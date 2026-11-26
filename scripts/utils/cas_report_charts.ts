/**
 * cas_report_charts.ts
 * --------------------
 * Shared chart helpers for CAS HTML dashboards (Chart.js pies +
 * manipulation-signal tooltips) used by cas_graph_dashboard.ts and
 * cas_distribution_dashboard.ts.
 *
 * Centralizes:
 * - Severity/alert vocabulary (TERM_LABELS, colors, score conversion)
 * - Pie-slice data builders (holders % supply + movers % movements) with
 *   rich interactive tooltips (identity, balance, movements, alerts)
 * - PIE_CHARTS_JS: browser-side Chart.js pie init + external scrollable
 *   tooltip via window._visTooltip (degrades gracefully without Chart.js)
 * - MANIP_TOOLTIP_BIND_JS: hover tooltip binding for the Manipulação table
 *
 * All text is pt-BR; HTML is built server-side and embedded as JSON inside
 * <script> tags — callers must escape `<` (`</script>` guard) via
 * safeJsonForScript().
 *
 * Author: Carlos Delfino
 * Email: consultoria@carlosdelfino.eti.br
 * WhatsApp: +55 (85) 98520-5490
 */

import { formatUnits } from "agentic_space_commons";
import { polyScanLink } from "./vis_tooltip";

// ── Types ─────────────────────────────────────────────────────────────

const ZERO = "0x0000000000000000000000000000000000000000";
const DECIMALS = 18;

/**
 * Transferência on-chain mínima necessária para montar os dados das
 * pizzas (equivalente estrutural ao TokenTransfer dos dashboards).
 */
export interface PieTransfer {
  hash: string;
  from: string;
  to: string;
  value: string;
  timeStamp: string;
  blockNumber: string;
}

/** Holder ranqueado: participação percentual no supply do token. */
export interface PieHolderInfo {
  address: string;
  balance: bigint;
  pct: number;
}

/**
 * Informação de label conhecida (env + SQLite). Espelha o KnownAddress
 * dos dashboards para permitir compartilhamento sem acoplamento.
 */
export interface PieLabelInfo {
  label: string;
  isInfra: boolean;
  isContract: boolean;
  type: string;
  asset: string;
  observation: string;
}

/**
 * Alerta de manipulação normalizado para tooltips/nós/arestas: combina
 * a severidade heurística com o score GNN quando disponível.
 */
export interface PieAlert {
  type: string;
  severity: "ALTO" | "MODERADO" | "BAIXO";
  evidence: string;
  addresses: string[];
  heuristicScore: number;
  gnnScore: number;
  combinedScore: number;
  gnnKey?: string;
}

/** Fatia de um gráfico de pizza (share 0–100 + tooltip HTML rico). */
export interface PieSlice {
  label: string;
  share: number;
  tooltipHtml: string;
}

/** Dados das pizzas de distribuição: holders e movimentadores. */
export interface PieData {
  holders: PieSlice[];
  movers: PieSlice[];
}

/** Movimentação individual exibida na lista "Últimas N" do tooltip. */
export interface AccountMovement {
  timestamp: number;
  direction: "out" | "in";
  counterparty: string;
  value: number;
  hash: string;
}

/** Conta ranqueada por participação percentual (saldo ou movimentações). */
export interface RankedAccount {
  address: string;
  share: number;
}

/** Estatísticas de movimentação de um nó (sent/received/volume em CAS). */
export type NodeStatsMap = Map<string, { sent: number; received: number; volume: number }>;

// ── Severity & alert vocabulary ───────────────────────────────────────

export const SEVERITY_RANK: Record<"ALTO" | "MODERADO" | "BAIXO", number> = {
  ALTO: 0,
  MODERADO: 1,
  BAIXO: 2,
};

export function severityRank(s: "ALTO" | "MODERADO" | "BAIXO"): number {
  return SEVERITY_RANK[s] ?? 99;
}

export function alertColor(severity: "ALTO" | "MODERADO" | "BAIXO"): string {
  return severity === "ALTO" ? "#eb3812" : severity === "MODERADO" ? "#F05F40" : "#cc7501";
}

