import { ethers, network } from "hardhat";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * @file 43_deploy_trader_governance_facet.ts
 * @description Deploya a nova versão do TraderGovernanceFacet, onde
 *              pauseSwap/unpauseSwap usam PAUSER_ROLE (enforceRoleOrOwner)
 *              em vez de onlyOwner — permitindo pausa imediata pelo Safe
 *              sem o delay de 48h do timelock. O endereço é gravado em
 *              deployments/trader-governance-v2.json para os scripts 44-46.
 *              Idempotente: se o facet já estiver deployado, reutiliza.
 *
 * Author:  Carlos Delfino
 * Email:   consultoria@carlosdelfino.eti.br
 * WhatsApp: +55 (85) 98520-5490
 */

const OUTPUT = resolve(__dirname, "../../deployments/trader-governance-v2.json");

function log(level: string, message: string, details = ""): void {
  const timestamp = new Date().toISOString().replace("T", " ").replace("Z", "");
  console.log(`[${timestamp}] [43_deploy_trader_governance_facet:main] ${level} ${message}${details ? ` - ${details}` : ""}`);
}

async function main(): Promise<void> {
  if (network.config.chainId !== 137) throw new Error("This script only runs on Polygon mainnet (chainId 137)");
  const [deployer] = await ethers.getSigners();
  log("info", "deployer", `address=${deployer.address}`);

  if (existsSync(OUTPUT)) {
    const existing = JSON.parse(readFileSync(OUTPUT, "utf8"));
    if (existing.facet && (await ethers.provider.getCode(existing.facet)) !== "0x") {
      log("info", "facet_already_deployed", `facet=${existing.facet}`);
      return;
    }
  }

  const Factory = await ethers.getContractFactory("TraderGovernanceFacet");
  const facet = await Factory.deploy();
  await facet.waitForDeployment();
  const facetAddress = await facet.getAddress();
  const deployTx = facet.deploymentTransaction()?.hash ?? "";
  log("info", "facet_deployed", `facet=${facetAddress} tx=${deployTx}`);

  // Sanity check: a versão deployada deve expor os 9 seletores de governança.
  const selectors = Factory.interface.fragments
    .filter((f) => f.type === "function")
    .map((f) => Factory.interface.getFunction(f.name)!.selector);
  if (selectors.length !== 9) throw new Error(`Expected 9 governance selectors, got ${selectors.length}`);

  writeFileSync(OUTPUT, `${JSON.stringify({
    network: network.name,
    chainId: 137,
    facet: facetAddress,
    deployTx,
    deployedAt: new Date().toISOString(),
    selectors,
  }, null, 2)}\n`, "utf8");
  log("info", "deployment_recorded", `output=${OUTPUT} selectors=${selectors.length}`);
}

main().catch((error) => {
  log("error", "deploy_failed", `message=${error.shortMessage ?? error.message}`);
  process.exitCode = 1;
});
