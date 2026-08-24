import { ethers } from "hardhat";
import dotenv from "dotenv";

dotenv.config();

/**
 * Grant RATIO_SETTER_ROLE to the trader address on the Diamond.
 * The new CASSwapUSDCPOLFacet checks this role for setSwapRatio/setSwapRatioUSDC.
 *
 * Usage:
 *   TRADER_ADDRESS=0x... npx hardhat run scripts/grant_trader_ratio_setter.ts --network polygon
 */
async function main() {
  const [signer] = await ethers.getSigners();
  const diamondAddress = process.env.DIAMOND_ADDRESS || "";
  const traderAddress = process.env.TRADER_ADDRESS || "";

  if (!diamondAddress) throw new Error("DIAMOND_ADDRESS not set");
  if (!traderAddress) throw new Error("TRADER_ADDRESS not set");

  const accessControl = await ethers.getContractAt("AccessControlFacet", diamondAddress);

  // keccak256("RATIO_SETTER_ROLE") — must match CASSwapUSDCPOLFacet
  const RATIO_SETTER_ROLE = ethers.id("RATIO_SETTER_ROLE");

  console.log(`Signer:          ${signer.address}`);
  console.log(`Diamond:         ${diamondAddress}`);
  console.log(`Trader:          ${traderAddress}`);
  console.log(`Role hash:       ${RATIO_SETTER_ROLE}`);

  const ownership = await ethers.getContractAt("OwnershipFacet", diamondAddress);
  const owner = await ownership.owner();
  console.log(`Diamond owner:   ${owner}`);

  try {
    const registrarRole = await accessControl.REGISTRAR_ROLE();
    console.log(`REGISTRAR_ROLE:  ${registrarRole}`);
  } catch (e: any) {
    console.error("AccessControlFacet.REGISTRAR_ROLE() reverted:", e.reason || e.message);
    throw e;
  }

  let already = false;
  try {
    already = await accessControl.hasRole(RATIO_SETTER_ROLE, traderAddress);
    console.log(`hasRole check:   ${already}`);
  } catch (e: any) {
    console.error("AccessControlFacet.hasRole() reverted:", e.reason || e.message);
    throw e;
  }

  if (already) {
    console.log("Trader already has RATIO_SETTER_ROLE");
    return;
  }

  const tx = await accessControl.grantRole(RATIO_SETTER_ROLE, traderAddress);
  console.log(`TX sent: ${tx.hash}`);
  await tx.wait();

  const confirmed = await accessControl.hasRole(RATIO_SETTER_ROLE, traderAddress);
  console.log(`Has RATIO_SETTER_ROLE: ${confirmed}`);
}

main().catch((error: any) => {
  console.error(error?.reason || error?.message || error);
  process.exit(1);
});
