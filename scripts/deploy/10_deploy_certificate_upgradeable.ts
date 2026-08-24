import { ethers, upgrades } from "hardhat";
import {
  SEP, SUB, preFlightCheck, sendAndVerify, printSummary,
} from "../utils/deploy_helpers";
import * as dotenv from "dotenv";

dotenv.config();

/**
 * Deploy script for RapportCertificateUpgradeable (UUPS proxy).
 *
 * Deploys:
 *   1. RapportCertificateUpgradeable implementation
 *   2. ERC1967 proxy pointing to the implementation
 *   3. Calls initialize() with admin, CAS token, registry, account impl, base URI
 *
 * After deploy, save RAPPORT_CERTIFICATE_ADDRESS (proxy address) in .env.
 * The implementation address is not needed for interaction — only the proxy.
 */

async function main() {
  const [deployer] = await ethers.getSigners();

  const admin = process.env.CERTIFICATE_ADMIN_ADDRESS || deployer.address;
  const casTokenAddress = process.env.CAS_TOKEN_ADDRESS;
  const registryAddress = process.env.ERC6551_REGISTRY_ADDRESS;
  const accountImplementationAddress =
    process.env.CERTIFICATE_ACCOUNT_IMPLEMENTATION_ADDRESS;
  const baseTokenURI =
    process.env.CERTIFICATE_BASE_URI ||
    "https://agenticspace.rapport.tec.br/api/v1/certificates/token/";

  if (!casTokenAddress || casTokenAddress === "") {
    console.error("CAS_TOKEN_ADDRESS not set in .env");
    process.exit(1);
  }
  if (!registryAddress || registryAddress === "") {
    console.error("ERC6551_REGISTRY_ADDRESS not set in .env");
    process.exit(1);
  }
  if (!accountImplementationAddress || accountImplementationAddress === "") {
    console.error("CERTIFICATE_ACCOUNT_IMPLEMENTATION_ADDRESS not set in .env");
    process.exit(1);
  }

  console.log(`\n${SEP}`);
  console.log("  RapportCertificateUpgradeable — UUPS Proxy Deploy");
  console.log(SEP);
  console.log(`\n${SUB}`);
  console.log("  Parâmetros");
  console.log(SUB);
  console.log(`  Admin:              ${admin}`);
  console.log(`  CAS Token:          ${casTokenAddress}`);
  console.log(`  ERC6551 Registry:   ${registryAddress}`);
  console.log(`  Account Impl:       ${accountImplementationAddress}`);
  console.log(`  Base URI:           ${baseTokenURI}`);

  const Certificate = await ethers.getContractFactory(
    "RapportCertificateUpgradeable",
  );

  console.log(`\n${SUB}`);
  console.log("  Deployando proxy + implementação...");
  console.log(SUB);

  const proxy = await upgrades.deployProxy(Certificate, [
    admin,
    casTokenAddress,
    registryAddress,
    accountImplementationAddress,
    baseTokenURI,
  ], {
    kind: "uups",
    initializer: "initialize",
  });

  await proxy.waitForDeployment();
  const proxyAddress = await proxy.getAddress();
  const implAddress = await upgrades.erc1967.getImplementationAddress(
    proxyAddress,
  );

  console.log(`\n${SEP}`);
  console.log("  Deploy concluído!");
  console.log(SEP);
  console.log(`  Proxy address:        ${proxyAddress}`);
  console.log(`  Implementation:       ${implAddress}`);
  console.log(`\n  Salve no .env:`);
  console.log(`  RAPPORT_CERTIFICATE_ADDRESS=${proxyAddress}`);
  console.log(`  RAPPORT_CERTIFICATE_IMPL_ADDRESS=${implAddress}`);

  // Verify on Polygonscan
  if (process.env.POLYGONSCAN_API_KEY) {
    console.log(`\n${SUB}`);
    console.log("  Verificando no Polygonscan...");
    console.log(SUB);

    try {
      await upgrades.verify(proxy);
      console.log("  ✅ Verificação concluída.");
    } catch (err: any) {
      console.log(`  ⚠️ Verificação falhou: ${err.message}`);
      console.log("  Tente manualmente:");
      console.log(`  npx hardhat verify --network polygon ${implAddress}`);
    }
  }

  printSummary("RapportCertificateUpgradeable", [
    { label: "Proxy", value: proxyAddress },
    { label: "Implementation", value: implAddress },
  ]);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
