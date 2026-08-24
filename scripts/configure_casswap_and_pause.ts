import { ethers } from "hardhat";

const AGGREGATOR_ABI = [
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
];

const SWAP_ABI = [
  "function setSwapRatio(uint256 numerator, uint256 denominator)",
  "function setSwapRatioUSDC(uint256 numerator, uint256 denominator)",
  "function getRatio() view returns (uint256 numerator, uint256 denominator)",
  "function getRatioUSDC() view returns (uint256 numerator, uint256 denominator)",
  "function isSwapPaused() view returns (bool)",
];

const PAUSE_ABI = ["function pauseSwap()"];

const OWNER_ABI = ["function owner() view returns (address)"];

function bn(v: string | number | bigint): bigint {
  return BigInt(v);
}

async function main() {
  const [signer] = await ethers.getSigners();
  const diamondAddress = process.env.DIAMOND_ADDRESS;
  const chainlinkPolUsd = process.env.CHAINLINK_POL_USD_FEED;

  if (!diamondAddress) throw new Error("DIAMOND_ADDRESS not set");
  if (!chainlinkPolUsd) throw new Error("CHAINLINK_POL_USD_FEED not set");

  console.log(`Diamond: ${diamondAddress}`);
  console.log(`Signer:  ${signer.address}`);

  const owner = await new ethers.Contract(diamondAddress, OWNER_ABI, signer).owner();
  console.log(`Owner:   ${owner}`);

  // 1) Fetch live POL/USD (USDC) price from Chainlink
  const feed = new ethers.Contract(ethers.getAddress(chainlinkPolUsd.toLowerCase()), AGGREGATOR_ABI, signer);
  const decimals = Number(await feed.decimals());
  const round = await feed.latestRoundData();
  const answer = BigInt(round.answer);
  const updatedAt = Number(round.updatedAt);

  if (answer <= 0n) throw new Error("Invalid Chainlink answer");
  const latestBlock = await ethers.provider.getBlock("latest");
  const age = latestBlock!.timestamp - updatedAt;
  if (age > 3600) throw new Error(`Chainlink price is stale: ${age}s old`);

  // Convert to USDC per POL (6 decimals)
  const polUsdcPrice = (answer * 1_000_000n) / 10n ** BigInt(decimals);
  const polUsdcFloat = Number(polUsdcPrice) / 1_000_000;
  console.log(`\nChainlink POL/USD price: 1 POL = ${polUsdcFloat} USDC`);

  // 2) Compute ratios for: 1 CAS = 0.0001 USDC
  // 1 USDC = 10_000 CAS
  // setSwapRatioUSDC is CAS per USDC (base units / base units)
  const usdcPerCas = 100n; // 0.0001 USDC = 100 USDC units
  const usdcPerFull = 1_000_000n; // 1 USDC in base units
  const casPerUsdcHuman = usdcPerFull / usdcPerCas; // 10_000 CAS per 1 USDC human
  const ratioUsdcNum = casPerUsdcHuman * 10n ** 12n; // 10_000 * 10^12 = 10^16
  const ratioUsdcDen = 1n;

  // setSwapRatio is CAS per POL
  // 1 POL = polUsdcPrice USDC (6 dec) => 1 POL = (polUsdcPrice * 10_000 / 1e6) CAS
  const ratioPolNum = polUsdcPrice * 10_000n;
  const ratioPolDen = 1_000_000n;

  const polPerCas = Number(ratioPolDen) / Number(ratioPolNum);
  console.log(`\nComputed ratios:`);
  console.log(`  1 CAS = ${usdcPerCas} USDC units  = 0.0001 USDC`);
  console.log(`  1 USDC = ${casPerUsdcHuman} CAS`);
  console.log(`  1 CAS ≈ ${polPerCas.toExponential(6)} POL`);
  console.log(`  setSwapRatioUSDC(${ratioUsdcNum}, ${ratioUsdcDen})`);
  console.log(`  setSwapRatio(${ratioPolNum}, ${ratioPolDen})`);

  if (signer.address.toLowerCase() !== owner.toLowerCase()) {
    console.error("\n❌ Signer is not the Diamond owner. Set POLYGON_PRIVATE_KEY to the owner key and rerun.");
    process.exit(1);
  }

  const swap = new ethers.Contract(diamondAddress, SWAP_ABI, signer);
  const pause = new ethers.Contract(diamondAddress, PAUSE_ABI, signer);

  console.log("\n🔍 Simulating setSwapRatioUSDC...");
  await swap.setSwapRatioUSDC.staticCall(ratioUsdcNum, ratioUsdcDen);
  console.log("   Simulation passed");

  console.log("🔍 Simulating setSwapRatio...");
  await swap.setSwapRatio.staticCall(ratioPolNum, ratioPolDen);
  console.log("   Simulation passed");

  console.log("🔍 Simulating pauseSwap...");
  await pause.pauseSwap.staticCall();
  console.log("   Simulation passed");

  console.log("\n📝 Sending setSwapRatioUSDC...");
  const txUsdc = await swap.setSwapRatioUSDC(ratioUsdcNum, ratioUsdcDen);
  const receiptUsdc = await txUsdc.wait();
  console.log(`   TX: ${txUsdc.hash}, gas used: ${receiptUsdc!.gasUsed}`);

  console.log("📝 Sending setSwapRatio...");
  const txPol = await swap.setSwapRatio(ratioPolNum, ratioPolDen);
  const receiptPol = await txPol.wait();
  console.log(`   TX: ${txPol.hash}, gas used: ${receiptPol!.gasUsed}`);

  console.log("📝 Sending pauseSwap...");
  const txPause = await pause.pauseSwap();
  const receiptPause = await txPause.wait();
  console.log(`   TX: ${txPause.hash}, gas used: ${receiptPause!.gasUsed}`);

  const [numPol, denPol] = await swap.getRatio();
  const [numUsdc, denUsdc] = await swap.getRatioUSDC();
  const paused = await swap.isSwapPaused();

  console.log("\n✅ Final state");
  console.log(`  getRatio:    ${numPol}/${denPol}`);
  console.log(`  getRatioUSDC: ${numUsdc}/${denUsdc}`);
  console.log(`  isSwapPaused: ${paused}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("❌ Failed:", e.reason ?? e.message ?? e);
    process.exit(1);
  });
