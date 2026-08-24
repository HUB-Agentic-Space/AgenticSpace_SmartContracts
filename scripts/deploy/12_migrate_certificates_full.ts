import { ethers } from "hardhat";
import * as dotenv from "dotenv";

dotenv.config();

/**
 * Full migration script: mints all certificates from the old RapportCertificate
 * into the new RapportCertificateUpgradeable (UUPS proxy).
 *
 * Prerequisites:
 *   - Deployer must have POL for gas
 *   - Deployer must be granted TRUSTED_CALLER_ROLE on the new proxy
 *   - Issuer wallet must have ISSUER_ROLE on the new proxy
 *   - Deployer or issuer must have enough CAS tokens for all deposits
 *   - Phase 1 must be active on the new proxy
 *
 * Steps per certificate:
 *   1. Read certificate data from the old contract
 *   2. Transfer CAS to the new contract (via depositCasForMintFor)
 *   3. Generate EIP-712 authorization signature (issuer wallet)
 *   4. Call mintCertificate (as TRUSTED_CALLER on behalf of recipient)
 *   5. Migrate document hash, Merkle root, and Merkle root proof if present
 *
 * Usage:
 *   npx hardhat run scripts/deploy/12_migrate_certificates_full.ts --network polygon
 */

const OLD_CERT_ADDRESS = process.env.OLD_RAPPORT_CERTIFICATE_ADDRESS || "";
const NEW_CERT_ADDRESS = process.env.RAPPORT_CERTIFICATE_ADDRESS || "";
const ISSUER_PRIVATE_KEY = process.env.CERTIFICATE_ISSUER_PRIVATE_KEY ||
  process.env.RELAYER_PRIVATE_KEY || "";

