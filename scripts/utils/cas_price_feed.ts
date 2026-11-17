/**
 * @file cas_price_feed.ts
 * @notice Preco medio CAS/USD a partir dos pools DEX atuais na Polygon.
 * @dev    Le os pools com liquidez do CAS (pares V2 por reserva + quote V3
 *         via Quoter) e calcula o preco medio simples do CAS em USD usando
 *         Chainlink para a contraparte (POL/USD, ETH/USD; USDC/USDT ~ $1).
 *
 *         Mesma metodologia de `scripts/casswap/21_balance_dex_prices.ts`
 *         (preco spot por pool + media aritmetica), fatorada para reuso pelo
 *         seed do BinPool CAS/BNB na BSC (script 58).
 *
 *         Fallback: se nenhum pool tiver liquidez, usa CAS_WPOL_PRICE
 *         (quando numerico) ou CAS_PRICE_USD do .env.
 *
 *         CLI de inspecao:
 *           npx tsx scripts/utils/cas_price_feed.ts
 *
 * Author:  Carlos Delfino
 * Email:   consultoria@carlosdelfino.eti.br
 * WhatsApp: +55 (85) 98520-5490
 */
import "dotenv/config";
import { ethers } from "ethers";

const FILE = "scripts/utils/cas_price_feed.ts";

const WPOL = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";
const WETH = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619";
const USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
const USDT = "0xc2132D05D31c914a87C6611C10748AEb04B58e8F";

const FEED_POL_USD = process.env.CHAINLINK_POL_USD_FEED ?? "0xAB594600376Ec9fD91F8e885dADF0CE036862dE0";
const FEED_ETH_USD = "0xF9680D99D6C9589e2a93a78A04A279e509205945";

const PAIR_ABI = [
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
];
const V3_QUOTER_ABI = [
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) view returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
];
const CL_ABI = [
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
];
const ERC20_ABI = ["function decimals() view returns (uint8)"];

const V3_FEE_TIERS = [100, 500, 3000, 10000];

function log(level: string, message: string, params?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").split(".")[0];
  const extra = params ? ` - ${JSON.stringify(params)}` : "";
  console.log(`[${ts}] [${FILE}] ${level} ${message}${extra}`);
}

export interface PoolQuote {
  dex: string;
  pairAddress: string;
  pairedToken: string;
  pairedSymbol: string;
  casUsd: number;
  casReserve: bigint;
  hasLiquidity: boolean;
}

export interface CasPriceSnapshot {
  /** preco medio CAS em USD (media simples dos pools com liquidez) */
  casUsd: number;
  /** fonte: "scan" (media dos pools) ou "env-fallback" */
  source: "scan" | "env-fallback";
  quotes: PoolQuote[];
  polUsd: number;
  ethUsd: number;
}

async function feedUsd(provider: ethers.JsonRpcProvider, feed: string): Promise<number> {
  const c = new ethers.Contract(feed, CL_ABI, provider);
  const [, answer] = await c.latestRoundData();
  return Number(answer) / 1e8;
}

function checksum(addr: string | undefined | null): string | null {
  if (!addr) return null;
  try {
    return ethers.getAddress(addr);
  } catch {
    return null;
  }
}

/** Pares V2 do CAS considerados na media (LP token via .env). */
function v2Pairs(): { dex: string; pair: string }[] {
  const defs = [
    { dex: "QuickSwap V2", pair: checksum(process.env.QUICKSWAP_LP_TOKEN_ADDRESS) },
    { dex: "SushiSwap", pair: checksum(process.env.SUSHISWAP_LP_TOKEN_ADDRESS) },
    { dex: "ApeSwap", pair: checksum(process.env.APESWAP_LP_TOKEN_ADDRESS) },
    { dex: "Dfyn", pair: checksum(process.env.DFYN_LP_TOKEN_ADDRESS) },
    { dex: "DEX (generico)", pair: checksum(process.env.DEX_LP_TOKEN_ADDRESS) },
  ];
  return defs.filter((d): d is { dex: string; pair: string } => d.pair !== null);
}

