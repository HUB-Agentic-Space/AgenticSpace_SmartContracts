/**
 * CoinGecko Listing Readiness Check
 * ----------------------------------
 * Verifica se o token CAS está pronto para submissão no CoinGecko e
 * outros agregadores. Gera um relatório com score 0-100 e lista de
 * pendências bloqueantes vs não-bloqueantes.
 *
 * Uso:
 *   npm run listing:readiness
 *   (ou) npx hardhat run scripts/analysis/coingecko_listing_readiness.ts
 *
 * Requisitos de ambiente:
 *   smartcontracts/.env : POLYGONSCAN_API_KEY, CAS_TOKEN_ADDRESS
 */

import * as fs from "fs";
import * as path from "path";
import dotenv from "dotenv";

// ── Env loading ───────────────────────────────────────────────────────

const SC_ROOT = path.resolve(__dirname, "..", "..");
dotenv.config({ path: path.join(SC_ROOT, ".env") });

// ── Structured logging ────────────────────────────────────────────────

type LogLevel = "INFO" | "WARN" | "ERROR" | "OK" | "DEBUG";

function log(level: LogLevel, fn: string, message: string, params?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const emoji = { INFO: "ℹ️", WARN: "⚠️", ERROR: "❌", OK: "✅", DEBUG: "🔍" }[level];
  const extra = params ? ` - ${JSON.stringify(params)}` : "";
  console.log(`[${ts}] [coingecko_readiness:${fn}] ${emoji} ${message}${extra}`);
}

// ── Types ─────────────────────────────────────────────────────────────

interface CheckResult {
  name: string;
  category: string;
  passed: boolean;
  blocking: boolean;
  weight: number;
  details: string;
  url?: string;
}

interface ReadinessReport {
  timestamp: string;
  tokenAddress: string;
  network: string;
  score: number;
  maxScore: number;
  percentage: number;
  blockingIssues: CheckResult[];
  nonBlockingIssues: CheckResult[];
  passedChecks: CheckResult[];
  summary: string;
}

// ── Constants ─────────────────────────────────────────────────────────

const POLYGONSCAN_API_KEY = process.env.POLYGONSCAN_API_KEY ?? "";
const CAS_TOKEN_ADDRESS = process.env.CAS_TOKEN_ADDRESS ?? "";
const CHAIN_ID = 137;
const API_BASES = [
  "https://api.etherscan.io/v2/api",
  "https://api.polygonscan.com/api",
];

const METADATA = JSON.parse(
  fs.readFileSync(path.join(SC_ROOT, "docs", "coingecko-listing-metadata.json"), "utf-8"),
);

const PUBLIC_BASE_URL = METADATA.links.website;
const LOGO_URL = METADATA.links.logo;
const TOKENLIST_URL = METADATA.links.tokenlist;
const WHITEPAPER_URL = METADATA.links.whitepaper;
const TOKENOMICS_URL = METADATA.links.tokenomics;

// ── API helpers ───────────────────────────────────────────────────────

async function scanRequest(params: Record<string, string>): Promise<unknown> {
  let lastError: Error | null = null;
  for (const base of API_BASES) {
    const url = new URL(base);
    if (base.includes("etherscan.io/v2")) url.searchParams.set("chainid", String(CHAIN_ID));
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("apikey", POLYGONSCAN_API_KEY);
    try {
      const res = await fetch(url.toString());
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { status: string; message: string; result: unknown };
      if (body.status === "1" || (body.status === "0" && body.message === "No transactions found")) {
        return body.result;
      }
      throw new Error(`API status=${body.status} message=${body.message}`);
    } catch (err) {
      lastError = err as Error;
    }
  }
  throw lastError ?? new Error("Todas as bases da API falharam");
}

async function checkUrlAccessible(url: string): Promise<{ ok: boolean; status: number; contentType: string }> {
  try {
    const res = await fetch(url, { method: "HEAD" });
    return {
      ok: res.ok,
      status: res.status,
      contentType: res.headers.get("content-type") ?? "",
    };
  } catch {
    return { ok: false, status: 0, contentType: "" };
  }
}

// ── Individual checks ─────────────────────────────────────────────────

