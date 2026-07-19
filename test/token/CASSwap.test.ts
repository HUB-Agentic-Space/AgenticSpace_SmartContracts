import { expect } from "chai";
import { ethers } from "hardhat";

/**
 * Unit tests for CASSwap contract.
 * Tests buy, sell, flexible ratio adjustment, fees, access control, pausable, edge cases.
 */
describe("CASSwap", () => {
  let casToken: any;
  let casSwap: any;
  let deployer: any;
  let user1: any;
  let user2: any;
  const initialSupply = ethers.parseEther("1000000");
  const reserveAmount = ethers.parseEther("1000");

  async function getDeadline(seconds = 3600): Promise<bigint> {
    const block = await ethers.provider.getBlock("latest");
    return BigInt(block!.timestamp + seconds);
  }

  beforeEach(async () => {
    [deployer, user1, user2] = await ethers.getSigners();

    // Deploy CASToken
    const CASToken = await ethers.getContractFactory("CASToken");
    casToken = await CASToken.deploy();
    await casToken.waitForDeployment();
    await (await casToken["initialize(address,uint256,string,string)"](
      deployer.address,
      initialSupply,
      "Cryptocoin Agentic Space",
      "CAS"
    )).wait();

    // Deploy InfrastructureFund (use deployer as placeholder)
    const InfrastructureFund = await ethers.getContractFactory("InfrastructureFund");
    const infraFund = await InfrastructureFund.deploy();
    await infraFund.waitForDeployment();
    await (await infraFund["initialize(address,address,address,address)"](
      deployer.address,
      await casToken.getAddress(),
      deployer.address,
      deployer.address
    )).wait();
    const infraFundAddr = await infraFund.getAddress();

    // Deploy CASSwap
    const CASSwap = await ethers.getContractFactory("CASSwap");
    casSwap = await CASSwap.deploy();
    await casSwap.waitForDeployment();
    await (await casSwap["initialize(address,address,address)"](
      deployer.address,
      await casToken.getAddress(),
      infraFundAddr
    )).wait();

    // Deposit CAS reserve
    await (await casToken.approve(await casSwap.getAddress(), reserveAmount)).wait();
    await (await casSwap.depositCAS(reserveAmount)).wait();

    // Send some POL to swap for sell liquidity
    await deployer.sendTransaction({
      to: await casSwap.getAddress(),
      value: ethers.parseEther("10"),
    });
  });

  describe("Initialization", () => {
    it("should initialize with ratio 1:1", async () => {
      const [num, den] = await casSwap.getRatio();
      expect(num).to.equal(1n);
      expect(den).to.equal(1n);
    });

    it("should initialize with 0 fee", async () => {
      expect(await casSwap.getSwapFee()).to.equal(0n);
    });

    it("should have CAS reserve", async () => {
      expect(await casSwap.getCASBalance()).to.equal(reserveAmount);
    });

    it("should have POL balance", async () => {
      expect(await casSwap.getPOLBalance()).to.equal(ethers.parseEther("10"));
    });

    it("should not be paused", async () => {
      expect(await casSwap.isPaused()).to.be.false;
    });
  });

  describe("buyCAS", () => {
    it("should buy CAS with POL at 1:1 ratio", async () => {
      const buyAmount = ethers.parseEther("1");
      const balBefore = await casToken.balanceOf(user1.address);

      const deadline = await getDeadline();
      await casSwap.connect(user1).buyCAS(0n, deadline, { value: buyAmount });

      const balAfter = await casToken.balanceOf(user1.address);
      expect(balAfter - balBefore).to.equal(buyAmount);
    });

    it("should revert with zero POL", async () => {
      const deadline = await getDeadline();
      await expect(casSwap.connect(user1).buyCAS(0n, deadline, { value: 0 }))
        .to.be.revertedWithCustomError(casSwap, "ZeroAmount");
    });

    it("should revert when paused", async () => {
      await casSwap.pause();
      const deadline = await getDeadline();
      await expect(casSwap.connect(user1).buyCAS(0n, deadline, { value: ethers.parseEther("1") }))
        .to.be.revertedWithCustomError(casSwap, "EnforcedPause");
    });

    it("should revert with insufficient CAS reserve", async () => {
      // Reserve is 1,000 CAS at 1:1, so send 1,001 POL
      const hugeAmount = ethers.parseEther("1001");
      const dl = await getDeadline();
      await expect(casSwap.buyCAS(0n, dl, { value: hugeAmount }))
        .to.be.revertedWithCustomError(casSwap, "InsufficientCASBalance");
    });
  });

  describe("sellCAS", () => {
    it("should sell CAS for POL at 1:1 ratio", async () => {
      // First buy some CAS
      const dl1 = await getDeadline();
      await casSwap.connect(user1).buyCAS(0n, dl1, { value: ethers.parseEther("1") });
      const casBal = await casToken.balanceOf(user1.address);

      // Approve and sell
      await casToken.connect(user1).approve(await casSwap.getAddress(), casBal);
      const polBefore = await ethers.provider.getBalance(user1.address);

      const dl2 = await getDeadline();
      const tx = await casSwap.connect(user1).sellCAS(casBal, 0n, dl2);
      const receipt = await tx.wait();
      const gasCost = receipt.gasUsed * receipt.gasPrice;

      const polAfter = await ethers.provider.getBalance(user1.address);
      const polReceived = polAfter - polBefore + gasCost;
      expect(polReceived).to.equal(casBal);
    });

    it("should revert with zero amount", async () => {
      const dl = await getDeadline();
      await expect(casSwap.connect(user1).sellCAS(0, 0n, dl))
        .to.be.revertedWithCustomError(casSwap, "ZeroAmount");
    });

    it("should revert when paused", async () => {
      await casSwap.pause();
      const dl = await getDeadline();
      await expect(casSwap.connect(user1).sellCAS(ethers.parseEther("1"), 0n, dl))
        .to.be.revertedWithCustomError(casSwap, "EnforcedPause");
    });
  });

  describe("setRatio (flexible)", () => {
    it("should change ratio to 1:2", async () => {
      await casSwap.setRatio(1, 2);
      const [num, den] = await casSwap.getRatio();
      expect(num).to.equal(1n);
      expect(den).to.equal(2n);
    });

    it("should change ratio to 2:1", async () => {
      await casSwap.setRatio(2, 1);
      const [num, den] = await casSwap.getRatio();
      expect(num).to.equal(2n);
      expect(den).to.equal(1n);
    });

    it("should change ratio to 1:10", async () => {
      await casSwap.setRatio(1, 10);
      const [num, den] = await casSwap.getRatio();
      expect(num).to.equal(1n);
      expect(den).to.equal(10n);
    });

    it("should change ratio to 5:3", async () => {
      await casSwap.setRatio(5, 3);
      const [num, den] = await casSwap.getRatio();
      expect(num).to.equal(5n);
      expect(den).to.equal(3n);
    });

    it("should revert with zero numerator", async () => {
      await expect(casSwap.setRatio(0, 1))
        .to.be.revertedWithCustomError(casSwap, "InvalidRatio");
    });

    it("should revert with zero denominator", async () => {
      await expect(casSwap.setRatio(1, 0))
        .to.be.revertedWithCustomError(casSwap, "InvalidRatio");
    });

    it("should revert for non-RATIO_ADMIN_ROLE", async () => {
      await expect(casSwap.connect(user1).setRatio(1, 2))
        .to.be.reverted;
    });

    it("should affect buy calculation at new ratio", async () => {
      // Set ratio to 1:2 (1 POL = 0.5 CAS)
      await casSwap.setRatio(1, 2);
      const buyAmount = ethers.parseEther("1");
      const balBefore = await casToken.balanceOf(user1.address);

      const dl = await getDeadline();
      await casSwap.connect(user1).buyCAS(0n, dl, { value: buyAmount });

      const balAfter = await casToken.balanceOf(user1.address);
      expect(balAfter - balBefore).to.equal(ethers.parseEther("0.5"));
    });
  });

  describe("setSwapFee", () => {
    it("should set fee by admin", async () => {
      await casSwap.setSwapFee(100); // 1%
      expect(await casSwap.getSwapFee()).to.equal(100n);
    });

    it("should revert with fee > MAX_SWAP_FEE_BPS (1000)", async () => {
      await expect(casSwap.setSwapFee(1001))
        .to.be.revertedWithCustomError(casSwap, "InvalidFee");
    });

    it("should revert for non-admin", async () => {
      await expect(casSwap.connect(user1).setSwapFee(100))
        .to.be.reverted;
    });

    it("should deduct fee on buy", async () => {
      await casSwap.setSwapFee(500); // 5% (within new 10% cap)
      const buyAmount = ethers.parseEther("1");
      const balBefore = await casToken.balanceOf(user1.address);

      const dl = await getDeadline();
      await casSwap.connect(user1).buyCAS(0n, dl, { value: buyAmount });

      const balAfter = await casToken.balanceOf(user1.address);
      // 1 POL - 5% fee = 0.95 POL → 0.95 CAS at 1:1
      expect(balAfter - balBefore).to.equal(ethers.parseEther("0.95"));
    });
  });

  describe("depositCAS", () => {
    it("should deposit CAS into swap", async () => {
      const depositAmount = ethers.parseEther("1000");
      await casToken.approve(await casSwap.getAddress(), depositAmount);

      const balBefore = await casSwap.getCASBalance();
      await casSwap.depositCAS(depositAmount);
      const balAfter = await casSwap.getCASBalance();

      expect(balAfter - balBefore).to.equal(depositAmount);
    });

    it("should revert with zero amount", async () => {
      await expect(casSwap.depositCAS(0))
        .to.be.revertedWithCustomError(casSwap, "ZeroAmount");
    });
  });

  describe("withdrawPOL", () => {
    it("should withdraw POL to infrastructure fund by treasurer", async () => {
      const withdrawAmount = ethers.parseEther("1");
      const swapAddr = await casSwap.getAddress();

      const swapPolBefore = await casSwap.getPOLBalance();
      await casSwap.withdrawPOL(withdrawAmount);
      const swapPolAfter = await casSwap.getPOLBalance();

      expect(swapPolBefore - swapPolAfter).to.equal(withdrawAmount);
    });

    it("should revert for non-treasurer", async () => {
      await expect(casSwap.connect(user1).withdrawPOL(ethers.parseEther("1")))
        .to.be.reverted;
    });

    it("should revert with zero amount", async () => {
      await expect(casSwap.withdrawPOL(0))
        .to.be.revertedWithCustomError(casSwap, "ZeroAmount");
    });
  });

  describe("withdrawCAS", () => {
    it("should withdraw CAS to arbitrary address by admin", async () => {
      const withdrawAmount = ethers.parseEther("100");
      const swapAddr = await casSwap.getAddress();
      const recipient = user1.address;

      const swapCasBefore = await casSwap.getCASBalance();
      const recipientBefore = await casToken.balanceOf(recipient);

      await casSwap.withdrawCAS(recipient, withdrawAmount);

      const swapCasAfter = await casSwap.getCASBalance();
      const recipientAfter = await casToken.balanceOf(recipient);

      expect(swapCasBefore - swapCasAfter).to.equal(withdrawAmount);
      expect(recipientAfter - recipientBefore).to.equal(withdrawAmount);
    });

    it("should revert for non-admin", async () => {
      await expect(casSwap.connect(user1).withdrawCAS(user1.address, ethers.parseEther("1")))
        .to.be.reverted;
    });

    it("should revert with zero address", async () => {
      await expect(casSwap.withdrawCAS(ethers.ZeroAddress, ethers.parseEther("1")))
        .to.be.revertedWithCustomError(casSwap, "ZeroAddress");
    });

    it("should revert with zero amount", async () => {
      await expect(casSwap.withdrawCAS(user1.address, 0))
        .to.be.revertedWithCustomError(casSwap, "ZeroAmount");
    });

    it("should revert when insufficient CAS balance", async () => {
      const casBal = await casSwap.getCASBalance();
      const tooMuch = casBal + 1n;
      await expect(casSwap.withdrawCAS(user1.address, tooMuch))
        .to.be.revertedWithCustomError(casSwap, "InsufficientCASBalance");
    });

    it("should revert when paused", async () => {
      await casSwap.pause();
      await expect(casSwap.withdrawCAS(user1.address, ethers.parseEther("1")))
        .to.be.revertedWithCustomError(casSwap, "EnforcedPause");
    });
  });

  describe("Pausable", () => {
    it("should pause by PAUSER_ROLE", async () => {
      await casSwap.pause();
      expect(await casSwap.isPaused()).to.be.true;
    });

    it("should unpause by PAUSER_ROLE", async () => {
      await casSwap.pause();
      await casSwap.unpause();
      expect(await casSwap.isPaused()).to.be.false;
    });

    it("should revert pause by non-PAUSER_ROLE", async () => {
      await expect(casSwap.connect(user1).pause()).to.be.reverted;
    });
  });

  describe("Edge cases", () => {
    it("should handle very small buy amounts", async () => {
      const tinyAmount = 1n; // 1 wei
      const dl = await getDeadline();
      await casSwap.connect(user1).buyCAS(0n, dl, { value: tinyAmount });
      const bal = await casToken.balanceOf(user1.address);
      expect(bal).to.equal(1n);
    });

    it("should handle ratio with large numbers", async () => {
      await casSwap.setRatio(999999, 1);
      const [num, den] = await casSwap.getRatio();
      expect(num).to.equal(999999n);
      expect(den).to.equal(1n);
    });
  });
});
