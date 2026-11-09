/**
 * CAS Sync — sincronização incremental de transferências e pool creators
 * via Etherscan V2 API (multichain, chainid=137) para o banco SQLite local.
 *
 * Funções:
 *   - scanRequest: requisição com retry, fallback de base e rate-limit
 *   - syncTransfers: sync incremental de tokentx, upsert de endereços
 *   - syncPoolCreators: descoberta de pool creators via logs de PairCreated
 *
 * Padrões: Adapter (API → SQLite), Strategy (múltiplas bases com fallback)
 */

import * as path from "path";
import dotenv from "dotenv";
import {
  getDB,
  getLastBlockNumber,
  getTransactionCount,
  insertTransaction,
  upsertAddress,
  setSyncState,
  recalculateAllAddressStats,
  getAllTransactionsFromDB,
  insertPoolCreation,
  getAllPoolCreations,
  type TransactionRecord,
} from "./cas_database";

// ── Env loading ───────────────────────────────────────────────────────

const SC_ROOT = path.resolve(__dirname, "..", "..");

if (!process.env.CAS_TOKEN_ADDRESS) {
  dotenv.config({ path: path.join(SC_ROOT, ".env") });
}

// ── Structured logging ────────────────────────────────────────────────

type LogLevel = "INFO" | "WARN" | "ERROR" | "OK" | "DEBUG";

function log(level: LogLevel, fn: string, message: string, params?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const emoji = { INFO: "ℹ️", WARN: "⚠️", ERROR: "❌", OK: "✅", DEBUG: "🔍" }[level];
  const extra = params ? ` - ${JSON.stringify(params)}` : "";
  console.log(`[${ts}] [cas_sync:${fn}] ${emoji} ${message}${extra}`);
}

// ── Types ─────────────────────────────────────────────────────────────

export interface TokenTransfer {
  hash: string;
  from: string;
  to: string;
  value: string;
  timeStamp: string;
  blockNumber: string;
}

// ── Polygonscan / Etherscan V2 API ────────────────────────────────────

const CHAIN_ID = 137;
// A API V1 dedicada (api.polygonscan.com/api) foi descontinuada e responde
// HTTP 301 para docs.etherscan.io/v2-migration — apenas o endpoint V2
// multichain permanece funcional para a Polygon (chainid=137).
const API_BASES = [
  "https://api.etherscan.io/v2/api",
];

const MAX_RETRIES = 5;
const REQUEST_TIMEOUT_MS = 15_000;
const RATE_LIMIT_EXTRA_DELAY_MS = 2_000;
const RATE_LIMIT_DELAY_MS = 350;
let pinnedBase: string | null = null;

const ZERO = "0x0000000000000000000000000000000000000000";

