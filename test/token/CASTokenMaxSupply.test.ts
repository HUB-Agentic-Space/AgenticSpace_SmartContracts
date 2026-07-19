import { expect } from "chai";
import { ethers } from "hardhat";

/**
 * Unit tests for CASToken MAX_SUPPLY cap, disclaimer, and RATIO_ADMIN_ROLE.
 */
describe("CASToken — MAX_SUPPLY & Disclaimer", () => {
  let casToken: any;
  let deployer: any;
  let user1: any;
  const MAX_SUPPLY = ethers.parseEther("10000000");
  const initialSupply = ethers.parseEther("1000000");

  beforeEach(async () => {
    [deployer, user1] = await ethers.getSigners();

    const CASToken = await ethers.getContractFactory("CASToken");
    casToken = await CASToken.deploy();
    await casToken.waitForDeployment();
    await (await casToken["initialize(address,uint256,string,string)"](
      deployer.address,
      initialSupply,
      "Criptocoin Agentic Space",
      "CAS"
    )).wait();
  });

  describe("MAX_SUPPLY", () => {
    it("should have MAX_SUPPLY of 10,000,000 CAS", async () => {
      expect(await casToken.maxSupply()).to.equal(MAX_SUPPLY);
    });

    it("should expose MAX_SUPPLY as public constant", async () => {
      expect(await casToken.MAX_SUPPLY()).to.equal(MAX_SUPPLY);
    });

    it("should mint up to MAX_SUPPLY", async () => {
      const remaining = MAX_SUPPLY - initialSupply;
      await casToken.mint(deployer.address, remaining);
      expect(await casToken.totalSupply()).to.equal(MAX_SUPPLY);
    });

    it("should revert when minting beyond MAX_SUPPLY", async () => {
      const remaining = MAX_SUPPLY - initialSupply;
      await casToken.mint(deployer.address, remaining);

      await expect(casToken.mint(deployer.address, 1))
        .to.be.revertedWithCustomError(casToken, "MaxSupplyExceeded");
    });

    it("should revert when initial supply exceeds MAX_SUPPLY", async () => {
      const CASToken = await ethers.getContractFactory("CASToken");
      const newToken = await CASToken.deploy();
      await newToken.waitForDeployment();

      await expect(
        newToken["initialize(address,uint256,string,string)"](
          deployer.address,
          MAX_SUPPLY + 1n,
          "Test",
          "TST"
        )
      ).to.be.revertedWithCustomError(newToken, "MaxSupplyExceeded");
    });

    it("should emit MaxSupplyAnnounced on initialize", async () => {
      const CASToken = await ethers.getContractFactory("CASToken");
      const newToken = await CASToken.deploy();
      await newToken.waitForDeployment();

      await expect(
        newToken["initialize(address,uint256,string,string)"](
          deployer.address,
          initialSupply,
          "Test",
          "TST"
        )
      ).to.emit(newToken, "MaxSupplyAnnounced")
        .withArgs(MAX_SUPPLY);
    });
  });

  describe("Disclaimer", () => {
    it("should return non-empty disclaimer", async () => {
      const text = await casToken.disclaimer();
      expect(text.length).to.be.gt(0);
    });

    it("should mention infrastructure", async () => {
      const text = await casToken.disclaimer();
      expect(text.toLowerCase()).to.include("infrastructure");
    });

    it("should mention Agentic Space", async () => {
      const text = await casToken.disclaimer();
      expect(text).to.include("Agentic Space");
    });

    it("should mention ratio 1:1", async () => {
      const text = await casToken.disclaimer();
      expect(text).to.include("1:1");
    });
  });

  describe("RATIO_ADMIN_ROLE", () => {
    it("should grant RATIO_ADMIN_ROLE to admin on initialize", async () => {
      expect(await casToken.isRatioAdmin(deployer.address)).to.be.true;
    });

    it("should not have RATIO_ADMIN_ROLE for non-admin", async () => {
      expect(await casToken.isRatioAdmin(user1.address)).to.be.false;
    });

    it("should allow admin to grant RATIO_ADMIN_ROLE to others", async () => {
      const RATIO_ADMIN_ROLE = await casToken.RATIO_ADMIN_ROLE();
      await casToken.grantRole(RATIO_ADMIN_ROLE, user1.address);
      expect(await casToken.isRatioAdmin(user1.address)).to.be.true;
    });
  });

  describe("Burn", () => {
    it("should burn tokens and reduce totalSupply", async () => {
      const burnAmount = ethers.parseEther("100");
      const supplyBefore = await casToken.totalSupply();

      await casToken.burn(burnAmount);

      expect(await casToken.totalSupply()).to.equal(supplyBefore - burnAmount);
    });

    it("should allow minting after burn (supply goes below MAX)", async () => {
      const burnAmount = ethers.parseEther("100");
      await casToken.burn(burnAmount);

      // Should be able to mint back
      await casToken.mint(deployer.address, burnAmount);
      expect(await casToken.totalSupply()).to.equal(initialSupply);
    });
  });
});
