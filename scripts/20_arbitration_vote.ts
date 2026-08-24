import "dotenv/config";
import { ethers } from "hardhat";
import { getDB } from "./utils/cas_database";
import { FraudDatabase, VoteOutcome, WhitelistService } from "agentic_space_commons";
import * as path from "path";

function log(level: string, fn: string, message: string, params?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").split(".")[0];
  const file = "scripts/20_arbitration_vote.ts";
  const extra = params ? ` - ${JSON.stringify(params)}` : "";
  console.log(`[${ts}] [${file}:${fn}] ${level} ${message}${extra}`);
}

async function main(): Promise<void> {
  const caseIdStr = process.env.CASE_ID;
  const supportStr = process.env.SUPPORT;

  if (!caseIdStr || !supportStr) {
    log("ERROR", "main", "Missing env vars", { CASE_ID: !!caseIdStr, SUPPORT: !!supportStr });
    process.exit(1);
  }

  const caseId = parseInt(caseIdStr, 10);
  const support = parseInt(supportStr, 10);

  if (support < 0 || support > 2) {
    log("ERROR", "main", "Invalid support value (0=Against, 1=For, 2=Abstain)", { support });
    process.exit(1);
  }

  const { DIAMOND_ADDRESS, CAS_TOKEN_ADDRESS } = process.env;
  if (!DIAMOND_ADDRESS || !CAS_TOKEN_ADDRESS) {
    log("ERROR", "main", "Missing DIAMOND_ADDRESS or CAS_TOKEN_ADDRESS");
    process.exit(1);
  }

  const [deployer] = await ethers.getSigners();

  const SC_ROOT = path.resolve(__dirname, "..");
  const whitelist = WhitelistService.fromSmartContractsRoot(SC_ROOT);
  whitelist.load();

  const ARBITRATION_ABI = [
    "function castArbitrationVote(uint256 caseId, uint8 support) external",
    "function getCase(uint256 caseId) view returns (tuple)",
    "function getCaseState(uint256 caseId) view returns (uint8)",
  ];

  const CAS_TOKEN_ABI = [
    "function approve(address, uint256) external",
    "function allowance(address, address) view returns (uint256)",
    "function isFrozen(address) view returns (bool)",
  ];

  const diamond = new ethers.Contract(DIAMOND_ADDRESS, ARBITRATION_ABI, deployer);
  const casToken = new ethers.Contract(CAS_TOKEN_ADDRESS, CAS_TOKEN_ABI, deployer);

  const isFrozen = await casToken.isFrozen(deployer.address);
  if (isFrozen) {
    log("ERROR", "main", "Voter is frozen and cannot vote", { voter: deployer.address });
    process.exit(1);
  }

  const feeAmount = ethers.parseEther("0.5");
  const allowance = await casToken.allowance(deployer.address, DIAMOND_ADDRESS);
  if (allowance < feeAmount) {
    await casToken.approve(DIAMOND_ADDRESS, feeAmount);
    log("OK", "main", "Approved CAS for voting fee", { amount: "0.5 CAS" });
  }

  log("INFO", "main", "Casting arbitration vote", { caseId, support, voter: deployer.address });

  const tx = await diamond.castArbitrationVote(caseId, support);
  const receipt = await tx.wait();
  log("OK", "main", "Vote cast", { caseId, support, txHash: receipt!.hash });

  const db = getDB();
  const fraudDb = new FraudDatabase(db);

  const allRecords = fraudDb.getAllFraudAddresses();
  const caseRecord = allRecords.find((r) => r.caseId === caseId);
  if (caseRecord && whitelist.isWhitelisted(caseRecord.address)) {
    log("WARN", "main", "Endereço na whitelist — não é possível votar em caso de endereço inocentado", {
      caseId,
      address: caseRecord.address,
    });
    process.exit(1);
  }
  if (caseRecord) {
    const outcome = support === 1 ? VoteOutcome.FOR : support === 0 ? VoteOutcome.AGAINST : VoteOutcome.PENDING;
    if (support !== 2) {
      fraudDb.setVoteOutcome(caseRecord.fraudDate, caseRecord.address, caseRecord.reason, outcome);
      log("OK", "main", "Vote outcome recorded in DB", { outcome });
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log("  Arbitration Vote Complete");
  console.log("=".repeat(60));
  console.log(`  Case ID: ${caseId}`);
  console.log(`  Support: ${support} (${support === 0 ? "Against" : support === 1 ? "For" : "Abstain"})`);
  console.log(`  Voter:   ${deployer.address}`);
  console.log("=".repeat(60));
}

main().catch((err: any) => {
  log("ERROR", "main", "Script failed", { error: err.message });
  process.exit(1);
});
