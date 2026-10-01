import "dotenv/config";
import { ethers } from "hardhat";
import { planUsdcSequentialUpdate, ratioDiffBps, usdcNumFromPolRatio } from "./utils/cas_market_envelope";

const SCRIPT = "calibrate_casswap_usdc_pol";

function log(level: string, message: string, params: Record<string, unknown> = {}) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const extra = Object.keys(params).length ? ` - ${JSON.stringify(params)}` : "";
  console.log(`[${ts}] [${SCRIPT}] ${level} ${message}${extra}`);
}

const humanCasPerUsdc = (num: bigint, den: bigint) => (Number(num) / Number(den)) / 1e12;

const SWAP_ABI = [
  "function setSwapRatioUSDC(uint256 numerator, uint256 denominator)",
  "function setSwapRatioUSDCSell(uint256 numerator, uint256 denominator)",
  "function getRatio() view returns (uint256 numerator, uint256 denominator)",
  "function getRatioSell() view returns (uint256 numerator, uint256 denominator)",
  "function getRatioUSDC() view returns (uint256 numerator, uint256 denominator)",
  "function getRatioUSDCSell() view returns (uint256 numerator, uint256 denominator)",
  "function isSwapPaused() view returns (bool)",
  "function owner() view returns (address)",
  "function hasRole(bytes32,address) view returns (bool)",
];
const FEED_ABI = [
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
];

