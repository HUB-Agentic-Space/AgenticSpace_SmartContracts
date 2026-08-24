/**
 * Balance DEX Prices — analisa preços do CAS em todas as DEXs,
 * identifica a mais barata e a mais cara, e executa arbitragem
 * para equilibrar a distribuição de preços.
 *
 * Lê reservas diretamente dos LP pairs (V2) e usa quoter para V3/Algebra,
 * cobrindo: QuickSwap V2, SushiSwap, ApeSwap, Dfyn, Uniswap V3, QuickSwap V3.
 *
 * Comandos:
 *   --scan                 Apenas analisa preços (default)
 *   --execute              Executa a operação de equilíbrio com --amount
 *   --amount <POL>         Quantidade de POL para a operação (default: 0.5)
 *   --min-spread <bps>     Spread mínimo para considerar desbalanceado (default: 100)
 *   --allbuy <dex>         Compra TODO o estoque de CAS da DEX especificada
 *   --allsell <dex>        Vende TODO o saldo de CAS na DEX especificada
 *   --allbuy <dex> --allsell <dex>  Vende na mais cara e usa o POL para comprar na mais barata
 *   --route <name>         Executa rota nomeada via MultiRouteSwapFacet (diamondCut)
 *   --list-routes          Lista rotas disponíveis no MultiRouteSwapFacet
 *   --address <addr>       Usa o endereço especificado como signer (busca chave no DB ou prompt)
 *   --analysis             Analisa rota entre duas DEXs (requer --buy e --sell)
 *   --buy <dex>            DEX de compra para análise (com --analysis)
 *   --sell <dex>           DEX de venda para análise (com --analysis)
 *
 * Uso:
 *   npx tsx scripts/casswap/21_balance_dex_prices.ts --scan
 *   npx tsx scripts/casswap/21_balance_dex_prices.ts --execute --amount 0.5
 *   npx tsx scripts/casswap/21_balance_dex_prices.ts --allbuy apeswap
 *   npx tsx scripts/casswap/21_balance_dex_prices.ts --allsell dfyn
 *   npx tsx scripts/casswap/21_balance_dex_prices.ts --allbuy apeswap --allsell dfyn
 *   npx tsx scripts/casswap/21_balance_dex_prices.ts --route dfyn_to_apeswap
 *   npx tsx scripts/casswap/21_balance_dex_prices.ts --list-routes
 *   npx tsx scripts/casswap/21_balance_dex_prices.ts --allbuy sushiswap --address 0x8950dD90B86D72e3F03A6d47Fb25B92808d40c7a
 *   npx tsx scripts/casswap/21_balance_dex_prices.ts --analysis --buy sushiswap --sell dfyn --amount 1.0
 */

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import * as readline from "node:readline/promises";
import fetch from "node-fetch";
import { ethers } from "agentic_space_commons";
import { requireEnv } from "../utils/deploy_helpers";
import { getAddress, closeDB, getDB } from "../utils/cas_database";

const WPOL_ADDRESS = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";
const WETH_ADDRESS = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619";

const PAIR_ABI = [
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
];

const V2_ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[])",
  "function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[])",
  "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[])",
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[])",
];

const MULTI_ROUTE_FACET_ABI = [
  "function executeHops((address router, address[] path, bool useNativeIn, bool useNativeOut, uint256 amountIn)[] hops, uint256 minAmountOut) payable returns (uint256)",
  "function executeRoute(string routeName, uint256 minAmountOut) payable returns (uint256)",
  "function addRoute(string name, (address router, address[] path, bool useNativeIn, bool useNativeOut, uint256 amountIn)[] hops) external",
  "function listRoutes() view returns (string[])",
  "function getRoute(string name) view returns ((address router, address[] path, bool useNativeIn, bool useNativeOut, uint256 amountIn)[] hops, string name, bool active)",
  "function initMultiRouteSwap(address casToken) external",
];

const V3_QUOTER_ABI = [
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) view returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
];

