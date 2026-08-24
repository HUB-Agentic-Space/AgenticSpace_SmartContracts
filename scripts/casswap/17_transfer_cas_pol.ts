/**
 * Transfer CAS/POL — envio de CAS e POL entre contas com estimativa de gas.
 *
 * Comandos:
 *   --list                 Lista contas com chave privada no .env e saldos POL
 *   --sync                 Sincroniza chaves privadas do .env para o banco de dados
 *   --src <name|addr|#idx> Conta de origem (nome do .env, label do DB, endereço, ou #índice)
 *   --dst <name|addr|#idx> Conta de destino (nome do .env, label do DB, endereço, ou #índice)
 *   --vlr <amount>         Valor a transferir ou cotar (ex: "1.5" = 1.5 POL ou 1.5 CAS)
 *   --token <cas|pol>      Token a enviar (default: pol)
 *   --cas2pol              Procura melhor taxa em todas as DEXs + CASSwap
 *   --quote <pair>         Cotação: converte entre POL, CAS, ETH e moedas fiduciárias
 *                         ex: pol/real, cas/usd, eth/pol, eth/cas, pol/cas, cas/eth
 *                         CAS é convertido via DEX para POL, ETH via CoinGecko cross rate
 *                         Inclui estimativa de gas no valor total
 *   --amoy                 Usa testnet Amoy em vez de mainnet
 *   --yes                  Pula confirmação (PERIGOSO — default é pedir)
 *
 * Uso:
 *   npx tsx scripts/casswap/17_transfer_cas_pol.ts --list
 *   npx tsx scripts/casswap/17_transfer_cas_pol.ts --src DEPLOYER --dst 0x123... --vlr 1.5
 *   npx tsx scripts/casswap/17_transfer_cas_pol.ts --src DEPLOYER --dst RELAYER --vlr 0.5 --token cas
 *   npx tsx scripts/casswap/17_transfer_cas_pol.ts --src DEPLOYER --dst 0x123... --vlr 1.0 --cas2pol
 *   npx tsx scripts/casswap/17_transfer_cas_pol.ts --quote pol/real --vlr 10
 *   npx tsx scripts/casswap/17_transfer_cas_pol.ts --quote cas/usd --vlr 1000
 *   npx tsx scripts/casswap/17_transfer_cas_pol.ts --quote eth/real --vlr 1
 *   npx tsx scripts/casswap/17_transfer_cas_pol.ts --quote eth/pol --vlr 1
 *   npx tsx scripts/casswap/17_transfer_cas_pol.ts --quote pol/cas --vlr 10
 *   npx tsx scripts/casswap/17_transfer_cas_pol.ts --quote cas/eth --vlr 1000
 */

import "dotenv/config";
import { ethers } from "agentic_space_commons";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  getDB, closeDB, getLabelMap, getAllAddresses,
  getAllPrivateKeys, syncPrivateKeysFromEnv,
  resolveShortAddress,
  getAddressesByRole, getPrivateKeyByAddress,
} from "../utils/cas_database";
import {
  buildHtmlTable, buildHtmlPage, buildSummaryGrid,
  saveAndOpenReport, type TableColumn, type SummaryItem,
} from "../utils/html_report";

// ── ABIs ──────────────────────────────────────────────────────────────

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function paused() view returns (bool)",
];

const CASSWAP_ABI = [
  "function getRatio() view returns (uint256 numerator, uint256 denominator)",
  "function getSwapFee() view returns (uint256)",
  "function getCASBalance() view returns (uint256)",
  "function getPOLBalance() view returns (uint256)",
  "function isPaused() view returns (bool)",
  "function sellCAS(uint256 casAmount, uint256 minPolOut, uint256 deadline) returns (uint256 polReceived)",
];

const DEX_ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] path) view returns (uint[] amounts)",
  "function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline) returns (uint[] amounts)",
  "function factory() view returns (address)",
];

const WPOL_ADDRESS = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";

interface DexRouterInfo {
  name: string;
  address: string;
}

const DEX_ROUTERS: DexRouterInfo[] = [
  { name: "QuickSwap", address: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff" },
  { name: "SushiSwap", address: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506" },
  { name: "ApeSwap", address: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607" },
  { name: "Dfyn", address: "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429" },
];

// ── Constants ─────────────────────────────────────────────────────────

const SEP = "=".repeat(72);
const SUB = "-".repeat(72);

const POL_TRANSFER_GAS = 21000n;
const CAS_TRANSFER_GAS = 65000n;
const CASSWAP_SELL_GAS = 150000n;
const CASSWAP_APPROVE_GAS = 50000n;
const DEX_SWAP_GAS = 180000n;
const DEX_APPROVE_GAS = 50000n;

// ── Types ─────────────────────────────────────────────────────────────

interface EnvAccount {
  name: string;
  address: string;
  privateKey: string;
  dbLabel?: string;
}

interface IndexedAccount {
  index: number;
  name: string;
  address: string;
  hasPrivateKey: boolean;
  privateKey?: string;
  dbLabel?: string;
}

interface ParsedArgs {
  list: boolean;
  sync: boolean;
  src?: string;
  dst?: string;
  vlr?: string;
  token: "cas" | "pol";
  cas2pol: boolean;
  amoy: boolean;
  yes: boolean;
  immediate: boolean;
  quote?: string;
}

interface DexQuote {
  source: string;
  type: "casswap" | "dex_v2";
  routerAddr?: string;
  polOut: bigint;
  casNeeded: bigint;
  effectiveRate: bigint;
  feeBps?: bigint;
  paused?: boolean;
  liquidityOk: boolean;
  available: boolean;
  error?: string;
}

// ── Logging ───────────────────────────────────────────────────────────

function log(level: "INFO" | "WARN" | "ERROR" | "OK", fn: string, msg: string, params?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const emoji = { INFO: "ℹ️", WARN: "⚠️", ERROR: "❌", OK: "✅" }[level];
  console.log(`[${ts}] [transfer_cas_pol:${fn}] ${emoji} ${msg}${params ? ` - ${JSON.stringify(params)}` : ""}`);
}

// ── Error decoding ────────────────────────────────────────────────────

interface KnownError {
  selector: string;
  name: string;
  hint: string;
}

const KNOWN_ERRORS: KnownError[] = [
  { selector: "0xd93c0665", name: "EnforcedPause()", hint: "O contrato do token CAS está PAUSADO. Transferências estão bloqueadas até que um PAUSER_ROLE execute unpause()." },
  { selector: "0x7939f4db", name: "AccountBalanceInsufficientBalance()", hint: "Saldo insuficiente do remetente para completar a transferência." },
  { selector: "0xe602df05", name: "ERC20InsufficientAllowance()", hint: "Allowance insuficiente — o spender não tem permissão para gastar essa quantidade." },
  { selector: "0xfb10f4f8", name: "ERC20InvalidApprover()", hint: "Approver inválido (endereço zero)." },
  { selector: "0xe4c12a4c", name: "ERC20InvalidReceiver()", hint: "Receiver inválido (endereço zero ou contrato sem receiver)." },
  { selector: "0x6c9d00e3", name: "ERC20InvalidSender()", hint: "Sender inválido (endereço zero)." },
  { selector: "0x00fdd58e", name: "ERC20InsufficientBalance()", hint: "Saldo ERC20 insuficiente para a transferência." },
];

function decodeContractError(err: unknown): { friendly: string; hint: string } {
  const msg = (err as Error).message ?? String(err);

  for (const known of KNOWN_ERRORS) {
    if (msg.includes(known.selector)) {
      return {
        friendly: `Erro de contrato: ${known.name}`,
        hint: known.hint,
      };
    }
  }

  if (msg.includes("insufficient funds")) {
    return {
      friendly: "Saldo POL insuficiente para pagar gas",
      hint: "A conta de origem não tem POL suficiente para cobrir o custo da transação. Use --cas2pol para vender CAS e obter POL.",
    };
  }

  if (msg.includes("nonce too low") || msg.includes("replacement transaction")) {
    return {
      friendly: "Nonce conflitante",
      hint: "Há uma transação pendente ou o nonce está desatualizado. Aguarde alguns segundos e tente novamente.",
    };
  }

  if (msg.includes("execution reverted")) {
    const dataMatch = msg.match(/data="(0x[0-9a-fA-F]+)"/);
    const data = dataMatch?.[1] ?? "";
    return {
      friendly: `Transação revertida pelo contrato${data ? ` (selector: ${data.slice(0, 10)})` : ""}`,
      hint: `O contrato reverteu a operação. Verifique: 1) se o token está pausado, 2) se o endereço de destino é válido, 3) se há saldo suficiente. Selector completo: ${data}`,
    };
  }

  if (msg.includes("network") || msg.includes("timeout") || msg.includes("ECONNREFUSED")) {
    return {
      friendly: "Erro de conexão com a rede",
      hint: "Não foi possível conectar ao RPC. Verifique POLYGON_RPC_URL no .env ou tente novamente em alguns instantes.",
    };
  }

  return { friendly: msg, hint: "Erro inesperado. Verifique os parâmetros e tente novamente." };
}

function printFriendlyError(err: unknown, context: string): void {
  const { friendly, hint } = decodeContractError(err);
  console.error(`\n${SEP}`);
  console.error(`  ❌ ERRO — ${context}`);
  console.error(SEP);
  console.error(`  Causa:    ${friendly}`);
  console.error(`  Solução:  ${hint}`);
  console.error(`${SEP}\n`);
  log("ERROR", context, friendly, { hint });
}

// ── CAS Token pause/unpause helpers ───────────────────────────────────

const CAS_PAUSE_ABI = [
  "function paused() view returns (bool)",
  "function pause()",
  "function unpause()",
  "function hasRole(bytes32 role, address account) view returns (bool)",
];

const PAUSER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("PAUSER_ROLE"));

const PAUSER_PRIORITY = ["DEPLOYER", "OWNER", "RELAYER", "BACKEND", "MANAGER"];

async function findPauserAccount(
  indexed: IndexedAccount[],
  casTokenAddr: string,
  provider: ethers.JsonRpcProvider,
): Promise<EnvAccount | null> {
  // 1. Tentar buscar no DB contas marcadas com PAUSER_ROLE
  try {
    getDB();
    const roleAccounts = getAddressesByRole("PAUSER_ROLE");
    for (const rec of roleAccounts) {
      const normalized = rec.address.toLowerCase();
      const pk = getPrivateKeyByAddress(normalized);
      if (pk && pk.private_key) {
        // Validar on-chain se ainda tem o role
        const cas = new ethers.Contract(casTokenAddr, CAS_PAUSE_ABI, provider);
        const hasRole = await cas.hasRole(PAUSER_ROLE, normalized);
        if (hasRole) {
          log("INFO", "findPauserAccount", "Pauser encontrado via DB roles", {
            address: normalized, name: pk.name,
          });
          return {
            name: pk.name,
            address: ethers.getAddress(normalized),
            privateKey: pk.private_key,
            dbLabel: rec.label || rec.name || undefined,
          };
        }
      }
    }
  } catch {
    // DB não disponível — continua para fallback
  }

  // 2. Fallback: tentar contas por prioridade de nome (DEPLOYER, OWNER, etc.)
  for (const priorityName of PAUSER_PRIORITY) {
    const match = indexed.find(
      (a) => a.hasPrivateKey && a.privateKey &&
        a.name.toUpperCase().includes(priorityName),
    );
    if (!match || !match.privateKey) continue;

    const cas = new ethers.Contract(casTokenAddr, CAS_PAUSE_ABI, provider);
    try {
      const hasRole = await cas.hasRole(PAUSER_ROLE, match.address);
      if (hasRole) {
        log("INFO", "findPauserAccount", "Pauser encontrado via prioridade de nome", {
          address: match.address, name: match.name,
        });
        // Salvar no DB para acelerar buscas futuras
        try {
          getDB();
          const { addAddressRole } = require("../utils/cas_database");
          addAddressRole(match.address, "PAUSER_ROLE");
        } catch { /* ignore */ }
        return {
          name: match.name,
          address: match.address,
          privateKey: match.privateKey,
          dbLabel: match.dbLabel,
        };
      }
    } catch {
      // Erro na consulta on-chain — tenta próxima
    }
  }

  return null;
}

async function unpauseCasToken(
  signer: ethers.Wallet,
  casTokenAddr: string,
  maxFeePerGas: bigint,
  maxPriorityFeePerGas: bigint,
): Promise<void> {
  const cas = new ethers.Contract(casTokenAddr, CAS_PAUSE_ABI, signer);
  const pauserRole = ethers.keccak256(ethers.toUtf8Bytes("PAUSER_ROLE"));
  const hasRole = await cas.hasRole(pauserRole, signer.address);
  if (!hasRole) {
    throw new Error(
      `A conta ${signer.address} não possui PAUSER_ROLE no CASToken. ` +
      `Não é possível despausar com --immediate.`,
    );
  }

  const isPaused = await cas.paused();
  if (!isPaused) {
    log("INFO", "unpauseCasToken", "Token CAS já está despausado — pulando");
    return;
  }

  console.log(`\n  🔓 Despausando token CAS...`);
  const tx = await cas.unpause({ maxFeePerGas, maxPriorityFeePerGas });
  console.log(`  TX unpause: ${tx.hash}`);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(`Transação unpause falhou: ${tx.hash}`);
  }
  console.log(`  ✅ Token CAS despausado`);
  log("OK", "unpauseCasToken", "Token CAS despausado", { txHash: tx.hash });
}

async function pauseCasToken(
  signer: ethers.Wallet,
  casTokenAddr: string,
  maxFeePerGas: bigint,
  maxPriorityFeePerGas: bigint,
): Promise<void> {
  const cas = new ethers.Contract(casTokenAddr, CAS_PAUSE_ABI, signer);

  const isPaused = await cas.paused();
  if (isPaused) {
    log("INFO", "pauseCasToken", "Token CAS já está pausado — pulando");
    return;
  }

  console.log(`\n  🔒 Re-pausando token CAS...`);
  const tx = await cas.pause({ maxFeePerGas, maxPriorityFeePerGas });
  console.log(`  TX pause: ${tx.hash}`);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(`Transação pause falhou: ${tx.hash}`);
  }
  console.log(`  ✅ Token CAS re-pausado`);
  log("OK", "pauseCasToken", "Token CAS re-pausado", { txHash: tx.hash });
}

