/**
 * AirDrop CAS — Relatório de Campanha por Fase
 * ---------------------------------------------
 * Gera um relatório HTML do progresso da campanha de AirDrop do token CAS
 * contra a meta de 1000 contas (holders on-chain com saldo > 0), consulta
 * holders reais via Polygonscan, lê o CSV de distribuição, e usa a IA
 * (OpenRouter) para gerar sugestões contextuais baseadas na fase informada.
 *
 * Uso:
 *   npx tsx scripts/analysis/airdrop_campaign_report.ts <fase>
 *   npm run airdrop:report -- 0
 *   npm run airdrop:report -- 1
 *
 * Parâmetro posicional (obrigatório):
 *   0 = Lançamento (distribuição gratuita já executada)
 *   1 = Consolidação (certificados, treinamentos, desafios)
 * 2+ = Fases futuras (genéricas/extensíveis)
 *
 * Requisitos de ambiente (smartcontracts/.env):
 *   AI_API, AI_API_KEY, AI_MODEL — OpenRouter
 *   CAS_TOKEN_ADDRESS, POLYGONSCAN_API_KEY, POLYGON_RPC_URL
 */

import { formatUnits } from "agentic_space_commons";
import * as fs from "fs";
import * as path from "path";
import dotenv from "dotenv";

// ── Env loading ───────────────────────────────────────────────────────

const SC_ROOT = path.resolve(__dirname, "..", "..");
dotenv.config({ path: path.join(SC_ROOT, ".env") });

const DATA_DIR = path.join(SC_ROOT, "data");
const REPORTS_DIR = path.join(SC_ROOT, "reports");
const CAS_TOKEN_ADDRESS = process.env.CAS_TOKEN_ADDRESS || "";
const POLYGONSCAN_API_KEY = process.env.POLYGONSCAN_API_KEY || "";
const AI_API_KEY = process.env.AI_API_KEY?.trim() || "";
const AI_MODEL = process.env.AI_MODEL?.trim() || "";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL?.trim() || "granite4:small-h";
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL?.trim() || "http://localhost:11434";
const RAPPORT_CERTIFICATE_ADDRESS = process.env.RAPPORT_CERTIFICATE_ADDRESS?.trim() || "";
const OLD_RAPPORT_CERTIFICATE_ADDRESS = process.env.OLD_RAPPORT_CERTIFICATE_ADDRESS?.trim() || "";
const POLYGON_RPC_URL = process.env.POLYGON_RPC_URL?.trim() || "https://polygon-rpc.com";

const TARGET_ACCOUNTS = 1000;
const DECIMALS = 18;
const ZERO = "0x0000000000000000000000000000000000000000";
const CHAIN_ID = 137;
const API_BASES = [
  "https://api.polygonscan.com/api",
  "https://api.etherscan.io/v2/api",
];

// ── Anonymization levels (LGPD) ──────────────────────────────────────

enum AnonLevel {
  NONE = 0,
  PSEUDONYMIZED = 1,
  FULL = 2,
}

interface AnonConfig {
  level: AnonLevel;
}

function parseAnonArgs(args: string[]): AnonConfig {
  const count = args.filter((a) => a === "--anon").length;
  if (count >= 2) return { level: AnonLevel.FULL };
  if (count === 1) return { level: AnonLevel.PSEUDONYMIZED };
  return { level: AnonLevel.NONE };
}

function anonName(name: string, index: number, level: AnonLevel): string {
  if (level === AnonLevel.NONE) return name;
  return `Parceiro #${index + 1}`;
}

function anonGroup(group: string, level: AnonLevel): string {
  if (level === AnonLevel.NONE) return group || "—";
  return group ? `Grupo ${group.charAt(0).toUpperCase()}` : "—";
}

function anonIndication(indication: string, level: AnonLevel): string {
  if (level === AnonLevel.NONE) return indication || "—";
  return "—";
}

function anonAddress(addr: string, rawAddr: string, isResolvable: boolean, level: AnonLevel): string {
  if (level === AnonLevel.NONE) {
    return isResolvable ? polyScanLink(addr, shortAddr(addr)) : `<span title="${escapeHtml(rawAddr)}">${escapeHtml(rawAddr)}</span>`;
  }
  if (level === AnonLevel.PSEUDONYMIZED) {
    return isResolvable ? `<code>${shortAddr(addr)}</code>` : `<span>Endereço pendente</span>`;
  }
  return `<span>🔒 Anonimizado</span>`;
}

function anonHolderAddress(addr: string, level: AnonLevel): string {
  if (level === AnonLevel.NONE) return polyScanLink(addr, shortAddr(addr));
  if (level === AnonLevel.PSEUDONYMIZED) return `<code>${shortAddr(addr)}</code>`;
  return `<span>🔒 Anonimizado</span>`;
}

function anonObservation(obs: string, level: AnonLevel): string {
  if (level === AnonLevel.NONE) return obs || "—";
  return "—";
}

function anonGroupLabel(label: string, level: AnonLevel): string {
  if (level === AnonLevel.NONE) return label || "Sem grupo";
  if (level === AnonLevel.PSEUDONYMIZED) return label ? `Grupo ${label.charAt(0).toUpperCase()}` : "Sem grupo";
  return label ? `Grupo ${label.charAt(0).toUpperCase()}` : "Sem grupo";
}

// ── Structured logging ────────────────────────────────────────────────

type LogLevel = "INFO" | "WARN" | "ERROR" | "OK" | "DEBUG";

function log(level: LogLevel, fn: string, message: string, params?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const emoji = { INFO: "ℹ️", WARN: "⚠️", ERROR: "❌", OK: "✅", DEBUG: "🔍" }[level];
  const extra = params ? ` - ${JSON.stringify(params)}` : "";
  console.log(`[${ts}] [airdrop_campaign_report:${fn}] ${emoji} ${message}${extra}`);
}

// ── Types ─────────────────────────────────────────────────────────────

interface AirdropRecord {
  name: string;
  group: string;
  indication: string;
  date: string;
  dateSort: number;
  address: string;
  rawAddress: string;
  quantity: number;
  isResolvable: boolean;
  observation: string;
}

interface OnChainHolder {
  address: string;
  balance: bigint;
}

interface CampaignMetrics {
  totalDistributedCsv: number;
  csvRecordCount: number;
  onChainHolders: number;
  onChainHoldersList: OnChainHolder[];
  progressPct: number;
  gap: number;
  retentionRate: number;
  uniqueAddressesInCsv: number;
  groupDistribution: Map<string, number>;
  certificates?: CertificateStats;
}

interface PhaseStat {
  id: number;
  name: string;
  minCasDeposit: bigint;
  startsAt: number;
  endsAt: number;
  minted: number;
  active: boolean;
}

interface CertificateStats {
  totalCertificates: number;
  phaseCount: number;
  currentPhaseId: number;
  phases: PhaseStat[];
  uniqueHolders: number;
  contractAddress: string;
}

// ── Phase definitions ─────────────────────────────────────────────────

interface PhaseInfo {
  id: number;
  name: string;
  description: string;
}

