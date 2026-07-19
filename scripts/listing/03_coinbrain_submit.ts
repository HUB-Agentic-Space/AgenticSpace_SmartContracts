/**
 * CoinBrain Token Submission
 * ---------------------------
 * Verifica se o token CAS está listado no CoinBrain e, se não estiver,
 * prepara e envia a submissão via API pública ou gera formulário
 * preenchido para submissão manual assistida.
 *
 * Uso:
 *   npm run listing:coinbrain
 *   (ou) npx hardhat run scripts/listing/03_coinbrain_submit.ts
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
  console.log(`[${ts}] [coinbrain_submit:${fn}] ${emoji} ${message}${extra}`);
}

const CAS_TOKEN_ADDRESS = process.env.CAS_TOKEN_ADDRESS ?? "";

const METADATA = JSON.parse(
  fs.readFileSync(path.join(SC_ROOT, "docs", "coingecko-listing-metadata.json"), "utf-8"),
);

async function checkCoinBrainListing(): Promise<{ listed: boolean; url?: string }> {
  log("INFO", "checkCoinBrainListing", "Verificando se CAS já está listado no CoinBrain");
  try {
    const res = await fetch(`https://api.coinbrain.com/coin/info/${CAS_TOKEN_ADDRESS}?chain=polygon`);
    if (res.status === 404) {
      log("WARN", "checkCoinBrainListing", "Token não encontrado no CoinBrain");
      return { listed: false };
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { url?: string };
    log("OK", "checkCoinBrainListing", "Token já listado no CoinBrain", { url: data.url });
    return { listed: true, url: data.url };
  } catch (err) {
    log("WARN", "checkCoinBrainListing", "Não foi possível verificar (API pode não ter endpoint público)", {
      error: (err as Error).message,
    });
    return { listed: false };
  }
}

function generateManualSubmissionForm(): string {
  return JSON.stringify({
    platform: "coinbrain",
    instructions: "Submeter manualmente em https://coinbrain.com/requests/coin",
    form_data: {
      name: METADATA.token.name,
      symbol: METADATA.token.symbol,
      contract_address: CAS_TOKEN_ADDRESS,
      chain: "polygon",
      decimals: METADATA.token.decimals,
      website: METADATA.links.website,
      explorer: METADATA.links.explorer,
      logo_url: METADATA.links.logo,
      description: METADATA.token.description_short,
      github: METADATA.links.github,
      whitepaper: METADATA.links.whitepaper,
      twitter: METADATA.social.twitter || "(preencher)",
      discord: METADATA.social.discord || "(preencher)",
      telegram: METADATA.social.telegram || "(preencher)",
    },
  }, null, 2);
}

async function main(): Promise<void> {
  log("INFO", "main", "🚀 Iniciando submissão para CoinBrain", { token: CAS_TOKEN_ADDRESS });

  if (!CAS_TOKEN_ADDRESS) {
    log("ERROR", "main", "CAS_TOKEN_ADDRESS não configurado no .env");
    process.exitCode = 1;
    return;
  }

  // 1. Check if already listed
  const checkResult = await checkCoinBrainListing();
  if (checkResult.listed) {
    log("OK", "main", "🏁 Token já listado no CoinBrain — nenhuma ação necessária", { url: checkResult.url });
    return;
  }

  // 2. Try API submission (if endpoint exists)
  log("INFO", "main", "Tentando submissão via API pública do CoinBrain");
  try {
    const payload = {
      name: METADATA.token.name,
      symbol: METADATA.token.symbol,
      address: CAS_TOKEN_ADDRESS,
      chain: "polygon",
      decimals: METADATA.token.decimals,
      website: METADATA.links.website,
      description: METADATA.token.description_short,
      logo: METADATA.links.logo,
      links: {
        github: METADATA.links.github,
        whitepaper: METADATA.links.whitepaper,
      },
    };

    const res = await fetch("https://api.coinbrain.com/coin/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      const data = (await res.json()) as { url?: string };
      log("OK", "main", "🏁 Submissão enviada com sucesso via API", { url: data.url });
      saveResult("submitted", data.url);
      return;
    }
    log("WARN", "main", "API de submissão não disponível ou requer autenticação", { status: res.status });
  } catch (err) {
    log("WARN", "main", "Submissão via API falhou — gerando formulário para submissão manual", {
      error: (err as Error).message,
    });
  }

  // 3. Generate manual submission form
  const formData = generateManualSubmissionForm();
  const reportsDir = path.join(SC_ROOT, "reports");
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
  const formPath = path.join(reportsDir, `coinbrain-manual-form-${Date.now()}.json`);
  fs.writeFileSync(formPath, formData);
  log("OK", "main", "🏁 Formulário preenchido gerado para submissão manual", { path: formPath });
  console.log("\n📋 Submeter manualmente em: https://coinbrain.com/requests/coin");
  console.log(`📝 Dados preenchidos: ${formPath}`);

  saveResult("manual_required", undefined, formPath);
}

function saveResult(status: string, url?: string, formPath?: string): void {
  const reportsDir = path.join(SC_ROOT, "reports");
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
  const resultPath = path.join(reportsDir, `coinbrain-submit-${Date.now()}.json`);
  fs.writeFileSync(resultPath, JSON.stringify({
    platform: "coinbrain",
    status,
    url,
    formPath,
    timestamp: new Date().toISOString(),
  }, null, 2));
}

main().catch((error) => {
  log("ERROR", "main", "Erro fatal", { error: (error as Error).message });
  process.exitCode = 1;
});