// ── Arg parsing ───────────────────────────────────────────────────────

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    list: false,
    sync: false,
    token: "pol",
    cas2pol: false,
    amoy: false,
    yes: false,
    immediate: false,
  };
  // quote will be set by --quote flag if present

  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--list": args.list = true; break;
      case "--sync": args.sync = true; break;
      case "--src": args.src = argv[++i]; break;
      case "--dst": args.dst = argv[++i]; break;
      case "--vlr": args.vlr = argv[++i]; break;
      case "--token": {
        const t = argv[++i]?.toLowerCase();
        if (t !== "cas" && t !== "pol") throw new Error("--token deve ser 'cas' ou 'pol'");
        args.token = t as "cas" | "pol";
        break;
      }
      case "--quote": args.quote = argv[++i]; break;
      case "--cas2pol": args.cas2pol = true; break;
      case "--amoy": args.amoy = true; break;
      case "--yes": args.yes = true; break;
      case "--immediate": args.immediate = true; break;
      case "--help": case "-h": printHelp(); process.exit(0);
      default:
        if (arg?.startsWith("--")) throw new Error(`Flag desconhecida: ${arg}`);
        positional.push(arg);
    }
  }

  // Positional args: src dst vlr (in that order)
  if (positional.length > 0 && !args.src) args.src = positional[0];
  if (positional.length > 1 && !args.dst) args.dst = positional[1];
  if (positional.length > 2 && !args.vlr) args.vlr = positional[2];

  return args;
}

function printHelp(): void {
  console.log(`
  Transfer CAS/POL — Envio de CAS e POL entre contas

  Uso:
    npx tsx scripts/casswap/17_transfer_cas_pol.ts [options]
    npx tsx scripts/casswap/17_transfer_cas_pol.ts <src> <dst> <vlr> [--token cas|pol]

  Opções:
    --list                 Lista contas com chave privada e saldos POL
    --sync                 Sincroniza chaves privadas do .env para o banco de dados
    --src <name|addr|#idx>  Conta de origem (nome, endereço, ou #índice do --list)
    --dst <name|addr|#idx>  Conta de destino (nome, endereço, ou #índice do --list)
    --vlr <amount>         Valor a transferir (ex: "1.5")
    --token <cas|pol>      Token a enviar (default: pol)
    --cas2pol              Procura melhor taxa em todas as DEXs + CASSwap
    --quote <pair>         Cotação POL/CAS/ETH ↔ fiat ou crypto (ex: pol/real, cas/usd,
                           eth/pol, eth/cas, pol/cas, cas/eth)
                           Inclui gas no total. Combine com --vlr para quantidade
    --amoy                 Usa testnet Amoy
    --yes                  Pula confirmação (PERIGOSO)
    --immediate            Despausa o token CAS antes da transferência e re-pausa após
                           (usa conta com PAUSER_ROLE: DEPLOYER, OWNER, RELAYER, etc.)

  Exemplos:
    npx tsx scripts/casswap/17_transfer_cas_pol.ts --list
    npx tsx scripts/casswap/17_transfer_cas_pol.ts --src DEPLOYER --dst 0x123... --vlr 1.5
    npx tsx scripts/casswap/17_transfer_cas_pol.ts --src DEPLOYER --dst RELAYER --vlr 0.5 --token cas
    npx tsx scripts/casswap/17_transfer_cas_pol.ts --src DEPLOYER --dst 0x123... --vlr 1.0 --cas2pol
    npx tsx scripts/casswap/17_transfer_cas_pol.ts --src #0 --dst #3 --vlr 0.5
    npx tsx scripts/casswap/17_transfer_cas_pol.ts DEPLOYER RELAYER 0.5 --token cas
    npx tsx scripts/casswap/17_transfer_cas_pol.ts --src MANAGER --dst 0x123... --vlr 100 --token cas --immediate
    npx tsx scripts/casswap/17_transfer_cas_pol.ts --quote pol/real --vlr 10
    npx tsx scripts/casswap/17_transfer_cas_pol.ts --quote cas/usd --vlr 1000
    npx tsx scripts/casswap/17_transfer_cas_pol.ts --quote eth/real --vlr 1
    npx tsx scripts/casswap/17_transfer_cas_pol.ts --quote eth/pol --vlr 1
    npx tsx scripts/casswap/17_transfer_cas_pol.ts --quote pol/cas --vlr 10
    npx tsx scripts/casswap/17_transfer_cas_pol.ts --quote cas/eth --vlr 1000
  `);
}

// ── Account discovery ─────────────────────────────────────────────────

const SKIP_PREFIXES = ["POLYGON_AMOY", "POLYGON"];

function discoverEnvAccounts(): EnvAccount[] {
  const byKey = new Map<string, EnvAccount>();
  const byAddr = new Map<string, EnvAccount>();
  const labelMap = safeGetLabelMap();

  for (const key of Object.keys(process.env)) {
    if (!key.endsWith("_PRIVATE_KEY")) continue;
    const pkValue = process.env[key];
    if (!pkValue || pkValue === "") continue;

    const prefix = key.replace("_PRIVATE_KEY", "");
    const addressKey = `${prefix}_ADDRESS`;
    let address = process.env[addressKey];

    if (!address) {
      try {
        address = new ethers.Wallet(pkValue).address;
      } catch {
        continue;
      }
    }

    if (!address || !ethers.isAddress(address)) continue;

    const normalized = address.toLowerCase();
    const dbLabel = labelMap.get(normalized);
    const account: EnvAccount = {
      name: prefix,
      address: ethers.getAddress(address),
      privateKey: pkValue,
      dbLabel,
    };

    // Deduplicate by private key value — prefer entries with _ADDRESS env var
    // and prefer non-skipped prefixes (DEPLOYER over POLYGON_AMOY)
    const existingByKey = byKey.get(pkValue);
    if (existingByKey) {
      const existingHasAddr = process.env[`${existingByKey.name}_ADDRESS`];
      const newHasAddr = process.env[addressKey];
      const existingSkipped = SKIP_PREFIXES.includes(existingByKey.name);
      const newSkipped = SKIP_PREFIXES.includes(prefix);

      if (newHasAddr && !existingHasAddr) {
        byKey.set(pkValue, account);
      } else if (!newSkipped && existingSkipped) {
        byKey.set(pkValue, account);
      }
    } else {
      byKey.set(pkValue, account);
    }
  }

  // Build byAddr map from deduplicated accounts
  for (const acc of byKey.values()) {
    const normalized = acc.address.toLowerCase();
    if (!byAddr.has(normalized)) {
      byAddr.set(normalized, acc);
    }
  }

  // Also load from database (accounts synced via --sync)
  try {
    getDB();
    const dbKeys = getAllPrivateKeys();
    for (const rec of dbKeys) {
      const normalized = rec.address.toLowerCase();
      if (byAddr.has(normalized)) continue;

      const dbLabel = labelMap.get(normalized);
      byAddr.set(normalized, {
        name: rec.name,
        address: ethers.getAddress(rec.address),
        privateKey: rec.private_key,
        dbLabel,
      });
    }
  } catch {
    // DB not available — skip
  }

  return Array.from(byAddr.values());
}

