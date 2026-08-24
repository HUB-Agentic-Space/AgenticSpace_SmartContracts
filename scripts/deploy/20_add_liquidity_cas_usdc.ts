import { ethers } from "hardhat";
import {
  getUsdcLpEnv,
  getUsdcLpSigner,
  getErc20Contract,
  minAmount,
  deadlineFrom,
} from "../utils/usdc_lp_helpers";

const ROUTER_ABI = [
  "function factory() view returns (address)",
  "function addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256) external returns (uint256,uint256,uint256)",
];

async function main() {
  const env = getUsdcLpEnv();
  const lp = await getUsdcLpSigner();
  if (!lp) {
    throw new Error("USDC_LP_PRIVATE_KEY nao configurada no .env.usdc");
  }

  const cas = await getErc20Contract(env.CAS_TOKEN_ADDRESS);
  const usdc = await getErc20Contract(env.USDC_TOKEN_ADDRESS);

  const deadline = deadlineFrom(env.DEADLINE_MINUTES);
  const minCas = minAmount(env.CAS_PER_DEX, env.SLIPPAGE_BPS);
  const minUsdc = minAmount(env.USDC_PER_DEX, env.SLIPPAGE_BPS);

  console.log(`[20] Adicionando liquidez CAS/USDC nativo em ${env.DEX_ROUTERS.length} DEXs`);
  console.log(`  LP account : ${env.USDC_LP_ADDRESS}`);
  console.log(`  USDC/DEX   : ${ethers.formatUnits(env.USDC_PER_DEX, 6)} USDC`);
  console.log(`  CAS/DEX    : ${ethers.formatEther(env.CAS_PER_DEX)} CAS`);

  for (const dex of env.DEX_ROUTERS) {
    console.log(`\n  DEX: ${dex.name} (${dex.address})`);

    const router = await ethers.getContractAt(ROUTER_ABI, dex.address);

    const approveCas = await cas.connect(lp).approve(dex.address, env.CAS_PER_DEX);
    await approveCas.wait();
    const approveUsdc = await usdc.connect(lp).approve(dex.address, env.USDC_PER_DEX);
    await approveUsdc.wait();

    const tx = await router
      .connect(lp)
      .addLiquidity(
        env.CAS_TOKEN_ADDRESS,
        env.USDC_TOKEN_ADDRESS,
        env.CAS_PER_DEX,
        env.USDC_PER_DEX,
        minCas,
        minUsdc,
        env.USDC_LP_ADDRESS,
        deadline,
      );
    const receipt = await tx.wait();

    const factoryAddr = await router.factory();
    const factory = await ethers.getContractAt(["function getPair(address,address) view returns (address)"], factoryAddr);
    const pairAddr = await factory.getPair(env.CAS_TOKEN_ADDRESS, env.USDC_TOKEN_ADDRESS);
    const pair = await getErc20Contract(pairAddr);
    const lpBalance = await pair.balanceOf(env.USDC_LP_ADDRESS);

    console.log(`    Pair       : ${pairAddr}`);
    console.log(`    LP tokens  : ${lpBalance.toString()} ${await pair.symbol()}`);
    console.log(`    Tx hash    : ${receipt?.hash ?? tx.hash}`);
  }

  console.log(`\n[20] Liquidez adicionada em todos os DEXs.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
