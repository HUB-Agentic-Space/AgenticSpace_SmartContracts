import { expect } from "chai";
import { ethers } from "hardhat";
import { IDiamondCut } from "../../typechain-types";

/**
 * Integration tests for Diamond + CASToken + CASSwap + InfrastructureFund.
 * Verifies that real CAS token payments flow through the Diamond ecosystem.
 */

function getSelectors(contract: any): string[] {
  const selectors: string[] = [];
  const iface = contract.interface;
  for (const fn of iface.fragments) {
    if (fn.type === "function" && fn.name !== "init") {
      selectors.push(iface.getFunction(fn.name).selector);
    }
  }
  return selectors;
}

describe("Diamond + CAS Integration", () => {
  let diamond: any;
  let diamondAddr: string;
  let diamondInit: any;
  let casToken: any;
  let infraFund: any;
  let casSwap: any;
  let deployer: any;
  let user1: any;
  let user2: any;

  const DID = "did:ethr:0x1234567890123456789012345678901234567890";
  const DID_HASH = ethers.keccak256(ethers.toUtf8Bytes(DID));
  const PUBLIC_ID = "agent-int-01";
  const PUBLIC_ID_HASH = ethers.keccak256(ethers.toUtf8Bytes(PUBLIC_ID));
  const AUID = "auid-12345678-abcd-1234-abcd-1234567890ab";
  const NAME = "Integration Test Agent";
  const DESCRIPTION = "An agent for integration testing";
  const PARENT_PUBLIC_ID = "";
  const MERKLE_ROOT = ethers.keccak256(ethers.toUtf8Bytes("test-merkle-root"));
  const PROMPT_COUNT = 3;

  beforeEach(async () => {
    [deployer, user1, user2] = await ethers.getSigners();

    // -----------------------------------------------------------------------
    // 1. Deploy Diamond with all facets
    // -----------------------------------------------------------------------
    const DiamondCutFacet = await ethers.getContractFactory("DiamondCutFacet");
    const diamondCutFacet = await DiamondCutFacet.deploy();
    await diamondCutFacet.waitForDeployment();

    const Diamond = await ethers.getContractFactory("Diamond");
    const cut: IDiamondCut.FacetCutStruct[] = [{
      facetAddress: await diamondCutFacet.getAddress(),
      action: 0,
      functionSelectors: getSelectors(diamondCutFacet),
    }];
    diamond = await Diamond.deploy(deployer.address, cut);
    await diamond.waitForDeployment();
    diamondAddr = await diamond.getAddress();

    const DiamondInit = await ethers.getContractFactory("DiamondInit");
    diamondInit = await DiamondInit.deploy();
    await diamondInit.waitForDeployment();

    const facetNames = [
      "DiamondLoupeFacet",
      "OwnershipFacet",
      "PausableFacet",
      "UserRegistryFacet",
      "AgentRegistryFacet",
      "AgentValidatorFacet",
      "RoadMapDAOFacet",
      "AgentDAOFacet",
      "ContractRegistryFacet",
      "AccessControlFacet",
      "PaymentFacet",
      "GasPromotionFacet",
    ];

    const facetCuts: IDiamondCut.FacetCutStruct[] = [];
    for (const name of facetNames) {
      const Factory = await ethers.getContractFactory(name);
      const facet = await Factory.deploy();
      await facet.waitForDeployment();
      facetCuts.push({
        facetAddress: await facet.getAddress(),
        action: 0,
        functionSelectors: getSelectors(facet),
      });
    }

    const diamondCut = await ethers.getContractAt("IDiamondCut", diamondAddr);
    const initCalldata = DiamondInit.interface.encodeFunctionData("init");
    await (await diamondCut.diamondCut(facetCuts, await diamondInit.getAddress(), initCalldata)).wait();

    const validatorFacet = await ethers.getContractAt("AgentValidatorFacet", diamondAddr);
    await (await validatorFacet.initValidator()).wait();

    const roadmapFacet = await ethers.getContractAt("RoadMapDAOFacet", diamondAddr);
    await (await roadmapFacet.initRoadMapDAO()).wait();

    const agentDaoFacet = await ethers.getContractAt("AgentDAOFacet", diamondAddr);
    await (await agentDaoFacet.initAgentDAO()).wait();

    const paymentFacet = await ethers.getContractAt("PaymentFacet", diamondAddr);
    await (await paymentFacet.initPayment()).wait();

    const gasPromoFacet = await ethers.getContractAt("GasPromotionFacet", diamondAddr);
    await (await gasPromoFacet.initGasPromotion()).wait();

    // -----------------------------------------------------------------------
    // 2. Deploy CASToken
    // -----------------------------------------------------------------------
    const CASToken = await ethers.getContractFactory("CASToken");
    casToken = await CASToken.deploy();
    await casToken.waitForDeployment();
    const casTokenAddr = await casToken.getAddress();
    await (await casToken["initialize(address,uint256,string,string)"](
      deployer.address,
      ethers.parseEther("1000000"),
      "Cryptocoin Agentic Space",
      "CAS"
    )).wait();

    // -----------------------------------------------------------------------
    // 3. Deploy InfrastructureFund
    // -----------------------------------------------------------------------
    const InfrastructureFund = await ethers.getContractFactory("InfrastructureFund");
    infraFund = await InfrastructureFund.deploy();
    await infraFund.waitForDeployment();
    const infraFundAddr = await infraFund.getAddress();
    await (await infraFund["initialize(address,address,address,address)"](
      deployer.address,
      casTokenAddr,
      deployer.address,
      deployer.address
    )).wait();

    // -----------------------------------------------------------------------
    // 4. Deploy CASSwap
    // -----------------------------------------------------------------------
    const CASSwap = await ethers.getContractFactory("CASSwap");
    casSwap = await CASSwap.deploy();
    await casSwap.waitForDeployment();
    const casSwapAddr = await casSwap.getAddress();
    await (await casSwap["initialize(address,address,address)"](
      deployer.address,
      casTokenAddr,
      infraFundAddr
    )).wait();

    // Deposit CAS reserve into swap
    const reserveAmount = ethers.parseEther("10000");
    await (await casToken.approve(casSwapAddr, reserveAmount)).wait();
    await (await casSwap.depositCAS(reserveAmount)).wait();

    // Send POL to swap for sell liquidity
    await deployer.sendTransaction({
      to: casSwapAddr,
      value: ethers.parseEther("10"),
    });

    // -----------------------------------------------------------------------
    // 5. Link CAS Token and InfrastructureFund in Diamond PaymentFacet
    // -----------------------------------------------------------------------
    await (await paymentFacet.setCasToken(casTokenAddr)).wait();
    await (await paymentFacet.setInfrastructureFund(infraFundAddr)).wait();

    // Set real fees (100 CAS registration, 10 CAS validation)
    await (await paymentFacet.updateFees({
      registrationFee: ethers.parseEther("100"),
      validationFee: ethers.parseEther("10"),
      daoProposalFee: ethers.parseEther("50"),
      userRegistrationFee: 0,
    })).wait();

    // -----------------------------------------------------------------------
    // 6. Register contracts in ContractRegistry
    // -----------------------------------------------------------------------
    const contractRegistry = await ethers.getContractAt("ContractRegistryFacet", diamondAddr);
    await (await contractRegistry.register("CASToken", 1, casTokenAddr)).wait();
    await (await contractRegistry.register("InfrastructureFund", 1, infraFundAddr)).wait();
    await (await contractRegistry.register("CASSwap", 1, casSwapAddr)).wait();
  });

  describe("PaymentFacet integration", () => {
    it("should have CAS token linked", async () => {
      const paymentFacet = await ethers.getContractAt("PaymentFacet", diamondAddr);
      expect(await paymentFacet.getCasToken()).to.equal(await casToken.getAddress());
    });

    it("should have InfrastructureFund linked", async () => {
      const paymentFacet = await ethers.getContractAt("PaymentFacet", diamondAddr);
      expect(await paymentFacet.getInfrastructureFund()).to.equal(await infraFund.getAddress());
    });

    it("should have non-zero fees", async () => {
      const paymentFacet = await ethers.getContractAt("PaymentFacet", diamondAddr);
      const fees = await paymentFacet.getFees();
      expect(fees.registrationFee).to.equal(ethers.parseEther("100"));
      expect(fees.validationFee).to.equal(ethers.parseEther("10"));
      expect(fees.daoProposalFee).to.equal(ethers.parseEther("50"));
    });
  });

  describe("ContractRegistry integration", () => {
    it("should have CASToken registered", async () => {
      const registry = await ethers.getContractAt("ContractRegistryFacet", diamondAddr);
      expect(await registry.isRegistered("CASToken")).to.be.true;
      const registered = await registry["getAddress(string)"]("CASToken");
      const expected = await casToken.getAddress();
      expect(registered).to.equal(expected);
    });

    it("should have InfrastructureFund registered", async () => {
      const registry = await ethers.getContractAt("ContractRegistryFacet", diamondAddr);
      expect(await registry.isRegistered("InfrastructureFund")).to.be.true;
      expect(await registry["getAddress(string)"]("InfrastructureFund")).to.equal(await infraFund.getAddress());
    });

    it("should have CASSwap registered", async () => {
      const registry = await ethers.getContractAt("ContractRegistryFacet", diamondAddr);
      expect(await registry.isRegistered("CASSwap")).to.be.true;
      expect(await registry["getAddress(string)"]("CASSwap")).to.equal(await casSwap.getAddress());
    });
  });

  describe("Fee payment with real CAS", () => {
    it("should charge CAS registration fee and transfer to InfrastructureFund", async () => {
      // Give user1 some CAS
      const casAmount = ethers.parseEther("500");
      await casToken.transfer(user1.address, casAmount);

      // User1 approves Diamond to spend CAS for fees
      // PaymentLib uses transferFrom(payer, infrastructureFund, amount)
      // So user1 must approve the Diamond address (msg.sender of the facet)
      await casToken.connect(user1).approve(diamondAddr, ethers.parseEther("500"));

      // Register user first
      const userRegistry = await ethers.getContractAt("UserRegistryFacet", diamondAddr);
      const userDID = "did:ethr:0xabcdef1234567890abcdef1234567890abcdef12";
      const userDIDHash = ethers.keccak256(ethers.toUtf8Bytes(userDID));
      const userPublicIdHash = ethers.keccak256(ethers.toUtf8Bytes("user-int-01"));
      await (await userRegistry.connect(user1).registerUser(userDIDHash, userPublicIdHash, 0)).wait();

      // Register agent (charges registrationFee = 100 CAS)
      const agentRegistry = await ethers.getContractAt("AgentRegistryFacet", diamondAddr);
      const fundBalBefore = await casToken.balanceOf(await infraFund.getAddress());
      const userBalBefore = await casToken.balanceOf(user1.address);

      await (await agentRegistry.connect(user1).registerAgent(
        userDIDHash,
        "agent-int-01",
        AUID,
        NAME,
        DESCRIPTION,
        PARENT_PUBLIC_ID,
        MERKLE_ROOT,
        PROMPT_COUNT
      )).wait();

      const fundBalAfter = await casToken.balanceOf(await infraFund.getAddress());
      const userBalAfter = await casToken.balanceOf(user1.address);

      // Verify fee was transferred
      expect(fundBalAfter - fundBalBefore).to.equal(ethers.parseEther("100"));
      expect(userBalBefore - userBalAfter).to.equal(ethers.parseEther("100"));
    });

    it("should revert registration without sufficient CAS allowance", async () => {
      // Give user1 some CAS but don't approve
      await casToken.transfer(user1.address, ethers.parseEther("500"));

      const userRegistry = await ethers.getContractAt("UserRegistryFacet", diamondAddr);
      const userDID = "did:ethr:0xabcdef1234567890abcdef1234567890abcdef12";
      const userDIDHash = ethers.keccak256(ethers.toUtf8Bytes(userDID));
      const userPublicIdHash = ethers.keccak256(ethers.toUtf8Bytes("user-int-02"));
      await (await userRegistry.connect(user1).registerUser(userDIDHash, userPublicIdHash, 0)).wait();

      const agentRegistry = await ethers.getContractAt("AgentRegistryFacet", diamondAddr);
      await expect(
        agentRegistry.connect(user1).registerAgent(
          userDIDHash,
          "agent-int-02",
          AUID,
          NAME,
          DESCRIPTION,
          PARENT_PUBLIC_ID,
          MERKLE_ROOT,
          PROMPT_COUNT
        )
      ).to.be.reverted;
    });
  });

  describe("Swap + Diamond integration", () => {
    it("should buy CAS via swap and use it to pay Diamond fees", async () => {
      // User1 buys CAS via swap (1 POL = 1 CAS at 1:1)
      const polAmount = ethers.parseEther("200");
      const block = await ethers.provider.getBlock("latest");
      const deadline = BigInt(block!.timestamp + 3600);
      await casSwap.connect(user1).buyCAS(0n, deadline, { value: polAmount });

      const casBal = await casToken.balanceOf(user1.address);
      expect(casBal).to.equal(polAmount);

      // Approve Diamond to spend CAS
      await casToken.connect(user1).approve(diamondAddr, ethers.parseEther("200"));

      // Register user
      const userRegistry = await ethers.getContractAt("UserRegistryFacet", diamondAddr);
      const userDID = "did:ethr:0x9999991234567890abcdef1234567890abcdef12";
      const userDIDHash = ethers.keccak256(ethers.toUtf8Bytes(userDID));
      const userPublicIdHash = ethers.keccak256(ethers.toUtf8Bytes("user-swap-01"));
      await (await userRegistry.connect(user1).registerUser(userDIDHash, userPublicIdHash, 0)).wait();

      // Register agent (100 CAS fee)
      const agentRegistry = await ethers.getContractAt("AgentRegistryFacet", diamondAddr);
      const fundBefore = await casToken.balanceOf(await infraFund.getAddress());

      await (await agentRegistry.connect(user1).registerAgent(
        userDIDHash,
        "agent-swap-01",
        AUID,
        NAME,
        DESCRIPTION,
        PARENT_PUBLIC_ID,
        MERKLE_ROOT,
        PROMPT_COUNT
      )).wait();

      const fundAfter = await casToken.balanceOf(await infraFund.getAddress());
      expect(fundAfter - fundBefore).to.equal(ethers.parseEther("100"));
    });
  });

  describe("Cross-contract pausable", () => {
    it("should still allow Diamond operations when CASToken is paused", async () => {
      // Pause CASToken
      await casToken.pause();

      // Diamond operations (like UserRegistry) should still work
      // since they don't involve CAS transfers
      const userRegistry = await ethers.getContractAt("UserRegistryFacet", diamondAddr);
      const userDID = "did:ethr:0xpaused1234567890abcdef1234567890abcdef12";
      const userDIDHash = ethers.keccak256(ethers.toUtf8Bytes(userDID));
      const userPublicIdHash = ethers.keccak256(ethers.toUtf8Bytes("user-paused-01"));
      await (await userRegistry.connect(user1).registerUser(userDIDHash, userPublicIdHash, 0)).wait();

      // But agent registration (which requires CAS transfer) should fail
      const agentRegistry = await ethers.getContractAt("AgentRegistryFacet", diamondAddr);
      await expect(
        agentRegistry.connect(user1).registerAgent(
          userDIDHash,
          "agent-paused-01",
          AUID,
          NAME,
          DESCRIPTION,
          PARENT_PUBLIC_ID,
          MERKLE_ROOT,
          PROMPT_COUNT
        )
      ).to.be.reverted;
    });
  });

  describe("CASSwap ratio adjustment with Diamond", () => {
    it("should allow ratio admin to adjust swap ratio", async () => {
      // Deployer is RATIO_ADMIN_ROLE
      await casSwap.setRatio(1, 2);
      const [num, den] = await casSwap.getRatio();
      expect(num).to.equal(1n);
      expect(den).to.equal(2n);

      // Buy at new ratio: 1 POL = 0.5 CAS
      const polAmount = ethers.parseEther("1");
      const balBefore = await casToken.balanceOf(user1.address);
      const blk = await ethers.provider.getBlock("latest");
      const dl = BigInt(blk!.timestamp + 3600);
      await casSwap.connect(user1).buyCAS(0n, dl, { value: polAmount });
      const balAfter = await casToken.balanceOf(user1.address);
      expect(balAfter - balBefore).to.equal(ethers.parseEther("0.5"));
    });
  });
});
