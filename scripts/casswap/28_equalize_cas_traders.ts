/**
 * @file 28_equalize_cas_traders.ts
 * @notice Equaliza o saldo de CAS entre as contas trader listadas em um CSV e
 *         as contas operacionais (Deployer e Relayer), de modo que todas
 *         terminem com o MESMO saldo. A origem dos fundos é o signer padrão da
 *         rede (POLYGON_PRIVATE_KEY — o Deployer) — nenhum mint é executado.
 * @dev    Formato do CSV (header obrigatório, nomes flexíveis):
 *           nome, endereco, chave_privada
 *         Apenas a coluna de endereço (e opcionalmente a de nome) é usada;
 *         a coluna `chave_privada` é ignorada e nunca usada para assinatura.
 *
 *         Alvo dinâmico:
 *           E = floor(totalBalance / N)
 *           totalBalance = saldo(deployer) + saldo(relayer) + Σ saldo(traders)
 *           N = traders + relayer + deployer
 *
 *         Para cada carteira (exceto o deployer): se saldo < E, o deployer
 *         transfere (E - saldo) via CAS.transfer. Carteiras já acima de E não
 *         são tocadas (o script nunca retira CAS de terceiros). O restante
 *         (E + T mod N, ≤ 10 wei) permanece no deployer.
 *
 *         Idempotente: o deficit é recalculado a partir do saldo on-chain no
 *         momento de cada envio; re-execução após falha parcial só envia as
 *         transferências ainda necessárias.
 *
 *         Regras de segurança: aborta se qualquer linha tiver endereço
 *         inválido/duplicado, contrato pausado, ou POL insuficiente para gas.
 *         As versões do CAS sem isFrozen/isVotingLockActive são toleradas —
 *         se a função existir on-chain, a checagem é aplicada; se reverter,
 *         a regra é considerada inexistente na implantação atual.
 *         DRY_RUN é o padrão — só envia tx com DRY_RUN=false.
 *
 *         Uso:
 *           DRY_RUN=true  npx hardhat run scripts/casswap/28_equalize_cas_traders.ts --network polygon
 *           DRY_RUN=false npx hardhat run scripts/casswap/28_equalize_cas_traders.ts --network polygon
 *
 *         Variáveis:
 *           TRADERS_CSV — caminho do CSV (default:
 *                         data/rapport_trader_contas_2026-08-03.csv)
 *           RELAYER_ADDRESS — carteira extra a equalizar (opcional; se
 *                             ausente, só deployer + traders são equalizados)
 *
 * Author:  Carlos Delfino
 * Email:   consultoria@carlosdelfino.eti.br
 * WhatsApp: +55 (85) 98520-5490
 */

import "dotenv/config";
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import {
  SEP,
  SUB,
  fmtPOL,
  fmtGwei,
  getNetworkInfo,
  requireEnv,
} from "../utils/deploy_helpers";
import { parseCsv } from "../utils/cas_csv_import";

const FILE = "scripts/casswap/28_equalize_cas_traders.ts";
const SC_ROOT = path.resolve(__dirname, "..", "..");

const DEFAULT_CSV = path.join("data", "rapport_trader_contas_2026-08-03.csv");
const GAS_FALLBACK_TRANSFER = 120_000n;

const CAS_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function paused() view returns (bool)",
  "function isFrozen(address account) view returns (bool)",
  "function isVotingLockActive() view returns (bool)",
];

type LogLevel = "INFO" | "WARN" | "ERROR" | "OK" | "DEBUG";
function log(level: LogLevel, fn: string, msg: string, p?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const e = { INFO: "ℹ️", WARN: "⚠️", ERROR: "❌", OK: "✅", DEBUG: "🔍" }[level];
  console.log(`[${ts}] [${FILE}:${fn}] ${e} ${msg}${p ? ` - ${JSON.stringify(p)}` : ""}`);
}

// ── CSV ───────────────────────────────────────────────────────────────

/** Resolve o caminho do CSV: env TRADERS_CSV, argumento posicional *.csv ou default. */
function resolveCsvPath(): string {
  const envPath = (process.env.TRADERS_CSV ?? "").trim();
  if (envPath) return path.isAbsolute(envPath) ? envPath : path.join(SC_ROOT, envPath);
  const arg = process.argv.find((a) => a.toLowerCase().endsWith(".csv"));
  if (arg) return path.isAbsolute(arg) ? arg : path.resolve(process.cwd(), arg);
  return path.join(SC_ROOT, DEFAULT_CSV);
}