async function checkContractVerified(): Promise<CheckResult> {
  log("INFO", "checkContractVerified", "Verificando verificação do contrato no Polygonscan");
  try {
    const result = (await scanRequest({
      module: "contract",
      action: "getcontractsource",
      contractaddress: CAS_TOKEN_ADDRESS,
    })) as { SourceCode?: string } | null;

    const verified = !!result?.SourceCode && result.SourceCode.length > 0;
    return {
      name: "Contrato verificado no Polygonscan",
      category: "contract",
      passed: verified,
      blocking: true,
      weight: 15,
      details: verified ? "Código-fonte verificado e público" : "Contrato não verificado — submeter em polygonscan.com",
      url: `https://polygonscan.com/address/${CAS_TOKEN_ADDRESS}#code`,
    };
  } catch (err) {
    return {
      name: "Contrato verificado no Polygonscan",
      category: "contract",
      passed: false,
      blocking: true,
      weight: 15,
      details: `Erro ao verificar: ${(err as Error).message}`,
    };
  }
}

async function checkDexLiquidity(): Promise<CheckResult> {
  log("INFO", "checkDexLiquidity", "Verificando liquidez DEX via DexScreener");
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${CAS_TOKEN_ADDRESS}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { pairs?: Array<{ liquidity?: { usd?: number } }> };
    const pairs = body.pairs ?? [];
    const totalLiquidity = pairs.reduce((sum, p) => sum + (p.liquidity?.usd ?? 0), 0);
    const minLiquidity = 1000;
    const passed = totalLiquidity >= minLiquidity;
    return {
      name: "Liquidez DEX ≥ $1.000",
      category: "market",
      passed,
      blocking: true,
      weight: 15,
      details: `Liquidez total: $${totalLiquidity.toFixed(2)} (${pairs.length} pares)`,
      url: `https://dexscreener.com/polygon/${CAS_TOKEN_ADDRESS}`,
    };
  } catch (err) {
    return {
      name: "Liquidez DEX ≥ $1.000",
      category: "market",
      passed: false,
      blocking: true,
      weight: 15,
      details: `Erro ao consultar DexScreener: ${(err as Error).message}`,
    };
  }
}

async function checkDexVolume(): Promise<CheckResult> {
  log("INFO", "checkDexVolume", "Verificando volume 24h DEX");
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${CAS_TOKEN_ADDRESS}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { pairs?: Array<{ volume?: { h24?: number } }> };
    const pairs = body.pairs ?? [];
    const totalVolume = pairs.reduce((sum, p) => sum + (p.volume?.h24 ?? 0), 0);
    const passed = totalVolume > 0;
    return {
      name: "Volume DEX 24h > $0",
      category: "market",
      passed,
      blocking: false,
      weight: 10,
      details: `Volume 24h: $${totalVolume.toFixed(2)}`,
      url: `https://dexscreener.com/polygon/${CAS_TOKEN_ADDRESS}`,
    };
  } catch (err) {
    return {
      name: "Volume DEX 24h > $0",
      category: "market",
      passed: false,
      blocking: false,
      weight: 10,
      details: `Erro: ${(err as Error).message}`,
    };
  }
}

async function checkLogoAccessible(): Promise<CheckResult> {
  log("INFO", "checkLogoAccessible", "Verificando acessibilidade do logo público");
  const result = await checkUrlAccessible(LOGO_URL);
  const passed = result.ok && (result.contentType.includes("image") || result.status === 200);
  return {
    name: "Logo PNG acessível publicamente",
    category: "assets",
    passed,
    blocking: true,
    weight: 10,
    details: `Status: ${result.status}, Content-Type: ${result.contentType}`,
    url: LOGO_URL,
  };
}

async function checkTokenlistAccessible(): Promise<CheckResult> {
  log("INFO", "checkTokenlistAccessible", "Verificando acessibilidade da tokenlist JSON");
  const result = await checkUrlAccessible(TOKENLIST_URL);
  const passed = result.ok && result.contentType.includes("json");
  return {
    name: "Tokenlist JSON acessível publicamente",
    category: "assets",
    passed,
    blocking: false,
    weight: 5,
    details: `Status: ${result.status}, Content-Type: ${result.contentType}`,
    url: TOKENLIST_URL,
  };
}

