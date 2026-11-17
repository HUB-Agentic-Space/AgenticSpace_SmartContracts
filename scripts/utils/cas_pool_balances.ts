/**
 * cas_pool_balances.ts
 * --------------------
 * Saldo atual e liquidez inicial dos pools CAS descobertos on-chain
 * (`pool_creations`, ver cas_dex_pools.ts / syncPoolCreators), para a aba
 * "Saldos dos Pools" do analysis:cas:distribution. Somente leitura: usa
 * eth_call/balanceOf/getReserves/getLogs — nunca assina nem envia tx.
 *
 * Estratégia por tipo de pool (espelha automation/pool_monitor.py do
 * AnaliseCAS, que reporta os mesmos saldos via alertas de desktop):
 * - v2/algebra: getReserves() do pair; fallback balanceOf dos dois tokens
 *   no endereço do pair;
 * - v3: balanceOf dos dois tokens no contrato do pool;
 * - v4: não existe contrato de pair — as moedas ficam no PoolManager e o
 *   saldo lido é o AGREGADO de todas as pools daquela moeda (marcado
 *   `aggregated`, nunca comparado com liquidez inicial);
 * - diamond (CASSwap): balanceOf de CAS no Diamond + saldo nativo POL,
 *   mais saldos extras de stablecoins registradas.
 *
 * Liquidez inicial: valor do contra-par no primeiro evento Mint após o
 * bloco de criação (mesmo critério do AnaliseCAS). Quando não há Mint
 * (V4, Diamond) a coluna fica indisponível e o status é "n/a".
 *
 * Author: Carlos Delfino
 * Email: consultoria@carlosdelfino.eti.br
 * WhatsApp: +55 (85) 98520-5490
 */

import { scanRequest } from "./cas_sync";
import type { DexPoolView } from "./cas_dex_pools";
import { escapeHtml, shortAddr } from "./cas_report_charts";
import { polyScanLink } from "./vis_tooltip";

type LogLevel = "INFO" | "WARN" | "ERROR" | "OK" | "DEBUG";

function log(level: LogLevel, fn: string, msg: string, p?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const emoji = { INFO: "ℹ️", WARN: "⚠️", ERROR: "❌", OK: "✅", DEBUG: "🔍" }[level];
  console.log(`[${ts}] [cas_pool_balances:${fn}] ${emoji} ${msg}${p ? " - " + JSON.stringify(p) : ""}`);
}

// ── Constantes on-chain ───────────────────────────────────────────────

const CAS_DECIMALS = 18;
const POOL_MANAGER_V4 = "0x67366782805870060151383f4bbff9dab53e5cd6";
const CASSWAP_DIAMOND = "0x80bd976cb588cd2f9ad9ac671fb19174e9f3172b";

// Seletores ABI mínimos (mesmos do chain_reader.py).
const SEL_BALANCE_OF = "0x70a08231";
const SEL_DECIMALS = "0x313ce567";
const SEL_GET_RESERVES = "0x0902f1ac";

// keccak256 dos eventos Mint V2/V3 (Algebra usa o layout V3).
const MINT_V2_TOPIC = "0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f";
const MINT_V3_TOPIC = "0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde";

// Moedas já catalogadas (símbolo + decimais); o resto resolve via
// decimals() on-chain e endereço curto como símbolo.
const KNOWN_CURRENCIES: Record<string, { symbol: string; decimals: number }> = {
  "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270": { symbol: "WPOL", decimals: 18 },
  "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619": { symbol: "WETH", decimals: 18 },
  "0x4c28f48448720e9000907bc2611f73022fdce1fa": { symbol: "WETH", decimals: 18 },
  "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359": { symbol: "USDC", decimals: 6 },
  "0x2791bca1f2de4661ed88a30c99a7a9449aa84174": { symbol: "USDC.e", decimals: 6 },
  "0xc2132d05d31c914a87c6611c10748aeb04b58e8f": { symbol: "USDT", decimals: 6 },
  "0xe6a537a407488807f0bbeb0038b79004f19dddfb": { symbol: "BRLA", decimals: 18 },
  "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6": { symbol: "WBTC", decimals: 8 },
  "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063": { symbol: "DAI", decimals: 18 },
};

// Endereço "0x0" marca moeda nativa nos pools V4.
const NATIVE_POL = "0x0000000000000000000000000000000000000000";

