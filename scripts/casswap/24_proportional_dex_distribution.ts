/**
 * Proportional DEX Distribution — distribuição de liquidez CAS/POL entre DEXs.
 *
 * Fluxo:
 *   1. Lê carteiras ativas do rapport_trader (SQLite criptografado).
 *   2. Consulta saldos CAS, POL e USDC de cada carteira.
 *   3. Retira proporcionalmente até 100K CAS (ou --amount) das carteiras-fonte.
 *   4. Consolida CAS + POL na carteira operadora (DEPLOYER/RELAYER).
 *   5. Distribui a liquidez proporcionalmente à reserva CAS de cada pool V2.
 *
 * Uso:
 *   npx tsx scripts/casswap/24_proportional_dex_distribution.ts --dry-run
 *   npx tsx scripts/casswap/24_proportional_dex_distribution.ts --execute --amount 100000
 *   npx tsx scripts/casswap/24_proportional_dex_distribution.ts --execute --dex quickswap --dex sushiswap
 *
 * Segurança:
 *   - Nunca loga chaves privadas ou WALLET_MASTER_KEY.
 *   - `--dry-run` é o padrão; `--execute` exige confirmação explícita.
 *   - Aborta se a rede não for Polygon PoS (chainId 137) ou se o DB estiver ausente.
 */

import "dotenv/config";
import { ethers } from "ethers";
import { SEP, SUB, fmtPOL, getNetworkInfo } from "../utils/deploy_helpers";
import {
  loadTraderWallets,
  getWalletBalances,
  type TraderWallet,
} from "../utils/trader_wallet_reader";
import {
  buildDexRegistry,
  getSupportedV2Dexes,
  getUnsupportedDexes,
  type DexLiquidityConfig,
} from "../utils/dex_liquidity_registry";

const CAS_DECIMALS = 18;
const POL_DECIMALS = 18;
const SLIPPAGE_BPS = 50n; // 0.5%
const DEADLINE_SECONDS = 20 * 60;
const DEFAULT_TARGET_CAS = 100_000;

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
];

const V2_ROUTER_ABI = [
  "function addLiquidityETH(address token, uint amountTokenDesired, uint amountTokenMin, uint amountETHMin, address to, uint deadline) external payable returns (uint amountToken, uint amountETH, uint liquidity)",
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[])",
];

const PAIR_ABI = [
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function totalSupply() view returns (uint256)",
];

type LogLevel = "INFO" | "WARN" | "ERROR" | "OK" | "DEBUG";
function log(level: LogLevel, fn: string, msg: string, p?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const e = { INFO: "ℹ️", WARN: "⚠️", ERROR: "❌", OK: "✅", DEBUG: "🔍" }[level];
  console.log(`[${ts}] [24_dex_distribution:${fn}] ${e} ${msg}${p ? ` - ${JSON.stringify(p)}` : ""}`);
}

interface WalletBalance {
  wallet: TraderWallet;
  cas: bigint;
  pol: bigint;
  usdc: bigint;
  casShare: bigint;
  polShare: bigint;
}

interface DexPoolInfo {
  dex: DexLiquidityConfig;
  casReserve: bigint;
  polReserve: bigint;
  hasLiquidity: boolean;
  weight: number;
  casAllocation: bigint;
  polNeeded: bigint;
}

interface CliArgs {
  dryRun: boolean;
  execute: boolean;
  force: boolean;
  amount: bigint;
  dexFilter: string[];
  confirm: string | null;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const result: CliArgs = {
    dryRun: true,
    execute: false,
    force: false,
    amount: ethers.parseUnits(String(DEFAULT_TARGET_CAS), CAS_DECIMALS),
    dexFilter: [],
    confirm: null,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--execute") {
      result.execute = true;
      result.dryRun = false;
    } else if (arg === "--dry-run") {
      result.dryRun = true;
      result.execute = false;
    } else if (arg === "--force") {
      result.force = true;
    } else if (arg === "--amount") {
      const val = args[++i];
      result.amount = ethers.parseUnits(val, CAS_DECIMALS);
    } else if (arg === "--dex") {
      const val = args[++i];
      result.dexFilter.push(val.toLowerCase());
    } else if (arg === "--confirm") {
      result.confirm = args[++i];
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
  }
  return result;
}

