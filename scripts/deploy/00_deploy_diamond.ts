import { ethers } from "hardhat";
import { IDiamondCut } from "../../typechain-types";
import {
  SEP, SUB, preFlightCheck, estimateDeployGas, sendAndVerify, printSummary,
} from "../utils/deploy_helpers";

/**
 * Deploy script for the Agentic Space Diamond (EIP-2535).
 *
 * Deploys:
 *   1. DiamondCutFacet
 *   2. Diamond (with DiamondCutFacet attached)
 *   3. DiamondLoupeFacet, OwnershipFacet, PausableFacet
 *   4. Domain facets: UserRegistryFacet, AgentRegistryFacet, AgentValidatorFacet,
 *      RoadMapDAOFacet, AgentDAOFacet, CommunityDAOFacet, ContractRegistryFacet,
 *      AccessControlFacet
 *   5. DiamondInit (executed via diamondCut delegatecall)
 *   6. Register CASToken and InfrastructureFund in ContractRegistryFacet
 *
 * All facets are attached to the Diamond in a single diamondCut transaction.
 */

function getSelectors(contract: any): string[] {
  const selectors: string[] = [];
  const iface = contract.interface;
  for (const fn of iface.fragments) {
    if (fn.type === "function" && fn.name !== "init") {
      selectors.push(iface.getFunction(fn.name).selector);
    }
  }
  return selectors;
}

