import "dotenv/config";
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { getDB } from "./utils/cas_database";
import { FraudDatabase, parseFraudCsv, FraudStatus, WhitelistService } from "agentic_space_commons";

function log(level: string, fn: string, message: string, params?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").split(".")[0];
  const file = "scripts/19_freeze_fraud_addresses.ts";
  const extra = params ? ` - ${JSON.stringify(params)}` : "";
  console.log(`[${ts}] [${file}:${fn}] ${level} ${message}${extra}`);
}

async function main(): Promise<void> {
  const csvPath = process.env.FRAUD_CSV_PATH ?? path.resolve(__dirname, "..", "data", "fraude.csv");
  const dryRun = (process.env.DRY_RUN ?? "false").toLowerCase() === "true";

  const { CAS_TOKEN_ADDRESS, DIAMOND_ADDRESS } = process.env;
  if (!CAS_TOKEN_ADDRESS || !DIAMOND_ADDRESS) {
    log("ERROR", "main", "Missing env vars", { CAS_TOKEN_ADDRESS: !!CAS_TOKEN_ADDRESS, DIAMOND_ADDRESS: !!DIAMOND_ADDRESS });
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

  if (parseResult.warnings.length > 0) {
    log("WARN", "main", "CSV parsing warnings", { warnings: parseResult.warnings });
  }

  if (parseResult.duplicates.length > 0) {
    log("ERROR", "main", "Duplicate composite keys in CSV", { duplicates: parseResult.duplicates });
    process.exit(1);
  }

  log("INFO", "main", "CSV parsed", { records: parseResult.records.length, dryRun });

  const CAS_TOKEN_ABI = [
    "function freeze(address) external",
    "function freezeUntil(address, uint256) external",
    "function unfreeze(address) external",
    "function isFrozen(address) view returns (bool)",
    "function approve(address, uint256) external",
    "function allowance(address, address) view returns (uint256)",
  ];

  const ARBITRATION_ABI = [
    "function fileArbitrationCase(address[] accused, string[] reasons, bytes32 evidenceHash, uint8 freezeType, uint256 freezeUntilTime) external returns (uint256)",
    "function getCaseCount() view returns (uint256)",
  ];

  const casToken = new ethers.Contract(CAS_TOKEN_ADDRESS, CAS_TOKEN_ABI, deployer);
  const diamond = new ethers.Contract(DIAMOND_ADDRESS, ARBITRATION_ABI, deployer);

  const feeData = await ethers.provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? 0n;

  let processed = 0;
  let frozen = 0;
  let casesCreated = 0;
  let skipped = 0;
  let whitelisted = 0;
  const errors: Array<{ address: string; error: string }> = [];

  for (const record of parseResult.records) {
    processed++;

    if (whitelist.isWhitelisted(record.address)) {
      whitelisted++;
      const wl = whitelist.getRecord(record.address);
      log("INFO", "main", "Endereço na whitelist — pulando freeze e arbitragem", {
        address: record.address,
        reason: wl?.reason,
      });
      continue;
    }

    const existing = fraudDb.getFraudAddress(record.fraudDate, record.address, record.reason);
    if (existing && existing.isVoted) {
      skipped++;
      log("INFO", "main", "Skipping voted record", { address: record.address });
      continue;
    }

    if (!existing) {
      fraudDb.upsertFraudAddress(record);
      log("OK", "main", "Inserted fraud record", { address: record.address });
    }

    if (dryRun) {
      log("INFO", "main", "[DRY-RUN] Would freeze and create case", { address: record.address });
      frozen++;
      casesCreated++;
      continue;
    }

    try {
      const isAlreadyFrozen = await casToken.isFrozen(record.address);
      if (!isAlreadyFrozen) {
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
        frozen++;
        log("OK", "main", "Freeze applied", { address: record.address, freezeUntil: record.freezeUntil });
      }

      const feeAmount = ethers.parseEther("5");
      const allowance = await casToken.allowance(deployer.address, DIAMOND_ADDRESS);
      if (allowance < feeAmount) {
        await casToken.approve(DIAMOND_ADDRESS, feeAmount);
        log("OK", "main", "Approved CAS for arbitration fee", { amount: "5 CAS" });
      }

      const freezeType = record.freezeUntil ? 0 : 1;
      const freezeUntilTime = record.freezeUntil
        ? Math.floor(new Date(record.freezeUntil).getTime() / 1000)
        : 0;

      const tx = await diamond.fileArbitrationCase(
        [record.address],
        [record.reason],
        ethers.ZeroHash,
        freezeType,
        freezeUntilTime,
      );
      const receipt = await tx.wait();
      log("OK", "main", "Arbitration case created", { address: record.address, txHash: receipt!.hash });

      const caseCount = await diamond.getCaseCount();
      const caseId = Number(caseCount);

      fraudDb.setCaseId(record.fraudDate, record.address, record.reason, caseId);
      const votingDeadline = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 19);
      fraudDb.setVotingDeadline(record.fraudDate, record.address, record.reason, votingDeadline);
      casesCreated++;
    } catch (err: any) {
      errors.push({ address: record.address, error: err.message });
      log("ERROR", "main", "Failed to process record", { address: record.address, error: err.message });
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log("  Freeze + Arbitration Summary");
  console.log("=".repeat(60));
  console.log(`  Processed:     ${processed}`);
  console.log(`  Frozen:        ${frozen}`);
  console.log(`  Cases Created: ${casesCreated}`);
  console.log(`  Skipped:       ${skipped}`);
  console.log(`  Whitelisted:   ${whitelisted}`);
  console.log(`  Errors:        ${errors.length}`);
  if (dryRun) console.log("  [DRY-RUN MODE]");
  console.log("=".repeat(60));
}

main().catch((err) => {
  log("ERROR", "main", "Script failed", { error: err.message });
  process.exit(1);
});
