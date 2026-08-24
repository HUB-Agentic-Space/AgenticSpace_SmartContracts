import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("BuybackBurn (UUPS)", function () {
  async function deployFixture() {
    const [admin, operator, treasurer, pauser, other] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const casToken = await MockERC20.deploy("Cryptocoin Agentic Space", "CAS", 18) as any;
    await casToken.waitForDeployment();

    const wpol = await MockERC20.deploy("Wrapped POL", "WPOL", 18) as any;
    await wpol.waitForDeployment();

    const MockBuybackRouter = await ethers.getContractFactory("MockBuybackRouter");
    const router = await MockBuybackRouter.deploy(
      await casToken.getAddress(),
      await wpol.getAddress(),
    ) as any;
    await router.waitForDeployment();

    const BuybackBurn = await ethers.getContractFactory("BuybackBurn");
    const buyback = await upgrades.deployProxy(
      BuybackBurn,
      [
        admin.address,
        await casToken.getAddress(),
        await router.getAddress(),
        await wpol.getAddress(),
      ],
      { kind: "uups", initializer: "initialize" },
    ) as any;
    await buyback.waitForDeployment();

    await buyback.grantRole(await buyback.OPERATOR_ROLE(), operator.address);
    await buyback.grantRole(await buyback.PAUSER_ROLE(), pauser.address);
    await buyback.grantRole(await buyback.TREASURER_ROLE(), treasurer.address);

    return { buyback, casToken, wpol, router, admin, operator, treasurer, pauser, other };
  }

  describe("Initialization", function () {
    it("should initialize with correct parameters", async function () {
      const { buyback, casToken, router, wpol, admin } = await loadFixture(deployFixture);

      expect(await buyback.getCasToken()).to.equal(await casToken.getAddress());
      expect(await buyback.getDexRouter()).to.equal(await router.getAddress());
      expect(await buyback.getWpol()).to.equal(await wpol.getAddress());
      expect(await buyback.getSlippageBps()).to.equal(50);
      expect(await buyback.getMinBuybackAmount()).to.equal(ethers.parseEther("5"));
      expect(await buyback.isPaused()).to.be.false;

      expect(await buyback.hasRole(await buyback.OPERATOR_ROLE(), admin.address)).to.be.true;
      expect(await buyback.hasRole(await buyback.PAUSER_ROLE(), admin.address)).to.be.true;
      expect(await buyback.hasRole(await buyback.TREASURER_ROLE(), admin.address)).to.be.true;
    });

    it("should not allow re-initialization", async function () {
      const { buyback, casToken, router, wpol } = await loadFixture(deployFixture);
      await expect(
        buyback.initialize(
          ethers.ZeroAddress,
          await casToken.getAddress(),
          await router.getAddress(),
          await wpol.getAddress(),
        ),
      ).to.be.revertedWithCustomError(buyback, "InvalidInitialization");
    });
  });

  describe("Deposit POL", function () {
    it("should accept POL via depositPOL", async function () {
      const { buyback, other } = await loadFixture(deployFixture);
      const amount = ethers.parseEther("10");

      await expect(
        buyback.connect(other).depositPOL({ value: amount }),
      ).to.emit(buyback, "POLDeposited")
        .withArgs(other.address, amount);

      expect(await buyback.getPOLBalance()).to.equal(amount);
    });

    it("should accept POL via receive", async function () {
      const { buyback, other } = await loadFixture(deployFixture);
      const amount = ethers.parseEther("5");

      await other.sendTransaction({
        to: await buyback.getAddress(),
        value: amount,
      });

      expect(await buyback.getPOLBalance()).to.equal(amount);
    });

    it("should revert on zero deposit", async function () {
      const { buyback, other } = await loadFixture(deployFixture);
      await expect(
        buyback.connect(other).depositPOL({ value: 0 }),
      ).to.be.revertedWithCustomError(buyback, "ZeroAmount");
    });
  });

  describe("Execute Buyback", function () {
    it("should buy CAS and burn it", async function () {
      const { buyback, casToken, router, operator } = await loadFixture(deployFixture);

      const polAmount = ethers.parseEther("10");
      const casToReturn = ethers.parseEther("3000");

      await casToken.mint(await router.getAddress(), casToReturn);
      await buyback.depositPOL({ value: polAmount });

      const supplyBefore = await casToken.totalSupply();
      const deadline = (await time.latest()) + 600;

      await expect(
        buyback.connect(operator).executeBuyback(
          ethers.parseEther("2900"),
          deadline,
        ),
      ).to.emit(buyback, "BuybackExecuted");

      const supplyAfter = await casToken.totalSupply();
      expect(supplyAfter).to.be.lt(supplyBefore);
      expect(supplyBefore - supplyAfter).to.equal(casToReturn);
      expect(await buyback.getPOLBalance()).to.equal(0);
    });

    it("should revert if paused", async function () {
      const { buyback, pauser, operator } = await loadFixture(deployFixture);

      await buyback.depositPOL({ value: ethers.parseEther("10") });
      await buyback.connect(pauser).pause();

      const deadline = (await time.latest()) + 600;
      await expect(
        buyback.connect(operator).executeBuyback(1, deadline),
      ).to.be.revertedWithCustomError(buyback, "EnforcedPause");
    });

    it("should revert if caller is not OPERATOR_ROLE", async function () {
      const { buyback, other } = await loadFixture(deployFixture);

      await buyback.depositPOL({ value: ethers.parseEther("10") });
      const deadline = (await time.latest()) + 600;

      await expect(
        buyback.connect(other).executeBuyback(1, deadline),
      ).to.be.revertedWithCustomError(buyback, "AccessControlUnauthorizedAccount");
    });

    it("should revert if POL balance below min", async function () {
      const { buyback, operator } = await loadFixture(deployFixture);

      await buyback.depositPOL({ value: ethers.parseEther("1") });
      const deadline = (await time.latest()) + 600;

      await expect(
        buyback.connect(operator).executeBuyback(1, deadline),
      ).to.be.revertedWithCustomError(buyback, "BelowMinAmount");
    });

    it("should revert on expired deadline", async function () {
      const { buyback, casToken, router, operator } = await loadFixture(deployFixture);

      await casToken.mint(await router.getAddress(), ethers.parseEther("3000"));
      await buyback.depositPOL({ value: ethers.parseEther("10") });

      const pastDeadline = (await time.latest()) - 1;
      await expect(
        buyback.connect(operator).executeBuyback(1, pastDeadline),
      ).to.be.revertedWithCustomError(buyback, "DeadlineExpired");
    });
  });

  describe("Admin — Operator", function () {
    it("should allow OPERATOR to set router", async function () {
      const { buyback, operator, other } = await loadFixture(deployFixture);

      await buyback.connect(operator).setDEXRouter(other.address);
      expect(await buyback.getDexRouter()).to.equal(other.address);
    });

    it("should not allow non-operator to set router", async function () {
      const { buyback, other } = await loadFixture(deployFixture);

      await expect(
        buyback.connect(other).setDEXRouter(other.address),
      ).to.be.revertedWithCustomError(buyback, "AccessControlUnauthorizedAccount");
    });

    it("should allow OPERATOR to set slippage within limit", async function () {
      const { buyback, operator } = await loadFixture(deployFixture);

      await buyback.connect(operator).setSlippageBps(200);
      expect(await buyback.getSlippageBps()).to.equal(200);
    });

    it("should revert on slippage above max", async function () {
      const { buyback, operator } = await loadFixture(deployFixture);

      await expect(
        buyback.connect(operator).setSlippageBps(501),
      ).to.be.revertedWithCustomError(buyback, "InvalidSlippage");
    });

    it("should allow OPERATOR to set min buyback amount", async function () {
      const { buyback, operator } = await loadFixture(deployFixture);

      await buyback.connect(operator).setMinBuybackAmount(ethers.parseEther("1"));
      expect(await buyback.getMinBuybackAmount()).to.equal(ethers.parseEther("1"));
    });
  });

  describe("Admin — Treasurer", function () {
    it("should allow TREASURER to withdraw POL", async function () {
      const { buyback, treasurer } = await loadFixture(deployFixture);

      await buyback.depositPOL({ value: ethers.parseEther("10") });
      const balBefore = await ethers.provider.getBalance(treasurer.address);

      await buyback.connect(treasurer).withdrawPOL(ethers.parseEther("5"));

      const balAfter = await ethers.provider.getBalance(treasurer.address);
      expect(balAfter).to.be.gt(balBefore);
      expect(await buyback.getPOLBalance()).to.equal(ethers.parseEther("5"));
    });

    it("should not allow non-treasurer to withdraw", async function () {
      const { buyback, other } = await loadFixture(deployFixture);

      await buyback.depositPOL({ value: ethers.parseEther("10") });
      await expect(
        buyback.connect(other).withdrawPOL(ethers.parseEther("5")),
      ).to.be.revertedWithCustomError(buyback, "AccessControlUnauthorizedAccount");
    });
  });

  describe("Pause / Unpause", function () {
    it("should allow PAUSER to pause and unpause", async function () {
      const { buyback, pauser } = await loadFixture(deployFixture);

      await buyback.connect(pauser).pause();
      expect(await buyback.isPaused()).to.be.true;

      await buyback.connect(pauser).unpause();
      expect(await buyback.isPaused()).to.be.false;
    });
  });

  describe("UUPS Upgrade", function () {
    it("should allow DEFAULT_ADMIN to upgrade", async function () {
      const { buyback, admin } = await loadFixture(deployFixture);

      const BuybackBurnV2 = await ethers.getContractFactory("BuybackBurn");
      await upgrades.upgradeProxy(
        await buyback.getAddress(),
        BuybackBurnV2.connect(admin),
      );

      expect(await buyback.getCasToken()).to.be.properAddress;
    });

    it("should not allow non-admin to upgrade", async function () {
      const { buyback, other } = await loadFixture(deployFixture);

      const BuybackBurnV2 = await ethers.getContractFactory("BuybackBurn");
      await expect(
        upgrades.upgradeProxy(
          await buyback.getAddress(),
          BuybackBurnV2.connect(other),
        ),
      ).to.be.revertedWithCustomError(buyback, "AccessControlUnauthorizedAccount");
    });
  });
});
