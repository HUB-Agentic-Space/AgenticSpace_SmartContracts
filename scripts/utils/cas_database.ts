/**
 * CAS Database — SQLite para rastreamento de endereços e transações.
 *
 * Tabelas:
 *   - addresses: endereços com label/nome (até 100 chars), tipo, metadata
 *   - transactions: transferências CAS sincronizadas do Polygonscan
 *   - pool_creations: criação de pools DEX com identificação do criador
 *   - sync_state: controle de última sincronização
 *
 * Padrões: Factory (getInstance — singleton), DAO (data access objects)
 */

import Database from "better-sqlite3";
import * as path from "path";
import * as fs from "fs";

function getDbPath(): string {
  if (process.env.CAS_DB_PATH) {
    return path.resolve(process.env.CAS_DB_PATH);
  }
  return path.join(path.resolve(__dirname, "..", "..", "data"), "cas_tracker.db");
}

let _instance: Database.Database | null = null;

export interface AddressRecord {
  address: string;
  name: string;
  label: string;
  type: string;
  is_contract: number;
  asset: string;
  roles: string;
  first_seen: string | null;
  last_seen: string | null;
  total_received: string;
  total_sent: string;
  tx_count: number;
  notes: string;
  created_at: string;
  updated_at: string;
}

export interface TransactionRecord {
  tx_hash: string;
  block_number: number;
  timestamp: number;
  from_address: string;
  to_address: string;
  value: string;
  is_mint: number;
  is_burn: number;
  label: string;
  description: string;
  created_at: string;
}

export interface PoolCreationRecord {
  pair_address: string;
  factory_address: string;
  creator_address: string;
  token0: string;
  token1: string;
  tx_hash: string;
  block_number: number;
  timestamp: number;
  dex_name: string;
  created_at: string;
}

export interface SyncState {
  key: string;
  value: string;
  updated_at: string;
}

function log(level: "INFO" | "WARN" | "ERROR" | "OK", fn: string, msg: string, p?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const emoji = { INFO: "ℹ️", WARN: "⚠️", ERROR: "❌", OK: "✅" }[level];
  console.log(`[${ts}] [cas_database:${fn}] ${emoji} ${msg}${p ? ` - ${JSON.stringify(p)}` : ""}`);
}

export function getDB(): Database.Database {
  if (_instance) return _instance;

  const dbPath = getDbPath();
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  initSchema(db);
  _instance = db;
  log("OK", "getDB", "Banco inicializado", { path: dbPath });
  return db;
}

