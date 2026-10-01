import { ethers } from "hardhat";
import * as dotenv from "dotenv";
import * as path from "path";

const SC_ROOT = path.resolve(__dirname, "..", "..");
dotenv.config({ path: path.join(SC_ROOT, ".env") });

const CAS_SWAP_ADDRESS = process.env.CAS_SWAP_ADDRESS!;
const CAS_TOKEN_ADDRESS = process.env.CAS_TOKEN_ADDRESS!;

const CASSWAP_ABI = [
  "function paused() view returns (bool)",
  "function setRatio(uint256,uint256)",
  "function getRatio() view returns (uint256,uint256)",
  "function getSwapFee() view returns (uint256)",
  "function getCASBalance() view returns (uint256)",
  "function getPOLBalance() view returns (uint256)",
  "function buyCAS(uint256,uint256) payable returns (uint256)",
];

async function main(): Promise<void> {
  const [signer] = await ethers.getSigners();
  const casSwap = new ethers.Contract(CAS_SWAP_ADDRESS, CASSWAP_ABI, signer);
  const casToken = new ethers.Contract(CAS_TOKEN_ADDRESS, ["function balanceOf(address) view returns (uint256)"], signer);

  const paused = await casSwap.paused();
  const [num, den] = await casSwap.getRatio();
  const fee = await casSwap.getSwapFee();
  const casBal = await casSwap.getCASBalance();
  const polBal = await casSwap.getPOLBalance();
  const tokenBal = await casToken.balanceOf(CAS_SWAP_ADDRESS);

  console.log("paused:", paused);
  console.log("ratio:", num.toString(), den.toString(), `${num}:${den}`);
  console.log("fee bps:", fee.toString());
  console.log("CAS balance (contract):", casBal.toString(), ethers.formatEther(casBal));
  console.log("token balance:", tokenBal.toString(), ethers.formatEther(tokenBal));
  console.log("POL balance:", polBal.toString(), ethers.formatEther(polBal));

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const polIn = ethers.parseEther("0.011");
  const minOut = 1n;

  console.log("Attempting staticCall buyCAS(minOut=1, deadline) with 0.011 POL...");
  try {
    const out = await casSwap.buyCAS.staticCall(minOut, deadline, { value: polIn });
    console.log("staticCall success, CAS out:", out.toString(), ethers.formatEther(out));
  } catch (err: any) {
    console.error("staticCall failed:", err.shortMessage ?? err.message);
    if (err.data) console.error("error data:", err.data);
  }
}

main().catch(console.error);
