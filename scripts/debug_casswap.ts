import { ethers } from "hardhat";

async function main() {
  const [owner, user1] = await ethers.getSigners();

  // Mock tokens
  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const casToken = await MockERC20.deploy("CAS Token", "CAS", 18);
  const usdcToken = await MockERC20.deploy("USDC Token", "USDC", 6);
  await casToken.waitForDeployment();
  await usdcToken.waitForDeployment();
  const casAddr = await casToken.getAddress();
  const usdcAddr = await usdcToken.getAddress();

  const SwapFacet = await ethers.getContractFactory("CASSwapUSDCPOLFacet");
  const facet = await SwapFacet.deploy();
  await facet.waitForDeployment();
  const facetAddr = await facet.getAddress();
  console.log("Facet address:", facetAddr);

  const baseSlot = ethers.keccak256(ethers.toUtf8Bytes("agentic.space.diamond.storage"));
  const ownerSlot = "0x" + (BigInt(baseSlot) + 4n).toString(16).padStart(64, "0");
  console.log("owner slot:", ownerSlot);

  await ethers.provider.send("hardhat_setStorageAt", [
    facetAddr,
    ownerSlot,
    ethers.zeroPadValue(owner.address, 32),
  ]);

  try {
    const tx = await facet.initCASSwapUSDCPOL(casAddr, usdcAddr);
    await tx.wait();
    console.log("init ok");
  } catch (e: any) {
    console.error("init failed:", e.message);
    if (e.data) console.error("revert data:", e.data);
  }

  try {
    const paused = await facet.isSwapPaused();
    console.log("paused:", paused);
  } catch (e: any) {
    console.error("isSwapPaused failed:", e.message);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
