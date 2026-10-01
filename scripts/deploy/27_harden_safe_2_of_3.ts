import { ethers, network } from "hardhat";

const SAFE = "0x1743abe1A64DAB3c81e394adb4e3B56ef05F0D26";
const CURRENT_OWNER = "0x63cf627357A9C4C8EabA4b3d2d563dE825d71f25";
const OWNER_2 = "0x253174e88515beCB71444229BaC1461c26A5d5D7";
const OWNER_3 = "0x06aE104567Fe969ba57371940730111FaeD33E9a";

const SAFE_ABI = [
  "function nonce() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function addOwnerWithThreshold(address owner,uint256 threshold)",
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address payable refundReceiver,bytes signatures) returns (bool)",
];

function log(level: string, message: string, details = ""): void {
  const timestamp = new Date().toISOString().replace("T", " ").replace("Z", "");
  console.log(`[${timestamp}] [27_harden_safe_2_of_3:main] ${level} ${message}${details ? ` - ${details}` : ""}`);
}

function walletFrom(variable: string): ethers.Wallet {
  const value = process.env[variable]?.trim();
  if (!value) throw new Error(`${variable} is not configured`);
  return new ethers.Wallet(value.startsWith("0x") ? value : `0x${value}`, ethers.provider);
}

function prevalidatedSignature(owner: string): string {
  return ethers.solidityPacked(["bytes32", "uint256", "uint8"], [ethers.zeroPadValue(owner, 32), 0, 1]);
}

async function executeAddOwner(
  safe: ethers.Contract,
  signer: ethers.Wallet,
  expectedNonce: bigint,
  owner: string,
  threshold: bigint,
): Promise<string> {
  const nonce = await safe.nonce();
  if (nonce !== expectedNonce) throw new Error(`Safe nonce changed: expected ${expectedNonce}, received ${nonce}`);
  const data = safe.interface.encodeFunctionData("addOwnerWithThreshold", [owner, threshold]);
  const connected = safe.connect(signer);
  const args = [SAFE, 0, data, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, prevalidatedSignature(signer.address)] as const;
  const accepted = await connected.execTransaction.staticCall(...args);
  if (!accepted) throw new Error(`Safe simulation rejected nonce ${nonce}`);
  const transaction = await connected.execTransaction(...args);
  log("info", "safe_transaction_submitted", `nonce=${nonce} tx=${transaction.hash} owner=${owner} threshold=${threshold}`);
  const receipt = await transaction.wait();
  if (!receipt || receipt.status !== 1) throw new Error(`Safe transaction failed: ${transaction.hash}`);
  log("info", "safe_transaction_confirmed", `nonce=${nonce} tx=${transaction.hash} block=${receipt.blockNumber}`);
  return transaction.hash;
}

async function main(): Promise<void> {
  if (network.config.chainId !== 137) throw new Error("This script only runs on Polygon mainnet (chainId 137)");
  const owner1 = walletFrom("SAFE_OWNER_PRIVATE_KEY");
  const owner2 = walletFrom("SAFE_OWNER_PRIVATE_KEY_2");
  if (owner1.address.toLowerCase() !== CURRENT_OWNER.toLowerCase()) throw new Error("SAFE_OWNER_PRIVATE_KEY does not match current owner");
  if (owner2.address.toLowerCase() !== OWNER_2.toLowerCase()) throw new Error("SAFE_OWNER_PRIVATE_KEY_2 does not match owner 2");

  const safe = new ethers.Contract(SAFE, SAFE_ABI, ethers.provider);
  const initialOwners = (await safe.getOwners()).map((owner: string) => owner.toLowerCase());
  const initialThreshold = await safe.getThreshold();
  const initialNonce = await safe.nonce();
  let tx9 = "already-confirmed";

  if (initialNonce === 9n && initialOwners.length === 1 && initialOwners[0] === CURRENT_OWNER.toLowerCase() && initialThreshold === 1n) {
    tx9 = await executeAddOwner(safe, owner1, 9n, OWNER_2, 1n);
  } else if (
    initialNonce !== 10n ||
    initialThreshold !== 1n ||
    initialOwners.length !== 2 ||
    !initialOwners.includes(CURRENT_OWNER.toLowerCase()) ||
    !initialOwners.includes(OWNER_2.toLowerCase())
  ) {
    throw new Error(`Unexpected Safe resume state: nonce=${initialNonce} threshold=${initialThreshold} owners=${initialOwners.join(",")}`);
  }

  const tx10 = await executeAddOwner(safe, owner1, 10n, OWNER_3, 2n);

  const finalOwners = (await safe.getOwners()).map((owner: string) => owner.toLowerCase());
  const expectedOwners = [CURRENT_OWNER, OWNER_2, OWNER_3].map((owner) => owner.toLowerCase());
  if (finalOwners.length !== 3 || expectedOwners.some((owner) => !finalOwners.includes(owner))) {
    throw new Error(`Unexpected final Safe owners: ${finalOwners.join(",")}`);
  }
  if (await safe.getThreshold() !== 2n) throw new Error("Final Safe threshold is not 2");
  log("info", "safe_hardening_completed", `safe=${SAFE} threshold=2 owners=3 tx9=${tx9} tx10=${tx10}`);
}

main().catch((error) => {
  log("error", "safe_hardening_failed", `message=${error.shortMessage ?? error.message}`);
  process.exitCode = 1;
});
