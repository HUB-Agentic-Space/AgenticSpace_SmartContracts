import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();

  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const cas = await MockERC20.deploy("Mock CAS", "mCAS", 18);
  await cas.waitForDeployment();

  const CASSwap = await ethers.getContractFactory("CASSwap");
  const casswap = await CASSwap.deploy();
  await casswap.waitForDeployment();

  const casAddr = await cas.getAddress();
  const swapAddr = await casswap.getAddress();
  const infraFund = deployer.address; // nao usado no teste basico

  await (await casswap["initialize(address,address,address)"](deployer.address, casAddr, infraFund)).wait();

  await (await casswap.setRatio(17n, 1n)).wait();

  const reserve = ethers.parseEther("500000");
  await (await cas.mint(deployer.address, reserve)).wait();
  await (await cas.approve(swapAddr, reserve)).wait();
  await (await casswap.depositCAS(reserve)).wait();

  if (await casswap.isPaused()) {
    throw new Error("CASSwap nao deveria estar pausado antes do pause() final");
  }

  await (await casswap.pause()).wait();

  const paused = await casswap.isPaused();
  if (!paused) {
    throw new Error("CASSwap nao ficou pausado apos pause()");
  }

  const casBal = await casswap.getCASBalance();
  const ratio = await casswap.getRatio();

  console.log(`[06] CASSwap deployado e pausado com sucesso.`);
  console.log(`  Endereco : ${swapAddr}`);
  console.log(`  Pausado  : ${paused}`);
  console.log(`  Ratio    : ${ratio[0]}:${ratio[1]}`);
  console.log(`  CAS lock : ${ethers.formatEther(casBal)} CAS`);
  console.log(`  Admin    : ${deployer.address}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
