/**
 * CAS Distribution Dashboard
 * --------------------------
 * Analisa a distribuição do token CAS na Polygon Mainnet usando a API do
 * Polygonscan (Etherscan V2) e/ou dados do banco SQLite local, calcula
 * métricas de concentração (Gini, HHI, Top-N, holders > 30%), gera sugestões
 * textuais via GenAI (OpenRouter) e abre um dashboard HTML rico em gráficos.
 *
 * Integração SQLite:
 *   - Labels/nomes de endereços são lidos do banco cas_tracker.db
 *   - Transações podem ser lidas do banco se já sincronizadas (08_sync_cas_db)
 *   - Use --use-db para forçar leitura apenas do banco (sem API)
 *
 * Importação CSV automática:
 *   - Varre smartcontracts/data/*.csv e importa endereços com labels/observações
 *   - Detecção automática de colunas (nome, endereço, observação) via heurísticas NLP
 *   - A importação ocorre antes da análise para garantir labels atualizados
 *
 * Modo anônimo (--anon):
 *   - Não exibe labels, nomes ou observações — apenas endereços curtos
 *   - Classificação infra/externo é preservada para análise de risco
 *
 * Uso:
 *   npm run analysis:cas:distribution
 *   npm run analysis:cas:distribution -- --use-db
 *   npm run analysis:cas:distribution -- --anon
 *   npm run analysis:cas:distribution -- --depth 3
 *   npm run analysis:cas:distribution -- "Rapport" --depth 2
 *   npm run analysis:cas:distribution -- 0xc590…c02b "Ednardo" --depth 2
 *   npm run analysis:cas:distribution -- --from 2026-11-01 --to 2026-11-05
 *   npm run analysis:cas:distribution -- --from 01/11/2026_12-00 --to 05/11/2026
 *   (ou) npx hardhat run scripts/analysis/cas_distribution_dashboard.ts
 *
 * Flags:
 *   --depth N   Profundidade BFS a partir de endereços conhecidos (default: GRAPH_DEPTH_DEFAULT do .env)
 *   --use-db    Usa apenas o banco SQLite (sem sync via API)
 *   --anon      Oculta labels e observações
 *   --from D    Considera apenas transferências a partir de D (UTC).
 *   --to D      Considera apenas transferências até D (UTC, inclusivo;
 *               data-only cobre o dia inteiro até 23:59:59).
 *               Formatos de D: AAAA-MM-DD[_HH-MM] ou DD/MM/AAAA[_HH-MM].
 *
 * Alvos posicionais (opcional):
 *   Endereço, nome, índice, ou endereço encurtado (0x……) para centrar a análise.
 *   Múltiplos alvos podem ser passados.
 *   Se omitido, usa endereços infra conhecidos como seeds.
 *
 * Detecção de manipulação:
 *   - volume spikes, pump/dump, whale dump, wash trading, clusters coordenados;
 *   - short-and-distort, spoofing/layering, rug pull;
 *   - aba "🚨 Manipulação" no HTML + JSON cas_manipulation_signals_*.json;
 *   - SocialSentinel opcional (SOCIAL_SENTINEL_ENABLED=true + CONSENT=true).
 *
 * Requisitos de ambiente:
 *   smartcontracts/.env : POLYGONSCAN_API_KEY, CAS_TOKEN_ADDRESS (+ labels)
 *   backend/.env        : AI_API_KEY, AI_MODEL (OpenRouter)
 */

import { formatUnits } from "agentic_space_commons";
import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
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
  getAddress,
  getAllAddresses,
  searchAddresses,
  resolveShortAddress,
  type AddressRecord,
} from "../utils/cas_database";
import { importAllCsvs } from "../utils/cas_csv_import";
import { detectManipulationSignals, type ManipulationSignal, type LabelResolver } from "../utils/cas_manipulation";
import { describeDateRange, inDateRange, resolveDateRange } from "../utils/date_range";
import { SocialSentinel, type SentimentSnapshot } from "../utils/social_sentinel";
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
const BACKEND_ENV = path.resolve(SC_ROOT, "..", "backend", ".env");

dotenv.config({ path: path.join(SC_ROOT, ".env") });
dotenv.config({ path: BACKEND_ENV, override: false });

// ── Global flags ──────────────────────────────────────────────────────

let anonMode = false;

// ── Structured logging ────────────────────────────────────────────────

type LogLevel = "INFO" | "WARN" | "ERROR" | "OK" | "DEBUG";

function log(level: LogLevel, fn: string, message: string, params?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const emoji = { INFO: "ℹ️", WARN: "⚠️", ERROR: "❌", OK: "✅", DEBUG: "🔍" }[level];
  const extra = params ? ` - ${JSON.stringify(params)}` : "";
  console.log(`[${ts}] [cas_distribution_dashboard:${fn}] ${emoji} ${message}${extra}`);
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
  isContractLike: boolean;
  observation: string;
}

interface Metrics {
  totalSupply: bigint;
  decimals: number;
  holders: Holder[];
  holderCount: number;
  top1Pct: number;
  top5Pct: number;
  top10Pct: number;
  gini: number;
  hhi: number;
  whales30: Holder[];
  circulating: bigint;
  circulatingPct: number;
  transferCount: number;
  firstTransfer: Date | null;
  lastTransfer: Date | null;
  dailySeries: { date: string; count: number; volume: number }[];
}

interface DexPair {
  dex: string;
  pairAddress: string;
  url: string;
  priceUsd: number;
  priceNative: number;
  liquidityUsd: number;
  volume24h: number;
  txns24h: { buys: number; sells: number };
  fdv: number;
  marketCap: number;
  quoteSymbol: string;
}

interface MarketData {
  coingeckoListed: boolean;
  coingeckoId: string | null;
  coingeckoPriceUsd: number | null;
  coingeckoMarketCap: number | null;
  coingeckoVolume24h: number | null;
  dexPairs: DexPair[];
  bestPair: DexPair | null;
}

// ── Known address labels (env + SQLite DB) ─────────────────────────────

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

interface PartnerRecord {
  name: string;
  group: string;
  indication: string;
  date: string;
  dateSort: number;
  rawAddress: string;
  address: string;
  quantity: number;
  currentBalance: number;
  currentPct: number;
  label: string;
  observation: string;
  type: string;
  receivedUsd: number | null;
  currentUsd: number | null;
  isResolvable: boolean;
}

function knownLabels(): Map<string, KnownAddress> {
  const map = new Map<string, KnownAddress>();

  // 1. Labels from .env (highest priority for isInfra classification)
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

  // 2. Labels from SQLite DB (supplement, don't override env labels)
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

  // ── Anon mode: strip labels and observations but preserve isInfra ──
  if (anonMode) {
    for (const [addr, info] of map) {
      map.set(addr, { ...info, label: "", observation: "" });
    }
    log("INFO", "knownLabels", "Modo anônimo ativo — labels e observações ocultos", { entries: map.size });
  }

  return map;
}

// ── CSV import with NLP-like column detection ─────────────────────────

const DATA_DIR = path.join(SC_ROOT, "data");
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const NAME_KEYWORDS = ["nome", "name", "titular", "identificacao", "identificação",
  "grupo", "conta", "usuario", "usuário", "user", "owner", "dono", "pessoa"];
const ADDRESS_KEYWORDS = ["endereco", "endereço", "address", "addr", "wallet",
  "carteira", "conta"];
const OBS_KEYWORDS = ["obs", "observacao", "observação", "nota", "note",
  "descricao", "descrição", "description", "comentario", "comentário",
  "comment", "detalhe", "detail"];
const QTD_KEYWORDS = ["qtd", "quantidade", "amount", "quantity", "valor"];
const DATE_KEYWORDS = ["data", "datahora", "data/hora", "timestamp", "date", "hora"];
const GROUP_KEYWORDS = ["grupo", "group", "categoria", "campanha", "time", "equipe"];
const INDICATION_KEYWORDS = ["indicacao", "indicação", "indicado", "indication", "ref", "referencia", "referência"];