function loadAllAddresses(): IndexedAccount[] {
  const envAccounts = discoverEnvAccounts();
  const byAddr = new Map<string, IndexedAccount>();
  const labelMap = safeGetLabelMap();

  // First add accounts with private keys (from .env or DB private_keys table)
  for (const acc of envAccounts) {
    const normalized = acc.address.toLowerCase();
    byAddr.set(normalized, {
      index: 0, // will be assigned later
      name: acc.name,
      address: acc.address,
      hasPrivateKey: true,
      privateKey: acc.privateKey,
      dbLabel: acc.dbLabel,
    });
  }

  // Then add all other addresses from the DB (no private key)
  try {
    getDB();
    const dbAddresses = getAllAddresses();
    for (const rec of dbAddresses) {
      const normalized = rec.address.toLowerCase();
      if (byAddr.has(normalized)) continue;

      const display = rec.name || rec.label || "";
      byAddr.set(normalized, {
        index: 0,
        name: display,
        address: ethers.getAddress(rec.address),
        hasPrivateKey: false,
        dbLabel: rec.label || undefined,
      });
    }
  } catch {
    // DB not available
  }

  // Sort: accounts with private keys first (by name), then others (by name/label)
  const all = Array.from(byAddr.values());
  all.sort((a, b) => {
    if (a.hasPrivateKey !== b.hasPrivateKey) return a.hasPrivateKey ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  // Assign indices
  for (let i = 0; i < all.length; i++) {
    all[i].index = i;
  }

  return all;
}

function safeGetLabelMap(): Map<string, string> {
  try {
    getDB();
    return getLabelMap() as Map<string, string>;
  } catch {
    return new Map<string, string>();
  }
}

function isAddr(value: string): boolean {
  return ethers.isAddress(value);
}

function isShortAddr(value: string): boolean {
  return value.startsWith("0x") && (value.includes("…") || value.includes("..."));
}

function isIndexRef(value: string): boolean {
  return value.startsWith("#") && /^\d+$/.test(value.slice(1));
}

function resolveSource(nameOrAddr: string, indexed: IndexedAccount[]): EnvAccount {
  // #index reference
  if (isIndexRef(nameOrAddr)) {
    const idx = parseInt(nameOrAddr.slice(1), 10);
    const entry = indexed.find(a => a.index === idx);
    if (!entry) throw new Error(`Índice #${idx} não encontrado. Use --list para ver os índices disponíveis.`);
    if (!entry.hasPrivateKey || !entry.privateKey) {
      throw new Error(`Conta #${idx} (${entry.name || entry.address}) não tem chave privada — não pode ser origem.`);
    }
    return {
      name: entry.name,
      address: entry.address,
      privateKey: entry.privateKey,
      dbLabel: entry.dbLabel,
    };
  }

  // Shortened address (e.g. 0xc590…c02b)
  if (isShortAddr(nameOrAddr)) {
    const resolved = resolveShortAddress(nameOrAddr);
    if (resolved) {
      const normalized = resolved.toLowerCase();
      const byAddr = indexed.find(a => a.hasPrivateKey && a.address.toLowerCase() === normalized);
      if (byAddr && byAddr.privateKey) {
        return { name: byAddr.name, address: byAddr.address, privateKey: byAddr.privateKey, dbLabel: byAddr.dbLabel };
      }
    }
  }

  // By name (from accounts with private keys)
  const byName = indexed.find(a => a.hasPrivateKey && a.name.toLowerCase() === nameOrAddr.toLowerCase());
  if (byName && byName.privateKey) {
    return { name: byName.name, address: byName.address, privateKey: byName.privateKey, dbLabel: byName.dbLabel };
  }

  // By address
  if (isAddr(nameOrAddr)) {
    const normalized = nameOrAddr.toLowerCase();
    const byAddr = indexed.find(a => a.hasPrivateKey && a.address.toLowerCase() === normalized);
    if (byAddr && byAddr.privateKey) {
      return { name: byAddr.name, address: byAddr.address, privateKey: byAddr.privateKey, dbLabel: byAddr.dbLabel };
    }
  }

  // By label in DB
  const labelMap: Map<string, string> = safeGetLabelMap();
  let found: IndexedAccount | undefined;
  labelMap.forEach((label: string, addr: string) => {
    if (!found && label.toLowerCase() === nameOrAddr.toLowerCase()) {
      found = indexed.find(a => a.address.toLowerCase() === addr);
    }
  });
  if (found && found.hasPrivateKey && found.privateKey) {
    return { name: found.name, address: found.address, privateKey: found.privateKey, dbLabel: found.dbLabel };
  }

  throw new Error(`Conta de origem não encontrada ou sem chave privada: ${nameOrAddr}`);
}

function resolveDestination(nameOrAddr: string, indexed: IndexedAccount[]): string {
  // #index reference
  if (isIndexRef(nameOrAddr)) {
    const idx = parseInt(nameOrAddr.slice(1), 10);
    const entry = indexed.find(a => a.index === idx);
    if (!entry) throw new Error(`Índice #${idx} não encontrado. Use --list para ver os índices disponíveis.`);
    return entry.address;
  }

  // Shortened address (e.g. 0xc590…c02b)
  if (isShortAddr(nameOrAddr)) {
    const resolved = resolveShortAddress(nameOrAddr);
    if (resolved) return ethers.getAddress(resolved);
  }

  // By address
  if (isAddr(nameOrAddr)) return ethers.getAddress(nameOrAddr);

  // By name
  const byName = indexed.find(a => a.name.toLowerCase() === nameOrAddr.toLowerCase());
  if (byName) return byName.address;

  // By label in DB
  const labelMap: Map<string, string> = safeGetLabelMap();
  let dstFound: string | undefined;
  labelMap.forEach((label: string, addr: string) => {
    if (!dstFound && label.toLowerCase() === nameOrAddr.toLowerCase()) {
      dstFound = ethers.getAddress(addr);
    }
  });
  if (dstFound) return dstFound;

  throw new Error(`Conta de destino não encontrada: ${nameOrAddr}`);
}

// ── Provider / signer ─────────────────────────────────────────────────

function getRpcUrl(amoy: boolean): string {
  if (amoy) {
    return process.env.POLYGON_AMOY_RPC_URL || "https://rpc-amoy.polygon.technology";
  }
  return process.env.POLYGON_RPC_URL || "https://polygon.drpc.org";
}

function getProvider(amoy: boolean): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(getRpcUrl(amoy));
}

function getSigner(account: EnvAccount, amoy: boolean): ethers.Wallet {
  const provider = getProvider(amoy);
  return new ethers.Wallet(account.privateKey, provider);
}

// ── Gas helpers ───────────────────────────────────────────────────────

async function getFeeData(provider: ethers.JsonRpcProvider): Promise<{
  gasPrice: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}> {
  const feeData = await provider.getFeeData();
  const latestBlock = await provider.getBlock("latest");
  const baseFee = latestBlock?.baseFeePerGas ?? 0n;
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? feeData.gasPrice ?? 25_000_000_000n;
  const maxFeePerGas = baseFee * 2n + maxPriorityFeePerGas;
  const gasPrice = feeData.gasPrice ?? maxFeePerGas;
  return { gasPrice, maxFeePerGas, maxPriorityFeePerGas };
}

async function estimateTransferGas(
  provider: ethers.JsonRpcProvider,
  from: string,
  to: string,
  value: bigint,
  token: "cas" | "pol",
  casTokenAddr?: string,
): Promise<bigint> {
  if (token === "pol") {
    return POL_TRANSFER_GAS;
  }

  if (!casTokenAddr) throw new Error("CAS_TOKEN_ADDRESS não definido no .env");

  try {
    const casContract = new ethers.Contract(casTokenAddr, ERC20_ABI, provider);
    const gas = await casContract.transfer.estimateGas(to, value, { from });
    return (gas * 120n) / 100n;
  } catch {
    return CAS_TRANSFER_GAS;
  }
}

// ── Confirmation ──────────────────────────────────────────────────────

let _rl: readline.Interface | null = null;

function getRl(): readline.Interface {
  if (!_rl) {
    _rl = readline.createInterface({ input, output });
  }
  return _rl;
}

async function confirm(prompt: string, defaultYes: boolean = false): Promise<boolean> {
  const rl = getRl();
  const hint = defaultYes ? "[S/n]" : "[s/N]";
  const answer = await rl.question(`\n  ${prompt} ${hint} `);

  const trimmed = answer.trim().toLowerCase();
  if (trimmed === "") return defaultYes;
  return trimmed === "s" || trimmed === "sim" || trimmed === "y" || trimmed === "yes";
}

function closeRl(): void {
  if (_rl) {
    _rl.close();
    _rl = null;
  }
}

// ── List accounts ─────────────────────────────────────────────────────

async function listAccounts(indexed: IndexedAccount[], amoy: boolean): Promise<void> {
  const provider = getProvider(amoy);
  const network = await provider.getNetwork();
  const casTokenAddr = process.env.CAS_TOKEN_ADDRESS;

  const casContract = casTokenAddr && ethers.isAddress(casTokenAddr)
    ? new ethers.Contract(casTokenAddr, ERC20_ABI, provider)
    : null;

  const withKey = indexed.filter(a => a.hasPrivateKey).length;

  const summary: SummaryItem[] = [
    { label: "Rede", value: `${network.name} (chainId: ${network.chainId})` },
    { label: "RPC", value: getRpcUrl(amoy) },
    { label: "Total de endereços", value: String(indexed.length) },
    { label: "Com chave privada", value: String(withKey) },
  ];

  // Collect POL + CAS balances
  const polColumns: TableColumn[] = [
    { header: "#", key: "idx", mono: true },
    { header: "Nome", key: "name" },
    { header: "Endereço", key: "address", mono: true, link: (r) => `https://polygonscan.com/address/${r.address}` },
    { header: "Saldo POL", key: "pol", mono: true },
    { header: "Chave", key: "key", render: (r) => r.key === "true" ? '<span class="badge badge-ok">Sim</span>' : '<span class="badge badge-info">—</span>' },
    { header: "Label DB", key: "label" },
  ];

  const polRows: Record<string, string>[] = [];
  const casRows: Record<string, string>[] = [];

  for (const acc of indexed) {
    let polBalance: bigint;
    try {
      polBalance = await provider.getBalance(acc.address);
    } catch {
      polBalance = 0n;
    }

    polRows.push({
      idx: `#${acc.index}`,
      name: acc.name || "(sem nome)",
      address: acc.address,
      pol: ethers.formatEther(polBalance),
      key: acc.hasPrivateKey ? "true" : "false",
      label: acc.dbLabel || "-",
    });

    if (casContract) {
      let casBal: bigint;
      try {
        casBal = await casContract.balanceOf(acc.address);
      } catch {
        casBal = 0n;
      }
      casRows.push({
        idx: `#${acc.index}`,
        name: acc.name || "(sem nome)",
        address: acc.address,
        cas: ethers.formatEther(casBal),
      });
    }
  }

  let body = buildSummaryGrid(summary);

  body += `<div class="card"><h2>Saldo POL</h2>${buildHtmlTable(polColumns, polRows)}</div>`;

  if (casRows.length > 0) {
    const casColumns: TableColumn[] = [
      { header: "#", key: "idx", mono: true },
      { header: "Nome", key: "name" },
      { header: "Endereço", key: "address", mono: true, link: (r) => `https://polygonscan.com/address/${r.address}` },
      { header: "Saldo CAS", key: "cas", mono: true },
    ];
    body += `<div class="card"><h2>Saldo CAS</h2>${buildHtmlTable(casColumns, casRows)}</div>`;
  }

  body += `<div class="card"><h3>Como usar</h3><p class="text-muted">Use <code>#índice</code> para referenciar contas em <code>--src</code> e <code>--dst</code>. Exemplo: <code>--src #0 --dst #3 --vlr 1.0</code></p><p class="text-coral">⚠️ Índices mudam quando novos endereços são adicionados ao banco.</p><p class="text-muted">ℹ️ Apenas contas com <span class="badge badge-ok">Sim</span> têm chave privada e podem enviar.</p></div>`;

  const html = buildHtmlPage(
    "Contas disponíveis — CAS/POL Transfer",
    `Rede: ${network.name} (chainId: ${network.chainId}) — ${indexed.length} endereços (${withKey} com chave privada)`,
    body,
  );

  const ts = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
  saveAndOpenReport(`transfer_accounts_${ts}.html`, html);
}

// ── DEX quote helpers ─────────────────────────────────────────────────

async function queryCasswapQuote(
  provider: ethers.JsonRpcProvider,
  casAmount: bigint,
): Promise<DexQuote> {
  const casSwapAddr = process.env.CAS_SWAP_ADDRESS;
  if (!casSwapAddr || !ethers.isAddress(casSwapAddr)) {
    return { source: "CASSwap", type: "casswap", polOut: 0n, casNeeded: casAmount, effectiveRate: 0n, liquidityOk: false, available: false, error: "CAS_SWAP_ADDRESS não definido" };
  }

  try {
    const casSwap = new ethers.Contract(casSwapAddr, CASSWAP_ABI, provider);
    const [ratioNum, ratioDen] = await casSwap.getRatio();
    const feeBps = await casSwap.getSwapFee();
    const swapPaused = await casSwap.isPaused();
    const swapPolLiquidity = await casSwap.getPOLBalance();

    // polOut = casAmount * den / num * (10000 - feeBps) / 10000
    const afterFee = (casAmount * (10000n - feeBps)) / 10000n;
    const polOut = (afterFee * ratioDen) / ratioNum;
    const effectiveRate = casAmount > 0n ? (casAmount * 10n ** 18n) / polOut : 0n;
    const liquidityOk = swapPolLiquidity >= polOut;

    return {
      source: "CASSwap", type: "casswap", routerAddr: casSwapAddr,
      polOut, casNeeded: casAmount, effectiveRate, feeBps,
      paused: swapPaused, liquidityOk, available: !swapPaused && liquidityOk,
    };
  } catch (err: any) {
    return { source: "CASSwap", type: "casswap", polOut: 0n, casNeeded: casAmount, effectiveRate: 0n, liquidityOk: false, available: false, error: (err as Error).message };
  }
}

async function queryDexV2Quote(
  provider: ethers.JsonRpcProvider,
  routerInfo: DexRouterInfo,
  casTokenAddr: string,
  casAmount: bigint,
): Promise<DexQuote> {
  try {
    const router = new ethers.Contract(routerInfo.address, DEX_ROUTER_ABI, provider);
    const path = [casTokenAddr, WPOL_ADDRESS];
    const amounts = await router.getAmountsOut(casAmount, path);
    const polOut = amounts[amounts.length - 1];
    const effectiveRate = polOut > 0n ? (casAmount * 10n ** 18n) / polOut : 0n;

    return {
      source: routerInfo.name, type: "dex_v2", routerAddr: routerInfo.address,
      polOut, casNeeded: casAmount, effectiveRate,
      liquidityOk: polOut > 0n, available: polOut > 0n,
    };
  } catch (err: any) {
    return {
      source: routerInfo.name, type: "dex_v2", routerAddr: routerInfo.address,
      polOut: 0n, casNeeded: casAmount, effectiveRate: 0n,
      liquidityOk: false, available: false, error: (err as Error).message,
    };
  }
}

async function queryAllDexs(
  provider: ethers.JsonRpcProvider,
  casTokenAddr: string,
  casAmount: bigint,
): Promise<DexQuote[]> {
  const quotes: Promise<DexQuote>[] = [];

  quotes.push(queryCasswapQuote(provider, casAmount));

  for (const dex of DEX_ROUTERS) {
    quotes.push(queryDexV2Quote(provider, dex, casTokenAddr, casAmount));
  }

  return Promise.all(quotes);
}

function pickBestQuote(quotes: DexQuote[]): DexQuote | null {
  const available = quotes.filter(q => q.available);
  if (available.length === 0) return null;
  return available.reduce((best, q) => q.polOut > best.polOut ? q : best);
}

// ── CAS2POL calculation ───────────────────────────────────────────────

interface Cas2PolResult {
  polNeeded: bigint;
  gasForTransfer: bigint;
  gasForSwap: bigint;
  gasForApprove: bigint;
  totalGas: bigint;
  gasCostInPol: bigint;
  totalPolNeeded: bigint;
  quotes: DexQuote[];
  bestQuote: DexQuote | null;
  casNeeded: bigint;
  idealCas: bigint;
  feeInCas: bigint;
  feeInPol: bigint;
}

async function calculateCas2Pol(
  provider: ethers.JsonRpcProvider,
  gasPrice: bigint,
  transferAmount: bigint,
  transferGas: bigint,
  casTokenAddr: string,
): Promise<Cas2PolResult> {
  const gasForTransfer = transferGas;
  const gasCostInPol = gasForTransfer * gasPrice;
  const polNeeded = transferAmount;
  const totalPolNeeded = polNeeded + gasCostInPol;

  // First pass: query all DEXs with a reference amount to find the best rate
  // We query with 1 CAS to get the rate, then compute the actual casNeeded
  const refAmount = ethers.parseEther("1");
  const refQuotes = await queryAllDexs(provider, casTokenAddr, refAmount);
  const bestRef = pickBestQuote(refQuotes);

  if (!bestRef) {
    // No DEX available — return with empty quotes
    return {
      polNeeded, gasForTransfer, gasForSwap: 0n, gasForApprove: 0n,
      totalGas: gasForTransfer, gasCostInPol, totalPolNeeded,
      quotes: refQuotes, bestQuote: null,
      casNeeded: 0n, idealCas: 0n, feeInCas: 0n, feeInPol: 0n,
    };
  }

  // Calculate CAS needed based on the best DEX's effective rate
  // effectiveRate = CAS per POL (in 18 decimals), so casNeeded = totalPolNeeded * effectiveRate / 1e18
  const idealCas = (totalPolNeeded * bestRef.effectiveRate) / 10n ** 18n;

  // Add 2% slippage tolerance for DEX swaps
  const casNeeded = bestRef.type === "dex_v2"
    ? (idealCas * 102n) / 100n
    : idealCas;

  const feeInCas = casNeeded - idealCas;
  const feeInPol = bestRef.effectiveRate > 0n
    ? (feeInCas * 10n ** 18n) / bestRef.effectiveRate
    : 0n;

  // Now query again with the actual casNeeded to get precise quotes
  const quotes = await queryAllDexs(provider, casTokenAddr, casNeeded);
  const bestQuote = pickBestQuote(quotes);

  // Determine gas based on best quote type
  const gasForSwap = bestQuote?.type === "casswap" ? CASSWAP_SELL_GAS : DEX_SWAP_GAS;
  const gasForApprove = bestQuote?.type === "casswap" ? CASSWAP_APPROVE_GAS : DEX_APPROVE_GAS;
  const totalGas = gasForTransfer + gasForSwap + gasForApprove;

  // Recalculate with updated gas
  const updatedGasCostInPol = totalGas * gasPrice;
  const updatedTotalPolNeeded = polNeeded + updatedGasCostInPol;

  // Recalculate casNeeded with updated total
  const updatedIdealCas = (updatedTotalPolNeeded * bestRef.effectiveRate) / 10n ** 18n;
  const updatedCasNeeded = bestRef.type === "dex_v2"
    ? (updatedIdealCas * 102n) / 100n
    : updatedIdealCas;

  const updatedFeeInCas = updatedCasNeeded - updatedIdealCas;
  const updatedFeeInPol = bestRef.effectiveRate > 0n
    ? (updatedFeeInCas * 10n ** 18n) / bestRef.effectiveRate
    : 0n;

  return {
    polNeeded, gasForTransfer, gasForSwap, gasForApprove, totalGas,
    gasCostInPol: updatedGasCostInPol, totalPolNeeded: updatedTotalPolNeeded,
    quotes, bestQuote,
    casNeeded: updatedCasNeeded, idealCas: updatedIdealCas,
    feeInCas: updatedFeeInCas, feeInPol: updatedFeeInPol,
  };
}

function printCas2PolResult(r: Cas2PolResult): void {
  console.log(`\n${SUB}`);
  console.log("  Cálculo CAS → POL (cobrir transferência + gas)");
  console.log(SUB);
  console.log(`  POL para transferir: ${ethers.formatEther(r.polNeeded)} POL`);
  console.log(`  Gas transferência:   ${r.gasForTransfer} gas`);
  console.log(`  Gas swap:            ${r.gasForSwap} gas`);
  console.log(`  Gas approve:         ${r.gasForApprove} gas`);
  console.log(`  Gas total:           ${r.totalGas} gas`);
  console.log(`  Custo gas em POL:    ${ethers.formatEther(r.gasCostInPol)} POL`);
  console.log(`  POL total necessário:${ethers.formatEther(r.totalPolNeeded)} POL`);
  console.log();

  // Comparison table
  console.log(`${SUB}`);
  console.log("  Comparação de DEXs (CAS → POL)");
  console.log(SUB);
  console.log("  Fonte".padEnd(16) + "POL recebido".padEnd(24) + "Taxa (CAS/POL)".padEnd(20) + "Status");
  console.log("  " + "-".repeat(80));

  for (const q of r.quotes) {
    const polStr = q.available ? ethers.formatEther(q.polOut) : "-";
    const rateStr = q.available ? ethers.formatEther(q.effectiveRate) : "-";
    let status: string;
    if (q.available) {
      status = "✅ Disponível";
    } else if (q.paused) {
      status = "⏸️  Pausado";
    } else if (q.error) {
      status = `❌ ${q.error.slice(0, 30)}`;
    } else {
      status = "❌ Indisponível";
    }

    const isBest = r.bestQuote && q.source === r.bestQuote.source;
    const marker = isBest ? " ← MELHOR" : "";
    console.log(
      `  ${q.source.padEnd(16)}${polStr.padEnd(24)}${rateStr.padEnd(20)}${status}${marker}`,
    );
  }

  console.log();

  if (r.bestQuote) {
    console.log(`  🏆 Melhor opção: ${r.bestQuote.source} (${r.bestQuote.type})`);
    if (r.bestQuote.routerAddr) {
      console.log(`     Router: ${r.bestQuote.routerAddr}`);
    }
    console.log(`     POL recebido: ${ethers.formatEther(r.bestQuote.polOut)} POL`);
    console.log(`     Taxa: ${ethers.formatEther(r.bestQuote.effectiveRate)} CAS/POL`);
    if (r.bestQuote.feeBps !== undefined) {
      console.log(`     Fee: ${r.bestQuote.feeBps} bps (${Number(r.bestQuote.feeBps) / 100}%)`);
    }
    console.log();
    console.log(`  CAS ideal (sem slippage): ${ethers.formatEther(r.idealCas)} CAS`);
    console.log(`  CAS com margem:           ${ethers.formatEther(r.casNeeded)} CAS`);
    console.log(`  Perda (fee/slippage) CAS: ${ethers.formatEther(r.feeInCas)} CAS`);
    console.log(`  Perda (fee/slippage) POL: ${ethers.formatEther(r.feeInPol)} POL`);
  } else {
    console.log("  ❌ Nenhuma DEX disponível para swap CAS→POL.");
    for (const q of r.quotes) {
      if (q.error) console.log(`     ${q.source}: ${q.error}`);
    }
  }

  console.log();
}

// ── Quote (conversion: fiat + crypto) ─────────────────────────────────

const COINGECKO_COIN_IDS: Record<string, string> = {
  pol: "matic-network",
  eth: "ethereum",
};

const CURRENCY_SYMBOLS: Record<string, string> = {
  usd: "$",
  real: "R$",
  brl: "R$",
  eur: "€",
  gbp: "£",
  jpy: "¥",
  cny: "¥",
  ars: "$",
  cad: "C$",
  aud: "A$",
  chf: "Fr",
  inr: "₹",
  pol: "",
  cas: "",
  eth: "Ξ",
};

const CURRENCY_ALIASES: Record<string, string> = {
  real: "brl",
  reais: "brl",
  dolar: "usd",
  euro: "eur",
  libra: "gbp",
  iene: "jpy",
  yuan: "cny",
  peso: "ars",
};

type QuoteToken = "pol" | "cas" | "eth";

function isCryptoDest(c: string): boolean {
  return c === "pol" || c === "cas" || c === "eth";
}

function isQuoteToken(c: string): boolean {
  return c === "pol" || c === "cas" || c === "eth";
}

interface FiatPrice {
  currency: string;
  price: number;
  symbol: string;
  change24h: number;
}

const _priceCache = new Map<string, FiatPrice>();

async function fetchCryptoFiatPrice(
  coinId: string,
  currency: string,
): Promise<FiatPrice> {
  const cacheKey = `${coinId}:${currency}`;
  const cached = _priceCache.get(cacheKey);
  if (cached) return cached;

  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=${currency}&include_24hr_change=true`;
  log("INFO", "fetchCryptoFiatPrice", "Buscando preço na CoinGecko", { coinId, currency });

  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`CoinGecko API retornou HTTP ${resp.status}: ${resp.statusText}`);
  }
  const data = await resp.json() as Record<string, Record<string, number>>;
  const coinData = data[coinId];
  if (!coinData || coinData[currency] === undefined) {
    throw new Error(`Moeda '${currency}' não suportada pela CoinGecko para ${coinId}`);
  }

  const price = coinData[currency];
  const change24h = coinData[`${currency}_24h_change`] ?? 0;
  const symbol = CURRENCY_SYMBOLS[currency] ?? "";

  const result = { currency, price, symbol, change24h };
  _priceCache.set(cacheKey, result);
  log("OK", "fetchCryptoFiatPrice", "Preço obtido", { coinId, currency, price, change24h });
  return result;
}

async function fetchMultiPrice(
  coinIds: string[],
  currency: string,
): Promise<Map<string, FiatPrice>> {
  const results = new Map<string, FiatPrice>();
  const toFetch = coinIds.filter(id => !_priceCache.has(`${id}:${currency}`));

  if (toFetch.length > 0) {
    const idsParam = toFetch.join(",");
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${idsParam}&vs_currencies=${currency}&include_24hr_change=true`;
    log("INFO", "fetchMultiPrice", "Buscando preços na CoinGecko", { coins: toFetch, currency });

    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`CoinGecko API retornou HTTP ${resp.status}: ${resp.statusText}`);
    }
    const data = await resp.json() as Record<string, Record<string, number>>;

    for (const id of toFetch) {
      const coinData = data[id];
      if (!coinData || coinData[currency] === undefined) {
        throw new Error(`Moeda '${currency}' não suportada pela CoinGecko para ${id}`);
      }
      const fp: FiatPrice = {
        currency,
        price: coinData[currency],
        symbol: CURRENCY_SYMBOLS[currency] ?? "",
        change24h: coinData[`${currency}_24h_change`] ?? 0,
      };
      _priceCache.set(`${id}:${currency}`, fp);
      results.set(id, fp);
    }
  }

  for (const id of coinIds) {
    const cached = _priceCache.get(`${id}:${currency}`);
    if (cached) results.set(id, cached);
  }

  return results;
}

