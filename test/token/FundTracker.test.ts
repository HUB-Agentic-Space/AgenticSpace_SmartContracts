import { expect } from "chai";
import { ethers } from "hardhat";

describe("FundTrackerToken", () => {
  let deployer: any;
  let user1: any;
  let user2: any;
  let casToken: any;
  let infraFund: any;
  let casTracker: any;
  let polTracker: any;

  const INITIAL_SUPPLY = ethers.parseEther("1000000");

  beforeEach(async () => {
    [deployer, user1, user2] = await ethers.getSigners();

    // Deploy CASToken (UUPS)
    const CASToken = await ethers.getContractFactory("CASToken");
    casToken = await CASToken.deploy();
    await casToken.waitForDeployment();
    await (await casToken.initialize(
      deployer.address,
      INITIAL_SUPPLY,
      "Criptocoin Agentic Space",
      "CAS"
    )).wait();

    // Deploy InfrastructureFund (UUPS)
    const InfraFund = await ethers.getContractFactory("InfrastructureFund");
    infraFund = await InfraFund.deploy();
    await infraFund.waitForDeployment();
    await (await infraFund.initialize(
      deployer.address,
      await casToken.getAddress(),
      user1.address, // rapport
      user2.address  // author
    )).wait();

    // Deploy FundTrackerToken — CAS tracker
    const FundTracker = await ethers.getContractFactory("FundTrackerToken");
    casTracker = await FundTracker.deploy(
      await infraFund.getAddress(),
      0, // CAS_TRACKER
      "Agentic CAS Fund",
      "aCAS",
      deployer.address
    );
    await casTracker.waitForDeployment();

    // Deploy FundTrackerToken — POL tracker
    polTracker = await FundTracker.deploy(
      await infraFund.getAddress(),
      1, // POL_TRACKER
      "Agentic POL Fund",
      "aPOL",
      deployer.address
    );
    await polTracker.waitForDeployment();
  });

  describe("Deployment", () => {
    it("should set correct name and symbol for CAS tracker", async () => {
      expect(await casTracker.name()).to.equal("Agentic CAS Fund");
      expect(await casTracker.symbol()).to.equal("aCAS");
    });

    it("should set correct name and symbol for POL tracker", async () => {
      expect(await polTracker.name()).to.equal("Agentic POL Fund");
      expect(await polTracker.symbol()).to.equal("aPOL");
    });

    it("should set correct assetType", async () => {
      expect(await casTracker.assetType()).to.equal(0);
      expect(await polTracker.assetType()).to.equal(1);
    });

    it("should set fund address", async () => {
      expect(await casTracker.fund()).to.equal(await infraFund.getAddress());
      expect(await polTracker.fund()).to.equal(await infraFund.getAddress());
    });

    it("should revert with zero fund address", async () => {
      const FundTracker = await ethers.getContractFactory("FundTrackerToken");
      await expect(
        FundTracker.deploy(ethers.ZeroAddress, 0, "Test", "TST", deployer.address)
      ).to.be.revertedWithCustomError(FundTracker, "InvalidFundAddress");
    });

    it("should revert with invalid assetType", async () => {
      const FundTracker = await ethers.getContractFactory("FundTrackerToken");
      await expect(
        FundTracker.deploy(await infraFund.getAddress(), 2, "Test", "TST", deployer.address)
      ).to.be.revertedWithCustomError(FundTracker, "InvalidAssetType");
    });
  });

  describe("CAS Tracker", () => {
    it("should return 0 totalSupply when fund has no CAS", async () => {
      expect(await casTracker.totalSupply()).to.equal(0);
    });

    it("should mirror CAS balance after deposit", async () => {
      const depositAmount = ethers.parseEther("100");
      await casToken.approve(await infraFund.getAddress(), depositAmount);
      await infraFund.depositCas(depositAmount);

      expect(await casTracker.totalSupply()).to.equal(depositAmount);
    });

    it("should show balance to admin only", async () => {
      const depositAmount = ethers.parseEther("100");
      await casToken.approve(await infraFund.getAddress(), depositAmount);
      await infraFund.depositCas(depositAmount);

      expect(await casTracker.balanceOf(deployer.address)).to.equal(depositAmount);
      expect(await casTracker.balanceOf(user1.address)).to.equal(0);
    });

    it("should update after CAS withdrawal", async () => {
      const depositAmount = ethers.parseEther("100");
      await casToken.approve(await infraFund.getAddress(), depositAmount);
      await infraFund.depositCas(depositAmount);

      const withdrawAmount = ethers.parseEther("40");
      await infraFund.transferCasToRapport(withdrawAmount);

      expect(await casTracker.totalSupply()).to.equal(depositAmount - withdrawAmount);
    });
  });

  describe("POL Tracker", () => {
    it("should return 0 totalSupply when fund has no POL", async () => {
      expect(await polTracker.totalSupply()).to.equal(0);
    });

    it("should mirror POL balance after deposit", async () => {
      const depositAmount = ethers.parseEther("5");
      await infraFund.depositNative({ value: depositAmount });

      expect(await polTracker.totalSupply()).to.equal(depositAmount);
    });

    it("should show balance to admin only", async () => {
      const depositAmount = ethers.parseEther("5");
      await infraFund.depositNative({ value: depositAmount });

      expect(await polTracker.balanceOf(deployer.address)).to.equal(depositAmount);
      expect(await polTracker.balanceOf(user1.address)).to.equal(0);
    });

    it("should update after POL withdrawal", async () => {
      const depositAmount = ethers.parseEther("5");
      await infraFund.depositNative({ value: depositAmount });

      const withdrawAmount = ethers.parseEther("2");
      await infraFund.transferNativeToRapport(withdrawAmount);

      expect(await polTracker.totalSupply()).to.equal(depositAmount - withdrawAmount);
    });
  });

  describe("Non-transferable", () => {
    it("should revert on transfer", async () => {
      await expect(
        casTracker.transfer(user1.address, 100)
      ).to.be.revertedWith("FundTracker: non-transferable");
    });

    it("should revert on approve", async () => {
      await expect(
        casTracker.approve(user1.address, 100)
      ).to.be.revertedWith("FundTracker: non-transferable");
    });

    it("should revert on transferFrom", async () => {
      await expect(
        casTracker.transferFrom(deployer.address, user1.address, 100)
      ).to.be.revertedWith("FundTracker: non-transferable");
    });
  });

  describe("Ownership", () => {
    it("should transfer ownership and update balance visibility", async () => {
      const depositAmount = ethers.parseEther("50");
      await casToken.approve(await infraFund.getAddress(), depositAmount);
      await infraFund.depositCas(depositAmount);

      // deployer sees balance
      expect(await casTracker.balanceOf(deployer.address)).to.equal(depositAmount);

      // transfer tracker ownership to user1
      await casTracker.transferOwnership(user1.address);

      // now user1 sees balance, deployer sees 0
      expect(await casTracker.balanceOf(user1.address)).to.equal(depositAmount);
      expect(await casTracker.balanceOf(deployer.address)).to.equal(0);
    });

    it("should revert transferring ownership to zero address", async () => {
      await expect(
        casTracker.transferOwnership(ethers.ZeroAddress)
      ).to.be.reverted;
    });

    it("should revert non-owner transferring ownership", async () => {
      await expect(
        casTracker.connect(user1).transferOwnership(user2.address)
      ).to.be.reverted;
    });
  });
});
