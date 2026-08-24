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

const UNIV3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const UNIV3_POSITION_MANAGER = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";
const UNIV3_FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)",
  "function createPool(address tokenA, address tokenB, uint24 fee) returns (address pool)",
];

const UNIV3_POOL_ABI = [
  "function initialize(uint160 sqrtPriceX96) external",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
];

const POSITION_MANAGER_ABI = [
  "function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)) returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
];

const CAS_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

function log(level: string, message: string, params?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").split(".")[0];
  const file = "scripts/deploy/05_add_uniswap_v3_liquidity.ts";
  const extra = params ? ` - ${JSON.stringify(params)}` : "";
  console.log(`[${ts}] [${file}:main] ${level} ${message}${extra}`);
}

function tickToSqrtPriceX96(tick: number): bigint {
  const ratio = Math.pow(1.0001, tick);
  const sqrtPrice = Math.sqrt(ratio);
  const sqrtPriceX96 = BigInt(Math.floor(sqrtPrice * Number(2n ** 96n)));
  return sqrtPriceX96;
}

function priceToTick(price: number, token0Decimals: number, token1Decimals: number): number {
  const adjustedPrice = price * Math.pow(10, token0Decimals - token1Decimals);
  return Math.floor(Math.log(adjustedPrice) / Math.log(1.0001));
}

