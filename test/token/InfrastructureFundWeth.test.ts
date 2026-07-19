import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("InfrastructureFund WETH + Hardening", () => {
  async function deployFixture() {
    const [admin, treasurer, pauser, rapport, author, user1, attacker] =
      await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const casToken = await MockERC20.deploy("CAS Token", "CAS", 18) as any;
    await casToken.waitForDeployment();

    const wethToken = await MockERC20.deploy("Wrapped ETH", "WETH", 18) as any;
    await wethToken.waitForDeployment();

    const InfrastructureFund = await ethers.getContractFactory("InfrastructureFund");
    const fundProxy = await upgrades.deployProxy(
      InfrastructureFund,
      [admin.address, await casToken.getAddress(), rapport.address, author.address],
      { kind: "uups" }
    );
    await fundProxy.waitForDeployment();

    const fund = InfrastructureFund.attach(await fundProxy.getAddress()) as any;

    await fund.grantRole(await fund.TREASURER_ROLE(), treasurer.address);
    await fund.grantRole(await fund.PAUSER_ROLE(), pauser.address);

    await casToken.mint(user1.address, ethers.parseEther("1000"));
    await wethToken.mint(user1.address, ethers.parseEther("500"));

    return {
      admin,
      treasurer,
      pauser,
      rapport,
      author,
      user1,
      attacker,
      casToken,
      wethToken,
      fund,
    };
  }

  const { upgrades } = require("hardhat");

  describe("WETH Support", () => {
    it("should revert depositWeth when wethToken not set (testnet fallback)", async () => {
      const { user1, fund } = await loadFixture(deployFixture);

      await expect(
        fund.connect(user1).depositWeth(ethers.parseEther("10"))
      ).to.be.revertedWithCustomError(fund, "WethNotSupported");
    });

    it("should deposit WETH after setWethToken", async () => {
      const { admin, user1, wethToken, fund } = await loadFixture(deployFixture);

      await fund.connect(admin).setWethToken(await wethToken.getAddress());
      await wethToken.connect(user1).approve(await fund.getAddress(), ethers.parseEther("50"));
      await fund.connect(user1).depositWeth(ethers.parseEther("50"));

      expect(await fund.wethBalance()).to.equal(ethers.parseEther("50"));
    });

    it("should return 0 wethBalance when wethToken not set", async () => {
      const { fund } = await loadFixture(deployFixture);
      expect(await fund.wethBalance()).to.equal(0);
    });

    it("should transfer WETH to rapport", async () => {
      const { admin, treasurer, rapport, wethToken, fund } = await loadFixture(deployFixture);

      await fund.connect(admin).setWethToken(await wethToken.getAddress());
      await wethToken.mint(await fund.getAddress(), ethers.parseEther("100"));

      await fund.connect(treasurer).transferWethToRapport(ethers.parseEther("30"));

      expect(await wethToken.balanceOf(rapport.address)).to.equal(ethers.parseEther("30"));
    });

    it("should transfer WETH to author", async () => {
      const { admin, treasurer, author, wethToken, fund } = await loadFixture(deployFixture);

      await fund.connect(admin).setWethToken(await wethToken.getAddress());
      await wethToken.mint(await fund.getAddress(), ethers.parseEther("100"));

      await fund.connect(treasurer).transferWethToAuthor(ethers.parseEther("40"));

      expect(await wethToken.balanceOf(author.address)).to.equal(ethers.parseEther("40"));
    });

    it("should revert WETH transfer when wethToken not set", async () => {
      const { treasurer, rapport, fund } = await loadFixture(deployFixture);

      await expect(
        fund.connect(treasurer).transferWethToRapport(ethers.parseEther("10"))
      ).to.be.revertedWithCustomError(fund, "WethNotSupported");
    });

    it("should revert WETH transfer on insufficient balance", async () => {
      const { admin, treasurer, rapport, wethToken, fund } = await loadFixture(deployFixture);

      await fund.connect(admin).setWethToken(await wethToken.getAddress());
      await wethToken.mint(await fund.getAddress(), ethers.parseEther("10"));

      await expect(
        fund.connect(treasurer).transferWethToRapport(ethers.parseEther("50"))
      ).to.be.revertedWithCustomError(fund, "InsufficientWethBalance");
    });

    it("should emit WethTokenUpdated event", async () => {
      const { admin, wethToken, fund } = await loadFixture(deployFixture);

      await expect(fund.connect(admin).setWethToken(await wethToken.getAddress()))
        .to.emit(fund, "WethTokenUpdated")
        .withArgs(ethers.ZeroAddress, await wethToken.getAddress());
    });
  });

  describe("Security: ReentrancyGuard on depositNative", () => {
    it("should accept native deposits", async () => {
      const { user1, fund } = await loadFixture(deployFixture);

      await expect(
        fund.connect(user1).depositNative({ value: ethers.parseEther("1") })
      ).to.emit(fund, "NativeReceived");
    });

    it("should revert on zero native deposit", async () => {
      const { user1, fund } = await loadFixture(deployFixture);

      await expect(
        fund.connect(user1).depositNative({ value: 0 })
      ).to.be.revertedWithCustomError(fund, "ZeroAmount");
    });
  });
});