/** Normaliza header: minúsculas, sem acento, sem separadores. */
function normalizeHeader(h: string): string {
  return h
    .toLowerCase()
    .trim()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

const ADDR_SET = new Set(["endereco", "address", "addr", "wallet", "carteira", "publickey", "recipient", "destino", "to"]);
const NAME_SET = new Set(["nome", "name", "titular", "conta", "label", "identificacao"]);

interface WalletRow {
  lineNo: number;
  name: string;
  address: string;
}

/** Lê o CSV e retorna as linhas (endereço + nome). Erros coletados em `errors`. */
function readTraders(csvPath: string): { rows: WalletRow[]; errors: string[] } {
  const content = fs.readFileSync(csvPath, "utf8").replace(/^﻿/, "");
  const table = parseCsv(content);
  const errors: string[] = [];
  if (table.length < 2) {
    errors.push(`CSV vazio ou sem linhas de dados: ${csvPath}`);
    return { rows: [], errors };
  }
  const header = table[0];
  let addrCol = -1;
  let nameCol = -1;
  header.forEach((h, i) => {
    const n = normalizeHeader(h);
    if (addrCol < 0 && ADDR_SET.has(n)) addrCol = i;
    else if (nameCol < 0 && NAME_SET.has(n)) nameCol = i;
  });
  if (addrCol < 0) {
    errors.push(`header do CSV precisa de uma coluna de endereço (ex.: 'endereco'). Header: ${header.join(" | ")}`);
    return { rows: [], errors };
  }

  const rows: WalletRow[] = [];
  const seen = new Map<string, number>();
  for (let i = 1; i < table.length; i++) {
    const fields = table[i];
    const lineNo = i + 1;
    const rawAddr = (fields[addrCol] ?? "").trim();
    if (!rawAddr) continue;
    const name = nameCol >= 0 ? (fields[nameCol] ?? "").trim() : "";
    if (!ethers.isAddress(rawAddr)) {
      errors.push(`linha ${lineNo}: endereço inválido "${rawAddr}"`);
      continue;
    }
    const addr = ethers.getAddress(rawAddr);
    const prev = seen.get(addr.toLowerCase());
    if (prev !== undefined) {
      errors.push(`linha ${lineNo}: endereço duplicado (já na linha ${prev}) "${addr}"`);
      continue;
    }
    seen.set(addr.toLowerCase(), lineNo);
    rows.push({ lineNo, name, address: addr });
  }
  return { rows, errors };
}

// ── Main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\n${SEP}`);
  console.log("  Equalização de saldo CAS — traders + Deployer + Relayer");
  console.log(SEP);

  const dryRun = (process.env.DRY_RUN ?? "true").toLowerCase() !== "false";
  const env = requireEnv(["CAS_TOKEN_ADDRESS"]);

  // ── Signer de origem (Deployer = POLYGON_PRIVATE_KEY) ──────────────
  const [deployer] = await ethers.getSigners();
  const provider = deployer.provider!;
  const chainId = Number((await provider.getNetwork()).chainId);
  const netInfo = getNetworkInfo(chainId);
  const cas = new ethers.Contract(env.CAS_TOKEN_ADDRESS, CAS_ABI, deployer);

  // ── CSV + carteiras participantes ──────────────────────────────────
  const csvPath = resolveCsvPath();
  if (!fs.existsSync(csvPath)) {
    console.log(`\n  ERRO: arquivo não encontrado: ${csvPath}\n`);
    process.exit(1);
  }
  const { rows, errors } = readTraders(csvPath);
  if (errors.length > 0) {
    console.log(`\n${SUB}\n  ERROS no CSV — nada será transferido\n${SUB}`);
    for (const e of errors) console.log(`  - ${e}`);
    console.log();
    process.exit(1);
  }
  if (rows.length === 0) {
    console.log(`\n  Nenhuma carteira no CSV. Nada a fazer.\n`);
    return;
  }

  const wallets: WalletRow[] = [...rows];
  const relayerAddr = (process.env.RELAYER_ADDRESS ?? "").trim();
  if (relayerAddr && ethers.isAddress(relayerAddr)
      && relayerAddr.toLowerCase() !== deployer.address.toLowerCase()
      && !wallets.some((w) => w.address.toLowerCase() === relayerAddr.toLowerCase())) {
    wallets.push({ lineNo: 0, name: "Relayer (backend)", address: ethers.getAddress(relayerAddr) });
  }
  wallets.push({ lineNo: 0, name: "Deployer (origem)", address: deployer.address });

  console.log(`\n${SUB}\n  Rede\n${SUB}`);
  console.log(`  Rede:     ${netInfo.name} (${chainId})`);
  console.log(`  Modo:     ${dryRun ? "DRY-RUN (nenhuma tx será enviada)" : "EXECUÇÃO"}`);
  console.log(`  Origem:   ${deployer.address} (Deployer)`);
  console.log(`  CAS:      ${env.CAS_TOKEN_ADDRESS}`);
  console.log(`  CSV:      ${csvPath}`);
  console.log(`  Carteiras: ${wallets.length} (${rows.length} traders + extras)`);

  // ── Estado do contrato ─────────────────────────────────────────────
  const paused = await cas.paused();
  if (paused) {
    log("ERROR", "main", "CASToken pausado — transferências impossíveis");
    process.exit(1);
  }
  const votingLock = await cas.isVotingLockActive().catch(() => false);
  const frozenFn = (a: string) => cas.isFrozen(a).catch(() => false);

  // ── Saldos e alvo igualitário ──────────────────────────────────────
  interface PlanRow extends WalletRow {
    balance: bigint;
    deficit: bigint;
    frozen: boolean;
    isDeployer: boolean;
  }
  const plan: PlanRow[] = [];
  const blockers: string[] = [];
  for (const w of wallets) {
    const [balance, frozen] = await Promise.all([cas.balanceOf(w.address), frozenFn(w.address)]);
    const isDeployer = w.address.toLowerCase() === deployer.address.toLowerCase();
    plan.push({ ...w, balance, deficit: 0n, frozen, isDeployer });
    if (frozen) blockers.push(`${w.name || w.address} está CONGELADO`);
  }
  if (blockers.length > 0) {
    console.log(`\n${SUB}\n  BLOQUEIOS — nada será transferido\n${SUB}`);
    for (const b of blockers) console.log(`  - ${b}`);
    console.log();
    process.exit(1);
  }
  if (votingLock) {
    log("ERROR", "main", "Voting lock ativo — transferências bloqueadas");
    process.exit(1);
  }

  const total = plan.reduce((s, r) => s + r.balance, 0n);
  const n = BigInt(plan.length);
  const equal = total / n; // floor; resto (≤ N-1 wei) fica no deployer
  for (const r of plan) r.deficit = equal > r.balance ? equal - r.balance : 0n;

  const toSend = plan.filter((r) => !r.isDeployer && r.deficit > 0n);
  const above = plan.filter((r) => !r.isDeployer && r.balance > equal);
  const totalOut = toSend.reduce((s, r) => s + r.deficit, 0n);
  const deployerFinal = total - toSend.reduce((s, r) => s + r.deficit, 0n) - plan.filter((r) => !r.isDeployer).reduce((s, r) => s + r.balance, 0n);

  console.log(`\n${SUB}\n  Alvo igualitário\n${SUB}`);
  console.log(`  Total em jogo:   ${ethers.formatEther(total)} CAS`);
  console.log(`  Carteiras:       ${plan.length}`);
  console.log(`  Alvo (E):        ${ethers.formatEther(equal)} CAS por carteira`);
  if (above.length > 0) {
    console.log(`\n  ATENÇÃO: ${above.length} carteira(s) já acima de E — não serão reduzidas:`);
    for (const a of above) console.log(`    ${a.name || a.address} — ${ethers.formatEther(a.balance)} CAS`);
    console.log(`  (o deployer não pode retirar CAS de terceiros; a equalização será parcial)`);
  }

  // ── Tabela de provisão ─────────────────────────────────────────────
  console.log(`\n${SUB}\n  Plano de distribuição\n${SUB}`);
  console.log(
    `  ${"Carteira".padEnd(34)}${"Endereço".padEnd(44)}${"Saldo atual".padStart(20)}${"A enviar".padStart(20)}`,
  );
  for (const r of plan) {
    const tag = r.isDeployer ? " (origem)" : r.deficit === 0n ? " (sem ação)" : "";
    console.log(
      `  ${(r.name || "-").slice(0, 32).padEnd(34)}${r.address.padEnd(44)}${ethers.formatEther(r.balance).padStart(20)}${(r.deficit > 0n ? ethers.formatEther(r.deficit) : "0").padStart(20)}${tag}`,
    );
  }
  console.log(`\n  Transferências:    ${toSend.length}`);
  console.log(`  Total a enviar:    ${ethers.formatEther(totalOut)} CAS`);
  console.log(`  Deployer final:    ~${ethers.formatEther(deployerFinal)} CAS (E + resto < ${n} wei)`);

  if (toSend.length === 0) {
    console.log(`\n  Todas as carteiras já estão equalizadas. Nada a fazer.\n`);
    return;
  }

  // ── Estimativa de gas ──────────────────────────────────────────────
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? 30_000_000_000n;
  const deployerPol = await provider.getBalance(deployer.address);
  let totalGas = 0n;
  const gasPerTx: bigint[] = [];
  for (const r of toSend) {
    let g = GAS_FALLBACK_TRANSFER;
    try {
      g = (await cas.transfer.estimateGas(r.address, r.deficit)) * 12n / 10n;
    } catch {
      // fallback silencioso — estimativa conservadora
    }
    gasPerTx.push(g);
    totalGas += g;
  }
  const totalCost = totalGas * gasPrice;
  const costMargin = (totalCost * 120n) / 100n;

  console.log(`\n${SEP}\n  TABELA DE PROVISÃO — gas na ${netInfo.name}\n${SEP}`);
  console.log(`  Gas price:           ${fmtGwei(gasPrice)}`);
  console.log(`  Gas estimado total:  ${totalGas.toString()} (${toSend.length} transfers)`);
  console.log(`  Custo estimado:      ${fmtPOL(totalCost)} (+20% = ${fmtPOL(costMargin)})`);
  console.log(`  Saldo POL deployer:  ${fmtPOL(deployerPol)}`);
  if (deployerPol < costMargin) {
    log("ERROR", "main", "POL insuficiente para gas no deployer", {
      necessario: fmtPOL(costMargin),
      disponivel: fmtPOL(deployerPol),
    });
    process.exit(1);
  }

  if (dryRun) {
    console.log(`\n${SEP}`);
    console.log(`  DRY-RUN concluído — nenhuma transação enviada.`);
    console.log(`  Para executar: DRY_RUN=false npx hardhat run ${FILE} --network polygon`);
    console.log(`${SEP}\n`);
    return;
  }

  // ── Execução ───────────────────────────────────────────────────────
  let sent = 0;
  let sentTotal = 0n;
  for (let i = 0; i < toSend.length; i++) {
    const r = toSend[i];
    // Rechecagem do deficit no momento do envio (idempotência real)
    const bal = await cas.balanceOf(r.address);
    const deficit = equal - bal;
    if (deficit <= 0n) {
      console.log(`\n  ${r.address} já no alvo (${ethers.formatEther(bal)} CAS) — pulando`);
      continue;
    }
    console.log(`\n${SUB}\n  Transfer ${i + 1}/${toSend.length}: ${r.name || r.address}\n${SUB}`);
    console.log(`  ${ethers.formatEther(deficit)} CAS → ${r.address}`);
    const tx = await cas.transfer(r.address, deficit, { gasLimit: gasPerTx[i] });
    console.log(`  TX: ${tx.hash}`);
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      log("ERROR", "main", "Transferência falhou on-chain — abortando (re-execução retoma do ponto de falha)", {
        hash: tx.hash,
        to: r.address,
      });
      process.exit(1);
    }
    sent += 1;
    sentTotal += deficit;
    const balAfter = await cas.balanceOf(r.address);
    log("INFO", "main", "transfer confirmada", {
      hash: tx.hash,
      gasUsed: receipt.gasUsed.toString(),
      to: r.address,
      saldoFinal: ethers.formatEther(balAfter),
    });
  }

  const deployerCasAfter = await cas.balanceOf(deployer.address);
  console.log(`\n${SEP}`);
  console.log(`  Concluído — ${sent} transferências, ${ethers.formatEther(sentTotal)} CAS distribuídos`);
  console.log(`  Saldo CAS deployer final: ${ethers.formatEther(deployerCasAfter)} CAS`);
  console.log(`${SEP}\n`);
}

main().catch((err) => {
  log("ERROR", "main", "Falha fatal", { error: String(err?.message ?? err) });
  process.exit(1);
});
