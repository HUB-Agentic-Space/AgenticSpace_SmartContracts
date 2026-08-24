import { ethers } from "hardhat";
import {
  preFlightCheck, estimateDeployGas, sendAndVerify, printSummary,
} from "../utils/deploy_helpers";

/**
 * Deploy script for CASToken and InfrastructureFund.
 *
 * Deploys:
 *   1. CASToken (UUPS proxy) — initialized with deployer as admin, 1M initial supply
 *   2. InfrastructureFund (UUPS proxy) — initialized with deployer as admin,
 *      CASToken address, deployer as rapport and author (can be changed later)
 *
 * Run after 00_deploy_diamond.ts. Sets CAS_TOKEN_ADDRESS and INFRASTRUCTURE_FUND_ADDRESS
 * so the diamond deploy script can register them if re-run.
 */

async function main() {
  const [deployer] = await ethers.getSigners();

  // -----------------------------------------------------------------------
  // 0. Pre-flight check
  // -----------------------------------------------------------------------
  const CASTokenF = await ethers.getContractFactory("CASToken");
  const InfraFundF = await ethers.getContractFactory("InfrastructureFund");

  const steps = [
    { label: "1. Deploy CASToken", gas: await estimateDeployGas(CASTokenF, deployer) },
    { label: "2. initialize() CASToken", gas: 300_000n },
    { label: "3. Deploy InfrastructureFund", gas: await estimateDeployGas(InfraFundF, deployer) },
    { label: "4. initialize() InfraFund", gas: 300_000n },
  ];

  const { gasPrice, balance } = await preFlightCheck(
    "Deploy CASToken + InfrastructureFund",
    steps,
  );

  // -----------------------------------------------------------------------
  // 1. Deploy CASToken
  // -----------------------------------------------------------------------
  const casToken = await CASTokenF.deploy({ gasPrice });
  await casToken.waitForDeployment();
  const casTokenAddr = await casToken.getAddress();
  console.log(`  CASToken proxy: ${casTokenAddr}`);

  const initialSupply = ethers.parseEther("1000000");
  await sendAndVerify(
    "initialize() CASToken (1M CAS)",
    casToken["initialize(address,uint256,string,string)"](
      deployer.address, initialSupply, "Cryptocoin Agentic Space", "CAS",
      { gasPrice },
    ),
    gasPrice,
  );

  const maxSupply = await casToken.maxSupply();
  console.log(`  MAX_SUPPLY: ${ethers.formatEther(maxSupply)} CAS`);

  // -----------------------------------------------------------------------
  // 2. Deploy InfrastructureFund
  // -----------------------------------------------------------------------
  const infraFund = await InfraFundF.deploy({ gasPrice });
  await infraFund.waitForDeployment();
  const infraFundAddr = await infraFund.getAddress();
  console.log(`  InfrastructureFund proxy: ${infraFundAddr}`);

  await sendAndVerify(
    "initialize() InfrastructureFund",
    infraFund["initialize(address,address,address,address)"](
      deployer.address, casTokenAddr, deployer.address, deployer.address,
      { gasPrice },
    ),
    gasPrice,
  );

  // -----------------------------------------------------------------------
  // 3. Summary
  // -----------------------------------------------------------------------
  await printSummary(
    "Token Deploy Concluido",
    [
      { label: "CASToken:", value: casTokenAddr },
      { label: "InfrastructureFund:", value: infraFundAddr },
      { label: "MAX_SUPPLY:", value: `${ethers.formatEther(maxSupply)} CAS` },
    ],
    balance,
    [
      `Atualize .env: CAS_TOKEN_ADDRESS=${casTokenAddr}`,
      `Atualize .env: INFRASTRUCTURE_FUND_ADDRESS=${infraFundAddr}`,
      `Re-execute 00_deploy_diamond.ts para registrar no Diamond`,
    ],
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`\n  Erro: ${error.message ?? error}`);
    process.exit(1);
  });