async function fetchUsdPrice(coinId: string): Promise<number> {
  const fp = await fetchCryptoFiatPrice(coinId, "usd");
  return fp.price;
}

interface CasPolRate {
  casPerPol: bigint;
  polPerCas: bigint;
  dex: string;
}

async function resolveCasPolRate(
  provider: ethers.JsonRpcProvider,
): Promise<CasPolRate> {
  const casTokenAddr = process.env.CAS_TOKEN_ADDRESS;
  if (!casTokenAddr || !ethers.isAddress(casTokenAddr)) {
    throw new Error("CAS_TOKEN_ADDRESS não definido no .env");
  }
  const refAmount = ethers.parseEther("1");
  const refQuotes = await queryAllDexs(provider, casTokenAddr, refAmount);
  const bestRef = pickBestQuote(refQuotes);
  if (!bestRef) {
    throw new Error("Nenhuma DEX disponível para CAS→POL.");
  }
  return {
    casPerPol: bestRef.effectiveRate,
    polPerCas: (10n ** 18n * 10n ** 18n) / bestRef.effectiveRate,
    dex: bestRef.source,
  };
}

interface QuoteResult {
  sourceToken: QuoteToken;
  amount: bigint;
  destLabel: string;
  destSymbol: string;
  destIsCrypto: boolean;
  destValue: number;
  destCryptoValue?: bigint;
  polEquivalent: bigint;
  gasCostInPol: bigint;
  totalPolNeeded: bigint;
  totalDestValue: number;
  totalDestCrypto?: bigint;
  conversionLines: string[];
  priceInfoLines: string[];
  nextStep: string;
}

