import { ethers } from "hardhat";
import dotenv from "dotenv";
import { resolve } from "path";

dotenv.config({ path: resolve(__dirname, "..", ".env") });

/**
 * Unpause swap, set asymmetric buy/sell ratios, and verify.
 *
 * Uso: npx hardhat run scripts/unpause_and_set_asymmetric_ratios.ts --network polygon
 */

const ABI = [
  "function unpauseSwap() external",
  "function pauseSwap() external",
  "function isSwapPaused() view returns (bool)",
  "function setSwapRatio(uint256,uint256) external",
  "function setSwapRatioUSDC(uint256,uint256) external",
  "function setSwapRatioSell(uint256,uint256) external",
  "function setSwapRatioUSDCSell(uint256,uint256) external",
  "function getRatio() view returns (uint256,uint256)",
  "function getRatioUSDC() view returns (uint256,uint256)",
  "function getRatioSell() view returns (uint256,uint256)",
  "function getRatioUSDCSell() view returns (uint256,uint256)",
  "function getSwapFeeBps() view returns (uint256)",
];

const CHAINLINK_ABI = [
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
];

async function main(): Promise<void> {
  const diamondAddr = process.env.DIAMOND_ADDRESS!;
  const relayerKey = process.env.RELAYER_PRIVATE_KEY!;
  const chainlinkFeed = process.env.CHAINLINK_POL_USD_FEED!;

  const [defaultSigner] = await ethers.getSigners();
  const provider = defaultSigner.provider!;
  const relayer = new ethers.Wallet(relayerKey, provider);

  const swap = new ethers.Contract(diamondAddr, ABI, relayer);

  // Ratios
  const buyNum = ethers.parseEther("5000");
  const buyDen = ethers.parseEther("3");
  const sellNum = ethers.parseEther(process.env.SELL_RATIO_NUM || "2000");
  const sellDen = ethers.parseEther(process.env.SELL_RATIO_DEN || "1");

  // Chainlink POL/USD
  const chainlink = new ethers.Contract(chainlinkFeed, CHAINLINK_ABI, provider);
  const [, polUsdPrice] = await chainlink.latestRoundData();
  const polUsdcPrice6 = Number(polUsdPrice) / 1e8;

  const casPerPolBuy = Number(buyNum) / Number(buyDen);
  const casPerPolSell = Number(sellNum) / Number(sellDen);
  const casPerUsdcBuy = (casPerPolBuy * 1_000_000) / polUsdcPrice6;
  const casPerUsdcSell = (casPerPolSell * 1_000_000) / polUsdcPrice6;
  const usdcBuyNum = ethers.parseUnits(casPerUsdcBuy.toFixed(12), 12);
  const usdcBuyDen = 1n;
  const usdcSellNum = ethers.parseUnits(casPerUsdcSell.toFixed(12), 12);
  const usdcSellDen = 1n;

  console.log("\n============================================================");
  console.log("  Unpause + Set Asymmetric Ratios");
  console.log("============================================================");
  console.log(`  POL/USD: $${polUsdcPrice6.toFixed(6)}`);
  console.log(`  Buy:  1 POL = ${casPerPolBuy.toFixed(2)} CAS  (1 CAS = ${(1/casPerPolBuy).toFixed(8)} POL)`);
  console.log(`  Sell: 1 POL = ${casPerPolSell.toFixed(2)} CAS  (1 CAS = ${(1/casPerPolSell).toFixed(8)} POL)`);
  console.log(`  Spread: ${((casPerPolSell/casPerPolBuy - 1) * 100).toFixed(2)}%`);

  // Step 1: Unpause
  const paused = await swap.isSwapPaused();
  console.log(`\n  Paused: ${paused}`);
  if (paused) {
    console.log("  Unpausing...");
    const tx = await swap.unpauseSwap();
    console.log(`  TX: ${tx.hash}`);
    await tx.wait();
  }

  // Step 2: Set buy POL ratio
  const [curBuyNum, curBuyDen] = await swap.getRatio();
  if (curBuyNum !== buyNum || curBuyDen !== buyDen) {
    console.log("  Setting buy POL ratio...");
    const tx = await swap.setSwapRatio(buyNum, buyDen);
    console.log(`  TX: ${tx.hash}`);
    await tx.wait();
  }

  // Step 3: Set sell POL ratio
  const [curSellNum, curSellDen] = await swap.getRatioSell();
  if (curSellNum !== sellNum || curSellDen !== sellDen) {
    console.log("  Setting sell POL ratio...");
    const tx = await swap.setSwapRatioSell(sellNum, sellDen);
    console.log(`  TX: ${tx.hash}`);
    await tx.wait();
  }

  // Step 4: Set buy USDC ratio
  const [curUsdcBuyNum] = await swap.getRatioUSDC();
  if (curUsdcBuyNum !== usdcBuyNum) {
    console.log("  Setting buy USDC ratio...");
    const tx = await swap.setSwapRatioUSDC(usdcBuyNum, usdcBuyDen);
    console.log(`  TX: ${tx.hash}`);
    await tx.wait();
  }

  // Step 5: Set sell USDC ratio
  const [curUsdcSellNum] = await swap.getRatioUSDCSell();
  if (curUsdcSellNum !== usdcSellNum) {
    console.log("  Setting sell USDC ratio...");
    const tx = await swap.setSwapRatioUSDCSell(usdcSellNum, usdcSellDen);
    console.log(`  TX: ${tx.hash}`);
    await tx.wait();
  }

  // Verify
  const [fBuyNum, fBuyDen] = await swap.getRatio();
  const [fSellNum, fSellDen] = await swap.getRatioSell();
  const fee = await swap.getSwapFeeBps();
  const finalPaused = await swap.isSwapPaused();

  console.log("\n  ✅ Final state:");
  console.log(`     Buy:  ${fBuyNum}/${fBuyDen}  (1 POL = ${(Number(fBuyNum)/Number(fBuyDen)).toFixed(2)} CAS)`);
  console.log(`     Sell: ${fSellNum}/${fSellDen}  (1 POL = ${(Number(fSellNum)/Number(fSellDen)).toFixed(2)} CAS)`);
  console.log(`     Fee:  ${fee} bps (${Number(fee)/100}%)`);
  console.log(`     Paused: ${finalPaused}`);
  console.log("============================================================\n");
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
