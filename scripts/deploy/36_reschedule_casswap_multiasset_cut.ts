import { ethers, network } from "hardhat";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { IDiamondCut } from "../../typechain-types";

const SAFE = "0x1743abe1A64DAB3c81e394adb4e3B56ef05F0D26";
const OWNER_2 = "0x253174e88515beCB71444229BaC1461c26A5d5D7";
const OWNER_3 = "0x06aE104567Fe969ba57371940730111FaeD33E9a";
const PAYLOAD_PATH = resolve(__dirname, "../../deployments/casswap-multiasset-cut.json");
const COLLIDING_SELECTOR = "0xace942fe"; // setAllSwapRatios — instalado pelo corte anterior

const SAFE_ABI = [
  "function nonce() view returns(uint256)",
  "function getOwners() view returns(address[])",
  "function getThreshold() view returns(uint256)",
  "function getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256) view returns(bytes32)",
  "function execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address payable,bytes) returns(bool)",
];

function log(level: string, message: string, details = ""): void {
  const timestamp = new Date().toISOString().replace("T", " ").replace("Z", "");
  console.log(`[${timestamp}] [36_reschedule_casswap_multiasset_cut:main] ${level} ${message}${details ? ` - ${details}` : ""}`);
}

function walletFrom(variable: string): ethers.Wallet {
  const value = process.env[variable]?.trim();
  if (!value) throw new Error(`${variable} is not configured`);
  return new ethers.Wallet(value.startsWith("0x") ? value : `0x${value}`, ethers.provider);
}

async function safeExec(
  safe: ethers.Contract,
  payer: ethers.Wallet,
  signers: ethers.Wallet[],
  to: string,
  data: string,
): Promise<ethers.TransactionReceipt> {
  const nonce = await safe.nonce();
  const safeTxHash = await safe.getTransactionHash(
    to, 0, data, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, nonce,
  );
  const signatures = [...signers]
    .sort((a, b) => a.address.toLowerCase().localeCompare(b.address.toLowerCase()))
    .map((wallet) => wallet.signingKey.sign(safeTxHash).serialized);
  const execArgs = [to, 0, data, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, ethers.concat(signatures)] as const;
  const safeWithPayer = safe.connect(payer);
  if (!(await safeWithPayer.execTransaction.staticCall(...execArgs))) {
    throw new Error("Safe rejected transaction simulation");
  }
  const tx = await safeWithPayer.execTransaction(...execArgs);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error(`Safe transaction failed: ${tx.hash}`);
  log("info", "safe_exec_confirmed", `nonce=${nonce} tx=${tx.hash}`);
  return receipt;
}