export function severityToPct(s: "ALTO" | "MODERADO" | "BAIXO"): number {
  return s === "ALTO" ? 1.0 : s === "MODERADO" ? 0.6 : 0.3;
}

export function pctToSeverity(pct: number): "ALTO" | "MODERADO" | "BAIXO" {
  return pct >= 0.7 ? "ALTO" : pct >= 0.4 ? "MODERADO" : "BAIXO";
}

/**
 * Vocabulário dos tipos de sinal de manipulação: rótulo legível +
 * descrição educativa exibida no atributo `title` do termo.
 * Chaves extras (lp_outflow, top10_concentration, whale_dump_pressure)
 * cobrem os padrões GNN mapeados em HEURISTIC_TO_GNN.
 */
export const TERM_LABELS: Record<string, { label: string; description: string }> = {
  pump_episode: { label: "Episódio de Pump", description: "Evento de valorização artificial do preço para atrair compradores, comum em esquemas de pump-and-dump." },
  dump_episode: { label: "Episódio de Dump", description: "Queda abrupta do preço após valorização artificial, indicando saída coordenada por grandes detentores." },
  volume_spike: { label: "Pico de Volume", description: "Volume de negociação anormalmente alto em curto período, sinalizando possível manipulação de mercado." },
  coordinated_cluster: { label: "Cluster Coordenado", description: "Grupo de endereços que transferem tokens entre si de forma sincronizada, sugerindo coordenação." },
  spoofing_layering: { label: "Spoofing/Layering", description: "Ordens falsas colocadas e canceladas rapidamente para criar falsa impressão de oferta/demanda e enganar outros traders." },
  lp_outflow: { label: "Saída de Liquidez (LP)", description: "Retirada expressiva de liquidez de pools, sinal de risco de rug pull." },
  top10_concentration: { label: "Concentração Top 10", description: "Alta concentração da oferta nos 10 maiores endereços, aumentando o risco de manipulação por poucos agentes." },
  wash_trading: { label: "Wash Trading", description: "Negociação entre contas controladas pela mesma parte para simular volume e enganar o mercado." },
  whale_dump: { label: "Descarte de Baleia", description: "Grande detentor (whale) movimentando ou vendendo parcela expressiva do supply, pressionando o preço para baixo." },
  whale_dump_pressure: { label: "Pressão de Venda de Baleias", description: "Grandes detentores (baleias) movimentando ativos para vendas massivas, pressionando o preço para baixo." },
  rug_pull: { label: "Rug Pull", description: "Retirada fraudulenta de liquidez ou fundos por desenvolvedores/insiders, abandonando o projeto." },
  short_and_distort: { label: "Short and Distort", description: "Venda a descoberto combinada à disseminação de notícias negativas para derrubar o preço." },
};

export function formatTerm(code: string | undefined): string {
  if (!code || !TERM_LABELS[code]) return code ?? "-";
  const { label, description } = TERM_LABELS[code];
  return `<span class="term" title="${description.replace(/"/g, "&quot;")}">${label}</span>`;
}

// ── Shared primitives ─────────────────────────────────────────────────

export function toNum(v: bigint): number {
  return Number(formatUnits(v, DECIMALS));
}

export function fmt(v: number, digits = 2): string {
  return v.toLocaleString("pt-BR", { maximumFractionDigits: digits });
}

export function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Serializa um objeto para embutir dentro de uma tag <script> com
 * segurança: `<` vira <, impedindo que um `</script>` em conteúdo
 * externo (labels, evidências, observações) quebre o documento.
 */
export function safeJsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

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

// ── Alert formatting ──────────────────────────────────────────────────

/**
 * HTML rolável da lista de alertas de um nó/aresta/fatia: ícone por
 * severidade, termo legível com descrição em `title`, scores
 * heurístico/neural/combinado e a evidência textual.
 */
