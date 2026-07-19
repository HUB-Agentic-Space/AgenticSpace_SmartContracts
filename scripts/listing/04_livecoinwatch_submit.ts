/**
 * LiveCoinWatch Token Request
 * ----------------------------
 * Envia uma solicitação de listagem do CAS no LiveCoinWatch via
 * formulário web. Se houver proteção anti-bot, gera arquivo com
 * dados preenchidos para submissão manual rápida.
 *
 * Uso:
 *   npm run listing:livecoinwatch
 *   (ou) npx hardhat run scripts/listing/04_livecoinwatch_submit.ts
 *
 * Requisitos de ambiente:
 *   smartcontracts/.env : CAS_TOKEN_ADDRESS
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
  console.log(`[${ts}] [livecoinwatch_submit:${fn}] ${emoji} ${message}${extra}`);
}

const CAS_TOKEN_ADDRESS = process.env.CAS_TOKEN_ADDRESS ?? "";

const METADATA = JSON.parse(
  fs.readFileSync(path.join(SC_ROOT, "docs", "coingecko-listing-metadata.json"), "utf-8"),
);

const SUBMIT_URL = "https://www.livecoinwatch.com/requests/coin";

async function checkLiveCoinWatchListing(): Promise<boolean> {
  log("INFO", "checkLiveCoinWatchListing", "Verificando se CAS já está listado no LiveCoinWatch");
  try {
    const res = await fetch(`https://www.livecoinwatch.com/price/${METADATA.token.symbol.toLowerCase()}-agentic-space`);
    if (res.ok) {
      log("OK", "checkLiveCoinWatchListing", "Token já listado no LiveCoinWatch");
      return true;
    }
    log("WARN", "checkLiveCoinWatchListing", "Token não encontrado no LiveCoinWatch");
    return false;
  } catch {
    log("WARN", "checkLiveCoinWatchListing", "Não foi possível verificar");
    return false;
  }
}

async function main(): Promise<void> {
  log("INFO", "main", "🚀 Iniciando submissão para LiveCoinWatch", { token: CAS_TOKEN_ADDRESS });

  if (!CAS_TOKEN_ADDRESS) {
    log("ERROR", "main", "CAS_TOKEN_ADDRESS não configurado no .env");
    process.exitCode = 1;
    return;
  }

  // 1. Check if already listed
  const alreadyListed = await checkLiveCoinWatchListing();
  if (alreadyListed) {
    log("OK", "main", "🏁 Token já listado no LiveCoinWatch — nenhuma ação necessária");
    return;
  }

  // 2. Try POST submission
  log("INFO", "main", "Tentando submissão via formulário web");
  try {
    const formData = new URLSearchParams({
      coinName: METADATA.token.name,
      symbol: METADATA.token.symbol,
      chain: "Polygon",
      contractAddress: CAS_TOKEN_ADDRESS,
      decimals: String(METADATA.token.decimals),
      website: METADATA.links.website,
      explorer: METADATA.links.explorer,
      logoUrl: METADATA.links.logo,
      description: METADATA.token.description_short,
      github: METADATA.links.github,
      whitepaper: METADATA.links.whitepaper,
      twitter: METADATA.social.twitter || "",
      discord: METADATA.social.discord || "",
      telegram: METADATA.social.telegram || "",
      isRepresentative: "true",
    });

    const res = await fetch(SUBMIT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "AgenticSpace-ListingBot/1.0",
      },
      body: formData.toString(),
      redirect: "manual",
    });

    if (res.status === 200 || res.status === 301 || res.status === 302) {
      log("OK", "main", "🏁 Submissão enviada com sucesso");
      saveResult("submitted");
      return;
    }
    log("WARN", "main", "Formulário pode ter proteção anti-bot", { status: res.status });
  } catch (err) {
    log("WARN", "main", "Submissão via POST falhou — gerando formulário manual", {
      error: (err as Error).message,
    });
  }

  // 3. Generate manual submission data
  const formData = {
    platform: "livecoinwatch",
    instructions: "Submeter manualmente em https://www.livecoinwatch.com/requests/coin",
    form_data: {
      coinName: METADATA.token.name,
      symbol: METADATA.token.symbol,
      chain: "Polygon",
      contractAddress: CAS_TOKEN_ADDRESS,
      decimals: METADATA.token.decimals,
      website: METADATA.links.website,
      explorer: METADATA.links.explorer,
      logoUrl: METADATA.links.logo,
      description: METADATA.token.description_short,
      github: METADATA.links.github,
      whitepaper: METADATA.links.whitepaper,
      twitter: METADATA.social.twitter || "(preencher)",
      discord: METADATA.social.discord || "(preencher)",
      telegram: METADATA.social.telegram || "(preencher)",
      isRepresentative: true,
    },
  };

  const reportsDir = path.join(SC_ROOT, "reports");
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
  const formPath = path.join(reportsDir, `livecoinwatch-manual-form-${Date.now()}.json`);
  fs.writeFileSync(formPath, JSON.stringify(formData, null, 2));
  log("OK", "main", "🏁 Formulário preenchido gerado para submissão manual", { path: formPath });
  console.log("\n📋 Submeter manualmente em: https://www.livecoinwatch.com/requests/coin");
  console.log(`📝 Dados preenchidos: ${formPath}`);

  saveResult("manual_required", formPath);
}

function saveResult(status: string, formPath?: string): void {
  const reportsDir = path.join(SC_ROOT, "reports");
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
  const resultPath = path.join(reportsDir, `livecoinwatch-submit-${Date.now()}.json`);
  fs.writeFileSync(resultPath, JSON.stringify({
    platform: "livecoinwatch",
    status,
    formPath,
    timestamp: new Date().toISOString(),
  }, null, 2));
}

main().catch((error) => {
  log("ERROR", "main", "Erro fatal", { error: (error as Error).message });
  process.exitCode = 1;
});
