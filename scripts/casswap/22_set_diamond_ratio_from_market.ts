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

const DIAMOND_ABI = [
  "function setAllSwapRatios(uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256) external",
  "function setSwapRatio(uint256,uint256) external",
  "function setSwapRatioUSDC(uint256,uint256) external",
  "function setSwapRatioSell(uint256,uint256) external",
  "function setSwapRatioUSDCSell(uint256,uint256) external",
  "function getRatio() view returns (uint256 numerator, uint256 denominator)",
  "function getRatioUSDC() view returns (uint256 numerator, uint256 denominator)",
  "function getRatioSell() view returns (uint256 numerator, uint256 denominator)",
  "function getRatioUSDCSell() view returns (uint256 numerator, uint256 denominator)",
  "function isSwapPaused() view returns (bool)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function RATIO_SETTER_ROLE() view returns (bytes32)",
  "function owner() view returns (address)",
];

const CAS_TOKEN_ADDRESS = process.env.CAS_TOKEN_ADDRESS ?? "0x5151A34EaC7bA08cd6B540b32cD30316218A2287";
const GECKO_TOKEN_URL = `https://api.geckoterminal.com/api/v2/networks/polygon_pos/tokens/${CAS_TOKEN_ADDRESS}`;

function log(level: string, message: string, params?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").split(".")[0];
  const file = "scripts/casswap/22_set_diamond_ratio_from_market.ts";
  const extra = params ? ` - ${JSON.stringify(params)}` : "";
  console.log(`[${ts}] [${file}:main] ${level} ${message}${extra}`);
}

async function fetchCasPriceUsd(): Promise<number> {
  const res = await fetch(GECKO_TOKEN_URL, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`GeckoTerminal API HTTP ${res.status}`);
  const body = (await res.json()) as {
    data?: { attributes?: { price_usd?: string } };
  };
  const price = body.data?.attributes?.price_usd;
  if (!price) throw new Error("GeckoTerminal price_usd ausente");
  return parseFloat(price);
}

function bpsDiff(aNum: bigint, aDen: bigint, bNum: bigint, bDen: bigint): number {
  if (aNum === 0n || aDen === 0n || bNum === 0n || bDen === 0n) return 0;
  const aScaled = aNum * bDen;
  const bScaled = bNum * aDen;
  const diff = aScaled > bScaled ? aScaled - bScaled : bScaled - aScaled;
  const impact = Number((diff * 10000n) / bScaled);
  return impact;
}