function normalizeHeader(h: string): string {
  return h.toLowerCase().trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let j = 0; j < line.length; j++) {
    const ch = line[j];
    if (ch === '"') {
      if (inQuotes && line[j + 1] === '"') {
        current += '"';
        j++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      fields.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

function detectColumns(
  headers: string[],
  sampleRows: string[][],
): { nameCol: number; addressCol: number; obsCol: number } {
  const colCount = headers.length;
  const scores = Array.from({ length: colCount }, (_, idx) => {
    const norm = normalizeHeader(headers[idx] ?? "");
    let nameScore = 0;
    let addressScore = 0;
    let obsScore = 0;

    for (const kw of NAME_KEYWORDS) {
      if (norm.includes(normalizeHeader(kw))) { nameScore += 10; break; }
    }
    for (const kw of ADDRESS_KEYWORDS) {
      if (norm.includes(normalizeHeader(kw))) { addressScore += 10; break; }
    }
    for (const kw of OBS_KEYWORDS) {
      if (norm.includes(normalizeHeader(kw))) { obsScore += 10; break; }
    }

    const values = sampleRows
      .map((r) => (r[idx] ?? "").trim())
      .filter((v) => v.length > 0);

    if (values.length > 0) {
      const addrMatches = values.filter((v) => ADDRESS_RE.test(v)).length;
      if (addrMatches / values.length > 0.3) addressScore += 20;

      const nameLike = values.filter(
        (v) => v.length > 2 && v.length < 100 && !ADDRESS_RE.test(v) && !/^\d+$/.test(v),
      ).length;
      if (nameLike / values.length > 0.3) nameScore += 5;

      const obsLike = values.filter((v) => v.length > 15).length;
      if (obsLike / values.length > 0.2) obsScore += 5;
    }

    return { idx, nameScore, addressScore, obsScore };
  });

  const bestAddress = scores.reduce((b, s) => (s.addressScore > b.addressScore ? s : b), scores[0]);
  const addressCol = bestAddress.addressScore > 0 ? bestAddress.idx : -1;

  const nameCandidates = scores.filter((s) => s.idx !== addressCol);
  const bestName = nameCandidates.reduce((b, s) => (s.nameScore > b.nameScore ? s : b), nameCandidates[0]);
  const nameCol = bestName && bestName.nameScore > 0 ? bestName.idx : -1;

  const obsCandidates = scores.filter((s) => s.idx !== addressCol && s.idx !== nameCol);
  const bestObs = obsCandidates.reduce((b, s) => (s.obsScore > b.obsScore ? s : b), obsCandidates[0]);
  const obsCol = bestObs && bestObs.obsScore > 0 ? bestObs.idx : -1;

  return { nameCol, addressCol, obsCol };
}

function findPartnerColumn(headers: string[], keywords: string[]): number {
  for (let i = 0; i < headers.length; i++) {
    const h = normalizeHeader(headers[i] ?? "");
    for (const kw of keywords) {
      if (h.includes(normalizeHeader(kw))) return i;
    }
  }
  return -1;
}

function parsePtBrNumber(s: string): number {
  const t = (s || "").replace(/[^\d.,-]/g, "");
  const normalized = t.replace(/\./g, "").replace(",", ".");
  const n = parseFloat(normalized);
  return isNaN(n) ? 0 : n;
}

function parseDateToTimestamp(s: string): number {
  const m = s.match(/(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return 0;
  const [_, d, mo, y, hh = "00", mm = "00", ss = "00"] = m;
  const iso = `${y}-${mo}-${d}T${hh}:${mm}:${ss}Z`;
  const ts = new Date(iso).getTime();
  return isNaN(ts) ? 0 : ts;
}

function loadAirdropPartners(
  dataDir: string,
  labels: Map<string, KnownAddress>,
  holders: Holder[],
  priceUsd: number,
): PartnerRecord[] {
  const files = fs.readdirSync(dataDir)
    .filter((f) => f.toLowerCase().endsWith(".csv") && /airdrop|distribuicao|distribuição/.test(f.toLowerCase()))
    .sort();
  if (files.length === 0) return [];

  const holdersMap = new Map(holders.map((h) => [h.address, h]));
  const partners: PartnerRecord[] = [];

  for (const fileName of files) {
    const csvPath = path.join(dataDir, fileName);
    log("INFO", "loadAirdropPartners", "Carregando CSV de parceiros", { file: fileName });

    let content: string;
    try {
      content = fs.readFileSync(csvPath, "utf-8");
    } catch (err) {
      log("WARN", "loadAirdropPartners", "Não foi possível ler arquivo", { file: fileName, error: (err as Error).message });
      continue;
    }

    const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const rows = lines.map((l) => parseCsvLine(l));

    let headerIdx = -1;
    for (let i = 0; i < Math.min(10, rows.length); i++) {
      const cells = rows[i];
      const hasName = cells.some((c) => NAME_KEYWORDS.some((kw) => normalizeHeader(c).includes(normalizeHeader(kw))));
      const hasAddr = cells.some((c) => ADDRESS_KEYWORDS.some((kw) => normalizeHeader(c).includes(normalizeHeader(kw))));
      const hasQtd = cells.some((c) => QTD_KEYWORDS.some((kw) => normalizeHeader(c).includes(normalizeHeader(kw))));
      if ((hasName && hasAddr) || hasQtd) { headerIdx = i; break; }
    }
    if (headerIdx === -1) {
      log("WARN", "loadAirdropPartners", "Cabeçalho não encontrado, pulando arquivo", { file: fileName });
      continue;
    }

    const headers = rows[headerIdx];
    const dataRows = rows.slice(headerIdx + 1);

    const nameCol = findPartnerColumn(headers, NAME_KEYWORDS);
    const addressCol = findPartnerColumn(headers, ADDRESS_KEYWORDS);
    const qtdCol = findPartnerColumn(headers, QTD_KEYWORDS);
    const groupCol = findPartnerColumn(headers, GROUP_KEYWORDS);
    const dateCol = findPartnerColumn(headers, DATE_KEYWORDS);
    const indicationCol = findPartnerColumn(headers, INDICATION_KEYWORDS);

    if (addressCol < 0) {
      log("WARN", "loadAirdropPartners", "Coluna de endereço não encontrada, pulando arquivo", { file: fileName });
      continue;
    }

    for (const row of dataRows) {
      const rawQty = qtdCol >= 0 ? (row[qtdCol] ?? "").trim() : "";
      const quantity = parsePtBrNumber(rawQty);
      if (quantity <= 0) continue;

      const rawAddr = (row[addressCol] ?? "").trim();
      if (!rawAddr) continue;

      const isResolvable = ADDRESS_RE.test(rawAddr);
      const address = isResolvable ? rawAddr.toLowerCase() : rawAddr;

      const name = nameCol >= 0 ? (row[nameCol] ?? "").trim() : "";
      const group = groupCol >= 0 ? (row[groupCol] ?? "").trim() : "";
      const date = dateCol >= 0 ? (row[dateCol] ?? "").trim() : "";
      const indication = indicationCol >= 0 ? (row[indicationCol] ?? "").trim() : "";

      const known = isResolvable ? labels.get(address) : undefined;
      const holder = isResolvable ? holdersMap.get(address) : undefined;
      const currentBalance = holder ? toNum(holder.balance) : 0;
      const currentPct = holder ? holder.pct : 0;
      const label = known?.label || holder?.label || name || "Parceiro";
      const type = known?.type || holder?.type || "unknown";
      const observation = known?.observation || holder?.observation || "";

      partners.push({
        name: name || label,
        group,
        indication,
        date,
        dateSort: parseDateToTimestamp(date),
        rawAddress: rawAddr,
        address,
        quantity,
        currentBalance,
        currentPct,
        label,
        observation,
        type,
        receivedUsd: priceUsd > 0 ? quantity * priceUsd : null,
        currentUsd: priceUsd > 0 ? currentBalance * priceUsd : null,
        isResolvable,
      });
    }
  }

  partners.sort((a, b) => b.quantity - a.quantity);
  log("OK", "loadAirdropPartners", "Parceiros carregados", { count: partners.length, files: files.length });
  return partners;
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
    ? [pinnedBase, ...API_BASES.filter(b => b !== pinnedBase)]
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
      keySource: isEtherscanV2
        ? (process.env.ETHERSCAN_API_KEY?.trim() ? "ETHERSCAN_API_KEY" : "POLYGONSCAN_API_KEY")
        : "POLYGONSCAN_API_KEY",
    });

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
        const contentType = res.headers.get("content-type") ?? "";
        if (!contentType.includes("application/json")) {
          const textBody = await res.text();
          const isHtml = textBody.trimStart().startsWith("<");
          const detail = isHtml
            ? "Resposta HTML (possível Cloudflare/rate-limit)"
            : textBody.slice(0, 200);
          if (isTransientError(res.status, detail) && attempt < MAX_RETRIES) {
            const backoff = Math.min(1000 * Math.pow(2, attempt - 1), 16_000) + Math.random() * 400;
            log("WARN", "scanRequest", "Resposta não-JSON, retrying", {
              base: base.split("/").pop(),
              action: params.action,
              attempt,
              contentType,
              httpStatus: res.status,
              backoffMs: Math.round(backoff + RATE_LIMIT_EXTRA_DELAY_MS),
            });
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
          log("WARN", "scanRequest", "API rate limited, retrying", {
            base: base.split("/").pop(),
            action: params.action,
            attempt,
            message: body.message,
            result: resultStr.slice(0, 150),
            backoffMs: Math.round(backoff + RATE_LIMIT_EXTRA_DELAY_MS),
          });
          await sleep(backoff + RATE_LIMIT_EXTRA_DELAY_MS);
          continue;
        }
        throw new Error(`API status=${body.status} message=${body.message} result=${resultStr.slice(0, 200)}`);
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

/**
 * Sync incremental: busca apenas transferências novas do Polygonscan
 * e armazena no SQLite. Retorna todas as transferências do banco.
 */
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
        newCount,
      });
      if (dbCount + newCount > 0) {
        log("WARN", "fetchAllTransfers", "Prosseguindo com dados parciais", { dbCount, newCount });
        break;
      }
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

    log("DEBUG", "fetchAllTransfers", "Página sincronizada", {
      startBlock: currentStartBlock,
      count: result.length,
      newCount,
      lastTxBlock,
    });

    if (result.length < PAGE_SIZE) break;
    currentStartBlock = lastTxBlock + 1;
  }

  if (newCount > 0) {
    recalculateAllAddressStats();
    setSyncState("last_sync", new Date().toISOString());
  }

  const totalCount = getTransactionCount();
  log("OK", "fetchAllTransfers", "Sync concluído", {
    newTx: newCount,
    totalDbTx: totalCount,
  });

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

async function fetchTotalSupply(tokenAddress: string): Promise<bigint> {
  const result = (await scanRequest({
    module: "stats",
    action: "tokensupply",
    contractaddress: tokenAddress,
  })) as string;
  return BigInt(result);
}

// ── CoinGecko API ─────────────────────────────────────────────────────

async function fetchCoinGeckoStatus(tokenAddress: string): Promise<{
  listed: boolean;
  id: string | null;
  priceUsd: number | null;
  marketCap: number | null;
  volume24h: number | null;
}> {
  const apiKey = process.env.COINGECKO_API_KEY?.trim();
  const url = `https://api.coingecko.com/api/v3/coins/polygon/contract/${tokenAddress}`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (apiKey) headers["x-cg-demo-api-key"] = apiKey;

  log("INFO", "fetchCoinGeckoStatus", "Verificando listagem no CoinGecko", { token: tokenAddress });
  try {
    const res = await fetchWithTimeout(url, 10_000);
    if (res.status === 404) {
      log("WARN", "fetchCoinGeckoStatus", "Token não listado no CoinGecko");
      return { listed: false, id: null, priceUsd: null, marketCap: null, volume24h: null };
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as {
      id: string;
      market_data?: {
        current_price?: { usd?: number };
        market_cap?: { usd?: number };
        total_volume?: { usd?: number };
      };
    };
    const price = data.market_data?.current_price?.usd ?? null;
    const mcap = data.market_data?.market_cap?.usd ?? null;
    const vol = data.market_data?.total_volume?.usd ?? null;
    log("OK", "fetchCoinGeckoStatus", "Token listado no CoinGecko", {
      id: data.id, priceUsd: price, marketCap: mcap, volume24h: vol,
    });
    return { listed: true, id: data.id, priceUsd: price, marketCap: mcap, volume24h: vol };
  } catch (err) {
    log("WARN", "fetchCoinGeckoStatus", "Erro ao consultar CoinGecko", { error: (err as Error).message });
    return { listed: false, id: null, priceUsd: null, marketCap: null, volume24h: null };
  }
}

// ── DexScreener API ───────────────────────────────────────────────────

async function fetchDexScreenerData(tokenAddress: string): Promise<{
  dexPairs: DexPair[];
  bestPair: DexPair | null;
}> {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`;
  log("INFO", "fetchDexScreenerData", "Buscando pares DEX no DexScreener", { token: tokenAddress });
  try {
    const res = await fetchWithTimeout(url, 10_000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as {
      pairs?: Array<{
        dexId: string;
        url: string;
        pairAddress: string;
        priceNative: string;
        priceUsd: string;
        volume?: { h24?: number };
        liquidity?: { usd?: number };
        txns?: { h24?: { buys?: number; sells?: number } };
        fdv?: number;
        marketCap?: number;
        quoteToken?: { symbol?: string };
      }>;
    };
    const rawPairs = body.pairs ?? [];
    const dexPairs: DexPair[] = rawPairs.map((p) => ({
      dex: p.dexId,
      pairAddress: p.pairAddress,
      url: p.url,
      priceUsd: parseFloat(p.priceUsd) || 0,
      priceNative: parseFloat(p.priceNative) || 0,
      liquidityUsd: p.liquidity?.usd ?? 0,
      volume24h: p.volume?.h24 ?? 0,
      txns24h: { buys: p.txns?.h24?.buys ?? 0, sells: p.txns?.h24?.sells ?? 0 },
      fdv: p.fdv ?? 0,
      marketCap: p.marketCap ?? 0,
      quoteSymbol: p.quoteToken?.symbol ?? "?",
    }));
    const bestPair = dexPairs.length > 0
      ? dexPairs.reduce((best, p) => (p.liquidityUsd > best.liquidityUsd ? p : best))
      : null;
    log("OK", "fetchDexScreenerData", "Pares DEX encontrados", {
      pairCount: dexPairs.length,
      bestDex: bestPair?.dex,
      bestLiquidity: bestPair?.liquidityUsd,
    });
    return { dexPairs, bestPair };
  } catch (err) {
    log("WARN", "fetchDexScreenerData", "Erro ao consultar DexScreener", { error: (err as Error).message });
    return { dexPairs: [], bestPair: null };
  }
}

// ── Depth filtering (BFS from known infra addresses) ──────────────────

function filterTransfersByDepth(transfers: TokenTransfer[], maxDepth: number, seedAddrs?: Set<string>): TokenTransfer[] {
  if (maxDepth <= 0 && !seedAddrs) return transfers;

  const seeds = new Set<string>();
  if (seedAddrs && seedAddrs.size > 0) {
    for (const a of seedAddrs) seeds.add(a.toLowerCase());
  } else {
    const labels = knownLabels();
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

// ── Metrics computation ───────────────────────────────────────────────

const ZERO = "0x0000000000000000000000000000000000000000";
const DECIMALS = 18;

function toNum(v: bigint): number {
  return Number(formatUnits(v, DECIMALS));
}

function computeMetrics(transfers: TokenTransfer[], totalSupply: bigint): Metrics {
  const labels = knownLabels();
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

  const sumPct = (n: number) => holders.slice(0, n).reduce((s, h) => s + h.pct, 0);

  // Gini (sobre holders com saldo > 0)
  const vals = holders.map((h) => toNum(h.balance)).sort((a, b) => a - b);
  const n = vals.length;
  const total = vals.reduce((s, v) => s + v, 0);
  let giniSum = 0;
  for (let i = 0; i < n; i++) giniSum += (2 * (i + 1) - n - 1) * vals[i];
  const gini = n > 1 && total > 0 ? giniSum / (n * total) : 0;

  // HHI: soma dos quadrados dos percentuais (0-10000)
  const hhi = holders.reduce((s, h) => s + h.pct * h.pct, 0);

  const whales30 = holders.filter((h) => h.pct > 30);

  const infraBalance = holders.filter((h) => h.isContractLike).reduce((s, h) => s + h.balance, 0n);
  const circulating = totalSupply - infraBalance;

  // Série temporal diária
  const daily = new Map<string, { count: number; volume: number }>();
  for (const t of transfers) {
    const date = new Date(Number(t.timeStamp) * 1000).toISOString().slice(0, 10);
    const entry = daily.get(date) ?? { count: 0, volume: 0 };
    entry.count += 1;
    entry.volume += toNum(BigInt(t.value));
    daily.set(date, entry);
  }
  const dailySeries = [...daily.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({ date, count: v.count, volume: Math.round(v.volume * 100) / 100 }));

  return {
    totalSupply,
    decimals: DECIMALS,
    holders,
    holderCount: holders.length,
    top1Pct: sumPct(1),
    top5Pct: sumPct(5),
    top10Pct: sumPct(10),
    gini: Math.round(gini * 10000) / 10000,
    hhi: Math.round(hhi),
    whales30,
    circulating,
    circulatingPct: totalSupply > 0n ? Number((circulating * 10000n) / totalSupply) / 100 : 0,
    transferCount: transfers.length,
    firstTransfer: transfers.length ? new Date(Number(transfers[0].timeStamp) * 1000) : null,
    lastTransfer: transfers.length ? new Date(Number(transfers[transfers.length - 1].timeStamp) * 1000) : null,
    dailySeries,
  };
}

// ── GenAI (OpenRouter) ────────────────────────────────────────────────

async function generateAiAnalysis(metrics: Metrics, marketData: MarketData): Promise<string> {
  const apiKey = process.env.AI_API_KEY?.trim();
  const model = process.env.AI_MODEL?.trim();
  if (!apiKey || !model) {
    log("WARN", "generateAiAnalysis", "AI_API_KEY/AI_MODEL ausentes; pulando análise GenAI");
    return "<p><em>Análise GenAI indisponível: configure AI_API_KEY e AI_MODEL em backend/.env.</em></p>";
  }

  const topSummary = metrics.holders.slice(0, 15).map((h, i) => ({
    rank: i + 1,
    address: h.address,
    label: anonMode ? "anônimo" : (h.label || "desconhecido"),
    pct: h.pct,
    balance: toNum(h.balance),
    infra: h.isContractLike,
  }));

  const cgStatus = marketData.coingeckoListed
    ? `Listado (id: ${marketData.coingeckoId}, preço: $${marketData.coingeckoPriceUsd}, market cap: $${marketData.coingeckoMarketCap}, volume 24h: $${marketData.coingeckoVolume24h})`
    : "NÃO listado no CoinGecko";
  const dexSummary = marketData.dexPairs.length
    ? marketData.dexPairs.map((p) => `${p.dex} (${p.quoteSymbol}): preço $${p.priceUsd.toExponential(2)}, liquidez $${p.liquidityUsd.toFixed(2)}, vol24h $${p.volume24h.toFixed(2)}, txns24h ${p.txns24h.buys}b/${p.txns24h.sells}s`).join(" | ")
    : "Nenhum par DEX encontrado";

  const prompt = `Você é um analista sênior de mercado cripto assessorando o admin/criador do token CAS (Polygon Mainnet, supply máximo 10.000.000, cunhado 1.000.000).
O objetivo do admin é garantir que o CAS NÃO seja percebido como token fake ou de baixa qualidade por agregadores, exchanges e traders.

Dados on-chain atuais (fonte: Polygonscan):
- Supply total: ${toNum(metrics.totalSupply)} CAS
- Holders com saldo > 0: ${metrics.holderCount}
- Circulante (fora de contratos de infraestrutura/DEX): ${toNum(metrics.circulating)} CAS (${metrics.circulatingPct}%)
- Concentração: Top1=${metrics.top1Pct.toFixed(2)}% | Top5=${metrics.top5Pct.toFixed(2)}% | Top10=${metrics.top10Pct.toFixed(2)}%
- Gini=${metrics.gini} | HHI=${metrics.hhi} (0-10000)
- Holders com mais de 30% do supply: ${metrics.whales30.length ? metrics.whales30.map((w) => `${anonMode ? "anônimo" : (w.label || w.address)} (${w.pct.toFixed(2)}%)`).join(", ") : "nenhum"}
- Total de transferências: ${metrics.transferCount} (de ${metrics.firstTransfer?.toISOString().slice(0, 10)} a ${metrics.lastTransfer?.toISOString().slice(0, 10)})
- Top 15 holders: ${JSON.stringify(topSummary)}

Dados de mercado (fonte: CoinGecko + DexScreener):
- CoinGecko: ${cgStatus}
- Pares DEX: ${dexSummary}
- Melhor par por liquidez: ${marketData.bestPair ? `${marketData.bestPair.dex} — $${marketData.bestPair.liquidityUsd.toFixed(2)} de liquidez` : "nenhum"}

Produza em português, formato HTML simples (apenas <h3>, <p>, <ul>, <li>, <strong>), sem markdown:
1. <h3>Diagnóstico de Distribuição</h3> — avaliação objetiva da saúde da distribuição.
2. <h3>Riscos de Percepção (fake/low-quality)</h3> — o que pode fazer o token ser sinalizado negativamente (concentração, poucos holders, baixa liquidez, atividade artificial, não listagem no CoinGecko).
3. <h3>Recomendações para o Admin</h3> — ações concretas e priorizadas (distribuição, liquidez em DEX, lock, vesting, transparência, verificação em agregadores, listagem no CoinGecko).
4. <h3>Leitura para Traders/Investidores</h3> — o que um operador deve observar antes de operar CAS.
Seja específico com os números fornecidos.`;

  const FALLBACK_MODELS = [
    "google/gemini-2.5-flash-lite",
    "meta-llama/llama-3.3-70b-instruct:free",
    "google/gemma-3-27b-it:free",
    "deepseek/deepseek-r1:free",
    "meta-llama/llama-3.2-3b-instruct:free",
  ];
  const modelsToTry = [model, ...FALLBACK_MODELS.filter((m) => m !== model)];

  for (const tryModel of modelsToTry) {
    log("INFO", "generateAiAnalysis", "Chamando OpenRouter", { model: tryModel });
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://agenticspace.rapport.tec.br",
          "X-Title": "CAS Distribution Dashboard",
        },
        body: JSON.stringify({
          model: tryModel,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.3,
          max_tokens: 1000,
        }),
      });
      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`HTTP ${res.status}: ${errBody.slice(0, 200)}`);
      }
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const content = data.choices?.[0]?.message?.content?.trim();
      if (!content) throw new Error("Resposta vazia do modelo");
      log("OK", "generateAiAnalysis", "Análise GenAI recebida", { model: tryModel, chars: content.length });
      return content.replace(/```html?|```/g, "");
    } catch (err) {
      log("WARN", "generateAiAnalysis", "Modelo falhou, tentando próximo", {
        model: tryModel,
        error: (err as Error).message,
      });
    }
  }

  log("ERROR", "generateAiAnalysis", "Todos os modelos falharam");
  return `<p><em>Falha ao gerar análise GenAI após tentar ${modelsToTry.length} modelos. Verifique AI_API_KEY e créditos no OpenRouter.</em></p>`;
}

// ── HTML dashboard ────────────────────────────────────────────────────

function fmt(v: number, digits = 2): string {
  return v.toLocaleString("pt-BR", { maximumFractionDigits: digits });
}

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildHtml(metrics: Metrics, tokenAddress: string, aiHtml: string, marketData: MarketData, transfers: TokenTransfer[], signals: ManipulationSignal[], socialSnapshot: SentimentSnapshot | null, periodLabel?: string): string {
  const labels = knownLabels();
  const topN = metrics.holders.slice(0, 20);
  const othersPct = Math.max(0, 100 - topN.reduce((s, h) => s + h.pct, 0));

  const donutLabels = [...topN.map((h) => h.label || shortAddr(h.address)), "Outros"];
  const donutData = [...topN.map((h) => Math.round(h.pct * 100) / 100), Math.round(othersPct * 100) / 100];
  const donutObs = [...topN.map((h) => h.observation || ""), ""];
  const barObs = topN.map((h) => h.observation || "");

  // ── CAS partners from airdrop / distribution CSV ──
  const bestPriceUsd = marketData.bestPair?.priceUsd ?? 0;
  const partners = loadAirdropPartners(DATA_DIR, labels, metrics.holders, bestPriceUsd);

  const totalDistributed = partners.reduce((s, p) => s + p.quantity, 0);
  const totalCurrentHeld = partners.reduce((s, p) => s + p.currentBalance, 0);
  const totalReceivedUsd = partners.reduce((s, p) => s + (p.receivedUsd ?? 0), 0);
  const totalCurrentUsd = partners.reduce((s, p) => s + (p.currentUsd ?? 0), 0);
  const unresolvableCount = partners.filter((p) => !p.isResolvable).length;

  const partnerRows = partners.length
    ? partners
        .map(
          (p) => `<tr${!p.isResolvable ? ' class="alert-row"' : ""}>
      <td>${escapeHtml(p.name)}</td>
      <td>${escapeHtml(p.group || "—")}</td>
      <td>${escapeHtml(p.indication || "—")}</td>
      <td data-sort="${p.dateSort}">${escapeHtml(p.date || "—")}</td>
      <td>${p.isResolvable ? polyScanLink(p.address, shortAddr(p.address)) : `<span title="${escapeHtml(p.rawAddress || "")}">${escapeHtml(p.rawAddress || "—")}</span>`}</td>
      <td data-sort="${p.quantity}">${fmt(p.quantity, 4)} CAS</td>
      <td data-sort="${p.currentBalance}">${fmt(p.currentBalance, 4)} CAS</td>
      <td data-sort="${p.currentPct}">${p.currentPct.toFixed(4)}%</td>
      <td data-sort="${p.receivedUsd ?? -1}">${p.receivedUsd != null ? `$${fmt(p.receivedUsd, 2)}` : "—"}</td>
      <td data-sort="${p.currentUsd ?? -1}">${p.currentUsd != null ? `$${fmt(p.currentUsd, 2)}` : "—"}</td>
      <td>${typeEmoji(p.type)} ${p.type}</td>
      <td style="font-size:.8rem;color:var(--muted);max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(p.observation || "")}">${escapeHtml(p.observation || "—")}</td>
    </tr>`,
        )
        .join("")
    : `<tr><td colspan="12" style="text-align:center;color:#F05F40">Nenhum parceiro/airdrop encontrado nos CSVs de data/</td></tr>`;

  const partnerKpis = `<div class="kpi"><div class="v">${partners.length}</div><div class="l">Parceiros listados</div></div>
  <div class="kpi"><div class="v">${fmt(totalDistributed, 4)}</div><div class="l">Total distribuído (CAS)</div></div>
  <div class="kpi"><div class="v">${fmt(totalCurrentHeld, 4)}</div><div class="l">Saldo retido (CAS)</div></div>
  <div class="kpi"><div class="v">${totalReceivedUsd > 0 ? `$${fmt(totalReceivedUsd, 2)}` : "—"}</div><div class="l">Valor recebido (DEX)</div></div>
  <div class="kpi"><div class="v">${totalCurrentUsd > 0 ? `$${fmt(totalCurrentUsd, 2)}` : "—"}</div><div class="l">Valor retido (DEX)</div></div>
  ${unresolvableCount > 0 ? `<div class="kpi"><div class="v">${unresolvableCount}</div><div class="l">Endereços pendentes</div></div>` : ""}`;

  // ── Multi-asset / bridge / swap / token addresses from CSV/DB ──
  const allLabels = knownLabels();
  const multiAssets = [...allLabels.entries()]
    .filter(([, info]) => info.isContract || /bridge|wrapper|token|swap|dex|lp|faucet/i.test(info.type))
    .sort((a, b) => (a[1].label || a[0]).localeCompare(b[1].label || b[0]));

  const bridgeCount = multiAssets.filter(([, i]) => i.type === "bridge").length;
  const wrapperCount = multiAssets.filter(([, i]) => i.type === "wrapper").length;
  const tokenCount = multiAssets.filter(([, i]) => i.type === "token").length;
  const swapDexCount = multiAssets.filter(([, i]) => ["swap", "dex", "lp"].includes(i.type)).length;

  const multiAssetRows = multiAssets.length
    ? multiAssets
        .map(([addr, info]) => `<tr>
      <td>${polyScanLink(addr, shortAddr(addr))}</td>
      <td>${typeEmoji(info.type)} ${info.type}</td>
      <td>${escapeHtml(info.asset || "—")}</td>
      <td>${escapeHtml(info.label || shortAddr(addr))}</td>
      <td style="font-size:.8rem;color:var(--muted);max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(info.observation || "")}">${escapeHtml(info.observation || "—")}</td>
    </tr>`)
        .join("")
    : `<tr><td colspan="5" style="text-align:center;color:#F05F40">Nenhum endereço de bridge/swap/token catalogado</td></tr>`;

  const multiAssetKpis = `<div class="kpi"><div class="v">${multiAssets.length}</div><div class="l">Endereços multi-moeda</div></div>
  <div class="kpi"><div class="v">${bridgeCount}</div><div class="l">Bridges</div></div>
  <div class="kpi"><div class="v">${wrapperCount}</div><div class="l">Wrappers</div></div>
  <div class="kpi"><div class="v">${tokenCount}</div><div class="l">Tokens catalogados</div></div>
  <div class="kpi"><div class="v">${swapDexCount}</div><div class="l">Swaps/DEX</div></div>`;

  // Lorenz curve
  const sorted = metrics.holders.map((h) => toNum(h.balance)).sort((a, b) => a - b);
  const totalBal = sorted.reduce((s, v) => s + v, 0) || 1;
  const lorenz: { x: number; y: number }[] = [{ x: 0, y: 0 }];
  let cum = 0;
  sorted.forEach((v, i) => {
    cum += v;
    lorenz.push({ x: ((i + 1) / sorted.length) * 100, y: (cum / totalBal) * 100 });
  });

  const typeCell = (type: string) => `${typeEmoji(type)} ${type}`;

  const whaleRows = metrics.whales30.length
    ? metrics.whales30
        .map(
          (w) => `<tr class="alert-row">
        <td>${polyScanLink(w.address, shortAddr(w.address))}</td>
        <td title="${escapeHtml(w.observation || "")}">${escapeHtml(w.label || shortAddr(w.address))}</td>
        <td>${fmt(toNum(w.balance))} CAS</td>
        <td><strong>${w.pct.toFixed(2)}%</strong></td>
        <td>${typeCell(w.type)}</td>
        <td>${escapeHtml(w.asset || "—")}</td>
        <td>${w.isContractLike ? "🏛️ Infraestrutura" : "⚠️ Carteira externa"}</td>
      </tr>`,
        )
        .join("")
    : `<tr><td colspan="7" style="text-align:center;color:#F05F40">✅ Nenhum holder externo acima de 30% do supply</td></tr>`;

  const latestMovements = [...transfers]
    .sort((a, b) => Number(b.timeStamp) - Number(a.timeStamp))
    .slice(0, 50);
  const latestRows = latestMovements
    .map((t) => {
      const from = t.from.toLowerCase();
      const to = t.to.toLowerCase();
      const fromLabel = escapeHtml(labels.get(from)?.label || shortAddr(from));
      const toLabel = escapeHtml(labels.get(to)?.label || shortAddr(to));
      const date = new Date(Number(t.timeStamp) * 1000).toLocaleString("pt-BR", { timeZone: "UTC" });
      return `<tr>
        <td>${date}</td>
        <td data-sort="${Number(t.blockNumber)}">${t.blockNumber}</td>
        <td><a href="https://polygonscan.com/tx/${t.hash}" target="_blank" data-full-address="${t.hash}"><code>${shortAddr(t.hash)}</code></a></td>
        <td>${polyScanLink(from, shortAddr(from))}</td>
        <td>${polyScanLink(to, shortAddr(to))}</td>
        <td data-sort="${toNum(BigInt(t.value))}">${fmt(toNum(BigInt(t.value)))} CAS</td>
        <td>${fromLabel}</td>
        <td>${toLabel}</td>
      </tr>`;
    })
    .join("");

  const holderRows = topN
    .map(
      (h, i) => `<tr${h.pct > 30 ? ' class="alert-row"' : ""}>
      <td data-sort="${i + 1}">${i + 1}</td>
      <td>${polyScanLink(h.address, shortAddr(h.address))}</td>
      <td title="${escapeHtml(h.observation || "")}">${escapeHtml(h.label || shortAddr(h.address))}</td>
      <td data-sort="${toNum(h.balance)}">${fmt(toNum(h.balance))} CAS</td>
      <td data-sort="${h.pct}">${h.pct.toFixed(4)}%</td>
      <td>${typeCell(h.type)}</td>
      <td>${escapeHtml(h.asset || "—")}</td>
      <td style="font-size:.8rem;color:var(--muted);max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(h.observation || "")}">${escapeHtml(h.observation || "—")}</td>
    </tr>`,
    )
    .join("");

  const riskLevel =
    metrics.whales30.filter((w) => !w.isContractLike).length > 0
      ? { label: "ALTO", color: "#eb3812" }
      : metrics.top10Pct > 90
        ? { label: "MODERADO", color: "#fcc650" }
        : { label: "CONTROLADO", color: "#F05F40" };

  // ── Market data rendering ──
  const cgBadge = marketData.coingeckoListed
    ? `<span class="badge" style="background:#F05F4022;color:#F05F40">✅ CoinGecko</span>`
    : `<span class="badge" style="background:#fcc65022;color:#cc7501">⚠️ Não listado no CoinGecko</span>`;

  const totalDexLiquidity = marketData.dexPairs.reduce((s, p) => s + p.liquidityUsd, 0);
  const totalDexVolume = marketData.dexPairs.reduce((s, p) => s + p.volume24h, 0);
  const bestPrice = marketData.bestPair?.priceUsd ?? null;

  const marketKpis = marketData.coingeckoListed
    ? `<div class="kpi"><div class="v">$${marketData.coingeckoPriceUsd?.toFixed(8) ?? "—"}</div><div class="l">Preço CoinGecko (USD)</div></div>
  <div class="kpi"><div class="v">$${marketData.coingeckoMarketCap != null ? fmt(marketData.coingeckoMarketCap, 0) : "—"}</div><div class="l">Market Cap (CoinGecko)</div></div>
  <div class="kpi"><div class="v">$${marketData.coingeckoVolume24h != null ? fmt(marketData.coingeckoVolume24h, 0) : "—"}</div><div class="l">Volume 24h (CoinGecko)</div></div>`
    : `<div class="kpi"><div class="v">—</div><div class="l">CoinGecko: não listado</div></div>`;

  const dexKpis = marketData.bestPair
    ? `<div class="kpi"><div class="v">$${bestPrice!.toExponential(2)}</div><div class="l">Preço <span class="term-tip" data-tip="Decentralized Exchange — exchange descentralizada onde tokens são negociados via pools de liquidez (AMM) sem intermediário. Liquidez em DEX é sinal de saúde do token.">DEX</span> (USD)</div></div>
  <div class="kpi"><div class="v">$${fmt(totalDexLiquidity, 2)}</div><div class="l">Liquidez total <span class="term-tip" data-tip="Decentralized Exchange — exchange descentralizada onde tokens são negociados via pools de liquidez (AMM) sem intermediário. Liquidez em DEX é sinal de saúde do token.">DEX</span> (USD)</div></div>
  <div class="kpi"><div class="v">$${fmt(totalDexVolume, 2)}</div><div class="l">Volume 24h <span class="term-tip" data-tip="Decentralized Exchange — exchange descentralizada onde tokens são negociados via pools de liquidez (AMM) sem intermediário. Liquidez em DEX é sinal de saúde do token.">DEX</span> (USD)</div></div>
  <div class="kpi"><div class="v">${marketData.dexPairs.length}</div><div class="l">Pares <span class="term-tip" data-tip="Decentralized Exchange — exchange descentralizada onde tokens são negociados via pools de liquidez (AMM) sem intermediário. Liquidez em DEX é sinal de saúde do token.">DEX</span> ativos</div></div>`
    : `<div class="kpi"><div class="v">—</div><div class="l"><span class="term-tip" data-tip="Decentralized Exchange — exchange descentralizada onde tokens são negociados via pools de liquidez (AMM) sem intermediário. Liquidez em DEX é sinal de saúde do token.">DEX</span>: sem pares encontrados</div></div>`;

  const dexRows = marketData.dexPairs.length
    ? marketData.dexPairs
        .sort((a, b) => b.liquidityUsd - a.liquidityUsd)
        .map((p) => `<tr>
      <td><a href="${p.url}" target="_blank">${p.dex}</a></td>
      <td>${p.quoteSymbol}</td>
      <td>$${p.priceUsd.toExponential(2)}</td>
      <td>$${fmt(p.liquidityUsd, 2)}</td>
      <td>$${fmt(p.volume24h, 2)}</td>
      <td>${p.txns24h.buys} / ${p.txns24h.sells}</td>
      <td>$${p.fdv > 0 ? fmt(p.fdv, 0) : "—"}</td>
    </tr>`)
        .join("")
    : `<tr><td colspan=\"7\" style=\"text-align:center;color:#712d23\">Nenhum par DEX encontrado no DexScreener</td></tr>`;

  // ── Transfer graph data (for vis.js network) ──
  const holderBalanceMap = new Map<string, { balance: bigint; pct: number }>();
  for (const h of metrics.holders) {
    holderBalanceMap.set(h.address, { balance: h.balance, pct: h.pct });
  }
  const nodeStats = new Map<string, { sent: number; received: number; volume: number }>();
  const edgeMap = new Map<string, { count: number; volume: number }>();

  for (const t of transfers) {
    const from = t.from.toLowerCase();
    const to = t.to.toLowerCase();
    const value = toNum(BigInt(t.value));

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

  const graphNodes = [...nodeStats.entries()]
    .filter(([addr]) => addr !== ZERO)
    .map(([addr, stat]) => {
      const known = labels.get(addr);
      const totalTxn = stat.sent + stat.received;
      const isInfra = known?.isInfra ?? false;
      const isContract = known?.isContract ?? isInfra;
      const type = known?.type ?? "unknown";
      const asset = known?.asset ?? "";
      const isDeployer = addr === (process.env.DEPLOYER_ADDRESS?.toLowerCase() ?? "");
      const label = known?.label || shortAddr(addr);
      const holderInfo = holderBalanceMap.get(addr);
      const holderBalance = holderInfo ? toNum(holderInfo.balance) : 0;
      const holderPct = holderInfo ? holderInfo.pct : 0;
      // Node size ∝ CAS balance held
      const size = 10 + Math.round((holderBalance / maxHolderBalance) * 50);
      // Border width ∝ transaction count
      const borderWidth = 1 + Math.round((totalTxn / maxTxnCount) * 6);
      // Border color ∝ transaction count tiers
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
      // Background color by identity classification
      let bgColor: string;
      if (isDeployer) {
        bgColor = "#fcc650";
      } else if (isInfra) {
        bgColor = "#b5651d";
      } else {
        bgColor = "#712d23";
      }
      const holderObs = metrics.holders.find((h) => h.address === addr)?.observation || "";
      const obsText = known?.observation || holderObs;
      const obsHtml = obsText ? `<br><em style="color:#f7d4ca;">${obsText}</em>` : "";
      const typeHtml = type !== "unknown" ? `<br>${typeEmoji(type)} Tipo: ${type}` : "";
      const assetHtml = asset ? `<br>💰 Moeda: ${asset}` : "";
      const tooltip = `<b>${label}</b><br>${polyScanLink(addr, addr)}<br>Saldo: ${fmt(holderBalance, 2)} CAS (${holderPct.toFixed(2)}%)${typeHtml}${assetHtml}<br>Enviadas: ${stat.sent} | Recebidas: ${stat.received}<br>Volume: ${fmt(stat.volume, 2)} CAS${obsHtml}`;
      return { id: addr, label, title: tooltip, size, color: bgColor, borderColor, borderWidth, totalTxn, holderBalance, isContract, type, asset, icon: typeEmoji(type), shape: nodeShape(type) };
    });

  const graphEdges = [...edgeMap.entries()]
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
      const tooltip = `<b>${edge.count} transferências</b><br>De: ${polyScanLink(from, shortAddr(from))}<br>Para: ${polyScanLink(to, shortAddr(to))}<br>Volume: ${fmt(edge.volume, 2)} CAS`;
      const volumeLabel = `${fmt(edge.volume, 2)} CAS`;
      return { from, to, value: edge.count, title: tooltip, width, color: edgeColor, highlight: edgeHighlight, volumeLabel };
    });

  const graphDataJson = JSON.stringify({ nodes: graphNodes, edges: graphEdges });

  // ── OHLC candlestick data (3 intervals: 30min, 8h, daily) ──
  const refPriceUsd = marketData.bestPair?.priceUsd ?? 0;

  const buildCandleData = (
    candleMinutes: number,
    bucketMinutes: number,
    labelFmt: (ts: number) => string,
  ): {
    label: string;
    open: number;
    high: number;
    low: number;
    close: number;
    totalVolume: number;
    volumeUsd: number;
    txCount: number;
  }[] => {
    const candleMap = new Map<number, Map<number, number>>();
    const candleTxCount = new Map<number, number>();
    for (const t of transfers) {
      const ts = Number(t.timeStamp);
      const candleStart = Math.floor(ts / (candleMinutes * 60)) * (candleMinutes * 60);
      const bucketStart = Math.floor(ts / (bucketMinutes * 60)) * (bucketMinutes * 60);
      const value = toNum(BigInt(t.value));
      if (!candleMap.has(candleStart)) candleMap.set(candleStart, new Map());
      const buckets = candleMap.get(candleStart)!;
      buckets.set(bucketStart, (buckets.get(bucketStart) ?? 0) + value);
      candleTxCount.set(candleStart, (candleTxCount.get(candleStart) ?? 0) + 1);
    }
    return [...candleMap.entries()]
      .sort(([a], [b]) => a - b)
      .map(([candleStart, buckets]) => {
        const sorted = [...buckets.entries()].sort(([a], [b]) => a - b);
        const vols = sorted.map(([, v]) => v);
        const totalVolume = Math.round(vols.reduce((s, v) => s + v, 0) * 100) / 100;
        return {
          label: labelFmt(candleStart),
          open: Math.round(vols[0] * 100) / 100,
          high: Math.round(Math.max(...vols) * 100) / 100,
          low: Math.round(Math.min(...vols) * 100) / 100,
          close: Math.round(vols[vols.length - 1] * 100) / 100,
          totalVolume,
          volumeUsd: Math.round(totalVolume * refPriceUsd * 100) / 100,
          txCount: candleTxCount.get(candleStart) ?? 0,
        };
      });
  };

  const candle30m = buildCandleData(30, 5, (ts) => {
    return new Date(ts * 1000).toISOString().slice(0, 16).replace("T", " ");
  });
  const candle8h = buildCandleData(480, 60, (ts) => {
    return new Date(ts * 1000).toISOString().slice(0, 13).replace("T", " ") + ":00";
  });
  const candleDaily = buildCandleData(1440, 60, (ts) => {
    return new Date(ts * 1000).toISOString().slice(0, 10);
  });

  // ── Candlestick KPIs ──
  const allCandles = [...candle30m, ...candle8h, ...candleDaily];
  const maxCandleUsd = allCandles.length ? Math.max(...allCandles.map((c) => c.volumeUsd)) : 0;
  const minCandleUsd = allCandles.length ? Math.min(...allCandles.map((c) => c.volumeUsd)) : 0;
  const totalCandleUsd = allCandles.reduce((s, c) => s + c.volumeUsd, 0);
  const totalCandleTx = allCandles.reduce((s, c) => s + c.txCount, 0);

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CAS — Painel de Distribuição 3D</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
${GRAPH_3D_CDN}
<style>
  :root { --bg:#222222; --card:#712d23; --border:rgba(255,255,255,0.15); --text:#ffffff; --muted:#f7d4ca; --accent:#F05F40; --blue:#fcc650; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { background:var(--bg); color:var(--text); font-family:'Segoe UI',system-ui,sans-serif; padding:24px; }
  h1 { font-size:1.6rem; margin-bottom:4px; }
  h2 { font-size:1.15rem; margin:24px 0 12px; color:var(--accent); }
  h3 { color:var(--blue); margin:16px 0 8px; }
  p, li { line-height:1.6; color:var(--text); }
  ul { padding-left:24px; margin-bottom:12px; }
  .sub { color:var(--muted); font-size:.9rem; margin-bottom:20px; }
  .sub a { color:var(--blue); }
  .kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:12px; margin-bottom:24px; }
  .kpi { background:var(--card); border:1px solid var(--border); border-radius:12px; padding:16px; }
  .kpi .v { font-size:1.4rem; font-weight:700; }
  .kpi .l { color:var(--muted); font-size:.8rem; margin-top:4px; }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
  @media (max-width:900px){ .grid { grid-template-columns:1fr; } }
  .card { background:var(--card); border:1px solid var(--border); border-radius:12px; padding:20px; }
  .card.full { grid-column:1/-1; }
  table { width:100%; border-collapse:collapse; font-size:.85rem; }
  th, td { padding:8px 10px; text-align:left; border-bottom:1px solid var(--border); }
  th { color:var(--muted); font-weight:600; }
  .sortable th { cursor:pointer; user-select:none; }
  .sortable th:hover { color:var(--text); }
  td a { color:var(--blue); text-decoration:none; }
  .alert-row { background:rgba(235,56,18,.12); }
  .badge { display:inline-block; padding:4px 12px; border-radius:999px; font-weight:700; font-size:.85rem; }
  canvas { max-height:340px; }
  #network-graph canvas { max-height:none; }
  #tab-candlestick canvas { max-height:420px; }
  footer { margin-top:32px; color:var(--muted); font-size:.8rem; text-align:center; }
  .tabs-bar { display:flex; flex-wrap:wrap; gap:4px; border-bottom:2px solid var(--border); margin-bottom:20px; }
  .tab-btn { background:transparent; border:none; border-bottom:3px solid transparent; color:var(--muted); padding:10px 18px; cursor:pointer; font-size:.95rem; font-weight:600; transition:all .2s; border-radius:8px 8px 0 0; }
  .tab-btn:hover { color:var(--text); background:rgba(255,255,255,.05); }
  .tab-btn.active { color:var(--accent); border-bottom-color:var(--accent); background:rgba(240,95,64,.08); }
  .tab-panel { display:none; }
  .tab-panel.active { display:block; }
  .print-btn { position:fixed; top:20px; right:20px; z-index:1000; background:var(--accent); color:#ffffff; border:none; border-radius:10px; padding:10px 20px; font-size:.9rem; font-weight:700; cursor:pointer; box-shadow:0 4px 12px rgba(240,95,64,.3); }
  .print-btn:hover { transform:translateY(-2px); }
  .term-tip { cursor:help; border-bottom:1px dashed var(--blue); position:relative; display:inline-block; }
  .term-tip::after { content:attr(data-tip); position:absolute; bottom:calc(100% + 8px); left:50%; transform:translateX(-50%); background:var(--card); color:var(--text); border:1px solid var(--border); border-radius:8px; padding:10px 14px; font-size:.8rem; line-height:1.5; min-width:220px; max-width:320px; white-space:normal; text-align:left; box-shadow:0 6px 20px rgba(0,0,0,.4); opacity:0; pointer-events:none; transition:opacity .2s; z-index:100; }
  .term-tip::before { content:""; position:absolute; bottom:calc(100% + 2px); left:50%; transform:translateX(-50%); border:6px solid transparent; border-top-color:var(--card); opacity:0; transition:opacity .2s; z-index:100; }
  .term-tip:hover::after, .term-tip:hover::before, .term-tip.is-open::after, .term-tip.is-open::before { opacity:1; }
  .print-overlay { display:none; position:fixed; inset:0; background:rgba(0,0,0,.7); z-index:2000; justify-content:center; align-items:center; }
  .print-overlay.show { display:flex; }
  .print-modal { background:var(--card); border:1px solid var(--border); border-radius:16px; padding:28px; max-width:480px; width:90%; }
  .print-modal h3 { margin-bottom:16px; }
  .print-modal label { display:flex; align-items:center; gap:10px; padding:8px 0; cursor:pointer; font-size:.95rem; }
  .print-modal label input { width:18px; height:18px; accent-color:var(--accent); }
  .print-modal-actions { display:flex; gap:12px; margin-top:20px; justify-content:flex-end; }
  .print-modal-actions button { border:none; border-radius:8px; padding:10px 20px; font-weight:600; cursor:pointer; font-size:.9rem; }
  .btn-print { background:var(--accent); color:#ffffff; }
  .btn-cancel { background:var(--border); color:var(--text); }
  #tab-graph .card.full { display:flex; flex-direction:column; min-height:calc(100vh - 280px); }
  .graph-legend { display:flex; gap:20px; margin-top:12px; flex-wrap:wrap; font-size:.85rem; color:var(--muted); }
  .graph-legend span { display:flex; align-items:center; gap:6px; }
  .graph-legend .dot { width:12px; height:12px; border-radius:50%; display:inline-block; }
  ${GRAPH_3D_CSS}
  .graph-search-bar { display:flex; gap:8px; align-items:center; margin-bottom:12px; }
  .graph-search-bar input { flex:1; padding:8px 14px; border-radius:8px; border:1px solid var(--border); background:rgba(255,255,255,0.05); color:var(--text); font-size:.9rem; outline:none; }
  .graph-search-bar input:focus { border-color:var(--primary); box-shadow:0 0 0 2px rgba(240,95,64,0.2); }
  .graph-search-bar input::placeholder { color:var(--muted); }
  .graph-search-bar button { padding:6px 14px; border-radius:8px; border:1px solid var(--border); background:var(--accent); color:#fff; cursor:pointer; font-size:.85rem; white-space:nowrap; }
  .graph-search-bar button:hover { background:var(--primary); }
  .graph-search-result { font-size:.8rem; color:var(--muted); margin-left:4px; white-space:nowrap; }
  @media print {
    body { background:#fff !important; color:#222222 !important; padding:12px !important; -webkit-print-color-adjust:exact !important; print-color-adjust:exact !important; }
    .print-btn, .tabs-bar, .print-overlay { display:none !important; }
    .tab-panel { display:block !important; page-break-after:always; }
    .tab-panel:last-child { page-break-after:auto; }
    .card { background:#f7d4ca !important; border:1px solid rgba(34,34,34,0.15) !important; -webkit-print-color-adjust:exact !important; print-color-adjust:exact !important; }
    .kpi { background:#f7d4ca !important; border:1px solid rgba(34,34,34,0.15) !important; -webkit-print-color-adjust:exact !important; print-color-adjust:exact !important; }
    .kpi .v { color:#222222 !important; }
    .kpi .l { color:#712d23 !important; }
    h1, h2, h3 { color:#222222 !important; }
    h2 { color:#F05F40 !important; }
    h3 { color:#cc7501 !important; }
    .sub { color:#712d23 !important; }
    .sub a { color:#cc7501 !important; }
    th { color:#712d23 !important; }
    td { color:#222222 !important; }
    td a { color:#cc7501 !important; }
    .alert-row { background:rgba(235,56,18,.08) !important; -webkit-print-color-adjust:exact !important; print-color-adjust:exact !important; }
    .badge { -webkit-print-color-adjust:exact !important; print-color-adjust:exact !important; }
    table { border-color:rgba(34,34,34,0.15) !important; }
    th, td { border-bottom:1px solid rgba(34,34,34,0.15) !important; }
    .grid { grid-template-columns:1fr 1fr !important; }
    canvas { max-height:280px !important; }
    #network-graph { height:500px !important; border:1px solid rgba(34,34,34,0.15) !important; }
    footer { color:#712d23 !important; }
  }
</style>
</head>
<body>

<button class="print-btn" onclick="openPrintModal()">🖨️ Imprimir / PDF</button>

<h1>🪙 CAS — Painel de Distribuição &amp; Qualidade</h1>
<p class="sub">
  Token: <a href="https://polygonscan.com/token/${tokenAddress}" target="_blank">${tokenAddress}</a> · Polygon Mainnet (137) ·
  Gerado em ${new Date().toLocaleString("pt-BR")} · Fonte: Polygonscan${periodLabel ? ` · Período: ${periodLabel}` : ""} ·
  Risco de concentração: <span class="badge" style="background:${riskLevel.color}22;color:${riskLevel.color}">${riskLevel.label}</span> · ${cgBadge}
</p>

<div class="tabs-bar">
  <button class="tab-btn active" onclick="switchTab(event,'tab-overview')">📋 Visão Geral</button>
  <button class="tab-btn" onclick="switchTab(event,'tab-market')">💰 Mercado</button>
  <button class="tab-btn" onclick="switchTab(event,'tab-concentration')">🚨 Concentração</button>
  <button class="tab-btn" onclick="switchTab(event,'tab-charts')">📊 Gráficos</button>
  <button class="tab-btn" onclick="switchTab(event,'tab-candlestick')">🕯️ Candlesticks</button>
  <button class="tab-btn" onclick="switchTab(event,'tab-holders')">🏆 Holders</button>
  <button class="tab-btn" onclick="switchTab(event,'tab-partners')">🤝 Parceiros</button>
  <button class="tab-btn" onclick="switchTab(event,'tab-multiasset')">🌉 Multi-Ativo</button>
  <button class="tab-btn" onclick="switchTab(event,'tab-graph')">🔗 Grafo 3D de Transferências</button>
  <button class="tab-btn" onclick="switchTab(event,'tab-manipulation')">🚨 Manipulação</button>
  <button class="tab-btn" onclick="switchTab(event,'tab-ai')">🤖 Análise IA</button>
</div>

<div id="tab-overview" class="tab-panel active">
  <div class="kpis">
    <div class="kpi"><div class="v">${fmt(toNum(metrics.totalSupply), 0)}</div><div class="l">Supply Total (CAS)</div></div>
    <div class="kpi"><div class="v">${metrics.holderCount}</div><div class="l">Holders (saldo &gt; 0)</div></div>
    <div class="kpi"><div class="v">${fmt(toNum(metrics.circulating), 0)} <small>(${metrics.circulatingPct}%)</small></div><div class="l"><span class="term-tip" data-tip="Supply circulante fora de contratos de infraestrutura e DEX. Indica quanto do token está efetivamente disponível para negociação.">Circulante</span> fora de infra/DEX</div></div>
    <div class="kpi"><div class="v">${metrics.top1Pct.toFixed(2)}%</div><div class="l">Top 1 holder</div></div>
    <div class="kpi"><div class="v">${metrics.top10Pct.toFixed(2)}%</div><div class="l">Top 10 holders</div></div>
    <div class="kpi"><div class="v">${metrics.gini}</div><div class="l">Índice de <span class="term-tip" data-tip="Índice de Gini — mede a desigualdade de distribuição de 0 (igualdade perfeita) a 1 (concentração máxima). Quanto mais próximo de 1, maior o risco do token ser percebido como controlado por poucos.">Gini</span></div></div>
    <div class="kpi"><div class="v">${fmt(metrics.hhi, 0)}</div><div class="l"><span class="term-tip" data-tip="Herfindahl-Hirschman Index — soma dos quadrados das participações percentuais (0–10000). Abaixo de 1500 = competitivo; acima de 2500 = altamente concentrado. Usado por reguladores para avaliar monopólio.">HHI</span> (0–10000)</div></div>
    <div class="kpi"><div class="v">${metrics.transferCount}</div><div class="l">Transferências totais</div></div>
  </div>
  <div class="card full">
    <h3>Resumo Executivo</h3>
    <p><strong>Supply total:</strong> ${fmt(toNum(metrics.totalSupply), 0)} CAS · <strong>Holders ativos:</strong> ${metrics.holderCount} · <strong>Transferências:</strong> ${metrics.transferCount}</p>
    <p style="margin-top:8px"><strong>Concentração:</strong> Top 1 = ${metrics.top1Pct.toFixed(2)}% · Top 10 = ${metrics.top10Pct.toFixed(2)}% · <span class="term-tip" data-tip="Índice de Gini — mede a desigualdade de distribuição de 0 (igualdade perfeita) a 1 (concentração máxima). Quanto mais próximo de 1, maior o risco do token ser percebido como controlado por poucos.">Gini</span> = ${metrics.gini} · <span class="term-tip" data-tip="Herfindahl-Hirschman Index — soma dos quadrados das participações percentuais (0–10000). Abaixo de 1500 = competitivo; acima de 2500 = altamente concentrado. Usado por reguladores para avaliar monopólio.">HHI</span> = ${fmt(metrics.hhi, 0)}</p>
    <p style="margin-top:8px"><strong><span class="term-tip" data-tip="Supply circulante fora de contratos de infraestrutura e DEX. Indica quanto do token está efetivamente disponível para negociação.">Circulante</span> (fora de infra/DEX):</strong> ${fmt(toNum(metrics.circulating), 0)} CAS (${metrics.circulatingPct}%)</p>
    <p style="margin-top:8px"><strong>Ecossistema multi-moeda:</strong> ${multiAssets.length} endereços catalogados (bridges, wrappers, swaps, tokens) · Veja a aba 🌉 Multi-Ativo para detalhes.</p>
    <p style="margin-top:8px"><strong>Risco de concentração:</strong> <span class="badge" style="background:${riskLevel.color}22;color:${riskLevel.color}">${riskLevel.label}</span></p>
  </div>
</div>

<div id="tab-market" class="tab-panel">
  <h2>💰 Dados de Mercado</h2>
  <div class="kpis">
    ${marketKpis}
    ${dexKpis}
  </div>
  <div class="card full">
    <table>
      <thead><tr><th><span class="term-tip" data-tip="Decentralized Exchange — exchange descentralizada onde tokens são negociados via pools de liquidez (AMM) sem intermediário. Liquidez em DEX é sinal de saúde do token.">DEX</span></th><th>Quote</th><th>Preço (USD)</th><th>Liquidez (USD)</th><th>Volume 24h (USD)</th><th>Txns 24h (B/S)</th><th><span class="term-tip" data-tip="Fully Diluted Valuation — valor de mercado se todo o supply estivesse em circulação ao preço atual. Diferente do market cap, considera o supply máximo.">FDV</span> (USD)</th></tr></thead>
      <tbody>${dexRows}</tbody>
    </table>
  </div>
</div>

<div id="tab-concentration" class="tab-panel">
  <h2>🚨 <span class="term-tip" data-tip="Whale — holder que possui mais de 30% do supply total. Carteiras externas (não-infra) nesse nível representam risco alto de manipulação de preço.">Whales</span> acima de 30% do supply</h2>
  <div class="card full">
    <table>
      <thead><tr><th>Endereço</th><th>Rótulo</th><th>Saldo</th><th>% Supply</th><th>Tipo</th><th>Moeda</th><th>Classificação</th></tr></thead>
      <tbody>${whaleRows}</tbody>
    </table>
  </div>
  <div class="card full" style="margin-top:16px">
    <h3>Métricas de Concentração</h3>
    <p><strong><span class="term-tip" data-tip="Índice de Gini — mede a desigualdade de distribuição de 0 (igualdade perfeita) a 1 (concentração máxima). Quanto mais próximo de 1, maior o risco do token ser percebido como controlado por poucos.">Gini</span>:</strong> ${metrics.gini} (0 = igualdade perfeita, 1 = concentração máxima)</p>
    <p style="margin-top:6px"><strong><span class="term-tip" data-tip="Herfindahl-Hirschman Index — soma dos quadrados das participações percentuais (0–10000). Abaixo de 1500 = competitivo; acima de 2500 = altamente concentrado. Usado por reguladores para avaliar monopólio.">HHI</span>:</strong> ${fmt(metrics.hhi, 0)} (0–10000; &lt;1500 = competitivo, &gt;2500 = altamente concentrado)</p>
    <p style="margin-top:6px"><strong>Top 1:</strong> ${metrics.top1Pct.toFixed(2)}% · <strong>Top 5:</strong> ${metrics.top5Pct.toFixed(2)}% · <strong>Top 10:</strong> ${metrics.top10Pct.toFixed(2)}%</p>
  </div>
</div>

<div id="tab-charts" class="tab-panel">
  <h2>📊 Gráficos de Distribuição</h2>
  <div class="grid">
    <div class="card"><h3>Distribuição do Supply (Top 20 + Outros)</h3><canvas id="donut"></canvas></div>
    <div class="card"><h3>Top 20 Holders (% do supply)</h3><canvas id="bars"></canvas></div>
    <div class="card"><h3>Curva de <span class="term-tip" data-tip="Curva de Lorenz — visualiza a distribuição acumulada de riqueza. A distância entre a curva e a linha diagonal de igualdade perfeita indica o nível de concentração. Quanto maior a área entre as duas, maior a desigualdade.">Lorenz</span> (concentração)</h3><canvas id="lorenz"></canvas></div>
    <div class="card"><h3>Atividade Diária (transferências e volume)</h3><canvas id="activity"></canvas></div>
  </div>
</div>

<div id="tab-candlestick" class="tab-panel">
  <h2>🕯️ Evolução do CAS — Preço &amp; Volume (Candlestick Combinado)</h2>
  <p class="sub">Gráfico combinado: <strong>candlestick</strong> (valorização/desvalorização do volume CAS) + <strong>barras de volume USD</strong> (valor movimentado por período) · Preço ref: ${refPriceUsd > 0 ? `$${refPriceUsd.toExponential(2)} (DexScreener)` : "indisponível (sem par DEX)"}</p>
  <div class="kpis">
    <div class="kpi"><div class="v">$${refPriceUsd > 0 ? refPriceUsd.toExponential(2) : "—"}</div><div class="l">Preço ref. <span class="term-tip" data-tip="DEX — Decentralized Exchange. Preço de referência obtido do DexScreener (melhor par por liquidez).">DEX</span> (USD)</div></div>
    <div class="kpi"><div class="v">$${fmt(totalCandleUsd, 2)}</div><div class="l">Volume total estimado (USD)</div></div>
    <div class="kpi"><div class="v">$${fmt(maxCandleUsd, 2)}</div><div class="l">Maior candle (USD)</div></div>
    <div class="kpi"><div class="v">$${fmt(minCandleUsd, 2)}</div><div class="l">Menor candle (USD)</div></div>
    <div class="kpi"><div class="v">${totalCandleTx}</div><div class="l">Transações nos candles</div></div>
  </div>
  <div class="card full">
    <h3>Volume a cada 30 minutos — OHLC + Volume USD</h3>
    <p class="sub" style="margin-bottom:12px">Cada candle = 30 min · sub-buckets de 5 min: <span class="term-tip" data-tip="OHLC — Open-High-Low-Close. Open = volume do primeiro bucket de 5 min ativo, High = maior bucket, Low = menor bucket, Close = último bucket ativo.">OHLC</span> · Laranja (C ≥ O = valorização) · Vermelho-escuro (C < O = desvalorização) · Barras inferiores = volume USD estimado.</p>
    <canvas id="candle30m"></canvas>
  </div>
  <div class="card full" style="margin-top:16px">
    <h3>Volume 3x ao dia (8 em 8h) — OHLC + Volume USD</h3>
    <p class="sub" style="margin-bottom:12px">Cada candle = 8 horas · sub-buckets de 1h: <span class="term-tip" data-tip="OHLC — Open-High-Low-Close. Open = volume da primeira hora ativa, High = maior hora, Low = menor hora, Close = última hora ativa.">OHLC</span> · Laranja (C ≥ O) · Vermelho-escuro (C < O) · Barras inferiores = volume USD estimado.</p>
    <canvas id="candle8h"></canvas>
  </div>
  <div class="card full" style="margin-top:16px">
    <h3>Volume Diário — OHLC + Volume USD</h3>
    <p class="sub" style="margin-bottom:12px">Cada candle = 1 dia · sub-buckets de 1h: <span class="term-tip" data-tip="OHLC — Open-High-Low-Close. Open = volume da primeira hora ativa, High = maior volume horário, Low = menor volume horário, Close = volume da última hora ativa.">OHLC</span> · Laranja (C ≥ O) · Vermelho-escuro (C < O) · Barras inferiores = volume USD estimado.</p>
    <canvas id="candleDaily"></canvas>
  </div>
</div>

<div id="tab-holders" class="tab-panel">
  <h2>🏆 Top 20 Holders</h2>
  <div class="card full">
    <table id="holders-table" class="sortable">
      <thead><tr><th onclick="sortTable('holders-table', 0, 'number')">#</th><th onclick="sortTable('holders-table', 1, 'string')">Endereço</th><th onclick="sortTable('holders-table', 2, 'string')">Rótulo</th><th onclick="sortTable('holders-table', 3, 'number')">Saldo</th><th onclick="sortTable('holders-table', 4, 'number')">% Supply</th><th onclick="sortTable('holders-table', 5, 'string')">Tipo</th><th onclick="sortTable('holders-table', 6, 'string')">Moeda</th><th onclick="sortTable('holders-table', 7, 'string')">Observação</th></tr></thead>
      <tbody>${holderRows}</tbody>
    </table>
  </div>
  <h2 style="margin-top:28px">🔄 Últimas Movimentações (Traders)</h2>
  <div class="card full">
    <table id="latest-movements-table" class="sortable">
      <thead><tr><th onclick="sortTable('latest-movements-table', 0, 'date')">Data/Hora (UTC)</th><th onclick="sortTable('latest-movements-table', 1, 'number')">Bloco</th><th onclick="sortTable('latest-movements-table', 2, 'string')">Tx</th><th onclick="sortTable('latest-movements-table', 3, 'string')">De</th><th onclick="sortTable('latest-movements-table', 4, 'string')">Para</th><th onclick="sortTable('latest-movements-table', 5, 'number')">Valor (CAS)</th><th onclick="sortTable('latest-movements-table', 6, 'string')">De Rótulo</th><th onclick="sortTable('latest-movements-table', 7, 'string')">Para Rótulo</th></tr></thead>
      <tbody>${latestRows}</tbody>
    </table>
  </div>
</div>

<div id="tab-partners" class="tab-panel">
  <h2>🤝 Parceiros do CAS</h2>
  <p class="sub">Parceiros que receberam moedas via airdrop/distribuição. Valores em USD calculados com o preço do melhor par <span class="term-tip" data-tip="DEX — Decentralized Exchange. Preço de referência do par com maior liquidez no DexScreener.">DEX</span>.</p>
  <div class="kpis">
    ${partnerKpis}
  </div>
  <div class="card full">
    <table id="partners-table" class="sortable">
      <thead><tr><th onclick="sortTable('partners-table', 0, 'string')">Parceiro</th><th onclick="sortTable('partners-table', 1, 'string')">Grupo</th><th onclick="sortTable('partners-table', 2, 'string')">Indicação</th><th onclick="sortTable('partners-table', 3, 'number')">Data/Hora</th><th onclick="sortTable('partners-table', 4, 'string')">Endereço</th><th onclick="sortTable('partners-table', 5, 'number')">Qtd. recebida</th><th onclick="sortTable('partners-table', 6, 'number')">Saldo atual</th><th onclick="sortTable('partners-table', 7, 'number')">% supply</th><th onclick="sortTable('partners-table', 8, 'number')">Valor recebido</th><th onclick="sortTable('partners-table', 9, 'number')">Valor atual</th><th onclick="sortTable('partners-table', 10, 'string')">Tipo</th><th onclick="sortTable('partners-table', 11, 'string')">Observação</th></tr></thead>
      <tbody>${partnerRows}</tbody>
    </table>
  </div>
</div>

<div id="tab-multiasset" class="tab-panel">
  <h2>🌉 Multi-Ativo &amp; Pontes</h2>
  <p class="sub">Endereços catalogados de outros tokens, bridges, wrappers e swaps/DEX. A moeda predominante vem da coluna <em>Moeda/Asset</em> dos CSVs.</p>
  <div class="kpis">
    ${multiAssetKpis}
  </div>
  <div class="card full">
    <table>
      <thead><tr><th>Endereço</th><th>Tipo</th><th>Moeda</th><th>Rótulo</th><th>Observação</th></tr></thead>
      <tbody>${multiAssetRows}</tbody>
    </table>
  </div>
</div>

<div id="tab-graph" class="tab-panel">
  <h2>🔗 Grafo 3D de Transferências</h2>
  <p class="sub">Nós = endereços · Arestas = transferências · Tamanho do nó ∝ saldo CAS · Borda ∝ nº de transações (largura e cor) · Controles 3D: arraste para rotacionar, scroll para zoom, clique direito para pan</p>
  <div class="card full">
    <div class="graph-search-bar">
      <input type="text" id="graph-search-input" placeholder="Buscar por label ou endereço..." autocomplete="off" onkeydown="if(event.key==='Enter')searchGraph()" />
      <button id="graph-search-btn" onclick="searchGraph()">🔍 Buscar</button>
      <button id="graph-search-clear" onclick="clearGraphSearch()">✕ Limpar</button>
      <span id="graph-search-result" class="graph-search-result"></span>
    </div>
    <div id="network-graph"></div>
    <div class="graph-legend">
      <span><span class="dot" style="background:#fcc650"></span> Deployer/Admin</span>
      <span><span class="dot" style="background:#b5651d"></span> Infra/DEX/Bridge</span>
      <span><span class="dot" style="background:#712d23"></span> Carteira externa</span>
      <span>⭐ Contrato/Token/Bridge (icosaedro 3D)</span>
      <span style="margin-left:16px">Borda ∝ transações:</span>
      <span><span class="dot" style="background:#eb3812"></span> Muitas</span>
      <span><span class="dot" style="background:#F05F40"></span> Médias</span>
      <span><span class="dot" style="background:#cc7501"></span> Poucas</span>
      <span><span class="dot" style="background:#d49a5a"></span> Mínimas</span>
      <span style="margin-left:16px">Controles 3D:</span>
      <span>🖱️ Arraste = rotacionar</span>
      <span>🔍 Scroll = zoom</span>
      <span>✋ Clique direito = pan</span>
    </div>
  </div>
</div>

<div id="tab-manipulation" class="tab-panel">
  <h2>🚨 Sinais de Manipulação</h2>
  <div class="kpis">
    <div class="kpi"><div class="v">${signals.filter((s) => s.severity === "ALTO").length}</div><div class="l">ALTO</div></div>
    <div class="kpi"><div class="v">${signals.filter((s) => s.severity === "MODERADO").length}</div><div class="l">MODERADO</div></div>
    <div class="kpi"><div class="v">${signals.filter((s) => s.severity === "BAIXO").length}</div><div class="l">BAIXO</div></div>
    <div class="kpi"><div class="v">${fmt(signals.reduce((s, x) => s + x.volumeCas, 0))}</div><div class="l">Volume suspeito (CAS)</div></div>
    <div class="kpi"><div class="v">${new Set(signals.flatMap((s) => s.addresses)).size}</div><div class="l">Endereços envolvidos</div></div>
    <div class="kpi"><div class="v">${socialSnapshot ? (socialSnapshot.negativeScore * 100).toFixed(0) + "%" : "—"}</div><div class="l">Negatividade social</div></div>
  </div>
  <div class="card full">
    <h3>Sinais detectados</h3>
    <table id="manipulation-table" class="sortable">
      <thead><tr><th>Tipo</th><th>Severidade</th><th>Início</th><th>Fim</th><th>Endereços</th><th>Volume (CAS)</th><th>Txs</th><th>Evidência</th></tr></thead>
      <tbody>${signals.length ? signals.map((s) => `<tr class="${s.severity === "ALTO" ? "alert-row" : ""}">
        <td>${s.type}</td>
        <td>${s.severity}</td>
        <td>${s.start ? new Date(s.start * 1000).toLocaleString("pt-BR", { timeZone: "UTC" }) : "—"}</td>
        <td>${s.end ? new Date(s.end * 1000).toLocaleString("pt-BR", { timeZone: "UTC" }) : "—"}</td>
        <td>${s.addresses.slice(0, 3).map((a) => polyScanLink(a, shortAddr(a))).join(", ")}${s.addresses.length > 3 ? ` +${s.addresses.length - 3}` : ""}</td>
        <td data-sort="${s.volumeCas}">${fmt(s.volumeCas)}</td>
        <td>${s.txCount}</td>
        <td style="font-size:.8rem;max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${s.evidence.replace(/"/g, "&quot;")}">${s.evidence}</td>
      </tr>`).join("") : `<tr><td colspan="8" style="text-align:center;color:#F05F40">Nenhum sinal detectado</td></tr>`}</tbody>
    </table>
  </div>
  ${socialSnapshot ? `<div class="card full" style="margin-top:16px">
    <h3>Sentimento Social (últimas 24h)</h3>
    <p>Plataformas: ${socialSnapshot.platforms.join(", ")} · Posts: ${socialSnapshot.posts.length} · Score negativo: ${(socialSnapshot.negativeScore * 100).toFixed(1)}%</p>
    <p>Termos de risco: ${Object.entries(socialSnapshot.riskKeywordCounts).filter(([, c]) => c > 0).map(([k, c]) => `${k}=${c}`).join(", ") || "nenhum"}</p>
    ${socialSnapshot.topSources.length ? `<ul>${socialSnapshot.topSources.map((s) => `<li><a href="${s.url}" target="_blank">${s.platform}</a></li>`).join("")}</ul>` : ""}
  </div>` : ""}
</div>

<div id="tab-ai" class="tab-panel">
  <h2>🤖 Análise GenAI (OpenRouter)</h2>
  <div class="card full">${aiHtml}</div>
</div>

<footer>CAS Distribution Dashboard · Agentic Space · dados on-chain via Polygonscan · uso interno do admin/operadores</footer>

<div id="print-overlay" class="print-overlay">
  <div class="print-modal">
    <h3>🖨️ Imprimir / Exportar PDF</h3>
    <p style="color:var(--muted);font-size:.85rem;margin-bottom:16px">Selecione as abas para incluir:</p>
    <label><input type="checkbox" class="print-tab-cb" value="tab-overview" checked> 📋 Visão Geral</label>
    <label><input type="checkbox" class="print-tab-cb" value="tab-market" checked> 💰 Mercado</label>
    <label><input type="checkbox" class="print-tab-cb" value="tab-concentration" checked> 🚨 Concentração</label>
    <label><input type="checkbox" class="print-tab-cb" value="tab-charts" checked> 📊 Gráficos</label>
    <label><input type="checkbox" class="print-tab-cb" value="tab-candlestick" checked> 🕯️ Candlesticks</label>
    <label><input type="checkbox" class="print-tab-cb" value="tab-holders" checked> 🏆 Holders</label>
    <label><input type="checkbox" class="print-tab-cb" value="tab-partners" checked> 🤝 Parceiros</label>
    <label><input type="checkbox" class="print-tab-cb" value="tab-graph" checked> 🔗 Grafo 3D de Transferências</label>
    <label><input type="checkbox" class="print-tab-cb" value="tab-manipulation" checked> 🚨 Manipulação</label>
  <label><input type="checkbox" class="print-tab-cb" value="tab-ai" checked> 🤖 Análise IA</label>
    <div class="print-modal-actions">
      <button class="btn-cancel" onclick="closePrintModal()">Cancelar</button>
      <button class="btn-print" onclick="doPrint()">Imprimir</button>
    </div>
  </div>
</div>

<script>
const donutLabels = ${JSON.stringify(donutLabels)};
const donutData = ${JSON.stringify(donutData)};
const barLabels = ${JSON.stringify(topN.map((h) => h.label || shortAddr(h.address)))};
const barData = ${JSON.stringify(topN.map((h) => Math.round(h.pct * 100) / 100))};
const barColors = ${JSON.stringify(topN.map((h) => (h.pct > 30 ? "#eb3812" : h.isContractLike ? "#cc7501" : "#F05F40")))};
const donutObs = ${JSON.stringify(donutObs)};
const barObs = ${JSON.stringify(barObs)};
const lorenzData = ${JSON.stringify(lorenz.map((p) => ({ x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 })))};
const dailyLabels = ${JSON.stringify(metrics.dailySeries.map((d) => d.date))};
const dailyCounts = ${JSON.stringify(metrics.dailySeries.map((d) => d.count))};
const dailyVolumes = ${JSON.stringify(metrics.dailySeries.map((d) => d.volume))};
const graphData = ${graphDataJson};

Chart.defaults.color = "#f7d4ca";
Chart.defaults.borderColor = "rgba(255,255,255,0.15)";
const palette = ["#F05F40","#fcc650","#cc7501","#eb3812","#ce6e6d","#f7d4ca","#d4502e","#b5651d",
                 "#fdd97a","#d9908f","#fae5df","#ff7a5c","#e89642","#ffd98a","#f54020","#c43d18",
                 "#8a3a2c","#5d3a32","#eb6b4a","#e07a3a","#d49a5a"];

new Chart(document.getElementById("donut"), {
  type: "doughnut",
  data: { labels: donutLabels, datasets: [{ data: donutData, backgroundColor: palette, borderWidth: 1, borderColor: "#712d23" }] },
  options: { plugins: { legend: { position: "right", labels: { font: { size: 10 } } },
    tooltip: { callbacks: { label: (c) => {
      const obs = donutObs[c.dataIndex] || "";
      return obs ? c.label + ": " + c.parsed + "% — " + obs : c.label + ": " + c.parsed + "%";
    } } } } }
});

new Chart(document.getElementById("bars"), {
  type: "bar",
  data: { labels: barLabels, datasets: [{ label: "% do supply", data: barData, backgroundColor: barColors }] },
  options: { indexAxis: "y", scales: { x: { title: { display: true, text: "% do supply" } } },
    plugins: { legend: { display: false },
      annotation: undefined,
      tooltip: { callbacks: { label: (c) => {
        const obs = barObs[c.dataIndex] || "";
        return obs ? c.parsed.x + "% do supply — " + obs : c.parsed.x + "% do supply";
      } } } } }
});

new Chart(document.getElementById("lorenz"), {
  type: "line",
  data: { datasets: [
    { label: "Lorenz (CAS)", data: lorenzData, borderColor: "#F05F40", backgroundColor: "rgba(240,95,64,.15)", fill: true, pointRadius: 0, tension: .2 },
    { label: "Igualdade perfeita", data: [{x:0,y:0},{x:100,y:100}], borderColor: "#712d23", borderDash: [6,4], pointRadius: 0 }
  ]},
  options: { scales: {
      x: { type: "linear", min: 0, max: 100, title: { display: true, text: "% de holders (acumulado)" } },
      y: { min: 0, max: 100, title: { display: true, text: "% do supply (acumulado)" } } } }
});

new Chart(document.getElementById("activity"), {
  data: { labels: dailyLabels, datasets: [
    { type: "bar", label: "Transferências", data: dailyCounts, backgroundColor: "#cc7501", yAxisID: "y" },
    { type: "line", label: "Volume (CAS)", data: dailyVolumes, borderColor: "#fcc650", yAxisID: "y1", tension: .3, pointRadius: 2 }
  ]},
  options: { scales: {
      y: { position: "left", title: { display: true, text: "Transferências" } },
      y1: { position: "right", grid: { drawOnChartArea: false }, title: { display: true, text: "Volume CAS" } } } }
});

// ── Candlestick charts (3 intervals: 30min, 8h, daily) ──
const candle30mData = ${JSON.stringify(candle30m)};
const candle8hData = ${JSON.stringify(candle8h)};
const candleDailyData = ${JSON.stringify(candleDaily)};

function makeCandleChart(canvasId, data, yLabel) {
  if (data.length === 0) return;
  const labels = data.map(d => d.label);
  const bodyData = data.map(d => [Math.min(d.open, d.close), Math.max(d.open, d.close)]);
  const colors = data.map(d => d.close >= d.open ? "#F05F40" : "#eb3812");
  const volUsdData = data.map(d => d.volumeUsd);
  const volUsdColors = data.map(d => d.close >= d.open ? "rgba(204,117,1,0.55)" : "rgba(113,45,35,0.65)");

  const wickPlugin = {
    id: canvasId + "Wicks",
    afterDatasetsDraw(chart) {
      const { ctx, scales } = chart;
      const yScale = scales.y;
      const meta = chart.getDatasetMeta(0);
      data.forEach((d, i) => {
        const bar = meta.data[i];
        if (!bar) return;
        const x = bar.x;
        const yHigh = yScale.getPixelForValue(d.high);
        const yLow = yScale.getPixelForValue(d.low);
        ctx.save();
        ctx.strokeStyle = d.close >= d.open ? "rgba(240,95,64,.7)" : "rgba(235,56,18,.7)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x, yHigh);
        ctx.lineTo(x, yLow);
        ctx.stroke();
        ctx.restore();
      });
    }
  };

  new Chart(document.getElementById(canvasId), {
    type: "bar",
    data: {
      labels: labels,
      datasets: [
        {
          label: "Candlestick (O–C)",
          data: bodyData,
          backgroundColor: colors,
          borderColor: colors,
          borderWidth: 1,
          barPercentage: 0.6,
          categoryPercentage: 0.8,
          yAxisID: "y",
          order: 1,
        },
        {
          label: "Volume USD",
          data: volUsdData,
          backgroundColor: volUsdColors,
          borderColor: volUsdColors,
          borderWidth: 0,
          barPercentage: 0.7,
          categoryPercentage: 0.8,
          yAxisID: "y1",
          order: 2,
        },
      ],
    },
    options: {
      plugins: {
        legend: { display: true, labels: { color: "#f7d4ca", font: { size: 11 } } },
        tooltip: {
          callbacks: {
            title: (items) => data[items[0].dataIndex].label,
            label: (ctx) => {
              const d = data[ctx.dataIndex];
              if (ctx.datasetIndex === 0) {
                const dir = d.close >= d.open ? "▲ Valorização" : "▼ Desvalorização";
                return [
                  dir,
                  "Open: " + d.open.toLocaleString("pt-BR", {maximumFractionDigits:2}) + " CAS",
                  "High: " + d.high.toLocaleString("pt-BR", {maximumFractionDigits:2}) + " CAS",
                  "Low: " + d.low.toLocaleString("pt-BR", {maximumFractionDigits:2}) + " CAS",
                  "Close: " + d.close.toLocaleString("pt-BR", {maximumFractionDigits:2}) + " CAS",
                  "Volume total: " + d.totalVolume.toLocaleString("pt-BR", {maximumFractionDigits:2}) + " CAS",
                  "Valor USD: $" + d.volumeUsd.toLocaleString("pt-BR", {maximumFractionDigits:2}),
                  "Transações: " + d.txCount,
                ];
              }
              return null;
            },
          },
        },
      },
      scales: {
        y: {
          position: "left",
          title: { display: true, text: yLabel, color: "#f7d4ca" },
          ticks: { color: "#f7d4ca" },
          grid: { color: "rgba(255,255,255,0.08)" },
        },
        y1: {
          position: "right",
          title: { display: true, text: "Volume USD", color: "#cc7501" },
          ticks: { color: "#cc7501" },
          grid: { drawOnChartArea: false },
        },
        x: { ticks: { maxRotation: 45, autoSkip: true, maxTicksLimit: 20, color: "#f7d4ca" } },
      },
    },
    plugins: [wickPlugin],
  });
}

makeCandleChart("candle30m", candle30mData, "Volume CAS (OHLC)");
makeCandleChart("candle8h", candle8hData, "Volume CAS (OHLC)");
makeCandleChart("candleDaily", candleDailyData, "Volume CAS (OHLC)");

// ── Tab switching ──
// _graph3d and _graph3dData are declared by GRAPH_3D_INIT_JS below

// ── Mobile tooltip toggle (click to open/close) ──
document.querySelectorAll('.term-tip').forEach(el => {
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.term-tip.is-open').forEach(o => { if (o !== el) o.classList.remove('is-open'); });
    el.classList.toggle('is-open');
  });
});
document.addEventListener('click', () => {
  document.querySelectorAll('.term-tip.is-open').forEach(el => el.classList.remove('is-open'));
});
function switchTab(evt, tabId) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  evt.currentTarget.classList.add('active');
  document.getElementById(tabId).classList.add('active');
  if (tabId === 'tab-graph') {
    setTimeout(() => {
      var container = document.getElementById('network-graph');
      if (_graph3d && container) {
        _graph3d.width(container.clientWidth).height(container.clientHeight);
        _graph3d.refresh();
        _graph3d.zoomToFit(400, 60);
      }
    }, 100);
  }
}

// ── Print modal ──
function openPrintModal() {
  document.getElementById('print-overlay').classList.add('show');
}
function closePrintModal() {
  document.getElementById('print-overlay').classList.remove('show');
}
function doPrint() {
  closePrintModal();
  const checked = Array.from(document.querySelectorAll('.print-tab-cb:checked')).map(cb => cb.value);
  document.querySelectorAll('.tab-panel').forEach(p => {
    if (!checked.includes(p.id)) { p.style.display = 'none'; }
  });
  window.print();
  setTimeout(() => {
    document.querySelectorAll('.tab-panel').forEach(p => { p.style.display = ''; });
  }, 500);
}

// ── Transfer graph (3d-force-graph) ──
${GRAPH_3D_TOOLTIP_JS}
${GRAPH_3D_INIT_JS}
${GRAPH_3D_SEARCH_JS}

function sortTable(tableId, colIndex, type) {
  const table = document.getElementById(tableId);
  if (!table) return;
  const tbody = table.querySelector('tbody');
  const rows = Array.from(tbody.querySelectorAll('tr'));
  const dir = table.getAttribute('data-sort-dir-' + colIndex) === 'asc' ? -1 : 1;
  const comparator = function(a, b) {
    const aText = (a.cells[colIndex] ? (a.cells[colIndex].getAttribute('data-sort') || a.cells[colIndex].textContent.trim()) : '') || '';
    const bText = (b.cells[colIndex] ? (b.cells[colIndex].getAttribute('data-sort') || b.cells[colIndex].textContent.trim()) : '') || '';
    let aVal, bVal;
    if (type === 'number') {
      let aClean = aText.replace(/[^0-9.,-]/g, '');
      let bClean = bText.replace(/[^0-9.,-]/g, '');
      if (aClean.indexOf(',') !== -1) aClean = aClean.replace(/\\./g, '').replace(',', '.');
      if (bClean.indexOf(',') !== -1) bClean = bClean.replace(/\\./g, '').replace(',', '.');
      aVal = parseFloat(aClean) || 0;
      bVal = parseFloat(bClean) || 0;
      return (aVal - bVal) * dir;
    }
    if (type === 'date') {
      const am = aText.match(/(\\d{2})\\/(\\d{2})\\/(\\d{4})[, ]+(\\d{2}):(\\d{2}):(\\d{2})/);
      const bm = bText.match(/(\\d{2})\\/(\\d{2})\\/(\\d{4})[, ]+(\\d{2}):(\\d{2}):(\\d{2})/);
      aVal = am ? new Date(am[3] + '-' + am[2] + '-' + am[1] + 'T' + am[4] + ':' + am[5] + ':' + am[6] + 'Z').getTime() : 0;
      bVal = bm ? new Date(bm[3] + '-' + bm[2] + '-' + bm[1] + 'T' + bm[4] + ':' + bm[5] + ':' + bm[6] + 'Z').getTime() : 0;
      return (aVal - bVal) * dir;
    }
    return aText.localeCompare(bText, 'pt-BR', { numeric: true, sensitivity: 'base' }) * dir;
  };
  rows.sort(comparator);
  rows.forEach(function(row) { tbody.appendChild(row); });
  for (let i = 0; i < 20; i++) { table.removeAttribute('data-sort-dir-' + i); }
  table.setAttribute('data-sort-dir-' + colIndex, dir === 1 ? 'asc' : 'desc');
}
</script>
</body>
</html>`;
}

// ── Browser opener ────────────────────────────────────────────────────

function openBrowser(filePath: string): void {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  execFile(opener, [filePath], (err) => {
    if (err) {
      log("WARN", "openBrowser", "Não foi possível abrir o navegador automaticamente", {
        error: err.message,
        file: filePath,
      });
    } else {
      log("OK", "openBrowser", "Dashboard aberto no navegador", { file: filePath });
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
  if (/^0x[0-9a-fA-F]{40}$/.test(target)) return target.toLowerCase();

  if (target.startsWith("0x") && (target.includes("…") || target.includes("..."))) {
    const resolved = resolveShortAddress(target);
    if (resolved) {
      log("OK", "resolveTarget", "Endereço encurtado resolvido", { input: target, address: resolved });
      return resolved;
    }
    log("WARN", "resolveTarget", "Endereço encurtado não encontrado", { input: target });
  }

  const idx = parseInt(target, 10);
  if (!isNaN(idx) && String(idx) === target && idx > 0) {
    const all = getAllAddresses();
    if (idx <= all.length) {
      log("OK", "resolveTarget", "Endereço por índice", { index: idx, address: all[idx - 1].address });
      return all[idx - 1].address;
    }
  }

  const nameResults = searchByName(target);
  if (nameResults.length > 0) {
    log("OK", "resolveTarget", "Endereço por nome", { query: target, address: nameResults[0].address });
    return nameResults[0].address;
  }

  const results = searchAddresses(target);
  if (results.length > 0) {
    log("OK", "resolveTarget", "Endereço por label/notes", { query: target, address: results[0].address });
    return results[0].address;
  }

  const direct = getAddress(target);
  if (direct) return direct.address;

  log("WARN", "resolveTarget", "Não foi possível resolver o alvo", { target });
  return null;
}

// ── Main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log("INFO", "main", "🚀 Iniciando análise de distribuição do CAS");

  const cliArgs = process.argv.slice(2);
  const useDbOnly = cliArgs.includes("--use-db");
  anonMode = cliArgs.includes("--anon");

  // Parse positional targets (address, name, index, shortened address)
  const positionalTargets: string[] = [];
  let fromArg: string | undefined;
  let toArg: string | undefined;
  for (let i = 0; i < cliArgs.length; i++) {
    const arg = cliArgs[i];
    if (arg === "--depth") { i++; continue; }
    if (arg === "--from") { fromArg = cliArgs[++i]; continue; }
    if (arg === "--to") { toArg = cliArgs[++i]; continue; }
    if (arg === "--index") { const v = cliArgs[++i]; if (v) positionalTargets.push(v); continue; }
    if (arg.startsWith("--")) continue;
    positionalTargets.push(arg);
  }

  const { range: dateRange, error: dateError } = resolveDateRange(fromArg, toArg);
  if (dateError) {
    log("ERROR", "main", dateError);
    process.exit(1);
  }
  if (dateRange) {
    log("INFO", "main", "Filtro de período ativo", { periodo: describeDateRange(dateRange) });
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

  if (anonMode) {
    log("INFO", "main", "Modo anônimo (--anon) ativado — labels e observações serão ocultos");
  }

  const tokenAddress = process.env.CAS_TOKEN_ADDRESS?.trim();
  if (!tokenAddress || !/^0x[0-9a-fA-F]{40}$/.test(tokenAddress)) {
    log("ERROR", "main", "CAS_TOKEN_ADDRESS ausente ou inválido em smartcontracts/.env");
    process.exit(1);
  }

  let transfers: TokenTransfer[] = [];
  let totalSupply: bigint = 0n;
  let cgStatus: PromiseSettledResult<{ listed: boolean; id: string | null; priceUsd: number | null; marketCap: number | null; volume24h: number | null }> | null = null;
  let dexData: PromiseSettledResult<{ dexPairs: DexPair[]; bestPair: DexPair | null }> | null = null;

  getDB();

  // ── Import CSV labels before analysis ──
  importAllCsvs(DATA_DIR);

  if (useDbOnly) {
    // ── Mode: SQLite only (no API sync) ──
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

    // Total supply still needs API or can be approximated from DB
    if (process.env.POLYGONSCAN_API_KEY?.trim()) {
      try {
        totalSupply = await fetchTotalSupply(tokenAddress);
      } catch (err) {
        log("WARN", "main", "Falha ao buscar total supply via API, usando soma do banco", { error: (err as Error).message });
      }
    }
  } else {
    // ── Mode: API sync + DB cache ──
    if (!process.env.POLYGONSCAN_API_KEY?.trim()) {
      log("ERROR", "main", "POLYGONSCAN_API_KEY ausente em smartcontracts/.env. Use --use-db para modo apenas banco.");
      closeDB();
      process.exit(1);
    }

    log("INFO", "main", "Sync incremental + totalSupply + dados de mercado concorrentemente");

    const [transfersResult, supplyResult, cgResult, dexResult] = await Promise.allSettled([
      fetchAllTransfers(tokenAddress),
      fetchTotalSupply(tokenAddress),
      fetchCoinGeckoStatus(tokenAddress),
      fetchDexScreenerData(tokenAddress),
    ]);
    cgStatus = cgResult;
    dexData = dexResult;

    // Process transfers result
    if (transfersResult.status === "fulfilled") {
      transfers = transfersResult.value;
      log("OK", "main", "Transferências obtidas (DB + sync incremental)", { count: transfers.length });
    } else {
      log("ERROR", "main", "Falha no sync de transferências", { error: transfersResult.reason?.message });
      if (getTransactionCount() > 0) {
        log("WARN", "main", "Fallback: usando transações do banco SQLite");
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
        log("ERROR", "main", "Sem dados no SQLite. Verifique API key e conectividade.");
        closeDB();
        process.exit(1);
      }
    }

    // Process totalSupply result
    if (supplyResult.status === "fulfilled") {
      totalSupply = supplyResult.value;
      log("OK", "main", "Total supply obtido via API", { supply: toNum(totalSupply) });
    } else {
      log("WARN", "main", "Falha ao buscar total supply via API, calculando dos transfers", { error: supplyResult.reason?.message });
    }
  }

  if (dateRange) {
    const before = transfers.length;
    transfers = transfers.filter((t) => inDateRange(Number(t.timeStamp), dateRange));
    log("OK", "main", "Transferências filtradas por período", {
      periodo: describeDateRange(dateRange),
      antes: before,
      depois: transfers.length,
    });
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
    log("ERROR", "main", dateRange
      ? `Nenhuma transferência encontrada no período ${describeDateRange(dateRange)}`
      : "Nenhuma transferência encontrada; verifique o endereço do token e a API key");
    closeDB();
    process.exit(1);
  }

  // ── Process market data (already fetched concurrently in API mode) ──
  let marketData: MarketData;
  if (!useDbOnly && cgStatus && dexData) {
    const cg = cgStatus.status === "fulfilled" ? cgStatus.value : null;
    const dex = dexData.status === "fulfilled" ? dexData.value : null;
    marketData = {
      coingeckoListed: cg?.listed ?? false,
      coingeckoId: cg?.id ?? null,
      coingeckoPriceUsd: cg?.priceUsd ?? null,
      coingeckoMarketCap: cg?.marketCap ?? null,
      coingeckoVolume24h: cg?.volume24h ?? null,
      dexPairs: dex?.dexPairs ?? [],
      bestPair: dex?.bestPair ?? null,
    };
  } else {
    log("INFO", "main", "Buscando dados de mercado (CoinGecko + DexScreener)");
    const [cgResult, dexResult] = await Promise.allSettled([
      fetchCoinGeckoStatus(tokenAddress),
      fetchDexScreenerData(tokenAddress),
    ]);
    marketData = {
      coingeckoListed: cgResult.status === "fulfilled" ? cgResult.value.listed : false,
      coingeckoId: cgResult.status === "fulfilled" ? cgResult.value.id : null,
      coingeckoPriceUsd: cgResult.status === "fulfilled" ? cgResult.value.priceUsd : null,
      coingeckoMarketCap: cgResult.status === "fulfilled" ? cgResult.value.marketCap : null,
      coingeckoVolume24h: cgResult.status === "fulfilled" ? cgResult.value.volume24h : null,
      dexPairs: dexResult.status === "fulfilled" ? dexResult.value.dexPairs : [],
      bestPair: dexResult.status === "fulfilled" ? dexResult.value.bestPair : null,
    };
  }
  log("OK", "main", "Dados de mercado consolidados", {
    coingeckoListed: marketData.coingeckoListed,
    dexPairs: marketData.dexPairs.length,
    bestDex: marketData.bestPair?.dex,
  });

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
      log("OK", "main", "Alvos resolvidos para centro da análise", { count: targetSeeds.size, addresses: [...targetSeeds] });
      if (depth === 0) depth = 1;
    } else {
      log("WARN", "main", "Nenhum alvo pôde ser resolvido — usando seeds infra padrão");
      targetSeeds = undefined;
    }
  }

  const filteredTransfers = filterTransfersByDepth(transfers, depth, targetSeeds);
  if (filteredTransfers.length !== transfers.length) {
    log("INFO", "main", "Transferências filtradas por profundidade", { original: transfers.length, filtered: filteredTransfers.length, depth });
  }
  const metrics = computeMetrics(filteredTransfers, totalSupply);
  log("OK", "main", "Métricas calculadas", {
    holders: metrics.holderCount,
    top1Pct: metrics.top1Pct.toFixed(2),
    top10Pct: metrics.top10Pct.toFixed(2),
    gini: metrics.gini,
    hhi: metrics.hhi,
    whales30: metrics.whales30.length,
  });

  for (const w of metrics.whales30) {
    log("WARN", "main", "Holder acima de 30% do supply", {
      address: w.address,
      label: w.label || "desconhecido",
      pct: w.pct.toFixed(2),
      infra: w.isContractLike,
    });
  }

  const labels = knownLabels();
  const labelResolver: LabelResolver = (addr) => {
    const info = labels.get(addr.toLowerCase());
    return info ? { label: info.label, isInfra: info.isInfra, type: info.type } : undefined;
  };

  let socialSnapshot: SentimentSnapshot | null = null;
  if (process.env.SOCIAL_SENTINEL_ENABLED?.toLowerCase() === "true") {
    const platforms = process.env.SOCIAL_SENTINEL_PLATFORMS?.split(",")?.map((s) => s.trim()).filter((s) => s.length > 0) ?? ["duckduckgo", "reddit"];
    const sentinel = new SocialSentinel([tokenAddress, "CAS", "CASToken"], platforms);
    socialSnapshot = await sentinel.scan().catch((err) => {
      log("WARN", "main", "SocialSentinel falhou", { error: (err as Error).message });
      return null;
    });
  }

  const signals = detectManipulationSignals(filteredTransfers, labelResolver, marketData, tokenAddress, socialSnapshot);
  log("OK", "main", "Sinais de manipulação detectados", { count: signals.length });

  const aiHtml = await generateAiAnalysis(metrics, marketData);

  const reportsDir = path.join(SC_ROOT, "reports");
  fs.mkdirSync(reportsDir, { recursive: true });

  const signalsPath = path.join(reportsDir, `cas_manipulation_signals_${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(signalsPath, JSON.stringify({ signals, socialSnapshot, generatedAt: new Date().toISOString() }, null, 2), "utf-8");
  log("OK", "main", "JSON de sinais salvo", { file: signalsPath });

  const outFile = path.join(reportsDir, `cas_distribution_${new Date().toISOString().slice(0, 10)}.html`);
  fs.writeFileSync(outFile, buildHtml(metrics, tokenAddress, aiHtml, marketData, filteredTransfers, signals, socialSnapshot, dateRange ? describeDateRange(dateRange) : undefined), "utf-8");
  log("OK", "main", "Relatório HTML gerado", { file: outFile });

  openBrowser(outFile);
  log("INFO", "main", "🏁 Análise concluída");
  closeDB();
}

main().catch((err) => {
  log("ERROR", "main", "Falha na execução", { error: (err as Error).message });
  closeDB();
  process.exit(1);
});
