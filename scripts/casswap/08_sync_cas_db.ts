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

async function scanRequest(params: Record<string, string>): Promise<unknown> {
  const apiKey = process.env.POLYGONSCAN_API_KEY ?? "";
  let lastErr: Error | null = null;
  for (const base of API_BASES) {
    const url = new URL(base);
    if (base.includes("etherscan.io/v2")) url.searchParams.set("chainid", String(CHAIN_ID));
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("apikey", apiKey);
    try {
      const res = await fetch(url.toString());
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { status: string; message: string; result: unknown };
      if (body.status === "1" || (body.status === "0" && body.message === "No transactions found"))
        return body.result;
      throw new Error(`API status=${body.status} msg=${body.message}`);
    } catch (err) { lastErr = err as Error; }
  }
  throw lastErr ?? new Error("API falhou");
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
    const result = (await scanRequest({
      module: "account", action: "tokentx", contractaddress: casTokenAddress,
      page: String(page), offset: "1000", sort: "asc",
    })) as TokenTransfer[] | string;
    if (!Array.isArray(result) || result.length === 0) break;
    transfers.push(...result);
    log("DEBUG", "main", "Página coletada", { page, count: result.length, total: transfers.length });
    if (result.length < 1000) break;
    page += 1;
    if (page > 100) { log("WARN", "main", "Limite de 100 páginas"); break; }
    await new Promise((r) => setTimeout(r, 250));
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
