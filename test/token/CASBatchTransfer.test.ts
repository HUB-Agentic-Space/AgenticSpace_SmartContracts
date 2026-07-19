import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("CASBatchTransfer", () => {
  async function deployFixture() {
    const [owner, user1, user2, user3, recipient1, recipient2, recipient3] =
      await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const casToken = await MockERC20.deploy("CAS Token", "CAS", 18);
    await casToken.waitForDeployment();

    const CASBatchTransfer = await ethers.getContractFactory("CASBatchTransfer");
    const batchTransfer = await CASBatchTransfer.deploy(await casToken.getAddress());
    await batchTransfer.waitForDeployment();

    const amount = ethers.parseEther("10000");
    await casToken.mint(owner.address, amount);
    await casToken.mint(user1.address, ethers.parseEther("1000"));

    return {
      owner,
      user1,
      user2,
      user3,
      recipient1,
      recipient2,
      recipient3,
      casToken,
      batchTransfer,
    };
  }

  describe("Initialization", () => {
    it("should set CAS token address", async () => {
      const { casToken, batchTransfer } = await loadFixture(deployFixture);
      expect(await batchTransfer.casToken()).to.equal(await casToken.getAddress());
    });

    it("should set MAX_RECIPIENTS to 200", async () => {
      const { batchTransfer } = await loadFixture(deployFixture);
      expect(await batchTransfer.MAX_RECIPIENTS()).to.equal(200);
    });

    it("should revert with zero address", async () => {
      const CASBatchTransfer = await ethers.getContractFactory("CASBatchTransfer");
      await expect(
        CASBatchTransfer.deploy(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(CASBatchTransfer, "ZeroAddress");
    });
  });

  describe("batchTransfer", () => {
    it("should transfer CAS to multiple recipients", async () => {
      const { owner, recipient1, recipient2, recipient3, casToken, batchTransfer } =
        await loadFixture(deployFixture);

      const recipients = [recipient1.address, recipient2.address, recipient3.address];
      const amounts = [
        ethers.parseEther("10"),
        ethers.parseEther("20"),
        ethers.parseEther("30"),
      ];
      const totalNeeded = ethers.parseEther("60");

      await casToken.approve(await batchTransfer.getAddress(), totalNeeded);

      const tx = await batchTransfer.batchTransfer(recipients, amounts);
      await tx.wait();

      expect(await casToken.balanceOf(recipient1.address)).to.equal(ethers.parseEther("10"));
      expect(await casToken.balanceOf(recipient2.address)).to.equal(ethers.parseEther("20"));
      expect(await casToken.balanceOf(recipient3.address)).to.equal(ethers.parseEther("30"));
    });

    it("should emit BatchTransferExecuted event", async () => {
      const { owner, recipient1, recipient2, casToken, batchTransfer } =
        await loadFixture(deployFixture);

      const recipients = [recipient1.address, recipient2.address];
      const amounts = [ethers.parseEther("5"), ethers.parseEther("15")];
      const totalNeeded = ethers.parseEther("20");

      await casToken.approve(await batchTransfer.getAddress(), totalNeeded);

      await expect(batchTransfer.batchTransfer(recipients, amounts))
        .to.emit(batchTransfer, "BatchTransferExecuted")
        .withArgs(owner.address, totalNeeded, 2);
    });

    it("should revert on length mismatch", async () => {
      const { recipient1, recipient2, casToken, batchTransfer } =
        await loadFixture(deployFixture);

      await casToken.approve(await batchTransfer.getAddress(), ethers.parseEther("100"));

      await expect(
        batchTransfer.batchTransfer(
          [recipient1.address, recipient2.address],
          [ethers.parseEther("10")]
        )
      ).to.be.revertedWithCustomError(batchTransfer, "LengthMismatch");
    });

    it("should revert when exceeding MAX_RECIPIENTS", async () => {
      const { casToken, batchTransfer } = await loadFixture(deployFixture);

      const recipients = Array(201).fill(ethers.ZeroAddress);
      const amounts = Array(201).fill(ethers.parseEther("1"));

      await expect(
        batchTransfer.batchTransfer(recipients, amounts)
      ).to.be.revertedWithCustomError(batchTransfer, "MaxRecipientsExceeded");
    });

    it("should revert on insufficient allowance", async () => {
      const { recipient1, casToken, batchTransfer } = await loadFixture(deployFixture);

      await casToken.approve(await batchTransfer.getAddress(), ethers.parseEther("5"));

      await expect(
        batchTransfer.batchTransfer([recipient1.address], [ethers.parseEther("10")])
      ).to.be.revertedWithCustomError(batchTransfer, "InsufficientAllowance");
    });

    it("should skip zero address recipients", async () => {
      const { recipient1, casToken, batchTransfer } = await loadFixture(deployFixture);

      const recipients = [recipient1.address, ethers.ZeroAddress];
      const amounts = [ethers.parseEther("10"), ethers.parseEther("5")];
      const totalNeeded = ethers.parseEther("15");

      await casToken.approve(await batchTransfer.getAddress(), totalNeeded);

      const tx = await batchTransfer.batchTransfer(recipients, amounts);
      await tx.wait();

      expect(await casToken.balanceOf(recipient1.address)).to.equal(ethers.parseEther("10"));
    });

    it("should skip zero amount recipients", async () => {
      const { recipient1, recipient2, casToken, batchTransfer } =
        await loadFixture(deployFixture);

      const recipients = [recipient1.address, recipient2.address];
      const amounts = [ethers.parseEther("10"), 0];
      const totalNeeded = ethers.parseEther("10");

      await casToken.approve(await batchTransfer.getAddress(), totalNeeded);

      const tx = await batchTransfer.batchTransfer(recipients, amounts);
      await tx.wait();

      expect(await casToken.balanceOf(recipient1.address)).to.equal(ethers.parseEther("10"));
      expect(await casToken.balanceOf(recipient2.address)).to.equal(0);
    });
  });

  describe("distribute", () => {
    it("should distribute CAS from contract balance", async () => {
      const {
        owner,
        recipient1,
        recipient2,
        casToken,
        batchTransfer,
      } = await loadFixture(deployFixture);

      const depositAmount = ethers.parseEther("100");
      await casToken.mint(await batchTransfer.getAddress(), depositAmount);

      const recipients = [recipient1.address, recipient2.address];
      const amounts = [ethers.parseEther("30"), ethers.parseEther("40")];

      const tx = await batchTransfer.distribute(recipients, amounts);
      await tx.wait();

      expect(await casToken.balanceOf(recipient1.address)).to.equal(ethers.parseEther("30"));
      expect(await casToken.balanceOf(recipient2.address)).to.equal(ethers.parseEther("40"));
    });

    it("should revert on insufficient balance", async () => {
      const { owner, recipient1, casToken, batchTransfer } = await loadFixture(deployFixture);

      await casToken.mint(await batchTransfer.getAddress(), ethers.parseEther("10"));

      await expect(
        batchTransfer.distribute([recipient1.address], [ethers.parseEther("50")])
      ).to.be.revertedWithCustomError(batchTransfer, "InsufficientBalance");
    });

    it("should revert when non-owner calls distribute", async () => {
      const { user1, recipient1, casToken, batchTransfer } = await loadFixture(deployFixture);

      await casToken.mint(await batchTransfer.getAddress(), ethers.parseEther("100"));

      await expect(
        batchTransfer.connect(user1).distribute([recipient1.address], [ethers.parseEther("10")])
      ).to.be.revertedWithCustomError(batchTransfer, "OwnableUnauthorizedAccount").withArgs(user1.address);
    });
  });

  describe("rescueTokens", () => {
    it("should rescue non-CAS tokens", async () => {
      const { owner, user1, casToken, batchTransfer } = await loadFixture(deployFixture);

      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const otherToken = await MockERC20.deploy("Other", "OTH", 18);
      await otherToken.waitForDeployment();

      await otherToken.mint(await batchTransfer.getAddress(), ethers.parseEther("100"));

      await batchTransfer.rescueTokens(
        await otherToken.getAddress(),
        user1.address,
        ethers.parseEther("100")
      );

      expect(await otherToken.balanceOf(user1.address)).to.equal(ethers.parseEther("100"));
    });

    it("should revert on zero token address", async () => {
      const { batchTransfer } = await loadFixture(deployFixture);

      await expect(
        batchTransfer.rescueTokens(ethers.ZeroAddress, ethers.ZeroAddress, 0)
      ).to.be.revertedWithCustomError(batchTransfer, "ZeroAddress");
    });

    it("should revert on zero amount", async () => {
      const { user1, casToken, batchTransfer } = await loadFixture(deployFixture);

      await expect(
        batchTransfer.rescueTokens(await casToken.getAddress(), user1.address, 0)
      ).to.be.revertedWithCustomError(batchTransfer, "ZeroAmount");
    });
  });
});
