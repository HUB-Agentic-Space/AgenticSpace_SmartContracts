import { ethers, network } from "hardhat";
import { execFileSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import payload from "../../deployments/casswap-oracle-cut.json";

const SERVICE = "agenticspace-casswap-oracle-execute.service";
const TIMER = "agenticspace-casswap-oracle-execute.timer";

function log(level: string, message: string, details = ""): void {
  const timestamp = new Date().toISOString().replace("T", " ").replace("Z", "");
  console.log(`[${timestamp}] [49_execute_casswap_oracle_cut:main] ${level} ${message}${details ? ` - ${details}` : ""}`);
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
    payload.cutCalldata,
    payload.predecessor,
    payload.salt,
  );
  log("info", "execution_submitted", `tx=${transaction.hash} operationId=${payload.operationId}`);
  const receipt = await transaction.wait();
  if (!receipt || receipt.status !== 1) throw new Error(`Execution failed: ${transaction.hash}`);

  // Verificação: cada seletor aponta para o facet esperado (replace → swap,
  // add → oracle).
  const loupe = await ethers.getContractAt("DiamondLoupeFacet", payload.diamond, executor);
  for (const entry of payload.selectors) {
    const expected = entry.facet === "swap" ? payload.swapFacet : payload.oracleFacet;
    const facet = await loupe.facetAddress(entry.selector);
    if (facet.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(`Selector verification failed: ${entry.signature} points to ${facet}, expected ${expected}`);
    }
  }
  log("info", "execution_verified", `tx=${transaction.hash} selectors=${payload.selectors.length}`);

  // Verificação do init: oracleEnabled ligado e âncora SushiSwap registrada.
  const oracle = new ethers.Contract(payload.diamond, [
    "function oraclePricingEnabled() view returns(bool)",
    "function getCasPriceSources() view returns(uint256,uint256,bool)",
  ], executor);
  const enabled = await oracle.oraclePricingEnabled();
  if (!enabled) throw new Error("Oracle pricing not enabled after init");
  const [uniPrice, sushiPrice, flag] = await oracle.getCasPriceSources();
  log("info", "oracle_state", `enabled=${enabled} uniV3CasPerWpol=${uniPrice} sushiCasPerWpol=${sushiPrice} flag=${flag}`);

  cleanupUnits();
}

main().catch((error) => {
  log("error", "execution_failed", `message=${error.shortMessage ?? error.message}`);
  process.exitCode = 1;
});
