import { ethers } from "hardhat";
import {
  SEP, SUB, preFlightCheck, sendAndVerify, printSummary, requireEnv,
} from "../utils/deploy_helpers";

/**
 * Fix ContractRegistry addresses and bind CASSwap in PaymentFacet on mainnet.
 *
 * Issues being fixed:
 *   1. ContractRegistry has Diamond address for CASToken, InfrastructureFund, CASSwap
 *      instead of their actual addresses. Re-register with version 2.
 *   2. CASFundTracker and POLFundTracker are not registered. Register as v1.
 *   3. PaymentFacet.getCasSwap() returns zero — setCasSwap() was never called.
 *
 * Prerequisites:
 *   - DIAMOND_ADDRESS, CAS_TOKEN_ADDRESS, INFRASTRUCTURE_FUND_ADDRESS,
 *     CAS_SWAP_ADDRESS, CAS_FUND_TRACKER_ADDRESS, POL_FUND_TRACKER_ADDRESS
 *     must be set in .env
 *   - The caller (POLYGON_PRIVATE_KEY) must be the Diamond owner.
 *
 * Usage:
 *   npx hardhat run scripts/deploy/09_fix_registry_and_swap.ts --network polygon
 */
async function main() {
  const [deployer] = await ethers.getSigners();

  const env = requireEnv([
    "DIAMOND_ADDRESS",
    "CAS_TOKEN_ADDRESS",
    "INFRASTRUCTURE_FUND_ADDRESS",
    "CAS_SWAP_ADDRESS",
    "CAS_FUND_TRACKER_ADDRESS",
    "POL_FUND_TRACKER_ADDRESS",
  ]);

  const diamondAddr = env.DIAMOND_ADDRESS;
  const casTokenAddr = env.CAS_TOKEN_ADDRESS;
  const infraFundAddr = env.INFRASTRUCTURE_FUND_ADDRESS;
  const casSwapAddr = env.CAS_SWAP_ADDRESS;
  const casFundTrackerAddr = env.CAS_FUND_TRACKER_ADDRESS;
  const polFundTrackerAddr = env.POL_FUND_TRACKER_ADDRESS;

  console.log(`\n${SEP}`);
  console.log(`  Fix Registry & Swap Binding — Polygon Mainnet`);
  console.log(SEP);
  console.log(`  Diamond:      ${diamondAddr}`);
  console.log(`  Deployer:     ${deployer.address}`);
  console.log(`  CAS Token:    ${casTokenAddr}`);
  console.log(`  InfraFund:    ${infraFundAddr}`);
  console.log(`  CASSwap:      ${casSwapAddr}`);
  console.log(`  CASFundTrack: ${casFundTrackerAddr}`);
  console.log(`  POLFundTrack: ${polFundTrackerAddr}\n`);

  // Pre-flight: estimate gas for all steps
  const steps = [
    { label: "Register CASToken v2", gas: 150_000n },
    { label: "Register InfrastructureFund v2", gas: 150_000n },
    { label: "Register CASSwap v2", gas: 150_000n },
    { label: "Register CASFundTracker v1", gas: 150_000n },
    { label: "Register POLFundTracker v1", gas: 150_000n },
    { label: "setCasSwap() on PaymentFacet", gas: 100_000n },
  ];

  const { gasPrice, balance } = await preFlightCheck(
    "Fix Registry & Swap Binding",
    steps,
    {
      extraInfo: [
        { label: "Network:", value: "Polygon Mainnet (137)" },
      ],
    },
  );

  // Get contract instances
  const contractRegistry = await ethers.getContractAt("ContractRegistryFacet", diamondAddr);
  const paymentFacet = await ethers.getContractAt("PaymentFacet", diamondAddr);

  const results: { label: string; value: string }[] = [];
  const errors: string[] = [];

  // -----------------------------------------------------------------------
  // 1. Re-register CASToken (v2)
  // -----------------------------------------------------------------------
  console.log(`${SUB}\n  1. Re-register CASToken (v2)\n${SUB}`);
  try {
    const isReg = await contractRegistry.isRegistered("CASToken");
    if (isReg) {
      const currentAddr = await contractRegistry["getAddress(string)"]("CASToken");
      const currentVer = await contractRegistry.getCurrentVersion("CASToken");
      console.log(`  Current: ${currentAddr} (v${currentVer})`);
      const newVersion = currentVer + 1n;
      await sendAndVerify(
        `register(CASToken, v${newVersion})`,
        contractRegistry.register("CASToken", newVersion, casTokenAddr, { gasPrice }),
        gasPrice,
      );
      results.push({ label: "CASToken (v" + newVersion + "):", value: casTokenAddr });
    } else {
      await sendAndVerify(
        "register(CASToken, v1)",
        contractRegistry.register("CASToken", 1n, casTokenAddr, { gasPrice }),
        gasPrice,
      );
      results.push({ label: "CASToken (v1):", value: casTokenAddr });
    }
  } catch (err: any) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  FAILED: ${msg?.slice(0, 200)}`);
    errors.push(`CASToken: ${msg?.slice(0, 100)}`);
  }

  // -----------------------------------------------------------------------
  // 2. Re-register InfrastructureFund (v2)
  // -----------------------------------------------------------------------
  console.log(`${SUB}\n  2. Re-register InfrastructureFund (v2)\n${SUB}`);
  try {
    const isReg = await contractRegistry.isRegistered("InfrastructureFund");
    if (isReg) {
      const currentAddr = await contractRegistry["getAddress(string)"]("InfrastructureFund");
      const currentVer = await contractRegistry.getCurrentVersion("InfrastructureFund");
      console.log(`  Current: ${currentAddr} (v${currentVer})`);
      const newVersion = currentVer + 1n;
      await sendAndVerify(
        `register(InfrastructureFund, v${newVersion})`,
        contractRegistry.register("InfrastructureFund", newVersion, infraFundAddr, { gasPrice }),
        gasPrice,
      );
      results.push({ label: "InfrastructureFund (v" + newVersion + "):", value: infraFundAddr });
    } else {
      await sendAndVerify(
        "register(InfrastructureFund, v1)",
        contractRegistry.register("InfrastructureFund", 1n, infraFundAddr, { gasPrice }),
        gasPrice,
      );
      results.push({ label: "InfrastructureFund (v1):", value: infraFundAddr });
    }
  } catch (err: any) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  FAILED: ${msg?.slice(0, 200)}`);
    errors.push(`InfrastructureFund: ${msg?.slice(0, 100)}`);
  }

  // -----------------------------------------------------------------------
  // 3. Re-register CASSwap (v2)
  // -----------------------------------------------------------------------
  console.log(`${SUB}\n  3. Re-register CASSwap (v2)\n${SUB}`);
  try {
    const isReg = await contractRegistry.isRegistered("CASSwap");
    if (isReg) {
      const currentAddr = await contractRegistry["getAddress(string)"]("CASSwap");
      const currentVer = await contractRegistry.getCurrentVersion("CASSwap");
      console.log(`  Current: ${currentAddr} (v${currentVer})`);
      const newVersion = currentVer + 1n;
      await sendAndVerify(
        `register(CASSwap, v${newVersion})`,
        contractRegistry.register("CASSwap", newVersion, casSwapAddr, { gasPrice }),
        gasPrice,
      );
      results.push({ label: "CASSwap (v" + newVersion + "):", value: casSwapAddr });
    } else {
      await sendAndVerify(
        "register(CASSwap, v1)",
        contractRegistry.register("CASSwap", 1n, casSwapAddr, { gasPrice }),
        gasPrice,
      );
      results.push({ label: "CASSwap (v1):", value: casSwapAddr });
    }
  } catch (err: any) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  FAILED: ${msg?.slice(0, 200)}`);
    errors.push(`CASSwap: ${msg?.slice(0, 100)}`);
  }

  // -----------------------------------------------------------------------
  // 4. Register CASFundTracker (v1)
  // -----------------------------------------------------------------------
  console.log(`${SUB}\n  4. Register CASFundTracker (v1)\n${SUB}`);
  try {
    const isReg = await contractRegistry.isRegistered("CASFundTracker");
    if (isReg) {
      const currentAddr = await contractRegistry["getAddress(string)"]("CASFundTracker");
      console.log(`  Already registered at ${currentAddr}, skipping.`);
      results.push({ label: "CASFundTracker:", value: currentAddr });
    } else {
      await sendAndVerify(
        "register(CASFundTracker, v1)",
        contractRegistry.register("CASFundTracker", 1n, casFundTrackerAddr, { gasPrice }),
        gasPrice,
      );
      results.push({ label: "CASFundTracker (v1):", value: casFundTrackerAddr });
    }
  } catch (err: any) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  FAILED: ${msg?.slice(0, 200)}`);
    errors.push(`CASFundTracker: ${msg?.slice(0, 100)}`);
  }

  // -----------------------------------------------------------------------
  // 5. Register POLFundTracker (v1)
  // -----------------------------------------------------------------------
  console.log(`${SUB}\n  5. Register POLFundTracker (v1)\n${SUB}`);
  try {
    const isReg = await contractRegistry.isRegistered("POLFundTracker");
    if (isReg) {
      const currentAddr = await contractRegistry["getAddress(string)"]("POLFundTracker");
      console.log(`  Already registered at ${currentAddr}, skipping.`);
      results.push({ label: "POLFundTracker:", value: currentAddr });
    } else {
      await sendAndVerify(
        "register(POLFundTracker, v1)",
        contractRegistry.register("POLFundTracker", 1n, polFundTrackerAddr, { gasPrice }),
        gasPrice,
      );
      results.push({ label: "POLFundTracker (v1):", value: polFundTrackerAddr });
    }
  } catch (err: any) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  FAILED: ${msg?.slice(0, 200)}`);
    errors.push(`POLFundTracker: ${msg?.slice(0, 100)}`);
  }

  // -----------------------------------------------------------------------
  // 6. Call setCasSwap() on PaymentFacet
  // -----------------------------------------------------------------------
  console.log(`${SUB}\n  6. setCasSwap() on PaymentFacet\n${SUB}`);
  try {
    const currentSwap = await paymentFacet.getCasSwap();
    console.log(`  Current getCasSwap(): ${currentSwap}`);
    if (currentSwap.toLowerCase() === casSwapAddr.toLowerCase()) {
      console.log(`  Already set to correct address, skipping.`);
      results.push({ label: "setCasSwap:", value: "already set" });
    } else {
      await sendAndVerify(
        "setCasSwap()",
        paymentFacet.setCasSwap(casSwapAddr, { gasPrice }),
        gasPrice,
      );
      // Verify
      const newSwap = await paymentFacet.getCasSwap();
      console.log(`  Verified getCasSwap(): ${newSwap}`);
      results.push({ label: "setCasSwap:", value: newSwap });
    }
  } catch (err: any) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  FAILED: ${msg?.slice(0, 200)}`);
    errors.push(`setCasSwap: ${msg?.slice(0, 100)}`);
  }

  // -----------------------------------------------------------------------
  // 7. Verification & Summary
  // -----------------------------------------------------------------------
  console.log(`${SUB}\n  Verification\n${SUB}`);
  const verifyNames = ["CASToken", "InfrastructureFund", "CASSwap", "CASFundTracker", "POLFundTracker"];
  for (const name of verifyNames) {
    try {
      const isReg = await contractRegistry.isRegistered(name);
      if (isReg) {
        const addr = await contractRegistry["getAddress(string)"](name);
        const ver = await contractRegistry.getCurrentVersion(name);
        console.log(`  ✓ ${name}: ${addr} (v${ver})`);
      } else {
        console.log(`  ✗ ${name}: NOT registered`);
      }
    } catch {
      console.log(`  ? ${name}: verification failed`);
    }
  }

  try {
    const casSwapFinal = await paymentFacet.getCasSwap();
    console.log(`  ✓ getCasSwap(): ${casSwapFinal}`);
  } catch {
    console.log(`  ? getCasSwap(): verification failed`);
  }

  await printSummary(
    "Fix Registry & Swap Binding Concluido",
    results,
    balance,
    [
      errors.length > 0
        ? `Errors: ${errors.length} — ${errors.join("; ")}`
        : "All operations completed successfully.",
      `Verify on Polygonscan: ${diamondAddr}`,
    ],
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`\n  Erro: ${error.message ?? error}`);
    process.exit(1);
  });
