/**
 * CoinStats Threshold Monitor
 * ----------------------------
 * Monitora se o token CAS atinge os critérios mínimos para listagem
 * automática no CoinStats. CoinStats lista automaticamente tokens que
 * atendem aos thresholds — não há submissão manual.
 *
 * Critérios mínimos (Polygon):
 *   - FDV ≥ $100.000
 *   - Volume 24h ≥ $100.000
 *   - Liquidez ≥ $20.000
 *
 * Uso:
 *   npm run listing:coinstats
 *   (ou) npx hardhat run scripts/listing/05_coinstats_check.ts
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
  console.log(`[${ts}] [coinstats_check:${fn}] ${emoji} ${message}${extra}`);
}

const CAS_TOKEN_ADDRESS = process.env.CAS_TOKEN_ADDRESS ?? "";

const THRESHOLDS = {
  fdv: 100_000,
  volume24h: 100_000,
  liquidity: 20_000,
};

interface MetricStatus {
  name: string;
  current: number;
  threshold: number;
  passed: boolean;
  gap: number;
  gapPct: number;
}

async function main(): Promise<void> {
  log("INFO", "main", "🚀 Monitorando thresholds do CoinStats", { token: CAS_TOKEN_ADDRESS });

  if (!CAS_TOKEN_ADDRESS) {
    log("ERROR", "main", "CAS_TOKEN_ADDRESS não configurado no .env");
    process.exitCode = 1;
    return;
  }

  // Fetch data from DexScreener
  const apiUrl = `https://api.dexscreener.com/latest/dex/tokens/${CAS_TOKEN_ADDRESS}`;
  log("DEBUG", "main", "Consultando DexScreener para métricas", { url: apiUrl });

  try {
    const res = await fetch(apiUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as {
      pairs?: Array<{
        liquidity?: { usd?: number };
        volume?: { h24?: number };
        fdv?: number;
        marketCap?: number;
      }>;
    };
    const pairs = body.pairs ?? [];

    if (pairs.length === 0) {
      log("WARN", "main", "Nenhum par DEX encontrado — não é possível calcular métricas");
      reportResult([], false);
      return;
    }

    const totalLiquidity = pairs.reduce((sum, p) => sum + (p.liquidity?.usd ?? 0), 0);
    const totalVolume = pairs.reduce((sum, p) => sum + (p.volume?.h24 ?? 0), 0);
    const bestFdv = Math.max(...pairs.map((p) => p.fdv ?? 0));

    const metrics: MetricStatus[] = [
      {
        name: "FDV (Fully Diluted Valuation)",
        current: bestFdv,
        threshold: THRESHOLDS.fdv,
        passed: bestFdv >= THRESHOLDS.fdv,
        gap: Math.max(0, THRESHOLDS.fdv - bestFdv),
        gapPct: bestFdv > 0 ? (THRESHOLDS.fdv / bestFdv) * 100 : Infinity,
      },
      {
        name: "Volume 24h",
        current: totalVolume,
        threshold: THRESHOLDS.volume24h,
        passed: totalVolume >= THRESHOLDS.volume24h,
        gap: Math.max(0, THRESHOLDS.volume24h - totalVolume),
        gapPct: totalVolume > 0 ? (THRESHOLDS.volume24h / totalVolume) * 100 : Infinity,
      },
      {
        name: "Liquidez DEX",
        current: totalLiquidity,
        threshold: THRESHOLDS.liquidity,
        passed: totalLiquidity >= THRESHOLDS.liquidity,
        gap: Math.max(0, THRESHOLDS.liquidity - totalLiquidity),
        gapPct: totalLiquidity > 0 ? (THRESHOLDS.liquidity / totalLiquidity) * 100 : Infinity,
      },
    ];

    const allPassed = metrics.every((m) => m.passed);

    // Print report
    console.log("\n" + "=".repeat(72));
    console.log("📊 COINSTATS THRESHOLD MONITOR — CAS TOKEN");
    console.log("=".repeat(72));
    console.log(`Token: ${CAS_TOKEN_ADDRESS}`);
    console.log(`Status: ${allPassed ? "✅ Todos os critérios atendidos — CoinStats listará automaticamente" : "⚠️ Critérios não atendidos"}`);
    console.log();

    console.log("MÉTRICAS:");
    for (const m of metrics) {
      const status = m.passed ? "✅" : "❌";
      const gapStr = m.passed ? "" : ` — faltam $${m.gap.toFixed(2)} (${m.gapPct.toFixed(0)}% para atingir)`;
      console.log(`  ${status} ${m.name}: $${m.current.toFixed(2)} / $${m.threshold.toFixed(2)}${gapStr}`);
    }

    if (!allPassed) {
      console.log();
      console.log("📋 AÇÕES RECOMENDADAS:");
      if (!metrics[0].passed) console.log("  • Aumentar FDV: subir preço do CAS via demanda orgânica ou aumentar supply circulante");
      if (!metrics[1].passed) console.log("  • Aumentar volume: promover trading no DEX, programa de market making");
      if (!metrics[2].passed) console.log("  • Aumentar liquidez: adicionar mais CAS/POL ao pool do SushiSwap");
    }
    console.log();

    reportResult(metrics, allPassed);
  } catch (err) {
    log("ERROR", "main", "Erro ao consultar DexScreener", { error: (err as Error).message });
    process.exitCode = 1;
  }
}

function reportResult(metrics: MetricStatus[], allPassed: boolean): void {
  const reportsDir = path.join(SC_ROOT, "reports");
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
  const resultPath = path.join(reportsDir, `coinstats-check-${Date.now()}.json`);
  fs.writeFileSync(resultPath, JSON.stringify({
    platform: "coinstats",
    status: allPassed ? "eligible" : "not_eligible",
    thresholds: THRESHOLDS,
    metrics,
    timestamp: new Date().toISOString(),
  }, null, 2));
  log("OK", "reportResult", "Relatório salvo", { path: resultPath });
}

main().catch((error) => {
  log("ERROR", "main", "Erro fatal", { error: (error as Error).message });
  process.exitCode = 1;
});
