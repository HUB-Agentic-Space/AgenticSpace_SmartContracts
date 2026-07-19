/**
 * Redistribuição de CAS — Melhoria de Distribuição
 * -----------------------------------------------
 * O CASSwap foi deployado diretamente (não como proxy UUPS),
 * então NÃO pode ser upgraded. A função withdrawCAS não existe on-chain.
 *
 * Solução: usar operação legítima de admin (RATIO_ADMIN_ROLE):
 *   1. Ajustar ratio temporariamente para 10M:1 (1 POL = 10M CAS)
 *   2. Comprar CAS do swap com POL mínimo
 *   3. Restaurar ratio original
 *
 * Etapas:
 *   0. Extrair 40% do saldo CAS do CASSwap via ratio trick
 *   1. Transferir 1.000 CAS para os 10 recebedores com menor saldo
 *   2. Transferir 20% (extraído) → Agentic Space Manager
 *   3. Transferir 20% (extraído) → Agentic Space Backend
 *
 * Uso: npm run distribute:cas:polygon
 */

import { ethers } from "hardhat";
import { Contract, formatUnits } from "ethers";
import * as dotenv from "dotenv";
import * as path from "path";
import {
  SEP, SUB, fmtPOL, getNetworkInfo, requireEnv,
  preFlightCheck, sendAndVerify, printSummary,
  type DeployStep,
} from "../utils/deploy_helpers";

const SC_ROOT = path.resolve(__dirname, "..", "..");
dotenv.config({ path: path.join(SC_ROOT, ".env") });

type LogLevel = "INFO" | "WARN" | "ERROR" | "OK" | "DEBUG";
function log(level: LogLevel, fn: string, msg: string, p?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const e = { INFO: "ℹ️", WARN: "⚠️", ERROR: "❌", OK: "✅", DEBUG: "🔍" }[level];
  console.log(`[${ts}] [06_redistribute_cas:${fn}] ${e} ${msg}${p ? ` - ${JSON.stringify(p)}` : ""}`);
}

const DECIMALS = 18;
const CHAIN_ID = 137;
const API_BASES = ["https://api.etherscan.io/v2/api", "https://api.polygonscan.com/api"];
const AGENTIC_SPACE_MANAGER = "0x1cdF56D75d5F3643BecB1Cb2F96cbEC26a43c73c";
const AGENTIC_SPACE_BACKEND = "0x8950dD90B86D72e3F03A6d47Fb25B92808d40c7a";

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
];
const CASSWAP_ABI = [
  "function getCASBalance() view returns (uint256)",
  "function getRatio() view returns (uint256,uint256)",
  "function setRatio(uint256,uint256)",
  "function buyCAS(uint256,uint256) payable returns (uint256)",
  "function isPaused() view returns (bool)",
  "function getSwapFee() view returns (uint256)",
];

interface TokenTransfer { hash: string; from: string; to: string; value: string; timeStamp: string; }

async function scanRequest(params: Record<string, string>): Promise<unknown> {
  const apiKey = process.env.POLYGONSCAN_API_KEY ?? "";
  let lastErr: Error | null = null;
  for (const base of API_BASES) {
    const url = new URL(base);
    if (base.includes("etherscan.io/v2")) url.searchParams.set("chainid", String(CHAIN_ID));
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("apikey", apiKey);
    try {
      const res = await fetch(url.toString());
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { status: string; message: string; result: unknown };
      if (body.status === "1" || (body.status === "0" && body.message === "No transactions found"))
        return body.result;
      throw new Error(`API status=${body.status} msg=${body.message}`);
    } catch (err) { lastErr = err as Error; }
  }
  throw lastErr ?? new Error("API falhou");
}

interface ReceiverInfo { address: string; balance: bigint; totalReceived: bigint; }

