import { ethers, network } from "hardhat";
import { execFileSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import payload from "../../deployments/casswap-pause-governance.json";

/**
 * @file 46_execute_pause_governance.ts
 * @description Executa o batch de governança do pause após o delay do
 *              timelock (EXECUTOR_ROLE aberto — qualquer conta executa):
 *              diamondCut Replace do TraderGovernanceFacet v2 +
 *              grantRole(PAUSER_ROLE) ao Safe. Verifica ao final que o
 *              seletor pauseSwap aponta para o facet novo e que o Safe
 *              detém PAUSER_ROLE. Remove o timer systemd de execução
 *              automática, se existir.
 *
 * Author:  Carlos Delfino
 * Email:   consultoria@carlosdelfino.eti.br
 * WhatsApp: +55 (85) 98520-5490
 */

const SERVICE = "agenticspace-casswap-pausegov-execute.service";
const TIMER = "agenticspace-casswap-pausegov-execute.timer";
const PAUSE_SWAP_SELECTOR = "0xed6b5ad5";

function log(level: string, message: string, details = ""): void {
  const timestamp = new Date().toISOString().replace("T", " ").replace("Z", "");
  console.log(`[${timestamp}] [46_execute_pause_governance:main] ${level} ${message}${details ? ` - ${details}` : ""}`);
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
    "function executeBatch(address[] targets,uint256[] values,bytes[] payloads,bytes32 predecessor,bytes32 salt) payable",
  ], executor);

  if (await timelock.isOperationDone(payload.operationId)) {
    log("info", "operation_already_executed", `operationId=${payload.operationId}`);
    cleanupUnits();
    return;
  }
  if (!(await timelock.isOperationReady(payload.operationId))) {
    throw new Error(`Operation is not ready; readyAt=${await timelock.getTimestamp(payload.operationId)}`);
  }

  const transaction = await timelock.executeBatch(
    payload.targets,
    payload.values,
    payload.payloads,
    payload.predecessor,
    payload.salt,
  );
  log("info", "execution_submitted", `tx=${transaction.hash} operationId=${payload.operationId}`);
  const receipt = await transaction.wait();
  if (!receipt || receipt.status !== 1) throw new Error(`Execution failed: ${transaction.hash}`);

  const diamond = new ethers.Contract(payload.diamond, [
    "function facetAddress(bytes4) view returns(address)",
    "function hasRole(bytes32,address) view returns(bool)",
  ], executor);
  const pauseFacet = await diamond.facetAddress(PAUSE_SWAP_SELECTOR);
  if (pauseFacet.toLowerCase() !== payload.newFacet.toLowerCase()) {
    throw new Error(`Cut verification failed: pauseSwap facet=${pauseFacet} expected=${payload.newFacet}`);
  }
  if (!(await diamond.hasRole(payload.pauserRole, payload.pauserRoleGrantee))) {
    throw new Error(`Role verification failed: ${payload.pauserRoleGrantee} sem PAUSER_ROLE`);
  }
  log("info", "execution_verified", `tx=${transaction.hash} pauseSwapFacet=${pauseFacet} pauser=${payload.pauserRoleGrantee}`);
  cleanupUnits();
}

main().catch((error) => {
  log("error", "execution_failed", `message=${error.shortMessage ?? error.message}`);
  process.exitCode = 1;
});
