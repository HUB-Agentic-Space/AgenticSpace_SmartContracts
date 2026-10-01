import { ethers, network } from "hardhat";

const DIAMOND = "0xd1F0a20955c0A09325E0CB7c5ab73563e6b6c833";
const CAS = "0x464c9b53Fd50564e451835BA71C6D608CC0A6Eb7";
const USDC = "0xaE4405ad8DDA8Dd80FC5e2b4bA6bB6dcbA0a95dE";

function log(level: string, message: string, details = ""): void {
  const timestamp = new Date().toISOString().replace("T", " ").replace("Z", "");
  console.log(`[${timestamp}] [07_validate_casswap_amoy:main] ${level} ${message}${details ? ` - ${details}` : ""}`);
}

async function main(): Promise<void> {
  if (network.config.chainId !== 80002) throw new Error("This script only runs on Polygon Amoy (chainId 80002)");
  const [user] = await ethers.getSigners();
  const swap = await ethers.getContractAt("CASSwapUSDCPOLFacet", DIAMOND, user);
  const cas = await ethers.getContractAt("MockERC20", CAS, user);
  const usdc = await ethers.getContractAt("MockERC20", USDC, user);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

  await (await cas.mint(user.address, ethers.parseEther("2"))).wait();
  await (await usdc.mint(user.address, 2_000_000n)).wait();
  await (await cas.approve(DIAMOND, ethers.MaxUint256)).wait();
  await (await usdc.approve(DIAMOND, ethers.MaxUint256)).wait();

  const transactions = [
    await swap.buyCASWithPOL(0, deadline, { value: ethers.parseEther("0.001") }),
    await swap.sellCASForPOL(ethers.parseEther("0.001"), 0, deadline),
    await swap.buyCASWithUSDC(1_000_000n, 0, deadline),
    await swap.sellCASForUSDC(ethers.parseEther("1"), 0, deadline),
  ];
  for (const transaction of transactions) {
    const receipt = await transaction.wait();
    if (receipt?.status !== 1) throw new Error(`Transaction failed: ${transaction.hash}`);
    log("info", "swap_confirmed", `tx=${transaction.hash}`);
  }

  const reserves = await swap.getReserves();
  log("info", "validation_completed", `cas=${reserves[0]} pol=${reserves[1]} usdc=${reserves[2]} paused=${await swap.isSwapPaused()}`);
}

main().catch((error) => {
  log("error", "validation_failed", `message=${error.shortMessage ?? error.message}`);
  process.exitCode = 1;
});