/** Preco USD de referencia da contraparte (por endereco). */
function pairedUsdPrice(
  token: string,
  polUsd: number,
  ethUsd: number,
): { symbol: string; usd: number } {
  const t = token.toLowerCase();
  if (t === WPOL.toLowerCase()) return { symbol: "WPOL", usd: polUsd };
  if (t === WETH.toLowerCase()) return { symbol: "WETH", usd: ethUsd };
  if (t === USDC.toLowerCase()) return { symbol: "USDC", usd: 1 };
  if (t === USDT.toLowerCase()) return { symbol: "USDT", usd: 1 };
  return { symbol: "UNKNOWN", usd: 0 };
}

/**
 * Calcula o snapshot de preco do CAS: media simples do preco CAS/USD
 * spot de cada pool com liquidez (V2 por reservas, V3 por quoter).
 */
export async function getCasPriceSnapshot(
  rpcUrl?: string,
  casToken?: string,
): Promise<CasPriceSnapshot> {
  const rpc = rpcUrl ?? process.env.POLYGON_RPC_URL ?? "https://polygon.drpc.org";
  const cas = checksum(casToken ?? process.env.CAS_TOKEN_ADDRESS);
  if (!cas) throw new Error("CAS_TOKEN_ADDRESS nao configurado");

  const provider = new ethers.JsonRpcProvider(rpc);
  const [polUsd, ethUsd] = await Promise.all([
    feedUsd(provider, FEED_POL_USD),
    feedUsd(provider, FEED_ETH_USD),
  ]);

  const quotes: PoolQuote[] = [];

  // ── Pares V2 (preco = reserva contraparte / reserva CAS, ajustando decimais)
  for (const { dex, pair } of v2Pairs()) {
    const q: PoolQuote = {
      dex, pairAddress: pair, pairedToken: "", pairedSymbol: "",
      casUsd: 0, casReserve: 0n, hasLiquidity: false,
    };
    try {
      const p = new ethers.Contract(pair, PAIR_ABI, provider);
      const [[r0, r1], t0raw, t1raw] = await Promise.all([
        p.getReserves(), p.token0(), p.token1(),
      ]);
      const t0 = (t0raw as string).toLowerCase();
      const t1 = (t1raw as string).toLowerCase();
      const isCas0 = t0 === cas.toLowerCase();
      const paired = isCas0 ? t1 : t0;
      const casReserve = isCas0 ? r0 : r1;
      const pairedReserve = isCas0 ? r1 : r0;
      const { symbol, usd } = pairedUsdPrice(paired, polUsd, ethUsd);

      q.pairedToken = paired;
      q.pairedSymbol = symbol;
      q.casReserve = casReserve;
      q.hasLiquidity = casReserve > 0n && pairedReserve > 0n && usd > 0;

      if (q.hasLiquidity) {
        const pairedToken = new ethers.Contract(paired, ERC20_ABI, provider);
        const pairedDec = Number(await pairedToken.decimals());
        const casUnits = Number(ethers.formatUnits(casReserve, 18));
        const pairedUnits = Number(ethers.formatUnits(pairedReserve, pairedDec));
        const casInPaired = pairedUnits / casUnits; // contraparte por CAS
        q.casUsd = casInPaired * usd;
      }
    } catch (err: any) {
      log("WARN", "falha lendo par V2", { dex, pair, error: String(err?.message ?? err) });
    }
    quotes.push(q);
  }

  // ── Uniswap V3 (quote WPOL->CAS 1 WPOL nas fee tiers; melhor quote vence)
  const uniQuoter = checksum(process.env.UNISWAP_V3_QUOTER) ?? "0xb27308f9F90D607463bb33eA1BeBb41C2765c608";
  const q3: PoolQuote = {
    dex: "Uniswap V3", pairAddress: process.env.UNIV3_POOL_ADDRESS ?? "",
    pairedToken: WPOL, pairedSymbol: "WPOL", casUsd: 0,
    casReserve: 0n, hasLiquidity: false,
  };
  try {
    const quoter = new ethers.Contract(uniQuoter, V3_QUOTER_ABI, provider);
    const amountIn = ethers.parseEther("1");
    let bestOut = 0n;
    for (const fee of V3_FEE_TIERS) {
      try {
        const out = await quoter.quoteExactInputSingle.staticCall({
          tokenIn: WPOL, tokenOut: cas, amountIn, fee, sqrtPriceLimitX96: 0n,
        });
        const outAmt = (out as unknown as bigint[])[0] as bigint;
        if (outAmt > bestOut) bestOut = outAmt;
      } catch {
        // fee tier sem pool
      }
    }
    if (bestOut > 0n) {
      const casPerWpol = Number(ethers.formatUnits(bestOut, 18));
      q3.casUsd = polUsd / casPerWpol;
      q3.casReserve = bestOut;
      q3.hasLiquidity = true;
    }
  } catch (err: any) {
    log("WARN", "falha no quoter V3", { error: String(err?.message ?? err) });
  }
  quotes.push(q3);

  // ── Media simples CAS/USD dos pools com liquidez ───────────────────
  const valid = quotes.filter((q) => q.hasLiquidity && q.casUsd > 0);
  if (valid.length === 0) {
    const wpolFixed = parseFloat(process.env.CAS_WPOL_PRICE ?? "");
    const envUsd = parseFloat(process.env.CAS_PRICE_USD ?? "0.0005");
    const casUsd = Number.isFinite(wpolFixed) && wpolFixed > 0
      ? wpolFixed * polUsd
      : envUsd;
    log("WARN", "nenhum pool com liquidez — usando fallback de .env", { casUsd });
    return { casUsd, source: "env-fallback", quotes, polUsd, ethUsd };
  }

  const casUsd = valid.reduce((s, q) => s + q.casUsd, 0) / valid.length;
  return { casUsd, source: "scan", quotes, polUsd, ethUsd };
}

