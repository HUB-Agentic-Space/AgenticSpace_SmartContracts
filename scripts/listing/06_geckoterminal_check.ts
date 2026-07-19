/**
 * GeckoTerminal Indexing Check
 * -----------------------------
 * Verifica se o token CAS está indexado no GeckoTerminal (subproduto
 * do CoinGecko focado em DEXs). GeckoTerminal indexa automaticamente
 * tokens listados no CoinGecko.
 *
 * Uso:
 *   npm run listing:geckoterminal
 *   (ou) npx hardhat run scripts/listing/06_geckoterminal_check.ts
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
  console.log(`[${ts}] [geckoterminal_check:${fn}] ${emoji} ${message}${extra}`);
}

const CAS_TOKEN_ADDRESS = process.env.CAS_TOKEN_ADDRESS ?? "";

async function main(): Promise<void> {
  log("INFO", "main", "🚀 Verificando indexação no GeckoTerminal", { token: CAS_TOKEN_ADDRESS });

  if (!CAS_TOKEN_ADDRESS) {
    log("ERROR", "main", "CAS_TOKEN_ADDRESS não configurado no .env");
    process.exitCode = 1;
    return;
  }

  // 1. Check GeckoTerminal API (uses CoinGecko's network/polygon endpoint)
  const geckoUrl = `https://api.geckoterminal.com/api/v2/networks/polygon_pos/tokens/${CAS_TOKEN_ADDRESS}`;
  log("DEBUG", "main", "Consultando API do GeckoTerminal", { url: geckoUrl });

  try {
    const res = await fetch(geckoUrl, {
      headers: { Accept: "application/json" },
    });

    if (res.status === 404) {
      log("WARN", "main", "Token não indexado no GeckoTerminal");
      log("INFO", "main", "GeckoTerminal indexa automaticamente após listagem no CoinGecko");
      log("INFO", "main", "Próximo passo: submeter CAS no CoinGecko (ver coingecko-listing-guide.md)");
      reportResult({ indexed: false, reason: "Token não listado no CoinGecko — GeckoTerminal indexa após listagem" });
      return;
    }

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const body = (await res.json()) as {
      data?: {
        id: string;
        attributes?: {
          name?: string;
          symbol?: string;
          price_usd?: string;
          market_cap_usd?: string;
          volume_usd?: { h24?: string };
          total_reserve_in_usd?: string;
        };
      };
    };

    const attrs = body.data?.attributes;
    log("OK", "main", "Token indexado no GeckoTerminal", {
      name: attrs?.name,
      symbol: attrs?.symbol,
      price: attrs?.price_usd,
    });

    console.log("\n" + "=".repeat(72));
    console.log("📊 GECKOTERMINAL STATUS — CAS TOKEN");
    console.log("=".repeat(72));
    console.log(`Token: ${CAS_TOKEN_ADDRESS}`);
    console.log(`Indexado: ✅ Sim`);
    if (attrs?.price_usd) console.log(`Preço: $${attrs.price_usd}`);
    if (attrs?.market_cap_usd) console.log(`Market Cap: $${attrs.market_cap_usd}`);
    if (attrs?.volume_usd?.h24) console.log(`Volume 24h: $${attrs.volume_usd.h24}`);
    if (attrs?.total_reserve_in_usd) console.log(`Reserva total: $${attrs.total_reserve_in_usd}`);
    console.log(`URL: https://www.geckoterminal.com/polygon/tokens/${CAS_TOKEN_ADDRESS}`);
    console.log();

    reportResult({
      indexed: true,
      name: attrs?.name,
      symbol: attrs?.symbol,
      priceUsd: attrs?.price_usd,
      marketCapUsd: attrs?.market_cap_usd,
      volume24h: attrs?.volume_usd?.h24,
      url: `https://www.geckoterminal.com/polygon/tokens/${CAS_TOKEN_ADDRESS}`,
    });
  } catch (err) {
    log("ERROR", "main", "Erro ao consultar GeckoTerminal", { error: (err as Error).message });
    process.exitCode = 1;
  }
}

function reportResult(data: Record<string, unknown>): void {
  const reportsDir = path.join(SC_ROOT, "reports");
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
  const resultPath = path.join(reportsDir, `geckoterminal-check-${Date.now()}.json`);
  fs.writeFileSync(resultPath, JSON.stringify({
    platform: "geckoterminal",
    timestamp: new Date().toISOString(),
    ...data,
  }, null, 2));
  log("OK", "reportResult", "Relatório salvo", { path: resultPath });
}

main().catch((error) => {
  log("ERROR", "main", "Erro fatal", { error: (error as Error).message });
  process.exitCode = 1;
});
