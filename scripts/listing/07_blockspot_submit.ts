/**
 * Blockspot Token Submission
 * ---------------------------
 * Envia dados do token CAS para listagem no Blockspot via formulário web.
 * Se houver proteção anti-bot, gera arquivo com dados preenchidos para
 * submissão manual rápida.
 *
 * Uso:
 *   npm run listing:blockspot
 *   (ou) npx hardhat run scripts/listing/07_blockspot_submit.ts
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
  console.log(`[${ts}] [blockspot_submit:${fn}] ${emoji} ${message}${extra}`);
}

const CAS_TOKEN_ADDRESS = process.env.CAS_TOKEN_ADDRESS ?? "";

const METADATA = JSON.parse(
  fs.readFileSync(path.join(SC_ROOT, "docs", "coingecko-listing-metadata.json"), "utf-8"),
);

async function main(): Promise<void> {
  log("INFO", "main", "🚀 Iniciando submissão para Blockspot", { token: CAS_TOKEN_ADDRESS });

  if (!CAS_TOKEN_ADDRESS) {
    log("ERROR", "main", "CAS_TOKEN_ADDRESS não configurado no .env");
    process.exitCode = 1;
    return;
  }

  // 1. Try POST submission
  log("INFO", "main", "Tentando submissão via formulário web do Blockspot");
  try {
    const formData = new URLSearchParams({
      name: METADATA.token.name,
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
    });

    const res = await fetch("https://blockspot.io/add-coin", {
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

  // 2. Generate manual submission data
  const formData = {
    platform: "blockspot",
    instructions: "Submeter manualmente em https://blockspot.io/add-coin",
    form_data: {
      name: METADATA.token.name,
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
    },
  };

  const reportsDir = path.join(SC_ROOT, "reports");
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
  const formPath = path.join(reportsDir, `blockspot-manual-form-${Date.now()}.json`);
  fs.writeFileSync(formPath, JSON.stringify(formData, null, 2));
  log("OK", "main", "🏁 Formulário preenchido gerado para submissão manual", { path: formPath });
  console.log("\n📋 Submeter manualmente em: https://blockspot.io/add-coin");
  console.log(`📝 Dados preenchidos: ${formPath}`);

  saveResult("manual_required", formPath);
}

function saveResult(status: string, formPath?: string): void {
  const reportsDir = path.join(SC_ROOT, "reports");
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
  const resultPath = path.join(reportsDir, `blockspot-submit-${Date.now()}.json`);
  fs.writeFileSync(resultPath, JSON.stringify({
    platform: "blockspot",
    status,
    formPath,
    timestamp: new Date().toISOString(),
  }, null, 2));
}

main().catch((error) => {
  log("ERROR", "main", "Erro fatal", { error: (error as Error).message });
  process.exitCode = 1;
});
