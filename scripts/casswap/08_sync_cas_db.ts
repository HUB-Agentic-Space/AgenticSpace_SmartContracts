/**
 * Sync CAS Transactions — importa transferências do Polygonscan para o banco SQLite.
 *
 * Uso:
 *   npx hardhat run scripts/casswap/08_sync_cas_db.ts --network polygon
 *   npm run sync:cas:db
 *
 * Requisitos:
 *   smartcontracts/.env : CAS_TOKEN_ADDRESS, POLYGONSCAN_API_KEY
 */

import { ethers } from "hardhat";
import * as dotenv from "dotenv";
import * as path from "path";
import {
  getDB, closeDB, insertTransaction, upsertAddress,
  getSyncState, setSyncState, recalculateAllAddressStats,
  getTransactionCount, getLastBlockNumber, getLabelMap,
} from "../utils/cas_database";

const SC_ROOT = path.resolve(__dirname, "..", "..");
dotenv.config({ path: path.join(SC_ROOT, ".env") });

type LogLevel = "INFO" | "WARN" | "ERROR" | "OK" | "DEBUG";
function log(level: LogLevel, fn: string, msg: string, p?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const emoji = { INFO: "ℹ️", WARN: "⚠️", ERROR: "❌", OK: "✅", DEBUG: "🔍" }[level];
  console.log(`[${ts}] [08_sync_cas_db:${fn}] ${emoji} ${msg}${p ? ` - ${JSON.stringify(p)}` : ""}`);
}

const CHAIN_ID = 137;
const API_BASES = ["https://api.etherscan.io/v2/api", "https://api.polygonscan.com/api"];
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

interface TokenTransfer {
  hash: string;
  from: string;
  to: string;
  value: string;
  timeStamp: string;
  blockNumber: string;
}

const MAX_RETRIES = 5;
const REQUEST_TIMEOUT_MS = 15_000;
const RATE_LIMIT_EXTRA_DELAY_MS = 2_000;

function isTransientError(status: number, message: string): boolean {
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  if (message.toLowerCase().includes("rate limit") || message.toLowerCase().includes("max rate")) return true;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function scanRequest(params: Record<string, string>): Promise<unknown> {
  const apiKey = process.env.POLYGONSCAN_API_KEY ?? "";
  let lastErr: Error | null = null;

  for (const base of API_BASES) {
    const url = new URL(base);
    if (base.includes("etherscan.io/v2")) url.searchParams.set("chainid", String(CHAIN_ID));
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("apikey", apiKey);

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await fetchWithTimeout(url.toString(), REQUEST_TIMEOUT_MS);
        if (!res.ok) {
          const msg = `HTTP ${res.status}`;
          if (isTransientError(res.status, msg) && attempt < MAX_RETRIES) {
            const backoff = Math.min(1000 * Math.pow(2, attempt - 1), 16_000) + Math.random() * 400;
            const extraDelay = res.status === 429 ? RATE_LIMIT_EXTRA_DELAY_MS : 0;
            log("WARN", "scanRequest", "Erro transitório, retrying", {
              base: base.split("/").pop(),
              action: params.action,
              attempt,
              status: res.status,
              backoffMs: Math.round(backoff + extraDelay),
            });
            await sleep(backoff + extraDelay);
            continue;
          }
          throw new Error(msg);
        }
        const body = (await res.json()) as { status: string; message: string; result: unknown };
        if (body.status === "1" || (body.status === "0" && body.message === "No transactions found"))
          return body.result;
        if (isTransientError(0, body.message) && attempt < MAX_RETRIES) {
          const backoff = Math.min(1000 * Math.pow(2, attempt - 1), 16_000) + Math.random() * 400;
          log("WARN", "scanRequest", "API rate limited, retrying", {
            base: base.split("/").pop(),
            action: params.action,
            attempt,
            message: body.message,
            backoffMs: Math.round(backoff + RATE_LIMIT_EXTRA_DELAY_MS),
          });
          await sleep(backoff + RATE_LIMIT_EXTRA_DELAY_MS);
          continue;
        }
        throw new Error(`API status=${body.status} msg=${body.message}`);
      } catch (err) {
        const errMsg = (err as Error).message;
        const isAbort = errMsg.includes("abort") || errMsg.includes("timeout");
        if ((isAbort || isTransientError(0, errMsg)) && attempt < MAX_RETRIES) {
          const backoff = Math.min(1000 * Math.pow(2, attempt - 1), 16_000) + Math.random() * 400;
          log("WARN", "scanRequest", "Erro transitório/timeout, retrying", {
            base: base.split("/").pop(),
            action: params.action,
            attempt,
            error: errMsg,
            backoffMs: Math.round(backoff),
          });
          await sleep(backoff);
          continue;
        }
        lastErr = err as Error;
        log("WARN", "scanRequest", "Falha na base, tentando fallback", {
          base,
          action: params.action,
          error: errMsg,
          attempt,
        });
        break;
      }
    }
  }
  throw lastErr ?? new Error("API falhou após retries");
}

