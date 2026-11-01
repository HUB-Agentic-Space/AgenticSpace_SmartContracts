import { ethers, network } from "hardhat";
import { execFileSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import payload from "../../deployments/claim-facets-cut.json";

/**
 * @file 54_execute_claim_facets_cut.ts
 * @description Executa no Timelock a operação em batch dos facets de claim após
 *              o delay de 48h: diamondCut, initClaimNFT e suporte ao CAS.
 *              Verifica seletores, signer, metadados, interfaces ERC-165 e
 *              suporte ao ativo. Remove o service/timer systemd de execução ao
 *              concluir com sucesso.
 *
 * Author:  Carlos Delfino
 * Email:   consultoria@carlosdelfino.eti.br
 * WhatsApp: +55 (85) 98520-5490
 */

const SERVICE = "agenticspace-claim-facets-execute.service";
const TIMER = "agenticspace-claim-facets-execute.timer";

function log(level: string, message: string, details = ""): void {
  const timestamp = new Date().toISOString().replace("T", " ").replace("Z", "");
  console.log(`[${timestamp}] [54_execute_claim_facets_cut:main] ${level} ${message}${details ? ` - ${details}` : ""}`);
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

  const loupe = await ethers.getContractAt("DiamondLoupeFacet", payload.diamond, executor);
  for (const [entries, expected] of [
    [payload.vaultSelectors, payload.claimVaultFacet],
    [payload.nftSelectors, payload.claimNFTFacet],
  ] as const) {
    for (const entry of entries) {
      const facet = await loupe.facetAddress(entry.selector);
      if (facet.toLowerCase() !== expected.toLowerCase()) {
        throw new Error(`Selector verification failed: ${entry.selector} (${entry.signature}) points to ${facet}, expected ${expected}`);
      }
    }
  }
  log("info", "selectors_verified", `count=${payload.vaultSelectors.length + payload.nftSelectors.length}`);

  const vaultAtDiamond = await ethers.getContractAt("ClaimVaultFacet", payload.diamond, executor);
  const signer = await vaultAtDiamond.getClaimSigner();
  if (signer.toLowerCase() !== payload.claimSigner.toLowerCase()) {
    throw new Error(`claimSigner mismatch: ${signer} expected ${payload.claimSigner}`);
  }
  if (!(await vaultAtDiamond.isClaimAssetSupported(payload.casToken))) {
    throw new Error("CAS asset support was not enabled");
  }
  if (!(await vaultAtDiamond.isClaimAssetSupported(ethers.ZeroAddress))) {
    throw new Error("Native asset support was not enabled");
  }

  const nftAtDiamond = await ethers.getContractAt("ClaimNFTFacet", payload.diamond, executor);
  const [collectionName, collectionSymbol] = await Promise.all([nftAtDiamond.name(), nftAtDiamond.symbol()]);
  if (collectionName !== payload.nftName || collectionSymbol !== payload.nftSymbol) {
    throw new Error(`NFT metadata mismatch: ${collectionName}/${collectionSymbol}`);
  }
  const erc165 = new ethers.Contract(payload.diamond, ["function supportsInterface(bytes4) view returns(bool)"], executor);
  if (!(await erc165.supportsInterface("0x80ac58cd"))) throw new Error("ERC-721 interface not registered");
  if (!(await erc165.supportsInterface("0xb45a3c0e"))) throw new Error("ERC-5192 interface not registered");

  const [casBalance, committed] = await vaultAtDiamond.getVaultBalance(payload.casToken);
  log("info", "execution_verified", `tx=${transaction.hash} signer=${signer} casBalance=${casBalance} committed=${committed}`);
  cleanupUnits();
}

main().catch((error) => {
  log("error", "execution_failed", `message=${error.shortMessage ?? error.message}`);
  process.exitCode = 1;
});
