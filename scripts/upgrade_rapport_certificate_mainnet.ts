/**
 * Upgrade RapportCertificateUpgradeable on mainnet (Polygon 137).
 *
 * Steps:
 *   1. Deploy new implementation (RapportCertificateUpgradeable)
 *   2. Deploy RapportCertificatePhaseAdminFacet
 *   3. Call upgradeTo(newImpl) on the proxy via Safe execTransaction
 *   4. Call setPhaseAdminFacet(facetAddr) on the proxy via Safe execTransaction
 *   5. Verify state preservation (phaseCount, totalCertificates, currentPhaseId)
 *
 * The proxy admin is a 1-of-1 Gnosis Safe at MULTISIG_ADDRESS.
 * We sign the Safe transaction hash with SAFE_OWNER_PRIVATE_KEY and
 * call execTransaction directly.
 */
import { ethers, upgrades } from "hardhat";

const SAFE_ABI = [
  "function nonce() view returns (uint256)",
  "function getThreshold() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes signatures) returns (bool)",
];

const CERT_ABI = [
  "function phaseCount() view returns (uint256)",
  "function currentPhaseId() view returns (uint256)",
  "function totalCertificates() view returns (uint256)",
  "function phaseAdminFacet() view returns (address)",
  "function getPhase(uint256) view returns (tuple(string name, bytes32 templateHash, uint256 minCasDeposit, uint256 startsAt, uint256 endsAt, uint256 minted, bool active, string skillsDescription, string instructions, uint256 extraFeeTypeId, uint256 tbaRebateBps, bool allowMultipleIssuance, uint256 maxPerRecipient, uint256 maxTotalSupply))",
];

function normalizeKey(key: string): string {
  const trimmed = key.trim();
  return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
}

async function safeExecTransaction(
  safe: ethers.Contract,
  ownerWallet: ethers.Wallet,
  to: string,
  data: string,
  gasPrice: bigint,
): Promise<string> {
  const nonce = await safe.nonce();
  const safeTxGas = 0n;
  const baseGas = 0n;
  const gasPriceSafe = 0n;
  const gasToken = ethers.ZeroAddress;
  const refundReceiver = ethers.ZeroAddress;
  const operation = 0; // CALL

  const txHash = await safe.getTransactionHash(
    to,
    0n,
    data,
    operation,
    safeTxGas,
    baseGas,
    gasPriceSafe,
    gasToken,
    refundReceiver,
    nonce,
  );

  console.log(`  Safe tx hash: ${txHash}`);
  console.log(`  Safe nonce: ${nonce}`);

  // Safe v1.1.1 signature types:
  //   v=0: approved hash (requires prior approveHash call)
  //   v=1: on-chain approval (msg.sender == address in r)
  //   v>30: eth_sign (v-4)
  //   v=27/28: EIP-712
  // Since we're sending from the owner wallet (msg.sender == owner),
  // we use v=1 with r = owner address (padded to 32 bytes), s=0.
  const signatures = ethers.solidityPacked(
    ["bytes32", "uint256", "uint8"],
    [ethers.zeroPadValue(ownerWallet.address, 32), 0, 1],
  );

  console.log("  Submitting execTransaction from owner wallet...");

  // Connect the Safe contract to the owner wallet so msg.sender == owner
  const safeWithOwner = safe.connect(ownerWallet);
  const tx = await safeWithOwner.execTransaction(
    to,
    0n,
    data,
    operation,
    safeTxGas,
    baseGas,
    gasPriceSafe,
    gasToken,
    refundReceiver,
    signatures,
    { gasPrice, gasLimit: 500000n },
  );
  console.log(`  Tx submitted: ${tx.hash}`);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1n) {
    throw new Error(`Safe execTransaction reverted: ${tx.hash}`);
  }
  console.log(`  Confirmed in block ${receipt.blockNumber}`);
  return tx.hash;
}

