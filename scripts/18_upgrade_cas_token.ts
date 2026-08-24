import "dotenv/config";
import { ethers } from "hardhat";
import { requireEnv, sendAndVerify, SEP } from "./utils/deploy_helpers";

function log(level: string, fn: string, message: string, params?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").split(".")[0];
  const file = "scripts/18_upgrade_cas_token.ts";
  const extra = params ? ` - ${JSON.stringify(params)}` : "";
  console.log(`[${ts}] [${file}:${fn}] ${level} ${message}${extra}`);
}

async function main(): Promise<void> {
  const { CAS_TOKEN_ADDRESS, CAS_TOKEN_NEW_IMPL } = await requireEnv([
    "CAS_TOKEN_ADDRESS",
    "CAS_TOKEN_NEW_IMPL",
  ]);

  const [deployer] = await ethers.getSigners();

  const CAS_TOKEN_ABI = [
    "function upgradeTo(address) external",
    "function hasRole(bytes32 role, address account) view returns (bool)",
    "function isFrozen(address) view returns (bool)",
    "function freeze(address) external",
    "function freezeUntil(address, uint256) external",
    "function unfreeze(address) external",
  ];

  const casToken = new ethers.Contract(CAS_TOKEN_ADDRESS, CAS_TOKEN_ABI, deployer);
  const adminRole = ethers.ZeroHash;

  const isAdmin = await casToken.hasRole(adminRole, deployer.address);
  if (!isAdmin) {
    log("ERROR", "main", "Deployer is not DEFAULT_ADMIN_ROLE", { deployer: deployer.address });
    process.exit(1);
  }

  console.log(`\n${SEP}`);
  console.log("  CASToken UUPS Upgrade — Freeze/Arbitration Support");
  console.log(SEP);
  console.log(`  Proxy:     ${CAS_TOKEN_ADDRESS}`);
  console.log(`  New Impl:  ${CAS_TOKEN_NEW_IMPL}`);
  console.log(`  Deployer:  ${deployer.address}`);
  console.log(SEP);

  const feeData = await ethers.provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? 0n;

  log("INFO", "main", "Upgrading CASToken proxy", { proxy: CAS_TOKEN_ADDRESS, newImpl: CAS_TOKEN_NEW_IMPL });

  await sendAndVerify("upgradeTo", casToken.upgradeTo(CAS_TOKEN_NEW_IMPL), gasPrice);

  log("OK", "main", "Upgrade complete — freeze/unfreeze functions now available");

  const complianceRole = ethers.keccak256(ethers.toUtf8Bytes("COMPLIANCE_ROLE"));
  const casTokenWithRoles = new ethers.Contract(
    CAS_TOKEN_ADDRESS,
    ["function grantRole(bytes32 role, address account) external", "function hasRole(bytes32 role, address account) view returns (bool)"],
    deployer,
  );

  const hasCompliance = await casTokenWithRoles.hasRole(complianceRole, deployer.address);
  if (!hasCompliance) {
    log("INFO", "main", "Granting COMPLIANCE_ROLE to deployer");
    await sendAndVerify("grantRole", casTokenWithRoles.grantRole(complianceRole, deployer.address), gasPrice);
    log("OK", "main", "COMPLIANCE_ROLE granted");
  }

  console.log(`\n${SEP}`);
  console.log("  Upgrade completo. CASToken agora suporta freeze/unfreeze.");
  console.log(SEP);
}

main().catch((err) => {
  log("ERROR", "main", "Script failed", { error: err.message });
  process.exit(1);
});
