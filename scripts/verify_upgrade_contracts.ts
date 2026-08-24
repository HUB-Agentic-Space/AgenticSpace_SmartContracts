/**
 * Verify the new RapportCertificateUpgradeable implementation and
 * RapportCertificatePhaseAdminFacet on Polygonscan.
 *
 * The implementation contract has no constructor args (UUPS pattern —
 * initialization happens via the proxy's initialize call).
 * The facet also has no constructor args.
 */
import { run } from "hardhat";

async function main() {
  const implAddress = "0x2480F2add161928ec17dbd774854B3a8b9AB8Bc2";
  const facetAddress = "0x52CC4DC338f780168ff0ac554C86BBe6a8b35f29";

  console.log("=== Verifying contracts on Polygonscan ===\n");

  // Verify the new implementation
  console.log("--- Verifying RapportCertificateUpgradeable (new impl) ---");
  console.log(`  Address: ${implAddress}`);
  try {
    await run("verify:verify", {
      address: implAddress,
      constructorArguments: [],
    });
    console.log("  ✓ Verified");
  } catch (err: any) {
    if (err.message?.includes("Already Verified") || err.message?.includes("already verified")) {
      console.log("  ✓ Already verified");
    } else {
      console.log("  ✗ Error:", err.message);
    }
  }

  // Verify the facet
  console.log("\n--- Verifying RapportCertificatePhaseAdminFacet ---");
  console.log(`  Address: ${facetAddress}`);
  try {
    await run("verify:verify", {
      address: facetAddress,
      constructorArguments: [],
    });
    console.log("  ✓ Verified");
  } catch (err: any) {
    if (err.message?.includes("Already Verified") || err.message?.includes("already verified")) {
      console.log("  ✓ Already verified");
    } else {
      console.log("  ✗ Error:", err.message);
    }
  }

  console.log("\n=== Verification complete ===");
  console.log("Check on Polygonscan:");
  console.log(`  Impl: https://polygonscan.com/address/${implAddress}#code`);
  console.log(`  Facet: https://polygonscan.com/address/${facetAddress}#code`);
  console.log(`  Proxy: https://polygonscan.com/address/0x0D4d5F160E57ec707Fb6a2A84C53040a1E23FA55#code`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Error:", error.message ?? error);
    process.exit(1);
  });