export function formatAlertsHtml(alerts: PieAlert[]): string {
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

// ── Pie data builders ─────────────────────────────────────────────────

/**
 * Separa contas em fatias individuais e um grupo final limitado a
 * `maxGroupSharePct` do total. Itera as contas (já ordenadas em ordem
 * decrescente) exibindo-as individualmente enquanto a soma remanescente
 * superar o limite; o restante é retornado para ser agrupado na fatia
 * "Outras contas".
 *
 * @param accounts         - contas ordenadas da maior para a menor share.
 * @param maxGroupSharePct - teto percentual da fatia agrupada (default 10%).
 * @returns indivíduos exibidos um a um e contas que devem ser agrupadas.
 */
export function groupTail(
  accounts: RankedAccount[],
  maxGroupSharePct = 10,
): { individuals: RankedAccount[]; grouped: RankedAccount[] } {
  let remaining = accounts.reduce((s, a) => s + a.share, 0);
  const individuals: RankedAccount[] = [];
  let i = 0;
  while (i < accounts.length && remaining > maxGroupSharePct) {
    individuals.push(accounts[i]);
    remaining -= accounts[i].share;
    i++;
  }
  return { individuals, grouped: accounts.slice(i) };
}

/**
 * Retorna as últimas `limit` movimentações de uma conta (enviadas ou
 * recebidas), ordenadas da mais recente para a mais antiga.
 *
 * @param addr       - endereço da conta (qualquer caixa).
 * @param transfers  - transferências CAS já filtradas pelo escopo do relatório.
 * @param limit      - máximo de movimentações retornadas (default 10).
 * @returns lista de movimentações com direção, contraparte, valor e hash.
 */
export function lastMovements(addr: string, transfers: PieTransfer[], limit = 10): AccountMovement[] {
  const lower = addr.toLowerCase();
  const movs: AccountMovement[] = [];
  for (const t of transfers) {
    const from = t.from.toLowerCase();
    const to = t.to.toLowerCase();
    if (from !== lower && to !== lower) continue;
    movs.push({
      timestamp: Number(t.timeStamp),
      direction: from === lower ? "out" : "in",
      counterparty: from === lower ? to : from,
      value: toNum(BigInt(t.value)),
      hash: t.hash,
    });
  }
  movs.sort((a, b) => b.timestamp - a.timestamp);
  return movs.slice(0, limit);
}

/**
 * Nome de exibição de uma conta: "Anon N" em modo anônimo, label
 * conhecida ou endereço encurtado.
 */
export function displayAccountName(
  addr: string,
  labels: Map<string, PieLabelInfo>,
  anonFor: (a: string) => string | undefined,
): string {
  const anon = anonFor(addr.toLowerCase());
  if (anon) return anon;
  return labels.get(addr.toLowerCase())?.label || shortAddr(addr.toLowerCase());
}

/**
 * HTML clicável de uma conta para tooltips (link PolygonScan), ou
 * `<code>` com o nome anônimo em modo `--anon`.
 */
export function accountLinkHtml(
  addr: string,
  labels: Map<string, PieLabelInfo>,
  anonFor: (a: string) => string | undefined,
): string {
  const lower = addr.toLowerCase();
  if (lower === ZERO) return `<em>⛓️ endereço zero</em>`;
  const anon = anonFor(lower);
  if (anon) return `<code>${anon}</code>`;
  const known = labels.get(lower);
  const display = known?.label ? `${known.label} (${shortAddr(lower)})` : shortAddr(lower);
  return polyScanLink(lower, display);
}

/**
 * HTML da lista "Últimas N movimentações" de uma conta: data UTC,
 * direção (enviada/recebida/mint/burn), contraparte clicável, valor em
 * CAS e link do hash da transação no PolygonScan.
 */
export function formatMovementsHtml(
  movs: AccountMovement[],
  labels: Map<string, PieLabelInfo>,
  anonFor: (a: string) => string | undefined,
): string {
  if (movs.length === 0) return "";
  const rows = movs
    .map((m) => {
      const date = new Date(m.timestamp * 1000).toLocaleString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "UTC",
      });
      const isMint = m.direction === "in" && m.counterparty === ZERO;
      const isBurn = m.direction === "out" && m.counterparty === ZERO;
      const dir = isMint ? "🪙 Mint" : isBurn ? "🔥 Burn" : m.direction === "out" ? "▲ Enviada" : "▼ Recebida";
      const cp = isMint || isBurn ? "" : ` ${m.direction === "out" ? "→" : "←"} ${accountLinkHtml(m.counterparty, labels, anonFor)}`;
      const sign = m.direction === "out" ? "-" : "+";
      const color = m.direction === "out" ? "#eb3812" : "#F05F40";
      const txLink = `<a href="https://polygonscan.com/tx/${m.hash}" target="_blank" data-full-address="${m.hash}" style="color:#fcc650;text-decoration:none;"><code>${m.hash.slice(0, 10)}…</code></a>`;
      return `<li style="margin-bottom:3px;"><span style="color:var(--muted);font-size:.72rem;">${date} UTC</span> ${dir}${cp} <b style="color:${color};">${sign}${fmt(m.value, 2)}</b> ${txLink}</li>`;
    })
    .join("");
  return `<br><br><b style="color:#fcc650;">Últimas ${movs.length} movimentações:</b><ul style="margin:4px 0;padding-left:16px;list-style:none;">${rows}</ul>`;
}

