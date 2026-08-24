import { ethers } from "hardhat";
import {
  SEP, SUB, preFlightCheck, sendAndVerify, printSummary, requireEnv,
} from "../utils/deploy_helpers";

/**
 * Grant roles to the relayer address on InfrastructureFund and CASSwap.
 *
 * InfrastructureFund roles: DEFAULT_ADMIN_ROLE, TREASURER_ROLE
 * CASSwap roles: DEFAULT_ADMIN_ROLE, TREASURER_ROLE, RATIO_ADMIN_ROLE
 *
 * Usage:
 *   npx hardhat run scripts/deploy/10_grant_relayer_roles.ts --network polygon
 */
async function main() {
  const [deployer] = await ethers.getSigners();

  const env = requireEnv([
    "INFRASTRUCTURE_FUND_ADDRESS",
    "CAS_SWAP_ADDRESS",
    "RELAYER_ADDRESS",
  ]);

  const infraAddr = env.INFRASTRUCTURE_FUND_ADDRESS;
  const swapAddr = env.CAS_SWAP_ADDRESS;
  const relayerAddr = env.RELAYER_ADDRESS;

  console.log(`\n${SEP}`);
  console.log(`  Grant Relayer Roles — Polygon Mainnet`);
  console.log(SEP);
  console.log(`  Deployer:        ${deployer.address}`);
  console.log(`  Relayer:         ${relayerAddr}`);
  console.log(`  InfraFund:       ${infraAddr}`);
  console.log(`  CASSwap:         ${swapAddr}\n`);

  const steps = [
    { label: "InfraFund grantRole(ADMIN)", gas: 100_000n },
    { label: "InfraFund grantRole(TREASURER)", gas: 100_000n },
    { label: "CASSwap grantRole(ADMIN)", gas: 100_000n },
    { label: "CASSwap grantRole(TREASURER)", gas: 100_000n },
    { label: "CASSwap grantRole(RATIO_ADMIN)", gas: 100_000n },
  ];

  const { gasPrice, balance } = await preFlightCheck(
    "Grant Relayer Roles",
    steps,
    {
      extraInfo: [
        { label: "Network:", value: "Polygon Mainnet (137)" },
      ],
    },
  );

  const results: { label: string; value: string }[] = [];
  const errors: string[] = [];

  // --- InfrastructureFund ---
  const infra = await ethers.getContractAt("InfrastructureFund", infraAddr);

  const ADMIN_ROLE = await infra.DEFAULT_ADMIN_ROLE();
  const TREASURER_ROLE = await infra.TREASURER_ROLE();

  console.log(`${SUB}\n  1. InfrastructureFund — grantRole(ADMIN)\n${SUB}`);
  try {
    const has = await infra.hasRole(ADMIN_ROLE, relayerAddr);
    if (has) {
      console.log(`  Already has ADMIN_ROLE, skipping.`);
      results.push({ label: "InfraFund ADMIN:", value: "already set" });
    } else {
      await sendAndVerify(
        "grantRole(ADMIN)",
        infra.grantRole(ADMIN_ROLE, relayerAddr, { gasPrice }),
        gasPrice,
      );
      results.push({ label: "InfraFund ADMIN:", value: relayerAddr });
    }
  } catch (err: any) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  FAILED: ${msg?.slice(0, 200)}`);
    errors.push(`InfraFund ADMIN: ${msg?.slice(0, 100)}`);
  }

  console.log(`${SUB}\n  2. InfrastructureFund — grantRole(TREASURER)\n${SUB}`);
  try {
    const has = await infra.hasRole(TREASURER_ROLE, relayerAddr);
    if (has) {
      console.log(`  Already has TREASURER_ROLE, skipping.`);
      results.push({ label: "InfraFund TREASURER:", value: "already set" });
    } else {
      await sendAndVerify(
        "grantRole(TREASURER)",
        infra.grantRole(TREASURER_ROLE, relayerAddr, { gasPrice }),
        gasPrice,
      );
      results.push({ label: "InfraFund TREASURER:", value: relayerAddr });
    }
  } catch (err: any) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  FAILED: ${msg?.slice(0, 200)}`);
    errors.push(`InfraFund TREASURER: ${msg?.slice(0, 100)}`);
  }

  // --- CASSwap ---
  const swap = await ethers.getContractAt("CASSwap", swapAddr);

  const SWAP_ADMIN_ROLE = await swap.DEFAULT_ADMIN_ROLE();
  const SWAP_TREASURER_ROLE = await swap.TREASURER_ROLE();
  const RATIO_ADMIN_ROLE = await swap.RATIO_ADMIN_ROLE();

  console.log(`${SUB}\n  3. CASSwap — grantRole(ADMIN)\n${SUB}`);
  try {
    const has = await swap.hasRole(SWAP_ADMIN_ROLE, relayerAddr);
    if (has) {
      console.log(`  Already has ADMIN_ROLE, skipping.`);
      results.push({ label: "CASSwap ADMIN:", value: "already set" });
    } else {
      await sendAndVerify(
        "grantRole(ADMIN)",
        swap.grantRole(SWAP_ADMIN_ROLE, relayerAddr, { gasPrice }),
        gasPrice,
      );
      results.push({ label: "CASSwap ADMIN:", value: relayerAddr });
    }
  } catch (err: any) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  FAILED: ${msg?.slice(0, 200)}`);
    errors.push(`CASSwap ADMIN: ${msg?.slice(0, 100)}`);
  }

  console.log(`${SUB}\n  4. CASSwap — grantRole(TREASURER)\n${SUB}`);
  try {
    const has = await swap.hasRole(SWAP_TREASURER_ROLE, relayerAddr);
    if (has) {
      console.log(`  Already has TREASURER_ROLE, skipping.`);
      results.push({ label: "CASSwap TREASURER:", value: "already set" });
    } else {
      await sendAndVerify(
        "grantRole(TREASURER)",
        swap.grantRole(SWAP_TREASURER_ROLE, relayerAddr, { gasPrice }),
        gasPrice,
      );
      results.push({ label: "CASSwap TREASURER:", value: relayerAddr });
    }
  } catch (err: any) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  FAILED: ${msg?.slice(0, 200)}`);
    errors.push(`CASSwap TREASURER: ${msg?.slice(0, 100)}`);
  }

  console.log(`${SUB}\n  5. CASSwap — grantRole(RATIO_ADMIN)\n${SUB}`);
  try {
    const has = await swap.hasRole(RATIO_ADMIN_ROLE, relayerAddr);
    if (has) {
      console.log(`  Already has RATIO_ADMIN_ROLE, skipping.`);
      results.push({ label: "CASSwap RATIO_ADMIN:", value: "already set" });
    } else {
      await sendAndVerify(
        "grantRole(RATIO_ADMIN)",
        swap.grantRole(RATIO_ADMIN_ROLE, relayerAddr, { gasPrice }),
        gasPrice,
      );
      results.push({ label: "CASSwap RATIO_ADMIN:", value: relayerAddr });
    }
  } catch (err: any) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  FAILED: ${msg?.slice(0, 200)}`);
    errors.push(`CASSwap RATIO_ADMIN: ${msg?.slice(0, 100)}`);
  }

  // --- Verification ---
  console.log(`${SUB}\n  Verification\n${SUB}`);
  console.log(`  InfrastructureFund:`);
  console.log(`    ADMIN(relayer):     ${await infra.hasRole(ADMIN_ROLE, relayerAddr)}`);
  console.log(`    TREASURER(relayer): ${await infra.hasRole(TREASURER_ROLE, relayerAddr)}`);
  console.log(`  CASSwap:`);
  console.log(`    ADMIN(relayer):     ${await swap.hasRole(SWAP_ADMIN_ROLE, relayerAddr)}`);
  console.log(`    TREASURER(relayer): ${await swap.hasRole(SWAP_TREASURER_ROLE, relayerAddr)}`);
  console.log(`    RATIO_ADMIN(relayer): ${await swap.hasRole(RATIO_ADMIN_ROLE, relayerAddr)}`);

  await printSummary(
    "Grant Relayer Roles Concluido",
    results,
    balance,
    [
      errors.length > 0
        ? `Errors: ${errors.length} — ${errors.join("; ")}`
        : "All roles granted successfully.",
    ],
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`\n  Erro: ${error.message ?? error}`);
    process.exit(1);
  });
