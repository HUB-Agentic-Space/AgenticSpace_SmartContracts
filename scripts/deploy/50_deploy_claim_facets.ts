import { ethers, network } from "hardhat";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * @file 50_deploy_claim_facets.ts
 * @description Deploya ClaimVaultFacet e ClaimNFTFacet, verifica colisão de
 *              seletores contra todos os facetAddresses já registrados no
 *              Diamond (via facetAddress) e executa o diamondCut com
 *              inicialização. Requer DIAMOND_ADDRESS e CLAIM_SIGNER_ADDRESS
 *              no ambiente; CLAIM_NFT_BASE_URI é opcional.
 *              Não executa sem confirmação: exige CONFIRM_DIAMOND_CUT=true.
 *
 * Author:  Carlos Delfino
 * Email:   consultoria@carlosdelfino.eti.br
 * WhatsApp: +55 (85) 98520-5490
 */

const OUTPUT_DIR = resolve(__dirname, "../../deployments");

function log(level: string, message: string, details = ""): void {
  const timestamp = new Date().toISOString().replace("T", " ").replace("Z", "");
  console.log(`[${timestamp}] [50_deploy_claim_facets:main] ${level} ${message}${details ? ` - ${details}` : ""}`);
}

function selectors(contract: { interface: any }): string[] {
  return contract.interface.fragments
    .filter((f: any) => f.type === "function")
    .map((f: any) => contract.interface.getFunction(f.format("sighash"))!.selector);
}

async function main(): Promise<void> {
  const diamondAddress = process.env.DIAMOND_ADDRESS;
  const claimSigner = process.env.CLAIM_SIGNER_ADDRESS;
  const baseURI = process.env.CLAIM_NFT_BASE_URI ?? "https://hubagentic.space/api/v1/nft/claim/";
  if (!diamondAddress || !ethers.isAddress(diamondAddress)) {
    throw new Error("DIAMOND_ADDRESS is required and must be a valid address");
  }
  if (!claimSigner || !ethers.isAddress(claimSigner)) {
    throw new Error("CLAIM_SIGNER_ADDRESS is required and must be a valid address");
  }
  if (process.env.CONFIRM_DIAMOND_CUT !== "true") {
    throw new Error("Set CONFIRM_DIAMOND_CUT=true to execute the diamondCut");
  }

  const [deployer] = await ethers.getSigners();
  log("info", "deploy", `network=${network.name} chainId=${network.config.chainId} deployer=${deployer.address}`);

  const ClaimVaultFacet = await ethers.getContractFactory("ClaimVaultFacet");
  const vaultImpl = await ClaimVaultFacet.deploy();
  await vaultImpl.waitForDeployment();
  const vaultAddress = await vaultImpl.getAddress();
  log("info", "facet_deployed", `ClaimVaultFacet=${vaultAddress}`);

  const ClaimNFTFacet = await ethers.getContractFactory("ClaimNFTFacet");
  const nftImpl = await ClaimNFTFacet.deploy();
  await nftImpl.waitForDeployment();
  const nftAddress = await nftImpl.getAddress();
  log("info", "facet_deployed", `ClaimNFTFacet=${nftAddress}`);

  // Collision check: every selector must be unmapped in the Diamond.
  const loupe = await ethers.getContractAt("DiamondLoupeFacet", diamondAddress);
  const vaultSelectors = selectors(ClaimVaultFacet);
  const nftSelectors = selectors(ClaimNFTFacet);
  const initSignatures = new Set(["initClaimVault(address)", "initClaimNFT(string,string,string)"]);
  const cutSelectors = (names: string[], sel: string[]) =>
    sel.filter((s, i) => {
      void names; void i;
      return true;
    });

  for (const sel of [...vaultSelectors, ...nftSelectors]) {
    const mapped = await loupe.facetAddress(sel);
    if (mapped !== ethers.ZeroAddress) {
      throw new Error(`Selector collision detected: ${sel} already mapped to ${mapped}. Aborting diamondCut.`);
    }
  }
  log("info", "collision_check_passed", `selectors=${vaultSelectors.length + nftSelectors.length}`);

  const cut = [
    { facetAddress: vaultAddress, action: 0, functionSelectors: vaultSelectors },
    { facetAddress: nftAddress, action: 0, functionSelectors: nftSelectors },
  ];
  void cutSelectors;
  void initSignatures;

  const vaultInit = ClaimVaultFacet.interface.encodeFunctionData("initClaimVault", [claimSigner]);
  const diamondCut = await ethers.getContractAt("IDiamondCut", diamondAddress);
  const tx = await diamondCut.diamondCut(cut, vaultAddress, vaultInit);
  const receipt = await tx.wait();
  log("info", "diamond_cut_executed", `tx=${tx.hash} block=${receipt?.blockNumber}`);

  // Initialize NFT collection via the facet selector now mapped in the Diamond.
  const nftAtDiamond = await ethers.getContractAt("ClaimNFTFacet", diamondAddress);
  const initTx = await nftAtDiamond.initClaimNFT("Rapport Claim", "RCLAIM", baseURI);
  await initTx.wait();
  log("info", "nft_initialized", `tx=${initTx.hash} baseURI=${baseURI}`);

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const output = resolve(OUTPUT_DIR, `claim-facets-${network.config.chainId}.json`);
  writeFileSync(output, `${JSON.stringify({
    network: network.name,
    chainId: Number(network.config.chainId),
    diamond: diamondAddress,
    claimVaultFacet: vaultAddress,
    claimNFTFacet: nftAddress,
    claimSigner,
    diamondCutTx: tx.hash,
    nftInitTx: initTx.hash,
    deployedAt: new Date().toISOString(),
  }, null, 2)}\n`, "utf8");
  log("info", "deployment_recorded", `output=${output}`);
}

main().catch((error) => {
  log("error", "deploy_failed", `message=${error.shortMessage ?? error.message}`);
  process.exitCode = 1;
});
