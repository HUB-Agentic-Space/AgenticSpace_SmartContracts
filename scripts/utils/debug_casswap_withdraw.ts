import { ethers } from "hardhat";
import * as dotenv from "dotenv";
import * as path from "path";

const SC_ROOT = path.resolve(__dirname, "..", "..");
dotenv.config({ path: path.join(SC_ROOT, ".env") });

const CAS_SWAP_ADDRESS = process.env.CAS_SWAP_ADDRESS!;
const INFRASTRUCTURE_FUND_ADDRESS = process.env.INFRASTRUCTURE_FUND_ADDRESS!;
const CAS_TOKEN_ADDRESS = process.env.CAS_TOKEN_ADDRESS!;

const CASSWAP_ABI = [
  "function paused() view returns (bool)",
  "function unpause()",
  "function withdrawCAS(address to, uint256 amount)",
  "function getCASBalance() view returns (uint256)",
  "function getPOLBalance() view returns (uint256)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
];

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

async function main(): Promise<void> {
  const [signer] = await ethers.getSigners();
  const casSwap = new ethers.Contract(CAS_SWAP_ADDRESS, CASSWAP_ABI, signer);
  const casToken = new ethers.Contract(CAS_TOKEN_ADDRESS, ERC20_ABI, signer);

  const paused = await casSwap.paused();
  const casBalance = await casSwap.getCASBalance();
  const tokenBalance = await casToken.balanceOf(CAS_SWAP_ADDRESS);

  console.log("paused:", paused);
  console.log("getCASBalance:", casBalance.toString(), ethers.formatEther(casBalance));
  console.log("tokenBalance:", tokenBalance.toString(), ethers.formatEther(tokenBalance));
  console.log("signer:", signer.address);
  console.log("to:", INFRASTRUCTURE_FUND_ADDRESS);

  if (paused) {
    console.log("Unpausing...");
    const tx = await casSwap.unpause();
    await tx.wait();
    console.log("Unpaused", tx.hash);
  }

  console.log("Attempting staticCall withdrawCAS...");
  try {
    await casSwap.withdrawCAS.staticCall(INFRASTRUCTURE_FUND_ADDRESS, tokenBalance);
    console.log("staticCall succeeded");
  } catch (err: any) {
    console.error("staticCall failed:", err.shortMessage ?? err.message ?? err);
    if (err.data) {
      console.error("error data:", err.data);
      try {
        const iface = new ethers.Interface(CASSWAP_ABI);
        const parsed = iface.parseError(err.data);
        console.error("parsed error:", parsed);
      } catch (parseErr) {
        console.error("could not parse error data");
      }
    }
  }
}

main().catch(console.error);