async function main() {
  const diamondAddress = process.env.DIAMOND_ADDRESS;
  const feedAddress = process.env.CHAINLINK_POL_USD_FEED;
  if (!diamondAddress) throw new Error("DIAMOND_ADDRESS not set");
  if (!feedAddress) throw new Error("CHAINLINK_POL_USD_FEED not set");

  const provider = ethers.provider;
  const network = await provider.getNetwork();
  if (network.chainId !== 137n) throw new Error(`Expected Polygon chainId 137, got ${network.chainId}`);

  const dryRun = (process.env.DRY_RUN || "true").toLowerCase() !== "false";
  log("INFO", "start", { diamond: diamondAddress, dryRun });

  const swap = new ethers.Contract(diamondAddress, SWAP_ABI, provider);
  const block = await provider.getBlock("latest");
  if (!block) throw new Error("Reference block unavailable");
  const opts = { blockTag: block.number };

  // POL buy/sell ratios on-chain are the pricing authority: USDC must stay
  // consistent with them (casPerUsdc = casPerPol / polUsd). No POL ratio is
  // touched here — only the two USDC ratios are recalibrated.
  const [polBuy, polSell, usdcBuy, usdcSell, paused] = await Promise.all([
    swap.getRatio(opts), swap.getRatioSell(opts),
    swap.getRatioUSDC(opts), swap.getRatioUSDCSell(opts),
    swap.isSwapPaused(opts),
  ]);
  log("INFO", "on-chain state", {
    block: block.number,
    casPerPolBuy: Number(ethers.formatUnits(polBuy[0], 18)) / Number(ethers.formatUnits(polBuy[1], 18)),
    casPerPolSell: Number(ethers.formatUnits(polSell[0], 18)) / Number(ethers.formatUnits(polSell[1], 18)),
    casPerUsdcBuy: humanCasPerUsdc(usdcBuy[0], usdcBuy[1]),
    casPerUsdcSell: humanCasPerUsdc(usdcSell[0], usdcSell[1]),
    paused,
  });

  const feed = new ethers.Contract(ethers.getAddress(feedAddress.toLowerCase()), FEED_ABI, provider);
  const [round, feedDecimals] = await Promise.all([feed.latestRoundData(opts), feed.decimals(opts)]);
  const maxAge = Number(process.env.CAS_ORACLE_MAX_AGE_SECONDS || "3600");
  if (!Number.isFinite(maxAge) || maxAge <= 0 || round[1] <= 0n || round[3] === 0n ||
    Number(round[3]) > block.timestamp || block.timestamp - Number(round[3]) > maxAge)
    throw new Error("POL/USD feed invalid or stale; calibration aborted");
  const polUsd = Number(ethers.formatUnits(round[1], Number(feedDecimals)));
  log("INFO", "chainlink POL/USD", { polUsd, updatedAt: Number(round[3]), feedDecimals: Number(feedDecimals) });

  const newBuy: [bigint, bigint] = [usdcNumFromPolRatio(polBuy[0], polBuy[1], round[1], Number(feedDecimals)), 1n];
  const newSell: [bigint, bigint] = [usdcNumFromPolRatio(polSell[0], polSell[1], round[1], Number(feedDecimals)), 1n];
  const order = planUsdcSequentialUpdate(
    [usdcBuy[0], usdcBuy[1]], [usdcSell[0], usdcSell[1]], newBuy, newSell);
  if (!order) throw new Error("Target USDC ratios are a reverse spread; refusing to publish");
  log("INFO", "target USDC ratios", {
    casPerUsdcBuy: humanCasPerUsdc(newBuy[0], newBuy[1]),
    casPerUsdcSell: humanCasPerUsdc(newSell[0], newSell[1]),
    impliedPolUsdBuy: humanCasPerUsdc(usdcBuy[0], usdcBuy[1]) > 0
      ? (Number(polBuy[0]) / Number(polBuy[1])) / humanCasPerUsdc(newBuy[0], newBuy[1]) : 0,
    order: order.join("->"),
  });

  const diffBps = {
    buy: ratioDiffBps([usdcBuy[0], usdcBuy[1]], newBuy),
    sell: ratioDiffBps([usdcSell[0], usdcSell[1]], newSell),
  };
  const minUpdateBps = Number(process.env.MIN_UPDATE_BPS || "0");
  if (!Number.isFinite(minUpdateBps) || minUpdateBps < 0 || minUpdateBps > 10000)
    throw new Error("Invalid MIN_UPDATE_BPS");
  log("INFO", "change vs on-chain", { buyBps: diffBps.buy.toString(), sellBps: diffBps.sell.toString(), minUpdateBps });
  if (diffBps.buy <= BigInt(minUpdateBps) && diffBps.sell <= BigInt(minUpdateBps)) {
    log("INFO", "already calibrated within threshold; nothing to publish");
    return;
  }
  if (dryRun) {
    log("INFO", "DRY_RUN — set DRY_RUN=false to publish", { planned: order });
    return;
  }
  if (paused) throw new Error("Swap is paused; ratio setters are whenNotPaused. Use the reviewed governance procedure");

  const signerKey = process.env.CAS_RATIO_SIGNER_PRIVATE_KEY || process.env.RELAYER_PRIVATE_KEY;
  const signer = signerKey ? new ethers.Wallet(signerKey, provider) : (await ethers.getSigners())[0];
  if (!signer) throw new Error("No signer configured (CAS_RATIO_SIGNER_PRIVATE_KEY / RELAYER_PRIVATE_KEY / hardhat account)");
  const [owner, allowed] = await Promise.all([
    swap.owner(opts), swap.hasRole(ethers.id("RATIO_SETTER_ROLE"), signer.address, opts)]);
  if (!allowed && owner.toLowerCase() !== signer.address.toLowerCase())
    throw new Error(`Signer ${signer.address} lacks RATIO_SETTER_ROLE and is not the owner`);

  const latest = await provider.getBlock("latest");
  if (!latest || latest.timestamp - block.timestamp > 60) throw new Error("Quote expired before publication");

  const writer = swap.connect(signer) as ethers.Contract;
  for (const step of order) {
    const [num, den] = step === "buy" ? newBuy : newSell;
    const fn = step === "buy" ? "setSwapRatioUSDC" : "setSwapRatioUSDCSell";
    await writer[fn].staticCall(num, den);
    const tx = await writer[fn](num, den);
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) throw new Error(`${fn} transaction failed`);
    log("INFO", `${fn} confirmed`, { tx: tx.hash, block: receipt.blockNumber });
  }

  const [vBuy, vSell] = await Promise.all([swap.getRatioUSDC(), swap.getRatioUSDCSell()]);
  if (vBuy[0] !== newBuy[0] || vBuy[1] !== newBuy[1] || vSell[0] !== newSell[0] || vSell[1] !== newSell[1])
    throw new Error("On-chain USDC ratios differ from target after update; inspect for a competing publisher");
  log("INFO", "calibration verified on-chain", {
    casPerUsdcBuy: humanCasPerUsdc(vBuy[0], vBuy[1]),
    casPerUsdcSell: humanCasPerUsdc(vSell[0], vSell[1]),
  });
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    log("ERROR", "calibration failed", { error: e.shortMessage || e.reason || e.message || String(e) });
    process.exit(1);
  });
