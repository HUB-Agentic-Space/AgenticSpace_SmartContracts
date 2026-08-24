import { ethers } from "hardhat";
import dotenv from "dotenv";
import { resolve } from "path";

dotenv.config({ path: resolve(__dirname, "..", ".env") });

/**
 * Sets asymmetric buy/sell ratios on the Diamond CASSwap facet.
 *
 * Buy ratio:  1 CAS = 0.0006 POL  →  1 POL = 1666.67 CAS  (5000/3)
 * Sell ratio: 1 CAS = 0.0005 POL  →  1 POL = 2000.00 CAS  (2000/1)
 *
 * Spread = 16.67% (swap keeps the difference on every round-trip)
 *
 * The sell ratio can be adjusted via SELL_RATIO_NUM / SELL_RATIO_DEN env vars.
 *
 * Uso: npx hardhat run scripts/set_asymmetric_ratios.ts --network polygon
 */

const SWAP_ABI = [
  "function setSwapRatio(uint256,uint256) external",
  "function setSwapRatioUSDC(uint256,uint256) external",
  "function setSwapRatioSell(uint256,uint256) external",
  "function setSwapRatioUSDCSell(uint256,uint256) external",
  "function getRatio() view returns (uint256,uint256)",
  "function getRatioUSDC() view returns (uint256,uint256)",
  "function getRatioSell() view returns (uint256,uint256)",
  "function getRatioUSDCSell() view returns (uint256,uint256)",
  "function isSwapPaused() view returns (bool)",
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

  const swap = new ethers.Contract(diamondAddr, SWAP_ABI, relayer);

  // Buy ratio: 1 POL = 1666.67 CAS (5000/3) — same as before
  const buyNum = ethers.parseEther("5000");
  const buyDen = ethers.parseEther("3");

  // Sell ratio: 1 POL = 2000 CAS (user gets less POL when selling CAS)
  // Override via env vars if needed
  const sellNum = ethers.parseEther(process.env.SELL_RATIO_NUM || "2000");
  const sellDen = ethers.parseEther(process.env.SELL_RATIO_DEN || "1");

  // Get Chainlink POL/USD for proportional USDC ratios
  const chainlink = new ethers.Contract(chainlinkFeed, CHAINLINK_ABI, provider);
  const [, polUsdPrice] = await chainlink.latestRoundData();
  const polUsdcPrice6 = Number(polUsdPrice) / 1e8; // Chainlink uses 8 decimals

  // USDC buy ratio: proportional to POL buy ratio
  const casPerPolBuy = Number(buyNum) / Number(buyDen);
  const casPerUsdcBuy = (casPerPolBuy * 1_000_000) / polUsdcPrice6;
  const usdcBuyNum = ethers.parseUnits(casPerUsdcBuy.toFixed(12), 12);
  const usdcBuyDen = 1n;

  // USDC sell ratio: proportional to POL sell ratio
  const casPerPolSell = Number(sellNum) / Number(sellDen);
  const casPerUsdcSell = (casPerPolSell * 1_000_000) / polUsdcPrice6;
  const usdcSellNum = ethers.parseUnits(casPerUsdcSell.toFixed(12), 12);
  const usdcSellDen = 1n;

  console.log("\n============================================================");
  console.log("  Set Asymmetric Swap Ratios");
  console.log("============================================================");
  console.log(`  POL/USD (Chainlink): $${polUsdcPrice6.toFixed(6)}`);
  console.log(`\n  Buy  (POL→CAS): 1 POL = ${casPerPolBuy.toFixed(2)} CAS  (1 CAS = ${(1/casPerPolBuy).toFixed(8)} POL)`);
  console.log(`  Sell (CAS→POL): 1 POL = ${casPerPolSell.toFixed(2)} CAS  (1 CAS = ${(1/casPerPolSell).toFixed(8)} POL)`);
  console.log(`  Spread: ${((casPerPolSell/casPerPolBuy - 1) * 100).toFixed(2)}%`);
  console.log(`\n  Buy  (USDC→CAS): 1 USDC = ${casPerUsdcBuy.toFixed(2)} CAS`);
  console.log(`  Sell (CAS→USDC): 1 USDC = ${casPerUsdcSell.toFixed(2)} CAS`);

  // Check current state
  const [curBuyNum, curBuyDen] = await swap.getRatio();
  const [curSellNum, curSellDen] = await swap.getRatioSell();
  console.log(`\n  Current buy:  ${curBuyNum}/${curBuyDen}`);
  console.log(`  Current sell: ${curSellNum}/${curSellDen}`);

  // Set buy ratio if different
  if (curBuyNum !== buyNum || curBuyDen !== buyDen) {
    console.log("\n  Setting buy POL ratio...");
    const tx = await swap.setSwapRatio(buyNum, buyDen);
    console.log(`  TX: ${tx.hash}`);
    await tx.wait();
  }

  // Set sell ratio if different
  if (curSellNum !== sellNum || curSellDen !== sellDen) {
    console.log("  Setting sell POL ratio...");
    const tx = await swap.setSwapRatioSell(sellNum, sellDen);
    console.log(`  TX: ${tx.hash}`);
    await tx.wait();
  }

  // Set USDC buy ratio if different
  const [curUsdcBuyNum] = await swap.getRatioUSDC();
  if (curUsdcBuyNum !== usdcBuyNum) {
    console.log("  Setting buy USDC ratio...");
    const tx = await swap.setSwapRatioUSDC(usdcBuyNum, usdcBuyDen);
    console.log(`  TX: ${tx.hash}`);
    await tx.wait();
  }

  // Set USDC sell ratio if different
  const [curUsdcSellNum] = await swap.getRatioUSDCSell();
  if (curUsdcSellNum !== usdcSellNum) {
    console.log("  Setting sell USDC ratio...");
    const tx = await swap.setSwapRatioUSDCSell(usdcSellNum, usdcSellDen);
    console.log(`  TX: ${tx.hash}`);
    await tx.wait();
  }

  // Verify
  const [finalBuyNum, finalBuyDen] = await swap.getRatio();
  const [finalSellNum, finalSellDen] = await swap.getRatioSell();
  console.log("\n  ✅ Final state:");
  console.log(`     Buy:  ${finalBuyNum}/${finalBuyDen}  (1 POL = ${(Number(finalBuyNum)/Number(finalBuyDen)).toFixed(2)} CAS)`);
  console.log(`     Sell: ${finalSellNum}/${finalSellDen}  (1 POL = ${(Number(finalSellNum)/Number(finalSellDen)).toFixed(2)} CAS)`);
  console.log("============================================================\n");
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
