/**
 * Grant PHASE_MANAGER_ROLE to the relayer via Gnosis Safe transaction.
 *
 * Usage:
 *   npx hardhat run scripts/grant_phase_manager_via_safe.ts --network polygon
 *
 * Requires in .env:
 *   RAPPORT_CERTIFICATE_ADDRESS  — proxy address
 *   RELAYER_PRIVATE_KEY          — relayer wallet (to derive target address)
 *   SAFE_OWNER_PRIVATE_KEY       — Safe owner's private key
 */

import { ethers } from "hardhat";

async function main() {
  const certificateAddress = process.env.RAPPORT_CERTIFICATE_ADDRESS?.trim();
  if (!certificateAddress) {
    throw new Error("RAPPORT_CERTIFICATE_ADDRESS not set in .env");
  }

  const safeProxy = "0x1743abe1A64DAB3c81e394adb4e3B56ef05F0D26";
  const safeOwnerKey = process.env.SAFE_OWNER_PRIVATE_KEY?.trim();
  if (!safeOwnerKey) {
    throw new Error("SAFE_OWNER_PRIVATE_KEY not set in .env");
  }

  const relayerKey = process.env.RELAYER_PRIVATE_KEY?.trim();
  if (!relayerKey) {
    throw new Error("RELAYER_PRIVATE_KEY not set in .env");
  }

  const relayer = new ethers.Wallet(relayerKey);
  const owner = new ethers.Wallet(safeOwnerKey, ethers.provider);

  console.log(`[grant_phase_manager] Certificate: ${certificateAddress}`);
  console.log(`[grant_phase_manager] Safe proxy: ${safeProxy}`);
  console.log(`[grant_phase_manager] Safe owner: ${owner.address}`);
  console.log(`[grant_phase_manager] Target (relayer): ${relayer.address}`);

  // Verify owner matches Safe owner
  const safeAbi = [
    "function getOwners() view returns (address[])",
    "function getThreshold() view returns (uint256)",
    "function nonce() view returns (uint256)",
    "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes signatures) payable returns (bool success)",
    "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, uint256 nonce) view returns (bytes32)",
  ];

  const safe = new ethers.Contract(safeProxy, safeAbi, ethers.provider);
  const owners = await safe.getOwners();
  const threshold = await safe.getThreshold();
  const nonce = await safe.nonce();

  console.log(`[grant_phase_manager] Safe threshold: ${threshold}, nonce: ${nonce}`);
  console.log(`[grant_phase_manager] Safe owners: ${owners.join(", ")}`);

  if (!owners.some((o: string) => o.toLowerCase() === owner.address.toLowerCase())) {
    throw new Error(`Safe owner ${owner.address} is not in Safe owners list: ${owners.join(", ")}`);
  }

  // Check if relayer already has the role
  const cert = await ethers.getContractAt("RapportCertificateUpgradeable", certificateAddress);
  const PHASE_MANAGER_ROLE = await cert.PHASE_MANAGER_ROLE();
  const hasRole = await cert.hasRole(PHASE_MANAGER_ROLE, relayer.address);
  if (hasRole) {
    console.log(`[grant_phase_manager] ✅ ${relayer.address} already has PHASE_MANAGER_ROLE`);
    return;
  }

  // Encode grantRole(PHASE_MANAGER_ROLE, relayer.address)
  const grantRoleData = cert.interface.encodeFunctionData("grantRole", [
    PHASE_MANAGER_ROLE,
    relayer.address,
  ]);

  console.log(`[grant_phase_manager] grantRole data: ${grantRoleData}`);

  // Build Safe transaction
  const to = certificateAddress;
  const value = 0n;
  const data = grantRoleData;
  const operation = 0; // Call
  const safeTxGas = 0n;
  const baseGas = 0n;
  const gasPrice = 0n;
  const gasToken = ethers.ZeroAddress;
  const refundReceiver = ethers.ZeroAddress;

  // Get transaction hash
  const txHash = await safe.getTransactionHash(
    to, value, data, operation,
    safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, nonce,
  );

  console.log(`[grant_phase_manager] Safe tx hash: ${txHash}`);

  // Sign with owner key (threshold = 1, so one signature is enough)
  // For an EOA owner, we use a standard EIP-191 signature (v = 27 or 28)
  // The Safe decodes signature type from the last byte:
  //   0x00-0x01: contract signature (EIP-1271)
  //   0x1b-0x1c (27-28): ECDSA signature (approved hash)
  //   0x1f-0x20 (31-32): eth_sign signature
  // We sign the approved hash (getTransactionHash) directly, so v stays 27/28.
  const signature = await owner.signingKey.sign(ethers.getBytes(txHash));
  const sig = ethers.concat([
    signature.r,
    signature.s,
    ethers.toBeHex(signature.v),
  ]);

  console.log(`[grant_phase_manager] Signature: ${sig}`);

  // Execute transaction
  console.log(`[grant_phase_manager] Executing Safe transaction...`);
  const tx = await safe.connect(owner).execTransaction(
    to, value, data, operation,
    safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, sig,
    { gasLimit: 300000 },
  );

  console.log(`[grant_phase_manager] TX: ${tx.hash}`);
  const receipt = await tx.wait();
  if (receipt?.status === 1) {
    console.log(`[grant_phase_manager] ✅ PHASE_MANAGER_ROLE granted to ${relayer.address}`);
  } else {
    console.log(`[grant_phase_manager] ❌ Transaction reverted`);
  }
}

main().catch((err) => {
  console.error("[grant_phase_manager] ❌", err);
  process.exit(1);
});