/**
 * Tooltip rico de uma conta individual para as pizzas do dashboard:
 * identidade, saldo total atual, tipo/moeda/observação, estatísticas de
 * movimentação, últimas 10 movimentações e alertas de segurança.
 */
export function accountPieTooltip(params: {
  addr: string;
  labels: Map<string, PieLabelInfo>;
  anonFor: (a: string) => string | undefined;
  holderBalance: number;
  holderPct: number;
  stat?: { sent: number; received: number; volume: number };
  movements: AccountMovement[];
  alerts: PieAlert[];
}): string {
  const { addr, labels, anonFor, holderBalance, holderPct, stat, movements, alerts } = params;
  const lower = addr.toLowerCase();
  const known = labels.get(lower);
  const name = displayAccountName(lower, labels, anonFor);
  const type = known?.type ?? "unknown";
  const asset = known?.asset ?? "";
  const obs = known?.observation ?? "";
  const typeHtml = type !== "unknown" ? `<br>${typeEmoji(type)} Tipo: ${type}` : "";
  const assetHtml = asset ? `<br>💰 Moeda: ${asset}` : "";
  const obsHtml = obs ? `<br><em style="color:#f7d4ca;">${obs}</em>` : "";
  const balanceHtml = `<br><b>Saldo total atual:</b> ${fmt(holderBalance, 2)} CAS (${holderPct.toFixed(2)}% do supply)`;
  const statHtml = stat ? `<br>Enviadas: ${stat.sent} | Recebidas: ${stat.received}<br>Volume: ${fmt(stat.volume, 2)} CAS` : "";
  const alertBadge = alerts.length > 0 ? ` <span style="color:#eb3812;">⚠️ ${alerts.length}</span>` : "";
  return `<b>${name}</b>${alertBadge}<br>${accountLinkHtml(lower, labels, anonFor)}${balanceHtml}${typeHtml}${assetHtml}${statHtml}${obsHtml}${formatMovementsHtml(movements, labels, anonFor)}${formatAlertsHtml(alerts)}`;
}

/**
 * Tooltip da fatia agrupada "Outras contas": quantidade de contas,
 * participação somada, lista rolável das contas agrupadas (movimentações,
 * saldo e share) e alertas de segurança agregados dos membros.
 */
export function groupPieTooltip(
  members: RankedAccount[],
  metricLabel: string,
  labels: Map<string, PieLabelInfo>,
  anonFor: (a: string) => string | undefined,
  nodeStats: NodeStatsMap,
  holderBalanceMap: Map<string, { balance: bigint; pct: number }>,
  nodeAlertMap: Map<string, PieAlert[]>,
): string {
  const share = members.reduce((s, m) => s + m.share, 0);
  const alertSet = new Map<string, PieAlert>();
  for (const m of members) {
    for (const a of nodeAlertMap.get(m.address) ?? []) {
      alertSet.set(`${a.type}|${a.addresses.join(",")}`, a);
    }
  }
  const lines = members
    .map((m) => {
      const holder = holderBalanceMap.get(m.address);
      const stat = nodeStats.get(m.address);
      const detail = stat ? `${stat.sent + stat.received} mov. · ` : "";
      return `<li>${accountLinkHtml(m.address, labels, anonFor)} — ${detail}${holder ? `${fmt(toNum(holder.balance), 2)} CAS` : "sem saldo"} <span style="color:var(--muted);font-size:.72rem;">(${m.share.toFixed(2)}%)</span></li>`;
    })
    .join("");
  return `<b>Outras contas (${members.length})</b><br>Somadas: ${share.toFixed(2)}% ${metricLabel}<ul style="margin:6px 0;padding-left:16px;">${lines}</ul>${formatAlertsHtml([...alertSet.values()])}`;
}

