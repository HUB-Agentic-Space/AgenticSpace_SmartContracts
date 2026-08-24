import { ethers } from "hardhat";
import dotenv from "dotenv";
import { resolve } from "path";

dotenv.config({ path: resolve(__dirname, "..", ".env") });

async function main(): Promise<void> {
  const diamondAddr = process.env.DIAMOND_ADDRESS!;
  const relayerKey = process.env.RELAYER_PRIVATE_KEY!;

  const [defaultSigner] = await ethers.getSigners();
  const provider = defaultSigner.provider!;
  const relayer = new ethers.Wallet(relayerKey, provider);

  const swap = new ethers.Contract(diamondAddr, [
    "function unpauseSwap() external",
    "function isSwapPaused() view returns (bool)",
    "function owner() view returns (address)",
  ], relayer);

  console.log("paused:", await swap.isSwapPaused());
  console.log("owner:", await swap.owner());
  console.log("relayer:", relayer.address);

  try {
    await swap.unpauseSwap.staticCall();
    console.log("staticCall OK — would succeed");
  } catch (e: any) {
    console.log("REVERT:", e.message);
    // Try to decode custom error
    if (e.data) {
      console.log("revert data:", e.data);
    }
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
