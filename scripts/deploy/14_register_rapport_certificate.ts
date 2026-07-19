import { artifacts, ethers } from "hardhat";

const REGISTRY_NAME = "RapportCertificate";
const POLYGON_CHAIN_ID = 137n;
const CANONICAL_ERC6551_REGISTRY = ethers.getAddress(
  "0x000000006551c19487814612e58FE06813775758",
);
const ERC5192_INTERFACE_ID = ethers.id("locked(uint256)").slice(0, 10);
const FOUNDERS_MIN_CAS_DEPOSIT = 50n * 10n ** 18n;

const EXPECTED_CERTIFICATE_IDENTITY = {
  name: "Rapport Certificate",
  symbol: "RPTCERT",
  issuerLegalName: "Raport Tecnologia Inova Simples",
  issuerCnpj: "67.904.299/0001-80",
  rapportWebsite: "https://rapport.tec.br",
  agenticSpaceWebsite: "https://agenticspace.rapport.tec.br",
  foundersPhaseName: "Sócio Fundador",
} as const;

function normalizedPrivateKey(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
}

function requiredAddress(name: string): string {
  const value = process.env[name]?.trim();
  if (!value || !ethers.isAddress(value)) {
    throw new Error(`${name} must contain a valid address.`);
  }
  const address = ethers.getAddress(value);
  if (address === ethers.ZeroAddress) {
    throw new Error(`${name} cannot be the zero address.`);
  }
  return address;
}

function assertAddress(label: string, actual: string, expected: string): void {
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`${label} mismatch: expected ${expected}, found ${actual}.`);
  }
}

function assertString(label: string, actual: string, expected: string): void {
  if (actual !== expected) {
    throw new Error(
      `${label} mismatch: expected ${JSON.stringify(expected)}, `
      + `found ${JSON.stringify(actual)}.`,
    );
  }
}

