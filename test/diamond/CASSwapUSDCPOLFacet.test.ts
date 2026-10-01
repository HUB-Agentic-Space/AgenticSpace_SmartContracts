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
  for (const f of contract.interface.fragments) {
    if ((f as any).type === "function") {
      const sig = (f as any).format("sighash");
      selectors.push(ethers.id(sig).slice(0, 10));
    }
  }
  return selectors;
}

describe("CASSwapUSDCPOLFacet", () => {
  async function deployFixture() {
    const [owner, user1, treasurer] = await ethers.getSigners();

    // Mock tokens
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const casToken = await MockERC20.deploy("CAS Token", "CAS", 18);
    const usdcToken = await MockERC20.deploy("USDC Token", "USDC", 6);
    await casToken.waitForDeployment();
    await usdcToken.waitForDeployment();
    const casAddr = await casToken.getAddress();
    const usdcAddr = await usdcToken.getAddress();

    // Diamond cut facet + Diamond
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

    // Deploy and add CASSwapUSDCPOLFacet
    const SwapFacet = await ethers.getContractFactory("CASSwapUSDCPOLFacet");
    const facet = await SwapFacet.deploy();
    await facet.waitForDeployment();
    const facetAddr = await facet.getAddress();

    const diamondCut = await ethers.getContractAt("IDiamondCut", diamondAddr);
    const cut: IDiamondCut.FacetCutStruct[] = [{
      facetAddress: facetAddr,
      action: 0,
      functionSelectors: getSelectors(facet),
    }];
    await (await diamondCut.diamondCut(cut, ethers.ZeroAddress, "0x")).wait();

    // Init via Diamond
    const swap = await ethers.getContractAt("CASSwapUSDCPOLFacet", diamondAddr);
    await (await swap.initCASSwapUSDCPOL(casAddr, usdcAddr)).wait();

    // Set a loose guard for the fixture tests
    await (await swap.connect(owner).setMaxImpactBps(10000n)).wait();

    // Fund Diamond with CAS, USDC and POL
    await casToken.mint(diamondAddr, ethers.parseEther("100000"));
    await usdcToken.mint(diamondAddr, 1_000_000_000000n); // 1M USDC
    await owner.sendTransaction({ to: diamondAddr, value: ethers.parseEther("1000") });

    // Fund user
    await casToken.mint(user1.address, ethers.parseEther("10000"));
    await usdcToken.mint(user1.address, 100_000_000000n); // 100k USDC
    await casToken.connect(user1).approve(diamondAddr, ethers.parseEther("10000"));
    await usdcToken.connect(user1).approve(diamondAddr, 100_000_000000n);

    return { owner, user1, treasurer, casToken, usdcToken, swap, diamondAddr };
  }

  describe("Initialization", () => {
    it("initializes with default ratios and tokens", async () => {
      const { swap, casToken, usdcToken, diamondAddr } = await loadFixture(deployFixture);
      const [num, den] = await swap.getRatio();
      const [uNum, uDen] = await swap.getRatioUSDC();
      expect(num).to.equal(1n);
      expect(den).to.equal(1n);
      expect(uNum).to.equal(1n);
      expect(uDen).to.equal(1n);
      expect(await swap.isSwapPaused()).to.be.false;
      const reserves = await swap.getReserves();
      expect(reserves.casBalance).to.equal(ethers.parseEther("100000"));
      expect(reserves.usdcBalance).to.equal(1_000_000_000000n);
      expect(reserves.polBalance).to.equal(ethers.parseEther("1000"));
    });
  });

  describe("Ratios", () => {
    it("only owner can set ratio", async () => {
      const { swap, user1 } = await loadFixture(deployFixture);
      await expect(swap.connect(user1).setSwapRatio(2n, 1n))
        .to.be.revertedWithCustomError(swap, "MissingRole");
    });

    it("owner can set POL ratio", async () => {
      const { swap, owner } = await loadFixture(deployFixture);
      await expect(swap.connect(owner).setSwapRatio(2n, 1n))
        .to.emit(swap, "RatioUpdated")
        .withArgs(0, 2n, 1n, owner.address);
      const [num, den] = await swap.getRatio();
      expect(num).to.equal(2n);
      expect(den).to.equal(1n);
    });

    it("rejects zero ratio", async () => {
      const { swap, owner } = await loadFixture(deployFixture);
      await expect(swap.connect(owner).setSwapRatio(0n, 1n))
        .to.be.revertedWithCustomError(swap, "InvalidRatioArg");
    });

    it("enforces max impact on setSwapRatio", async () => {
      const { swap, owner } = await loadFixture(deployFixture);
      // tighten impact to 1% then change from 1:1 to 2:1 (+100%) must fail
      await (await swap.connect(owner).setMaxImpactBps(100n)).wait();
      await expect(swap.connect(owner).setSwapRatio(2n, 1n))
        .to.be.revertedWithCustomError(swap, "RatioChangeExceeded");
    });

    it("allows small ratio changes within impact", async () => {
      const { swap, owner } = await loadFixture(deployFixture);
      // 1:1 -> 101:100 = 1% increase; right at the limit
      await expect(swap.connect(owner).setSwapRatio(10001n, 10000n))
        .to.emit(swap, "RatioUpdated");
    });

    it("owner can set all ratios atomically", async () => {
      const { swap, owner } = await loadFixture(deployFixture);
      await expect(swap.connect(owner).setAllSwapRatios(
        101n, 100n,
        10001n, 10000n,
        102n, 100n,
        102n, 100n,
      ))
        .to.emit(swap, "RatioUpdated");
      const [polNum, polDen] = await swap.getRatio();
      expect(polNum).to.equal(101n);
      expect(polDen).to.equal(100n);
    });
  });

  describe("Spread invariants", () => {
    it("rejects inverted atomic POL and USDC spreads without partial writes", async () => {
      const { swap } = await loadFixture(deployFixture);
      await expect(swap.setAllSwapRatios(2n, 1n, 1n, 1n, 1n, 1n, 1n, 1n))
        .to.be.revertedWithCustomError(swap, "ReverseSpread").withArgs(0);
      await expect(swap.setAllSwapRatios(1n, 1n, 2n, 1n, 1n, 1n, 1n, 1n))
        .to.be.revertedWithCustomError(swap, "ReverseSpread").withArgs(1);
      expect(await swap.getRatio()).to.deep.equal([1n, 1n]);
      expect(await swap.getRatioUSDC()).to.deep.equal([1n, 1n]);
    });

    it("rejects reversed spread through each individual setter", async () => {
      const { swap } = await loadFixture(deployFixture);
      await swap.setMaxImpactBps(0n);
      await swap.setAllSwapRatios(1n, 1n, 1n, 1n, 2n, 1n, 2n, 1n);
      await expect(swap.setSwapRatio(3n, 1n)).to.be.revertedWithCustomError(swap, "ReverseSpread");
      await expect(swap.setSwapRatioUSDC(3n, 1n)).to.be.revertedWithCustomError(swap, "ReverseSpread");
      await expect(swap.setSwapRatioSell(1n, 2n)).to.be.revertedWithCustomError(swap, "ReverseSpread");
      await expect(swap.setSwapRatioUSDCSell(1n, 2n)).to.be.revertedWithCustomError(swap, "ReverseSpread");
    });

    it("compares full-precision ratios even if cross products exceed uint256", async () => {
      const { swap } = await loadFixture(deployFixture);
      await swap.setMaxImpactBps(0n);
      const n = 1n << 200n;
      await swap.setAllSwapRatios(n, n, n, n, n, n, n, n);
      await expect(swap.setAllSwapRatios(n + 1n, n, n, n, n, n, n, n))
        .to.be.revertedWithCustomError(swap, "ReverseSpread");
    });

    it("allows a normal spread with equivalent differently-scaled fractions", async () => {
      const { swap } = await loadFixture(deployFixture);
      await swap.setMaxImpactBps(0n);
      await swap.setAllSwapRatios(1n, 2n, 100n, 200n, 2n, 4n, 1000n, 2000n);
      expect(await swap.getRatio()).to.deep.equal([1n, 2n]);
    });
  });

  describe("Fees", () => {
    it("owner can set swap fee bps", async () => {
      const { swap, owner } = await loadFixture(deployFixture);
      await expect(swap.connect(owner).setSwapFeeBps(50n))
        .to.emit(swap, "SwapFeeUpdated")
        .withArgs(0n, 50n);
      expect(await swap.getSwapFeeBps()).to.equal(50n);
    });

    it("rejects fee above 10000 bps", async () => {
      const { swap, owner } = await loadFixture(deployFixture);
      await expect(swap.connect(owner).setSwapFeeBps(10001n))
        .to.be.revertedWithCustomError(swap, "InvalidFeeBps");
    });
  });

  describe("Swaps", () => {
    it("buy CAS with POL at 1:1", async () => {
      const { swap, diamondAddr, user1, casToken } = await loadFixture(deployFixture);
      const amount = ethers.parseEther("1");
      const balBefore = await casToken.balanceOf(user1.address);
      const deadline = await getDeadline();
      await expect(swap.connect(user1).buyCASWithPOL(0n, deadline, { value: amount }))
        .to.emit(swap, "CASBoughtWithPOL")
        .withArgs(user1.address, amount, amount, 0n);
      const balAfter = await casToken.balanceOf(user1.address);
      expect(balAfter - balBefore).to.equal(amount);
      expect(await ethers.provider.getBalance(diamondAddr)).to.equal(ethers.parseEther("1001"));
    });

    it("sell CAS for POL at 1:1", async () => {
      const { swap, diamondAddr, user1, casToken } = await loadFixture(deployFixture);
      const amount = ethers.parseEther("1");
      const polBefore = await ethers.provider.getBalance(user1.address);
      const deadline = await getDeadline();
      await expect(swap.connect(user1).sellCASForPOL(amount, 0n, deadline))
        .to.emit(swap, "CASSoldForPOL");
      const polAfter = await ethers.provider.getBalance(user1.address);
      expect(polAfter - polBefore).to.be.closeTo(amount, ethers.parseEther("0.01"));
      expect(await casToken.balanceOf(diamondAddr)).to.equal(ethers.parseEther("100001"));
    });

    it("buy CAS with USDC at 1:1", async () => {
      const { swap, owner, diamondAddr, user1, casToken, usdcToken } = await loadFixture(deployFixture);
      // 1 USDC = 1 CAS  =>  1e6 USDC = 1e18 CAS  =>  num/den = 1e12/1
      await (await swap.connect(owner).setMaxImpactBps(0n)).wait();
      await (await swap.connect(owner).setSwapRatioUSDC(1_000_000_000_000n, 1n)).wait();
      const usdcIn = 1000_000000n; // 1k USDC
      const balBefore = await casToken.balanceOf(user1.address);
      const deadline = await getDeadline();
      await expect(swap.connect(user1).buyCASWithUSDC(usdcIn, 0n, deadline))
        .to.emit(swap, "CASBoughtWithUSDC");
      const balAfter = await casToken.balanceOf(user1.address);
      expect(balAfter - balBefore).to.equal(ethers.parseEther("1000"));
      expect(await usdcToken.balanceOf(diamondAddr)).to.equal(1_001_000_000000n);
    });

    it("sell CAS for USDC at 1:1", async () => {
      const { swap, owner, diamondAddr, user1, usdcToken } = await loadFixture(deployFixture);
      // 1 USDC = 1 CAS  =>  1e6 USDC = 1e18 CAS  =>  num/den = 1e12/1
      await (await swap.connect(owner).setMaxImpactBps(0n)).wait();
      await (await swap.connect(owner).setSwapRatioUSDC(1_000_000_000_000n, 1n)).wait();
      const casIn = ethers.parseEther("1000");
      const balBefore = await usdcToken.balanceOf(user1.address);
      const deadline = await getDeadline();
      await expect(swap.connect(user1).sellCASForUSDC(casIn, 0n, deadline))
        .to.emit(swap, "CASSoldForUSDC");
      const balAfter = await usdcToken.balanceOf(user1.address);
      expect(balAfter - balBefore).to.equal(1000_000000n);
      expect(await usdcToken.balanceOf(diamondAddr)).to.equal(999_000_000000n);
    });
  });
});
