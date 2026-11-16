/**
 * CAS Sync — sincronização incremental de transferências e pool creators
 * via Etherscan V2 API (multichain, chainid=137) para o banco SQLite local.
 *
 * Funções:
 *   - scanRequest: requisição com retry progressivo, fallback de base,
 *     rate-limit, Retry-After e circuit breaker de bases mortas
 *   - fetchTotalSupply: tokensupply com fallback eth_call via scan e RPC direto
 *   - syncTransfers: sync incremental de tokentx, upsert de endereços e
 *     fallback eth_getLogs via RPC quando o índice do scan está parado
 *   - syncPoolCreators: descoberta de pool creators via logs de PairCreated
 *
 * Padrões: Adapter (API → SQLite), Strategy (múltiplas bases com fallback),
 * Circuit Breaker (bases marcadas como mortas são puladas no processo)
 *
 * Author: Carlos Delfino
 * Email: consultoria@carlosdelfino.eti.br
 * WhatsApp: +55 (85) 98520-5490
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
const REQUEST_TIMEOUT_STEP_MS = 15_000;
const REQUEST_TIMEOUT_MAX_MS = 60_000;
const RATE_LIMIT_EXTRA_DELAY_MS = 2_000;
const RATE_LIMIT_DELAY_MS = 350;
const RETRY_AFTER_MAX_MS = 60_000;
let pinnedBase: string | null = null;

// Bases que retornaram falha determinística (página HTML/redirect em
// endpoint de API) são marcadas como mortas e puladas pelo resto do
// processo — evita que chamadas concorrentes a frio repitam o custo de
// uma base fora do ar antes de pinnedBase ser fixado.
const deadBases = new Set<string>();

const ZERO = "0x0000000000000000000000000000000000000000";

// Códigos de erro de rede (undici/Node) que indicam falha transitória.
// fetch() encapsula-os em `TypeError: fetch failed` com `cause.code` —
// a mensagem sozinha ("fetch failed") não permite classificação.
const TRANSIENT_NET_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
]);

function isTransientError(status: number, message: string): boolean {
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  const lower = message.toLowerCase();
  if (lower.includes("rate limit") || lower.includes("max rate") || lower.includes("too many requests")) return true;
  return false;
}

function isTransientNetError(err: unknown): boolean {
  const msg = (err as Error)?.message?.toLowerCase() ?? "";
  if (msg.includes("abort") || msg.includes("timeout")) return true;
  const code = (err as { cause?: { code?: string } })?.cause?.code;
  if (code && TRANSIENT_NET_CODES.has(code)) return true;
  return isTransientError(0, msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Timeout progressivo por tentativa: um abort de 15s indica endpoint
// lento — retry com o mesmo orçamento tende a falhar de novo.
function attemptTimeout(attempt: number): number {
  return Math.min(REQUEST_TIMEOUT_MS + (attempt - 1) * REQUEST_TIMEOUT_STEP_MS, REQUEST_TIMEOUT_MAX_MS);
}

// Honra o header Retry-After (segundos ou data HTTP) quando presente —
// usado como piso do backoff em 429 e respostas não-JSON (challenge).
function retryAfterMs(res: Response): number {
  const header = res.headers.get("retry-after");
  if (!header) return 0;
  const secs = Number(header);
  if (!Number.isNaN(secs)) return Math.min(Math.max(secs, 0) * 1000, RETRY_AFTER_MAX_MS);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), RETRY_AFTER_MAX_MS);
  return 0;
}

function markBaseDead(base: string, reason: string): void {
  deadBases.add(base);
  if (pinnedBase === base) pinnedBase = null;
  log("WARN", "scanRequest", "Base marcada como indisponível", { base, reason });
}

/**
 * Reseta o estado interno do cliente scan (base pinada + circuit breaker).
 * Exposto para testes unitários — não usar em fluxo normal.
 */
export function resetScanApiState(): void {
  pinnedBase = null;
  deadBases.clear();
}

