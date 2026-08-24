import "dotenv/config";
import { ethers } from "hardhat";
import { requireEnv, sendAndVerify, SEP, SUB } from "../utils/deploy_helpers";

const CAS_TOKEN_ABI = [
  "function paused() view returns (bool)",
  "function pause()",
  "function unpause()",
  "function hasRole(bytes32 role, address account) view returns (bool)",
];

function log(level: string, fn: string, message: string, params?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").split(".")[0];
  const file = "scripts/casswap/17_pause_cas_token.ts";
  const extra = params ? ` - ${JSON.stringify(params)}` : "";
  console.log(`[${ts}] [${file}:${fn}] ${level} ${message}${extra}`);
}

async function main(): Promise<void> {
  const action = (process.env.PAUSE_ACTION ?? "pause").toLowerCase().trim();

  if (action !== "pause" && action !== "unpause") {
    log("ERROR", "main", "PAUSE_ACTION invalido — use 'pause' ou 'unpause'", { action });
    process.exit(1);
  }

  const [deployer] = await ethers.getSigners();
  const provider = ethers.provider;
  const { CAS_TOKEN_ADDRESS } = await requireEnv(["CAS_TOKEN_ADDRESS"]);

  const pauserRole = ethers.keccak256(ethers.toUtf8Bytes("PAUSER_ROLE"));
  const cas = new ethers.Contract(CAS_TOKEN_ADDRESS, CAS_TOKEN_ABI, deployer);

  const isPaused = await cas.paused();
  const hasRole = await cas.hasRole(pauserRole, deployer.address);

  console.log(`\n${SEP}`);
  console.log(`  ${action === "unpause" ? "Unpause" : "Pause"} do token CAS (CASToken)`);
  console.log(SEP);
  console.log(`  Token:    ${CAS_TOKEN_ADDRESS}`);
  console.log(`  Deployer: ${deployer.address}`);
  console.log(`  Paused:   ${isPaused}`);
  console.log(`  PAUSER:   ${hasRole ? "SIM" : "NAO"}`);
  console.log(SEP);

  if (action === "pause" && isPaused) {
    console.log("  Token CAS ja esta pausado. Nenhuma acao necessaria.\n");
    return;
  }

  if (action === "unpause" && !isPaused) {
    console.log("  Token CAS nao esta pausado. Nenhuma acao necessaria.\n");
    return;
  }

  if (!hasRole) {
    throw new Error("Deployer nao possui PAUSER_ROLE no CASToken.");
  }

  const feeData = await provider.getFeeData();
  const latestBlock = await provider.getBlock("latest");
  const baseFee = latestBlock?.baseFeePerGas ?? 0n;
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? feeData.gasPrice ?? 25_000_000_000n;
  const maxFeePerGas = baseFee * 2n + maxPriorityFeePerGas;
  const txOptions = { maxFeePerGas, maxPriorityFeePerGas };

  const fnName = action === "unpause" ? "unpause" : "pause";
  console.log(`\n${SUB}`);
  console.log(`  Enviando transacao: CASToken.${fnName}()`);
  console.log(SUB);

  await sendAndVerify(`CASToken.${fnName}()`, (cas as any)[fnName](txOptions), maxFeePerGas);

  const finalPaused = await cas.paused();

  console.log(`\n${SEP}`);
  console.log(`  Token CAS ${action === "unpause" ? "despausado" : "pausado"} com sucesso.`);
  console.log(`  Pausado: ${finalPaused}`);
  if (action === "pause") {
    console.log("  Todas as transferencias/trocas de CAS estao suspensas.");
  } else {
    console.log("  Transferencias de CAS estao liberadas.");
  }
  console.log(SEP);
  console.log();

  log("OK", "main", `CASToken ${fnName} concluido`, { paused: finalPaused });
}

main().catch((err) => {
  log("ERROR", "main", "Erro fatal", { error: err.message ?? String(err) });
  console.error(`\n  Erro fatal: ${err.message ?? err}`);
  process.exit(1);
});