async function main() {
  const diamondAddress = requiredAddress("DIAMOND_ADDRESS");
  const certificateAddress = requiredAddress("RAPPORT_CERTIFICATE_ADDRESS");
  const expectedCasToken = requiredAddress("CAS_TOKEN_ADDRESS");
  const configuredRoles = [
    { env: "CERTIFICATE_ADMIN_ADDRESS", getter: "DEFAULT_ADMIN_ROLE" },
    { env: "CERTIFICATE_ISSUER_ADDRESS", getter: "ISSUER_ROLE" },
    {
      env: "CERTIFICATE_PHASE_MANAGER_ADDRESS",
      getter: "PHASE_MANAGER_ROLE",
    },
    { env: "CERTIFICATE_REVOKER_ADDRESS", getter: "REVOKER_ROLE" },
    { env: "CERTIFICATE_PAUSER_ADDRESS", getter: "PAUSER_ROLE" },
    {
      env: "CERTIFICATE_BONUS_MANAGER_ADDRESS",
      getter: "BONUS_MANAGER_ROLE",
    },
  ].map((entry) => ({ ...entry, target: requiredAddress(entry.env) }));

  const [defaultSigner] = await ethers.getSigners();
  const relayerPrivateKey = process.env.RELAYER_PRIVATE_KEY?.trim();
  const signer = relayerPrivateKey
    ? new ethers.Wallet(
        normalizedPrivateKey(relayerPrivateKey),
        ethers.provider,
      )
    : defaultSigner;

  const network = await ethers.provider.getNetwork();
  const allowNonPolygonForTests =
    process.env.ALLOW_NON_POLYGON_CERTIFICATE_REGISTRATION_FOR_TESTS
      ?.trim()
      .toLowerCase() === "true";
  if (network.chainId !== POLYGON_CHAIN_ID && !allowNonPolygonForTests) {
    throw new Error(
      `Certificate registration is restricted to Polygon chain 137; `
      + `connected chain is ${network.chainId}. Set `
      + "ALLOW_NON_POLYGON_CERTIFICATE_REGISTRATION_FOR_TESTS=true only in "
      + "an isolated test environment.",
    );
  }
  if (network.chainId !== POLYGON_CHAIN_ID) {
    console.warn(
      `[certificate-registry] TEST OVERRIDE: validating chain ${network.chainId}.`,
    );
  }

  const [diamondCode, certificateCode, casTokenCode, canonicalRegistryCode] =
    await Promise.all([
      ethers.provider.getCode(diamondAddress),
      ethers.provider.getCode(certificateAddress),
      ethers.provider.getCode(expectedCasToken),
      ethers.provider.getCode(CANONICAL_ERC6551_REGISTRY),
    ]);
  if (diamondCode === "0x") {
    throw new Error(`Diamond has no bytecode at ${diamondAddress}.`);
  }
  if (certificateCode === "0x") {
    throw new Error(`RapportCertificate has no bytecode at ${certificateAddress}.`);
  }
  if (casTokenCode === "0x") {
    throw new Error(`CAS token has no bytecode at ${expectedCasToken}.`);
  }
  if (canonicalRegistryCode === "0x") {
    throw new Error(
      `Canonical ERC-6551 registry has no bytecode at `
      + `${CANONICAL_ERC6551_REGISTRY}.`,
    );
  }

  const certificate = await ethers.getContractAt(
    "RapportCertificate",
    certificateAddress,
    signer,
  ) as any;
  const payment = await ethers.getContractAt(
    "PaymentFacet",
    diamondAddress,
    signer,
  ) as any;

  const [
    certificateName,
    certificateSymbol,
    certificateCasToken,
    paymentCasToken,
    erc6551Registry,
    accountImplementation,
    foundersPhase,
    currentPhaseId,
    erc5192Supported,
    issuerLegalName,
    issuerCnpj,
    rapportWebsite,
    agenticSpaceWebsite,
  ] = await Promise.all([
    certificate.name(),
    certificate.symbol(),
    certificate.casToken(),
    payment.getCasToken(),
    certificate.erc6551Registry(),
    certificate.accountImplementation(),
    certificate.getPhase(1),
    certificate.currentPhaseId(),
    certificate.supportsInterface(ERC5192_INTERFACE_ID),
    certificate.ISSUER_LEGAL_NAME(),
    certificate.ISSUER_CNPJ(),
    certificate.RAPPORT_WEBSITE(),
    certificate.AGENTIC_SPACE_WEBSITE(),
  ]);

  assertString(
    "Certificate name",
    certificateName,
    EXPECTED_CERTIFICATE_IDENTITY.name,
  );
  assertString(
    "Certificate symbol",
    certificateSymbol,
    EXPECTED_CERTIFICATE_IDENTITY.symbol,
  );
  assertAddress("Certificate CAS token", certificateCasToken, expectedCasToken);
  assertAddress("PaymentFacet CAS token", paymentCasToken, expectedCasToken);
  assertAddress(
    "Certificate ERC-6551 registry",
    erc6551Registry,
    CANONICAL_ERC6551_REGISTRY,
  );

  const accountImplementationAddress = ethers.getAddress(accountImplementation);
  if (accountImplementationAddress === ethers.ZeroAddress) {
    throw new Error("Certificate account implementation is the zero address.");
  }
  const accountImplementationCode = await ethers.provider.getCode(
    accountImplementationAddress,
  );
  if (accountImplementationCode === "0x") {
    throw new Error(
      `Certificate account implementation has no bytecode at `
      + `${accountImplementationAddress}.`,
    );
  }
  const accountArtifact = await artifacts.readArtifact(
    "RapportCertificateAccount",
  );
  if (!accountArtifact.deployedBytecode || accountArtifact.deployedBytecode === "0x") {
    throw new Error("RapportCertificateAccount artifact has no runtime bytecode.");
  }
  const expectedAccountCodeHash = ethers.keccak256(
    accountArtifact.deployedBytecode,
  );
  const actualAccountCodeHash = ethers.keccak256(accountImplementationCode);
  if (actualAccountCodeHash !== expectedAccountCodeHash) {
    throw new Error(
      `Certificate account implementation runtime mismatch at `
      + `${accountImplementationAddress}: expected codehash `
      + `${expectedAccountCodeHash}, found ${actualAccountCodeHash}.`,
    );
  }

  assertString(
    "Founders phase name",
    foundersPhase.name,
    EXPECTED_CERTIFICATE_IDENTITY.foundersPhaseName,
  );
  if (foundersPhase.minCasDeposit !== FOUNDERS_MIN_CAS_DEPOSIT) {
    throw new Error(
      `Founders phase CAS deposit mismatch: expected `
      + `${FOUNDERS_MIN_CAS_DEPOSIT}, found ${foundersPhase.minCasDeposit}.`,
    );
  }
  if (!foundersPhase.active || currentPhaseId !== 1n) {
    throw new Error(
      `Founders phase must be active and current before registration; `
      + `active=${foundersPhase.active}, currentPhaseId=${currentPhaseId}.`,
    );
  }
  if (!erc5192Supported) {
    throw new Error(
      `Certificate does not advertise ERC-5192 interface ${ERC5192_INTERFACE_ID}.`,
    );
  }

  assertString(
    "Issuer legal name",
    issuerLegalName,
    EXPECTED_CERTIFICATE_IDENTITY.issuerLegalName,
  );
  assertString(
    "Issuer CNPJ",
    issuerCnpj,
    EXPECTED_CERTIFICATE_IDENTITY.issuerCnpj,
  );
  assertString(
    "Rapport website",
    rapportWebsite,
    EXPECTED_CERTIFICATE_IDENTITY.rapportWebsite,
  );
  assertString(
    "Agentic Space website",
    agenticSpaceWebsite,
    EXPECTED_CERTIFICATE_IDENTITY.agenticSpaceWebsite,
  );

  for (const { env, getter, target } of configuredRoles) {
    const role = await certificate[getter]();
    if (!(await certificate.hasRole(role, target))) {
      throw new Error(
        `${env} target ${target} does not hold ${getter}; registration aborted.`,
      );
    }
  }

  const ownership = await ethers.getContractAt(
    "OwnershipFacet",
    diamondAddress,
    signer,
  ) as any;
  const signerAddress = await signer.getAddress();
  const owner = await ownership.owner();
  if (owner.toLowerCase() !== signerAddress.toLowerCase()) {
    throw new Error(
      `Selected signer ${signerAddress} is not Diamond owner ${owner}. `
      + "Load the owner key through RELAYER_PRIVATE_KEY.",
    );
  }

  const registry = await ethers.getContractAt(
    "ContractRegistryFacet",
    diamondAddress,
    signer,
  ) as any;
  const isRegistered = await registry.isRegistered(REGISTRY_NAME);
  let targetVersion = 1n;
  let transactionHash: string | null = null;

  if (isRegistered) {
    const [currentAddress, currentVersion] = await Promise.all([
      registry["getAddress(string)"](REGISTRY_NAME),
      registry.getCurrentVersion(REGISTRY_NAME),
    ]);
    if (currentAddress.toLowerCase() === certificateAddress.toLowerCase()) {
      targetVersion = currentVersion;
    } else {
      targetVersion = currentVersion + 1n;
      const tx = await registry.register(
        REGISTRY_NAME,
        targetVersion,
        certificateAddress,
      );
      transactionHash = tx.hash;
      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) {
        throw new Error(`Diamond registration reverted: ${tx.hash}`);
      }
    }
  } else {
    const tx = await registry.register(
      REGISTRY_NAME,
      targetVersion,
      certificateAddress,
    );
    transactionHash = tx.hash;
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      throw new Error(`Diamond registration reverted: ${tx.hash}`);
    }
  }

  const [verifiedAddress, verifiedVersion, verifiedName] = await Promise.all([
    registry["getAddress(string)"](REGISTRY_NAME),
    registry.getCurrentVersion(REGISTRY_NAME),
    registry.getNameByAddress(certificateAddress),
  ]);
  if (
    verifiedAddress.toLowerCase() !== certificateAddress.toLowerCase()
    || verifiedVersion !== targetVersion
    || verifiedName !== REGISTRY_NAME
  ) {
    throw new Error(
      `Post-registration verification failed: address=${verifiedAddress}, `
      + `version=${verifiedVersion}, name=${verifiedName}.`,
    );
  }

  console.log("[certificate-registry] Chain ID:", network.chainId.toString());
  console.log("[certificate-registry] Diamond:", diamondAddress);
  console.log("[certificate-registry] RapportCertificate:", certificateAddress);
  console.log("[certificate-registry] Version:", targetVersion.toString());
  console.log(
    "[certificate-registry] Transaction:",
    transactionHash ?? "unchanged (already registered)",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
