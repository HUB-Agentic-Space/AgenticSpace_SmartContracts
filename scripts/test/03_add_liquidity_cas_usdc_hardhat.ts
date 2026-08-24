import { ethers } from "hardhat";
import {
  getUsdcLpEnv,
  getErc20Contract,
  minAmount,
  deadlineFrom,
} from "../utils/usdc_lp_helpers";

const ROUTER_ABI = [
  "function factory() view returns (address)",
  "function addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256) external returns (uint256,uint256,uint256)",
];

async function main() {
  const env = getUsdcLpEnv(".env.usdc.test");
  const [deployer, lp] = await ethers.getSigners();

  if (lp.address.toLowerCase() !== env.USDC_LP_ADDRESS.toLowerCase()) {
    throw new Error(`Signer[1] (${lp.address}) nao corresponde a USDC_LP_ADDRESS (${env.USDC_LP_ADDRESS})`);
  }

  const cas = await getErc20Contract(env.CAS_TOKEN_ADDRESS);
  const usdc = await getErc20Contract(env.USDC_TOKEN_ADDRESS);
  const infra = await ethers.getContractAt(
    ["function transferCasToRapport(uint256)", "function rapportAddress() view returns (address)"],
    env.INFRASTRUCTURE_FUND_ADDRESS,
  );

  // 1) InfraFund -> Rapport -> LP
  console.log(`[03] Transferindo CAS do InfrastructureFund para Rapport e depois para LP...`);
  const rapport = await infra.rapportAddress();
  console.log(`  Rapport address: ${rapport}`);

  const tx1 = await infra.connect(deployer).transferCasToRapport(env.CAS_LIQUIDITY_TOTAL);
  await tx1.wait();
  const tx2 = await cas.connect(deployer).transfer(env.USDC_LP_ADDRESS, env.CAS_LIQUIDITY_TOTAL);
  await tx2.wait();
  console.log(`  CAS transferido: ${ethers.formatEther(env.CAS_LIQUIDITY_TOTAL)} CAS`);

  const deadline = deadlineFrom(env.DEADLINE_MINUTES);
  const minCas = minAmount(env.CAS_PER_DEX, env.SLIPPAGE_BPS);
  const minUsdc = minAmount(env.USDC_PER_DEX, env.SLIPPAGE_BPS);

  // 2) Adicionar liquidez em cada DEX
  for (const dex of env.DEX_ROUTERS) {
    console.log(`\n[03] DEX: ${dex.name} (${dex.address})`);

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

    console.log(`  Pair     : ${pairAddr}`);
    console.log(`  LP mint  : ${lpBalance.toString()} ${await pair.symbol()}`);
    console.log(`  Tx hash  : ${receipt?.hash ?? tx.hash}`);
  }

  console.log(`\n[03] Liquidez adicionada em ${env.DEX_ROUTERS.length} DEXs.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