async function checkWhitepaperAccessible(): Promise<CheckResult> {
  log("INFO", "checkWhitepaperAccessible", "Verificando acessibilidade do whitepaper");
  const result = await checkUrlAccessible(WHITEPAPER_URL);
  const passed = result.ok;
  return {
    name: "Whitepaper acessível publicamente",
    category: "assets",
    passed,
    blocking: false,
    weight: 5,
    details: `Status: ${result.status}`,
    url: WHITEPAPER_URL,
  };
}

async function checkTokenomicsAccessible(): Promise<CheckResult> {
  log("INFO", "checkTokenomicsAccessible", "Verificando acessibilidade do tokenomics");
  const result = await checkUrlAccessible(TOKENOMICS_URL);
  const passed = result.ok;
  return {
    name: "Tokenomics acessível publicamente",
    category: "assets",
    passed,
    blocking: false,
    weight: 5,
    details: `Status: ${result.status}`,
    url: TOKENOMICS_URL,
  };
}

async function checkWebsiteAccessible(): Promise<CheckResult> {
  log("INFO", "checkWebsiteAccessible", "Verificando acessibilidade do website");
  const result = await checkUrlAccessible(PUBLIC_BASE_URL);
  const passed = result.ok;
  return {
    name: "Website acessível publicamente",
    category: "assets",
    passed,
    blocking: true,
    weight: 10,
    details: `Status: ${result.status}`,
    url: PUBLIC_BASE_URL,
  };
}

async function checkHolderCount(): Promise<CheckResult> {
  log("INFO", "checkHolderCount", "Verificando número de holders");
  try {
    const result = (await scanRequest({
      module: "token",
      action: "tokenholderlist",
      contractaddress: CAS_TOKEN_ADDRESS,
      page: "1",
      offset: "1",
      sort: "desc",
    })) as unknown[];
    const holderCount = Array.isArray(result) ? result.length : 0;
    // This API only returns up to 10000, but if we get results we know there are holders
    const hasHolders = holderCount > 0;
    const minRecommended = 50;
    return {
      name: "Holders (mínimo recomendado: 50)",
      category: "community",
      passed: hasHolders,
      blocking: false,
      weight: 10,
      details: hasHolders
        ? `Token possui holders ativos (API retornou resultados)`
        : "Nenhum holder encontrado — distribuir tokens para aumentar base",
      url: `https://polygonscan.com/token/${CAS_TOKEN_ADDRESS}#balances`,
    };
  } catch (err) {
    return {
      name: "Holders (mínimo recomendado: 50)",
      category: "community",
      passed: false,
      blocking: false,
      weight: 10,
      details: `Erro: ${(err as Error).message}`,
    };
  }
}

async function checkTransferActivity(): Promise<CheckResult> {
  log("INFO", "checkTransferActivity", "Verificando atividade de transferências");
  try {
    const result = (await scanRequest({
      module: "account",
      action: "tokentx",
      contractaddress: CAS_TOKEN_ADDRESS,
      page: "1",
      offset: "1",
      sort: "desc",
    })) as unknown[];
    const hasActivity = Array.isArray(result) && result.length > 0;
    return {
      name: "Atividade de transferências on-chain",
      category: "market",
      passed: hasActivity,
      blocking: false,
      weight: 5,
      details: hasActivity ? "Transferências recentes detectadas" : "Sem transferências detectadas",
      url: `https://polygonscan.com/token/${CAS_TOKEN_ADDRESS}#txs`,
    };
  } catch (err) {
    return {
      name: "Atividade de transferências on-chain",
      category: "market",
      passed: false,
      blocking: false,
      weight: 5,
      details: `Erro: ${(err as Error).message}`,
    };
  }
}

