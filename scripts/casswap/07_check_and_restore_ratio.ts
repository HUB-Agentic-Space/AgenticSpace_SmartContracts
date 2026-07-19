/**
 * Verifica e restaura o ratio do CASSwap caso esteja incorreto.
 * Uso: npx hardhat run scripts/casswap/07_check_and_restore_ratio.ts --network polygon
 */
import { ethers } from "hardhat";
import { Contract } from "ethers";
import { requireEnv, SEP, SUB, sendAndVerify, fmtPOL } from "../utils/deploy_helpers";

const CASSWAP_ABI = [
  "function getRatio() view returns (uint256,uint256)",
  "function setRatio(uint256,uint256)",
  "function getCASBalance() view returns (uint256)",
  "function isPaused() view returns (bool)",
];

async function main(): Promise<void> {
  const env = requireEnv(["CAS_SWAP_ADDRESS"]);
  const [deployer] = await ethers.getSigners();
  const provider = deployer.provider!;

  const casswap = new Contract(env.CAS_SWAP_ADDRESS, CASSWAP_ABI, deployer);
  const [num, den] = await casswap.getRatio();
  const casBal = await casswap.getCASBalance();
  const paused = await casswap.isPaused();
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? 30_000_000_000n;

  console.log(`\n${SEP}`);
  console.log("  Verificar e Restaurar Ratio CASSwap");
  console.log(SEP);
  console.log(`  CASSwap:   ${env.CAS_SWAP_ADDRESS}`);
  console.log(`  Ratio:     ${num}:${den}`);
  console.log(`  CAS bal:   ${ethers.formatEther(casBal)} CAS`);
  console.log(`  Pausado:   ${paused}`);
  console.log(`  Gas price: ${gasPrice} wei`);

  const EXPECTED_NUM = 17n;
  const EXPECTED_DEN = 1n;

  if (num === EXPECTED_NUM && den === EXPECTED_DEN) {
    console.log(`\n  ✅ Ratio já está correto (${EXPECTED_NUM}:${EXPECTED_DEN}). Nada a fazer.`);
    return;
  }

  console.log(`\n  ⚠️  Ratio incorreto! Atual: ${num}:${den}`);
  console.log(`  Restaurando para ${EXPECTED_NUM}:${EXPECTED_DEN}...`);

  await sendAndVerify(
    `setRatio(${EXPECTED_NUM}:${EXPECTED_DEN})`,
    casswap.setRatio(EXPECTED_NUM, EXPECTED_DEN, { gasPrice }) as Promise<any>,
    gasPrice,
  );

  const [newNum, newDen] = await casswap.getRatio();
  console.log(`\n  ✅ Ratio restaurado: ${newNum}:${newDen}`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error("\n❌ Falha:", (err as Error).message);
  process.exit(1);
});
