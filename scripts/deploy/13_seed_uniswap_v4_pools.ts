/**
 * @file 13_seed_uniswap_v4_pools.ts
 * @notice Cria e semeia 5 pools CAS no Uniswap V4 (Polygon) a 1 CAS = 0,0003
 *         WPOL: CAS/USDC, CAS/USDT, CAS/WPOL, CAS/WETH, CAS/BRLA — 500.000 CAS
 *         por pool, fee 3000, tickSpacing 60, faixa ±10%.
 * @dev    Opcionalmente minta CAS para o deployer (MINTER_ROLE) antes dos
 *         pools. Pagamentos de liquidez via Permit2 (approve -> permit2.approve
 *         -> PositionManager.modifyLiquidities com MINT_POSITION + SETTLE_PAIR).
 *
 *         Modo DRY_RUN (padrão): nenhuma tx é enviada; o script lê saldos e
 *         feeds on-chain, estima gas e imprime a TABELA DE PROVISÃO (saldo x
 *         necessário x faltante por moeda + POL de gas com +20%).
 *
 *         Uso:
 *           DRY_RUN=true  npx hardhat run scripts/deploy/13_seed_uniswap_v4_pools.ts --network polygon
 *           DRY_RUN=false npx hardhat run scripts/deploy/13_seed_uniswap_v4_pools.ts --network polygon
 *
 * Author:  Carlos Delfino
 * Email:   consultoria@carlosdelfino.eti.br
 * WhatsApp: +55 (85) 98520-5490
 */
import "dotenv/config";
import { ethers } from "hardhat";
import {
  SEP,
  SUB,
  fmtGwei,
  getNetworkInfo,
  requireEnv,
} from "../utils/deploy_helpers";

const FILE = "scripts/deploy/13_seed_uniswap_v4_pools.ts";

function log(level: string, message: string, params?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").split(".")[0];
  const extra = params ? ` - ${JSON.stringify(params)}` : "";
  console.log(`[${ts}] [${FILE}:main] ${level} ${message}${extra}`);
}

// ── Endereços fixos (Polygon mainnet) ────────────────────────────────

const UNIV4_POOL_MANAGER = "0x67366782805870060151383F4BbFF9daB53e5cD6";
const UNIV4_POSITION_MANAGER = "0x1ec2ebf4f37e7363fdfe3551602425af0b3ceef9";
const UNIV4_STATE_VIEW = "0x5ea1bd7974c8a611cbab0bdcafcb1d9cc9b3ba5a";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const ZERO_HOOKS = ethers.ZeroAddress;

const CAS = "0x5151A34EaC7bA08cd6B540b32cD30316218A2287";
const USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"; // nativo Circle
const USDT = "0xc2132D05D31c914a87C6611C10748AEb04B58e8F";
const WPOL = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";
const WETH = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619";
const BRLA = "0xE6A537a407488807F0bbeb0038B79004f19DDDFb";

const FEED_POL_USD = "0xAB594600376Ec9fD91F8e885dADF0CE036862dE0";
const FEED_ETH_USD = "0xF9680D99D6C9589e2a93a78A04A279e509205945";
const FEED_BRL_USD = "0xB90DA3ff54C3ED09115abf6FbA0Ff4645586af2c";

// Par SushiSwap WPOL/CAS — referência de preço de mercado (reservas = spot real).
const SUSHI_WPOL_CAS = "0x265D86d4D43c32037b032097e8bFB6893E1C3964";

// Uniswap V4 Actions (v4-periphery libraries/Actions.sol)
const ACTION_MINT_POSITION = 0x02;
const ACTION_SETTLE_PAIR = 0x0d;

// Estimativas conservadoras de gas (fallback quando estimateGas reverte).
const GAS_EST = {
  mintCas: 150_000n,
  initialize: 400_000n,
  erc20Approve: 60_000n,
  permit2Approve: 80_000n,
  modifyLiquidities: 900_000n,
  erc20Transfer: 60_000n,
};

// ── ABIs mínimas ─────────────────────────────────────────────────────

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

const CAS_ABI = [
  "function mint(address to, uint256 amount)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function totalSupply() view returns (uint256)",
  "function maxSupply() view returns (uint256)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function paused() view returns (bool)",
];

const PERMIT2_ABI = [
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
  "function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
];