function isTransientError(status: number, message: string): boolean {
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  const lower = message.toLowerCase();
  if (lower.includes("rate limit") || lower.includes("max rate") || lower.includes("too many requests")) return true;
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
  await sleep(RATE_LIMIT_DELAY_MS);

  let lastError: Error | null = null;
  const bases = pinnedBase
    ? [pinnedBase, ...API_BASES.filter((b) => b !== pinnedBase)]
    : API_BASES;

  for (const base of bases) {
    const isEtherscanV2 = base.includes("etherscan.io/v2");
    const apiKey = isEtherscanV2
      ? (process.env.ETHERSCAN_API_KEY?.trim() || process.env.POLYGONSCAN_API_KEY?.trim() || "")
      : (process.env.POLYGONSCAN_API_KEY?.trim() || "");
    const url = new URL(base);
    if (isEtherscanV2) url.searchParams.set("chainid", String(CHAIN_ID));
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("apikey", apiKey);

    log("DEBUG", "scanRequest", "Tentando base", {
      base: base.split("/").pop(),
      action: params.action,
      hasApiKey: apiKey.length > 0,
    });

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await fetchWithTimeout(url.toString(), REQUEST_TIMEOUT_MS);
        if (!res.ok) {
          const msg = `HTTP ${res.status}`;
          if (isTransientError(res.status, msg) && attempt < MAX_RETRIES) {
            const backoff = Math.min(1000 * Math.pow(2, attempt - 1), 16_000) + Math.random() * 400;
            const extraDelay = res.status === 429 ? RATE_LIMIT_EXTRA_DELAY_MS : 0;
            await sleep(backoff + extraDelay);
            continue;
          }
          throw new Error(msg);
        }
        const contentType = res.headers.get("content-type") ?? "";
        if (!contentType.includes("application/json")) {
          const textBody = await res.text();
          const isHtml = textBody.trimStart().startsWith("<");
          const detail = isHtml ? "Resposta HTML" : textBody.slice(0, 200);
          if (isTransientError(res.status, detail) && attempt < MAX_RETRIES) {
            const backoff = Math.min(1000 * Math.pow(2, attempt - 1), 16_000) + Math.random() * 400;
            await sleep(backoff + RATE_LIMIT_EXTRA_DELAY_MS);
            continue;
          }
          throw new Error(`Resposta não-JSON (${contentType}): ${detail}`);
        }
        const body = (await res.json()) as {
          status?: string;
          message?: string;
          result?: unknown;
          jsonrpc?: string;
          error?: { code?: number; message?: string };
        };

        // Envelope JSON-RPC (module=proxy): {jsonrpc, id, result|error} — sem status/message.
        if (body.jsonrpc === "2.0") {
          const rpcError = body.error;
          if (rpcError) {
            const rpcMsg = `RPC ${rpcError.code ?? "?"}: ${rpcError.message ?? "erro desconhecido"}`;
            if (isTransientError(rpcError.code ?? 0, rpcMsg) && attempt < MAX_RETRIES) {
              const backoff = Math.min(1000 * Math.pow(2, attempt - 1), 16_000) + Math.random() * 400;
              await sleep(backoff);
              continue;
            }
            throw new Error(rpcMsg);
          }
          if (pinnedBase === null) pinnedBase = base;
          return body.result;
        }

        // status=0 com "No ... found" é resultado vazio válido (ex.: getLogs
        // retorna "No records found"), não erro de API.
        const apiMessage = body.message ?? "";
        const isBenignEmpty = body.status === "0" && /^no [\w ]*found$/i.test(apiMessage);
        if (body.status === "1" || isBenignEmpty) {
          if (pinnedBase === null) pinnedBase = base;
          return body.result;
        }
        const resultStr = typeof body.result === "string" ? body.result : JSON.stringify(body.result);
        const combinedMsg = `${apiMessage} ${resultStr}`;
        if (isTransientError(0, combinedMsg) && attempt < MAX_RETRIES) {
          const backoff = Math.min(1000 * Math.pow(2, attempt - 1), 16_000) + Math.random() * 400;
          await sleep(backoff + RATE_LIMIT_EXTRA_DELAY_MS);
          continue;
        }
        throw new Error(`API status=${body.status} message=${apiMessage} result=${resultStr.slice(0, 200)}`);
      } catch (err) {
        const errMsg = (err as Error).message;
        const isAbort = errMsg.includes("abort") || errMsg.includes("timeout");
        if ((isAbort || isTransientError(0, errMsg)) && attempt < MAX_RETRIES) {
          const backoff = Math.min(1000 * Math.pow(2, attempt - 1), 16_000) + Math.random() * 400;
          await sleep(backoff);
          continue;
        }
        lastError = err as Error;
        break;
      }
    }
  }
  throw lastError ?? new Error("Todas as bases da API falharam após retries");
}

// ── Transfer sync ─────────────────────────────────────────────────────

/**
 * Sincroniza incrementalmente as transferências do token CAS via API,
 * inserindo novas transações e endereços no banco SQLite.
 *
 * Retorna todas as transferências do banco (não apenas as novas).
 */
