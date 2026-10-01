import { ethers, network } from "hardhat";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { IDiamondCut } from "../../typechain-types";

const DIAMOND = "0x80BD976cB588cD2F9aD9Ac671FB19174E9F3172b";
const TIMELOCK = "0x6e14dA17C2B9df7A5d829897F9c39b61D9E8d4B5";
const DELAY = 172800n;

function selectorsOf(contract: any): string[] {
  const selectors: string[] = [];
  contract.interface.forEachFunction((fragment: any) => selectors.push(fragment.selector));
  return [...new Set(selectors)];
}

function log(level: string, message: string, details = ""): void {
  const timestamp = new Date().toISOString().replace("T", " ").replace("Z", "");
  console.log(`[${timestamp}] [29_prepare_casswap_timelock_cut:main] ${level} ${message}${details ? ` - ${details}` : ""}`);
}

async function main(): Promise<void> {
  if (network.config.chainId !== 137) throw new Error("This script only runs on Polygon mainnet (chainId 137)");
  const [deployer] = await ethers.getSigners();
  const factory = await ethers.getContractFactory("CASSwapUSDCPOLFacet", deployer);
  const facet = await factory.deploy();
  await facet.waitForDeployment();
  const facetAddress = await facet.getAddress();
  const deploymentReceipt = await facet.deploymentTransaction()?.wait();
  log("info", "facet_deployed", `address=${facetAddress} tx=${deploymentReceipt?.hash}`);

  const loupe = await ethers.getContractAt("DiamondLoupeFacet", DIAMOND, deployer);
  const replace: string[] = [];
  const add: string[] = [];
  const selectorSignatures: Record<string, string> = {};
  facet.interface.forEachFunction((fragment: any) => {
    selectorSignatures[fragment.selector] = fragment.format("sighash");
  });
  for (const selector of selectorsOf(facet)) {
    const current = await loupe.facetAddress(selector);
    (current === ethers.ZeroAddress ? add : replace).push(selector);
  }

  const cuts: IDiamondCut.FacetCutStruct[] = [];
  if (replace.length > 0) cuts.push({ facetAddress, action: 1, functionSelectors: replace });
  if (add.length > 0) cuts.push({ facetAddress, action: 0, functionSelectors: add });
  const cutInterface = new ethers.Interface([
    "function diamondCut((address facetAddress,uint8 action,bytes4[] functionSelectors)[] cut,address init,bytes calldata data)",
  ]);
  const cutCalldata = cutInterface.encodeFunctionData("diamondCut", [cuts, ethers.ZeroAddress, "0x"]);
  const predecessor = ethers.ZeroHash;
  const salt = ethers.keccak256(ethers.toUtf8Bytes(`CASSwapUSDCPOLFacet:${facetAddress}:v2`));
  const timelockInterface = new ethers.Interface([
    "function schedule(address target,uint256 value,bytes data,bytes32 predecessor,bytes32 salt,uint256 delay)",
    "function hashOperation(address target,uint256 value,bytes data,bytes32 predecessor,bytes32 salt) view returns(bytes32)",
  ]);
  const scheduleCalldata = timelockInterface.encodeFunctionData("schedule", [DIAMOND, 0, cutCalldata, predecessor, salt, DELAY]);
  const timelock = new ethers.Contract(TIMELOCK, timelockInterface, ethers.provider);
  const operationId = await timelock.hashOperation(DIAMOND, 0, cutCalldata, predecessor, salt);

  const output = {
    network: network.name,
    chainId: 137,
    diamond: DIAMOND,
    timelock: TIMELOCK,
    facet: facetAddress,
    facetDeploymentTx: deploymentReceipt?.hash,
    cuts,
    replaceSelectors: replace.map((selector) => ({ selector, signature: selectorSignatures[selector] })),
    addSelectors: add.map((selector) => ({ selector, signature: selectorSignatures[selector] })),
    cutCalldata,
    predecessor,
    salt,
    delaySeconds: DELAY.toString(),
    operationId,
    safeScheduleTransaction: { to: TIMELOCK, value: "0", data: scheduleCalldata },
  };
  const outputPath = resolve(__dirname, "../../deployments/casswap-timelock-cut.json");
  writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  log("info", "cut_prepared", `replace=${replace.length} add=${add.length} operationId=${operationId} output=${outputPath}`);
}

main().catch((error) => {
  log("error", "preparation_failed", `message=${error.shortMessage ?? error.message}`);
  process.exitCode = 1;
});
