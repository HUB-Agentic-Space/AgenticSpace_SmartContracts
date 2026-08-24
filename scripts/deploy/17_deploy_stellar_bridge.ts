/**
 * 17_deploy_stellar_bridge.ts
 *
 * Deploys the StellarBridgeFacet and adds it to the Diamond via diamondCut.
 * Initializes the facet with CAS token, bridge admin, and bridge operator.
 *
 * Usage: hardhat run scripts/deploy/17_deploy_stellar_bridge.ts --network polygonAmoy
 */
import { ethers, network } from "hardhat";
import dotenv from "dotenv";
import { promises as fs } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

dotenv.config();

async function main() {
  const [deployer] = await ethers.getSigners();
  const diamondAddress = process.env.DIAMOND_ADDRESS;
  const casTokenAddress = process.env.CAS_TOKEN_ADDRESS;

  if (!diamondAddress) {
    throw new Error("DIAMOND_ADDRESS not set in .env");
  }
  if (!casTokenAddress) {
    throw new Error("CAS_TOKEN_ADDRESS not set in .env");
  }

  console.log("🚀 Deploying StellarBridgeFacet...");
  console.log(`   Network: ${network.name} (chainId: ${network.config.chainId})`);
  console.log(`   Deployer: ${deployer.address}`);
  console.log(`   Diamond: ${diamondAddress}`);
  console.log(`   CAS Token: ${casTokenAddress}`);

  // -----------------------------------------------------------------------
  // 1. Deploy StellarBridgeFacet
  // -----------------------------------------------------------------------
  const StellarBridgeFacet = await ethers.getContractFactory("StellarBridgeFacet");
  const stellarBridgeFacet = await StellarBridgeFacet.deploy();
  await stellarBridgeFacet.waitForDeployment();
  const facetAddress = await stellarBridgeFacet.getAddress();
  console.log(`✅ StellarBridgeFacet deployed at: ${facetAddress}`);

  // -----------------------------------------------------------------------
  // 2. Get function selectors
  // -----------------------------------------------------------------------
  const facet = await ethers.getContractAt("IStellarBridge", facetAddress);
  const selectors = Object.keys(facet.interface.functions)
    .map((fn) => facet.interface.getFunction(fn)!.selector)
    .filter((s) => s !== "0x00000000");

  console.log(`   Function selectors (${selectors.length}):`);
  for (const s of selectors) {
    console.log(`     ${s}`);
  }

  // -----------------------------------------------------------------------
  // 3. Prepare diamondCut
  // -----------------------------------------------------------------------
  const diamondCut = await ethers.getContractAt("IDiamondCut", diamondAddress);

  const cut = [
    {
      facetAddress: facetAddress,
      action: 0, // Add
      functionSelectors: selectors,
    },
  ];

  // Prepare init calldata
  const bridgeAdmin = process.env.BRIDGE_ADMIN || deployer.address;
  const bridgeOperator = process.env.BRIDGE_OPERATOR || deployer.address;

  console.log(`   Bridge Admin: ${bridgeAdmin}`);
  console.log(`   Bridge Operator: ${bridgeOperator}`);

  const initCalldata = stellarBridgeFacet.interface.encodeFunctionData(
    "initStellarBridge",
    [casTokenAddress, bridgeAdmin, bridgeOperator]
  );

  // -----------------------------------------------------------------------
  // 4. Execute diamondCut
  // -----------------------------------------------------------------------
  console.log("📦 Adding StellarBridgeFacet to Diamond...");
  const tx = await diamondCut.diamondCut(
    cut,
    facetAddress,
    initCalldata
  );
  console.log(`   TX hash: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`✅ DiamondCut confirmed, gas used: ${receipt!.gasUsed}`);

  // -----------------------------------------------------------------------
  // 5. Verify
  // -----------------------------------------------------------------------
  const bridge = await ethers.getContractAt("IStellarBridge", diamondAddress);
  const operator = await bridge.getBridgeOperator();
  const admin = await bridge.getBridgeAdmin();
  const paused = await bridge.isBridgePaused();

  console.log("");
  console.log("📋 Bridge Status:");
  console.log(`   Operator: ${operator}`);
  console.log(`   Admin: ${admin}`);
  console.log(`   Paused: ${paused}`);

  // -----------------------------------------------------------------------
  // 6. Update .env with facet address
  // -----------------------------------------------------------------------
  console.log("");
  console.log("📝 Add to .env:");
  console.log(`   STELLAR_BRIDGE_FACET_ADDRESS=${facetAddress}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Deployment failed:", error);
    process.exit(1);
  });
