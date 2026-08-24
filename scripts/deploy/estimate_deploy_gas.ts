/**
 * estimate_deploy_gas.ts
 *
 * Estimates the gas cost for deploying the StellarBridgeFacet
 * and adding it to the Diamond on Polygon mainnet.
 *
 * Usage: hardhat run scripts/deploy/estimate_deploy_gas.ts --network polygon
 */
import { ethers, network } from "hardhat";
import dotenv from "dotenv";

dotenv.config();

async function main() {
  const diamondAddress = process.env.DIAMOND_ADDRESS;
  const casTokenAddress = process.env.CAS_TOKEN_ADDRESS;

  if (!diamondAddress || !casTokenAddress) {
    throw new Error("DIAMOND_ADDRESS or CAS_TOKEN_ADDRESS not set in .env");
  }

  const [deployer] = await ethers.getSigners();
  const provider = ethers.provider;

  console.log("📊 Stellar Bridge Deployment Gas Estimation");
  console.log("==============================================");
  console.log(`   Network: ${network.name} (chainId: ${network.config.chainId})`);
  console.log(`   Deployer: ${deployer.address}`);
  console.log(`   Diamond: ${diamondAddress}`);
  console.log(`   CAS Token: ${casTokenAddress}`);
  console.log("");

  // -----------------------------------------------------------------------
  // 1. Get current gas price
  // -----------------------------------------------------------------------
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice;
  const baseFee = feeData.maxFeePerGas;
  const priorityFee = feeData.maxPriorityFeePerGas;

  console.log("⛽ Current Gas Prices:");
  if (gasPrice) {
    console.log(`   Gas Price (legacy):     ${ethers.formatUnits(gasPrice, "gwei")} Gwei`);
  }
  if (baseFee && priorityFee) {
    console.log(`   Base Fee:               ${ethers.formatUnits(baseFee, "gwei")} Gwei`);
    console.log(`   Priority Fee:           ${ethers.formatUnits(priorityFee, "gwei")} Gwei`);
    console.log(`   Max Fee (EIP-1559):     ${ethers.formatUnits(baseFee + priorityFee, "gwei")} Gwei`);
  }
  console.log("");

  // -----------------------------------------------------------------------
  // 2. Estimate deployment gas for StellarBridgeFacet
  // -----------------------------------------------------------------------
  console.log("📦 Estimating StellarBridgeFacet deployment gas...");
  const StellarBridgeFacet = await ethers.getContractFactory("StellarBridgeFacet");

  // Estimate deploy gas using deployTransaction
  const deployTx = StellarBridgeFacet.getDeployTransaction();
  const deployGasEstimate = await provider.estimateGas({
    data: deployTx.data,
  });

  console.log(`   Estimated deploy gas:   ${deployGasEstimate.toString()}`);
  console.log("");

  // -----------------------------------------------------------------------
  // 3. Estimate diamondCut gas (approximate)
  // -----------------------------------------------------------------------
  console.log("📦 Estimating diamondCut gas (approximate)...");
  // diamondCut with ~15 selectors + init call: typically 200k-400k gas
  const diamondCutGasEstimate = 350000n;
  console.log(`   Estimated diamondCut:   ${diamondCutGasEstimate.toString()}`);
  console.log("");

  // -----------------------------------------------------------------------
  // 4. Calculate total
  // -----------------------------------------------------------------------
  const totalGas = deployGasEstimate + diamondCutGasEstimate;
  const effectiveGasPrice = gasPrice || (baseFee! + priorityFee!);

  const deployCost = deployGasEstimate * effectiveGasPrice;
  const diamondCutCost = diamondCutGasEstimate * effectiveGasPrice;
  const totalCost = totalGas * effectiveGasPrice;

  console.log("💰 Cost Summary:");
  console.log("   ─────────────────────────────────────────────");
  console.log(`   Facet deploy:   ${ethers.formatEther(deployCost)} POL`);
  console.log(`   diamondCut:     ${ethers.formatEther(diamondCutCost)} POL`);
  console.log(`   ─────────────────────────────────────────────`);
  console.log(`   Total:          ${ethers.formatEther(totalCost)} POL`);
  console.log("");

  // -----------------------------------------------------------------------
  // 5. Scenarios (low, average, high gas)
  // -----------------------------------------------------------------------
  const scenarios = [
    { name: "Low (150 Gwei)",     gwei: 150n },
    { name: "Average (300 Gwei)", gwei: 300n },
    { name: "High (500 Gwei)",    gwei: 500n },
    { name: "Spike (800 Gwei)",   gwei: 800n },
  ];

  console.log("📊 Cost Scenarios:");
  console.log("   ─────────────────────────────────────────────");
  for (const s of scenarios) {
    const price = s.gwei * 10n**9n;
    const cost = totalGas * price;
    console.log(`   ${s.name.padEnd(20)} ${ethers.formatEther(cost)} POL`);
  }
  console.log("");

  // -----------------------------------------------------------------------
  // 6. Check deployer balance
  // -----------------------------------------------------------------------
  const balance = await provider.getBalance(deployer.address);
  console.log("👤 Deployer Balance:");
  console.log(`   Address:  ${deployer.address}`);
  console.log(`   Balance:  ${ethers.formatEther(balance)} POL`);
  console.log("");

  const recommended = totalCost * 3n; // 3x buffer
  if (balance < recommended) {
    console.log(`   ⚠️  Recommended minimum: ${ethers.formatEther(recommended)} POL (3x buffer)`);
    console.log(`   ❌ Insufficient balance! Need at least ${ethers.formatEther(recommended)} POL`);
  } else {
    console.log(`   ✅ Sufficient balance (recommended: ${ethers.formatEther(recommended)} POL)`);
  }

  // -----------------------------------------------------------------------
  // 7. CAS liquidity needed for unlocks
  // -----------------------------------------------------------------------
  console.log("");
  console.log("🏦 CAS Liquidity for Unlocks (Stellar → EVM direction):");
  console.log("   The Diamond must hold CAS to send to users bridging from Stellar.");
  console.log("   Recommended: transfer CAS to Diamond address after deployment.");
  console.log(`   Diamond address: ${diamondAddress}`);
  console.log("   Amount: depends on expected bridge volume from Stellar.");
  console.log("");
  console.log("   To deposit CAS into Diamond for bridge liquidity:");
  console.log("   1. Approve CAS for Diamond: casToken.approve(diamond, amount)");
  console.log("   2. Transfer: casToken.transfer(diamond, amount)");
  console.log("   Or use the PaymentFacet if it has a deposit function.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Estimation failed:", error);
    process.exit(1);
  });