async function handleQuote(
  args: ParsedArgs,
  provider: ethers.JsonRpcProvider,
): Promise<QuoteResult> {
  if (!args.quote) throw new Error("--quote não definido");

  const parts = args.quote.toLowerCase().split("/");
  if (parts.length !== 2) {
    throw new Error(
      `Formato inválido: '${args.quote}'. Use <token>/<moeda>, ex: pol/real, cas/usd, eth/pol`,
    );
  }

  const [srcStr, destStr] = parts;
  if (!isQuoteToken(srcStr)) {
    throw new Error(`Token '${srcStr}' não suportado. Use 'pol', 'cas' ou 'eth'`);
  }

  const sourceToken = srcStr as QuoteToken;
  const amountStr = args.vlr ?? "1";
  const amount = ethers.parseEther(amountStr);

  const destIsCrypto = isCryptoDest(destStr);
  const resolvedDest = destIsCrypto ? destStr : (CURRENCY_ALIASES[destStr] ?? destStr);
  const destSymbol = CURRENCY_SYMBOLS[destStr] ?? CURRENCY_SYMBOLS[resolvedDest] ?? "";

  // Pre-fetch all needed CoinGecko prices in a single batch call
  const coinsNeeded: string[] = [];
  const currenciesNeeded: string[] = ["usd"];
  if (!destIsCrypto) currenciesNeeded.push(resolvedDest);

  if (sourceToken === "eth" || destStr === "eth") coinsNeeded.push(COINGECKO_COIN_IDS.eth);
  if (sourceToken === "pol" || sourceToken === "cas" || destStr === "pol" || destStr === "cas" || !destIsCrypto) {
    coinsNeeded.push(COINGECKO_COIN_IDS.pol);
  }

  for (const curr of currenciesNeeded) {
    await fetchMultiPrice(coinsNeeded, curr);
  }

  const { gasPrice } = await getFeeData(provider);

  const transferGas = sourceToken === "pol" ? POL_TRANSFER_GAS : CAS_TRANSFER_GAS;
  const gasCostInPol = transferGas * gasPrice;

  const conversionLines: string[] = [];
  const priceInfoLines: string[] = [];

  // ── Step 1: Convert source → POL ──
  let polEquivalent: bigint;

  if (sourceToken === "pol") {
    polEquivalent = amount;
  } else if (sourceToken === "cas") {
    const rate = await resolveCasPolRate(provider);
    polEquivalent = (amount * rate.polPerCas) / 10n ** 18n;
    conversionLines.push(`CAS→POL via ${rate.dex}: ${ethers.formatEther(rate.casPerPol)} CAS/POL`);
    conversionLines.push(`${ethers.formatEther(amount)} CAS = ${ethers.formatEther(polEquivalent)} POL`);
  } else {
    // ETH → POL via CoinGecko cross rate
    const ethUsd = await fetchUsdPrice(COINGECKO_COIN_IDS.eth);
    const polUsd = await fetchUsdPrice(COINGECKO_COIN_IDS.pol);
    const polPerEth = ethUsd / polUsd;
    polEquivalent = ethers.parseEther((Number(ethers.formatEther(amount)) * polPerEth).toFixed(18));
    priceInfoLines.push(`Preço ETH: $${ethUsd.toFixed(6)} USD`);
    priceInfoLines.push(`Preço POL: $${polUsd.toFixed(6)} USD`);
    conversionLines.push(`ETH→POL (cross rate): 1 ETH = ${polPerEth.toFixed(6)} POL`);
    conversionLines.push(`${ethers.formatEther(amount)} ETH = ${ethers.formatEther(polEquivalent)} POL`);
  }

  // ── Step 2: Convert POL → destination ──
  let destValue: number;
  let destCryptoValue: bigint | undefined;
  let totalDestCrypto: bigint | undefined;

  if (destIsCrypto) {
    if (destStr === "pol") {
      destCryptoValue = polEquivalent;
      destValue = Number(ethers.formatEther(polEquivalent));
    } else if (destStr === "cas") {
      const rate = await resolveCasPolRate(provider);
      destCryptoValue = (polEquivalent * rate.casPerPol) / 10n ** 18n;
      destValue = Number(ethers.formatEther(destCryptoValue));
      conversionLines.push(`POL→CAS via ${rate.dex}: ${ethers.formatEther(rate.casPerPol)} CAS/POL`);
      conversionLines.push(`${ethers.formatEther(polEquivalent)} POL = ${ethers.formatEther(destCryptoValue)} CAS`);
    } else {
      // dest = ETH
      const ethUsd = await fetchUsdPrice(COINGECKO_COIN_IDS.eth);
      const polUsd = await fetchUsdPrice(COINGECKO_COIN_IDS.pol);
      const polPerEth = ethUsd / polUsd;
      destValue = Number(ethers.formatEther(polEquivalent)) / polPerEth;
      destCryptoValue = ethers.parseEther(destValue.toFixed(18));
      if (sourceToken !== "eth") {
        priceInfoLines.push(`Preço ETH: $${ethUsd.toFixed(6)} USD`);
        priceInfoLines.push(`Preço POL: $${polUsd.toFixed(6)} USD`);
        conversionLines.push(`POL→ETH (cross rate): 1 ETH = ${polPerEth.toFixed(6)} POL`);
        conversionLines.push(`${ethers.formatEther(polEquivalent)} POL = ${ethers.formatEther(destCryptoValue)} ETH`);
      }
    }
  } else {
    // Fiat destination
    if (sourceToken === "eth") {
      const fp = await fetchCryptoFiatPrice(COINGECKO_COIN_IDS.eth, resolvedDest);
      destValue = Number(ethers.formatEther(amount)) * fp.price;
      priceInfoLines.push(`Preço ETH: ${fp.symbol} ${fp.price.toFixed(6)} / ETH`);
      priceInfoLines.push(`Variação 24h: ${fp.change24h >= 0 ? "+" : ""}${fp.change24h.toFixed(2)}%`);
    } else {
      // POL or CAS → fiat: use POL price (polEquivalent already computed)
      const fp = await fetchCryptoFiatPrice(COINGECKO_COIN_IDS.pol, resolvedDest);
      destValue = Number(ethers.formatEther(polEquivalent)) * fp.price;
      priceInfoLines.push(`Preço POL: ${fp.symbol} ${fp.price.toFixed(6)} / POL`);
      priceInfoLines.push(`Variação 24h: ${fp.change24h >= 0 ? "+" : ""}${fp.change24h.toFixed(2)}%`);
    }
  }

  // ── Step 3: Gas + totals ──
  const totalPolNeeded = polEquivalent + gasCostInPol;
  let totalDestValue: number;

  if (destIsCrypto) {
    if (destStr === "pol") {
      totalDestCrypto = totalPolNeeded;
      totalDestValue = Number(ethers.formatEther(totalPolNeeded));
    } else if (destStr === "cas") {
      const rate = await resolveCasPolRate(provider);
      totalDestCrypto = (totalPolNeeded * rate.casPerPol) / 10n ** 18n;
      totalDestValue = Number(ethers.formatEther(totalDestCrypto));
    } else {
      const ethUsd = await fetchUsdPrice(COINGECKO_COIN_IDS.eth);
      const polUsd = await fetchUsdPrice(COINGECKO_COIN_IDS.pol);
      const polPerEth = ethUsd / polUsd;
      totalDestValue = Number(ethers.formatEther(totalPolNeeded)) / polPerEth;
      totalDestCrypto = ethers.parseEther(totalDestValue.toFixed(18));
    }
  } else {
    const polFp = await fetchCryptoFiatPrice(COINGECKO_COIN_IDS.pol, resolvedDest);
    const gasFiat = Number(ethers.formatEther(gasCostInPol)) * polFp.price;
    totalDestValue = destValue + gasFiat;
  }

  const nextStep = `Use --src <conta> --dst <conta> --vlr ${ethers.formatEther(amount)} --token ${sourceToken === "pol" ? "pol" : sourceToken === "cas" ? "cas" : "pol"} para executar a transferência.`;

  const result: QuoteResult = {
    sourceToken,
    amount,
    destLabel: destStr.toUpperCase(),
    destSymbol,
    destIsCrypto,
    destValue,
    destCryptoValue,
    polEquivalent,
    gasCostInPol,
    totalPolNeeded,
    totalDestValue,
    totalDestCrypto,
    conversionLines,
    priceInfoLines,
    nextStep,
  };

  printQuoteResult(result, gasPrice, transferGas);
  return result;
}

