import { expect } from "chai";
import { ethers, network } from "hardhat";

const DAY = 86400;

describe("ArbitrationFacet — Majority Rule, Revote & Voting Power", () => {
  let diamond: any;
  let casToken: any;
  let deployer: any;
  let proposer: any;
  let voter1: any;
  let voter2: any;
  let voter3: any;
  let voter4: any;
  let voter5: any;
  let accused: any;

  const COMPLIANCE_ROLE = ethers.keccak256(ethers.toUtf8Bytes("COMPLIANCE_ROLE"));
  const DAO_PROPOSER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("DAO_PROPOSER_ROLE"));
  const DAO_EXECUTOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("DAO_EXECUTOR_ROLE"));
  const DAO_CANCELLER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("DAO_CANCELLER_ROLE"));
  const USER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("USER_ROLE"));
  const AGENT_ROLE = ethers.keccak256(ethers.toUtf8Bytes("AGENT_ROLE"));

  async function fastForward(seconds: number) {
    await network.provider.send("evm_increaseTime", [seconds]);
    await network.provider.send("evm_mine");
  }

  function getSelectors(contract: any, fnNames: string[]): string[] {
    return fnNames.map((name) => contract.interface.getFunction(name).selector);
  }

  async function deployDiamond() {
    const DiamondCutFacet = await ethers.getContractFactory("DiamondCutFacet");
    const diamondCutFacet = await DiamondCutFacet.deploy();
    await diamondCutFacet.waitForDeployment();

    const Diamond = await ethers.getContractFactory("Diamond");
    const d = await Diamond.deploy(
      deployer.address,
      [[
        await diamondCutFacet.getAddress(),
        0,
        getSelectors(diamondCutFacet, ["diamondCut"]),
      ]],
    );
    await d.waitForDeployment();

    const ArbitrationFacet = await ethers.getContractFactory("ArbitrationFacet");
    const arbitrationFacet = await ArbitrationFacet.deploy();
    await arbitrationFacet.waitForDeployment();

    const arbSelectors = getSelectors(arbitrationFacet, [
      "initArbitration", "setArbitrationQuorum", "setArbitrationVotingDuration",
      "setArbitrationDisclosureDuration", "setArbitrationCasToken", "setMaxRevotes",
      "fileArbitrationCase", "castArbitrationVote", "executeArbitrationCase",
      "cancelArbitrationCase", "handleExpiredCase", "refileExpiredCase",
      "getCase", "getCaseCount", "getCaseState", "getVotingPeriod",
      "isVotingLockActive", "getArbitrationDisclosureDuration",
      "getMaxRevotes", "getRevoteCount", "hasVotedInCase",
      "isFrozenByArbitration", "getArbitrationQuorum",
      "getArbitrationVotingDuration", "getArbitrationCasToken",
      "getMaxRetries", "getRetryFreezeDuration",
      "delegateArbitrationVote", "clearArbitrationDelegation", "getArbitrationDelegatee",
      "setReputation", "getReputation",
      "setTechnicalCouncilMember", "isTechnicalCouncilMember",
      "setVotingPowerConfig", "getVotingPower", "getVotedPower",
      "challengeResult", "resolveChallenge", "finalizeCase",
      "fileAppeal", "getAppealCount", "getChallengeDeadline",
    ]);

    const initCalldata = arbitrationFacet.interface.encodeFunctionData("initArbitration", []);
    const diamondLoupe = new ethers.Contract(await d.getAddress(), [
      "function diamondCut((address,uint8,bytes4[])[], address, bytes) external",
    ], deployer);

    await (await diamondLoupe.diamondCut(
      [[await arbitrationFacet.getAddress(), 0, arbSelectors]],
      await arbitrationFacet.getAddress(),
      initCalldata,
    )).wait();

    return new ethers.Contract(await d.getAddress(), arbitrationFacet.interface, deployer);
  }

  async function setupPaymentStorage(diamondAddress: string) {
    const PaymentFacet = await ethers.getContractFactory("PaymentFacet");
    const paymentFacet = await PaymentFacet.deploy();
    await paymentFacet.waitForDeployment();

    const paySelectors = getSelectors(paymentFacet, [
      "setCasToken", "setInfrastructureFund", "initPayment",
    ]);

    const diamondLoupe = new ethers.Contract(diamondAddress, [
      "function diamondCut((address,uint8,bytes4[])[], address, bytes) external",
    ], deployer);

    await (await diamondLoupe.diamondCut(
      [[await paymentFacet.getAddress(), 0, paySelectors]],
      ethers.ZeroAddress,
      "0x",
    )).wait();

    const diamondWithPayment = new ethers.Contract(diamondAddress, [
      "function setCasToken(address) external",
      "function setInfrastructureFund(address) external",
      "function initPayment() external",
    ], deployer);

    await (await diamondWithPayment.setCasToken(await casToken.getAddress())).wait();
    await (await diamondWithPayment.setInfrastructureFund(deployer.address)).wait();
    await (await diamondWithPayment.initPayment()).wait();
  }

  async function setupAccessRoles(diamondAddress: string) {
    const AccessFacet = await ethers.getContractFactory("AccessControlFacet");
    const accessFacet = await AccessFacet.deploy();
    await accessFacet.waitForDeployment();

    const accessSelectors = getSelectors(accessFacet, [
      "grantRole", "revokeRole", "hasRole", "getRoleMemberCount",
    ]);

    const diamondLoupe = new ethers.Contract(diamondAddress, [
      "function diamondCut((address,uint8,bytes4[])[], address, bytes) external",
    ], deployer);

    await (await diamondLoupe.diamondCut(
      [[await accessFacet.getAddress(), 0, accessSelectors]],
      ethers.ZeroAddress,
      "0x",
    )).wait();

    const diamondWithAccess = new ethers.Contract(diamondAddress, [
      "function grantRole(bytes32, address) external",
      "function hasRole(bytes32, address) view returns (bool)",
      "function getRoleMemberCount(bytes32) view returns (uint256)",
    ], deployer);

    await (await diamondWithAccess.grantRole(DAO_PROPOSER_ROLE, proposer.address)).wait();
    await (await diamondWithAccess.grantRole(DAO_EXECUTOR_ROLE, deployer.address)).wait();
    await (await diamondWithAccess.grantRole(DAO_CANCELLER_ROLE, deployer.address)).wait();
    for (const v of [voter1, voter2, voter3, voter4, voter5]) {
      await (await diamondWithAccess.grantRole(USER_ROLE, v.address)).wait();
    }
    await (await diamondWithAccess.grantRole(AGENT_ROLE, deployer.address)).wait();
  }

  beforeEach(async () => {
    [deployer, proposer, voter1, voter2, voter3, voter4, voter5, accused] = await ethers.getSigners();

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
    for (const v of [proposer, voter1, voter2, voter3, voter4, voter5]) {
      await (await casToken.mint(v.address, ethers.parseEther("100"))).wait();
    }

    diamond = await deployDiamond();
    const diamondAddr = await diamond.getAddress();

    await setupPaymentStorage(diamondAddr);
    await setupAccessRoles(diamondAddr);

    await (await diamond.setArbitrationCasToken(await casToken.getAddress())).wait();
    await (await casToken.grantRole(COMPLIANCE_ROLE, diamondAddr)).wait();
    await (await diamond.setArbitrationVotingDuration(DAY)).wait();
    await (await diamond.setArbitrationDisclosureDuration(DAY)).wait();

    for (const v of [proposer, voter1, voter2, voter3, voter4, voter5]) {
      await (await casToken.connect(v).approve(diamondAddr, ethers.parseEther("1000"))).wait();
    }
  });

  it("should reject votes from unregistered (anonymous) addresses", async () => {
    await (await diamond.connect(proposer).fileArbitrationCase(
      [accused.address], ["fraud"], ethers.ZeroHash, 1, 0,
    )).wait();

    await fastForward(DAY + 1);

    const anon = (await ethers.getSigners())[8];
    await expect(
      diamond.connect(anon).castArbitrationVote(1, 1),
    ).to.be.revertedWithCustomError(diamond, "VoterNotRegistered");
  });

  it("should trigger revote when no >50% majority", async () => {
    await (await diamond.connect(proposer).fileArbitrationCase(
      [accused.address], ["fraud"], ethers.ZeroHash, 1, 0,
    )).wait();

    await fastForward(DAY + 1);

    await diamond.connect(voter1).castArbitrationVote(1, 1);
    await diamond.connect(voter2).castArbitrationVote(1, 1);
    await diamond.connect(voter3).castArbitrationVote(1, 0);
    await diamond.connect(voter4).castArbitrationVote(1, 0);

    await fastForward(DAY + 1);

    await expect(
      diamond.connect(deployer).executeArbitrationCase(1),
    ).to.emit(diamond, "ArbitrationRevoteRequired");

    const arbCase = await diamond.getCase(1);
    expect(arbCase.revoteCount).to.equal(1);
    expect(arbCase.votingPeriod).to.equal(0);
    expect(arbCase.forVotes).to.equal(0);
    expect(arbCase.againstVotes).to.equal(0);
  });

  it("should enter challenge period after majority result, then finalize", async () => {
    await (await diamond.connect(proposer).fileArbitrationCase(
      [accused.address], ["fraud"], ethers.ZeroHash, 1, 0,
    )).wait();

    await fastForward(DAY + 1);

    await diamond.connect(voter1).castArbitrationVote(1, 1);
    await diamond.connect(voter2).castArbitrationVote(1, 1);
    await diamond.connect(voter3).castArbitrationVote(1, 1);
    await diamond.connect(voter4).castArbitrationVote(1, 0);

    await fastForward(DAY + 1);

    // executeArbitrationCase enters challenge period (not Executed yet)
    await (await diamond.connect(deployer).executeArbitrationCase(1)).wait();

    let arbCase = await diamond.getCase(1);
    expect(arbCase.state).to.equal(7); // Challenged
    expect(arbCase.votingPeriod).to.equal(3); // Challenge

    // Fast forward past challenge deadline
    const challengeDeadline = await diamond.getChallengeDeadline(1);
    await fastForward(3 * DAY + 1);

    // Finalize without challenge
    await expect(
      diamond.connect(deployer).finalizeCase(1),
    ).to.emit(diamond, "ArbitrationCaseExecuted");

    arbCase = await diamond.getCase(1);
    expect(arbCase.state).to.equal(2); // Executed
  });

  it("should allow challenge and technical council to overturn result", async () => {
    await (await diamond.setTechnicalCouncilMember(deployer.address, true)).wait();

    await (await diamond.connect(proposer).fileArbitrationCase(
      [accused.address], ["fraud"], ethers.ZeroHash, 1, 0,
    )).wait();

    await fastForward(DAY + 1);

    await diamond.connect(voter1).castArbitrationVote(1, 1);
    await diamond.connect(voter2).castArbitrationVote(1, 1);
    await diamond.connect(voter3).castArbitrationVote(1, 1);
    await diamond.connect(voter4).castArbitrationVote(1, 0);

    await fastForward(DAY + 1);

    await (await diamond.connect(deployer).executeArbitrationCase(1)).wait();

    // Challenge the result
    await expect(
      diamond.connect(voter5).challengeResult(1),
    ).to.emit(diamond, "CaseChallenged");

    // Technical council overturns — triggers revote
    await expect(
      diamond.connect(deployer).resolveChallenge(1, false),
    ).to.emit(diamond, "ChallengeResolved");

    const arbCase = await diamond.getCase(1);
    expect(arbCase.revoteCount).to.equal(1);
    expect(arbCase.votingPeriod).to.equal(0); // Back to Disclosure
  });

  it("should allow same voter to vote in revote round", async () => {
    await (await diamond.connect(proposer).fileArbitrationCase(
      [accused.address], ["fraud"], ethers.ZeroHash, 1, 0,
    )).wait();

    await fastForward(DAY + 1);

    await diamond.connect(voter1).castArbitrationVote(1, 1);
    await diamond.connect(voter2).castArbitrationVote(1, 0);

    await fastForward(DAY + 1);

    await diamond.connect(deployer).executeArbitrationCase(1);

    await fastForward(DAY + 1);

    await expect(
      diamond.connect(voter1).castArbitrationVote(1, 1),
    ).not.to.be.reverted;
  });

  it("should revert when max revotes reached", async () => {
    await (await diamond.setMaxRevotes(1)).wait();

    await (await diamond.connect(proposer).fileArbitrationCase(
      [accused.address], ["fraud"], ethers.ZeroHash, 1, 0,
    )).wait();

    await fastForward(DAY + 1);

    await diamond.connect(voter1).castArbitrationVote(1, 1);
    await diamond.connect(voter2).castArbitrationVote(1, 0);

    await fastForward(DAY + 1);

    await diamond.connect(deployer).executeArbitrationCase(1);

    await fastForward(DAY + 1);

    await diamond.connect(voter1).castArbitrationVote(1, 1);
    await diamond.connect(voter2).castArbitrationVote(1, 0);

    await fastForward(DAY + 1);

    await expect(
      diamond.connect(deployer).executeArbitrationCase(1),
    ).to.be.revertedWithCustomError(diamond, "MaxRevotesReached");
  });

  it("should not count abstentions as decisive votes for majority", async () => {
    await (await diamond.connect(proposer).fileArbitrationCase(
      [accused.address], ["fraud"], ethers.ZeroHash, 1, 0,
    )).wait();

    await fastForward(DAY + 1);

    await diamond.connect(voter1).castArbitrationVote(1, 1);
    await diamond.connect(voter2).castArbitrationVote(1, 0);
    await diamond.connect(voter3).castArbitrationVote(1, 2);
    await diamond.connect(voter4).castArbitrationVote(1, 2);
    await diamond.connect(voter5).castArbitrationVote(1, 2);

    await fastForward(DAY + 1);

    await expect(
      diamond.connect(deployer).executeArbitrationCase(1),
    ).to.emit(diamond, "ArbitrationRevoteRequired");
  });

  it("should calculate weighted voting power based on token balance", async () => {
    // voter1 has 100 CAS, voter3 has 100 CAS — same power
    // Give voter1 more tokens to get more power
    await (await casToken.mint(voter1.address, ethers.parseEther("900"))).wait();

    const power1 = await diamond.getVotingPower(voter1.address);
    const power3 = await diamond.getVotingPower(voter3.address);
    expect(power1).to.be.gt(power3);
  });

  it("should allow vote delegation", async () => {
    await (await diamond.connect(voter1).delegateArbitrationVote(voter2.address)).wait();

    const delegatee = await diamond.getArbitrationDelegatee(voter1.address);
    expect(delegatee).to.equal(voter2.address);
  });

  it("should allow appeal after execution", async () => {
    await (await diamond.setTechnicalCouncilMember(deployer.address, true)).wait();

    await (await diamond.connect(proposer).fileArbitrationCase(
      [accused.address], ["fraud"], ethers.ZeroHash, 1, 0,
    )).wait();

    await fastForward(DAY + 1);

    await diamond.connect(voter1).castArbitrationVote(1, 1);
    await diamond.connect(voter2).castArbitrationVote(1, 1);
    await diamond.connect(voter3).castArbitrationVote(1, 1);

    await fastForward(DAY + 1);

    await (await diamond.connect(deployer).executeArbitrationCase(1)).wait();

    await fastForward(3 * DAY + 1);

    await (await diamond.connect(deployer).finalizeCase(1)).wait();

    let arbCase = await diamond.getCase(1);
    expect(arbCase.state).to.equal(2); // Executed

    // File appeal
    await expect(
      diamond.connect(voter4).fileAppeal(1),
    ).to.emit(diamond, "AppealFiled");

    arbCase = await diamond.getCase(1);
    expect(arbCase.state).to.equal(1); // Active again
    expect(arbCase.revoteCount).to.equal(1);
  });

  it("should set and get reputation scores", async () => {
    await (await diamond.setReputation(voter1.address, 8000)).wait();
    const score = await diamond.getReputation(voter1.address);
    expect(score).to.equal(8000);
  });

  it("should set technical council members", async () => {
    await (await diamond.setTechnicalCouncilMember(voter5.address, true)).wait();
    expect(await diamond.isTechnicalCouncilMember(voter5.address)).to.be.true;
    expect(await diamond.isTechnicalCouncilMember(voter4.address)).to.be.false;
  });
});