function getPhaseInfo(phaseId: number): PhaseInfo {
  const knownPhases: Record<number, PhaseInfo> = {
    0: {
      id: 0,
      name: "Lançamento",
      description:
        "Distribuição gratuita já executada. Foco em onboarding inicial de parceiros e comunidades.",
    },
    1: {
      id: 1,
      name: "Consolidação",
      description:
        "Nova campanha de certificados com ênfase em treinamentos e desafios. Busca engajar e reter usuários.",
    },
  };

  if (knownPhases[phaseId]) return knownPhases[phaseId];

  return {
    id: phaseId,
    name: `Fase ${phaseId}`,
    description: `Fase futura (ID ${phaseId}). A IA gerará sugestões contextuais com base nos dados atuais.`,
  };
}

// ── CSV parser ────────────────────────────────────────────────────────

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const NAME_KEYWORDS = ["nome", "name", "parceiro", "conta"];
const ADDRESS_KEYWORDS = ["address", "endereço", "endereco", "carteira", "wallet"];
const QTD_KEYWORDS = ["qtd", "quantidade", "amount", "valor"];
const GROUP_KEYWORDS = ["grupo", "group"];
const DATE_KEYWORDS = ["data", "date"];
const INDICATION_KEYWORDS = ["indicação", "indicacao", "indication", "referral"];
const OBS_KEYWORDS = ["obs", "observação", "observacao", "note"];

