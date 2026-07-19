import "dotenv/config";
import { ethers } from "hardhat";
import {
  SEP,
  SUB,
  fmtPOL,
  fmtGwei,
  getNetworkInfo,
  requireEnv,
  sendAndVerify,
} from "../utils/deploy_helpers";

const CASSWAP_ABI = [
  "function setRatio(uint256 numerator, uint256 denominator) external",
  "function getRatio() external view returns (uint256 numerator, uint256 denominator)",
  "function RATIO_ADMIN_ROLE() external view returns (bytes32)",
  "function hasRole(bytes32 role, address account) external view returns (bool)",
  "function isPaused() external view returns (bool)",
];

function log(level: string, message: string, params?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").split(".")[0];
  const file = "scripts/casswap/04_set_casswap_ratio.ts";
  const extra = params ? ` - ${JSON.stringify(params)}` : "";
  console.log(`[${ts}] [${file}:main] ${level} ${message}${extra}`);
}

async function main(): Promise<void> {
  console.log(`\n${SEP}`);
  console.log("  Ajuste do ratio do CASSwap");
  console.log(SEP);

  const env = requireEnv(["CAS_SWAP_ADDRESS"]);
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
    log("ERROR", "Abortando: script deve rodar na Polygon mainnet (137)", { chainId });
    process.exit(1);
  }

  const numeratorInput = process.env.RATIO_NUMERATOR ?? "17";
  const denominatorInput = process.env.RATIO_DENOMINATOR ?? "1";
  const numerator = BigInt(numeratorInput);
  const denominator = BigInt(denominatorInput);

  if (numerator === 0n || denominator === 0n) {
    log("ERROR", "Ratio invalido: numerator e denominator devem ser maiores que zero", {
      numerator: numeratorInput,
      denominator: denominatorInput,
    });
    process.exit(1);
  }

  console.log(`\n${SUB}`);
  console.log("  Parametros do ratio");
  console.log(SUB);
  console.log(`  Numerator:   ${numerator}`);
  console.log(`  Denominator: ${denominator}`);
  console.log(`  Significado: 1 POL = ${numerator}/${denominator} CAS`);

  const casswapAddress = env.CAS_SWAP_ADDRESS;
  const casswap = new ethers.Contract(casswapAddress, CASSWAP_ABI, deployer);

  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? 25_000_000_000n;
  console.log(`  Gas price:   ${fmtGwei(gasPrice)}`);

  console.log(`\n${SUB}`);
  console.log("  Validacao");
  console.log(SUB);

  const [currentNum, currentDen] = await casswap.getRatio();
  log("INFO", "Ratio atual", { numerator: currentNum.toString(), denominator: currentDen.toString() });

  if (currentNum === numerator && currentDen === denominator) {
    log("INFO", "Ratio ja esta configurado com os valores solicitados");
    process.exit(0);
  }

  const paused = await casswap.isPaused();
  if (paused) {
    log("ERROR", "CASSwap esta pausado; nao e possivel ajustar o ratio");
    process.exit(1);
  }

  const ratioAdminRole = await casswap.RATIO_ADMIN_ROLE();
  const hasRole = await casswap.hasRole(ratioAdminRole, deployer.address);
  if (!hasRole) {
    log("ERROR", "Deployer nao possui RATIO_ADMIN_ROLE", {
      deployer: deployer.address,
      role: ratioAdminRole,
    });
    process.exit(1);
  }

  const balance = await provider.getBalance(deployer.address);
  let estimatedGas: bigint;
  try {
    estimatedGas = await casswap.setRatio.estimateGas(numerator, denominator, { gasPrice });
    log("INFO", "Simulacao OK (estimateGas)", { estimatedGas: estimatedGas.toString() });
  } catch (err: any) {
    log("ERROR", "Simulacao falhou", {
      reason: err.reason ?? err.message,
    });
    process.exit(1);
  }

  const gasLimit = (estimatedGas * 120n) / 100n;
  const txCost = gasLimit * gasPrice;
  if (balance < txCost) {
    log("ERROR", "Saldo insuficiente para cobrir o gas", {
      balance: fmtPOL(balance),
      cost: fmtPOL(txCost),
    });
    process.exit(1);
  }

  log("INFO", "Saldo suficiente", {
    balance: fmtPOL(balance),
    estimatedCost: fmtPOL(txCost),
  });

  console.log(`\n${SUB}`);
  console.log("  Envio da transacao");
  console.log(SUB);

  const txPromise = casswap.setRatio(numerator, denominator, { gasPrice, gasLimit });
  await sendAndVerify("setRatio", txPromise, gasPrice, gasLimit);

  const [newNum, newDen] = await casswap.getRatio();
  log("INFO", "Ratio atualizado", {
    numerator: newNum.toString(),
    denominator: newDen.toString(),
  });

  console.log(`\n${SEP}`);
  console.log("  Ajuste concluido");
  console.log(SEP);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
