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
  estimateFunctionGas,
} from "../utils/deploy_helpers";

const CHAINLINK_ABI = [
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
];

const DIAMOND_ABI = [
  "function setSwapRatio(uint256 numerator, uint256 denominator) external",
  "function setSwapRatioUSDC(uint256 numerator, uint256 denominator) external",
  "function setSwapRatioSell(uint256 numerator, uint256 denominator) external",
  "function setSwapRatioUSDCSell(uint256 numerator, uint256 denominator) external",
  "function getRatio() view returns (uint256 numerator, uint256 denominator)",
  "function getRatioUSDC() view returns (uint256 numerator, uint256 denominator)",
  "function getRatioSell() view returns (uint256 numerator, uint256 denominator)",
  "function getRatioUSDCSell() view returns (uint256 numerator, uint256 denominator)",
  "function isSwapPaused() view returns (bool)",
  "function RATIO_SETTER_ROLE() view returns (bytes32)",
  "function owner() view returns (address)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
];

function log(level: string, message: string, params?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").split(".")[0];
  const file = "scripts/casswap/19_set_diamond_ratio_target.ts";
  const extra = params ? ` - ${JSON.stringify(params)}` : "";
  console.log(`[${ts}] [${file}:main] ${level} ${message}${extra}`);
}

async function main(): Promise<void> {
  console.log(`\n${SEP}`);
  console.log("  Configurar Ratio do Diamond Swap (CAS = $0.0005)");
  console.log(SEP);

  const env = requireEnv(["DIAMOND_ADDRESS", "CHAINLINK_POL_USD_FEED", "RELAYER_PRIVATE_KEY"]);
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
    log("ERROR", "Abortando: script deve rodar na Polygon mainnet (137)", { chainId });
    process.exit(1);
  }

  const diamondAddress = env.DIAMOND_ADDRESS;
  const casPriceUsd = parseFloat(process.env.CAS_PRICE_USD ?? "0.0005");
  const sellSpreadBps = parseInt(process.env.SELL_SPREAD_BPS ?? "2000", 10);

  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? 25_000_000_000n;
  console.log(`  Gas price: ${fmtGwei(gasPrice)}`);

  const diamond = new ethers.Contract(diamondAddress, DIAMOND_ABI, relayer);

  // Verify access control
  const owner = await diamond.owner();
  const ratioSetterRole = await diamond.RATIO_SETTER_ROLE();
  const hasRole = await diamond.hasRole(ratioSetterRole, relayer.address);
  const isOwner = relayer.address.toLowerCase() === owner.toLowerCase();

  log("INFO", "Controle de acesso", {
    signer: relayer.address,
    owner,
    isOwner,
    hasRatioSetterRole: hasRole,
  });

  if (!isOwner && !hasRole) {
    log("ERROR", "Deployer nao e owner nem RATIO_SETTER_ROLE. Nao pode setar ratios.", {});
    process.exit(1);
  }

  // Fetch POL/USD price from Chainlink
  const chainlink = new ethers.Contract(env.CHAINLINK_POL_USD_FEED.toLowerCase(), CHAINLINK_ABI, provider);
  const [, polPriceRaw, , updatedAt] = await chainlink.latestRoundData();
  const chainlinkDecimals = await chainlink.decimals();
  const polPriceUsd = Number(polPriceRaw) / Number(10n ** BigInt(chainlinkDecimals));

  log("INFO", "Chainlink POL/USD price", {
    price: polPriceUsd.toFixed(6),
    updatedAt: new Date(Number(updatedAt) * 1000).toISOString(),
    chainlinkDecimals: Number(chainlinkDecimals),
  });

  // Calculate ratios
  // CAS has 18 decimals, POL has 18 decimals, USDC has 6 decimals
  // Ratio semantics: num/den = CAS (base units) per 1 base unit of quote currency
  // 1 POL = (polPriceUsd / casPriceUsd) CAS
  const casPerPol = polPriceUsd / casPriceUsd;
  const casPerUsdc = 1 / casPriceUsd;

  // POL ratio: 18-decimal scaled (matching existing Diamond format)
  // e.g. casPerPol = 145.54 -> num = 145.54e18, den = 1e18
  const ratioPolNum = ethers.parseEther(casPerPol.toFixed(18));
  const ratioPolDen = ethers.parseEther("1");

  // USDC ratio: 12-decimal scaled (CAS 18 decimals vs USDC 6 decimals)
  // e.g. casPerUsdc = 2000 -> num = 2000e12, den = 1
  const ratioUsdcNum = ethers.parseUnits(casPerUsdc.toFixed(12), 12);
  const ratioUsdcDen = 1n;

  // Sell ratios: apply spread (sell receives less CAS)
  // sellNum = buyNum * (10000 - spread) / 10000
  const sellFactor = BigInt(10000 - sellSpreadBps);
  const ratioPolSellNum = (ratioPolNum * sellFactor) / 10000n;
  const ratioPolSellDen = ratioPolDen;
  const ratioUsdcSellNum = (ratioUsdcNum * sellFactor) / 10000n;
  const ratioUsdcSellDen = ratioUsdcDen;

  log("INFO", "Ratios calculados", {
    casPriceUsd,
    polPriceUsd: polPriceUsd.toFixed(6),
    casPerPol: casPerPol.toFixed(2),
    casPerUsdc: casPerUsdc.toFixed(2),
    ratioPol: `${ratioPolNum}/${ratioPolDen}`,
    ratioUsdc: `${ratioUsdcNum}/${ratioUsdcDen}`,
    ratioPolSell: `${ratioPolSellNum}/${ratioPolSellDen}`,
    ratioUsdcSell: `${ratioUsdcSellNum}/${ratioUsdcSellDen}`,
    sellSpreadBps,
  });

  // Check current state
  const isPaused = await diamond.isSwapPaused();
  const [curPolNum, curPolDen] = await diamond.getRatio();
  const [curUsdcNum, curUsdcDen] = await diamond.getRatioUSDC();

  log("INFO", "Estado atual do Diamond", {
    isPaused,
    currentRatioPol: `${curPolNum}/${curPolDen}`,
    currentRatioUsdc: `${curUsdcNum}/${curUsdcDen}`,
  });

  if (isPaused) {
    log("WARN", "Swap esta pausado. Ratios serao definidos mas swap continuara pausado.");
    log("INFO", "Para despausar, execute o script de unpause apropriado.");
  }

  console.log(`\n${SUB}`);
  console.log("  Resumo das transacoes");
  console.log(SUB);
  console.log(`  CAS Price:    $${casPriceUsd.toFixed(6)}`);
  console.log(`  POL Price:    $${polPriceUsd.toFixed(6)}`);
  console.log(`  CAS por POL:  ${casPerPol.toFixed(2)} (ratio ${ratioPolNum}/${ratioPolDen})`);
  console.log(`  CAS por USDC: ${casPerUsdc.toFixed(2)} (ratio ${ratioUsdcNum}/${ratioUsdcDen})`);
  console.log(`  Sell spread:  ${sellSpreadBps / 100}% (${sellSpreadBps} bps)`);
  console.log(`  Sell POL:     ratio ${ratioPolSellNum}/${ratioPolSellDen}`);
  console.log(`  Sell USDC:    ratio ${ratioUsdcSellNum}/${ratioUsdcSellDen}`);

  // Execute transactions
  const gasLimit = 200_000n;

  // Static call first to get better error messages
  try {
    await diamond.setSwapRatio.staticCall(ratioPolNum, ratioPolDen);
  } catch (err: any) {
    log("ERROR", "staticCall setSwapRatio falhou", {
      error: err.message,
      ratioPolNum: ratioPolNum.toString(),
      ratioPolDen: ratioPolDen.toString(),
    });
    process.exit(1);
  }

  await sendAndVerify(
    "setSwapRatio (POL buy)",
    diamond.setSwapRatio(ratioPolNum, ratioPolDen),
    gasPrice,
    gasLimit,
  );

  await sendAndVerify(
    "setSwapRatioUSDC (USDC buy)",
    diamond.setSwapRatioUSDC(ratioUsdcNum, ratioUsdcDen),
    gasPrice,
    gasLimit,
  );

  await sendAndVerify(
    "setSwapRatioSell (POL sell)",
    diamond.setSwapRatioSell(ratioPolSellNum, ratioPolSellDen),
    gasPrice,
    gasLimit,
  );

  await sendAndVerify(
    "setSwapRatioUSDCSell (USDC sell)",
    diamond.setSwapRatioUSDCSell(ratioUsdcSellNum, ratioUsdcSellDen),
    gasPrice,
    gasLimit,
  );

  // Verify final state
  const [finalPolNum, finalPolDen] = await diamond.getRatio();
  const [finalUsdcNum, finalUsdcDen] = await diamond.getRatioUSDC();
  const [finalPolSellNum, finalPolSellDen] = await diamond.getRatioSell();
  const [finalUsdcSellNum, finalUsdcSellDen] = await diamond.getRatioUSDCSell();

  log("INFO", "Ratios finais verificados", {
    polBuy: `${finalPolNum}/${finalPolDen}`,
    usdcBuy: `${finalUsdcNum}/${finalUsdcDen}`,
    polSell: `${finalPolSellNum}/${finalPolSellDen}`,
    usdcSell: `${finalUsdcSellNum}/${finalUsdcSellDen}`,
  });

  console.log(`\n${SUB}`);
  console.log("  Resultado");
  console.log(SUB);
  console.log(`  POL buy ratio:  ${finalPolNum}/${finalPolDen}`);
  console.log(`  USDC buy ratio: ${finalUsdcNum}/${finalUsdcDen}`);
  console.log(`  POL sell ratio: ${finalPolSellNum}/${finalPolSellDen}`);
  console.log(`  USDC sell ratio:${finalUsdcSellNum}/${finalUsdcSellDen}`);
  console.log(`\n  Proximos passos:`);
  console.log(`    1. Despausar swap (se necessario)`);
  console.log(`    2. Depositar POL no Diamond: npx hardhat run scripts/casswap/17_deposit_pol_to_diamond.ts --network polygon`);
  console.log(`    3. Verificar estado:         npx hardhat run scripts/casswap/01_check_casswap_state.ts --network polygon`);
  console.log(`\n${SEP}\n`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    log("ERROR", "Script failed", { error: err.message });
    console.error(err);
    process.exit(1);
  });