function printUsage(): void {
  console.log(`
Uso: npx tsx scripts/casswap/24_proportional_dex_distribution.ts [opções]

Opções:
  --dry-run          Apenas simula e imprime o plano (padrão)
  --execute          Executa as transações reais
  --force            Se o saldo total CAS for menor que o alvo, usa o disponível
  --amount <n>       Quantidade alvo de CAS (padrão: ${DEFAULT_TARGET_CAS})
  --dex <name>       Filtra DEXs por nome (pode ser repetido)
  --confirm <text>   Confirmação obrigatória para --execute (ex.: "yes")
  --help             Exibe esta ajuda
`);
}

function getProvider(): ethers.JsonRpcProvider {
  const rpc =
    process.env.POLYGON_RPC_URL ??
    (process.env.ANKR_API_KEY ? `https://rpc.ankr.com/polygon/${process.env.ANKR_API_KEY}` : "https://polygon.drpc.org");
  return new ethers.JsonRpcProvider(rpc);
}

function getOperatorSigner(provider: ethers.Provider): ethers.Wallet {
  const pk = process.env.POLYGON_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY ?? process.env.RELAYER_PRIVATE_KEY;
  if (!pk) {
    throw new Error("Configure POLYGON_PRIVATE_KEY, DEPLOYER_PRIVATE_KEY ou RELAYER_PRIVATE_KEY no .env");
  }
  const normalized = pk.startsWith("0x") ? pk : `0x${pk}`;
  return new ethers.Wallet(normalized, provider);
}

async function getPoolReserves(
  provider: ethers.Provider,
  dex: DexLiquidityConfig,
  casTokenAddress: string
): Promise<{ casReserve: bigint; polReserve: bigint; hasLiquidity: boolean }> {
  if (!dex.lpTokenAddress) {
    return { casReserve: 0n, polReserve: 0n, hasLiquidity: false };
  }
  try {
    const pair = new ethers.Contract(dex.lpTokenAddress, PAIR_ABI, provider);
    const [[res0, res1], token0] = await Promise.all([pair.getReserves(), pair.token0()]);
    const isCasToken0 = token0.toLowerCase() === casTokenAddress.toLowerCase();
    const casReserve = isCasToken0 ? res0 : res1;
    const polReserve = isCasToken0 ? res1 : res0;
    return { casReserve, polReserve, hasLiquidity: casReserve > 0n && polReserve > 0n };
  } catch (err) {
    log("WARN", "getPoolReserves", `Falha ao ler pool ${dex.name}`, { error: (err as Error).message });
    return { casReserve: 0n, polReserve: 0n, hasLiquidity: false };
  }
}

async function calculateProportions(
  wallets: TraderWallet[],
  balances: Map<string, { cas: bigint; pol: bigint; usdc: bigint }>,
  targetCas: bigint,
  force: boolean
): Promise<{ targetCas: bigint; walletPlans: WalletBalance[] }> {
  const totalCas = wallets.reduce((acc, w) => acc + (balances.get(w.address.toLowerCase())?.cas ?? 0n), 0n);
  const totalPol = wallets.reduce((acc, w) => acc + (balances.get(w.address.toLowerCase())?.pol ?? 0n), 0n);

  let effectiveTarget = targetCas;
  if (totalCas < targetCas) {
    if (!force) {
      throw new Error(
        `Saldo total CAS insuficiente: ${ethers.formatUnits(totalCas, CAS_DECIMALS)} < ${ethers.formatUnits(targetCas, CAS_DECIMALS)}. Use --force para ajustar ao máximo disponível.`
      );
    }
    effectiveTarget = totalCas;
    log("WARN", "calculateProportions", "Saldo insuficiente; usando máximo disponível", {
      requested: ethers.formatUnits(targetCas, CAS_DECIMALS),
      effective: ethers.formatUnits(effectiveTarget, CAS_DECIMALS),
    });
  }

  if (effectiveTarget === 0n) {
    throw new Error("Nenhum CAS disponível para distribuição.");
  }

  const walletPlans: WalletBalance[] = wallets.map((wallet) => {
    const bal = balances.get(wallet.address.toLowerCase()) ?? { cas: 0n, pol: 0n, usdc: 0n };
    const casShare = (effectiveTarget * bal.cas) / totalCas;
    return { wallet, ...bal, casShare, polShare: 0n };
  });

  return { targetCas: effectiveTarget, walletPlans };
}

