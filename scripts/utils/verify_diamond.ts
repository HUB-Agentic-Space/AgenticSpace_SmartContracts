import { ethers } from "hardhat";
import { IDiamondCut } from "../../typechain-types";

/**
 * Verify the Diamond proxy on Polygonscan.
 * The Diamond constructor receives (address owner, IDiamondCut.FacetCut[] cut).
 * The initial cut only includes DiamondCutFacet.
 */
async function main() {
  const diamondAddr = process.env.DIAMOND_ADDRESS;
  if (!diamondAddr) {
    console.error("DIAMOND_ADDRESS not set in .env");
    process.exit(1);
  }

  const diamondCutFacetAddr = "0xFA75D96a1F0297FB1de7547B09837Ea98d434570";
  const deployerAddr = "0x66682BBeD9e540017967692cCdd069fE5F833888";

  // Get selectors from DiamondCutFacet
  const DiamondCutFacet = await ethers.getContractFactory("DiamondCutFacet");
  const iface = DiamondCutFacet.interface;
  const selectors: string[] = [];
  for (const fn of iface.fragments) {
    if (fn.type === "function" && fn.name !== "init") {
      selectors.push(iface.getFunction(fn.name).selector);
    }
  }

  const cut: IDiamondCut.FacetCutStruct[] = [{
    facetAddress: diamondCutFacetAddr,
    action: 0,
    functionSelectors: selectors,
  }];

  // Encode constructor args
  const DiamondFactory = await ethers.getContractFactory("Diamond");
  const encodedArgs = DiamondFactory.interface.encodeDeploy([deployerAddr, cut]);
  console.log("Diamond address:", diamondAddr);
  console.log("Encoded constructor args:", encodedArgs);

  // Verify using hardhat verify programmatically
  const { run } = require("hardhat");
  await run("verify:verify", {
    address: diamondAddr,
    constructorArguments: [deployerAddr, cut],
  });
}

main().catch((e) => {
  console.error("Error:", e.message ?? e);
  process.exit(1);
});
