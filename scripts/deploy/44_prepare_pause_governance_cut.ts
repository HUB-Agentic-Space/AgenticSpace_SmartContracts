import { ethers, network } from "hardhat";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * @file 44_prepare_pause_governance_cut.ts
 * @description Prepara o batch de governança que torna o pause do swap
 *              imediato: (1) diamondCut Replace dos 9 seletores do
 *              TraderGovernanceFacet apontando para o facet v2 deployado
 *              pelo script 43 (pauseSwap/unpauseSwap passam a exigir
 *              PAUSER_ROLE ou owner); (2) grantRole(PAUSER_ROLE) para o
 *              Safe 2-de-3. O batch é agendado via timelock.scheduleBatch
 *              pelo Safe — script 45 — e executado após 48h — script 46.
 *              Gera deployments/casswap-pause-governance.json.
 *
 * Author:  Carlos Delfino
 * Email:   consultoria@carlosdelfino.eti.br
 * WhatsApp: +55 (85) 98520-5490
 */

const DIAMOND = "0x80BD976cB588cD2F9aD9Ac671FB19174E9F3172b";
const TIMELOCK = "0x6e14dA17C2B9df7A5d829897F9c39b61D9E8d4B5";
const OLD_FACET = "0x94b1AE50aF1FF776A9Eb211582bBAf9e7b29C96b";
const SAFE = "0x1743abe1A64DAB3c81e394adb4e3B56ef05F0D26";
const DELAY = 172800n;
const PAUSER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("PAUSER_ROLE"));
const FACET_DEPLOY = resolve(__dirname, "../../deployments/trader-governance-v2.json");

function log(level: string, message: string, details = ""): void {
  const timestamp = new Date().toISOString().replace("T", " ").replace("Z", "");
  console.log(`[${timestamp}] [44_prepare_pause_governance_cut:main] ${level} ${message}${details ? ` - ${details}` : ""}`);
}

async function main(): Promise<void> {
  if (network.config.chainId !== 137) throw new Error("This script only runs on Polygon mainnet (chainId 137)");

  const deployment = JSON.parse(readFileSync(FACET_DEPLOY, "utf8"));
  const newFacet: string = deployment.facet;
  if (!newFacet || (await ethers.provider.getCode(newFacet)) === "0x") {
    throw new Error(`Facet v2 nao deployado em ${newFacet}; rode o script 43 primeiro`);
  }

  // Seletores atuais do facet antigo — Replace preserva exatamente o mesmo conjunto.
  const loupe = new ethers.Contract(DIAMOND, [
    "function facetFunctionSelectors(address) view returns(bytes4[])",
    "function facetAddress(bytes4) view returns(address)",
    "function hasRole(bytes32,address) view returns(bool)",
  ], ethers.provider);
  const selectors: string[] = await loupe.facetFunctionSelectors(OLD_FACET);
  if (selectors.length !== 9) throw new Error(`Expected 9 selectors on ${OLD_FACET}, got ${selectors.length}`);
  if ((await loupe.facetAddress(selectors[0])).toLowerCase() !== OLD_FACET.toLowerCase()) {
    throw new Error("Facet antigo nao e o registrado para pauseSwap — abortando");
  }
  if (await loupe.hasRole(PAUSER_ROLE, SAFE)) {
    log("info", "role_already_granted", `safe=${SAFE} role=PAUSER_ROLE`);
  }

  const cutInterface = new ethers.Interface([
    "function diamondCut(tuple(address facetAddress, uint8 action, bytes4[] functionSelectors)[] cuts, address init, bytes initCalldata)",
  ]);
  const cutCalldata = cutInterface.encodeFunctionData("diamondCut", [
    [{ facetAddress: newFacet, action: 1, functionSelectors: selectors }],
    ethers.ZeroAddress,
    "0x",
  ]);

  const accessInterface = new ethers.Interface(["function grantRole(bytes32 role, address account)"]);
  const grantCalldata = accessInterface.encodeFunctionData("grantRole", [PAUSER_ROLE, SAFE]);

  const targets = [DIAMOND, DIAMOND];
  const values = [0, 0];
  const payloads = [cutCalldata, grantCalldata];
  const predecessor = ethers.ZeroHash;
  const salt = ethers.keccak256(ethers.toUtf8Bytes(`TraderGovernanceFacet:pauser-role:${newFacet}:${Date.now()}`));

  const timelockInterface = new ethers.Interface([
    "function scheduleBatch(address[] targets,uint256[] values,bytes[] payloads,bytes32 predecessor,bytes32 salt,uint256 delay)",
    "function hashOperationBatch(address[] targets,uint256[] values,bytes[] payloads,bytes32 predecessor,bytes32 salt) view returns(bytes32)",
  ]);
  const scheduleCalldata = timelockInterface.encodeFunctionData("scheduleBatch", [targets, values, payloads, predecessor, salt, DELAY]);
  const timelock = new ethers.Contract(TIMELOCK, timelockInterface, ethers.provider);
  const operationId = await timelock.hashOperationBatch(targets, values, payloads, predecessor, salt);

  const output = {
    network: network.name,
    chainId: 137,
    diamond: DIAMOND,
    timelock: TIMELOCK,
    action: "pause-governance-cut",
    oldFacet: OLD_FACET,
    newFacet,
    selectors,
    pauserRole: PAUSER_ROLE,
    pauserRoleGrantee: SAFE,
    targets,
    values,
    payloads,
    predecessor,
    salt,
    delaySeconds: DELAY.toString(),
    operationId,
    safeScheduleTransaction: { to: TIMELOCK, value: "0", data: scheduleCalldata },
  };
  const outputPath = resolve(__dirname, "../../deployments/casswap-pause-governance.json");
  writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  log("info", "batch_prepared", `operationId=${operationId} newFacet=${newFacet} selectors=${selectors.length} output=${outputPath}`);
}

main().catch((error) => {
  log("error", "preparation_failed", `message=${error.shortMessage ?? error.message}`);
  process.exitCode = 1;
});
