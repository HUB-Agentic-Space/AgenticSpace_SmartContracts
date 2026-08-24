import { expect } from "chai";
import { ethers } from "hardhat";

describe("CASToken — Voting Lock", () => {
  let casToken: any;
  let deployer: any;
  let user1: any;
  let user2: any;
  let compliance: any;

  const COMPLIANCE_ROLE = ethers.keccak256(ethers.toUtf8Bytes("COMPLIANCE_ROLE"));

  beforeEach(async () => {
    [deployer, user1, user2, compliance] = await ethers.getSigners();
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

  it("should have voting lock inactive by default", async () => {
    expect(await casToken.isVotingLockActive()).to.be.false;
  });

  it("should block all transfers when voting lock is active", async () => {
    await casToken.connect(compliance).setVotingLock(true);
    expect(await casToken.isVotingLockActive()).to.be.true;

    await expect(
      casToken.connect(user1).transfer(user2.address, 100),
    ).to.be.revertedWithCustomError(casToken, "VotingLockActive");
  });

  it("should allow transfers when voting lock is inactive", async () => {
    expect(await casToken.isVotingLockActive()).to.be.false;
    await expect(
      casToken.connect(user1).transfer(user2.address, 100),
    ).not.to.be.reverted;
  });

  it("should allow transfers after voting lock is deactivated", async () => {
    await casToken.connect(compliance).setVotingLock(true);
    expect(await casToken.isVotingLockActive()).to.be.true;

    await casToken.connect(compliance).setVotingLock(false);
    expect(await casToken.isVotingLockActive()).to.be.false;

    await expect(
      casToken.connect(user1).transfer(user2.address, 100),
    ).not.to.be.reverted;
  });

  it("should revert if non-compliance calls setVotingLock", async () => {
    await expect(
      casToken.connect(user1).setVotingLock(true),
    ).to.be.reverted;
  });

  it("should emit VotingLockStateChanged event", async () => {
    await expect(casToken.connect(compliance).setVotingLock(true))
      .to.emit(casToken, "VotingLockStateChanged")
      .withArgs(true);
  });
});