// RPCs diretos para fallback quando o scan proxy falha ou não há API key.
const RPC_FALLBACKS = [
  process.env.POLYGON_RPC_URL?.trim(),
  "https://polygon-bor-rpc.publicnode.com",
  "https://polygon.drpc.org",
].filter((u): u is string => !!u);

// ── Leitura on-chain ──────────────────────────────────────────────────

/**
 * eth_call somente-leitura: primeiro via proxy do scan (module=proxy,
 * que já lida com rate-limit/retries), depois RPC direto nos fallbacks.
 */
async function ethCall(to: string, data: string): Promise<string | null> {
  try {
    const raw = (await scanRequest({
      module: "proxy", action: "eth_call", to, data, tag: "latest",
    })) as string;
    if (typeof raw === "string" && raw.startsWith("0x")) return raw;
  } catch {
    // segue para RPC direto
  }
  for (const url of RPC_FALLBACKS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "eth_call",
          params: [{ to, data }, "latest"],
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) continue;
      const body = (await res.json()) as { result?: string };
      if (typeof body.result === "string" && body.result.startsWith("0x")) {
        return body.result;
      }
    } catch {
      continue;
    }
  }
  return null;
}

/** eth_getBalance (wei) via RPC direto — scan proxy não expõe balance. */
async function nativeBalance(address: string): Promise<bigint | null> {
  for (const url of RPC_FALLBACKS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "eth_getBalance",
          params: [address, "latest"],
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) continue;
      const body = (await res.json()) as { result?: string };
      if (typeof body.result === "string") return BigInt(body.result);
    } catch {
      continue;
    }
  }
  return null;
}

function word(raw: string, index: number): bigint | null {
  const hex = raw.slice(2);
  const start = index * 64;
  if (hex.length < start + 64) return null;
  return BigInt("0x" + hex.slice(start, start + 64));
}

function erc20Balance(token: string, holder: string): Promise<bigint | null> {
  const data = SEL_BALANCE_OF + holder.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  return ethCall(token, data).then((raw) => (raw ? word(raw, 0) : null));
}

async function erc20Decimals(token: string): Promise<number> {
  const raw = await ethCall(token, SEL_DECIMALS);
  const value = raw ? word(raw, 0) : null;
  return value !== null ? Number(value) : 18;
}

function currencyMeta(address: string): { symbol: string; decimals: number } {
  const known = KNOWN_CURRENCIES[address.toLowerCase()];
  if (known) return known;
  return { symbol: shortAddr(address), decimals: 18 };
}

interface ScanLog {
  blockNumber: string;
  logIndex?: string;
  data: string;
  topics: string[];
  transactionHash: string;
}

/**
 * Valores (amount0, amount1) do primeiro Mint do pool a partir do bloco
 * de criação — mesma baseline do alerta de desktop do AnaliseCAS.
 * Tenta os dois tópicos (V2 e V3/Algebra) e devolve o mais antigo.
 */
async function firstMintAmounts(
  poolId: string, createdBlock: number,
): Promise<{ amount0: bigint; amount1: bigint; txHash: string } | null> {
  if (!createdBlock) return null;
  const candidates: ScanLog[] = [];
  for (const topic0 of [MINT_V2_TOPIC, MINT_V3_TOPIC]) {
    try {
      const logs = (await scanRequest({
        module: "logs", action: "getLogs",
        fromBlock: String(createdBlock), toBlock: "latest",
        address: poolId, topic0,
      })) as ScanLog[];
      if (Array.isArray(logs)) candidates.push(...logs);
    } catch (err) {
      log("WARN", "firstMintAmounts", "getLogs de Mint falhou", {
        poolId: poolId.slice(0, 14), error: (err as Error).message,
      });
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) =>
    (parseInt(a.blockNumber, 16) - parseInt(b.blockNumber, 16)) ||
    (parseInt(a.logIndex ?? "0x0", 16) - parseInt(b.logIndex ?? "0x0", 16)));
  const entry = candidates[0];
  const data = (entry.data ?? "0x").slice(2);
  const isV3 = (entry.topics[0] ?? "").toLowerCase() === MINT_V3_TOPIC;
  // V3 data: sender|amount|amount0|amount1; V2 data: amount0|amount1.
  const w0 = isV3 ? 2 : 0;
  const w1 = isV3 ? 3 : 1;
  if (data.length < (w1 + 1) * 64) return null;
  return {
    amount0: BigInt("0x" + data.slice(w0 * 64, w0 * 64 + 64)),
    amount1: BigInt("0x" + data.slice(w1 * 64, w1 * 64 + 64)),
    txHash: entry.transactionHash,
  };
}

