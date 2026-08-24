import { ethers } from "hardhat";
import dotenv from "dotenv";

dotenv.config();

async function main() {
  const diamondAddress = process.env.DIAMOND_ADDRESS;
  if (!diamondAddress) throw new Error("DIAMOND_ADDRESS not set");

  const [signer] = await ethers.getSigners();
  console.log(`Signer:  ${signer.address}`);

  const ownership = await ethers.getContractAt("OwnershipFacet", diamondAddress);
  const owner = await ownership.owner();
  console.log(`Owner:   ${owner}`);

  if (signer.address.toLowerCase() !== owner.toLowerCase()) {
    console.log("Signer is NOT the Diamond owner.");
  } else {
    console.log("Signer IS the Diamond owner.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
