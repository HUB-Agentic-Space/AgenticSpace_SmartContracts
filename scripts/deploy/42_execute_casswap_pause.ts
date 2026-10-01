import { ethers, network } from "hardhat";
import { execFileSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import payload from "../../deployments/casswap-pause.json";

/**
 * @file 42_execute_casswap_pause.ts
 * @description Executa o pause do swap no Diamond após o delay do timelock.
 *              Como o EXECUTOR_ROLE está aberto (address(0)), qualquer conta
 *              pode executar — este script usa o signer padrão do Hardhat e
 *              verifica isSwapPaused() ao final. Remove o timer systemd de
 *              execução automática, se existir.
 *
 * Author:  Carlos Delfino
 * Email:   consultoria@carlosdelfino.eti.br
 * WhatsApp: +55 (85) 98520-5490
 */

const SERVICE = "agenticspace-casswap-pause-execute.service";
const TIMER = "agenticspace-casswap-pause-execute.timer";

function log(level: string, message: string, details = ""): void {
  const timestamp = new Date().toISOString().replace("T", " ").replace("Z", "");
  console.log(`[${timestamp}] [42_execute_casswap_pause:main] ${level} ${message}${details ? ` - ${details}` : ""}`);
}

function cleanupUnits(): void {
  try { execFileSync("systemctl", ["--user", "disable", "--now", TIMER], { stdio: "ignore" }); } catch { /* já removido */ }
  const unitDirectory = resolve(process.env.HOME ?? "", ".config/systemd/user");
  for (const unit of [SERVICE, TIMER]) {
    const path = resolve(unitDirectory, unit);
    if (existsSync(path)) unlinkSync(path);
  }
  try { execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" }); } catch { /* noop */ }
  log("info", "timer_removed", `service=${SERVICE} timer=${TIMER}`);
}

async function main(): Promise<void> {
  if (network.config.chainId !== 137) throw new Error("This script only runs on Polygon mainnet (chainId 137)");
  const [executor] = await ethers.getSigners();
  const timelock = new ethers.Contract(payload.timelock, [
    "function isOperationReady(bytes32) view returns(bool)",
    "function isOperationDone(bytes32) view returns(bool)",
    "function getTimestamp(bytes32) view returns(uint256)",
    "function execute(address,uint256,bytes,bytes32,bytes32) payable",
  ], executor);

  if (await timelock.isOperationDone(payload.operationId)) {
    log("info", "operation_already_executed", `operationId=${payload.operationId}`);
    cleanupUnits();
    return;
  }
  if (!(await timelock.isOperationReady(payload.operationId))) {
    throw new Error(`Operation is not ready; readyAt=${await timelock.getTimestamp(payload.operationId)}`);
  }

  const transaction = await timelock.execute(
    payload.diamond,
    0,
    payload.swapCalldata,
    payload.predecessor,
    payload.salt,
  );
  log("info", "execution_submitted", `tx=${transaction.hash} operationId=${payload.operationId}`);
  const receipt = await transaction.wait();
  if (!receipt || receipt.status !== 1) throw new Error(`Execution failed: ${transaction.hash}`);

  const diamond = new ethers.Contract(payload.diamond, [
    "function isSwapPaused() view returns(bool)",
  ], executor);
  if (!(await diamond.isSwapPaused())) {
    throw new Error("Pause verification failed: isSwapPaused()=false apos execute");
  }
  log("info", "execution_verified", `tx=${transaction.hash} isSwapPaused=true`);
  cleanupUnits();
}

main().catch((error) => {
  log("error", "execution_failed", `message=${error.shortMessage ?? error.message}`);
  process.exitCode = 1;
});
