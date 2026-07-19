/**
 * Listing Orchestrator
 * --------------------
 * Executa todos os scripts de listagem em sequência e gera um
 * relatório consolidado com o status de cada plataforma.
 *
 * Uso:
 *   npm run listing:submit-all
 *   (ou) npx hardhat run scripts/listing/08_run_all_listings.ts
 *
 * Requisitos de ambiente:
 *   smartcontracts/.env : CAS_TOKEN_ADDRESS
 *   gh CLI autenticado (para Trust Wallet) — execute `gh auth login`
 */

import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as util from "util";
import dotenv from "dotenv";

const execFileAsync = util.promisify(execFile);

const SC_ROOT = path.resolve(__dirname, "..", "..");
dotenv.config({ path: path.join(SC_ROOT, ".env") });

type LogLevel = "INFO" | "WARN" | "ERROR" | "OK" | "DEBUG";

function log(level: LogLevel, fn: string, message: string, params?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const emoji = { INFO: "ℹ️", WARN: "⚠️", ERROR: "❌", OK: "✅", DEBUG: "🔍" }[level];
  const extra = params ? ` - ${JSON.stringify(params)}` : "";
  console.log(`[${ts}] [listing_orchestrator:${fn}] ${emoji} ${message}${extra}`);
}

interface ListingResult {
  platform: string;
  script: string;
  status: "success" | "failed" | "skipped";
  output: string;
  durationMs: number;
  timestamp: string;
}

const SCRIPTS: Array<{ platform: string; script: string; file: string; requiresGhCli?: boolean }> = [
  { platform: "Trust Wallet", script: "01_trustwallet_submit.ts", file: "01_trustwallet_submit.ts", requiresGhCli: true },
  { platform: "DexScreener", script: "02_dexscreener_check.ts", file: "02_dexscreener_check.ts" },
  { platform: "CoinBrain", script: "03_coinbrain_submit.ts", file: "03_coinbrain_submit.ts" },
  { platform: "LiveCoinWatch", script: "04_livecoinwatch_submit.ts", file: "04_livecoinwatch_submit.ts" },
  { platform: "CoinStats", script: "05_coinstats_check.ts", file: "05_coinstats_check.ts" },
  { platform: "GeckoTerminal", script: "06_geckoterminal_check.ts", file: "06_geckoterminal_check.ts" },
  { platform: "Blockspot", script: "07_blockspot_submit.ts", file: "07_blockspot_submit.ts" },
];

async function runScript(scriptFile: string): Promise<{ stdout: string; stderr: string }> {
  const scriptPath = path.join(__dirname, scriptFile);
  const { stdout, stderr } = await execFileAsync("npx", ["hardhat", "run", scriptPath], {
    cwd: SC_ROOT,
    maxBuffer: 10 * 1024 * 1024,
    timeout: 120_000,
  });
  return { stdout, stderr };
}

async function main(): Promise<void> {
  log("INFO", "main", "🚀 Iniciando orquestração de listagens", {
    scripts: SCRIPTS.length,
    token: process.env.CAS_TOKEN_ADDRESS,
  });

  const results: ListingResult[] = [];

  for (const entry of SCRIPTS) {
    log("INFO", "main", `Executando: ${entry.platform}`, { script: entry.script });

    if (entry.requiresGhCli) {
      try {
        await execFileAsync("gh", ["auth", "status"], { timeout: 10_000 });
      } catch {
        log("WARN", "main", `Pulando ${entry.platform} — gh CLI não autenticado (execute \`gh auth login\`)`);
        results.push({
          platform: entry.platform,
          script: entry.script,
          status: "skipped",
          output: "gh CLI não autenticado — execute `gh auth login`",
          durationMs: 0,
          timestamp: new Date().toISOString(),
        });
        continue;
      }
    }

    const startTime = Date.now();
    try {
      const { stdout, stderr } = await runScript(entry.file);
      const durationMs = Date.now() - startTime;
      const output = stdout + (stderr ? `\n--- stderr ---\n${stderr}` : "");

      log("OK", "main", `${entry.platform} concluído`, { durationMs });
      results.push({
        platform: entry.platform,
        script: entry.script,
        status: "success",
        output: output.slice(-2000),
        durationMs,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const errorOutput = (err as Error).message || String(err);
      log("ERROR", "main", `${entry.platform} falhou`, { error: errorOutput.slice(0, 200), durationMs });
      results.push({
        platform: entry.platform,
        script: entry.script,
        status: "failed",
        output: errorOutput.slice(-2000),
        durationMs,
        timestamp: new Date().toISOString(),
      });
    }
  }

  // Generate consolidated report
  const reportsDir = path.join(SC_ROOT, "reports");
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
  const reportPath = path.join(reportsDir, `listing-status-${Date.now()}.json`);
  const report = {
    timestamp: new Date().toISOString(),
    token: process.env.CAS_TOKEN_ADDRESS,
    network: "Polygon PoS (137)",
    totalScripts: SCRIPTS.length,
    successCount: results.filter((r) => r.status === "success").length,
    failedCount: results.filter((r) => r.status === "failed").length,
    skippedCount: results.filter((r) => r.status === "skipped").length,
    results,
  };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  // Print summary
  console.log("\n" + "=".repeat(72));
  console.log("📊 RELATÓRIO CONSOLIDADO DE LISTAGENS — CAS TOKEN");
  console.log("=".repeat(72));
  console.log(`Token: ${process.env.CAS_TOKEN_ADDRESS}`);
  console.log(`Rede: Polygon PoS (137)`);
  console.log(`Total: ${report.totalScripts} | ✅ ${report.successCount} | ❌ ${report.failedCount} | ⏭️ ${report.skippedCount}`);
  console.log();

  console.log("STATUS POR PLATAFORMA:");
  for (const r of results) {
    const statusIcon = r.status === "success" ? "✅" : r.status === "failed" ? "❌" : "⏭️";
    console.log(`  ${statusIcon} ${r.platform} — ${r.status} (${r.durationMs}ms)`);
  }
  console.log();
  console.log(`📄 Relatório completo: ${reportPath}`);
  console.log();

  log("OK", "main", "🏁 Orquestração concluída", {
    success: report.successCount,
    failed: report.failedCount,
    skipped: report.skippedCount,
    reportPath,
  });
}

main().catch((error) => {
  log("ERROR", "main", "Erro fatal", { error: (error as Error).message });
  process.exitCode = 1;
});
