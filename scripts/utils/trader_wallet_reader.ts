/**
 * Trader Wallet Reader — leitura segura das carteiras do rapport_trader.
 *
 * Lê a tabela `trader_wallets` do SQLite do subprojeto rapport_trader,
 * descriptografa as chaves privadas com AES-256-GCM usando WALLET_MASTER_KEY
 * e retorna carteiras prontas para assinatura.
 *
 * Segurança:
 *   - Nunca loga chaves privadas, WALLET_MASTER_KEY ou payloads criptografados.
 *   - Abre o DB em modo readonly.
 *   - Falha rápido se o DB ou a master key estiverem ausentes.
 */

import Database from "better-sqlite3";
import { createDecipheriv } from "crypto";
import { ethers } from "ethers";
import * as path from "path";
import * as fs from "fs";

export interface TraderWallet {
  id: number;
  address: string;
  name: string | null;
  signer: ethers.Wallet;
  source: string | null;
  imported: number;
  active: number;
  needsFunding: number;
  forkEnabled: number;
  parentId: number | null;
}

interface TraderWalletRow {
  id: number;
  address: string;
  name: string | null;
  private_key_encrypted: string;
  imported: number;
  source: string | null;
  parent_wallet_id: number | null;
  base_cas_balance: number;
  active: number;
  needs_funding: number;
  fork_enabled: number;
  created_at: string;
}

interface EncryptedPrivateKey {
  iv: string; // base64
  tag: string; // base64
  data: string; // base64
}

function log(level: "INFO" | "WARN" | "ERROR" | "OK" | "DEBUG", fn: string, msg: string, p?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const emoji = { INFO: "ℹ️", WARN: "⚠️", ERROR: "❌", OK: "✅", DEBUG: "🔍" }[level];
  console.log(`[${ts}] [trader_wallet_reader:${fn}] ${emoji} ${msg}${p ? ` - ${JSON.stringify(p)}` : ""}`);
}

function getMasterKey(): Buffer {
  const key = process.env.WALLET_MASTER_KEY;
  if (!key) {
    throw new Error("WALLET_MASTER_KEY is not configured in .env");
  }
  const buf = Buffer.from(key, "hex");
  if (buf.length !== 32) {
    throw new Error("WALLET_MASTER_KEY must be 64 hex characters (32 bytes)");
  }
  return buf;
}

function decryptPrivateKey(encryptedPayload: string): string {
  const masterKey = getMasterKey();
  let payload: EncryptedPrivateKey;
  try {
    payload = JSON.parse(encryptedPayload) as EncryptedPrivateKey;
  } catch {
    throw new Error("Invalid encrypted private key payload");
  }
  const iv = Buffer.from(payload.iv, "base64");
  const tag = Buffer.from(payload.tag, "base64");
  const data = Buffer.from(payload.data, "base64");
  const decipher = createDecipheriv("aes-256-gcm", masterKey, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString("utf8");
}

/**
 * Resolve o caminho do DB do rapport_trader.
 * Prioridade:
 *   1. `TRADER_DB_PATH` (absoluto ou relativo ao cwd)
 *   2. `../rapport_trader/data/cas_tracker.db` relativo ao diretório do script
 */
function resolveTraderDbPath(): string {
  const envPath = process.env.TRADER_DB_PATH;
  if (envPath) {
    const resolved = path.resolve(envPath);
    if (fs.existsSync(resolved)) return resolved;
    throw new Error(`TRADER_DB_PATH aponta para arquivo inexistente: ${resolved}`);
  }

  const defaultPath = path.resolve(__dirname, "..", "..", "..", "rapport_trader", "data", "cas_tracker.db");
  if (fs.existsSync(defaultPath)) return defaultPath;

  throw new Error(
    `DB do rapport_trader não encontrado. Defina TRADER_DB_PATH ou verifique ${defaultPath}`
  );
}

/**
 * Carrega as carteiras ativas do rapport_trader e retorna signers prontos.
 */
export function loadTraderWallets(provider: ethers.Provider): TraderWallet[] {
  const dbPath = resolveTraderDbPath();
  log("INFO", "loadTraderWallets", "Abrindo DB do rapport_trader", { dbPath });

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare("SELECT * FROM trader_wallets WHERE active = 1 ORDER BY id")
      .all() as TraderWalletRow[];

    const wallets: TraderWallet[] = [];
    for (const row of rows) {
      try {
        const privateKey = decryptPrivateKey(row.private_key_encrypted);
        const signer = new ethers.Wallet(privateKey, provider);
        if (signer.address.toLowerCase() !== row.address.toLowerCase()) {
          log("WARN", "loadTraderWallets", "Chave descriptografada não corresponde ao endereço", {
            id: row.id,
            expected: row.address,
            derived: signer.address,
          });
          continue;
        }
        wallets.push({
          id: row.id,
          address: row.address,
          name: row.name,
          signer,
          source: row.source,
          imported: row.imported,
          active: row.active,
          needsFunding: row.needs_funding,
          forkEnabled: row.fork_enabled,
          parentId: row.parent_wallet_id,
        });
      } catch (err) {
        log("ERROR", "loadTraderWallets", "Falha ao descriptografar carteira", {
          id: row.id,
          address: row.address,
          error: (err as Error).message,
        });
      }
    }

    log("OK", "loadTraderWallets", "Carteiras carregadas", { count: wallets.length });
    return wallets;
  } finally {
    db.close();
  }
}

/**
 * Retorna saldos CAS, POL e USDC para um conjunto de endereços.
 */
export async function getWalletBalances(
  provider: ethers.Provider,
  addresses: string[],
  casTokenAddress: string,
  usdcTokenAddress?: string
): Promise<Map<string, { cas: bigint; pol: bigint; usdc: bigint }>> {
  const cas = new ethers.Contract(
    casTokenAddress,
    ["function balanceOf(address) view returns (uint256)"],
    provider
  );
  const usdc = usdcTokenAddress
    ? new ethers.Contract(
        usdcTokenAddress,
        ["function balanceOf(address) view returns (uint256)"],
        provider
      )
    : null;

  const balances = new Map<string, { cas: bigint; pol: bigint; usdc: bigint }>();
  for (const addr of addresses) {
    try {
      const [casBal, polBal, usdcBal] = await Promise.all([
        cas.balanceOf(addr),
        provider.getBalance(addr),
        usdc ? usdc.balanceOf(addr) : Promise.resolve(0n),
      ]);
      balances.set(addr.toLowerCase(), { cas: casBal, pol: polBal, usdc: usdcBal });
    } catch (err) {
      log("ERROR", "getWalletBalances", "Falha ao ler saldo", {
        address: addr,
        error: (err as Error).message,
      });
      balances.set(addr.toLowerCase(), { cas: 0n, pol: 0n, usdc: 0n });
    }
  }
  return balances;
}
