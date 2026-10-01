import { ethers, network } from "hardhat";
import payload from "../../deployments/casswap-multiasset-cut.json";

const SAFE = "0x1743abe1A64DAB3c81e394adb4e3B56ef05F0D26";
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
  console.log(`[${timestamp}] [34_schedule_casswap_multiasset_cut:main] ${level} ${message}${details ? ` - ${details}` : ""}`);
}

function walletFrom(variable: string): ethers.Wallet {
  const value = process.env[variable]?.trim();
  if (!value) throw new Error(`${variable} is not configured`);
  return new ethers.Wallet(value.startsWith("0x") ? value : `0x${value}`, ethers.provider);
}

async function main(): Promise<void> {
  if (network.config.chainId !== 137) throw new Error("This script only runs on Polygon mainnet (chainId 137)");
  const payer = walletFrom("SAFE_OWNER_PRIVATE_KEY");
  const signer2 = walletFrom("SAFE_OWNER_PRIVATE_KEY_2");
  const signer3 = walletFrom("SAFE_OWNER_PRIVATE_KEY_3");
  if (signer2.address.toLowerCase() !== OWNER_2.toLowerCase()) throw new Error("Owner 2 key mismatch");
  if (signer3.address.toLowerCase() !== OWNER_3.toLowerCase()) throw new Error("Owner 3 key mismatch");

  // A posse do Diamond já está com o Timelock desde o corte anterior;
  // aqui só agendamos a operação preparada pelo script 32.
  const ownership = await ethers.getContractAt("OwnershipFacet", payload.diamond, payer);
  const owner = await ownership.owner();
  if (owner.toLowerCase() !== payload.timelock.toLowerCase()) {
    throw new Error(`Diamond owner is ${owner}, expected timelock ${payload.timelock}`);
  }

  const safe = new ethers.Contract(SAFE, SAFE_ABI, ethers.provider);
  const owners = (await safe.getOwners()).map((ownerAddress: string) => ownerAddress.toLowerCase());
  if (await safe.getThreshold() !== 2n || !owners.includes(OWNER_2.toLowerCase()) || !owners.includes(OWNER_3.toLowerCase())) {
    throw new Error("Safe is not in the expected 2-of-3 state");
  }
  const nonce = await safe.nonce();
  log("info", "safe_state", `nonce=${nonce} threshold=2 owners=${owners.length}`);

  const timelock = new ethers.Contract(payload.timelock, [
    "function isOperationPending(bytes32) view returns(bool)",
    "function isOperationDone(bytes32) view returns(bool)",
    "function getTimestamp(bytes32) view returns(uint256)",
  ], ethers.provider);
  if (await timelock.isOperationDone(payload.operationId)) {
    log("info", "operation_already_executed", `operationId=${payload.operationId}`);
    return;
  }
  if (await timelock.isOperationPending(payload.operationId)) {
    log("info", "operation_already_scheduled", `operationId=${payload.operationId} readyAt=${await timelock.getTimestamp(payload.operationId)}`);
    return;
  }

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

  const scheduleTx = await safeWithPayer.execTransaction(...execArgs);
  log("info", "schedule_submitted", `safeNonce=${nonce} tx=${scheduleTx.hash} operationId=${payload.operationId}`);
  const receipt = await scheduleTx.wait();
  if (!receipt || receipt.status !== 1) throw new Error(`Schedule transaction failed: ${scheduleTx.hash}`);

  if (!(await timelock.isOperationPending(payload.operationId))) throw new Error("Operation is not pending in timelock");
  const readyAt = await timelock.getTimestamp(payload.operationId);
  log("info", "schedule_confirmed", `tx=${scheduleTx.hash} readyAt=${readyAt} readyAtISO=${new Date(Number(readyAt) * 1000).toISOString()}`);
}

main().catch((error) => {
  log("error", "schedule_failed", `message=${error.shortMessage ?? error.message}`);
  process.exitCode = 1;
});
