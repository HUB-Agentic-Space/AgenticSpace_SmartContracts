import { ethers } from "hardhat";
import { getUsdcLpEnv, getErc20Contract } from "../utils/usdc_lp_helpers";

async function main() {
  const env = getUsdcLpEnv(".env.usdc.test");

  const cas = await getErc20Contract(env.CAS_TOKEN_ADDRESS);
  const usdc = await getErc20Contract(env.USDC_TOKEN_ADDRESS);

  const casBalance = await cas.balanceOf(env.USDC_LP_ADDRESS);
  const usdcBalance = await usdc.balanceOf(env.USDC_LP_ADDRESS);
  const polBalance = await ethers.provider.getBalance(env.USDC_LP_ADDRESS);

  console.log(`[02] Preflight da conta LP (${env.USDC_LP_ADDRESS})`);
  console.log(`  CAS  : ${ethers.formatEther(casBalance)} CAS`);
  console.log(`  USDC : ${ethers.formatUnits(usdcBalance, 6)} USDC`);
  console.log(`  POL  : ${ethers.formatEther(polBalance)} POL`);
  console.log(`\n  Necessario por DEX:`);
  console.log(`  USDC : ${ethers.formatUnits(env.USDC_PER_DEX, 6)} USDC`);
  console.log(`  CAS  : ${ethers.formatEther(env.CAS_PER_DEX)} CAS`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
