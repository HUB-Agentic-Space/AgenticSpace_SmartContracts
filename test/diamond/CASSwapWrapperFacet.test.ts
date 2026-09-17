import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { IDiamondCut } from "../../typechain-types";

async function getDeadline(seconds = 3600): Promise<bigint> {
  const block = await ethers.provider.getBlock("latest");
  return BigInt(block!.timestamp + seconds);
}

function getSelectors(contract: any): string[] {
  const selectors: string[] = [];
  contract.interface.forEachFunction((frag: any) => selectors.push(frag.selector));
  return selectors;
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

    const DiamondCutFacet = await ethers.getContractFactory("DiamondCutFacet");
    const diamondCutFacet = await DiamondCutFacet.deploy();
    await diamondCutFacet.waitForDeployment();

    const Diamond = await ethers.getContractFactory("Diamond");
    const initialCut: IDiamondCut.FacetCutStruct[] = [{
      facetAddress: await diamondCutFacet.getAddress(),
      action: 0, // Add
      functionSelectors: getSelectors(diamondCutFacet),
    }];
    const diamond = await Diamond.deploy(owner.address, initialCut);
    await diamond.waitForDeployment();
    const diamondAddr = await diamond.getAddress();

    const SwapFacet = await ethers.getContractFactory("CASSwapUSDCPOLFacet");
    const swapFacet = await SwapFacet.deploy();
    await swapFacet.waitForDeployment();

    const WrapperFacet = await ethers.getContractFactory("CASSwapWrapperFacet");
    const wrapperFacet = await WrapperFacet.deploy();
    await wrapperFacet.waitForDeployment();

    const GovFacet = await ethers.getContractFactory("TraderGovernanceFacet");
    const govFacet = await GovFacet.deploy();
    await govFacet.waitForDeployment();

    const cuts: IDiamondCut.FacetCutStruct[] = [
      { facetAddress: await swapFacet.getAddress(), action: 0, functionSelectors: getSelectors(swapFacet) },
      { facetAddress: await wrapperFacet.getAddress(), action: 0, functionSelectors: getSelectors(wrapperFacet) },
      { facetAddress: await govFacet.getAddress(), action: 0, functionSelectors: getSelectors(govFacet) },
    ];

    const diamondCut = await ethers.getContractAt("IDiamondCut", diamondAddr);
    await (await diamondCut.diamondCut(cuts, ethers.ZeroAddress, "0x")).wait();

    const swap = await ethers.getContractAt("CASSwapUSDCPOLFacet", diamondAddr);
    const wrapper = await ethers.getContractAt("CASSwapWrapperFacet", diamondAddr);
    const gov = await ethers.getContractAt("TraderGovernanceFacet", diamondAddr);

    await (await swap.initCASSwapUSDCPOL(casAddr, usdcAddr)).wait();
    await (await swap.connect(owner).setMaxImpactBps(0n)).wait();
    await (await swap.connect(owner).setSwapRatioUSDC(1_000_000_000_000n, 1n)).wait();
    await (await swap.connect(owner).setMaxImpactBps(10000n)).wait();

    await casToken.mint(diamondAddr, ethers.parseEther("100000"));
    await usdcToken.mint(diamondAddr, 1_000_000_000000n);
    await owner.sendTransaction({ to: diamondAddr, value: ethers.parseEther("1000") });

    await casToken.mint(user1.address, ethers.parseEther("10000"));
    await usdcToken.mint(user1.address, 100_000_000000n);
    await casToken.connect(user1).approve(diamondAddr, ethers.parseEther("10000"));
    await usdcToken.connect(user1).approve(diamondAddr, 100_000_000000n);

    return { owner, user1, casToken, usdcToken, swap, wrapper, gov, diamondAddr };
  }

  it("swaps exact ETH for CAS", async () => {
    const { wrapper, user1, casToken, diamondAddr } = await loadFixture(deployFixture);
    const balBefore = await casToken.balanceOf(user1.address);
    const deadline = await getDeadline();
    await expect(wrapper.connect(user1).swapExactETHForCAS(0n, deadline, { value: ethers.parseEther("1") }))
      .to.emit(wrapper, "WrapperSwapExecuted")
      .withArgs(user1.address, 0, ethers.parseEther("1"), ethers.parseEther("1"));
    expect(await casToken.balanceOf(user1.address) - balBefore).to.equal(ethers.parseEther("1"));
    expect(await ethers.provider.getBalance(diamondAddr)).to.equal(ethers.parseEther("1001"));
  });

  it("swaps exact USDC for CAS", async () => {
    const { wrapper, user1, casToken, usdcToken, diamondAddr } = await loadFixture(deployFixture);
    const usdcIn = 1000_000000n;
    const balBefore = await casToken.balanceOf(user1.address);
    const deadline = await getDeadline();
    await expect(wrapper.connect(user1).swapExactUSDCForCAS(usdcIn, 0n, deadline))
      .to.emit(wrapper, "WrapperSwapExecuted")
      .withArgs(user1.address, 2, usdcIn, ethers.parseEther("1000"));
    expect(await casToken.balanceOf(user1.address) - balBefore).to.equal(ethers.parseEther("1000"));
    expect(await usdcToken.balanceOf(diamondAddr)).to.equal(1_001_000_000000n);
  });

  it("swaps exact CAS for ETH", async () => {
    const { wrapper, user1, casToken, diamondAddr } = await loadFixture(deployFixture);
    const casIn = ethers.parseEther("1");
    const polBefore = await ethers.provider.getBalance(user1.address);
    const deadline = await getDeadline();
    await expect(wrapper.connect(user1).swapExactCASForETH(casIn, 0n, deadline))
      .to.emit(wrapper, "WrapperSwapExecuted");
    expect(await casToken.balanceOf(diamondAddr)).to.equal(ethers.parseEther("100001"));
    expect(await ethers.provider.getBalance(user1.address) - polBefore).to.be.closeTo(casIn, ethers.parseEther("0.01"));
  });

  it("swaps exact CAS for USDC", async () => {
    const { wrapper, user1, usdcToken, diamondAddr } = await loadFixture(deployFixture);
    const casIn = ethers.parseEther("1000");
    const usdcBefore = await usdcToken.balanceOf(user1.address);
    const deadline = await getDeadline();
    await expect(wrapper.connect(user1).swapExactCASForUSDC(casIn, 0n, deadline))
      .to.emit(wrapper, "WrapperSwapExecuted");
    expect(await usdcToken.balanceOf(user1.address) - usdcBefore).to.equal(1000_000000n);
    expect(await usdcToken.balanceOf(diamondAddr)).to.equal(999_000_000000n);
  });

  it("reverts when paused", async () => {
    const { wrapper, gov, owner, user1 } = await loadFixture(deployFixture);
    await (await gov.connect(owner).pauseSwap()).wait();
    await expect(wrapper.connect(user1).swapExactETHForCAS(0n, await getDeadline(), { value: ethers.parseEther("1") }))
      .to.be.revertedWithCustomError(wrapper, "SwapPaused");
  });
});