function printQuoteResult(
  r: QuoteResult,
  gasPrice: bigint,
  transferGas: bigint,
): void {
  const tokenName = r.sourceToken.toUpperCase();
  const destName = r.destLabel;
  const sym = r.destSymbol;

  console.log(`\n${SEP}`);
  console.log(`  Cotação ${tokenName}/${destName}`);
  console.log(SEP);
  console.log(`  Quantidade:        ${ethers.formatEther(r.amount)} ${tokenName}`);
  console.log(`  Moeda destino:     ${destName}${sym ? ` (${sym})` : ""}`);

  for (const line of r.priceInfoLines) {
    console.log(`  ${line}`);
  }

  if (r.conversionLines.length > 0) {
    console.log(`\n  Conversão:`);
    for (const line of r.conversionLines) {
      console.log(`    ${line}`);
    }
  }

  console.log(`\n${SUB}`);
  console.log("  Valor da Transferência");
  console.log(SUB);
  console.log(`  ${tokenName}:           ${ethers.formatEther(r.amount)} ${tokenName}`);
  console.log(`  ≈ POL:             ${ethers.formatEther(r.polEquivalent)} POL`);
  if (r.destIsCrypto && r.destCryptoValue) {
    console.log(`  ≈ ${destName}:            ${ethers.formatEther(r.destCryptoValue)} ${destName}`);
  } else {
    console.log(`  ≈ ${destName}:            ${sym} ${r.destValue.toFixed(2)}`);
  }

  console.log(`\n${SUB}`);
  console.log("  Estimativa de Gas");
  console.log(SUB);
  console.log(`  Gas estimado:      ${transferGas} gas`);
  console.log(`  Gas price:         ${ethers.formatUnits(gasPrice, "gwei")} gwei`);
  console.log(`  Custo gas em POL:  ${ethers.formatEther(r.gasCostInPol)} POL`);

  console.log(`\n${SUB}`);
  console.log("  Total Necessário");
  console.log(SUB);
  console.log(`  POL total:         ${ethers.formatEther(r.totalPolNeeded)} POL`);
  if (r.destIsCrypto && r.totalDestCrypto) {
    console.log(`  ${destName} total:          ${ethers.formatEther(r.totalDestCrypto)} ${destName}`);
  } else {
    console.log(`  ${destName} total:          ${sym} ${r.totalDestValue.toFixed(2)}`);
  }
  console.log(`\n  next_step: ${r.nextStep}`);
  console.log(SEP);
}

// ── Transfer execution ────────────────────────────────────────────────

async function executePolTransfer(
  signer: ethers.Wallet,
  dst: string,
  amount: bigint,
  gasPrice: bigint,
  maxFeePerGas: bigint,
  maxPriorityFeePerGas: bigint,
): Promise<void> {
  log("INFO", "executePolTransfer", "Iniciando transferência POL", {
    from: signer.address, to: dst, amount: ethers.formatEther(amount),
  });

  try {
    const tx = await signer.sendTransaction({
      to: dst,
      value: amount,
      maxFeePerGas,
      maxPriorityFeePerGas,
    });

    console.log(`  TX: ${tx.hash}`);
    console.log(`  Aguardando confirmação...`);

    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      throw new Error(`Transação falhou: ${tx.hash}`);
    }

    const gasUsed = receipt.gasUsed;
    const gasCost = gasUsed * receipt.gasPrice;
    console.log(`  ✅ Transferência POL concluída`);
    console.log(`  Gas usado: ${gasUsed} (${ethers.formatEther(gasCost)} POL)`);
    console.log(`  TX: ${tx.hash}`);

    log("OK", "executePolTransfer", "Transferência POL concluída", {
      txHash: tx.hash, gasUsed: gasUsed.toString(),
    });
  } catch (err: unknown) {
    printFriendlyError(err, "executePolTransfer");
    throw new Error(decodeContractError(err).friendly);
  }
}

