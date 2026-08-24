/**
 * Check all role holders on RapportCertificate.
 * Queries RoleGranted events to find who holds each role.
 *
 * Usage:
 *   npx hardhat run scripts/check_role_holders.ts --network polygon
 */

import { ethers } from "hardhat";

async function main() {
  const certificateAddress = process.env.RAPPORT_CERTIFICATE_ADDRESS?.trim();
  if (!certificateAddress) {
    throw new Error("RAPPORT_CERTIFICATE_ADDRESS not set in .env");
  }

  const cert = await ethers.getContractAt("RapportCertificateUpgradeable", certificateAddress);

  const DEFAULT_ADMIN_ROLE = await cert.DEFAULT_ADMIN_ROLE();
  const PHASE_MANAGER_ROLE = await cert.PHASE_MANAGER_ROLE();
  const ISSUER_ROLE = await cert.ISSUER_ROLE();
  const REVOKER_ROLE = await cert.REVOKER_ROLE();
  const PAUSER_ROLE = await cert.PAUSER_ROLE();
  const BONUS_MANAGER_ROLE = await cert.BONUS_MANAGER_ROLE();

  // Query RoleGranted events from genesis
  const currentBlock = await ethers.provider.getBlockNumber();
  const CHUNK_SIZE = 9000;

  const grantedFilter = cert.filters.RoleGranted();
  const revokedFilter = cert.filters.RoleRevoked();

  console.log(`Scanning events in chunks of ${CHUNK_SIZE} from 0 to ${currentBlock}...`);

  const allGranted: any[] = [];
  const allRevoked: any[] = [];

  for (let from = 0; from <= currentBlock; from += CHUNK_SIZE) {
    const to = Math.min(from + CHUNK_SIZE - 1, currentBlock);
    try {
      const [granted, revoked] = await Promise.all([
        cert.queryFilter(grantedFilter, from, to),
        cert.queryFilter(revokedFilter, from, to),
      ]);
      allGranted.push(...granted);
      allRevoked.push(...revoked);
    } catch (err: any) {
      console.log(`  Chunk ${from}-${to} failed: ${err.message?.slice(0, 80)}`);
    }
  }

  console.log(`Found ${allGranted.length} RoleGranted and ${allRevoked.length} RoleRevoked events`);

  // Now verify on-chain
  const roles = [
    { name: "DEFAULT_ADMIN_ROLE", hash: DEFAULT_ADMIN_ROLE },
    { name: "PHASE_MANAGER_ROLE", hash: PHASE_MANAGER_ROLE },
    { name: "ISSUER_ROLE", hash: ISSUER_ROLE },
    { name: "REVOKER_ROLE", hash: REVOKER_ROLE },
    { name: "PAUSER_ROLE", hash: PAUSER_ROLE },
    { name: "BONUS_MANAGER_ROLE", hash: BONUS_MANAGER_ROLE },
  ];

  // Collect unique accounts from granted events
  const allAccounts = new Set<string>();
  for (const ev of allGranted) {
    allAccounts.add(ev.args.account);
  }

  console.log(`\nUnique accounts that ever received a role: ${allAccounts.size}`);
  for (const account of allAccounts) {
    console.log(`\n  Account: ${account}`);
    for (const role of roles) {
      const has = await cert.hasRole(role.hash, account);
      if (has) {
        console.log(`    ✅ ${role.name}`);
      }
    }
  }

  // Also check the relayer specifically
  const relayerKey = process.env.RELAYER_PRIVATE_KEY?.trim();
  if (relayerKey) {
    const relayer = new ethers.Wallet(relayerKey);
    console.log(`\n  Relayer: ${relayer.address}`);
    for (const role of roles) {
      const has = await cert.hasRole(role.hash, relayer.address);
      console.log(`    ${has ? "✅" : "❌"} ${role.name}`);
    }
  }

  // Check if admin is a contract
  const adminAddr = process.env.CERTIFICATE_ADMIN_ADDRESS?.trim();
  if (adminAddr) {
    const code = await ethers.provider.getCode(adminAddr);
    console.log(`\n  Admin (${adminAddr}) is ${code === "0x" ? "an EOA" : "a CONTRACT"} (code length: ${code.length})`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
