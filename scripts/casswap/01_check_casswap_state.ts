import "dotenv/config";
import { ethers } from "hardhat";
import { Contract } from "ethers";
import {
  SEP,
  SUB,
  fmtPOL,
  fmtGwei,
  getNetworkInfo,
  requireEnv,
} from "../utils/deploy_helpers";

const CASSWAP_ABI = [
  "function getRatio() view returns (uint256 numerator, uint256 denominator)",
  "function getCASBalance() view returns (uint256)",
  "function getPOLBalance() view returns (uint256)",
  "function getSwapFee() view returns (uint256)",
  "function isPaused() view returns (bool)",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

const PAIR_ABI = [
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];

const WPOL_ADDRESS = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";

interface DexPair {
  name: string;
  address: string;
}

function log(level: string, message: string, params?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").split(".")[0];
  const file = "scripts/casswap/01_check_casswap_state.ts";
  const extra = params ? ` - ${JSON.stringify(params)}` : "";
  console.log(`[${ts}] [${file}:main] ${level} ${message}${extra}`);
}

async function main(): Promise<void> {
  console.log(`\n${SEP}`);
  console.log("  Snapshot CASSwap / Deployer / DEXs");
  console.log(SEP);

  const env = requireEnv(["CAS_SWAP_ADDRESS", "CAS_TOKEN_ADDRESS"]);
  const [deployer] = await ethers.getSigners();
  const provider = deployer.provider!;

  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);
  const netInfo = getNetworkInfo(chainId);

  console.log(`\n${SUB}`);
  console.log("  Rede");
  console.log(SUB);
  console.log(`  Rede:      ${netInfo.name}`);
  console.log(`  Chain ID:  ${chainId}`);
  console.log(`  Deployer:  ${deployer.address}`);

  if (chainId !== 137) {
    log("WARN", "Nao esta na mainnet Polygon 137", { chainId });
  }

  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? 25_000_000_000n;
  console.log(`  Gas price: ${fmtGwei(gasPrice)}`);

  const casTokenAddress = env.CAS_TOKEN_ADDRESS;
  const casswapAddress = env.CAS_SWAP_ADDRESS;
  const infrastructureFundAddress = process.env.INFRASTRUCTURE_FUND_ADDRESS ?? "";

  const casToken = new Contract(casTokenAddress, ERC20_ABI, provider);
  const casswap = new Contract(casswapAddress, CASSWAP_ABI, provider);

  console.log(`\n${SUB}`);
  console.log("  CASSwap");
  console.log(SUB);

  const [ratioNum, ratioDen] = await casswap.getRatio();
  const casBalance = await casswap.getCASBalance();
  const polBalance = await casswap.getPOLBalance();
  const swapFee = await casswap.getSwapFee();
  const paused = await casswap.isPaused();

  const ratio = Number(ratioNum) / Number(ratioDen);

  log("INFO", "CASSwap state", {
    ratio: `${ratio.toFixed(4)} CAS/POL`,
    casReserve: ethers.formatEther(casBalance),
    polReserve: ethers.formatEther(polBalance),
    swapFeeBps: swapFee.toString(),
    paused,
  });

  console.log(`  Ratio:     1 POL = ${ratio.toFixed(4)} CAS`);
  console.log(`  CAS res:   ${ethers.formatEther(casBalance)} CAS`);
  console.log(`  POL res:   ${ethers.formatEther(polBalance)} POL`);
  console.log(`  Fee:       ${swapFee.toString()} bps`);
  console.log(`  Pausado:   ${paused}`);

  console.log(`\n${SUB}`);
  console.log("  Saldos");
  console.log(SUB);

  const deployerPOL = await provider.getBalance(deployer.address);
  const deployerCAS = await casToken.balanceOf(deployer.address);

  log("INFO", "Deployer balances", {
    pol: ethers.formatEther(deployerPOL),
    cas: ethers.formatEther(deployerCAS),
  });

  console.log(`  Deployer POL: ${fmtPOL(deployerPOL)}`);
  console.log(`  Deployer CAS: ${ethers.formatEther(deployerCAS)} CAS`);

  if (infrastructureFundAddress && ethers.isAddress(infrastructureFundAddress)) {
    const infraPOL = await provider.getBalance(infrastructureFundAddress);
    const infraCAS = await casToken.balanceOf(infrastructureFundAddress);
    log("INFO", "InfrastructureFund balances", {
      address: infrastructureFundAddress,
      pol: ethers.formatEther(infraPOL),
      cas: ethers.formatEther(infraCAS),
    });
    console.log(`  Infra POL:    ${fmtPOL(infraPOL)}`);
    console.log(`  Infra CAS:    ${ethers.formatEther(infraCAS)} CAS`);
  } else {
    log("INFO", "INFRASTRUCTURE_FUND_ADDRESS nao configurado");
  }

  const pairs: DexPair[] = [
    { name: "QuickSwap", address: process.env.QUICKSWAP_LP_TOKEN_ADDRESS ?? "" },
    { name: "SushiSwap", address: process.env.SUSHISWAP_LP_TOKEN_ADDRESS ?? "" },
    { name: "ApeSwap", address: process.env.APESWAP_LP_TOKEN_ADDRESS ?? "" },
    { name: "Dfyn", address: process.env.DFYN_LP_TOKEN_ADDRESS ?? "" },
  ].filter((p) => p.address !== "" && ethers.isAddress(p.address));

  if (pairs.length > 0) {
    console.log(`\n${SUB}`);
    console.log("  Pares DEX");
    console.log(SUB);
  }

  for (const { name, address } of pairs) {
    try {
      const pair = new Contract(address, PAIR_ABI, provider);
      const [r0, r1] = await pair.getReserves();
      const t0 = (await pair.token0()).toLowerCase();
      const t1 = (await pair.token1()).toLowerCase();
      const totalSupply = await pair.totalSupply();
      const deployerLP = await pair.balanceOf(deployer.address);

      const isCas0 = t0 === casTokenAddress.toLowerCase();
      const casRes = isCas0 ? r0 : r1;
      const otherRes = isCas0 ? r1 : r0;
      const otherToken = isCas0 ? t1 : t0;
      const isWPOL = otherToken === WPOL_ADDRESS.toLowerCase();

      const price = Number(casRes) / Number(otherRes);

      log("INFO", `${name} pair state`, {
        address,
        price: `${price.toFixed(6)} ${isWPOL ? "CAS/POL" : "CAS/OTHER"}`,
        token0: t0,
        token1: t1,
        totalSupply: ethers.formatEther(totalSupply),
        deployerLP: ethers.formatEther(deployerLP),
      });

      console.log(`  ${name.padEnd(12)} ${address}`);
      console.log(`    1 ${isWPOL ? "POL" : "OTHER"} = ${price.toFixed(6)} CAS`);
      console.log(`    LP total:   ${ethers.formatEther(totalSupply)}`);
      console.log(`    Deployer LP:${ethers.formatEther(deployerLP)}`);
      if (!isWPOL) {
        console.log(`    AVISO: par nao eh WPOL — comparacao de preco pode nao refletir POL`);
      }
    } catch (err: any) {
      log("ERROR", `Falha ao ler par ${name}`, { address, error: err.message });
      console.log(`  ${name}: erro — ${err.message}`);
    }
  }

  console.log(`\n${SEP}\n`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    log("ERROR", "Script failed", { error: err.message });
    console.error(err);
    process.exit(1);
  });
