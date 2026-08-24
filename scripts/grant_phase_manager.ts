/**
 * Grant PHASE_MANAGER_ROLE to the relayer wallet on RapportCertificate.
 *
 * Usage:
 *   npx hardhat run scripts/grant_phase_manager.ts --network polygon
 *
 * Requires in .env:
 *   RAPPORT_CERTIFICATE_ADDRESS  — proxy address
 *   RELAYER_PRIVATE_KEY          — relayer wallet private key (or ADMIN_PRIVATE_KEY)
 *   CERTIFICATE_ADMIN_ADDRESS    — address holding DEFAULT_ADMIN_ROLE
 */

import { ethers } from "hardhat";

async function main() {
  const certificateAddress = process.env.RAPPORT_CERTIFICATE_ADDRESS?.trim();
  if (!certificateAddress) {
    throw new Error("RAPPORT_CERTIFICATE_ADDRESS not set in .env");
  }

  // Use admin signer (holder of DEFAULT_ADMIN_ROLE) to grant the role
  const adminPrivateKey = process.env.CERTIFICATE_ADMIN_PRIVATE_KEY?.trim() ||
    process.env.RELAYER_PRIVATE_KEY?.trim();
  if (!adminPrivateKey) {
    throw new Error("CERTIFICATE_ADMIN_PRIVATE_KEY or RELAYER_PRIVATE_KEY not set in .env");
  }

  const relayerAddress = process.env.CERTIFICATE_PHASE_MANAGER_ADDRESS?.trim() ||
    process.env.RELAYER_WALLET_ADDRESS?.trim();
  if (!relayerAddress) {
    // Derive from RELAYER_PRIVATE_KEY
    const wallet = new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY!.trim());
    console.log(`[grant_phase_manager] Relayer address derived from RELAYER_PRIVATE_KEY: ${wallet.address}`);
  }

  const targetAddress = relayerAddress || new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY!.trim()).address;

  const provider = ethers.provider;
  const adminWallet = new ethers.Wallet(adminPrivateKey, provider);

  console.log(`[grant_phase_manager] Certificate: ${certificateAddress}`);
  console.log(`[grant_phase_manager] Admin signer: ${adminWallet.address}`);
  console.log(`[grant_phase_manager] Target (relayer): ${targetAddress}`);

  const certificate = await ethers.getContractAt("RapportCertificateUpgradeable", certificateAddress, adminWallet);

  const PHASE_MANAGER_ROLE = await certificate.PHASE_MANAGER_ROLE();
  const hasRole = await certificate.hasRole(PHASE_MANAGER_ROLE, targetAddress);

  if (hasRole) {
    console.log(`[grant_phase_manager] ✅ ${targetAddress} already has PHASE_MANAGER_ROLE`);
    return;
  }

  console.log(`[grant_phase_manager] Granting PHASE_MANAGER_ROLE to ${targetAddress}...`);
  const tx = await certificate.grantRole(PHASE_MANAGER_ROLE, targetAddress);
  console.log(`[grant_phase_manager] TX: ${tx.hash}`);
  await tx.wait();
  console.log(`[grant_phase_manager] ✅ PHASE_MANAGER_ROLE granted to ${targetAddress}`);
}

main().catch((err) => {
  console.error("[grant_phase_manager] ❌", err);
  process.exit(1);
});
