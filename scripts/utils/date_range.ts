/**
 * date_range.ts
 * -------------
 * Parsing e validação de período (`--from`/`--to`) para os dashboards de
 * análise do token CAS (cas_graph_dashboard, cas_distribution_dashboard).
 *
 * Formatos aceitos (sempre interpretados em UTC, como os relatórios):
 *   - ISO:          2026-11-01
 *   - ISO com hora: 2026-11-01_12-00, 2026-11-01T12:00, "2026-11-01 12:00"
 *   - Brasileiro:   01/11/2026, 01/11/2026_12-00, "01/11/2026 12:00"
 *
 * Quando apenas a data é informada, `--from` cobre a partir de 00:00:00 UTC
 * e `--to` cobre até 23:59:59 UTC do dia (limite inclusivo).
 *
 * Author:  Carlos Delfino
 * Email:   consultoria@carlosdelfino.eti.br
 * WhatsApp: +55 (85) 98520-5490
 */

/** Janela de tempo resolvida, em epoch seconds (UTC), limites inclusivos. */
export interface DateRangeFilter {
  /** Timestamp inicial (segundos). `undefined` = sem limite inferior. */
  fromTs?: number;
  /** Timestamp final (segundos). `undefined` = sem limite superior. */
  toTs?: number;
}

/** Resultado de {@link resolveDateRange}: `range` ausente quando nenhum filtro foi pedido. */
export interface ResolveDateRangeResult {
  range?: DateRangeFilter;
  error?: string;
}

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T_ ](\d{2})[:.-](\d{2})(?:[:.-](\d{2}))?)?$/;
const BR_RE = /^(\d{2})\/(\d{2})\/(\d{4})(?:[T_ ](\d{2})[:.-](\d{2})(?:[:.-](\d{2}))?)?$/;

const DAY_END_OFFSET_S = 86399; // 23:59:59 — torna --to de data-only inclusivo no dia inteiro.

/**
 * Converte um argumento de data/hora em epoch seconds UTC.
 *
 * @param raw - Valor bruto do argumento CLI (ex.: `2026-11-01_12-00`, `01/11/2026`).
 * @returns `{ ts, hasTime }` ou `null` quando o formato/valor é inválido
 *          (ex.: `31/02/2026`, `2026-13-01`, hora fora de faixa).
 */
export function parseDateArg(raw: string): { ts: number; hasTime: boolean } | null {
  const s = raw.trim();
  let m = ISO_RE.exec(s);
  let year: number, month: number, day: number;
  if (m) {
    year = +m[1]; month = +m[2]; day = +m[3];
  } else {
    m = BR_RE.exec(s);
    if (!m) return null;
    day = +m[1]; month = +m[2]; year = +m[3];
  }

  const hasTime = m[4] !== undefined;
  const hh = hasTime ? +m[4] : 0;
  const mi = m[5] !== undefined ? +m[5] : 0;
  const ss = m[6] !== undefined ? +m[6] : 0;
  if (hh > 23 || mi > 59 || ss > 59) return null;

  const ms = Date.UTC(year, month - 1, day, hh, mi, ss);
  const dt = new Date(ms);
  // Round-trip: rejeita datas de calendário inexistentes (ex.: 31/02).
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    return null;
  }
  return { ts: Math.floor(ms / 1000), hasTime };
}

/**
 * Resolve os argumentos `--from`/`--to` em uma {@link DateRangeFilter} validada.
 *
 * @param fromRaw - Valor de `--from` (opcional).
 * @param toRaw   - Valor de `--to` (opcional; data-only cobre o dia inteiro).
 * @returns `{ range }` com os limites em segundos, ou `{ error }` com mensagem
 *          amigável para log/exit quando o valor é inválido ou o intervalo é
 *          invertido. `range` é `undefined` quando nenhum filtro foi pedido.
 */
export function resolveDateRange(fromRaw?: string, toRaw?: string): ResolveDateRangeResult {
  if (!fromRaw && !toRaw) return { range: undefined };

  const hint = "formatos: AAAA-MM-DD[_HH-MM] ou DD/MM/AAAA[_HH-MM] (UTC)";
  const range: DateRangeFilter = {};

  if (fromRaw) {
    const parsed = parseDateArg(fromRaw);
    if (!parsed) return { error: `valor inválido para --from: "${fromRaw}" — ${hint}` };
    range.fromTs = parsed.ts;
  }
  if (toRaw) {
    const parsed = parseDateArg(toRaw);
    if (!parsed) return { error: `valor inválido para --to: "${toRaw}" — ${hint}` };
    range.toTs = parsed.hasTime ? parsed.ts : parsed.ts + DAY_END_OFFSET_S;
  }
  if (range.fromTs !== undefined && range.toTs !== undefined && range.fromTs > range.toTs) {
    return {
      error: `--from (${formatTs(range.fromTs)}) é posterior a --to (${formatTs(range.toTs)})`,
    };
  }
  return { range };
}

/**
 * Testa se um timestamp (epoch seconds) pertence à janela, limites inclusivos.
 *
 * @param tsSeconds - Timestamp da transação em segundos.
 * @param range     - Janela resolvida por {@link resolveDateRange}.
 * @returns `true` quando dentro da janela.
 */
export function inDateRange(tsSeconds: number, range: DateRangeFilter): boolean {
  if (range.fromTs !== undefined && tsSeconds < range.fromTs) return false;
  if (range.toTs !== undefined && tsSeconds > range.toTs) return false;
  return true;
}

/**
 * Formata um epoch-seconds como `AAAA-MM-DD HH:MM UTC` para logs e relatórios.
 *
 * @param tsSeconds - Timestamp em segundos.
 * @returns Data/hora legível em UTC.
 */
export function formatTs(tsSeconds: number): string {
  return new Date(tsSeconds * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

/**
 * Descreve a janela em texto pt-BR curto para logs e subtítulos de relatório.
 *
 * @param range - Janela resolvida por {@link resolveDateRange}.
 * @returns Texto como `de 2026-11-01 00:00 UTC até 2026-11-05 23:59 UTC`,
 *          `a partir de ...` ou `até ...`.
 */
export function describeDateRange(range: DateRangeFilter): string {
  if (range.fromTs !== undefined && range.toTs !== undefined) {
    return `de ${formatTs(range.fromTs)} até ${formatTs(range.toTs)}`;
  }
  if (range.fromTs !== undefined) return `a partir de ${formatTs(range.fromTs)}`;
  return `até ${formatTs(range.toTs!)}`;
}
