import { ethers } from "hardhat";
import {
  preFlightCheck, estimateDeployGas, printSummary, requireEnv,
} from "../utils/deploy_helpers";

/**
 * Deploy FundTrackerToken — two instances:
 *   1. CAS Tracker (symbol: aCAS) — mirrors InfrastructureFund.casBalance()
 *   2. POL Tracker (symbol: aPOL) — mirrors InfrastructureFund.nativeBalance()
 *
 * Requires INFRASTRUCTURE_FUND_ADDRESS in .env.
 * Optional: FUND_TRACKER_ADMIN (defaults to deployer).
 */
async function main() {
  const [deployer] = await ethers.getSigners();

  const env = requireEnv(["INFRASTRUCTURE_FUND_ADDRESS"]);
  const fundAddr = env.INFRASTRUCTURE_FUND_ADDRESS;
  const admin = process.env.FUND_TRACKER_ADMIN || deployer.address;

  // Pre-flight check
  const TrackerF = await ethers.getContractFactory("FundTrackerToken");
  const deployGas = await estimateDeployGas(TrackerF, deployer);

  const steps = [
    { label: "1. Deploy CAS Tracker", gas: deployGas },
    { label: "2. Deploy POL Tracker", gas: deployGas },
  ];

  const { gasPrice, balance } = await preFlightCheck(
    "Deploy FundTrackerToken (CAS + POL)",
    steps,
    {
      extraInfo: [
        { label: "Fund:", value: fundAddr },
        { label: "Admin:", value: admin },
      ],
    },
  );

  // 1. CAS Tracker
  const casTracker = await TrackerF.deploy(
    fundAddr, 0, "Agentic CAS Fund", "aCAS", admin, { gasPrice },
  );
  await casTracker.waitForDeployment();
  const casTrackerAddr = await casTracker.getAddress();
  console.log(`  CAS FundTrackerToken: ${casTrackerAddr}`);

  // 2. POL Tracker
  const polTracker = await TrackerF.deploy(
    fundAddr, 1, "Agentic POL Fund", "aPOL", admin, { gasPrice },
  );
  await polTracker.waitForDeployment();
  const polTrackerAddr = await polTracker.getAddress();
  console.log(`  POL FundTrackerToken: ${polTrackerAddr}`);

  await printSummary(
    "FundTrackerToken Deploy Concluido",
    [
      { label: "CAS Tracker:", value: `${casTrackerAddr} (aCAS)` },
      { label: "POL Tracker:", value: `${polTrackerAddr} (aPOL)` },
    ],
    balance,
    [
      `Atualize .env: CAS_FUND_TRACKER_ADDRESS=${casTrackerAddr}`,
      `Atualize .env: POL_FUND_TRACKER_ADDRESS=${polTrackerAddr}`,
      `Adicione no MetaMask como tokens customizados`,
    ],
  );
}

main().catch((error) => {
  console.error(`\n  Erro: ${error.message ?? error}`);
  process.exitCode = 1;
});
