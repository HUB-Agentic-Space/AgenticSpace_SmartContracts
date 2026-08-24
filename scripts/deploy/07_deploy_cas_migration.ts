import { ethers } from "hardhat";
import {
  preFlightCheck, estimateDeployGas, sendAndVerify, printSummary, requireEnv,
} from "../utils/deploy_helpers";

/**
 * Deploy script for CASMigration.
 *
 * Migrates old CAS (v1, no MAX_SUPPLY) to new CAS (v2, with MAX_SUPPLY) at 1:1 ratio.
 *
 * Prerequisites:
 *   - Old CASToken deployed (OLD_CAS_ADDRESS in .env)
 *   - New CASToken deployed (CAS_TOKEN_ADDRESS in .env)
 *   - Deployer has MINTER_ROLE on new CASToken to mint migration reserve
 *
 * Environment variables:
 *   - CAS_TOKEN_ADDRESS: New CASToken (v2) address
 *   - OLD_CAS_ADDRESS: Old CASToken (v1) address
 *   - MIGRATION_RESERVE: Amount of new CAS to mint for migration (default: old totalSupply)
 *
 * After deploy:
 *   - Set CAS_MIGRATION_ADDRESS in .env
 *   - Users call migrate(amount) with approve on old CAS first
 */
async function main() {
  const [deployer] = await ethers.getSigners();

  const env = requireEnv(["CAS_TOKEN_ADDRESS"]);
  const newCasAddr = env.CAS_TOKEN_ADDRESS;
  const oldCasAddr = process.env.OLD_CAS_ADDRESS || "0x23222C45505576AC35A5f28458D02d8E715E48A7";

  // Check old CAS total supply
  const oldCas = await ethers.getContractAt("IERC20", oldCasAddr);
  const oldSupply = await oldCas.totalSupply();
  const reserveAmount = ethers.parseEther(process.env.MIGRATION_RESERVE || ethers.formatEther(oldSupply));

  // Pre-flight check
  const CASMigrationF = await ethers.getContractFactory("CASMigration");
  const newCas = await ethers.getContractAt("CASToken", newCasAddr);

  const steps = [
    { label: "1. Deploy CASMigration", gas: await estimateDeployGas(CASMigrationF, deployer) },
    { label: "2. mint() reserve", gas: 100_000n },
  ];

  const { gasPrice, balance } = await preFlightCheck(
    "Deploy CASMigration",
    steps,
    {
      extraInfo: [
        { label: "Old CAS (v1):", value: oldCasAddr },
        { label: "New CAS (v2):", value: newCasAddr },
        { label: "Old supply:", value: `${ethers.formatEther(oldSupply)} CAS` },
        { label: "Reserve:", value: `${ethers.formatEther(reserveAmount)} CAS` },
      ],
    },
  );

  // 1. Deploy CASMigration
  const migration = await CASMigrationF.deploy(oldCasAddr, newCasAddr, { gasPrice });
  await migration.waitForDeployment();
  const migrationAddr = await migration.getAddress();
  console.log(`  CASMigration deployado: ${migrationAddr}`);

  // 2. Mint new CAS to migration contract
  await sendAndVerify(
    `mint(${ethers.formatEther(reserveAmount)} CAS)`,
    newCas.mint(migrationAddr, reserveAmount, { gasPrice }),
    gasPrice,
  );

  // Verify
  const available = await migration.availableNewCAS();

  await printSummary(
    "CASMigration Deploy Concluido",
    [
      { label: "Migration:", value: migrationAddr },
      { label: "Old CAS:", value: oldCasAddr },
      { label: "New CAS:", value: newCasAddr },
      { label: "Reserve:", value: `${ethers.formatEther(available)} CAS` },
    ],
    balance,
    [
      `Atualize .env: CAS_MIGRATION_ADDRESS=${migrationAddr}`,
      `Usuarios devem: oldCAS.approve(migrationAddr, amount)`,
      `Entao: migration.migrate(amount)`,
    ],
  );
}

main().catch((error) => {
  console.error(`\n  Erro: ${error.message ?? error}`);
  process.exitCode = 1;
});
