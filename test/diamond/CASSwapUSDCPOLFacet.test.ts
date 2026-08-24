import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

async function getDeadline(seconds = 3600): Promise<bigint> {
  const block = await ethers.provider.getBlock("latest");
  return BigInt(block!.timestamp + seconds);
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

    // Deploy facet
    const SwapFacet = await ethers.getContractFactory("CASSwapUSDCPOLFacet");
    const facet = await SwapFacet.deploy();
    await facet.waitForDeployment();
    const facetAddr = await facet.getAddress();

    // Set Diamond owner slot in LibDiamond storage
    const baseSlot = ethers.keccak256(ethers.toUtf8Bytes("agentic.space.diamond.storage"));
    const ownerSlot = "0x" + (BigInt(baseSlot) + 4n).toString(16).padStart(64, "0");
    await ethers.provider.send("hardhat_setStorageAt", [
      facetAddr,
      ownerSlot,
      ethers.zeroPadValue(owner.address, 32),
    ]);
    const ownerInSlot = await ethers.provider.getStorage(facetAddr, ownerSlot);
    console.log("DEBUG owner in slot:", ownerInSlot);

    // Init
    const code = await ethers.provider.getCode(facetAddr);
    console.log("DEBUG code size:", (code.length - 2) / 2);
    console.log("DEBUG init selector in runtime:", code.toLowerCase().includes(ethers.id("initCASSwapUSDCPOL(address,address)").slice(2, 10).toLowerCase()));
    console.log("DEBUG facet target:", facet.target, "addr:", facetAddr, "ownerSlot:", ownerSlot);
    const initData = facet.interface.encodeFunctionData("initCASSwapUSDCPOL", [casAddr, usdcAddr]);
    console.log("DEBUG init data:", initData);
    try {
      await (await facet.initCASSwapUSDCPOL(casAddr, usdcAddr)).wait();
    } catch (e: any) {
      console.log("DEBUG init error data:", e.data);
      console.log("DEBUG init error:", e.message);
      throw e;
    }

    // Fund facet with CAS, USDC and POL
    await casToken.mint(facetAddr, ethers.parseEther("100000"));
    await usdcToken.mint(facetAddr, 1_000_000_000000n); // 1M USDC
    await owner.sendTransaction({ to: facetAddr, value: ethers.parseEther("1000") });

    // Fund user
    await casToken.mint(user1.address, ethers.parseEther("10000"));
    await usdcToken.mint(user1.address, 100_000_000000n); // 100k USDC
    await casToken.connect(user1).approve(facetAddr, ethers.parseEther("10000"));
    await usdcToken.connect(user1).approve(facetAddr, 100_000_000000n);

    return { owner, user1, treasurer, casToken, usdcToken, facet, facetAddr };
  }

  describe("Initialization", () => {
    it("initializes with default ratios and tokens", async () => {
      const { facet, casToken, usdcToken } = await loadFixture(deployFixture);
      const [num, den] = await facet.getRatio();
      const [uNum, uDen] = await facet.getRatioUSDC();
      expect(num).to.equal(1n);
      expect(den).to.equal(1n);
      expect(uNum).to.equal(1n);
      expect(uDen).to.equal(1n);
      expect(await facet.isSwapPaused()).to.be.false;
      const reserves = await facet.getReserves();
      expect(reserves.casBalance).to.equal(ethers.parseEther("100000"));
      expect(reserves.usdcBalance).to.equal(1_000_000_000000n);
      expect(reserves.polBalance).to.equal(ethers.parseEther("1000"));
    });
  });

  describe("Ratios", () => {
    it("only owner can set ratio", async () => {
      const { facet, user1 } = await loadFixture(deployFixture);
      await expect(facet.connect(user1).setSwapRatio(2n, 1n))
        .to.be.revertedWithCustomError(facet, "MissingRole");
    });

    it("owner can set POL ratio", async () => {
      const { facet, owner } = await loadFixture(deployFixture);
      await expect(facet.connect(owner).setSwapRatio(2n, 1n))
        .to.emit(facet, "RatioUpdated")
        .withArgs(0, 2n, 1n, owner.address);
      const [num, den] = await facet.getRatio();
      expect(num).to.equal(2n);
      expect(den).to.equal(1n);
    });

    it("rejects zero ratio", async () => {
      const { facet, owner } = await loadFixture(deployFixture);
      await expect(facet.connect(owner).setSwapRatio(0n, 1n))
        .to.be.revertedWithCustomError(facet, "InvalidRatioArg");
    });
  });

  describe("Swaps", () => {
    it("buy CAS with POL at 1:1", async () => {
      const { facet, facetAddr, user1, casToken } = await loadFixture(deployFixture);
      const amount = ethers.parseEther("1");
      const balBefore = await casToken.balanceOf(user1.address);
      const deadline = await getDeadline();
      await expect(facet.connect(user1).buyCASWithPOL(0n, deadline, { value: amount }))
        .to.emit(facet, "CASBoughtWithPOL")
        .withArgs(user1.address, amount, amount, 0n);
      const balAfter = await casToken.balanceOf(user1.address);
      expect(balAfter - balBefore).to.equal(amount);
      expect(await ethers.provider.getBalance(facetAddr)).to.equal(ethers.parseEther("1001"));
    });

    it("sell CAS for POL at 1:1", async () => {
      const { facet, facetAddr, user1, casToken } = await loadFixture(deployFixture);
      const amount = ethers.parseEther("1");
      const polBefore = await ethers.provider.getBalance(user1.address);
      const deadline = await getDeadline();
      await expect(facet.connect(user1).sellCASForPOL(amount, 0n, deadline))
        .to.emit(facet, "CASSoldForPOL");
      const polAfter = await ethers.provider.getBalance(user1.address);
      expect(polAfter - polBefore).to.be.closeTo(amount, ethers.parseEther("0.01"));
      expect(await casToken.balanceOf(facetAddr)).to.equal(ethers.parseEther("100001"));
    });

    it("buy CAS with USDC at 1:1", async () => {
      const { facet, facetAddr, user1, casToken, usdcToken } = await loadFixture(deployFixture);
      const usdcIn = 1000_000000n; // 1k USDC
      const balBefore = await casToken.balanceOf(user1.address);
      const deadline = await getDeadline();
      await expect(facet.connect(user1).buyCASWithUSDC(usdcIn, 0n, deadline))
        .to.emit(facet, "CASBoughtWithUSDC");
      const balAfter = await casToken.balanceOf(user1.address);
      expect(balAfter - balBefore).to.equal(ethers.parseEther("1000"));
      expect(await usdcToken.balanceOf(facetAddr)).to.equal(1_001_000_000000n);
    });

    it("sell CAS for USDC at 1:1", async () => {
      const { facet, facetAddr, user1, usdcToken } = await loadFixture(deployFixture);
      const casIn = ethers.parseEther("1000");
      const balBefore = await usdcToken.balanceOf(user1.address);
      const deadline = await getDeadline();
      await expect(facet.connect(user1).sellCASForUSDC(casIn, 0n, deadline))
        .to.emit(facet, "CASSoldForUSDC");
      const balAfter = await usdcToken.balanceOf(user1.address);
      expect(balAfter - balBefore).to.equal(1000_000000n);
      expect(await usdcToken.balanceOf(facetAddr)).to.equal(999_000_000000n);
    });

  });
});
