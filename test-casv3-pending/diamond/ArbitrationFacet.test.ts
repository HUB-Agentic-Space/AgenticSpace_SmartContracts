import { expect } from "chai";
import { ethers } from "hardhat";

describe("ArbitrationFacet — Full Lifecycle", () => {
  let diamond: any;
  let casToken: any;
  let deployer: any;
  let proposer: any;
  let voter1: any;
  let voter2: any;
  let accused: any;

  const COMPLIANCE_ROLE = ethers.keccak256(ethers.toUtf8Bytes("COMPLIANCE_ROLE"));
  const DAO_PROPOSER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("DAO_PROPOSER_ROLE"));
  const DAO_EXECUTOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("DAO_EXECUTOR_ROLE"));
  const DAO_CANCELLER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("DAO_CANCELLER_ROLE"));
  const USER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("USER_ROLE"));
  const AGENT_ROLE = ethers.keccak256(ethers.toUtf8Bytes("AGENT_ROLE"));

  async function deployDiamond() {
    const LibDiamond = await ethers.getContractFactory("LibDiamond");
    const libDiamond = await LibDiamond.deploy();
    await libDiamond.waitForDeployment();

    const DiamondCutFacet = await ethers.getContractFactory("DiamondCutFacet");
    const diamondCutFacet = await DiamondCutFacet.deploy();
    await diamondCutFacet.waitForDeployment();

    const Diamond = await ethers.getContractFactory("Diamond");
    const diamond = await Diamond.deploy(deployer.address, await diamondCutFacet.getAddress());
    await diamond.waitForDeployment();

    const DiamondInit = await ethers.getContractFactory("DiamondInit");
    const diamondInit = await DiamondInit.deploy();
    await diamondInit.waitForDeployment();

    const ArbitrationFacet = await ethers.getContractFactory("ArbitrationFacet");
    const arbitrationFacet = await ArbitrationFacet.deploy();
    await arbitrationFacet.waitForDeployment();

    const cut = [{
      facetAddress: await arbitrationFacet.getAddress(),
      action: 0,
      functionSelectors: [
        arbitrationFacet.interface.getFunction("initArbitration").selector,
        arbitrationFacet.interface.getFunction("setArbitrationQuorum").selector,
        arbitrationFacet.interface.getFunction("setArbitrationVotingDuration").selector,
        arbitrationFacet.interface.getFunction("setArbitrationCasToken").selector,
        arbitrationFacet.interface.getFunction("fileArbitrationCase").selector,
        arbitrationFacet.interface.getFunction("castArbitrationVote").selector,
        arbitrationFacet.interface.getFunction("executeArbitrationCase").selector,
        arbitrationFacet.interface.getFunction("cancelArbitrationCase").selector,
        arbitrationFacet.interface.getFunction("handleExpiredCase").selector,
        arbitrationFacet.interface.getFunction("refileExpiredCase").selector,
        arbitrationFacet.interface.getFunction("getCase").selector,
        arbitrationFacet.interface.getFunction("getCaseCount").selector,
        arbitrationFacet.interface.getFunction("getCaseState").selector,
        arbitrationFacet.interface.getFunction("hasVotedInCase").selector,
        arbitrationFacet.interface.getFunction("isFrozenByArbitration").selector,
        arbitrationFacet.interface.getFunction("getArbitrationQuorum").selector,
        arbitrationFacet.interface.getFunction("getArbitrationVotingDuration").selector,
        arbitrationFacet.interface.getFunction("getArbitrationCasToken").selector,
        arbitrationFacet.interface.getFunction("getMaxRetries").selector,
        arbitrationFacet.interface.getFunction("getRetryFreezeDuration").selector,
      ],
    }];

    const initCalldata = arbitrationFacet.interface.encodeFunctionData("initArbitration", []);
    const diamondLoupe = new ethers.Contract(await diamond.getAddress(), [
      "function diamondCut((address,uint8,bytes4[])[], address, bytes) external",
    ], deployer);

    await (await diamondLoupe.diamondCut(cut, await arbitrationFacet.getAddress(), initCalldata)).wait();

    return new ethers.Contract(await diamond.getAddress(), arbitrationFacet.interface, deployer);
  }

  async function setupPaymentStorage(diamondAddress: string) {
    const PaymentFacet = await ethers.getContractFactory("PaymentFacet");
    const paymentFacet = await PaymentFacet.deploy();
    await paymentFacet.waitForDeployment();

    const cut = [{
      facetAddress: await paymentFacet.getAddress(),
      action: 0,
      functionSelectors: [
        paymentFacet.interface.getFunction("setCasToken").selector,
        paymentFacet.interface.getFunction("setInfrastructureFund").selector,
        paymentFacet.interface.getFunction("initDefaultFees").selector,
      ],
    }];

    const initCalldata = "0x";
    const diamondLoupe = new ethers.Contract(diamondAddress, [
      "function diamondCut((address,uint8,bytes4[])[], address, bytes) external",
    ], deployer);

    await (await diamondLoupe.diamondCut(cut, ethers.ZeroAddress, initCalldata)).wait();

    const diamondWithPayment = new ethers.Contract(diamondAddress, [
      "function setCasToken(address) external",
      "function setInfrastructureFund(address) external",
      "function initDefaultFees() external",
    ], deployer);

    await (await diamondWithPayment.setCasToken(await casToken.getAddress())).wait();
    await (await diamondWithPayment.setInfrastructureFund(deployer.address)).wait();
    await (await diamondWithPayment.initDefaultFees()).wait();
  }

  async function setupAccessRoles(diamondAddress: string) {
    const AccessFacet = await ethers.getContractFactory("DiamondAccessControlFacet");
    if (!AccessFacet) return;

    const accessFacet = await AccessFacet.deploy();
    await accessFacet.waitForDeployment();

    const cut = [{
      facetAddress: await accessFacet.getAddress(),
      action: 0,
      functionSelectors: [
        accessFacet.interface.getFunction("grantRole").selector,
        accessFacet.interface.getFunction("revokeRole").selector,
        accessFacet.interface.getFunction("hasRole").selector,
        accessFacet.interface.getFunction("getRoleMemberCount").selector,
      ],
    }];

    const diamondLoupe = new ethers.Contract(diamondAddress, [
      "function diamondCut((address,uint8,bytes4[])[], address, bytes) external",
    ], deployer);

    await (await diamondLoupe.diamondCut(cut, ethers.ZeroAddress, "0x")).wait();

    const diamondWithAccess = new ethers.Contract(diamondAddress, [
      "function grantRole(bytes32, address) external",
      "function hasRole(bytes32, address) view returns (bool)",
      "function getRoleMemberCount(bytes32) view returns (uint256)",
    ], deployer);

    await (await diamondWithAccess.grantRole(DAO_PROPOSER_ROLE, proposer.address)).wait();
    await (await diamondWithAccess.grantRole(DAO_EXECUTOR_ROLE, deployer.address)).wait();
    await (await diamondWithAccess.grantRole(DAO_CANCELLER_ROLE, deployer.address)).wait();
    await (await diamondWithAccess.grantRole(USER_ROLE, voter1.address)).wait();
    await (await diamondWithAccess.grantRole(USER_ROLE, voter2.address)).wait();
    await (await diamondWithAccess.grantRole(AGENT_ROLE, deployer.address)).wait();
  }

  beforeEach(async () => {
    [deployer, proposer, voter1, voter2, accused] = await ethers.getSigners();

    const CASToken = await ethers.getContractFactory("CASToken");
    casToken = await CASToken.deploy();
    await casToken.waitForDeployment();
    await (await casToken["initialize(address,uint256,string,string)"](
      deployer.address,
      ethers.parseEther("1000000"),
      "Cryptocoin Agentic Space",
      "CAS",
    )).wait();

    await (await casToken.grantRole(COMPLIANCE_ROLE, deployer.address)).wait();
    await (await casToken.mint(proposer.address, ethers.parseEther("100"))).wait();
    await (await casToken.mint(voter1.address, ethers.parseEther("100"))).wait();
    await (await casToken.mint(voter2.address, ethers.parseEther("100"))).wait();

    diamond = await deployDiamond();
    const diamondAddr = await diamond.getAddress();

    await setupPaymentStorage(diamondAddr);
    await setupAccessRoles(diamondAddr);

    await (await diamond.setArbitrationCasToken(await casToken.getAddress())).wait();

    await (await casToken.connect(proposer).approve(diamondAddr, ethers.parseEther("1000"))).wait();
    await (await casToken.connect(voter1).approve(diamondAddr, ethers.parseEther("1000"))).wait();
    await (await casToken.connect(voter2).approve(diamondAddr, ethers.parseEther("1000"))).wait();
  });

  describe("fileArbitrationCase", () => {
    it("should create a case", async () => {
      const tx = await diamond.connect(proposer).fileArbitrationCase(
        [accused.address],
        ["phishing"],
        ethers.ZeroHash,
        1,
        0,
      );
      const receipt = await tx.wait();
      expect(receipt).to.not.be.null;

      const caseCount = await diamond.getCaseCount();
      expect(caseCount).to.equal(1);

      const arbCase = await diamond.getCase(1);
      expect(arbCase.filer).to.equal(proposer.address);
      expect(arbCase.accused[0]).to.equal(accused.address);
    });

    it("should revert with empty accused list", async () => {
      await expect(diamond.connect(proposer).fileArbitrationCase(
        [], [], ethers.ZeroHash, 1, 0,
      )).to.be.revertedWithCustomError(diamond, "EmptyAccusedList");
    });

    it("should revert with array length mismatch", async () => {
      await expect(diamond.connect(proposer).fileArbitrationCase(
        [accused.address], [], ethers.ZeroHash, 1, 0,
      )).to.be.revertedWithCustomError(diamond, "AccusedArrayLengthMismatch");
    });

    it("should revert with zero address in accused", async () => {
      await expect(diamond.connect(proposer).fileArbitrationCase(
        [ethers.ZeroAddress], ["reason"], ethers.ZeroHash, 1, 0,
      )).to.be.revertedWithCustomError(diamond, "ZeroAddress");
    });

    it("should revert with invalid freeze type", async () => {
      await expect(diamond.connect(proposer).fileArbitrationCase(
        [accused.address], ["reason"], ethers.ZeroHash, 3, 0,
      )).to.be.revertedWithCustomError(diamond, "InvalidFreezeType");
    });

    it("should revert if limited freeze with past endTime", async () => {
      const now = (await ethers.provider.getBlock("latest")).timestamp;
      await expect(diamond.connect(proposer).fileArbitrationCase(
        [accused.address], ["reason"], ethers.ZeroHash, 0, now,
      )).to.be.revertedWithCustomError(diamond, "FreezeUntilMustBeFuture");
    });
  });

  describe("castArbitrationVote", () => {
    beforeEach(async () => {
      await (await diamond.connect(proposer).fileArbitrationCase(
        [accused.address], ["phishing"], ethers.ZeroHash, 1, 0,
      )).wait();
    });

    it("should cast a For vote", async () => {
      await expect(diamond.connect(voter1).castArbitrationVote(1, 1))
        .to.emit(diamond, "ArbitrationVoteCast")
        .withArgs(1, voter1.address, 1, 1);
      expect(await diamond.hasVotedInCase(1, voter1.address)).to.be.true;
    });

    it("should cast an Against vote", async () => {
      await diamond.connect(voter1).castArbitrationVote(1, 0);
      const arbCase = await diamond.getCase(1);
      expect(arbCase.againstVotes).to.equal(1);
    });

    it("should revert on double voting", async () => {
      await diamond.connect(voter1).castArbitrationVote(1, 1);
      await expect(diamond.connect(voter1).castArbitrationVote(1, 0))
        .to.be.revertedWithCustomError(diamond, "AlreadyVoted");
    });

    it("should revert with invalid support value", async () => {
      await expect(diamond.connect(voter1).castArbitrationVote(1, 3))
        .to.be.revertedWithCustomError(diamond, "InvalidSupport");
    });

    it("should revert if voter is frozen", async () => {
      await casToken.freeze(voter1.address);
      await expect(diamond.connect(voter1).castArbitrationVote(1, 1))
        .to.be.revertedWithCustomError(diamond, "NotAuthorized");
    });
  });

  describe("executeArbitrationCase", () => {
    beforeEach(async () => {
      await (await diamond.connect(proposer).fileArbitrationCase(
        [accused.address], ["phishing"], ethers.ZeroHash, 1, 0,
      )).wait();
    });

    it("should execute and freeze accused when approved", async () => {
      await diamond.connect(voter1).castArbitrationVote(1, 1);
      await diamond.connect(voter2).castArbitrationVote(1, 1);

      await ethers.provider.send("evm_increaseTime", [6 * 24 * 60 * 60]);
      await ethers.provider.send("evm_mine", []);

      await expect(diamond.executeArbitrationCase(1))
        .to.emit(diamond, "ArbitrationCaseExecuted");

      expect(await casToken.isFrozen(accused.address)).to.be.true;
      expect(await diamond.isFrozenByArbitration(accused.address)).to.be.true;
    });

    it("should execute and unfreeze when not approved", async () => {
      await diamond.connect(voter1).castArbitrationVote(1, 0);

      await ethers.provider.send("evm_increaseTime", [6 * 24 * 60 * 60]);
      await ethers.provider.send("evm_mine", []);

      await diamond.executeArbitrationCase(1);
      expect(await casToken.isFrozen(accused.address)).to.be.false;
    });

    it("should revert if voting not ended", async () => {
      await diamond.connect(voter1).castArbitrationVote(1, 1);
      await expect(diamond.executeArbitrationCase(1))
        .to.be.revertedWithCustomError(diamond, "VotingEnded");
    });

    it("should revert if case not found", async () => {
      await expect(diamond.executeArbitrationCase(999))
        .to.be.revertedWithCustomError(diamond, "CaseNotFound");
    });
  });

  describe("cancelArbitrationCase", () => {
    it("should cancel an active case", async () => {
      await (await diamond.connect(proposer).fileArbitrationCase(
        [accused.address], ["reason"], ethers.ZeroHash, 1, 0,
      )).wait();

      await expect(diamond.cancelArbitrationCase(1))
        .to.emit(diamond, "ArbitrationCaseCanceled");

      const state = await diamond.getCaseState(1);
      expect(Number(state)).to.equal(3); // Canceled
    });
  });

  describe("handleExpiredCase", () => {
    it("should freeze for 6 months on expired case with no quorum", async () => {
      await (await diamond.connect(proposer).fileArbitrationCase(
        [accused.address], ["reason"], ethers.ZeroHash, 1, 0,
      )).wait();

      await ethers.provider.send("evm_increaseTime", [6 * 24 * 60 * 60]);
      await ethers.provider.send("evm_mine", []);

      await expect(diamond.handleExpiredCase(1))
        .to.emit(diamond, "ArbitrationCaseExpired");

      expect(await casToken.isFrozen(accused.address)).to.be.true;
      const arbCase = await diamond.getCase(1);
      expect(Number(arbCase.retryCount)).to.equal(1);
    });

    it("should revert if max retries reached", async () => {
      for (let i = 0; i < 3; i++) {
        await (await diamond.connect(proposer).fileArbitrationCase(
          [accused.address], ["reason"], ethers.ZeroHash, 1, 0,
        )).wait();
        const caseId = Number(await diamond.getCaseCount());

        await ethers.provider.send("evm_increaseTime", [6 * 24 * 60 * 60]);
        await ethers.provider.send("evm_mine", []);

        try {
          await diamond.handleExpiredCase(caseId);
        } catch {}
      }

      await (await diamond.connect(proposer).fileArbitrationCase(
        [accused.address], ["reason"], ethers.ZeroHash, 1, 0,
      )).wait();
      const caseId = Number(await diamond.getCaseCount());

      await ethers.provider.send("evm_increaseTime", [6 * 24 * 60 * 60]);
      await ethers.provider.send("evm_mine", []);

      await expect(diamond.handleExpiredCase(caseId))
        .to.be.revertedWithCustomError(diamond, "MaxRetriesReached");
    });
  });

  describe("View functions", () => {
    it("should return correct case count", async () => {
      expect(await diamond.getCaseCount()).to.equal(0);
      await (await diamond.connect(proposer).fileArbitrationCase(
        [accused.address], ["reason"], ethers.ZeroHash, 1, 0,
      )).wait();
      expect(await diamond.getCaseCount()).to.equal(1);
    });

    it("should return correct quorum", async () => {
      expect(await diamond.getArbitrationQuorum()).to.equal(500);
    });

    it("should return correct voting duration", async () => {
      expect(await diamond.getArbitrationVotingDuration()).to.equal(5 * 24 * 60 * 60);
    });

    it("should return max retries", async () => {
      expect(await diamond.getMaxRetries()).to.equal(3);
    });

    it("should return retry freeze duration", async () => {
      expect(await diamond.getRetryFreezeDuration()).to.equal(180 * 24 * 60 * 60);
    });
  });
});
