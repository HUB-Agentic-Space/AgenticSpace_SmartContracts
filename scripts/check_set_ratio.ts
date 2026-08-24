import { ethers } from "hardhat";

async function main() {
  const diamondAddress = process.env.DIAMOND_ADDRESS;
  if (!diamondAddress) throw new Error("DIAMOND_ADDRESS not set");

  const txHash = process.env.TX_HASH || "0xe8c4e7b2c32af0bc9e2b477c03952bac784c66e533020a1193c8216ab62c673d";

  const swap = await ethers.getContractAt("ICASSwapUSDCPOL", diamondAddress);

  console.log("Reading current getRatio()...");
  const ratio = await swap.getRatio();
  console.log(`getRatio: ${ratio[0].toString()}/${ratio[1].toString()}`);

  const usdcRatio = await swap.getRatioUSDC();
  console.log(`getRatioUSDC: ${usdcRatio[0].toString()}/${usdcRatio[1].toString()}`);

  const paused = await swap.isSwapPaused();
  console.log(`isSwapPaused: ${paused}`);

  console.log(`\nParsing TX ${txHash}...`);
  const receipt = await ethers.provider.getTransactionReceipt(txHash);
  if (!receipt) {
    console.log("Receipt not found");
    return;
  }
  console.log(`  status: ${receipt.status}`);
  console.log(`  gasUsed: ${receipt.gasUsed.toString()}`);
  console.log(`  logs: ${receipt.logs.length}`);

  for (const log of receipt.logs) {
    try {
      const parsed = swap.interface.parseLog(log);
      if (parsed) {
        console.log(`  Event: ${parsed.name}`);
        console.log(`    args: ${JSON.stringify(parsed.args.toObject(true))}`);
      }
    } catch {}
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
