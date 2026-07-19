import { ethers } from "hardhat";

type CertificateContract = Awaited<ReturnType<typeof ethers.getContractAt>> & {
  [key: string]: any;
};

type RoleTarget = {
  label: string;
  role: string;
  target: string;
};

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

async function roleMembers(
  certificate: CertificateContract,
  role: string,
): Promise<string[]> {
  const count = await certificate.getRoleMemberCount(role) as bigint;
  if (count > 100n) {
    throw new Error(
      `Role ${role} has ${count} members; refusing an unexpectedly large enumeration.`,
    );
  }

  const members: string[] = [];
  for (let index = 0n; index < count; index++) {
    members.push(ethers.getAddress(await certificate.getRoleMember(role, index)));
  }
  return members;
}

async function main() {
  const certificateAddress = requiredAddress("RAPPORT_CERTIFICATE_ADDRESS");
  const bootstrapAdmin = requiredAddress("CERTIFICATE_BOOTSTRAP_ADMIN_ADDRESS");
  const admin = requiredAddress("CERTIFICATE_ADMIN_ADDRESS");
  const issuer = requiredAddress("CERTIFICATE_ISSUER_ADDRESS");
  const phaseManager = requiredAddress("CERTIFICATE_PHASE_MANAGER_ADDRESS");
  const revoker = requiredAddress("CERTIFICATE_REVOKER_ADDRESS");
  const pauser = requiredAddress("CERTIFICATE_PAUSER_ADDRESS");
  const bonusManager = requiredAddress("CERTIFICATE_BONUS_MANAGER_ADDRESS");

  const [defaultSigner] = await ethers.getSigners();
  const relayerPrivateKey = process.env.RELAYER_PRIVATE_KEY?.trim();
  const defaultSignerAddress = await defaultSigner.getAddress();
  const signer = defaultSignerAddress.toLowerCase() === admin.toLowerCase()
    ? defaultSigner
    : relayerPrivateKey
      ? new ethers.Wallet(
          normalizedPrivateKey(relayerPrivateKey),
          ethers.provider,
        )
      : defaultSigner;
  const signerAddress = await signer.getAddress();
  if (signerAddress.toLowerCase() !== admin.toLowerCase()) {
    throw new Error(
      `Selected signer ${signerAddress} is not configured admin ${admin}. `
      + "Load the admin key through RELAYER_PRIVATE_KEY.",
    );
  }

  const code = await ethers.provider.getCode(certificateAddress);
  if (code === "0x") {
    throw new Error(`RapportCertificate has no bytecode at ${certificateAddress}.`);
  }
  const certificate = await ethers.getContractAt(
    "RapportCertificate",
    certificateAddress,
    signer,
  ) as CertificateContract;

  const roleTargets: RoleTarget[] = [
    {
      label: "ISSUER_ROLE",
      role: await certificate.ISSUER_ROLE(),
      target: issuer,
    },
    {
      label: "PHASE_MANAGER_ROLE",
      role: await certificate.PHASE_MANAGER_ROLE(),
      target: phaseManager,
    },
    {
      label: "REVOKER_ROLE",
      role: await certificate.REVOKER_ROLE(),
      target: revoker,
    },
    {
      label: "PAUSER_ROLE",
      role: await certificate.PAUSER_ROLE(),
      target: pauser,
    },
    {
      label: "BONUS_MANAGER_ROLE",
      role: await certificate.BONUS_MANAGER_ROLE(),
      target: bonusManager,
    },
    {
      // DEFAULT_ADMIN_ROLE remains last so an external final admin can remove
      // all bootstrap operational privileges before removing bootstrap admin.
      label: "DEFAULT_ADMIN_ROLE",
      role: await certificate.DEFAULT_ADMIN_ROLE(),
      target: admin,
    },
  ];

  const defaultAdminRole = roleTargets.at(-1)!.role;
  if (!(await certificate.hasRole(defaultAdminRole, signerAddress))) {
    throw new Error(
      `Configured admin ${signerAddress} does not hold DEFAULT_ADMIN_ROLE.`,
    );
  }

  // Accept only the configured target and the known bootstrap account before
  // cleanup. Any third member may represent an unreviewed privileged account,
  // so abort before sending the first transaction.
  for (const { label, role, target } of roleTargets) {
    if (!(await certificate.hasRole(role, target))) {
      throw new Error(`Configured target ${target} is missing ${label}.`);
    }

    const allowedMembers = new Set([
      target.toLowerCase(),
      bootstrapAdmin.toLowerCase(),
    ]);
    const members = await roleMembers(certificate, role);
    const unexpected = members.filter(
      (member) => !allowedMembers.has(member.toLowerCase()),
    );
    if (unexpected.length > 0) {
      throw new Error(
        `${label} has unexpected member(s): ${unexpected.join(", ")}. `
        + "Review and remove them manually before finalization.",
      );
    }
  }

  const transactions: Array<{ role: string; hash: string }> = [];
  const preservedRoles: string[] = [];
  for (const { label, role, target } of roleTargets) {
    if (target.toLowerCase() === bootstrapAdmin.toLowerCase()) {
      preservedRoles.push(label);
      continue;
    }
    if (!(await certificate.hasRole(role, bootstrapAdmin))) continue;

    const tx = await certificate.revokeRole(role, bootstrapAdmin);
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      throw new Error(`Revoking bootstrap ${label} reverted: ${tx.hash}`);
    }
    transactions.push({ role: label, hash: tx.hash });
  }

  for (const { label, role, target } of roleTargets) {
    const members = await roleMembers(certificate, role);
    if (
      members.length !== 1
      || members[0].toLowerCase() !== target.toLowerCase()
      || !(await certificate.hasRole(role, target))
    ) {
      throw new Error(
        `${label} final membership mismatch; expected only ${target}, `
        + `found ${members.join(", ") || "none"}.`,
      );
    }
  }

  console.log("[certificate-roles] RapportCertificate:", certificateAddress);
  console.log("[certificate-roles] Bootstrap account:", bootstrapAdmin);
  for (const { label, target } of roleTargets) {
    console.log(`[certificate-roles] ${label}: ${target}`);
  }
  if (preservedRoles.length > 0) {
    console.log(
      "[certificate-roles] Bootstrap roles intentionally preserved:",
      preservedRoles.join(", "),
    );
  }
  if (transactions.length === 0) {
    console.log("[certificate-roles] Transactions: unchanged (already finalized)");
  } else {
    for (const transaction of transactions) {
      console.log(`[certificate-roles] ${transaction.role}: ${transaction.hash}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
