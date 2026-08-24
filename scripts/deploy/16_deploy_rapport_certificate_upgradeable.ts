import { ethers, upgrades } from "hardhat";
import {
  preFlightCheck,
  estimateDeployGas,
  printSummary,
  requireEnv,
  sendAndVerify,
} from "../utils/deploy_helpers";

const CANONICAL_ERC6551_REGISTRY =
  "0x000000006551c19487814612e58FE06813775758";

const REGISTRY_NAME = "RapportCertificate";

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

function normalizedPrivateKey(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const env = requireEnv(["CAS_TOKEN_ADDRESS"]);
  const casTokenAddress = env.CAS_TOKEN_ADDRESS;
  const baseUri =
    process.env.CERTIFICATE_BASE_URI
    ?? "https://agenticspace.rapport.tec.br/api/v1/certificates/token/";
  const admin = requiredAddress("CERTIFICATE_ADMIN_ADDRESS");
  const issuer = requiredAddress("CERTIFICATE_ISSUER_ADDRESS");
  const phaseManager = requiredAddress("CERTIFICATE_PHASE_MANAGER_ADDRESS");
  const revoker = requiredAddress("CERTIFICATE_REVOKER_ADDRESS");
  const pauser = requiredAddress("CERTIFICATE_PAUSER_ADDRESS");
  const bonusManager = requiredAddress("CERTIFICATE_BONUS_MANAGER_ADDRESS");

  const network = await ethers.provider.getNetwork();
  const allowLocalRegistry =
    network.chainId === 31337n
    || process.env.ALLOW_LOCAL_ERC6551_REGISTRY?.trim().toLowerCase() === "true";
  let registryAddress = ethers.getAddress(
    process.env.ERC6551_REGISTRY_ADDRESS || CANONICAL_ERC6551_REGISTRY,
  );
  const isCanonicalRegistry =
    registryAddress === ethers.getAddress(CANONICAL_ERC6551_REGISTRY);

  if (!allowLocalRegistry && !isCanonicalRegistry) {
    throw new Error(
      `Registry ERC-6551 nao canonico (${registryAddress}) na chain ${network.chainId}. `
      + "O deploy foi abortado para preservar a identidade singleton. "
      + "Use o endereco canonico ou defina ALLOW_LOCAL_ERC6551_REGISTRY=true "
      + "somente em rede local ou de teste controlada.",
    );
  }

  const registryCode = await ethers.provider.getCode(registryAddress);
  const deployLocalRegistry = registryCode === "0x";

  if (deployLocalRegistry && !allowLocalRegistry) {
    throw new Error(
      `ERC-6551 registry sem bytecode em ${registryAddress} na chain ${network.chainId}. `
      + "O deploy foi abortado para preservar a identidade singleton. "
      + "Confirme o endereco canonico ou defina ALLOW_LOCAL_ERC6551_REGISTRY=true "
      + "somente em rede local ou de teste controlada.",
    );
  }

  const Account = await ethers.getContractFactory("RapportCertificateAccount");
  const Certificate = await ethers.getContractFactory(
    "RapportCertificateUpgradeable",
  );
  const steps = [
    {
      label: "Deploy RapportCertificateAccount",
      gas: await estimateDeployGas(Account, deployer),
    },
    {
      label: "Deploy RapportCertificateUpgradeable (UUPS Proxy)",
      gas: 5_000_000n,
    },
    { label: "Configure certificate roles", gas: 800_000n },
  ];
  if (deployLocalRegistry) {
    const Registry = await ethers.getContractFactory("ERC6551Registry");
    steps.unshift({
      label: "Deploy ERC6551Registry (canonical-compatible local instance)",
      gas: await estimateDeployGas(Registry, deployer),
    });
  }
  const { gasPrice, balance } = await preFlightCheck(
    "Deploy Rapport Certificate Upgradeable (UUPS + ERC-6551)",
    steps,
    {
      extraInfo: [
        { label: "CAS Token:", value: casTokenAddress },
        { label: "Admin:", value: admin },
        { label: "Issuer:", value: issuer },
        { label: "Phase Manager:", value: phaseManager },
        { label: "Revoker:", value: revoker },
        { label: "Pauser:", value: pauser },
        { label: "Bonus Manager:", value: bonusManager },
        { label: "Base URI:", value: baseUri },
        { label: "Pattern:", value: "UUPS Proxy" },
      ],
    },
  );

  if (deployLocalRegistry) {
    const Registry = await ethers.getContractFactory("ERC6551Registry");
    const registry = await Registry.deploy({ gasPrice });
    await registry.waitForDeployment();
    registryAddress = await registry.getAddress();
    console.log(`  ERC6551Registry local: ${registryAddress}`);
  } else {
    console.log(`  ERC6551Registry existente: ${registryAddress}`);
  }

  const accountImplementation = await Account.deploy({ gasPrice });
  await accountImplementation.waitForDeployment();
  const accountImplementationAddress = await accountImplementation.getAddress();
  console.log(`  RapportCertificateAccount: ${accountImplementationAddress}`);

  const certificate = await upgrades.deployProxy(
    Certificate,
    [
      deployer.address,
      casTokenAddress,
      registryAddress,
      accountImplementationAddress,
      baseUri,
    ],
    { kind: "uups", gasPrice },
  );
  await certificate.waitForDeployment();
  const certificateAddress = await certificate.getAddress();
  console.log(`  RapportCertificateUpgradeable (proxy): ${certificateAddress}`);

  const defaultAdminRole = await certificate.DEFAULT_ADMIN_ROLE();
  const issuerRole = await certificate.ISSUER_ROLE();
  const phaseManagerRole = await certificate.PHASE_MANAGER_ROLE();
  const revokerRole = await certificate.REVOKER_ROLE();
  const pauserRole = await certificate.PAUSER_ROLE();
  const bonusManagerRole = await certificate.BONUS_MANAGER_ROLE();

  const roleTargets = [
    { label: "DEFAULT_ADMIN_ROLE", role: defaultAdminRole, target: admin },
    { label: "ISSUER_ROLE", role: issuerRole, target: issuer },
    {
      label: "PHASE_MANAGER_ROLE",
      role: phaseManagerRole,
      target: phaseManager,
    },
    { label: "REVOKER_ROLE", role: revokerRole, target: revoker },
    { label: "PAUSER_ROLE", role: pauserRole, target: pauser },
    {
      label: "BONUS_MANAGER_ROLE",
      role: bonusManagerRole,
      target: bonusManager,
    },
  ] as const;

  for (const { label, role, target } of roleTargets) {
    if (target.toLowerCase() !== deployer.address.toLowerCase()) {
      await sendAndVerify(
        `grant ${label} to ${target}`,
        certificate.grantRole(role, target, { gasPrice }),
        gasPrice,
      );
    }
  }

  for (const { label, role, target } of roleTargets) {
    if (!(await certificate.hasRole(role, target))) {
      throw new Error(`${target} is missing ${label} after role configuration.`);
    }
  }

  const foundersPhase = await certificate.getPhase(1);

  const diamondAddress = process.env.DIAMOND_ADDRESS?.trim();
  let registrationTxHash: string | null = null;
  let registeredVersion: bigint = 0n;

  if (diamondAddress && ethers.isAddress(diamondAddress)) {
    const relayerPrivateKey = process.env.RELAYER_PRIVATE_KEY?.trim();
    const signer = relayerPrivateKey
      ? new ethers.Wallet(normalizedPrivateKey(relayerPrivateKey), ethers.provider)
      : deployer;

    const ownership = await ethers.getContractAt(
      "OwnershipFacet",
      diamondAddress,
      signer,
    ) as any;
    const owner = await ownership.owner();
    const signerAddress = await signer.getAddress();
    if (owner.toLowerCase() !== signerAddress.toLowerCase()) {
      throw new Error(
        `Signer (${signerAddress}) is not Diamond owner (${owner}). Set RELAYER_PRIVATE_KEY.`,
      );
    }

    const registry = await ethers.getContractAt(
      "ContractRegistryFacet",
      diamondAddress,
      signer,
    ) as any;
    const isRegistered = await registry.isRegistered(REGISTRY_NAME);

    if (isRegistered) {
      const [currentAddress, currentVersion] = await Promise.all([
        registry["getAddress(string)"](REGISTRY_NAME),
        registry.getCurrentVersion(REGISTRY_NAME),
      ]);
      if (currentAddress.toLowerCase() === certificateAddress.toLowerCase()) {
        registeredVersion = currentVersion;
      } else {
        registeredVersion = currentVersion + 1n;
        const tx = await registry.register(
          REGISTRY_NAME,
          registeredVersion,
          certificateAddress,
        );
        registrationTxHash = tx.hash;
        const receipt = await tx.wait();
        if (!receipt || receipt.status !== 1) {
          throw new Error(`Diamond registration reverted: ${tx.hash}`);
        }
      }
    } else {
      registeredVersion = 1n;
      const tx = await registry.register(
        REGISTRY_NAME,
        registeredVersion,
        certificateAddress,
      );
      registrationTxHash = tx.hash;
      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) {
        throw new Error(`Diamond registration reverted: ${tx.hash}`);
      }
    }
  }

  await printSummary(
    "Rapport Certificate Upgradeable Deploy Concluido",
    [
      { label: "RapportCertificateUpgradeable:", value: certificateAddress },
      { label: "Implementation:", value: await upgrades.erc1967.getImplementationAddress(certificateAddress) },
      { label: "TBA implementation:", value: accountImplementationAddress },
      { label: "ERC6551Registry:", value: registryAddress },
      { label: "Fase inicial:", value: foundersPhase.name },
      { label: "Admin:", value: admin },
      { label: "Issuer:", value: issuer },
      { label: "Gestor de fases:", value: phaseManager },
      { label: "Revogador:", value: revoker },
      { label: "Pausador:", value: pauser },
      { label: "Gestor de bonus:", value: bonusManager },
      { label: "Diamond registry version:", value: registeredVersion.toString() },
      { label: "Diamond registration tx:", value: registrationTxHash ?? "skipped (no DIAMOND_ADDRESS)" },
      {
        label: "Aporte minimo:",
        value: `${ethers.formatEther(foundersPhase.minCasDeposit)} CAS`,
      },
    ],
    balance,
    [
      `Atualize .env: RAPPORT_CERTIFICATE_ADDRESS=${certificateAddress}`,
      `Backend: CERTIFICATE_CONTRACT_ADDRESS=${certificateAddress}`,
      `Frontend: NEXT_PUBLIC_CERTIFICATE_ADDRESS=${certificateAddress}`,
      `Atualize .env: CERTIFICATE_ACCOUNT_IMPLEMENTATION_ADDRESS=${accountImplementationAddress}`,
      `Atualize .env: ERC6551_REGISTRY_ADDRESS=${registryAddress}`,
      "Verifique os roles e revogue os roles bootstrap do deployer via multisig.",
      "O contrato anterior permanece acessivel para verificacao de certificados 1-7.",
    ],
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`\n  Erro: ${error.message ?? error}`);
    process.exit(1);
  });
