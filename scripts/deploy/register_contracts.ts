import { ethers } from "hardhat";
import {
  SEP, SUB, preFlightCheck, sendAndVerify, printSummary, requireEnv,
} from "../utils/deploy_helpers";

/**
 * Register external contracts (Faucet, CASSwap, etc.) in the Diamond
 * ContractRegistryFacet.
 *
 * This script is useful when:
 *   - The Diamond was already deployed and you deployed Faucet/CASSwap later.
 *   - You need to re-register or update a contract address in the registry.
 *   - The deploy scripts did not register the contract automatically.
 *
 * Prerequisites:
 *   - DIAMOND_ADDRESS must be set in .env
 *   - The caller must be the Diamond owner or have REGISTRAR_ROLE.
 *   - FAUCET_ADDRESS and/or CAS_SWAP_ADDRESS must be set in .env.
 *
 * Usage:
 *   npx hardhat run scripts/deploy/register_contracts.ts --network polygonAmoy
 *
 * Optional env vars:
 *   REGISTER_FAUCET=1          — Force Faucet registration (default: if FAUCET_ADDRESS set)
 *   REGISTER_CAS_SWAP=1        — Force CASSwap registration (default: if CAS_SWAP_ADDRESS set)
 *   REGISTER_CAS_MIGRATION=1   — Force CASMigration registration (default: if CAS_MIGRATION_ADDRESS set)
 *   REGISTER_RAPPORT_CERTIFICATE=1 — Force certificate registration
 */

interface ContractToRegister {
  name: string;
  envVar: string;
  forceEnvVar: string;
  version: bigint;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const env = requireEnv(["DIAMOND_ADDRESS"]);
  const diamondAddr = env.DIAMOND_ADDRESS;

  const contractsToRegister: ContractToRegister[] = [
    { name: "Faucet",          envVar: "FAUCET_ADDRESS",         forceEnvVar: "REGISTER_FAUCET",       version: 1n },
    { name: "CASSwap",         envVar: "CAS_SWAP_ADDRESS",       forceEnvVar: "REGISTER_CAS_SWAP",     version: 1n },
    { name: "CASMigration",    envVar: "CAS_MIGRATION_ADDRESS",  forceEnvVar: "REGISTER_CAS_MIGRATION",version: 1n },
    { name: "RapportCertificate", envVar: "RAPPORT_CERTIFICATE_ADDRESS", forceEnvVar: "REGISTER_RAPPORT_CERTIFICATE", version: 1n },
  ];

  // Filter to contracts that have an address set
  const pending = contractsToRegister.filter(
    (c) => process.env[c.envVar] && process.env[c.envVar] !== "",
  );

  if (pending.length === 0) {
    console.error(`${SEP}\n  No contract addresses found in .env to register.\n${SEP}`);
    console.error(`  Set at least one of: FAUCET_ADDRESS, CAS_SWAP_ADDRESS, CAS_MIGRATION_ADDRESS, RAPPORT_CERTIFICATE_ADDRESS`);
    process.exitCode = 1;
    return;
  }

  // Pre-flight: estimate gas for each registration
  const steps = pending.map((c) => ({
    label: `Register ${c.name}`,
    gas: 150_000n,
  }));

  const { gasPrice, balance } = await preFlightCheck(
    "Register Contracts in Diamond",
    steps,
    {
      extraInfo: [
        { label: "Diamond:", value: diamondAddr },
        { label: "Caller:", value: deployer.address },
        ...pending.map((c) => ({
          label: `${c.name}:`,
          value: process.env[c.envVar] || "(not set)",
        })),
      ],
    },
  );

  const contractRegistry = await ethers.getContractAt("ContractRegistryFacet", diamondAddr);
  const paymentFacet = await ethers.getContractAt("PaymentFacet", diamondAddr);

  const registered: { name: string; address: string; version: bigint }[] = [];
  const skipped: { name: string; reason: string }[] = [];

  for (const c of pending) {
    const addr = process.env[c.envVar]!;
    console.log(`${SUB}\n  Processing ${c.name} at ${addr}`);

    try {
      const isReg = await contractRegistry.isRegistered(c.name);

      if (isReg) {
        const currentAddr = await contractRegistry["getAddress(string)"](c.name);
        if (currentAddr.toLowerCase() === addr.toLowerCase()) {
          console.log(`  [register] ${c.name} already registered at same address, skipping.`);
          skipped.push({ name: c.name, reason: "already registered at same address" });
          continue;
        }

        // Address changed — need to register with a higher version
        const currentVersion = await contractRegistry.getCurrentVersion(c.name);
        const newVersion = currentVersion + 1n;
        console.log(`  [register] ${c.name} address changed, updating to version ${newVersion}...`);

        await sendAndVerify(
          `register(${c.name}, v${newVersion})`,
          contractRegistry.register(c.name, newVersion, addr, { gasPrice }),
          gasPrice,
        );

        registered.push({ name: c.name, address: addr, version: newVersion });
      } else {
        // New registration
        await sendAndVerify(
          `register(${c.name}, v${c.version})`,
          contractRegistry.register(c.name, c.version, addr, { gasPrice }),
          gasPrice,
        );

        registered.push({ name: c.name, address: addr, version: c.version });
        console.log(`  [register] ${c.name} registered at version ${c.version}.`);
      }

      if (c.name === "CASSwap") {
        try {
          const current = await paymentFacet.getCasSwap();
          if (current.toLowerCase() !== addr.toLowerCase()) {
            await paymentFacet.setCasSwap.estimateGas(addr);
            await (await paymentFacet.setCasSwap(addr, { gasPrice })).wait();
            console.log(`  [register] PaymentFacet.casSwap updated to: ${addr}`);
          } else {
            console.log(`  [register] PaymentFacet.casSwap already up to date.`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`  [register] Could not update PaymentFacet.casSwap: ${msg}`);
          console.warn(`  [register] Only the Diamond owner can call setCasSwap.`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  [register] Failed to register ${c.name}: ${msg}`);
      skipped.push({ name: c.name, reason: msg });
    }
  }

  // Verify registrations
  console.log(`\n${SUB}\n  Verification:\n${SUB}`);
  for (const c of pending) {
    try {
      const isReg = await contractRegistry.isRegistered(c.name);
      if (isReg) {
        const addr = await contractRegistry["getAddress(string)"](c.name);
        const ver = await contractRegistry.getCurrentVersion(c.name);
        console.log(`  ✓ ${c.name}: ${addr} (v${ver})`);
      } else {
        console.log(`  ✗ ${c.name}: NOT registered`);
      }
    } catch {
      console.log(`  ✗ ${c.name}: verification failed`);
    }
  }

  await printSummary(
    "Contract Registration Concluido",
    registered.map((r) => ({ label: `${r.name} (v${r.version}):`, value: r.address })),
    balance,
    [
      registered.length > 0
        ? `Successfully registered ${registered.length} contract(s).`
        : "No new contracts were registered.",
      skipped.length > 0
        ? `Skipped ${skipped.length}: ${skipped.map((s) => s.name).join(", ")}`
        : "",
      `Verify on Polygonscan: ${diamondAddr}`,
    ].filter((s) => s !== ""),
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`\n  Erro: ${error.message ?? error}`);
    process.exit(1);
  });
