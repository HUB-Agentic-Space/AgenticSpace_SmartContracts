import { expect } from "chai";
import { ethers } from "hardhat";

/**
 * Unit tests for LiquidityLock contract.
 * Tests deploy, lock, withdraw before/after unlock, extend, non-admin access.
 */
describe("LiquidityLock", () => {
  let lpToken: any;
  let lock: any;
  let deployer: any;
  let user1: any;
  const lockDuration = 365n * 86400n; // 1 year in seconds

  beforeEach(async () => {
    [deployer, user1] = await ethers.getSigners();

    // Deploy a mock ERC-20 as LP token
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    lpToken = await MockERC20.deploy("LP Token", "LP", 18);
    await lpToken.waitForDeployment();

    // Mint some LP tokens to deployer
    await lpToken.mint(deployer.address, ethers.parseEther("1000"));

    // Deploy LiquidityLock
    const LiquidityLock = await ethers.getContractFactory("LiquidityLock");
    lock = await LiquidityLock.deploy(
      await lpToken.getAddress(),
      lockDuration,
      deployer.address
    );
    await lock.waitForDeployment();
  });

  describe("Initialization", () => {
    it("should set LP token address", async () => {
      expect(await lock.getLPToken()).to.equal(await lpToken.getAddress());
    });

    it("should set unlock time in the future", async () => {
      const unlockTime = await lock.getUnlockTime();
      const now = BigInt(Math.floor(Date.now() / 1000));
      expect(unlockTime).to.be.gt(now);
    });

    it("should set owner", async () => {
      expect(await lock.owner()).to.equal(deployer.address);
    });
  });

  describe("Lock", () => {
    it("should receive LP tokens", async () => {
      const amount = ethers.parseEther("500");
      await lpToken.transfer(await lock.getAddress(), amount);
      expect(await lock.getLPTokenBalance()).to.equal(amount);
    });

    it("should not be expired immediately", async () => {
      expect(await lock.isExpired()).to.be.false;
    });
  });

  describe("Withdraw", () => {
    it("should revert before unlock time", async () => {
      const amount = ethers.parseEther("500");
      await lpToken.transfer(await lock.getAddress(), amount);

      await expect(lock.withdraw())
        .to.be.revertedWithCustomError(lock, "LockNotExpired");
    });

    it("should withdraw after unlock time", async () => {
      const amount = ethers.parseEther("500");
      await lpToken.transfer(await lock.getAddress(), amount);

      // Fast forward time
      await ethers.provider.send("evm_increaseTime", [Number(lockDuration) + 1]);
      await ethers.provider.send("evm_mine", []);

      const balBefore = await lpToken.balanceOf(deployer.address);
      await lock.withdraw();
      const balAfter = await lpToken.balanceOf(deployer.address);
      expect(balAfter - balBefore).to.equal(amount);
    });

    it("should revert withdraw by non-owner", async () => {
      await expect(lock.connect(user1).withdraw())
        .to.be.revertedWithCustomError(lock, "OwnableUnauthorizedAccount");
    });

    it("should revert when no tokens to withdraw", async () => {
      // Fast forward time
      await ethers.provider.send("evm_increaseTime", [Number(lockDuration) + 1]);
      await ethers.provider.send("evm_mine", []);

      await expect(lock.withdraw())
        .to.be.revertedWithCustomError(lock, "NoTokensToWithdraw");
    });
  });

  describe("extendLock", () => {
    it("should emit event when extending", async () => {
      const currentUnlock = await lock.getUnlockTime();
      const newUnlock = currentUnlock + 86400n;

      await expect(lock.extendLock(newUnlock))
        .to.emit(lock, "LockExtended")
        .withArgs(currentUnlock, newUnlock);
    });

    it("should revert with time <= current unlock", async () => {
      const currentUnlock = await lock.getUnlockTime();
      await expect(lock.extendLock(currentUnlock))
        .to.be.revertedWithCustomError(lock, "InvalidUnlockTime");
    });

    it("should revert for non-owner", async () => {
      const currentUnlock = await lock.getUnlockTime();
      await expect(lock.connect(user1).extendLock(currentUnlock + 86400n))
        .to.be.revertedWithCustomError(lock, "OwnableUnauthorizedAccount");
    });
  });
});
