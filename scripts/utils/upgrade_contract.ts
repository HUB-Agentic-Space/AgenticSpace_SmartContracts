import { upgrades } from "hardhat";

async function main() {
  const contractName = process.env.UPGRADE_CONTRACT_NAME;
  const proxyAddress = process.env.UPGRADE_PROXY_ADDRESS;

  if (!contractName || !proxyAddress) {
    console.error("Error: Set UPGRADE_CONTRACT_NAME and UPGRADE_PROXY_ADDRESS in .env");
    process.exitCode = 1;
    return;
  }

  console.log(`[upgrade] Upgrading ${contractName} at proxy ${proxyAddress}`);

  const Factory = await ethers.getContractFactory(contractName);
  const upgraded = await upgrades.upgradeProxy(proxyAddress, Factory);

  await upgraded.waitForDeployment();

  const implAddress = await upgrades.erc1967.getImplementationAddress(proxyAddress);
  console.log(`[upgrade] ${contractName} upgraded. New implementation: ${implAddress}`);
  console.log(`[upgrade] Next step: Verify new implementation on Polygonscan`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