async function main(): Promise<void> {
  console.log(`\n${SEP}`);
  console.log("  Configurar Diamond ratio a partir do preço de mercado");
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
  const sellSpreadBps = parseInt(process.env.SELL_SPREAD_BPS ?? "200", 10);
  const minUpdateBps = parseInt(process.env.MIN_UPDATE_BPS ?? "50", 10);
  const dryRun = (process.env.DRY_RUN ?? "false").toLowerCase() === "true";

  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? 25_000_000_000n;
  console.log(`  Gas price: ${fmtGwei(gasPrice)}`);

  const diamond = new ethers.Contract(diamondAddress, DIAMOND_ABI, relayer);

  // Verify access control
  const owner = await diamond.owner();
  const ratioSetterRole = await diamond.RATIO_SETTER_ROLE();
  const hasRole = await diamond.hasRole(ratioSetterRole, relayer.address);
  const isOwner = relayer.address.toLowerCase() === owner.toLowerCase();

  log("INFO", "Controle de acesso", { signer: relayer.address, owner, isOwner, hasRatioSetterRole: hasRole });

  if (!isOwner && !hasRole) {
    log("ERROR", "Deployer nao e owner nem RATIO_SETTER_ROLE. Nao pode setar ratios.", {});
    process.exit(1);
  }

  if (await diamond.isSwapPaused()) {
    log("WARN", "Swap pausado. Nada sera executado.");
    process.exit(0);
  }

  // Fetch prices
  const [casPriceUsd, chainlink] = await Promise.all([
    fetchCasPriceUsd(),
    (async () => {
      const c = new ethers.Contract(env.CHAINLINK_POL_USD_FEED.toLowerCase(), CHAINLINK_ABI, provider);
      const [, answer, , updatedAt] = await c.latestRoundData();
      const dec = await c.decimals();
      return { price: Number(answer) / Number(10n ** BigInt(dec)), updatedAt };
    })(),
  ]);

  const polPriceUsd = chainlink.price;

  log("INFO", "Precos de mercado", {
    casPriceUsd,
    polPriceUsd: polPriceUsd.toFixed(6),
    chainlinkUpdatedAt: new Date(Number(chainlink.updatedAt) * 1000).toISOString(),
  });

  if (casPriceUsd <= 0 || polPriceUsd <= 0) {
    log("ERROR", "Precos invalidos", { casPriceUsd, polPriceUsd });
    process.exit(1);
  }

  // Calculate ratios
  // Ratio semantics: num/den = CAS (base units) per 1 base unit of quote currency
  const casPerPol = polPriceUsd / casPriceUsd;
  const casPerUsdc = 1 / casPriceUsd;

  const ratioPolNum = ethers.parseEther(casPerPol.toFixed(18));
  const ratioPolDen = ethers.parseEther("1");
  const ratioUsdcNum = ethers.parseUnits(casPerUsdc.toFixed(12), 12);
  const ratioUsdcDen = 1n;

  const sellFactor = BigInt(10000 - sellSpreadBps);
  const ratioPolSellNum = (ratioPolNum * sellFactor) / 10000n;
  const ratioPolSellDen = ratioPolDen;
  const ratioUsdcSellNum = (ratioUsdcNum * sellFactor) / 10000n;
  const ratioUsdcSellDen = ratioUsdcDen;

  // Fetch current on-chain ratios
  const [curPolNum, curPolDen] = await diamond.getRatio();
  const [curUsdcNum, curUsdcDen] = await diamond.getRatioUSDC();
  const [curPolSellNum, curPolSellDen] = await diamond.getRatioSell();
  const [curUsdcSellNum, curUsdcSellDen] = await diamond.getRatioUSDCSell();

  const impactPol = bpsDiff(curPolNum, curPolDen, ratioPolNum, ratioPolDen);
  const impactUsdc = bpsDiff(curUsdcNum, curUsdcDen, ratioUsdcNum, ratioUsdcDen);
  const impactPolSell = bpsDiff(curPolSellNum, curPolSellDen, ratioPolSellNum, ratioPolSellDen);
  const impactUsdcSell = bpsDiff(curUsdcSellNum, curUsdcSellDen, ratioUsdcSellNum, ratioUsdcSellDen);

  log("INFO", "Comparativo de ratios", {
    impactPol,
    impactUsdc,
    impactPolSell,
    impactUsdcSell,
    minUpdateBps,
  });

  if (
    impactPol < minUpdateBps &&
    impactUsdc < minUpdateBps &&
    impactPolSell < minUpdateBps &&
    impactUsdcSell < minUpdateBps
  ) {
    log("INFO", "Nenhuma variacao acima do limite minimo. Nenhuma transacao sera enviada.", { minUpdateBps });
    process.exit(0);
  }

  console.log(`\n${SUB}`);
  console.log("  Resumo da transacao");
  console.log(SUB);
  console.log(`  CAS Price:    $${casPriceUsd.toFixed(8)}`);
  console.log(`  POL Price:    $${polPriceUsd.toFixed(6)}`);
  console.log(`  CAS por POL:  ${casPerPol.toFixed(4)} (buy)`);
  console.log(`  CAS por USDC: ${casPerUsdc.toFixed(4)} (buy)`);
  console.log(`  Sell spread:  ${sellSpreadBps / 100}% (${sellSpreadBps} bps)`);
  console.log(`  Modo:         ${dryRun ? "DRY-RUN" : "BROADCAST"}`);

  if (dryRun) {
    log("INFO", "DRY-RUN: transacao nao enviada", {
      polBuy: `${ratioPolNum}/${ratioPolDen}`,
      usdcBuy: `${ratioUsdcNum}/${ratioUsdcDen}`,
      polSell: `${ratioPolSellNum}/${ratioPolSellDen}`,
      usdcSell: `${ratioUsdcSellNum}/${ratioUsdcSellDen}`,
    });
    process.exit(0);
  }

  const gasLimit = 250_000n;

  // Static call first to get better error messages
  try {
    await diamond.setAllSwapRatios.staticCall(
      ratioPolNum,
      ratioPolDen,
      ratioUsdcNum,
      ratioUsdcDen,
      ratioPolSellNum,
      ratioPolSellDen,
      ratioUsdcSellNum,
      ratioUsdcSellDen,
    );
  } catch (err: any) {
    log("ERROR", "staticCall setAllSwapRatios falhou", { error: err.message });
    process.exit(1);
  }

  await sendAndVerify(
    "setAllSwapRatios",
    diamond.setAllSwapRatios(
      ratioPolNum,
      ratioPolDen,
      ratioUsdcNum,
      ratioUsdcDen,
      ratioPolSellNum,
      ratioPolSellDen,
      ratioUsdcSellNum,
      ratioUsdcSellDen,
      { gasPrice, gasLimit },
    ),
    gasPrice,
    gasLimit,
  );

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

  console.log(`\n${SEP}\n`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    log("ERROR", "Script failed", { error: err.message });
    console.error(err);
    process.exit(1);
  });
