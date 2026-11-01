import { ethers, network } from "hardhat";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * @file 52_prepare_claim_facets_cut.ts
 * @description Deploya ClaimVaultFacet e ClaimNFTFacet na Polygon mainnet e
 *              prepara o payload de governança: um scheduleBatch no Timelock
 *              contendo (1) diamondCut com os dois facets e init do vault,
 *              (2) initClaimNFT, (3) setClaimAssetSupport(CAS). O agendamento
 *              é executado pela Safe 2-de-3 no script 53 e a execução após 48h
 *              pelo script 54. Requer DIAMOND_ADDRESS, CAS_TOKEN_ADDRESS e
 *              CLAIM_SIGNER_ADDRESS; CLAIM_NFT_BASE_URI é opcional.
 *
 * Author:  Carlos Delfino
 * Email:   consultoria@carlosdelfino.eti.br
 * WhatsApp: +55 (85) 98520-5490
 */

const DIAMOND = "0x80BD976cB588cD2F9aD9Ac671FB19174E9F3172b";
const TIMELOCK = "0x6e14dA17C2B9df7A5d829897F9c39b61D9E8d4B5";
const DELAY = 172800n;
const OUTPUT_DIR = resolve(__dirname, "../../deployments");

function log(level: string, message: string, details = ""): void {
  const timestamp = new Date().toISOString().replace("T", " ").replace("Z", "");
  console.log(`[${timestamp}] [52_prepare_claim_facets_cut:main] ${level} ${message}${details ? ` - ${details}` : ""}`);
}

function selectorsOf(contract: { interface: any }): string[] {
  const list: string[] = [];
  contract.interface.forEachFunction((fragment: any) => list.push(fragment.selector));
  return [...new Set(list)];
}

