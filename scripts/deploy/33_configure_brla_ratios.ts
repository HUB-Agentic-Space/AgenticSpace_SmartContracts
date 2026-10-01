import { ethers, network } from "hardhat";

const DIAMOND = process.env.DIAMOND_ADDRESS ?? "0x80BD976cB588cD2F9aD9Ac671FB19174E9F3172b";
const BRLA_TOKEN = process.env.BRLA_TOKEN_ADDRESS ?? "0xe6a537a407488807f0bbeb0038b79004f19dddfb";
const FEED_DECIMALS_BOUND = 36n;

const SWAP_ABI = [
  "function getBRLAToken() view returns (address)",
  "function setBRLAToken(address) external",
  "function getRatioUSDC() view returns (uint256,uint256)",
  "function getRatioUSDCSell() view returns (uint256,uint256)",
  "function getRatioBRLA() view returns (uint256,uint256)",
  "function getRatioBRLASell() view returns (uint256,uint256)",
  "function setAllSwapRatiosV2(uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256) external",
  "function getRatio() view returns (uint256,uint256)",
  "function getRatioSell() view returns (uint256,uint256)",
];

const FEED_ABI = [
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
];

function log(level: string, message: string, details = ""): void {
  const timestamp = new Date().toISOString().replace("T", " ").replace("Z", "");
  console.log(`[${timestamp}] [33_configure_brla_ratios:main] ${level} ${message}${details ? ` - ${details}` : ""}`);
}

/**
 * BRL por 1 USD. Fonte: feed Chainlink BRL/USD (CHAINLINK_BRL_USD_FEED) ou
 * a variável BRLA_USD_RATE (ex.: "5.40"). Retorna fração escalada 1e8.
 */
async function getBrlPerUsd(signer: ethers.Signer): Promise<{ num: bigint; den: bigint }> {
  const feedAddr = process.env.CHAINLINK_BRL_USD_FEED?.trim();
  if (feedAddr) {
    const feed = new ethers.Contract(feedAddr, FEED_ABI, signer);
    const decimals = await feed.decimals();
    if (decimals > FEED_DECIMALS_BOUND) throw new Error(`Feed decimals inválido: ${decimals}`);
    const round = await feed.latestRoundData();
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (round.answer <= 0n) throw new Error("Feed BRL/USD retornou resposta não positiva");
    if (round.updatedAt === 0n || round.updatedAt > now || now - round.updatedAt > 3600n) {
      throw new Error(`Feed BRL/USD stale: updatedAt=${round.updatedAt} now=${now}`);
    }
    return { num: BigInt(round.answer), den: 10n ** BigInt(decimals) };
  }
  const manual = process.env.BRLA_USD_RATE?.trim();
  if (!manual) throw new Error("Configure CHAINLINK_BRL_USD_FEED ou BRLA_USD_RATE (BRL por 1 USD)");
  const rate = Number(manual);
  if (!isFinite(rate) || rate <= 0) throw new Error(`BRLA_USD_RATE inválido: ${manual}`);
  return { num: BigInt(Math.round(rate * 1e8)), den: 100000000n };
}

/**
 * Ratio BRLA (CAS base por BRLA base, ambos 18 dec) derivado do ratio USDC
 * on-chain: casPerBrla = (usdcNum/usdcDen/1e12) / brlPerUsd.
 *   brlaNum = usdcNum * brlDen
 *   brlaDen = usdcDen * 1e12 * brlNum
 */
function deriveBrlaRatio(usdcNum: bigint, usdcDen: bigint, brlNum: bigint, brlDen: bigint) {
  return { num: usdcNum * brlDen, den: usdcDen * 10n ** 12n * brlNum };
}

async function main(): Promise<void> {
  if (network.config.chainId !== 137) throw new Error("This script only runs on Polygon mainnet (chainId 137)");
  const [signer] = await ethers.getSigners();
  const swap = new ethers.Contract(DIAMOND, SWAP_ABI, signer);

  // 1. Garante o token BRLA configurado (owner).
  let configured = ethers.ZeroAddress;
  try { configured = await swap.getBRLAToken(); } catch { /* seletor ausente = facet antigo */ }
  if (configured === ethers.ZeroAddress) {
    if (!ethers.isAddress(BRLA_TOKEN)) throw new Error(`BRLA_TOKEN_ADDRESS inválido: ${BRLA_TOKEN}`);
    await swap.setBRLAToken.staticCall(BRLA_TOKEN);
    const tx = await swap.setBRLAToken(BRLA_TOKEN);
    await tx.wait();
    log("info", "brla_token_configured", `brlaToken=${BRLA_TOKEN} tx=${tx.hash}`);
  } else {
    log("info", "brla_token_already_set", `brlaToken=${configured}`);
  }

  // 2. Deriva ratios BRLA do USDC on-chain (proporcional ao valor em USD).
  const [usdcBuyNum, usdcBuyDen] = await swap.getRatioUSDC();
  const [usdcSellNum, usdcSellDen] = await swap.getRatioUSDCSell();
  if (usdcBuyNum === 0n || usdcSellNum === 0n) throw new Error("Ratios USDC não configurados on-chain");
  const brl = await getBrlPerUsd(signer);
  const buy = deriveBrlaRatio(usdcBuyNum, usdcBuyDen, brl.num, brl.den);
  const sell = deriveBrlaRatio(usdcSellNum, usdcSellDen, brl.num, brl.den);

  // Spread normal: buy <= sell (CAS por BRLA).
  if (buy.num * sell.den > sell.num * buy.den) throw new Error("Spread BRLA derivado invertido");
  const humanBuy = Number(buy.num) / Number(buy.den);
  const humanSell = Number(sell.num) / Number(sell.den);
  log("info", "brla_ratios_derived", `buy=${humanBuy.toFixed(4)} sell=${humanSell.toFixed(4)} CAS/BRLA brlUsd=${Number(brl.num) / Number(brl.den)}`);

  // 3. Publica atomicamente via setAllSwapRatiosV2, preservando POL/USDC.
  const [polBuyNum, polBuyDen] = await swap.getRatio();
  const [polSellNum, polSellDen] = await swap.getRatioSell();
  const args = [
    polBuyNum, polBuyDen, usdcBuyNum, usdcBuyDen, buy.num, buy.den,
    polSellNum, polSellDen, usdcSellNum, usdcSellDen, sell.num, sell.den,
  ];
  await swap.setAllSwapRatiosV2.staticCall(...args);
  const tx = await swap.setAllSwapRatiosV2(...args);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error(`setAllSwapRatiosV2 falhou: ${tx.hash}`);
  log("info", "ratios_published", `tx=${tx.hash}`);

  // 4. Verificação pós-publicação.
  const [bNum, bDen] = await swap.getRatioBRLA();
  const [sNum, sDen] = await swap.getRatioBRLASell();
  if (bNum !== buy.num || bDen !== buy.den || sNum !== sell.num || sDen !== sell.den) {
    throw new Error("Verificação pós-publicação divergiu dos valores enviados");
  }
  log("info", "verified", `brlaBuy=${bNum}/${bDen} brlaSell=${sNum}/${sDen}`);
}

main().catch((error) => {
  log("error", "configuration_failed", `message=${error.shortMessage ?? error.message}`);
  process.exitCode = 1;
});