const POOL_MANAGER_ABI = [
  "function initialize((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, uint160 sqrtPriceX96) returns (int24)",
];

const STATE_VIEW_ABI = [
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
];

const POSITION_MANAGER_ABI = [
  "function modifyLiquidities(bytes unlockData, uint256 deadline) payable",
  "function nextTokenId() view returns (uint256)",
];

const CL_ABI = [
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
];

const SUSHI_PAIR_ABI = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
];

// ── Matemática V3/V4 (Q64.96) ────────────────────────────────────────

const Q96 = 2n ** 96n;

/** Raiz quadrada inteira (Newton). */
function isqrt(x: bigint): bigint {
  if (x < 2n) return x;
  let z = (x + 1n) / 2n, y = x;
  while (z < y) { y = z; z = (x / z + z) / 2n; }
  return y;
}

/** sqrtPriceX96 para preço = num/den em unidades base (currency1 por currency0). */
function sqrtPriceX96FromRatio(num: bigint, den: bigint): bigint {
  return isqrt((num * (Q96 * Q96)) / den);
}

/** sqrtPriceX96 aproximado a partir de um tick (float, usado em limites de faixa). */
function sqrtPriceX96FromTick(tick: number): bigint {
  return BigInt(Math.floor(Math.sqrt(1.0001 ** tick) * Number(Q96)));
}

/** Tick mais próximo para preço = num/den (currency1 por currency0, base units). */
function ratioToTick(num: bigint, den: bigint): number {
  return Math.floor(Math.log(Number(num) / Number(den)) / Math.log(1.0001));
}

function alignDown(tick: number, spacing: number): number {
  return Math.floor(tick / spacing) * spacing;
}

interface PoolDef {
  name: string;
  counterparty: string;      // endereço do token parceiro
  counterSymbol: string;
  counterDecimals: number;
  /** price = currency1 por currency0 (base units) = num/den */
  num: bigint;
  den: bigint;
  /** true se CAS é currency1 (depósito medido em amount1) */
  casIsCurrency1: boolean;
  casAmount: bigint;         // 500k CAS em wei
}

/**
 * Calcula a quantidade da contrapartida necessária para depositar `casAmount`
 * na faixa [sqrtA, sqrtB] contendo sqrtP, e a liquidez resultante.
 * Retorna { liquidity, amount0, amount1 } com a contrapartida exata.
 */
function amountsForRange(
  pool: PoolDef,
  sqrtP: bigint,
  sqrtA: bigint,
  sqrtB: bigint,
): { liquidity: bigint; amount0: bigint; amount1: bigint } {
  let L: bigint;
  if (pool.casIsCurrency1) {
    // CAS = currency1: amount1 = L*(sqrtP - sqrtA)/Q96 → L = amount1*Q96/(sqrtP - sqrtA)
    L = (pool.casAmount * Q96) / (sqrtP - sqrtA);
  } else {
    // CAS = currency0: amount0 = L*(sqrtB - sqrtP)*Q96/(sqrtP*sqrtB)
    L = (pool.casAmount * sqrtP * sqrtB) / ((sqrtB - sqrtP) * Q96);
  }
  const amount0 = (L * (sqrtB - sqrtP) * Q96) / (sqrtP * sqrtB);
  const amount1 = (L * (sqrtP - sqrtA)) / Q96;
  return { liquidity: L, amount0, amount1 };
}

// ── Helpers de feed / formatação ─────────────────────────────────────

async function feedPrice(provider: any, feed: string): Promise<bigint> {
  const c = new ethers.Contract(feed, CL_ABI, provider);
  const [, answer] = await c.latestRoundData();
  return BigInt(answer);
}

