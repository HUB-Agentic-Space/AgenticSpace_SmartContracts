import { ethers, upgrades } from "hardhat";

async function main() {
  const addr = process.env.CHECK_PROXY_ADDRESS;
  if (!addr) {
    console.error("Set CHECK_PROXY_ADDRESS in .env");
    process.exit(1);
  }

  console.log(`[check-proxy] Checking proxy at ${addr}`);

  // Try ERC1967 implementation slot
  try {
    const implSlot = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
    const implRaw = await ethers.provider.getStorage(addr, implSlot);
    const implAddr = "0x" + implRaw.slice(26);
    console.log(`[check-proxy] ERC1967 implementation: ${implAddr}`);
  } catch (e: any) {
    console.log(`[check-proxy] ERC1967 slot read failed: ${e.message}`);
  }

  // Try calling maxSupply (CASToken)
  try {
    const token = await ethers.getContractAt("CASToken", addr);
    const ms = await token.maxSupply();
    console.log(`[check-proxy] maxSupply: ${ethers.formatEther(ms)}`);
    const name = await token.name();
    console.log(`[check-proxy] name: ${name}`);
    const sym = await token.symbol();
    console.log(`[check-proxy] symbol: ${sym}`);
  } catch (e: any) {
    console.log(`[check-proxy] CASToken call failed: ${e.message}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
