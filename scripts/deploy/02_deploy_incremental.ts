import { ethers } from "hardhat";

/**
 * Incremental deploy script — continues from a partial deployment.
 *
 * Reuses already-deployed facets (by address) and only deploys missing ones,
 * then executes diamondCut to attach all facets to the existing Diamond.
 *
 * Set EXISTING_DIAMOND_ADDRESS in .env to skip Diamond proxy deployment.
 * Already-deployed facet addresses are hardcoded below from the previous run.
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

// Facets already deployed in previous run
const ALREADY_DEPLOYED: Record<string, string> = {
  DiamondLoupeFacet: "0x1Cf9d6cF0Fa979D09761D4f41bc78267f78977bE",
  OwnershipFacet: "0x8AAd53FEF5CFD63598C7caF28B0F640245F778a7",
  PausableFacet: "0x72Fd77B3cdb81066165787f494352399F0dB0027",
  UserRegistryFacet: "0x7A2bDd7c0B80c78b4aE9677839976B5A28EBcbF1",
  AgentRegistryFacet: "0xd8A3719afbaC8bb19291BF7fb33333a0eC903637",
  AgentValidatorFacet: "0x7f76C4F89E70C31B12Ba14bfB943Ce206cf1809b",
  RoadMapDAOFacet: "0xd14430836CF34B3B97b1D87B52FF47bff03b3F8a",
  AgentDAOFacet: "0x9E54710842A1E752D618604567B3c53A4ca7baca",
  ContractRegistryFacet: "0x455Bc25088f40c688B76974dF34626219931aD19",
  AccessControlFacet: "0x0b4FEddA266AEf25Ba3Dbc3fdDB61399A799ba82",
  PaymentFacet: "0xA1651eACb4031f1Fa25929d20d73B88b17Da92A6",
  GasPromotionFacet: "0xB7eFab8c5180F9E9024E68D8CD0c3241b4915f23",
};

const EXISTING_DIAMOND = "0xa9e0Cc843d7C2D4f2Ead780CD2F806C080392415";
const EXISTING_DIAMOND_INIT = "0x2056172c469a60E5290C27661CCF7D5785F8635B";

// Facets still to deploy
const REMAINING_FACETS: string[] = [];

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`[deploy:incremental] Account: ${deployer.address}`);
  console.log(`[deploy:incremental] Diamond: ${EXISTING_DIAMOND}`);

  const allCuts: { facetAddress: string; action: number; functionSelectors: string[] }[] = [];

  // Add already-deployed facets to the cut (they were not yet attached via diamondCut)
  for (const [name, addr] of Object.entries(ALREADY_DEPLOYED)) {
    const Factory = await ethers.getContractFactory(name);
    // For facets already deployed, we just need the selectors from the factory
    const fakeContract = Factory.attach(addr);
    allCuts.push({
      facetAddress: addr,
      action: 0,
      functionSelectors: getSelectors(fakeContract),
    });
    console.log(`[deploy:incremental] Reusing ${name}: ${addr}`);
  }

  // Deploy remaining facets
  for (const name of REMAINING_FACETS) {
    const Factory = await ethers.getContractFactory(name);
    const facet = await Factory.deploy();
    await facet.waitForDeployment();
    const facetAddr = await facet.getAddress();
    console.log(`[deploy:incremental] ${name}: ${facetAddr}`);

    allCuts.push({
      facetAddress: facetAddr,
      action: 0,
      functionSelectors: getSelectors(facet),
    });
  }

  // Execute diamondCut with all facets (no init — already done during Diamond deployment)
  const diamondCut = await ethers.getContractAt("IDiamondCut", EXISTING_DIAMOND);

  console.log(`[deploy:incremental] Executing diamondCut with ${allCuts.length} facets...`);
  const tx = await diamondCut.diamondCut(allCuts, ethers.ZeroAddress, "0x");
  await tx.wait();
  console.log(`[deploy:incremental] All facets attached to Diamond.`);

  // Initialize domain facets
  console.log(`[deploy:incremental] Initializing domain facets...`);

  const validatorFacet = await ethers.getContractAt("AgentValidatorFacet", EXISTING_DIAMOND);
  await (await validatorFacet.initValidator()).wait();
  console.log(`[deploy:incremental] AgentValidatorFacet initialized.`);

  const roadmapFacet = await ethers.getContractAt("RoadMapDAOFacet", EXISTING_DIAMOND);
  await (await roadmapFacet.initRoadMapDAO()).wait();
  console.log(`[deploy:incremental] RoadMapDAOFacet initialized.`);

  const agentDaoFacet = await ethers.getContractAt("AgentDAOFacet", EXISTING_DIAMOND);
  await (await agentDaoFacet.initAgentDAO()).wait();
  console.log(`[deploy:incremental] AgentDAOFacet initialized.`);

  const paymentFacet = await ethers.getContractAt("PaymentFacet", EXISTING_DIAMOND);
  await (await paymentFacet.initPayment()).wait();
  console.log(`[deploy:incremental] PaymentFacet initialized.`);

  const gasPromoFacet = await ethers.getContractAt("GasPromotionFacet", EXISTING_DIAMOND);
  await (await gasPromoFacet.initGasPromotion()).wait();
  console.log(`[deploy:incremental] GasPromotionFacet initialized.`);

  // Register external contracts
  const contractRegistry = await ethers.getContractAt("ContractRegistryFacet", EXISTING_DIAMOND);

  const casTokenAddr = process.env.CAS_TOKEN_ADDRESS;
  if (casTokenAddr && casTokenAddr !== "") {
    await (await contractRegistry.register("CASToken", 1, casTokenAddr)).wait();
    console.log(`[deploy:incremental] CASToken registered: ${casTokenAddr}`);
    await (await paymentFacet.setCasToken(casTokenAddr)).wait();
    console.log(`[deploy:incremental] PaymentFacet bound to CASToken.`);
  }

  const infraFundAddr = process.env.INFRASTRUCTURE_FUND_ADDRESS;
  if (infraFundAddr && infraFundAddr !== "") {
    await (await contractRegistry.register("InfrastructureFund", 1, infraFundAddr)).wait();
    console.log(`[deploy:incremental] InfrastructureFund registered: ${infraFundAddr}`);
    await (await paymentFacet.setInfrastructureFund(infraFundAddr)).wait();
    console.log(`[deploy:incremental] PaymentFacet bound to InfrastructureFund.`);
  }

  console.log(`\n[deploy:incremental] === Deployment Complete ===`);
  console.log(`[deploy:incremental] Diamond address: ${EXISTING_DIAMOND}`);
  console.log(`[deploy:incremental] Next: Set DIAMOND_ADDRESS=${EXISTING_DIAMOND} in .env files`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