async function executeCasTransfer(
  signer: ethers.Wallet,
  casTokenAddr: string,
  dst: string,
  amount: bigint,
  maxFeePerGas: bigint,
  maxPriorityFeePerGas: bigint,
): Promise<void> {
  log("INFO", "executeCasTransfer", "Iniciando transferência CAS", {
    from: signer.address, to: dst, amount: ethers.formatEther(amount),
  });

  const casContract = new ethers.Contract(casTokenAddr, ERC20_ABI, signer);

  // Pré-verificação: checar pause e saldo antes de enviar tx
  try {
    const isPaused = await casContract.paused();
    if (isPaused) {
      throw new Error(`Token CAS está pausado (selector: 0xd93c0665) — transferências bloqueadas`);
    }
  } catch (err: unknown) {
    if ((err as Error).message.includes("pausado")) throw err;
    // paused() pode não existir — continua
  }

  try {
    const tx = await casContract.transfer(dst, amount, {
      maxFeePerGas,
      maxPriorityFeePerGas,
    });

    console.log(`  TX: ${tx.hash}`);
    console.log(`  Aguardando confirmação...`);

    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      throw new Error(`Transação falhou: ${tx.hash}`);
    }

    const gasUsed = receipt.gasUsed;
    const gasCost = gasUsed * receipt.gasPrice;
    console.log(`  ✅ Transferência CAS concluída`);
    console.log(`  Gas usado: ${gasUsed} (${ethers.formatEther(gasCost)} POL)`);
    console.log(`  TX: ${tx.hash}`);

    log("OK", "executeCasTransfer", "Transferência CAS concluída", {
      txHash: tx.hash, gasUsed: gasUsed.toString(),
    });
  } catch (err: unknown) {
    printFriendlyError(err, "executeCasTransfer");
    throw new Error(decodeContractError(err).friendly);
  }
}

async function executeSwap(
  signer: ethers.Wallet,
  casTokenAddr: string,
  quote: DexQuote,
  casAmount: bigint,
  minPolOut: bigint,
  gasPrice: bigint,
  maxFeePerGas: bigint,
  maxPriorityFeePerGas: bigint,
): Promise<bigint> {
  log("INFO", "executeSwap", `Iniciando swap CAS→POL via ${quote.source}`, {
    casAmount: ethers.formatEther(casAmount), dex: quote.source, type: quote.type,
  });

  if (!quote.routerAddr) throw new Error("Router address não definido no quote");

  // Pré-verificação: checar se CAS está pausado antes de tentar swap
  const casContract = new ethers.Contract(casTokenAddr, ERC20_ABI, signer);
  try {
    const isPaused = await casContract.paused();
    if (isPaused) {
      throw new Error(`Token CAS está pausado (selector: 0xd93c0665) — swap bloqueado`);
    }
  } catch (err: unknown) {
    if ((err as Error).message.includes("pausado")) {
      printFriendlyError(err, "executeSwap");
      throw err;
    }
    // paused() pode não existir — continua
  }

  // Step 1: Approve spender to spend CAS
  const currentAllowance = await casContract.allowance(signer.address, quote.routerAddr);

  if (currentAllowance < casAmount) {
    console.log(`  Aprovando ${quote.source} para gastar CAS...`);
    try {
      const approveTx = await casContract.approve(quote.routerAddr, casAmount, {
        maxFeePerGas,
        maxPriorityFeePerGas,
      });
      const approveReceipt = await approveTx.wait();
      if (!approveReceipt || approveReceipt.status !== 1) {
        throw new Error(`Approve falhou: ${approveTx.hash}`);
      }
      console.log(`  ✅ Approve confirmado: ${approveTx.hash}`);
    } catch (err: unknown) {
      printFriendlyError(err, "executeSwap:approve");
      throw new Error(decodeContractError(err).friendly);
    }
  } else {
    console.log(`  Allowance suficiente, pulando approve.`);
  }

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);

  try {
    let sellTx: ethers.TransactionResponse;

    if (quote.type === "casswap") {
      // CASSwap: sellCAS
      const casSwap = new ethers.Contract(quote.routerAddr, CASSWAP_ABI, signer);
      console.log(`  Vendendo CAS no CASSwap...`);
      sellTx = await casSwap.sellCAS(casAmount, minPolOut, deadline, {
        maxFeePerGas,
        maxPriorityFeePerGas,
      });
    } else {
      // DEX V2: swapExactTokensForETH (CAS → WPOL → POL)
      const router = new ethers.Contract(quote.routerAddr, DEX_ROUTER_ABI, signer);
      const path = [casTokenAddr, WPOL_ADDRESS];
      console.log(`  Vendendo CAS no ${quote.source}...`);
      sellTx = await router.swapExactTokensForETH(
        casAmount,
        minPolOut,
        path,
        signer.address,
        deadline,
        {
          maxFeePerGas,
          maxPriorityFeePerGas,
        },
      );
    }

    console.log(`  TX swap: ${sellTx.hash}`);
    console.log(`  Aguardando confirmação...`);

    const sellReceipt = await sellTx.wait();
    if (!sellReceipt || sellReceipt.status !== 1) {
      throw new Error(`Swap falhou: ${sellTx.hash}`);
    }

    const gasUsed: bigint = sellReceipt.gasUsed;
    const gasPriceUsed: bigint = sellReceipt.gasPrice ?? gasPrice;
    const gasCost: bigint = gasUsed * gasPriceUsed;
    console.log(`  ✅ Swap CAS→POL concluído via ${quote.source}`);
    console.log(`  Gas usado: ${gasUsed} (${ethers.formatEther(gasCost)} POL)`);
    console.log(`  TX: ${sellTx.hash}`);

    log("OK", "executeSwap", "Swap concluído", {
      txHash: sellTx.hash, gasUsed: gasUsed.toString(), dex: quote.source,
    });

    return gasCost;
  } catch (err: unknown) {
    printFriendlyError(err, "executeSwap");
    throw new Error(decodeContractError(err).friendly);
  }
}

