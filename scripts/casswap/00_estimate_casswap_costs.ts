import { ethers } from "hardhat";
import {
  preFlightCheck,
  estimateDeployGas,
  estimateFunctionGas,
  fmtPOL,
  requireEnv,
} from "../utils/deploy_helpers";

async function main() {
  const [deployer] = await ethers.getSigners();
  const env = requireEnv(["CAS_TOKEN_ADDRESS"]);

  const casTokenAddr = env.CAS_TOKEN_ADDRESS;
  const casReserveInput = process.env.CAS_RESERVE_AMOUNT || "500000";
  const polDepositInput = process.env.POL_DEPOSIT_AMOUNT || "10";
  const ratioRaw = process.env.CAS_RATIO || "1:1";
  const [ratioNum, ratioDen] = ratioRaw.split(":");
  const needsRatioSet = ratioNum !== "1" || ratioDen !== "1";

  const reserveAmount = ethers.parseEther(casReserveInput);
  const polDepositWei = ethers.parseEther(polDepositInput);

  const CASSwapF = await ethers.getContractFactory("CASSwap");
  const casToken = await ethers.getContractAt("CASToken", casTokenAddr);

  const steps = [
    { label: "1. Deploy CASSwap", gas: await estimateDeployGas(CASSwapF, deployer) },
    { label: "2. initialize()", gas: 300_000n },
    { label: "3. setRatio()", gas: needsRatioSet ? 80_000n : 0n },
    { label: "4. approve()", gas: await estimateFunctionGas(casToken, "approve", [casTokenAddr, reserveAmount], 60_000n) },
    { label: "5. depositCAS()", gas: 150_000n },
    { label: "6. pause()", gas: 50_000n },
    { label: "7. depositPOL()", gas: 30_000n },
  ];

  const { totalCost, gasPrice } = await preFlightCheck(
    "Estimativa de Custos CASSwap",
    steps,
    {
      extraInfo: [
        { label: "CAS Token:", value: casTokenAddr },
        { label: "Ratio:", value: ratioRaw },
        { label: "CAS reserve:", value: `${casReserveInput} CAS` },
        { label: "POL deposit:", value: `${polDepositInput} POL` },
      ],
    },
  );

  const totalGas = steps.reduce((sum, s) => sum + s.gas, 0n);

  console.log(`\n  =============================================================`);
  console.log(`  Cenarios de preco de gas`);
  console.log(`  =============================================================`);
  for (const gwei of [150n, 300n, 500n, 800n]) {
    const price = gwei * 10n ** 9n;
    const cost = totalGas * price;
    console.log(`  ${gwei.toString().padStart(3)} gwei ${ethers.formatEther(cost).padStart(18)} POL`);
  }

  console.log(`\n  =============================================================`);
  console.log(`  Contas e saldos necessarios`);
  console.log(`  =============================================================`);
  console.log(`  Deployer/Operador: ${deployer.address}`);
  console.log(`    - POL para gas  : ~${fmtPOL(totalCost)} (gas price atual: ${fmtPOL(gasPrice)}?)`);
  console.log(`    - POL para o CASSwap : ${polDepositInput} POL (para vendas de CAS)`);
  console.log(`    - CAS para aprovar/depositar: ${casReserveInput} CAS`);
  console.log(`  CASSwap (apos deploy):`);
  console.log(`    - Recebe ${casReserveInput} CAS via depositCAS()`);
  console.log(`    - Recebe ${polDepositInput} POL via transferencia direta`);
  console.log(`  InfrastructureFund:`);
  console.log(`    - Recebe POL excedente via withdrawPOL() em operacao futura`);
  console.log(`  =============================================================`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`\n  Erro: ${error.message ?? error}`);
    process.exit(1);
  });
