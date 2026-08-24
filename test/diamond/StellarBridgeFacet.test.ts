import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("StellarBridgeFacet", () => {
  async function deployFixture() {
    const [owner, user1, bridgeOperator, bridgeAdmin, recipient] =
      await ethers.getSigners();

    // Deploy mock CAS token
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const casToken = await MockERC20.deploy("CAS Token", "CAS", 18);
    await casToken.waitForDeployment();
    const casTokenAddr = await casToken.getAddress();

    // Deploy StellarBridgeFacet
    const StellarBridgeFacet = await ethers.getContractFactory("StellarBridgeFacet");
    const facet = await StellarBridgeFacet.deploy();
    await facet.waitForDeployment();
    const facetAddr = await facet.getAddress();

    // Set contract owner in LibDiamond storage
    const baseSlot = ethers.keccak256(ethers.toUtf8Bytes("agentic.space.diamond.storage"));
    const ownerSlot = ethers.toQuantity(BigInt(baseSlot) + 4n);
    await ethers.provider.send("hardhat_setStorageAt", [
      facetAddr,
      ownerSlot,
      ethers.zeroPadValue(owner.address, 32),
    ]);

    // Initialize the facet
    await facet.initStellarBridge(
      casTokenAddr,
      bridgeAdmin.address,
      bridgeOperator.address
    );

    // Mint CAS to user1 and the facet
    await casToken.mint(user1.address, ethers.parseEther("10000"));
    await casToken.mint(facetAddr, ethers.parseEther("100000"));

    // User1 approves CAS for the facet
    await casToken.connect(user1).approve(facetAddr, ethers.parseEther("10000"));

    const stellarRecipient = ethers.randomBytes(32);
    const stellarRecipientBytes32 = ethers.hexlify(stellarRecipient);

    return {
      owner,
      user1,
      bridgeOperator,
      bridgeAdmin,
      recipient,
      casToken,
      casTokenAddr,
      facet,
      facetAddr,
      stellarRecipientBytes32,
    };
  }

  describe("Initialization", () => {
    it("should initialize with correct values", async () => {
      const { facet, casTokenAddr, bridgeAdmin, bridgeOperator } = await loadFixture(deployFixture);

      expect(await facet.getBridgeAdmin()).to.equal(bridgeAdmin.address);
      expect(await facet.getBridgeOperator()).to.equal(bridgeOperator.address);
      expect(await facet.isBridgePaused()).to.equal(false);
      expect(await facet.getBridgeFeeBps()).to.equal(30);
    });

    it("should revert if non-owner calls initStellarBridge", async () => {
      const { facet, user1, casTokenAddr, bridgeAdmin, bridgeOperator } = await loadFixture(deployFixture);
      await expect(
        facet.connect(user1).initStellarBridge(casTokenAddr, bridgeAdmin.address, bridgeOperator.address)
      ).to.be.revertedWithCustomError(facet, "NotBridgeAdmin");
    });
  });

  describe("lockForStellar", () => {
    it("should lock CAS and emit event", async () => {
      const { facet, facetAddr, user1, casToken, stellarRecipientBytes32 } = await loadFixture(deployFixture);
      const amount = ethers.parseEther("100");

      const tx = facet.connect(user1).lockForStellar(stellarRecipientBytes32, amount);
      await expect(tx)
        .to.emit(facet, "CasLockedForStellar")
        .withArgs(
          await computeLockId(facet, user1.address, stellarRecipientBytes32, amount, 0),
          user1.address,
          stellarRecipientBytes32,
          amount,
          0
        );

      // Check CAS was transferred
      expect(await casToken.balanceOf(facetAddr)).to.be.gte(ethers.parseEther("100100"));
    });

    it("should increment nonce", async () => {
      const { facet, user1, stellarRecipientBytes32 } = await loadFixture(deployFixture);
      const amount = ethers.parseEther("100");

      await facet.connect(user1).lockForStellar(stellarRecipientBytes32, amount);
      expect(await facet.getNonce(user1.address)).to.equal(1);

      await facet.connect(user1).lockForStellar(stellarRecipientBytes32, amount);
      expect(await facet.getNonce(user1.address)).to.equal(2);
    });

    it("should revert with zero amount", async () => {
      const { facet, user1, stellarRecipientBytes32 } = await loadFixture(deployFixture);
      await expect(
        facet.connect(user1).lockForStellar(stellarRecipientBytes32, 0)
      ).to.be.revertedWithCustomError(facet, "AmountIsZero");
    });

    it("should revert with zero stellar recipient", async () => {
      const { facet, user1 } = await loadFixture(deployFixture);
      await expect(
        facet.connect(user1).lockForStellar(ethers.ZeroHash, ethers.parseEther("100"))
      ).to.be.revertedWithCustomError(facet, "StellarRecipientZero");
    });

    it("should revert when paused", async () => {
      const { facet, bridgeAdmin, user1, stellarRecipientBytes32 } = await loadFixture(deployFixture);
      await facet.connect(bridgeAdmin).setBridgePaused(true);
      await expect(
        facet.connect(user1).lockForStellar(stellarRecipientBytes32, ethers.parseEther("100"))
      ).to.be.revertedWithCustomError(facet, "BridgeIsPaused");
    });
  });

  describe("confirmStellarLock", () => {
    it("should confirm lock when called by operator", async () => {
      const { facet, bridgeOperator, user1, stellarRecipientBytes32 } = await loadFixture(deployFixture);
      const amount = ethers.parseEther("100");

      const tx = await facet.connect(user1).lockForStellar(stellarRecipientBytes32, amount);
      const receipt = await tx.wait();
      const event = receipt!.logs.find(
        (log) => facet.interface.parseLog(log)?.name === "CasLockedForStellar"
      );
      const lockId = facet.interface.parseLog(event!)!.args.lockId;

      const stellarTxHash = ethers.randomBytes(32);
      await expect(
        facet.connect(bridgeOperator).confirmStellarLock(lockId, ethers.hexlify(stellarTxHash))
      ).to.emit(facet, "StellarLockConfirmed");

      const record = await facet.getLockRecord(lockId);
      expect(record.status).to.equal(2); // Completed
    });

    it("should revert when called by non-operator", async () => {
      const { facet, user1, stellarRecipientBytes32 } = await loadFixture(deployFixture);
      const amount = ethers.parseEther("100");

      const tx = await facet.connect(user1).lockForStellar(stellarRecipientBytes32, amount);
      const receipt = await tx.wait();
      const event = receipt!.logs.find(
        (log) => facet.interface.parseLog(log)?.name === "CasLockedForStellar"
      );
      const lockId = facet.interface.parseLog(event!)!.args.lockId;

      await expect(
        facet.connect(user1).confirmStellarLock(lockId, ethers.hexlify(ethers.randomBytes(32)))
      ).to.be.revertedWithCustomError(facet, "NotBridgeOperator");
    });
  });

  describe("cancelLock", () => {
    it("should cancel and refund", async () => {
      const { facet, user1, casToken, stellarRecipientBytes32 } = await loadFixture(deployFixture);
      const amount = ethers.parseEther("100");

      const balanceBefore = await casToken.balanceOf(user1.address);
      const tx = await facet.connect(user1).lockForStellar(stellarRecipientBytes32, amount);
      const receipt = await tx.wait();
      const event = receipt!.logs.find(
        (log) => facet.interface.parseLog(log)?.name === "CasLockedForStellar"
      );
      const lockId = facet.interface.parseLog(event!)!.args.lockId;

      await expect(facet.connect(user1).cancelLock(lockId))
        .to.emit(facet, "LockCancelled");

      const balanceAfter = await casToken.balanceOf(user1.address);
      expect(balanceAfter).to.equal(balanceBefore);
    });
  });

  describe("unlockFromStellar", () => {
    it("should unlock CAS to recipient", async () => {
      const { facet, facetAddr, bridgeOperator, recipient, casToken } = await loadFixture(deployFixture);
      const amount = ethers.parseEther("50");
      const stellarLockId = ethers.hexlify(ethers.randomBytes(32));

      const balanceBefore = await casToken.balanceOf(recipient.address);

      await expect(
        facet.connect(bridgeOperator).unlockFromStellar(stellarLockId, recipient.address, amount)
      ).to.emit(facet, "CasUnlockedFromStellar");

      const balanceAfter = await casToken.balanceOf(recipient.address);
      expect(balanceAfter - balanceBefore).to.equal(amount);
    });

    it("should revert on replay", async () => {
      const { facet, bridgeOperator, recipient } = await loadFixture(deployFixture);
      const amount = ethers.parseEther("50");
      const stellarLockId = ethers.hexlify(ethers.randomBytes(32));

      await facet.connect(bridgeOperator).unlockFromStellar(stellarLockId, recipient.address, amount);

      await expect(
        facet.connect(bridgeOperator).unlockFromStellar(stellarLockId, recipient.address, amount)
      ).to.be.revertedWithCustomError(facet, "UnlockAlreadyProcessed");
    });

    it("should revert when called by non-operator", async () => {
      const { facet, user1, recipient } = await loadFixture(deployFixture);
      await expect(
        facet.connect(user1).unlockFromStellar(ethers.hexlify(ethers.randomBytes(32)), recipient.address, ethers.parseEther("50"))
      ).to.be.revertedWithCustomError(facet, "NotBridgeOperator");
    });
  });

  describe("Admin functions", () => {
    it("should set bridge operator", async () => {
      const { facet, bridgeAdmin, user1 } = await loadFixture(deployFixture);
      await facet.connect(bridgeAdmin).setBridgeOperator(user1.address);
      expect(await facet.getBridgeOperator()).to.equal(user1.address);
    });

    it("should set paused", async () => {
      const { facet, bridgeAdmin } = await loadFixture(deployFixture);
      await facet.connect(bridgeAdmin).setBridgePaused(true);
      expect(await facet.isBridgePaused()).to.equal(true);
    });

    it("should revert fee too high", async () => {
      const { facet, bridgeAdmin } = await loadFixture(deployFixture);
      await expect(
        facet.connect(bridgeAdmin).setBridgeFeeBps(1001)
      ).to.be.revertedWithCustomError(facet, "FeeTooHigh");
    });

    it("should revert non-admin setting operator", async () => {
      const { facet, user1 } = await loadFixture(deployFixture);
      await expect(
        facet.connect(user1).setBridgeOperator(user1.address)
      ).to.be.revertedWithCustomError(facet, "NotBridgeAdmin");
    });
  });

  async function computeLockId(
    facet: any,
    sender: string,
    stellarRecipient: string,
    amount: bigint,
    nonce: bigint
  ): Promise<string> {
    return ethers.keccak256(
      ethers.solidityPacked(
        ["address", "bytes32", "uint256", "uint64"],
        [sender, stellarRecipient, amount, nonce]
      )
    );
  }
});
