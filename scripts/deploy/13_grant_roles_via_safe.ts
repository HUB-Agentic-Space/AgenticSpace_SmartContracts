import { ethers } from "hardhat";
import * as dotenv from "dotenv";

dotenv.config();

/**
 * Grants TRUSTED_CALLER_ROLE to the deployer and ISSUER_ROLE to the relayer
 * on the RapportCertificateUpgradeable proxy, using the Safe owner key
 * to execute through the Gnosis Safe proxy.
 *
 * The Safe proxy at 0x1743... delegates to the Safe implementation.
 * We use execTransaction() to call grantRole on the certificate contract.
 *
 * Usage:
 *   npx hardhat run scripts/deploy/13_grant_roles_via_safe.ts --network polygon
 */

const SAFE_ADDRESS = process.env.CERTIFICATE_ADMIN_ADDRESS || "";
const SAFE_OWNER_PRIVATE_KEY = process.env.SAFE_OWNER_PRIVATE_KEY || "";
const NEW_CERT_ADDRESS = process.env.RAPPORT_CERTIFICATE_ADDRESS || "";

// Gnosis Safe v1.3.0 execTransaction ABI
const SAFE_ABI = [
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) external payable returns (bool success)",
  "function nonce() public view returns (uint256)",
  "function getThreshold() public view returns (uint256)",
  "function getOwners() public view returns (address[])",
  "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) public view returns (bytes32)",
];

const CERT_ABI = [
  "function grantRole(bytes32 role, address account) external",
  "function TRUSTED_CALLER_ROLE() view returns (bytes32)",
  "function ISSUER_ROLE() view returns (bytes32)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
];

async function main() {
  if (!SAFE_ADDRESS || !SAFE_OWNER_PRIVATE_KEY || !NEW_CERT_ADDRESS) {
    console.error("SAFE_ADDRESS, SAFE_OWNER_PRIVATE_KEY, and RAPPORT_CERTIFICATE_ADDRESS must be set");
    process.exit(1);
  }

  const [deployer] = await ethers.getSigners();
  const provider = ethers.provider;
  const chainId = (await provider.getNetwork()).chainId;

  const safeOwner = new ethers.Wallet(SAFE_OWNER_PRIVATE_KEY, provider);
  const safe = new ethers.Contract(SAFE_ADDRESS, SAFE_ABI, safeOwner);
  const cert = new ethers.Contract(NEW_CERT_ADDRESS, CERT_ABI, provider);

  console.log(`\n========================================================================`);
  console.log("  Grant Roles via Gnosis Safe");
  console.log(`========================================================================`);
  console.log(`  Safe address:      ${SAFE_ADDRESS}`);
  console.log(`  Safe owner:        ${safeOwner.address}`);
  console.log(`  Cert proxy:        ${NEW_CERT_ADDRESS}`);
  console.log(`  Deployer (target): ${deployer.address}`);
  console.log(`  Chain ID:          ${chainId}`);

  // Verify Safe owners
  const owners = await safe.getOwners();
  console.log(`  Safe owners:       ${owners.join(", ")}`);
  const threshold = await safe.getThreshold();
  console.log(`  Safe threshold:    ${threshold}`);

  const isOwner = owners.some(
    (o: string) => o.toLowerCase() === safeOwner.address.toLowerCase(),
  );
  if (!isOwner) {
    console.error(`  ❌ Safe owner key does not match any Safe owner.`);
    process.exit(1);
  }

  const TRUSTED_CALLER_ROLE = await cert.TRUSTED_CALLER_ROLE();
  const ISSUER_ROLE = await cert.ISSUER_ROLE();

  // Check current roles
  const deployerHasTrusted = await cert.hasRole(TRUSTED_CALLER_ROLE, deployer.address);
  const relayerAddress = process.env.RELAYER_PRIVATE_KEY
    ? new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY).address
    : safeOwner.address;
  const relayerHasIssuer = await cert.hasRole(ISSUER_ROLE, relayerAddress);

  console.log(`\n  Deployer has TRUSTED_CALLER_ROLE: ${deployerHasTrusted ? "✅" : "❌"}`);
  console.log(`  Relayer has ISSUER_ROLE:          ${relayerHasIssuer ? "✅" : "❌"}`);

  // Build grantRole transactions
  const grants: { role: string; target: string; label: string }[] = [];

  if (!deployerHasTrusted) {
    grants.push({
      role: TRUSTED_CALLER_ROLE,
      target: deployer.address,
      label: "TRUSTED_CALLER_ROLE → deployer",
    });
  }

  if (!relayerHasIssuer) {
    grants.push({
      role: ISSUER_ROLE,
      target: relayerAddress,
      label: "ISSUER_ROLE → relayer",
    });
  }

  if (grants.length === 0) {
    console.log(`\n  ✅ All roles already granted. Nothing to do.`);
    return;
  }

  // Execute each grantRole via Safe
  for (const grant of grants) {
    console.log(`\n  Granting ${grant.label}...`);

    // Build grantRole calldata
    const certInterface = new ethers.Interface(CERT_ABI);
    const data = certInterface.encodeFunctionData("grantRole", [grant.role, grant.target]);

    // Get current Safe nonce
    const nonce = await safe.nonce();
    console.log(`    Safe nonce: ${nonce}`);

    // Build Safe transaction hash
    const txHash = await safe.getTransactionHash(
      NEW_CERT_ADDRESS, // to
      0,                // value
      data,             // data
      0,                // operation (CALL)
      0,                // safeTxGas
      0,                // baseGas
      0,                // gasPrice
      ethers.ZeroAddress, // gasToken
      ethers.ZeroAddress, // refundReceiver
      nonce,            // nonce
    );

    // Sign the transaction hash (threshold=1, so one signature is enough)
    // For Safe v1.3.0 with threshold 1, the signature format is:
    // r = owner address padded to 32 bytes, s = 0, v = 1 (approved hash)
    // Actually, for EOA owners, we sign the hash with personal_sign (EIP-191)
    const signature = await safeOwner.signingKey.sign(txHash);

    // Safe expects signatures in the format: r (32) + s (32) + v (1)
    // For an EOA owner, v should be adjusted: v + 4 for on-chain approval, or just v
    const sig = ethers.concat([
      signature.r,
      signature.s,
      ethers.toBeArray(signature.v),
    ]);

    console.log(`    Signature: ${sig.slice(0, 20)}...`);

    // Execute the transaction via Safe
    // Use the deployer as the gas payer (relayer) for the Safe execTransaction
    const safeWithDeployer = safe.connect(deployer);
    try {
      const tx = await safeWithDeployer.execTransaction(
        NEW_CERT_ADDRESS,
        0,
        data,
        0,                // operation
        0,                // safeTxGas
        0,                // baseGas
        0,                // gasPrice
        ethers.ZeroAddress,
        ethers.ZeroAddress,
        sig,
      );
      const receipt = await tx.wait();
      console.log(`    ✅ Granted! txHash: ${receipt?.hash}`);

      // Verify
      const hasRoleNow = await cert.hasRole(grant.role, grant.target);
      console.log(`    Verified: ${hasRoleNow ? "✅" : "❌"}`);
    } catch (err: any) {
      console.log(`    ❌ Failed: ${err.message?.slice(0, 200)}`);
    }
  }

  console.log(`\n========================================================================`);
  console.log("  Done");
  console.log(`========================================================================`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