const MINT_AUTH_TYPE = {
  CertificateMintAuthorization: [
    { name: "issuanceId", type: "bytes32" },
    { name: "recipient", type: "address" },
    { name: "nameHash", type: "bytes32" },
    { name: "phaseId", type: "uint256" },
    { name: "metadataHash", type: "bytes32" },
    { name: "casAmount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

async function main() {
  if (!OLD_CERT_ADDRESS || !NEW_CERT_ADDRESS) {
    console.error("OLD_RAPPORT_CERTIFICATE_ADDRESS and RAPPORT_CERTIFICATE_ADDRESS must be set");
    process.exit(1);
  }
  if (!ISSUER_PRIVATE_KEY) {
    console.error("CERTIFICATE_ISSUER_PRIVATE_KEY or RELAYER_PRIVATE_KEY must be set");
    process.exit(1);
  }

  const [deployer] = await ethers.getSigners();
  const chainId = (await ethers.provider.getNetwork()).chainId;

  console.log(`\n========================================================================`);
  console.log("  Certificate Full Migration");
  console.log(`========================================================================`);
  console.log(`  Deployer:        ${deployer.address}`);
  console.log(`  Old contract:    ${OLD_CERT_ADDRESS}`);
  console.log(`  New proxy:       ${NEW_CERT_ADDRESS}`);
  console.log(`  Chain ID:        ${chainId}`);

  const issuerWallet = new ethers.Wallet(ISSUER_PRIVATE_KEY, ethers.provider);
  console.log(`  Issuer wallet:   ${issuerWallet.address}`);

  const oldCert = await ethers.getContractAt("RapportCertificate", OLD_CERT_ADDRESS);
  const newCert = await ethers.getContractAt("RapportCertificateUpgradeable", NEW_CERT_ADDRESS);

  // --- Role checks ---
  const TRUSTED_CALLER_ROLE = await newCert.TRUSTED_CALLER_ROLE();
  const hasTrustedCaller = await newCert.hasRole(TRUSTED_CALLER_ROLE, deployer.address);
  if (!hasTrustedCaller) {
    console.log(`\n  ⚠️  Deployer does not have TRUSTED_CALLER_ROLE. Granting now...`);
    const DEFAULT_ADMIN_ROLE = await newCert.DEFAULT_ADMIN_ROLE();
    const isAdmin = await newCert.hasRole(DEFAULT_ADMIN_ROLE, deployer.address);
    if (!isAdmin) {
      console.error(`  ❌ Deployer is not admin. Cannot grant TRUSTED_CALLER_ROLE.`);
      process.exit(1);
    }
    const grantTx = await newCert.grantRole(TRUSTED_CALLER_ROLE, deployer.address);
    await grantTx.wait();
    console.log(`  ✅ TRUSTED_CALLER_ROLE granted to deployer`);
  } else {
    console.log(`  Deployer has TRUSTED_CALLER_ROLE: ✅`);
  }

  const ISSUER_ROLE = await newCert.ISSUER_ROLE();
  const hasIssuerRole = await newCert.hasRole(ISSUER_ROLE, issuerWallet.address);
  if (!hasIssuerRole) {
    console.error(`\n  ❌ Issuer wallet ${issuerWallet.address} does NOT have ISSUER_ROLE.`);
    process.exit(1);
  }
  console.log(`  Issuer has ISSUER_ROLE: ✅`);

  // --- CAS token setup ---
  const casTokenAddress = await newCert.casToken();
  const casToken = await ethers.getContractAt(
    "@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20",
    casTokenAddress,
  );

  // Use deployer as the trusted caller for deposits and minting
  const casWithDeployer = casToken.connect(deployer);
  const newCertWithDeployer = newCert.connect(deployer);

  const deployerCasBalance = await casWithDeployer.balanceOf(deployer.address);
  console.log(`  Deployer CAS balance: ${ethers.formatEther(deployerCasBalance)} CAS`);

  const totalCerts = await oldCert.totalCertificates();
  console.log(`\n  Total certificates to migrate: ${totalCerts}\n`);

  // Calculate total CAS needed
  let totalCasNeeded = 0n;
  for (let i = 1n; i <= totalCerts; i++) {
    const cert = await oldCert.getCertificate(i);
    totalCasNeeded += cert.casDeposited;
  }
  console.log(`  Total CAS needed: ${ethers.formatEther(totalCasNeeded)} CAS`);

  if (deployerCasBalance < totalCasNeeded) {
    console.log(`  ⚠️  Deployer has insufficient CAS. Checking issuer wallet...`);
    const issuerCasBalance = await casToken.balanceOf(issuerWallet.address);
    console.log(`  Issuer CAS balance: ${ethers.formatEther(issuerCasBalance)} CAS`);
    if (deployerCasBalance + issuerCasBalance < totalCasNeeded) {
      console.error(`  ❌ Not enough CAS tokens total. Need ${ethers.formatEther(totalCasNeeded)} CAS.`);
      process.exit(1);
    }
    // Transfer from issuer to deployer
    const casWithIssuer = casToken.connect(issuerWallet);
    const transferAmount = totalCasNeeded - deployerCasBalance;
    console.log(`  Transferring ${ethers.formatEther(transferAmount)} CAS from issuer to deployer...`);
    const transferTx = await casWithIssuer.transfer(deployer.address, transferAmount);
    await transferTx.wait();
    console.log(`  ✅ CAS transferred`);
  }

  // Approve CAS spending for the new contract
  const currentAllowance = await casWithDeployer.allowance(deployer.address, NEW_CERT_ADDRESS);
  if (currentAllowance < totalCasNeeded) {
    console.log(`  Approving CAS token spending...`);
    const approveTx = await casWithDeployer.approve(NEW_CERT_ADDRESS, totalCasNeeded);
    await approveTx.wait();
    console.log(`  ✅ Approved`);
  }

  let migrated = 0;
  let skipped = 0;
  let failed = 0;

  for (let tokenId = 1n; tokenId <= totalCerts; tokenId++) {
    console.log(`\n--- Token ${tokenId} ---`);

    try {
      const oldCertificate = await oldCert.getCertificate(tokenId);
      const recipient = oldCertificate.recipient;
      const phaseId = oldCertificate.phaseId;
      const casDeposited = oldCertificate.casDeposited;
      const issuanceId = oldCertificate.issuanceId;
      const nameHash = oldCertificate.nameHash;
      const metadataHash = oldCertificate.metadataHash;
      const documentHash = oldCertificate.documentHash;
      const revoked = oldCertificate.revoked;

      console.log(`  recipient:     ${recipient}`);
      console.log(`  phaseId:       ${phaseId}`);
      console.log(`  casDeposited:  ${ethers.formatEther(casDeposited)} CAS`);
      console.log(`  issuanceId:    ${issuanceId}`);
      console.log(`  revoked:       ${revoked}`);

      // Check if already exists on new contract
      const existingTokenId = await newCert.certificatesByRecipientAndPhase(recipient, phaseId);
      if (existingTokenId > 0n) {
        console.log(`  ⏭️  Recipient already has certificate for phase ${phaseId} — skipping`);
        skipped++;
        continue;
      }

      // Check if issuanceId was already used
      const wasIssuanceUsed = await newCert.issuanceUsed(issuanceId);
      const newIssuanceId = wasIssuanceUsed
        ? ethers.id(`migration-${tokenId}-${Date.now()}`)
        : issuanceId;

      // Step 1: Deposit CAS for the recipient using depositCasForMintFor (TRUSTED_CALLER)
      // Note: depositCasForMintFor does NOT do transferFrom — it only credits internally.
      // We must transfer CAS tokens directly to the contract first, then call depositCasForMintFor.
      console.log(`  Step 1: Depositing CAS for recipient...`);
      const existingDeposit = await newCert.casDeposits(recipient, phaseId);
      if (existingDeposit < casDeposited) {
        const needed = casDeposited - existingDeposit;
        // Transfer CAS directly to the contract
        console.log(`    Transferring ${ethers.formatEther(needed)} CAS to contract...`);
        const transferTx = await casWithDeployer.transfer(NEW_CERT_ADDRESS, needed);
        await transferTx.wait();
        console.log(`    ✅ CAS transferred to contract`);
        // Now credit the deposit to the recipient
        const depositTx = await newCertWithDeployer.depositCasForMintFor(
          recipient,
          phaseId,
          needed,
        );
        await depositTx.wait();
        console.log(`    ✅ CAS deposited: ${ethers.formatEther(needed)} CAS`);
      } else {
        console.log(`    ⏭️  Sufficient deposit already exists`);
      }

      // Step 2: Generate EIP-712 authorization signature
      console.log(`  Step 2: Generating EIP-712 authorization...`);
      const newNonce = await newCert.nonces(recipient);
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

      const authData = {
        issuanceId: newIssuanceId,
        recipient: recipient,
        nameHash: nameHash,
        phaseId: phaseId,
        metadataHash: metadataHash,
        casAmount: casDeposited,
        nonce: newNonce,
        deadline: deadline,
      };

      const domain = {
        name: "RapportCertificate",
        version: "1",
        chainId: chainId,
        verifyingContract: NEW_CERT_ADDRESS,
      };

      const signature = await issuerWallet.signTypedData(domain, MINT_AUTH_TYPE, authData);
      console.log(`    ✅ Signature generated`);

      // Step 3: Call mintCertificate as TRUSTED_CALLER (deployer)
      console.log(`  Step 3: Minting certificate on new proxy...`);
      try {
        const mintTx = await newCertWithDeployer.mintCertificate(
          {
            issuanceId: newIssuanceId,
            recipient: recipient,
            nameHash: nameHash,
            phaseId: phaseId,
            metadataHash: metadataHash,
            casAmount: casDeposited,
            nonce: newNonce,
            deadline: deadline,
          },
          issuerWallet.address,
          signature,
        );
        const receipt = await mintTx.wait();
        console.log(`    ✅ Minted! txHash: ${receipt?.hash}`);

        // Find the new token ID from the event
        const iface = newCert.interface;
        for (const log of receipt?.logs || []) {
          try {
            const parsed = iface.parseLog(log);
            if (parsed?.name === "CertificateMinted") {
              const newTokenId = parsed.args.tokenId;
              console.log(`    New token ID: ${newTokenId}`);

              // Step 4: Migrate attestations
              if (documentHash !== ethers.ZeroHash) {
                console.log(`  Step 4: Migrating document hash...`);
                try {
                  const attestTx = await newCertWithDeployer.attestDocumentHash(newTokenId, documentHash);
                  await attestTx.wait();
                  console.log(`    ✅ Document hash migrated`);
                } catch (e: any) {
                  console.log(`    ⚠️ Document hash migration failed: ${e.message?.slice(0, 150)}`);
                }
              }

              // Migrate Merkle root
              try {
                const merkleRoot = await oldCert.getMerkleRoot(tokenId);
                if (merkleRoot !== ethers.ZeroHash) {
                  console.log(`  Migrating Merkle root...`);
                  const merkleTx = await newCertWithDeployer.attestMerkleRoot(newTokenId, merkleRoot);
                  await merkleTx.wait();
                  console.log(`    ✅ Merkle root migrated`);
                }
              } catch {
                // Merkle root may not exist
              }

              // Migrate Merkle root proof
              try {
                const merkleRootProof = await oldCert.getMerkleRootProof(tokenId);
                if (merkleRootProof !== ethers.ZeroHash) {
                  console.log(`  Migrating Merkle root proof...`);
                  const proofTx = await newCertWithDeployer.attestMerkleRootProof(newTokenId, merkleRootProof);
                  await proofTx.wait();
                  console.log(`    ✅ Merkle root proof migrated`);
                }
              } catch {
                // Merkle root proof may not exist
              }

              break;
            }
          } catch {
            // Not our event
          }
        }
        migrated++;
      } catch (mintError: any) {
        console.log(`    ❌ Mint failed: ${mintError.message?.slice(0, 200)}`);
        failed++;
        continue;
      }
    } catch (err: any) {
      console.log(`  ❌ Error processing token ${tokenId}: ${err.message?.slice(0, 200)}`);
      failed++;
    }
  }

  console.log(`\n========================================================================`);
  console.log("  Migration Summary");
  console.log(`========================================================================`);
  console.log(`  Total:    ${totalCerts}`);
  console.log(`  Migrated: ${migrated}`);
  console.log(`  Skipped:  ${skipped}`);
  console.log(`  Failed:   ${failed}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
