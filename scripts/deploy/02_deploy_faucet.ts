import { ethers } from "hardhat";
import {
  preFlightCheck, estimateDeployGas, printSummary,
} from "../utils/deploy_helpers";

/**
 * Deploy do Faucet avulso para distribuicao de POL na rede Polygon.
 *
 * Parametros configuraveis via variaveis de ambiente:
 *   FAUCET_INTERVAL  — intervalo de cooldown em segundos (default: 86400 = 24h)
 *   FAUCET_AMOUNT    — quantidade de POL por saque em wei (default: 0.1 POL = 100000000000000000)
 */
async function main() {
  const [deployer] = await ethers.getSigners();

  const interval = process.env.FAUCET_INTERVAL
    ? BigInt(process.env.FAUCET_INTERVAL)
    : 86400n;

  const amount = process.env.FAUCET_AMOUNT
    ? BigInt(process.env.FAUCET_AMOUNT)
    : ethers.parseEther("0.1");

  // Pre-flight check
  const FaucetF = await ethers.getContractFactory("Faucet");
  const steps = [
    { label: "1. Deploy Faucet", gas: await estimateDeployGas(FaucetF, deployer) },
  ];

  const { gasPrice, balance } = await preFlightCheck(
    "Deploy Faucet — Polygon POL",
    steps,
    {
      extraInfo: [
        { label: "Interval (s):", value: interval.toString() },
        { label: "Amount (POL):", value: ethers.formatEther(amount) },
      ],
    },
  );

  const faucet = await FaucetF.deploy(interval, amount, { gasPrice });
  await faucet.waitForDeployment();
  const address = await faucet.getAddress();

  console.log(`  Faucet deployado: ${address}`);
  console.log(`  Owner:            ${await faucet.owner()}`);

  // -----------------------------------------------------------------------
  // Register Faucet in Diamond ContractRegistry (if Diamond is deployed)
  // -----------------------------------------------------------------------
  const diamondAddr = process.env.DIAMOND_ADDRESS;
  if (diamondAddr && diamondAddr !== "") {
    try {
      const contractRegistry = await ethers.getContractAt("ContractRegistryFacet", diamondAddr);
      const alreadyRegistered = await contractRegistry.isRegistered("Faucet");
      if (!alreadyRegistered) {
        await (await contractRegistry.register("Faucet", 1, address)).wait();
        console.log(`  [deploy:faucet] Faucet registered in Diamond at: ${diamondAddr}`);
      } else {
        console.log(`  [deploy:faucet] Faucet already registered in Diamond, skipping.`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  [deploy:faucet] Could not register in Diamond: ${msg}`);
      console.warn(`  [deploy:faucet] Run scripts/deploy/register_contracts.ts manually.`);
    }
  } else {
    console.log(`  [deploy:faucet] DIAMOND_ADDRESS not set, skipping Diamond registration.`);
    console.log(`  [deploy:faucet] Run scripts/deploy/register_contracts.ts after Diamond deploy.`);
  }

  await printSummary(
    "Faucet Deploy Concluido",
    [
      { label: "Faucet:", value: address },
      { label: "Owner:", value: await faucet.owner() },
      { label: "Interval:", value: `${interval}s` },
      { label: "Amount:", value: `${ethers.formatEther(amount)} POL` },
    ],
    balance,
    [
      `Envie POL para o contrato: ${address}`,
      `Verifique no Polygonscan`,
      `Usuarios podem chamar requestTokens()`,
      `Atualize .env: FAUCET_ADDRESS=${address}`,
      `Atualize frontend .env: NEXT_PUBLIC_FAUCET_ADDRESS=${address}`,
    ],
  );
}

main().catch((error) => {
  console.error(`\n  Erro: ${error.message ?? error}`);
  process.exitCode = 1;
});