async function main(): Promise<void> {
  log("INFO", "main", "🚀 Sincronizando transações CAS para banco SQLite");

  const casTokenAddress = process.env.CAS_TOKEN_ADDRESS;
  if (!casTokenAddress) { log("ERROR", "main", "CAS_TOKEN_ADDRESS não definido"); process.exit(1); }

  const db = getDB();
  const beforeCount = getTransactionCount();
  const lastBlock = getLastBlockNumber();
  log("INFO", "main", "Estado atual do banco", { txCount: beforeCount, lastBlock });

  // Pré-popular endereços conhecidos do .env
  const envLabels: Record<string, { label: string; type: string }> = {
    [casTokenAddress.toLowerCase()]: { label: "CASToken (contrato)", type: "contract" },
  };
  const swapAddr = process.env.CAS_SWAP_ADDRESS?.toLowerCase();
  if (swapAddr) envLabels[swapAddr] = { label: "CASSwap (reserva oficial)", type: "contract" };
  const infraAddr = process.env.INFRASTRUCTURE_FUND_ADDRESS?.toLowerCase();
  if (infraAddr) envLabels[infraAddr] = { label: "InfrastructureFund", type: "contract" };
  const diamondAddr = process.env.DIAMOND_ADDRESS?.toLowerCase();
  if (diamondAddr) envLabels[diamondAddr] = { label: "Diamond (proxy)", type: "contract" };
  const deployerAddr = process.env.DEPLOYER_ADDRESS?.toLowerCase();
  if (deployerAddr) envLabels[deployerAddr] = { label: "Deployer/Admin", type: "eoa" };

  for (const [addr, info] of Object.entries(envLabels)) {
    upsertAddress(addr, info.label, info.type, info.type === "contract");
  }
  log("OK", "main", "Endereços conhecidos do .env inseridos", { count: Object.keys(envLabels).length });

  // Buscar todas as transferências
  log("INFO", "main", "Buscando transferências no Polygonscan...");
  const transfers: TokenTransfer[] = [];
  let page = 1;
  for (;;) {
    let result: TokenTransfer[] | string;
    try {
      result = (await scanRequest({
        module: "account", action: "tokentx", contractaddress: casTokenAddress,
        page: String(page), offset: "1000", sort: "asc",
      })) as TokenTransfer[] | string;
    } catch (err) {
      log("ERROR", "main", "Falha ao buscar página após retries", {
        page, error: (err as Error).message, collectedSoFar: transfers.length,
      });
      if (transfers.length > 0) {
        log("WARN", "main", "Prosseguindo com transferências parciais", { total: transfers.length });
        break;
      }
      throw err;
    }
    if (!Array.isArray(result) || result.length === 0) break;
    transfers.push(...result);
    log("DEBUG", "main", "Página coletada", { page, count: result.length, total: transfers.length });
    if (result.length < 1000) break;
    page += 1;
    if (page > 100) { log("WARN", "main", "Limite de 100 páginas"); break; }
    await sleep(300);
  }
  log("OK", "main", "Transferências coletadas", { total: transfers.length });

  // Inserir no banco
  let inserted = 0;
  for (const t of transfers) {
    const isMint = t.from.toLowerCase() === ZERO_ADDR ? 1 : 0;
    const isBurn = t.to.toLowerCase() === ZERO_ADDR ? 1 : 0;

    insertTransaction({
      tx_hash: t.hash,
      block_number: parseInt(t.blockNumber, 10),
      timestamp: parseInt(t.timeStamp, 10),
      from_address: t.from,
      to_address: t.to,
      value: t.value,
      is_mint: isMint,
      is_burn: isBurn,
      label: "",
      description: "",
    });

    // Registrar endereços
    if (!isMint) upsertAddress(t.from, "", "eoa", false);
    if (!isBurn) upsertAddress(t.to, "", "eoa", false);

    inserted++;
  }

  // Recalcular estatísticas
  recalculateAllAddressStats();

  const afterCount = getTransactionCount();
  const newTxCount = afterCount - beforeCount;

  // Estatísticas finais
  const addressCount = (db.prepare("SELECT COUNT(*) as count FROM addresses").get() as { count: number }).count;
  const labeledCount = (db.prepare("SELECT COUNT(*) as count FROM addresses WHERE label != ''").get() as { count: number }).count;

  log("OK", "main", "🏁 Sincronização concluída", {
    transfersFetched: transfers.length,
    newTxInDb: newTxCount,
    totalTxInDb: afterCount,
    addresses: addressCount,
    labeled: labeledCount,
  });

  // Listar endereços sem label para o usuário nomear
  const unlabeled = db.prepare("SELECT address, total_received, tx_count FROM addresses WHERE label = '' ORDER BY tx_count DESC LIMIT 20").all() as { address: string; total_received: string; tx_count: number }[];
  if (unlabeled.length > 0) {
    console.log("\n  Endereços sem nome (use 'npm run cas:db:label' para nomear):");
    for (const u of unlabeled) {
      const received = Number(ethers.formatUnits(BigInt(u.total_received || "0"), 18));
      console.log(`    ${u.address}  recebido: ${received.toLocaleString("pt-BR")} CAS  txs: ${u.tx_count}`);
    }
  }

  // Listar endereços nomeados
  const labeled = db.prepare("SELECT address, label, type FROM addresses WHERE label != '' ORDER BY label").all() as { address: string; label: string; type: string }[];
  if (labeled.length > 0) {
    console.log("\n  Endereços nomeados:");
    for (const l of labeled) {
      console.log(`    ${l.address}  ${l.label}  (${l.type})`);
    }
  }

  setSyncState("last_sync", new Date().toISOString());
  closeDB();
}

main().then(() => process.exit(0)).catch((err) => {
  log("ERROR", "main", "Falha", { error: (err as Error).message });
  console.error(err);
  closeDB();
  process.exit(1);
});
