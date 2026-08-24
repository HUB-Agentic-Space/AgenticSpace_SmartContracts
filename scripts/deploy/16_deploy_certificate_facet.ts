import { ethers } from "hardhat";
import { SEP, SUB, requireEnv } from "../utils/deploy_helpers";

/**
 * Deploy CertificateFacet and wire it into the Diamond.
 *
 * O CertificateFacet permite que o usuário transfira CAS para o Diamond
 * (endereço confiável/conhecido pelo MetaMask/Blockaid) e emita o certificado
 * em uma única transação, sem interagir diretamente com o contrato
 * RapportCertificate recém-implantado (que dispara alertas do Blockaid).
 *
 * Passos:
 *   1. Deploy do CertificateFacet.
 *   2. DiamondCut: Add/Replace dos selectors do facet.
 *   3. Concede TRUSTED_CALLER_ROLE ao Diamond no RapportCertificate,
 *      permitindo que o Diamond deposite e emita em nome do usuário.
 *   4. Verifica getCertificateContract() via Diamond.
 *
 * Pré-requisitos:
 *   - RapportCertificate (com TRUSTED_CALLER_ROLE/depositCasForMintFor) já
 *     implantado e registrado no Diamond (script 14).
 *   - Signer = owner do Diamond E admin do RapportCertificate (para grant).
 *
 * Uso:
 *   npx hardhat run scripts/deploy/16_deploy_certificate_facet.ts --network polygon
 */

function getSelectors(contract: any): string[] {
  const selectors: string[] = [];
  const iface = contract.interface;
  for (const fn of iface.fragments) {
    if (fn.type === "function" && fn.name !== "init") {
      selectors.push(iface.getFunction(fn.name).selector);
    }
  }
  return selectors;
}

function normalizedPrivateKey(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
}