async function calculateDexDistribution(
  provider: ethers.Provider,
  dexes: DexLiquidityConfig[],
  targetCas: bigint,
  casTokenAddress: string
): Promise<DexPoolInfo[]> {
  const infos: DexPoolInfo[] = [];
  for (const dex of dexes) {
    const reserves = await getPoolReserves(provider, dex, casTokenAddress);
    infos.push({
      dex,
      ...reserves,
      weight: 0,
      casAllocation: 0n,
      polNeeded: 0n,
    });
  }

  const totalCasReserve = infos.reduce((acc, i) => acc + i.casReserve, 0n);
  if (totalCasReserve === 0n) {
    log("WARN", "calculateDexDistribution", "Nenhuma pool CAS/POL encontrada nos DEXs suportados");
    return infos;
  }

  for (const info of infos) {
    if (!info.hasLiquidity) continue;
    info.weight = Number(info.casReserve) / Number(totalCasReserve);
    info.casAllocation = (targetCas * BigInt(Math.floor(info.weight * 1e9))) / 1_000_000_000n;
    info.polNeeded = (info.casAllocation * info.polReserve) / info.casReserve;
  }

  return infos;
}

function calculatePolShares(walletPlans: WalletBalance[], totalPolNeeded: bigint): void {
  const totalPol = walletPlans.reduce((acc, w) => acc + w.pol, 0n);
  if (totalPol === 0n) {
    for (const w of walletPlans) w.polShare = 0n;
    return;
  }
  for (const w of walletPlans) {
    w.polShare = (totalPolNeeded * w.pol) / totalPol;
  }
}