export function closeDB(): void {
  if (_instance) {
    _instance.close();
    _instance = null;
    log("INFO", "closeDB", "Banco fechado");
  }
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS addresses (
      address       TEXT PRIMARY KEY,
      name          TEXT NOT NULL DEFAULT '',
      label         TEXT NOT NULL DEFAULT '',
      type          TEXT NOT NULL DEFAULT 'unknown',
      is_contract   INTEGER NOT NULL DEFAULT 0,
      asset         TEXT NOT NULL DEFAULT '',
      first_seen    TEXT,
      last_seen     TEXT,
      total_received TEXT NOT NULL DEFAULT '0',
      total_sent    TEXT NOT NULL DEFAULT '0',
      tx_count      INTEGER NOT NULL DEFAULT 0,
      notes         TEXT NOT NULL DEFAULT '',
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS transactions (
      tx_hash       TEXT NOT NULL,
      block_number  INTEGER NOT NULL,
      timestamp     INTEGER NOT NULL,
      from_address  TEXT NOT NULL,
      to_address    TEXT NOT NULL,
      value         TEXT NOT NULL,
      is_mint       INTEGER NOT NULL DEFAULT 0,
      is_burn       INTEGER NOT NULL DEFAULT 0,
      label         TEXT NOT NULL DEFAULT '',
      description   TEXT NOT NULL DEFAULT '',
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (tx_hash, from_address, to_address, block_number)
    );

    CREATE INDEX IF NOT EXISTS idx_tx_from ON transactions(from_address);
    CREATE INDEX IF NOT EXISTS idx_tx_to ON transactions(to_address);
    CREATE INDEX IF NOT EXISTS idx_tx_block ON transactions(block_number);
    CREATE INDEX IF NOT EXISTS idx_tx_timestamp ON transactions(timestamp);

    CREATE TABLE IF NOT EXISTS sync_state (
      key           TEXT PRIMARY KEY,
      value         TEXT NOT NULL,
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pool_creations (
      pair_address    TEXT PRIMARY KEY,
      factory_address TEXT NOT NULL,
      creator_address TEXT NOT NULL,
      token0          TEXT NOT NULL,
      token1          TEXT NOT NULL,
      tx_hash         TEXT NOT NULL,
      block_number    INTEGER NOT NULL,
      timestamp       INTEGER NOT NULL,
      dex_name        TEXT NOT NULL DEFAULT '',
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_pool_creator ON pool_creations(creator_address);
    CREATE INDEX IF NOT EXISTS idx_pool_factory ON pool_creations(factory_address);
    CREATE INDEX IF NOT EXISTS idx_pool_token0 ON pool_creations(token0);
    CREATE INDEX IF NOT EXISTS idx_pool_token1 ON pool_creations(token1);

    CREATE TABLE IF NOT EXISTS private_keys (
      address       TEXT PRIMARY KEY,
      name          TEXT NOT NULL DEFAULT '',
      env_key       TEXT NOT NULL DEFAULT '',
      private_key   TEXT NOT NULL DEFAULT '',
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_pk_name ON private_keys(name);

    CREATE TABLE IF NOT EXISTS fraud_addresses (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      fraud_date      TEXT NOT NULL,
      address         TEXT NOT NULL,
      name            TEXT NOT NULL DEFAULT '',
      reason          TEXT NOT NULL DEFAULT '',
      status          TEXT NOT NULL DEFAULT 'a_fazer',
      freeze_until    TEXT,
      voting_deadline TEXT,
      vote_outcome    TEXT,
      case_id         INTEGER,
      dao_proposal_id INTEGER,
      is_voted        INTEGER NOT NULL DEFAULT 0,
      first_seen      TEXT NOT NULL DEFAULT (datetime('now')),
      last_checked    TEXT NOT NULL DEFAULT (datetime('now')),
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(fraud_date, address, reason)
    );

    CREATE INDEX IF NOT EXISTS idx_fraud_address ON fraud_addresses(address);
    CREATE INDEX IF NOT EXISTS idx_fraud_status ON fraud_addresses(status);
    CREATE INDEX IF NOT EXISTS idx_fraud_voted ON fraud_addresses(is_voted);
    CREATE INDEX IF NOT EXISTS idx_fraud_case_id ON fraud_addresses(case_id);
  `);

  // ── Migrations for pre-existing databases ────────────────────────────
  migrateColumn(db, "addresses", "name", "TEXT NOT NULL DEFAULT ''");
  migrateColumn(db, "addresses", "asset", "TEXT NOT NULL DEFAULT ''");
  migrateColumn(db, "transactions", "label", "TEXT NOT NULL DEFAULT ''");
  migrateColumn(db, "transactions", "description", "TEXT NOT NULL DEFAULT ''");
  migrateColumn(db, "addresses", "roles", "TEXT NOT NULL DEFAULT ''");
}

function migrateColumn(db: Database.Database, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
    log("OK", "migrateColumn", `Coluna adicionada`, { table, column });
  }
}

// ── Address DAO ───────────────────────────────────────────────────────

export function upsertAddress(addr: string, label?: string, type?: string, isContract?: boolean, asset?: string): void {
  const db = getDB();
  const normalized = addr.toLowerCase();
  const existing = db.prepare("SELECT address FROM addresses WHERE address = ?").get(normalized) as { address: string } | undefined;

  if (existing) {
    const updates: string[] = [];
    const values: (string | number)[] = [];
    if (label !== undefined && label.length <= 100) { updates.push("label = ?"); values.push(label); }
    if (type !== undefined) { updates.push("type = ?"); values.push(type); }
    if (isContract !== undefined) { updates.push("is_contract = ?"); values.push(isContract ? 1 : 0); }
    if (asset !== undefined && asset.length <= 20) { updates.push("asset = ?"); values.push(asset); }
    if (updates.length === 0) return;
    updates.push("updated_at = datetime('now')");
    values.push(normalized);
    db.prepare(`UPDATE addresses SET ${updates.join(", ")} WHERE address = ?`).run(...values);
  } else {
    db.prepare(`INSERT INTO addresses (address, label, type, is_contract, asset) VALUES (?, ?, ?, ?, ?)`).run(
      normalized,
      (label ?? "").slice(0, 100),
      type ?? "unknown",
      isContract ? 1 : 0,
      (asset ?? "").slice(0, 20),
    );
  }
}

export function setAddressName(addr: string, name: string): void {
  const db = getDB();
  const normalized = addr.toLowerCase();
  const existing = db.prepare("SELECT address FROM addresses WHERE address = ?").get(normalized) as { address: string } | undefined;
  if (existing) {
    db.prepare("UPDATE addresses SET name = ?, updated_at = datetime('now') WHERE address = ?").run(name.slice(0, 200), normalized);
  } else {
    db.prepare("INSERT INTO addresses (address, name, type) VALUES (?, ?, 'unknown')").run(normalized, name.slice(0, 200));
  }
  log("OK", "setAddressName", "Nome definido", { address: normalized, name: name.slice(0, 50) });
}

export function setAddressLabel(addr: string, label: string): void {
  if (label.length > 100) throw new Error("Label exceeds 100 characters");
  upsertAddress(addr, label);
}

export function setAddressDescription(addr: string, description: string): void {
  setNotes(addr, description);
}


export function getAddress(addr: string): AddressRecord | undefined {
  const db = getDB();
  return db.prepare("SELECT * FROM addresses WHERE address = ?").get(addr.toLowerCase()) as AddressRecord | undefined;
}

export function getAddressesByRole(role: string): AddressRecord[] {
  const db = getDB();
  const pattern = `%"${role}"%`;
  return db.prepare("SELECT * FROM addresses WHERE roles LIKE ? ORDER BY label").all(pattern) as AddressRecord[];
}

export function setAddressRoles(addr: string, roles: string[]): void {
  const db = getDB();
  const normalized = addr.toLowerCase();
  const rolesJson = JSON.stringify(roles);
  const existing = db.prepare("SELECT address FROM addresses WHERE address = ?").get(normalized) as { address: string } | undefined;
  if (existing) {
    db.prepare("UPDATE addresses SET roles = ?, updated_at = datetime('now') WHERE address = ?").run(rolesJson, normalized);
  } else {
    db.prepare("INSERT INTO addresses (address, roles) VALUES (?, ?)").run(normalized, rolesJson);
  }
  log("OK", "setAddressRoles", "Roles definidas", { address: normalized, roles });
}

export function addAddressRole(addr: string, role: string): void {
  const db = getDB();
  const normalized = addr.toLowerCase();
  const rec = getAddress(normalized);
  let roles: string[] = [];
  if (rec && rec.roles) {
    try { roles = JSON.parse(rec.roles); } catch { roles = []; }
  }
  if (!roles.includes(role)) {
    roles.push(role);
    setAddressRoles(normalized, roles);
  }
}

export function getAllAddresses(): AddressRecord[] {
  const db = getDB();
  return db.prepare("SELECT * FROM addresses ORDER BY updated_at DESC").all() as AddressRecord[];
}

export function getAddressesByType(type: string): AddressRecord[] {
  const db = getDB();
  return db.prepare("SELECT * FROM addresses WHERE type = ? ORDER BY label").all(type) as AddressRecord[];
}

export function searchAddresses(query: string): AddressRecord[] {
  const db = getDB();
  const like = `%${query.toLowerCase()}%`;
  return db.prepare("SELECT * FROM addresses WHERE address LIKE ? OR label LIKE ? OR notes LIKE ? ORDER BY updated_at DESC").all(like, like, like) as AddressRecord[];
}

/**
 * Resolves a shortened address (e.g. "0xc590…c02b", "0xc590…", "0x…c02b")
 * to the closest matching full address in the database.
 *
 * Accepts both "…" (U+2026) and "..." (three dots) as ellipsis.
 * Returns the full lowercase address, or null if no match is found.
 */
export function resolveShortAddress(input: string): string | null {
  const normalized = input.trim().replace(/\.\.\./g, "…");

  // Full address — return as-is
  if (/^0x[0-9a-fA-F]{40}$/.test(normalized)) {
    return normalized.toLowerCase();
  }

  // Must start with 0x and contain an ellipsis
  if (!normalized.startsWith("0x") || !normalized.includes("…")) {
    return null;
  }

  const parts = normalized.split("…");
  const prefix = parts[0] ?? ""; // e.g. "0xc590"
  const suffix = parts[1] ?? "";  // e.g. "c02b"

  // Remove "0x" from prefix for hex comparison
  const hexPrefix = prefix.replace(/^0x/i, "").toLowerCase();
  const hexSuffix = suffix.toLowerCase();

  // Both parts must be valid hex (or empty)
  if (hexPrefix && !/^[0-9a-f]+$/.test(hexPrefix)) return null;
  if (hexSuffix && !/^[0-9a-f]+$/.test(hexSuffix)) return null;

  // Need at least one part to search
  if (!hexPrefix && !hexSuffix) return null;

  const db = getDB();
  let sql: string;
  let params: string[];

  if (hexPrefix && hexSuffix) {
    sql = "SELECT address FROM addresses WHERE address LIKE ? AND address LIKE ? ORDER BY updated_at DESC LIMIT 1";
    params = [`0x${hexPrefix}%`, `%${hexSuffix}`];
  } else if (hexPrefix) {
    sql = "SELECT address FROM addresses WHERE address LIKE ? ORDER BY updated_at DESC LIMIT 1";
    params = [`0x${hexPrefix}%`];
  } else {
    sql = "SELECT address FROM addresses WHERE address LIKE ? ORDER BY updated_at DESC LIMIT 1";
    params = [`%${hexSuffix}`];
  }

  const row = db.prepare(sql).get(...params) as { address: string } | undefined;
  return row?.address ?? null;
}

export function setNotes(addr: string, notes: string): void {
  const db = getDB();
  const normalized = addr.toLowerCase();
  db.prepare("UPDATE addresses SET notes = ?, updated_at = datetime('now') WHERE address = ?").run(notes, normalized);
}

// ── Transaction DAO ───────────────────────────────────────────────────

export function insertTransaction(tx: Omit<TransactionRecord, "created_at">): void {
  const db = getDB();
  db.prepare(`INSERT OR IGNORE INTO transactions
    (tx_hash, block_number, timestamp, from_address, to_address, value, is_mint, is_burn, label, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    tx.tx_hash,
    tx.block_number,
    tx.timestamp,
    tx.from_address.toLowerCase(),
    tx.to_address.toLowerCase(),
    tx.value,
    tx.is_mint,
    tx.is_burn,
    tx.label ?? "",
    tx.description ?? "",
  );
}

export function setTransactionLabel(txHash: string, label: string): void {
  const db = getDB();
  const updated = db.prepare(
    `UPDATE transactions SET label = ? WHERE tx_hash = ?`
  ).run(label.slice(0, 200), txHash.toLowerCase());
  if (updated.changes === 0) {
    log("WARN", "setTransactionLabel", "Transação não encontrada no banco", { txHash: txHash.slice(0, 20) });
  } else {
    log("OK", "setTransactionLabel", "Label definido", { txHash: txHash.slice(0, 20), label: label.slice(0, 50) });
  }
}

export function setTransactionDescription(txHash: string, description: string): void {
  const db = getDB();
  const updated = db.prepare(
    `UPDATE transactions SET description = ? WHERE tx_hash = ?`
  ).run(description, txHash.toLowerCase());
  if (updated.changes === 0) {
    log("WARN", "setTransactionDescription", "Transação não encontrada no banco", { txHash: txHash.slice(0, 20) });
  } else {
    log("OK", "setTransactionDescription", "Descrição definida", { txHash: txHash.slice(0, 20) });
  }
}

export function getTransactionsByHash(txHash: string): TransactionRecord[] {
  const db = getDB();
  return db.prepare("SELECT * FROM transactions WHERE tx_hash = ? ORDER BY block_number").all(txHash.toLowerCase()) as TransactionRecord[];
}

export function getTransactionsByAddress(addr: string, limit?: number): TransactionRecord[] {
  const db = getDB();
  const normalized = addr.toLowerCase();
  const sql = `SELECT * FROM transactions WHERE from_address = ? OR to_address = ? ORDER BY timestamp DESC${limit ? ` LIMIT ${limit}` : ""}`;
  return db.prepare(sql).all(normalized, normalized) as TransactionRecord[];
}

export function getAllTransactions(limit?: number): TransactionRecord[] {
  const db = getDB();
  const sql = `SELECT * FROM transactions ORDER BY timestamp DESC${limit ? ` LIMIT ${limit}` : ""}`;
  return db.prepare(sql).all() as TransactionRecord[];
}

export function getTransactionCount(): number {
  const db = getDB();
  const row = db.prepare("SELECT COUNT(*) as count FROM transactions").get() as { count: number };
  return row.count;
}

export function getLastBlockNumber(): number {
  const db = getDB();
  const row = db.prepare("SELECT MAX(block_number) as max_block FROM transactions").get() as { max_block: number | null };
  return row.max_block ?? 0;
}

// ── Sync State DAO ────────────────────────────────────────────────────

export function getSyncState(key: string): string | undefined {
  const db = getDB();
  const row = db.prepare("SELECT value FROM sync_state WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSyncState(key: string, value: string): void {
  const db = getDB();
  db.prepare(`INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`).run(key, value);
}

// ── CSV Import Tracking ───────────────────────────────────────────────

export function getCsvImportTime(fileName: string): string | undefined {
  return getSyncState(`csv_import:${fileName}`);
}

export function setCsvImportTime(fileName: string, fileMtime: string): void {
  setSyncState(`csv_import:${fileName}`, fileMtime);
  log("OK", "setCsvImportTime", "Timestamp de importação CSV registrado", { file: fileName, mtime: fileMtime });
}

// ── Address balance update from transactions ──────────────────────────

export function recalculateAddressStats(addr: string): void {
  const db = getDB();
  const normalized = addr.toLowerCase();

  // Use BigInt arithmetic via JS instead of SQL CAST to avoid integer overflow
  const receivedRows = db.prepare("SELECT value FROM transactions WHERE to_address = ?").all(normalized) as { value: string }[];
  const sentRows = db.prepare("SELECT value FROM transactions WHERE from_address = ?").all(normalized) as { value: string }[];
  const countRow = db.prepare("SELECT COUNT(*) as count FROM transactions WHERE from_address = ? OR to_address = ?").get(normalized, normalized) as { count: number };
  const firstTx = db.prepare("SELECT MIN(timestamp) as ts FROM transactions WHERE from_address = ? OR to_address = ?").get(normalized, normalized) as { ts: number | null };
  const lastTx = db.prepare("SELECT MAX(timestamp) as ts FROM transactions WHERE from_address = ? OR to_address = ?").get(normalized, normalized) as { ts: number | null };

  let totalReceived = 0n;
  for (const r of receivedRows) totalReceived += BigInt(r.value || "0");
  let totalSent = 0n;
  for (const r of sentRows) totalSent += BigInt(r.value || "0");

  const firstSeen = firstTx.ts ? new Date(firstTx.ts * 1000).toISOString() : null;
  const lastSeen = lastTx.ts ? new Date(lastTx.ts * 1000).toISOString() : null;

  db.prepare(`UPDATE addresses SET total_received = ?, total_sent = ?, tx_count = ?, first_seen = ?, last_seen = ?, updated_at = datetime('now') WHERE address = ?`).run(
    totalReceived.toString(),
    totalSent.toString(),
    countRow.count,
    firstSeen,
    lastSeen,
    normalized,
  );
}

export function recalculateAllAddressStats(): void {
  const db = getDB();
  const addresses = db.prepare("SELECT address FROM addresses").all() as { address: string }[];
  for (const a of addresses) {
    recalculateAddressStats(a.address);
  }
  log("OK", "recalculateAllAddressStats", "Estatísticas recalculadas", { count: addresses.length });
}

// ── Label lookup for dashboard integration ────────────────────────────

export function getLabelMap(): Map<string, string> {
  const db = getDB();
  const rows = db.prepare("SELECT address, name, label FROM addresses WHERE name != '' OR label != ''").all() as { address: string; name: string; label: string }[];
  const map = new Map<string, string>();
  for (const r of rows) {
    const display = r.name || r.label;
    if (display) map.set(r.address, display);
  }
  return map;
}

export function getAddressDetailsMap(): Map<string, { name: string; label: string; type: string; isContract: boolean; asset: string; notes: string }> {
  const db = getDB();
  const rows = db.prepare("SELECT address, name, label, type, is_contract, asset, notes FROM addresses WHERE name != '' OR label != ''").all() as { address: string; name: string; label: string; type: string; is_contract: number; asset: string; notes: string }[];
  const map = new Map<string, { name: string; label: string; type: string; isContract: boolean; asset: string; notes: string }>();
  for (const r of rows) {
    map.set(r.address, { name: r.name, label: r.label, type: r.type, isContract: r.is_contract === 1, asset: r.asset ?? "", notes: r.notes ?? "" });
  }
  return map;
}

export function getAllTransactionsFromDB(limit?: number): TransactionRecord[] {
  const db = getDB();
  const sql = `SELECT * FROM transactions ORDER BY timestamp ASC${limit ? ` LIMIT ${limit}` : ""}`;
  return db.prepare(sql).all() as TransactionRecord[];
}

// ── Pool Creation DAO ─────────────────────────────────────────────────

export function insertPoolCreation(record: Omit<PoolCreationRecord, "created_at">): void {
  const db = getDB();
  db.prepare(`INSERT OR IGNORE INTO pool_creations
    (pair_address, factory_address, creator_address, token0, token1, tx_hash, block_number, timestamp, dex_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    record.pair_address.toLowerCase(),
    record.factory_address.toLowerCase(),
    record.creator_address.toLowerCase(),
    record.token0.toLowerCase(),
    record.token1.toLowerCase(),
    record.tx_hash.toLowerCase(),
    record.block_number,
    record.timestamp,
    record.dex_name,
  );
}

export function getAllPoolCreations(): PoolCreationRecord[] {
  const db = getDB();
  return db.prepare("SELECT * FROM pool_creations ORDER BY block_number ASC").all() as PoolCreationRecord[];
}

export function getPoolCreationsByCreator(creatorAddr: string): PoolCreationRecord[] {
  const db = getDB();
  return db.prepare("SELECT * FROM pool_creations WHERE creator_address = ? ORDER BY block_number ASC")
    .all(creatorAddr.toLowerCase()) as PoolCreationRecord[];
}

export function getPoolCreationsByToken(tokenAddr: string): PoolCreationRecord[] {
  const db = getDB();
  const normalized = tokenAddr.toLowerCase();
  return db.prepare("SELECT * FROM pool_creations WHERE token0 = ? OR token1 = ? ORDER BY block_number ASC")
    .all(normalized, normalized) as PoolCreationRecord[];
}

export function getPoolCreatorMap(): Map<string, PoolCreationRecord[]> {
  const db = getDB();
  const rows = db.prepare("SELECT * FROM pool_creations ORDER BY block_number ASC").all() as PoolCreationRecord[];
  const map = new Map<string, PoolCreationRecord[]>();
  for (const r of rows) {
    const key = r.creator_address.toLowerCase();
    const list = map.get(key) ?? [];
    list.push(r);
    map.set(key, list);
  }
  return map;
}

// ── Private Key DAO ────────────────────────────────────────────────────

export interface PrivateKeyRecord {
  address: string;
  name: string;
  env_key: string;
  private_key: string;
  updated_at: string;
}

export function upsertPrivateKey(address: string, name: string, envKey: string, privateKey: string): void {
  const db = getDB();
  const normalized = address.toLowerCase();
  db.prepare(`INSERT INTO private_keys (address, name, env_key, private_key, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(address) DO UPDATE SET name = excluded.name, env_key = excluded.env_key, private_key = excluded.private_key, updated_at = datetime('now')`)
    .run(normalized, name, envKey, privateKey);
}

export function getPrivateKeyByAddress(address: string): PrivateKeyRecord | undefined {
  const db = getDB();
  return db.prepare("SELECT * FROM private_keys WHERE address = ?").get(address.toLowerCase()) as PrivateKeyRecord | undefined;
}

export function getPrivateKeyByName(name: string): PrivateKeyRecord | undefined {
  const db = getDB();
  return db.prepare("SELECT * FROM private_keys WHERE name = ? COLLATE NOCASE").get(name) as PrivateKeyRecord | undefined;
}

export function getAllPrivateKeys(): PrivateKeyRecord[] {
  const db = getDB();
  return db.prepare("SELECT * FROM private_keys ORDER BY name").all() as PrivateKeyRecord[];
}

export function syncPrivateKeysFromEnv(): { synced: number; skipped: number } {
  let synced = 0;
  let skipped = 0;

  for (const key of Object.keys(process.env)) {
    if (!key.endsWith("_PRIVATE_KEY")) continue;
    const pkValue = process.env[key];
    if (!pkValue || pkValue === "") continue;

    const prefix = key.replace("_PRIVATE_KEY", "");
    const addressKey = `${prefix}_ADDRESS`;
    let address = process.env[addressKey];

    if (!address) {
      try {
        const { ethers } = require("ethers");
        address = new ethers.Wallet(pkValue).address;
      } catch {
        skipped++;
        continue;
      }
    }

    if (!address) {
      skipped++;
      continue;
    }

    upsertPrivateKey(address, prefix, key, pkValue);
    synced++;
  }

  log("OK", "syncPrivateKeysFromEnv", "Chaves sincronizadas do .env", { synced, skipped });
  return { synced, skipped };
}
