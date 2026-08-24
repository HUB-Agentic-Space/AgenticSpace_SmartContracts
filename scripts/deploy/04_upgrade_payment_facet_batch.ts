import { ethers } from "hardhat";
import {
  SEP, SUB, requireEnv,
} from "../utils/deploy_helpers";

/**
 * Upgrade PaymentFacet to include batchTransfer/distribute (promotional CAS transfer).
 * Replaces standalone CASBatchTransfer — now everything is under the Diamond.
 *
 * Steps:
 *   1. Deploy new PaymentFacet (with batchTransfer + distribute)
 *   2. DiamondCut: Replace existing selectors + Add new selectors
 *
 * Usage:
 *   npx hardhat run scripts/deploy/04_upgrade_payment_facet_batch.ts --network polygonAmoy
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
  console.log(`  Upgrade PaymentFacet — Add batchTransfer/distribute`);
  console.log(SEP);
  console.log(`  Diamond:   ${diamondAddress}`);
  console.log(`  Relayer:   ${relayerWallet.address} (diamond owner)\n`);

  const gasPrice = 30_000_000_000n; // 30 gwei

  // 1. Deploy new PaymentFacet
  const PaymentFacetFactory = await ethers.getContractFactory("PaymentFacet");
  console.log(`${SUB}\n  1. Deploy new PaymentFacet\n${SUB}`);
  const newPaymentFacet = await PaymentFacetFactory.deploy({ gasPrice });
  await newPaymentFacet.waitForDeployment();
  const newPaymentFacetAddr = await newPaymentFacet.getAddress();
  console.log(`  New PaymentFacet: ${newPaymentFacetAddr}`);

  // 2. Compute facet cuts using on-chain loupe
  console.log(`${SUB}\n  2. DiamondCut\n${SUB}`);
  const newSelectors = getSelectors(newPaymentFacet);

  const loupe = await ethers.getContractAt("DiamondLoupeFacet", diamondAddress);
  const facets = await loupe.facets();
  const onChainSelectors = new Set<string>();
  for (const [, selectors] of facets) {
    for (const sel of selectors) onChainSelectors.add(sel);
  }

  // Replace: selectors that exist on-chain AND in new facet
  const replaceSelectors = newSelectors.filter((s) => onChainSelectors.has(s));
  // Add: selectors in new facet that DON'T exist on-chain
  const addSelectors = newSelectors.filter((s) => !onChainSelectors.has(s));

  const cuts: { facetAddress: string; action: number; functionSelectors: string[] }[] = [];

  if (replaceSelectors.length > 0) {
    cuts.push({ facetAddress: newPaymentFacetAddr, action: 1, functionSelectors: replaceSelectors });
    console.log(`  Replace: ${replaceSelectors.length} selectors`);
  }
  if (addSelectors.length > 0) {
    cuts.push({ facetAddress: newPaymentFacetAddr, action: 0, functionSelectors: addSelectors });
    console.log(`  Add: ${addSelectors.length} selectors`);
    for (const sel of addSelectors) {
      console.log(`    ${sel}`);
    }
  }

  // Execute cuts one at a time
  const diamondCut = await ethers.getContractAt("IDiamondCut", diamondAddress, relayerWallet);

  for (const cut of cuts) {
    const actionName = cut.action === 0 ? "Add" : "Replace";
    try {
      const tx = await diamondCut.diamondCut([cut], ethers.ZeroAddress, "0x", { gasPrice, gasLimit: 300_000 });
      const receipt = await tx.wait();
      if (receipt?.status === 1) {
        console.log(`  OK: ${actionName} confirmado. Gas: ${receipt.gasUsed}`);
      } else {
        console.error(`  FALHA em ${actionName}`);
      }
    } catch (err: any) {
      console.error(`  ERRO em ${actionName}: ${err.message?.slice(0, 200)}`);
    }
  }

  // 3. Verify
  console.log(`${SUB}\n  3. Verify\n${SUB}`);
  const paymentAtDiamond = PaymentFacetFactory.attach(diamondAddress);
  try {
    const casToken = await paymentAtDiamond.getCasToken();
    const infra = await paymentAtDiamond.getInfrastructureFund();
    const casSwap = await paymentAtDiamond.getCasSwap();
    console.log(`  getCasToken():           ${casToken}`);
    console.log(`  getInfrastructureFund(): ${infra}`);
    console.log(`  getCasSwap():            ${casSwap}`);
  } catch (err: any) {
    console.error(`  Verify failed: ${err.message?.slice(0, 200)}`);
  }

  console.log(`\n${SEP}`);
  console.log(`  Upgrade concluido!`);
  console.log(`  New PaymentFacet: ${newPaymentFacetAddr}`);
  console.log(`  Diamond:          ${diamondAddress}`);
  console.log(`  batchTransfer() e distribute() agora disponiveis no Diamond.`);
  console.log(`${SEP}\n`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(`\n  Erro: ${e.message ?? e}`);
  process.exit(1);
});
