import "dotenv/config";
import { ethers } from "hardhat";
import {
  SEP,
  SUB,
  fmtPOL,
  fmtGwei,
  getNetworkInfo,
  requireEnv,
  sendAndVerify,
} from "../utils/deploy_helpers";

const CHAINLINK_ABI = [
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
];

const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
];

const POSITION_MANAGER_ABI = [
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function collect(uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) returns (uint256 amount0, uint256 amount1)",
  "function decreaseLiquidity(uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline) returns (uint256 amount0, uint256 amount1)",
  "function increaseLiquidity(uint256 tokenId, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, uint256 deadline) returns (uint128 liquidity, uint256 amount0, uint256 amount1)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function approve(address, uint256) returns (bool)",
];

const WPOL_ABI = [
  "function deposit() payable",
  "function withdraw(uint256) returns ()",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
];

function log(level: string, message: string, params?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").split(".")[0];
  const file = "scripts/deploy/07_rebalance_v3_position.ts";
  const extra = params ? ` - ${JSON.stringify(params)}` : "";
  console.log(`[${ts}] [${file}:main] ${level} ${message}${extra}`);
}

function priceToTick(price: number, token0Decimals: number, token1Decimals: number): number {
  const adjustedPrice = price * Math.pow(10, token0Decimals - token1Decimals);
  return Math.floor(Math.log(adjustedPrice) / Math.log(1.0001));
}

