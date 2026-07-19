import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("PaymentFacet Batch Transfer", () => {
  async function deployFixture() {
    const [owner, user1, recipient1, recipient2, recipient3] =
      await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const casToken = await MockERC20.deploy("CAS Token", "CAS", 18) as any;
    await casToken.waitForDeployment();

    const PaymentFacet = await ethers.getContractFactory("PaymentFacet");
    const paymentFacet = await PaymentFacet.deploy() as any;
    await paymentFacet.waitForDeployment();

    // Set contract owner in LibDiamond storage (slot: keccak256("agentic.space.diamond.storage"))
    // This is needed because initPayment/setCasToken/distribute use enforceIsContractOwner()
    // LibDiamond.DiamondStorage struct layout:
    //   slot 0: facetAddresses (array length)
    //   slot 1: facetFunctionSelectors (mapping)
    //   slot 2: facetFunctionSelectors (mapping)  
    //   slot 3: supportedInterfaces (mapping)
    //   slot 4: contractOwner (address)
    //   slot 5: paused (bool)
    const baseSlot = ethers.keccak256(ethers.toUtf8Bytes("agentic.space.diamond.storage"));
    // contractOwner is at base + 4
    const ownerSlot = ethers.toQuantity(
      BigInt(baseSlot) + 4n
    );
    await ethers.provider.send("hardhat_setStorageAt", [
      await paymentFacet.getAddress(),
      ownerSlot,
      ethers.zeroPadValue(owner.address, 32),
    ]);

    // Initialize payment storage with default fees (requires contract owner)
    await paymentFacet.initPayment();

    // Set CAS token
    await paymentFacet.setCasToken(await casToken.getAddress());

    // Mint CAS to user1 and owner
    await casToken.mint(user1.address, ethers.parseEther("10000"));
    await casToken.mint(owner.address, ethers.parseEther("10000"));

    // Mint CAS directly to PaymentFacet for distribute tests
    await casToken.mint(await paymentFacet.getAddress(), ethers.parseEther("1000"));

    return {
      owner,
      user1,
      recipient1,
      recipient2,
      recipient3,
      casToken,
      paymentFacet,
    };
  }

  describe("batchTransfer", () => {
    it("should transfer CAS to multiple recipients", async () => {
      const { user1, recipient1, recipient2, recipient3, casToken, paymentFacet } =
        await loadFixture(deployFixture);

      const recipients = [recipient1.address, recipient2.address, recipient3.address];
      const amounts = [
        ethers.parseEther("10"),
        ethers.parseEther("20"),
        ethers.parseEther("30"),
      ];
      const totalNeeded = ethers.parseEther("60");

      await casToken.connect(user1).approve(await paymentFacet.getAddress(), totalNeeded);

      const tx = await paymentFacet
        .connect(user1)
        .batchTransfer(recipients, amounts);
      await tx.wait();

      expect(await casToken.balanceOf(recipient1.address)).to.equal(ethers.parseEther("10"));
      expect(await casToken.balanceOf(recipient2.address)).to.equal(ethers.parseEther("20"));
      expect(await casToken.balanceOf(recipient3.address)).to.equal(ethers.parseEther("30"));
    });

    it("should emit BatchTransferExecuted event", async () => {
      const { user1, recipient1, recipient2, casToken, paymentFacet } =
        await loadFixture(deployFixture);

      const recipients = [recipient1.address, recipient2.address];
      const amounts = [ethers.parseEther("5"), ethers.parseEther("15")];
      const totalNeeded = ethers.parseEther("20");

      await casToken.connect(user1).approve(await paymentFacet.getAddress(), totalNeeded);

      await expect(paymentFacet.connect(user1).batchTransfer(recipients, amounts))
        .to.emit(paymentFacet, "BatchTransferExecuted")
        .withArgs(user1.address, totalNeeded, 2);
    });

    it("should revert on length mismatch", async () => {
      const { user1, recipient1, recipient2, casToken, paymentFacet } =
        await loadFixture(deployFixture);

      await casToken.connect(user1).approve(await paymentFacet.getAddress(), ethers.parseEther("100"));

      await expect(
        paymentFacet
          .connect(user1)
          .batchTransfer([recipient1.address, recipient2.address], [ethers.parseEther("10")])
      ).to.be.revertedWithCustomError(paymentFacet, "LengthMismatch");
    });

    it("should revert when exceeding MAX_BATCH_RECIPIENTS", async () => {
      const { user1, casToken, paymentFacet } = await loadFixture(deployFixture);

      const recipients = Array(201).fill(ethers.ZeroAddress);
      const amounts = Array(201).fill(ethers.parseEther("1"));

      await expect(
        paymentFacet.connect(user1).batchTransfer(recipients, amounts)
      ).to.be.revertedWithCustomError(paymentFacet, "MaxRecipientsExceeded");
    });

    it("should skip zero address recipients", async () => {
      const { user1, recipient1, casToken, paymentFacet } =
        await loadFixture(deployFixture);

      const recipients = [recipient1.address, ethers.ZeroAddress];
      const amounts = [ethers.parseEther("10"), ethers.parseEther("5")];
      const totalNeeded = ethers.parseEther("15");

      await casToken.connect(user1).approve(await paymentFacet.getAddress(), totalNeeded);

      const tx = await paymentFacet.connect(user1).batchTransfer(recipients, amounts);
      await tx.wait();

      expect(await casToken.balanceOf(recipient1.address)).to.equal(ethers.parseEther("10"));
    });

    it("should skip zero amount recipients", async () => {
      const { user1, recipient1, recipient2, casToken, paymentFacet } =
        await loadFixture(deployFixture);

      const recipients = [recipient1.address, recipient2.address];
      const amounts = [ethers.parseEther("10"), 0];
      const totalNeeded = ethers.parseEther("10");

      await casToken.connect(user1).approve(await paymentFacet.getAddress(), totalNeeded);

      const tx = await paymentFacet.connect(user1).batchTransfer(recipients, amounts);
      await tx.wait();

      expect(await casToken.balanceOf(recipient1.address)).to.equal(ethers.parseEther("10"));
      expect(await casToken.balanceOf(recipient2.address)).to.equal(0);
    });

    it("should revert when CAS token not set", async () => {
      const { user1, recipient1, paymentFacet } = await loadFixture(deployFixture);

      // Deploy a fresh PaymentFacet without setting CAS token
      const PaymentFacet = await ethers.getContractFactory("PaymentFacet");
      const freshFacet = await PaymentFacet.deploy() as any;
      await freshFacet.waitForDeployment();

      // Set contract owner in LibDiamond storage for the fresh facet
      const baseSlot = ethers.keccak256(ethers.toUtf8Bytes("agentic.space.diamond.storage"));
      const ownerSlot = ethers.toQuantity(BigInt(baseSlot) + 4n);
      const [owner] = await ethers.getSigners();
      await ethers.provider.send("hardhat_setStorageAt", [
        await freshFacet.getAddress(),
        ownerSlot,
        ethers.zeroPadValue(owner.address, 32),
      ]);
      await freshFacet.initPayment();

      await expect(
        freshFacet.connect(user1).batchTransfer([recipient1.address], [ethers.parseEther("10")])
      ).to.be.revertedWithCustomError(freshFacet, "CasTokenNotSet");
    });
  });

  describe("distribute", () => {
    it("should distribute CAS from facet balance", async () => {
      const { owner, recipient1, recipient2, casToken, paymentFacet } =
        await loadFixture(deployFixture);

      const recipients = [recipient1.address, recipient2.address];
      const amounts = [ethers.parseEther("30"), ethers.parseEther("40")];

      const tx = await paymentFacet.connect(owner).distribute(recipients, amounts);
      await tx.wait();

      expect(await casToken.balanceOf(recipient1.address)).to.equal(ethers.parseEther("30"));
      expect(await casToken.balanceOf(recipient2.address)).to.equal(ethers.parseEther("40"));
    });

    it("should emit BatchDistributed event", async () => {
      const { owner, recipient1, recipient2, paymentFacet } =
        await loadFixture(deployFixture);

      const recipients = [recipient1.address, recipient2.address];
      const amounts = [ethers.parseEther("10"), ethers.parseEther("20")];
      const totalNeeded = ethers.parseEther("30");

      await expect(paymentFacet.connect(owner).distribute(recipients, amounts))
        .to.emit(paymentFacet, "BatchDistributed")
        .withArgs(owner.address, totalNeeded, 2);
    });

    it("should revert on insufficient balance", async () => {
      const { owner, recipient1, casToken, paymentFacet } =
        await loadFixture(deployFixture);

      // Try to distribute more than the 1000 CAS minted to the facet
      await expect(
        paymentFacet
          .connect(owner)
          .distribute([recipient1.address], [ethers.parseEther("5000")])
      ).to.be.revertedWithCustomError(paymentFacet, "InsufficientCasBalance");
    });

    it("should revert when non-owner calls distribute", async () => {
      const { user1, recipient1, paymentFacet } = await loadFixture(deployFixture);

      // In standalone test, owner is deployer. user1 is not owner.
      // PaymentFacet uses DiamondAccessControl.enforceIsContractOwner()
      // which checks LibDiamond.contractOwner() — in standalone test this is address(0)
      // so any caller will fail with NotContractOwner
      await expect(
        paymentFacet
          .connect(user1)
          .distribute([recipient1.address], [ethers.parseEther("10")])
      ).to.be.reverted;
    });
  });
});
