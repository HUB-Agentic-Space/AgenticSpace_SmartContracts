/**
 * DexScreener Status Monitor
 * ---------------------------
 * Verifica se o token CAS está indexado no DexScreener e se Enhanced
 * Token Info (logo, description, links) está sendo exibida.
 *
 * Uso:
 *   npm run listing:dexscreener
 *   (ou) npx hardhat run scripts/listing/02_dexscreener_check.ts
 *
 * Requisitos de ambiente:
 *   smartcontracts/.env : CAS_TOKEN_ADDRESS
 *   API DexScreener é gratuita e não requer API key
 */

import * as fs from "fs";
import * as path from "path";
import dotenv from "dotenv";

const SC_ROOT = path.resolve(__dirname, "..", "..");
dotenv.config({ path: path.join(SC_ROOT, ".env") });

type LogLevel = "INFO" | "WARN" | "ERROR" | "OK" | "DEBUG";

function log(level: LogLevel, fn: string, message: string, params?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const emoji = { INFO: "ℹ️", WARN: "⚠️", ERROR: "❌", OK: "✅", DEBUG: "🔍" }[level];
  const extra = params ? ` - ${JSON.stringify(params)}` : "";
  console.log(`[${ts}] [dexscreener_check:${fn}] ${emoji} ${message}${extra}`);
}

const CAS_TOKEN_ADDRESS = process.env.CAS_TOKEN_ADDRESS ?? "";

interface DexScreenerPair {
  dexId: string;
  url: string;
  pairAddress: string;
  priceUsd: string;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  txns?: { h24?: { buys?: number; sells?: number } };
  fdv?: number;
  marketCap?: number;
  info?: {
    imageUrl?: string;
    description?: string;
    socials?: Array<{ type: string; url: string }>;
  };
}

async function main(): Promise<void> {
  log("INFO", "main", "🚀 Verificando status no DexScreener", { token: CAS_TOKEN_ADDRESS });

  if (!CAS_TOKEN_ADDRESS) {
    log("ERROR", "main", "CAS_TOKEN_ADDRESS não configurado no .env");
    process.exitCode = 1;
    return;
  }

  const apiUrl = `https://api.dexscreener.com/latest/dex/tokens/${CAS_TOKEN_ADDRESS}`;
  log("DEBUG", "main", "Consultando API", { url: apiUrl });

  try {
    const res = await fetch(apiUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { pairs?: DexScreenerPair[] };
    const pairs = body.pairs ?? [];

    if (pairs.length === 0) {
      log("WARN", "main", "Token não indexado no DexScreener — verificar se há pool DEX ativa");
      log("INFO", "main", "DexScreener indexa automaticamente ao detectar pool com ~$500+ de liquidez");
      reportResult({ indexed: false, enhancedInfo: false, pairs: [], totalLiquidity: 0, totalVolume: 0 });
      return;
    }

    log("OK", "main", "Token indexado no DexScreener", { pairCount: pairs.length });

    const totalLiquidity = pairs.reduce((sum, p) => sum + (p.liquidity?.usd ?? 0), 0);
    const totalVolume = pairs.reduce((sum, p) => sum + (p.volume?.h24 ?? 0), 0);

    // Check Enhanced Token Info
    const firstPair = pairs[0];
    const hasInfo = !!firstPair.info;
    const hasLogo = !!firstPair.info?.imageUrl;
    const hasDescription = !!firstPair.info?.description;
    const hasSocials = !!firstPair.info?.socials && firstPair.info.socials.length > 0;

    log("INFO", "main", "Status Enhanced Token Info", {
      hasInfo,
      hasLogo,
      hasDescription,
      hasSocials,
    });

    // Print pair details
    console.log("\n" + "=".repeat(72));
    console.log("📊 DEXSCREENER STATUS — CAS TOKEN");
    console.log("=".repeat(72));
    console.log(`Token: ${CAS_TOKEN_ADDRESS}`);
    console.log(`Indexado: ✅ Sim (${pairs.length} pares)`);
    console.log(`Liquidez total: $${totalLiquidity.toFixed(2)}`);
    console.log(`Volume 24h: $${totalVolume.toFixed(2)}`);
    console.log();

    console.log("PARES DEX:");
    for (const p of pairs) {
      console.log(`  ${p.dexId}: $${parseFloat(p.priceUsd).toExponential(2)} | Liq: $${(p.liquidity?.usd ?? 0).toFixed(2)} | Vol24h: $${(p.volume?.h24 ?? 0).toFixed(2)}`);
      console.log(`    → ${p.url}`);
    }
    console.log();

    console.log("ENHANCED TOKEN INFO:");
    console.log(`  Logo: ${hasLogo ? "✅" : "❌"}`);
    console.log(`  Descrição: ${hasDescription ? "✅" : "❌"}`);
    console.log(`  Links sociais: ${hasSocials ? "✅" : "❌"}`);

    if (!hasInfo) {
      console.log();
      console.log("⚠️ Enhanced Token Info não exibida. Opções:");
      console.log("  1. Orgânico (gratuito): DexScreener lê metadata do CoinGecko após listagem");
      console.log("  2. Pago (~$300): Submeter via 'Update Token Info' no site dexscreener.com");
    }
    console.log();

    reportResult({
      indexed: true,
      enhancedInfo: hasInfo,
      pairs: pairs.map((p) => ({
        dex: p.dexId,
        url: p.url,
        liquidity: p.liquidity?.usd ?? 0,
        volume24h: p.volume?.h24 ?? 0,
      })),
      totalLiquidity,
      totalVolume,
    });
  } catch (err) {
    log("ERROR", "main", "Erro ao consultar DexScreener", { error: (err as Error).message });
    process.exitCode = 1;
  }
}

function reportResult(data: Record<string, unknown>): void {
  const reportsDir = path.join(SC_ROOT, "reports");
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
  const resultPath = path.join(reportsDir, `dexscreener-check-${Date.now()}.json`);
  fs.writeFileSync(resultPath, JSON.stringify({
    platform: "dexscreener",
    timestamp: new Date().toISOString(),
    ...data,
  }, null, 2));
  log("OK", "reportResult", "Relatório salvo", { path: resultPath });
}

main().catch((error) => {
  log("ERROR", "main", "Erro fatal", { error: (error as Error).message });
  process.exitCode = 1;
});
