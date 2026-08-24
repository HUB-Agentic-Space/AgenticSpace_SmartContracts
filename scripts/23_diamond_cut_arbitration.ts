import "dotenv/config";
import { ethers } from "ethers";
import { readFileSync } from "fs";
import { join } from "path";
import { requireEnv, sendAndVerify, SEP } from "./utils/deploy_helpers";

function log(level: string, fn: string, message: string, params?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").split(".")[0];
  const file = "scripts/23_diamond_cut_arbitration.ts";
  const extra = params ? ` - ${JSON.stringify(params)}` : "";
  console.log(`[${ts}] [${file}:${fn}] ${level} ${message}${extra}`);
}

async function main(): Promise<void> {
  const { DIAMOND_ADDRESS, ARBITRATION_FACET_ADDRESS, POLYGON_RPC_URL, RELAYER_PRIVATE_KEY } = await requireEnv([
    "DIAMOND_ADDRESS",
    "ARBITRATION_FACET_ADDRESS",
    "POLYGON_RPC_URL",
    "RELAYER_PRIVATE_KEY",
  ]);

  const provider = new ethers.JsonRpcProvider(POLYGON_RPC_URL);
  const deployer = new ethers.Wallet(RELAYER_PRIVATE_KEY, provider);

  const DIAMOND_CUT_ABI = [
    "function diamondCut((address,uint8,bytes4[])[], address, bytes) external",
  ];

  const diamond = new ethers.Contract(DIAMOND_ADDRESS, DIAMOND_CUT_ABI, deployer);

  console.log(`\n${SEP}`);
  console.log("  Diamond Cut — Add ArbitrationFacet");
  console.log(SEP);
  console.log(`  Diamond:           ${DIAMOND_ADDRESS}`);
  console.log(`  ArbitrationFacet: ${ARBITRATION_FACET_ADDRESS}`);
  console.log(`  Deployer:         ${deployer.address}`);
  console.log(SEP);

  // Load ArbitrationFacet ABI from Hardhat artifacts
  const artifactPath = join(process.cwd(), "artifacts/contracts/facets/ArbitrationFacet.sol/ArbitrationFacet.json");
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  const arbInterface = new ethers.Interface(artifact.abi);
  const functionSelectors = [
    arbInterface.getFunction("initArbitration").selector,
    arbInterface.getFunction("setArbitrationQuorum").selector,
    arbInterface.getFunction("setArbitrationVotingDuration").selector,
    arbInterface.getFunction("setArbitrationDisclosureDuration").selector,
    arbInterface.getFunction("setArbitrationCasToken").selector,
    arbInterface.getFunction("setMaxRevotes").selector,
    arbInterface.getFunction("fileArbitrationCase").selector,
    arbInterface.getFunction("castArbitrationVote").selector,
    arbInterface.getFunction("executeArbitrationCase").selector,
    arbInterface.getFunction("cancelArbitrationCase").selector,
    arbInterface.getFunction("handleExpiredCase").selector,
    arbInterface.getFunction("refileExpiredCase").selector,
    arbInterface.getFunction("getCase").selector,
    arbInterface.getFunction("getCaseCount").selector,
    arbInterface.getFunction("getCaseState").selector,
    arbInterface.getFunction("getVotingPeriod").selector,
    arbInterface.getFunction("isVotingLockActive").selector,
    arbInterface.getFunction("getArbitrationDisclosureDuration").selector,
    arbInterface.getFunction("getMaxRevotes").selector,
    arbInterface.getFunction("getRevoteCount").selector,
    arbInterface.getFunction("hasVotedInCase").selector,
    arbInterface.getFunction("isFrozenByArbitration").selector,
    arbInterface.getFunction("getArbitrationQuorum").selector,
    arbInterface.getFunction("getArbitrationVotingDuration").selector,
    arbInterface.getFunction("getArbitrationCasToken").selector,
    arbInterface.getFunction("getMaxRetries").selector,
    arbInterface.getFunction("getRetryFreezeDuration").selector,
    // Voting power: delegation
    arbInterface.getFunction("delegateArbitrationVote").selector,
    arbInterface.getFunction("clearArbitrationDelegation").selector,
    arbInterface.getFunction("getArbitrationDelegatee").selector,
    // Voting power: reputation & technical council
    arbInterface.getFunction("setReputation").selector,
    arbInterface.getFunction("getReputation").selector,
    arbInterface.getFunction("setTechnicalCouncilMember").selector,
    arbInterface.getFunction("isTechnicalCouncilMember").selector,
    // Voting power: config & views
    arbInterface.getFunction("setVotingPowerConfig").selector,
    arbInterface.getFunction("getVotingPower").selector,
    arbInterface.getFunction("getVotedPower").selector,
    // Challenge & appeal
    arbInterface.getFunction("challengeResult").selector,
    arbInterface.getFunction("resolveChallenge").selector,
    arbInterface.getFunction("finalizeCase").selector,
    arbInterface.getFunction("fileAppeal").selector,
    arbInterface.getFunction("getAppealCount").selector,
    arbInterface.getFunction("getChallengeDeadline").selector,
  ];

  log("INFO", "main", "Selectors to add", { count: functionSelectors.length, selectors: functionSelectors });

  const cut: [string, number, string[]][] = [
    [
      ARBITRATION_FACET_ADDRESS,
      0,
      functionSelectors,
    ],
  ];

  const initCalldata = arbInterface.encodeFunctionData("initArbitration", []);

  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? 0n;

  log("INFO", "main", "Executing diamond cut");
  await sendAndVerify(
    "diamondCut",
    diamond.diamondCut(cut, ARBITRATION_FACET_ADDRESS, initCalldata),
    gasPrice,
  );

  log("OK", "main", "Diamond cut complete — ArbitrationFacet added and initialized");

  const { CAS_TOKEN_ADDRESS } = await requireEnv(["CAS_TOKEN_ADDRESS"]);
  const arbitrationSetCas = arbInterface.encodeFunctionData("setArbitrationCasToken", [CAS_TOKEN_ADDRESS]);

  log("INFO", "main", "Setting CAS token address on ArbitrationFacet");
  const diamondWithArbitration = new ethers.Contract(
    DIAMOND_ADDRESS,
    arbInterface,
    deployer,
  );
  await sendAndVerify("setArbitrationCasToken", diamondWithArbitration.setArbitrationCasToken(CAS_TOKEN_ADDRESS), gasPrice);
  log("OK", "main", "CAS token address set on ArbitrationFacet");

  console.log(`\n${SEP}`);
  console.log("  Diamond cut completo. ArbitrationFacet ativo.");
  console.log(SEP);
}

main().catch((err) => {
  log("ERROR", "main", "Script failed", { error: err.message });
  process.exit(1);
});
