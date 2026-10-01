export interface MarketSample {
  source: string;
  pricePolPerCas: number;
  liquidityUsd: number;
  observedAtMs: number;
}

/**
 * Returns the CAS reserve index when the pair is exactly CAS/WPOL, or -1 for
 * any other pair. A pool whose other token is not WPOL (e.g. the configured
 * Dfyn pair 0x2275..., which is CAS/WETH) is not a POL market: its quote
 * reserve must never be denominated as POL in the envelope.
 */
export function casPolReserveIndex(token0: string, token1: string, cas: string, wpol: string): number {
  const tokens = [token0.toLowerCase(), token1.toLowerCase()];
  const ci = tokens.indexOf(cas.toLowerCase());
  return ci >= 0 && tokens[1 - ci] === wpol.toLowerCase() ? ci : -1;
}

/**
 * Absolute difference between two CAS-per-quote ratios, in basis points of a.
 */
export function ratioDiffBps(a: readonly [bigint, bigint], b: readonly [bigint, bigint]): bigint {
  if (a[0] <= 0n || a[1] <= 0n) return 10000n;
  const oldScaled = a[0] * b[1], next = b[0] * a[1];
  return ((next >= oldScaled ? next - oldScaled : oldScaled - next) * 10000n) / oldScaled;
}

/**
 * CAS/USDC numerator (denominator is 1) derived from the on-chain CAS/POL
 * ratio and the Chainlink POL/USD answer: casPerUsdc = polNum/polDen /
 * (answer/10^feedDecimals). The numerator is scaled by 1e12 so that
 * casOut_base = usdcIn_base * num/den converts 6-decimal USDC input into
 * 18-decimal CAS output at the intended human CAS-per-USDC price.
 */
export function usdcNumFromPolRatio(polNum: bigint, polDen: bigint, feedAnswer: bigint, feedDecimals: number): bigint {
  if (polNum <= 0n || polDen <= 0n || feedAnswer <= 0n ||
    !Number.isInteger(feedDecimals) || feedDecimals < 0 || feedDecimals > 36)
    throw new Error("Invalid inputs for USDC ratio derivation");
  return (polNum * 10n ** (BigInt(feedDecimals) + 12n)) / (polDen * feedAnswer);
}

/**
 * Order for the individual USDC setters that never leaves a transient reverse
 * spread (buy CAS/USDC above sell CAS/USDC). Returns null only when the target
 * itself is a reverse spread — with a consistent target a safe order always
 * exists, so there is no need for the atomic setter just to choose one.
 */
export function planUsdcSequentialUpdate(
  oldBuy: readonly [bigint, bigint], oldSell: readonly [bigint, bigint],
  newBuy: readonly [bigint, bigint], newSell: readonly [bigint, bigint]
): Array<"buy" | "sell"> | null {
  const le = (a: readonly [bigint, bigint], b: readonly [bigint, bigint]) => a[0] * b[1] <= b[0] * a[1];
  if (!le(newBuy, newSell)) return null;
  if (le(newBuy, oldSell)) return ["buy", "sell"];
  if (le(oldBuy, newSell)) return ["sell", "buy"];
  return null;
}

/** Prices are POL per CAS; contract ratios are the inverse (CAS per POL). */
export function selectMarketEnvelope(samples: MarketSample[], polUsd: number, nowMs: number,
  minLiquidityUsd = 0, maxAgeMs = 120_000) {
  if (!Number.isFinite(polUsd) || polUsd <= 0) throw new Error("Invalid POL/USD price");
  if (!Number.isFinite(minLiquidityUsd) || minLiquidityUsd < 0) throw new Error("Invalid minimum liquidity");
  if (samples.some(s => !Number.isFinite(s.observedAtMs) || s.observedAtMs > nowMs || nowMs - s.observedAtMs > maxAgeMs))
    throw new Error("A market source is stale; refusing an incomplete envelope");
  const valid = samples.filter(s => Number.isFinite(s.pricePolPerCas) && s.pricePolPerCas > 0 &&
    Number.isFinite(s.liquidityUsd) && s.liquidityUsd > 0 && s.liquidityUsd >= minLiquidityUsd &&
    Number.isFinite(s.observedAtMs) && s.observedAtMs <= nowMs && nowMs - s.observedAtMs <= maxAgeMs);
  if (!valid.length) throw new Error("No fresh valid market quotes; ratio update aborted");
  const buyPricePol = Math.max(...valid.map(s => s.pricePolPerCas));
  const sellPricePol = Math.min(...valid.map(s => s.pricePolPerCas));
  return { buyPricePol, sellPricePol, buyPriceUsd: buyPricePol * polUsd, sellPriceUsd: sellPricePol * polUsd,
    buyCasPerPol: 1 / buyPricePol, sellCasPerPol: 1 / sellPricePol,
    buyCasPerUsdc: 1 / (buyPricePol * polUsd), sellCasPerUsdc: 1 / (sellPricePol * polUsd),
    buySource: valid.find(s => s.pricePolPerCas === buyPricePol)!.source,
    sellSource: valid.find(s => s.pricePolPerCas === sellPricePol)!.source,
    sources: valid.map(s => s.source) };
}
