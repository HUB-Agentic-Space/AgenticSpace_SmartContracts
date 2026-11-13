import { expect } from "chai";
import { ethers } from "hardhat";

describe("CASToken — Freeze/Unfreeze", () => {
  let casToken: any;
  let deployer: any;
  let compliance: any;
  let user1: any;
  let user2: any;

  const COMPLIANCE_ROLE = ethers.keccak256(ethers.toUtf8Bytes("COMPLIANCE_ROLE"));

  beforeEach(async () => {
    [deployer, compliance, user1, user2] = await ethers.getSigners();
    const CASToken = await ethers.getContractFactory("CASToken");
    casToken = await CASToken.deploy();
    await casToken.waitForDeployment();
    await (await casToken["initialize(address,uint256,string,string)"](
      deployer.address,
      ethers.parseEther("1000000"),
      "Cryptocoin Agentic Space",
      "CAS",
    )).wait();

    await (await casToken.grantRole(COMPLIANCE_ROLE, compliance.address)).wait();
    await (await casToken.mint(user1.address, ethers.parseEther("1000"))).wait();
    await (await casToken.mint(user2.address, ethers.parseEther("1000"))).wait();
  });

  describe("freeze", () => {
    it("should freeze an account (permanent)", async () => {
      await expect(casToken.connect(compliance).freeze(user1.address))
        .to.emit(casToken, "Frozen")
        .withArgs(user1.address, 0);
      expect(await casToken.isFrozen(user1.address)).to.be.true;
    });

    it("should revert if non-compliance calls freeze", async () => {
      await expect(casToken.connect(user1).freeze(user2.address))
        .to.be.revertedWithCustomError(casToken, "AccessControlUnauthorizedAccount");
    });

    it("should revert on zero address", async () => {
      await expect(casToken.connect(compliance).freeze(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(casToken, "CannotFreezeZeroAddress");
    });

    it("should block transfer from frozen account", async () => {
      await casToken.connect(compliance).freeze(user1.address);
      await expect(casToken.connect(user1).transfer(user2.address, 100))
        .to.be.revertedWithCustomError(casToken, "AccountFrozen");
    });

    it("should block transfer to frozen account", async () => {
      await casToken.connect(compliance).freeze(user2.address);
      await expect(casToken.connect(user1).transfer(user2.address, 100))
        .to.be.revertedWithCustomError(casToken, "AccountFrozen");
    });
  });

  describe("freezeUntil", () => {
    it("should freeze until a future timestamp", async () => {
      const future = (await ethers.provider.getBlock("latest")).timestamp + 86400;
      await expect(casToken.connect(compliance).freezeUntil(user1.address, future))
        .to.emit(casToken, "Frozen")
        .withArgs(user1.address, future);
      expect(await casToken.isFrozen(user1.address)).to.be.true;
      expect(await casToken.freezeUntilOf(user1.address)).to.equal(future);
    });

    it("should revert if endTime is not in the future", async () => {
      const now = (await ethers.provider.getBlock("latest")).timestamp;
      await expect(casToken.connect(compliance).freezeUntil(user1.address, now))
        .to.be.revertedWithCustomError(casToken, "FreezeUntilMustBeFuture");
    });

    it("should auto-unfreeze after endTime passes", async () => {
      const future = (await ethers.provider.getBlock("latest")).timestamp + 5;
      await casToken.connect(compliance).freezeUntil(user1.address, future);

      await ethers.provider.send("evm_increaseTime", [10]);
      await ethers.provider.send("evm_mine", []);

      expect(await casToken.isFrozen(user1.address)).to.be.false;
    });

    it("should emit Unfrozen on auto-unfreeze during transfer", async () => {
      const future = (await ethers.provider.getBlock("latest")).timestamp + 5;
      await casToken.connect(compliance).freezeUntil(user1.address, future);

      await ethers.provider.send("evm_increaseTime", [10]);
      await ethers.provider.send("evm_mine", []);

      await expect(casToken.connect(user1).transfer(user2.address, 100))
        .to.emit(casToken, "Unfrozen")
        .withArgs(user1.address);
    });
  });

  describe("unfreeze", () => {
    it("should unfreeze a frozen account", async () => {
      await casToken.connect(compliance).freeze(user1.address);
      await expect(casToken.connect(compliance).unfreeze(user1.address))
        .to.emit(casToken, "Unfrozen")
        .withArgs(user1.address);
      expect(await casToken.isFrozen(user1.address)).to.be.false;
    });

    it("should revert if non-compliance calls unfreeze", async () => {
      await casToken.connect(compliance).freeze(user1.address);
      await expect(casToken.connect(user1).unfreeze(user1.address))
        .to.be.revertedWithCustomError(casToken, "AccessControlUnauthorizedAccount");
    });

    it("should revert on zero address", async () => {
      await expect(casToken.connect(compliance).unfreeze(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(casToken, "CannotFreezeZeroAddress");
    });

    it("should allow transfer after unfreeze", async () => {
      await casToken.connect(compliance).freeze(user1.address);
      await casToken.connect(compliance).unfreeze(user1.address);
      await expect(casToken.connect(user1).transfer(user2.address, 100))
        .not.to.be.reverted;
    });
  });

  describe("isFrozen view", () => {
    it("should return false for non-frozen account", async () => {
      expect(await casToken.isFrozen(user1.address)).to.be.false;
    });

    it("should return false for expired temporary freeze", async () => {
      const future = (await ethers.provider.getBlock("latest")).timestamp + 5;
      await casToken.connect(compliance).freezeUntil(user1.address, future);

      await ethers.provider.send("evm_increaseTime", [10]);
      await ethers.provider.send("evm_mine", []);

      expect(await casToken.isFrozen(user1.address)).to.be.false;
    });

    it("should return true for permanent freeze", async () => {
      await casToken.connect(compliance).freeze(user1.address);
      expect(await casToken.isFrozen(user1.address)).to.be.true;
    });
  });

  describe("freezeUntilOf view", () => {
    it("should return 0 for permanent freeze", async () => {
      await casToken.connect(compliance).freeze(user1.address);
      expect(await casToken.freezeUntilOf(user1.address)).to.equal(0);
    });

    it("should return endTime for limited freeze", async () => {
      const future = (await ethers.provider.getBlock("latest")).timestamp + 86400;
      await casToken.connect(compliance).freezeUntil(user1.address, future);
      expect(await casToken.freezeUntilOf(user1.address)).to.equal(future);
    });

    it("should return 0 for non-frozen account", async () => {
      expect(await casToken.freezeUntilOf(user1.address)).to.equal(0);
    });
  });

  describe("Idempotency", () => {
    it("should allow re-freezing an already frozen account", async () => {
      await casToken.connect(compliance).freeze(user1.address);
      await expect(casToken.connect(compliance).freeze(user1.address))
        .to.emit(casToken, "Frozen");
    });

    it("should allow unfreezing a non-frozen account", async () => {
      await expect(casToken.connect(compliance).unfreeze(user1.address))
        .to.emit(casToken, "Unfrozen");
    });
  });
});
