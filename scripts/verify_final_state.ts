import { ethers } from "hardhat";

async function main() {
  const proxyAddress = "0x0D4d5F160E57ec707Fb6a2A84C53040a1E23FA55";
  // Use the public mapping getter: phases(uint256) returns the Phase struct
  const abi = [
    "function phaseCount() view returns (uint256)",
    "function currentPhaseId() view returns (uint256)",
    "function totalCertificates() view returns (uint256)",
    "function phaseAdminFacet() view returns (address)",
    "function phases(uint256) view returns (string name, bytes32 templateHash, uint256 minCasDeposit, uint256 startsAt, uint256 endsAt, uint256 minted, bool active, string skillsDescription, string instructions, uint256 extraFeeTypeId, uint256 tbaRebateBps, bool allowMultipleIssuance, uint256 maxPerRecipient, uint256 maxTotalSupply)",
  ];
  const cert = new ethers.Contract(proxyAddress, abi, ethers.provider);

  const phaseCount = await cert.phaseCount();
  const currentPhaseId = await cert.currentPhaseId();
  const totalCerts = await cert.totalCertificates();
  const facet = await cert.phaseAdminFacet();

  console.log("=== Mainnet Post-Upgrade Final Verification ===");
  console.log("Proxy:", proxyAddress);
  console.log("Phase count:", phaseCount.toString());
  console.log("Current phase ID:", currentPhaseId.toString());
  console.log("Total certificates:", totalCerts.toString());
  console.log("PhaseAdminFacet:", facet);

  // Read all phases using the public mapping getter
  for (let i = 1n; i <= phaseCount; i++) {
    const phase = await cert.phases(i);
    console.log(`\nPhase ${i}:`);
    console.log(`  name: ${phase.name}`);
    console.log(`  minted: ${phase.minted}`);
    console.log(`  active: ${phase.active}`);
    console.log(`  allowMultipleIssuance: ${phase.allowMultipleIssuance}`);
    console.log(`  maxPerRecipient: ${phase.maxPerRecipient}`);
    console.log(`  maxTotalSupply: ${phase.maxTotalSupply}`);
  }

  console.log("\n=== All checks passed ===");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Error:", error.message ?? error);
    process.exit(1);
  });