async function fetchAllReceivers(tokenAddress: string): Promise<Map<string, bigint>> {
  log("INFO", "fetchAllReceivers", "Buscando todas as transferências", { token: tokenAddress });
  const transfers: TokenTransfer[] = [];
  let page = 1;
  for (;;) {
    const result = (await scanRequest({
      module: "account", action: "tokentx", contractaddress: tokenAddress,
      page: String(page), offset: "1000", sort: "asc",
    })) as TokenTransfer[] | string;
    if (!Array.isArray(result) || result.length === 0) break;
    transfers.push(...result);
    if (result.length < 1000) break;
    page += 1;
    if (page > 10) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  log("DEBUG", "fetchAllReceivers", "Transferências coletadas", { total: transfers.length });

  const known = new Set<string>([
    tokenAddress.toLowerCase(),
    (process.env.CAS_SWAP_ADDRESS ?? "").toLowerCase(),
    (process.env.INFRASTRUCTURE_FUND_ADDRESS ?? "").toLowerCase(),
    (process.env.DIAMOND_ADDRESS ?? "").toLowerCase(),
  ]);

  // Calcular total recebido por endereço (excluir mints e contratos conhecidos)
  const receivedMap = new Map<string, bigint>();
  for (const t of transfers) {
    const to = t.to.toLowerCase();
    const from = t.from.toLowerCase();
    if (from === "0x0000000000000000000000000000000000000000") continue;
    if (known.has(to)) continue;
    const current = receivedMap.get(to) ?? 0n;
    receivedMap.set(to, current + BigInt(t.value));
  }
  log("OK", "fetchAllReceivers", "Recebedores mapeados", { count: receivedMap.size });
  return receivedMap;
}

async function fetchLowestBalanceReceivers(
  casToken: Contract,
  receivedMap: Map<string, bigint>,
  count: number,
): Promise<ReceiverInfo[]> {
  log("INFO", "fetchLowestBalanceReceivers", "Consultando saldos on-chain", { candidates: receivedMap.size, count });
  const candidates: ReceiverInfo[] = [];
  for (const [addrLower, totalReceived] of receivedMap) {
    const addr = ethers.getAddress(addrLower);
    const balance = await casToken.balanceOf(addr);
    candidates.push({ address: addr, balance, totalReceived });
  }
  // Ordenar por saldo on-chain crescente (menores primeiro)
  candidates.sort((a, b) => (a.balance < b.balance ? -1 : a.balance > b.balance ? 1 : 0));
  const result = candidates.slice(0, count);
  log("OK", "fetchLowestBalanceReceivers", "Menores saldos selecionados", {
    count: result.length,
    balances: result.map((r) => ({ addr: r.address.slice(0, 10) + "…", bal: Number(formatUnits(r.balance, DECIMALS)) })),
  });
  return result;
}

async function main(): Promise<void> {
  log("INFO", "main", "🚀 Iniciando redistribuição de CAS");
  const env = requireEnv(["CAS_TOKEN_ADDRESS", "CAS_SWAP_ADDRESS", "POLYGONSCAN_API_KEY"]);
  const [deployer] = await ethers.getSigners();
  const provider = deployer.provider!;
  const chainId = Number((await provider.getNetwork()).chainId);
  const netInfo = getNetworkInfo(chainId);

  console.log(`\n${SEP}\n  Redistribuição de CAS\n${SEP}`);
  console.log(`  Rede: ${netInfo.name} (${chainId})`);
  console.log(`  Deployer: ${deployer.address}`);

  const casToken = new Contract(env.CAS_TOKEN_ADDRESS, ERC20_ABI, deployer);
  const casswap = new Contract(env.CAS_SWAP_ADDRESS, CASSWAP_ABI, deployer);

  const totalSupply = await casToken.totalSupply();
  const deployerBal = await casToken.balanceOf(deployer.address);
  const casswapBal = await casswap.getCASBalance();
  const [origNum, origDen] = await casswap.getRatio();
  const isPaused = await casswap.isPaused();
  const swapFee = await casswap.getSwapFee();

  const tsNum = Number(formatUnits(totalSupply, DECIMALS));
  const depNum = Number(formatUnits(deployerBal, DECIMALS));
  const swapNum = Number(formatUnits(casswapBal, DECIMALS));

  console.log(`\n${SUB}\n  Saldos\n${SUB}`);
  console.log(`  Supply:    ${tsNum.toLocaleString("pt-BR")} CAS`);
  console.log(`  Deployer:  ${depNum.toLocaleString("pt-BR")} CAS`);
  console.log(`  CASSwap:   ${swapNum.toLocaleString("pt-BR")} CAS`);
  console.log(`  Ratio:     ${origNum}:${origDen} | Fee: ${swapFee} bps | Pausado: ${isPaused}`);

  // Cálculos
  // 1.000 CAS por recebedor (fixo, não percentual)
  const perReceiver = ethers.parseUnits("1000", DECIMALS);
  const redistributeAmt = perReceiver * 10n;
  const swap20pct = (casswapBal * 20n) / 100n;
  const swap40pct = swap20pct * 2n;

  const redNum = Number(formatUnits(redistributeAmt, DECIMALS));
  const perRecNum = Number(formatUnits(perReceiver, DECIMALS));
  const swap20Num = Number(formatUnits(swap20pct, DECIMALS));

  console.log(`\n${SUB}\n  Plano\n${SUB}`);
  console.log(`  10 recebedores × 1.000 CAS:  ${redNum.toLocaleString("pt-BR")} CAS (menores saldos)`);
  console.log(`  20% CASSwap → Manager:       ${swap20Num.toLocaleString("pt-BR")} CAS`);
  console.log(`  20% CASSwap → Backend:       ${swap20Num.toLocaleString("pt-BR")} CAS`);

  // Validações (apenas CASSwap e pause — deployer será validado após extração)
  if (casswapBal < swap40pct) {
    log("ERROR", "main", "Saldo CASSwap insuficiente", { need: swap20Num * 2, have: swapNum });
    process.exit(1);
  }
  if (isPaused) { log("ERROR", "main", "CASSwap pausado"); process.exit(1); }

  // Buscar recebedores com menor saldo
  const receivedMap = await fetchAllReceivers(env.CAS_TOKEN_ADDRESS);
  const receivers = await fetchLowestBalanceReceivers(casToken, receivedMap, 10);
  if (receivers.length < 10) log("WARN", "main", `Apenas ${receivers.length} recebedores`);
  console.log(`\n${SUB}\n  10 Recebedores com Menor Saldo\n${SUB}`);
  receivers.forEach((r, i) => {
    const balNum = Number(formatUnits(r.balance, DECIMALS));
    const recNum = Number(formatUnits(r.totalReceived, DECIMALS));
    console.log(`  ${String(i+1).padStart(2)}. ${r.address}  saldo: ${balNum.toLocaleString("pt-BR")} CAS  recebido: ${recNum.toLocaleString("pt-BR")} CAS  → +1.000 CAS`);
  });

  // Pré-flight
  const steps: DeployStep[] = [
    { label: "setRatio (temp)", gas: 80_000n },
    { label: "buyCAS (extrair 40%)", gas: 150_000n },
    { label: "setRatio (restaurar)", gas: 80_000n },
    { label: "10× transfer", gas: 10n * 65_000n },
    { label: "transfer → Manager", gas: 65_000n },
    { label: "transfer → Backend", gas: 65_000n },
  ];
  const { gasPrice } = await preFlightCheck("Redistribuição CAS", steps, {
    extraInfo: [
      { label: "Recebedores:", value: `${receivers.length} carteiras` },
      { label: "Manager:", value: AGENTIC_SPACE_MANAGER },
      { label: "Backend:", value: AGENTIC_SPACE_BACKEND },
    ],
  });

  // ══ Etapa 0: Extrair CAS do CASSwap via ratio trick ════════════════
  // Ratio: casReceived = (polAfterFee * numerator) / denominator
  // Para MAX CAS per POL: numerator grande, denominator = 1
  // Ex: setRatio(10M, 1) → 1 POL = 10M CAS
  console.log(`\n${SUB}\n  Etapa 0: Extrair 40% do CASSwap (ratio trick)\n${SUB}`);
  const EXTREME_NUM = 10_000_000n;
  const polNeeded = swap40pct / EXTREME_NUM;
  const polWithMargin = polNeeded + (polNeeded / 10n);
  console.log(`  Ratio temp: ${EXTREME_NUM}:1 (1 POL = 10M CAS) | POL: ${fmtPOL(polWithMargin)} | CAS alvo: ${swap20Num*2}`);

  const depPOL = await provider.getBalance(deployer.address);
  if (depPOL < polWithMargin + gasPrice * 500_000n) {
    log("ERROR", "main", "POL insuficiente", { have: fmtPOL(depPOL) });
    process.exit(1);
  }

  // 0a. Set ratio extremo (10M CAS : 1 POL)
  await sendAndVerify(`setRatio(${EXTREME_NUM}:1)`, casswap.setRatio(EXTREME_NUM, 1n, { gasPrice }) as Promise<any>, gasPrice);

  // 0b. Buy CAS — minCasOut = swap40pct (garante que recebe o esperado)
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  await sendAndVerify(
    `buyCAS(${fmtPOL(polWithMargin)} → ${swap20Num*2} CAS)`,
    casswap.buyCAS(swap40pct, deadline, { gasPrice, value: polWithMargin }) as Promise<any>,
    gasPrice,
  );
  const casExtracted = (await casToken.balanceOf(deployer.address)) - deployerBal;
  const casExtractedNum = Number(formatUnits(casExtracted, DECIMALS));
  log("OK", "main", "CAS extraído", { amount: casExtractedNum });

  if (casExtracted < swap40pct) {
    log("WARN", "main", "CAS extraído menor que esperado", { expected: swap20Num*2, got: casExtractedNum });
  }

  // 0c. Restaurar ratio (com retry para timeout)
  let ratioRestored = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await sendAndVerify(`setRatio(${origNum}:${origDen}) restaurar (tentativa ${attempt})`,
        casswap.setRatio(origNum, origDen, { gasPrice }) as Promise<any>, gasPrice);
      ratioRestored = true;
      break;
    } catch (err) {
      log("WARN", "main", `Tentativa ${attempt} falhou, verificando on-chain...`, { error: (err as Error).message });
      // Verificar se a TX foi minada mesmo com timeout
      const [checkN, checkD] = await casswap.getRatio();
      if (checkN === origNum && checkD === origDen) {
        log("OK", "main", "Ratio já restaurado on-chain (TX confirmada apesar do timeout)");
        ratioRestored = true;
        break;
      }
      if (attempt < 3) {
        log("INFO", "main", "Aguardando 5s antes de tentar novamente...");
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }
  if (!ratioRestored) {
    log("ERROR", "main", "Não foi possível restaurar o ratio! Rode manualmente: npm run restore:ratio:polygon");
    process.exit(1);
  }
  const [rN, rD] = await casswap.getRatio();
  if (rN !== origNum || rD !== origDen) { log("ERROR", "main", "Ratio não restaurado", { actual: `${rN}:${rD}`, expected: `${origNum}:${origDen}` }); process.exit(1); }
  log("OK", "main", "Ratio restaurado", { ratio: `${rN}:${rD}` });

  // ══ Etapa 1: Redistribuir 1.000 CAS para os 10 menores saldos ═════
  console.log(`\n${SUB}\n  Etapa 1: Transferir 1.000 CAS para os 10 menores saldos\n${SUB}`);
  // Validar saldo do deployer AGORA (após extração do ratio trick)
  const depBalAfterExtraction = await casToken.balanceOf(deployer.address);
  if (depBalAfterExtraction < redistributeAmt + swap40pct) {
    log("ERROR", "main", "Saldo deployer insuficiente após extração", {
      need: Number(formatUnits(redistributeAmt + swap40pct, DECIMALS)),
      have: Number(formatUnits(depBalAfterExtraction, DECIMALS)),
    });
    process.exit(1);
  }
  for (let i = 0; i < receivers.length; i++) {
    await sendAndVerify(`Transfer ${i+1}/${receivers.length}: ${receivers[i].address.slice(0,10)}…`,
      casToken.transfer(receivers[i].address, perReceiver) as Promise<any>, gasPrice);
    log("OK", "main", `Transfer ${i+1}`, { to: receivers[i].address, cas: perRecNum });
  }

  // ══ Etapa 2: Manager ══════════════════════════════════════════════
  console.log(`\n${SUB}\n  Etapa 2: → Manager\n${SUB}`);
  await sendAndVerify(`transfer → Manager (${swap20Num} CAS)`,
    casToken.transfer(AGENTIC_SPACE_MANAGER, swap20pct) as Promise<any>, gasPrice);
  log("OK", "main", "Manager OK", { to: AGENTIC_SPACE_MANAGER, cas: swap20Num });

  // ══ Etapa 3: Backend ══════════════════════════════════════════════
  console.log(`\n${SUB}\n  Etapa 3: → Backend\n${SUB}`);
  await sendAndVerify(`transfer → Backend (${swap20Num} CAS)`,
    casToken.transfer(AGENTIC_SPACE_BACKEND, swap20pct) as Promise<any>, gasPrice);
  log("OK", "main", "Backend OK", { to: AGENTIC_SPACE_BACKEND, cas: swap20Num });

  // ══ Resumo ════════════════════════════════════════════════════════
  const newDepBal = await casToken.balanceOf(deployer.address);
  const newSwapBal = await casswap.getCASBalance();
  const mgrBal = await casToken.balanceOf(AGENTIC_SPACE_MANAGER);
  const bakBal = await casToken.balanceOf(AGENTIC_SPACE_BACKEND);

  await printSummary("Redistribuição CAS Concluída", [
    { label: "Deployer (antes):", value: `${depNum.toLocaleString("pt-BR")} CAS` },
    { label: "Deployer (agora):", value: `${Number(formatUnits(newDepBal, DECIMALS)).toLocaleString("pt-BR")} CAS` },
    { label: "CASSwap (antes):", value: `${swapNum.toLocaleString("pt-BR")} CAS` },
    { label: "CASSwap (agora):", value: `${Number(formatUnits(newSwapBal, DECIMALS)).toLocaleString("pt-BR")} CAS` },
    { label: "Manager:", value: `${Number(formatUnits(mgrBal, DECIMALS)).toLocaleString("pt-BR")} CAS` },
    { label: "Backend:", value: `${Number(formatUnits(bakBal, DECIMALS)).toLocaleString("pt-BR")} CAS` },
    { label: "Recebedores:", value: `${receivers.length} × 1.000 CAS (menores saldos)` },
    { label: "Ratio:", value: `${rN}:${rD} (restaurado)` },
  ], 0n, [
    "Executar dashboard: npm run analysis:cas:distribution",
    "Verificar transações no Polygonscan",
    "Considerar deploy de novo CASSwap como proxy UUPS no futuro",
  ]);
  log("INFO", "main", "🏁 Redistribuição concluída");
}

main().then(() => process.exit(0)).catch((err) => {
  log("ERROR", "main", "Falha", { error: (err as Error).message });
  console.error(err);
  process.exit(1);
});
