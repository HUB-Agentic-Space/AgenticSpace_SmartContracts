import { ethers } from "hardhat";
import { SEP, SUB, preFlightCheck, printSummary } from "../utils/deploy_helpers";

const EXISTING_DIAMOND = "0x7B927dc2561cA5Ca564D3E57d5E0170726662e4E";

async function main() {
  const [deployer] = await ethers.getSigners();

  // -----------------------------------------------------------------------
  // 0. Pre-flight check for remaining init and registration calls
  // -----------------------------------------------------------------------
  const { balance } = await preFlightCheck(
    "Diamond Resume — Init & Register",
    [
      { label: "Init validator", gas: 100_000n },
      { label: "Init RoadMapDAO", gas: 150_000n },
      { label: "Init AgentDAO", gas: 150_000n },
      { label: "Init CommunityDAO", gas: 150_000n },
      { label: "Init Payment", gas: 100_000n },
      { label: "Init GasPromotion", gas: 100_000n },
      { label: "Register contracts", gas: 500_000n },
    ],
    { extraInfo: [{ label: "Diamond:", value: EXISTING_DIAMOND }] },
  );

  // -----------------------------------------------------------------------
  // 1. Initialize domain facets (idempotent on Amoy — safe to retry)
  // -----------------------------------------------------------------------
  const call = async (label: string, fn: any) => {
    try {
      const tx = await fn();
      await tx.wait();
      console.log(`[resume] ${label} initialized.`);
    } catch (error: any) {
      const msg = error.message ?? "";
      if (msg.includes("already initialized") || msg.includes("AlreadyInitialized")) {
        console.log(`[resume] ${label} already initialized — skipping.`);
      } else {
        console.error(`[resume] ${label} failed: ${msg}`);
        throw error;
      }
    }
  };

  const validatorFacet = await ethers.getContractAt("AgentValidatorFacet", EXISTING_DIAMOND);
  await call("AgentValidatorFacet", () => validatorFacet.initValidator());

  const roadmapFacet = await ethers.getContractAt("RoadMapDAOFacet", EXISTING_DIAMOND);
  await call("RoadMapDAOFacet", () => roadmapFacet.initRoadMapDAO());

  const agentDaoFacet = await ethers.getContractAt("AgentDAOFacet", EXISTING_DIAMOND);
  await call("AgentDAOFacet", () => agentDaoFacet.initAgentDAO());

  const communityDaoFacet = await ethers.getContractAt("CommunityDAOFacet", EXISTING_DIAMOND);
  await call("CommunityDAOFacet", () => communityDaoFacet.initCommunityDAO());

  const paymentFacet = await ethers.getContractAt("PaymentFacet", EXISTING_DIAMOND);
  await call("PaymentFacet", () => paymentFacet.initPayment());

  const gasPromoFacet = await ethers.getContractAt("GasPromotionFacet", EXISTING_DIAMOND);
  await call("GasPromotionFacet", () => gasPromoFacet.initGasPromotion());

  // -----------------------------------------------------------------------
  // 2. Register external contracts
  // -----------------------------------------------------------------------
  const contractRegistry = await ethers.getContractAt("ContractRegistryFacet", EXISTING_DIAMOND);

  const casTokenAddr = process.env.CAS_TOKEN_ADDRESS;
  if (casTokenAddr && casTokenAddr !== "") {
    try {
      const isReg = await contractRegistry.isRegistered("CASToken");
      if (!isReg) {
        await (await contractRegistry.register("CASToken", 1, casTokenAddr)).wait();
        console.log(`[resume] CASToken registered at: ${casTokenAddr}`);
      } else {
        console.log(`[resume] CASToken already registered.`);
      }
      await (await paymentFacet.setCasToken(casTokenAddr)).wait();
      console.log(`[resume] PaymentFacet bound to CASToken.`);
    } catch (error: any) {
      console.warn(`[resume] CASToken registration skipped: ${error.message}`);
    }
  } else {
    console.log(`[resume] Skipping CASToken registration (CAS_TOKEN_ADDRESS not set).`);
  }

  const infraFundAddr = process.env.INFRASTRUCTURE_FUND_ADDRESS;
  if (infraFundAddr && infraFundAddr !== "") {
    try {
      const isReg = await contractRegistry.isRegistered("InfrastructureFund");
      if (!isReg) {
        await (await contractRegistry.register("InfrastructureFund", 1, infraFundAddr)).wait();
        console.log(`[resume] InfrastructureFund registered at: ${infraFundAddr}`);
      } else {
        console.log(`[resume] InfrastructureFund already registered.`);
      }
      await (await paymentFacet.setInfrastructureFund(infraFundAddr)).wait();
      console.log(`[resume] PaymentFacet bound to InfrastructureFund.`);
    } catch (error: any) {
      console.warn(`[resume] InfrastructureFund registration skipped: ${error.message}`);
    }
  } else {
    console.log(`[resume] Skipping InfrastructureFund registration (INFRASTRUCTURE_FUND_ADDRESS not set).`);
  }

  const faucetAddress = process.env.FAUCET_ADDRESS;
  if (faucetAddress && faucetAddress !== "") {
    const alreadyRegistered = await contractRegistry.isRegistered("Faucet");
    if (!alreadyRegistered) {
      await (await contractRegistry.register("Faucet", 1, faucetAddress)).wait();
      console.log(`[resume] Faucet registered at: ${faucetAddress}`);
    } else {
      console.log(`[resume] Faucet already registered, skipping.`);
    }
  } else {
    console.log(`[resume] Skipping Faucet registration (FAUCET_ADDRESS not set).`);
  }

  const casSwapAddr = process.env.CAS_SWAP_ADDRESS;
  if (casSwapAddr && casSwapAddr !== "") {
    const alreadyRegistered = await contractRegistry.isRegistered("CASSwap");
    if (!alreadyRegistered) {
      await (await contractRegistry.register("CASSwap", 1, casSwapAddr)).wait();
      console.log(`[resume] CASSwap registered at: ${casSwapAddr}`);
    } else {
      console.log(`[resume] CASSwap already registered, skipping.`);
    }
  } else {
    console.log(`[resume] Skipping CASSwap registration (CAS_SWAP_ADDRESS not set).`);
  }

  const casMigrationAddr = process.env.CAS_MIGRATION_ADDRESS;
  if (casMigrationAddr && casMigrationAddr !== "") {
    const alreadyRegistered = await contractRegistry.isRegistered("CASMigration");
    if (!alreadyRegistered) {
      await (await contractRegistry.register("CASMigration", 1, casMigrationAddr)).wait();
      console.log(`[resume] CASMigration registered at: ${casMigrationAddr}`);
    } else {
      console.log(`[resume] CASMigration already registered, skipping.`);
    }
  } else {
    console.log(`[resume] Skipping CASMigration registration (CAS_MIGRATION_ADDRESS not set).`);
  }

  // -----------------------------------------------------------------------
  // 3. Summary
  // -----------------------------------------------------------------------
  await printSummary(
    "Diamond Resume Concluido",
    [{ label: "Diamond:", value: EXISTING_DIAMOND }],
    balance,
    [
      `Atualize .env: DIAMOND_ADDRESS=${EXISTING_DIAMOND}`,
      `Verifique no Polygonscan: npx hardhat verify --network polygonAmoy ${EXISTING_DIAMOND} "${deployer.address}" "[...]"`,
    ],
  );
}

main().catch((error) => {
  console.error(`\n  Erro: ${error.message ?? error}`);
  process.exitCode = 1;
});
