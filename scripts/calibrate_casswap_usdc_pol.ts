import { ethers } from "hardhat";
import http from "http";
import dotenv from "dotenv";
import { resolve } from "path";

dotenv.config({ path: resolve(__dirname, "..", ".env") });

function httpGet(url: string): Promise<string> {
  return new Promise((ok, reject) => {
    http
      .get(url, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => ok(data));
      })
      .on("error", reject);
  });
}

async function main() {
  const [signer] = await ethers.getSigners();
  const diamondAddress = process.env.DIAMOND_ADDRESS;
  const feedAddress = process.env.CHAINLINK_POL_USD_FEED;

  if (!diamondAddress) throw new Error("DIAMOND_ADDRESS not set");
  if (!feedAddress) throw new Error("CHAINLINK_POL_USD_FEED not set");

  const owner = await new ethers.Contract(
    diamondAddress,
    ["function owner() view returns (address)"],
    signer
  ).owner();

  if (signer.address.toLowerCase() !== owner.toLowerCase()) {
    throw new Error("Signer must be the Diamond owner (relayer). Set POLYGON_PRIVATE_KEY accordingly.");
  }

  console.log(`Diamond: ${diamondAddress}`);
  console.log(`Signer/Owner: ${signer.address}`);

  // 1) Último ratio CAS/POL consolidado do backend
  const priceLine = await httpGet("http://127.0.0.1:3460/api/price-line?limit=1");
  const priceData = JSON.parse(priceLine);
  const latest = priceData.data?.[0] as { pair?: string; ratio?: number } | undefined;
  if (!latest || latest.ratio == null) throw new Error("Backend não retornou ratio CAS/POL");
  const casPerPol = Number(latest.ratio);
  console.log(`Backend CAS/POL: ${casPerPol}`);

  // 2) POL/USD (USDC) via Chainlink
  const feed = new ethers.Contract(
    ethers.getAddress(feedAddress.toLowerCase()),
    [
      "function decimals() view returns (uint8)",
      "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
    ],
    signer
  );
  const [decimals, round] = await Promise.all([feed.decimals(), feed.latestRoundData()]);
  const answer = BigInt(round.answer);
  const updatedAt = Number(round.updatedAt);
  const latestBlock = await ethers.provider.getBlock("latest");
  const age = latestBlock!.timestamp - updatedAt;
  if (answer <= 0n) throw new Error("Invalid Chainlink answer");
  if (age > 3600) throw new Error(`Chainlink price is stale: ${age}s old`);

  // USDC por POL em base 6 decimais
  const polUsdcPrice = (answer * 1_000_000n) / 10n ** BigInt(decimals);
  const polUsdcFloat = Number(polUsdcPrice) / 1_000_000;
  console.log(`Chainlink 1 POL = ${polUsdcFloat} USDC`);

  // 3) Deriva CAS/USDC: 1 USDC = casPerPol * 1_000_000 / polUsdcPrice  CAS
  const casPerUsdc = (casPerPol * 1_000_000) / Number(polUsdcPrice);
  console.log(`Computed 1 USDC = ${casPerUsdc} CAS`);

  // 4) Codificar para o contrato
  // CAS/POL: ambos 18 decimais -> num = casPerPol * 1e18, den = 1e18
  const ratioPolNum = ethers.parseEther(casPerPol.toFixed(18));
  const ratioPolDen = ethers.parseEther("1");

  // CAS/USDC: USDC 6 dec, CAS 18 dec -> num = casPerUsdc * 1e12, den = 1
  const ratioUsdcNum = ethers.parseUnits(casPerUsdc.toFixed(12), 12);
  const ratioUsdcDen = 1n;

  console.log(`\nsetSwapRatio(${ratioPolNum}, ${ratioPolDen})`);
  console.log(`setSwapRatioUSDC(${ratioUsdcNum}, ${ratioUsdcDen})`);

  const swapAbi = [
    "function setSwapRatio(uint256 numerator, uint256 denominator)",
    "function setSwapRatioUSDC(uint256 numerator, uint256 denominator)",
    "function getRatio() view returns (uint256 numerator, uint256 denominator)",
    "function getRatioUSDC() view returns (uint256 numerator, uint256 denominator)",
    "function isSwapPaused() view returns (bool)",
  ];
  const pauseAbi = ["function unpauseSwap()", "function pauseSwap()"];

  const swap = new ethers.Contract(diamondAddress, swapAbi, signer);
  const pause = new ethers.Contract(diamondAddress, pauseAbi, signer);

  const pausedBefore = await swap.isSwapPaused();
  console.log(`\nPaused before: ${pausedBefore}`);

  if (pausedBefore) {
    console.log("Unpausing temporarily to set ratios...");
    const txUnpause = await pause.unpauseSwap();
    await txUnpause.wait();
  }

  const txPol = await swap.setSwapRatio(ratioPolNum, ratioPolDen);
  await txPol.wait();
  console.log(`setSwapRatio TX: ${txPol.hash}`);

  const txUsdc = await swap.setSwapRatioUSDC(ratioUsdcNum, ratioUsdcDen);
  await txUsdc.wait();
  console.log(`setSwapRatioUSDC TX: ${txUsdc.hash}`);

  const txPause = await pause.pauseSwap();
  await txPause.wait();
  console.log(`pauseSwap TX: ${txPause.hash}`);

  const [numPol, denPol] = await swap.getRatio();
  const [numUsdc, denUsdc] = await swap.getRatioUSDC();
  console.log(`\nFinal state:`);
  console.log(`  CAS/POL getRatio:    ${numPol}/${denPol}`);
  console.log(`  CAS/USDC getRatioUSDC: ${numUsdc}/${denUsdc}`);
  console.log(`  isSwapPaused: ${await swap.isSwapPaused()}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("❌ Calibration failed:", e.reason ?? e.message ?? e);
    process.exit(1);
  });
