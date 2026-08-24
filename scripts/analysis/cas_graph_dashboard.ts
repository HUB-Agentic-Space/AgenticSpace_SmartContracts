/**
 * CAS Graph Dashboard
 * -------------------
 * Script especializado em visualização de grafos de transferências do
 * token CAS na Polygon Mainnet. Lê transferências do SQLite local ou
 * sincroniza via Polygonscan/Etherscan V2, calcula saldos/labels e gera
 * um HTML independente com o grafo 3D interativo (3d-force-graph / Three.js).
 *
 * Uso:
 *   npm run analysis:cas:graph
 *   npm run analysis:cas:graph -- --use-db
 *   npm run analysis:cas:graph -- --anon
 *   npm run analysis:cas:graph -- --depth 3
 *   npm run analysis:cas:graph -- "Rapport" --depth 2
 *   npm run analysis:cas:graph -- 0xc590…c02b "Ednardo" --depth 2
 *   (ou) npx tsx scripts/analysis/cas_graph_dashboard.ts
 *
 * Flags:
 *   --depth N   Profundidade BFS a partir de endereços conhecidos (default: GRAPH_DEPTH_DEFAULT do .env)
 *   --use-db    Usa apenas o banco SQLite (sem sync via API)
 *   --anon      Oculta labels e observações
 *
 * Alvos posicionais (opcional):
 *   Endereço, nome, índice, ou endereço encurtado (0x……) para centrar o grafo.
 *   Múltiplos alvos podem ser passados.
 *   Se omitido, usa endereços infra conhecidos como seeds.
 *
 * Requisitos de ambiente:
 *   smartcontracts/.env : POLYGONSCAN_API_KEY, CAS_TOKEN_ADDRESS (+ labels)
 */

import { formatUnits } from "agentic_space_commons";
import * as fs from "fs";
import * as path from "path";
import { execFile, spawnSync } from "child_process";
import dotenv from "dotenv";
import {
  getDB,
  closeDB,
  getAddressDetailsMap,
  getAllTransactionsFromDB,
  getTransactionCount,
  getLastBlockNumber,
  insertTransaction,
  upsertAddress,
  setSyncState,
  recalculateAllAddressStats,
  insertPoolCreation,
  getAllPoolCreations,
  getPoolCreatorMap,
  getAddress,
  getAllAddresses,
  searchAddresses,
  resolveShortAddress,
  type PoolCreationRecord,
  type AddressRecord,
} from "../utils/cas_database";
import { importAllCsvs } from "../utils/cas_csv_import";
import { detectManipulationSignals, ManipulationSignal } from "../utils/cas_manipulation";
import { polyScanLink } from "../utils/vis_tooltip";
import {
  GRAPH_3D_CDN,
  GRAPH_3D_CSS,
  GRAPH_3D_TOOLTIP_JS,
  GRAPH_3D_INIT_JS,
  GRAPH_3D_SEARCH_JS,
} from "../utils/3d_graph_render";

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
  console.log(`[${ts}] [cas_graph_dashboard:${fn}] ${emoji} ${message}${extra}`);
}

// ── Types ─────────────────────────────────────────────────────────────

interface TokenTransfer {
  hash: string;
  from: string;
  to: string;
  value: string;
  timeStamp: string;
  blockNumber: string;
}

interface Holder {
  address: string;
  balance: bigint;
  pct: number;
  label: string;
  type: string;
  asset: string;
  observation: string;
  isContractLike: boolean;
}

interface GraphAlert {
  type: string;
  severity: "ALTO" | "MODERADO" | "BAIXO";
  evidence: string;
  addresses: string[];
  heuristicScore: number;
  gnnScore: number;
  combinedScore: number;
  gnnKey?: string;
}

interface GraphNode {
  id: string;
  label: string;
  title: string;
  size: number;
  color: string;
  borderColor: string;
  borderWidth: number;
  totalTxn: number;
  holderBalance: number;
  isContract: boolean;
  type: string;
  asset: string;
  icon: string;
  shape: string;
  alerts?: GraphAlert[];
}

