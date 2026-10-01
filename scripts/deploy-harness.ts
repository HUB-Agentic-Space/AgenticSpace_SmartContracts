import { ethers } from "hardhat";
async function main() {
  const F = await ethers.getContractFactory("EchidnaCASSwapHarness");
  const h = await F.deploy();
  await h.waitForDeployment();
  console.log("deployed", await h.getAddress());
}
main().catch((e) => { console.log("REVERT:", e.shortMessage ?? e.message); process.exitCode = 1; });