const ALGEBRA_QUOTER_ABI = [
  "function quoteExactInputSingle(address tokenIn, address tokenOut, uint256 amountIn) view returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

const V3_FEE_TIERS = [100, 500, 3000, 10000];

type DexType = "v2" | "v3" | "algebra";

interface DexConfig {
  name: string;
  type: DexType;
  routerAddress: string;
  lpTokenAddress?: string;
  quoterAddress?: string;
  middleToken?: string;
}

interface DexQuote {
  name: string;
  type: DexType;
  routerAddress: string;
  lpTokenAddress?: string;
  casReserve: bigint;
  pairedReserve: bigint;
  pairedToken: string;
  isWPOL: boolean;
  pricePerCas: number;
  hasLiquidity: boolean;
}

interface ExecutionResult {
  success: boolean;
  buyDex: string;
  sellDex: string;
  buyTxHash: string | null;
  sellTxHash: string | null;
  approveTxHash: string | null;
  casBought: string;
  casSold: string;
  polIn: string;
  polOut: string;
  netResult: string;
  error: string | null;
}

interface OperationLog {
  step: string;
  dex: string;
  action: string;
  txHash: string | null;
  amount: string;
  detail: string;
  timestamp: string;
}

interface WalletBalance {
  label: string;
  address: string;
  polBalance: string;
  casBalance: string;
  isSigner: boolean;
}

interface FundingInfo {
  signerAddress: string;
  polBalance: string;
  casBalance: string;
  polNeededForTrade: string;
  gasCostPol: string;
  totalPolNeeded: string;
  polShortfall: string;
  needsDeposit: boolean;
  polAvailableForBuy: string;
  mode: string;
  wallets: WalletBalance[];
}

function log(level: string, message: string, params?: unknown): void {
  const ts = new Date().toISOString().replace("T", " ").split(".")[0];
  const extra = params ? ` - ${JSON.stringify(params)}` : "";
  console.log(`[${ts}] [21_balance_dex_prices] ${level} ${message}${extra}`);
}

function getProvider(): ethers.JsonRpcProvider {
  const rpc =
    process.env.POLYGON_RPC_URL ??
    (process.env.ANKR_API_KEY ? `https://rpc.ankr.com/polygon/${process.env.ANKR_API_KEY}` : "https://polygon.drpc.org");
  return new ethers.JsonRpcProvider(rpc);
}

function getSigner(): ethers.Wallet {
  const pk = process.env.POLYGON_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY ?? "";
  if (!pk) throw new Error("POLYGON_PRIVATE_KEY or DEPLOYER_PRIVATE_KEY not set in .env");
  const normalized = pk.startsWith("0x") ? pk : `0x${pk}`;
  return new ethers.Wallet(normalized, getProvider());
}

async function getSignerForAddress(address?: string): Promise<{ wallet: ethers.Wallet; address: string }> {
  // If no --address, use default env key
  if (!address) {
    const wallet = getSigner();
    return { wallet, address: wallet.address };
  }

  const targetAddr = ethers.getAddress(address);

  // 1. Check if any env var matches this address
  const envKeys = ["POLYGON_PRIVATE_KEY", "DEPLOYER_PRIVATE_KEY", "RELAYER_PRIVATE_KEY"];
  for (const key of envKeys) {
    const pk = process.env[key];
    if (pk) {
      const normalized = pk.startsWith("0x") ? pk : `0x${pk}`;
      const computed = ethers.computeAddress(normalized);
      if (computed.toLowerCase() === targetAddr.toLowerCase()) {
        return { wallet: new ethers.Wallet(normalized, getProvider()), address: computed };
      }
    }
  }

  // 2. Check DB private_keys table
  try {
    const db = getDB();
    const row = db.prepare("SELECT private_key FROM private_keys WHERE address = ?").get(targetAddr.toLowerCase()) as { private_key: string } | undefined;
    if (row && row.private_key) {
      const normalized = row.private_key.startsWith("0x") ? row.private_key : `0x${row.private_key}`;
      const wallet = new ethers.Wallet(normalized, getProvider());
      if (wallet.address.toLowerCase() === targetAddr.toLowerCase()) {
        log("INFO", "Found private key in DB for address", { address: targetAddr });
        return { wallet, address: wallet.address };
      }
    }
  } catch (err) {
    log("WARN", "Could not query DB for private key", { error: (err as Error).message });
  }

  // 3. Prompt user on stdin
  console.log(`\n🔐 Chave privada não encontrada para ${targetAddr}`);
  console.log(`   Digite a chave privada (não será exibida):`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  const input = await rl.question("");
  rl.close();

  const pkInput = input.trim();
  if (!pkInput) {
    throw new Error(`Nenhuma chave privada fornecida para ${targetAddr}`);
  }

  const normalized = pkInput.startsWith("0x") ? pkInput : `0x${pkInput}`;
  let wallet: ethers.Wallet;
  try {
    wallet = new ethers.Wallet(normalized, getProvider());
  } catch {
    throw new Error(`Chave privada inválida fornecida para ${targetAddr}`);
  }

  if (wallet.address.toLowerCase() !== targetAddr.toLowerCase()) {
    throw new Error(`Chave privada não corresponde ao endereço ${targetAddr}. Endereço derivado: ${wallet.address}`);
  }

  // 4. Save to DB for future use
  try {
    const db = getDB();
    db.prepare(`
      INSERT INTO private_keys (address, name, env_key, private_key, updated_at)
      VALUES (?, ?, '', ?, datetime('now'))
      ON CONFLICT(address) DO UPDATE SET private_key = excluded.private_key, updated_at = datetime('now')
    `).run(targetAddr.toLowerCase(), `signer_${targetAddr.slice(2, 8)}`, normalized);
    log("INFO", "Private key saved to DB for future use", { address: targetAddr });
  } catch (err) {
    log("WARN", "Could not save private key to DB", { error: (err as Error).message });
  }

  return { wallet, address: wallet.address };
}

const MAX_TX_WAIT_RETRIES = 5;
const TX_WAIT_RETRY_DELAY_MS = 3_000;
const DEFAULT_SWAP_GAS_LIMIT = 300_000n;
const GAS_ESTIMATE_BUFFER_PERCENT = 20n;

async function waitForTxWithRetry(
  tx: ethers.TransactionResponse,
  label: string,
): Promise<ethers.TransactionReceipt> {
  for (let attempt = 1; attempt <= MAX_TX_WAIT_RETRIES; attempt++) {
    try {
      const receipt = await tx.wait();
      if (!receipt) throw new Error("Transaction receipt is null");
      return receipt;
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      const isRpcError = /Unknown block|could not coalesce|SERVER_ERROR|TIMEOUT|quorum/i.test(msg);
      if (!isRpcError || attempt === MAX_TX_WAIT_RETRIES) throw err;
      log("WARN", "TX wait retry", { label, attempt, txHash: tx.hash, error: msg });
      await new Promise((r) => setTimeout(r, TX_WAIT_RETRY_DELAY_MS * attempt));
    }
  }
  throw new Error("unreachable");
}

function parseArgs(): {
  scan: boolean;
  execute: boolean;
  amount: string;
  minSpread: number;
  allBuy: string | null;
  allSell: string | null;
  route: string | null;
  listRoutes: boolean;
  address: string | null;
  analysis: boolean;
  buy: string | null;
  sell: string | null;
} {
  const args = process.argv.slice(2);
  const amountIdx = args.indexOf("--amount");
  const spreadIdx = args.indexOf("--min-spread");
  const allBuyIdx = args.indexOf("--allbuy");
  const allSellIdx = args.indexOf("--allsell");
  const routeIdx = args.indexOf("--route");
  const addressIdx = args.indexOf("--address");
  const buyIdx = args.indexOf("--buy");
  const sellIdx = args.indexOf("--sell");
  const hasAllBuy = allBuyIdx >= 0 && args[allBuyIdx + 1];
  const hasAllSell = allSellIdx >= 0 && args[allSellIdx + 1];
  const hasRoute = routeIdx >= 0 && args[routeIdx + 1];
  const hasAddress = addressIdx >= 0 && args[addressIdx + 1];
  const hasBuy = buyIdx >= 0 && args[buyIdx + 1];
  const hasSell = sellIdx >= 0 && args[sellIdx + 1];
  const hasAnalysis = args.includes("--analysis");
  const hasListRoutes = args.includes("--list-routes");
  const hasAll = hasAllBuy || hasAllSell || hasRoute || hasListRoutes || hasAnalysis;
  return {
    scan: !hasAll && (args.includes("--scan") || !args.includes("--execute")),
    execute: !hasAll && args.includes("--execute"),
    amount: amountIdx >= 0 && args[amountIdx + 1] ? args[amountIdx + 1] : "0.5",
    minSpread: spreadIdx >= 0 && args[spreadIdx + 1] ? Number(args[spreadIdx + 1]) : 100,
    allBuy: hasAllBuy ? args[allBuyIdx + 1].toLowerCase() : null,
    allSell: hasAllSell ? args[allSellIdx + 1].toLowerCase() : null,
    route: hasRoute ? args[routeIdx + 1] : null,
    listRoutes: hasListRoutes,
    address: hasAddress ? args[addressIdx + 1] : null,
    analysis: hasAnalysis,
    buy: hasBuy ? args[buyIdx + 1].toLowerCase() : null,
    sell: hasSell ? args[sellIdx + 1].toLowerCase() : null,
  };
}

function checksum(addr: string | undefined): string | undefined {
  if (!addr) return undefined;
  return ethers.getAddress(addr);
}

function buildDexList(): DexConfig[] {
  const list: DexConfig[] = [
    {
      name: "QuickSwap V2",
      type: "v2",
      routerAddress: checksum(process.env.QUICKSWAP_ROUTER_ADDRESS) || "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
      lpTokenAddress: checksum(process.env.QUICKSWAP_LP_TOKEN_ADDRESS),
      middleToken: WPOL_ADDRESS,
    },
    {
      name: "SushiSwap",
      type: "v2",
      routerAddress: checksum(process.env.SUSHISWAP_ROUTER_ADDRESS) || "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506",
      lpTokenAddress: checksum(process.env.SUSHISWAP_LP_TOKEN_ADDRESS),
      middleToken: WPOL_ADDRESS,
    },
    {
      name: "ApeSwap",
      type: "v2",
      routerAddress: checksum(process.env.APESWAP_ROUTER_ADDRESS) || "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
      lpTokenAddress: checksum(process.env.APESWAP_LP_TOKEN_ADDRESS),
      middleToken: WPOL_ADDRESS,
    },
    {
      name: "Dfyn",
      type: "v2",
      routerAddress: checksum(process.env.DFYN_ROUTER_ADDRESS) || "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429",
      lpTokenAddress: checksum(process.env.DFYN_LP_TOKEN_ADDRESS),
      middleToken: WETH_ADDRESS,
    },
  ];

  if (process.env.UNISWAP_V3_FACTORY) {
    list.push({
      name: "Uniswap V3",
      type: "v3",
      routerAddress: checksum(process.env.UNISWAP_V3_ROUTER) || "0xE592427A0AEce92De3Edee1F18E0157C05861564",
      quoterAddress: checksum(process.env.UNISWAP_V3_QUOTER) || "0xb27308f9F90D607463bb33eA1BeBb41C2765c608",
    });
  }

  if (process.env.QUICKSWAP_V3_ROUTER) {
    list.push({
      name: "QuickSwap V3",
      type: "algebra",
      routerAddress: checksum(process.env.QUICKSWAP_V3_ROUTER)!,
      quoterAddress: checksum(process.env.QUICKSWAP_V3_QUOTER),
    });
  }

  return list.filter((d) => d.routerAddress);
}

async function scanV2Dex(
  provider: ethers.JsonRpcProvider,
  dex: DexConfig,
  casToken: string,
): Promise<DexQuote> {
  const empty: DexQuote = {
    name: dex.name,
    type: "v2",
    routerAddress: dex.routerAddress,
    lpTokenAddress: dex.lpTokenAddress,
    casReserve: 0n,
    pairedReserve: 0n,
    pairedToken: "",
    isWPOL: false,
    pricePerCas: 0,
    hasLiquidity: false,
  };

  if (!dex.lpTokenAddress) {
    log("WARN", "No LP token address for V2 DEX", { dex: dex.name });
    return empty;
  }

  try {
    const pair = new ethers.Contract(dex.lpTokenAddress, PAIR_ABI, provider);
    const [r0, r1] = await pair.getReserves();
    const t0 = (await pair.token0()).toLowerCase();
    const t1 = (await pair.token1()).toLowerCase();
    const casLower = casToken.toLowerCase();

    const isCas0 = t0 === casLower;
    const casReserve = isCas0 ? r0 : r1;
    const pairedReserve = isCas0 ? r1 : r0;
    const pairedToken = isCas0 ? t1 : t0;
    const isWPOL = pairedToken === WPOL_ADDRESS.toLowerCase();

    const pricePerCas = casReserve > 0n ? Number(pairedReserve) / Number(casReserve) : 0;

    return {
      ...empty,
      casReserve,
      pairedReserve,
      pairedToken,
      isWPOL,
      pricePerCas,
      hasLiquidity: casReserve > 0n && pairedReserve > 0n,
    };
  } catch (err) {
    log("WARN", "Failed to read V2 pair reserves", { dex: dex.name, error: (err as Error).message });
    return empty;
  }
}

async function scanV3Dex(
  provider: ethers.JsonRpcProvider,
  dex: DexConfig,
  casToken: string,
  amountIn: bigint,
): Promise<DexQuote> {
  const empty: DexQuote = {
    name: dex.name,
    type: dex.type,
    routerAddress: dex.routerAddress,
    casReserve: 0n,
    pairedReserve: 0n,
    pairedToken: WPOL_ADDRESS,
    isWPOL: true,
    pricePerCas: 0,
    hasLiquidity: false,
  };

  if (!dex.quoterAddress) {
    log("WARN", "No quoter address for V3 DEX", { dex: dex.name });
    return empty;
  }

  try {
    if (dex.type === "v3") {
      const quoter = new ethers.Contract(dex.quoterAddress, V3_QUOTER_ABI, provider);
      let bestOut = 0n;

      for (const fee of V3_FEE_TIERS) {
        try {
          const result = await quoter.quoteExactInputSingle.staticCall({
            tokenIn: WPOL_ADDRESS,
            tokenOut: casToken,
            amountIn,
            fee,
            sqrtPriceLimitX96: 0n,
          });
          const out = (result as unknown as bigint[])[0] as bigint;
          if (out > bestOut) bestOut = out;
        } catch {
          // fee tier not available
        }
      }

      const pricePerCas = bestOut > 0n ? Number(amountIn) / Number(bestOut) : 0;
      return {
        ...empty,
        casReserve: bestOut,
        pairedReserve: amountIn,
        pricePerCas,
        hasLiquidity: bestOut > 0n,
      };
    } else {
      const quoter = new ethers.Contract(dex.quoterAddress, ALGEBRA_QUOTER_ABI, provider);
      const result = await quoter.quoteExactInputSingle.staticCall(WPOL_ADDRESS, casToken, amountIn);
      const out = (result as unknown as bigint[])[0] as bigint;
      const pricePerCas = out > 0n ? Number(amountIn) / Number(out) : 0;
      return {
        ...empty,
        casReserve: out,
        pairedReserve: amountIn,
        pricePerCas,
        hasLiquidity: out > 0n,
      };
    }
  } catch (err) {
    log("WARN", "Failed to quote V3/Algebra DEX", { dex: dex.name, error: (err as Error).message });
    return empty;
  }
}

async function scanDexPrices(
  provider: ethers.JsonRpcProvider,
  casToken: string,
  amountIn: bigint,
): Promise<DexQuote[]> {
  const dexList = buildDexList();
  const quotes: DexQuote[] = [];

  for (const dex of dexList) {
    log("INFO", "Scanning DEX", { name: dex.name, type: dex.type });
    const quote =
      dex.type === "v2"
        ? await scanV2Dex(provider, dex, casToken)
        : await scanV3Dex(provider, dex, casToken, amountIn);
    quotes.push(quote);
  }

  return quotes;
}

async function executeBalance(
  signer: ethers.Wallet,
  casToken: string,
  cheapestDex: DexQuote,
  expensiveDex: DexQuote,
  amountIn: bigint,
): Promise<ExecutionResult> {
  const provider = signer.provider as ethers.JsonRpcProvider;
  const casContract = new ethers.Contract(casToken, ERC20_ABI, signer);

  const result: ExecutionResult = {
    success: false,
    buyDex: cheapestDex.name,
    sellDex: expensiveDex.name,
    buyTxHash: null,
    sellTxHash: null,
    approveTxHash: null,
    casBought: "0",
    casSold: "0",
    polIn: ethers.formatEther(amountIn),
    polOut: "0",
    netResult: "0",
    error: null,
  };

  log("INFO", "Executing balance trade", {
    buyDex: cheapestDex.name,
    sellDex: expensiveDex.name,
    amountIn: ethers.formatEther(amountIn),
  });

  const deadline = Math.floor(Date.now() / 1000) + 600;

  if (cheapestDex.type !== "v2") {
    result.error = `Execute not yet supported for ${cheapestDex.type} DEX (${cheapestDex.name})`;
    log("ERROR", result.error);
    return result;
  }

  try {
    const buyRouter = new ethers.Contract(cheapestDex.routerAddress, V2_ROUTER_ABI, signer);
    const buyPath = cheapestDex.isWPOL
      ? [WPOL_ADDRESS, casToken]
      : [cheapestDex.pairedToken, casToken];

    log("INFO", "Buying CAS on cheapest DEX", { dex: cheapestDex.name, polIn: ethers.formatEther(amountIn) });

    const buyTx = await buyRouter.swapExactETHForTokens(0n, buyPath, signer.address, deadline, { value: amountIn });
    await waitForTxWithRetry(buyTx, "buy");
    result.buyTxHash = buyTx.hash;
    log("INFO", "Buy completed", { txHash: buyTx.hash });

    const casBalance = await casContract.balanceOf(signer.address);
    result.casBought = ethers.formatEther(casBalance);
    if (casBalance === 0n) {
      result.error = "No CAS balance after buy";
      log("ERROR", result.error);
      return result;
    }

    const sellRouterAddr = expensiveDex.routerAddress;
    const currentAllowance = await casContract.allowance(signer.address, sellRouterAddr);
    if (currentAllowance < casBalance) {
      log("INFO", "Approving CAS for sell router", { dex: expensiveDex.name });
      const approveTx = await casContract.approve(sellRouterAddr, casBalance);
      await waitForTxWithRetry(approveTx, "approve-sell");
      result.approveTxHash = approveTx.hash;
      log("INFO", "Approval completed", { txHash: approveTx.hash });
    }

    if (expensiveDex.type !== "v2") {
      result.error = `Execute not yet supported for ${expensiveDex.type} DEX (${expensiveDex.name})`;
      log("ERROR", result.error);
      return result;
    }

    const sellRouter = new ethers.Contract(sellRouterAddr, V2_ROUTER_ABI, signer);
    const sellPath = expensiveDex.isWPOL
      ? [casToken, WPOL_ADDRESS]
      : [casToken, expensiveDex.pairedToken];

    log("INFO", "Selling CAS on expensive DEX", { dex: expensiveDex.name, casIn: ethers.formatEther(casBalance) });

    const sellTx = await sellRouter.swapExactTokensForETH(casBalance, 0n, sellPath, signer.address, deadline);
    await waitForTxWithRetry(sellTx, "sell");
    result.sellTxHash = sellTx.hash;
    result.casSold = ethers.formatEther(casBalance);

    const polBalanceAfter = await provider.getBalance(signer.address);
    const polBalanceBefore = await provider.getBalance(signer.address).then(() => amountIn);
    result.polOut = ethers.formatEther(polBalanceAfter);
    result.netResult = ethers.formatEther(polBalanceAfter - polBalanceBefore + amountIn);
    result.success = true;

    log("INFO", "Balance trade completed", { buyTx: buyTx.hash, sellTx: sellTx.hash });
    return result;
  } catch (err) {
    result.error = (err as Error).message;
    log("ERROR", "Balance trade failed", { error: result.error });
    return result;
  }
}

function findDexByName(quotes: DexQuote[], name: string): DexQuote | null {
  const lower = name.toLowerCase();
  return quotes.find((q) => q.name.toLowerCase().includes(lower)) ?? null;
}

function nowTs(): string {
  return new Date().toISOString().replace("T", " ").split(".")[0];
}

async function estimateSwapGas(
  router: ethers.Contract,
  path: string[],
  signer: ethers.Wallet,
  value: bigint,
  deadline: number,
): Promise<bigint> {
  try {
    const estimated = await router.swapExactETHForTokens.estimateGas(0n, path, signer.address, deadline, { value });
    return (estimated * (100n + GAS_ESTIMATE_BUFFER_PERCENT)) / 100n;
  } catch {
    return DEFAULT_SWAP_GAS_LIMIT;
  }
}

async function executeAllBuy(
  signer: ethers.Wallet,
  casToken: string,
  dex: DexQuote,
  polToSpend: bigint,
  ops: OperationLog[],
): Promise<{ success: boolean; casBought: string; txHash: string | null; error: string | null }> {
  const casContract = new ethers.Contract(casToken, ERC20_ABI, signer);
  const deadline = Math.floor(Date.now() / 1000) + 600;

  if (dex.type !== "v2") {
    const msg = `Buy not yet supported for ${dex.type} DEX (${dex.name})`;
    log("ERROR", msg);
    ops.push({ step: "allbuy", dex: dex.name, action: "buy", txHash: null, amount: "0", detail: msg, timestamp: nowTs() });
    return { success: false, casBought: "0", txHash: null, error: msg };
  }

  try {
    const router = new ethers.Contract(dex.routerAddress, V2_ROUTER_ABI, signer);
    const path = dex.isWPOL ? [WPOL_ADDRESS, casToken] : [dex.pairedToken, casToken];

    const provider = signer.provider as ethers.JsonRpcProvider;
    const polBalance = await provider.getBalance(signer.address);
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice ?? 30_000_000_000n;
    const maxFeePerGas = feeData.maxFeePerGas ?? gasPrice;

    const gasLimit = await estimateSwapGas(router, path, signer, polToSpend, deadline);
    const gasCost = gasLimit * maxFeePerGas;
    const totalNeeded = polToSpend + gasCost;

    log("INFO", "All-buy: pre-flight gas check", {
      dex: dex.name,
      polBalance: ethers.formatEther(polBalance),
      polToSpend: ethers.formatEther(polToSpend),
      gasLimit: gasLimit.toString(),
      gasCost: ethers.formatEther(gasCost),
      totalNeeded: ethers.formatEther(totalNeeded),
    });

    let adjustedPolToSpend = polToSpend;

    if (totalNeeded > polBalance) {
      adjustedPolToSpend = polBalance > gasCost ? polBalance - gasCost : 0n;

      if (adjustedPolToSpend === 0n) {
        const msg = `Saldo insuficiente para gas. Saldo: ${ethers.formatEther(polBalance)} POL. Gas estimado: ${ethers.formatEther(gasCost)} POL (limite: ${gasLimit}). Necessário pelo menos ${ethers.formatEther(gasCost)} POL para cobrir gas da transação.`;
        log("ERROR", "All-buy: insufficient funds for gas", {
          dex: dex.name,
          polBalance: ethers.formatEther(polBalance),
          gasCost: ethers.formatEther(gasCost),
          requiredMinBalance: ethers.formatEther(gasCost),
        });
        ops.push({
          step: "allbuy",
          dex: dex.name,
          action: "buy",
          txHash: null,
          amount: "0",
          detail: msg,
          timestamp: nowTs(),
        });
        return { success: false, casBought: "0", txHash: null, error: msg };
      }

      log("WARN", "All-buy: reserving gas, reducing purchase amount", {
        dex: dex.name,
        originalPolToSpend: ethers.formatEther(polToSpend),
        adjustedPolToSpend: ethers.formatEther(adjustedPolToSpend),
        gasReserved: ethers.formatEther(gasCost),
      });

      ops.push({
        step: "allbuy-gas-reserve",
        dex: dex.name,
        action: "plan",
        txHash: null,
        amount: ethers.formatEther(adjustedPolToSpend),
        detail: `Gas reservado: ${ethers.formatEther(gasCost)} POL (limite: ${gasLimit}). POL para compra ajustado de ${ethers.formatEther(polToSpend)} para ${ethers.formatEther(adjustedPolToSpend)} POL. Saldo: ${ethers.formatEther(polBalance)} POL.`,
        timestamp: nowTs(),
      });
    }

    log("INFO", "All-buy: buying CAS on DEX", { dex: dex.name, polIn: ethers.formatEther(adjustedPolToSpend) });

    const tx = await router.swapExactETHForTokens(0n, path, signer.address, deadline, { value: adjustedPolToSpend });
    await waitForTxWithRetry(tx, "allbuy");
    const casBalance = await casContract.balanceOf(signer.address);

    log("INFO", "All-buy completed", { dex: dex.name, txHash: tx.hash, casBought: ethers.formatEther(casBalance) });

    ops.push({
      step: "allbuy",
      dex: dex.name,
      action: "buy",
      txHash: tx.hash,
      amount: ethers.formatEther(adjustedPolToSpend),
      detail: `Comprou CAS com ${ethers.formatEther(adjustedPolToSpend)} POL (gas reservado: ${ethers.formatEther(gasCost)} POL). Saldo CAS: ${ethers.formatEther(casBalance)}`,
      timestamp: nowTs(),
    });

    return { success: true, casBought: ethers.formatEther(casBalance), txHash: tx.hash, error: null };
  } catch (err) {
    const msg = (err as Error).message;
    log("ERROR", "All-buy failed", { dex: dex.name, error: msg });
    ops.push({ step: "allbuy", dex: dex.name, action: "buy", txHash: null, amount: "0", detail: msg, timestamp: nowTs() });
    return { success: false, casBought: "0", txHash: null, error: msg };
  }
}

async function executeAllSell(
  signer: ethers.Wallet,
  casToken: string,
  dex: DexQuote,
  casToSell: bigint,
  ops: OperationLog[],
): Promise<{ success: boolean; polReceived: string; txHash: string | null; approveTxHash: string | null; error: string | null }> {
  const casContract = new ethers.Contract(casToken, ERC20_ABI, signer);
  const deadline = Math.floor(Date.now() / 1000) + 600;

  if (dex.type !== "v2") {
    const msg = `Sell not yet supported for ${dex.type} DEX (${dex.name})`;
    log("ERROR", msg);
    ops.push({ step: "allsell", dex: dex.name, action: "sell", txHash: null, amount: "0", detail: msg, timestamp: nowTs() });
    return { success: false, polReceived: "0", txHash: null, approveTxHash: null, error: msg };
  }

  try {
    const routerAddr = dex.routerAddress;
    const currentAllowance = await casContract.allowance(signer.address, routerAddr);
    let approveTxHash: string | null = null;

    if (currentAllowance < casToSell) {
      log("INFO", "All-sell: approving CAS", { dex: dex.name, amount: ethers.formatEther(casToSell) });
      const approveTx = await casContract.approve(routerAddr, casToSell);
      await waitForTxWithRetry(approveTx, "allsell-approve");
      approveTxHash = approveTx.hash;
      ops.push({
        step: "allsell-approve",
        dex: dex.name,
        action: "approve",
        txHash: approveTx.hash,
        amount: ethers.formatEther(casToSell),
        detail: `Aprovou CAS para venda na ${dex.name}`,
        timestamp: nowTs(),
      });
    }

    const router = new ethers.Contract(routerAddr, V2_ROUTER_ABI, signer);
    const path = dex.isWPOL ? [casToken, WPOL_ADDRESS] : [casToken, dex.pairedToken];

    log("INFO", "All-sell: selling CAS on DEX", { dex: dex.name, casIn: ethers.formatEther(casToSell) });

    const polBefore = await signer.provider!.getBalance(signer.address);
    const tx = await router.swapExactTokensForETH(casToSell, 0n, path, signer.address, deadline);
    await waitForTxWithRetry(tx, "allsell");
    const polAfter = await signer.provider!.getBalance(signer.address);
    const polReceived = polAfter > polBefore ? polAfter - polBefore : 0n;

    log("INFO", "All-sell completed", { dex: dex.name, txHash: tx.hash, polReceived: ethers.formatEther(polReceived) });

    ops.push({
      step: "allsell",
      dex: dex.name,
      action: "sell",
      txHash: tx.hash,
      amount: ethers.formatEther(casToSell),
      detail: `Vendeu ${ethers.formatEther(casToSell)} CAS. POL recebido: ${ethers.formatEther(polReceived)}`,
      timestamp: nowTs(),
    });

    return { success: true, polReceived: ethers.formatEther(polReceived), txHash: tx.hash, approveTxHash, error: null };
  } catch (err) {
    const msg = (err as Error).message;
    log("ERROR", "All-sell failed", { dex: dex.name, error: msg });
    ops.push({ step: "allsell", dex: dex.name, action: "sell", txHash: null, amount: "0", detail: msg, timestamp: nowTs() });
    return { success: false, polReceived: "0", txHash: null, approveTxHash: null, error: msg };
  }
}

async function executeAllBalance(
  signer: ethers.Wallet,
  casToken: string,
  sellDex: DexQuote,
  buyDex: DexQuote,
  ops: OperationLog[],
): Promise<{ success: boolean; error: string | null }> {
  const casContract = new ethers.Contract(casToken, ERC20_ABI, signer);
  const casBalance = await casContract.balanceOf(signer.address);

  log("INFO", "All-balance: starting combined sell+buy", {
    sellDex: sellDex.name,
    buyDex: buyDex.name,
    casBalance: ethers.formatEther(casBalance),
  });

  if (casBalance === 0n) {
    const msg = "No CAS balance to sell";
    log("WARN", msg);
    ops.push({ step: "allbalance", dex: sellDex.name, action: "sell", txHash: null, amount: "0", detail: msg, timestamp: nowTs() });
    return { success: false, error: msg };
  }

  ops.push({
    step: "allbalance-plan",
    dex: `${sellDex.name} → ${buyDex.name}`,
    action: "plan",
    txHash: null,
    amount: ethers.formatEther(casBalance),
    detail: `Plano: vender ${ethers.formatEther(casBalance)} CAS na ${sellDex.name} (mais cara) e usar POL para comprar CAS na ${buyDex.name} (mais barata)`,
    timestamp: nowTs(),
  });

  const sellResult = await executeAllSell(signer, casToken, sellDex, casBalance, ops);
  if (!sellResult.success) {
    return { success: false, error: sellResult.error };
  }

  const polReceived = ethers.parseEther(sellResult.polReceived);
  const feeData = await signer.provider!.getFeeData();
  const gasPrice = feeData.gasPrice ?? 30_000_000_000n;
  const maxFeePerGas = feeData.maxFeePerGas ?? gasPrice;
  const buyGas = DEFAULT_SWAP_GAS_LIMIT * maxFeePerGas;
  const polForBuy = polReceived > buyGas ? polReceived - buyGas : 0n;

  if (polForBuy === 0n) {
    const msg = `POL received (${sellResult.polReceived}) not enough after gas for buy`;
    log("WARN", msg);
    ops.push({ step: "allbalance", dex: buyDex.name, action: "buy", txHash: null, amount: "0", detail: msg, timestamp: nowTs() });
    return { success: false, error: msg };
  }

  log("INFO", "All-balance: using POL proceeds to buy CAS", {
    buyDex: buyDex.name,
    polForBuy: ethers.formatEther(polForBuy),
  });

  const buyResult = await executeAllBuy(signer, casToken, buyDex, polForBuy, ops);

  ops.push({
    step: "allbalance-summary",
    dex: `${sellDex.name} → ${buyDex.name}`,
    action: "summary",
    txHash: null,
    amount: "",
    detail: buyResult.success
      ? `Equilíbrio concluído: vendeu na ${sellDex.name}, comprou na ${buyDex.name}. CAS final: ${buyResult.casBought}`
      : `Equilíbrio falhou na compra: ${buyResult.error}`,
    timestamp: nowTs(),
  });

  return { success: buyResult.success, error: buyResult.error };
}

async function findConversionRouter(
  provider: ethers.JsonRpcProvider,
  tokenIn: string,
  tokenOut: string,
): Promise<DexConfig | null> {
  const dexList = buildDexList().filter((d) => d.type === "v2");
  for (const dex of dexList) {
    try {
      const router = new ethers.Contract(dex.routerAddress, V2_ROUTER_ABI, provider);
      const testAmount = ethers.parseEther("0.001");
      const amounts = await router.getAmountsOut(testAmount, [tokenIn, tokenOut]);
      if (amounts && amounts[amounts.length - 1] > 0n) {
        return dex;
      }
    } catch {
      // This DEX doesn't have this pair, try next
    }
  }
  return null;
}

async function executeAllBalanceViaFacet(
  signer: ethers.Wallet,
  casToken: string,
  sellDex: DexQuote,
  buyDex: DexQuote,
  ops: OperationLog[],
): Promise<{ success: boolean; error: string | null }> {
  const diamondAddress = process.env.DIAMOND_ADDRESS;
  if (!diamondAddress) {
    log("WARN", "DIAMOND_ADDRESS not set, falling back to non-atomic execution");
    return executeAllBalance(signer, casToken, sellDex, buyDex, ops);
  }

  const casContract = new ethers.Contract(casToken, ERC20_ABI, signer);
  const casBalance = await casContract.balanceOf(signer.address);

  if (casBalance === 0n) {
    const msg = "No CAS balance to sell";
    log("WARN", msg);
    ops.push({ step: "facet-balance", dex: sellDex.name, action: "sell", txHash: null, amount: "0", detail: msg, timestamp: nowTs() });
    return { success: false, error: msg };
  }

  log("INFO", "All-balance via MultiRouteSwapFacet (atomic)", {
    sellDex: sellDex.name,
    buyDex: buyDex.name,
    casBalance: ethers.formatEther(casBalance),
    diamond: diamondAddress,
  });

  // Build hops for the facet
  // Hop 1: Sell CAS → pairedToken on sellDex (swapExactTokensForTokens or swapExactTokensForETH)
  // Hop 2 (if needed): Convert pairedToken → WPOL
  // Hop 3: Buy CAS with WPOL on buyDex (swapExactETHForTokens)

  const hops: Array<{
    router: string;
    path: string[];
    useNativeIn: boolean;
    useNativeOut: boolean;
    amountIn: string;
  }> = [];

  // Hop 1: Sell CAS on sellDex
  if (sellDex.type !== "v2") {
    const msg = `Sell not supported for ${sellDex.type} DEX (${sellDex.name})`;
    ops.push({ step: "facet-balance", dex: sellDex.name, action: "sell", txHash: null, amount: "0", detail: msg, timestamp: nowTs() });
    return { success: false, error: msg };
  }

  if (sellDex.isWPOL) {
    // CAS → WPOL (swapExactTokensForETH since WPOL = native)
    hops.push({
      router: sellDex.routerAddress,
      path: [casToken, WPOL_ADDRESS],
      useNativeIn: false,
      useNativeOut: true,
      amountIn: casBalance.toString(),
    });
  } else {
    // CAS → WETH or other paired token (swapExactTokensForTokens)
    hops.push({
      router: sellDex.routerAddress,
      path: [casToken, sellDex.pairedToken],
      useNativeIn: false,
      useNativeOut: false,
      amountIn: casBalance.toString(),
    });

    // Hop 2: Convert pairedToken → WPOL if not WPOL already
    // Search all V2 DEXs for one that has pairedToken/WPOL liquidity
    const conversionRouter = await findConversionRouter(provider, sellDex.pairedToken, WPOL_ADDRESS);
    if (!conversionRouter) {
      const msg = `No V2 DEX found with liquidity for ${sellDex.pairedToken.slice(0, 8)}→WPOL conversion`;
      ops.push({ step: "facet-balance", dex: sellDex.name, action: "convert", txHash: null, amount: "0", detail: msg, timestamp: nowTs() });
      return { success: false, error: msg };
    }
    log("INFO", "Found conversion router", { router: conversionRouter.name, from: sellDex.pairedToken.slice(0, 8), to: "WPOL" });
    hops.push({
      router: conversionRouter.routerAddress,
      path: [sellDex.pairedToken, WPOL_ADDRESS],
      useNativeIn: false,
      useNativeOut: false,
      amountIn: "0", // will use output from previous hop
    });
  }

  // Final hop: Buy CAS on buyDex with WPOL
  if (buyDex.type !== "v2") {
    const msg = `Buy not supported for ${buyDex.type} DEX (${buyDex.name})`;
    ops.push({ step: "facet-balance", dex: buyDex.name, action: "buy", txHash: null, amount: "0", detail: msg, timestamp: nowTs() });
    return { success: false, error: msg };
  }

  if (buyDex.isWPOL) {
    // WPOL → CAS (swapExactETHForTokens)
    hops.push({
      router: buyDex.routerAddress,
      path: [WPOL_ADDRESS, casToken],
      useNativeIn: true,
      useNativeOut: false,
      amountIn: "0",
    });
  } else {
    // WPOL → pairedToken → CAS (multi-hop within the same router)
    hops.push({
      router: buyDex.routerAddress,
      path: [WPOL_ADDRESS, buyDex.pairedToken, casToken],
      useNativeIn: true,
      useNativeOut: false,
      amountIn: "0",
    });
  }

  ops.push({
    step: "facet-balance-plan",
    dex: `${sellDex.name} → ${buyDex.name}`,
    action: "plan",
    txHash: null,
    amount: ethers.formatEther(casBalance),
    detail: `Plano atômico via MultiRouteSwapFacet: ${hops.length} hops. Vende ${ethers.formatEther(casBalance)} CAS na ${sellDex.name}, converte para WPOL, compra CAS na ${buyDex.name}`,
    timestamp: nowTs(),
  });

  try {
    // Approve CAS for the Diamond (first hop needs it)
    const currentAllowance = await casContract.allowance(signer.address, diamondAddress);
    if (currentAllowance < casBalance) {
      log("INFO", "Approving CAS for Diamond", { diamond: diamondAddress });
      const approveTx = await casContract.approve(diamondAddress, casBalance);
      await approveTx.wait();
      ops.push({
        step: "facet-balance-approve",
        dex: "Diamond",
        action: "approve",
        txHash: approveTx.hash,
        amount: ethers.formatEther(casBalance),
        detail: `Aprovou CAS para o Diamond proxy`,
        timestamp: nowTs(),
      });
    }

    const facet = new ethers.Contract(diamondAddress, MULTI_ROUTE_FACET_ABI, signer);

    log("INFO", "Executing atomic multi-route swap via facet", { hops: hops.length });
    const tx = await facet.executeHops(hops, 0n);
    const receipt = await tx.wait();

    log("INFO", "Atomic multi-route swap completed", { txHash: tx.hash });

    const finalCasBalance = await casContract.balanceOf(signer.address);
    ops.push({
      step: "facet-balance",
      dex: `${sellDex.name} → ${buyDex.name}`,
      action: "execute",
      txHash: tx.hash,
      amount: ethers.formatEther(casBalance),
      detail: `Swap atômico executado via MultiRouteSwapFacet. CAS final: ${ethers.formatEther(finalCasBalance)}`,
      timestamp: nowTs(),
    });

    ops.push({
      step: "facet-balance-summary",
      dex: `${sellDex.name} → ${buyDex.name}`,
      action: "summary",
      txHash: null,
      amount: "",
      detail: `Equilíbrio atômico concluído: vendeu na ${sellDex.name}, comprou na ${buyDex.name}. CAS final: ${ethers.formatEther(finalCasBalance)}`,
      timestamp: nowTs(),
    });

    return { success: true, error: null };
  } catch (err) {
    const msg = (err as Error).message;
    log("ERROR", "Atomic multi-route swap failed", { error: msg });
    ops.push({
      step: "facet-balance",
      dex: `${sellDex.name} → ${buyDex.name}`,
      action: "execute",
      txHash: null,
      amount: "0",
      detail: `Falha no swap atômico: ${msg}`,
      timestamp: nowTs(),
    });
    return { success: false, error: msg };
  }
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function sanitizeDetail(raw: string): { short: string; full: string; isError: boolean } {
  const isError = /insufficient funds|INVALID_ARGUMENT|SERVER_ERROR|CALL_EXCEPTION|replacement fee too low|nonce too low|execution reverted|TIMEOUT|INSUFFICIENT_FUNDS/i.test(raw);

  let short = raw;

  const insufMatch = raw.match(/insufficient funds for gas \* price \+ value[^:]*: balance ([0-9.]+), tx cost ([0-9.]+), overshot ([0-9.]+)/);
  if (insufMatch) {
    const fmt = (v: string) => `${(Number(v) / 1e18).toFixed(6)} POL`;
    short = `Saldo insuficiente para gas + value. Saldo: ${fmt(insufMatch[1])}, Custo: ${fmt(insufMatch[2])}, Déficit: ${fmt(insufMatch[3])}`;
  } else if (/INSUFFICIENT_FUNDS/i.test(raw) && !insufMatch) {
    short = "Saldo insuficiente para executar a transação.";
  } else if (/execution reverted/i.test(raw)) {
    const revMatch = raw.match(/reason="([^"]+)"/);
    short = revMatch ? `Transação revertida: ${revMatch[1]}` : "Transação revertida pelo contrato.";
  } else if (/nonce too low/i.test(raw)) {
    short = "Nonce muito baixo — transação já enviada ou substituída.";
  } else if (/replacement fee too low/i.test(raw)) {
    short = "Taxa de substituição muito baixa — aumente o gas price.";
  } else if (/INVALID_ARGUMENT/i.test(raw)) {
    const argMatch = raw.match(/argument="([^"]+)", value="([^"]+)"/);
    short = argMatch ? `Argumento inválido (${argMatch[1]}): ${argMatch[2]}` : "Argumento inválido passado ao contrato.";
  } else if (/SERVER_ERROR|TIMEOUT|Unknown block|could not coalesce/i.test(raw)) {
    short = "Erro de comunicação com o RPC. Tente novamente.";
  } else if (raw.length > 120) {
    short = raw.slice(0, 117) + "...";
  }

  return { short, full: raw, isError };
}

function resolveLabel(addr: string): string {
  const lower = addr.toLowerCase();
  if (lower === WPOL_ADDRESS.toLowerCase()) return "WPOL (Wrapped POL)";
  if (lower === WETH_ADDRESS.toLowerCase()) return "WETH (Wrapped ETH)";
  try {
    const rec = getAddress(lower);
    if (rec) {
      const parts = [rec.name, rec.label].filter((p) => p && p.trim());
      if (parts.length > 0) return parts.join(" — ");
    }
  } catch {
    // DB not available
  }
  return "";
}

function shortAddr(addr: string): string {
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}

function polyscanAddr(addr: string): string {
  return `https://polygonscan.com/address/${addr}`;
}

function polyscanTx(hash: string): string {
  return `https://polygonscan.com/tx/${hash}`;
}

function addrLink(addr: string): string {
  const label = resolveLabel(addr);
  const display = label || shortAddr(addr);
  return `<a href="${polyscanAddr(addr)}" target="_blank" class="addr-link" title="${esc(addr)}">${esc(display)}</a>`;
}

function deviationColor(dev: number): string {
  const abs = Math.abs(dev);
  if (abs < 1) return "#F05F40";
  if (abs < 3) return "#fcc650";
  return "#eb3812";
}

interface RouteHop {
  dex: string;
  router: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  expectedAmountOut: string;
  priceImpactPct: number;
}

interface RouteAnalysis {
  buyDex: DexQuote;
  sellDex: DexQuote;
  amountIn: string;
  casBought: string;
  casSold: string;
  polReceived: string;
  profit: string;
  profitPct: number;
  priceImpactBuyPct: number;
  priceImpactSellPct: number;
  gasEstimate: string;
  netProfit: string;
  isProfitable: boolean;
  hops: RouteHop[];
  conversionDex: string | null;
  routeType: string;
}

async function analyzeRoute(
  provider: ethers.JsonRpcProvider,
  casToken: string,
  buyDex: DexQuote,
  sellDex: DexQuote,
  amountIn: bigint,
): Promise<RouteAnalysis> {
  const V2_ROUTER_QUOTE_ABI = [
    "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
  ];

  const hops: RouteHop[] = [];
  let casBought = 0n;
  let polReceived = 0n;
  let conversionDex: string | null = null;
  let routeType = "";

  // Step 1: Buy CAS on buyDex with POL
  if (buyDex.type !== "v2") {
    throw new Error(`Buy DEX ${buyDex.name} is not V2 (unsupported for analysis)`);
  }

  const buyRouter = new ethers.Contract(buyDex.routerAddress, V2_ROUTER_QUOTE_ABI, provider);
  const buyPath = buyDex.isWPOL
    ? [WPOL_ADDRESS, casToken]
    : [WPOL_ADDRESS, buyDex.pairedToken, casToken];

  const buyAmounts = await buyRouter.getAmountsOut(amountIn, buyPath);
  casBought = buyAmounts[buyAmounts.length - 1];

  const buyPriceBefore = buyDex.pricePerCas;
  const buyPriceAfter = Number(ethers.formatEther(buyDex.pairedReserve)) / Number(ethers.formatEther(buyDex.casReserve - casBought + (buyDex.casReserve > casBought ? 0n : 1n)));
  const priceImpactBuyPct = buyPriceBefore > 0 ? ((buyPriceAfter - buyPriceBefore) / buyPriceBefore) * 100 : 0;

  hops.push({
    dex: buyDex.name,
    router: buyDex.routerAddress,
    tokenIn: "POL",
    tokenOut: "CAS",
    amountIn: ethers.formatEther(amountIn),
    expectedAmountOut: ethers.formatEther(casBought),
    priceImpactPct: priceImpactBuyPct,
  });

  // Step 2: Sell CAS on sellDex for POL
  if (sellDex.type !== "v2") {
    throw new Error(`Sell DEX ${sellDex.name} is not V2 (unsupported for analysis)`);
  }

  const sellRouter = new ethers.Contract(sellDex.routerAddress, V2_ROUTER_QUOTE_ABI, provider);
  const sellPath = sellDex.isWPOL
    ? [casToken, WPOL_ADDRESS]
    : [casToken, sellDex.pairedToken, WPOL_ADDRESS];

  const sellAmounts = await sellRouter.getAmountsOut(casBought, sellPath);
  polReceived = sellAmounts[sellAmounts.length - 1];

  const sellPriceBefore = sellDex.pricePerCas;
  const sellPriceAfter = Number(ethers.formatEther(sellDex.pairedReserve + polReceived)) / Number(ethers.formatEther(sellDex.casReserve));
  const priceImpactSellPct = sellPriceBefore > 0 ? ((sellPriceAfter - sellPriceBefore) / sellPriceBefore) * 100 : 0;

  hops.push({
    dex: sellDex.name,
    router: sellDex.routerAddress,
    tokenIn: "CAS",
    tokenOut: "POL",
    amountIn: ethers.formatEther(casBought),
    expectedAmountOut: ethers.formatEther(polReceived),
    priceImpactPct: priceImpactSellPct,
  });

  // If buyDex and sellDex use different paired tokens, there's a conversion hop
  if (!buyDex.isWPOL && !sellDex.isWPOL && buyDex.pairedToken !== sellDex.pairedToken) {
    routeType = "multi-hop (conversão intermediária)";
    const convRouter = await findConversionRouter(provider, buyDex.pairedToken, sellDex.pairedToken);
    conversionDex = convRouter?.name ?? null;
  } else if (buyDex.name === sellDex.name) {
    routeType = "round-trip (mesma DEX)";
  } else {
    routeType = "direto (POL → CAS → POL)";
  }

  const profit = polReceived > amountIn ? polReceived - amountIn : 0n;
  const loss = amountIn > polReceived ? amountIn - polReceived : 0n;
  const profitPct = amountIn > 0n ? (Number(ethers.formatEther(profit > 0n ? profit : -loss)) / Number(ethers.formatEther(amountIn))) * 100 : 0;

  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? 30_000_000_000n;
  const gasEstimate = (DEFAULT_SWAP_GAS_LIMIT * 2n + 100_000n) * gasPrice;
  const netProfit = profit > gasEstimate ? profit - gasEstimate : 0n;

  return {
    buyDex,
    sellDex,
    amountIn: ethers.formatEther(amountIn),
    casBought: ethers.formatEther(casBought),
    casSold: ethers.formatEther(casBought),
    polReceived: ethers.formatEther(polReceived),
    profit: ethers.formatEther(profit > 0n ? profit : 0n),
    profitPct,
    priceImpactBuyPct,
    priceImpactSellPct,
    gasEstimate: ethers.formatEther(gasEstimate),
    netProfit: ethers.formatEther(netProfit),
    isProfitable: netProfit > 0n,
    hops,
    conversionDex,
    routeType,
  };
}

interface LlmAnalysisResult {
  summary: string;
  recommendations: string[];
  riskAssessment: string;
  modelUsed: string;
}

function buildLlmContext(
  sorted: DexQuote[],
  avgPrice: number,
  cheapest: DexQuote,
  expensive: DexQuote,
  spreadPct: number,
  spreadBps: number,
  isBalanced: boolean,
  amount: string,
  mode: string,
  funding: FundingInfo | null,
  routeAnalysis: RouteAnalysis | null,
): string {
  const dexLines = sorted.map((q, i) => {
    const dev = ((q.pricePerCas - avgPrice) / avgPrice) * 100;
    return `  ${i + 1}. ${q.name} (${q.type.toUpperCase()}): price=${q.pricePerCas.toFixed(6)} POL/CAS, CAS_reserve=${ethers.formatEther(q.casReserve)}, paired_reserve=${ethers.formatEther(q.pairedReserve)}, deviation=${dev.toFixed(2)}%, liquidity=${q.hasLiquidity}`;
  }).join("\n");

  const walletLines = funding?.wallets.map(w =>
    `  ${w.label} (${w.address}): POL=${w.polBalance}, CAS=${w.casBalance}`
  ).join("\n") ?? "  (no wallet data)";

  const routeInfo = routeAnalysis
    ? `\nRoute analysis:\n  Buy on ${routeAnalysis.buyDex.name} → Sell on ${routeAnalysis.sellDex.name}\n  POL invested: ${routeAnalysis.amountIn}\n  CAS bought: ${routeAnalysis.casBought}\n  POL received: ${routeAnalysis.polReceived}\n  Gross profit: ${routeAnalysis.profit} POL (${routeAnalysis.profitPct.toFixed(3)}%)\n  Gas estimate: ${routeAnalysis.gasEstimate} POL\n  Net profit: ${routeAnalysis.netProfit} POL\n  Profitable: ${routeAnalysis.isProfitable}\n  Route type: ${routeAnalysis.routeType}`
    : "";

  return `DEX Price Analysis Report for CAS token on Polygon PoS
Mode: ${mode}
Amount for analysis: ${amount} POL

DEX prices (sorted cheapest to most expensive):
${dexLines}

Market summary:
  Average price: ${avgPrice.toFixed(6)} POL/CAS
  Cheapest DEX: ${cheapest.name} at ${cheapest.pricePerCas.toFixed(6)} POL/CAS
  Most expensive DEX: ${expensive.name} at ${expensive.pricePerCas.toFixed(6)} POL/CAS
  Spread: ${spreadPct.toFixed(2)}% (${spreadBps} bps)
  Status: ${isBalanced ? "BALANCED" : "IMBALANCED"}

Wallet balances:
${walletLines}
${routeInfo}
`;
}

async function generateLlmAnalysis(
  sorted: DexQuote[],
  avgPrice: number,
  cheapest: DexQuote,
  expensive: DexQuote,
  spreadPct: number,
  spreadBps: number,
  isBalanced: boolean,
  amount: string,
  mode: string,
  funding: FundingInfo | null,
  routeAnalysis: RouteAnalysis | null,
): Promise<LlmAnalysisResult | null> {
  const ollamaUrl = process.env.OLLAMA_BASE_URL || process.env.OLLAMA_URL || "http://127.0.0.1:11434";
  const primaryModel = process.env.OLLAMA_MODEL || "Rapport_Trader_qwen2.5-v1:latest";
  const fallbackModels = ["Rapport_Trader_qwen2.5-v1:latest", "qwen2.5:7b", "granite4:small-h"];
  const models = [primaryModel, ...fallbackModels.filter(m => m !== primaryModel)];

  const systemPrompt = `You are the AgenticSpace DEX analyst AI, operating on Polygon PoS.
Your job is to analyze DEX price data for the CAS token and produce a concise textual report in Portuguese (pt-BR).

You must respond with a single valid JSON object (no markdown, no code fences) with this exact shape:
{
  "summary": "2-4 sentences summarizing the current DEX price situation in Portuguese",
  "recommendations": ["array of 2-4 actionable recommendations in Portuguese"],
  "riskAssessment": "1-2 sentences assessing risks (liquidity, spread, price impact) in Portuguese"
}

Rules:
- Write everything in Portuguese (pt-BR).
- Be concise and direct. No fluff.
- Focus on actionable insights for the operator.
- If the market is imbalanced, suggest specific actions (buy on cheapest, sell on most expensive).
- If a route analysis is provided, comment on its profitability and suggest improvements.
- If wallet balances are low, warn about insufficient funds for operations.
- Never recommend wash trading or manipulation. Focus on organic arbitrage and liquidity provision.
- Consider gas costs when discussing profitability.`;

  const userMessage = buildLlmContext(
    sorted, avgPrice, cheapest, expensive, spreadPct, spreadBps,
    isBalanced, amount, mode, funding, routeAnalysis,
  );

  for (const model of models) {
    log("INFO", "Generating LLM analysis", { model, url: ollamaUrl, attempt: models.indexOf(model) + 1 });

    try {
      const body = {
        model,
        system: systemPrompt,
        prompt: userMessage,
        stream: false,
        format: "json",
        options: {
          temperature: 0.3,
          top_p: 0.8,
          num_predict: 400,
          num_ctx: 2048,
        },
      };

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 90_000);

      const res = await fetch(`${ollamaUrl}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!res.ok) {
        throw new Error(`Ollama error ${res.status}: ${await res.text()}`);
      }

      const data = (await res.json()) as { response?: string };
      const raw = data.response?.trim() ?? "";
      const cleaned = raw.replace(/^```json\s*/, "").replace(/```$/, "").trim();
      const parsed = JSON.parse(cleaned) as LlmAnalysisResult;
      parsed.modelUsed = model;

      log("INFO", "LLM analysis generated", {
        model,
        summaryLength: parsed.summary?.length ?? 0,
        recommendations: parsed.recommendations?.length ?? 0,
      });

      return parsed;
    } catch (err) {
      log("WARN", "LLM analysis failed for model", { error: (err as Error).message, model });
    }
  }

  log("WARN", "All LLM models failed, skipping textual analysis");
  return null;
}

function generateHtmlReport(
  quotes: DexQuote[],
  validQuotes: DexQuote[],
  sorted: DexQuote[],
  avgPrice: number,
  cheapest: DexQuote,
  expensive: DexQuote,
  spreadPct: number,
  spreadBps: number,
  isBalanced: boolean,
  minSpread: number,
  amount: string,
  mode: string,
  funding: FundingInfo | null,
  execResult: ExecutionResult | null,
  casToken: string,
  ops: OperationLog[],
  postOpQuotes: DexQuote[] | null = null,
  routeAnalysis: RouteAnalysis | null = null,
  llmAnalysis: LlmAnalysisResult | null = null,
): string {
  const now = new Date().toISOString().replace("T", " ").split(".")[0];
  const dexRows = sorted.map((q, i) => {
    const dev = ((q.pricePerCas - avgPrice) / avgPrice) * 100;
    const devColor = deviationColor(dev);
    const isCheapest = i === 0;
    const isExpensive = i === sorted.length - 1;
    const badge = isCheapest
      ? '<span class="badge badge-cheap">MAIS BARATA</span>'
      : isExpensive
        ? '<span class="badge badge-expensive">MAIS CARA</span>'
        : "";
    const pairedDisplay = q.isWPOL ? "WPOL" : addrLink(q.pairedToken);
    const lpLink = q.lpTokenAddress ? addrLink(q.lpTokenAddress) : '<span class="no-liq">—</span>';
    return `<tr>
      <td>${esc(q.name)} ${badge}<br><span class="router-addr">${addrLink(q.routerAddress)}</span></td>
      <td><span class="type-tag type-${q.type}">${q.type.toUpperCase()}</span></td>
      <td>${pairedDisplay}</td>
      <td>${lpLink}</td>
      <td class="num">${Number(ethers.formatEther(q.casReserve)).toFixed(4)}</td>
      <td class="num">${Number(ethers.formatEther(q.pairedReserve)).toFixed(4)}</td>
      <td class="num price">${q.pricePerCas.toFixed(6)}</td>
      <td class="num" style="color:${devColor}">${dev.toFixed(2)}%</td>
    </tr>`;
  }).join("\n");

  const noLiquidityRows = quotes
    .filter((q) => !q.hasLiquidity)
    .map((q) => `<tr><td>${esc(q.name)}<br><span class="router-addr">${addrLink(q.routerAddress)}</span></td><td><span class="type-tag type-${q.type}">${q.type.toUpperCase()}</span></td><td colspan="6" class="no-liq">Sem liquidez</td></tr>`)
    .join("\n");

  const statusBadge = isBalanced
    ? '<span class="status-badge status-ok">EQUILIBRADO</span>'
    : '<span class="status-badge status-warn">DESBALANCEADO</span>';

  let fundingSection = "";
  if (funding) {
    const walletRows = funding.wallets.map(w => {
      const signerTag = w.isSigner ? ' <span class="badge badge-cheap">ATIVO</span>' : "";
      return `<tr>
        <td>${esc(w.label)}${signerTag}</td>
        <td>${addrLink(w.address)}</td>
        <td class="num">${esc(w.polBalance)}</td>
        <td class="num">${esc(w.casBalance)}</td>
      </tr>`;
    }).join("\n");

    const modeLabel: Record<string, string> = {
      "scan": "Análise (scan)",
      "execute": "Execução manual",
      "all-buy": "Compra total (--allbuy)",
      "all-sell": "Venda total (--allsell)",
      "all-balance": "Equilíbrio (--allbuy + --allsell)",
      "route": "Rota nomeada (--route)",
      "list-routes": "Listagem de rotas",
      "analysis": "Análise de rota (--analysis)",
    };
    const modeText = modeLabel[funding.mode] ?? funding.mode;

    const polForBuy = Number(funding.polAvailableForBuy);
    const polForBuyColor = polForBuy > 0 ? "var(--color-text-main)" : "#eb3812";

    const contextRows = funding.mode === "all-buy"
      ? `<tr><td>POL disponível para compra (saldo - gas)</td><td class="num" style="color:${polForBuyColor}">${esc(funding.polAvailableForBuy)} POL</td></tr>
         <tr><td>Custo de gas estimado</td><td class="num">${esc(funding.gasCostPol)} POL</td></tr>`
      : funding.mode === "all-sell"
      ? `<tr><td>CAS disponível para venda</td><td class="num">${esc(funding.casBalance)} CAS</td></tr>
         <tr><td>Custo de gas estimado</td><td class="num">${esc(funding.gasCostPol)} POL</td></tr>`
      : funding.mode === "all-balance" || funding.mode === "route"
      ? `<tr><td>CAS disponível para venda</td><td class="num">${esc(funding.casBalance)} CAS</td></tr>
         <tr><td>POL disponível (saldo - gas)</td><td class="num" style="color:${polForBuyColor}">${esc(funding.polAvailableForBuy)} POL</td></tr>
         <tr><td>Custo de gas estimado</td><td class="num">${esc(funding.gasCostPol)} POL</td></tr>`
      : `<tr><td>POL para trade (--amount)</td><td class="num">${esc(funding.polNeededForTrade)} POL</td></tr>
         <tr><td>Custo de gas estimado</td><td class="num">${esc(funding.gasCostPol)} POL</td></tr>
         <tr><td>Total necessário</td><td class="num">${esc(funding.totalPolNeeded)} POL</td></tr>`;

    const depositAlert = funding.mode === "all-buy" && polForBuy <= 0
      ? `<div class="alert alert-warn">⚠ SALDO INSUFICIENTE: A carteira ativa não tem POL suficiente para gas. Use --address para especificar outra carteira.</div>`
      : funding.mode === "all-sell" && Number(funding.casBalance) <= 0
      ? `<div class="alert alert-warn">⚠ SEM CAS: A carteira ativa não tem saldo CAS para vender.</div>`
      : funding.needsDeposit && (funding.mode === "scan" || funding.mode === "execute")
      ? `<div class="alert alert-warn">⚠ DEPÓSITO NECESSÁRIO: Falta ${esc(funding.polShortfall)} POL na carteira ativa</div>`
      : '<div class="alert alert-ok">✓ Saldo suficiente para execução</div>';

    fundingSection = `
    <div class="card">
      <h2>Análise de Saldos — ${esc(modeText)}</h2>
      <table class="info-table">
        <thead>
          <tr><th>Carteira</th><th>Endereço</th><th>POL</th><th>CAS</th></tr>
        </thead>
        <tbody>
          ${walletRows}
        </tbody>
      </table>
      <h3 style="margin-top:16px;font-size:14px;color:var(--color-link)">Contexto da operação</h3>
      <table class="info-table">
        ${contextRows}
      </table>
      ${depositAlert}
    </div>`;
  }

  let routeAnalysisSection = "";
  if (routeAnalysis) {
    const ra = routeAnalysis;
    const profitColor = ra.isProfitable ? "#F05F40" : "#eb3812";
    const profitIcon = ra.isProfitable ? "✓" : "✗";
    const profitLabel = ra.isProfitable ? "PROFITABLE" : "NÃO PROFITABLE";

    const hopRows = ra.hops.map((h, i) => {
      const impactColor = Math.abs(h.priceImpactPct) > 2 ? "#eb3812" : Math.abs(h.priceImpactPct) > 0.5 ? "#fcc650" : "var(--color-text-main)";
      return `<tr>
        <td class="num">${i + 1}</td>
        <td>${esc(h.dex)}</td>
        <td>${esc(h.tokenIn)}</td>
        <td>${esc(h.tokenOut)}</td>
        <td class="num">${esc(h.amountIn)}</td>
        <td class="num">${esc(h.expectedAmountOut)}</td>
        <td class="num" style="color:${impactColor}">${h.priceImpactPct.toFixed(3)}%</td>
      </tr>`;
    }).join("\n");

    routeAnalysisSection = `
    <div class="card">
      <h2>Análise de Rota: ${esc(ra.buyDex.name)} → ${esc(ra.sellDex.name)}</h2>
      <div style="margin-bottom:12px">
        <span class="status-badge ${ra.isProfitable ? 'status-ok' : 'status-warn'}">${profitIcon} ${profitLabel}</span>
        <span style="color:var(--color-text-muted); margin-left:12px; font-size:13px;">
          Tipo: ${esc(ra.routeType)}
        </span>
      </div>
      <table class="info-table">
        <tr><td>POL investido</td><td class="num">${esc(ra.amountIn)} POL</td></tr>
        <tr><td>CAS comprado (na ${esc(ra.buyDex.name)})</td><td class="num">${esc(ra.casBought)} CAS</td></tr>
        <tr><td>CAS vendido (na ${esc(ra.sellDex.name)})</td><td class="num">${esc(ra.casSold)} CAS</td></tr>
        <tr><td>POL recebido</td><td class="num">${esc(ra.polReceived)} POL</td></tr>
        <tr><td>Lucro bruto</td><td class="num" style="color:${profitColor}">${esc(ra.profit)} POL (${ra.profitPct.toFixed(3)}%)</td></tr>
        <tr><td>Gas estimado</td><td class="num">${esc(ra.gasEstimate)} POL</td></tr>
        <tr><td>Lucro líquido (após gas)</td><td class="num" style="color:${profitColor}">${esc(ra.netProfit)} POL</td></tr>
        ${ra.conversionDex ? `<tr><td>DEX de conversão intermediária</td><td>${esc(ra.conversionDex)}</td></tr>` : ""}
      </table>
      <h3 style="margin-top:16px;font-size:14px;color:var(--color-link)">Hops da rota</h3>
      <table class="ops-table">
        <thead>
          <tr><th>#</th><th>DEX</th><th>Token In</th><th>Token Out</th><th>Amount In</th><th>Amount Out</th><th>Price Impact</th></tr>
        </thead>
        <tbody>
          ${hopRows}
        </tbody>
      </table>
      <div style="margin-top:12px;font-size:12px;color:var(--color-text-muted)">
        Preço de compra: ${ra.buyDex.pricePerCas.toFixed(6)} POL/CAS ·
        Preço de venda: ${ra.sellDex.pricePerCas.toFixed(6)} POL/CAS ·
        Spread: ${((ra.sellDex.pricePerCas - ra.buyDex.pricePerCas) / ra.buyDex.pricePerCas * 100).toFixed(2)}%
      </div>
    </div>`;
  }

  let llmAnalysisSection = "";
  if (llmAnalysis) {
    const recItems = llmAnalysis.recommendations?.map(r => `<li>${esc(r)}</li>`).join("") ?? "";
    llmAnalysisSection = `
    <div class="card">
      <h2>Análise IA <span style="font-size:12px;color:var(--color-text-muted);font-weight:normal">(${esc(llmAnalysis.modelUsed)})</span></h2>
      <div style="margin-bottom:12px">
        <strong style="color:var(--color-link)">Resumo</strong>
        <p style="margin:6px 0;line-height:1.6">${esc(llmAnalysis.summary)}</p>
      </div>
      ${recItems ? `<div style="margin-bottom:12px">
        <strong style="color:var(--color-link)">Recomendações</strong>
        <ul style="margin:6px 0 6px 20px;line-height:1.6">
          ${recItems}
        </ul>
      </div>` : ""}
      <div>
        <strong style="color:var(--color-link)">Avaliação de Risco</strong>
        <p style="margin:6px 0;line-height:1.6">${esc(llmAnalysis.riskAssessment)}</p>
      </div>
    </div>`;
  }

  let execSection = "";
  if (execResult) {
    const successClass = execResult.success ? "alert-ok" : "alert-error";
    const successIcon = execResult.success ? "✓" : "✗";
    execSection = `
    <div class="card">
      <h2>Resultado da Execução</h2>
      <div class="alert ${successClass}">${successIcon} ${execResult.success ? "Operação concluída" : "Operação falhou"}</div>
      ${execResult.error ? (() => { const ed = sanitizeDetail(execResult.error); return `<div class="alert alert-error"><strong>Erro:</strong> ${esc(ed.short)}${ed.full.length > 120 ? `<details style="margin-top:8px"><summary style="cursor:pointer;font-size:11px;color:var(--color-text-muted)">Detalhes técnicos</summary><pre style="margin-top:6px;font-size:10px;white-space:pre-wrap;word-break:break-all;color:var(--color-text-muted)">${esc(ed.full)}</pre></details>` : ""}</div>`; })() : ""}
      <table class="info-table">
        <tr><td>Compra em</td><td>${esc(execResult.buyDex)}</td></tr>
        <tr><td>Venda em</td><td>${esc(execResult.sellDex)}</td></tr>
        <tr><td>POL investido</td><td class="num">${esc(execResult.polIn)} POL</td></tr>
        <tr><td>CAS comprado</td><td class="num">${esc(execResult.casBought)} CAS</td></tr>
        <tr><td>CAS vendido</td><td class="num">${esc(execResult.casSold)} CAS</td></tr>
        <tr><td>POL recebido</td><td class="num">${esc(execResult.polOut)} POL</td></tr>
        <tr><td>Resultado líquido</td><td class="num">${esc(execResult.netResult)} POL</td></tr>
      </table>
      ${execResult.buyTxHash ? `<p class="tx-link">Buy TX: <a href="${polyscanTx(execResult.buyTxHash)}" target="_blank">${esc(execResult.buyTxHash)}</a></p>` : ""}
      ${execResult.approveTxHash ? `<p class="tx-link">Approve TX: <a href="${polyscanTx(execResult.approveTxHash)}" target="_blank">${esc(execResult.approveTxHash)}</a></p>` : ""}
      ${execResult.sellTxHash ? `<p class="tx-link">Sell TX: <a href="${polyscanTx(execResult.sellTxHash)}" target="_blank">${esc(execResult.sellTxHash)}</a></p>` : ""}
    </div>`;
  }

  const executeHint = !isBalanced && mode === "scan"
    ? `<div class="alert alert-info">
      Para executar:<br>
      <code>npx tsx scripts/casswap/21_balance_dex_prices.ts --execute --amount ${esc(amount)}</code><br>
      <code>npx tsx scripts/casswap/21_balance_dex_prices.ts --allbuy ${esc(cheapest?.name?.toLowerCase() || "apeswap")}</code><br>
      <code>npx tsx scripts/casswap/21_balance_dex_prices.ts --allsell ${esc(expensive?.name?.toLowerCase() || "dfyn")}</code><br>
      <code>npx tsx scripts/casswap/21_balance_dex_prices.ts --allbuy ${esc(cheapest?.name?.toLowerCase() || "apeswap")} --allsell ${esc(expensive?.name?.toLowerCase() || "dfyn")}</code><br>
      <br>Rotas nomeadas (via MultiRouteSwapFacet):<br>
      <code>npx tsx scripts/casswap/21_balance_dex_prices.ts --list-routes</code><br>
      <code>npx tsx scripts/casswap/21_balance_dex_prices.ts --route dfyn_to_apeswap</code><br>
      <br>Análise de rota entre DEXs:<br>
      <code>npx tsx scripts/casswap/21_balance_dex_prices.ts --analysis --buy ${esc(cheapest?.name?.toLowerCase() || "sushiswap")} --sell ${esc(expensive?.name?.toLowerCase() || "dfyn")} --amount 1.0</code>
    </div>`
    : "";

  const reserveDiffSection = postOpQuotes && postOpQuotes.length > 0
    ? (() => {
        const beforeMap = new Map(validQuotes.map(q => [q.name, q]));
        const rows = postOpQuotes.map(post => {
          const pre = beforeMap.get(post.name);
          const preCas = pre ? ethers.formatEther(pre.casReserve) : "—";
          const postCas = ethers.formatEther(post.casReserve);
          const prePaired = pre ? ethers.formatEther(pre.pairedReserve) : "—";
          const postPaired = ethers.formatEther(post.pairedReserve);
          const prePrice = pre ? pre.pricePerCas.toFixed(6) : "—";
          const postPrice = post.pricePerCas.toFixed(6);
          const casDiff = pre ? (Number(postCas) - Number(preCas)).toFixed(6) : "—";
          const priceDiff = pre ? ((post.pricePerCas - pre.pricePerCas) / pre.pricePerCas * 100).toFixed(2) : "—";
          const casDiffColor = casDiff !== "—" && Number(casDiff) < 0 ? "#eb3812" : casDiff !== "—" && Number(casDiff) > 0 ? "#fcc650" : "";
          const priceDiffColor = priceDiff !== "—" && Number(priceDiff) < 0 ? "#eb3812" : priceDiff !== "—" && Number(priceDiff) > 0 ? "#fcc650" : "";
          return `<tr>
            <td>${esc(post.name)}</td>
            <td class="num">${preCas}</td>
            <td class="num">${postCas}</td>
            <td class="num" style="color:${casDiffColor}">${casDiff}</td>
            <td class="num">${prePaired}</td>
            <td class="num">${postPaired}</td>
            <td class="num">${prePrice}</td>
            <td class="num">${postPrice}</td>
            <td class="num" style="color:${priceDiffColor}">${priceDiff}%</td>
          </tr>`;
        }).join("\n");
        return `<div class="card">
      <h2>Reservas DEX — Antes vs Depois</h2>
      <table class="ops-table">
        <thead>
          <tr><th rowspan="2">DEX</th><th colspan="3">Reserva CAS</th><th colspan="2">Reserva Paired</th><th colspan="3">Preço POL/CAS</th></tr>
          <tr><th>Antes</th><th>Depois</th><th>Δ</th><th>Antes</th><th>Depois</th><th>Antes</th><th>Depois</th><th>Δ%</th></tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>`;
      })()
    : "";

  const opsSection = ops.length > 0
    ? `<div class="card">
      <h2>Log de Operações</h2>
      <table class="ops-table">
        <thead>
          <tr><th>Timestamp</th><th>Etapa</th><th>DEX</th><th>Ação</th><th>Quantidade</th><th>Detalhe</th><th>TX</th></tr>
        </thead>
        <tbody>
          ${ops.map((o, i) => {
            const det = sanitizeDetail(o.detail);
            const actionTag = o.action === "buy"
              ? "type-buy"
              : o.action === "sell"
              ? "type-sell"
              : o.action === "approve"
              ? "type-approve"
              : o.action === "plan"
              ? "type-plan"
              : "type-v2";
            const rowClass = det.isError ? "ops-row-error" : "";
            const needsExpand = det.full.length > 120;
            const detailCell = needsExpand
              ? `<div class="ops-detail-short">${esc(det.short)} <button class="ops-expand-btn" onclick="const el=document.getElementById('ops-full-${i}');el.style.display=el.style.display==='none'?'block':'none';this.textContent=el.style.display==='none'?'Ver mais':'Ver menos'">Ver mais</button></div><div id="ops-full-${i}" class="ops-detail-full" style="display:none">${esc(det.full)}</div>`
              : det.isError
              ? `<span class="ops-detail-error">${esc(det.short)}</span>`
              : esc(det.short);
            return `<tr class="${rowClass}">
              <td class="num" style="font-size:11px">${esc(o.timestamp)}</td>
              <td>${esc(o.step)}</td>
              <td>${esc(o.dex)}</td>
              <td><span class="type-tag ${actionTag}">${esc(o.action)}</span></td>
              <td class="num">${esc(o.amount)}</td>
              <td class="ops-detail">${detailCell}</td>
              <td>${o.txHash ? `<a href="${polyscanTx(o.txHash)}" target="_blank" class="addr-link">${esc(o.txHash.slice(0, 10))}...</a>` : "—"}</td>
            </tr>`;
          }).join("\n")}
        </tbody>
      </table>
    </div>`
    : "";

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Equilíbrio de Preços DEX — CAS/POL</title>
<style>
  :root {
    --color-primary: #F05F40;
    --color-primary-hover: #eb3812;
    --color-dark: #222222;
    --color-light: #ffffff;
    --color-accent-gold: #fcc650;
    --color-accent-bronze: #cc7501;
    --color-accent-wine: #712d23;
    --color-accent-coral: #ce6e6d;
    --color-accent-peach: #f7d4ca;
    --color-accent-deep-black: #070404;
    --color-bg-main: var(--color-dark);
    --color-bg-card: var(--color-accent-wine);
    --color-text-main: var(--color-light);
    --color-text-muted: var(--color-accent-peach);
    --color-border: rgba(255,255,255,0.15);
    --color-link: var(--color-accent-gold);
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: var(--color-bg-main);
    color: var(--color-text-main);
    font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
    padding: 24px;
    min-height: 100vh;
  }
  .header {
    text-align: center;
    padding: 32px 0 24px;
    border-bottom: 2px solid var(--color-primary);
    margin-bottom: 24px;
  }
  .header h1 {
    color: var(--color-primary);
    font-size: 28px;
    margin-bottom: 8px;
  }
  .header .subtitle {
    color: var(--color-text-muted);
    font-size: 14px;
  }
  .header .timestamp {
    color: var(--color-accent-gold);
    font-size: 12px;
    margin-top: 4px;
  }
  .container { max-width: 1100px; margin: 0 auto; }
  .card {
    background: var(--color-bg-card);
    border: 1px solid var(--color-border);
    border-radius: 12px;
    padding: 24px;
    margin-bottom: 20px;
  }
  .card h2 {
    color: var(--color-primary);
    font-size: 18px;
    margin-bottom: 16px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--color-border);
  }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 10px 12px; text-align: left; font-size: 13px; }
  th {
    color: var(--color-accent-gold);
    font-weight: 600;
    border-bottom: 2px solid var(--color-border);
    text-transform: uppercase;
    font-size: 11px;
    letter-spacing: 0.5px;
  }
  td { border-bottom: 1px solid var(--color-border); }
  td.num { text-align: right; font-family: 'Cascadia Code', 'Fira Code', monospace; }
  td.price { color: var(--color-accent-gold); font-weight: 600; }
  td.no-liq { color: var(--color-accent-coral); font-style: italic; }
  td.mono { font-family: monospace; font-size: 12px; color: var(--color-text-muted); }
  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 700;
    margin-left: 6px;
  }
  .badge-cheap { background: rgba(240,95,64,0.2); color: var(--color-primary); }
  .badge-expensive { background: rgba(235,56,18,0.2); color: var(--color-primary-hover); }
  .type-tag {
    display: inline-block;
    padding: 2px 6px;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 600;
  }
  .type-v2 { background: rgba(204,117,1,0.25); color: var(--color-accent-bronze); }
  .type-v3 { background: rgba(252,198,80,0.2); color: var(--color-accent-gold); }
  .type-algebra { background: rgba(206,110,109,0.25); color: var(--color-accent-coral); }
  .type-buy { background: rgba(240,95,64,0.2); color: var(--color-primary); }
  .type-sell { background: rgba(206,110,109,0.25); color: var(--color-accent-coral); }
  .type-approve { background: rgba(252,198,80,0.15); color: var(--color-accent-gold); }
  .type-plan { background: rgba(113,45,35,0.4); color: var(--color-text-muted); }
  .ops-table { table-layout: fixed; }
  .ops-table th:nth-child(6), .ops-table td:nth-child(6) { width: 35%; }
  .ops-table th:nth-child(1), .ops-table td:nth-child(1) { width: 12%; }
  .ops-row-error { background: rgba(235,56,18,0.06); }
  .ops-row-error:hover { background: rgba(235,56,18,0.12); }
  .ops-detail { word-break: break-word; font-size: 12px; line-height: 1.5; }
  .ops-detail-error { color: var(--color-accent-coral); font-weight: 500; }
  .ops-detail-short { display: flex; align-items: flex-start; gap: 6px; }
  .ops-detail-full {
    margin-top: 8px;
    padding: 8px 10px;
    background: rgba(7,4,4,0.4);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    font-family: 'Cascadia Code', 'Fira Code', monospace;
    font-size: 10px;
    color: var(--color-text-muted);
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 200px;
    overflow-y: auto;
  }
  .ops-expand-btn {
    background: none;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    color: var(--color-link);
    cursor: pointer;
    font-size: 10px;
    padding: 1px 6px;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .ops-expand-btn:hover { background: rgba(252,198,80,0.1); }
  .status-badge {
    display: inline-block;
    padding: 6px 16px;
    border-radius: 6px;
    font-weight: 700;
    font-size: 14px;
  }
  .status-ok { background: rgba(240,95,64,0.2); color: var(--color-primary); }
  .status-warn { background: rgba(235,56,18,0.2); color: var(--color-primary-hover); }
  .alert {
    padding: 12px 16px;
    border-radius: 8px;
    margin: 12px 0;
    font-size: 13px;
  }
  .alert-ok { background: rgba(240,95,64,0.12); color: var(--color-primary); border: 1px solid rgba(240,95,64,0.3); }
  .alert-warn { background: rgba(235,56,18,0.12); color: var(--color-primary-hover); border: 1px solid rgba(235,56,18,0.3); }
  .alert-error { background: rgba(206,110,109,0.15); color: var(--color-accent-coral); border: 1px solid rgba(206,110,109,0.3); }
  .alert-info { background: rgba(252,198,80,0.1); color: var(--color-accent-gold); border: 1px solid rgba(252,198,80,0.25); }
  .info-table td:first-child { color: var(--color-text-muted); width: 40%; }
  .info-table td:last-child { color: var(--color-text-main); }
  .summary-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 16px;
    margin-bottom: 16px;
  }
  .summary-item {
    background: rgba(7,4,4,0.3);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    padding: 16px;
    text-align: center;
  }
  .summary-item .label { color: var(--color-text-muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
  .summary-item .value { color: var(--color-accent-gold); font-size: 20px; font-weight: 700; margin-top: 4px; font-family: monospace; }
  .summary-item .value.primary { color: var(--color-primary); }
  .tx-link { font-size: 12px; color: var(--color-text-muted); margin: 6px 0; }
  .tx-link a { color: var(--color-link); text-decoration: none; }
  .tx-link a:hover { text-decoration: underline; }
  code { background: rgba(7,4,4,0.5); padding: 2px 6px; border-radius: 4px; font-size: 12px; color: var(--color-accent-gold); }
  .addr-link { color: var(--color-link); text-decoration: none; font-size: 12px; }
  .addr-link:hover { text-decoration: underline; }
  .router-addr { font-size: 11px; color: var(--color-text-muted); }
  .router-addr a { color: var(--color-accent-bronze); }
  .footer { text-align: center; color: var(--color-text-muted); font-size: 11px; padding: 20px 0; border-top: 1px solid var(--color-border); margin-top: 24px; }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>Equilíbrio de Preços DEX — CAS/POL</h1>
    <div class="subtitle">Análise de convergência de preços across DEXs na Polygon</div>
    <div class="timestamp">Gerado em ${now} | Modo: ${mode.toUpperCase()} | Amount: ${esc(amount)} POL</div>
  </div>

  ${validQuotes.length === 0 ? `
  <div class="card">
    <h2>Resultado</h2>
    <div class="alert alert-warn">⚠ Nenhuma DEX com liquidez encontrada para o par CAS/POL.</div>
    <p style="color:var(--color-text-muted); margin-top:12px;">Verifique:</p>
    <ul style="color:var(--color-text-muted); margin-left:24px; margin-top:8px;">
      <li>LP token addresses no .env (QUICKSWAP_LP_TOKEN_ADDRESS, etc.)</li>
      <li>UNISWAP_V3_FACTORY / QUICKSWAP_V3_ROUTER para V3</li>
      <li>Conexão RPC (POLYGON_RPC_URL)</li>
    </ul>
  </div>
  ` : `
  <div class="card">
    <h2>Tabela de Preços por DEX</h2>
    <p style="color:var(--color-text-muted); font-size:12px; margin-bottom:12px;">
      Ordenado do mais barato (mais CAS por POL) ao mais caro. Token: ${addrLink(casToken)}
    </p>
    <table>
      <thead>
        <tr>
          <th>DEX / Router</th>
          <th>Tipo</th>
          <th>Token Par</th>
          <th>LP Token</th>
          <th style="text-align:right">Reserva CAS</th>
          <th style="text-align:right">Reserva Par</th>
          <th style="text-align:right">POL/CAS</th>
          <th style="text-align:right">Desvio</th>
        </tr>
      </thead>
      <tbody>
        ${dexRows}
        ${noLiquidityRows}
      </tbody>
    </table>
  </div>

  <div class="card">
    <h2>Análise de Convergência</h2>
    <div class="summary-grid">
      <div class="summary-item">
        <div class="label">DEX mais barata</div>
        <div class="value primary">${esc(cheapest.name)}</div>
        <div style="font-size:12px;color:var(--color-text-muted)">${cheapest.pricePerCas.toFixed(6)} POL/CAS</div>
      </div>
      <div class="summary-item">
        <div class="label">DEX mais cara</div>
        <div class="value primary">${esc(expensive.name)}</div>
        <div style="font-size:12px;color:var(--color-text-muted)">${expensive.pricePerCas.toFixed(6)} POL/CAS</div>
      </div>
      <div class="summary-item">
        <div class="label">Preço médio</div>
        <div class="value">${avgPrice.toFixed(6)}</div>
        <div style="font-size:12px;color:var(--color-text-muted)">POL/CAS</div>
      </div>
      <div class="summary-item">
        <div class="label">Spread</div>
        <div class="value primary">${spreadPct.toFixed(2)}%</div>
        <div style="font-size:12px;color:var(--color-text-muted)">${spreadBps} bps</div>
      </div>
    </div>
    <div style="text-align:center; margin: 16px 0;">
      ${statusBadge}
      <span style="color:var(--color-text-muted); margin-left:12px; font-size:13px;">
        Limite: ${minSpread} bps
      </span>
    </div>
    ${executeHint}
  </div>

  ${fundingSection}
  ${routeAnalysisSection}
  ${llmAnalysisSection}
  ${execSection}
  ${reserveDiffSection}
  ${opsSection}
  `}

  <div class="footer">
    Rapport Tecnologia — AgenticSpace | Script: 21_balance_dex_prices.ts | ${now}
  </div>
</div>
</body>
</html>`;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const provider = getProvider();
  const casToken = requireEnv(["CAS_TOKEN_ADDRESS"])["CAS_TOKEN_ADDRESS"];

  const hasAllMode = !!args.allBuy || !!args.allSell || !!args.route || args.listRoutes || args.analysis;
  const mode = args.listRoutes
    ? "list-routes"
    : args.route
    ? "route"
    : args.analysis
    ? "analysis"
    : hasAllMode
    ? args.allBuy && args.allSell ? "all-balance" : args.allBuy ? "all-buy" : "all-sell"
    : args.execute ? "execute" : "scan";

  log("INFO", "Starting DEX price balance analysis", {
    mode,
    amount: args.amount,
    allBuy: args.allBuy,
    allSell: args.allSell,
    casToken,
  });

  const amountIn = ethers.parseEther(args.amount);
  const quotes = await scanDexPrices(provider, casToken, amountIn);
  const validQuotes = quotes.filter((q) => q.hasLiquidity);

  let sorted: DexQuote[] = [];
  let avgPrice = 0;
  let cheapest: DexQuote | null = null;
  let expensive: DexQuote | null = null;
  let spreadPct = 0;
  let spreadBps = 0;
  let isBalanced = false;

  if (validQuotes.length > 0) {
    sorted = [...validQuotes].sort((a, b) => a.pricePerCas - b.pricePerCas);
    avgPrice = validQuotes.reduce((s, q) => s + q.pricePerCas, 0) / validQuotes.length;
    cheapest = sorted[0];
    expensive = sorted[sorted.length - 1];
    spreadPct = cheapest.pricePerCas > 0
      ? ((expensive.pricePerCas - cheapest.pricePerCas) / cheapest.pricePerCas) * 100
      : 0;
    spreadBps = Math.floor(spreadPct * 100);
    isBalanced = spreadBps < args.minSpread;
  }

  let funding: FundingInfo | null = null;
  let execResult: ExecutionResult | null = null;
  const ops: OperationLog[] = [];

  // Resolve signer: use --address if provided, otherwise default env key
  const { wallet: signerWallet, address: signerAddr } = await getSignerForAddress(args.address ?? undefined);
  log("INFO", "Signer resolved", { address: signerAddr, custom: !!args.address });

  if (signerAddr && validQuotes.length > 0) {
    const polBalance = await provider.getBalance(signerAddr);
    const casContract = new ethers.Contract(casToken, ERC20_ABI, provider);
    const casBalance = await casContract.balanceOf(signerAddr);

    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice ?? 30_000_000_000n;
    const maxFeePerGas = feeData.maxFeePerGas ?? gasPrice;
    const totalGas = (DEFAULT_SWAP_GAS_LIMIT + DEFAULT_SWAP_GAS_LIMIT + 100_000n) * maxFeePerGas;
    const totalPolNeeded = amountIn + totalGas;
    const polShortfall = totalPolNeeded > polBalance ? totalPolNeeded - polBalance : 0n;
    const polAvailableForBuy = polBalance > totalGas ? polBalance - totalGas : 0n;

    // Collect all relevant wallet balances
    const wallets: WalletBalance[] = [];
    wallets.push({
      label: "Signer (ativo)",
      address: signerAddr,
      polBalance: ethers.formatEther(polBalance),
      casBalance: ethers.formatEther(casBalance),
      isSigner: true,
    });

    // Relayer / Diamond owner
    const relayerPk = process.env.RELAYER_PRIVATE_KEY ?? "";
    if (relayerPk) {
      const relayerAddr = ethers.computeAddress(relayerPk.startsWith("0x") ? relayerPk : `0x${relayerPk}`);
      if (relayerAddr.toLowerCase() !== signerAddr.toLowerCase()) {
        try {
          const relayerPol = await provider.getBalance(relayerAddr);
          const relayerCas = await casContract.balanceOf(relayerAddr);
          wallets.push({
            label: "Relayer / Diamond Owner",
            address: relayerAddr,
            polBalance: ethers.formatEther(relayerPol),
            casBalance: ethers.formatEther(relayerCas),
            isSigner: false,
          });
        } catch { /* skip if RPC fails */ }
      }
    }

    // Diamond proxy
    const diamondAddr = process.env.DIAMOND_ADDRESS;
    if (diamondAddr) {
      try {
        const diamondPol = await provider.getBalance(diamondAddr);
        const diamondCas = await casContract.balanceOf(diamondAddr);
        wallets.push({
          label: "Diamond Proxy",
          address: diamondAddr,
          polBalance: ethers.formatEther(diamondPol),
          casBalance: ethers.formatEther(diamondCas),
          isSigner: false,
        });
      } catch { /* skip if RPC fails */ }
    }

    log("INFO", "Wallet balances", {
      signer: { pol: ethers.formatEther(polBalance), cas: ethers.formatEther(casBalance) },
      polAvailableForBuy: ethers.formatEther(polAvailableForBuy),
      walletCount: wallets.length,
    });

    funding = {
      signerAddress: signerAddr,
      polBalance: ethers.formatEther(polBalance),
      casBalance: ethers.formatEther(casBalance),
      polNeededForTrade: ethers.formatEther(amountIn),
      gasCostPol: ethers.formatEther(totalGas),
      totalPolNeeded: ethers.formatEther(totalPolNeeded),
      polShortfall: ethers.formatEther(polShortfall),
      needsDeposit: polShortfall > 0n,
      polAvailableForBuy: ethers.formatEther(polAvailableForBuy),
      mode,
      wallets,
    };

    if (args.execute && polShortfall === 0n && !isBalanced && cheapest && expensive) {
      log("INFO", "Executing balance trade", { buyDex: cheapest.name, sellDex: expensive.name });
      execResult = await executeBalance(signerWallet, casToken, cheapest, expensive, amountIn);
    }

    if (hasAllMode) {
      const signer = signerWallet;

      if (args.allBuy && args.allSell) {
        const buyDex = findDexByName(validQuotes, args.allBuy);
        const sellDex = findDexByName(validQuotes, args.allSell);

        if (!buyDex) {
          log("ERROR", "DEX not found for --allbuy", { name: args.allBuy });
          ops.push({ step: "error", dex: args.allBuy, action: "lookup", txHash: null, amount: "0", detail: `DEX "${args.allBuy}" não encontrada`, timestamp: nowTs() });
        } else if (!sellDex) {
          log("ERROR", "DEX not found for --allsell", { name: args.allSell });
          ops.push({ step: "error", dex: args.allSell, action: "lookup", txHash: null, amount: "0", detail: `DEX "${args.allSell}" não encontrada`, timestamp: nowTs() });
        } else {
          log("INFO", "Combined all-balance mode", { buyDex: buyDex.name, sellDex: sellDex.name });
          if (process.env.DIAMOND_ADDRESS) {
            await executeAllBalanceViaFacet(signer, casToken, sellDex, buyDex, ops);
          } else {
            log("WARN", "DIAMOND_ADDRESS not set, using non-atomic execution");
            await executeAllBalance(signer, casToken, sellDex, buyDex, ops);
          }
        }
      } else if (args.allBuy) {
        const dex = findDexByName(validQuotes, args.allBuy);
        if (!dex) {
          log("ERROR", "DEX not found for --allbuy", { name: args.allBuy });
          ops.push({ step: "error", dex: args.allBuy, action: "lookup", txHash: null, amount: "0", detail: `DEX "${args.allBuy}" não encontrada`, timestamp: nowTs() });
        } else {
          const polBalance = await provider.getBalance(signerAddr);
          const feeData = await provider.getFeeData();
          const gasPrice = feeData.gasPrice ?? 30_000_000_000n;
          const maxFeePerGas = feeData.maxFeePerGas ?? gasPrice;
          const buyGas = DEFAULT_SWAP_GAS_LIMIT * maxFeePerGas;
          const polForBuy = polBalance > buyGas ? polBalance - buyGas : 0n;

          if (polForBuy === 0n) {
            const requiredMsg = `Saldo insuficiente. Saldo atual: ${ethers.formatEther(polBalance)} POL. Gas estimado: ${ethers.formatEther(buyGas)} POL (limite: ${DEFAULT_SWAP_GAS_LIMIT}). Necessário pelo menos ${ethers.formatEther(buyGas)} POL para gas da transação de compra.`;
            log("ERROR", "Insufficient POL for all-buy", {
              polBalance: ethers.formatEther(polBalance),
              gasEstimate: ethers.formatEther(buyGas),
              requiredMinBalance: ethers.formatEther(buyGas),
            });
            ops.push({ step: "allbuy", dex: dex.name, action: "buy", txHash: null, amount: "0", detail: requiredMsg, timestamp: nowTs() });
          } else {
            await executeAllBuy(signer, casToken, dex, polForBuy, ops);
          }
        }
      } else if (args.allSell) {
        const dex = findDexByName(validQuotes, args.allSell);
        if (!dex) {
          log("ERROR", "DEX not found for --allsell", { name: args.allSell });
          ops.push({ step: "error", dex: args.allSell, action: "lookup", txHash: null, amount: "0", detail: `DEX "${args.allSell}" não encontrada`, timestamp: nowTs() });
        } else {
          const casBalance = await casContract.balanceOf(signerAddr);
          if (casBalance === 0n) {
            log("WARN", "No CAS balance for all-sell");
            ops.push({ step: "allsell", dex: dex.name, action: "sell", txHash: null, amount: "0", detail: "Sem saldo CAS", timestamp: nowTs() });
          } else {
            await executeAllSell(signer, casToken, dex, casBalance, ops);
          }
        }
      } else if (args.route) {
        // Execute a named preset route via MultiRouteSwapFacet
        const diamondAddress = process.env.DIAMOND_ADDRESS;
        if (!diamondAddress) {
          log("ERROR", "DIAMOND_ADDRESS not set, cannot use --route");
          ops.push({ step: "error", dex: "Diamond", action: "route", txHash: null, amount: "0", detail: "DIAMOND_ADDRESS não configurado", timestamp: nowTs() });
        } else {
          const signer = signerWallet;
          const facet = new ethers.Contract(diamondAddress, MULTI_ROUTE_FACET_ABI, signer);
          try {
            // Check route exists
            const routes = await facet.listRoutes();
            if (!routes.includes(args.route)) {
              log("ERROR", "Route not found", { name: args.route, available: routes });
              ops.push({ step: "error", dex: "Diamond", action: "route", txHash: null, amount: "0", detail: `Rota "${args.route}" não encontrada. Disponíveis: ${routes.join(", ")}`, timestamp: nowTs() });
            } else {
              log("INFO", "Executing preset route via facet", { route: args.route });

              // Check CAS balance for routes that start with selling CAS
              const casBalance = await casContract.balanceOf(signerAddr);
              if (casBalance > 0n) {
                const currentAllowance = await casContract.allowance(signerAddr, diamondAddress);
                if (currentAllowance < casBalance) {
                  log("INFO", "Approving CAS for Diamond", { diamond: diamondAddress });
                  const approveTx = await casContract.connect(signer).approve(diamondAddress, casBalance);
                  await approveTx.wait();
                  ops.push({ step: "route-approve", dex: "Diamond", action: "approve", txHash: approveTx.hash, amount: ethers.formatEther(casBalance), detail: `Aprovou CAS para o Diamond proxy`, timestamp: nowTs() });
                }
              }

              const tx = await facet.executeRoute(args.route, 0n);
              log("INFO", "Route execution tx sent", { route: args.route, txHash: tx.hash });
              const receipt = await tx.wait();
              log("INFO", "Route execution confirmed", { route: args.route, txHash: tx.hash });

              const finalCasBalance = await casContract.balanceOf(signerAddr);
              ops.push({ step: "route-execute", dex: "Diamond", action: "route", txHash: tx.hash, amount: ethers.formatEther(casBalance), detail: `Rota "${args.route}" executada via MultiRouteSwapFacet. CAS final: ${ethers.formatEther(finalCasBalance)}`, timestamp: nowTs() });
            }
          } catch (err) {
            const msg = (err as Error).message;
            log("ERROR", "Route execution failed", { route: args.route, error: msg });
            ops.push({ step: "route-execute", dex: "Diamond", action: "route", txHash: null, amount: "0", detail: `Falha na rota "${args.route}": ${msg}`, timestamp: nowTs() });
          }
        }
      } else if (args.listRoutes) {
        const diamondAddress = process.env.DIAMOND_ADDRESS;
        if (!diamondAddress) {
          log("ERROR", "DIAMOND_ADDRESS not set, cannot list routes");
          ops.push({ step: "error", dex: "Diamond", action: "list-routes", txHash: null, amount: "0", detail: "DIAMOND_ADDRESS não configurado", timestamp: nowTs() });
        } else {
          const facet = new ethers.Contract(diamondAddress, MULTI_ROUTE_FACET_ABI, provider);
          try {
            const routes = await facet.listRoutes();
            log("INFO", "Available routes", { count: routes.length, routes });
            ops.push({ step: "list-routes", dex: "Diamond", action: "list-routes", txHash: null, amount: "0", detail: `Rotas disponíveis: ${routes.length > 0 ? routes.join(", ") : "nenuma"}`, timestamp: nowTs() });
            console.log("\n📋 Rotas disponíveis no MultiRouteSwapFacet:");
            for (const name of routes) {
              console.log(`   - ${name}`);
            }
            console.log("");
          } catch (err) {
            log("ERROR", "Failed to list routes", { error: (err as Error).message });
            ops.push({ step: "list-routes", dex: "Diamond", action: "list-routes", txHash: null, amount: "0", detail: `Erro ao listar rotas: ${(err as Error).message}`, timestamp: nowTs() });
          }
        }
      }
    }
  }

  // Route analysis mode: --analysis --buy <dex> --sell <dex>
  let routeAnalysis: RouteAnalysis | null = null;
  if (args.analysis && args.buy && args.sell) {
    const buyDex = findDexByName(validQuotes, args.buy);
    const sellDex = findDexByName(validQuotes, args.sell);
    if (!buyDex) {
      log("ERROR", "Buy DEX not found for --analysis", { name: args.buy });
      ops.push({ step: "analysis", dex: args.buy, action: "lookup", txHash: null, amount: "0", detail: `DEX de compra "${args.buy}" não encontrada`, timestamp: nowTs() });
    } else if (!sellDex) {
      log("ERROR", "Sell DEX not found for --analysis", { name: args.sell });
      ops.push({ step: "analysis", dex: args.sell, action: "lookup", txHash: null, amount: "0", detail: `DEX de venda "${args.sell}" não encontrada`, timestamp: nowTs() });
    } else {
      log("INFO", "Analyzing route", { buy: buyDex.name, sell: sellDex.name, amount: args.amount });
      try {
        routeAnalysis = await analyzeRoute(provider, casToken, buyDex, sellDex, amountIn);
        log("INFO", "Route analysis completed", {
          buyDex: buyDex.name,
          sellDex: sellDex.name,
          casBought: routeAnalysis.casBought,
          polReceived: routeAnalysis.polReceived,
          profit: routeAnalysis.profit,
          profitPct: routeAnalysis.profitPct.toFixed(3) + "%",
          netProfit: routeAnalysis.netProfit,
          isProfitable: routeAnalysis.isProfitable,
          routeType: routeAnalysis.routeType,
        });
        ops.push({
          step: "analysis",
          dex: `${buyDex.name} → ${sellDex.name}`,
          action: "analysis",
          txHash: null,
          amount: args.amount,
          detail: `Rota: ${routeAnalysis.routeType}. CAS: ${routeAnalysis.casBought}. POL recebido: ${routeAnalysis.polReceived}. Lucro líquido: ${routeAnalysis.netProfit} POL (${routeAnalysis.profitPct.toFixed(3)}%). ${routeAnalysis.isProfitable ? "PROFITABLE" : "NÃO PROFITABLE"}`,
          timestamp: nowTs(),
        });
      } catch (err) {
        log("ERROR", "Route analysis failed", { error: (err as Error).message });
        ops.push({ step: "analysis", dex: `${buyDex.name} → ${sellDex.name}`, action: "analysis", txHash: null, amount: "0", detail: `Erro na análise: ${(err as Error).message}`, timestamp: nowTs() });
      }
    }
  } else if (args.analysis && (!args.buy || !args.sell)) {
    log("ERROR", "--analysis requires --buy <dex> and --sell <dex>");
    ops.push({ step: "analysis", dex: "—", action: "analysis", txHash: null, amount: "0", detail: "--analysis requer --buy <dex> e --sell <dex>", timestamp: nowTs() });
  }

  // Post-operation DEX reserve scan (only if operations were executed)
  let postOpQuotes: DexQuote[] | null = null;
  const hadOperations = ops.some(o =>
    o.txHash !== null ||
    ["allbuy", "allsell", "allbalance", "facet-balance", "route-execute"].includes(o.step)
  );
  if (hadOperations && validQuotes.length > 0) {
    log("INFO", "Re-scanning DEX reserves post-operation");
    try {
      postOpQuotes = await scanDexPrices(provider, casToken, amountIn);
      const postValid = postOpQuotes.filter(q => q.hasLiquidity);
      log("INFO", "Post-op scan completed", { dexCount: postValid.length });
      for (const post of postValid) {
        const pre = validQuotes.find(q => q.name === post.name);
        if (pre) {
          const casDelta = post.casReserve - pre.casReserve;
          const priceDelta = pre.pricePerCas > 0
            ? ((post.pricePerCas - pre.pricePerCas) / pre.pricePerCas) * 100
            : 0;
          log("INFO", "Reserve change", {
            dex: post.name,
            casBefore: ethers.formatEther(pre.casReserve),
            casAfter: ethers.formatEther(post.casReserve),
            casDelta: ethers.formatEther(casDelta),
            priceBefore: pre.pricePerCas.toFixed(6),
            priceAfter: post.pricePerCas.toFixed(6),
            priceDeltaPct: priceDelta.toFixed(2) + "%",
          });
        }
      }
    } catch (err) {
      log("WARN", "Post-op re-scan failed", { error: (err as Error).message });
    }
  }

  // Generate LLM textual analysis via Ollama
  const llmAnalysis = await generateLlmAnalysis(
    sorted,
    avgPrice,
    cheapest ?? quotes[0],
    expensive ?? quotes[0],
    spreadPct,
    spreadBps,
    isBalanced,
    args.amount,
    mode,
    funding,
    routeAnalysis,
  );

  const html = generateHtmlReport(
    quotes,
    validQuotes,
    sorted,
    avgPrice,
    cheapest ?? quotes[0],
    expensive ?? quotes[0],
    spreadPct,
    spreadBps,
    isBalanced,
    args.minSpread,
    args.amount,
    mode,
    funding,
    execResult,
    casToken,
    ops,
    postOpQuotes,
    routeAnalysis,
    llmAnalysis,
  );

  const reportsDir = path.join(__dirname, "..", "..", "reports");
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }
  const dateStr = new Date().toISOString().split("T")[0];
  const filename = `dex_balance_${dateStr}.html`;
  const filepath = path.join(reportsDir, filename);
  fs.writeFileSync(filepath, html, "utf-8");

  log("INFO", "HTML report generated", { file: filepath });

  if (validQuotes.length === 0) {
    log("ERROR", "No DEX with liquidity found");
  } else {
    log("INFO", "Balance analysis completed", {
      dexCount: validQuotes.length,
      spreadBps,
      isBalanced,
    });
  }

  console.log(`\n📄 Relatório HTML gerado: ${filepath}`);

  try { closeDB(); } catch { /* DB may not be open */ }

  const url = `file://${filepath}`;
  const cmd = process.platform === "win32" ? `start "" "${url}"` :
              process.platform === "darwin" ? `open "${url}"` :
              `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) {
      log("WARN", "Could not auto-open browser", { error: err.message });
      console.log(`   Abra manualmente: ${url}\n`);
    } else {
      log("INFO", "Browser opened", { url });
      console.log(`   ✓ Aberto no navegador\n`);
    }
  });
}

main().catch((err) => {
  log("ERROR", "Fatal error", { error: err.message });
  console.error(err);
  process.exit(1);
});
