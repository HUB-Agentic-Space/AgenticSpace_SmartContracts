import { ethers } from "hardhat";
import {
  SEP, SUB, preFlightCheck, sendAndVerify, printSummary, requireEnv,
} from "../utils/deploy_helpers";

/**
 * Revoke TREASURER_ROLE from relayer on InfrastructureFund.
 * The relayer keeps ADMIN_ROLE but cannot withdraw funds.
 * Only the deployer retains TREASURER_ROLE.
 *
 * Usage:
 *   npx hardhat run scripts/deploy/11_revoke_relayer_treasurer.ts --network polygon
 */
async function main() {
  const [deployer] = await ethers.getSigners();

  const env = requireEnv([
    "INFRASTRUCTURE_FUND_ADDRESS",
    "RELAYER_ADDRESS",
  ]);

  const infraAddr = env.INFRASTRUCTURE_FUND_ADDRESS;
  const relayerAddr = env.RELAYER_ADDRESS;

  console.log(`\n${SEP}`);
  console.log(`  Revoke TREASURER_ROLE from Relayer — InfrastructureFund`);
  console.log(SEP);
  console.log(`  Deployer:    ${deployer.address}`);
  console.log(`  Relayer:     ${relayerAddr}`);
  console.log(`  InfraFund:   ${infraAddr}\n`);

  const steps = [
    { label: "revokeRole(TREASURER, relayer)", gas: 100_000n },
  ];

  const { gasPrice, balance } = await preFlightCheck(
    "Revoke Relayer Treasurer",
    steps,
    {
      extraInfo: [
        { label: "Network:", value: "Polygon Mainnet (137)" },
      ],
    },
  );

  const infra = await ethers.getContractAt("InfrastructureFund", infraAddr);
  const TREASURER_ROLE = await infra.TREASURER_ROLE();
  const ADMIN_ROLE = await infra.DEFAULT_ADMIN_ROLE();

  const results: { label: string; value: string }[] = [];
  const errors: string[] = [];

  console.log(`${SUB}\n  1. Revoke TREASURER_ROLE from relayer\n${SUB}`);
  try {
    const has = await infra.hasRole(TREASURER_ROLE, relayerAddr);
    if (!has) {
      console.log(`  Relayer does not have TREASURER_ROLE, skipping.`);
      results.push({ label: "TREASURER revoked:", value: "already absent" });
    } else {
      await sendAndVerify(
        "revokeRole(TREASURER, relayer)",
        infra.revokeRole(TREASURER_ROLE, relayerAddr, { gasPrice }),
        gasPrice,
      );
      results.push({ label: "TREASURER revoked:", value: relayerAddr });
    }
  } catch (err: any) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  FAILED: ${msg?.slice(0, 200)}`);
    errors.push(`revokeRole: ${msg?.slice(0, 100)}`);
  }

  // Verification
  console.log(`${SUB}\n  Verification\n${SUB}`);
  console.log(`  Relayer ADMIN:     ${await infra.hasRole(ADMIN_ROLE, relayerAddr)}`);
  console.log(`  Relayer TREASURER: ${await infra.hasRole(TREASURER_ROLE, relayerAddr)}`);
  console.log(`  Deployer TREASURER: ${await infra.hasRole(TREASURER_ROLE, deployer.address)}`);

  await printSummary(
    "Revoke TREASURER_ROLE Concluido",
    results,
    balance,
    [
      errors.length > 0
        ? `Errors: ${errors.length} — ${errors.join("; ")}`
        : "TREASURER_ROLE revoked from relayer. Only deployer can withdraw funds.",
    ],
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`\n  Erro: ${error.message ?? error}`);
    process.exit(1);
  });