// ── View model ────────────────────────────────────────────────────────

export type PoolExcess = "excesso" | "ok" | "na";

export interface PoolBalance {
  dexName: string;
  poolId: string;
  isV4: boolean;
  kind: "v2" | "v3" | "v4" | "diamond" | "algebra";
  pairLabel: string;
  casBalance: number | null;
  quoteSymbol: string;
  quoteBalance: number | null;
  /** Saldo do contra-par no primeiro Mint (mesma unidade de quote). */
  initialQuote: number | null;
  initialTxHash: string | null;
  /** V4: saldo agregado do PoolManager, não só deste pool. */
  aggregated: boolean;
  /** Saldos extras relevantes (ex.: USDC no CASSwap Diamond). */
  extras: { symbol: string; balance: number }[];
  excess: PoolExcess;
  error?: string;
}

function kindOf(view: DexPoolView): PoolBalance["kind"] {
  const name = view.dexName.toLowerCase();
  if (view.isV4 || name.includes("v4")) return "v4";
  if (name.includes("algebra")) return "algebra";
  if (name.includes("v3")) return "v3";
  if (name.includes("casswap") || view.poolId.toLowerCase() === CASSWAP_DIAMOND) return "diamond";
  return "v2";
}

/** Lê os saldos CAS + contra-par de um pool; falhas viram `error`. */
async function readPoolBalance(
  view: DexPoolView, casAddress: string,
): Promise<PoolBalance> {
  const kind = kindOf(view);
  const casToken = casAddress.toLowerCase();
  const [casSide, quoteToken] =
    view.token0.toLowerCase() === casToken
      ? [view.token0.toLowerCase(), view.token1.toLowerCase()]
      : [view.token1.toLowerCase(), view.token0.toLowerCase()];
  const isNativeQuote = quoteToken === NATIVE_POL;
  const quote = isNativeQuote
    ? { symbol: "POL", decimals: 18 }
    : currencyMeta(quoteToken);
  const base: PoolBalance = {
    dexName: view.dexName,
    poolId: view.poolId,
    isV4: view.isV4,
    kind,
    pairLabel: view.pairLabel,
    casBalance: null,
    quoteSymbol: quote.symbol,
    quoteBalance: null,
    initialQuote: null,
    initialTxHash: null,
    aggregated: kind === "v4",
    extras: [],
    excess: "na",
  };
  try {
    let casRaw: bigint | null = null;
    let quoteRaw: bigint | null = null;

    if (kind === "diamond") {
      casRaw = await erc20Balance(casSide, view.poolId);
      quoteRaw = isNativeQuote
        ? await nativeBalance(view.poolId)
        : await erc20Balance(quoteToken, view.poolId);
      const usdc = await erc20Balance(
        "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", view.poolId);
      if (usdc !== null && usdc > 0n) {
        base.extras.push({ symbol: "USDC", balance: Number(usdc) / 1e6 });
      }
    } else {
      const holder = kind === "v4" ? POOL_MANAGER_V4 : view.poolId;
      if (kind === "v2") {
        const raw = await ethCall(view.poolId, SEL_GET_RESERVES);
        const r0 = raw ? word(raw, 0) : null;
        const r1 = raw ? word(raw, 1) : null;
        if (r0 !== null && r1 !== null) {
          [casRaw, quoteRaw] =
            view.token0.toLowerCase() === casSide ? [r0, r1] : [r1, r0];
        }
      }
      if (casRaw === null) {
        // v3/algebra/v4 ou V2 sem getReserves: balanceOf dos dois lados.
        casRaw = await erc20Balance(casSide, holder);
        quoteRaw = isNativeQuote
          ? await nativeBalance(holder)
          : await erc20Balance(quoteToken, holder);
      }
    }

    base.casBalance = casRaw !== null ? Number(casRaw) / 10 ** CAS_DECIMALS : null;
    base.quoteBalance = quoteRaw !== null ? Number(quoteRaw) / 10 ** quote.decimals : null;
  } catch (err) {
    base.error = (err as Error).name;
  }

  // Baseline: primeiro Mint após o bloco de criação (só faz sentido em
  // pools com contrato próprio — V4/Diamond ficam "n/a").
  if (kind === "v2" || kind === "v3" || kind === "algebra") {
    const mint = await firstMintAmounts(view.poolId, view.blockNumber);
    if (mint) {
      const quoteRaw =
        view.token0.toLowerCase() === casSide ? mint.amount1 : mint.amount0;
      base.initialQuote = Number(quoteRaw) / 10 ** quote.decimals;
      base.initialTxHash = mint.txHash;
      if (base.quoteBalance !== null && base.initialQuote !== null) {
        base.excess =
          base.quoteBalance > base.initialQuote * (1 + 1e-9) ? "excesso" : "ok";
      }
    }
  }
  return base;
}

