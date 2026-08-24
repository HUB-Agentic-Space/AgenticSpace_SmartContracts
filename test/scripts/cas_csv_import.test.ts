import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseCsv, findHeaderRow, detectColumns, importAllCsvs } from "../../scripts/utils/cas_csv_import";
import { getAllAddresses, getAddress, closeDB } from "../../scripts/utils/cas_database";

function getRoles(record: { roles: string }): string[] {
  try {
    return JSON.parse(record.roles || "[]");
  } catch {
    return [];
  }
}

describe("cas_csv_import — detecção semântica de colunas e whitelist", () => {
  describe("pure functions", () => {
    it("should detect columns from the real fraude.csv", () => {
      const csvPath = path.resolve(__dirname, "..", "..", "data", "fraude.csv");
      if (!fs.existsSync(csvPath)) return;

      const content = fs.readFileSync(csvPath, "utf-8");
      const rows = parseCsv(content);
      const headerIdx = findHeaderRow(rows);
      const headers = rows[headerIdx];
      const dataRows = rows.slice(headerIdx + 1);
      const columns = detectColumns(headers, dataRows.slice(0, 10));

      expect(columns.addressCol).to.be.greaterThan(-1);
      expect(columns.nameCol).to.be.greaterThan(-1);
    });

    it("should detect columns from the real whitelist.csv", () => {
      const csvPath = path.resolve(__dirname, "..", "..", "data", "whitelist.csv");
      if (!fs.existsSync(csvPath)) return;

      const content = fs.readFileSync(csvPath, "utf-8");
      const rows = parseCsv(content);
      const headerIdx = findHeaderRow(rows);
      const headers = rows[headerIdx];
      const dataRows = rows.slice(headerIdx + 1);
      const columns = detectColumns(headers, dataRows.slice(0, 10));

      expect(columns.addressCol).to.equal(1);
      expect(columns.nameCol).to.equal(0);
    });
  });

  describe("importAllCsvs whitelist integration", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cas-csv-test-"));
      process.env.CAS_DB_PATH = path.join(tmpDir, "test.db");
    });

    afterEach(() => {
      closeDB();
      delete process.env.CAS_DB_PATH;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("should import real CSVs and mark whitelisted addresses", () => {
      const dataDir = path.resolve(__dirname, "..", "..", "data");
      const results = importAllCsvs(dataDir);
      const totalImported = results.reduce((s, r) => s + r.imported, 0);
      expect(totalImported).to.be.greaterThan(0);

      const addresses = getAllAddresses();
      const whitelisted = addresses.filter((a) => getRoles(a).includes("whitelisted"));
      expect(whitelisted.length).to.be.greaterThan(0);

      const maycon = getAddress("0xcb8bb6bef70b288bf1767766b55947e2650d7dc2");
      expect(maycon).to.not.be.undefined;
      expect(getRoles(maycon!)).to.include("whitelisted");
      expect(maycon!.name).to.equal("Maycon");
      expect(maycon!.notes).to.not.include("Pump and Dump");
    });

    it("should mark non-whitelisted fraud addresses as fraud_suspect", () => {
      const fraudAddr = "0x1111111111111111111111111111111111111111";
      const wlAddr = "0x2222222222222222222222222222222222222222";

      fs.writeFileSync(
        path.join(tmpDir, "fraude.csv"),
        `Data,Nome,Endereço,Tipo Fraude\n01/01/2025,Attacker,${fraudAddr},phishing\n01/01/2025,Safe,${wlAddr},mistake\n`,
      );
      fs.writeFileSync(
        path.join(tmpDir, "whitelist.csv"),
        `Nome,Endereço,motivo\nSafe,${wlAddr},Endereço validado e isento de classificação fraudulenta\n`,
      );

      const results = importAllCsvs(tmpDir);
      expect(results).to.have.length(2);

      const fraudRecord = getAddress(fraudAddr);
      expect(fraudRecord).to.not.be.undefined;
      expect(getRoles(fraudRecord!)).to.include("fraud_suspect");
      expect(getRoles(fraudRecord!)).to.not.include("whitelisted");

      const wlRecord = getAddress(wlAddr);
      expect(wlRecord).to.not.be.undefined;
      expect(getRoles(wlRecord!)).to.include("whitelisted");
      expect(getRoles(wlRecord!)).to.not.include("fraud_suspect");
      expect(wlRecord!.notes).to.include("isento");
    });
  });
});
