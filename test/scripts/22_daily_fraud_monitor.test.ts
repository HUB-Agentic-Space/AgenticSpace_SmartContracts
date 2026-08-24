import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import Database from "better-sqlite3";
import { FraudDatabase, parseFraudCsv, FraudStatus, VoteOutcome } from "agentic_space_commons";

describe("Script 22 — daily_fraud_monitor (logic test)", () => {
  const csvPath = path.resolve(__dirname, "..", "..", "data", "fraude.csv");

  it("should detect new records not in DB", () => {
    if (!fs.existsSync(csvPath)) return;
    const content = fs.readFileSync(csvPath, "utf-8");
    const csvResult = parseFraudCsv(content);

    const db = new Database(":memory:");
    const fraudDb = new FraudDatabase(db);
    fraudDb.createTable();

    let newCount = 0;
    for (const record of csvResult.records) {
      const existing = fraudDb.getFraudAddress(record.fraudDate, record.address, record.reason);
      if (!existing) newCount++;
    }
    expect(newCount).to.equal(csvResult.records.length);
    db.close();
  });

  it("should respect voted records (not mark as new)", () => {
    if (!fs.existsSync(csvPath)) return;
    const content = fs.readFileSync(csvPath, "utf-8");
    const csvResult = parseFraudCsv(content);

    const db = new Database(":memory:");
    const fraudDb = new FraudDatabase(db);
    fraudDb.createTable();

    // Insert and vote on first record
    if (csvResult.records.length > 0) {
      const first = csvResult.records[0];
      fraudDb.upsertFraudAddress(first);
      fraudDb.setVoteOutcome(first.fraudDate, first.address, first.reason, VoteOutcome.FOR);

      const existing = fraudDb.getFraudAddress(first.fraudDate, first.address, first.reason);
      expect(existing).to.not.be.null;
      expect(existing!.isVoted).to.be.true;
    }
    db.close();
  });

  it("should detect reincidence for pardoned addresses", () => {
    const db = new Database(":memory:");
    const fraudDb = new FraudDatabase(db);
    fraudDb.createTable();

    fraudDb.upsertFraudAddress({
      fraudDate: "2025-01-01",
      address: "0x1234",
      name: "Attacker",
      reason: "phishing",
      status: FraudStatus.A_FAZER,
      freezeUntil: null,
      votingDeadline: "2025-03-01",
      voteOutcome: VoteOutcome.PENDING,
      caseId: 1,
      daoProposalId: null,
      isVoted: false,
      firstSeen: null,
      lastChecked: null,
    });
    fraudDb.setVoteOutcome("2025-01-01", "0x1234", "phishing", VoteOutcome.AGAINST);

    const canReblock = fraudDb.canReblock("0x1234", "2025-06-01");
    expect(canReblock).to.be.true;
    db.close();
  });
});
