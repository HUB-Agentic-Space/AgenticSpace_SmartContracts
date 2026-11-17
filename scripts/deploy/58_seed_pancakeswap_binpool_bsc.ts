/**
 * @file 58_seed_pancakeswap_binpool_bsc.ts
 * @notice Seed de liquidez no BinPool CAS/BNB da PancakeSwap Infinity (BSC).
 * @dev    Fluxo:
 *
 *           1. Preco: media CAS/USD dos pools DEX atuais na Polygon
 *              (scripts/utils/cas_price_feed.ts, mesma metodologia do
 *              21_balance_dex_prices.ts) + BNB/USD via Chainlink na BSC
 *              -> activeId do bin pelo preco alvo CAS por BNB.
 *           2. Inicializa o pool via BinPositionManager.initializePool
 *              (idempotente — nao reverte se o pool ja existir).
 *           3. Approves: CAS -> Permit2 -> BinPositionManager.
 *           4. modifyLiquidities{value: BNB} com acoes
 *              [BIN_ADD_LIQUIDITY, CLOSE_CURRENCY x2, SWEEP] — BNB nativo
 *              (currency0 = address(0)) e CASOFT (currency1).
 *
 *         Pre-requisito: CASOFT deployado na BSC (script 56) e CAS
 *         bridgado (script 57) — ou saldo CASOFT existente na conta.
 *         Este script NAO faz mint nem bridge: e o passo "preencher o
 *         pool com saldo de conta".
 *
 *         Uso (DRY-RUN e o padrao; execucao exige SEED_EXECUTE=true):
 *           npx hardhat run scripts/deploy/58_seed_pancakeswap_binpool_bsc.ts --network bsc
 *           SEED_EXECUTE=true npx hardhat run scripts/deploy/58_seed_pancakeswap_binpool_bsc.ts --network bsc
 *
 * Author:  Carlos Delfino
 * Email:   consultoria@carlosdelfino.eti.br
 * WhatsApp: +55 (85) 98520-5490
 */
import "dotenv/config";
import { ethers } from "hardhat";
import type { JsonRpcProvider } from "ethers";
import {
  SEP,
  SUB,
  fmtGwei,
  getNetworkInfo,
  requireEnv,
} from "../utils/deploy_helpers";
import {
  getBnbUsd,
  getCasPriceSnapshot,
} from "../utils/cas_price_feed";
import {
  encodeBinStepParams,
  idFromPrice,
  getBinIds,
  distributions,
  deltaIds as computeDeltaIds,
} from "../utils/binpool_math";

const FILE = "scripts/deploy/58_seed_pancakeswap_binpool_bsc.ts";

// ── Enderecos PancakeSwap Infinity (BNB Chain mainnet) ───────────────
const BINPOOL_MANAGER =
  process.env.PANCAKE_BIN_POOL_MANAGER ?? "0xC697d2898e0D09264376196696c51D7aBbbAA4a9";
const BIN_POSITION_MANAGER =
  process.env.PANCAKE_BIN_POSITION_MANAGER ?? "0x3D311D6283Dd8aB90bb0031835C8e606349e2850";
const PERMIT2 =
  process.env.BSC_PERMIT2 ?? "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const NATIVE_CURRENCY = ethers.ZeroAddress; // BNB nativo no PoolKey

// Actions (infinity-periphery Planner)
const ACTION_BIN_ADD_LIQUIDITY = 0x19;
const ACTION_CLOSE_CURRENCY = 0x12;
const ACTION_SWEEP = 0x14;

const BINPOOL_MANAGER_ABI = [
  "function getSlot0(bytes32 id) view returns (uint24 activeId, uint24 protocolFee, uint24 lpFee)",
];
const BINPM_ABI = [
  "function initializePool((address currency0, address currency1, address hooks, address poolManager, uint24 fee, bytes32 parameters) key, uint24 activeId) payable",
  "function modifyLiquidities(bytes payload, uint256 deadline) payable",
  "function permit2() view returns (address)",
];
const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
];
const PERMIT2_ABI = [
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
];

const GAS_EST = {
  approve: 60_000n,
  permit2: 100_000n,
  initPool: 500_000n,
  addLiquidity: 1_500_000n,
};

function log(level: string, message: string, params?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").split(".")[0];
  const extra = params ? ` - ${JSON.stringify(params)}` : "";
  console.log(`[${ts}] [${FILE}:main] ${level} ${message}${extra}`);
}

async function send(
  label: string,
  buildTx: () => Promise<any>,
): Promise<any> {
  const tx = await buildTx();
  console.log(`  TX ${label}: ${tx.hash}`);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    log("ERROR", `tx revertida: ${label}`, { hash: tx.hash });
    process.exit(1);
  }
  log("INFO", `confirmada ${label}`, { hash: tx.hash, gasUsed: receipt.gasUsed.toString() });
  return receipt;
}

