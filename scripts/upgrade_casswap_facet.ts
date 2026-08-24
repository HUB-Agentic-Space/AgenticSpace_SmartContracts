import { ethers } from "hardhat";
import dotenv from "dotenv";
import { resolve } from "path";

dotenv.config({ path: resolve(__dirname, "..", ".env") });

/**
 * Upgrade CASSwapUSDCPOLFacet on Diamond to add asymmetric sell ratios.
 * Uses diamondCut with Replace action for existing selectors and Add for new ones.
 *
 * Uso: npx hardhat run scripts/upgrade_casswap_facet.ts --network polygon
 */

const DIAMOND_LOUPE_ABI = [
  "function diamondCut((address facetAddress, uint8 action, bytes4[] functionSelectors)[], address initAddress, bytes initCalldata) external",
  "function facets() external view returns (address[] memory)",
  "function facetFunctionSelectors(address _facet) external view returns (bytes4[] memory)",
  "function facetAddress(bytes4 _selector) external view returns (address)",
];

const SWAP_FACET_ABI = [
  "function initCASSwapUSDCPOL(address,address) external",
  "function setSwapRatio(uint256,uint256) external",
  "function setSwapRatioUSDC(uint256,uint256) external",
  "function setSwapRatioSell(uint256,uint256) external",
  "function setSwapRatioUSDCSell(uint256,uint256) external",
  "function getRatio() view returns (uint256,uint256)",
  "function getRatioUSDC() view returns (uint256,uint256)",
  "function getRatioSell() view returns (uint256,uint256)",
  "function getRatioUSDCSell() view returns (uint256,uint256)",
  "function buyCASWithPOL(uint256,uint256) payable returns (uint256)",
  "function sellCASForPOL(uint256,uint256,uint256) returns (uint256)",
  "function buyCASWithUSDC(uint256,uint256,uint256) returns (uint256)",
  "function sellCASForUSDC(uint256,uint256,uint256) returns (uint256)",
  "function redeemCAS(uint256,uint8,uint256,uint256) returns (uint256)",
  "function redeemForCAS(uint8,uint256,uint256,uint256) payable returns (uint256)",
  "function supportSwap(uint8,uint256,address) external",
  "function getSwapFeeBps() view returns (uint256)",
  "function getReserves() view returns (uint256,uint256,uint256)",
  "function isSwapPaused() view returns (bool)",
  "function RATIO_SETTER_ROLE() view returns (bytes32)",
];

async function main(): Promise<void> {
  const diamondAddr = process.env.DIAMOND_ADDRESS!;
  const relayerKey = process.env.RELAYER_PRIVATE_KEY!;

  const [defaultSigner] = await ethers.getSigners();
  const provider = defaultSigner.provider!;
  const relayer = new ethers.Wallet(relayerKey, provider);

  console.log("\n============================================================");
  console.log("  CASSwapUSDCPOLFacet Upgrade — Asymmetric Ratios");
  console.log("============================================================");
  console.log(`  Diamond:  ${diamondAddr}`);
  console.log(`  Relayer:  ${relayer.address}`);

  // Deploy new facet
  const SwapFacet = await ethers.getContractFactory("CASSwapUSDCPOLFacet", relayer);
  const newFacet = await SwapFacet.deploy();
  await newFacet.waitForDeployment();
  const newFacetAddr = await newFacet.getAddress();
  console.log(`  New facet: ${newFacetAddr}`);

  // Get all selectors from new facet
  const allSelectors: string[] = [];
  newFacet.interface.forEachFunction((frag: any) => {
    allSelectors.push(frag.selector);
  });

  // Check which selectors already exist on the diamond
  const diamondLoupe = new ethers.Contract(diamondAddr, [
    ...DIAMOND_LOUPE_ABI,
    "function facetAddress(bytes4) view returns (address)",
  ], relayer);

  const replaceSelectors: string[] = [];
  const addSelectors: string[] = [];

  for (const sel of allSelectors) {
    try {
      const existingAddr = await diamondLoupe.facetAddress(sel);
      if (existingAddr !== ethers.ZeroAddress) {
        replaceSelectors.push(sel);
      } else {
        addSelectors.push(sel);
      }
    } catch {
      addSelectors.push(sel);
    }
  }

  console.log(`  Replace: ${replaceSelectors.length} selectors`);
  console.log(`  Add:     ${addSelectors.length} selectors`);

  // Build cuts
  const cuts: any[] = [];

  if (replaceSelectors.length > 0) {
    cuts.push({
      facetAddress: newFacetAddr,
      action: 1, // Replace
      functionSelectors: replaceSelectors,
    });
  }

  if (addSelectors.length > 0) {
    cuts.push({
      facetAddress: newFacetAddr,
      action: 0, // Add
      functionSelectors: addSelectors,
    });
  }

  if (cuts.length === 0) {
    console.log("  No changes needed — all selectors already point to same facet.");
    return;
  }

  // Execute diamondCut (no init needed — storage is already initialized)
  const tx = await diamondLoupe.diamondCut(cuts, ethers.ZeroAddress, "0x");
  console.log(`  TX: ${tx.hash}`);
  await tx.wait();

  // Verify
  const swap = new ethers.Contract(diamondAddr, SWAP_FACET_ABI, relayer);
  const [buyNum, buyDen] = await swap.getRatio();
  const [sellNum, sellDen] = await swap.getRatioSell();
  console.log(`\n  Buy ratio:  ${buyNum}/${buyDen}`);
  console.log(`  Sell ratio: ${sellNum}/${sellDen}`);
  console.log("  ✅ Upgrade complete.");
  console.log("============================================================\n");
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
