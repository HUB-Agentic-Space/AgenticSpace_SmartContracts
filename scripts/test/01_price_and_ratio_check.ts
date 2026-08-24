import { ethers } from "hardhat";
import { getUsdcLpEnv, parseRatio } from "../utils/usdc_lp_helpers";

async function main() {
  const env = getUsdcLpEnv(".env.usdc.test");

  const casswap = await ethers.getContractAt(["function getRatio() view returns (uint256,uint256)"], env.CASSWAP_ADDRESS);
  const [num, den] = await casswap.getRatio();
  const polUsdc = env.POL_USDC_PRICE;

  // CAS/USDC = POL/USDC * (denominator / numerator)
  const casUsdc = polUsdc * (Number(den) / Number(num));
  const usdcTotal = parseFloat(ethers.formatUnits(env.USDC_LIQUIDITY_TOTAL, 6));
  const casTotalFloat = usdcTotal / casUsdc;

  console.log(`[01] Verificacao de preco e ratio`);
  console.log(`  CAS/POL ratio      : ${num}:${den}`);
  console.log(`  POL/USDC (mock)    : ${polUsdc}`);
  console.log(`  CAS/USDC calculado : ${casUsdc.toFixed(10)}`);
  console.log(`  USDC total         : ${usdcTotal} USDC`);
  console.log(`  CAS total          : ${casTotalFloat.toFixed(6)} CAS`);
  console.log(`  Por DEX            : ${ethers.formatUnits(env.USDC_PER_DEX, 6)} USDC + ${ethers.formatEther(env.CAS_PER_DEX)} CAS`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
