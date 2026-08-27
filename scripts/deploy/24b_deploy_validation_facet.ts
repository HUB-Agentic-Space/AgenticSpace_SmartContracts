import { ethers } from "hardhat";

async function main(): Promise<void> {
  const [deployer] = await ethers.getSigners();
  const Factory = await ethers.getContractFactory("ValidationRegistryFacet", deployer);
  const contract = await Factory.deploy({ gasLimit: 2_000_000n });
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  console.log(`ValidationRegistryFacet deployed at: ${address}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
