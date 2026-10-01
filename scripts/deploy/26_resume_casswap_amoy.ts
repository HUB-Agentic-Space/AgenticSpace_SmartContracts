import { ethers, network } from "hardhat";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const DIAMOND = "0xd1F0a20955c0A09325E0CB7c5ab73563e6b6c833";
const CAS = "0x464c9b53Fd50564e451835BA71C6D608CC0A6Eb7";
const USDC = "0xaE4405ad8DDA8Dd80FC5e2b4bA6bB6dcbA0a95dE";

function log(level: string, message: string, details = ""): void {
  const timestamp = new Date().toISOString().replace("T", " ").replace("Z", "");
  console.log(`[${timestamp}] [26_resume_casswap_amoy:main] ${level} ${message}${details ? ` - ${details}` : ""}`);
}

async function main(): Promise<void> {
  if (network.config.chainId !== 80002) throw new Error("This script only runs on Polygon Amoy (chainId 80002)");
  const [deployer] = await ethers.getSigners();
  const swap = await ethers.getContractAt("CASSwapUSDCPOLFacet", DIAMOND, deployer);
  const cas = await ethers.getContractAt("MockERC20", CAS, deployer);
  const usdc = await ethers.getContractAt("MockERC20", USDC, deployer);

  const [ratioNum] = await swap.getRatio();
  if (ratioNum === 0n) {
    await (await swap.initCASSwapUSDCPOL(CAS, USDC)).wait();
    log("info", "swap_initialized");
  }

  await (await swap.setMaxImpactBps(0)).wait();
  await (await swap.setSwapRatioUSDC(1_000_000_000_000n, 1n)).wait();
  await (await swap.setSwapRatioUSDCSell(1_000_000_000_000n, 1n)).wait();
  await (await swap.setMaxImpactBps(1000)).wait();

  const reserves = await swap.getReserves();
  if (reserves[0] < ethers.parseEther("100000")) await (await cas.mint(DIAMOND, ethers.parseEther("100000"))).wait();
  if (reserves[2] < 100_000n * 1_000_000n) await (await usdc.mint(DIAMOND, 100_000n * 1_000_000n)).wait();
  if (await ethers.provider.getBalance(DIAMOND) < ethers.parseEther("0.05")) {
    await (await deployer.sendTransaction({ to: DIAMOND, value: ethers.parseEther("0.05") })).wait();
  }

  const deployment = {
    network: network.name,
    chainId: network.config.chainId,
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    diamond: DIAMOND,
    casToken: CAS,
    usdcToken: USDC,
    facets: {
      DiamondCutFacet: "0x10c37dFdBf59F75BE6ED78dc0Dc22cA50a1d0418",
      DiamondLoupeFacet: "0xa9351bD0E63097FEe2d15A08C906508138532c25",
      OwnershipFacet: "0x94F79788d8d7BdA18B199e2c5aC1CCdCb3D74D45",
      CASSwapUSDCPOLFacet: "0xAa6c79177D8435624A21B4B643b77f811Ea7cA6C",
      CASSwapWrapperFacet: "0xeAe92c969Fd52Cb4D894d17A7DDD432fDc4FbDBB",
      TraderGovernanceFacet: "0xeE4bBf6f4aB922De1040A9071E26c5015E2f9f81",
    },
  };
  const output = resolve(__dirname, "../../deployments/casswap-amoy.json");
  writeFileSync(output, `${JSON.stringify(deployment, null, 2)}\n`, "utf8");
  log("info", "deployment_completed", `diamond=${DIAMOND} output=${output}`);
}

main().catch((error) => {
  log("error", "deployment_failed", `message=${error.shortMessage ?? error.message}`);
  process.exitCode = 1;
});