/**
 * Constrói os dados das duas pizzas do dashboard:
 *
 * - `holders`: participação de cada conta no supply CAS (de `holders[]`).
 * - `movers`: participação de cada conta no total de movimentações
 *   (enviadas + recebidas, excluindo o endereço zero).
 *
 * Em ambos, contas são exibidas individualmente da maior para a menor;
 * quando a soma remanescente fica ≤10% do total, o resto vira a fatia
 * "Outras contas" (regra `groupTail`).
 *
 * @param transfers        - transferências no escopo do relatório.
 * @param holders          - holders com saldo > 0 (ordenados por saldo desc).
 * @param nodeStats        - estatísticas sent/received/volume por endereço.
 * @param labels           - labels conhecidas (env + DB).
 * @param anonFor          - resolve "Anon N" quando em modo anônimo.
 * @param nodeAlertMap     - alertas agrupados por endereço.
 * @param holderBalanceMap - saldo/pct por endereço.
 * @param totalMovements   - total de enviadas+recebidas (fora endereço zero).
 */
export function buildPieData(
  transfers: PieTransfer[],
  holders: PieHolderInfo[],
  nodeStats: NodeStatsMap,
  labels: Map<string, PieLabelInfo>,
  anonFor: (a: string) => string | undefined,
  nodeAlertMap: Map<string, PieAlert[]>,
  holderBalanceMap: Map<string, { balance: bigint; pct: number }>,
  totalMovements: number,
): PieData {
  const holderAccounts: RankedAccount[] = holders.map((h) => ({ address: h.address, share: h.pct }));
  const moverAccounts: RankedAccount[] = [...nodeStats.entries()]
    .filter(([a]) => a !== ZERO)
    .map(([a, s]) => ({ address: a, share: totalMovements > 0 ? ((s.sent + s.received) / totalMovements) * 100 : 0 }))
    .sort((a, b) => b.share - a.share);

  const mkSlice = (acc: RankedAccount): PieSlice => {
    const holder = holderBalanceMap.get(acc.address);
    const stat = nodeStats.get(acc.address);
    const alerts = nodeAlertMap.get(acc.address) ?? [];
    const movements = lastMovements(acc.address, transfers, 10);
    return {
      label: `${displayAccountName(acc.address, labels, anonFor)} · ${acc.share.toFixed(1)}%`,
      share: acc.share,
      tooltipHtml: accountPieTooltip({
        addr: acc.address,
        labels,
        anonFor,
        holderBalance: holder ? toNum(holder.balance) : 0,
        holderPct: holder ? holder.pct : 0,
        stat,
        movements,
        alerts,
      }),
    };
  };

  const h = groupTail(holderAccounts);
  const m = groupTail(moverAccounts);

  const holdersSlices = h.individuals.map(mkSlice);
  if (h.grouped.length > 0) {
    const share = h.grouped.reduce((s, a) => s + a.share, 0);
    holdersSlices.push({
      label: `Outras contas (${h.grouped.length}) · ${share.toFixed(1)}%`,
      share,
      tooltipHtml: groupPieTooltip(h.grouped, "do supply", labels, anonFor, nodeStats, holderBalanceMap, nodeAlertMap),
    });
  }

  const moverSlices = m.individuals.map(mkSlice);
  if (m.grouped.length > 0) {
    const share = m.grouped.reduce((s, a) => s + a.share, 0);
    moverSlices.push({
      label: `Outras contas (${m.grouped.length}) · ${share.toFixed(1)}%`,
      share,
      tooltipHtml: groupPieTooltip(m.grouped, "das movimentações", labels, anonFor, nodeStats, holderBalanceMap, nodeAlertMap),
    });
  }

  return { holders: holdersSlices, movers: moverSlices };
}

// ── Manipulation signal tooltips ──────────────────────────────────────

