import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

async function getDeadline(seconds = 3600): Promise<bigint> {
  const block = await ethers.provider.getBlock("latest");
  return BigInt(block!.timestamp + seconds);
}

describe("CASSwapWrapperFacet", () => {
  async function deployFixture() {
    const [owner, user1] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const casToken = await MockERC20.deploy("CAS Token", "CAS", 18);
    const usdcToken = await MockERC20.deploy("USDC Token", "USDC", 6);
    await casToken.waitForDeployment();
    await usdcToken.waitForDeployment();

    const casAddr = await casToken.getAddress();
    const usdcAddr = await usdcToken.getAddress();

    const SwapFacet = await ethers.getContractFactory("CASSwapUSDCPOLFacet");
    const swapFacet = await SwapFacet.deploy();
    await swapFacet.waitForDeployment();
    const swapAddr = await swapFacet.getAddress();

    const WrapperFacet = await ethers.getContractFactory("CASSwapWrapperFacet");
    const wrapperFacet = await WrapperFacet.deploy();
    await wrapperFacet.waitForDeployment();
    const wrapperAddr = await wrapperFacet.getAddress();

    // Set same owner for both facets so LibDiamond owner is consistent
    const baseSlot = ethers.keccak256(ethers.toUtf8Bytes("agentic.space.diamond.storage"));
    const ownerSlot = ethers.toQuantity(BigInt(baseSlot) + 4n);
    for (const addr of [swapAddr, wrapperAddr]) {
      await ethers.provider.send("hardhat_setStorageAt", [
        addr,
        ownerSlot,
        ethers.zeroPadValue(owner.address, 32),
      ]);
    }

    await swapFacet.initCASSwapUSDCPOL(casAddr, usdcAddr);
    await wrapperFacet.initCASSwapUSDCPOL(casAddr, usdcAddr);

    // Funding
    await casToken.mint(wrapperAddr, ethers.parseEther("100000"));
    await usdcToken.mint(wrapperAddr, 1_000_000_000000n);
    await owner.sendTransaction({ to: wrapperAddr, value: ethers.parseEther("1000") });

    // User funds
    await casToken.mint(user1.address, ethers.parseEther("10000"));
    await usdcToken.mint(user1.address, 100_000_000000n);
    await casToken.connect(user1).approve(wrapperAddr, ethers.parseEther("10000"));
    await usdcToken.connect(user1).approve(wrapperAddr, 100_000_000000n);

    return { owner, user1, casToken, usdcToken, wrapperFacet, wrapperAddr };
  }

  it("swaps exact ETH for CAS", async () => {
    const { wrapperFacet, wrapperAddr, user1, casToken } = await loadFixture(deployFixture);
    const balBefore = await casToken.balanceOf(user1.address);
    const deadline = await getDeadline();
    await expect(wrapperFacet.connect(user1).swapExactETHForCAS(0n, deadline, { value: ethers.parseEther("1") }))
      .to.emit(wrapperFacet, "WrapperSwapExecuted")
      .withArgs(user1.address, 0, ethers.parseEther("1"), ethers.parseEther("1"));
    expect(await casToken.balanceOf(user1.address) - balBefore).to.equal(ethers.parseEther("1"));
    expect(await ethers.provider.getBalance(wrapperAddr)).to.equal(ethers.parseEther("1001"));
  });

  it("swaps exact USDC for CAS", async () => {
    const { wrapperFacet, wrapperAddr, user1, casToken, usdcToken } = await loadFixture(deployFixture);
    const usdcIn = 1000_000000n;
    const balBefore = await casToken.balanceOf(user1.address);
    const deadline = await getDeadline();
    await expect(wrapperFacet.connect(user1).swapExactUSDCForCAS(usdcIn, 0n, deadline))
      .to.emit(wrapperFacet, "WrapperSwapExecuted")
      .withArgs(user1.address, 2, usdcIn, ethers.parseEther("1000"));
    expect(await casToken.balanceOf(user1.address) - balBefore).to.equal(ethers.parseEther("1000"));
    expect(await usdcToken.balanceOf(wrapperAddr)).to.equal(1_001_000_000000n);
  });

  it("swaps exact CAS for ETH", async () => {
    const { wrapperFacet, wrapperAddr, user1, casToken } = await loadFixture(deployFixture);
    const casIn = ethers.parseEther("1");
    const polBefore = await ethers.provider.getBalance(user1.address);
    const deadline = await getDeadline();
    await expect(wrapperFacet.connect(user1).swapExactCASForETH(casIn, 0n, deadline))
      .to.emit(wrapperFacet, "WrapperSwapExecuted");
    expect(await casToken.balanceOf(wrapperAddr)).to.equal(ethers.parseEther("100001"));
    expect(await ethers.provider.getBalance(user1.address) - polBefore).to.be.closeTo(casIn, ethers.parseEther("0.01"));
  });

  it("swaps exact CAS for USDC", async () => {
    const { wrapperFacet, wrapperAddr, user1, usdcToken } = await loadFixture(deployFixture);
    const casIn = ethers.parseEther("1000");
    const usdcBefore = await usdcToken.balanceOf(user1.address);
    const deadline = await getDeadline();
    await expect(wrapperFacet.connect(user1).swapExactCASForUSDC(casIn, 0n, deadline))
      .to.emit(wrapperFacet, "WrapperSwapExecuted");
    expect(await usdcToken.balanceOf(user1.address) - usdcBefore).to.equal(1000_000000n);
    expect(await usdcToken.balanceOf(wrapperAddr)).to.equal(999_000_000000n);
  });

  it("reverts when paused", async () => {
    const { wrapperFacet, owner, user1 } = await loadFixture(deployFixture);
    const SwapFacet = await ethers.getContractAt("CASSwapUSDCPOLFacet", await wrapperFacet.getAddress());
    await SwapFacet.connect(owner).pause();
    await expect(wrapperFacet.connect(user1).swapExactETHForCAS(0n, await getDeadline(), { value: ethers.parseEther("1") }))
      .to.be.revertedWithCustomError(wrapperFacet, "SwapPaused");
  });
});
