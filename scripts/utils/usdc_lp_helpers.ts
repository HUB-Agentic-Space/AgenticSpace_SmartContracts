import dotenv from "dotenv";
import { ethers } from "hardhat";
import { Wallet, JsonRpcApiProvider, Contract } from "agentic_space_commons";

// Carrega .env.usdc em conjunto com as variaveis do .env.
dotenv.config({ path: ".env.usdc" });

export interface DexRouter {
  name: string;
  address: string;
}

export interface UsdcLpEnv {
  USDC_LP_ADDRESS: string;
  USDC_LP_PRIVATE_KEY: string;
  CAS_TOKEN_ADDRESS: string;
  USDC_TOKEN_ADDRESS: string;
  CASSWAP_ADDRESS: string;
  INFRASTRUCTURE_FUND_ADDRESS: string;
  RAPPORT_ADDRESS: string;
  RAPPORT_PRIVATE_KEY: string;
  DEX_ROUTERS: DexRouter[];
  LOCK_OWNER_ADDRESS: string;
  LOCK_DURATION_DAYS: number;
  SLIPPAGE_BPS: number;
  DEADLINE_MINUTES: number;
  USDC_LIQUIDITY_TOTAL: bigint;
  CAS_USDC_PRICE: number;
  CAS_LIQUIDITY_TOTAL: bigint;
  USDC_PER_DEX: bigint;
  CAS_PER_DEX: bigint;
  POL_USDC_PRICE: number;
  CAS_RATIO: string;
}

export function parseDexRouters(raw: string | undefined): DexRouter[] {
  if (!raw || raw === "") return [];
  return raw.split(";").map((entry) => {
    const [name, address] = entry.split(":");
    if (!name || !address) {
      throw new Error(`Formato invalido em DEX_ROUTERS: ${entry}`);
    }
    return { name: name.trim(), address: address.trim() };
  });
}

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
    console.log(`\n  ERRO: Variaveis de ambiente ausentes:`);
    for (const v of missing) console.log(`    - ${v}`);
    console.log(`\n  Corrija e tente novamente.`);
    process.exit(1);
  }
  return values;
}