async function main() {
  const [defaultSigner] = await ethers.getSigners();

  const env = requireEnv([
    "DIAMOND_ADDRESS",
    "RAPPORT_CERTIFICATE_ADDRESS",
  ]);

  const diamondAddress = ethers.getAddress(env.DIAMOND_ADDRESS);
  const certificateAddress = ethers.getAddress(env.RAPPORT_CERTIFICATE_ADDRESS);

  // O owner do Diamond (relayer) executa o deploy do facet e o diamondCut.
  const relayerPrivateKey = process.env.RELAYER_PRIVATE_KEY?.trim();
  const signer = relayerPrivateKey
    ? new ethers.Wallet(normalizedPrivateKey(relayerPrivateKey), defaultSigner.provider!)
    : defaultSigner;
  const signerAddress = await signer.getAddress();

  // O admin do RapportCertificate (deployer / POLYGON_PRIVATE_KEY) concede o
  // TRUSTED_CALLER_ROLE ao Diamond. Pode ser um signer distinto do owner do
  // Diamond. Use CERTIFICATE_ADMIN_PRIVATE_KEY para uma chave dedicada.
  const adminPrivateKey = process.env.CERTIFICATE_ADMIN_PRIVATE_KEY?.trim();
  const adminSigner = adminPrivateKey
    ? new ethers.Wallet(normalizedPrivateKey(adminPrivateKey), defaultSigner.provider!)
    : defaultSigner;
  const adminSignerAddress = await adminSigner.getAddress();

  const feeData = await signer.provider!.getFeeData();
  const gasPrice = feeData.gasPrice ?? 30_000_000_000n;

  console.log(`\n${SEP}`);
  console.log(`  Deploy CertificateFacet + DiamondCut`);
  console.log(SEP);
  console.log(`  Diamond:            ${diamondAddress}`);
  console.log(`  RapportCertificate: ${certificateAddress}`);
  console.log(`  Signer:             ${signerAddress}`);
  console.log(`  Gas price:          ${ethers.formatUnits(gasPrice, "gwei")} gwei\n`);

  // Guard: Diamond and Certificate must have bytecode
  const [diamondCode, certCode] = await Promise.all([
    signer.provider!.getCode(diamondAddress),
    signer.provider!.getCode(certificateAddress),
  ]);
  if (diamondCode === "0x") throw new Error(`Diamond has no bytecode at ${diamondAddress}.`);
  if (certCode === "0x") throw new Error(`RapportCertificate has no bytecode at ${certificateAddress}.`);

  // Signer must be Diamond owner
  const ownership = await ethers.getContractAt("OwnershipFacet", diamondAddress, signer) as any;
  const owner = await ownership.owner();
  if (owner.toLowerCase() !== signerAddress.toLowerCase()) {
    throw new Error(`Signer ${signerAddress} is not Diamond owner ${owner}.`);
  }

  // 1. Deploy CertificateFacet
  console.log(`${SUB}\n  1. Deploy CertificateFacet\n${SUB}`);
  const CertificateFacetFactory = await ethers.getContractFactory("CertificateFacet", signer);
  const facet = await CertificateFacetFactory.deploy({ gasPrice });
  await facet.waitForDeployment();
  const facetAddr = await facet.getAddress();
  console.log(`  CertificateFacet: ${facetAddr}`);

  // 2. DiamondCut
  console.log(`${SUB}\n  2. DiamondCut\n${SUB}`);
  const newSelectors = getSelectors(facet);

  const loupe = await ethers.getContractAt("DiamondLoupeFacet", diamondAddress, signer);
  const facets = await loupe.facets();
  const onChainSelectors = new Set<string>();
  for (const [, selectors] of facets) {
    for (const sel of selectors) onChainSelectors.add(sel);
  }

  const replaceSelectors = newSelectors.filter((s) => onChainSelectors.has(s));
  const addSelectors = newSelectors.filter((s) => !onChainSelectors.has(s));

  const cuts: { facetAddress: string; action: number; functionSelectors: string[] }[] = [];
  if (replaceSelectors.length > 0) {
    cuts.push({ facetAddress: facetAddr, action: 1, functionSelectors: replaceSelectors });
    console.log(`  Replace: ${replaceSelectors.length} selectors`);
  }
  if (addSelectors.length > 0) {
    cuts.push({ facetAddress: facetAddr, action: 0, functionSelectors: addSelectors });
    console.log(`  Add: ${addSelectors.length} selectors`);
    for (const sel of addSelectors) console.log(`    ${sel}`);
  }

  const diamondCut = await ethers.getContractAt("IDiamondCut", diamondAddress, signer);
  for (const cut of cuts) {
    const actionName = cut.action === 0 ? "Add" : "Replace";
    const tx = await diamondCut.diamondCut([cut], ethers.ZeroAddress, "0x", { gasPrice, gasLimit: 400_000 });
    const receipt = await tx.wait();
    if (receipt?.status === 1) {
      console.log(`  OK: ${actionName} confirmado. Gas: ${receipt.gasUsed}`);
    } else {
      throw new Error(`DiamondCut ${actionName} reverted: ${tx.hash}`);
    }
  }

  // 3. Grant TRUSTED_CALLER_ROLE to Diamond on the certificate (admin signer)
  console.log(`${SUB}\n  3. Grant TRUSTED_CALLER_ROLE ao Diamond\n${SUB}`);
  console.log(`  Admin signer: ${adminSignerAddress}`);
  const certificate = await ethers.getContractAt("RapportCertificate", certificateAddress, adminSigner) as any;
  const trustedRole = await certificate.TRUSTED_CALLER_ROLE();
  const alreadyTrusted = await certificate.hasRole(trustedRole, diamondAddress);
  if (alreadyTrusted) {
    console.log(`  Diamond já possui TRUSTED_CALLER_ROLE.`);
  } else {
    const adminRole = await certificate.DEFAULT_ADMIN_ROLE();
    if (!(await certificate.hasRole(adminRole, adminSignerAddress))) {
      throw new Error(
        `Admin signer ${adminSignerAddress} não é DEFAULT_ADMIN do RapportCertificate; `
        + `não pode conceder TRUSTED_CALLER_ROLE. Defina CERTIFICATE_ADMIN_PRIVATE_KEY `
        + `com a chave admin (${signerAddress !== adminSignerAddress ? "diferente do relayer" : "correta"}).`,
      );
    }
    const tx = await certificate.grantRole(trustedRole, diamondAddress, { gasPrice });
    const receipt = await tx.wait();
    if (receipt?.status !== 1) throw new Error(`grantRole reverted: ${tx.hash}`);
    console.log(`  OK: TRUSTED_CALLER_ROLE concedido ao Diamond. Gas: ${receipt.gasUsed}`);
  }

  // 4. Verify
  console.log(`${SUB}\n  4. Verify\n${SUB}`);
  const facetAtDiamond = CertificateFacetFactory.attach(diamondAddress) as any;
  const registeredCert = await facetAtDiamond.getCertificateContract();
  console.log(`  getCertificateContract(): ${registeredCert}`);
  if (registeredCert.toLowerCase() !== certificateAddress.toLowerCase()) {
    throw new Error(
      `Registry mismatch: Diamond aponta para ${registeredCert}, esperado ${certificateAddress}. `
      + `Rode o script 14 para registrar/atualizar o RapportCertificate no Diamond.`,
    );
  }

  console.log(`\n${SEP}`);
  console.log(`  CertificateFacet integrado ao Diamond!`);
  console.log(`  CertificateFacet: ${facetAddr}`);
  console.log(`  Diamond:          ${diamondAddress}`);
  console.log(`  Frontend deve chamar depositAndMintCertificate() no Diamond.`);
  console.log(`${SEP}\n`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(`\n  Erro: ${e.message ?? e}`);
  process.exit(1);
});
