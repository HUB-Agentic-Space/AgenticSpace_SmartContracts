import { ethers, network } from "hardhat";
import payload from "../../deployments/casswap-timelock-cut.json";

const SAFE = "0x1743abe1A64DAB3c81e394adb4e3B56ef05F0D26";
const DIAMOND_OWNER = "0x8950dD90B86D72e3F03A6d47Fb25B92808d40c7a";
const OWNER_2 = "0x253174e88515beCB71444229BaC1461c26A5d5D7";
const OWNER_3 = "0x06aE104567Fe969ba57371940730111FaeD33E9a";

const SAFE_ABI = [
  "function nonce() view returns(uint256)",
  "function getOwners() view returns(address[])",
  "function getThreshold() view returns(uint256)",
  "function getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256) view returns(bytes32)",
  "function execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address payable,bytes) returns(bool)",
];

function log(level: string, message: string, details = ""): void {
  const timestamp = new Date().toISOString().replace("T", " ").replace("Z", "");
  console.log(`[${timestamp}] [30_transfer_and_schedule_casswap_cut:main] ${level} ${message}${details ? ` - ${details}` : ""}`);
}

function walletFrom(variable: string): ethers.Wallet {
  const value = process.env[variable]?.trim();
  if (!value) throw new Error(`${variable} is not configured`);
  return new ethers.Wallet(value.startsWith("0x") ? value : `0x${value}`, ethers.provider);
}

async function main(): Promise<void> {
  if (network.config.chainId !== 137) throw new Error("This script only runs on Polygon mainnet (chainId 137)");
  const diamondOwner = walletFrom("RELAYER_PRIVATE_KEY");
  const payer = walletFrom("SAFE_OWNER_PRIVATE_KEY");
  const signer2 = walletFrom("SAFE_OWNER_PRIVATE_KEY_2");
  const signer3 = walletFrom("SAFE_OWNER_PRIVATE_KEY_3");
  if (diamondOwner.address.toLowerCase() !== DIAMOND_OWNER.toLowerCase()) throw new Error("RELAYER_PRIVATE_KEY does not control the Diamond");
  if (signer2.address.toLowerCase() !== OWNER_2.toLowerCase()) throw new Error("Owner 2 key mismatch");
  if (signer3.address.toLowerCase() !== OWNER_3.toLowerCase()) throw new Error("Owner 3 key mismatch");

  const ownership = await ethers.getContractAt("OwnershipFacet", payload.diamond, diamondOwner);
  if ((await ownership.owner()).toLowerCase() !== DIAMOND_OWNER.toLowerCase()) throw new Error("Unexpected Diamond owner");
  await ownership.transferOwnership.staticCall(payload.timelock);

  const safe = new ethers.Contract(SAFE, SAFE_ABI, ethers.provider);
  const owners = (await safe.getOwners()).map((owner: string) => owner.toLowerCase());
  if (await safe.getThreshold() !== 2n || !owners.includes(OWNER_2.toLowerCase()) || !owners.includes(OWNER_3.toLowerCase())) {
    throw new Error("Safe is not in the expected 2-of-3 state");
  }
  const nonce = await safe.nonce();
  if (nonce !== 11n) throw new Error(`Expected Safe nonce 11, received ${nonce}`);

  const schedule = payload.safeScheduleTransaction;
  const safeTxHash = await safe.getTransactionHash(
    schedule.to, 0, schedule.data, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, nonce,
  );
  const signatures = [signer2, signer3]
    .sort((a, b) => a.address.toLowerCase().localeCompare(b.address.toLowerCase()))
    .map((wallet) => wallet.signingKey.sign(safeTxHash).serialized);
  const packedSignatures = ethers.concat(signatures);
  const safeWithPayer = safe.connect(payer);
  const execArgs = [schedule.to, 0, schedule.data, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, packedSignatures] as const;
  const accepted = await safeWithPayer.execTransaction.staticCall(...execArgs);
  if (!accepted) throw new Error("Safe rejected schedule simulation");

  const ownershipTx = await ownership.transferOwnership(payload.timelock);
  log("info", "ownership_transfer_submitted", `tx=${ownershipTx.hash} timelock=${payload.timelock}`);
  await ownershipTx.wait();
  if ((await ownership.owner()).toLowerCase() !== payload.timelock.toLowerCase()) throw new Error("Diamond ownership transfer was not applied");
  log("info", "ownership_transfer_confirmed", `tx=${ownershipTx.hash}`);

  const scheduleTx = await safeWithPayer.execTransaction(...execArgs);
  log("info", "schedule_submitted", `safeNonce=${nonce} tx=${scheduleTx.hash} operationId=${payload.operationId}`);
  const receipt = await scheduleTx.wait();
  if (!receipt || receipt.status !== 1) throw new Error(`Schedule transaction failed: ${scheduleTx.hash}`);

  const timelock = new ethers.Contract(payload.timelock, [
    "function isOperationPending(bytes32) view returns(bool)",
    "function getTimestamp(bytes32) view returns(uint256)",
  ], ethers.provider);
  if (!(await timelock.isOperationPending(payload.operationId))) throw new Error("Operation is not pending in timelock");
  log("info", "schedule_confirmed", `tx=${scheduleTx.hash} readyAt=${await timelock.getTimestamp(payload.operationId)}`);
}

main().catch((error) => {
  log("error", "transfer_or_schedule_failed", `message=${error.shortMessage ?? error.message}`);
  process.exitCode = 1;
});