interface GraphEdge {
  from: string;
  to: string;
  value: number;
  title: string;
  width: number;
  color: string;
  highlight: string;
  volumeLabel: string;
  alerts?: GraphAlert[];
  dashes?: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────

const ZERO = "0x0000000000000000000000000000000000000000";
const DECIMALS = 18;

function toNum(v: bigint): number {
  return Number(formatUnits(v, DECIMALS));
}

function fmt(v: number, digits = 2): string {
  return v.toLocaleString("pt-BR", { maximumFractionDigits: digits });
}

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

const INFRA_LABELS = new Set([
  "contract", "infra", "dex", "swap", "reserve", "fund", "proxy", "faucet",
  "lock", "migration", "lp", "bridge", "wrapper", "token", "safe", "multisig",
]);

const TYPE_EMOJIS: Record<string, string> = {
  wallet: "👤",
  contract: "🏛️",
  token: "🪙",
  bridge: "🌉",
  wrapper: "🔁",
  dex: "💧",
  lp: "💧",
  faucet: "🚰",
  safe: "🔒",
  multisig: "🔒",
  migration: "🔄",
  diamond: "💎",
  proxy: "📡",
  lock: "🔐",
  reserve: "🛡️",
  fund: "🏦",
  router: "🛣️",
  manager: "🧰",
  factory: "🏭",
  certificate: "📜",
  tba: "🎒",
  pool_creator: "🏭",
  unknown: "❓",
};

function typeEmoji(type: string): string {
  return TYPE_EMOJIS[type?.toLowerCase()] ?? "❓";
}

const TYPE_SHAPES: Record<string, string> = {
  wallet: "dot",
  contract: "dot",
  token: "dot",
  bridge: "diamond",
  wrapper: "dot",
  dex: "dot",
  lp: "hexagon",
  faucet: "dot",
  safe: "square",
  multisig: "square",
  migration: "dot",
  diamond: "diamond",
  proxy: "dot",
  lock: "dot",
  reserve: "dot",
  fund: "dot",
  router: "triangle",
  manager: "square",
  factory: "triangleDown",
  certificate: "star",
  tba: "diamond",
  pool_creator: "triangleDown",
  unknown: "dot",
};

function nodeShape(type: string): string {
  return TYPE_SHAPES[type?.toLowerCase()] ?? "dot";
}

interface KnownAddress {
  label: string;
  isInfra: boolean;
  isContract: boolean;
  type: string;
  asset: string;
  observation: string;
}

function knownLabels(anonMode = false): Map<string, KnownAddress> {
  const map = new Map<string, KnownAddress>();

  const add = (envKey: string, label: string, isInfra: boolean) => {
    const v = process.env[envKey]?.trim();
    if (v && /^0x[0-9a-fA-F]{40}$/.test(v)) {
      const type = isInfra ? "contract" : "wallet";
      map.set(v.toLowerCase(), { label, isInfra, isContract: isInfra, type, asset: "", observation: "" });
    }
  };
  add("CAS_TOKEN_ADDRESS", "CASToken (contrato)", true);
  add("CAS_SWAP_ADDRESS", "CASSwap (reserva oficial)", true);
  add("INFRASTRUCTURE_FUND_ADDRESS", "InfrastructureFund", true);
  add("DIAMOND_ADDRESS", "Diamond (proxy)", true);
  add("FAUCET_ADDRESS", "Faucet", true);
  add("DEPLOYER_ADDRESS", "Deployer/Admin", false);
  add("RELAYER_ADDRESS", "Relayer", false);
  add("QUICKSWAP_LP_TOKEN_ADDRESS", "QuickSwap LP (DEX)", true);
  add("SUSHISWAP_LP_TOKEN_ADDRESS", "SushiSwap LP (DEX)", true);
  add("APESWAP_LP_TOKEN_ADDRESS", "ApeSwap LP (DEX)", true);
  add("DFYN_LP_TOKEN_ADDRESS", "Dfyn LP (DEX)", true);
  add("DEX_LP_TOKEN_ADDRESS", "DEX LP", true);
  add("LP_LOCK_ADDRESS", "LP Lock", true);
  add("CAS_MIGRATION_ADDRESS", "CAS Migration", true);

  try {
    const dbMap = getAddressDetailsMap();
    for (const [addr, info] of dbMap) {
      const isInfra = info.isContract || INFRA_LABELS.has(info.label.toLowerCase()) || INFRA_LABELS.has(info.type.toLowerCase());
      const isContract = info.isContract || isInfra;
      const type = info.type || (isContract ? "contract" : "wallet");
      const asset = info.asset || "";
      const display = info.name || info.label;
      const observation = info.notes || "";
      if (!map.has(addr)) {
        if (display) {
          map.set(addr, { label: display, isInfra, isContract, type, asset, observation });
        }
      } else {
        const existing = map.get(addr)!;
        if (observation && !existing.observation) {
          map.set(addr, { ...existing, observation });
        }
        if (asset && !existing.asset) {
          map.set(addr, { ...existing, asset });
        }
        if (type && existing.type === "unknown") {
          map.set(addr, { ...existing, type });
        }
      }
    }
    log("OK", "knownLabels", "Labels do SQLite carregados", { dbLabels: dbMap.size, envLabels: map.size });
  } catch (err) {
    log("WARN", "knownLabels", "Não foi possível ler labels do SQLite", { error: (err as Error).message });
  }

  if (anonMode) {
    for (const [addr, info] of map) {
      map.set(addr, { ...info, label: "", observation: "" });
    }
    log("INFO", "knownLabels", "Modo anônimo ativo — labels e observações ocultos", { entries: map.size });
  }

  return map;
}

// ── Graph alerts ──────────────────────────────────────────────────────

const SEVERITY_RANK = { ALTO: 0, MODERADO: 1, BAIXO: 2 };

function severityRank(s: "ALTO" | "MODERADO" | "BAIXO"): number {
  return SEVERITY_RANK[s] ?? 99;
}

function alertColor(severity: "ALTO" | "MODERADO" | "BAIXO"): string {
  return severity === "ALTO" ? "#eb3812" : severity === "MODERADO" ? "#F05F40" : "#cc7501";
}

function severityToPct(s: "ALTO" | "MODERADO" | "BAIXO"): number {
  return s === "ALTO" ? 1.0 : s === "MODERADO" ? 0.6 : 0.3;
}

function pctToSeverity(pct: number): "ALTO" | "MODERADO" | "BAIXO" {
  return pct >= 0.7 ? "ALTO" : pct >= 0.4 ? "MODERADO" : "BAIXO";
}

const TERM_LABELS: Record<string, { label: string; description: string }> = {
  pump_episode: { label: "Episódio de Pump", description: "Evento de valorização artificial do preço para atrair compradores, comum em esquemas de pump-and-dump." },
  dump_episode: { label: "Episódio de Dump", description: "Queda abrupta do preço após valorização artificial, indicando saída coordenada por grandes detentores." },
  volume_spike: { label: "Pico de Volume", description: "Volume de negociação anormalmente alto em curto período, sinalizando possível manipulação de mercado." },
  coordinated_cluster: { label: "Cluster Coordenado", description: "Grupo de endereços que transferem tokens entre si de forma sincronizada, sugerindo coordenação." },
  spoofing_layering: { label: "Spoofing/Layering", description: "Ordens falsas colocadas e canceladas rapidamente para criar falsa impressão de oferta/demanda e enganar outros traders." },
  lp_outflow: { label: "Saída de Liquidez (LP)", description: "Retirada expressiva de liquidez de pools, sinal de risco de rug pull." },
  top10_concentration: { label: "Concentração Top 10", description: "Alta concentração da oferta nos 10 maiores endereços, aumentando o risco de manipulação por poucos agentes." },
  wash_trading: { label: "Wash Trading", description: "Negociação entre contas controladas pela mesma parte para simular volume e enganar o mercado." },
  whale_dump_pressure: { label: "Pressão de Venda de Baleias", description: "Grandes detentores (baleias) movimentando ativos para vendas massivas, pressionando o preço para baixo." },
  rug_pull: { label: "Rug Pull", description: "Retirada fraudulenta de liquidez ou fundos por desenvolvedores/insiders, abandonando o projeto." },
  short_and_distort: { label: "Short and Distort", description: "Venda a descoberto combinada à disseminação de notícias negativas para derrubar o preço." },
};

function formatTerm(code: string | undefined): string {
  if (!code || !TERM_LABELS[code]) return code ?? "-";
  const { label, description } = TERM_LABELS[code];
  return `<span class="term" title="${description.replace(/"/g, "&quot;")}">${label}</span>`;
}

function formatAlertsHtml(alerts: GraphAlert[]): string {
  if (alerts.length === 0) return "";
  const sorted = [...alerts].sort((a, b) => {
    const sev = severityRank(a.severity) - severityRank(b.severity);
    if (sev !== 0) return sev;
    return b.combinedScore - a.combinedScore;
  });
  const items = sorted
    .map((a) => {
      const icon = a.severity === "ALTO" ? "🚨" : a.severity === "MODERADO" ? "⚠️" : "ℹ️";
      return `<li>${icon} <b style="color:${alertColor(a.severity)};">${formatTerm(a.type)}</b> (${a.severity}) — Combinado: ${(a.combinedScore * 100).toFixed(1)}%<br><span style="color:var(--muted);font-size:.75rem;">Heurística: ${(a.heuristicScore * 100).toFixed(1)}% · Neural Network: ${(a.gnnScore * 100).toFixed(1)}%${a.gnnKey ? ` · ${formatTerm(a.gnnKey)}` : ""}</span><br>${a.evidence}</li>`;
    })
    .join("");
  return `<br><br><b style="color:#eb3812;">Alertas de manipulação detectados:</b><ul style="margin:4px 0;padding-left:16px;">${items}</ul>`;
}

function computeGraphAlerts(transfers: TokenTransfer[], tokenAddress: string, anonMode = false): GraphAlert[] {
  const labels = knownLabels(anonMode);
  const resolver = (addr: string) => {
    const info = labels.get(addr.toLowerCase());
    if (!info) return undefined;
    return { label: info.label, isInfra: info.isInfra, type: info.type };
  };
  const market = { dexPairs: [] as { pairAddress?: string; liquidityUsd?: number; volume24h?: number; priceUsd?: number }[], bestPair: null as { pairAddress?: string; liquidityUsd?: number; priceUsd?: number } | null };
  const signals = detectManipulationSignals(transfers as any, resolver, market, tokenAddress);
  return signals.map((s) => {
    const heuristicScore = severityToPct(s.severity);
    return {
      type: s.type,
      severity: s.severity,
      evidence: s.evidence,
      addresses: s.addresses,
      heuristicScore,
      gnnScore: 0,
      combinedScore: heuristicScore,
    };
  });
}

// ── Polygonscan / Etherscan V2 API ────────────────────────────────────

const CHAIN_ID = 137;
const API_BASES = [
  "https://api.polygonscan.com/api",
  "https://api.etherscan.io/v2/api",
];

const MAX_RETRIES = 5;
const REQUEST_TIMEOUT_MS = 15_000;
const RATE_LIMIT_EXTRA_DELAY_MS = 2_000;
const RATE_LIMIT_DELAY_MS = 350;
let pinnedBase: string | null = null;

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
        const body = (await res.json()) as { status: string; message: string; result: unknown };
        if (body.status === "1" || (body.status === "0" && body.message === "No transactions found")) {
          if (pinnedBase === null) pinnedBase = base;
          return body.result;
        }
        const resultStr = typeof body.result === "string" ? body.result : JSON.stringify(body.result);
        const combinedMsg = `${body.message} ${resultStr}`;
        if (isTransientError(0, combinedMsg) && attempt < MAX_RETRIES) {
          const backoff = Math.min(1000 * Math.pow(2, attempt - 1), 16_000) + Math.random() * 400;
          await sleep(backoff + RATE_LIMIT_EXTRA_DELAY_MS);
          continue;
        }
        throw new Error(`API status=${body.status} message=${body.message} result=${resultStr.slice(0, 200)}`);
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

async function fetchTotalSupply(tokenAddress: string): Promise<bigint> {
  const result = (await scanRequest({
    module: "stats",
    action: "tokensupply",
    contractaddress: tokenAddress,
  })) as string;
  return BigInt(result);
}

// ── Pool creator discovery ─────────────────────────────────────────────

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

const DEX_FACTORIES: { name: string; address: string }[] = [
  { name: "QuickSwap", address: "0x8756a862d01e16f8E2e20E24aC4B68B83e39B5B5" },
  { name: "SushiSwap", address: "0xc35DADB65012eC5796536bD9864eD8773aBc74C4" },
  { name: "ApeSwap", address: "0x0841AD8bA9d0712e87B3720c71689df2d64dD5b8" },
  { name: "Dfyn", address: "0x3f4F49784604BBd4a64e875c4FE15aDB7B30BBcB" },
];

const PAIR_CREATED_TOPIC = "0x0d3648ea0f249681bC1dE2f9E0dD1F6d08e08c7b4e000000000000000000000a";

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

async function fetchPoolCreators(tokenAddress: string): Promise<PoolCreatorInfo[]> {
  const results: PoolCreatorInfo[] = [];
  const paddedToken = padAddress(tokenAddress);
  const dbPools = getAllPoolCreations();
  const knownPairs = new Set(dbPools.map((p) => p.pair_address.toLowerCase()));

  for (const factory of DEX_FACTORIES) {
    const factoryLower = factory.address.toLowerCase();
    const alreadySynced = dbPools.some(
      (p) => p.factory_address.toLowerCase() === factoryLower,
    );

    if (alreadySynced) {
      log("INFO", "fetchPoolCreators", `Factory ${factory.name} já sincronizada, pulando API`, { factory: factory.address });
      continue;
    }

    log("INFO", "fetchPoolCreators", `Buscando PairCreated em ${factory.name}`, { factory: factory.address });

    let logs: PolygonscanLog[];
    try {
      const raw = await scanRequest({
        module: "logs",
        action: "getLogs",
        fromBlock: "0",
        toBlock: "latest",
        address: factory.address,
        topic0: PAIR_CREATED_TOPIC,
        topic2: paddedToken,
      });
      logs = raw as PolygonscanLog[];
    } catch {
      try {
        const raw = await scanRequest({
          module: "logs",
          action: "getLogs",
          fromBlock: "0",
          toBlock: "latest",
          address: factory.address,
          topic0: PAIR_CREATED_TOPIC,
          topic3: paddedToken,
        });
        logs = raw as PolygonscanLog[];
      } catch (err) {
        log("WARN", "fetchPoolCreators", `Falha ao buscar logs de ${factory.name}`, { error: (err as Error).message });
        continue;
      }
    }

    if (!Array.isArray(logs) || logs.length === 0) {
      log("INFO", "fetchPoolCreators", `Nenhum pool encontrado em ${factory.name}`);
      continue;
    }

    log("OK", "fetchPoolCreators", `Pools encontrados em ${factory.name}`, { count: logs.length });

    for (const logEntry of logs) {
      const pairAddress = "0x" + (logEntry.topics[1]?.slice(26) ?? "").toLowerCase();
      const token0 = "0x" + (logEntry.topics[2]?.slice(26) ?? "").toLowerCase();
      const token1 = "0x" + (logEntry.topics[3]?.slice(26) ?? "").toLowerCase();

      if (knownPairs.has(pairAddress)) continue;

      const creator = await fetchTxSender(logEntry.transactionHash);
      if (!creator) {
        log("WARN", "fetchPoolCreators", "Não foi possível obter criador", { pairAddress, txHash: logEntry.transactionHash.slice(0, 20) });
        continue;
      }

      const info: PoolCreatorInfo = {
        pairAddress,
        factoryAddress: factoryLower,
        creatorAddress: creator.toLowerCase(),
        token0,
        token1,
        txHash: logEntry.transactionHash.toLowerCase(),
        blockNumber: parseInt(logEntry.blockNumber, 16),
        timestamp: parseInt(logEntry.timeStamp, 10),
        dexName: factory.name,
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

      upsertAddress(info.creatorAddress, `Pool Creator (${factory.name})`, "pool_creator", false);
      upsertAddress(info.pairAddress, `${factory.name} LP Pair`, "lp", true);

      log("OK", "fetchPoolCreators", "Pool registrado", {
        dex: factory.name,
        pair: pairAddress,
        creator: creator.toLowerCase(),
        block: info.blockNumber,
      });
    }
  }

  log("OK", "fetchPoolCreators", "Sincronização de pool creators concluída", { totalPools: results.length });
  return results;
}

async function fetchAllTransfers(tokenAddress: string): Promise<TokenTransfer[]> {
  const MAX_BLOCK = 999_999_999;
  const PAGE_SIZE = 10_000;

  getDB();

  const lastSyncedBlock = getLastBlockNumber();
  const dbCount = getTransactionCount();
  log("INFO", "fetchAllTransfers", "Sync incremental via paginação sequencial", {
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
      log("ERROR", "fetchAllTransfers", "Falha ao buscar página após retries", {
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
  log("OK", "fetchAllTransfers", "Sync concluído", { newTx: newCount, totalDbTx: totalCount });

  const dbTxs = getAllTransactionsFromDB();
  const transfers = dbTxs.map((t) => ({
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

// ── Metrics & graph computation ───────────────────────────────────────

function computeHolders(transfers: TokenTransfer[], totalSupply: bigint, anonMode = false): Holder[] {
  const labels = knownLabels(anonMode);
  const balances = new Map<string, bigint>();

  for (const t of transfers) {
    const from = t.from.toLowerCase();
    const to = t.to.toLowerCase();
    const value = BigInt(t.value);
    if (from !== ZERO) balances.set(from, (balances.get(from) ?? 0n) - value);
    if (to !== ZERO) balances.set(to, (balances.get(to) ?? 0n) + value);
  }

  const holders: Holder[] = [...balances.entries()]
    .filter(([, b]) => b > 0n)
    .map(([address, balance]) => {
      const known = labels.get(address);
      const type = known?.type ?? "unknown";
      const asset = known?.asset ?? "";
      const isContractLike = known?.isContract ?? known?.isInfra ?? false;
      return {
        address,
        balance,
        pct: totalSupply > 0n ? Number((balance * 1000000n) / totalSupply) / 10000 : 0,
        label: known?.label ?? "",
        type,
        asset,
        isContractLike,
        observation: known?.observation ?? "",
      };
    })
    .sort((a, b) => (b.balance > a.balance ? 1 : -1));

  return holders;
}

interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  meta: {
    nodeCount: number;
    edgeCount: number;
    totalVolume: number;
    generatedAt: string;
    alertCount: number;
    depth: number;
  };
  alerts: GraphAlert[];
}

interface GnnDiagnosis {
  timestamp: string;
  db_path: string;
  transfers_analyzed: number;
  nodes: number;
  edges: number;
  gnn_probabilities: Record<string, number>;
  diagnosis: string;
  trend: string;
  confidence: number;
  pattern_scores: Record<string, number>;
  reasons: string[];
}

const HEURISTIC_TO_GNN: Record<string, string | undefined> = {
  volume_spike: "whale_dump_pressure",
  pump_episode: "top10_concentration",
  dump_episode: "whale_dump_pressure",
  wash_trading: "wash_trading",
  coordinated_cluster: "top10_concentration",
  short_and_distort: "spoofing_layering",
  spoofing_layering: "spoofing_layering",
  rug_pull: "lp_outflow",
};

function unifyAlerts(heuristic: GraphAlert[], diagnosis: GnnDiagnosis | null): GraphAlert[] {
  if (!diagnosis) return heuristic;
  const gnn = diagnosis.pattern_scores;
  return heuristic.map((a) => {
    const gnnKey = HEURISTIC_TO_GNN[a.type];
    const gnnScore = gnnKey && gnn[gnnKey] !== undefined ? gnn[gnnKey] : 0;
    const heuristicScore = a.heuristicScore;
    const combinedScore = gnnKey && gnn[gnnKey] !== undefined ? (heuristicScore + gnnScore) / 2 : heuristicScore;
    return {
      ...a,
      gnnKey,
      gnnScore,
      combinedScore,
      severity: pctToSeverity(combinedScore),
    };
  });
}

function filterTransfersByDepth(transfers: TokenTransfer[], maxDepth: number, anonMode = false, seedAddrs?: Set<string>): TokenTransfer[] {
  if (maxDepth <= 0 && !seedAddrs) return transfers;

  const seeds = new Set<string>();
  if (seedAddrs && seedAddrs.size > 0) {
    for (const a of seedAddrs) seeds.add(a.toLowerCase());
  } else {
    const labels = knownLabels(anonMode);
    for (const [addr, info] of labels) {
      if (info.isInfra || info.isContract) seeds.add(addr);
    }
  }
  if (seeds.size === 0) {
    log("WARN", "filterTransfersByDepth", "Nenhum endereço infra conhecido — retornando todas as transferências", { maxDepth });
    return transfers;
  }

  const adj = new Map<string, Set<string>>();
  for (const t of transfers) {
    const from = t.from.toLowerCase();
    const to = t.to.toLowerCase();
    if (from === ZERO || to === ZERO) continue;
    if (!adj.has(from)) adj.set(from, new Set());
    if (!adj.has(to)) adj.set(to, new Set());
    adj.get(from)!.add(to);
    adj.get(to)!.add(from);
  }

  const visited = new Set<string>(seeds);
  let currentLevel = [...seeds];
  for (let d = 0; d < maxDepth; d++) {
    if (currentLevel.length === 0) break;
    const nextLevel: string[] = [];
    for (const addr of currentLevel) {
      const neighbors = adj.get(addr);
      if (!neighbors) continue;
      for (const n of neighbors) {
        if (!visited.has(n)) {
          visited.add(n);
          nextLevel.push(n);
        }
      }
    }
    currentLevel = nextLevel;
  }

  log("INFO", "filterTransfersByDepth", "Filtro BFS aplicado", { maxDepth, seeds: seeds.size, reachable: visited.size });

  return transfers.filter((t) => {
    const from = t.from.toLowerCase();
    const to = t.to.toLowerCase();
    return visited.has(from) || visited.has(to);
  });
}

function buildGraphData(
  transfers: TokenTransfer[],
  holders: Holder[],
  tokenAddress: string,
  diagnosis?: GnnDiagnosis | null,
  anonMode = false,
  poolCreatorMap?: Map<string, PoolCreationRecord[]>,
  depth = 0,
): GraphData {
  const labels = knownLabels(anonMode);
  const poolMap = poolCreatorMap ?? new Map<string, PoolCreationRecord[]>();
  const anonNames = new Map<string, string>();
  const anonFor = (addr: string): string | undefined => {
    if (!anonMode) return undefined;
    if (!anonNames.has(addr)) anonNames.set(addr, `Anon ${anonNames.size + 1}`);
    return anonNames.get(addr);
  };
  const holderBalanceMap = new Map<string, { balance: bigint; pct: number }>();
  for (const h of holders) {
    holderBalanceMap.set(h.address, { balance: h.balance, pct: h.pct });
  }

  const nodeStats = new Map<string, { sent: number; received: number; volume: number }>();
  const edgeMap = new Map<string, { count: number; volume: number }>();
  let totalVolume = 0;

  for (const t of transfers) {
    const from = t.from.toLowerCase();
    const to = t.to.toLowerCase();
    const value = toNum(BigInt(t.value));
    totalVolume += value;

    const fromStat = nodeStats.get(from) ?? { sent: 0, received: 0, volume: 0 };
    fromStat.sent += 1;
    fromStat.volume += value;
    nodeStats.set(from, fromStat);

    const toStat = nodeStats.get(to) ?? { sent: 0, received: 0, volume: 0 };
    toStat.received += 1;
    nodeStats.set(to, toStat);

    const edgeKey = `${from}->${to}`;
    const edge = edgeMap.get(edgeKey) ?? { count: 0, volume: 0 };
    edge.count += 1;
    edge.volume += value;
    edgeMap.set(edgeKey, edge);
  }

  const maxTxnCount = Math.max(...[...nodeStats.values()].map((s) => s.sent + s.received), 1);
  const maxEdgeVolume = Math.max(...[...edgeMap.values()].map((e) => e.volume), 1);
  const maxHolderBalance = Math.max(...[...holderBalanceMap.values()].map((v) => toNum(v.balance)), 1);

  const nodes: GraphNode[] = [...nodeStats.entries()]
    .filter(([addr]) => addr !== ZERO)
    .map(([addr, stat]) => {
      const known = labels.get(addr);
      const totalTxn = stat.sent + stat.received;
      const isInfra = known?.isInfra ?? false;
      const isContract = known?.isContract ?? isInfra;
      const type = known?.type ?? "unknown";
      const asset = known?.asset ?? "";
      const isDeployer = addr === (process.env.DEPLOYER_ADDRESS?.toLowerCase() ?? "");
      const poolCreations = poolMap.get(addr);
      const isPoolCreator = !!poolCreations && poolCreations.length > 0;
      const label = anonFor(addr) ?? (known?.label || shortAddr(addr));
      const holderInfo = holderBalanceMap.get(addr);
      const holderBalance = holderInfo ? toNum(holderInfo.balance) : 0;
      const holderPct = holderInfo ? holderInfo.pct : 0;
      const size = 10 + Math.round((holderBalance / maxHolderBalance) * 50);
      const borderWidth = 1 + Math.round((totalTxn / maxTxnCount) * 6);
      const txnPct = totalTxn / maxTxnCount;
      let borderColor: string;
      if (txnPct > 0.5) {
        borderColor = "#eb3812";
      } else if (txnPct > 0.2) {
        borderColor = "#F05F40";
      } else if (txnPct > 0.05) {
        borderColor = "#cc7501";
      } else {
        borderColor = "#d49a5a";
      }
      let bgColor: string;
      if (isDeployer) {
        bgColor = "#fcc650";
      } else if (isPoolCreator) {
        bgColor = "#ce6e6d";
      } else if (isInfra) {
        bgColor = "#b5651d";
      } else {
        bgColor = "#712d23";
      }
      if (isPoolCreator) {
        borderColor = "#fcc650";
      }
      const holderObs = holders.find((h) => h.address === addr)?.observation || "";
      const obsText = known?.observation || holderObs;
      const obsHtml = obsText ? `<br><em style="color:#f7d4ca;">${obsText}</em>` : "";
      const typeHtml = type !== "unknown" ? `<br>${typeEmoji(type)} Tipo: ${type}` : "";
      const assetHtml = asset ? `<br>💰 Moeda: ${asset}` : "";
      const poolHtml = isPoolCreator
        ? `<br><br><b style="color:#fcc650;">🏭 Criou ${poolCreations!.length} pool(s) DEX:</b>${poolCreations!.map((p) => `<br>• ${p.dex_name} — pair ${polyScanLink(p.pair_address, shortAddr(p.pair_address))} (bloco ${p.block_number})`).join("")}`
        : "";
      const addrHtml = anonMode ? `<code>${label}</code>` : polyScanLink(addr, addr);
      const tooltip = `<b>${label}</b><br>${addrHtml}<br>Saldo: ${fmt(holderBalance, 2)} CAS (${holderPct.toFixed(2)}%)${typeHtml}${assetHtml}<br>Enviadas: ${stat.sent} | Recebidas: ${stat.received}<br>Volume: ${fmt(stat.volume, 2)} CAS${obsHtml}${poolHtml}`;
      const finalType = isPoolCreator ? "pool_creator" : type;
      return {
        id: addr,
        label,
        title: tooltip,
        size,
        color: bgColor,
        borderColor,
        borderWidth: isPoolCreator ? Math.max(borderWidth, 4) : borderWidth,
        totalTxn,
        holderBalance,
        isContract,
        type: finalType,
        asset,
        icon: typeEmoji(finalType),
        shape: nodeShape(finalType),
      };
    });

  const edges: GraphEdge[] = [...edgeMap.entries()]
    .filter(([key]) => {
      const [from] = key.split("->");
      return from !== ZERO;
    })
    .map(([key, edge]) => {
      const [from, to] = key.split("->");
      const width = 1 + Math.round((edge.volume / maxEdgeVolume) * 8);
      const volPct = edge.volume / maxEdgeVolume;
      const edgeColor = volPct > 0.5 ? "#F05F40" : volPct > 0.2 ? "#fcc650" : volPct > 0.05 ? "#cc7501" : "#d49a5a";
      const edgeHighlight = volPct > 0.5 ? "#eb3812" : volPct > 0.2 ? "#ffd98a" : "#F05F40";
      const fromInfo = labels.get(from);
      const toInfo = labels.get(to);
      const fromDisplay = anonFor(from) ?? (fromInfo?.label ? `${fromInfo.label} (${shortAddr(from)})` : shortAddr(from));
      const toDisplay = anonFor(to) ?? (toInfo?.label ? `${toInfo.label} (${shortAddr(to)})` : shortAddr(to));
      const fromLink = anonFor(from) ? `<code>${fromDisplay}</code>` : polyScanLink(from, fromDisplay);
      const toLink = anonFor(to) ? `<code>${toDisplay}</code>` : polyScanLink(to, toDisplay);
      const tooltip = `<b>${edge.count} transferências</b><br>De: ${fromLink}<br>Para: ${toLink}<br>Volume: ${fmt(edge.volume, 2)} CAS`;
      const volumeLabel = `${fmt(edge.volume, 2)} CAS`;
      return { from, to, value: edge.count, title: tooltip, width, color: edgeColor, highlight: edgeHighlight, volumeLabel };
    });

  const poolEdges: GraphEdge[] = [];
  for (const [creatorAddr, creations] of poolMap) {
    for (const pc of creations) {
      const pairLower = pc.pair_address.toLowerCase();
      if (creatorAddr === pairLower) continue;
      const fromInfo = labels.get(creatorAddr);
      const fromDisplay = anonFor(creatorAddr) ?? (fromInfo?.label ? `${fromInfo.label} (${shortAddr(creatorAddr)})` : shortAddr(creatorAddr));
      const toDisplay = anonFor(pairLower) ?? shortAddr(pairLower);
      const fromLink = anonFor(creatorAddr) ? `<code>${fromDisplay}</code>` : polyScanLink(creatorAddr, fromDisplay);
      const toLink = anonFor(pairLower) ? `<code>${toDisplay}</code>` : polyScanLink(pairLower, toDisplay);
      const tooltip = `<b style="color:#fcc650;">🏭 createPool (${pc.dex_name})</b><br>De: ${fromLink}<br>Para: ${toLink}<br>Bloco: ${pc.block_number}<br>Tokens: ${polyScanLink(pc.token0, shortAddr(pc.token0))} ↔ ${polyScanLink(pc.token1, shortAddr(pc.token1))}`;
      poolEdges.push({
        from: creatorAddr,
        to: pairLower,
        value: 1,
        title: tooltip,
        width: 2,
        color: "#ce6e6d",
        highlight: "#fcc650",
        volumeLabel: `🏭 ${pc.dex_name}`,
        dashes: true,
      });
    }
  }
  edges.push(...poolEdges);

  const alerts = unifyAlerts(computeGraphAlerts(transfers, tokenAddress, anonMode), diagnosis ?? null);
  const nodeAlertMap = new Map<string, GraphAlert[]>();
  const edgeAlertMap = new Map<string, GraphAlert[]>();

  for (const a of alerts) {
    for (const addr of a.addresses) {
      const key = addr.toLowerCase();
      const list = nodeAlertMap.get(key) ?? [];
      list.push(a);
      nodeAlertMap.set(key, list);
    }
    for (let i = 0; i < a.addresses.length; i++) {
      for (let j = i + 1; j < a.addresses.length; j++) {
        const f = a.addresses[i].toLowerCase();
        const t = a.addresses[j].toLowerCase();
        const k1 = `${f}->${t}`;
        const k2 = `${t}->${f}`;
        const l1 = edgeAlertMap.get(k1) ?? [];
        l1.push(a);
        edgeAlertMap.set(k1, l1);
        const l2 = edgeAlertMap.get(k2) ?? [];
        l2.push(a);
        edgeAlertMap.set(k2, l2);
      }
    }
  }

  for (const n of nodes) {
    const nodeAlerts = nodeAlertMap.get(n.id) ?? [];
    if (nodeAlerts.length > 0) {
      const top = [...nodeAlerts].sort((a, b) => severityRank(a.severity) - severityRank(b.severity))[0];
      n.alerts = nodeAlerts;
      n.borderColor = alertColor(top.severity);
      n.borderWidth = top.severity === "ALTO" ? 6 : top.severity === "MODERADO" ? 4 : 3;
      n.title += formatAlertsHtml(nodeAlerts);
    }
  }

  for (const e of edges) {
    const key = `${e.from}->${e.to}`;
    const edgeAlerts = edgeAlertMap.get(key) ?? [];
    if (edgeAlerts.length > 0) {
      const top = [...edgeAlerts].sort((a, b) => severityRank(a.severity) - severityRank(b.severity))[0];
      e.alerts = edgeAlerts;
      e.color = alertColor(top.severity);
      e.highlight = alertColor(top.severity);
      e.dashes = true;
      e.title += formatAlertsHtml(edgeAlerts);
    }
  }

  return {
    nodes,
    edges,
    meta: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      totalVolume: Math.round(totalVolume * 100) / 100,
      generatedAt: new Date().toISOString(),
      alertCount: alerts.length,
      depth,
    },
    alerts,
  };
}

// ── GNN diagnosis ─────────────────────────────────────────────────────

function runGnnDiagnosis(): GnnDiagnosis | null {
  const python = path.join(SC_ROOT, ".venv", "bin", "python");
  const script = path.join(SC_ROOT, "scripts", "gnn", "cas_gnn_diagnose.py");
  const reportsDir = path.join(SC_ROOT, "reports");
  const outJson = path.join(reportsDir, `cas_gnn_diagnosis_${new Date().toISOString().slice(0, 10)}.json`);
  const db = path.join(SC_ROOT, "data", "cas_tracker.db");

  if (!fs.existsSync(python)) {
    log("WARN", "runGnnDiagnosis", "Interpretador Python do venv não encontrado", { python });
    return null;
  }
  if (!fs.existsSync(script)) {
    log("WARN", "runGnnDiagnosis", "Script de diagnóstico GNN não encontrado", { script });
    return null;
  }

  try {
    fs.mkdirSync(reportsDir, { recursive: true });
    log("INFO", "runGnnDiagnosis", "Executando diagnóstico GNN", { script, outJson });
    const result = spawnSync(python, [script, "--db", db, "--output", outJson, "--device", "cpu"], { encoding: "utf-8", cwd: SC_ROOT, timeout: 180_000 });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      log("WARN", "runGnnDiagnosis", "Diagnóstico GNN falhou", { stderr: result.stderr?.slice(0, 500) });
      return null;
    }
    if (!fs.existsSync(outJson)) {
      log("WARN", "runGnnDiagnosis", "Arquivo de saída do GNN não foi gerado", { outJson });
      return null;
    }
    const raw = fs.readFileSync(outJson, "utf-8");
    const parsed = JSON.parse(raw) as GnnDiagnosis;
    log("OK", "runGnnDiagnosis", "Diagnóstico GNN concluído", { diagnosis: parsed.diagnosis, confidence: parsed.confidence });
    return parsed;
  } catch (err) {
    log("ERROR", "runGnnDiagnosis", "Erro ao executar diagnóstico GNN", { error: (err as Error).message });
    return null;
  }
}

function formatPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function diagnosisToHtml(d: GnnDiagnosis, graphAlerts: GraphAlert[]): string {
  const probs = Object.entries(d.gnn_probabilities)
    .sort(([, a], [, b]) => b - a)
    .map(([label, p]) => {
      const color = label.includes("Saudável") ? "#F05F40" : label.includes("Especulativo") ? "#fcc650" : "#eb3812";
      return `<div style="margin-bottom:6px;">
        <div style="display:flex;justify-content:space-between;font-size:.8rem;margin-bottom:2px;">
          <span>${label}</span><span>${formatPct(p)}</span>
        </div>
        <div style="background:rgba(0,0,0,0.3);border-radius:4px;height:8px;">
          <div style="width:${(p * 100).toFixed(1)}%;background:${color};height:100%;border-radius:4px;"></div>
        </div>
      </div>`;
    })
    .join("");

  const scores = graphAlerts
    .slice()
    .sort((a, b) => b.combinedScore - a.combinedScore)
    .slice(0, 10)
    .map((a) => {
      const color = alertColor(a.severity);
      return `<div style="display:flex;justify-content:space-between;align-items:center;font-size:.85rem;margin-bottom:6px;padding:6px 8px;background:rgba(0,0,0,0.2);border-radius:6px;">
        <span><b style="color:${color};">${formatTerm(a.type)}</b> <span style="color:var(--muted);font-size:.75rem;">(${a.severity})</span></span>
        <span style="font-weight:700;color:${color};">${formatPct(a.combinedScore)}</span>
      </div>
      <div style="font-size:.75rem;color:var(--muted);margin:-2px 0 8px 8px;">Heurística ${formatPct(a.heuristicScore)} · Neural Network ${formatPct(a.gnnScore)}${a.gnnKey ? ` · ${formatTerm(a.gnnKey)}` : ""}</div>`;
    })
    .join("");

  const reasons = d.reasons.map((r) => `<li style="margin-bottom:4px;">${r}</li>`).join("");

  const badgeColor = d.diagnosis.includes("Saudável") ? "#F05F40" : d.diagnosis.includes("Especulativo") ? "#fcc650" : "#eb3812";

  return `<div class="card" style="margin-bottom:16px;">
    <h2 style="color:#fcc650;font-size:1.1rem;margin-bottom:12px;">🧠 Diagnóstico de Risco</h2>
    <div style="display:flex;flex-wrap:wrap;gap:12px;margin-bottom:16px;">
      <div style="flex:1;min-width:180px;">
        <div style="font-size:.75rem;color:var(--muted);margin-bottom:4px;">Classificação</div>
        <div style="font-size:1.3rem;font-weight:700;color:${badgeColor};">${d.diagnosis}</div>
        <div style="font-size:.85rem;color:var(--muted);margin-top:4px;">${d.trend}</div>
      </div>
      <div style="flex:1;min-width:180px;">
        <div style="font-size:.75rem;color:var(--muted);margin-bottom:4px;">Confiança</div>
        <div style="font-size:1.3rem;font-weight:700;color:#ffffff;">${formatPct(d.confidence)}</div>
        <div style="font-size:.75rem;color:var(--muted);margin-top:4px;">${d.transfers_analyzed} transferências · ${d.nodes} nós · ${d.edges} arestas</div>
      </div>
      <div style="flex:1;min-width:180px;">
        <div style="font-size:.75rem;color:var(--muted);margin-bottom:4px;">Probabilidades</div>
        ${probs}
      </div>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:16px;">
      <div style="flex:1;min-width:240px;">
        <div style="font-size:.85rem;color:#fcc650;margin-bottom:8px;">Alertas unificados (heurística + Neural Network)</div>
        ${scores}
      </div>
      <div style="flex:1;min-width:240px;">
        <div style="font-size:.85rem;color:#fcc650;margin-bottom:8px;">Motivos do diagnóstico</div>
        <ul style="font-size:.85rem;color:var(--muted);padding-left:18px;margin:0;">${reasons}</ul>
      </div>
    </div>
  </div>`;
}

// ── HTML graph dashboard ──────────────────────────────────────────────

function buildGraphHtml(graph: GraphData, tokenAddress: string, diagnosis?: GnnDiagnosis | null): string {
  const diagnosisHtml = diagnosis ? diagnosisToHtml(diagnosis, graph.alerts) : "";
  const graphDataJson = JSON.stringify({ nodes: graph.nodes, edges: graph.edges });

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CAS — Grafo 3D + Diagnóstico</title>
${GRAPH_3D_CDN}
<style>
  :root { --bg:#222222; --card:#712d23; --border:rgba(255,255,255,0.15); --text:#ffffff; --muted:#f7d4ca; --accent:#F05F40; --gold:#fcc650; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background:var(--bg); color:var(--text); min-height:100vh; padding:20px; }
  h1 { font-size:1.5rem; color:var(--accent); margin-bottom:4px; }
  .sub { color:var(--muted); font-size:.9rem; margin-bottom:12px; }
  .kpis { display:flex; flex-wrap:wrap; gap:12px; margin-bottom:16px; }
  .kpi { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:12px 16px; min-width:120px; }
  .kpi .v { font-size:1.3rem; font-weight:700; color:var(--gold); }
  .kpi .l { font-size:.75rem; color:var(--muted); }
  .card { background:var(--card); border:1px solid var(--border); border-radius:12px; padding:16px; }
  .graph-search-bar { display:flex; gap:8px; align-items:center; margin-bottom:12px; }
  .graph-search-bar input { flex:1; padding:8px 14px; border-radius:8px; border:1px solid var(--border); background:rgba(255,255,255,0.05); color:var(--text); font-size:.9rem; outline:none; }
  .graph-search-bar input:focus { border-color:var(--accent); }
  .graph-search-bar input::placeholder { color:var(--muted); }
  .graph-search-bar button { padding:6px 14px; border-radius:8px; border:1px solid var(--border); background:var(--accent); color:#fff; cursor:pointer; font-size:.85rem; white-space:nowrap; }
  .graph-search-bar button:hover { background:#eb3812; }
  .graph-search-result { font-size:.8rem; color:var(--muted); margin-left:4px; white-space:nowrap; }
  .graph-legend { display:flex; gap:20px; margin-top:12px; flex-wrap:wrap; font-size:.85rem; color:var(--muted); }
  .graph-legend span { display:flex; align-items:center; gap:6px; }
  .graph-legend .dot { width:12px; height:12px; border-radius:50%; display:inline-block; }
  ${GRAPH_3D_CSS}
  .term { cursor:help; text-decoration:underline dotted; }
</style>
</head>
<body>
<h1>🔗 Grafo 3D de Transferências CAS</h1>
<p class="sub">Token: <code>${tokenAddress}</code> · Nós: ${graph.meta.nodeCount} · Arestas: ${graph.meta.edgeCount} · Volume: ${fmt(graph.meta.totalVolume, 2)} CAS · Alertas: ${graph.meta.alertCount}</p>

<div class="kpis">
  <div class="kpi"><div class="v">${graph.meta.nodeCount}</div><div class="l">Endereços</div></div>
  <div class="kpi"><div class="v">${graph.meta.edgeCount}</div><div class="l">Fluxos</div></div>
  <div class="kpi"><div class="v">${fmt(graph.meta.totalVolume, 2)}</div><div class="l">Volume CAS</div></div>
  <div class="kpi"><div class="v">${graph.meta.alertCount}</div><div class="l">Alertas de manipulação</div></div>
</div>

${diagnosisHtml}
<div class="card">
  <div class="graph-search-bar">
    <input type="text" id="graph-search-input" placeholder="Buscar por label ou endereço..." autocomplete="off" onkeydown="if(event.key==='Enter')searchGraph()" />
    <button id="graph-search-btn" onclick="searchGraph()">🔍 Buscar</button>
    <button id="graph-search-clear" onclick="clearGraphSearch()">✕ Limpar</button>
    <span id="graph-search-result" class="graph-search-result"></span>
  </div>
  <div id="network-graph"></div>
  <div class="graph-legend">
    <span><span class="dot" style="background:#fcc650"></span> Deployer/Admin</span>
    <span><span class="dot" style="background:#ce6e6d"></span> Pool Creator</span>
    <span><span class="dot" style="background:#b5651d"></span> Infra/DEX/Bridge</span>
    <span><span class="dot" style="background:#712d23"></span> Carteira externa</span>
    <span>⭐ Contrato/Token/Bridge (icosaedro 3D)</span>
    <span>🏭 Criador de Pool (borda dourada)</span>
    <span style="margin-left:16px">Controles 3D:</span>
    <span>🖱️ Arraste = rotacionar</span>
    <span>🔍 Scroll = zoom</span>
    <span>✋ Clique direito = pan</span>
    <span style="margin-left:16px">Borda ∝ transações:</span>
    <span><span class="dot" style="background:#eb3812"></span> Muitas</span>
    <span><span class="dot" style="background:#F05F40"></span> Médias</span>
    <span><span class="dot" style="background:#cc7501"></span> Poucas</span>
    <span><span class="dot" style="background:#d49a5a"></span> Mínimas</span>
    <span style="margin-left:16px">Risco de manipulação:</span>
    <span><span class="dot" style="background:#eb3812"></span> ALTO</span>
    <span><span class="dot" style="background:#F05F40"></span> MODERADO</span>
    <span><span class="dot" style="background:#cc7501"></span> BAIXO</span>
    <span>— arestas tracejadas = alerta</span>
  </div>
</div>

<script>
const graphData = ${graphDataJson};

${GRAPH_3D_TOOLTIP_JS}
${GRAPH_3D_INIT_JS}
${GRAPH_3D_SEARCH_JS}
</script>
</body>
</html>`;
}

// ── Browser opener ────────────────────────────────────────────────────

function openBrowser(filePath: string): void {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  execFile(opener, [filePath], (err) => {
    if (err) {
      log("WARN", "openBrowser", "Não foi possível abrir o navegador automaticamente", { error: err.message, file: filePath });
    } else {
      log("OK", "openBrowser", "Grafo aberto no navegador", { file: filePath });
    }
  });
}

// ── Target resolution ─────────────────────────────────────────────────

function searchByName(query: string): AddressRecord[] {
  const db = getDB();
  const like = `%${query.toLowerCase()}%`;
  return db.prepare(
    "SELECT * FROM addresses WHERE name LIKE ? COLLATE NOCASE ORDER BY updated_at DESC",
  ).all(like) as AddressRecord[];
}

function resolveTarget(target: string): string | null {
  // Full address
  if (/^0x[0-9a-fA-F]{40}$/.test(target)) {
    return target.toLowerCase();
  }

  // Shortened address (0xc590…c02b, 0xc590…, 0x…c02b)
  if (target.startsWith("0x") && (target.includes("…") || target.includes("..."))) {
    const resolved = resolveShortAddress(target);
    if (resolved) {
      log("OK", "resolveTarget", "Endereço encurtado resolvido", { input: target, address: resolved });
      return resolved;
    }
    log("WARN", "resolveTarget", "Endereço encurtado não encontrado", { input: target });
  }

  // Integer index
  const idx = parseInt(target, 10);
  if (!isNaN(idx) && String(idx) === target && idx > 0) {
    const all = getAllAddresses();
    if (idx <= all.length) {
      log("OK", "resolveTarget", "Endereço por índice", { index: idx, address: all[idx - 1].address });
      return all[idx - 1].address;
    }
  }

  // Name search
  const nameResults = searchByName(target);
  if (nameResults.length > 0) {
    log("OK", "resolveTarget", "Endereço por nome", { query: target, address: nameResults[0].address });
    return nameResults[0].address;
  }

  // Label/notes search
  const results = searchAddresses(target);
  if (results.length > 0) {
    log("OK", "resolveTarget", "Endereço por label/notes", { query: target, address: results[0].address });
    return results[0].address;
  }

  // Direct DB lookup
  const direct = getAddress(target);
  if (direct) return direct.address;

  log("WARN", "resolveTarget", "Não foi possível resolver o alvo", { target });
  return null;
}

// ── Main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log("INFO", "main", "🚀 Iniciando geração do grafo de transferências CAS");

  const cliArgs = process.argv.slice(2);
  const useDbOnly = cliArgs.includes("--use-db");
  const anonMode = cliArgs.includes("--anon");

  // Parse positional targets (address, name, index, shortened address)
  const positionalTargets: string[] = [];
  for (let i = 0; i < cliArgs.length; i++) {
    const arg = cliArgs[i];
    if (arg === "--depth") { i++; continue; }
    if (arg === "--index") { const v = cliArgs[++i]; if (v) positionalTargets.push(v); continue; }
    if (arg.startsWith("--")) continue;
    positionalTargets.push(arg);
  }

  const envDepth = parseInt(process.env.GRAPH_DEPTH_DEFAULT ?? "0", 10);
  let depth = isNaN(envDepth) || envDepth < 0 ? 0 : envDepth;
  const depthIdx = cliArgs.indexOf("--depth");
  if (depthIdx !== -1) {
    const val = parseInt(cliArgs[depthIdx + 1] ?? "", 10);
    if (!isNaN(val) && val >= 0) {
      depth = val;
    } else {
      log("WARN", "main", "Valor inválido para --depth, usando default do .env", { value: cliArgs[depthIdx + 1], defaultDepth: depth });
    }
  }
  log("INFO", "main", "Profundidade BFS", { depth, source: depthIdx !== -1 ? "cli" : "env" });

  const tokenAddress = process.env.CAS_TOKEN_ADDRESS?.trim();
  if (!tokenAddress || !/^0x[0-9a-fA-F]{40}$/.test(tokenAddress)) {
    log("ERROR", "main", "CAS_TOKEN_ADDRESS ausente ou inválido em smartcontracts/.env");
    process.exit(1);
  }

  getDB();
  importAllCsvs(path.join(SC_ROOT, "data"));

  let transfers: TokenTransfer[] = [];
  let totalSupply: bigint = 0n;

  if (useDbOnly) {
    log("INFO", "main", "Modo --use-db: lendo transações do banco SQLite (sem sync API)");
    const dbTxCount = getTransactionCount();
    if (dbTxCount === 0) {
      log("ERROR", "main", "Banco SQLite vazio. Rode sem --use-db para sincronizar via API primeiro.");
      closeDB();
      process.exit(1);
    }
    const dbTxs = getAllTransactionsFromDB();
    transfers = dbTxs.map((t) => ({
      hash: t.tx_hash,
      from: t.from_address,
      to: t.to_address,
      value: t.value,
      timeStamp: String(t.timestamp),
      blockNumber: String(t.block_number),
    }));
    log("OK", "main", "Transações carregadas do SQLite", { count: transfers.length });

    if (process.env.POLYGONSCAN_API_KEY?.trim()) {
      try {
        totalSupply = await fetchTotalSupply(tokenAddress);
      } catch (err) {
        log("WARN", "main", "Falha ao buscar total supply via API, usando soma do banco", { error: (err as Error).message });
      }
    }
  } else {
    if (!process.env.POLYGONSCAN_API_KEY?.trim()) {
      log("ERROR", "main", "POLYGONSCAN_API_KEY ausente em smartcontracts/.env. Use --use-db para modo apenas banco.");
      closeDB();
      process.exit(1);
    }

    log("INFO", "main", "Sync incremental + totalSupply concorrentemente");

    const [transfersResult, supplyResult] = await Promise.allSettled([
      fetchAllTransfers(tokenAddress),
      fetchTotalSupply(tokenAddress),
    ]);

    if (transfersResult.status === "fulfilled") {
      transfers = transfersResult.value;
      log("OK", "main", "Transferências obtidas", { count: transfers.length });
    } else {
      log("ERROR", "main", "Falha no sync de transferências", { error: transfersResult.reason?.message });
      if (getTransactionCount() > 0) {
        const dbTxs = getAllTransactionsFromDB();
        transfers = dbTxs.map((t) => ({
          hash: t.tx_hash,
          from: t.from_address,
          to: t.to_address,
          value: t.value,
          timeStamp: String(t.timestamp),
          blockNumber: String(t.block_number),
        }));
        log("OK", "main", "Transações carregadas do SQLite (fallback)", { count: transfers.length });
      } else {
        closeDB();
        process.exit(1);
      }
    }

    if (supplyResult.status === "fulfilled") {
      totalSupply = supplyResult.value;
      log("OK", "main", "Total supply obtido via API", { supply: toNum(totalSupply) });
    } else {
      log("WARN", "main", "Falha ao buscar total supply via API", { error: supplyResult.reason?.message });
    }
  }

  if (totalSupply === 0n && transfers.length > 0) {
    const balances = new Map<string, bigint>();
    for (const t of transfers) {
      const from = t.from.toLowerCase();
      const to = t.to.toLowerCase();
      const value = BigInt(t.value);
      if (from !== ZERO) balances.set(from, (balances.get(from) ?? 0n) - value);
      if (to !== ZERO) balances.set(to, (balances.get(to) ?? 0n) + value);
    }
    totalSupply = [...balances.values()].reduce((s, b) => (b > 0n ? s + b : s), 0n);
    log("WARN", "main", "Total supply aproximado dos transfers", { approxSupply: toNum(totalSupply) });
  }

  if (transfers.length === 0) {
    log("ERROR", "main", "Nenhuma transferência encontrada");
    closeDB();
    process.exit(1);
  }

  if (!useDbOnly && process.env.POLYGONSCAN_API_KEY?.trim()) {
    try {
      await fetchPoolCreators(tokenAddress);
    } catch (err) {
      log("WARN", "main", "Falha ao buscar pool creators (não bloqueia)", { error: (err as Error).message });
    }
  }
  const poolCreatorMap = getPoolCreatorMap();
  if (poolCreatorMap.size > 0) {
    log("OK", "main", "Pool creators carregados do banco", { creators: poolCreatorMap.size, pools: [...poolCreatorMap.values()].reduce((s, l) => s + l.length, 0) });
  }

  const diagnosis = runGnnDiagnosis();

  // Resolve positional targets if provided
  let targetSeeds: Set<string> | undefined;
  if (positionalTargets.length > 0) {
    targetSeeds = new Set<string>();
    for (const t of positionalTargets) {
      const addr = resolveTarget(t);
      if (addr) {
        targetSeeds.add(addr);
      } else {
        log("WARN", "main", "Alvo não resolvido, pulando", { target: t });
      }
    }
    if (targetSeeds.size > 0) {
      log("OK", "main", "Alvos resolvidos para centro do grafo", { count: targetSeeds.size, addresses: [...targetSeeds] });
      // When targets are provided, force depth to at least 1 if it's 0
      if (depth === 0) depth = 1;
    } else {
      log("WARN", "main", "Nenhum alvo pôde ser resolvido — usando seeds infra padrão");
      targetSeeds = undefined;
    }
  }

  const filteredTransfers = filterTransfersByDepth(transfers, depth, anonMode, targetSeeds);
  if (filteredTransfers.length !== transfers.length) {
    log("INFO", "main", "Transferências filtradas por profundidade", { original: transfers.length, filtered: filteredTransfers.length, depth });
  }
  const holders = computeHolders(filteredTransfers, totalSupply, anonMode);
  const graph = buildGraphData(filteredTransfers, holders, tokenAddress, diagnosis, anonMode, poolCreatorMap, depth);
  log("OK", "main", "Grafo construído", { nodes: graph.meta.nodeCount, edges: graph.meta.edgeCount, volume: graph.meta.totalVolume, alerts: graph.meta.alertCount });
  const reportsDir = path.join(SC_ROOT, "reports");
  fs.mkdirSync(reportsDir, { recursive: true });

  const outFile = path.join(reportsDir, `cas_graph_${new Date().toISOString().slice(0, 10)}.html`);
  fs.writeFileSync(outFile, buildGraphHtml(graph, tokenAddress, diagnosis), "utf-8");
  log("OK", "main", "Relatório de grafo salvo", { file: outFile });

  // Also save JSON for programmatic consumption
  const jsonFile = path.join(reportsDir, `cas_graph_${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(jsonFile, JSON.stringify(graph, null, 2), "utf-8");
  log("OK", "main", "JSON do grafo salvo", { file: jsonFile });

  openBrowser(outFile);
  log("INFO", "main", "🏁 Geração do grafo concluída");
  closeDB();
}

main().catch((err) => {
  log("ERROR", "main", "Falha na execução", { error: (err as Error).message });
  closeDB();
  process.exit(1);
});