/**
 * Tooltip rico de uma linha da tabela de sinais de manipulação:
 * termo legível + descrição, severidade, período, endereços completos
 * com links PolygonScan (ou nomes anônimos), volume, nº de transações,
 * evidência completa e metadata opcional — tudo sanitizado.
 */
export function manipulationSignalTooltip(
  signal: {
    type: string;
    severity: "ALTO" | "MODERADO" | "BAIXO";
    start: number;
    end: number;
    addresses: string[];
    volumeCas: number;
    txCount: number;
    evidence: string;
    metadata?: Record<string, unknown>;
  },
  labels: Map<string, PieLabelInfo>,
  anonFor: (a: string) => string | undefined,
): string {
  const term = TERM_LABELS[signal.type];
  const termLabel = term?.label ?? signal.type;
  const termDesc = term ? `<br><span style="color:var(--muted);font-size:.78rem;">${escapeHtml(term.description)}</span>` : "";
  const sevColor = alertColor(signal.severity);
  const fmtTs = (ts: number) =>
    ts > 0
      ? new Date(ts * 1000).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC"
      : "—";
  const addrLines = signal.addresses
    .map((a) => `<li style="margin-bottom:2px;">${accountLinkHtml(a, labels, anonFor)}${labels.get(a.toLowerCase())?.type ? ` <span style="color:var(--muted);font-size:.72rem;">(${typeEmoji(labels.get(a.toLowerCase())!.type)} ${labels.get(a.toLowerCase())!.type})</span>` : ""}</li>`)
    .join("");
  const metaEntries = signal.metadata
    ? Object.entries(signal.metadata)
        .map(([k, v]) => `<li><span style="color:var(--muted);">${escapeHtml(k)}:</span> ${escapeHtml(typeof v === "string" ? v : JSON.stringify(v))}</li>`)
        .join("")
    : "";
  const metaHtml = metaEntries ? `<br><br><b style="color:#fcc650;">Metadados:</b><ul style="margin:4px 0;padding-left:16px;list-style:none;font-size:.75rem;">${metaEntries}</ul>` : "";

  return `<b>${escapeHtml(termLabel)}</b> <span style="color:${sevColor};font-weight:700;">(${signal.severity})</span>${termDesc}
    <br>Período: ${fmtTs(signal.start)} → ${fmtTs(signal.end)}
    <br>Volume suspeito: <b>${fmt(signal.volumeCas, 2)} CAS</b> · Transações: ${signal.txCount}
    <br><br><b style="color:#fcc650;">Endereços envolvidos (${signal.addresses.length}):</b>
    <ul style="margin:4px 0;padding-left:16px;list-style:none;">${addrLines || "<li>—</li>"}</ul>
    <b style="color:#fcc650;">Evidência:</b><br>${escapeHtml(signal.evidence)}${metaHtml}`;
}

// ── Browser-side JS ───────────────────────────────────────────────────

/**
 * Chart.js pie initialization shared by CAS dashboards.
 *
 * Reusa o tooltip rolável `window._visTooltip` (GRAPH_3D_TOOLTIP_JS) para
 * o tooltip externo — permite rolar o conteúdo rico das fatias. Se o CDN
 * do Chart.js falhar, cada canvas vira uma mensagem de fallback e o
 * restante do dashboard continua funcional.
 *
 * Espera um objeto global `pieData` com chaves nomeadas e uma lista
 * PIE_CHARTS [canvasId, key] — embutida no próprio snippet para bater
 * com os dashboards existentes.
 */
