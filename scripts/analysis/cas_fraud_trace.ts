/**
 * CAS Fraud Trace
 * ----------------
 * Rastreia relações e transações a partir de um endereço, nome ou índice
 * no banco SQLite, construindo um grafo 3D interativo (3d-force-graph) com
 * detecção de indícios de fraude.
 *
 * Uso:
 *   npm run analysis:cas:fraud -- 0xABC... [--depth 2] [--anon]
 *   npm run analysis:cas:fraud -- "Deployer" [--depth 3] [--anon --anon]
 *   npm run analysis:cas:fraud -- --index 5 [--depth 1]
 *   npm run analysis:cas:fraud -- 0xABC... "Ednardo" --index 3 [--depth 2]
 *   npm run analysis:cas:fraud -- --csv [--depth 2]
 *   npm run analysis:cas:fraud -- --csv outros.csv [--depth 2]
 *
 * Flags:
 *   --depth N   Profundidade da busca BFS (default: GRAPH_DEPTH_DEFAULT do .env)
 *   --anon      Oculta nomes/labels (1x). Com 2x, oculta também endereços.
 *   --index N   Busca por índice (rowid) na tabela addresses
 *   --use-db    Usa apenas o banco SQLite (sem sync via API)
 *   --csv [f]   Lê endereços de um CSV. Sem argumento, usa data/fraude.csv.
 *               Com caminho, lê o arquivo especificado. Detecta a coluna de
 *               endereços automaticamente via heurística semântica.
 *
 * Sync automático:
 *   Por padrão, sincroniza transferências e pool creators via Polygonscan
 *   antes de rastrear. Use --use-db para pular o sync e usar apenas o banco.
 *
 * Requisitos de ambiente:
 *   smartcontracts/.env : POLYGONSCAN_API_KEY, CAS_TOKEN_ADDRESS (+ labels)
 */

import { formatUnits, WhitelistService } from "agentic_space_commons";
import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import dotenv from "dotenv";
import {
  getDB,
  closeDB,
  getAddress,
  getAllAddresses,
  searchAddresses,
  getAddressDetailsMap,
  getTransactionsByAddress,
  getAllTransactions,
  getPoolCreatorMap,
  resolveShortAddress,
  type AddressRecord,
  type TransactionRecord,
  type PoolCreationRecord,
} from "../utils/cas_database";
import { syncTransfers, syncPoolCreators, hasApiKey } from "../utils/cas_sync";
import { importAllCsvs, parseCsv, findHeaderRow, detectColumns } from "../utils/cas_csv_import";
import { detectManipulationSignals, type ManipulationSignal } from "../utils/cas_manipulation";
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

// ── Whitelist (innocent addresses — takes precedence over fraud listings) ──

const whitelist = WhitelistService.fromSmartContractsRoot(SC_ROOT);

// ── Structured logging ────────────────────────────────────────────────

type LogLevel = "INFO" | "WARN" | "ERROR" | "OK" | "DEBUG";

