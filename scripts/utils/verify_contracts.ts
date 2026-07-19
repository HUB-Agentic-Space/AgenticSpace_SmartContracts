import { run } from "hardhat";

async function main() {
  const contractsToVerify = [
    { name: "Diamond", addressEnv: "DIAMOND_ADDRESS" },
    { name: "DiamondCutFacet", addressEnv: "DIAMOND_CUT_FACET_ADDRESS" },
    { name: "DiamondLoupeFacet", addressEnv: "DIAMOND_LOUPE_FACET_ADDRESS" },
    { name: "OwnershipFacet", addressEnv: "OWNERSHIP_FACET_ADDRESS" },
    { name: "PausableFacet", addressEnv: "PAUSABLE_FACET_ADDRESS" },
    { name: "UserRegistryFacet", addressEnv: "USER_REGISTRY_FACET_ADDRESS" },
    { name: "AgentRegistryFacet", addressEnv: "AGENT_REGISTRY_FACET_ADDRESS" },
    { name: "AgentValidatorFacet", addressEnv: "AGENT_VALIDATOR_FACET_ADDRESS" },
    { name: "RoadMapDAOFacet", addressEnv: "ROADMAP_DAO_FACET_ADDRESS" },
    { name: "AgentDAOFacet", addressEnv: "AGENT_DAO_FACET_ADDRESS" },
    { name: "ContractRegistryFacet", addressEnv: "CONTRACT_REGISTRY_FACET_ADDRESS" },
    { name: "AccessControlFacet", addressEnv: "ACCESS_CONTROL_FACET_ADDRESS" },
    { name: "PaymentFacet", addressEnv: "PAYMENT_FACET_ADDRESS" },
    { name: "GasPromotionFacet", addressEnv: "GAS_PROMOTION_FACET_ADDRESS" },
    { name: "FundTrackerToken", addressEnv: "CAS_FUND_TRACKER_ADDRESS" },
    { name: "FundTrackerToken", addressEnv: "POL_FUND_TRACKER_ADDRESS" },
    { name: "DiamondInit", addressEnv: "DIAMOND_INIT_ADDRESS" },
  ];

  for (const c of contractsToVerify) {
    const address = process.env[c.addressEnv];
    if (!address) {
      console.warn(`[verify] ${c.name}: ${c.addressEnv} not set, skipping`);
      continue;
    }

    try {
      await run("verify:verify", {
        address,
        constructorArguments: [],
      });
      console.log(`[verify] ${c.name} verified at ${address}`);
    } catch (error) {
      console.error(`[verify] ${c.name} failed: ${error}`);
    }
  }

  console.log("[verify] Verification complete");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
