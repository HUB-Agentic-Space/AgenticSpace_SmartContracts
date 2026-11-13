import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import { parseFraudCsv, FraudStatus, VoteOutcome, WhitelistService } from "agentic_space_commons";

describe("Script 19 — freeze_fraud_addresses (smoke test)", () => {
  const csvPath = path.resolve(__dirname, "..", "..", "data", "fraude.csv");

  it("should have a fraud CSV file at data/fraude.csv", () => {
    expect(fs.existsSync(csvPath), `Expected CSV at ${csvPath}`).to.be.true;
  });

  it("should parse the real CSV without duplicates", () => {
    if (!fs.existsSync(csvPath)) return;
    const content = fs.readFileSync(csvPath, "utf-8");
    const result = parseFraudCsv(content);
    expect(result.duplicates).to.have.length(0);
    expect(result.records.length).to.be.greaterThan(0);
  });

  it("should parse records with valid statuses", () => {
    if (!fs.existsSync(csvPath)) return;
    const content = fs.readFileSync(csvPath, "utf-8");
    const result = parseFraudCsv(content);
    for (const record of result.records) {
      expect(Object.values(FraudStatus)).to.include(record.status);
    }
  });

  it("should normalize addresses to lowercase", () => {
    if (!fs.existsSync(csvPath)) return;
    const content = fs.readFileSync(csvPath, "utf-8");
    const result = parseFraudCsv(content);
    for (const record of result.records) {
      expect(record.address).to.equal(record.address.toLowerCase());
    }
  });

  it("should identify whitelisted addresses present in the fraud CSV", () => {
    const scRoot = path.resolve(__dirname, "..", "..");
    const whitelistPath = path.join(scRoot, "data", "whitelist.csv");
    if (!fs.existsSync(csvPath) || !fs.existsSync(whitelistPath)) return;

    const whitelist = WhitelistService.fromSmartContractsRoot(scRoot);
    whitelist.load();
    expect(whitelist.size()).to.be.greaterThan(0);

    const content = fs.readFileSync(csvPath, "utf-8");
    const result = parseFraudCsv(content);

    let whitelistedInFraud = 0;
    for (const record of result.records) {
      if (whitelist.isWhitelisted(record.address)) {
        whitelistedInFraud++;
      }
    }

    expect(whitelistedInFraud).to.be.greaterThan(0, "Nenhum endereço da whitelist foi encontrado no fraude.csv");
  });
});