export function getUsdcLpEnv(path: string = ".env.usdc"): UsdcLpEnv {
  // .env is the canonical source; the optional .env.usdc overrides USDC-specific values.
  dotenv.config({ path: ".env" });
  dotenv.config({ path, override: true });

  const envOr = (...keys: string[]) => {
    for (const key of keys) {
      const v = process.env[key];
      if (v) return v;
    }
    return undefined;
  };

  const USDC_LP_ADDRESS = envOr("USDC_LP_ADDRESS") || "";
  const USDC_LP_PRIVATE_KEY = envOr("USDC_LP_PRIVATE_KEY") || "";
  const CAS_TOKEN_ADDRESS = envOr("CAS_TOKEN_ADDRESS", "CAS_ADDRESS", "NEXT_PUBLIC_CAS_TOKEN_ADDRESS") || "";
  const USDC_TOKEN_ADDRESS = envOr("USDC_TOKEN_ADDRESS", "USDC_ADDRESS") || "";
  const CASSWAP_ADDRESS = envOr("CASSWAP_ADDRESS", "CAS_SWAP_ADDRESS", "NEXT_PUBLIC_CASSWAP_ADDRESS") || "";
  const INFRASTRUCTURE_FUND_ADDRESS = envOr("INFRASTRUCTURE_FUND_ADDRESS") || "";
  const RAPPORT_ADDRESS = envOr("RAPPORT_ADDRESS") || "";
  const RAPPORT_PRIVATE_KEY = envOr("RAPPORT_PRIVATE_KEY") || "";
  const DEX_ROUTERS = envOr("DEX_ROUTERS") || "";
  const LOCK_OWNER_ADDRESS = envOr("LOCK_OWNER_ADDRESS") || "";
  const LOCK_DURATION_DAYS = envOr("LOCK_DURATION_DAYS") || "365";
  const SLIPPAGE_BPS = envOr("SLIPPAGE_BPS") || "50";
  const DEADLINE_MINUTES = envOr("DEADLINE_MINUTES") || "60";
  const USDC_LIQUIDITY_TOTAL = envOr("USDC_LIQUIDITY_TOTAL") || "500";
  const CAS_USDC_PRICE = envOr("CAS_USDC_PRICE") || "";
  const CAS_LIQUIDITY_TOTAL = envOr("CAS_LIQUIDITY_TOTAL") || "";
  const USDC_PER_DEX = envOr("USDC_PER_DEX") || "125";
  const CAS_PER_DEX = envOr("CAS_PER_DEX") || "";
  const POL_USDC_PRICE = envOr("POL_USDC_PRICE") || "0.5";
  const CAS_RATIO = envOr("CAS_RATIO") || "2:1";

  const dexRouters = parseDexRouters(DEX_ROUTERS);
  const usdcTotal = ethers.parseUnits(USDC_LIQUIDITY_TOTAL, 6);
  const usdcPerDex = usdcTotal / BigInt(Math.max(1, dexRouters.length || 1));

  let casUsdcPrice = CAS_USDC_PRICE ? parseFloat(CAS_USDC_PRICE) : 0;
  let casTotal: bigint;
  let casPerDex: bigint;

  if (CAS_LIQUIDITY_TOTAL) {
    casTotal = ethers.parseUnits(CAS_LIQUIDITY_TOTAL, 18);
    casPerDex = CAS_PER_DEX ? ethers.parseUnits(CAS_PER_DEX, 18) : casTotal / BigInt(dexRouters.length || 1);
  } else if (casUsdcPrice > 0) {
    const casTotalFloat = parseFloat(USDC_LIQUIDITY_TOTAL) / casUsdcPrice;
    casTotal = ethers.parseUnits(casTotalFloat.toFixed(18), 18);
    casPerDex = casTotal / BigInt(dexRouters.length || 1);
  } else {
    casTotal = 0n;
    casPerDex = 0n;
  }

  return {
    USDC_LP_ADDRESS,
    USDC_LP_PRIVATE_KEY,
    CAS_TOKEN_ADDRESS,
    USDC_TOKEN_ADDRESS,
    CASSWAP_ADDRESS,
    INFRASTRUCTURE_FUND_ADDRESS,
    RAPPORT_ADDRESS,
    RAPPORT_PRIVATE_KEY,
    DEX_ROUTERS: dexRouters,
    LOCK_OWNER_ADDRESS: LOCK_OWNER_ADDRESS || USDC_LP_ADDRESS,
    LOCK_DURATION_DAYS: parseInt(LOCK_DURATION_DAYS, 10),
    SLIPPAGE_BPS: parseInt(SLIPPAGE_BPS, 10),
    DEADLINE_MINUTES: parseInt(DEADLINE_MINUTES, 10),
    USDC_LIQUIDITY_TOTAL: usdcTotal,
    CAS_USDC_PRICE: casUsdcPrice,
    CAS_LIQUIDITY_TOTAL: casTotal,
    USDC_PER_DEX: usdcPerDex,
    CAS_PER_DEX: casPerDex,
    POL_USDC_PRICE: parseFloat(POL_USDC_PRICE),
    CAS_RATIO,
  };
}

export async function getUsdcLpSigner(): Promise<Wallet | undefined> {
  const env = getUsdcLpEnv();
  if (!env.USDC_LP_PRIVATE_KEY) return undefined;
  const [deployer] = await ethers.getSigners();
  const provider = deployer.provider as JsonRpcApiProvider;
  return new Wallet(env.USDC_LP_PRIVATE_KEY, provider);
}

export function parseRatio(ratio: string): { numerator: bigint; denominator: bigint } {
  const [num, den] = ratio.split(":").map((s) => s.trim());
  if (!num || !den) {
    throw new Error(`Formato invalido para CAS_RATIO (esperado N:D): ${ratio}`);
  }
  return { numerator: BigInt(num), denominator: BigInt(den) };
}

export function deadlineFrom(minutes: number): number {
  return Math.floor(Date.now() / 1000) + minutes * 60;
}

export function minAmount(amount: bigint, slippageBps: number): bigint {
  return (amount * BigInt(10000 - slippageBps)) / 10000n;
}

export async function getErc20Contract(address: string): Promise<Contract> {
  const abi = [
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
    "function balanceOf(address) view returns (uint256)",
    "function approve(address,uint256)",
    "function transfer(address,uint256)",
    "function transferFrom(address,address,uint256)",
    "function allowance(address,address) view returns (uint256)",
  ];
  return ethers.getContractAt(abi, address);
}
