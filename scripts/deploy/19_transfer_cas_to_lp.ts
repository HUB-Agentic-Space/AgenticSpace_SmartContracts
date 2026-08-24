import { ethers } from "hardhat";
import {
  getUsdcLpEnv,
  getErc20Contract,
} from "../utils/usdc_lp_helpers";

const INFRA_ABI = [
  "function transferCasToRapport(uint256)",
  "function rapportAddress() view returns (address)",
];

async function main() {
  const env = getUsdcLpEnv();

  const [deployer] = await ethers.getSigners();
  const rapport = new ethers.Wallet(env.RAPPORT_PRIVATE_KEY, deployer.provider);

  if (rapport.address.toLowerCase() !== env.RAPPORT_ADDRESS.toLowerCase()) {
    throw new Error(`RAPPORT_PRIVATE_KEY nao corresponde a RAPPORT_ADDRESS`);
  }

  const cas = await getErc20Contract(env.CAS_TOKEN_ADDRESS);
  const infra = await ethers.getContractAt(INFRA_ABI, env.INFRASTRUCTURE_FUND_ADDRESS);

  const rapportFromContract = await infra.rapportAddress();
  if (rapportFromContract.toLowerCase() !== env.RAPPORT_ADDRESS.toLowerCase()) {
    throw new Error(`RAPPORT_ADDRESS do .env.usdc difere do Rapport configurado no InfrastructureFund (${rapportFromContract})`);
  }

  console.log(`[19] Transferindo CAS do InfrastructureFund para Rapport e depois para LP...`);
  console.log(`  Rapport : ${env.RAPPORT_ADDRESS}`);
  console.log(`  Destino : ${env.USDC_LP_ADDRESS}`);
  console.log(`  Montante: ${ethers.formatEther(env.CAS_LIQUIDITY_TOTAL)} CAS`);

  const infraBal = await cas.balanceOf(env.INFRASTRUCTURE_FUND_ADDRESS);
  const rapportBal = await cas.balanceOf(env.RAPPORT_ADDRESS);
  const deployerBal = await cas.balanceOf(deployer.address);
  const amount = env.CAS_LIQUIDITY_TOTAL;

  if (infraBal >= amount) {
    console.log(`  Origem: InfrastructureFund (${env.INFRASTRUCTURE_FUND_ADDRESS})`);
    const tx1 = await infra.connect(deployer).transferCasToRapport(amount);
    await tx1.wait();
    console.log(`  InfrastructureFund -> Rapport: ${tx1.hash}`);

    const tx2 = await cas.connect(rapport).transfer(env.USDC_LP_ADDRESS, amount);
    await tx2.wait();
    console.log(`  Rapport -> LP: ${tx2.hash}`);
  } else if (rapportBal >= amount) {
    console.log(`  Origem: Rapport (${env.RAPPORT_ADDRESS}) - InfraFund sem saldo`);
    const tx = await cas.connect(rapport).transfer(env.USDC_LP_ADDRESS, amount);
    await tx.wait();
    console.log(`  Rapport -> LP: ${tx.hash}`);
  } else if (deployerBal >= amount) {
    console.log(`  Origem: Deployer (${deployer.address}) - InfraFund e Rapport sem saldo`);
    const tx = await cas.connect(deployer).transfer(env.USDC_LP_ADDRESS, amount);
    await tx.wait();
    console.log(`  Deployer -> LP: ${tx.hash}`);
  } else {
    throw new Error(
      `Nenhuma conta possui CAS suficiente. InfraFund: ${ethers.formatEther(infraBal)}, Rapport: ${ethers.formatEther(rapportBal)}, Deployer: ${ethers.formatEther(deployerBal)}`,
    );
  }

  const lpBalance = await cas.balanceOf(env.USDC_LP_ADDRESS);
  console.log(`\n  Saldo CAS da LP: ${ethers.formatEther(lpBalance)} CAS`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
