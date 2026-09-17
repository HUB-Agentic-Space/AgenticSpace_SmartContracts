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
  for (const fn of contract.interface.fragments) {
    if (fn.type === "function") {
      selectors.push(contract.interface.getFunction(fn.name).selector);
    }
  }
  return selectors;
}

describe("CASSwap Diamond Integration", () => {
  async function deployFixture() {
    const [owner, user1] = await ethers.getSigners();

    // Mock tokens
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const casToken = await MockERC20.deploy("CAS Token", "CAS", 18);
    const usdcToken = await MockERC20.deploy("USDC Token", "USDC", 6);
    await casToken.waitForDeployment();
    await usdcToken.waitForDeployment();
    const casAddr = await casToken.getAddress();
    const usdcAddr = await usdcToken.getAddress();

    // DiamondCutFacet + Diamond
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

    // Deploy new facets
    const facetNames = ["CASSwapUSDCPOLFacet", "CASSwapWrapperFacet", "TraderGovernanceFacet"];
    const cuts: IDiamondCut.FacetCutStruct[] = [];
    for (const name of facetNames) {
      const Factory = await ethers.getContractFactory(name);
      const facet = await Factory.deploy();
      await facet.waitForDeployment();
      cuts.push({ facetAddress: await facet.getAddress(), action: 0, functionSelectors: getSelectors(facet) });
    }

    // Attach facets
    const diamondCut = await ethers.getContractAt("IDiamondCut", diamondAddr);
    await (await diamondCut.diamondCut(cuts, ethers.ZeroAddress, "0x")).wait();

    // Init swap
    const swap = await ethers.getContractAt("CASSwapUSDCPOLFacet", diamondAddr);
    await (await swap.initCASSwapUSDCPOL(casAddr, usdcAddr)).wait();
    // Temporarily disable impact guard to set the decimal-normalized USDC ratio
    await (await swap.connect(owner).setMaxImpactBps(0n)).wait();
    // USDC ratio: 1 USDC = 1 CAS  =>  1e6 USDC base units = 1e18 CAS base units  =>  num/den = 1e12/1
    await (await swap.connect(owner).setSwapRatioUSDC(1_000_000_000_000n, 1n)).wait();
    // Restore a permissive guard for the "owner can set ratios" test
    await (await swap.connect(owner).setMaxImpactBps(10000n)).wait();

    // Fund Diamond
    await casToken.mint(diamondAddr, ethers.parseEther("100000"));
    await usdcToken.mint(diamondAddr, 1_000_000_000000n);
    await owner.sendTransaction({ to: diamondAddr, value: ethers.parseEther("1000") });

    // Fund user
    await casToken.mint(user1.address, ethers.parseEther("10000"));
    await usdcToken.mint(user1.address, 100_000_000000n);
    await casToken.connect(user1).approve(diamondAddr, ethers.parseEther("10000"));
    await usdcToken.connect(user1).approve(diamondAddr, 100_000_000000n);

    return { owner, user1, diamondAddr, casToken, usdcToken, swap };
  }

  it("initializes with correct ratios", async () => {
    const { swap } = await loadFixture(deployFixture);
    const [polNum, polDen] = await swap.getRatio();
    const [usdcNum, usdcDen] = await swap.getRatioUSDC();
    expect(polNum).to.equal(1n);
    expect(polDen).to.equal(1n);
    // USDC ratio ajustado pelo owner no fixture: 1 USDC = 1 CAS em unidades de base
    expect(usdcNum).to.equal(1_000_000_000_000n);
    expect(usdcDen).to.equal(1n);
    expect(await swap.isSwapPaused()).to.be.false;
  });

  it("owner can set ratios and user cannot", async () => {
    const { swap, owner, user1 } = await loadFixture(deployFixture);
    await expect(swap.connect(owner).setSwapRatio(2n, 1n))
      .to.emit(swap, "RatioUpdated")
      .withArgs(0, 2n, 1n, owner.address);
    await expect(swap.connect(user1).setSwapRatio(3n, 1n))
      .to.be.revertedWithCustomError(swap, "MissingRole");
  });

  it("buy CAS with POL", async () => {
    const { swap, user1, casToken, diamondAddr } = await loadFixture(deployFixture);
    const balBefore = await casToken.balanceOf(user1.address);
    const deadline = await getDeadline();
    await expect(swap.connect(user1).buyCASWithPOL(0n, deadline, { value: ethers.parseEther("1") }))
      .to.emit(swap, "CASBoughtWithPOL");
    const balAfter = await casToken.balanceOf(user1.address);
    expect(balAfter - balBefore).to.equal(ethers.parseEther("1"));
    expect(await ethers.provider.getBalance(diamondAddr)).to.equal(ethers.parseEther("1001"));
  });

  it("sell CAS for POL", async () => {
    const { swap, user1, casToken, diamondAddr } = await loadFixture(deployFixture);
    const amount = ethers.parseEther("1");
    const polBefore = await ethers.provider.getBalance(user1.address);
    const deadline = await getDeadline();
    await expect(swap.connect(user1).sellCASForPOL(amount, 0n, deadline))
      .to.emit(swap, "CASSoldForPOL");
    expect(await casToken.balanceOf(diamondAddr)).to.equal(ethers.parseEther("100001"));
    expect(await ethers.provider.getBalance(user1.address) - polBefore).to.be.closeTo(amount, ethers.parseEther("0.01"));
  });

  it("buy CAS with USDC", async () => {
    const { swap, user1, casToken, usdcToken, diamondAddr } = await loadFixture(deployFixture);
    const usdcIn = 1000_000000n;
    const balBefore = await casToken.balanceOf(user1.address);
    const deadline = await getDeadline();
    await expect(swap.connect(user1).buyCASWithUSDC(usdcIn, 0n, deadline))
      .to.emit(swap, "CASBoughtWithUSDC");
    expect(await casToken.balanceOf(user1.address) - balBefore).to.equal(ethers.parseEther("1000"));
    expect(await usdcToken.balanceOf(diamondAddr)).to.equal(1_001_000_000000n);
  });

  it("sell CAS for USDC", async () => {
    const { swap, user1, usdcToken, diamondAddr } = await loadFixture(deployFixture);
    const amount = ethers.parseEther("1000");
    const balBefore = await usdcToken.balanceOf(user1.address);
    const deadline = await getDeadline();
    await expect(swap.connect(user1).sellCASForUSDC(amount, 0n, deadline))
      .to.emit(swap, "CASSoldForUSDC");
    expect(await usdcToken.balanceOf(user1.address) - balBefore).to.equal(1000_000000n);
    expect(await usdcToken.balanceOf(diamondAddr)).to.equal(999_000_000000n);
  });

  it("wrapper swaps exact ETH for CAS", async () => {
    const { diamondAddr, user1, casToken } = await loadFixture(deployFixture);
    const wrapper = await ethers.getContractAt("ICASSwapWrapper", diamondAddr);
    const balBefore = await casToken.balanceOf(user1.address);
    const deadline = await getDeadline();
    await expect(wrapper.connect(user1).swapExactETHForCAS(0n, deadline, { value: ethers.parseEther("1") }))
      .to.emit(wrapper, "WrapperSwapExecuted");
    expect(await casToken.balanceOf(user1.address) - balBefore).to.equal(ethers.parseEther("1"));
  });

  it("governance can pause and unpause swaps", async () => {
    const { diamondAddr, owner, user1 } = await loadFixture(deployFixture);
    const gov = await ethers.getContractAt("TraderGovernanceFacet", diamondAddr);
    const swap = await ethers.getContractAt("CASSwapUSDCPOLFacet", diamondAddr);

    await (await gov.connect(owner).pauseSwap()).wait();
    expect(await swap.isSwapPaused()).to.be.true;

    await expect(swap.connect(user1).buyCASWithPOL(0n, await getDeadline(), { value: ethers.parseEther("1") }))
      .to.be.revertedWithCustomError(swap, "SwapPaused");

    await (await gov.connect(owner).unpauseSwap()).wait();
    expect(await swap.isSwapPaused()).to.be.false;
  });
});
