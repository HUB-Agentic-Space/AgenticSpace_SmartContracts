/**
 * Label Address / Transaction — adicionar nomes, labels e descrições.
 *
 * Detecta automaticamente se o identificador é um endereço de carteira/contrato
 * (42 chars) ou um hash de transação (66 chars) e aplica os campos apropriados.
 *
 * Para endereços:
 *   name        → nome humano (ex: "Alice's Wallet", "CASSwap Contract")
 *   label       → categoria/tag (ex: "wallet", "contract", "dex", "team")
 *   description → notas sobre o endereço (opcional)
 *
 * Para transações:
 *   name        → rótulo da transação (ex: "Mint inicial", "Distribuição DEX")
 *   label       → categoria/tag da transação (ex: "mint", "swap", "transfer")
 *   description → justificativa da transação (opcional)
 *
 * Uso:
 *   tsx scripts/casswap/10_label_address.ts <address_or_txhash> <name> <label> [description]
 *
 * Exemplos:
 *   npm run cas:label -- 0x1234... "Alice's Wallet" "wallet" "Primeira investidora"
 *   npm run cas:label -- 0xabcd... "CASSwap" "contract"
 *   npm run cas:label -- 0xdeadbeef...txhash "Mint inicial" "mint" "Cunhagem de 1M CAS para reserva"
 */

import * as dotenv from "dotenv";
import * as path from "path";
import {
  getDB,
  closeDB,
  setAddressName,
  setAddressLabel,
  setAddressDescription,
  getAddress,
  setTransactionLabel,
  setTransactionDescription,
  getTransactionsByHash,
} from "../utils/cas_database";

// ── Env loading ───────────────────────────────────────────────────────

const SC_ROOT = path.resolve(__dirname, "..", "..");
dotenv.config({ path: path.join(SC_ROOT, ".env") });

// ── Structured logging ────────────────────────────────────────────────

type LogLevel = "INFO" | "WARN" | "ERROR" | "OK" | "DEBUG";

function log(level: LogLevel, fn: string, message: string, params?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const emoji = { INFO: "ℹ️", WARN: "⚠️", ERROR: "❌", OK: "✅", DEBUG: "🔍" }[level];
  const extra = params ? ` - ${JSON.stringify(params)}` : "";
  console.log(`[${ts}] [label_address:${fn}] ${emoji} ${message}${extra}`);
}

// ── Helpers ───────────────────────────────────────────────────────────

const ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH_REGEX = /^0x[0-9a-fA-F]{64}$/;

function isAddress(value: string): boolean {
  return ADDRESS_REGEX.test(value);
}

function isTxHash(value: string): boolean {
  return TX_HASH_REGEX.test(value);
}

function printHelp(): void {
  console.log(`
  Label Address / Transaction — Adicionar nomes, labels e descrições

  Uso:
    tsx scripts/casswap/10_label_address.ts <address_or_txhash> <name> <label> [description]

  Para endereços (wallet/contrato — 42 chars):
    name        Nome humano (ex: "Alice's Wallet")
    label       Categoria/tag (ex: "wallet", "contract", "dex")
    description Notas sobre o endereço (opcional)

  Para transações (tx hash — 66 chars):
    name        Rótulo da transação (ex: "Mint inicial")
    label       Categoria/tag (ex: "mint", "swap", "transfer")
    description Justificativa da transação (opcional)

  Exemplos:
    npm run cas:label -- 0x1234... "Alice's Wallet" "wallet" "Primeira investidora"
    npm run cas:label -- 0xabcd... "CASSwap" "contract"
    npm run cas:label -- 0xdeadbeef... "Mint inicial" "mint" "Cunhagem de 1M CAS"
  `);
}

