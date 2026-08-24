import { ethers } from "hardhat";
import dotenv from "dotenv";
import { resolve } from "path";

dotenv.config({ path: resolve(__dirname, "..", ".env") });

async function main() {
  const [signer] = await ethers.getSigners();
  const diamondAddress = process.env.DIAMOND_ADDRESS;

  if (!diamondAddress) throw new Error("DIAMOND_ADDRESS not set");

  const owner = await new ethers.Contract(
    diamondAddress,
    ["function owner() view returns (address)"],
    signer
  ).owner();

  if (signer.address.toLowerCase() !== owner.toLowerCase()) {
    throw new Error("Signer must be the Diamond owner. Set POLYGON_PRIVATE_KEY accordingly.");
  }

  console.log(`Diamond: ${diamondAddress}`);
  console.log(`Signer/Owner: ${signer.address}`);

  const governanceAbi = [
    "function unpauseSwap()",
    "function pauseSwap()",
  ];

  const swapAbi = [
    "function isSwapPaused() view returns (bool)",
  ];

  const governance = new ethers.Contract(diamondAddress, governanceAbi, signer);
  const swap = new ethers.Contract(diamondAddress, swapAbi, signer);

  const pausedBefore = await swap.isSwapPaused();
  console.log(`\nPaused before: ${pausedBefore}`);

  if (!pausedBefore) {
    console.log("CASSwap already unpaused — nothing to do.");
    return;
  }

  const tx = await governance.unpauseSwap();
  console.log(`unpauseSwap TX: ${tx.hash}`);
  await tx.wait();

  const pausedAfter = await swap.isSwapPaused();
  console.log(`Paused after: ${pausedAfter}`);
  if (pausedAfter) throw new Error("CASSwap is still paused after unpauseSwap");
  console.log("\nCASSwap unpaused successfully.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("Unpause failed:", e.reason ?? e.message ?? e);
    process.exit(1);
  });