function fmt(amount: bigint, decimals: number): string {
  return ethers.formatUnits(amount, decimals);
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\n${SEP}`);
  console.log("  Seed de liquidez Uniswap V4 — 5 pools CAS (Polygon)");
  console.log(SEP);

  const dryRun = (process.env.DRY_RUN ?? "true").toLowerCase() !== "false";
  const casPerPool = ethers.parseEther(process.env.CAS_V4_AMOUNT_PER_POOL ?? "500000");
  const mintAmount = ethers.parseEther(process.env.CAS_V4_MINT_AMOUNT ?? "2500000");
  const rangePct = BigInt(process.env.UNIV4_RANGE_PCT ?? "10"); // ±%
  const slippageBps = 200n; // +2% de margem nos amountMax

  // Preço de referência CAS em WPOL. "auto"/"market"/vazio deriva do spot
  // SushiSwap (reservas); valor numérico (ex.: 0.00143) força o preço.
  const casWpolPriceEnv = (process.env.CAS_WPOL_PRICE ?? "auto").trim();

  const [deployer] = await ethers.getSigners();
  const provider = deployer.provider!;
  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);
  const netInfo = getNetworkInfo(chainId);

  console.log(`\n${SUB}\n  Rede\n${SUB}`);
  console.log(`  Rede:    ${netInfo.name} (${chainId})`);
  console.log(`  Modo:    ${dryRun ? "DRY-RUN (nenhuma tx será enviada)" : "EXECUÇÃO"}`);
  console.log(`  Deployer: ${deployer.address}`);
  console.log(`  CAS/pool: ${fmt(casPerPool, 18)} CAS | faixa ±${rangePct}%`);

  if (chainId !== 137) {
    log("ERROR", "Abortando: script deve rodar na Polygon mainnet (137)", { chainId });
    process.exit(1);
  }

  // ── Feeds + spot de mercado (SushiSwap WPOL/CAS) ───────────────────
  const [polUsdE8, ethUsdE8, brlUsdE8] = await Promise.all([
    feedPrice(provider, FEED_POL_USD),
    feedPrice(provider, FEED_ETH_USD),
    feedPrice(provider, FEED_BRL_USD),
  ]);
  const sushi = new ethers.Contract(SUSHI_WPOL_CAS, SUSHI_PAIR_ABI, provider);
  const [rWpol, rCas] = await sushi.getReserves(); // token0=WPOL, token1=CAS
  // Spot de mercado: 1 CAS = rWpol/rCas WPOL (ambos 18 dec).
  const marketWpolE18 = (BigInt(rWpol) * 10n ** 18n) / BigInt(rCas);

  let priceNum: bigint, priceDen: bigint, casWpolPriceStr: string, priceSource: string;
  if (["auto", "market", ""].includes(casWpolPriceEnv.toLowerCase())) {
    // Fração exata do spot: rWpol/rCas WPOL por CAS.
    priceNum = BigInt(rWpol); priceDen = BigInt(rCas);
    casWpolPriceStr = fmt(marketWpolE18, 18);
    priceSource = "mercado (reservas SushiSwap)";
  } else {
    const [ip, fp = ""] = casWpolPriceEnv.split(".");
    priceNum = BigInt((ip + fp).replace(/^0+/, "") || "0");
    priceDen = 10n ** BigInt(fp.length);
    casWpolPriceStr = casWpolPriceEnv;
    priceSource = "fixo (CAS_WPOL_PRICE)";
    if (priceNum === 0n) {
      log("ERROR", "CAS_WPOL_PRICE inválido", { casWpolPriceEnv });
      process.exit(1);
    }
    // Alerta se o preço fixo divergir >25% do spot de mercado.
    const diffBps = Number(((priceNum * 10n ** 18n * BigInt(rCas)) / (priceDen * BigInt(rWpol)) - 10n ** 18n) * 10000n / 10n ** 18n);
    if (Math.abs(diffBps) > 2500) {
      log("WARN", "preço fixo diverge do mercado — seed abaixo do spot será arbitrado (impacta o preço)", {
        fixoWpol: casWpolPriceStr, mercadoWpol: fmt(marketWpolE18, 18), diffBps,
      });
    }
  }
  const casUsdE8 = (polUsdE8 * priceNum) / priceDen; // CAS = priceNum/priceDen WPOL
  console.log(`\n${SUB}\n  Preços (Chainlink + mercado)\n${SUB}`);
  console.log(`  POL/USD: $${Number(polUsdE8) / 1e8} | ETH/USD: $${Number(ethUsdE8) / 1e8} | BRL/USD: $${Number(brlUsdE8) / 1e8}`);
  console.log(`  Mercado CAS/WPOL (Sushi ${fmt(rWpol, 18)} WPOL / ${fmt(rCas, 18)} CAS): 1 CAS = ${fmt(marketWpolE18, 18)} WPOL`);
  console.log(`  Referência usada (${priceSource}): 1 CAS = ${casWpolPriceStr} WPOL | CAS/USD derivado: $${Number(casUsdE8) / 1e8}`);

  // ── Definição dos 5 pools (currency ordenada por endereço) ─────────
  // price (currency1 por currency0, base units) expresso como num/den.
  const pools: PoolDef[] = [
    {
      // USDC 0x3c49 < CAS 0x5151 → c0=USDC, c1=CAS
      // price = CAS-wei por USDC-base = (1/casUsd) × 1e12 = 1e20/casUsdE8
      name: "CAS/USDC",
      counterparty: USDC, counterSymbol: "USDC", counterDecimals: 6,
      num: 10n ** 20n, den: casUsdE8,
      casIsCurrency1: true, casAmount: casPerPool,
    },
    {
      // CAS 0x5151 < USDT 0xc213 → c0=CAS, c1=USDT
      // price = USDT-base por CAS-wei = casUsd × 1e-12
      name: "CAS/USDT",
      counterparty: USDT, counterSymbol: "USDT", counterDecimals: 6,
      num: casUsdE8, den: 10n ** 20n,
      casIsCurrency1: false, casAmount: casPerPool,
    },
    {
      // WPOL 0x0d50 < CAS → c0=WPOL, c1=CAS
      // price = CAS-wei por WPOL-wei = 1/casWpol = priceDen/priceNum
      name: "CAS/WPOL",
      counterparty: WPOL, counterSymbol: "WPOL", counterDecimals: 18,
      num: priceDen, den: priceNum,
      casIsCurrency1: true, casAmount: casPerPool,
    },
    {
      // CAS 0x5151 < WETH 0x7ceB → c0=CAS, c1=WETH; price = casUsd/ethUsd
      name: "CAS/WETH",
      counterparty: WETH, counterSymbol: "WETH", counterDecimals: 18,
      num: casUsdE8, den: ethUsdE8,
      casIsCurrency1: false, casAmount: casPerPool,
    },
    {
      // CAS 0x5151 < BRLA 0xE6A5 → c0=CAS, c1=BRLA; price = casUsd/brlUsd
      name: "CAS/BRLA",
      counterparty: BRLA, counterSymbol: "BRLA", counterDecimals: 18,
      num: casUsdE8, den: brlUsdE8,
      casIsCurrency1: false, casAmount: casPerPool,
    },
  ];

  // ── Calcular preços, ticks e quantidades por pool ──────────────────
  const fee = 3000;
  const tickSpacing = 60;

  interface PlanRow {
    def: PoolDef;
    poolKey: [string, string, number, number, string];
    sqrtPriceX96: bigint;
    tickLower: number;
    tickUpper: number;
    liquidity: bigint;
    amount0: bigint;
    amount1: bigint;
    amount0Max: bigint;
    amount1Max: bigint;
    counterNeeded: bigint;   // quantidade da contrapartida (base units)
    counterInWpolE18: bigint; // contrapartida convertida a WPOL (1e18)
    impliedWpolE18: bigint;   // preço implícito: WPOL por CAS (1e18)
  }
  const plan: PlanRow[] = [];

  // Converte a contrapartida (base units) para equivalente WPOL (1e18).
  const toWpol = (def: PoolDef, amount: bigint): bigint => {
    switch (def.counterSymbol) {
      case "WPOL": return amount;
      case "USDC":
      case "USDT": // $1: usd = amt×1e-6 → wpol wei = amt×1e20/polUsdE8
        return (amount * 10n ** 20n) / polUsdE8;
      case "WETH": return (amount * ethUsdE8) / polUsdE8;
      case "BRLA": return (amount * brlUsdE8) / polUsdE8;
      default: return 0n;
    }
  };

  console.log(`\n${SUB}\n  Parâmetros dos pools\n${SUB}`);
  for (const def of pools) {
    const [c0, c1] = def.casIsCurrency1
      ? [def.counterparty, CAS]
      : [CAS, def.counterparty];
    const sqrtP = sqrtPriceX96FromRatio(def.num, def.den);
    const tickNow = ratioToTick(def.num, def.den);
    // faixa ±rangePct em torno do preço
    const tickLower = alignDown(ratioToTick(def.num * (100n - rangePct), def.den * 100n), tickSpacing);
    const tickUpper = alignDown(ratioToTick(def.num * (100n + rangePct), def.den * 100n), tickSpacing) + tickSpacing;
    const sqrtA = sqrtPriceX96FromTick(tickLower);
    const sqrtB = sqrtPriceX96FromTick(tickUpper);
    const { liquidity, amount0, amount1 } = amountsForRange(def, sqrtP, sqrtA, sqrtB);
    const amount0Max = (amount0 * (10000n + slippageBps)) / 10000n;
    const amount1Max = (amount1 * (10000n + slippageBps)) / 10000n;
    const counterNeeded = def.casIsCurrency1 ? amount0Max : amount1Max;
    const counterExact = def.casIsCurrency1 ? amount0 : amount1;
    const casDeposited = def.casIsCurrency1 ? amount1 : amount0;
    const counterInWpolE18 = toWpol(def, counterExact);
    // Preço implícito do CAS em WPOL: contrapartida(WPOL) / CAS depositado (18dec ambos).
    const impliedWpolE18 = casDeposited === 0n ? 0n : (counterInWpolE18 * 10n ** 18n) / casDeposited;

    plan.push({
      def,
      poolKey: [c0, c1, fee, tickSpacing, ZERO_HOOKS],
      sqrtPriceX96: sqrtP,
      tickLower, tickUpper,
      liquidity, amount0, amount1, amount0Max, amount1Max,
      counterNeeded, counterInWpolE18, impliedWpolE18,
    });

    console.log(`  ${def.name}: tick ${tickNow} [${tickLower}, ${tickUpper}]`);
    console.log(`    amount0 (${def.casIsCurrency1 ? def.counterSymbol : "CAS"}): ${fmt(amount0, def.casIsCurrency1 ? def.counterDecimals : 18)}`);
    console.log(`    amount1 (${def.casIsCurrency1 ? "CAS" : def.counterSymbol}): ${fmt(amount1, def.casIsCurrency1 ? 18 : def.counterDecimals)}`);
    console.log(`    contrapartida c/ margem: ${fmt(counterNeeded, def.counterDecimals)} ${def.counterSymbol}`);
    console.log(`    preço implícito: 1 CAS = ${fmt(impliedWpolE18, 18)} WPOL (alvo ${casWpolPriceStr})`);
  }

  // ── Tabela de provisão de fundos ───────────────────────────────────
  const casTotalNeeded = casPerPool * BigInt(pools.length);
  // Excedente do mint vai para a tesouraria (lastro captado).
  const treasury = (process.env.TREASURY_ADDRESS ?? "").trim();
  const treasuryAmount = mintAmount > casTotalNeeded ? mintAmount - casTotalNeeded : 0n;
  const needs = new Map<string, { symbol: string; decimals: number; needed: bigint }>();
  needs.set(CAS, { symbol: "CAS", decimals: 18, needed: casTotalNeeded });
  for (const row of plan) {
    const cur = needs.get(row.def.counterparty) ?? { symbol: row.def.counterSymbol, decimals: row.def.counterDecimals, needed: 0n };
    cur.needed += row.counterNeeded;
    needs.set(row.def.counterparty, cur);
  }

  // Estimativa de gas: mint + por pool (initialize + 2 approves ERC20 + 2 permit2 + modifyLiquidities)
  const gasPerPool = GAS_EST.initialize + 2n * GAS_EST.erc20Approve + 2n * GAS_EST.permit2Approve + GAS_EST.modifyLiquidities;
  const gasTotal = GAS_EST.mintCas + gasPerPool * BigInt(pools.length)
    + (treasuryAmount > 0n && treasury ? GAS_EST.erc20Transfer : 0n);
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? 30_000_000_000n;
  const gasCost = gasTotal * gasPrice;
  const gasCostPadded = (gasCost * 120n) / 100n;
  const polBalance = await provider.getBalance(deployer.address);

  console.log(`\n${SEP}`);
  console.log("  TABELA DE PROVISÃO — saldos necessários na Polygon");
  console.log(SEP);
  console.log(`  ${"Moeda".padEnd(6)} ${"Saldo atual".padStart(18)} ${"Necessário".padStart(18)} ${"Faltante".padStart(18)}`);

  const deficits: { symbol: string; addr: string; amount: bigint; decimals: number }[] = [];
  for (const [addr, n] of needs) {
    const token = new ethers.Contract(addr, ERC20_ABI, provider);
    const bal: bigint = await token.balanceOf(deployer.address);
    // CAS: o mint planejado (mintAmount) conta como provisão.
    const provisioned = addr === CAS ? bal + mintAmount : bal;
    const missing = n.needed > provisioned ? n.needed - provisioned : 0n;
    if (missing > 0n) deficits.push({ symbol: n.symbol, addr, amount: missing, decimals: n.decimals });
    console.log(`  ${n.symbol.padEnd(6)} ${fmt(bal, n.decimals).padStart(18)} ${fmt(n.needed, n.decimals).padStart(18)} ${fmt(missing, n.decimals).padStart(18)}`);
  }
  const polMissing = gasCostPadded > polBalance ? gasCostPadded - polBalance : 0n;
  console.log(`  ${"POL*".padEnd(6)} ${fmt(polBalance, 18).padStart(18)} ${fmt(gasCostPadded, 18).padStart(18)} ${fmt(polMissing, 18).padStart(18)}`);
  console.log(`\n  *POL = gas estimado: ${gasTotal} gas × ${fmtGwei(gasPrice)} = ${fmt(gasCost, 18)} (+20% = ${fmt(gasCostPadded, 18)})`);
  console.log(`  CAS "Necessário" cobre os 5 pools; o mint de ${fmt(mintAmount, 18)} CAS está previsto e já foi descontado do "Faltante".`);
  if (treasuryAmount > 0n) {
    const dest = treasury || "(TREASURY_ADDRESS não configurado — excedente ficará no deployer)";
    console.log(`  Tesouraria (lastro): ${fmt(treasuryAmount, 18)} CAS → ${dest}`);
  }

  if (deficits.length > 0 || polMissing > 0n) {
    console.log(`\n${SUB}\n  O QUE ADQUIRIR ANTES DE EXECUTAR\n${SUB}`);
    for (const d of deficits) {
      console.log(`  - ${d.symbol}: ${fmt(d.amount, d.decimals)} (token ${d.addr})`);
    }
    if (polMissing > 0n) console.log(`  - POL (gas): ${fmt(polMissing, 18)}`);
  } else {
    console.log(`\n  Todos os saldos cobrem a execução.`);
  }

  if (dryRun) {
    console.log(`\n${SEP}`);
    console.log(`  DRY-RUN concluído — nenhuma transação enviada.`);
    console.log(`  Para executar: DRY_RUN=false npx hardhat run ${FILE} --network polygon`);
    console.log(`${SEP}\n`);
    return;
  }

  // ── Execução ───────────────────────────────────────────────────────
  if (deficits.length > 0 || polMissing > 0n) {
    log("ERROR", "Saldos insuficientes — adquira os itens da tabela acima antes de executar.");
    process.exit(1);
  }

  const cas = new ethers.Contract(CAS, [...ERC20_ABI, ...CAS_ABI], deployer);
  const poolManager = new ethers.Contract(UNIV4_POOL_MANAGER, POOL_MANAGER_ABI, deployer);
  const stateView = new ethers.Contract(UNIV4_STATE_VIEW, STATE_VIEW_ABI, provider);
  const posManager = new ethers.Contract(UNIV4_POSITION_MANAGER, POSITION_MANAGER_ABI, deployer);
  const permit2 = new ethers.Contract(PERMIT2, PERMIT2_ABI, deployer);
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();

  const send = async (label: string, buildTx: () => Promise<any>): Promise<any> => {
    const tx = await buildTx();
    console.log(`  TX ${label}: ${tx.hash}`);
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      log("ERROR", `tx revertida: ${label}`, { hash: tx.hash });
      process.exit(1);
    }
    log("INFO", `confirmada ${label}`, { hash: tx.hash, gasUsed: receipt.gasUsed.toString() });
    return receipt;
  };

  // Passo 1 — mint de CAS (se CAS_V4_MINT_AMOUNT > 0)
  if (mintAmount > 0n) {
    log("INFO", "mint de CAS", { toMint: fmt(mintAmount, 18) });
    const supply = await cas.totalSupply();
    const maxSupply = await cas.maxSupply();
    if (supply + mintAmount > maxSupply) {
      log("ERROR", "mint excede MAX_SUPPLY", { supply: fmt(supply, 18), toMint: fmt(mintAmount, 18), maxSupply: fmt(maxSupply, 18) });
      process.exit(1);
    }
    await send(`CASToken.mint(deployer, ${fmt(mintAmount, 18)})`, () => cas.mint(deployer.address, mintAmount));
  }

  // Passo 2 — approvals: ERC20 → Permit2 (uma vez, allowance total necessária)
  console.log(`\n${SUB}\n  Approvals ERC20 → Permit2\n${SUB}`);
  for (const [addr, n] of needs) {
    const token = new ethers.Contract(addr, ERC20_ABI, deployer);
    const allowance: bigint = await token.allowance(deployer.address, PERMIT2);
    if (allowance < n.needed) {
      await send(`${n.symbol}.approve(Permit2, max)`, () => token.approve(PERMIT2, ethers.MaxUint256));
    } else {
      console.log(`  ${n.symbol}: allowance suficiente`);
    }
  }

  // Passo 3 — approvals Permit2 → PositionManager (expira em 1 hora)
  console.log(`\n${SUB}\n  Approvals Permit2 → PositionManager\n${SUB}`);
  const expiration = Math.floor(Date.now() / 1000) + 3600;
  for (const [addr, n] of needs) {
    const maxUint160 = (1n << 160n) - 1n;
    await send(
      `Permit2.approve(${n.symbol}, PosManager)`,
      () => permit2.approve(addr, UNIV4_POSITION_MANAGER, maxUint160, expiration),
    );
  }

  // Passo 4 — por pool: initialize (se preciso) + mint position
  for (const row of plan) {
    const d = row.def;
    console.log(`\n${SEP}\n  Pool ${d.name}\n${SEP}`);

    const poolId = ethers.keccak256(
      abiCoder.encode(
        ["tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)"],
        [row.poolKey],
      ),
    );
    const slot0 = await stateView.getSlot0(poolId);
    if (slot0.sqrtPriceX96 === 0n) {
      await send(
        `PoolManager.initialize(${d.name})`,
        () => poolManager.initialize(row.poolKey, row.sqrtPriceX96),
      );
    } else {
      console.log(`  Pool já inicializada (sqrtP=${slot0.sqrtPriceX96}) — pulando initialize`);
    }

    const mintParams = abiCoder.encode(
      [
        "tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)",
        "int24", "int24", "uint256", "uint128", "uint128", "address", "bytes",
      ],
      [
        row.poolKey,
        row.tickLower,
        row.tickUpper,
        row.liquidity,
        row.amount0Max,
        row.amount1Max,
        deployer.address,
        "0x",
      ],
    );
    const settleParams = abiCoder.encode(
      ["address", "address"],
      [row.poolKey[0], row.poolKey[1]],
    );
    const unlockData = abiCoder.encode(
      ["uint8[]", "bytes[]"],
      [[ACTION_MINT_POSITION, ACTION_SETTLE_PAIR], [mintParams, settleParams]],
    );

    const nextId: bigint = await posManager.nextTokenId();
    const deadline = Math.floor(Date.now() / 1000) + 600;
    await send(
      `PositionManager.modifyLiquidities(${d.name})`,
      () => posManager.modifyLiquidities(unlockData, deadline),
    );
    log("INFO", `posição mintada`, { pool: d.name, tokenId: nextId.toString(), liquidity: row.liquidity.toString() });
  }

  // Passo 5 — excedente do mint para a tesouraria (pareado com o lastro)
  if (treasuryAmount > 0n) {
    if (treasury) {
      console.log(`\n${SUB}\n  Tesouraria\n${SUB}`);
      await send(
        `CAS.transfer(tesouraria, ${fmt(treasuryAmount, 18)})`,
        () => cas.transfer(treasury, treasuryAmount),
      );
    } else {
      log("WARN", "TREASURY_ADDRESS não configurado — excedente permanece no deployer", {
        excedente: fmt(treasuryAmount, 18),
      });
    }
  }

  console.log(`\n${SEP}`);
  console.log(`  Concluído — 5 pools V4 semeadas a 1 CAS = ${casWpolPriceStr} WPOL (${priceSource})`);
  console.log(`${SEP}\n`);
}

main().catch((err) => {
  log("ERROR", "falha não tratada", { error: String(err?.message ?? err) });
  process.exit(1);
});
