import { ethers } from "hardhat";
import {
  preFlightCheck, estimateDeployGas, sendAndVerify, printSummary, requireEnv,
} from "../utils/deploy_helpers";

/**
 * Deploy only InfrastructureFund pointing to existing CASToken.
 * Used when CASToken is already deployed but InfrastructureFund needs redeployment.
 */
async function main() {
  const [deployer] = await ethers.getSigners();

  const env = requireEnv(["CAS_TOKEN_ADDRESS"]);
  const casTokenAddr = env.CAS_TOKEN_ADDRESS;

  // Pre-flight check
  const InfraF = await ethers.getContractFactory("InfrastructureFund");
  const steps = [
    { label: "1. Deploy InfrastructureFund", gas: await estimateDeployGas(InfraF, deployer) },
    { label: "2. initialize()", gas: 300_000n },
  ];

  const { gasPrice, balance } = await preFlightCheck(
    "Deploy InfrastructureFund",
    steps,
    {
      extraInfo: [{ label: "CAS Token:", value: casTokenAddr }],
    },
  );

  const infra = await InfraF.deploy({ gasPrice });
  await infra.waitForDeployment();
  const infraAddr = await infra.getAddress();
  console.log(`  InfrastructureFund proxy: ${infraAddr}`);

  await sendAndVerify(
    "initialize() InfrastructureFund",
    infra["initialize(address,address,address,address)"](
      deployer.address, casTokenAddr, deployer.address, deployer.address,
      { gasPrice },
    ),
    gasPrice,
  );

  const casBal = await infra.casBalance();
  const nativeBal = await infra.nativeBalance();

  await printSummary(
    "InfrastructureFund Deploy Concluido",
    [
      { label: "Address:", value: infraAddr },
      { label: "CAS balance:", value: `${ethers.formatEther(casBal)} CAS` },
      { label: "POL balance:", value: `${ethers.formatEther(nativeBal)} POL` },
    ],
    balance,
    [
      `Atualize .env: INFRASTRUCTURE_FUND_ADDRESS=${infraAddr}`,
      `Re-execute 00_deploy_diamond.ts para registrar no Diamond`,
    ],
  );
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(`\n  Erro: ${e.message ?? e}`);
  process.exit(1);
});
