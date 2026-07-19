import { ethers } from "hardhat";
import type { ContractFactory, Signer, Contract, TransactionResponse, TransactionReceipt } from "ethers";

// ── Formatting helpers ────────────────────────────────────────────────

export const SEP = "=".repeat(72);
export const SUB = "-".repeat(72);

export function fmtPOL(wei: bigint): string {
  return `${ethers.formatEther(wei)} POL`;
}

export function fmtGwei(wei: bigint): string {
  return `${ethers.formatUnits(wei, "gwei")} gwei`;
}

// ── Network info ──────────────────────────────────────────────────────

/**
 * POL existe em duas redes distintas:
 *
 *   1. Polygon PoS (sidechain independente)
 *      - Mainnet: chainId 137, RPC: https://polygon-rpc.com
 *      - Testnet (Amoy): chainId 80002, RPC: https://rpc-amoy.polygon.technology
 *      - POL e a moeda nativa (usada para gas)
 *      - Rede propria, separada da Ethereum
 *
 *   2. Ethereum Mainnet (L1)
 *      - chainId 1
 *      - POL existe como ERC-20 (nao nativo)
 *      - ETH e a moeda nativa para gas
 *      - Nao usamos esta rede para deploy dos contratos
 *
 * Usamos exclusivamente a Polygon PoS (sidechain) para deploy.
 */
const NETWORK_INFO: Record<number, { name: string; type: string; nativeToken: string; isPolygonPoS: boolean }> = {
  137:   { name: "Polygon PoS Mainnet", type: "Sidechain (separada da Ethereum)", nativeToken: "POL", isPolygonPoS: true },
  80002: { name: "Polygon Amoy Testnet", type: "Sidechain (separada da Ethereum)", nativeToken: "POL", isPolygonPoS: true },
  1:     { name: "Ethereum Mainnet", type: "L1", nativeToken: "ETH", isPolygonPoS: false },
  31337: { name: "Hardhat Local", type: "Desenvolvimento local", nativeToken: "ETH (mock)", isPolygonPoS: false },
};

export function getNetworkInfo(chainId: number) {
  return NETWORK_INFO[chainId] ?? {
    name: `Chain ${chainId}`,
    type: "Desconhecida",
    nativeToken: "?",
    isPolygonPoS: false,
  };
}

// ── Types ─────────────────────────────────────────────────────────────

export interface DeployStep {
  label: string;
  gas: bigint;
}

export interface PreFlightResult {
  balance: bigint;
  gasPrice: bigint;
  totalCost: bigint;
  surplus: bigint;
}

// ── Pre-flight check ──────────────────────────────────────────────────

/**
 * Prints a human-readable header with deployer address, balance, gas price,
 * per-step cost breakdown, and aborts if balance is insufficient.
 *
 * Returns the gasPrice to use for all transactions.
 */
export async function preFlightCheck(
  title: string,
  steps: DeployStep[],
  options?: { extraInfo?: { label: string; value: string }[] },
): Promise<PreFlightResult> {
  const [deployer] = await ethers.getSigners();
  const provider = deployer.provider!;

  // Detect network
  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);
  const netInfo = getNetworkInfo(chainId);

  console.log(`\n${SEP}`);
  console.log(`  ${title}`);
  console.log(SEP);

  // Network info
  console.log(`\n${SUB}`);
  console.log("  Rede (POL)");
  console.log(SUB);
  console.log(`  Rede:       ${netInfo.name}`);
  console.log(`  Chain ID:   ${chainId}`);
  console.log(`  Tipo:       ${netInfo.type}`);
  console.log(`  Token:      ${netInfo.nativeToken} (nativo para gas)`);
  if (netInfo.isPolygonPoS) {
    console.log(`  Status:     Polygon PoS sidechain (separada da Ethereum)`);
  } else if (chainId === 1) {
    console.log(`  AVISO:      Ethereum Mainnet! POL aqui e ERC-20, nao nativo.`);
    console.log(`              Nao usamos esta rede para deploy. Use --network polygonAmoy ou --network polygon.`);
  }

  // Extra info (env params, etc.)
  if (options?.extraInfo && options.extraInfo.length > 0) {
    console.log();
    for (const info of options.extraInfo) {
      console.log(`  ${info.label.padEnd(22)} ${info.value}`);
    }
  }

  // Balance & gas price
  const balance = await provider.getBalance(deployer.address);
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? 25_000_000_000n;

  console.log(`\n${SUB}`);
  console.log("  Saldo Atual");
  console.log(SUB);
  console.log(`  Carteira:   ${deployer.address}`);
  console.log(`  Saldo:      ${fmtPOL(balance)}`);
  console.log(`  Gas price:  ${fmtGwei(gasPrice)}`);

  // Per-step cost
  console.log(`\n${SUB}`);
  console.log("  Custo Estimado por Passo");
  console.log(SUB);

  let totalCost = 0n;
  for (const step of steps) {
    const cost = step.gas * gasPrice;
    totalCost += cost;
    console.log(`  ${step.label.padEnd(30)} ~${step.gas.toString()} gas  ${fmtPOL(cost)}`);
  }

  console.log(`  ${"Total estimado:".padEnd(30)} ${" ".repeat(13)}${fmtPOL(totalCost)}`);
  console.log(`  ${"Saldo disponivel:".padEnd(30)} ${" ".repeat(13)}${fmtPOL(balance)}`);

  const deficit = totalCost - balance;
  if (deficit > 0n) {
    console.log(`\n  SALDO INSUFICIENTE`);
    console.log(`    Deficit:     ${fmtPOL(deficit)}`);
    console.log(`    Necessario:  ${fmtPOL(totalCost)}`);
    console.log(`    Disponivel:  ${fmtPOL(balance)}`);
    console.log(`\n  Como resolver:`);
    console.log(`    1. Obtenha POL via faucet:`);
    console.log(`       https://faucet.polygon.technology/`);
    console.log(`       https://www.alchemy.com/faucets/polygon-amoy`);
    console.log(`    2. Ou transfira POL de outra carteira para:`);
    console.log(`       ${deployer.address}`);
    console.log(`    3. Tente novamente apos receber os fundos.`);
    process.exit(1);
  }

  const surplus = balance - totalCost;
  console.log(`  ${"Sobra apos deploy:".padEnd(30)} ${" ".repeat(13)}${fmtPOL(surplus)}`);
  console.log(`\n  Saldo suficiente. Prosseguindo...\n`);

  return { balance, gasPrice, totalCost, surplus };
}