export async function syncTransfers(tokenAddress: string): Promise<TokenTransfer[]> {
  const MAX_BLOCK = 999_999_999;
  const PAGE_SIZE = 10_000;

  getDB();

  const lastSyncedBlock = getLastBlockNumber();
  const dbCount = getTransactionCount();
  log("INFO", "syncTransfers", "Sync incremental via paginação sequencial", {
    token: tokenAddress, dbTxCount: dbCount, lastSyncedBlock,
  });

  const startBlock = lastSyncedBlock > 0 ? lastSyncedBlock + 1 : 0;
  let currentStartBlock = startBlock;
  let newCount = 0;

  for (;;) {
    let result: TokenTransfer[] | string;
    try {
      result = await scanRequest({
        module: "account",
        action: "tokentx",
        contractaddress: tokenAddress,
        startblock: String(currentStartBlock),
        endblock: String(MAX_BLOCK),
        offset: String(PAGE_SIZE),
        sort: "asc",
      }) as TokenTransfer[] | string;
    } catch (err) {
      log("ERROR", "syncTransfers", "Falha ao buscar página após retries", {
        startBlock: currentStartBlock,
        error: (err as Error).message,
      });
      if (dbCount + newCount > 0) break;
      throw err;
    }

    if (!Array.isArray(result) || result.length === 0) break;

    for (const t of result) {
      const isMint = t.from.toLowerCase() === ZERO ? 1 : 0;
      const isBurn = t.to.toLowerCase() === ZERO ? 1 : 0;

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

      if (!isMint) upsertAddress(t.from, "", "eoa", false);
      if (!isBurn) upsertAddress(t.to, "", "eoa", false);
    }

    newCount += result.length;
    const lastTxBlock = parseInt(result[result.length - 1].blockNumber, 10);

    if (result.length < PAGE_SIZE) break;
    currentStartBlock = lastTxBlock + 1;
  }

  if (newCount > 0) {
    recalculateAllAddressStats();
    setSyncState("last_sync", new Date().toISOString());
  }

  const totalCount = getTransactionCount();
  log("OK", "syncTransfers", "Sync concluído", { newTx: newCount, totalDbTx: totalCount });

  return loadTransfersFromDB();
}

/**
 * Carrega todas as transferências do banco SQLite.
 */
export function loadTransfersFromDB(): TokenTransfer[] {
  const dbTxs = getAllTransactionsFromDB();
  const transfers = dbTxs.map((t: TransactionRecord) => ({
    hash: t.tx_hash,
    from: t.from_address,
    to: t.to_address,
    value: t.value,
    timeStamp: String(t.timestamp),
    blockNumber: String(t.block_number),
  }));
  transfers.sort((a, b) => parseInt(a.blockNumber, 10) - parseInt(b.blockNumber, 10));
  return transfers;
}

// ── Pool creator discovery ────────────────────────────────────────────

interface PoolCreatorInfo {
  pairAddress: string;
  factoryAddress: string;
  creatorAddress: string;
  token0: string;
  token1: string;
  txHash: string;
  blockNumber: number;
  timestamp: number;
  dexName: string;
}

// Protocolos cobertos pela descoberta de pools: factories V2-style
// (PairCreated), Uniswap V3 (PoolCreated), Algebra (Pool) e Uniswap V4
// (Initialize no PoolManager singleton — não existe contrato de pair,
// o identificador único do pool é o PoolId bytes32 em topics[1]).
type PoolEventKind = "v2" | "v3" | "v4" | "algebra";

interface DexPoolSource {
  name: string;
  kind: PoolEventKind;
  address: string;
}

// keccak256 do evento de criação de pool de cada protocolo.
const POOL_EVENT_TOPICS: Record<PoolEventKind, string> = {
  v2: "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9", // PairCreated(address,address,address,uint256)
  v3: "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118", // PoolCreated(address,address,uint24,int24,address)
  algebra: "0x91ccaa7a278130b65168c3a0c8d3bcae84cf5e43704342bd3ec0b59e59c036db", // Pool(address,address,address)
  v4: "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438", // Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)
};

const POOL_EVENT_NAMES: Record<PoolEventKind, string> = {
  v2: "PairCreated",
  v3: "PoolCreated",
  algebra: "Pool",
  v4: "Initialize",
};

function envAddress(...keys: string[]): string | null {
  for (const key of keys) {
    const v = process.env[key]?.trim();
    if (v) return v;
  }
  return null;
}

