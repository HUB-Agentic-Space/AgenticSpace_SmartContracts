import { ethers } from "hardhat";
import {
  SEP, SUB, printSummary,
} from "../utils/deploy_helpers";
import * as dotenv from "dotenv";

dotenv.config();

/**
 * Migration script: copies state from the old RapportCertificate (standalone)
 * to the new RapportCertificateUpgradeable (UUPS proxy).
 *
 * Steps:
 *   1. Read all phases from the old contract
 *   2. Read all certificates from the old contract
 *   3. Recreate phases on the new contract (via PHASE_MANAGER_ROLE)
 *   4. Migrate CAS deposits, attestations, and Merkle roots
 *
 * IMPORTANT: This script requires the deployer to hold PHASE_MANAGER_ROLE and
 * ISSUER_ROLE on the new proxy. Run after 10_deploy_certificate_upgradeable.ts.
 *
 * Usage:
 *   npx hardhat run scripts/deploy/11_migrate_certificate_state.ts --network polygon
 */

const OLD_CERT_ADDRESS = process.env.OLD_RAPPORT_CERTIFICATE_ADDRESS || "";
const NEW_CERT_ADDRESS = process.env.RAPPORT_CERTIFICATE_ADDRESS || "";

async function main() {
  if (!OLD_CERT_ADDRESS || !NEW_CERT_ADDRESS) {
    console.error("OLD_RAPPORT_CERTIFICATE_ADDRESS and RAPPORT_CERTIFICATE_ADDRESS must be set in .env");
    process.exit(1);
  }

  const [deployer] = await ethers.getSigners();
  console.log(`\n${SEP}`);
  console.log("  Certificate State Migration");
  console.log(SEP);
  console.log(`  Deployer:    ${deployer.address}`);
  console.log(`  Old contract: ${OLD_CERT_ADDRESS}`);
  console.log(`  New proxy:    ${NEW_CERT_ADDRESS}`);

  const oldCert = await ethers.getContractAt("RapportCertificate", OLD_CERT_ADDRESS);
  const newCert = await ethers.getContractAt("RapportCertificateUpgradeable", NEW_CERT_ADDRESS);

  // -----------------------------------------------------------------------
  // 1. Read and migrate phases
  // -----------------------------------------------------------------------
  console.log(`\n${SUB}`);
  console.log("  Fase 1: Migrando phases...");
  console.log(SUB);

  const oldPhaseCount = await oldCert.phaseCount();
  console.log(`  Total de phases no contrato antigo: ${oldPhaseCount}`);

  // Phase 1 (Sócio Fundador) is created in initialize(), so skip it.
  for (let i = 2n; i <= oldPhaseCount; i++) {
    const phase = await oldCert.getPhase(i);
    console.log(`  Migrando phase ${i}: ${phase.name}`);

    const tx = await newCert.createPhase(
      phase.name,
      phase.templateHash,
      phase.minCasDeposit,
      phase.startsAt,
      phase.endsAt,
      phase.skillsDescription,
      phase.instructions,
      phase.extraFeeTypeId,
      phase.tbaRebateBps,
    );
    await tx.wait();
    console.log(`    ✅ Phase ${i} criada`);

    // Activate if it was active on the old contract
    const wasActive = await oldCert.activePhases(i);
    if (wasActive) {
      const activateTx = await newCert.activatePhase(i);
      await activateTx.wait();
      console.log(`    ✅ Phase ${i} ativada`);
    }

    // Migrate prerequisites
    const prereqs = await oldCert.getPhasePrerequisites(i);
    if (prereqs.length > 0) {
      const prereqTx = await newCert.setPhasePrerequisites(i, prereqs);
      await prereqTx.wait();
      console.log(`    ✅ Prerequisites migrados: ${prereqs.length}`);
    }
  }

  // -----------------------------------------------------------------------
  // 2. Read and migrate certificates
  // -----------------------------------------------------------------------
  console.log(`\n${SUB}`);
  console.log("  Fase 2: Migrando certificates...");
  console.log(SUB);

  const totalCerts = await oldCert.totalCertificates();
  console.log(`  Total de certificates no contrato antigo: ${totalCerts}`);

  let migrated = 0;
  let skipped = 0;

  for (let tokenId = 1n; tokenId <= totalCerts; tokenId++) {
    try {
      const cert = await oldCert.getCertificate(tokenId);
      console.log(`  Token ${tokenId}: phaseId=${cert.phaseId}, recipient=${cert.recipient}`);

      // Check if already exists on new contract via public certificates mapping
      const newCertData = await newCert.certificates(tokenId);
      if (newCertData.recipient !== ethers.ZeroAddress) {
        console.log(`    ⏭️  Já existe no novo contrato (tokenId=${tokenId})`);
        skipped++;
        continue;
      }

      // Note: Certificate minting requires EIP-712 authorization and CAS deposit.
      // For migration, the backend must:
      //   1. Deposit CAS on the new contract for each recipient
      //   2. Generate a new authorization signature
      //   3. Call mintCertificate
      //
      // This script logs what needs to be migrated. The actual mint must be
      // done by the backend relayer with proper authorization.
      console.log(`    ⚠️  Migração de certificate requer autorização do backend`);
      console.log(`    CAS depositado: ${ethers.formatEther(cert.casDeposited)} CAS`);
      console.log(`    TBA: ${cert.tokenBoundAccount}`);
    } catch (err: any) {
      console.log(`    ❌ Erro ao ler token ${tokenId}: ${err.message}`);
    }
  }

  // -----------------------------------------------------------------------
  // 3. Migrate attestations (document hashes, Merkle roots)
  // -----------------------------------------------------------------------
  console.log(`\n${SUB}`);
  console.log("  Fase 3: Migrando attestations...");
  console.log(SUB);

  for (let tokenId = 1n; tokenId <= totalCerts; tokenId++) {
    try {
      const cert = await oldCert.getCertificate(tokenId);

      // Migrate document hash
      if (cert.documentHash !== ethers.ZeroHash) {
        const newCert_data = await newCert.certificates(tokenId);
        if (newCert_data.documentHash === ethers.ZeroHash) {
          console.log(`  Token ${tokenId}: documentHash=${cert.documentHash}`);
          // Requires ISSUER_ROLE — uncomment when ready:
          // const tx = await newCert.attestDocumentHash(tokenId, cert.documentHash);
          // await tx.wait();
        }
      }

      // Migrate Merkle root
      const merkleRoot = await oldCert.getMerkleRoot(tokenId);
      if (merkleRoot !== ethers.ZeroHash) {
        console.log(`  Token ${tokenId}: merkleRoot=${merkleRoot}`);
        // const tx = await newCert.attestMerkleRoot(tokenId, merkleRoot);
        // await tx.wait();
      }

      // Migrate Merkle root proof
      const merkleRootProof = await oldCert.getMerkleRootProof(tokenId);
      if (merkleRootProof !== ethers.ZeroHash) {
        console.log(`  Token ${tokenId}: merkleRootProof=${merkleRootProof}`);
        // const tx = await newCert.attestMerkleRootProof(tokenId, merkleRootProof);
        // await tx.wait();
      }
    } catch {
      // Token may not exist on new contract yet
    }
  }

  printSummary("Certificate State Migration", [
    { label: "Total certificates (old)", value: totalCerts.toString() },
    { label: "Migrated", value: migrated.toString() },
    { label: "Skipped (already exists)", value: skipped.toString() },
    { label: "Pending (require backend auth)", value: (Number(totalCerts) - migrated - skipped).toString() },
  ]);

  console.log(`\n⚠️  Certificates requerem migração via backend relayer.`);
  console.log(`   O backend deve gerar novas autorizações EIP-712 e depositar CAS`);
  console.log(`   no novo contrato para cada certificado antes de chamar mintCertificate.`);
}
