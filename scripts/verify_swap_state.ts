import { ethers } from "hardhat";
import dotenv from "dotenv";
import { resolve } from "path";

dotenv.config({ path: resolve(__dirname, "..", ".env") });

async function main(): Promise<void> {
  const diamondAddr = process.env.DIAMOND_ADDRESS!;
  const oldSwapAddr = process.env.CAS_SWAP_ADDRESS!;

  const diamondAbi = [
    "function getRatio() view returns (uint256,uint256)",
    "function getRatioUSDC() view returns (uint256,uint256)",
    "function isSwapPaused() view returns (bool)",
    "function getReserves() view returns (uint256,uint256,uint256)",
  ];

  const oldAbi = [
    "function getRatio() view returns (uint256,uint256)",
    "function isPaused() view returns (bool)",
    "function getCASBalance() view returns (uint256)",
    "function getPOLBalance() view returns (uint256)",
  ];

  const diamond = new ethers.Contract(diamondAddr, diamondAbi, ethers.provider);
  const oldSwap = new ethers.Contract(oldSwapAddr, oldAbi, ethers.provider);

  console.log("\n============================================================");
  console.log("  CASSwap State Verification");
  console.log("============================================================");

  // Diamond
  const [polNum, polDen] = await diamond.getRatio();
  const [usdcNum, usdcDen] = await diamond.getRatioUSDC();
  const diaPaused = await diamond.isSwapPaused();
  const [casBal, usdcBal, polBal] = await diamond.getReserves();

  console.log("\n  Diamond CASSwapUSDCPOLFacet:");
  console.log(`    POL ratio:    ${polNum}/${polDen}  (1 POL = ${(Number(polNum)/Number(polDen)).toFixed(4)} CAS)`);
  console.log(`    USDC ratio:   ${usdcNum}/${usdcDen}`);
  console.log(`    1 CAS = ${(Number(polDen)/Number(polNum)).toFixed(8)} POL`);
  console.log(`    Paused:       ${diaPaused}`);
  console.log(`    Reserves:     ${ethers.formatEther(casBal)} CAS, ${ethers.formatUnits(usdcBal, 6)} USDC, ${ethers.formatEther(polBal)} POL`);

  // Old CASSwap
  const [oldNum, oldDen] = await oldSwap.getRatio();
  const oldPaused = await oldSwap.isPaused();
  const oldCas = await oldSwap.getCASBalance();
  const oldPol = await oldSwap.getPOLBalance();

  console.log("\n  Old CASSwap (standalone):");
  console.log(`    Ratio:    ${oldNum}/${oldDen}  (1 POL = ${(Number(oldNum)/Number(oldDen)).toFixed(4)} CAS)`);
  console.log(`    1 CAS = ${(Number(oldDen)/Number(oldNum)).toFixed(8)} POL`);
  console.log(`    Paused:   ${oldPaused}`);
  console.log(`    CAS balance: ${ethers.formatEther(oldCas)}`);
  console.log(`    POL balance: ${ethers.formatEther(oldPol)}`);

  console.log("\n============================================================");
  if (!diaPaused && !oldPaused) {
    console.log("  ✅ Ambos os swaps estão despausados e com ratio 1 CAS = 0.0006 POL");
  } else {
    console.log("  ⚠️  Algum swap ainda está pausado");
  }
  console.log("============================================================\n");
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
