/**
 * CAS Manipulation Detectors
 * --------------------------
 * Heurísticas on-chain para identificar padrões suspeitos no token CAS:
 * pump-and-dump, whale-dump, wash-trading, clusters coordenados,
 * short-and-distort, spoofing/layering e rug-pull.
 *
 * Uso:
 *   import { detectManipulationSignals } from "./cas_manipulation";
 */

import { formatUnits } from "agentic_space_commons";

const DECIMALS = 18;

// ── Logging ────────────────────────────────────────────────────────────

type LogLevel = "INFO" | "WARN" | "ERROR" | "OK" | "DEBUG";

function log(level: LogLevel, fn: string, msg: string, p?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const emoji = { INFO: "ℹ️", WARN: "⚠️", ERROR: "❌", OK: "✅", DEBUG: "🔍" }[level];
  const extra = p ? ` - ${JSON.stringify(p)}` : "";
  console.log(`[${ts}] [cas_manipulation:${fn}] ${emoji} ${msg}${extra}`);
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

export interface AddressInfo {
  label: string;
  isInfra: boolean;
  type: string;
}

export type LabelResolver = (address: string) => AddressInfo | undefined;

export interface MarketLike {
  dexPairs: { pairAddress?: string; liquidityUsd?: number; volume24h?: number; priceUsd?: number }[];
  bestPair?: { pairAddress?: string; liquidityUsd?: number; priceUsd?: number } | null;
}

export interface SentimentSnapshotLike {
  scannedAt: number;
  negativeScore: number;
  riskKeywordCounts: Record<string, number>;
  topSources: { platform: string; url: string }[];
}

export type ManipulationType =
  | "volume_spike"
  | "pump_episode"
  | "dump_episode"
  | "whale_dump"
  | "wash_trading"
  | "coordinated_cluster"
  | "short_and_distort"
  | "spoofing_layering"
  | "rug_pull";

export type Severity = "ALTO" | "MODERADO" | "BAIXO";

export interface ManipulationSignal {
  type: ManipulationType;
  severity: Severity;
  start: number;
  end: number;
  addresses: string[];
  volumeCas: number;
  txCount: number;
  evidence: string;
  metadata?: Record<string, unknown>;
}

// ── Helpers ────────────────────────────────────────────────────────────

export function toNum(value: string): number {
  return Number(formatUnits(value, DECIMALS));
}

export function shortAddr(a: string): string {
  if (!a || a.length < 12) return a ?? "";
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function fmt(n: number, digits = 2): string {
  return n.toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

const INFRA_LABELS = new Set([
  "contract", "infra", "dex", "swap", "reserve", "fund", "proxy", "faucet",
  "lock", "migration", "lp", "bridge", "wrapper", "token", "safe", "multisig",
]);

export function isInfraAddress(addr: string, resolve: LabelResolver): boolean {
  const info = resolve(addr.toLowerCase());
  if (!info) return false;
  return info.isInfra || INFRA_LABELS.has(info.type.toLowerCase()) || INFRA_LABELS.has(info.label.toLowerCase());
}

export function labelOf(addr: string, resolve: LabelResolver): string {
  return resolve(addr.toLowerCase())?.label || shortAddr(addr);
}

function tsSeconds(t: TokenTransfer): number {
  return Number(t.timeStamp) || 0;
}

function severityForZ(z: number): Severity {
  if (z >= 4) return "ALTO";
  if (z >= 2) return "MODERADO";
  return "BAIXO";
}

function aggregateBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = keyFn(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(item);
  }
  return map;
}

function bucketHours(transfers: TokenTransfer[], startHour: number): Map<number, TokenTransfer[]> {
  const buckets = new Map<number, TokenTransfer[]>();
  for (const t of transfers) {
    const ts = tsSeconds(t);
    if (!ts) continue;
    const h = Math.floor((ts - startHour) / 3600);
    if (!buckets.has(h)) buckets.set(h, []);
    buckets.get(h)!.push(t);
  }
  return buckets;
}

function meanStd(values: number[]): { mean: number; std: number } {
  if (values.length === 0) return { mean: 0, std: 0 };
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return { mean, std: Math.sqrt(variance) };
}

function hoursAgo(hours: number): number {
  return Math.floor(Date.now() / 1000) - hours * 3600;
}

// ── Volume / Pump / Dump ───────────────────────────────────────────────

export function detectVolumeSpikes(
  transfers: TokenTransfer[],
  resolve: LabelResolver,
  options: { bucketHours?: number; lookbackDays?: number; minVolumeCas?: number } = {},
): ManipulationSignal[] {
  const bucketH = options.bucketHours ?? 1;
  const lookbackDays = options.lookbackDays ?? 7;
  const minVol = options.minVolumeCas ?? 10_000;

  const now = Math.floor(Date.now() / 1000);
  const cutoff = lookbackDays > 0 ? now - lookbackDays * 24 * 3600 : 0;
  const filtered = transfers.filter((t) => tsSeconds(t) >= cutoff && tsSeconds(t) <= now + 3600);

  if (filtered.length === 0) return [];

  const startHour = Math.floor(tsSeconds(filtered[0]) / 3600) * 3600;
  const buckets = bucketHours(filtered, startHour);
  const volumes: number[] = [];
  const bucketVol = new Map<number, number>();
  const bucketTx = new Map<number, TokenTransfer[]>();

  for (const [h, txs] of buckets.entries()) {
    const v = txs.reduce((s, t) => s + toNum(t.value), 0);
    bucketVol.set(h, v);
    bucketTx.set(h, txs);
    volumes.push(v);
  }

  const { mean, std } = meanStd(volumes);
  if (std === 0) return [];

  const signals: ManipulationSignal[] = [];
  for (const [h, vol] of bucketVol.entries()) {
    const z = (vol - mean) / std;
    if (z >= 2 && vol >= minVol) {
      const txs = bucketTx.get(h) || [];
      const start = startHour + h * 3600;
      const end = start + 3600 * bucketH;
      const nonInfraTxs = txs.filter((t) => !isInfraAddress(t.from, resolve) && !isInfraAddress(t.to, resolve));
      const topSenders = aggregateBy(nonInfraTxs, (t) => t.from.toLowerCase());
      const topReceivers = aggregateBy(nonInfraTxs, (t) => t.to.toLowerCase());
      const senderList = [...topSenders.entries()]
        .map(([addr, arr]) => ({ addr, vol: arr.reduce((s, t) => s + toNum(t.value), 0) }))
        .sort((a, b) => b.vol - a.vol)
        .slice(0, 5);
      const receiverList = [...topReceivers.entries()]
        .map(([addr, arr]) => ({ addr, vol: arr.reduce((s, t) => s + toNum(t.value), 0) }))
        .sort((a, b) => b.vol - a.vol)
        .slice(0, 5);
      const ev = `Volume ${fmt(vol)} CAS (z=${z.toFixed(2)}). Top envios: ${senderList.map((s) => `${labelOf(s.addr, resolve)} (${fmt(s.vol)})`).join("; ")}. Top receb: ${receiverList.map((s) => `${labelOf(s.addr, resolve)} (${fmt(s.vol)})`).join("; ")}.`;
      signals.push({
        type: "volume_spike",
        severity: severityForZ(z),
        start,
        end,
        addresses: [...new Set([...senderList.map((s) => s.addr), ...receiverList.map((r) => r.addr)])],
        volumeCas: vol,
        txCount: txs.length,
        evidence: ev,
        metadata: { zScore: z, bucketHours: bucketH },
      });
    }
  }

  log("OK", "detectVolumeSpikes", "Análise concluída", { signals: signals.length });
  return signals.sort((a, b) => b.start - a.start);
}

export function detectPumpDumpEpisodes(
  transfers: TokenTransfer[],
  resolve: LabelResolver,
  options: { windows?: number[]; lookbackDays?: number } = {},
): ManipulationSignal[] {
  const windows = options.windows ?? [1, 6, 24];
  const lookbackDays = options.lookbackDays ?? 7;
  const now = Math.floor(Date.now() / 1000);
  const cutoff = lookbackDays > 0 ? now - lookbackDays * 24 * 3600 : 0;
  const filtered = transfers.filter((t) => tsSeconds(t) >= cutoff && tsSeconds(t) <= now + 3600);

  const signals: ManipulationSignal[] = [];

  for (const hWindow of windows) {
    const startHour = Math.floor(tsSeconds(filtered[0] || { timeStamp: "0" }) / 3600) * 3600;
    const buckets = new Map<number, { buy: number; sell: number; txs: TokenTransfer[] }>();
    const step = 3600 * hWindow;

    for (const t of filtered) {
      const ts = tsSeconds(t);
      const bucket = Math.floor((ts - startHour) / step);
      if (!buckets.has(bucket)) buckets.set(bucket, { buy: 0, sell: 0, txs: [] });
      const b = buckets.get(bucket)!;
      const val = toNum(t.value);
      const fromInfra = isInfraAddress(t.from, resolve);
      const toInfra = isInfraAddress(t.to, resolve);
      if (!fromInfra && toInfra) b.sell += val;
      else if (fromInfra && !toInfra) b.buy += val;
      else if (!fromInfra && !toInfra) {
        // pessoa->pessoa: conta como sell do sender e buy do receiver para pressão líquida
        b.sell += val;
        b.buy += val;
      }
      b.txs.push(t);
    }

    const volumes = [...buckets.values()].map((b) => b.buy + b.sell);
    const { mean, std } = meanStd(volumes);
    if (std === 0) continue;

    for (const [bucket, data] of buckets.entries()) {
      const vol = data.buy + data.sell;
      const z = (vol - mean) / std;
      if (z >= 2 && vol >= 10_000) {
        const pressure = data.buy - data.sell;
        const type = pressure > 0 ? "pump_episode" : (pressure < 0 ? "dump_episode" : "volume_spike");
        const severity = severityForZ(z);
        const nonInfraTxs = data.txs.filter((t) => !isInfraAddress(t.from, resolve));
        const topSenders = [...aggregateBy(nonInfraTxs, (t) => t.from.toLowerCase()).entries()]
          .map(([addr, arr]) => ({ addr, vol: arr.reduce((s, t) => s + toNum(t.value), 0) }))
          .sort((a, b) => b.vol - a.vol)
          .slice(0, 5);
        const start = startHour + bucket * step;
        const end = start + step;
        const ev = `${type === "pump_episode" ? "Pico de compra" : "Pico de venda"} em janela de ${hWindow}h (${fmt(vol)} CAS, z=${z.toFixed(2)}, pressão=${fmt(pressure)}). Origens: ${topSenders.map((s) => `${labelOf(s.addr, resolve)} (${fmt(s.vol)})`).join("; ")}.`;
        signals.push({
          type,
          severity,
          start,
          end,
          addresses: topSenders.map((s) => s.addr),
          volumeCas: vol,
          txCount: data.txs.length,
          evidence: ev,
          metadata: { windowHours: hWindow, pressure, zScore: z },
        });
      }
    }
  }

  log("OK", "detectPumpDumpEpisodes", "Detectado", { signals: signals.length });
  return signals.sort((a, b) => b.start - a.start);
}

// ── Wash Trading ───────────────────────────────────────────────────────

export function detectWashTradingClusters(
  transfers: TokenTransfer[],
  resolve: LabelResolver,
  options: { cycleWindowMs?: number; minCycles?: number; reciprocityThreshold?: number; maxLookbackHours?: number } = {},
): ManipulationSignal[] {
  const cycleWindowMs = options.cycleWindowMs ?? 15 * 60 * 1000;
  const minCycles = options.minCycles ?? 3;
  const reciprocityThreshold = options.reciprocityThreshold ?? 0.7;
  const maxLookbackHours = options.maxLookbackHours ?? 168; // 7 dias

  const now = Math.floor(Date.now() / 1000);
  const cutoff = maxLookbackHours > 0 ? now - maxLookbackHours * 3600 : 0;
  const filtered = transfers
    .filter((t) => tsSeconds(t) >= cutoff)
    .sort((a, b) => tsSeconds(a) - tsSeconds(b));

  if (filtered.length === 0) return [];

  // Índice de transferências de saída por endereço, mantendo janela deslizante
  const outgoing = new Map<string, { to: string; ts: number; val: number; hash: string }[]>();
  const pairCycles = new Map<string, number>();
  const pairVolume = new Map<string, number>();
  const addrVolume = new Map<string, number>();
  const addrCycleCount = new Map<string, number>();

  for (const t of filtered) {
    const from = t.from.toLowerCase();
    const to = t.to.toLowerCase();
    if (from === to) continue;
    if (isInfraAddress(from, resolve) || isInfraAddress(to, resolve)) continue;
    const ts = tsSeconds(t) * 1000;
    const val = toNum(t.value);

    // limpar entradas antigas da janela do endereço destino
    const toOutgoing = outgoing.get(to) || [];
    const recent = toOutgoing.filter((o) => ts - o.ts <= cycleWindowMs);

    // procurar B -> A com valor próximo
    const matches = recent.filter(
      (o) => o.to === from && Math.abs(o.val - val) / Math.max(o.val, val, 1e-9) <= 0.05,
    );

    for (const m of matches) {
      const pairKey = [from, to].sort().join("::");
      pairCycles.set(pairKey, (pairCycles.get(pairKey) || 0) + 1);
      pairVolume.set(pairKey, (pairVolume.get(pairKey) || 0) + val);
      addrCycleCount.set(from, (addrCycleCount.get(from) || 0) + 1);
      addrCycleCount.set(to, (addrCycleCount.get(to) || 0) + 1);
      addrVolume.set(from, (addrVolume.get(from) || 0) + val);
      addrVolume.set(to, (addrVolume.get(to) || 0) + val);
    }

    // adicionar transferência atual ao índice
    toOutgoing.push({ to, ts, val, hash: t.hash });
    outgoing.set(to, toOutgoing);

    const fromList = outgoing.get(from) || [];
    fromList.push({ to, ts, val, hash: t.hash });
    outgoing.set(from, fromList);
  }

  // Agrupar em clusters quando houver 3+ ciclos ou reciprocidade alta
  const clusterMap = new Map<string, { addrs: Set<string>; cycles: number; vol: number; first: number; last: number }>();
  const pairKeys = [...pairCycles.entries()].filter(([, c]) => c >= minCycles);

  for (const [pair, cycles] of pairKeys) {
    const [a, b] = pair.split("::");
    const key = [a, b].sort().join("::");
    const existing = clusterMap.get(key);
    const vol = pairVolume.get(pair) || 0;
    const first = 1e12;
    const last = 0;
    if (existing) {
      existing.cycles += cycles;
      existing.vol += vol;
      existing.addrs.add(a);
      existing.addrs.add(b);
    } else {
      clusterMap.set(key, { addrs: new Set([a, b]), cycles, vol, first, last });
    }
  }

  // Reciprocidade (volume mútuo / volume total do par)
  const addrOut = new Map<string, number>();
  const addrIn = new Map<string, number>();
  for (const t of filtered) {
    if (isInfraAddress(t.from, resolve) || isInfraAddress(t.to, resolve)) continue;
    const v = toNum(t.value);
    const from = t.from.toLowerCase();
    const to = t.to.toLowerCase();
    addrOut.set(from, (addrOut.get(from) || 0) + v);
    addrIn.set(to, (addrIn.get(to) || 0) + v);
  }

  const reciprocityPairs = new Map<string, number>();
  for (const addr of new Set([...addrOut.keys(), ...addrIn.keys()])) {
    const out = addrOut.get(addr) || 1;
    const inc = addrIn.get(addr) || 0;
    // proxy simples: se in ~= out, é recíproco
    const rec = Math.min(inc, out) / Math.max(inc, out, 1e-9);
    if (rec >= reciprocityThreshold && (addrOut.get(addr) ?? 0) > 50_000) {
      // endereço com alta reciprocidade e volume significativo
      // ligar aos principais pares (simplificado: ligar a todos os pares do cluster)
    }
  }

  const signals: ManipulationSignal[] = [];
  for (const [key, cluster] of clusterMap.entries()) {
    if (cluster.cycles < minCycles) continue;
    const addrs = [...cluster.addrs];
    const gross = addrs.reduce((s, a) => s + (addrVolume.get(a) || 1), 1);
    const net = addrs.reduce((s, a) => s + Math.abs((addrOut.get(a) || 0) - (addrIn.get(a) || 0)), 0);
    const severity: Severity = cluster.cycles >= 10 || gross > 1_000_000 ? "ALTO" : cluster.cycles >= 5 ? "MODERADO" : "BAIXO";
    const evidence = `Wash trading: ${cluster.cycles} ciclos entre ${addrs.map((a) => labelOf(a, resolve)).join(", ")}; volume bruto ~${fmt(gross)} CAS, líquido ~${fmt(net)} CAS.`;
    signals.push({
      type: "wash_trading",
      severity,
      start: 0,
      end: 0,
      addresses: addrs,
      volumeCas: gross,
      txCount: cluster.cycles * 2,
      evidence,
      metadata: { cycles: cluster.cycles, grossVolume: gross, netVolume: net },
    });
  }

  log("OK", "detectWashTradingClusters", "Detectado", { signals: signals.length });
  return signals.sort((a, b) => (b.metadata?.cycles as number ?? 0) - (a.metadata?.cycles as number ?? 0));
}

// ── Coordinated Clusters / Sybil ───────────────────────────────────────

export function detectCoordinatedClusters(
  transfers: TokenTransfer[],
  resolve: LabelResolver,
  options: { minAddresses?: number; timeWindowSec?: number; valueTolerance?: number; lookbackDays?: number } = {},
): ManipulationSignal[] {
  const minAddr = options.minAddresses ?? 3;
  const timeWindow = options.timeWindowSec ?? 60;
  const tolerance = options.valueTolerance ?? 0.2;
  const lookbackDays = options.lookbackDays ?? 7;
  const now = Math.floor(Date.now() / 1000);
  const cutoff = lookbackDays > 0 ? now - lookbackDays * 24 * 3600 : 0;
  const filtered = transfers.filter((t) => tsSeconds(t) >= cutoff);

  if (filtered.length === 0) return [];

  const byWindow = new Map<number, TokenTransfer[]>();
  for (const t of filtered) {
    const ts = tsSeconds(t);
    const bucket = Math.floor(ts / timeWindow);
    if (!byWindow.has(bucket)) byWindow.set(bucket, []);
    byWindow.get(bucket)!.push(t);
  }

  const signals: ManipulationSignal[] = [];
  const seenGroups = new Set<string>();

  for (const [bucket, txs] of byWindow.entries()) {
    const nonInfra = txs.filter((t) => !isInfraAddress(t.from, resolve) && !isInfraAddress(t.to, resolve));
    if (nonInfra.length < minAddr) continue;

    // Agrupar por magnitude de valor
    const byValue = aggregateBy(nonInfra, (t) => {
      const v = toNum(t.value);
      const exp = Math.floor(Math.log10(Math.max(v, 1)));
      const base = Math.pow(10, exp);
      return `${Math.floor(v / base)}:${exp}`;
    });

    for (const [, group] of byValue.entries()) {
      if (group.length < minAddr) continue;
      const tos = new Set(group.map((t) => t.to.toLowerCase()));
      const froms = new Set(group.map((t) => t.from.toLowerCase()));
      const key = [...tos].sort().join(",");
      if (seenGroups.has(key)) continue;
      seenGroups.add(key);
      const firstFrom = group[0].from.toLowerCase();
      const sameFunder = group.every((t) => t.from.toLowerCase() === firstFrom);
      const vol = group.reduce((s, t) => s + toNum(t.value), 0);
      const evidence = `Cluster coordenado: ${tos.size} destinatários receberam valores similares no mesmo bloco/janela de ${timeWindow}s. Origem ${sameFunder ? "única" : "múltipla"}: ${labelOf([...froms][0], resolve)}.`;
      signals.push({
        type: "coordinated_cluster",
        severity: sameFunder ? "ALTO" : "MODERADO",
        start: bucket * timeWindow,
        end: (bucket + 1) * timeWindow,
        addresses: [...tos, ...froms],
        volumeCas: vol,
        txCount: group.length,
        evidence,
        metadata: { sameFunder, toCount: tos.size, fromCount: froms.size },
      });
    }
  }

  log("OK", "detectCoordinatedClusters", "Detectado", { signals: signals.length });
  return signals.sort((a, b) => b.start - a.start);
}

// ── Short and Distort ──────────────────────────────────────────────────

export function detectShortAndDistort(
  transfers: TokenTransfer[],
  resolve: LabelResolver,
  market: MarketLike,
  social?: SentimentSnapshotLike | null,
  options: { minDumpVolumeCas?: number; socialNegativeThreshold?: number; lookbackHours?: number } = {},
): ManipulationSignal[] {
  const minDump = options.minDumpVolumeCas ?? 100_000;
  const negThreshold = options.socialNegativeThreshold ?? 0.3;
  const lookbackHours = options.lookbackHours ?? 24;
  const now = Math.floor(Date.now() / 1000);
  const cutoff = lookbackHours > 0 ? now - lookbackHours * 3600 : 0;
  const filtered = transfers.filter((t) => tsSeconds(t) >= cutoff);

  const signals: ManipulationSignal[] = [];

  // Saídas de grandes holders externos para DEX/LP
  const externalSells = aggregateBy(
    filtered.filter((t) => !isInfraAddress(t.from, resolve) && isInfraAddress(t.to, resolve)),
    (t) => t.from.toLowerCase(),
  );

  const dumpers = [...externalSells.entries()]
    .map(([addr, txs]) => ({ addr, vol: txs.reduce((s, t) => s + toNum(t.value), 0), count: txs.length }))
    .filter((d) => d.vol >= minDump)
    .sort((a, b) => b.vol - a.vol);

  if (dumpers.length === 0) return [];

  const topDumper = dumpers[0];
  const negTerms = social ? Object.entries(social.riskKeywordCounts).filter(([, c]) => c > 0).map(([k]) => k) : [];
  const hasSocialSpike = social && (social.negativeScore >= negThreshold || negTerms.length > 0);
  const liquidityDrop = market?.bestPair?.liquidityUsd ? market.bestPair.liquidityUsd < 10_000 : false;

  const evidence = `Pressão vendedora de ${fmt(topDumper.vol)} CAS por ${labelOf(topDumper.addr, resolve)} (${topDumper.count} txs). ${
    hasSocialSpike ? `Spike de FUD social detectado (${negTerms.slice(0, 5).join(", ")}).` : "Sem spike social."
  } ${liquidityDrop ? "Liquidez do par DEX está baixa." : ""}`;

  signals.push({
    type: "short_and_distort",
    severity: hasSocialSpike ? "ALTO" : "MODERADO",
    start: cutoff,
    end: now,
    addresses: dumpers.map((d) => d.addr),
    volumeCas: dumpers.reduce((s, d) => s + d.vol, 0),
    txCount: dumpers.reduce((s, d) => s + d.count, 0),
    evidence,
    metadata: { dumpers, socialNegativeScore: social?.negativeScore ?? 0 },
  });

  log("OK", "detectShortAndDistort", "Detectado", { signals: signals.length });
  return signals;
}

// ── Spoofing / Layering ────────────────────────────────────────────────

export function detectSpoofingLayering(
  transfers: TokenTransfer[],
  resolve: LabelResolver,
  market: MarketLike,
  options: { minSizeCas?: number; quickReturnMs?: number } = {},
): ManipulationSignal[] {
  const minSize = options.minSizeCas ?? 50_000;
  const quickReturnMs = options.quickReturnMs ?? 60 * 1000;

  const pairAddresses = new Set<string>(
    (market?.dexPairs || [])
      .map((p) => p.pairAddress?.toLowerCase())
      .filter((a): a is string => !!a),
  );

  const signals: ManipulationSignal[] = [];

  // Proxy on-chain: transferências grandes para DEX seguidas de devolução quase imediata
  const outToPair = transfers.filter(
    (t) => pairAddresses.has(t.to.toLowerCase()) && toNum(t.value) >= minSize,
  );

  for (const out of outToPair) {
    const from = out.from.toLowerCase();
    const to = out.to.toLowerCase();
    const outTs = tsSeconds(out) * 1000;
    const outVal = toNum(out.value);
    // procurar retorno do par para o mesmo from em curto prazo
    const returns = transfers.filter(
      (t) =>
        t.from.toLowerCase() === to &&
        t.to.toLowerCase() === from &&
        Math.abs(tsSeconds(t) * 1000 - outTs) <= quickReturnMs &&
        Math.abs(toNum(t.value) - outVal) / Math.max(outVal, toNum(t.value), 1e-9) <= 0.1,
    );
    if (returns.length > 0) {
      const evidence = `Spoofing/Layering proxy: ${fmt(outVal)} CAS enviado para ${labelOf(to, resolve)} e devolvido em ${Math.round((tsSeconds(returns[0]) * 1000 - outTs) / 1000)}s.`;
      signals.push({
        type: "spoofing_layering",
        severity: "MODERADO",
        start: Math.floor(outTs / 1000),
        end: tsSeconds(returns[0]),
        addresses: [from, to],
        volumeCas: outVal,
        txCount: 1 + returns.length,
        evidence,
        metadata: { pair: to, returnedValue: toNum(returns[0].value) },
      });
    }
  }

  log("OK", "detectSpoofingLayering", "Detectado", { signals: signals.length });
  return signals;
}

// ── Rug Pull ───────────────────────────────────────────────────────────

export function detectRugPull(
  transfers: TokenTransfer[],
  resolve: LabelResolver,
  market: MarketLike,
  tokenAddress: string,
  options: { minLpOutflowPct?: number; teamSellThreshold?: number } = {},
): ManipulationSignal[] {
  const minLpOutPct = options.minLpOutflowPct ?? 0.3;
  const teamSellThreshold = options.teamSellThreshold ?? 50_000;

  const pairAddresses = new Set<string>(
    (market?.dexPairs || [])
      .map((p) => p.pairAddress?.toLowerCase())
      .filter((a): a is string => !!a),
  );

  // Identificar endereços do time (deployer, admin, marketing, advisors)
  const teamLabels = new Set(["deployer", "admin", "team", "marketing", "advisor", "dev"]);
  const isTeam = (addr: string) => {
    const info = resolve(addr.toLowerCase());
    if (!info) return false;
    return teamLabels.has(info.type.toLowerCase()) || teamLabels.has(info.label.toLowerCase());
  };

  const signals: ManipulationSignal[] = [];

  // Retiradas do par para endereços não-infra
  const pairOutflows = aggregateBy(
    transfers.filter((t) => pairAddresses.has(t.from.toLowerCase()) && !isInfraAddress(t.to, resolve)),
    (t) => t.to.toLowerCase(),
  );

  for (const [to, txs] of pairOutflows.entries()) {
    const vol = txs.reduce((s, t) => s + toNum(t.value), 0);
    if (vol >= minLpOutPct * 1_000_000) { // threshold dinâmico simplificado
      const evidence = `Rug-pull proxy: ${fmt(vol)} CAS retirado do par de liquidez para ${labelOf(to, resolve)} (${txs.length} txs).`;
      signals.push({
        type: "rug_pull",
        severity: "ALTO",
        start: tsSeconds(txs[0]),
        end: tsSeconds(txs[txs.length - 1]),
        addresses: [to, txs[0].from.toLowerCase()],
        volumeCas: vol,
        txCount: txs.length,
        evidence,
        metadata: { pair: txs[0].from.toLowerCase() },
      });
    }
  }

  // Venda massiva do time
  const teamSells = aggregateBy(
    transfers.filter((t) => isTeam(t.from.toLowerCase()) && isInfraAddress(t.to, resolve)),
    (t) => t.from.toLowerCase(),
  );

  for (const [from, txs] of teamSells.entries()) {
    const vol = txs.reduce((s, t) => s + toNum(t.value), 0);
    if (vol >= teamSellThreshold) {
      const evidence = `Venda massiva do time: ${labelOf(from, resolve)} enviou ${fmt(vol)} CAS para DEX/LP.`;
      signals.push({
        type: "rug_pull",
        severity: "ALTO",
        start: tsSeconds(txs[0]),
        end: tsSeconds(txs[txs.length - 1]),
        addresses: [from],
        volumeCas: vol,
        txCount: txs.length,
        evidence,
        metadata: { teamSeller: true },
      });
    }
  }

  // Honeypot proxy: muitos endereços com saldo positivo mas nunca venderam (saída não-mint)
  const uniqueBuyers = new Set<string>();
  const uniqueSellers = new Set<string>();
  for (const t of transfers) {
    if (t.from === "0x0000000000000000000000000000000000000000") continue;
    if (t.to === "0x0000000000000000000000000000000000000000") continue;
    uniqueBuyers.add(t.to.toLowerCase());
    if (!isInfraAddress(t.from, resolve)) uniqueSellers.add(t.from.toLowerCase());
  }
  const onlyHolders = [...uniqueBuyers].filter((a) => !uniqueSellers.has(a) && !isInfraAddress(a, resolve));
  const honeypotRatio = uniqueBuyers.size > 0 ? onlyHolders.length / uniqueBuyers.size : 0;
  if (honeypotRatio > 0.8 && onlyHolders.length > 20) {
    const evidence = `Honeypot proxy: ${(honeypotRatio * 100).toFixed(1)}% dos ${uniqueBuyers.size} compradores nunca transferiram para fora (saída).`;
    signals.push({
      type: "rug_pull",
      severity: "MODERADO",
      start: 0,
      end: 0,
      addresses: [],
      volumeCas: 0,
      txCount: onlyHolders.length,
      evidence,
      metadata: { honeypotRatio, onlyHolders: onlyHolders.length },
    });
  }

  log("OK", "detectRugPull", "Detectado", { signals: signals.length });
  return signals;
}

// ── Aggregator ─────────────────────────────────────────────────────────

export interface ManipulationDetectionOptions {
  lookbackDays?: number;
  washLookbackHours?: number;
  shortLookbackHours?: number;
}

export function detectManipulationSignals(
  transfers: TokenTransfer[],
  resolve: LabelResolver,
  market: MarketLike,
  tokenAddress: string,
  social?: SentimentSnapshotLike | null,
  options?: ManipulationDetectionOptions,
): ManipulationSignal[] {
  log("INFO", "detectManipulationSignals", "Iniciando detecção", { totalTransfers: transfers.length });
  const results: ManipulationSignal[] = [];
  try {
    results.push(...detectVolumeSpikes(transfers, resolve, { lookbackDays: options?.lookbackDays }));
  } catch (err) {
    log("ERROR", "detectVolumeSpikes", "Falha", { error: (err as Error).message });
  }
  try {
    results.push(...detectPumpDumpEpisodes(transfers, resolve, { lookbackDays: options?.lookbackDays }));
  } catch (err) {
    log("ERROR", "detectPumpDumpEpisodes", "Falha", { error: (err as Error).message });
  }
  try {
    results.push(...detectWashTradingClusters(transfers, resolve, { maxLookbackHours: options?.washLookbackHours }));
  } catch (err) {
    log("ERROR", "detectWashTradingClusters", "Falha", { error: (err as Error).message });
  }
  try {
    results.push(...detectCoordinatedClusters(transfers, resolve, { lookbackDays: options?.lookbackDays }));
  } catch (err) {
    log("ERROR", "detectCoordinatedClusters", "Falha", { error: (err as Error).message });
  }
  try {
    results.push(...detectShortAndDistort(transfers, resolve, market, social, { lookbackHours: options?.shortLookbackHours }));
  } catch (err) {
    log("ERROR", "detectShortAndDistort", "Falha", { error: (err as Error).message });
  }
  try {
    results.push(...detectSpoofingLayering(transfers, resolve, market));
  } catch (err) {
    log("ERROR", "detectSpoofingLayering", "Falha", { error: (err as Error).message });
  }
  try {
    results.push(...detectRugPull(transfers, resolve, market, tokenAddress));
  } catch (err) {
    log("ERROR", "detectRugPull", "Falha", { error: (err as Error).message });
  }

  log("OK", "detectManipulationSignals", "Concluído", { signals: results.length });
  return results.sort((a, b) => {
    const sevOrder = { ALTO: 0, MODERADO: 1, BAIXO: 2 };
    const s = sevOrder[a.severity] - sevOrder[b.severity];
    if (s !== 0) return s;
    return b.end - a.end;
  });
}