async function printReport(
  walletPlans: WalletBalance[],
  dexInfos: DexPoolInfo[],
  targetCas: bigint,
  provider: ethers.Provider,
  operator: ethers.Wallet
): Promise<void> {
  console.log(`\n${SEP}\n  Relatório de Distribuição Proporcional\n${SEP}`);

  const net = await provider.getNetwork();
  const netInfo = getNetworkInfo(Number(net.chainId));
  console.log(`  Rede: ${netInfo.name} (${net.chainId})`);
  console.log(`  Operador: ${operator.address}`);
  console.log(`  Alvo CAS: ${ethers.formatUnits(targetCas, CAS_DECIMALS)} CAS`);

  console.log(`\n${SUB}\n  Carteiras Fonte\n${SUB}`);
  console.log(`  ${"Endereço".padEnd(44)} ${"CAS".padStart(18)} ${"POL".padStart(18)} ${"USDC".padStart(12)} ${"CAS→".padStart(18)} ${"POL→".padStart(18)}`);
  for (const w of walletPlans) {
    const cas = ethers.formatUnits(w.cas, CAS_DECIMALS);
    const pol = ethers.formatUnits(w.pol, POL_DECIMALS);
    const usdc = ethers.formatUnits(w.usdc, 6);
    const casShare = ethers.formatUnits(w.casShare, CAS_DECIMALS);
    const polShare = ethers.formatUnits(w.polShare, POL_DECIMALS);
    console.log(
      `  ${w.wallet.address.padEnd(44)} ${cas.padStart(18)} ${pol.padStart(18)} ${usdc.padStart(12)} ${casShare.padStart(18)} ${polShare.padStart(18)}`
    );
  }
  const totalCas = walletPlans.reduce((a, w) => a + w.cas, 0n);
  const totalPol = walletPlans.reduce((a, w) => a + w.pol, 0n);
  const totalCasShare = walletPlans.reduce((a, w) => a + w.casShare, 0n);
  const totalPolShare = walletPlans.reduce((a, w) => a + w.polShare, 0n);
  console.log(`  ${"─".repeat(112)}`);
  console.log(
    `  ${"TOTAL".padEnd(44)} ${ethers.formatUnits(totalCas, CAS_DECIMALS).padStart(18)} ${ethers.formatUnits(totalPol, POL_DECIMALS).padStart(18)} ${"".padStart(12)} ${ethers.formatUnits(totalCasShare, CAS_DECIMALS).padStart(18)} ${ethers.formatUnits(totalPolShare, POL_DECIMALS).padStart(18)}`
  );

  console.log(`\n${SUB}\n  Distribuição por DEX\n${SUB}`);
  console.log(`  ${"DEX".padEnd(18)} ${"Tipo".padStart(8)} ${"CAS".padStart(18)} ${"POL".padStart(18)} ${"Peso".padStart(8)} ${"Status".padStart(12)}`);
  for (const d of dexInfos) {
    const status = d.hasLiquidity && d.dex.supportsAddLiquidity ? "OK" : "skipped";
    const casAlloc = ethers.formatUnits(d.casAllocation, CAS_DECIMALS);
    const polNeed = ethers.formatUnits(d.polNeeded, POL_DECIMALS);
    const weight = (d.weight * 100).toFixed(2) + "%";
    console.log(
      `  ${d.dex.name.padEnd(18)} ${d.dex.type.padStart(8)} ${casAlloc.padStart(18)} ${polNeed.padStart(18)} ${weight.padStart(8)} ${status.padStart(12)}`
    );
    if (d.dex.notes) {
      console.log(`      ${d.dex.notes}`);
    }
  }

  const totalPolNeeded = dexInfos.reduce((a, d) => a + d.polNeeded, 0n);
  console.log(`\n  Total POL necessário: ${ethers.formatUnits(totalPolNeeded, POL_DECIMALS)} POL`);
  console.log(`  Total POL disponível: ${ethers.formatUnits(totalPol, POL_DECIMALS)} POL`);
  if (totalPolNeeded > totalPol) {
    console.log(`  ⚠️  POL insuficiente. Diferença: ${ethers.formatUnits(totalPolNeeded - totalPol, POL_DECIMALS)} POL`);
  }
}

async function ensureAllowance(
  token: ethers.Contract,
  owner: ethers.Wallet,
  spender: string,
  amount: bigint
): Promise<string | null> {
  const current = await token.allowance(owner.address, spender);
  if (current >= amount) return null;
  const tx = await token.approve(spender, ethers.MaxUint256);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error(`Falha ao aprovar ${spender}`);
  return receipt.hash;
}

async function executeConsolidation(
  walletPlans: WalletBalance[],
  operatorAddress: string,
  casTokenAddress: string
): Promise<{ casTxs: string[]; polTxs: string[] }> {
  const casTxs: string[] = [];
  const polTxs: string[] = [];

  for (const plan of walletPlans) {
    if (plan.casShare === 0n && plan.polShare === 0n) continue;
    const signer = plan.wallet.signer;
    const casToken = new ethers.Contract(casTokenAddress, ERC20_ABI, signer);

    if (plan.casShare > 0n) {
      try {
        const tx = await casToken.transfer(operatorAddress, plan.casShare);
        const receipt = await tx.wait();
        if (!receipt || receipt.status !== 1) throw new Error("transfer CAS falhou");
        casTxs.push(receipt.hash);
        log("OK", "executeConsolidation", "CAS transferido", {
          from: plan.wallet.address,
          amount: ethers.formatUnits(plan.casShare, CAS_DECIMALS),
          tx: receipt.hash,
        });
      } catch (err) {
        log("ERROR", "executeConsolidation", "Falha ao transferir CAS", {
          from: plan.wallet.address,
          error: (err as Error).message,
        });
      }
    }

    if (plan.polShare > 0n) {
      try {
        const tx = await signer.sendTransaction({ to: operatorAddress, value: plan.polShare });
        const receipt = await tx.wait();
        if (!receipt || receipt.status !== 1) throw new Error("transfer POL falhou");
        polTxs.push(receipt.hash);
        log("OK", "executeConsolidation", "POL transferido", {
          from: plan.wallet.address,
          amount: ethers.formatUnits(plan.polShare, POL_DECIMALS),
          tx: receipt.hash,
        });
      } catch (err) {
        log("ERROR", "executeConsolidation", "Falha ao transferir POL", {
          from: plan.wallet.address,
          error: (err as Error).message,
        });
      }
    }
  }

  return { casTxs, polTxs };
}