function normalizeHeader(s: string): string {
  return s.trim().toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

function findColumn(headers: string[], keywords: string[]): number {
  for (let i = 0; i < headers.length; i++) {
    const h = normalizeHeader(headers[i]);
    for (const kw of keywords) {
      if (h.includes(normalizeHeader(kw))) return i;
    }
  }
  return -1;
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      cells.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

function parsePtBrNumber(s: string): number {
  if (!s) return 0;
  const cleaned = s.replace(/CAS/i, "").replace(/["""']/g, "").trim();
  if (!cleaned) return 0;
  const normalized = cleaned.replace(/\./g, "").replace(",", ".");
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

function loadAirdropCsv(dataDir: string): AirdropRecord[] {
  const files = fs.readdirSync(dataDir)
    .filter((f) => f.toLowerCase().endsWith(".csv") && /airdrop|distribuicao|distribuição/.test(f.toLowerCase()))
    .sort();

  if (files.length === 0) {
    log("WARN", "loadAirdropCsv", "Nenhum CSV de airdrop encontrado", { dir: dataDir });
    return [];
  }

  const records: AirdropRecord[] = [];

  for (const fileName of files) {
    const csvPath = path.join(dataDir, fileName);
    log("INFO", "loadAirdropCsv", "Carregando CSV", { file: fileName });

    let content: string;
    try {
      content = fs.readFileSync(csvPath, "utf-8");
    } catch (err) {
      log("WARN", "loadAirdropCsv", "Erro ao ler arquivo", { file: fileName, error: (err as Error).message });
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
      if ((hasName && hasAddr) || hasQtd) {
        headerIdx = i;
        break;
      }
    }

    if (headerIdx === -1) {
      log("WARN", "loadAirdropCsv", "Cabeçalho não encontrado", { file: fileName });
      continue;
    }

    const headers = rows[headerIdx];
    const dataRows = rows.slice(headerIdx + 1);

    const nameCol = findColumn(headers, NAME_KEYWORDS);
    const addressCol = findColumn(headers, ADDRESS_KEYWORDS);
    const qtdCol = findColumn(headers, QTD_KEYWORDS);
    const groupCol = findColumn(headers, GROUP_KEYWORDS);
    const dateCol = findColumn(headers, DATE_KEYWORDS);
    const indicationCol = findColumn(headers, INDICATION_KEYWORDS);
    const obsCol = findColumn(headers, OBS_KEYWORDS);

    if (addressCol < 0) {
      log("WARN", "loadAirdropCsv", "Coluna de endereço não encontrada", { file: fileName });
      continue;
    }

    for (const row of dataRows) {
      const rawQty = qtdCol >= 0 ? (row[qtdCol] ?? "").trim() : "";
      const quantity = parsePtBrNumber(rawQty);
      if (quantity <= 0) continue;

      const rawAddr = (row[addressCol] ?? "").trim();
      if (!rawAddr) continue;

      const isResolvable = ADDRESS_RE.test(rawAddr);
      const address = isResolvable ? rawAddr.toLowerCase() : rawAddr.toLowerCase();
      const name = nameCol >= 0 ? (row[nameCol] ?? "").trim() : "";
      const group = groupCol >= 0 ? (row[groupCol] ?? "").trim() : "";
      const date = dateCol >= 0 ? (row[dateCol] ?? "").trim() : "";
      const indication = indicationCol >= 0 ? (row[indicationCol] ?? "").trim() : "";
      const observation = obsCol >= 0 ? (row[obsCol] ?? "").trim() : "";

      records.push({
        name: name || "Parceiro",
        group,
        indication,
        date,
        dateSort: parseDateToTimestamp(date),
        address,
        rawAddress: rawAddr,
        quantity,
        isResolvable,
        observation,
      });
    }
  }

  records.sort((a, b) => b.quantity - a.quantity);
  log("OK", "loadAirdropCsv", "Registros carregados", { count: records.length, files: files.length });
  return records;
}

// ── Polygonscan API client ─────────────────────────────────────────────

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
      ? (process.env.ETHERSCAN_API_KEY?.trim() || POLYGONSCAN_API_KEY)
      : POLYGONSCAN_API_KEY;
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
            log("WARN", "scanRequest", "Erro transitório, retrying", { attempt, status: res.status, backoffMs: Math.round(backoff + extraDelay) });
            await sleep(backoff + extraDelay);
            continue;
          }
          throw new Error(msg);
        }
        const contentType = res.headers.get("content-type") ?? "";
        if (!contentType.includes("application/json")) {
          const textBody = await res.text();
          const isHtml = textBody.trimStart().startsWith("<");
          const detail = isHtml ? "Resposta HTML (possível Cloudflare/rate-limit)" : textBody.slice(0, 200);
          if (isTransientError(res.status, detail) && attempt < MAX_RETRIES) {
            const backoff = Math.min(1000 * Math.pow(2, attempt - 1), 16_000) + Math.random() * 400;
            await sleep(backoff + RATE_LIMIT_EXTRA_DELAY_MS);
            continue;
          }
          throw new Error(`Resposta não-JSON: ${detail}`);
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
        log("WARN", "scanRequest", "Falha na base, tentando fallback", { base, error: errMsg, attempt });
        break;
      }
    }
  }
  throw lastError ?? new Error("Todas as bases da API falharam após retries");
}

// ── On-chain data fetch ────────────────────────────────────────────────

interface TokenTransfer {
  hash: string;
  from: string;
  to: string;
  value: string;
  timeStamp: string;
  blockNumber: string;
}

async function fetchAllTransfers(tokenAddress: string): Promise<TokenTransfer[]> {
  const MAX_BLOCK = 999_999_999;
  const PAGE_SIZE = 10_000;

  log("INFO", "fetchAllTransfers", "Buscando transferências", { token: tokenAddress });

  const allTransfers: TokenTransfer[] = [];
  let currentStartBlock = 0;

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
      log("ERROR", "fetchAllTransfers", "Falha ao buscar página", { startBlock: currentStartBlock, error: (err as Error).message });
      if (allTransfers.length > 0) {
        log("WARN", "fetchAllTransfers", "Prosseguindo com dados parciais", { count: allTransfers.length });
        break;
      }
      throw err;
    }

    if (!Array.isArray(result) || result.length === 0) break;

    for (const t of result) {
      allTransfers.push({
        hash: t.hash,
        from: t.from,
        to: t.to,
        value: t.value,
        timeStamp: t.timeStamp,
        blockNumber: t.blockNumber,
      });
    }

    log("DEBUG", "fetchAllTransfers", "Página sincronizada", {
      startBlock: currentStartBlock,
      count: result.length,
      total: allTransfers.length,
    });

    if (result.length < PAGE_SIZE) break;
    currentStartBlock = parseInt(result[result.length - 1].blockNumber, 10) + 1;
  }

  log("OK", "fetchAllTransfers", "Transferências obtidas", { total: allTransfers.length });
  return allTransfers;
}

async function fetchTotalSupply(tokenAddress: string): Promise<bigint> {
  const result = (await scanRequest({
    module: "stats",
    action: "tokensupply",
    contractaddress: tokenAddress,
  })) as string;
  return BigInt(result);
}

function computeHolders(transfers: TokenTransfer[], totalSupply: bigint): OnChainHolder[] {
  const balances = new Map<string, bigint>();

  for (const t of transfers) {
    const from = t.from.toLowerCase();
    const to = t.to.toLowerCase();
    const value = BigInt(t.value);
    if (from !== ZERO) balances.set(from, (balances.get(from) ?? 0n) - value);
    if (to !== ZERO) balances.set(to, (balances.get(to) ?? 0n) + value);
  }

  const holders: OnChainHolder[] = [...balances.entries()]
    .filter(([, b]) => b > 0n)
    .map(([address, balance]) => ({ address, balance }))
    .sort((a, b) => (b.balance > a.balance ? 1 : -1));

  return holders;
}

// ── Certificate data fetching ─────────────────────────────────────────

const FN_SELECTORS: Record<string, string> = {
  totalCertificates: "0x596b772f",
  phaseCount: "0xe4faf288",
  currentPhaseId: "0x40c5b34e",
  phases: "0x2e37eef6",
};

async function rpcEthCall(to: string, data: string): Promise<string> {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "eth_call",
    params: [{ to, data }, "latest"],
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(POLYGON_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
    const json = (await res.json()) as { result?: string; error?: { message?: string } };
    if (json.error) throw new Error(`RPC error: ${json.error.message}`);
    return json.result || "0x";
  } finally {
    clearTimeout(timer);
  }
}

function decodeUint256(hex: string): bigint {
  if (!hex || hex === "0x") return 0n;
  return BigInt(hex);
}

function decodeBool(hex: string, offset: number): boolean {
  const byte = hex.slice(2 + offset * 2, 2 + offset * 2 + 2);
  return byte === "01";
}

function decodeAddress(hex: string, offset: number): string {
  return "0x" + hex.slice(2 + offset * 2 + 24, 2 + offset * 2 + 64);
}

function decodeString(hex: string, headByteOffset: number): string {
  const data = hex.startsWith("0x") ? hex.slice(2) : hex;
  const dataOffset = Number(BigInt("0x" + data.slice(headByteOffset * 2, headByteOffset * 2 + 64)));
  const strLen = Number(BigInt("0x" + data.slice(dataOffset * 2, dataOffset * 2 + 64)));
  const strHex = data.slice(dataOffset * 2 + 64, dataOffset * 2 + 64 + strLen * 2);
  return Buffer.from(strHex, "hex").toString("utf-8");
}

async function fetchCertificateStats(): Promise<CertificateStats | null> {
  const certAddr = RAPPORT_CERTIFICATE_ADDRESS || OLD_RAPPORT_CERTIFICATE_ADDRESS;
  if (!certAddr) {
    log("WARN", "fetchCertificateStats", "RAPPORT_CERTIFICATE_ADDRESS não configurado");
    return null;
  }

  log("INFO", "fetchCertificateStats", "Consultando contrato de certificados", { address: certAddr });

  try {
    const [totalHex, phaseCountHex, currentPhaseHex] = await Promise.all([
      rpcEthCall(certAddr, FN_SELECTORS.totalCertificates),
      rpcEthCall(certAddr, FN_SELECTORS.phaseCount),
      rpcEthCall(certAddr, FN_SELECTORS.currentPhaseId),
    ]);

    const totalCertificates = Number(decodeUint256(totalHex));
    const phaseCount = Number(decodeUint256(phaseCountHex));
    const currentPhaseId = Number(decodeUint256(currentPhaseHex));

    log("OK", "fetchCertificateStats", "Dados básicos obtidos", {
      totalCertificates,
      phaseCount,
      currentPhaseId,
    });

    const phases: PhaseStat[] = [];
    for (let i = 1; i <= phaseCount; i++) {
      try {
        const callData = FN_SELECTORS.phases + i.toString(16).padStart(64, "0");
        const phaseHex = await rpcEthCall(certAddr, callData);
        if (!phaseHex || phaseHex === "0x") continue;

        const hex = phaseHex.slice(2);
        const word = (idx: number): string => hex.slice(idx * 64, idx * 64 + 64);
        const wordNum = (idx: number): number => Number(BigInt("0x" + word(idx)));
        const wordBool = (idx: number): boolean => word(idx).slice(62, 64) === "01";

        const name = decodeString(phaseHex, 0);
        const minCasDeposit = BigInt("0x" + word(2));
        const startsAt = wordNum(3);
        const endsAt = wordNum(4);
        const minted = wordNum(5);
        const active = wordBool(6);

        phases.push({ id: i, name, minCasDeposit, startsAt, endsAt, minted, active });
      } catch (err) {
        log("WARN", "fetchCertificateStats", "Erro ao ler fase", { phaseId: i, error: (err as Error).message });
      }
    }

    let uniqueHolders = 0;
    try {
      const nftTransfers = await scanRequest({
        module: "account",
        action: "tokennfttx",
        contractaddress: certAddr,
        startblock: "0",
        sort: "asc",
      }) as Array<{ to: string; from: string }>;

      const holders = new Set<string>();
      for (const t of nftTransfers) {
        const to = t.to.toLowerCase();
        const from = t.from.toLowerCase();
        if (from !== ZERO && holders.has(from)) holders.delete(from);
        if (to !== ZERO) holders.add(to);
      }
      uniqueHolders = holders.size;
    } catch (err) {
      log("WARN", "fetchCertificateStats", "Erro ao buscar transferências NFT", { error: (err as Error).message });
    }

    log("OK", "fetchCertificateStats", "Estatísticas de certificados obtidas", {
      totalCertificates,
      phases: phases.length,
      uniqueHolders,
    });

    return {
      totalCertificates,
      phaseCount,
      currentPhaseId,
      phases,
      uniqueHolders,
      contractAddress: certAddr,
    };
  } catch (err) {
    log("ERROR", "fetchCertificateStats", "Falha ao consultar certificados", { error: (err as Error).message });
    return null;
  }
}

// ── Metrics computation ───────────────────────────────────────────────

function toNum(v: bigint): number {
  return Number(formatUnits(v, DECIMALS));
}

function computeMetrics(
  csvRecords: AirdropRecord[],
  onChainHolders: OnChainHolder[],
  totalSupply: bigint,
  certStats: CertificateStats | null,
): CampaignMetrics {
  const totalDistributedCsv = csvRecords.reduce((s, r) => s + r.quantity, 0);
  const csvRecordCount = csvRecords.length;
  const onChainHoldersCount = onChainHolders.length;
  const progressPct = TARGET_ACCOUNTS > 0 ? (onChainHoldersCount / TARGET_ACCOUNTS) * 100 : 0;
  const gap = Math.max(0, TARGET_ACCOUNTS - onChainHoldersCount);

  const csvAddresses = new Set(csvRecords.filter((r) => r.isResolvable).map((r) => r.address));
  const onChainAddresses = new Set(onChainHolders.map((h) => h.address));
  let retained = 0;
  for (const addr of csvAddresses) {
    if (onChainAddresses.has(addr)) retained++;
  }
  const retentionRate = csvAddresses.size > 0 ? (retained / csvAddresses.size) * 100 : 0;

  const groupDistribution = new Map<string, number>();
  for (const r of csvRecords) {
    const group = r.group || "Sem grupo";
    groupDistribution.set(group, (groupDistribution.get(group) ?? 0) + r.quantity);
  }

  return {
    totalDistributedCsv,
    csvRecordCount,
    onChainHolders: onChainHoldersCount,
    onChainHoldersList: onChainHolders,
    progressPct,
    gap,
    retentionRate,
    uniqueAddressesInCsv: csvAddresses.size,
    groupDistribution,
    certificates: certStats ?? undefined,
  };
}

// ── AI suggestion generator (OpenRouter) ──────────────────────────────

async function generateAiSuggestion(
  phase: PhaseInfo,
  metrics: CampaignMetrics,
  totalSupply: bigint,
  anon: AnonConfig,
): Promise<string> {
  if (!AI_API_KEY || !AI_MODEL) {
    log("WARN", "generateAiSuggestion", "AI_API_KEY/AI_MODEL ausentes; pulando sugestão IA");
    return "<p><em>Sugestão de IA indisponível: configure AI_API_KEY e AI_MODEL no .env.</em></p>";
  }

  const groupSummary = [...metrics.groupDistribution.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([g, q]) => `${anonGroupLabel(g, anon.level)}: ${q.toFixed(2)} CAS`)
    .join(" | ");

  const certSummary = metrics.certificates
    ? `\n- Certificados NFT emitidos: ${metrics.certificates.totalCertificates}\n- Holders de certificado únicos: ${metrics.certificates.uniqueHolders}\n- Fases de certificado: ${metrics.certificates.phaseCount}\n- Fase atual: ${metrics.certificates.currentPhaseId > 0 ? metrics.certificates.phases.find(p => p.id === metrics.certificates!.currentPhaseId)?.name || "N/A" : "Nenhuma ativa"}\n- Emitidos por fase: ${metrics.certificates.phases.map(p => `${p.name} (${p.id}): ${p.minted}`).join(", ") || "nenhuma"}\n- Engajamento (cert/holders on-chain): ${metrics.onChainHolders > 0 ? (metrics.certificates.uniqueHolders / metrics.onChainHolders * 100).toFixed(1) : "0"}%`
    : "\n- Certificados NFT: dados não disponíveis";

  const prompt = `Você é um estrategista sênior de marketing cripto e growth hacking assessorando a Rapport Tecnologia no projeto Agentic Space.
O token CAS (Chain: Polygon Mainnet, endereço: ${CAS_TOKEN_ADDRESS}) está em campanha de AirDrop com meta de ${TARGET_ACCOUNTS} contas (holders on-chain com saldo > 0).

FASE ATUAL: ${phase.id} — ${phase.name}
Descrição da fase: ${phase.description}

DADOS ATUAIS:
- Meta de contas: ${TARGET_ACCOUNTS}
- Holders on-chain reais (saldo > 0): ${metrics.onChainHolders}
- Progresso: ${metrics.progressPct.toFixed(2)}% da meta
- Gap restante: ${metrics.gap} contas
- Total distribuído no CSV: ${metrics.totalDistributedCsv.toFixed(2)} CAS
- Registros no CSV: ${metrics.csvRecordCount}
- Endereços únicos resolvíveis no CSV: ${metrics.uniqueAddressesInCsv}
- Taxa de retenção (CSV → on-chain): ${metrics.retentionRate.toFixed(2)}%
- Supply total: ${toNum(totalSupply).toFixed(0)} CAS
- Distribuição por grupo: ${groupSummary || "nenhum grupo registrado"}
- Dados de certificados NFT (engajamento):${certSummary}

${phase.id === 0 ? "CONTEXTO: A distribuição gratuita já foi executada. Avalie os resultados e sugira ações para a próxima fase. Os certificados NFT (RapportCertificate, ERC-721 + ERC-6551 TBA) são a principal métrica de engajamento — cada certificado requer aporte de 50 CAS e gera uma Token Bound Account." : ""}
${phase.id === 1 ? "CONTEXTO: Nova campanha de certificados (RapportCertificate, ERC-721 + ERC-6551). Cada certificado requer aporte de 50 CAS. Ênfase em treinamentos e desafios. Sugira estratégias para atrair e engajar novos usuários via certificados. Use os dados de certificados emitidos para avaliar o engajamento real." : ""}
${phase.id >= 2 ? "CONTEXTO: Fase futura e genérica. Sugira estratégias inovadoras para expandir a base de usuários e consolidar o token CAS no ecossistema. Considere os dados de certificados NFT como métrica de engajamento." : ""}

Produza em português, em formato HTML simples (apenas <h3>, <p>, <ul>, <li>, <strong>, <table>, <tr>, <td>, <th>), sem markdown:
1. <h3>Diagnóstico da Fase</h3> — avaliação objetiva do progresso atual contra a meta.
2. <h3>Pontos Fortes</h3> — o que está funcionando bem.
3. <h3>Gaps e Riscos</h3> — o que precisa de atenção imediata.
4. <h3>Recomendações Estratégicas</h3> — ações concretas e priorizadas para esta fase.
5. <h3>Próximos Passos</h3> — orientações práticas para o administrador executar agora.
Seja específico com os números fornecidos.`;

  const FALLBACK_MODELS = [
    "google/gemini-2.5-flash-lite",
    "meta-llama/llama-3.3-70b-instruct",
    "google/gemma-3-27b-it",
    "deepseek/deepseek-r1",
    "meta-llama/llama-3.2-3b-instruct",
    "qwen/qwen-2.5-7b-instruct:free",
    "mistralai/mistral-7b-instruct:free",
  ];
  const modelsToTry = [AI_MODEL, ...FALLBACK_MODELS.filter((m) => m !== AI_MODEL)];

  for (const tryModel of modelsToTry) {
    log("INFO", "generateAiSuggestion", "Chamando OpenRouter", { model: tryModel });
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${AI_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://agenticspace.rapport.tec.br",
          "X-Title": "AirDrop CAS Campaign Report",
        },
        body: JSON.stringify({
          model: tryModel,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.3,
          max_tokens: 4096,
        }),
      });
      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`HTTP ${res.status}: ${errBody.slice(0, 200)}`);
      }
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const content = data.choices?.[0]?.message?.content?.trim();
      if (!content) throw new Error("Resposta vazia do modelo");
      if (content.length < 100 || /^user safety/i.test(content)) {
        throw new Error(`Resposta insuficiente ou filtro de segurança (${content.length} chars): ${content.slice(0, 80)}`);
      }
      log("OK", "generateAiSuggestion", "Sugestão IA recebida", { model: tryModel, chars: content.length });
      return markdownToHtml(content);
    } catch (err) {
      log("WARN", "generateAiSuggestion", "Modelo falhou, tentando próximo", {
        model: tryModel,
        error: (err as Error).message,
      });
    }
  }

  log("WARN", "generateAiSuggestion", "Todos os modelos OpenRouter falharam, tentando Ollama local", { model: OLLAMA_MODEL, baseUrl: OLLAMA_BASE_URL });
  const ollamaHtml = await generateOllamaSuggestion(phase, metrics, totalSupply, anon);
  return ollamaHtml;
}

// ── Ollama local fallback ─────────────────────────────────────────────

async function generateOllamaSuggestion(
  phase: PhaseInfo,
  metrics: CampaignMetrics,
  totalSupply: bigint,
  anon: AnonConfig,
): Promise<string> {
  if (!OLLAMA_MODEL) {
    log("ERROR", "generateOllamaSuggestion", "OLLAMA_MODEL não configurado");
    return "<p><em>Falha ao gerar sugestão IA: OpenRouter indisponível e Ollama não configurado.</em></p>";
  }

  const groupSummary = [...metrics.groupDistribution.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([g, q]) => `${anonGroupLabel(g, anon.level)}: ${q.toFixed(2)} CAS`)
    .join(" | ");

  const certSummary = metrics.certificates
    ? `\n- Certificados NFT emitidos: ${metrics.certificates.totalCertificates}\n- Holders de certificado únicos: ${metrics.certificates.uniqueHolders}\n- Fases de certificado: ${metrics.certificates.phaseCount}\n- Fase atual: ${metrics.certificates.currentPhaseId > 0 ? metrics.certificates.phases.find(p => p.id === metrics.certificates!.currentPhaseId)?.name || "N/A" : "Nenhuma ativa"}\n- Emitidos por fase: ${metrics.certificates.phases.map(p => `${p.name} (${p.id}): ${p.minted}`).join(", ") || "nenhuma"}\n- Engajamento (cert/holders on-chain): ${metrics.onChainHolders > 0 ? (metrics.certificates.uniqueHolders / metrics.onChainHolders * 100).toFixed(1) : "0"}%`
    : "\n- Certificados NFT: dados não disponíveis";

  const prompt = `Você é um estrategista sênior de marketing cripto e growth hacking assessorando a Rapport Tecnologia no projeto Agentic Space.
O token CAS (Chain: Polygon Mainnet) está em campanha de AirDrop com meta de ${TARGET_ACCOUNTS} contas (holders on-chain com saldo > 0).

FASE ATUAL: ${phase.id} — ${phase.name}
Descrição da fase: ${phase.description}

DADOS ATUAIS:
- Meta de contas: ${TARGET_ACCOUNTS}
- Holders on-chain reais (saldo > 0): ${metrics.onChainHolders}
- Progresso: ${metrics.progressPct.toFixed(2)}% da meta
- Gap restante: ${metrics.gap} contas
- Total distribuído no CSV: ${metrics.totalDistributedCsv.toFixed(2)} CAS
- Registros no CSV: ${metrics.csvRecordCount}
- Endereços únicos resolvíveis no CSV: ${metrics.uniqueAddressesInCsv}
- Taxa de retenção (CSV → on-chain): ${metrics.retentionRate.toFixed(2)}%
- Supply total: ${toNum(totalSupply).toFixed(0)} CAS
- Distribuição por grupo: ${groupSummary || "nenhum grupo registrado"}
- Dados de certificados NFT (engajamento):${certSummary}

${phase.id === 0 ? "CONTEXTO: A distribuição gratuita já foi executada. Avalie os resultados e sugira ações para a próxima fase. Os certificados NFT (RapportCertificate, ERC-721 + ERC-6551 TBA) são a principal métrica de engajamento — cada certificado requer aporte de 50 CAS e gera uma Token Bound Account." : ""}
${phase.id === 1 ? "CONTEXTO: Nova campanha de certificados (RapportCertificate, ERC-721 + ERC-6551). Cada certificado requer aporte de 50 CAS. Ênfase em treinamentos e desafios. Sugira estratégias para atrair e engajar novos usuários via certificados. Use os dados de certificados emitidos para avaliar o engajamento real." : ""}
${phase.id >= 2 ? "CONTEXTO: Fase futura e genérica. Sugira estratégias inovadoras para expandir a base de usuários e consolidar o token CAS no ecossistema. Considere os dados de certificados NFT como métrica de engajamento." : ""}

Produza em português, em formato HTML simples (apenas <h3>, <p>, <ul>, <li>, <strong>, <table>, <tr>, <td>, <th>), sem markdown:
1. <h3>Diagnóstico da Fase</h3> — avaliação objetiva do progresso atual contra a meta.
2. <h3>Pontos Fortes</h3> — o que está funcionando bem.
3. <h3>Gaps e Riscos</h3> — o que precisa de atenção imediata.
4. <h3>Recomendações Estratégicas</h3> — ações concretas e priorizadas para esta fase.
5. <h3>Próximos Passos</h3> — orientações práticas para o administrador executar agora.
Seja específico com os números fornecidos.`;

  log("INFO", "generateOllamaSuggestion", "Chamando Ollama local", { model: OLLAMA_MODEL, baseUrl: OLLAMA_BASE_URL });

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    const res = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt,
        stream: false,
        options: { temperature: 0.3, num_predict: 4096 },
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`HTTP ${res.status}: ${errBody.slice(0, 200)}`);
    }

    const data = (await res.json()) as { response?: string };
    const content = data.response?.trim();
    if (!content) throw new Error("Resposta vazia do Ollama");
    if (content.length < 100 || /^user safety/i.test(content)) {
      throw new Error(`Resposta insuficiente do Ollama (${content.length} chars)`);
    }

    log("OK", "generateOllamaSuggestion", "Sugestão IA recebida via Ollama", { model: OLLAMA_MODEL, chars: content.length });
    return markdownToHtml(content);
  } catch (err) {
    log("ERROR", "generateOllamaSuggestion", "Ollama falhou", { model: OLLAMA_MODEL, error: (err as Error).message });
    return `<p><em>Falha ao gerar sugestão IA: OpenRouter indisponível (sem créditos) e Ollama local falhou (${escapeHtml((err as Error).message)}). Verifique se o Ollama está rodando com o modelo ${escapeHtml(OLLAMA_MODEL)}.</em></p>`;
  }
}

// ── HTML helpers ───────────────────────────────────────────────────────

function fmt(v: number, digits = 2): string {
  return v.toLocaleString("pt-BR", { maximumFractionDigits: digits });
}

function shortAddr(a: string): string {
  if (a.length < 12) return a;
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

function markdownToHtml(md: string): string {
  let html = md;
  html = html.replace(/```[\s\S]*?```/g, (m) => `<pre><code>${escapeHtml(m.replace(/```/g, "").trim())}</code></pre>`);
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");

  const lines = html.split("\n");
  const result: string[] = [];
  let inUl = false;
  let inOl = false;
  let inTable = false;
  let tableHeaderDone = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      const cells = trimmed.slice(1, -1).split("|").map((c) => c.trim());
      const isSeparator = cells.every((c) => /^[-:]+$/.test(c));

      if (isSeparator) {
        tableHeaderDone = true;
        continue;
      }

      if (!inTable) {
        result.push("<table>");
        inTable = true;
        tableHeaderDone = false;
      }

      const tag = !tableHeaderDone ? "th" : "td";
      if (!tableHeaderDone) {
        result.push("<thead><tr>");
      } else if (tableHeaderDone && !result[result.length - 1]?.includes("<tbody>")) {
        result.push("<tbody>");
      }
      result.push(`<tr>${cells.map((c) => `<${tag}>${c}</${tag}>`).join("")}</tr>`);
      if (!tableHeaderDone) {
        result.push("</tr></thead>");
      }
      continue;
    }

    if (inTable) {
      if (result[result.length - 1]?.includes("<tbody>")) {
        result.push("</tbody>");
      }
      result.push("</table>");
      inTable = false;
      tableHeaderDone = false;
    }

    const ulMatch = line.match(/^\s*[-*]\s+(.+)/);
    const olMatch = line.match(/^\s*\d+\.\s+(.+)/);
    if (ulMatch) {
      if (!inUl) { result.push("<ul>"); inUl = true; }
      if (inOl) { result.push("</ol>"); inOl = false; }
      result.push(`<li>${ulMatch[1]}</li>`);
    } else if (olMatch) {
      if (!inOl) { result.push("<ol>"); inOl = true; }
      if (inUl) { result.push("</ul>"); inUl = false; }
      result.push(`<li>${olMatch[1]}</li>`);
    } else {
      if (inUl) { result.push("</ul>"); inUl = false; }
      if (inOl) { result.push("</ol>"); inOl = false; }
      if (trimmed && !/^<(h\d|pre|ul|ol|li|table|thead|tbody|tr|th|td|p|strong|em|code)/.test(trimmed)) {
        result.push(`<p>${trimmed}</p>`);
      } else if (trimmed) {
        result.push(trimmed);
      }
    }
  }
  if (inUl) result.push("</ul>");
  if (inOl) result.push("</ol>");
  if (inTable) {
    if (result[result.length - 1]?.includes("<tbody>")) result.push("</tbody>");
    result.push("</table>");
  }
  return result.join("\n");
}

function polyScanLink(addr: string, label?: string): string {
  const text = label ?? addr;
  return `<a href="https://polygonscan.com/address/${addr}" target="_blank" style="color:#fcc650;text-decoration:none;"><code>${text}</code></a>`;
}

// ── HTML report builder ───────────────────────────────────────────────

function buildHtml(
  phase: PhaseInfo,
  metrics: CampaignMetrics,
  csvRecords: AirdropRecord[],
  aiHtml: string,
  totalSupply: bigint,
  anon: AnonConfig,
): string {
  const now = new Date().toLocaleString("pt-BR");
  const progressColor = metrics.progressPct >= 75 ? "#F05F40" : metrics.progressPct >= 50 ? "#fcc650" : "#eb3812";

  const anonLevel = anon.level;
  const partnerRows = csvRecords.length
    ? csvRecords
        .map(
          (r, idx) => `<tr${!r.isResolvable ? ' class="alert-row"' : ""}>
      <td>${escapeHtml(anonName(r.name, idx, anonLevel))}</td>
      <td>${escapeHtml(anonGroup(r.group, anonLevel))}</td>
      <td>${escapeHtml(anonIndication(r.indication, anonLevel))}</td>
      <td data-sort="${r.dateSort}">${escapeHtml(r.date || "—")}</td>
      <td>${anonAddress(r.address, r.rawAddress, r.isResolvable, anonLevel)}</td>
      <td data-sort="${r.quantity}">${fmt(r.quantity, 4)} CAS</td>
      <td>${r.isResolvable ? "✅ On-chain" : "⚠️ Pendente"}</td>
      <td style="font-size:.8rem;color:var(--muted);max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(anonObservation(r.observation, anonLevel))}">${escapeHtml(anonObservation(r.observation, anonLevel))}</td>
    </tr>`,
        )
        .join("")
    : `<tr><td colspan="8" style="text-align:center;color:#F05F40">Nenhum registro encontrado no CSV de airdrop</td></tr>`;

  const groupLabels = [...metrics.groupDistribution.keys()].map((g) => anonGroupLabel(g, anonLevel));
  const groupData = [...metrics.groupDistribution.values()].map((v) => Math.round(v * 100) / 100);

  const topHolders = metrics.onChainHoldersList.slice(0, 20);
  const holderRows = topHolders.length
    ? topHolders
        .map(
          (h, i) => `<tr>
      <td data-sort="${i + 1}">${i + 1}</td>
      <td>${anonHolderAddress(h.address, anonLevel)}</td>
      <td data-sort="${toNum(h.balance)}">${fmt(toNum(h.balance))} CAS</td>
      <td>${totalSupply > 0n ? ((Number((h.balance * 1000000n) / totalSupply) / 10000)).toFixed(4) : "0"}%</td>
    </tr>`,
        )
        .join("")
    : `<tr><td colspan="4" style="text-align:center;color:#F05F40">Nenhum holder on-chain encontrado</td></tr>`;

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AirDrop CAS — Relatório de Campanha · Fase ${phase.id} (${escapeHtml(phase.name)})</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<style>
  :root {
    --bg:#222222; --card:#712d23; --border:rgba(255,255,255,0.15);
    --text:#ffffff; --muted:#f7d4ca; --accent:#F05F40; --accent-hover:#eb3812;
    --blue:#fcc650; --bronze:#cc7501; --wine:#712d23; --coral:#ce6e6d;
    --peach:#f7d4ca; --deep-black:#070404;
  }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { background:var(--bg); color:var(--text); font-family:'Segoe UI',system-ui,sans-serif; padding:24px; }
  h1 { font-size:1.6rem; margin-bottom:4px; color:var(--accent); }
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
  td a { color:var(--blue); text-decoration:none; }
  .alert-row { background:rgba(235,56,18,.12); }
  .badge { display:inline-block; padding:4px 12px; border-radius:999px; font-weight:700; font-size:.85rem; }
  canvas { max-height:340px; }
  footer { margin-top:32px; color:var(--muted); font-size:.8rem; text-align:center; }
  .progress-bar-container { background:var(--deep-black); border-radius:12px; height:32px; overflow:hidden; border:1px solid var(--border); margin:16px 0; }
  .progress-bar-fill { height:100%; border-radius:12px; transition:width .6s ease; display:flex; align-items:center; justify-content:flex-end; padding-right:12px; font-weight:700; font-size:.85rem; color:#fff; }
  .phase-badge { display:inline-block; padding:6px 16px; border-radius:999px; font-weight:700; font-size:1rem; background:var(--accent); color:#fff; }
  @media print {
    body { background:#fff !important; color:#222222 !important; padding:12px !important; -webkit-print-color-adjust:exact !important; print-color-adjust:exact !important; }
    .card { background:#f7d4ca !important; border:1px solid rgba(34,34,34,0.15) !important; }
    .kpi { background:#f7d4ca !important; border:1px solid rgba(34,34,34,0.15) !important; }
    .kpi .v { color:#222222 !important; }
    .kpi .l { color:#712d23 !important; }
    h1, h2, h3 { color:#222222 !important; }
    h2 { color:#F05F40 !important; }
    h3 { color:#cc7501 !important; }
    .sub { color:#712d23 !important; }
    th { color:#712d23 !important; }
    td { color:#222222 !important; }
    td a { color:#cc7501 !important; }
    .alert-row { background:rgba(235,56,18,.08) !important; }
    .progress-bar-container { background:#e0e0e0 !important; }
    .progress-bar-fill { color:#222222 !important; }
    canvas { max-height:280px !important; }
    footer { color:#712d23 !important; }
  }
</style>
</head>
<body>

<h1>🪙 AirDrop CAS — Relatório de Campanha</h1>
<p class="sub">
  <span class="phase-badge">Fase ${phase.id}: ${escapeHtml(phase.name)}</span> ·
  Token: <a href="https://polygonscan.com/token/${CAS_TOKEN_ADDRESS}" target="_blank">${CAS_TOKEN_ADDRESS}</a> ·
  Polygon Mainnet (137) · Gerado em ${now} ·
  Fonte: Polygonscan + CSV de distribuição${anonLevel !== AnonLevel.NONE ? ` · <span class="badge" style="background:#fcc65022;color:#cc7501">🔒 LGPD: ${anonLevel === AnonLevel.FULL ? "Anonimato total" : "Pseudonimizado"}</span>` : ""}
</p>

<div class="kpis">
  <div class="kpi"><div class="v">${TARGET_ACCOUNTS}</div><div class="l">Meta de contas</div></div>
  <div class="kpi"><div class="v" style="color:${progressColor}">${metrics.onChainHolders}</div><div class="l">Holders on-chain reais</div></div>
  <div class="kpi"><div class="v" style="color:${progressColor}">${metrics.progressPct.toFixed(2)}%</div><div class="l">Progresso da meta</div></div>
  <div class="kpi"><div class="v">${metrics.gap}</div><div class="l">Gap restante</div></div>
  <div class="kpi"><div class="v">${fmt(metrics.totalDistributedCsv, 2)}</div><div class="l">CAS distribuídos (CSV)</div></div>
  <div class="kpi"><div class="v">${metrics.csvRecordCount}</div><div class="l">Registros no CSV</div></div>
  <div class="kpi"><div class="v">${metrics.uniqueAddressesInCsv}</div><div class="l">Endereços únicos (CSV)</div></div>
  <div class="kpi"><div class="v">${metrics.retentionRate.toFixed(1)}%</div><div class="l">Taxa de retenção</div></div>
  <div class="kpi"><div class="v">${fmt(toNum(totalSupply), 0)}</div><div class="l">Supply total (CAS)</div></div>
</div>

${metrics.certificates ? `
<div class="kpis" style="margin-top:8px">
  <div class="kpi"><div class="v" style="color:#fcc650">${metrics.certificates.totalCertificates}</div><div class="l">Certificados NFT emitidos</div></div>
  <div class="kpi"><div class="v" style="color:#fcc650">${metrics.certificates.uniqueHolders}</div><div class="l">Holders de certificado únicos</div></div>
  <div class="kpi"><div class="v">${metrics.certificates.phaseCount}</div><div class="l">Fases de certificado</div></div>
  <div class="kpi"><div class="v">${metrics.certificates.currentPhaseId > 0 ? escapeHtml(metrics.certificates.phases.find(p => p.id === metrics.certificates!.currentPhaseId)?.name || "—") : "Nenhuma ativa"}</div><div class="l">Fase atual</div></div>
  <div class="kpi"><div class="v">${metrics.certificates.phases.reduce((s, p) => s + p.minted, 0)}</div><div class="l">Total emitido (somatório)</div></div>
</div>
` : ""}

<div class="card full">
  <h3>Progresso da Campanha — Meta: ${TARGET_ACCOUNTS} contas</h3>
  <div class="progress-bar-container">
    <div class="progress-bar-fill" style="width:${Math.min(metrics.progressPct, 100)}%;background:${progressColor};">
      ${metrics.progressPct.toFixed(1)}%
    </div>
  </div>
  <p><strong>Alcançado:</strong> ${metrics.onChainHolders} de ${TARGET_ACCOUNTS} contas · <strong>Faltam:</strong> ${metrics.gap} contas · <strong>Taxa de retenção CSV→on-chain:</strong> ${metrics.retentionRate.toFixed(2)}%</p>
  <p style="margin-top:8px"><strong>Descrição da fase:</strong> ${escapeHtml(phase.description)}</p>
</div>

<div class="grid">
  <div class="card">
    <h3>Distribuição por Grupo (CAS)</h3>
    <canvas id="groupChart"></canvas>
  </div>
  <div class="card">
    <h3>Progresso vs Meta</h3>
    <canvas id="progressChart"></canvas>
  </div>
</div>

<div class="card full" style="margin-top:16px">
  <h3>🤝 Parceiros do AirDrop (CSV)</h3>
  <table id="partners-table">
    <thead><tr><th>Parceiro</th><th>Grupo</th><th>Indicação</th><th>Data</th><th>Endereço</th><th>Qtd. (CAS)</th><th>Status</th><th>Observação</th></tr></thead>
    <tbody>${partnerRows}</tbody>
  </table>
</div>

${metrics.certificates ? `
<div class="card full" style="margin-top:16px">
  <h3>🎓 Certificados NFT (Engajamento) — RapportCertificate</h3>
  <p style="margin-bottom:12px"><strong>Contrato:</strong> ${anonHolderAddress(metrics.certificates.contractAddress, anonLevel)} · <strong>ERC-721 + ERC-6551 (TBA)</strong></p>
  <table id="cert-phases-table">
    <thead><tr><th>Fase</th><th>Nome</th><th>Depósito mín. (CAS)</th><th>Emitidos</th><th>Status</th><th>Início</th><th>Fim</th></tr></thead>
    <tbody>
      ${metrics.certificates.phases.map(p => `<tr${p.active ? ' style="background:rgba(240,95,64,0.08)"' : ""}>
        <td>${p.id}</td>
        <td>${escapeHtml(p.name)}</td>
        <td>${fmt(toNum(p.minCasDeposit), 0)}</td>
        <td>${p.minted}</td>
        <td>${p.active ? "✅ Ativa" : "⏸️ Inativa"}</td>
        <td>${p.startsAt > 0 ? new Date(p.startsAt * 1000).toLocaleDateString("pt-BR") : "—"}</td>
        <td>${p.endsAt > 0 ? new Date(p.endsAt * 1000).toLocaleDateString("pt-BR") : "—"}</td>
      </tr>`).join("")}
    </tbody>
  </table>
  <p style="margin-top:12px"><strong>Engajamento:</strong> ${metrics.certificates.uniqueHolders} usuários únicos possuem certificados NFT. ${metrics.certificates.totalCertificates > 0 ? `Isso representa ${(metrics.certificates.uniqueHolders / metrics.certificates.totalCertificates * 100).toFixed(1)}% de unicidade (1 certificado por usuário por fase).` : "Nenhum certificado emitido ainda."}</p>
  <p><strong>Relação com meta AirDrop:</strong> ${metrics.certificates.uniqueHolders} de ${metrics.onChainHolders} holders on-chain (${metrics.onChainHolders > 0 ? (metrics.certificates.uniqueHolders / metrics.onChainHolders * 100).toFixed(1) : "0"}%) possuem certificados, indicando engajamento ativo no ecossistema.</p>
</div>
` : ""}

<div class="card full" style="margin-top:16px">
  <h3>🏆 Top 20 Holders On-Chain</h3>
  <table id="holders-table">
    <thead><tr><th>#</th><th>Endereço</th><th>Saldo (CAS)</th><th>% Supply</th></tr></thead>
    <tbody>${holderRows}</tbody>
  </table>
</div>

<div class="card full" style="margin-top:16px">
  <h3>🤖 Sugestões da IA</h3>
  ${aiHtml}
</div>

<footer>AirDrop CAS Campaign Report · Agentic Space · Rapport Tecnologia · dados on-chain via Polygonscan · uso interno do admin/operadores</footer>

<script>
const groupLabels = ${JSON.stringify(groupLabels)};
const groupData = ${JSON.stringify(groupData)};
const progressPct = ${metrics.progressPct};
const onChainHolders = ${metrics.onChainHolders};
const gap = ${metrics.gap};
const targetAccounts = ${TARGET_ACCOUNTS};

Chart.defaults.color = '#f7d4ca';
Chart.defaults.borderColor = 'rgba(255,255,255,0.15)';

new Chart(document.getElementById('groupChart'), {
  type: 'bar',
  data: {
    labels: groupLabels,
    datasets: [{
      label: 'CAS distribuído',
      data: groupData,
      backgroundColor: ['#F05F40','#fcc650','#cc7501','#eb3812','#ce6e6d','#f7d4ca','#d4502e','#b5651d','#fdd97a','#d9908f','#fae5df','#ff7a5c','#e89642','#ffd98a','#f54020','#c43d18','#8a3a2c','#5d3a32','#eb6b4a','#e07a3a','#d49a5a'],
      borderWidth: 0,
    }],
  },
  options: {
    responsive: true,
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { maxRotation: 45, minRotation: 0, font: { size: 10 } } },
      y: { beginAtZero: true, ticks: { callback: (v) => v + ' CAS' } },
    },
  },
});

new Chart(document.getElementById('progressChart'), {
  type: 'doughnut',
  data: {
    labels: ['Alcançado', 'Gap'],
    datasets: [{
      data: [onChainHolders, gap],
      backgroundColor: ['#F05F40', 'rgba(255,255,255,0.15)'],
      borderWidth: 0,
    }],
  },
  options: {
    responsive: true,
    cutout: '65%',
    plugins: {
      legend: { position: 'bottom' },
      tooltip: {
        callbacks: {
          label: (ctx) => ctx.label + ': ' + ctx.parsed + ' contas (' + ((ctx.parsed / targetAccounts) * 100).toFixed(1) + '%)',
        },
      },
    },
  },
});
</script>

</body>
</html>`;
}

// ── Main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const allArgs = process.argv.slice(2);
  const positionalArgs = allArgs.filter((a) => !a.startsWith("--"));
  const anon = parseAnonArgs(allArgs);

  const phaseArg = positionalArgs[0];
  if (phaseArg === undefined) {
    log("ERROR", "main", "Parâmetro de fase é obrigatório. Uso: npx tsx scripts/analysis/airdrop_campaign_report.ts <fase> [--anon [--anon]]");
    process.exit(1);
  }

  const phaseId = parseInt(phaseArg, 10);
  if (isNaN(phaseId) || phaseId < 0) {
    log("ERROR", "main", "Fase inválida. Use um número inteiro >= 0", { input: phaseArg });
    process.exit(1);
  }

  const anonLabel = anon.level === AnonLevel.FULL ? "TOTAL" : anon.level === AnonLevel.PSEUDONYMIZED ? "PSEUDONIMIZADO" : "DESATIVADO";
  log("INFO", "main", "Nível de anonimização (LGPD)", { level: anonLabel });

  const phase = getPhaseInfo(phaseId);
  log("INFO", "main", "Iniciando relatório de AirDrop", { phase: phase.id, name: phase.name });

  if (!CAS_TOKEN_ADDRESS) {
    log("ERROR", "main", "CAS_TOKEN_ADDRESS não configurado no .env");
    process.exit(1);
  }
  if (!POLYGONSCAN_API_KEY) {
    log("ERROR", "main", "POLYGONSCAN_API_KEY não configurado no .env");
    process.exit(1);
  }

  const csvRecords = loadAirdropCsv(DATA_DIR);
  log("INFO", "main", "CSV carregado", { records: csvRecords.length });

  log("INFO", "main", "Consultando on-chain via Polygonscan");
  const transfers = await fetchAllTransfers(CAS_TOKEN_ADDRESS);
  const totalSupply = await fetchTotalSupply(CAS_TOKEN_ADDRESS);
  const onChainHolders = computeHolders(transfers, totalSupply);
  log("OK", "main", "Dados on-chain obtidos", {
    transfers: transfers.length,
    holders: onChainHolders.length,
    totalSupply: toNum(totalSupply).toFixed(0),
  });

  log("INFO", "main", "Consultando certificados NFT (engajamento)");
  const certStats = await fetchCertificateStats();
  if (certStats) {
    log("OK", "main", "Certificados obtidos", {
      total: certStats.totalCertificates,
      holders: certStats.uniqueHolders,
      phases: certStats.phases.length,
    });
  }

  const metrics = computeMetrics(csvRecords, onChainHolders, totalSupply, certStats);
  log("OK", "main", "Métricas calculadas", {
    onChainHolders: metrics.onChainHolders,
    progressPct: metrics.progressPct.toFixed(2),
    gap: metrics.gap,
    retentionRate: metrics.retentionRate.toFixed(2),
  });

  log("INFO", "main", "Gerando sugestões da IA", { model: AI_MODEL });
  const aiHtml = await generateAiSuggestion(phase, metrics, totalSupply, anon);

  const html = buildHtml(phase, metrics, csvRecords, aiHtml, totalSupply, anon);

  if (!fs.existsSync(REPORTS_DIR)) {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
  }

  const dateStr = new Date().toISOString().slice(0, 10);
  const anonSuffix = anon.level === AnonLevel.FULL ? "_anon" : anon.level === AnonLevel.PSEUDONYMIZED ? "_pseudo" : "";
  const fileName = `airdrop_campaign_phase${phaseId}${anonSuffix}_${dateStr}.html`;
  const filePath = path.join(REPORTS_DIR, fileName);

  fs.writeFileSync(filePath, html, "utf-8");
  log("OK", "main", "Relatório gerado", { file: filePath });

  console.log(`\n📊 Relatório: ${filePath}`);
  console.log(`   Fase: ${phase.id} — ${phase.name}`);
  console.log(`   Holders on-chain: ${metrics.onChainHolders}/${TARGET_ACCOUNTS} (${metrics.progressPct.toFixed(2)}%)`);
  console.log(`   Gap: ${metrics.gap} contas`);
  console.log(`   CAS distribuídos (CSV): ${metrics.totalDistributedCsv.toFixed(2)}`);
  console.log(`   Taxa de retenção: ${metrics.retentionRate.toFixed(2)}%`);

  openInBrowser(filePath);
}

function openInBrowser(filePath: string): void {
  const url = `file://${filePath}`;
  const platform = process.platform;
  let cmd: string;

  if (platform === "linux") {
    cmd = `xdg-open "${filePath}"`;
  } else if (platform === "darwin") {
    cmd = `open "${filePath}"`;
  } else if (platform === "win32") {
    cmd = `start "" "${filePath}"`;
  } else {
    log("WARN", "openInBrowser", "Plataforma não suportada para abertura automática", { platform });
    return;
  }

  log("INFO", "openInBrowser", "Abrindo relatório no navegador", { url });
  try {
    const { exec } = require("child_process");
    exec(cmd, (err: Error | null) => {
      if (err) {
        log("WARN", "openInBrowser", "Não foi possível abrir o navegador", { error: err.message });
      } else {
        log("OK", "openInBrowser", "Relatório aberto no navegador");
      }
    });
  } catch (err) {
    log("WARN", "openInBrowser", "Erro ao executar comando de abertura", { error: (err as Error).message });
  }
}

main().catch((err) => {
  log("ERROR", "main", "Erro fatal", { error: err.message });
  process.exit(1);
});
