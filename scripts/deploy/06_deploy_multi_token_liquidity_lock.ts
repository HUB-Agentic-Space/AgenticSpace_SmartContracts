import { ethers } from "hardhat";
import {
  preFlightCheck,
  estimateDeployGas,
  printSummary,
  requireEnv,
} from "../utils/deploy_helpers";

/**
 * Deploy do MultiTokenLiquidityLockFacet.
 *
 * Variáveis de ambiente esperadas:
 *   DIAMOND_ADDRESS
 *
 * Após deploy, atualize .env com:
 *   MULTI_TOKEN_LIQUIDITY_LOCK_FACET_ADDRESS=<endereço>
 */
async function main() {
  const [deployer] = await ethers.getSigners();

  const env = requireEnv(["DIAMOND_ADDRESS"]);

  const LockF = await ethers.getContractFactory("MultiTokenLiquidityLockFacet");

  const steps = [
    { label: "1. Deploy MultiTokenLiquidityLockFacet", gas: await estimateDeployGas(LockF, deployer) },
  ];

  const { balance, gasPrice } = await preFlightCheck(
    "Deploy MultiTokenLiquidityLockFacet",
    steps,
    {
      extraInfo: [
        { label: "Diamond:", value: env.DIAMOND_ADDRESS },
      ],
    },
  );

  const lock = await LockF.deploy({ gasPrice });
  await lock.waitForDeployment();
  const lockAddr = await lock.getAddress();

  console.log(`  MultiTokenLiquidityLockFacet: ${lockAddr}`);

  await printSummary(
    "MultiTokenLiquidityLockFacet Deploy Concluido",
    [
      { label: "Facet:", value: lockAddr },
      { label: "Diamond:", value: env.DIAMOND_ADDRESS },
    ],
    balance,
    [
      `Atualize .env: MULTI_TOKEN_LIQUIDITY_LOCK_FACET_ADDRESS=${lockAddr}`,
      "Execute scripts/diamond_cut_liquidity.ts para registrar os selectors no Diamond",
    ],
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`\n  Erro: ${error.message ?? error}`);
    process.exit(1);
  });
