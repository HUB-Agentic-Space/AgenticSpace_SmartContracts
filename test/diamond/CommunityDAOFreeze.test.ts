import { expect } from "chai";
import { ethers } from "hardhat";

describe("CommunityDAOFacet — Frozen Address Blocking", () => {
  let casToken: any;
  let deployer: any;
  let user: any;
  let frozenUser: any;

  const COMPLIANCE_ROLE = ethers.keccak256(ethers.toUtf8Bytes("COMPLIANCE_ROLE"));
  const USER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("USER_ROLE"));

  beforeEach(async () => {
    [deployer, user, frozenUser] = await ethers.getSigners();
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
    await (await casToken.grantRole(USER_ROLE, user.address)).wait();
    await (await casToken.grantRole(USER_ROLE, frozenUser.address)).wait();
    await (await casToken.mint(user.address, ethers.parseEther("1000"))).wait();
    await (await casToken.mint(frozenUser.address, ethers.parseEther("1000"))).wait();
  });

  it("should detect frozen user", async () => {
    await casToken.freeze(frozenUser.address);
    expect(await casToken.isFrozen(frozenUser.address)).to.be.true;
  });

  it("should allow non-frozen user transfers", async () => {
    expect(await casToken.isFrozen(user.address)).to.be.false;
    await expect(casToken.connect(user).transfer(deployer.address, 100))
      .not.to.be.reverted;
  });

  it("should block frozen user transfers", async () => {
    await casToken.freeze(frozenUser.address);
    await expect(casToken.connect(frozenUser).transfer(deployer.address, 100))
      .to.be.revertedWithCustomError(casToken, "AccountFrozen");
  });
});
