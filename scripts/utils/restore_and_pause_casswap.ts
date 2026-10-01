import { ethers, network } from "hardhat";
import * as dotenv from "dotenv";
import * as path from "path";

const SC_ROOT = path.resolve(__dirname, "..", "..");
dotenv.config({ path: path.join(SC_ROOT, ".env") });

if (network.config.chainId !== 137) {
  throw new Error("This script only runs on Polygon mainnet (chainId 137)");
}

const CAS_SWAP_ADDRESS = process.env.CAS_SWAP_ADDRESS!;

const CASSWAP_ABI = [
  "function paused() view returns (bool)",
  "function pause()",
  "function setRatio(uint256,uint256)",
  "function getRatio() view returns (uint256,uint256)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
];

const RATIO_ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("RATIO_ADMIN_ROLE"));
const PAUSER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("PAUSER_ROLE"));

function log(level: string, message: string, params?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`[${ts}] [restore_and_pause_casswap] ${level} ${message}${params ? ` - ${JSON.stringify(params)}` : ""}`);
}

async function main(): Promise<void> {
  const [signer] = await ethers.getSigners();
  const casSwap = new ethers.Contract(CAS_SWAP_ADDRESS, CASSWAP_ABI, signer);

  const isRatioAdmin = await casSwap.hasRole(RATIO_ADMIN_ROLE, signer.address);
  const isPauser = await casSwap.hasRole(PAUSER_ROLE, signer.address);

  if (!isRatioAdmin) throw new Error(`Signer ${signer.address} lacks RATIO_ADMIN_ROLE`);
  if (!isPauser) throw new Error(`Signer ${signer.address} lacks PAUSER_ROLE`);

  const [num, den] = await casSwap.getRatio();
  log("INFO", "current_ratio", { num: num.toString(), den: den.toString(), ratio: `${num}:${den}` });

  const ORIG_NUM = 5000n;
  const ORIG_DEN = 3n;

  if (num !== ORIG_NUM || den !== ORIG_DEN) {
    log("INFO", "restoring_ratio", { ratio: `${ORIG_NUM}:${ORIG_DEN}` });
    const tx = await casSwap.setRatio(ORIG_NUM, ORIG_DEN);
    await tx.wait();
    log("INFO", "ratio_restored", { tx: tx.hash });
  } else {
    log("INFO", "ratio_already_original");
  }

  const paused = await casSwap.paused();
  if (!paused) {
    log("INFO", "pausing_casswap");
    const tx = await casSwap.pause();
    await tx.wait();
    log("INFO", "casswap_paused", { tx: tx.hash });
  } else {
    log("INFO", "casswap_already_paused");
  }

  const [finalNum, finalDen] = await casSwap.getRatio();
  log("INFO", "final_state", { ratio: `${finalNum}:${finalDen}`, paused: await casSwap.paused() });
}

main().catch((err) => {
  log("ERROR", "restore_failed", { error: (err as Error).message });
  console.error(err);
  process.exitCode = 1;
});