// Fontes de criação de pools na Polygon mainnet. Endereços canônicos
// verificados on-chain (via factory() dos LP pairs e eventos emitidos);
// todos sobrescrevíveis via .env. Fontes sem endereço são ignoradas —
// Uniswap V2 não tem factory canônica na Polygon e só entra se
// UNISWAP_V2_FACTORY_ADDRESS/_FACTORY estiver configurado.
function poolSources(): DexPoolSource[] {
  const defs: { name: string; kind: PoolEventKind; address: string | null }[] = [
    { name: "QuickSwap", kind: "v2", address: envAddress("QUICKSWAP_FACTORY_ADDRESS") ?? "0x5757371414417b8c6caad45baef941abc7d3ab32" },
    { name: "SushiSwap", kind: "v2", address: envAddress("SUSHISWAP_FACTORY_ADDRESS") ?? "0xc35DADB65012eC5796536bD9864eD8773aBc74C4" },
    { name: "ApeSwap", kind: "v2", address: envAddress("APESWAP_FACTORY_ADDRESS") ?? "0xCf083Be4164828f00cAE704EC15a36D711491284" },
    { name: "Dfyn", kind: "v2", address: envAddress("DFYN_FACTORY_ADDRESS") ?? "0xE7Fb3e833eFE5F9c441105EB65Ef8b261266423b" },
    { name: "Uniswap V2", kind: "v2", address: envAddress("UNISWAP_V2_FACTORY_ADDRESS", "UNISWAP_V2_FACTORY") },
    { name: "Uniswap V3", kind: "v3", address: envAddress("UNISWAP_V3_FACTORY_ADDRESS", "UNISWAP_V3_FACTORY") ?? "0x1F98431c8aD98523631AE4a59f267346ea31F984" },
    { name: "QuickSwap V3 (Algebra)", kind: "algebra", address: envAddress("QUICKSWAP_V3_FACTORY_ADDRESS") ?? "0x411b0facc3489691f28ad58c47006af5e3ab3a28" },
    { name: "Uniswap V4", kind: "v4", address: envAddress("UNISWAP_V4_POOL_MANAGER_ADDRESS", "UNISWAP_V4_POOL_MANAGER") ?? "0x67366782805870060151383f4bbff9dab53e5cd6" },
  ];
  return defs.filter((d): d is DexPoolSource => d.address !== null);
}

function padAddress(addr: string): string {
  const clean = addr.toLowerCase().replace(/^0x/, "");
  return "0x" + clean.padStart(64, "0");
}

interface PolygonscanLog {
  address: string;
  topics: string[];
  data: string;
  transactionHash: string;
  blockNumber: string;
  timeStamp: string;
  logIndex?: string;
}

interface PolygonscanTx {
  from: string;
  to: string;
  hash: string;
}

async function fetchTxSender(txHash: string): Promise<string | null> {
  try {
    const result = await scanRequest({
      module: "proxy",
      action: "eth_getTransactionByHash",
      txhash: txHash,
    });
    const tx = result as PolygonscanTx;
    return tx?.from ?? null;
  } catch (err) {
    log("WARN", "fetchTxSender", "Falha ao buscar tx sender", { txHash: txHash.slice(0, 20), error: (err as Error).message });
    return null;
  }
}

// Extrai um endereço de um tópico indexado (32 bytes, 20 bytes finais).
function topicAddress(entry: PolygonscanLog, index: number): string {
  return "0x" + (entry.topics[index]?.slice(26) ?? "").toLowerCase();
}

// Extrai um endereço de uma word de `data` (non-indexed, 20 bytes finais).
function dataAddress(entry: PolygonscanLog, word: number): string {
  const start = 2 + word * 64 + 24;
  return "0x" + (entry.data ?? "").slice(start, start + 40).toLowerCase();
}

/**
 * Decodifica um log de criação de pool conforme o layout do protocolo.
 *
 * - v2/algebra: token0/topics[1], token1/topics[2], pool em data word 0.
 * - v3: token0/topics[1], token1/topics[2], fee/topics[3], pool em data word 1.
 * - v4: PoolId/topics[1], currency0/topics[2], currency1/topics[3]. Em V4
 *   não existe contrato de pair — o PoolId (bytes32) é registrado em
 *   `pair_address` por ser a chave única do pool.
 *
 * @returns `{pairAddress, token0, token1}` ou `null` se o log não decodifica.
 */
function parsePoolLog(
  source: DexPoolSource,
  entry: PolygonscanLog,
): { pairAddress: string; token0: string; token1: string } | null {
  if (source.kind === "v4") {
    const pairAddress = (entry.topics[1] ?? "").toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(pairAddress)) return null;
    return { pairAddress, token0: topicAddress(entry, 2), token1: topicAddress(entry, 3) };
  }
  const pairAddress = dataAddress(entry, source.kind === "v3" ? 1 : 0);
  if (!/^0x[0-9a-f]{40}$/.test(pairAddress)) return null;
  return { pairAddress, token0: topicAddress(entry, 1), token1: topicAddress(entry, 2) };
}

/**
 * Descobre e registra pool creators do token CAS via logs de criação de
 * pools (PairCreated/PoolCreated/Pool/Initialize) nas fontes DEX
 * conhecidas — V2-style, Uniswap V3, Algebra e Uniswap V4.
 */
