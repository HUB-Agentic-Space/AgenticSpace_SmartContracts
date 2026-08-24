import { ethers } from "hardhat";

async function main() {
  const diamondAddress = process.env.DIAMOND_ADDRESS;
  if (!diamondAddress) throw new Error("DIAMOND_ADDRESS not set");

  const txHash = process.env.TX_HASH || "0xfab17ca4331e11c266011b2ea0ff434fbdfe0c339fa8ae9800ffb0470d4fdb0c";

  console.log(`Diamond: ${diamondAddress}`);
  console.log(`Checking TX: ${txHash}`);

  const receipt = await ethers.provider.getTransactionReceipt(txHash);
  if (!receipt) {
    console.log("Receipt not found");
    return;
  }
  console.log(`  status: ${receipt.status}`);
  console.log(`  gasUsed: ${receipt.gasUsed.toString()}`);
  console.log(`  logs count: ${receipt.logs.length}`);

  const loupe = await ethers.getContractAt("IDiamondLoupe", diamondAddress);
  console.log("\nLoupe: facet addresses");
  const addresses = await loupe.facetAddresses();
  for (const addr of addresses) {
    const selectors = await loupe.facetFunctionSelectors(addr);
    console.log(`  ${addr}: ${selectors.length} selectors`);
  }

  const swap = await ethers.getContractAt("ICASSwapUSDCPOL", diamondAddress);
  const getRatioSelector = swap.interface.getFunction("getRatio").selector;
  console.log(`\ngetRatio selector: ${getRatioSelector}`);
  const facetForGetRatio = await loupe.facetAddress(getRatioSelector);
  console.log(`facetAddress(getRatio): ${facetForGetRatio}`);

  try {
    const ratio = await swap.getRatio();
    console.log(`getRatio: ${ratio[0].toString()}/${ratio[1].toString()}`);
  } catch (e: any) {
    console.error("getRatio reverted:", e.reason ?? e.message);
    if (e.data) console.error("  data:", e.data);
  }

  try {
    const ratioUsdc = await swap.getRatioUSDC();
    console.log(`getRatioUSDC: ${ratioUsdc[0].toString()}/${ratioUsdc[1].toString()}`);
  } catch (e: any) {
    console.error("getRatioUSDC reverted:", e.reason ?? e.message);
    if (e.data) console.error("  data:", e.data);
  }

  try {
    const fee = await swap.getSwapFeeBps();
    console.log(`getSwapFeeBps: ${fee.toString()}`);
  } catch (e: any) {
    console.error("getSwapFeeBps reverted:", e.reason ?? e.message);
    if (e.data) console.error("  data:", e.data);
  }

  try {
    const reserves = await swap.getReserves();
    console.log(`getReserves: CAS=${reserves[0].toString()}, USDC=${reserves[1].toString()}, POL=${reserves[2].toString()}`);
  } catch (e: any) {
    console.error("getReserves reverted:", e.reason ?? e.message);
    if (e.data) console.error("  data:", e.data);
  }

  try {
    const paused = await swap.isSwapPaused();
    console.log(`isSwapPaused: ${paused}`);
  } catch (e: any) {
    console.error("isSwapPaused reverted:", e.reason ?? e.message);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