async function main(): Promise<void> {
  if (network.config.chainId !== 137) throw new Error("This script only runs on Polygon mainnet (chainId 137)");
  const payload = JSON.parse(readFileSync(PAYLOAD_PATH, "utf8"));
  const payer = walletFrom("SAFE_OWNER_PRIVATE_KEY");
  const signer2 = walletFrom("SAFE_OWNER_PRIVATE_KEY_2");
  const signer3 = walletFrom("SAFE_OWNER_PRIVATE_KEY_3");
  if (signer2.address.toLowerCase() !== OWNER_2.toLowerCase()) throw new Error("Owner 2 key mismatch");
  if (signer3.address.toLowerCase() !== OWNER_3.toLowerCase()) throw new Error("Owner 3 key mismatch");

  const safe = new ethers.Contract(SAFE, SAFE_ABI, ethers.provider);
  const owners = (await safe.getOwners()).map((o: string) => o.toLowerCase());
  if (await safe.getThreshold() !== 2n || !owners.includes(OWNER_2.toLowerCase()) || !owners.includes(OWNER_3.toLowerCase())) {
    throw new Error("Safe is not in the expected 2-of-3 state");
  }

  const timelockIface = new ethers.Interface([
    "function cancel(bytes32 id)",
    "function schedule(address target,uint256 value,bytes data,bytes32 predecessor,bytes32 salt,uint256 delay)",
    "function hashOperation(address target,uint256 value,bytes data,bytes32 predecessor,bytes32 salt) view returns(bytes32)",
    "function isOperationPending(bytes32) view returns(bool)",
    "function isOperationDone(bytes32) view returns(bool)",
    "function getTimestamp(bytes32) view returns(uint256)",
  ]);
  const timelock = new ethers.Contract(payload.timelock, timelockIface, ethers.provider);

  // 1. Reclassifica o seletor colidido: na execução (após o corte anterior)
  //    setAllSwapRatios já existirá no Diamond, logo deve ser Replace.
  const addSet = payload.addSelectors as { selector: string; signature: string }[];
  const colliding = addSet.filter((e) => e.selector === COLLIDING_SELECTOR);
  if (colliding.length === 0) {
    log("info", "already_fixed", "setAllSwapRatios not in add list");
  } else {
    payload.addSelectors = addSet.filter((e) => e.selector !== COLLIDING_SELECTOR);
    payload.replaceSelectors = [...payload.replaceSelectors, ...colliding];
    const cuts: IDiamondCut.FacetCutStruct[] = [];
    if (payload.replaceSelectors.length > 0) {
      cuts.push({ facetAddress: payload.facet, action: 1, functionSelectors: payload.replaceSelectors.map((e: { selector: string }) => e.selector) });
    }
    if (payload.addSelectors.length > 0) {
      cuts.push({ facetAddress: payload.facet, action: 0, functionSelectors: payload.addSelectors.map((e: { selector: string }) => e.selector) });
    }
    const cutInterface = new ethers.Interface([
      "function diamondCut((address facetAddress,uint8 action,bytes4[] functionSelectors)[] cut,address init,bytes calldata data)",
    ]);
    payload.cuts = cuts;
    payload.cutCalldata = cutInterface.encodeFunctionData("diamondCut", [cuts, payload.initAddress, payload.initCalldata]);
    payload.operationId = await timelock.hashOperation(
      payload.diamond, 0, payload.cutCalldata, payload.predecessor, payload.salt,
    );
    payload.safeScheduleTransaction = {
      to: payload.timelock,
      value: "0",
      data: timelockIface.encodeFunctionData("schedule", [
        payload.diamond, 0, payload.cutCalldata, payload.predecessor, payload.salt, BigInt(payload.delaySeconds),
      ]),
    };
    writeFileSync(PAYLOAD_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    log("info", "payload_fixed", `moved=${colliding.map((e) => e.signature).join(",")} newOperationId=${payload.operationId}`);
  }

  // 2. Cancela a operação antiga (calldata com add inválido) se ainda pendente.
  const oldOperationId = "0x7a8ee037192db4aafd596290f85b0b924aa8c6533a928943571a5c6c0062f66b";
  if (oldOperationId !== payload.operationId && await timelock.isOperationPending(oldOperationId)) {
    await safeExec(safe, payer, [signer2, signer3], payload.timelock, timelockIface.encodeFunctionData("cancel", [oldOperationId]));
    log("info", "old_operation_cancelled", `operationId=${oldOperationId}`);
  }

  // 3. Agenda a operação corrigida.
  if (await timelock.isOperationPending(payload.operationId)) {
    log("info", "operation_already_scheduled", `operationId=${payload.operationId} readyAt=${await timelock.getTimestamp(payload.operationId)}`);
    return;
  }
  await safeExec(safe, payer, [signer2, signer3], payload.timelock, payload.safeScheduleTransaction.data);
  if (!(await timelock.isOperationPending(payload.operationId))) throw new Error("Operation is not pending in timelock");
  const readyAt = await timelock.getTimestamp(payload.operationId);
  log("info", "schedule_confirmed", `operationId=${payload.operationId} readyAt=${readyAt} readyAtISO=${new Date(Number(readyAt) * 1000).toISOString()}`);
}

main().catch((error) => {
  log("error", "reschedule_failed", `message=${error.shortMessage ?? error.message}`);
  process.exitCode = 1;
});