async function executeLiquidity(
  operator: ethers.Wallet,
  dexInfos: DexPoolInfo[],
  casTokenAddress: string
): Promise<{ addTxs: string[]; approveTxs: string[] }> {
  const addTxs: string[] = [];
  const approveTxs: string[] = [];
  const casToken = new ethers.Contract(casTokenAddress, ERC20_ABI, operator);
  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;

  for (const info of dexInfos) {
    if (!info.hasLiquidity || !info.dex.supportsAddLiquidity || info.casAllocation === 0n) {
      continue;
    }
    const router = new ethers.Contract(info.dex.routerAddress!, V2_ROUTER_ABI, operator);
    const casMin = (info.casAllocation * (10000n - SLIPPAGE_BPS)) / 10000n;
    const polMin = (info.polNeeded * (10000n - SLIPPAGE_BPS)) / 10000n;

    try {
      const approveTx = await ensureAllowance(casToken, operator, info.dex.routerAddress!, info.casAllocation);
      if (approveTx) approveTxs.push(approveTx);

      const tx = await router.addLiquidityETH(
        casTokenAddress,
        info.casAllocation,
        casMin,
        polMin,
        operator.address,
        deadline,
        { value: info.polNeeded }
      );
      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) throw new Error("addLiquidityETH falhou");
      addTxs.push(receipt.hash);
      log("OK", "executeLiquidity", "Liquidez adicionada", {
        dex: info.dex.name,
        cas: ethers.formatUnits(info.casAllocation, CAS_DECIMALS),
        pol: ethers.formatUnits(info.polNeeded, POL_DECIMALS),
        tx: receipt.hash,
      });
    } catch (err) {
      log("ERROR", "executeLiquidity", `Falha ao adicionar liquidez em ${info.dex.name}`, {
        error: (err as Error).message,
      });
    }
  }

  return { addTxs, approveTxs };
}