/**
 * Resolve símbolo/decimais dos contra-pares desconhecidos em paralelo e
 * lê o saldo de cada pool sequencialmente (respeita rate limit do scan).
 */
export async function fetchPoolBalances(
  views: DexPoolView[], casAddress: string,
): Promise<PoolBalance[]> {
  const rows: PoolBalance[] = [];
  for (const view of views) {
    // Decimais de moedas fora do mapa: lê on-chain antes de normalizar.
    const quoteToken =
      view.token0.toLowerCase() === casAddress.toLowerCase()
        ? view.token1.toLowerCase() : view.token0.toLowerCase();
    if (!KNOWN_CURRENCIES[quoteToken] && quoteToken !== NATIVE_POL) {
      const decimals = await erc20Decimals(quoteToken);
      KNOWN_CURRENCIES[quoteToken] = { symbol: shortAddr(quoteToken), decimals };
    }
    rows.push(await readPoolBalance(view, casAddress));
  }
  return rows;
}

// ── HTML ──────────────────────────────────────────────────────────────

const fmtNum = (v: number | null, digits = 6): string =>
  v === null ? "—" : v.toLocaleString("en-US", { maximumFractionDigits: digits });

const EXCESS_BADGE: Record<PoolExcess, string> = {
  excesso: `<span style="color:#ff9a7a;font-weight:700" title="Saldo do contra-par acima da liquidez inicial">⚠ EXCESSO</span>`,
  ok: `<span style="color:#9ad6a5">dentro</span>`,
  na: `<span style="color:#f7d4ca">n/a</span>`,
};

/**
 * Linhas `<tr>` da tabela "Saldos dos Pools". Excesso é avaliado só
 * quando a baseline first-Mint existe; V4 (agregado) e Diamond mostram
 * "n/a" — nunca apresenta inferência como fato.
 */
export function buildPoolBalanceRows(rows: PoolBalance[]): string {
  if (rows.length === 0) {
    return `<tr><td colspan="8" style="text-align:center;color:#712d23">Nenhum pool on-chain registrado — rode a sincronização de pool creators</td></tr>`;
  }
  return rows
    .map((r) => {
      const poolCell = r.isV4
        ? `<code title="PoolId V4 (PoolManager)">${shortAddr(r.poolId)}</code>`
        : polyScanLink(r.poolId, shortAddr(r.poolId));
      const extras = r.extras
        .map((e) => `<br>+ ${fmtNum(e.balance)} ${escapeHtml(e.symbol)}`)
        .join("");
      const aggNote = r.aggregated
        ? `<br><span style="font-size:.72rem;color:#f7d4ca" title="V4 não tem contrato de pair: o saldo é o total da moeda no PoolManager, somando todas as pools">agregado PoolManager</span>`
        : "";
      const errorNote = r.error
        ? `<br><span style="font-size:.72rem;color:#ff9a7a">leitura falhou (${escapeHtml(r.error)})</span>`
        : "";
      const initialCell = r.initialTxHash
        ? `${fmtNum(r.initialQuote)}<br>${polyScanLink(r.initialTxHash, "tx")}`
        : r.initialQuote !== null ? fmtNum(r.initialQuote) : "—";
      return `<tr>
      <td>${escapeHtml(r.dexName)}</td>
      <td>${escapeHtml(r.pairLabel)}</td>
      <td>${poolCell}</td>
      <td data-sort="${r.casBalance ?? -1}">${fmtNum(r.casBalance, 2)} CAS${errorNote}</td>
      <td data-sort="${r.quoteBalance ?? -1}">${fmtNum(r.quoteBalance)} ${escapeHtml(r.quoteSymbol)}${extras}${aggNote}</td>
      <td data-sort="${r.initialQuote ?? -1}">${initialCell}</td>
      <td>${EXCESS_BADGE[r.excess]}</td>
      <td style="font-size:.78rem;color:#f7d4ca">${escapeHtml(r.kind)}</td>
    </tr>`;
    })
    .join("");
}