async function main(): Promise<void> {
  console.log(`\n${SEP}`);
  console.log("  Rebalancear Posicao Uniswap V3 (CAS/WPOL)");
  console.log(SEP);

  const env = requireEnv([
    "UNIV3_POOL_ADDRESS",
    "UNIV3_NFT_TOKEN_ID",
    "CAS_TOKEN_ADDRESS",
    "CHAINLINK_POL_USD_FEED",
    "RELAYER_PRIVATE_KEY",
  ]);

  const provider = (await ethers.getSigners())[0].provider!;
  const relayer = new ethers.Wallet(env.RELAYER_PRIVATE_KEY, provider);

  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);
  const netInfo = getNetworkInfo(chainId);

  console.log(`\n${SUB}`);
  console.log("  Rede");
  console.log(SUB);
  console.log(`  Rede:      ${netInfo.name}`);
  console.log(`  Chain ID:  ${chainId}`);
  console.log(`  Signer:    ${relayer.address} (relayer/owner)`);

  if (chainId !== 137) {
    log("ERROR", "Script deve rodar na Polygon mainnet (137)", { chainId });
    process.exit(1);
  }

  const poolAddress = env.UNIV3_POOL_ADDRESS;
  const tokenId = BigInt(env.UNIV3_NFT_TOKEN_ID);
  const casTokenAddress = env.CAS_TOKEN_ADDRESS;
  const tickRangePercent = parseInt(process.env.UNIV3_TICK_RANGE_PERCENT ?? "10", 10);
  const feeTier = parseInt(process.env.UNIV3_FEE_TIER ?? "3000", 10);
  const casPriceUsd = parseFloat(process.env.CAS_PRICE_USD ?? "0.0005");

  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? 25_000_000_000n;
  console.log(`  Gas price: ${fmtGwei(gasPrice)}`);

  // --- Pool state ---
  const pool = new ethers.Contract(poolAddress, POOL_ABI, relayer);
  const [token0, token1, slot0] = await Promise.all([
    pool.token0(),
    pool.token1(),
    pool.slot0(),
  ]);

  const isCasToken0 = token0.toLowerCase() === casTokenAddress.toLowerCase();
  const currentTick = Number(slot0.tick);

  // --- Chainlink POL/USD ---
  const chainlink = new ethers.Contract(
    env.CHAINLINK_POL_USD_FEED.toLowerCase(),
    CHAINLINK_ABI,
    provider,
  );
  const [, polPriceRaw] = await chainlink.latestRoundData();
  const chainlinkDecimals = Number(await chainlink.decimals());
  const polPriceUsd = Number(polPriceRaw) / Number(10n ** BigInt(chainlinkDecimals));

  const casPerPol = polPriceUsd / casPriceUsd;
  const rawPrice = isCasToken0 ? 1 / casPerPol : casPerPol;

  // Token decimals
  const token0Contract = new ethers.Contract(token0, ERC20_ABI, provider);
  const token1Contract = new ethers.Contract(token1, ERC20_ABI, provider);
  const dec0 = Number(await token0Contract.decimals());
  const dec1 = Number(await token1Contract.decimals());

  // New tick range
  const newCurrentTick = priceToTick(
    rawPrice,
    isCasToken0 ? dec0 : dec1,
    isCasToken0 ? dec1 : dec0,
  );
  const tickSpacing = feeTier === 500 ? 10 : feeTier === 3000 ? 60 : 200;
  const tickLower = Math.floor((newCurrentTick * (100 - tickRangePercent) / 100) / tickSpacing) * tickSpacing;
  const tickUpper = Math.ceil((newCurrentTick * (100 + tickRangePercent) / 100) / tickSpacing) * tickSpacing;

  log("INFO", "Novo range de ticks", {
    currentTick: newCurrentTick,
    tickLower,
    tickUpper,
    tickSpacing,
    casPerPol: casPerPol.toFixed(2),
    polPriceUsd: polPriceUsd.toFixed(6),
  });

  // --- Current position ---
  const positionManager = new ethers.Contract(
    "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
    POSITION_MANAGER_ABI,
    relayer,
  );

  const pos = await positionManager.positions(tokenId);
  const oldTickLower = Number(pos.tickLower);
  const oldTickUpper = Number(pos.tickUpper);
  const positionLiquidity = pos.liquidity;

  log("INFO", "Posicao atual", {
    tokenId: tokenId.toString(),
    tickLower: oldTickLower,
    tickUpper: oldTickUpper,
    liquidity: positionLiquidity.toString(),
    feesOwed0: pos.tokensOwed0.toString(),
    feesOwed1: pos.tokensOwed1.toString(),
  });

  if (positionLiquidity === 0n) {
    log("ERROR", "Posicao sem liquidez. Nada a rebalancear.", {});
    process.exit(1);
  }

  // Check if rebalance is needed
  const inRange = currentTick >= oldTickLower && currentTick < oldTickUpper;
  if (inRange && oldTickLower === tickLower && oldTickUpper === tickUpper) {
    log("INFO", "Posicao ja esta no range ideal. Nenhum rebalanceamento necessario.", {});
    process.exit(0);
  }

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);

  // --- Step 1: Decrease liquidity (withdraw all) ---
  console.log(`\n${SUB}`);
  console.log("  Step 1: Remover liquidez atual");
  console.log(SUB);

  const decreaseTx = await positionManager.decreaseLiquidity(
    tokenId,
    positionLiquidity,
    0n,
    0n,
    deadline,
    { gasPrice, gasLimit: 300_000n },
  );
  await decreaseTx.wait();
  log("INFO", "Liquidez removida", { txHash: decreaseTx.hash });

  // --- Step 2: Collect tokens (including fees) ---
  console.log(`\n${SUB}`);
  console.log("  Step 2: Coletar tokens e fees");
  console.log(SUB);

  const collectTx = await positionManager.collect(
    tokenId,
    relayer.address,
    ethers.MaxUint128,
    ethers.MaxUint128,
    { gasPrice, gasLimit: 300_000n },
  );
  const collectReceipt = await collectTx.wait();
  log("INFO", "Tokens coletados", { txHash: collectTx.hash });

  // --- Step 3: Check balances ---
  const casContract = new ethers.Contract(casTokenAddress, ERC20_ABI, relayer);
  const wpolAddress = isCasToken0 ? token1 : token0;
  const wpol = new ethers.Contract(wpolAddress, WPOL_ABI, relayer);

  const casBalance = await casContract.balanceOf(relayer.address);
  const wpolBalance = await wpol.balanceOf(relayer.address);

  log("INFO", "Saldos apos coleta", {
    cas: ethers.formatEther(casBalance),
    wpol: ethers.formatEther(wpolBalance),
  });

  // --- Step 4: Approve and increase liquidity with new range ---
  console.log(`\n${SUB}`);
  console.log("  Step 3: Adicionar liquidez no novo range");
  console.log(SUB);

  const casAmount = casBalance;
  const polAmount = wpolBalance;

  // Approve both tokens
  await (await casContract.approve(positionManager.target, casAmount, { gasPrice, gasLimit: 200_000n })).wait();
  await (await wpol.approve(positionManager.target, polAmount, { gasPrice, gasLimit: 200_000n })).wait();
  log("INFO", "Tokens aprovados para Position Manager");

  const increaseTx = await positionManager.increaseLiquidity(
    tokenId,
    isCasToken0 ? casAmount : polAmount,
    isCasToken0 ? polAmount : casAmount,
    0n,
    0n,
    deadline,
    { gasPrice, gasLimit: 400_000n },
  );
  const increaseReceipt = await increaseTx.wait();
  log("INFO", "Liquidez adicionada no novo range", { txHash: increaseTx.hash });

  // --- Verify final state ---
  const newPos = await positionManager.positions(tokenId);
  log("INFO", "Posicao final", {
    tokenId: tokenId.toString(),
    tickLower: Number(newPos.tickLower),
    tickUpper: Number(newPos.tickUpper),
    liquidity: newPos.liquidity.toString(),
  });

  console.log(`\n${SUB}`);
  console.log("  Resultado");
  console.log(SUB);
  console.log(`  Token ID:          ${tokenId.toString()}`);
  console.log(`  Novo tick range:   [${Number(newPos.tickLower)}, ${Number(newPos.tickUpper)}]`);
  console.log(`  Nova liquidez:     ${newPos.liquidity.toString()}`);
  console.log(`  CAS na posicao:    ${ethers.formatEther(casAmount)}`);
  console.log(`  WPOL na posicao:   ${ethers.formatEther(polAmount)}`);
  console.log(`\n${SEP}\n`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    log("ERROR", "Script failed", { error: err.message });
    console.error(err);
    process.exit(1);
  });
