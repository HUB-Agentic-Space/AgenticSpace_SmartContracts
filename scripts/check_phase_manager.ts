/**
 * Check PHASE_MANAGER_ROLE status on RapportCertificate.
 *
 * Usage:
 *   npx hardhat run scripts/check_phase_manager.ts --network polygon
 */

import { ethers } from "hardhat";

async function main() {
  const certificateAddress = process.env.RAPPORT_CERTIFICATE_ADDRESS?.trim();
  if (!certificateAddress) {
    throw new Error("RAPPORT_CERTIFICATE_ADDRESS not set in .env");
  }

  const cert = await ethers.getContractAt("RapportCertificateUpgradeable", certificateAddress);

  const PHASE_MANAGER_ROLE = await cert.PHASE_MANAGER_ROLE();
  const DEFAULT_ADMIN_ROLE = await cert.DEFAULT_ADMIN_ROLE();

  const relayerKey = process.env.RELAYER_PRIVATE_KEY?.trim();
  if (relayerKey) {
    const relayer = new ethers.Wallet(relayerKey);
    console.log(`Relayer address: ${relayer.address}`);
    console.log(`  Has PHASE_MANAGER_ROLE: ${await cert.hasRole(PHASE_MANAGER_ROLE, relayer.address)}`);
    console.log(`  Has DEFAULT_ADMIN_ROLE: ${await cert.hasRole(DEFAULT_ADMIN_ROLE, relayer.address)}`);
  }

  const adminAddr = process.env.CERTIFICATE_ADMIN_ADDRESS?.trim();
  if (adminAddr) {
    console.log(`Admin address: ${adminAddr}`);
    console.log(`  Has DEFAULT_ADMIN_ROLE: ${await cert.hasRole(DEFAULT_ADMIN_ROLE, adminAddr)}`);
    console.log(`  Has PHASE_MANAGER_ROLE: ${await cert.hasRole(PHASE_MANAGER_ROLE, adminAddr)}`);
  }

  // Also check ISSUER_ROLE for the relayer
  const ISSUER_ROLE = await cert.ISSUER_ROLE();
  if (relayerKey) {
    const relayer = new ethers.Wallet(relayerKey);
    console.log(`  Has ISSUER_ROLE: ${await cert.hasRole(ISSUER_ROLE, relayer.address)}`);
  }

  // Check bootstrap admin
  const bootstrapAddr = process.env.CERTIFICATE_BOOTSTRAP_ADMIN_ADDRESS?.trim();
  if (bootstrapAddr) {
    console.log(`\nBootstrap admin address: ${bootstrapAddr}`);
    console.log(`  Has DEFAULT_ADMIN_ROLE: ${await cert.hasRole(DEFAULT_ADMIN_ROLE, bootstrapAddr)}`);
    console.log(`  Has PHASE_MANAGER_ROLE: ${await cert.hasRole(PHASE_MANAGER_ROLE, bootstrapAddr)}`);
    const code = await ethers.provider.getCode(bootstrapAddr);
    console.log(`  Is contract: ${code !== "0x"}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