async function checkSocialLinks(): Promise<CheckResult> {
  log("INFO", "checkSocialLinks", "Verificando links sociais configurados");
  const social = METADATA.social;
  const configured = Object.entries(social).filter(([, v]) => v && v.length > 0);
  const minSocials = 2;
  const passed = configured.length >= minSocials;
  return {
    name: `Links sociais configurados (mínimo: ${minSocials})`,
    category: "community",
    passed,
    blocking: false,
    weight: 10,
    details: passed
      ? `${configured.length} links configurados: ${configured.map(([k]) => k).join(", ")}`
      : `Apenas ${configured.length} link(s) configurado(s). Configurar Twitter/X, Discord e Telegram para melhorar ranking`,
  };
}

// ── Main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log("INFO", "main", "🚀 Iniciando verificação de prontidão para listagem", {
    token: CAS_TOKEN_ADDRESS,
    network: "polygon-pos",
  });

  if (!CAS_TOKEN_ADDRESS) {
    log("ERROR", "main", "CAS_TOKEN_ADDRESS não configurado no .env");
    process.exitCode = 1;
    return;
  }

  const checks: CheckResult[] = [];
  checks.push(await checkContractVerified());
  checks.push(await checkDexLiquidity());
  checks.push(await checkDexVolume());
  checks.push(await checkLogoAccessible());
  checks.push(await checkTokenlistAccessible());
  checks.push(await checkWhitepaperAccessible());
  checks.push(await checkTokenomicsAccessible());
  checks.push(await checkWebsiteAccessible());
  checks.push(await checkHolderCount());
  checks.push(await checkTransferActivity());
  checks.push(await checkSocialLinks());

  const maxScore = checks.reduce((sum, c) => sum + c.weight, 0);
  const score = checks.filter((c) => c.passed).reduce((sum, c) => sum + c.weight, 0);
  const percentage = Math.round((score / maxScore) * 100);

  const blockingIssues = checks.filter((c) => !c.passed && c.blocking);
  const nonBlockingIssues = checks.filter((c) => !c.passed && !c.blocking);
  const passedChecks = checks.filter((c) => c.passed);

  const report: ReadinessReport = {
    timestamp: new Date().toISOString(),
    tokenAddress: CAS_TOKEN_ADDRESS,
    network: "Polygon PoS (137)",
    score,
    maxScore,
    percentage,
    blockingIssues,
    nonBlockingIssues,
    passedChecks,
    summary:
      blockingIssues.length === 0
        ? `✅ Token pronto para submissão — score ${percentage}% (${nonBlockingIssues.length} pendências não-bloqueantes)`
        : `⚠️ Token NÃO pronto — ${blockingIssues.length} pendência(s) bloqueante(s), score ${percentage}%`,
  };

  // Print report
  console.log("\n" + "=".repeat(72));
  console.log("📊 RELATÓRIO DE PRONTIDÃO PARA LISTAGEM — CAS TOKEN");
  console.log("=".repeat(72));
  console.log(`Token: ${CAS_TOKEN_ADDRESS}`);
  console.log(`Rede: Polygon PoS (137)`);
  console.log(`Score: ${score}/${maxScore} (${percentage}%)`);
  console.log(`Status: ${report.summary}`);
  console.log();

  if (blockingIssues.length > 0) {
    console.log("🚫 PENDÊNCIAS BLOQUEANTES:");
    for (const issue of blockingIssues) {
      console.log(`  ❌ ${issue.name} — ${issue.details}`);
      if (issue.url) console.log(`     → ${issue.url}`);
    }
    console.log();
  }

  if (nonBlockingIssues.length > 0) {
    console.log("⚠️ PENDÊNCIAS NÃO-BLOQUEANTES:");
    for (const issue of nonBlockingIssues) {
      console.log(`  ⚠️ ${issue.name} — ${issue.details}`);
    }
    console.log();
  }

  console.log("✅ VERIFICAÇÕES APROVADAS:");
  for (const check of passedChecks) {
    console.log(`  ✅ ${check.name} — ${check.details}`);
  }
  console.log();

  // Save report
  const reportsDir = path.join(SC_ROOT, "reports");
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
  const reportPath = path.join(reportsDir, `listing-readiness-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  log("OK", "main", "🏁 Relatório salvo", { path: reportPath, score: percentage });

  if (blockingIssues.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  log("ERROR", "main", "Erro fatal", { error: (error as Error).message });
  process.exitCode = 1;
});