export const PIE_CHARTS_JS = `
// ── Distribuição CAS (pizzas Chart.js) ──
// Tooltip externo reusa window._visTooltip (mesmo tooltip rolável dos
// nós/arestas do grafo 3D). Chart.js indisponível (CDN offline) degrada
// para mensagem sem quebrar o restante do dashboard.
(function() {
  var PIE_CHARTS = [["pie-holders", "holders"], ["pie-movers", "movers"]];
  var CAS_PALETTE = ["#F05F40","#fcc650","#cc7501","#eb3812","#ce6e6d","#f7d4ca","#d4502e","#b5651d",
                     "#fdd97a","#d9908f","#fae5df","#ff7a5c","#e89642","#ffd98a","#f54020","#c43d18",
                     "#8a3a2c","#5d3a32","#eb6b4a","#e07a3a","#d49a5a"];

  function pieExternalTooltip(slices) {
    var currentIndex = -1;
    var swapTimer = null;
    function clearSwap() { if (swapTimer) { clearTimeout(swapTimer); swapTimer = null; } }
    return function(context) {
      var tip = document.getElementById("vis-custom-tooltip");
      // Tooltip em hover: congela o conteúdo para permitir rolagem —
      // o Chart.js continua emitindo eventos conforme o mouse cruza o canvas.
      if (tip && tip.matches(":hover")) { clearSwap(); return; }
      var t = context.tooltip;
      if (!window._visTooltip) return;
      if (!t || t.opacity === 0 || !t.dataPoints || t.dataPoints.length === 0) {
        clearSwap();
        // Delay maior para dar tempo de o mouse alcançar o tooltip.
        window._visTooltip.scheduleHide(700);
        return;
      }
      var idx = t.dataPoints[0].dataIndex;
      var slice = slices[idx];
      if (!slice) { clearSwap(); return; }
      var rect = context.chart.canvas.getBoundingClientRect();
      var x = rect.left + t.caretX;
      var y = rect.top + t.caretY;
      var visible = tip && tip.classList.contains("visible");
      if (idx === currentIndex || !visible) {
        clearSwap();
        currentIndex = idx;
        window._visTooltip.showTooltip(slice.tooltipHtml, x, y);
        return;
      }
      // Debounce: só troca o conteúdo se o hover permanecer na nova fatia,
      // evitando trocas ao cruzar fatias a caminho do tooltip.
      clearSwap();
      swapTimer = setTimeout(function() {
        swapTimer = null;
        if (tip && tip.matches(":hover")) return;
        currentIndex = idx;
        window._visTooltip.showTooltip(slice.tooltipHtml, x, y);
      }, 350);
    };
  }

  function initPie(canvasId, slices) {
    var el = document.getElementById(canvasId);
    if (!el || !slices || slices.length === 0) return;
    var chart = new Chart(el, {
      type: "pie",
      data: {
        labels: slices.map(function(s) { return s.label; }),
        datasets: [{ data: slices.map(function(s) { return s.share; }),
                     backgroundColor: CAS_PALETTE.slice(0, slices.length),
                     borderColor: "#712d23", borderWidth: 1 }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: "right", labels: { font: { size: 10 }, boxWidth: 14 } },
          tooltip: { enabled: false, external: pieExternalTooltip(slices) },
        },
      },
    });
    el.addEventListener("mouseleave", function() {
      if (window._visTooltip) window._visTooltip.scheduleHide(700);
    });
    return chart;
  }

  if (typeof Chart === "undefined" || typeof pieData === "undefined") {
    PIE_CHARTS.forEach(function(pair) {
      var el = document.getElementById(pair[0]);
      if (el) el.parentNode.innerHTML = "<p style='color:#f7d4ca;font-size:.85rem;'>Chart.js indisponível — verifique a conexão com o CDN e recarregue.</p>";
    });
    return;
  }
  Chart.defaults.color = "#f7d4ca";
  Chart.defaults.borderColor = "rgba(255,255,255,0.15)";
  PIE_CHARTS.forEach(function(pair) {
    initPie(pair[0], pieData[pair[1]]);
  });
})();
`;

/**
 * Hover tooltip binding para a tabela de sinais de manipulação:
 * linhas com `data-manip-idx` exibem o item correspondente do array
 * global `manipTooltips` (HTML gerado server-side por
 * manipulationSignalTooltip) no tooltip rolável `window._visTooltip`.
 */
// ── Whale threshold filter (combobox) ────────────────────────────────

/**
 * Percentuais de corte disponíveis no combobox "Wallets acima de X% do
 * supply" dos dashboards (Concentração, Top Holders). A listagem renderiza
 * todas as linhas com `data-whale-pct` e o filtro client-side oculta as
 * abaixo do limiar — sem reload nem reprocessamento.
 */