async function main(): Promise<void> {
  console.log(`\n${SEP}`);
  console.log("  Adicionar Liquidez Uniswap V3 (CAS/WPOL)");
  console.log(SEP);

  const env = requireEnv(["CAS_TOKEN_ADDRESS", "CHAINLINK_POL_USD_FEED"]);
  const [deployer] = await ethers.getSigners();
  const provider = deployer.provider!;

  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);
  const netInfo = getNetworkInfo(chainId);

  console.log(`\n${SUB}`);
  console.log("  Rede");
  console.log(SUB);
  console.log(`  Rede:      ${netInfo.name}`);
  console.log(`  Chain ID:  ${chainId}`);
  console.log(`  Deployer:  ${deployer.address}`);

  if (chainId !== 137) {
    log("ERROR", "Abortando: script deve rodar na Polygon mainnet (137)", { chainId });
    process.exit(1);
  }

  const casTokenAddress = env.CAS_TOKEN_ADDRESS;
  const wpolAddress = process.env.WPOL_ADDRESS ?? "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";
  const feeTier = parseInt(process.env.UNIV3_FEE_TIER ?? "3000", 10);
  const casPriceUsd = parseFloat(process.env.CAS_PRICE_USD ?? "0.0005");
  const polAmountInput = process.env.UNIV3_POL_AMOUNT ?? "20";
  const tickRangePercent = parseInt(process.env.UNIV3_TICK_RANGE_PERCENT ?? "10", 10);

  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? 25_000_000_000n;
  console.log(`  Gas price: ${fmtGwei(gasPrice)}`);

  // Fetch POL/USD from Chainlink
  const chainlink = new ethers.Contract(env.CHAINLINK_POL_USD_FEED.toLowerCase(), CHAINLINK_ABI, provider);
  const [, polPriceRaw] = await chainlink.latestRoundData();
  const chainlinkDecimals = await chainlink.decimals();
  const polPriceUsd = Number(polPriceRaw) / Number(10n ** BigInt(chainlinkDecimals));

  // Calculate CAS amount based on target price
  const casPerPol = polPriceUsd / casPriceUsd;
  const polAmountWei = ethers.parseEther(polAmountInput);
  const casAmountWei = ethers.parseEther(
    (Number(polAmountInput) * casPerPol).toFixed(18),
  );

  log("INFO", "Parametros V3", {
    casToken: casTokenAddress,
    wpol: wpolAddress,
    feeTier,
    casPriceUsd,
    polPriceUsd: polPriceUsd.toFixed(6),
    casPerPol: casPerPol.toFixed(2),
    polAmount: polAmountInput,
    casAmount: ethers.formatEther(casAmountWei),
    tickRangePercent,
  });

  // Determine token ordering (token0 < token1 by address)
  const [token0, token1] = casTokenAddress.toLowerCase() < wpolAddress.toLowerCase()
    ? [casTokenAddress, wpolAddress]
    : [wpolAddress, casTokenAddress];

  const isCasToken0 = token0.toLowerCase() === casTokenAddress.toLowerCase();

  // Get decimals
  const casContract = new ethers.Contract(casTokenAddress, CAS_ABI, deployer);
  const casDecimals = Number(await casContract.decimals());

  // Calculate price and tick
  // Price = token1/token0 in base units
  // If CAS is token0: price = WPOL/CAS = 1/casPerPol (in base units, adjusted for decimals)
  // If WPOL is token0: price = CAS/WPOL = casPerPol (in base units, adjusted for decimals)
  const rawPrice = isCasToken0 ? 1 / casPerPol : casPerPol;
  const currentTick = priceToTick(
    rawPrice,
    isCasToken0 ? casDecimals : 18,
    isCasToken0 ? 18 : casDecimals,
  );

  const tickSpacing = feeTier === 500 ? 10 : feeTier === 3000 ? 60 : 200;
  const tickLower = Math.floor((currentTick * (100 - tickRangePercent) / 100) / tickSpacing) * tickSpacing;
  const tickUpper = Math.ceil((currentTick * (100 + tickRangePercent) / 100) / tickSpacing) * tickSpacing;

  log("INFO", "Calculo de tick", {
    isCasToken0,
    rawPrice: rawPrice.toFixed(10),
    currentTick,
    tickSpacing,
    tickLower,
    tickUpper,
  });

  // Check if pool exists
  const factory = new ethers.Contract(UNIV3_FACTORY, UNIV3_FACTORY_ABI, deployer);
  let poolAddress = await factory.getPool(token0, token1, feeTier);

  console.log(`\n${SUB}`);
  console.log("  Pool V3");
  console.log(SUB);

  if (poolAddress === ethers.ZeroAddress) {
    log("INFO", "Pool nao existe. Criando...", { token0, token1, feeTier });
    const createTx = await factory.createPool(token0, token1, feeTier);
    await createTx.wait();
    poolAddress = await factory.getPool(token0, token1, feeTier);
    log("INFO", "Pool criada", { poolAddress });

    // Initialize pool with sqrtPriceX96
    const pool = new ethers.Contract(poolAddress, UNIV3_POOL_ABI, deployer);
    const sqrtPriceX96 = tickToSqrtPriceX96(currentTick);
    log("INFO", "Inicializando pool", {
      sqrtPriceX96: sqrtPriceX96.toString(),
    });

    const initData = pool.interface.encodeFunctionData("initialize", [sqrtPriceX96]);
    const initTx = await deployer.sendTransaction({
      to: poolAddress,
      data: initData,
      gasPrice,
      gasLimit: 500_000n,
    });
    await initTx.wait();
    log("INFO", "Pool inicializada", { txHash: initTx.hash });
  } else {
    log("INFO", "Pool ja existe", { poolAddress });
    const pool = new ethers.Contract(poolAddress, UNIV3_POOL_ABI, deployer);
    const slot0 = await pool.slot0();
    const sqrtPriceX96Current = slot0.sqrtPriceX96;

    log("INFO", "Estado atual da pool", {
      sqrtPriceX96: sqrtPriceX96Current.toString(),
      tick: Number(slot0.tick),
      liquidity: (await pool.liquidity()).toString(),
    });

    // Pool exists but was never initialized
    if (sqrtPriceX96Current === 0n) {
      const sqrtPriceX96 = tickToSqrtPriceX96(currentTick);
      log("INFO", "Pool nao inicializada. Inicializando agora...", {
        sqrtPriceX96: sqrtPriceX96.toString(),
      });
      const initTx = await pool.initialize(sqrtPriceX96, { gasPrice, gasLimit: 500_000n });
      await initTx.wait();
      log("INFO", "Pool inicializada", { txHash: initTx.hash });
    }
  }

  // Approve CAS for position manager
  const casBalance = await casContract.balanceOf(deployer.address);
  log("INFO", "Saldo CAS do deployer", { balance: ethers.formatEther(casBalance) });

  if (casBalance < casAmountWei) {
    log("ERROR", "Saldo CAS insuficiente", {
      balance: ethers.formatEther(casBalance),
      required: ethers.formatEther(casAmountWei),
    });
    process.exit(1);
  }

  console.log(`\n${SUB}`);
  console.log("  Aprovacao CAS");
  console.log(SUB);
  const approveTx = await casContract.approve(UNIV3_POSITION_MANAGER, casAmountWei);
  await approveTx.wait();
  log("INFO", "CAS aprovado para Position Manager", {
    amount: ethers.formatEther(casAmountWei),
    positionManager: UNIV3_POSITION_MANAGER,
  });

  // Mint position
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const positionManager = new ethers.Contract(UNIV3_POSITION_MANAGER, POSITION_MANAGER_ABI, deployer);

  const mintParams = {
    token0,
    token1,
    fee: feeTier,
    tickLower,
    tickUpper,
    amount0Desired: isCasToken0 ? casAmountWei : 0n,
    amount1Desired: isCasToken0 ? 0n : casAmountWei,
    amount0Min: 0n,
    amount1Min: 0n,
    recipient: deployer.address,
    deadline,
  };

  // Need to also provide WPOL — get from deployer balance
  const deployerPol = await provider.getBalance(deployer.address);
  const polForLiquidity = ethers.parseEther(polAmountInput);

  log("INFO", "Mintando posicao V3", {
    token0,
    token1,
    fee: feeTier,
    tickLower,
    tickUpper,
    casAmount: ethers.formatEther(casAmountWei),
    polAmount: ethers.formatEther(polForLiquidity),
    deadline: deadline.toString(),
  });

  // For V3, we need to wrap POL to WPOL first and approve
  const wpol = new ethers.Contract(
    wpolAddress,
    ["function deposit() payable", "function approve(address, uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"],
    deployer,
  );

  console.log(`\n${SUB}`);
  console.log("  Wrap POL -> WPOL");
  console.log(SUB);
  const wrapTx = await wpol.deposit({ value: polForLiquidity, gasPrice, gasLimit: 200_000n });
  await wrapTx.wait();
  log("INFO", "POL wrapped", { amount: ethers.formatEther(polForLiquidity) });

  const wpolApproveTx = await wpol.approve(UNIV3_POSITION_MANAGER, polForLiquidity);
  await wpolApproveTx.wait();
  log("INFO", "WPOL aprovado para Position Manager");

  // Now mint with both tokens
  const mintParamsBoth = {
    token0,
    token1,
    fee: feeTier,
    tickLower,
    tickUpper,
    amount0Desired: isCasToken0 ? casAmountWei : polForLiquidity,
    amount1Desired: isCasToken0 ? polForLiquidity : casAmountWei,
    amount0Min: 0n,
    amount1Min: 0n,
    recipient: deployer.address,
    deadline,
  };

  console.log(`\n${SUB}`);
  console.log("  Mint posicao NFT");
  console.log(SUB);

  const mintTx = await positionManager.mint(mintParamsBoth);
  const mintReceipt = await mintTx.wait();

  // Extract tokenId from events
  const mintEvent = mintReceipt?.logs.find(
    (log_entry: any) => log_entry.topics?.[0] === ethers.id("IncreaseLiquidity(uint256,uint128,uint256,uint256)"),
  );

  let tokenId: bigint | null = null;
  if (mintEvent) {
    tokenId = BigInt(mintEvent.topics[1]);
  }

  log("INFO", "Posicao mintada", {
    txHash: mintTx.hash,
    tokenId: tokenId?.toString(),
    gasUsed: mintReceipt?.gasUsed.toString(),
  });

  console.log(`\n${SUB}`);
  console.log("  Resultado");
  console.log(SUB);
  console.log(`  Pool V3:        ${poolAddress}`);
  console.log(`  Token ID NFT:   ${tokenId?.toString() ?? "verificar no receipt"}`);
  console.log(`  Fee tier:       ${feeTier} (${feeTier / 10000}%)`);
  console.log(`  Tick range:     [${tickLower}, ${tickUpper}]`);
  console.log(`  CAS depositado: ${ethers.formatEther(casAmountWei)}`);
  console.log(`  WPOL depositado:${ethers.formatEther(polForLiquidity)}`);
  console.log(`\n  Proximos passos:`);
  console.log(`    1. Adicione UNIV3_POOL_ADDRESS=${poolAddress} ao .env`);
  console.log(`    2. Adicione UNIV3_NFT_TOKEN_ID=${tokenId?.toString() ?? "<verificar>"} ao .env`);
  console.log(`    3. Monitorar a posicao e ajustar se necessario`);
  console.log(`\n${SEP}\n`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    log("ERROR", "Script failed", { error: err.message });
    console.error(err);
    process.exit(1);
  });