function log(level: LogLevel, fn: string, message: string, params?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const emoji = { INFO: "ℹ️", WARN: "⚠️", ERROR: "❌", OK: "✅", DEBUG: "🔍" }[level];
  const extra = params ? ` - ${JSON.stringify(params)}` : "";
  console.log(`[${ts}] [cas_fraud_trace:${fn}] ${emoji} ${message}${extra}`);
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

interface GraphAlert {
  type: string;
  severity: "ALTO" | "MODERADO" | "BAIXO";
  evidence: string;
  addresses: string[];
  heuristicScore: number;
  gnnScore: number;
  combinedScore: number;
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
  isTarget: boolean;
  depth: number;
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

interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  meta: {
    nodeCount: number;
    edgeCount: number;
    totalVolume: number;
    generatedAt: string;
    alertCount: number;
    target: string;
    depth: number;
  };
  alerts: GraphAlert[];
}

interface KnownAddress {
  label: string;
  isInfra: boolean;
  isContract: boolean;
  type: string;
  asset: string;
  observation: string;
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
  wallet: "👤", contract: "🏛️", token: "🪙", bridge: "🌉", wrapper: "🔁",
  dex: "💧", lp: "💧", faucet: "🚰", safe: "🔒", multisig: "🔒",
  migration: "🔄", diamond: "💎", proxy: "📡", lock: "🔐", reserve: "🛡️",
  fund: "🏦", router: "🛣️", manager: "🧰", factory: "🏭", certificate: "📜",
  tba: "🎒", pool_creator: "🏭", unknown: "❓",
};

function typeEmoji(type: string): string {
  return TYPE_EMOJIS[type?.toLowerCase()] ?? "❓";
}

const TYPE_SHAPES: Record<string, string> = {
  wallet: "dot", contract: "dot", token: "dot", bridge: "diamond",
  wrapper: "dot", dex: "dot", lp: "hexagon", faucet: "dot",
  safe: "square", multisig: "square", migration: "dot", diamond: "diamond",
  proxy: "dot", lock: "dot", reserve: "dot", fund: "dot",
  router: "triangle", manager: "square", factory: "triangleDown",
  certificate: "star", tba: "diamond", pool_creator: "triangleDown", unknown: "dot",
};

function nodeShape(type: string): string {
  return TYPE_SHAPES[type?.toLowerCase()] ?? "dot";
}

// ── Label resolution ──────────────────────────────────────────────────

function knownLabels(anonLevel: number): Map<string, KnownAddress> {
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

  if (anonLevel >= 1) {
    for (const [addr, info] of map) {
      map.set(addr, { ...info, label: "", observation: "" });
    }
    log("INFO", "knownLabels", "Modo anônimo ativo", { level: anonLevel, entries: map.size });
  }

  return map;
}

// ── Alert helpers ─────────────────────────────────────────────────────

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
  spoofing_layering: { label: "Spoofing/Layering", description: "Ordens falsas colocadas e canceladas rapidamente para criar falsa impressão de oferta/demanda." },
  lp_outflow: { label: "Saída de Liquidez (LP)", description: "Retirada expressiva de liquidez de pools, sinal de risco de rug pull." },
  top10_concentration: { label: "Concentração Top 10", description: "Alta concentração da oferta nos 10 maiores endereços, aumentando o risco de manipulação." },
  wash_trading: { label: "Wash Trading", description: "Negociação entre contas controladas pela mesma parte para simular volume e enganar o mercado." },
  whale_dump_pressure: { label: "Pressão de Venda de Baleias", description: "Grandes detentores movimentando ativos para vendas massivas, pressionando o preço." },
  rug_pull: { label: "Rug Pull", description: "Retirada fraudulenta de liquidez ou fundos por desenvolvedores/insiders." },
  short_and_distort: { label: "Short and Distort", description: "Venda a descoberto combinada à disseminação de notícias negativas para derrubar o preço." },
  whale_dump: { label: "Venda de Baleia", description: "Grande detentor vendendo uma quantidade massiva de tokens." },
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
      return `<li>${icon} <b style="color:${alertColor(a.severity)};">${formatTerm(a.type)}</b> (${a.severity}) — Score: ${(a.combinedScore * 100).toFixed(1)}%<br><span style="color:var(--muted);font-size:.75rem;">Heurística: ${(a.heuristicScore * 100).toFixed(1)}%</span><br>${a.evidence}</li>`;
    })
    .join("");
  return `<br><br><b style="color:#eb3812;">⚠️ Indícios de fraude detectados:</b><ul style="margin:4px 0;padding-left:16px;">${items}</ul>`;
}