export const WHALE_THRESHOLDS = [5, 10, 15, 20, 30] as const;
export const WHALE_DEFAULT_PCT = WHALE_THRESHOLDS[0];

/** Menor limiar do combobox — linhas abaixo dele nunca são renderizadas. */
export function whaleMinThreshold(): number {
  return WHALE_THRESHOLDS[0];
}

/**
 * Monta o `<select id="${id}">` do limiar de whales. As linhas `<tr>` da
 * tabela alvo devem carregar `data-whale-pct="<pct>"`; WHALE_FILTER_JS
 * faz o binding do onchange.
 *
 * @param opts.tableId id do `<tbody>` que contém as linhas (obrigatório)
 * @param opts.countId id do `<span>` que exibe a contagem visível (opcional)
 */
export function buildWhaleThresholdSelect(
  id: string,
  opts: { tableId: string; countId?: string; defaultPct?: number },
): string {
  const def = opts.defaultPct ?? WHALE_DEFAULT_PCT;
  const options = WHALE_THRESHOLDS.map(
    (p) => `<option value="${p}"${p === def ? " selected" : ""}>${p}%</option>`,
  ).join("");
  const countAttr = opts.countId ? ` data-count-id="${escapeHtml(opts.countId)}"` : "";
  return `<select id="${escapeHtml(id)}" class="whale-threshold" data-table="#${escapeHtml(opts.tableId)}"${countAttr} style="background:var(--bg,#712d23);color:#fff;border:1px solid rgba(255,255,255,.25);border-radius:6px;padding:2px 8px;font-size:.85rem;margin:0 4px;vertical-align:middle;">${options}</select>`;
}

/**
 * Binding client-side do combobox de limiar: para cada `<select.whale-threshold>`,
 * oculta `<tr data-whale-pct>` abaixo do valor, exibe a linha placeholder
 * `data-whale-empty` quando nenhuma linha passa no corte e atualiza o
 * contador indicado por `data-count-id`.
 */
export const WHALE_FILTER_JS = `
// ── Filtro de limiar % nas tabelas de whales/holders ──
(function() {
  function applyWhaleFilter(sel) {
    var min = parseFloat(sel.value);
    var tbody = document.querySelector(sel.getAttribute("data-table") || "");
    if (!tbody) return;
    var rows = tbody.querySelectorAll("tr[data-whale-pct]");
    var shown = 0;
    rows.forEach(function(r) {
      var pct = parseFloat(r.getAttribute("data-whale-pct") || "0");
      var show = pct > min;
      r.style.display = show ? "" : "none";
      if (show) shown++;
    });
    var empty = tbody.querySelector("tr[data-whale-empty]");
    if (empty) empty.style.display = shown === 0 ? "" : "none";
    var countId = sel.getAttribute("data-count-id");
    var counter = countId ? document.getElementById(countId) : null;
    if (counter) counter.textContent = String(shown);
  }
  document.querySelectorAll("select.whale-threshold").forEach(function(sel) {
    sel.addEventListener("change", function() { applyWhaleFilter(sel); });
    applyWhaleFilter(sel); // estado inicial
  });
})();
`;

export const MANIP_TOOLTIP_BIND_JS = `
// ── Tooltips da tabela de sinais de manipulação ──
(function() {
  var table = document.getElementById("manipulation-table");
  if (!table || !window._visTooltip || typeof manipTooltips === "undefined") return;
  var currentIdx = -1;
  table.addEventListener("mousemove", function(e) {
    var tip = document.getElementById("vis-custom-tooltip");
    if (tip && tip.matches(":hover")) return; // usuário interagindo com o tooltip
    var row = e.target && e.target.closest ? e.target.closest("tr[data-manip-idx]") : null;
    if (!row) {
      if (currentIdx !== -1) { currentIdx = -1; window._visTooltip.scheduleHide(600); }
      return;
    }
    var idx = parseInt(row.getAttribute("data-manip-idx"), 10);
    if (idx !== currentIdx) currentIdx = idx;
    window._visTooltip.showTooltip(manipTooltips[idx] || "", e.clientX, e.clientY);
  });
  table.addEventListener("mouseleave", function() {
    currentIdx = -1;
    window._visTooltip.scheduleHide(600);
  });
})();
`;
