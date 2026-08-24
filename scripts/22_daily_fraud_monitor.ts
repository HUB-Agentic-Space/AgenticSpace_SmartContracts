import "dotenv/config";
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { getDB } from "./utils/cas_database";
import { FraudDatabase, parseFraudCsv, FraudStatus, VoteOutcome, WhitelistService } from "agentic_space_commons";

function log(level: string, fn: string, message: string, params?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").split(".")[0];
  const file = "scripts/22_daily_fraud_monitor.ts";
  const extra = params ? ` - ${JSON.stringify(params)}` : "";
  console.log(`[${ts}] [${file}:${fn}] ${level} ${message}${extra}`);
}

async function main(): Promise<void> {
  const csvPath = process.env.FRAUD_CSV_PATH ?? path.resolve(__dirname, "..", "data", "fraude.csv");
  const dryRun = (process.env.DRY_RUN ?? "false").toLowerCase() === "true";

  const { CAS_TOKEN_ADDRESS, DIAMOND_ADDRESS } = process.env;
  if (!CAS_TOKEN_ADDRESS || !DIAMOND_ADDRESS) {
    log("ERROR", "main", "Missing env vars");
    process.exit(1);
  }

  if (!fs.existsSync(csvPath)) {
    log("ERROR", "main", "CSV file not found", { csvPath });
    process.exit(1);
  }

  const SC_ROOT = path.resolve(__dirname, "..");
  const whitelist = WhitelistService.fromSmartContractsRoot(SC_ROOT);
  whitelist.load();
  log("INFO", "main", "Whitelist carregada", { entries: whitelist.size() });

  const [deployer] = await ethers.getSigners();

  const db = getDB();
  const fraudDb = new FraudDatabase(db);
  fraudDb.createTable();

  const csvContent = fs.readFileSync(csvPath, "utf-8");
  const parseResult = parseFraudCsv(csvContent);

  log("INFO", "main", "Daily monitor started", { csvRecords: parseResult.records.length, dryRun });

  const csvKeys = new Set(parseResult.records.map((r) => `${r.fraudDate}|${r.address.toLowerCase()}|${r.reason}`));

  const CAS_TOKEN_ABI = [
    "function freeze(address) external",
    "function freezeUntil(address, uint256) external",
    "function unfreeze(address) external",
    "function isFrozen(address) view returns (bool)",
  ];

  const ARBITRATION_ABI = [
    "function handleExpiredCase(uint256 caseId) external",
    "function getCaseState(uint256 caseId) view returns (uint8)",
  ];

  const casToken = new ethers.Contract(CAS_TOKEN_ADDRESS, CAS_TOKEN_ABI, deployer);
  const diamond = new ethers.Contract(DIAMOND_ADDRESS, ARBITRATION_ABI, deployer);

  let newRecords = 0;
  let removedRecords = 0;
  let expiredHandled = 0;
  let reincidences = 0;
  let whitelisted = 0;
  const errors: string[] = [];

  for (const record of parseResult.records) {
    if (whitelist.isWhitelisted(record.address)) {
      whitelisted++;
      log("INFO", "main", "Endereço na whitelist — pulando monitoramento", {
        address: record.address,
      });
      continue;
    }

    const existing = fraudDb.getFraudAddress(record.fraudDate, record.address, record.reason);
    if (!existing) {
      if (!dryRun) {
        fraudDb.upsertFraudAddress(record);
        try {
          if (record.freezeUntil) {
            const endTime = Math.floor(new Date(record.freezeUntil).getTime() / 1000);
            if (endTime > Math.floor(Date.now() / 1000)) {
              await casToken.freezeUntil(record.address, endTime);
            } else {
              await casToken.freeze(record.address);
            }
          } else {
            await casToken.freeze(record.address);
          }
        } catch (err: any) {
          errors.push(`freeze ${record.address}: ${err.message}`);
        }
      }
      newRecords++;
      log("OK", "main", "New fraud record detected", { address: record.address });
    }

    fraudDb.updateLastChecked(record.fraudDate, record.address, record.reason);
  }

  const dbRecords = fraudDb.getAllFraudAddresses();
  for (const dbRecord of dbRecords) {
    if (whitelist.isWhitelisted(dbRecord.address)) {
      continue;
    }

    const key = `${dbRecord.fraudDate}|${dbRecord.address.toLowerCase()}|${dbRecord.reason}`;
    if (!csvKeys.has(key) && !dbRecord.isVoted) {
      if (dbRecord.status === FraudStatus.TEMPORARIO) {
        if (!dryRun) {
          try {
            await casToken.unfreeze(dbRecord.address);
            fraudDb.removeFraudAddress(dbRecord.fraudDate, dbRecord.address, dbRecord.reason);
          } catch (err: any) {
            errors.push(`unfreeze ${dbRecord.address}: ${err.message}`);
          }
        }
        removedRecords++;
        log("OK", "main", "Removed (not in CSV, temporary)", { address: dbRecord.address });
      }
    }

    if (dbRecord.caseId !== null && !dbRecord.isVoted) {
      const now = new Date().toISOString().slice(0, 19);
      if (dbRecord.votingDeadline && now > dbRecord.votingDeadline) {
        if (!dryRun) {
          try {
            const caseState = await diamond.getCaseState(dbRecord.caseId);
            if (Number(caseState) === 1) {
              await diamond.handleExpiredCase(dbRecord.caseId);
              expiredHandled++;
              log("OK", "main", "Expired case handled", { caseId: dbRecord.caseId, address: dbRecord.address });
            }
          } catch (err: any) {
            errors.push(`handleExpired ${dbRecord.caseId}: ${err.message}`);
          }
        }
      }
    }

    if (dbRecord.isVoted && dbRecord.voteOutcome === VoteOutcome.AGAINST) {
      const reincidence = fraudDb.canReblock(dbRecord.address, new Date().toISOString().slice(0, 19));
      if (reincidence) {
        reincidences++;
        log("WARN", "main", "Reincidence detected — address can be re-blocked", { address: dbRecord.address });
      }
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log("  Daily Fraud Monitor Report");
  console.log("=".repeat(60));
  console.log(`  New Records:      ${newRecords}`);
  console.log(`  Removed Records:  ${removedRecords}`);
  console.log(`  Expired Handled:  ${expiredHandled}`);
  console.log(`  Reincidences:     ${reincidences}`);
  console.log(`  Whitelisted:      ${whitelisted}`);
  console.log(`  Errors:           ${errors.length}`);
  if (dryRun) console.log("  [DRY-RUN MODE]");
  console.log("=".repeat(60));
  if (errors.length > 0) {
    console.log("\n  Errors:");
    errors.forEach((e) => console.log(`    - ${e}`));
  }
}

main().catch((err: any) => {
  log("ERROR", "main", "Script failed", { error: err.message });
  process.exit(1);
});
