import "dotenv/config";
import { ethers } from "hardhat";
import { getDB } from "./utils/cas_database";
import { FraudDatabase, WhitelistService } from "agentic_space_commons";
import * as path from "path";

function log(level: string, fn: string, message: string, params?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").split(".")[0];
  const file = "scripts/21_dao_sanction_proposal.ts";
  const extra = params ? ` - ${JSON.stringify(params)}` : "";
  console.log(`[${ts}] [${file}:${fn}] ${level} ${message}${extra}`);
}

async function main(): Promise<void> {
  const caseIdStr = process.env.CASE_ID;
  if (!caseIdStr) {
    log("ERROR", "main", "Missing CASE_ID env var");
    process.exit(1);
  }
  const caseId = parseInt(caseIdStr, 10);

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
    "function executeArbitrationCase(uint256 caseId) external",
    "function getCase(uint256 caseId) view returns (tuple)",
    "function getCaseState(uint256 caseId) view returns (uint8)",
  ];

  const diamond = new ethers.Contract(DIAMOND_ADDRESS, ARBITRATION_ABI, deployer);

  const caseState = await diamond.getCaseState(caseId);
  log("INFO", "main", "Case state", { caseId, state: Number(caseState) });

  if (Number(caseState) !== 1) {
    log("ERROR", "main", "Case is not Active, cannot execute", { caseId, state: Number(caseState) });
    process.exit(1);
  }

  log("INFO", "main", "Executing arbitration case (DAO sanction)", { caseId });

  const tx = await diamond.executeArbitrationCase(caseId);
  const receipt = await tx.wait();
  log("OK", "main", "Arbitration case executed", { caseId, txHash: receipt!.hash });

  const db = getDB();
  const fraudDb = new FraudDatabase(db);

  const allRecords = fraudDb.getAllFraudAddresses();
  const caseRecord = allRecords.find((r) => r.caseId === caseId);
  if (caseRecord && whitelist.isWhitelisted(caseRecord.address)) {
    log("WARN", "main", "Endereço na whitelist — não executar sanção sobre inocentado", {
      caseId,
      address: caseRecord.address,
    });
    process.exit(1);
  }
  if (caseRecord) {
    fraudDb.markAsVoted(caseRecord.fraudDate, caseRecord.address, caseRecord.reason);
    log("OK", "main", "Record marked as voted in DB", { address: caseRecord.address });
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log("  DAO Sanction Proposal — Execution Complete");
  console.log("=".repeat(60));
  console.log(`  Case ID: ${caseId}`);
  console.log(`  Tx Hash: ${receipt!.hash}`);
  console.log("=".repeat(60));
}

main().catch((err: any) => {
  log("ERROR", "main", "Script failed", { error: err.message });
  process.exit(1);
});