export async function syncPoolCreators(tokenAddress: string): Promise<void> {
  const results: PoolCreatorInfo[] = [];
  const paddedToken = padAddress(tokenAddress);
  const dbPools = getAllPoolCreations();
  const knownPairs = new Set(dbPools.map((p) => p.pair_address.toLowerCase()));

  for (const source of poolSources()) {
    const sourceLower = source.address.toLowerCase();
    const alreadySynced = dbPools.some(
      (p) => p.factory_address.toLowerCase() === sourceLower,
    );

    if (alreadySynced) {
      log("INFO", "syncPoolCreators", `Fonte ${source.name} já sincronizada, pulando API`, { address: source.address });
      continue;
    }

    const eventName = POOL_EVENT_NAMES[source.kind];
    log("INFO", "syncPoolCreators", `Buscando ${eventName} em ${source.name}`, { kind: source.kind, address: source.address });

    // O token pode ocupar qualquer posição indexada do par/currency;
    // consulta ambas e mescla (v4: currency0/topics[2], currency1/topics[3]).
    const tokenParams = source.kind === "v4" ? ["topic2", "topic3"] : ["topic1", "topic2"];
    const logsByKey = new Map<string, PolygonscanLog>();
    for (const topicParam of tokenParams) {
      try {
        const raw = await scanRequest({
          module: "logs",
          action: "getLogs",
          fromBlock: "0",
          toBlock: "latest",
          address: source.address,
          topic0: POOL_EVENT_TOPICS[source.kind],
          [topicParam]: paddedToken,
        });
        for (const entry of raw as PolygonscanLog[]) {
          logsByKey.set(`${entry.transactionHash}:${entry.logIndex ?? "0"}`, entry);
        }
      } catch (err) {
        log("WARN", "syncPoolCreators", `Falha ao buscar logs de ${source.name}`, { topicParam, error: (err as Error).message });
      }
    }
    const logs = [...logsByKey.values()];

    if (logs.length === 0) {
      log("INFO", "syncPoolCreators", `Nenhum pool encontrado em ${source.name}`);
      continue;
    }

    log("OK", "syncPoolCreators", `Pools encontrados em ${source.name}`, { count: logs.length });

    for (const logEntry of logs) {
      const parsed = parsePoolLog(source, logEntry);
      if (!parsed) {
        log("WARN", "syncPoolCreators", `Log ${eventName} sem identificador de pool válido`, { txHash: logEntry.transactionHash.slice(0, 20) });
        continue;
      }
      const { pairAddress, token0, token1 } = parsed;

      if (knownPairs.has(pairAddress)) continue;

      const creator = await fetchTxSender(logEntry.transactionHash);
      if (!creator) {
        log("WARN", "syncPoolCreators", "Não foi possível obter criador", { pairAddress, txHash: logEntry.transactionHash.slice(0, 20) });
        continue;
      }

      const info: PoolCreatorInfo = {
        pairAddress,
        factoryAddress: sourceLower,
        creatorAddress: creator.toLowerCase(),
        token0,
        token1,
        txHash: logEntry.transactionHash.toLowerCase(),
        blockNumber: parseInt(logEntry.blockNumber, 16),
        timestamp: parseInt(logEntry.timeStamp, 16),
        dexName: source.name,
      };

      results.push(info);
      knownPairs.add(pairAddress);

      insertPoolCreation({
        pair_address: info.pairAddress,
        factory_address: info.factoryAddress,
        creator_address: info.creatorAddress,
        token0: info.token0,
        token1: info.token1,
        tx_hash: info.txHash,
        block_number: info.blockNumber,
        timestamp: info.timestamp,
        dex_name: info.dexName,
      });

      upsertAddress(info.creatorAddress, `Pool Creator (${source.name})`, "pool_creator", false);
      // V4 não tem contrato de pair (PoolId bytes32) — só endereços reais
      // são registrados como LP na tabela de endereços.
      if (/^0x[0-9a-f]{40}$/.test(pairAddress)) {
        upsertAddress(info.pairAddress, `${source.name} Pool`, "lp", true);
      }

      log("OK", "syncPoolCreators", "Pool registrado", {
        dex: source.name,
        pair: pairAddress,
        creator: creator.toLowerCase(),
        block: info.blockNumber,
      });
    }
  }

  log("OK", "syncPoolCreators", "Sincronização de pool creators concluída", { totalPools: results.length });
}

/**
 * Verifica se a API key está configurada para permitir sync.
 */
export function hasApiKey(): boolean {
  return !!process.env.POLYGONSCAN_API_KEY?.trim();
}