// ── Main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length < 3) {
    log("ERROR", "main", "Parâmetros insuficientes. Uso: <address_or_txhash> <name> <label> [description]");
    printHelp();
    process.exit(1);
  }

  const identifier = args[0];
  const name = args[1];
  const label = args[2];
  const description = args[3] ?? "";

  if (!name || name.trim().length === 0) {
    log("ERROR", "main", "Nome não pode ser vazio");
    process.exit(1);
  }

  if (!label || label.trim().length === 0) {
    log("ERROR", "main", "Label não pode ser vazio");
    process.exit(1);
  }

  if (name.length > 200) {
    log("ERROR", "main", "Nome excede 200 caracteres", { length: name.length });
    process.exit(1);
  }

  if (label.length > 100) {
    log("ERROR", "main", "Label excede 100 caracteres", { length: label.length });
    process.exit(1);
  }

  getDB();

  try {
    if (isTxHash(identifier)) {
      await labelTransaction(identifier, name, label, description);
    } else if (isAddress(identifier)) {
      await labelAddress(identifier, name, label, description);
    } else {
      log("ERROR", "main", "Identificador inválido. Deve ser um endereço (0x + 40 hex) ou hash de transação (0x + 64 hex)", {
        identifier: identifier.slice(0, 20) + "...",
        length: identifier.length,
      });
      process.exit(1);
    }
  } finally {
    closeDB();
  }
}

async function labelAddress(addr: string, name: string, label: string, description: string): Promise<void> {
  log("INFO", "labelAddress", "🚀 Nomeando endereço", { address: addr, name, label, hasDescription: description.length > 0 });

  const existing = getAddress(addr);
  const isNew = !existing;

  setAddressName(addr, name);
  setAddressLabel(addr, label);

  if (description) {
    setAddressDescription(addr, description);
  }

  const updated = getAddress(addr);

  if (isNew) {
    log("OK", "labelAddress", "✅ Novo endereço cadastrado e nomeado", {
      address: addr,
      name,
      label,
      hasDescription: description.length > 0,
    });
  } else {
    log("OK", "labelAddress", "✅ Endereço atualizado", {
      address: addr,
      name,
      label,
      hasDescription: description.length > 0,
      previousLabel: existing?.label ?? "",
    });
  }

  console.log(`\n  📋 Endereço: ${addr}`);
  console.log(`  Nome:        ${updated?.name ?? name}`);
  console.log(`  Label:       ${updated?.label ?? label}`);
  console.log(`  Tipo:        ${updated?.type ?? "unknown"}`);
  console.log(`  Contrato:    ${updated?.is_contract ? "Sim" : "Não"}`);
  if (description) {
    console.log(`  Descrição:   ${description}`);
  }
  console.log(`  Atualizado:  ${updated?.updated_at ?? new Date().toISOString()}`);
}

async function labelTransaction(txHash: string, name: string, label: string, description: string): Promise<void> {
  log("INFO", "labelTransaction", "🚀 Rotulando transação", { txHash: txHash.slice(0, 20) + "...", name, label, hasDescription: description.length > 0 });

  const txs = getTransactionsByHash(txHash);

  if (txs.length === 0) {
    log("WARN", "labelTransaction", "Transação não encontrada no banco SQLite. Apenas label/descrição serão armazenados se ela for sincronizada depois.", {
      txHash: txHash.slice(0, 20) + "...",
    });
    console.log(`\n  ⚠️  Transação ${txHash.slice(0, 20)}... não encontrada no banco.`);
    console.log(`     Rode 'npm run sync:cas:db' para sincronizar transações primeiro.`);
    console.log(`     Os metadados serão aplicados quando a transação for inserida.\n`);
    return;
  }

  setTransactionLabel(txHash, name);
  if (description) {
    setTransactionDescription(txHash, description);
  }

  log("OK", "labelTransaction", "✅ Transação rotulada", {
    txHash: txHash.slice(0, 20) + "...",
    name,
    label,
    txCount: txs.length,
    hasDescription: description.length > 0,
  });

  console.log(`\n  📋 Transação: ${txHash}`);
  console.log(`  Nome:         ${name}`);
  console.log(`  Label:        ${label}`);
  if (description) {
    console.log(`  Descrição:    ${description}`);
  }
  console.log(`  Registros:    ${txs.length}`);
  for (const t of txs) {
    const date = new Date(t.timestamp * 1000).toISOString().replace("T", " ").slice(0, 19);
    console.log(`    ${date}  ${t.from_address} → ${t.to_address}  value: ${t.value}`);
  }
}

main().then(() => process.exit(0)).catch((err) => {
  log("ERROR", "main", "Falha", { error: (err as Error).message });
  closeDB();
  process.exit(1);
});