// ── Gas estimation helpers ────────────────────────────────────────────

/**
 * Estimate gas for a contract deployment from bytecode.
 * Adds a 20% safety margin. Falls back to bytecode-size heuristic.
 */
export async function estimateDeployGas(
  factory: ContractFactory,
  deployer: Signer,
): Promise<bigint> {
  try {
    const provider = deployer.provider!;
    const gas = await provider.estimateGas({
      from: await deployer.getAddress(),
      data: factory.bytecode,
    });
    return (gas * 120n) / 100n;
  } catch {
    const codeSize = (factory.bytecode.length - 2) / 2;
    const fallback = 21000n + BigInt(200 * Math.ceil(codeSize / 32)) + 200_000n;
    return (fallback * 130n) / 100n;
  }
}

/**
 * Estimate gas for a function call. Adds 20% safety margin.
 * Falls back to provided default if estimation fails.
 */
export async function estimateFunctionGas(
  contract: Contract,
  fn: string,
  args: any[],
  fallback: bigint,
): Promise<bigint> {
  try {
    const gas = await (contract as any)[fn].estimateGas(...args);
    return (gas * 120n) / 100n;
  } catch {
    return fallback;
  }
}

// ── Transaction helpers ───────────────────────────────────────────────

/**
 * Send a transaction, wait for receipt, verify status, and print gas used.
 * Aborts with human-readable error on failure.
 */
export async function sendAndVerify(
  label: string,
  txPromise: Promise<TransactionResponse>,
  gasPrice: bigint,
  gasLimit?: bigint,
): Promise<TransactionReceipt> {
  console.log(`${SUB}`);
  console.log(`  ${label}`);
  console.log(SUB);

  const tx = await txPromise;
  console.log(`  TX: ${tx.hash}`);
  console.log(`  Aguardando confirmacao...`);

  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    console.log(`\n  FALHA em: ${label}`);
    console.log(`    Status: ${receipt?.status ?? "desconhecido"}`);
    console.log(`    Gas usado: ${receipt?.gasUsed.toString() ?? "?"}`);
    console.log(`    TX: ${tx.hash}`);
    process.exit(1);
  }

  console.log(`  OK: ${label}`);
  console.log(`  Gas usado: ${receipt.gasUsed} (${fmtPOL(receipt.gasUsed * gasPrice)})\n`);

  return receipt as unknown as TransactionReceipt;
}

// ── Env validation helper ─────────────────────────────────────────────

/**
 * Validate that required environment variables are set.
 * Prints human-readable error and exits if any are missing.
 */
export function requireEnv(vars: string[]): Record<string, string> {
  const missing: string[] = [];
  const values: Record<string, string> = {};

  for (const v of vars) {
    const val = process.env[v];
    if (!val || val === "") {
      missing.push(v);
    } else {
      values[v] = val;
    }
  }

  if (missing.length > 0) {
    console.log(`\n  ERRO: Variaveis de ambiente ausentes no .env:`);
    for (const v of missing) console.log(`    - ${v}`);
    console.log(`\n  Corrija e tente novamente.`);
    process.exit(1);
  }

  return values;
}

// ── Summary helper ────────────────────────────────────────────────────

/**
 * Print a final deployment summary with balance spent and next steps.
 */
export async function printSummary(
  title: string,
  lines: { label: string; value: string }[],
  initialBalance: bigint,
  nextSteps: string[],
): Promise<void> {
  const [deployer] = await ethers.getSigners();
  const provider = deployer.provider!;
  const finalBalance = await provider.getBalance(deployer.address);
  const totalSpent = initialBalance - finalBalance;

  const network = await provider.getNetwork();
  const netInfo = getNetworkInfo(Number(network.chainId));

  console.log(`${SEP}`);
  console.log(`  ${title}`);
  console.log(SEP);
  console.log(`  ${"Rede:".padEnd(22)} ${netInfo.name} (chainId: ${network.chainId})`);
  for (const line of lines) {
    console.log(`  ${line.label.padEnd(22)} ${line.value}`);
  }
  console.log(`  ${"Total gasto:".padEnd(22)} ${fmtPOL(totalSpent)}`);
  console.log(`  ${"Saldo restante:".padEnd(22)} ${fmtPOL(finalBalance)}`);
  console.log(`\n  Proximos passos:`);
  for (let i = 0; i < nextSteps.length; i++) {
    console.log(`    ${i + 1}. ${nextSteps[i]}`);
  }
  console.log(`${SEP}\n`);
}
