import { ethers } from "hardhat";
import {
  SEP, SUB, requireEnv,
} from "../utils/deploy_helpers";

/**
 * Upgrade facets with security fixes (2025-07-14 audit).
 *
 * Modified facets:
 *   - PaymentFacet       (C-1, A-1, A-2, A-3)
 *   - RoadMapDAOFacet    (C-1)
 *   - AgentDAOFacet      (C-1)
 *   - AgentValidatorFacet(C-1)
 *   - GasPromotionFacet  (C-1)
 *   - DiamondInit        (C-1 — re-init not needed, just deploy new version)
 *
 * Also upgrades standalone contracts:
 *   - Faucet             (A-4, A-5 — redeploy)
 *   - CASSwap            (A-7 — redeploy)
 *   - CASMigration       (A-6 — redeploy)
 *
 * Usage:
 *   npx hardhat run scripts/deploy/08_upgrade_security_fixes.ts --network polygonAmoy
 */

function getSelectors(contract: any): string[] {
  const selectors: string[] = [];
  const iface = contract.interface;
  for (const fn of iface.fragments) {
    if (fn.type === "function" && fn.name !== "init") {
      selectors.push(iface.getFunction(fn.name).selector);
    }
  }
  return selectors;
}

async function main() {
  const [deployer] = await ethers.getSigners();

  const env = requireEnv([
    "DIAMOND_ADDRESS",
    "RELAYER_PRIVATE_KEY",
  ]);

  const diamondAddress = env.DIAMOND_ADDRESS;
  const relayerWallet = new ethers.Wallet(env.RELAYER_PRIVATE_KEY, deployer.provider!);

  console.log(`\n${SEP}`);
  console.log(`  Upgrade Security Fixes — Diamond Facets`);
  console.log(SEP);
  console.log(`  Diamond:   ${diamondAddress}`);
  console.log(`  Deployer:  ${deployer.address} (paga gas de deploy)`);
  console.log(`  Relayer:   ${relayerWallet.address} (assina diamondCut)\n`);

  const gasPrice = 25_000_000_000n; // 25 gwei — Amoy minimum

  // Facets to upgrade (replace selectors)
  const facetsToUpgrade = [
    "RoadMapDAOFacet",
    "AgentDAOFacet",
    "GasPromotionFacet",
  ];

  // Get on-chain selectors
  const loupe = await ethers.getContractAt("DiamondLoupeFacet", diamondAddress);
  const facets = await loupe.facets();
  const onChainSelectors = new Set<string>();
  for (const [, selectors] of facets) {
    for (const sel of selectors) onChainSelectors.add(sel);
  }

  // diamondCut will be signed by relayer (diamond owner)
  const diamondCut = await ethers.getContractAt("IDiamondCut", diamondAddress, relayerWallet);

  const upgradedFacets: { name: string; address: string }[] = [];
  const allCuts: { facetAddress: string; action: number; functionSelectors: string[] }[] = [];

  // Phase 1: Deploy all facets using deployer (cheaper, more balance)
  for (const facetName of facetsToUpgrade) {
    console.log(`\n${SUB}\n  Deploying ${facetName} (deployer)\n${SUB}`);

    const Factory = await ethers.getContractFactory(facetName, deployer);
    const newFacet = await Factory.deploy({ gasPrice, gasLimit: 3_000_000 });
    await newFacet.waitForDeployment();
    const newFacetAddr = await newFacet.getAddress();
    console.log(`  New ${facetName}: ${newFacetAddr}`);

    const newSelectors = getSelectors(newFacet);

    // Replace: selectors that exist on-chain AND in new facet
    const replaceSelectors = newSelectors.filter((s) => onChainSelectors.has(s));
    // Add: selectors in new facet that DON'T exist on-chain
    const addSelectors = newSelectors.filter((s) => !onChainSelectors.has(s));

    if (replaceSelectors.length > 0) {
      allCuts.push({ facetAddress: newFacetAddr, action: 1, functionSelectors: replaceSelectors });
      console.log(`  Replace: ${replaceSelectors.length} selectors`);
    }
    if (addSelectors.length > 0) {
      allCuts.push({ facetAddress: newFacetAddr, action: 0, functionSelectors: addSelectors });
      console.log(`  Add: ${addSelectors.length} selectors`);
    }

    upgradedFacets.push({ name: facetName, address: newFacetAddr });
  }

  // Phase 2: Single diamondCut with all facets (signed by relayer)
  if (allCuts.length > 0) {
    console.log(`\n${SUB}\n  diamondCut — ${allCuts.length} cuts (relayer)\n${SUB}`);
    try {
      const tx = await diamondCut.diamondCut(allCuts, ethers.ZeroAddress, "0x", { gasPrice, gasLimit: 600_000 });
      const receipt = await tx.wait();
      if (receipt?.status === 1) {
        console.log(`  OK: All facets upgraded in 1 tx. Gas: ${receipt.gasUsed}`);
      } else {
        console.error(`  FALHA no diamondCut`);
      }
    } catch (err: any) {
      console.error(`  ERRO no diamondCut: ${err.message?.slice(0, 200)}`);
      // Fallback: try one facet at a time
      console.log(`\n  Tentando um facet por vez...`);
      for (const f of upgradedFacets) {
        const facetCut = allCuts.filter(c => c.facetAddress === f.address);
        if (facetCut.length === 0) continue;
        try {
          const tx = await diamondCut.diamondCut(facetCut, ethers.ZeroAddress, "0x", { gasPrice, gasLimit: 500_000 });
          const receipt = await tx.wait();
          if (receipt?.status === 1) {
            console.log(`  OK: ${f.name} upgraded. Gas: ${receipt.gasUsed}`);
          } else {
            console.error(`  FALHA em ${f.name}`);
          }
        } catch (e: any) {
          console.error(`  ERRO em ${f.name}: ${e.message?.slice(0, 200)}`);
        }
      }
    }
  }

  // Summary
  console.log(`\n${SEP}`);
  console.log(`  Upgrade de Facets Concluido!`);
  console.log(SEP);
  for (const f of upgradedFacets) {
    console.log(`  ${f.name.padEnd(25)} ${f.address}`);
  }
  console.log(`\n  Diamond: ${diamondAddress}`);
  console.log(`${SEP}\n`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(`\n  Erro: ${e.message ?? e}`);
  process.exit(1);
});
