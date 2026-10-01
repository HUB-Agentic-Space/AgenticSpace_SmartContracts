import { ethers, network } from "hardhat";
import * as dotenv from "dotenv";
import * as path from "path";

const SC_ROOT = path.resolve(__dirname, "..", "..");
dotenv.config({ path: path.join(SC_ROOT, ".env") });

if (network.config.chainId !== 137) {
  throw new Error("This script only runs on Polygon mainnet (chainId 137)");
}

const CAS_SWAP_ADDRESS = process.env.CAS_SWAP_ADDRESS!;
const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS!;
const CAS_TOKEN_ADDRESS = process.env.CAS_TOKEN_ADDRESS!;

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

const CASSWAP_ABI = [
  "function paused() view returns (bool)",
  "function pause()",
  "function unpause()",
  "function setRatio(uint256,uint256)",
  "function buyCAS(uint256,uint256) payable returns (uint256)",
  "function getRatio() view returns (uint256,uint256)",
  "function getCASBalance() view returns (uint256)",
  "function getPOLBalance() view returns (uint256)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
];

const RATIO_ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("RATIO_ADMIN_ROLE"));
const PAUSER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("PAUSER_ROLE"));
const EXTREME_NUM = 10_000_000n; // 1 POL = 10M CAS
const MARGIN_BPS = 200n; // 2% margin on POL input
const BPS_DENOMINATOR = 10000n;

function log(level: string, message: string, params?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`[${ts}] [migrate_caswap_via_ratio_trick] ${level} ${message}${params ? ` - ${JSON.stringify(params)}` : ""}`);
}

function fmtCAS(v: bigint): string {
  return ethers.formatEther(v);
}

function fmtPOL(v: bigint): string {
  return ethers.formatEther(v);
}