async function main(): Promise<void> {
  const args = parseArgs();
  log("INFO", "main", "🚀 Iniciando distribuição proporcional de CAS", {
    mode: args.execute ? "EXECUTE" : "DRY-RUN",
    amount: ethers.formatUnits(args.amount, CAS_DECIMALS),
    force: args.force,
  });

  const provider = getProvider();
  const chainId = Number((await provider.getNetwork()).chainId);
  if (chainId !== 137) {
    throw new Error(`Rede incorreta: esperado Polygon PoS (137), encontrado ${chainId}`);
  }

  const casTokenAddress = process.env.CAS_TOKEN_ADDRESS;
  if (!casTokenAddress) throw new Error("CAS_TOKEN_ADDRESS não configurado");
  const usdcTokenAddress = process.env.USDC_ADDRESS;

  const operator = getOperatorSigner(provider);
  log("INFO", "main", "Operador de liquidez", { address: operator.address });

  // 1. Carregar carteiras do rapport_trader
  const wallets = loadTraderWallets(provider);
  if (wallets.length === 0) {
    throw new Error("Nenhuma carteira ativa encontrada no rapport_trader");
  }

  // 2. Consultar saldos
  const addresses = wallets.map((w) => w.address);
  const balances = await getWalletBalances(provider, addresses, casTokenAddress, usdcTokenAddress);

  // 3. Calcular proporções
  const { targetCas, walletPlans } = await calculateProportions(
    wallets,
    balances,
    args.amount,
    args.force
  );

  // 4. Filtrar e carregar DEXs
  const allDexes = buildDexRegistry();
  let selectedDexes = allDexes;
  if (args.dexFilter.length > 0) {
    selectedDexes = allDexes.filter((d) =>
      args.dexFilter.some((f) => d.name.toLowerCase().includes(f))
    );
  }
  const supportedDexes = getSupportedV2Dexes(selectedDexes);
  const unsupportedDexes = getUnsupportedDexes(selectedDexes);

  log("INFO", "main", "DEXs configurados", {
    total: selectedDexes.length,
    supported: supportedDexes.length,
    unsupported: unsupportedDexes.map((d) => d.name),
  });

  // 5. Calcular distribuição entre DEXs
  const dexInfos = await calculateDexDistribution(provider, supportedDexes, targetCas, casTokenAddress);
  const totalPolNeeded = dexInfos.reduce((a, d) => a + d.polNeeded, 0n);

  // 6. Calcular POL por carteira
  calculatePolShares(walletPlans, totalPolNeeded);

  // 7. Relatório
  await printReport(walletPlans, dexInfos, targetCas, provider, operator);

  if (args.dryRun) {
    log("INFO", "main", "🏁 Dry-run concluído. Use --execute para executar.");
    return;
  }

  // 8. Confirmação para execução real
  if (args.execute) {
    if (args.confirm !== "yes") {
      throw new Error("Execução real requer --confirm yes");
    }

    const totalPol = walletPlans.reduce((a, w) => a + w.pol, 0n);
    if (totalPolNeeded > totalPol && !args.force) {
      throw new Error(
        `POL insuficiente: necessário ${ethers.formatUnits(totalPolNeeded, POL_DECIMALS)}, disponível ${ethers.formatUnits(totalPol, POL_DECIMALS)}. Use --force para ajustar CAS.`
      );
    }

    // Ajustar CAS se POL insuficiente e --force
    if (totalPolNeeded > totalPol && args.force) {
      const weightedAvgRatio = Number(totalPolNeeded) / Number(targetCas);
      const adjustedCas = BigInt(Math.floor(Number(totalPol) / weightedAvgRatio));
      log("WARN", "main", "POL insuficiente; ajustando CAS proporcionalmente", {
        original: ethers.formatUnits(targetCas, CAS_DECIMALS),
        adjusted: ethers.formatUnits(adjustedCas, CAS_DECIMALS),
      });
      // Recalcular com CAS ajustado
      const { targetCas: newTarget, walletPlans: newPlans } = await calculateProportions(
        wallets,
        balances,
        adjustedCas,
        true
      );
      const newDexInfos = await calculateDexDistribution(provider, supportedDexes, newTarget, casTokenAddress);
      const newPolNeeded = newDexInfos.reduce((a, d) => a + d.polNeeded, 0n);
      calculatePolShares(newPlans, newPolNeeded);
      await printReport(newPlans, newDexInfos, newTarget, provider, operator);

      // Consolidar
      log("INFO", "main", "Consolidando CAS e POL para operador");
      const consolidation = await executeConsolidation(newPlans, operator.address, casTokenAddress);
      log("OK", "main", "Consolidação concluída", {
        casTxs: consolidation.casTxs.length,
        polTxs: consolidation.polTxs.length,
      });

      // Distribuir liquidez
      log("INFO", "main", "Distribuindo liquidez nos DEXs");
      const liquidity = await executeLiquidity(operator, newDexInfos, casTokenAddress);
      log("OK", "main", "Distribuição concluída", {
        addTxs: liquidity.addTxs.length,
        approveTxs: liquidity.approveTxs.length,
      });
    } else {
      // Consolidar
      log("INFO", "main", "Consolidando CAS e POL para operador");
      const consolidation = await executeConsolidation(walletPlans, operator.address, casTokenAddress);
      log("OK", "main", "Consolidação concluída", {
        casTxs: consolidation.casTxs.length,
        polTxs: consolidation.polTxs.length,
      });

      // Distribuir liquidez
      log("INFO", "main", "Distribuindo liquidez nos DEXs");
      const liquidity = await executeLiquidity(operator, dexInfos, casTokenAddress);
      log("OK", "main", "Distribuição concluída", {
        addTxs: liquidity.addTxs.length,
        approveTxs: liquidity.approveTxs.length,
      });
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    log("ERROR", "main", "Falha na execução", { error: (err as Error).message });
    console.error(err);
    process.exit(1);
  });
