import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("CASMigration", () => {
  async function deployFixture() {
    const [owner, user1, user2] = await ethers.getSigners();

    // Deploy old CAS (simple ERC20 mock)
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const oldCAS = await MockERC20.deploy("Old CAS", "oCAS", 18);
    await oldCAS.waitForDeployment();

    // Deploy new CAS (real CASToken with MAX_SUPPLY)
    const CASToken = await ethers.getContractFactory("CASToken");
    const newCAS = await CASToken.deploy();
    await newCAS.waitForDeployment();
    await newCAS.initialize(owner.address, ethers.parseEther("1000000"), "Cryptocoin Agentic Space", "CAS");

    // Deploy CASMigration
    const CASMigration = await ethers.getContractFactory("CASMigration");
    const migration = await CASMigration.deploy(await oldCAS.getAddress(), await newCAS.getAddress());
    await migration.waitForDeployment();

    // Mint new CAS to migration contract
    await newCAS.mint(await migration.getAddress(), ethers.parseEther("1000000"));

    // Mint old CAS to users
    await oldCAS.mint(user1.address, ethers.parseEther("1000"));
    await oldCAS.mint(user2.address, ethers.parseEther("500"));

    return { owner, user1, user2, oldCAS, newCAS, migration };
  }

  describe("Initialization", () => {
    it("should set old and new CAS addresses", async () => {
      const { oldCAS, newCAS, migration } = await loadFixture(deployFixture);
      expect(await migration.oldCAS()).to.equal(await oldCAS.getAddress());
      expect(await migration.newCAS()).to.equal(await newCAS.getAddress());
    });

    it("should start with migration active", async () => {
      const { migration } = await loadFixture(deployFixture);
      expect(await migration.migrationActive()).to.be.true;
    });

    it("should revert with zero address", async () => {
      const CASMigration = await ethers.getContractFactory("CASMigration");
      await expect(
        CASMigration.deploy(ethers.ZeroAddress, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(CASMigration, "ZeroAddress");
    });
  });

  describe("migrate", () => {
    it("should migrate old CAS to new CAS 1:1", async () => {
      const { user1, oldCAS, newCAS, migration } = await loadFixture(deployFixture);
      const amount = ethers.parseEther("100");

      // User approves old CAS
      await oldCAS.connect(user1).approve(await migration.getAddress(), amount);

      // Migrate
      await expect(migration.connect(user1).migrate(amount))
        .to.emit(migration, "Migrated")
        .withArgs(user1.address, amount);

      // Check balances
      expect(await newCAS.balanceOf(user1.address)).to.equal(amount);
      expect(await oldCAS.balanceOf(user1.address)).to.equal(ethers.parseEther("900"));
    });

    it("should update totalMigrated", async () => {
      const { user1, oldCAS, migration } = await loadFixture(deployFixture);
      const amount = ethers.parseEther("100");
      await oldCAS.connect(user1).approve(await migration.getAddress(), amount);
      await migration.connect(user1).migrate(amount);
      expect(await migration.totalMigrated()).to.equal(amount);
    });

    it("should revert with zero amount", async () => {
      const { user1, migration } = await loadFixture(deployFixture);
      await expect(migration.connect(user1).migrate(0))
        .to.be.revertedWithCustomError(migration, "ZeroAmount");
    });

    it("should revert when migration is not active", async () => {
      const { owner, user1, oldCAS, migration } = await loadFixture(deployFixture);
      await migration.connect(owner).setMigrationActive(false);
      await oldCAS.connect(user1).approve(await migration.getAddress(), ethers.parseEther("100"));
      await expect(migration.connect(user1).migrate(ethers.parseEther("100")))
        .to.be.revertedWithCustomError(migration, "MigrationNotActive");
    });

    it("should revert without approval", async () => {
      const { user1, migration } = await loadFixture(deployFixture);
      await expect(migration.connect(user1).migrate(ethers.parseEther("100")))
        .to.be.reverted;
    });

    it("should allow multiple migrations by same user", async () => {
      const { user1, oldCAS, newCAS, migration } = await loadFixture(deployFixture);
      const amt1 = ethers.parseEther("100");
      const amt2 = ethers.parseEther("50");

      await oldCAS.connect(user1).approve(await migration.getAddress(), amt1 + amt2);
      await migration.connect(user1).migrate(amt1);
      await migration.connect(user1).migrate(amt2);

      expect(await newCAS.balanceOf(user1.address)).to.equal(amt1 + amt2);
      expect(await migration.totalMigrated()).to.equal(amt1 + amt2);
    });
  });

  describe("batchMigrate", () => {
    it("should migrate for multiple users", async () => {
      const { owner, user1, user2, oldCAS, newCAS, migration } = await loadFixture(deployFixture);
      const amt1 = ethers.parseEther("100");
      const amt2 = ethers.parseEther("50");

      await oldCAS.connect(user1).approve(await migration.getAddress(), amt1);
      await oldCAS.connect(user2).approve(await migration.getAddress(), amt2);

      await migration.connect(owner).batchMigrate(
        [user1.address, user2.address],
        [amt1, amt2]
      );

      expect(await newCAS.balanceOf(user1.address)).to.equal(amt1);
      expect(await newCAS.balanceOf(user2.address)).to.equal(amt2);
      expect(await migration.totalMigrated()).to.equal(amt1 + amt2);
    });

    it("should revert for non-owner", async () => {
      const { user1, migration } = await loadFixture(deployFixture);
      await expect(
        migration.connect(user1).batchMigrate([user1.address], [ethers.parseEther("100")])
      ).to.be.revertedWithCustomError(migration, "OwnableUnauthorizedAccount");
    });

    it("should revert with length mismatch", async () => {
      const { owner, migration } = await loadFixture(deployFixture);
      await expect(
        migration.connect(owner).batchMigrate([owner.address], [])
      ).to.be.reverted;
    });
  });

  describe("setMigrationActive", () => {
    it("should toggle migration active state", async () => {
      const { owner, migration } = await loadFixture(deployFixture);
      await migration.connect(owner).setMigrationActive(false);
      expect(await migration.migrationActive()).to.be.false;
      await migration.connect(owner).setMigrationActive(true);
      expect(await migration.migrationActive()).to.be.true;
    });

    it("should revert for non-owner", async () => {
      const { user1, migration } = await loadFixture(deployFixture);
      await expect(migration.connect(user1).setMigrationActive(false))
        .to.be.revertedWithCustomError(migration, "OwnableUnauthorizedAccount");
    });
  });

  describe("rescueTokens", () => {
    it("should rescue new CAS tokens after migration closed", async () => {
      const { owner, newCAS, migration } = await loadFixture(deployFixture);
      const rescueAmount = ethers.parseEther("500000");

      // Migration must be deactivated before rescue
      await migration.connect(owner).setMigrationActive(false);

      await migration.connect(owner).rescueTokens(
        await newCAS.getAddress(),
        owner.address,
        rescueAmount
      );

      expect(await newCAS.balanceOf(owner.address)).to.be.greaterThan(ethers.parseEther("1000000"));
    });

    it("should revert for non-owner", async () => {
      const { user1, newCAS, migration, owner } = await loadFixture(deployFixture);
      await migration.connect(owner).setMigrationActive(false);
      await expect(
        migration.connect(user1).rescueTokens(await newCAS.getAddress(), user1.address, ethers.parseEther("100"))
      ).to.be.revertedWithCustomError(migration, "OwnableUnauthorizedAccount");
    });

    it("should revert with zero address recipient", async () => {
      const { owner, newCAS, migration } = await loadFixture(deployFixture);
      await migration.connect(owner).setMigrationActive(false);
      await expect(
        migration.connect(owner).rescueTokens(await newCAS.getAddress(), ethers.ZeroAddress, ethers.parseEther("100"))
      ).to.be.revertedWithCustomError(migration, "ZeroAddress");
    });

    it("should revert when migration is still active", async () => {
      const { owner, newCAS, migration } = await loadFixture(deployFixture);
      await expect(
        migration.connect(owner).rescueTokens(await newCAS.getAddress(), owner.address, ethers.parseEther("100"))
      ).to.be.revertedWithCustomError(migration, "MigrationStillActive");
    });
  });

  describe("availableNewCAS", () => {
    it("should return balance of new CAS in migration contract", async () => {
      const { migration } = await loadFixture(deployFixture);
      expect(await migration.availableNewCAS()).to.equal(ethers.parseEther("1000000"));
    });
  });
});
