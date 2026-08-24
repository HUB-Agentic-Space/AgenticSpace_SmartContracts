import { ethers } from "hardhat";

async function main() {
  const [signer] = await ethers.getSigners();
  const diamondAddress = process.env.DIAMOND_ADDRESS;
  if (!diamondAddress) throw new Error("DIAMOND_ADDRESS not set");

  console.log(`Diamond: ${diamondAddress}`);
  console.log(`Caller: ${signer.address}`);

  const swap = await ethers.getContractAt("ICASSwapUSDCPOL", diamondAddress);

  // 17 CAS = 1 POL
  const numerator = 17n;
  const denominator = 1n;

  console.log(`🔍 Simulating setSwapRatio(${numerator.toString()}, ${denominator.toString()})...`);
  try {
    await swap.connect(signer).setSwapRatio.staticCall(numerator, denominator);
    console.log("   Simulation passed");
  } catch (e: any) {
    console.error("   Simulation reverted:", e.reason ?? e.message);
    if (e.data) console.error("   Revert data:", e.data);
    throw e;
  }

  console.log("📝 Setting POL ratio...");
  const tx = await swap.connect(signer).setSwapRatio(numerator, denominator);
  console.log(`   TX hash: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`✅ Confirmed, gas used: ${receipt!.gasUsed}`);

  const ratio = await swap.getRatio();
  console.log(`\ngetRatio: ${ratio[0].toString()}/${ratio[1].toString()}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Failed:", error);
    process.exit(1);
  });