async function main(): Promise<void> {
  const [signer] = await ethers.getSigners();
  log("INFO", "signer", { address: signer.address });

  const casToken = new ethers.Contract(CAS_TOKEN_ADDRESS, ERC20_ABI, signer);
  const casSwap = new ethers.Contract(CAS_SWAP_ADDRESS, CASSWAP_ABI, signer);

  const isRatioAdmin = await casSwap.hasRole(RATIO_ADMIN_ROLE, signer.address);
  const isPauser = await casSwap.hasRole(PAUSER_ROLE, signer.address);

  if (!isRatioAdmin) throw new Error(`Signer ${signer.address} does not have RATIO_ADMIN_ROLE on CASSwap`);

  const decimals = await casToken.decimals();
  const symbol = await casToken.symbol();
  log("INFO", "token", { symbol, decimals: Number(decimals) });

  const swapCasBefore = await casToken.balanceOf(CAS_SWAP_ADDRESS);
  const swapPolBefore = await ethers.provider.getBalance(CAS_SWAP_ADDRESS);
  const deployerCasBefore = await casToken.balanceOf(signer.address);
  const deployerPolBefore = await ethers.provider.getBalance(signer.address);
  const diamondCasBefore = await casToken.balanceOf(DIAMOND_ADDRESS);
  const diamondPolBefore = await ethers.provider.getBalance(DIAMOND_ADDRESS);

  log("INFO", "balances_before", {
    casswap: { cas: fmtCAS(swapCasBefore), pol: fmtPOL(swapPolBefore) },
    deployer: { cas: fmtCAS(deployerCasBefore), pol: fmtPOL(deployerPolBefore) },
    diamond: { cas: fmtCAS(diamondCasBefore), pol: fmtPOL(diamondPolBefore) },
  });

  if (swapCasBefore === 0n) {
    log("INFO", "no_cas_to_migrate");
    return;
  }

  const [origNum, origDen] = await casSwap.getRatio();
  log("INFO", "original_ratio", { num: origNum.toString(), den: origDen.toString() });

  const wasPaused = await casSwap.paused();
  if (wasPaused) {
    if (!isPauser) throw new Error("CASSwap is paused and signer lacks PAUSER_ROLE");
    log("INFO", "unpausing_casswap");
    const unpauseTx = await casSwap.unpause();
    await unpauseTx.wait();
    log("INFO", "casswap_unpaused", { tx: unpauseTx.hash });
  }

  // POL needed for ratio trick: swapCasBefore / EXTREME_NUM exactly.
  // No margin is used because the output must not exceed the swap's CAS balance.
  const polInput = swapCasBefore / EXTREME_NUM;
  log("INFO", "ratio_trick_input", { polInput: fmtPOL(polInput) });

  if (deployerPolBefore < polInput) {
    throw new Error(`Deployer POL balance ${fmtPOL(deployerPolBefore)} is less than required ${fmtPOL(polInput)}`);
  }

  // Step 1: set extreme ratio
  log("INFO", "setting_extreme_ratio", { ratio: `${EXTREME_NUM}:1` });
  const setRatioTx = await casSwap.setRatio(EXTREME_NUM, 1n);
  await setRatioTx.wait();
  log("INFO", "extreme_ratio_set", { tx: setRatioTx.hash });

  // Step 2: buy CAS with POL to drain the swap
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const minCasOut = swapCasBefore;
  log("INFO", "buying_cas", { minCasOut: "0", polIn: fmtPOL(polInput) });

  let casExtracted: bigint;
  try {
    const buyTx = await casSwap.buyCAS(0n, deadline, { value: polInput });
    const receipt = await buyTx.wait();
    log("INFO", "buy_cas_confirmed", { tx: buyTx.hash });

    const deployerCasAfterBuy = await casToken.balanceOf(signer.address);
    casExtracted = deployerCasAfterBuy - deployerCasBefore;
    log("INFO", "cas_extracted", { amount: fmtCAS(casExtracted) });
  } catch (err: any) {
    log("ERROR", "buy_cas_failed", { error: err.shortMessage ?? err.message });
    throw err;
  }

  // Step 3: restore original ratio (with retry)
  let ratioRestored = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      log("INFO", "restoring_ratio", { attempt, ratio: `${origNum}:${origDen}` });
      const restoreTx = await casSwap.setRatio(origNum, origDen);
      await restoreTx.wait();
      ratioRestored = true;
      log("INFO", "ratio_restored", { tx: restoreTx.hash });
      break;
    } catch (err: any) {
      log("WARN", "restore_ratio_attempt_failed", { attempt, error: err.shortMessage ?? err.message });
      const [checkN, checkD] = await casSwap.getRatio();
      if (checkN === origNum && checkD === origDen) {
        log("INFO", "ratio_already_restored");
        ratioRestored = true;
        break;
      }
      if (attempt < 3) await new Promise((r) => setTimeout(r, 5000));
    }
  }
  if (!ratioRestored) throw new Error("Failed to restore CASSwap ratio");

  // Optional: repause the old swap now that it is drained
  if (wasPaused) {
    log("INFO", "repausing_casswap");
    const pauseTx = await casSwap.pause();
    await pauseTx.wait();
    log("INFO", "casswap_repaused", { tx: pauseTx.hash });
  }

  // Step 4: transfer extracted CAS to Diamond
  if (casExtracted === 0n) {
    log("WARN", "no_cas_extracted");
    return;
  }

  log("INFO", "transferring_cas_to_diamond", { amount: fmtCAS(casExtracted), to: DIAMOND_ADDRESS });
  const transferTx = await casToken.transfer(DIAMOND_ADDRESS, casExtracted);
  await transferTx.wait();
  log("INFO", "transfer_to_diamond_confirmed", { tx: transferTx.hash });

  // Final verification
  const swapCasAfter = await casToken.balanceOf(CAS_SWAP_ADDRESS);
  const deployerCasAfter = await casToken.balanceOf(signer.address);
  const diamondCasAfter = await casToken.balanceOf(DIAMOND_ADDRESS);
  const [finalNum, finalDen] = await casSwap.getRatio();

  log("INFO", "balances_after", {
    casswap: { cas: fmtCAS(swapCasAfter) },
    deployer: { cas: fmtCAS(deployerCasAfter) },
    diamond: { cas: fmtCAS(diamondCasAfter) },
  });
  log("INFO", "final_ratio", { num: finalNum.toString(), den: finalDen.toString() });

  if (swapCasAfter !== 0n) {
    log("WARN", "casswap_still_holds_cas", { remaining: fmtCAS(swapCasAfter) });
  }
  if (finalNum !== origNum || finalDen !== origDen) {
    log("WARN", "ratio_not_restored", { expected: `${origNum}:${origDen}`, actual: `${finalNum}:${finalDen}` });
  }

  log("INFO", "migration_completed");
}

main().catch((err) => {
  log("ERROR", "migration_failed", { error: (err as Error).message });
  console.error(err);
  process.exitCode = 1;
});
