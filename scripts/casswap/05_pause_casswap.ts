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
  "function pause() external",
  "function unpause() external",
  "function isPaused() external view returns (bool)",
  "function PAUSER_ROLE() external view returns (bytes32)",
  "function hasRole(bytes32 role, address account) external view returns (bool)",
];

function log(level: string, message: string, params?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").split(".")[0];
  const file = "scripts/casswap/05_pause_casswap.ts";
  const extra = params ? ` - ${JSON.stringify(params)}` : "";
  console.log(`[${ts}] [${file}:main] ${level} ${message}${extra}`);
}

async function main(): Promise<void> {
  const action = (process.env.PAUSE_ACTION ?? "pause").toLowerCase().trim();

  console.log(`\n${SEP}`);
  console.log(`  CASSwap ${action === "unpause" ? "Unpause" : "Pause"}`);
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

  if (chainId !== 137 && chainId !== 80002) {
    log("WARN", "Nao esta na Polygon mainnet ou Amoy testnet", { chainId });
  }

  const casswapAddress = env.CAS_SWAP_ADDRESS;
  const casswap = new ethers.Contract(casswapAddress, CASSWAP_ABI, deployer);

  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? 25_000_000_000n;
  console.log(`  Gas price: ${fmtGwei(gasPrice)}`);

  console.log(`\n${SUB}`);
  console.log("  Validacao");
  console.log(SUB);

  const currentlyPaused = await casswap.isPaused();
  log("INFO", "Estado atual", { paused: currentlyPaused });

  if (action === "pause") {
    if (currentlyPaused) {
      log("INFO", "CASSwap ja esta pausado — nada a fazer");
      process.exit(0);
    }
  } else if (action === "unpause") {
    if (!currentlyPaused) {
      log("INFO", "CASSwap nao esta pausado — nada a fazer");
      process.exit(0);
    }
  } else {
    log("ERROR", "PAUSE_ACTION invalido — use 'pause' ou 'unpause'", { action });
    process.exit(1);
  }

  const pauserRole = await casswap.PAUSER_ROLE();
  const hasRole = await casswap.hasRole(pauserRole, deployer.address);
  if (!hasRole) {
    log("ERROR", "Deployer nao possui PAUSER_ROLE", {
      deployer: deployer.address,
      role: pauserRole,
    });
    process.exit(1);
  }

  log("INFO", "Permissao PAUSER_ROLE confirmada", { deployer: deployer.address });

  const balance = await provider.getBalance(deployer.address);
  const fnName = action === "unpause" ? "unpause" : "pause";

  let estimatedGas: bigint;
  try {
    estimatedGas = await (casswap as any)[fnName].estimateGas({ gasPrice });
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
  console.log(`  Envio da transacao: ${fnName}`);
  console.log(SUB);

  const txPromise = (casswap as any)[fnName]({ gasPrice, gasLimit });
  await sendAndVerify(fnName, txPromise, gasPrice, gasLimit);

  const finalPaused = await casswap.isPaused();
  log("INFO", "Estado final", { paused: finalPaused });

  console.log(`\n${SEP}`);
  console.log(`  ${action === "unpause" ? "Unpause" : "Pause"} concluido`);
  console.log(`  CASSwap: ${casswapAddress}`);
  console.log(`  Pausado: ${finalPaused}`);
  console.log(SEP);
}

main().catch((err) => {
  log("ERROR", "Script failed", { error: err.message });
  console.error(err);
  process.exit(1);
});