async function main(): Promise<void> {
  if (network.config.chainId !== 137) throw new Error("This script only runs on Polygon mainnet (chainId 137)");
  if (process.env.CONFIRM_FACET_DEPLOY !== "true") {
    throw new Error("Set CONFIRM_FACET_DEPLOY=true to deploy the facet implementations");
  }
  const claimSigner = process.env.CLAIM_SIGNER_ADDRESS;
  const casToken = process.env.CAS_TOKEN_ADDRESS;
  const baseURI = process.env.CLAIM_NFT_BASE_URI ?? "https://hubagentic.space/api/v1/nft/claim/";
  if (!claimSigner || !ethers.isAddress(claimSigner)) throw new Error("CLAIM_SIGNER_ADDRESS is required and must be a valid address");
  if (!casToken || !ethers.isAddress(casToken)) throw new Error("CAS_TOKEN_ADDRESS is required and must be a valid address");

  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);
  log("info", "deployer_state", `network=${network.name} deployer=${deployer.address} balance=${ethers.formatEther(balance)} POL`);
  if (balance < ethers.parseEther("0.05")) throw new Error(`Deployer balance too low: ${ethers.formatEther(balance)} POL`);

  const vaultFactory = await ethers.getContractFactory("ClaimVaultFacet");
  const vaultImpl = await vaultFactory.deploy();
  await vaultImpl.waitForDeployment();
  const vaultAddress = await vaultImpl.getAddress();
  const vaultReceipt = await vaultImpl.deploymentTransaction()?.wait();
  log("info", "facet_deployed", `ClaimVaultFacet=${vaultAddress} tx=${vaultReceipt?.hash}`);

  const nftFactory = await ethers.getContractFactory("ClaimNFTFacet");
  const nftImpl = await nftFactory.deploy();
  await nftImpl.waitForDeployment();
  const nftAddress = await nftImpl.getAddress();
  const nftReceipt = await nftImpl.deploymentTransaction()?.wait();
  log("info", "facet_deployed", `ClaimNFTFacet=${nftAddress} tx=${nftReceipt?.hash}`);

  const loupe = await ethers.getContractAt("DiamondLoupeFacet", DIAMOND, deployer);
  const vaultSelectors = selectorsOf(vaultFactory);
  const nftSelectors = selectorsOf(nftFactory);
  const selectorSignatures: Record<string, string> = {};
  for (const contract of [vaultFactory, nftFactory]) {
    contract.interface.forEachFunction((fragment: any) => {
      selectorSignatures[fragment.selector] = fragment.format("sighash");
    });
  }
  for (const selector of [...vaultSelectors, ...nftSelectors]) {
    const mapped = await loupe.facetAddress(selector);
    if (mapped !== ethers.ZeroAddress) {
      throw new Error(`Selector collision detected: ${selector} already mapped to ${mapped}. Aborting.`);
    }
  }
  log("info", "collision_check_passed", `selectors=${vaultSelectors.length + nftSelectors.length}`);

  const cuts = [
    { facetAddress: vaultAddress, action: 0, functionSelectors: vaultSelectors },
    { facetAddress: nftAddress, action: 0, functionSelectors: nftSelectors },
  ];
  const vaultInit = vaultFactory.interface.encodeFunctionData("initClaimVault", [claimSigner]);
  const cutInterface = new ethers.Interface([
    "function diamondCut((address facetAddress,uint8 action,bytes4[] functionSelectors)[] cut,address init,bytes calldata data)",
  ]);
  const cutCalldata = cutInterface.encodeFunctionData("diamondCut", [cuts, vaultAddress, vaultInit]);
  const nftInitCalldata = nftFactory.interface.encodeFunctionData("initClaimNFT", ["Rapport Claim", "RCLAIM", baseURI]);
  const assetCalldata = vaultFactory.interface.encodeFunctionData("setClaimAssetSupport", [casToken, true]);

  const targets = [DIAMOND, DIAMOND, DIAMOND];
  const values = [0, 0, 0];
  const payloads = [cutCalldata, nftInitCalldata, assetCalldata];
  const predecessor = ethers.ZeroHash;
  const salt = ethers.keccak256(ethers.toUtf8Bytes(`ClaimFacets:${vaultAddress}:${nftAddress}:v1`));

  const timelockInterface = new ethers.Interface([
    "function scheduleBatch(address[] targets,uint256[] values,bytes[] payloads,bytes32 predecessor,bytes32 salt,uint256 delay)",
    "function hashOperationBatch(address[] targets,uint256[] values,bytes[] payloads,bytes32 predecessor,bytes32 salt) view returns(bytes32)",
    "function isOperationPending(bytes32) view returns(bool)",
    "function isOperationDone(bytes32) view returns(bool)",
  ]);
  const timelock = new ethers.Contract(TIMELOCK, timelockInterface, ethers.provider);
  const operationId = await timelock.hashOperationBatch(targets, values, payloads, predecessor, salt);
  if (await timelock.isOperationPending(operationId) || await timelock.isOperationDone(operationId)) {
    throw new Error(`Operation ${operationId} already scheduled or executed — adjust the salt`);
  }
  const scheduleCalldata = timelockInterface.encodeFunctionData("scheduleBatch", [targets, values, payloads, predecessor, salt, DELAY]);

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const output = {
    network: network.name,
    chainId: 137,
    diamond: DIAMOND,
    timelock: TIMELOCK,
    claimVaultFacet: vaultAddress,
    claimNFTFacet: nftAddress,
    claimVaultFacetDeploymentTx: vaultReceipt?.hash ?? null,
    claimNFTFacetDeploymentTx: nftReceipt?.hash ?? null,
    claimSigner,
    casToken,
    nftName: "Rapport Claim",
    nftSymbol: "RCLAIM",
    nftBaseURI: baseURI,
    cuts,
    vaultSelectors: vaultSelectors.map((selector) => ({ selector, signature: selectorSignatures[selector] })),
    nftSelectors: nftSelectors.map((selector) => ({ selector, signature: selectorSignatures[selector] })),
    targets,
    values: values.map(String),
    payloads,
    cutCalldata,
    nftInitCalldata,
    assetCalldata,
    predecessor,
    salt,
    delaySeconds: DELAY.toString(),
    operationId,
    safeScheduleTransaction: { to: TIMELOCK, value: "0", data: scheduleCalldata },
    preparedAt: new Date().toISOString(),
  };
  const outputPath = resolve(OUTPUT_DIR, "claim-facets-cut.json");
  writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  log("info", "cut_prepared", `vaultSelectors=${vaultSelectors.length} nftSelectors=${nftSelectors.length} operationId=${operationId} output=${outputPath}`);
}

main().catch((error) => {
  log("error", "preparation_failed", `message=${error.shortMessage ?? error.message}`);
  process.exitCode = 1;
});
