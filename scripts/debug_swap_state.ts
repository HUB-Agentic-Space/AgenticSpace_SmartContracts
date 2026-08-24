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
    "function isSwapPaused() view returns (bool)",
    "function getRatio() view returns (uint256,uint256)",
    "function getRatioSell() view returns (uint256,uint256)",
    "function RATIO_SETTER_ROLE() view returns (bytes32)",
    "function hasRole(bytes32,address) view returns (bool)",
    "function owner() view returns (address)",
  ], relayer);

  const paused = await swap.isSwapPaused();
  const role = await swap.RATIO_SETTER_ROLE();
  const hasRole = await swap.hasRole(role, relayer.address);
  const owner = await swap.owner();

  console.log("Paused:", paused);
  console.log("Relayer has RATIO_SETTER_ROLE:", hasRole);
  console.log("Diamond owner:", owner);
  console.log("Relayer:", relayer.address);
  console.log("Is owner:", owner === relayer.address);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