// ── Main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.sync) {
    console.log(`\n${SEP}`);
    console.log("  Sincronizando chaves privadas do .env → banco de dados");
    console.log(SEP);
    try {
      getDB();
      const result = syncPrivateKeysFromEnv();
      console.log(`  ✅ ${result.synced} chaves sincronizadas, ${result.skipped} ignoradas`);
      const all = getAllPrivateKeys();
      console.log(`\n  Total no banco: ${all.length} contas\n`);
      for (const rec of all) {
        console.log(`  ${rec.name.padEnd(20)} ${rec.address}`);
      }
      console.log();
      closeDB();
    } catch (err) {
      console.error(`❌ Erro ao sincronizar: ${(err as Error).message}`);
      closeDB();
      process.exit(1);
    }
    return;
  }

  if (args.list) {
    const indexed = loadAllAddresses();
    if (indexed.length === 0) {
      console.log("\n  Nenhum endereço encontrado no banco ou .env.");
      console.log("  Configure variáveis X_ADDRESS e X_PRIVATE_KEY no .env ou use --sync.\n");
      return;
    }
    await listAccounts(indexed, args.amoy);
    closeDB();
    return;
  }

  if (args.quote) {
    const provider = getProvider(args.amoy);
    try {
      await handleQuote(args, provider);
    } catch (err) {
      printFriendlyError(err, "handleQuote");
      process.exit(1);
    }
    closeDB();
    return;
  }

  // Validate required args for transfer
  if (!args.src) {
    console.error("❌ --src é obrigatório (ou use --list para listar contas)");
    printHelp();
    process.exit(1);
  }
  if (!args.dst) {
    console.error("❌ --dst é obrigatório (ou use --list para listar contas)");
    printHelp();
    process.exit(1);
  }
  if (!args.vlr) {
    console.error("❌ --vlr é obrigatório (ou use --list para listar contas)");
    printHelp();
    process.exit(1);
  }

  const indexed = loadAllAddresses();
  if (indexed.length === 0) {
    console.error("❌ Nenhum endereço encontrado no banco ou .env.");
    process.exit(1);
  }

  const srcAccount = resolveSource(args.src, indexed);
  const dstAddress = resolveDestination(args.dst, indexed);

  // Detect if #index was used for src or dst — requires double confirmation
  const usedIndexRef = isIndexRef(args.src) || isIndexRef(args.dst);

  if (srcAccount.address.toLowerCase() === dstAddress.toLowerCase()) {
    console.error("❌ Conta de origem e destino são iguais.");
    process.exit(1);
  }

  const amount = ethers.parseEther(args.vlr);
  if (amount <= 0n) {
    console.error("❌ Valor deve ser maior que zero.");
    process.exit(1);
  }

  const provider = getProvider(args.amoy);
  const network = await provider.getNetwork();
  const casTokenAddr = process.env.CAS_TOKEN_ADDRESS;

  console.log(`\n${SEP}`);
  console.log("  Transferência CAS/POL");
  console.log(SEP);
  console.log(`  Rede:       ${network.name} (chainId: ${network.chainId})`);
  console.log(`  Token:      ${args.token.toUpperCase()}`);
  console.log(`  Origem:     ${srcAccount.name} — ${srcAccount.address}`);
  if (srcAccount.dbLabel) console.log(`  Label DB:   ${srcAccount.dbLabel}`);
  console.log(`  Destino:    ${dstAddress}`);
  console.log(`  Valor:      ${ethers.formatEther(amount)} ${args.token.toUpperCase()}`);

  // Get fee data
  const { gasPrice, maxFeePerGas, maxPriorityFeePerGas } = await getFeeData(provider);
  console.log(`  Gas price:  ${ethers.formatUnits(gasPrice, "gwei")} gwei`);

  // Check balances
  const polBalance = await provider.getBalance(srcAccount.address);
  console.log(`\n  Saldo POL (origem): ${ethers.formatEther(polBalance)} POL`);

  if (args.token === "cas") {
    if (!casTokenAddr || !ethers.isAddress(casTokenAddr)) {
      console.error("❌ CAS_TOKEN_ADDRESS não definido no .env");
      process.exit(1);
    }
    const casContract = new ethers.Contract(casTokenAddr, ERC20_ABI, provider);

    // Verificar se o token está pausado antes de prosseguir
    let casPaused = false;
    try {
      casPaused = await casContract.paused();
    } catch {
      // paused() pode não existir em tokens que não são Pausable — ignora
    }
    if (casPaused) {
      if (args.immediate) {
        console.log(`\n  ⚠️  Token CAS está pausado — flag --immediate ativada`);
        console.log(`  O token será despausado antes da transferência e re-pausado após.\n`);
      } else {
        console.error(`\n❌ TOKEN CAS PAUSADO`);
        console.error(`  O contrato CAS Token está pausado — transferências estão bloqueadas.`);
        console.error(`  Opções:`);
        console.error(`    1. Use --immediate para despausar, transferir e re-pausar automaticamente`);
        console.error(`    2. Peça a um PAUSER_ROLE para executar: npm run unpause:cas:polygon`);
        console.error(`    3. Se precisar enviar POL, use --token pol (default)\n`);
        process.exit(1);
      }
    }

    const casBalance = await casContract.balanceOf(srcAccount.address);
    console.log(`  Saldo CAS (origem): ${ethers.formatEther(casBalance)} CAS`);

    if (casBalance < amount) {
      console.error(`❌ Saldo CAS insuficiente: ${ethers.formatEther(casBalance)} < ${ethers.formatEther(amount)}`);
      process.exit(1);
    }
  } else {
    if (polBalance < amount) {
      console.error(`❌ Saldo POL insuficiente: ${ethers.formatEther(polBalance)} < ${ethers.formatEther(amount)}`);
      process.exit(1);
    }
  }

  // Estimate gas
  const transferGas = await estimateTransferGas(
    provider, srcAccount.address, dstAddress, amount, args.token, casTokenAddr,
  );
  const transferGasCost = transferGas * gasPrice;

  console.log(`\n${SUB}`);
  console.log("  Estimativa de Gas");
  console.log(SUB);
  console.log(`  Gas estimado:    ${transferGas} gas`);
  console.log(`  Custo em POL:    ${ethers.formatEther(transferGasCost)} POL`);

  // CAS2POL calculation
  let cas2polResult: Cas2PolResult | null = null;
  if (args.cas2pol) {
    if (args.token !== "pol") {
      console.error("❌ --cas2pol só pode ser usado com --token pol (default)");
      process.exit(1);
    }

    if (!casTokenAddr || !ethers.isAddress(casTokenAddr)) {
      console.error("❌ CAS_TOKEN_ADDRESS não definido no .env");
      process.exit(1);
    }

    cas2polResult = await calculateCas2Pol(
      provider, gasPrice, amount, transferGas, casTokenAddr,
    );
    printCas2PolResult(cas2polResult);

    if (!cas2polResult.bestQuote) {
      console.error("\n❌ Nenhuma DEX disponível para swap CAS→POL.");
      process.exit(1);
    }

    // Check CAS balance for swap
    const casContract = new ethers.Contract(casTokenAddr, ERC20_ABI, provider);
    const casBalance = await casContract.balanceOf(srcAccount.address);
    console.log(`\n  Saldo CAS (origem): ${ethers.formatEther(casBalance)} CAS`);
    console.log(`  CAS necessário:     ${ethers.formatEther(cas2polResult.casNeeded)} CAS`);

    if (casBalance < cas2polResult.casNeeded) {
      console.error(`❌ Saldo CAS insuficiente para swap: ${ethers.formatEther(casBalance)} < ${ethers.formatEther(cas2polResult.casNeeded)}`);
      process.exit(1);
    }

    console.log(`\n  Resumo --cas2pol:`);
    console.log(`    DEX:       ${cas2polResult.bestQuote.source} (${cas2polResult.bestQuote.type})`);
    console.log(`    Vender:    ${ethers.formatEther(cas2polResult.casNeeded)} CAS`);
    console.log(`    Receber:   ~${ethers.formatEther(cas2polResult.bestQuote.polOut)} POL`);
    console.log(`    Perda:     ${ethers.formatEther(cas2polResult.feeInCas)} CAS (${ethers.formatEther(cas2polResult.feeInPol)} POL)`);
  }

  // Check if source has enough POL for gas
  const totalGasNeeded = cas2polResult
    ? cas2polResult.totalGas
    : transferGas;
  const totalGasCost = totalGasNeeded * gasPrice;

  if (polBalance < totalGasCost) {
    console.error(`\n❌ Saldo POL insuficiente para gas: ${ethers.formatEther(polBalance)} < ${ethers.formatEther(totalGasCost)}`);
    if (!args.cas2pol) {
      console.error("   Dica: use --cas2pol para vender CAS e obter POL para gas.");
    }
    process.exit(1);
  }

  // Confirmation
  console.log(`\n${SUB}`);
  console.log("  Confirmação");
  console.log(SUB);
  console.log(`  Transferir: ${ethers.formatEther(amount)} ${args.token.toUpperCase()}`);
  console.log(`  De:         ${srcAccount.name} — ${srcAccount.address}`);
  console.log(`  Para:       ${dstAddress}`);
  console.log(`  Gas:        ~${ethers.formatEther(transferGasCost)} POL`);

  if (cas2polResult && cas2polResult.bestQuote) {
    console.log(`  Swap:       Vender ${ethers.formatEther(cas2polResult.casNeeded)} CAS via ${cas2polResult.bestQuote.source} → ~${ethers.formatEther(cas2polResult.bestQuote.polOut)} POL`);
    console.log(`  Perda:      ${ethers.formatEther(cas2polResult.feeInCas)} CAS (${ethers.formatEther(cas2polResult.feeInPol)} POL)`);
  }

  if (usedIndexRef && !args.yes) {
    console.log(`\n${SUB}`);
    console.log("  ⚠️  AVISO: Referência por índice (#) usada");
    console.log(SUB);
    console.log(`  Índices podem mudar quando novos endereços são adicionados ao banco.`);
    console.log(`  Confirme se os endereços resolvidos estão corretos:\n`);
    console.log(`  Origem (--${isIndexRef(args.src) ? "src #" + args.src.slice(1) : "src"}):`);
    console.log(`    ${srcAccount.name} — ${srcAccount.address}`);
    if (srcAccount.dbLabel) console.log(`    Label: ${srcAccount.dbLabel}`);
    console.log(`  Destino (--${isIndexRef(args.dst) ? "dst #" + args.dst.slice(1) : "dst"}):`);

    // Find dst in indexed to show its name
    const dstEntry = indexed.find(a => a.address.toLowerCase() === dstAddress.toLowerCase());
    const dstName = dstEntry?.name || dstEntry?.dbLabel || "(sem nome)";
    const dstAddrStr = String(dstAddress);
    console.log(`    ${dstName}`);
    console.log(`    Endereço: ${dstAddrStr}`);

    const ok1 = await confirm("Os endereços acima estão corretos?", false);
    if (!ok1) {
      console.log("\n  Transação cancelada — endereços não confirmados.");
      closeRl();
      closeDB();
      return;
    }
  }

  if (!args.yes) {
    const ok = await confirm("Deseja continuar com a transação?", false);
    if (!ok) {
      console.log("\n  Transação cancelada pelo usuário.");
      closeRl();
      closeDB();
      return;
    }
  }

  // Execute
  const signer = getSigner(srcAccount, args.amoy);

  // Flag --immediate: encontra conta com PAUSER_ROLE para despausar/re-pausar
  let wasPaused = false;
  let pauserSigner: ethers.Wallet | null = null;
  if (args.immediate && args.token === "cas" && casTokenAddr) {
    const casCheck = new ethers.Contract(casTokenAddr, CAS_PAUSE_ABI, provider);
    try {
      wasPaused = await casCheck.paused();
    } catch {
      // paused() pode não existir — ignora
    }
    if (wasPaused) {
      console.log(`\n  🔍 Procurando conta com PAUSER_ROLE...`);
      const pauserAccount = await findPauserAccount(indexed, casTokenAddr, provider);
      if (!pauserAccount) {
        console.error(`\n❌ Nenhuma conta com PAUSER_ROLE encontrada.`);
        console.error(`  Contas verificadas por prioridade: ${PAUSER_PRIORITY.join(", ")}`);
        console.error(`  Certifique-se de que uma dessas contas tem PAUSER_ROLE no CASToken.\n`);
        process.exit(1);
      }
      pauserSigner = getSigner(pauserAccount, args.amoy);
      console.log(`  ✅ Conta pauser: ${pauserAccount.name} — ${pauserAccount.address}\n`);
      await unpauseCasToken(pauserSigner, casTokenAddr, maxFeePerGas, maxPriorityFeePerGas);
    }
  }

  try {
    if (cas2polResult && cas2polResult.bestQuote && casTokenAddr) {
      // Execute swap first via best DEX, then transfer
      const minPolOut = (cas2polResult.bestQuote.polOut * 95n) / 100n; // 5% slippage tolerance
      await executeSwap(
        signer,
        casTokenAddr,
        cas2polResult.bestQuote,
        cas2polResult.casNeeded,
        minPolOut,
        gasPrice,
        maxFeePerGas,
        maxPriorityFeePerGas,
      );

      // Check new POL balance
      const newPolBalance = await provider.getBalance(srcAccount.address);
      console.log(`\n  Novo saldo POL: ${ethers.formatEther(newPolBalance)} POL`);

      if (newPolBalance < amount + transferGasCost) {
        console.error(`❌ Após swap, saldo POL ainda insuficiente para transferência.`);
        process.exit(1);
      }

      await executePolTransfer(
        signer, dstAddress, amount,
        gasPrice, maxFeePerGas, maxPriorityFeePerGas,
      );
    } else if (args.token === "pol") {
      await executePolTransfer(
        signer, dstAddress, amount,
        gasPrice, maxFeePerGas, maxPriorityFeePerGas,
      );
    } else {
      if (!casTokenAddr) {
        console.error("❌ CAS_TOKEN_ADDRESS não definido");
        process.exit(1);
      }
      await executeCasTransfer(
        signer, casTokenAddr, dstAddress, amount,
        maxFeePerGas, maxPriorityFeePerGas,
      );
    }
  } finally {
    // Flag --immediate: re-pausa o token CAS após a transferência
    if (args.immediate && wasPaused && casTokenAddr && pauserSigner) {
      try {
        await pauseCasToken(pauserSigner, casTokenAddr, maxFeePerGas, maxPriorityFeePerGas);
      } catch (err: unknown) {
        printFriendlyError(err, "pauseCasToken (re-pause)");
        log("ERROR", "main", "Falha ao re-pausar token CAS — token permanece despausado!", {
          error: (err as Error).message,
        });
      }
    }
  }

  // Final balance
  const finalPolBalance = await provider.getBalance(srcAccount.address);
  console.log(`\n${SEP}`);
  console.log("  Resumo");
  console.log(SEP);
  console.log(`  Saldo POL final (origem): ${ethers.formatEther(finalPolBalance)} POL`);
  console.log(`${SEP}\n`);

  closeRl();
  closeDB();
}

main().catch((err) => {
  printFriendlyError(err, "main");
  closeRl();
  closeDB();
  process.exit(1);
});