async function fetchWithTimeout(url: string, timeoutMs: number, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function scanRequest(params: Record<string, string>): Promise<unknown> {
  await sleep(RATE_LIMIT_DELAY_MS);

  let lastError: Error | null = null;
  const liveBases = API_BASES.filter((b) => !deadBases.has(b));
  const bases = pinnedBase && !deadBases.has(pinnedBase)
    ? [pinnedBase, ...liveBases.filter((b) => b !== pinnedBase)]
    : liveBases;

  if (bases.length === 0) {
    throw new Error("Todas as bases da API estão indisponíveis (dead bases)");
  }

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
        const res = await fetchWithTimeout(url.toString(), attemptTimeout(attempt));
        if (!res.ok) {
          const msg = `HTTP ${res.status}`;
          if (isTransientError(res.status, msg) && attempt < MAX_RETRIES) {
            const backoff = Math.max(
              Math.min(1000 * Math.pow(2, attempt - 1), 16_000) + Math.random() * 400,
              retryAfterMs(res),
            );
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
        const contentType = res.headers.get("content-type") ?? "";
        if (!contentType.includes("application/json")) {
          const textBody = await res.text();
          const isHtml = textBody.trimStart().startsWith("<");
          const detail = isHtml ? "Resposta HTML" : textBody.slice(0, 200);
          if (isTransientError(res.status, detail) && attempt < MAX_RETRIES) {
            const backoff = Math.max(
              Math.min(1000 * Math.pow(2, attempt - 1), 16_000) + Math.random() * 400,
              retryAfterMs(res),
            );
            log("WARN", "scanRequest", "Resposta não-JSON, retrying", {
              base: base.split("/").pop(),
              action: params.action,
              attempt,
              contentType,
              backoffMs: Math.round(backoff + RATE_LIMIT_EXTRA_DELAY_MS),
            });
            await sleep(backoff + RATE_LIMIT_EXTRA_DELAY_MS);
            continue;
          }
          // Resposta definitiva não-API (página HTML de redirect/endpoint
          // descontinuado): marca a base como morta para o resto do
          // processo em vez de repeti-la a cada chamada.
          if (isHtml) markBaseDead(base, `Resposta não-JSON (${contentType})`);
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
          log("WARN", "scanRequest", "API rate limited, retrying", {
            base: base.split("/").pop(),
            action: params.action,
            attempt,
            message: apiMessage,
            backoffMs: Math.round(backoff + RATE_LIMIT_EXTRA_DELAY_MS),
          });
          await sleep(backoff + RATE_LIMIT_EXTRA_DELAY_MS);
          continue;
        }
        throw new Error(`API status=${body.status} message=${apiMessage} result=${resultStr.slice(0, 200)}`);
      } catch (err) {
        const errMsg = (err as Error).message;
        if (isTransientNetError(err) && attempt < MAX_RETRIES) {
          const backoff = Math.min(1000 * Math.pow(2, attempt - 1), 16_000) + Math.random() * 400;
          log("WARN", "scanRequest", "Erro transitório/timeout, retrying", {
            base: base.split("/").pop(),
            action: params.action,
            attempt,
            timeoutMs: attemptTimeout(attempt),
            error: errMsg,
            backoffMs: Math.round(backoff),
          });
          await sleep(backoff);
          continue;
        }
        lastError = err as Error;
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
  throw lastError ?? new Error("Todas as bases da API falharam após retries");
}

// ── Total supply com fallback ─────────────────────────────────────────

// Seletor ABI de totalSupply() — ERC-20, uint256 sem argumentos.
const TOTAL_SUPPLY_SELECTOR = "0x18160ddd";

/**
 * Chamada JSON-RPC direta a um endpoint RPC — caminho independente do
 * scan, usado como último fallback. Retry curto com backoff exponencial.
 */
async function rpcCall(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetchWithTimeout(rpcUrl, attemptTimeout(attempt), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { result?: unknown; error?: { code?: number; message?: string } };
      if (body.error) throw new Error(`RPC ${body.error.code ?? "?"}: ${body.error.message ?? "erro desconhecido"}`);
      return body.result;
    } catch (err) {
      lastError = err as Error;
      if (isTransientNetError(err) && attempt < 3) {
        await sleep(Math.min(1000 * Math.pow(2, attempt - 1), 8_000) + Math.random() * 400);
        continue;
      }
      throw lastError;
    }
  }
  throw lastError ?? new Error("rpcCall falhou após retries");
}

/**
 * Obtém o totalSupply do token com cadeia de fallback:
 *   1. stats/tokensupply (Etherscan V2);
 *   2. proxy/eth_call totalSupply() (mesma API, envelope JSON-RPC);
 *   3. eth_call direto ao POLYGON_RPC_URL — caminho independente do scan.
 */
export async function fetchTotalSupply(tokenAddress: string): Promise<bigint> {
  try {
    const result = (await scanRequest({
      module: "stats",
      action: "tokensupply",
      contractaddress: tokenAddress,
    })) as string;
    return BigInt(result);
  } catch (err) {
    log("WARN", "fetchTotalSupply", "tokensupply falhou, tentando eth_call via scan", {
      error: (err as Error).message,
    });
  }

  try {
    const result = (await scanRequest({
      module: "proxy",
      action: "eth_call",
      to: tokenAddress,
      data: TOTAL_SUPPLY_SELECTOR,
      tag: "latest",
    })) as string;
    return BigInt(result);
  } catch (err) {
    log("WARN", "fetchTotalSupply", "eth_call via scan falhou, tentando RPC direto", {
      error: (err as Error).message,
    });
  }

  const rpcUrl = rpcEndpoints()[0];
  const result = (await rpcCall(rpcUrl, "eth_call", [
    { to: tokenAddress, data: TOTAL_SUPPLY_SELECTOR },
    "latest",
  ])) as string;
  log("OK", "fetchTotalSupply", "Total supply via RPC direto", { rpcUrl: new URL(rpcUrl).hostname });
  return BigInt(result);
}

// ── RPC endpoints com fallback ────────────────────────────────────────

// RPCs públicos da Polygon usados quando POLYGON_RPC_URL falha, está
// rate-limited ou rejeita o range do eth_getLogs. A ordem é estável:
// primeiro a URL configurada, depois os fallbacks públicos.
const RPC_FALLBACK_URLS = [
  "https://polygon-bor-rpc.publicnode.com",
  "https://gateway.tenderly.co/public/polygon",
  "https://polygon.api.onfinality.io/public",
  "https://polygon.drpc.org",
  "https://1rpc.io/matic",
  "https://polygon.llamarpc.com",
];

function rpcEndpoints(): string[] {
  const urls: string[] = [];
  const env = process.env.POLYGON_RPC_URL?.trim();
  if (env) urls.push(env);
  for (const u of RPC_FALLBACK_URLS) if (!urls.includes(u)) urls.push(u);
  return urls;
}

/**
 * Executa uma chamada JSON-RPC tentando cada endpoint configurado até um
 * responder — Strategy sobre rpcCall com rotação de endpoints.
 */
async function rpcCallAny(method: string, params: unknown[]): Promise<unknown> {
  let lastError: Error | null = null;
  for (const url of rpcEndpoints()) {
    if (deadRpcEndpoints.has(url)) continue;
    try {
      return await rpcCall(url, method, params);
    } catch (err) {
      lastError = err as Error;
      if (isDeterministicRpcError(err)) deadRpcEndpoints.add(url);
      log("WARN", "rpcCallAny", "RPC falhou, tentando próximo endpoint", {
        rpc: new URL(url).hostname,
        method,
        error: lastError.message,
      });
    }
  }
  throw lastError ?? new Error("rpcCallAny: todos os endpoints falharam");
}

interface JsonRpcRequest {
  method: string;
  params: unknown[];
}

/**
 * Executa um lote JSON-RPC (array de requests) contra o primeiro endpoint
 * que responder corretamente. Cada resposta é casada pelo id; item com
 * erro individual reprova o lote inteiro e roda o próximo endpoint.
 */
async function rpcBatchAny(requests: JsonRpcRequest[]): Promise<unknown[]> {
  const payload = requests.map((r, i) => ({ jsonrpc: "2.0", id: i + 1, method: r.method, params: r.params }));
  let lastError: Error | null = null;
  for (const url of rpcEndpoints()) {
    if (deadRpcEndpoints.has(url)) continue;
    try {
      const res = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const arr = (await res.json()) as { id: number; result?: unknown; error?: { message?: string } }[];
      if (!Array.isArray(arr)) throw new Error("Resposta batch inválida");
      const byId = new Map(arr.map((item) => [item.id, item]));
      return payload.map((req) => {
        const item = byId.get(req.id);
        if (!item) throw new Error("Resposta ausente no batch");
        if (item.error) throw new Error(`RPC batch item: ${item.error.message ?? "erro desconhecido"}`);
        return item.result;
      });
    } catch (err) {
      lastError = err as Error;
      if (isDeterministicRpcError(err)) deadRpcEndpoints.add(url);
      log("WARN", "rpcBatchAny", "Batch RPC falhou, tentando próximo endpoint", {
        rpc: new URL(url).hostname,
        error: lastError.message,
      });
    }
  }
  throw lastError ?? new Error("rpcBatchAny: todos os endpoints falharam");
}

// ── Transfer sync ─────────────────────────────────────────────────────

// Tópico keccak256 do evento ERC-20 Transfer(address,address,uint256).
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// Span máximo coberto pelo fallback eth_getLogs quando o banco está
// vazio ou muito atrasado — o fallback é um preenchedor de lacuna, não
// um indexador completo (o histórico inteiro vem do índice do scan).
const RPC_LOGS_MAX_SPAN = 1_000_000;
const GETLOGS_CHUNK_INITIAL = 5_000;
const GETLOGS_CHUNK_MIN = 100;
const BLOCK_TS_BATCH_SIZE = 50;
const CHUNK_TRANSIENT_RETRIES = 4;
const CHUNK_TRANSIENT_DELAY_MS = 5_000;

interface RpcTransferLog {
  transactionHash: string;
  blockNumber: string;
  logIndex?: string;
  topics: string[];
  data: string;
}

// Estado de capacidade por endpoint válido durante o processo: endpoints
// que rejeitam deterministicamente (HTTP 4xx, método não suportado) são
// marcados como mortos; endpoints com limite de span de blocos registram
// o limite e são pulados quando o chunk pedido o excede; endpoints que
// falham N vezes seguidas (429 persistente, conexão recusada) são pulados
// pelo resto da varredura.
const deadRpcEndpoints = new Set<string>();
const rpcSpanLimits = new Map<string, number>();
const rpcFailStreaks = new Map<string, number>();
const RPC_FAIL_STREAK_MAX = 3;

// RPCs gratuitos limitam o span de blocos do eth_getLogs com mensagens
// que variam entre provedores ("range over N blocks", "limited to N blocks").
function isLogRangeError(err: unknown): boolean {
  const msg = (err as Error)?.message?.toLowerCase() ?? "";
  return msg.includes("range") || msg.includes("too many") || msg.includes("exceed") || msg.includes("limited");
}

// Falhas determinísticas que não valem retry nem rotação posterior:
// HTTP 4xx (exceto 429) e "method not found".
function isDeterministicRpcError(err: unknown): boolean {
  const msg = (err as Error)?.message?.toLowerCase() ?? "";
  if (/http 4\d\d/.test(msg) && !msg.includes("429")) return true;
  return msg.includes("method not found") || msg.includes("-32601");
}

// Extrai o limite de blocos da mensagem do provedor quando presente
// ("ranges over 10000 blocks", "limited to 0 - 50 blocks range").
function parseSpanLimit(msg: string): number | null {
  const m = msg.match(/(\d[\d,_]*)\s*blocks?/i);
  if (!m) return null;
  const n = parseInt(m[1].replace(/[,_]/g, ""), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * eth_getLogs com rotação de endpoints RPC — cada provedor gratuito tem
 * limites de range e rate-limit diferentes. O erro propagado carrega a
 * flag `rangeLimited` quando TODOS os endpoints tentáveis rejeitaram o
 * range, permitindo ao chamador reduzir o chunk em vez de abortar.
 */
async function ethGetLogsAny(address: string, fromBlock: number, toBlock: number): Promise<RpcTransferLog[]> {
  const span = toBlock - fromBlock + 1;
  let lastError: Error | null = null;
  let attempted = 0;
  let rangeFailures = 0;

  for (const url of rpcEndpoints()) {
    if (deadRpcEndpoints.has(url)) continue;
    if ((rpcFailStreaks.get(url) ?? 0) >= RPC_FAIL_STREAK_MAX) continue;
    const knownLimit = rpcSpanLimits.get(url);
    if (knownLimit !== undefined && span > knownLimit) continue;

    attempted++;
    try {
      const result = (await rpcCall(url, "eth_getLogs", [{
        address,
        topics: [TRANSFER_TOPIC],
        fromBlock: `0x${fromBlock.toString(16)}`,
        toBlock: `0x${toBlock.toString(16)}`,
      }])) as RpcTransferLog[] | null;
      rpcFailStreaks.delete(url);
      return result ?? [];
    } catch (err) {
      lastError = err as Error;
      const msg = lastError.message.toLowerCase();
      rpcFailStreaks.set(url, (rpcFailStreaks.get(url) ?? 0) + 1);
      if (isLogRangeError(err)) {
        rangeFailures++;
        rpcSpanLimits.set(url, parseSpanLimit(msg) ?? span - 1);
      } else if (isDeterministicRpcError(err)) {
        deadRpcEndpoints.add(url);
      }
      log("WARN", "ethGetLogsAny", "eth_getLogs falhou, tentando próximo RPC", {
        rpc: new URL(url).hostname,
        fromBlock,
        toBlock,
        error: lastError.message,
      });
    }
  }

  const err = lastError ?? new Error("eth_getLogs falhou em todos os RPCs");
  // attempted === 0: todos pulados por limite de span conhecido — o chunk
  // pedido excede o teto de todos os endpoints vivos, trate como range.
  if (attempted === 0 || rangeFailures === attempted) {
    (err as Error & { rangeLimited?: boolean }).rangeLimited = true;
  }
  throw err;
}

/**
 * Busca timestamps de blocos em lote JSON-RPC; se o batch falhar em todos
 * os endpoints, cai para chamadas sequenciais por bloco.
 */
async function fetchBlockTimestamps(blocks: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  for (let i = 0; i < blocks.length; i += BLOCK_TS_BATCH_SIZE) {
    const slice = blocks.slice(i, i + BLOCK_TS_BATCH_SIZE);
    try {
      const results = await rpcBatchAny(
        slice.map((b) => ({ method: "eth_getBlockByNumber", params: [`0x${b.toString(16)}`, false] })),
      );
      slice.forEach((b, j) => {
        const ts = parseInt((results[j] as { timestamp?: string } | null)?.timestamp ?? "0x0", 16);
        out.set(b, ts);
      });
    } catch {
      for (const b of slice) {
        const blk = (await rpcCallAny("eth_getBlockByNumber", [`0x${b.toString(16)}`, false])) as { timestamp?: string } | null;
        out.set(b, parseInt(blk?.timestamp ?? "0x0", 16));
      }
    }
  }
  return out;
}

/**
 * Decodifica e insere um lote de logs Transfer no banco, buscando o
 * timestamp de cada bloco (com cache entre chunks para não repetir
 * eth_getBlockByNumber).
 *
 * @returns quantidade de transações efetivamente inseridas.
 */
async function insertRpcTransferLogs(logs: RpcTransferLog[], tsCache: Map<number, number>): Promise<number> {
  const missingBlocks = [
    ...new Set(logs.map((l) => parseInt(l.blockNumber, 16)).filter((b) => !tsCache.has(b))),
  ];
  if (missingBlocks.length > 0) {
    const fetched = await fetchBlockTimestamps(missingBlocks);
    for (const [b, ts] of fetched) tsCache.set(b, ts);
  }

  const fallbackTs = Math.floor(Date.now() / 1000);
  const beforeCount = getTransactionCount();
  for (const l of logs) {
    const bn = parseInt(l.blockNumber, 16);
    const from = `0x${(l.topics[1] ?? "").slice(26)}`.toLowerCase();
    const to = `0x${(l.topics[2] ?? "").slice(26)}`.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(from) || !/^0x[0-9a-f]{40}$/.test(to)) continue;

    const isMint = from === ZERO ? 1 : 0;
    const isBurn = to === ZERO ? 1 : 0;
    insertTransaction({
      tx_hash: l.transactionHash,
      block_number: bn,
      timestamp: tsCache.get(bn) || fallbackTs,
      from_address: from,
      to_address: to,
      value: BigInt(l.data || "0x0").toString(10),
      is_mint: isMint,
      is_burn: isBurn,
      label: "",
      description: "",
    });

    if (!isMint) upsertAddress(from, "", "eoa", false);
    if (!isBurn) upsertAddress(to, "", "eoa", false);
  }
  return getTransactionCount() - beforeCount;
}

/**
 * Fallback de sync via eth_getLogs direto no RPC — usado quando o índice
 * do scan está desatualizado e não enxerga transfers recentes. O range é
 * dividido em chunks adaptativos (RPCs gratuitos limitam o span de
 * blocos) e cada chunk é persistido imediatamente: se a varredura abortar
 * no meio, o progresso parcial permanece no banco e a próxima execução
 * continua de onde parou.
 *
 * @param tokenAddress contrato ERC-20 cujos eventos Transfer serão lidos.
 * @param fromBlock primeiro bloco a consultar (inclusivo — re-ler o último
 *   bloco conhecido é seguro porque o INSERT OR IGNORE deduplica).
 * @param tip último bloco (ponta da chain).
 * @returns quantidade de transferências efetivamente inseridas no banco.
 */
async function syncTransfersViaRpcLogs(tokenAddress: string, fromBlock: number, tip: number): Promise<number> {
  const tsCache = new Map<number, number>();
  let chunk = GETLOGS_CHUNK_INITIAL;
  let cursor = fromBlock;
  let inserted = 0;
  let totalLogs = 0;
  let transientFails = 0;

  while (cursor <= tip) {
    const end = Math.min(cursor + chunk - 1, tip);
    try {
      await sleep(RATE_LIMIT_DELAY_MS);
      const page = await ethGetLogsAny(tokenAddress, cursor, end);
      transientFails = 0;
      if (page.length > 0) {
        totalLogs += page.length;
        inserted += await insertRpcTransferLogs(page, tsCache);
      }
      cursor = end + 1;
    } catch (err) {
      const e = err as Error & { rangeLimited?: boolean };
      if (e.rangeLimited && chunk > GETLOGS_CHUNK_MIN) {
        chunk = Math.max(GETLOGS_CHUNK_MIN, chunk >> 1);
        log("WARN", "syncTransfersViaRpcLogs", "Range rejeitado pelo RPC, reduzindo chunk", { chunk });
        continue;
      }
      if (!e.rangeLimited && transientFails < CHUNK_TRANSIENT_RETRIES) {
        transientFails++;
        const delay = CHUNK_TRANSIENT_DELAY_MS * transientFails;
        log("WARN", "syncTransfersViaRpcLogs", "Falha transitória no chunk, aguardando retry", {
          cursor, end, transientFails, delayMs: delay, error: e.message,
        });
        await sleep(delay);
        continue;
      }
      // Aborta mantendo o progresso já persistido — a próxima execução
      // retoma a partir do último bloco gravado no banco.
      log("WARN", "syncTransfersViaRpcLogs", "Abortando varredura RPC; progresso parcial mantido", {
        cursor, tip, inserted, error: e.message,
      });
      break;
    }
  }

  log(totalLogs > 0 ? "OK" : "INFO", "syncTransfersViaRpcLogs", "Varredura via RPC concluída", {
    logs: totalLogs,
    inserted,
    fromBlock,
    lastScanned: Math.min(cursor, tip),
    tip,
  });
  return inserted;
}

/**
 * Sincroniza incrementalmente as transferências do token CAS, inserindo
 * novas transações e endereços no banco SQLite.
 *
 * O caminho primário é o índice tokentx do scan; em seguida a ponta da
 * chain é comparada com o último bloco do banco e qualquer lacuna é
 * coberta via eth_getLogs direto no RPC — necessário porque o índice do
 * Etherscan V2 para a Polygon pode ficar parado e não enxergar transfers
 * recentes.
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

  // Re-lê o último bloco conhecido: transfers que caíram no mesmo bloco
  // da última tx sincronizada não são puladas (INSERT OR IGNORE deduplica).
  const startBlock = lastSyncedBlock;
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
    // Avança a partir do último bloco da página (não +1): uma página cheia
    // pode terminar no meio de um bloco e os transfers restantes desse
    // bloco seriam perdidos; a releitura é deduplicada no INSERT OR IGNORE.
    currentStartBlock = lastTxBlock;
  }

  // O índice do scan pode estar parado: compara o último bloco do banco
  // com a ponta da chain e cobre a lacuna via eth_getLogs direto no RPC.
  try {
    const tipHex = (await rpcCallAny("eth_blockNumber", [])) as string;
    const tip = parseInt(tipHex, 16);
    const lastDbBlock = getLastBlockNumber();
    if (tip > lastDbBlock) {
      let fromBlock = lastDbBlock;
      if (tip - fromBlock > RPC_LOGS_MAX_SPAN) {
        fromBlock = tip - RPC_LOGS_MAX_SPAN;
        log("WARN", "syncTransfers", "Lacuna maior que o span máximo do fallback RPC", {
          lastDbBlock,
          tip,
          fromBlock,
          spanLimit: RPC_LOGS_MAX_SPAN,
        });
      }
      newCount += await syncTransfersViaRpcLogs(tokenAddress, fromBlock, tip);
    }
  } catch (err) {
    log("WARN", "syncTransfers", "Fallback via RPC falhou (mantendo dados do scan)", {
      error: (err as Error).message,
    });
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
 * Verifica se há uma API key configurada para o endpoint Etherscan V2
 * (a chave V2 é unificada — ETHERSCAN_API_KEY ou POLYGONSCAN_API_KEY
 * servem, pois as keys do Polygonscan migraram para o Etherscan).
 */
export function hasApiKey(): boolean {
  return !!(process.env.ETHERSCAN_API_KEY?.trim() || process.env.POLYGONSCAN_API_KEY?.trim());
}
