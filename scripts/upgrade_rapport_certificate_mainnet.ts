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
import { ethers, upgrades, network } from "hardhat";

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
  "function phases(uint256) view returns (string name, bytes32 templateHash, uint256 minCasDeposit, uint256 startsAt, uint256 endsAt, uint256 minted, bool active, string skillsDescription, string instructions, uint256 extraFeeTypeId, uint256 tbaRebateBps, bool allowMultipleIssuance, uint256 maxPerRecipient, uint256 maxTotalSupply)",
];

function normalizeKey(key: string): string {
  const trimmed = key.trim();
  return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
}

/// Proposes a Safe transaction to the Safe Transaction Service so the
/// remaining owners can review, co-sign and execute it in the Safe UI.
/// Signs `safeTxHash` with the owner wallet using eth_sign (v += 4), the
/// signature scheme accepted by the service for off-chain proposals.
async function safeProposeTransaction(
  safe: ethers.Contract,
  ownerWallet: ethers.Wallet,
  safeAddress: string,
  chainId: bigint,
  to: string,
  data: string,
  nonceOverride?: bigint,
): Promise<string> {
  const nonce = nonceOverride ?? (await safe.nonce());
  const operation = 0;
  const safeTxHash = await safe.getTransactionHash(
    to, 0n, data, operation, 0n, 0n, 0n,
    ethers.ZeroAddress, ethers.ZeroAddress, nonce,
  );

  const raw = await ownerWallet.signMessage(ethers.getBytes(safeTxHash));
  const sig = ethers.Signature.from(raw);
  const signature = ethers.solidityPacked(
    ["bytes32", "bytes32", "uint8"],
    [sig.r, sig.s, sig.v + 4],
  );

  const base = `https://safe-transaction-polygon.safe.global/api/v1/safes/${safeAddress}/multisig-transactions/`;
  const body = {
    to, value: "0", data, operation,
    gasToken: ethers.ZeroAddress,
    safeTxGas: "0", baseGas: "0", gasPrice: "0",
    refundReceiver: ethers.ZeroAddress,
    nonce: nonce.toString(),
    contractTransactionHash: safeTxHash,
    sender: ownerWallet.address,
    signature,
    origin: "upgrade_rapport_certificate_mainnet.ts",
  };
  const resp = await fetch(base, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Safe proposal failed (${resp.status}): ${text}`);
  }
  console.log(`  Proposed Safe tx (nonce ${nonce}): ${safeTxHash}`);
  return safeTxHash;
}

/// Executes a Safe transaction with threshold > 1 by collecting an
/// eth_sign signature (v += 4) over `safeTxHash` from every available
/// owner wallet. Signatures are packed sorted by owner address, as
/// required by Safe's checkSignatures. `executor` only pays gas.
async function safeExecTransactionMultisig(
  safe: ethers.Contract,
  signerWallets: ethers.Wallet[],
  executor: ethers.Wallet,
  to: string,
  data: string,
  gasPrice: bigint,
): Promise<string> {
  const nonce = await safe.nonce();
  const txHash = await safe.getTransactionHash(
    to, 0n, data, 0, 0n, 0n, 0n,
    ethers.ZeroAddress, ethers.ZeroAddress, nonce,
  );
  console.log(`  Safe tx hash: ${txHash}`);
  console.log(`  Safe nonce: ${nonce}`);

  // Approve the tx hash on-chain from every signer wallet, then use
  // pre-approved-hash signatures (r = owner, s = 0, v = 1) in execTransaction.
  const approveIface = new ethers.Interface(["function approveHash(bytes32)"]);
  for (const w of signerWallets) {
    const approveTx = await w.sendTransaction({
      to: await safe.getAddress(),
      data: approveIface.encodeFunctionData("approveHash", [txHash]),
      gasPrice,
      gasLimit: 100000n,
    });
    const approveReceipt = await approveTx.wait();
    if (!approveReceipt || approveReceipt.status !== 1) {
      throw new Error(`approveHash reverted for ${w.address}: ${approveTx.hash}`);
    }
    console.log(`  approveHash confirmed for ${w.address} (${approveTx.hash})`);
  }

  const sigs = signerWallets
    .map((w) => ({
      address: w.address.toLowerCase(),
      packed: ethers.solidityPacked(
        ["bytes32", "uint256", "uint8"],
        [ethers.zeroPadValue(w.address, 32), 0, 1],
      ),
    }))
    .sort((a, b) => (a.address < b.address ? -1 : 1));
  const signatures = ethers.concat(sigs.map((s) => s.packed));
  console.log(`  Packed ${sigs.length} pre-approved owner signatures`);

  const safeWithExecutor = safe.connect(executor);
  const tx = await safeWithExecutor.execTransaction(
    to, 0n, data, 0, 0n, 0n, 0n,
    ethers.ZeroAddress, ethers.ZeroAddress, signatures,
    { gasPrice, gasLimit: 600000n },
  );
  console.log(`  Tx submitted: ${tx.hash}`);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(`Safe execTransaction reverted: ${tx.hash}`);
  }
  console.log(`  Confirmed in block ${receipt.blockNumber}`);
  return tx.hash;
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
  if (!receipt || receipt.status !== 1) {
    throw new Error(`Safe execTransaction reverted: ${tx.hash}`);
  }
  console.log(`  Confirmed in block ${receipt.blockNumber}`);
  return tx.hash;
}

async function main() {
  // Fork smoke mode: CERTIFICATE_FORK_SMOKE=1 resets the local node onto a
  // Polygon mainnet fork (config-time `forking` fails hardfork detection on
  // this toolchain, so we fork at runtime like the smoke script does).
  if (process.env.CERTIFICATE_FORK_SMOKE === "1") {
    const forkUrl = process.env.POLYGON_RPC_URL?.trim();
    if (!forkUrl) throw new Error("POLYGON_RPC_URL required for fork smoke");
    const forkBlock = Number(process.env.CERTIFICATE_FORK_BLOCK ?? 96580593);
    await network.provider.request({
      method: "hardhat_reset",
      params: [{ forking: { jsonRpcUrl: forkUrl, blockNumber: forkBlock } }],
    });
    console.log(`[fork-smoke] Fork pinned at block ${forkBlock}.`);
    console.log("[fork-smoke] Local node reset onto Polygon mainnet fork.");
  }

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
  console.log(`Safe owner balance: ${ethers.formatEther(ownerBalance)} POL`);

  // Additional owner keys for multi-signature execution (SAFE_OWNER_PRIVATE_KEY_2, _3, ...)
  const extraOwnerWallets: ethers.Wallet[] = [];
  for (let i = 2; ; i++) {
    const key = process.env[`SAFE_OWNER_PRIVATE_KEY_${i}`]?.trim();
    if (!key) break;
    const w = new ethers.Wallet(normalizeKey(key), ethers.provider);
    const bal = await ethers.provider.getBalance(w.address);
    console.log(`Safe owner ${i}: ${w.address} (${ethers.formatEther(bal)} POL)`);
    extraOwnerWallets.push(w);
  }
  console.log();

  // Verify the Safe
  const safe = new ethers.Contract(multisigAddress, SAFE_ABI, ethers.provider);
  const threshold = Number(await safe.getThreshold());
  const owners = await safe.getOwners();
  console.log(`Safe threshold: ${threshold}`);
  console.log(`Safe owners: ${owners}`);
  const ownerSet = new Set(owners.map((o: string) => o.toLowerCase()));
  if (!ownerSet.has(ownerWallet.address.toLowerCase())) {
    throw new Error(`Safe owner wallet ${ownerWallet.address} is not an owner of ${multisigAddress}`);
  }
  const signerWallets = [ownerWallet, ...extraOwnerWallets].filter(
    (w, i, arr) =>
      ownerSet.has(w.address.toLowerCase()) &&
      arr.findIndex((x) => x.address.toLowerCase() === w.address.toLowerCase()) === i,
  );
  console.log(`Owner wallets available for signing: ${signerWallets.length}/${threshold} required`);
  // With threshold > 1 we can only execute if enough owner keys are present;
  // otherwise we propose the transactions to the Safe Transaction Service.
  const proposeOnly = threshold !== 1 && signerWallets.length < threshold;
  if (proposeOnly) {
    console.log(
      `  Threshold ${threshold} > 1 and only ${signerWallets.length} owner key(s) ` +
      "available: executing deploy steps only; the Safe transactions will be " +
      "proposed to the Safe Transaction Service for co-signing.",
    );
  } else if (threshold !== 1) {
    console.log(`  Threshold ${threshold} satisfied locally: executing Safe txs with collected signatures.`);
  }
  if (threshold === 1 && owners[0].toLowerCase() !== ownerWallet.address.toLowerCase()) {
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
  const setFacetData = new ethers.Interface(["function setPhaseAdminFacet(address)"]).encodeFunctionData(
    "setPhaseAdminFacet",
    [facetAddress],
  );

  let upgradeTxHash = "";
  let setFacetTxHash = "";

  if (proposeOnly) {
    const network = await ethers.provider.getNetwork();
    const currentNonce = await safe.nonce();
    await safeProposeTransaction(
      safe, ownerWallet, multisigAddress, network.chainId,
      proxyAddress, upgradeData, currentNonce,
    );
    await safeProposeTransaction(
      safe, ownerWallet, multisigAddress, network.chainId,
      proxyAddress, setFacetData, currentNonce + 1n,
    );
    console.log("\n--- Steps 3-4 proposed. Awaiting co-signatures in the Safe UI ---");
    console.log("  After execution of both txs, re-run with NEW_CERTIFICATE_IMPL_ADDRESS");
    console.log("  and NEW_PHASE_ADMIN_FACET_ADDRESS set to verify state preservation.");
    console.log(`  Proposed implementation: ${newImplAddress}`);
    console.log(`  Proposed facet:          ${facetAddress}`);
    return;
  }

  const execSafeTx = threshold === 1
    ? (to: string, data: string) => safeExecTransaction(safe, ownerWallet, to, data, gasPrice)
    : (to: string, data: string) =>
        safeExecTransactionMultisig(safe, signerWallets, ownerWallet, to, data, gasPrice);

  upgradeTxHash = await execSafeTx(proxyAddress, upgradeData);
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
  console.log(`  setPhaseAdminFacet data: ${setFacetData}`);
  setFacetTxHash = await execSafeTx(proxyAddress, setFacetData);
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
  const phase1 = await certAfter.phases(1);
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