async function main() {
  const [deployer] = await ethers.getSigners();

  // -----------------------------------------------------------------------
  // 0. Pre-flight check: estimate gas for all steps and verify balance
  // -----------------------------------------------------------------------
  const facetNames = [
    "DiamondCutFacet",
    "DiamondLoupeFacet",
    "OwnershipFacet",
    "PausableFacet",
    "UserRegistryFacet",
    "AgentRegistryFacet",
    "AgentValidatorFacet",
    "RoadMapDAOFacet",
    "AgentDAOFacet",
    "CommunityDAOFacet",
    "ContractRegistryFacet",
    "AccessControlFacet",
    "PaymentFacet",
    "GasPromotionFacet",
  ];

  const steps: { label: string; gas: bigint }[] = [];
  for (const name of facetNames) {
    const Factory = await ethers.getContractFactory(name);
    const gas = await estimateDeployGas(Factory, deployer);
    steps.push({ label: `Deploy ${name}`, gas });
  }
  // Diamond deploy + diamondCut + init calls
  const DiamondFactory = await ethers.getContractFactory("Diamond");
  const DiamondInitFactory = await ethers.getContractFactory("DiamondInit");
  steps.push({ label: "Deploy Diamond", gas: await estimateDeployGas(DiamondFactory, deployer) });
  steps.push({ label: "Deploy DiamondInit", gas: await estimateDeployGas(DiamondInitFactory, deployer) });
  steps.push({ label: "diamondCut (all facets)", gas: 3_000_000n });
  steps.push({ label: "Init facets (5 calls)", gas: 1_000_000n });
  steps.push({ label: "Register contracts", gas: 500_000n });

  const { gasPrice, balance } = await preFlightCheck(
    "Diamond Deploy — Agentic Space (EIP-2535)",
    steps,
  );

  // -----------------------------------------------------------------------
  // 1. Deploy DiamondCutFacet
  // -----------------------------------------------------------------------
  const DiamondCutFacet = await ethers.getContractFactory("DiamondCutFacet");
  const diamondCutFacet = await DiamondCutFacet.deploy();
  await diamondCutFacet.waitForDeployment();
  const diamondCutFacetAddr = await diamondCutFacet.getAddress();
  console.log(`[deploy:diamond] DiamondCutFacet: ${diamondCutFacetAddr}`);

  // -----------------------------------------------------------------------
  // 2. Deploy Diamond (with DiamondCutFacet)
  // -----------------------------------------------------------------------
  const Diamond = await ethers.getContractFactory("Diamond");

  const cut: IDiamondCut.FacetCutStruct[] = [];
  cut.push({
    facetAddress: diamondCutFacetAddr,
    action: 0, // Add
    functionSelectors: getSelectors(diamondCutFacet),
  });

  const diamond = await Diamond.deploy(deployer.address, cut);
  await diamond.waitForDeployment();
  const diamondAddr = await diamond.getAddress();
  console.log(`[deploy:diamond] Diamond (proxy): ${diamondAddr}`);

  // -----------------------------------------------------------------------
  // 3. Deploy DiamondInit
  // -----------------------------------------------------------------------
  const DiamondInit = await ethers.getContractFactory("DiamondInit");
  const diamondInit = await DiamondInit.deploy();
  await diamondInit.waitForDeployment();
  const diamondInitAddr = await diamondInit.getAddress();
  console.log(`[deploy:diamond] DiamondInit: ${diamondInitAddr}`);

  // -----------------------------------------------------------------------
  // 4. Deploy remaining facets (skip DiamondCutFacet, already deployed)
  // -----------------------------------------------------------------------
  const remainingFacets = facetNames.slice(1);

  const facetCuts: IDiamondCut.FacetCutStruct[] = [];

  for (const name of remainingFacets) {
    const Factory = await ethers.getContractFactory(name);
    const facet = await Factory.deploy();
    await facet.waitForDeployment();
    const facetAddr = await facet.getAddress();
    console.log(`[deploy:diamond] ${name}: ${facetAddr}`);

    facetCuts.push({
      facetAddress: facetAddr,
      action: 0, // Add
      functionSelectors: getSelectors(facet),
    });
  }

  // -----------------------------------------------------------------------
  // 5. Execute diamondCut to add all facets + init
  // -----------------------------------------------------------------------
  const diamondCut = await ethers.getContractAt("IDiamondCut", diamondAddr);
  const initCalldata = DiamondInit.interface.encodeFunctionData("init");

  console.log(`[deploy:diamond] Executing diamondCut with ${facetCuts.length} facets...`);
  const tx = await diamondCut.diamondCut(facetCuts, diamondInitAddr, initCalldata);
  await tx.wait();
  console.log(`[deploy:diamond] All facets attached to Diamond.`);

  // -----------------------------------------------------------------------
  // 6. Initialize domain facets
  // -----------------------------------------------------------------------
  console.log(`[deploy:diamond] Initializing domain facets...`);

  // Init validator (sets MetaMask as supported wallet)
  const validatorFacet = await ethers.getContractAt("AgentValidatorFacet", diamondAddr);
  await (await validatorFacet.initValidator()).wait();
  console.log(`[deploy:diamond] AgentValidatorFacet initialized.`);

  // Init RoadMapDAO
  const roadmapFacet = await ethers.getContractAt("RoadMapDAOFacet", diamondAddr);
  await (await roadmapFacet.initRoadMapDAO()).wait();
  console.log(`[deploy:diamond] RoadMapDAOFacet initialized.`);

  // Init AgentDAO
  const agentDaoFacet = await ethers.getContractAt("AgentDAOFacet", diamondAddr);
  await (await agentDaoFacet.initAgentDAO()).wait();
  console.log(`[deploy:diamond] AgentDAOFacet initialized.`);

  // Init CommunityDAO
  const communityDaoFacet = await ethers.getContractAt("CommunityDAOFacet", diamondAddr);
  await (await communityDaoFacet.initCommunityDAO()).wait();
  console.log(`[deploy:diamond] CommunityDAOFacet initialized.`);

  // Init Payment (sets default fees)
  const paymentFacet = await ethers.getContractAt("PaymentFacet", diamondAddr);
  await (await paymentFacet.initPayment()).wait();
  console.log(`[deploy:diamond] PaymentFacet initialized.`);

  // Init GasPromotion (disabled by default)
  const gasPromoFacet = await ethers.getContractAt("GasPromotionFacet", diamondAddr);
  await (await gasPromoFacet.initGasPromotion()).wait();
  console.log(`[deploy:diamond] GasPromotionFacet initialized.`);

  // -----------------------------------------------------------------------
  // 7. Register external contracts (CASToken, InfrastructureFund)
  //        and bind them to PaymentFacet for fee processing.
  // -----------------------------------------------------------------------
  const contractRegistry = await ethers.getContractAt("ContractRegistryFacet", diamondAddr);

  const casTokenAddr = process.env.CAS_TOKEN_ADDRESS;
  if (casTokenAddr && casTokenAddr !== "") {
    await (await contractRegistry.register("CASToken", 1, casTokenAddr)).wait();
    console.log(`[deploy:diamond] CASToken registered at: ${casTokenAddr}`);

    await (await paymentFacet.setCasToken(casTokenAddr)).wait();
    console.log(`[deploy:diamond] PaymentFacet bound to CASToken.`);
  } else {
    console.log(`[deploy:diamond] Skipping CASToken registration (CAS_TOKEN_ADDRESS not set).`);
  }

  const infraFundAddr = process.env.INFRASTRUCTURE_FUND_ADDRESS;
  if (infraFundAddr && infraFundAddr !== "") {
    await (await contractRegistry.register("InfrastructureFund", 1, infraFundAddr)).wait();
    console.log(`[deploy:diamond] InfrastructureFund registered at: ${infraFundAddr}`);

    await (await paymentFacet.setInfrastructureFund(infraFundAddr)).wait();
    console.log(`[deploy:diamond] PaymentFacet bound to InfrastructureFund.`);
  } else {
    console.log(`[deploy:diamond] Skipping InfrastructureFund registration (INFRASTRUCTURE_FUND_ADDRESS not set).`);
  }

  // Register Faucet
  const faucetAddress = process.env.FAUCET_ADDRESS;
  if (faucetAddress && faucetAddress !== "") {
    const alreadyRegistered = await contractRegistry.isRegistered("Faucet");
    if (!alreadyRegistered) {
      await (await contractRegistry.register("Faucet", 1, faucetAddress)).wait();
      console.log(`[deploy:diamond] Faucet registered at: ${faucetAddress}`);
    } else {
      console.log(`[deploy:diamond] Faucet already registered, skipping.`);
    }
  } else {
    console.log(`[deploy:diamond] Skipping Faucet registration (FAUCET_ADDRESS not set).`);
  }

  // Register CASSwap
  const casSwapAddr = process.env.CAS_SWAP_ADDRESS;
  if (casSwapAddr && casSwapAddr !== "") {
    const alreadyRegistered = await contractRegistry.isRegistered("CASSwap");
    if (!alreadyRegistered) {
      await (await contractRegistry.register("CASSwap", 1, casSwapAddr)).wait();
      console.log(`[deploy:diamond] CASSwap registered at: ${casSwapAddr}`);
    } else {
      console.log(`[deploy:diamond] CASSwap already registered, skipping.`);
    }
  } else {
    console.log(`[deploy:diamond] Skipping CASSwap registration (CAS_SWAP_ADDRESS not set).`);
  }

  // Register CASMigration
  const casMigrationAddr = process.env.CAS_MIGRATION_ADDRESS;
  if (casMigrationAddr && casMigrationAddr !== "") {
    await (await contractRegistry.register("CASMigration", 1, casMigrationAddr)).wait();
    console.log(`[deploy:diamond] CASMigration registered at: ${casMigrationAddr}`);
  } else {
    console.log(`[deploy:diamond] Skipping CASMigration registration (CAS_MIGRATION_ADDRESS not set).`);
  }

  // -----------------------------------------------------------------------
  // 8. Summary
  // -----------------------------------------------------------------------
  await printSummary(
    "Diamond Deploy Concluido",
    [
      { label: "Diamond:", value: diamondAddr },
      { label: "DiamondInit:", value: diamondInitAddr },
      { label: "DiamondCutFacet:", value: diamondCutFacetAddr },
    ],
    balance,
    [
      `Atualize .env: DIAMOND_ADDRESS=${diamondAddr}`,
      `Verifique no Polygonscan: npx hardhat verify --network polygonAmoy ${diamondAddr} "${deployer.address}" "[...]"`,
    ],
  );
}

main().catch((error) => {
  console.error(`\n  Erro: ${error.message ?? error}`);
  process.exitCode = 1;
});
