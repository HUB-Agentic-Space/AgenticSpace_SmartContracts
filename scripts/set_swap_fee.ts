import { ethers } from "hardhat";
import dotenv from "dotenv";
import { resolve } from "path";

dotenv.config({ path: resolve(__dirname, "..", ".env") });

/**
 * Aumenta o swapFeeBps no Diamond para criar spread imediato.
 * Usa RELAYER_PRIVATE_KEY (Diamond owner).
 *
 * Uso: npx hardhat run scripts/set_swap_fee.ts --network polygon
 */

const ABI = [
  "function setSwapFeeBps(uint256 feeBps) external",
  "function getSwapFeeBps() external view returns (uint256)",
  "function isSwapPaused() external view returns (bool)",
];

async function main(): Promise<void> {
  const [defaultSigner] = await ethers.getSigners();
  const provider = defaultSigner.provider!;
  const diamondAddr = process.env.DIAMOND_ADDRESS!;
  const relayerKey = process.env.RELAYER_PRIVATE_KEY!;

  const relayer = new ethers.Wallet(relayerKey, provider);
  const diamond = new ethers.Contract(diamondAddr, ABI, relayer);

  const feeArg = process.env.SWAP_FEE_BPS || "300"; // default 3%
  const newFee = BigInt(feeArg);

  console.log(`\n  Diamond: ${diamondAddr}`);
  console.log(`  Relayer: ${relayer.address}`);
  console.log(`  New fee: ${newFee} bps (${Number(newFee) / 100}%)`);

  const currentFee = await diamond.getSwapFeeBps();
  console.log(`  Current fee: ${currentFee} bps`);

  if (currentFee === newFee) {
    console.log("  Fee already set — nothing to do.");
    return;
  }

  const tx = await diamond.setSwapFeeBps(newFee);
  console.log(`  TX: ${tx.hash}`);
  await tx.wait();

  const confirmed = await diamond.getSwapFeeBps();
  console.log(`  Confirmed fee: ${confirmed} bps (${Number(confirmed) / 100}%)`);
  console.log("\n  ✅ Swap fee updated.");
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
