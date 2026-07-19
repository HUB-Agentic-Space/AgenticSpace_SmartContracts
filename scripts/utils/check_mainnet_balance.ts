import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`POL Balance: ${ethers.formatEther(balance)} POL`);

  const network = await ethers.provider.getNetwork();
  console.log(`Network: chainId=${network.chainId}`);

  const gasPrice = await ethers.provider.getFeeData();
  console.log(`Gas Price: ${ethers.formatUnits(gasPrice.gasPrice || 0n, "gwei")} gwei`);

  const estimatedGasDeploy = 3000000n;
  const estimatedCost = (gasPrice.gasPrice || 0n) * estimatedGasDeploy;
  console.log(`Estimated deploy cost (2 contracts, ~3M gas): ${ethers.formatEther(estimatedCost)} POL`);
  console.log(`Sufficient: ${balance > estimatedCost ? "YES" : "NO"}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