/**
 * CAS por BNB no preco medio (quantos CAS valem 1 BNB).
 * @param bnbUsd preco BNB/USD (Chainlink BSC feed).
 */
export async function getCasPerBnb(bnbUsd: number, snapshot?: CasPriceSnapshot): Promise<number> {
  const snap = snapshot ?? (await getCasPriceSnapshot());
  if (snap.casUsd <= 0) throw new Error("preco CAS/USD invalido");
  return bnbUsd / snap.casUsd;
}

/** Feed BNB/USD (Chainlink) — chamar com provider da BSC. */
export async function getBnbUsd(provider: ethers.JsonRpcProvider): Promise<number> {
  const feed = process.env.CHAINLINK_BNB_USD_FEED ?? "0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE";
  return feedUsd(provider, feed);
}

// ── CLI de inspecao ──────────────────────────────────────────────────

async function cli(): Promise<void> {
  const snap = await getCasPriceSnapshot();
  console.log(`\n  Fonte: ${snap.source} | POL/USD $${snap.polUsd.toFixed(6)} | ETH/USD $${snap.ethUsd.toFixed(2)}`);
  console.log(`\n  ${"DEX".padEnd(16)} ${"Par".padEnd(10)} ${"CAS/USD".padStart(14)} ${"CAS reserve".padStart(18)}`);
  for (const q of snap.quotes) {
    const flag = q.hasLiquidity ? "" : "  (sem liquidez)";
    console.log(
      `  ${q.dex.padEnd(16)} ${q.pairedSymbol.padEnd(10)} ${q.casUsd > 0 ? q.casUsd.toExponential(4).padStart(14) : "-".padStart(14)} ${ethers.formatEther(q.casReserve).padStart(18)}${flag}`,
    );
  }
  console.log(`\n  CAS/USD medio: $${snap.casUsd.toExponential(4)}\n`);
}

if (require.main === module) {
  cli().catch((err) => {
    log("ERROR", "falha", { error: String(err?.message ?? err) });
    process.exit(1);
  });
}