async function main() {
  const proxyAddress = process.env.RAPPORT_CERTIFICATE_ADDRESS?.trim();
  if (!proxyAddress) throw new Error("RAPPORT_CERTIFICATE_ADDRESS not set");

  const multisigAddress = process.env.MULTISIG_ADDRESS?.trim();
  if (!multisigAddress) throw new Error("MULTISIG_ADDRESS not set");

  const safeOwnerKey = process.env.SAFE_OWNER_PRIVATE_KEY?.trim();
  if (!safeOwnerKey) throw new Error("SAFE_OWNER_PRIVATE_KEY not set");

  const [deployer] = await ethers.getSigners();
  const deployerBalance = await ethers.provider.getBalance(deployer.address);
  console.log("=== RapportCertificate Mainnet Upgrade ===\n");
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Deployer balance: ${ethers.formatEther(deployerBalance)} POL`);
  console.log(`Proxy: ${proxyAddress}`);
  console.log(`Multisig (Safe): ${multisigAddress}`);

  const ownerWallet = new ethers.Wallet(normalizeKey(safeOwnerKey), ethers.provider);
  console.log(`Safe owner: ${ownerWallet.address}`);
  const ownerBalance = await ethers.provider.getBalance(ownerWallet.address);
  console.log(`Safe owner balance: ${ethers.formatEther(ownerBalance)} POL\n`);

  // Verify the Safe
  const safe = new ethers.Contract(multisigAddress, SAFE_ABI, ethers.provider);
  const threshold = await safe.getThreshold();
  const owners = await safe.getOwners();
  console.log(`Safe threshold: ${threshold}`);
  console.log(`Safe owners: ${owners}`);
  if (Number(threshold) !== 1) {
    throw new Error(`Safe threshold is ${threshold}, expected 1`);
  }
  if (owners[0].toLowerCase() !== ownerWallet.address.toLowerCase()) {
    throw new Error(`Safe owner mismatch: expected ${ownerWallet.address}, got ${owners[0]}`);
  }

  // Read pre-upgrade state
  const cert = new ethers.Contract(proxyAddress, CERT_ABI, ethers.provider);
  const phaseCountBefore = await cert.phaseCount();
  const currentPhaseIdBefore = await cert.currentPhaseId();
  const totalCertsBefore = await cert.totalCertificates();
  console.log(`\nPre-upgrade state:`);
  console.log(`  Phase count: ${phaseCountBefore}`);
  console.log(`  Current phase ID: ${currentPhaseIdBefore}`);
  console.log(`  Total certificates: ${totalCertsBefore}`);

  // Read current implementation
  const implSlot = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
  const implRaw = await ethers.provider.getStorage(proxyAddress, implSlot);
  const oldImpl = "0x" + implRaw.slice(-40);
  console.log(`  Old implementation: ${oldImpl}`);

  // Get gas price
  const feeData = await ethers.provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? 30_000_000_000n;
  console.log(`\nGas price: ${ethers.formatUnits(gasPrice, "gwei")} gwei`);

  // Step 1: Deploy new implementation (or reuse if already deployed)
  console.log("\n--- Step 1: Deploy new RapportCertificateUpgradeable implementation ---");
  let newImplAddress = process.env.NEW_CERTIFICATE_IMPL_ADDRESS?.trim();
  if (newImplAddress && ethers.isAddress(newImplAddress)) {
    const code = await ethers.provider.getCode(newImplAddress);
    if (code === "0x") throw new Error(`NEW_CERTIFICATE_IMPL_ADDRESS has no code: ${newImplAddress}`);
    console.log(`  Reusing existing implementation: ${newImplAddress}`);
  } else {
    const Certificate = await ethers.getContractFactory("RapportCertificateUpgradeable");
    const newImpl = await Certificate.deploy({ gasPrice });
    await newImpl.waitForDeployment();
    newImplAddress = await newImpl.getAddress();
    console.log(`  New implementation deployed: ${newImplAddress}`);
  }

  // Step 2: Deploy PhaseAdminFacet (or reuse if already deployed)
  console.log("\n--- Step 2: Deploy RapportCertificatePhaseAdminFacet ---");
  let facetAddress = process.env.NEW_PHASE_ADMIN_FACET_ADDRESS?.trim();
  if (facetAddress && ethers.isAddress(facetAddress)) {
    const code = await ethers.provider.getCode(facetAddress);
    if (code === "0x") throw new Error(`NEW_PHASE_ADMIN_FACET_ADDRESS has no code: ${facetAddress}`);
    console.log(`  Reusing existing facet: ${facetAddress}`);
  } else {
    const Facet = await ethers.getContractFactory("RapportCertificatePhaseAdminFacet");
    const facet = await Facet.deploy({ gasPrice });
    await facet.waitForDeployment();
    facetAddress = await facet.getAddress();
    console.log(`  PhaseAdminFacet deployed: ${facetAddress}`);
  }

  // Step 3: Upgrade proxy via Safe
  console.log("\n--- Step 3: Upgrade proxy to new implementation via Safe ---");
  // upgradeToAndCall(address,bytes) selector: 0x4f1ef286
  // The old implementation only exposes upgradeToAndCall, not upgradeTo
  const upgradeData = new ethers.Interface(["function upgradeToAndCall(address,bytes)"]).encodeFunctionData(
    "upgradeToAndCall",
    [newImplAddress, "0x"],
  );
  console.log(`  upgradeTo data: ${upgradeData}`);
  const upgradeTxHash = await safeExecTransaction(
    safe,
    ownerWallet,
    proxyAddress,
    upgradeData,
    gasPrice,

  );
  console.log(`  Upgrade confirmed: ${upgradeTxHash}`);

  // Verify new implementation
  const implRawAfter = await ethers.provider.getStorage(proxyAddress, implSlot);
  const newImplOnProxy = "0x" + implRawAfter.slice(-40);
  console.log(`  New implementation on proxy: ${newImplOnProxy}`);
  if (newImplOnProxy.toLowerCase() !== newImplAddress.toLowerCase()) {
    throw new Error(`Implementation mismatch! Expected ${newImplAddress}, got ${newImplOnProxy}`);
  }

  // Step 4: Set phase admin facet via Safe
  console.log("\n--- Step 4: Set PhaseAdminFacet address via Safe ---");
  const setFacetData = new ethers.Interface(["function setPhaseAdminFacet(address)"]).encodeFunctionData(
    "setPhaseAdminFacet",
    [facetAddress],
  );
  console.log(`  setPhaseAdminFacet data: ${setFacetData}`);
  const setFacetTxHash = await safeExecTransaction(
    safe,
    ownerWallet,
    proxyAddress,
    setFacetData,
    gasPrice,

  );
  console.log(`  setPhaseAdminFacet confirmed: ${setFacetTxHash}`);

  // Step 5: Verify state preservation
  console.log("\n--- Step 5: Verify state preservation ---");
  const certAfter = new ethers.Contract(proxyAddress, CERT_ABI, ethers.provider);
  const phaseCountAfter = await certAfter.phaseCount();
  const currentPhaseIdAfter = await certAfter.currentPhaseId();
  const totalCertsAfter = await certAfter.totalCertificates();
  const facetAfter = await certAfter.phaseAdminFacet();

  console.log(`  Phase count: ${phaseCountBefore} -> ${phaseCountAfter} ${phaseCountBefore === phaseCountAfter ? "✓" : "✗"}`);
  console.log(`  Current phase ID: ${currentPhaseIdBefore} -> ${currentPhaseIdAfter} ${currentPhaseIdBefore === currentPhaseIdAfter ? "✓" : "✗"}`);
  console.log(`  Total certificates: ${totalCertsBefore} -> ${totalCertsAfter} ${totalCertsBefore === totalCertsAfter ? "✓" : "✗"}`);
  console.log(`  PhaseAdminFacet: ${facetAfter} ${facetAfter.toLowerCase() === facetAddress.toLowerCase() ? "✓" : "✗"}`);

  if (phaseCountBefore !== phaseCountAfter || totalCertsBefore !== totalCertsAfter) {
    throw new Error("State preservation check FAILED!");
  }

  // Read phase 1 to verify struct compatibility
  const phase1 = await certAfter.getPhase(1);
  console.log(`\n  Phase 1 name: ${phase1.name}`);
  console.log(`  Phase 1 minted: ${phase1.minted}`);
  console.log(`  Phase 1 active: ${phase1.active}`);
  console.log(`  Phase 1 allowMultipleIssuance: ${phase1.allowMultipleIssuance}`);
  console.log(`  Phase 1 maxPerRecipient: ${phase1.maxPerRecipient}`);
  console.log(`  Phase 1 maxTotalSupply: ${phase1.maxTotalSupply}`);

  console.log("\n=== Upgrade Complete ===");
  console.log("\nSummary:");
  console.log(`  Proxy: ${proxyAddress} (unchanged)`);
  console.log(`  Old implementation: ${oldImpl}`);
  console.log(`  New implementation: ${newImplAddress}`);
  console.log(`  PhaseAdminFacet: ${facetAddress}`);
  console.log(`  Upgrade tx: ${upgradeTxHash}`);
  console.log(`  SetFacet tx: ${setFacetTxHash}`);
  console.log("\nNext steps:");
  console.log("  1. Verify on Polygonscan");
  console.log("  2. Update .env files (frontend, frontend_dashboard, backend)");
  console.log("  3. Update RAPPORT_CERTIFICATE_IMPL_ADDRESS in smartcontracts/.env");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`\nError: ${error.message ?? error}`);
    process.exit(1);
  });