function computeGraphAlerts(transfers: TokenTransfer[], tokenAddress: string, anonLevel: number): GraphAlert[] {
  const labels = knownLabels(anonLevel);
  const resolver = (addr: string) => {
    const info = labels.get(addr.toLowerCase());
    if (!info) return undefined;
    return { label: info.label, isInfra: info.isInfra, type: info.type };
  };
  const poolMap = getPoolCreatorMap();
  const dexPairs: { pairAddress?: string; liquidityUsd?: number; volume24h?: number; priceUsd?: number }[] = [];
  for (const [, creations] of poolMap) {
    for (const pc of creations) {
      dexPairs.push({ pairAddress: pc.pair_address.toLowerCase() });
    }
  }
  const market = {
    dexPairs,
    bestPair: dexPairs[0] ?? null,
  };
  const signals = detectManipulationSignals(
    transfers as any,
    resolver,
    market,
    tokenAddress,
    null,
    { lookbackDays: 0, washLookbackHours: 0, shortLookbackHours: 0 },
  );
  const filtered = signals.filter((s) => {
    const allWhitelisted = s.addresses.every((a) => whitelist.isWhitelisted(a));
    if (allWhitelisted && s.addresses.length > 0) {
      log("INFO", "computeGraphAlerts", "Alerta descartado — endereço(s) na whitelist", {
        type: s.type,
        addresses: s.addresses,
      });
      return false;
    }
    return true;
  });
  return filtered.map((s) => {
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

// ── Target resolution ─────────────────────────────────────────────────

function searchByName(query: string): AddressRecord[] {
  const db = getDB();
  const like = `%${query.toLowerCase()}%`;
  return db.prepare(
    "SELECT * FROM addresses WHERE name LIKE ? COLLATE NOCASE ORDER BY updated_at DESC",
  ).all(like) as AddressRecord[];
}

function resolveTarget(target: string): string | null {
  // Try as full address
  if (/^0x[0-9a-fA-F]{40}$/.test(target)) {
    const addr = target.toLowerCase();
    log("OK", "resolveTarget", "Endereço válido", { address: addr });
    return addr;
  }

  // Try as shortened address (e.g. 0xc590…c02b, 0xc590…, 0x…c02b)
  if (target.startsWith("0x") && (target.includes("…") || target.includes("..."))) {
    const resolved = resolveShortAddress(target);
    if (resolved) {
      log("OK", "resolveTarget", "Endereço encurtado resolvido", { input: target, address: resolved });
      return resolved;
    }
    log("WARN", "resolveTarget", "Endereço encurtado não encontrado no banco", { input: target });
  }

  // Try as integer index (rowid)
  const idx = parseInt(target, 10);
  if (!isNaN(idx) && String(idx) === target && idx > 0) {
    const all = getAllAddresses();
    if (idx <= all.length) {
      const record = all[idx - 1];
      log("OK", "resolveTarget", "Endereço por índice", { index: idx, address: record.address });
      return record.address;
    }
    log("WARN", "resolveTarget", "Índice fora do intervalo", { index: idx, total: all.length });
  }

  // Try as name search first (searchAddresses doesn't cover the name field)
  const nameResults = searchByName(target);
  if (nameResults.length > 0) {
    const best = nameResults[0];
    log("OK", "resolveTarget", "Endereço por nome", { query: target, address: best.address, name: best.name });
    return best.address;
  }

  // Try as label/notes search
  const results = searchAddresses(target);
  if (results.length > 0) {
    const best = results[0];
    log("OK", "resolveTarget", "Endereço por label/notes", { query: target, address: best.address, label: best.label });
    return best.address;
  }

  // Try getAddress directly (in case it's a non-checksummed address)
  const direct = getAddress(target);
  if (direct) {
    log("OK", "resolveTarget", "Endereço direto do DB", { address: direct.address });
    return direct.address;
  }

  log("ERROR", "resolveTarget", "Não foi possível resolver o alvo", { target });
  return null;
}

// ── BFS tracing ───────────────────────────────────────────────────────

interface TraceResult {
  transfers: TokenTransfer[];
  addressDepths: Map<string, number>;
}

function bfsTrace(seedAddrs: string[], maxDepth: number): TraceResult {
  const visited = new Set<string>(seedAddrs);
  const addressDepths = new Map<string, number>();
  for (const s of seedAddrs) addressDepths.set(s, 0);
  const allTransfers: TokenTransfer[] = [];
  const seenTxHashes = new Set<string>();
  let currentLevel = [...seedAddrs];

  log("INFO", "bfsTrace", "Iniciando BFS multi-alvo", { seeds: seedAddrs.length, maxDepth });

  for (let depth = 0; depth <= maxDepth; depth++) {
    if (currentLevel.length === 0) break;
    log("INFO", "bfsTrace", `Processando profundidade ${depth}`, { addresses: currentLevel.length });

    const nextLevel: string[] = [];

    for (const addr of currentLevel) {
      const txs = getTransactionsByAddress(addr);
      for (const tx of txs) {
        const txKey = `${tx.tx_hash}:${tx.from_address}:${tx.to_address}:${tx.block_number}`;
        if (seenTxHashes.has(txKey)) continue;
        seenTxHashes.add(txKey);

        allTransfers.push({
          hash: tx.tx_hash,
          from: tx.from_address,
          to: tx.to_address,
          value: tx.value,
          timeStamp: String(tx.timestamp),
          blockNumber: String(tx.block_number),
        });

        const from = tx.from_address.toLowerCase();
        const to = tx.to_address.toLowerCase();

        for (const peer of [from, to]) {
          if (peer === ZERO) continue;
          if (!visited.has(peer)) {
            visited.add(peer);
            addressDepths.set(peer, depth + 1);
            if (depth + 1 <= maxDepth) {
              nextLevel.push(peer);
            }
          }
        }
      }
    }

    currentLevel = nextLevel;
  }

  allTransfers.sort((a, b) => parseInt(a.blockNumber, 10) - parseInt(b.blockNumber, 10));
  log("OK", "bfsTrace", "BFS concluído", {
    totalAddresses: visited.size,
    totalTransfers: allTransfers.length,
    maxDepthReached: Math.max(...addressDepths.values()),
  });

  return { transfers: allTransfers, addressDepths };
}

// ── Graph construction ────────────────────────────────────────────────

function buildTraceGraph(
  transfers: TokenTransfer[],
  targetAddrs: Set<string>,
  addressDepths: Map<string, number>,
  maxDepth: number,
  anonLevel: number,
): GraphData {
  const labels = knownLabels(anonLevel);
  const poolMap = getPoolCreatorMap();
  const anonNames = new Map<string, string>();
  const anonFor = (addr: string): string | undefined => {
    if (anonLevel < 1) return undefined;
    if (!anonNames.has(addr)) anonNames.set(addr, `Anon ${anonNames.size + 1}`);
    return anonNames.get(addr);
  };
  const addrFor = (addr: string): string => {
    if (anonLevel >= 2) return anonFor(addr) ?? "???";
    return addr;
  };

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

  const nodes: GraphNode[] = [...nodeStats.entries()]
    .filter(([addr]) => addr !== ZERO)
    .map(([addr, stat]) => {
      const known = labels.get(addr);
      const totalTxn = stat.sent + stat.received;
      const isInfra = known?.isInfra ?? false;
      const isContract = known?.isContract ?? isInfra;
      const type = known?.type ?? "unknown";
      const asset = known?.asset ?? "";
      const depth = addressDepths.get(addr) ?? maxDepth + 1;
      const isTarget = targetAddrs.has(addr);
      const poolCreations = poolMap.get(addr);
      const isPoolCreator = !!poolCreations && poolCreations.length > 0;
      let label = anonFor(addr) ?? (known?.label || shortAddr(addr));
      const size = isTarget ? 40 : 10 + Math.round((totalTxn / maxTxnCount) * 30);
      let borderWidth = isTarget ? 6 : 1 + Math.round((totalTxn / maxTxnCount) * 6);
      const txnPct = totalTxn / maxTxnCount;

      let borderColor: string;
      if (isTarget) {
        borderColor = "#F05F40";
      } else if (txnPct > 0.5) {
        borderColor = "#eb3812";
      } else if (txnPct > 0.2) {
        borderColor = "#F05F40";
      } else if (txnPct > 0.05) {
        borderColor = "#cc7501";
      } else {
        borderColor = "#d49a5a";
      }

      let bgColor: string;
      if (isTarget) {
        bgColor = "#F05F40";
      } else if (isPoolCreator) {
        bgColor = "#ce6e6d";
      } else if (isInfra) {
        bgColor = "#b5651d";
      } else {
        bgColor = "#712d23";
      }
      if (isPoolCreator && !isTarget) {
        borderColor = "#fcc650";
      }

      const wlRecord = whitelist.getRecord(addr);
      const isWhitelisted = !!wlRecord;
      const wlHtml = isWhitelisted
        ? `<br><b style="color:#ffffff;background:#222;padding:2px 6px;border-radius:4px;">🏳️ Whitelist</b>${wlRecord.reason ? ` — ${wlRecord.reason}` : ""}`
        : "";
      const obsText = known?.observation || "";
      const obsHtml = obsText ? `<br><em style="color:#f7d4ca;">${obsText}</em>` : "";
      const typeHtml = type !== "unknown" ? `<br>${typeEmoji(type)} Tipo: ${type}` : "";
      const assetHtml = asset ? `<br>💰 Moeda: ${asset}` : "";
      const depthHtml = `<br>📏 Profundidade: ${depth}`;
      const targetHtml = isTarget ? `<br><b style="color:#F05F40;">🎯 ALVO</b>` : "";
      const poolHtml = isPoolCreator
        ? `<br><br><b style="color:#fcc650;">🏭 Criou ${poolCreations!.length} pool(s) DEX:</b>${poolCreations!.map((p) => `<br>• ${p.dex_name} — pair ${polyScanLink(p.pair_address, shortAddr(p.pair_address))} (bloco ${p.block_number})`).join("")}`
        : "";

      const addrDisplay = anonLevel >= 2 ? `<code>${label}</code>` : polyScanLink(addr, addrFor(addr));
      const tooltip = `<b>${label}</b>${targetHtml}<br>${addrDisplay}<br>Enviadas: ${stat.sent} | Recebidas: ${stat.received}<br>Volume: ${fmt(stat.volume, 2)} CAS${typeHtml}${assetHtml}${depthHtml}${wlHtml}${obsHtml}${poolHtml}`;
      const finalType = isPoolCreator ? "pool_creator" : type;

      if (isWhitelisted) {
        borderColor = "#ffffff";
        borderWidth = 4;
        label = `🏳️ ${label}`;
      }

      return {
        id: addr,
        label,
        title: tooltip,
        size,
        color: bgColor,
        borderColor,
        borderWidth,
        totalTxn,
        holderBalance: 0,
        isContract,
        type: finalType,
        asset,
        icon: typeEmoji(finalType),
        shape: isTarget ? "star" : nodeShape(finalType),
        isTarget,
        depth,
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

  // Pool creation edges
  for (const [creatorAddr, creations] of poolMap) {
    for (const pc of creations) {
      const pairLower = pc.pair_address.toLowerCase();
      if (!nodeStats.has(creatorAddr) && !nodeStats.has(pairLower)) continue;
      if (creatorAddr === pairLower) continue;
      const fromInfo = labels.get(creatorAddr);
      const fromDisplay = anonFor(creatorAddr) ?? (fromInfo?.label ? `${fromInfo.label} (${shortAddr(creatorAddr)})` : shortAddr(creatorAddr));
      const toDisplay = anonFor(pairLower) ?? shortAddr(pairLower);
      const fromLink = anonFor(creatorAddr) ? `<code>${fromDisplay}</code>` : polyScanLink(creatorAddr, fromDisplay);
      const toLink = anonFor(pairLower) ? `<code>${toDisplay}</code>` : polyScanLink(pairLower, toDisplay);
      const tooltip = `<b style="color:#fcc650;">🏭 createPool (${pc.dex_name})</b><br>De: ${fromLink}<br>Para: ${toLink}<br>Bloco: ${pc.block_number}`;
      edges.push({
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

  // Compute alerts
  const tokenAddress = process.env.CAS_TOKEN_ADDRESS?.trim() ?? "";
  const alerts = tokenAddress ? computeGraphAlerts(transfers, tokenAddress, anonLevel) : [];
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
    if (whitelist.isWhitelisted(n.id)) {
      continue;
    }
    const nodeAlerts = nodeAlertMap.get(n.id) ?? [];
    if (nodeAlerts.length > 0) {
      const top = [...nodeAlerts].sort((a, b) => severityRank(a.severity) - severityRank(b.severity))[0];
      n.alerts = nodeAlerts;
      if (!n.isTarget) {
        n.borderColor = alertColor(top.severity);
        n.borderWidth = top.severity === "ALTO" ? 6 : top.severity === "MODERADO" ? 4 : 3;
      }
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
      target: [...targetAddrs].join(", "),
      depth: maxDepth,
    },
    alerts,
  };
}

// ── HTML generation ───────────────────────────────────────────────────

function buildTraceHtml(graph: GraphData, targetAddrs: Set<string>, anonLevel: number): string {
  const graphDataJson = JSON.stringify({ nodes: graph.nodes, edges: graph.edges });
  const lblMap = knownLabels(anonLevel);
  const targetLinks = anonLevel >= 1
    ? [...targetAddrs].map((_, i) => `<code>Anon ${i + 1}</code>`).join(", ")
    : [...targetAddrs].map((a) => polyScanLink(a, lblMap.get(a)?.label || shortAddr(a))).join(", ");

  const alertsHtml = graph.alerts.length > 0
    ? `<div class="card" style="margin-bottom:16px;">
        <h2 style="color:#eb3812;font-size:1.1rem;margin-bottom:12px;">🚨 Indícios de Fraude (${graph.alerts.length})</h2>
        ${graph.alerts.map((a) => {
          const color = alertColor(a.severity);
          const icon = a.severity === "ALTO" ? "🚨" : a.severity === "MODERADO" ? "⚠️" : "ℹ️";
          return `<div style="margin-bottom:8px;padding:8px 12px;background:rgba(0,0,0,0.2);border-radius:8px;border-left:3px solid ${color};">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <span>${icon} <b style="color:${color};">${formatTerm(a.type)}</b> <span style="color:var(--muted);font-size:.75rem;">(${a.severity})</span></span>
              <span style="font-weight:700;color:${color};">${(a.combinedScore * 100).toFixed(1)}%</span>
            </div>
            <div style="font-size:.8rem;color:var(--muted);margin-top:4px;">${a.evidence}</div>
          </div>`;
        }).join("")}
      </div>`
    : `<div class="card" style="margin-bottom:16px;"><h2 style="color:#F05F40;font-size:1.1rem;">✅ Nenhum indício de fraude detectado</h2></div>`;

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CAS — Rastreio de Fraude 3D</title>
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
<h1>🎯 Rastreio de Fraude 3D — CAS</h1>
<p class="sub">Alvos (${targetAddrs.size}): ${targetLinks} · Profundidade: ${graph.meta.depth} · Nós: ${graph.meta.nodeCount} · Arestas: ${graph.meta.edgeCount} · Volume: ${fmt(graph.meta.totalVolume, 2)} CAS · Alertas: ${graph.meta.alertCount}</p>

<div class="kpis">
  <div class="kpi"><div class="v">${graph.meta.nodeCount}</div><div class="l">Endereços</div></div>
  <div class="kpi"><div class="v">${graph.meta.edgeCount}</div><div class="l">Fluxos</div></div>
  <div class="kpi"><div class="v">${fmt(graph.meta.totalVolume, 2)}</div><div class="l">Volume CAS</div></div>
  <div class="kpi"><div class="v">${graph.meta.alertCount}</div><div class="l">Indícios de fraude</div></div>
  <div class="kpi"><div class="v">${graph.meta.depth}</div><div class="l">Profundidade</div></div>
</div>

${alertsHtml}
<div class="card">
  <div class="graph-search-bar">
    <input type="text" id="graph-search-input" placeholder="Buscar por label ou endereço..." autocomplete="off" onkeydown="if(event.key==='Enter')searchGraph()" />
    <button id="graph-search-btn" onclick="searchGraph()">🔍 Buscar</button>
    <button id="graph-search-clear" onclick="clearGraphSearch()">✕ Limpar</button>
    <span id="graph-search-result" class="graph-search-result"></span>
  </div>
  <div id="network-graph"></div>
  <div class="graph-legend">
    <span><span class="dot" style="background:#F05F40"></span> 🎯 Alvo</span>
    <span><span class="dot" style="background:#ce6e6d"></span> Pool Creator</span>
    <span><span class="dot" style="background:#b5651d"></span> Infra/DEX</span>
    <span><span class="dot" style="background:#712d23"></span> Carteira externa</span>
    <span style="margin-left:16px">Borda ∝ volume:</span>
    <span><span class="dot" style="background:#eb3812"></span> Alto</span>
    <span><span class="dot" style="background:#F05F40"></span> Médio</span>
    <span><span class="dot" style="background:#cc7501"></span> Baixo</span>
    <span style="margin-left:16px">Risco:</span>
    <span><span class="dot" style="background:#eb3812"></span> ALTO</span>
    <span><span class="dot" style="background:#F05F40"></span> MODERADO</span>
    <span><span class="dot" style="background:#cc7501"></span> BAIXO</span>
    <span>— tracejadas = alerta</span>
    <span style="margin-left:16px"><span class="dot" style="background:#fff;border:1px solid #ccc"></span> 🏳️ Whitelist (inocentado)</span>
    <span style="margin-left:16px">Controles 3D:</span>
    <span>🖱️ Arraste = rotacionar</span>
    <span>🔍 Scroll = zoom</span>
    <span>✋ Clique direito = pan</span>
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
      log("WARN", "openBrowser", "Não foi possível abrir o navegador", { error: err.message, file: filePath });
    } else {
      log("OK", "openBrowser", "Grafo aberto no navegador", { file: filePath });
    }
  });
}

// ── CLI arg parsing ───────────────────────────────────────────────────

interface CliArgs {
  targets: string[];
  depth: number;
  anonLevel: number;
  useDbOnly: boolean;
  csvFile: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  const envDepth = parseInt(process.env.GRAPH_DEPTH_DEFAULT ?? "1", 10);
  const defaultDepth = isNaN(envDepth) || envDepth < 0 ? 1 : envDepth;
  const args: CliArgs = { targets: [], depth: defaultDepth, anonLevel: 0, useDbOnly: false, csvFile: null };
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--depth") {
      const val = parseInt(argv[++i] ?? "", 10);
      if (!isNaN(val) && val >= 0) {
        args.depth = val;
      } else {
        log("WARN", "parseArgs", "Valor inválido para --depth, usando default do .env", { value: argv[i], defaultDepth });
      }
    } else if (arg === "--anon") {
      args.anonLevel++;
    } else if (arg === "--use-db") {
      args.useDbOnly = true;
    } else if (arg === "--csv") {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args.csvFile = next;
        i++;
      } else {
        args.csvFile = "";
      }
    } else if (arg === "--index") {
      const val = argv[++i];
      if (val) positional.push(val);
    } else if (arg.startsWith("--")) {
      log("WARN", "parseArgs", "Flag desconhecida", { flag: arg });
    } else {
      positional.push(arg);
    }
  }

  args.targets = positional;
  return args;
}

// ── CSV address extraction ────────────────────────────────────────────

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function readAddressesFromCsv(csvPath: string): string[] {
  if (!fs.existsSync(csvPath)) {
    log("ERROR", "readAddressesFromCsv", "Arquivo CSV não encontrado", { file: csvPath });
    return [];
  }

  const content = fs.readFileSync(csvPath, "utf-8");
  const allRows = parseCsv(content);
  if (allRows.length < 2) {
    log("WARN", "readAddressesFromCsv", "CSV com menos de 2 linhas", { file: csvPath });
    return [];
  }

  const headerIdx = findHeaderRow(allRows);
  const headers = allRows[headerIdx];
  const dataRows = allRows.slice(headerIdx + 1);
  const sampleRows = dataRows.slice(0, 10);

  const columns = detectColumns(headers, sampleRows);
  log("INFO", "readAddressesFromCsv", "Colunas detectadas", {
    file: path.basename(csvPath),
    addressCol: columns.addressCol,
    addressHeader: columns.addressCol >= 0 ? headers[columns.addressCol] : "(não encontrada)",
  });

  if (columns.addressCol === -1) {
    log("WARN", "readAddressesFromCsv", "Nenhuma coluna de endereço encontrada no CSV", { file: csvPath });
    return [];
  }

  const addresses: string[] = [];
  for (const row of dataRows) {
    const rawAddr = (row[columns.addressCol] ?? "").trim();
    if (ADDRESS_RE.test(rawAddr)) {
      addresses.push(rawAddr.toLowerCase());
    }
  }

  log("OK", "readAddressesFromCsv", "Endereços extraídos do CSV", {
    file: path.basename(csvPath),
    count: addresses.length,
  });

  return addresses;
}

// ── Main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log("INFO", "main", "🚀 Iniciando rastreio de fraude CAS");

  const cliArgs = parseArgs(process.argv.slice(2));

  let autoDetect = false;
  if (cliArgs.targets.length === 0 && cliArgs.csvFile === null) {
    log("INFO", "main", "Nenhum alvo fornecido — auto-detectando da transação mais recente");
    autoDetect = true;
  }

  log("INFO", "main", "Argumentos", { targets: cliArgs.targets, depth: cliArgs.depth, anonLevel: cliArgs.anonLevel });

  const tokenAddress = process.env.CAS_TOKEN_ADDRESS?.trim();
  if (!tokenAddress || !/^0x[0-9a-fA-F]{40}$/.test(tokenAddress)) {
    log("WARN", "main", "CAS_TOKEN_ADDRESS ausente ou inválido — detecção de fraude limitada");
  }

  getDB();
  importAllCsvs(path.join(SC_ROOT, "data"));

  // ── Sync incremental via API (unless --use-db) ────────────────────
  if (!cliArgs.useDbOnly && tokenAddress) {
    if (hasApiKey()) {
      log("INFO", "main", "Sincronizando transferências via API");
      try {
        await syncTransfers(tokenAddress);
      } catch (err) {
        log("WARN", "main", "Falha no sync de transferências — usando dados do banco", { error: (err as Error).message });
      }

      try {
        await syncPoolCreators(tokenAddress);
      } catch (err) {
        log("WARN", "main", "Falha no sync de pool creators (não bloqueia)", { error: (err as Error).message });
      }
    } else {
      log("WARN", "main", "POLYGONSCAN_API_KEY ausente — pulando sync via API. Use --use-db para suprimir este aviso.");
    }
  } else if (cliArgs.useDbOnly) {
    log("INFO", "main", "Modo --use-db: usando apenas dados do banco SQLite (sem sync API)");
  }

  // ── Auto-detect targets from most recent transaction ─────────────
  if (autoDetect) {
    const recentTxs = getAllTransactions(1);
    if (recentTxs.length > 0) {
      const tx = recentTxs[0];
      const from = tx.from_address.toLowerCase();
      const to = tx.to_address.toLowerCase();
      if (from !== ZERO) cliArgs.targets.push(from);
      if (to !== ZERO && to !== from) cliArgs.targets.push(to);
      log("OK", "main", "Alvos auto-detectados da transação mais recente", {
        from, to, block: tx.block_number, timestamp: tx.timestamp,
      });
    } else {
      log("ERROR", "main", "Nenhuma transação encontrada no banco para auto-detecção. Forneça um alvo explícito.");
      closeDB();
      process.exit(1);
    }
  }

  // ── CSV address extraction ────────────────────────────────────────
  if (cliArgs.csvFile !== null) {
    const csvPath = cliArgs.csvFile === ""
      ? path.join(SC_ROOT, "data", "fraude.csv")
      : path.isAbsolute(cliArgs.csvFile)
        ? cliArgs.csvFile
        : path.resolve(cliArgs.csvFile);
    log("INFO", "main", "Lendo endereços de CSV", { file: csvPath });
    const csvAddresses = readAddressesFromCsv(csvPath);
    for (const addr of csvAddresses) {
      cliArgs.targets.push(addr);
    }
    if (csvAddresses.length === 0) {
      log("WARN", "main", "Nenhum endereço válido extraído do CSV", { file: csvPath });
    }
  }

  const targetSet = new Set<string>();
  for (const t of cliArgs.targets) {
    const addr = resolveTarget(t);
    if (addr) {
      targetSet.add(addr);
    } else {
      log("WARN", "main", "Alvo não resolvido, pulando", { target: t });
    }
  }

  if (targetSet.size === 0) {
    log("ERROR", "main", "Nenhum alvo pôde ser resolvido. Tente com endereço, nome ou índice válido.");
    closeDB();
    process.exit(1);
  }

  log("OK", "main", "Alvos resolvidos", { count: targetSet.size, addresses: [...targetSet] });

  const { transfers, addressDepths } = bfsTrace([...targetSet], cliArgs.depth);

  if (transfers.length === 0) {
    log("WARN", "main", "Nenhuma transação encontrada para os alvos no banco após sync.");
    closeDB();
    process.exit(0);
  }

  log("OK", "main", "Transações coletadas", { count: transfers.length, addresses: addressDepths.size });

  const graph = buildTraceGraph(transfers, targetSet, addressDepths, cliArgs.depth, cliArgs.anonLevel);
  log("OK", "main", "Grafo construído", {
    nodes: graph.meta.nodeCount,
    edges: graph.meta.edgeCount,
    volume: graph.meta.totalVolume,
    alerts: graph.meta.alertCount,
  });

  const reportsDir = path.join(SC_ROOT, "reports");
  fs.mkdirSync(reportsDir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const targetShort = [...targetSet].map((a) => a.slice(2, 8)).join("_");
  const outFile = path.join(reportsDir, `cas_fraud_trace_${targetShort}_${ts}.html`);
  fs.writeFileSync(outFile, buildTraceHtml(graph, targetSet, cliArgs.anonLevel), "utf-8");
  log("OK", "main", "Relatório HTML salvo", { file: outFile });

  const jsonFile = path.join(reportsDir, `cas_fraud_trace_${targetShort}_${ts}.json`);
  fs.writeFileSync(jsonFile, JSON.stringify(graph, null, 2), "utf-8");
  log("OK", "main", "JSON do grafo salvo", { file: jsonFile });

  if (graph.alerts.length > 0) {
    log("WARN", "main", "⚠️ Indícios de fraude detectados", { count: graph.alerts.length });
    for (const a of graph.alerts) {
      log("WARN", "main", `  ${a.severity} — ${a.type}`, { score: a.combinedScore, evidence: a.evidence.slice(0, 120) });
    }
  } else {
    log("OK", "main", "✅ Nenhum indício de fraude detectado no subgrafo");
  }

  openBrowser(outFile);
  log("INFO", "main", "🏁 Rastreio concluído");
  closeDB();
}

main().catch((err) => {
  log("ERROR", "main", "Falha na execução", { error: (err as Error).message });
  closeDB();
  process.exit(1);
});