async function main(): Promise<void> {
  console.log(`\n${SEP}`);
  console.log("  Seed BinPool CAS/BNB — PancakeSwap Infinity (BSC)");
  console.log(SEP);

  const env = requireEnv(["CAS_OFT_BSC"]);
  // Flag dedicada (mesmo criterio do script 57): evita herdar DRY_RUN global.
  const dryRun = (process.env.SEED_EXECUTE ?? "false").toLowerCase() !== "true";
  const casAmount = ethers.parseEther(process.env.SEED_CAS_AMOUNT ?? "500000");
  const binStep = Number(process.env.BIN_STEP ?? "10");
  const binsPerSide = Number(process.env.BIN_RANGE_BINS ?? "3");
  const numBins = 2 * binsPerSide + 1;
  const fee = Number(process.env.BIN_FEE ?? "3000");
  const idSlippage = BigInt(process.env.SEED_ID_SLIPPAGE ?? "10");
  const slippageBps = BigInt(process.env.SEED_SLIPPAGE_BPS ?? "200");

  const [deployer] = await ethers.getSigners();
  const provider = deployer.provider!;
  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);
  const netInfo = getNetworkInfo(chainId);

  console.log(`\n${SUB}\n  Rede\n${SUB}`);
  console.log(`  Rede:     ${netInfo.name} (${chainId})`);
  console.log(`  Modo:     ${dryRun ? "DRY-RUN (nenhuma tx sera enviada)" : "EXECUCAO"}`);
  console.log(`  Deployer: ${deployer.address}`);

  if (chainId !== 56 && chainId !== 97) {
    log("ERROR", "Abortando: script deve rodar na BSC (56 ou 97)", { chainId });
    process.exit(1);
  }

  // ── Preco: media dos pools CAS (Polygon) + BNB/USD (Chainlink BSC) ─
  console.log(`\n${SUB}\n  Preco\n${SUB}`);
  const snapshot = await getCasPriceSnapshot();
  for (const q of snapshot.quotes) {
    if (!q.hasLiquidity) continue;
    console.log(`  ${q.dex.padEnd(16)} CAS/USD=${q.casUsd.toExponential(4)} (par ${q.pairedSymbol})`);
  }
  const bnbUsd = await getBnbUsd(provider as unknown as JsonRpcProvider);
  const casUsd = snapshot.casUsd;
  const casPerBnb = bnbUsd / casUsd; // preco Y/X = CAS por BNB
  console.log(`\n  CAS/USD medio:  $${casUsd.toExponential(4)} (fonte: ${snapshot.source})`);
  console.log(`  BNB/USD:        $${bnbUsd.toFixed(2)}`);
  console.log(`  CAS por BNB:    ${casPerBnb.toFixed(2)}`);
  if (snapshot.source !== "scan") {
    log("WARN", "media vinda de fallback .env — confirme se e o preco desejado");
  }

  // ── PoolKey + estado do pool ───────────────────────────────────────
  const casOft = env.CAS_OFT_BSC;
  if (casOft.toLowerCase() <= NATIVE_CURRENCY.toLowerCase()) {
    log("ERROR", "currency ordering invalida: CAS_OFT_BSC deve ser > address(0)");
    process.exit(1);
  }
  const poolKey = {
    currency0: NATIVE_CURRENCY, // BNB nativo (sempre < qualquer endereco ERC20)
    currency1: casOft,
    hooks: ethers.ZeroAddress,
    poolManager: BINPOOL_MANAGER,
    fee,
    parameters: encodeBinStepParams(binStep),
  };
  const poolId = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "address", "address", "uint24", "bytes32"],
      [poolKey.currency0, poolKey.currency1, poolKey.hooks, poolKey.poolManager, poolKey.fee, poolKey.parameters],
    ),
  );

  console.log(`\n${SUB}\n  Pool\n${SUB}`);
  console.log(`  PoolKey:  {c0: BNB nativo, c1: ${casOft}, fee: ${fee}, binStep: ${binStep}}`);
  console.log(`  PoolId:   ${poolId}`);

  const binManager = new ethers.Contract(BINPOOL_MANAGER, BINPOOL_MANAGER_ABI, provider);
  const binPm = new ethers.Contract(BIN_POSITION_MANAGER, BINPM_ABI, deployer);

  let activeId = 0;
  let initialized = false;
  try {
    const slot0 = await binManager.getSlot0(poolId);
    activeId = Number(slot0.activeId);
    initialized = activeId !== 0;
  } catch {
    log("WARN", "getSlot0 falhou — assumindo pool nao inicializado");
  }
  const targetId = idFromPrice(casPerBnb, binStep);
  console.log(`  Estado:   ${initialized ? `inicializado (activeId=${activeId})` : "nao inicializado"}`);
  console.log(`  Alvo:     activeId=${targetId} (preco ${casPerBnb.toFixed(4)} CAS/BNB)`);
  if (!initialized) activeId = targetId;
  if (initialized && Math.abs(activeId - targetId) > Number(idSlippage)) {
    log("WARN", "activeId do pool diverge do preco medio — idSlippage vai reverter",
      { activeId, targetId, idSlippage: Number(idSlippage) });
  }

  // ── Bins e quantidades ─────────────────────────────────────────────
  const binIds = getBinIds(activeId, numBins);
  const deltaIds = computeDeltaIds(binIds, activeId);
  const [distX, distY] = distributions(binIds, activeId);
  // SEED_BNB_AMOUNT="auto" deriva a perna BNB do preco medio; um numero fixo
  // sobrescreve (o activeId alvo continua vindo do preco medio).
  const bnbEnv = (process.env.SEED_BNB_AMOUNT ?? "auto").toLowerCase();
  const bnbAmount =
    bnbEnv === "auto"
      ? ethers.parseEther((Number(ethers.formatEther(casAmount)) / casPerBnb).toFixed(18))
      : ethers.parseEther(bnbEnv);
  const bnbAmountMax = (bnbAmount * (10_000n + slippageBps)) / 10_000n;

  console.log(`\n${SUB}\n  Liquidez\n${SUB}`);
  console.log(`  CAS:      ${ethers.formatEther(casAmount)} (currency1/Y)`);
  console.log(`  BNB:      ${ethers.formatEther(bnbAmount)} (currency0/X, max ${ethers.formatEther(bnbAmountMax)})`);
  console.log(`  Bins:     ${binIds.join(", ")} (${numBins} bins, deltas ${deltaIds.join(",")})`);

  // ── Provisao ───────────────────────────────────────────────────────
  const cas = new ethers.Contract(casOft, ERC20_ABI, deployer);
  const [casBalance, bnbBalance, feeData] = await Promise.all([
    cas.balanceOf(deployer.address),
    provider.getBalance(deployer.address),
    provider.getFeeData(),
  ]);
  const gasPrice = feeData.gasPrice ?? 3_000_000_000n;
  const gasUnits =
    GAS_EST.approve + GAS_EST.permit2 +
    (initialized ? 0n : GAS_EST.initPool) + GAS_EST.addLiquidity;
  const gasCost = gasUnits * gasPrice;
  const bnbNeeded = bnbAmountMax + gasCost;
  const casMissing = casAmount > casBalance ? casAmount - casBalance : 0n;
  const bnbMissing = bnbNeeded > bnbBalance ? bnbNeeded - bnbBalance : 0n;

  console.log(`\n${SEP}`);
  console.log("  TABELA DE PROVISAO — BSC");
  console.log(SEP);
  console.log(`  ${"Item".padEnd(14)} ${"Saldo atual".padStart(18)} ${"Necessario".padStart(18)} ${"Faltante".padStart(18)}`);
  console.log(`  ${"CAS (OFT)".padEnd(14)} ${ethers.formatEther(casBalance).padStart(18)} ${ethers.formatEther(casAmount).padStart(18)} ${ethers.formatEther(casMissing).padStart(18)}`);
  console.log(`  ${"BNB".padEnd(14)} ${ethers.formatEther(bnbBalance).padStart(18)} ${ethers.formatEther(bnbNeeded).padStart(18)} ${ethers.formatEther(bnbMissing).padStart(18)}`);
  console.log(`\n  BNB necessario = deposito max ${ethers.formatEther(bnbAmountMax)} + gas ${ethers.formatEther(gasCost)} (~${gasUnits} x ${fmtGwei(gasPrice)})`);
  if (casMissing > 0n) {
    console.log(`\n  Sem saldo CAS suficiente: rode o bridge (npm run bridge:cas:bsc) ou ajuste SEED_CAS_AMOUNT.`);
  }

  if (dryRun) {
    console.log(`\n${SEP}`);
    console.log("  DRY-RUN concluido — nenhuma transacao enviada.");
    console.log(`  Para executar: SEED_EXECUTE=true npx hardhat run ${FILE} --network bsc`);
    console.log(`${SEP}\n`);
    return;
  }

  if (casMissing > 0n || bnbMissing > 0n) {
    log("ERROR", "Provisao insuficiente — resolva os itens acima antes de executar.");
    process.exit(1);
  }

  // ── 1. initializePool (idempotente) ────────────────────────────────
  if (!initialized) {
    console.log(`\n${SUB}\n  initializePool(activeId=${targetId})\n${SUB}`);
    await send("BinPM.initializePool", () =>
      binPm.initializePool(poolKey, targetId, { gasPrice }));
  } else {
    console.log(`\n  Pool ja inicializado — pulando initializePool.`);
  }

  // ── 2. Approves: CAS -> Permit2 -> BinPM ───────────────────────────
  console.log(`\n${SUB}\n  Approves (Permit2)\n${SUB}`);
  let permit2Addr = PERMIT2;
  try {
    permit2Addr = await binPm.permit2();
  } catch {
    log("WARN", "binPm.permit2() indisponivel — usando PERMIT2 padrao", { permit2: PERMIT2 });
  }
  const permit2 = new ethers.Contract(permit2Addr, PERMIT2_ABI, deployer);
  const [p2Amount] = await permit2.allowance(deployer.address, casOft, BIN_POSITION_MANAGER);

  await send("CAS.approve(Permit2, max)", () =>
    cas.approve(permit2Addr, ethers.MaxUint256, { gasPrice }));
  if (p2Amount < casAmount) {
    await send("Permit2.approve(CAS, BinPM, max)", () =>
      permit2.approve(casOft, BIN_POSITION_MANAGER, ethers.MaxUint256, 4_294_967_295, { gasPrice }));
  } else {
    console.log(`  Allowance Permit2 suficiente (${p2Amount})`);
  }

  // ── 3. modifyLiquidities ───────────────────────────────────────────
  console.log(`\n${SUB}\n  addLiquidity (modifyLiquidities)\n${SUB}`);
  const addParams = {
    poolKey,
    amount0: bnbAmount,
    amount1: casAmount,
    amount0Max: bnbAmountMax,
    amount1Max: casAmount,
    activeIdDesired: BigInt(activeId),
    idSlippage,
    deltaIds,
    distributionX: distX,
    distributionY: distY,
    to: deployer.address,
    hookData: "0x",
  };
  const addEncoded = ethers.AbiCoder.defaultAbiCoder().encode(
    [
      "tuple(tuple(address currency0, address currency1, address hooks, address poolManager, uint24 fee, bytes32 parameters) poolKey, uint128 amount0, uint128 amount1, uint128 amount0Max, uint128 amount1Max, uint256 activeIdDesired, uint256 idSlippage, int256[] deltaIds, uint256[] distributionX, uint256[] distributionY, address to, bytes hookData)",
    ],
    [addParams],
  );
  const actions = ethers.solidityPacked(
    ["uint8", "uint8", "uint8", "uint8"],
    [ACTION_BIN_ADD_LIQUIDITY, ACTION_CLOSE_CURRENCY, ACTION_CLOSE_CURRENCY, ACTION_SWEEP],
  );
  const params = [
    addEncoded,
    ethers.AbiCoder.defaultAbiCoder().encode(["address"], [poolKey.currency0]),
    ethers.AbiCoder.defaultAbiCoder().encode(["address"], [poolKey.currency1]),
    ethers.AbiCoder.defaultAbiCoder().encode(["address", "address"], [poolKey.currency0, deployer.address]),
  ];
  const payload = ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes", "bytes[]"], [actions, params],
  );
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

  await send("BinPM.modifyLiquidities(BIN_ADD_LIQUIDITY)", () =>
    binPm.modifyLiquidities(payload, deadline, {
      value: bnbAmountMax, // excedente nativo devolvido pelo SWEEP
      gasPrice,
    }));

  // ── Resultado ──────────────────────────────────────────────────────
  const [casAfter, bnbAfter] = await Promise.all([
    cas.balanceOf(deployer.address),
    provider.getBalance(deployer.address),
  ]);
  console.log(`\n${SUB}\n  Resultado\n${SUB}`);
  console.log(`  CASOFT:   ${ethers.formatEther(casBalance)} -> ${ethers.formatEther(casAfter)}`);
  console.log(`  BNB:      ${ethers.formatEther(bnbBalance)} -> ${ethers.formatEther(bnbAfter)}`);
  console.log(`  PoolId:   ${poolId}`);
  console.log(`  Bins:     ${binIds.join(", ")} | 1155s mintados p/ ${deployer.address}`);
  console.log(`\n${SEP}\n`);
  log("INFO", "concluido", { poolId, activeId, casAmount: ethers.formatEther(casAmount) });
}

main().catch((err) => {
  log("ERROR", "falha nao tratada", { error: String(err?.message ?? err) });
  console.error(err);
  process.exit(1);
});
