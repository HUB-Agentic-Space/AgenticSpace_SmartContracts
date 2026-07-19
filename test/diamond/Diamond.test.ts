import { expect } from "chai";
import { ethers } from "hardhat";
import { IDiamondCut } from "../../typechain-types";

/**
 * Tests for the Agentic Space Diamond (EIP-2535).
 * Verifies diamond cut, loupe, ownership, agent registry, and validator facets.
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

describe("Diamond", () => {
  let diamond: any;
  let diamondAddr: string;
  let diamondInit: any;
  let diamondCutFacet: any;
  let deployer: any;
  let user1: any;
  let user2: any;

  const DID = "did:ethr:0x1234567890123456789012345678901234567890";
  const DID_HASH = ethers.keccak256(ethers.toUtf8Bytes(DID));
  const PUBLIC_ID = "agent-test-01";
  const PUBLIC_ID_HASH = ethers.keccak256(ethers.toUtf8Bytes(PUBLIC_ID));
  const AUID = "auid-12345678-abcd-1234-abcd-1234567890ab";
  const NAME = "Test Agent";
  const DESCRIPTION = "A test agent for unit testing";
  const PARENT_PUBLIC_ID = "";
  const MERKLE_ROOT = ethers.keccak256(ethers.toUtf8Bytes("test-merkle-root"));
  const PROMPT_COUNT = 3;

  beforeEach(async () => {
    [deployer, user1, user2] = await ethers.getSigners();

    // Deploy DiamondCutFacet
    const DiamondCutFacet = await ethers.getContractFactory("DiamondCutFacet");
    diamondCutFacet = await DiamondCutFacet.deploy();
    await diamondCutFacet.waitForDeployment();

    // Deploy Diamond with DiamondCutFacet
    const Diamond = await ethers.getContractFactory("Diamond");
    const cut: IDiamondCut.FacetCutStruct[] = [{
      facetAddress: await diamondCutFacet.getAddress(),
      action: 0,
      functionSelectors: getSelectors(diamondCutFacet),
    }];
    diamond = await Diamond.deploy(deployer.address, cut);
    await diamond.waitForDeployment();
    diamondAddr = await diamond.getAddress();

    // Deploy DiamondInit
    const DiamondInit = await ethers.getContractFactory("DiamondInit");
    diamondInit = await DiamondInit.deploy();
    await diamondInit.waitForDeployment();

    // Deploy and attach facets
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

    // Init domain facets
    const validatorFacet = await ethers.getContractAt("AgentValidatorFacet", diamondAddr);
    await (await validatorFacet.initValidator()).wait();

    const roadmapFacet = await ethers.getContractAt("RoadMapDAOFacet", diamondAddr);
    await (await roadmapFacet.initRoadMapDAO()).wait();

    const agentDaoFacet = await ethers.getContractAt("AgentDAOFacet", diamondAddr);
    await (await agentDaoFacet.initAgentDAO()).wait();

    // Init Payment and set fees to 0 for tests (no real CAS token)
    const paymentFacet = await ethers.getContractAt("PaymentFacet", diamondAddr);
    await (await paymentFacet.initPayment()).wait();
    await (await paymentFacet.updateFees({ registrationFee: 0, validationFee: 0, daoProposalFee: 0, userRegistrationFee: 0 })).wait();

    // Init GasPromotion (disabled by default)
    const gasPromoFacet = await ethers.getContractAt("GasPromotionFacet", diamondAddr);
    await (await gasPromoFacet.initGasPromotion()).wait();
  });

  // Helper: register a user before registering an agent
  async function registerUser(signer: any, didHash: string, publicIdHash: string) {
    const userRegistry = await ethers.getContractAt("UserRegistryFacet", diamondAddr);
    await userRegistry.connect(signer).registerUser(didHash, publicIdHash, 0);
  }

  describe("DiamondLoupeFacet", () => {
    it("should list all facets", async () => {
      const loupe = await ethers.getContractAt("DiamondLoupeFacet", diamondAddr);
      const facets = await loupe.facets();
      expect(facets.length).to.be.gte(11);
    });

    it("should return facet addresses", async () => {
      const loupe = await ethers.getContractAt("DiamondLoupeFacet", diamondAddr);
      const addresses = await loupe.facetAddresses();
      expect(addresses.length).to.be.gte(11);
    });

    it("should support EIP-165", async () => {
      const loupe = await ethers.getContractAt("DiamondLoupeFacet", diamondAddr);
      expect(await loupe.supportsInterface("0x01ffc9a7")).to.be.true;
    });
  });

  describe("OwnershipFacet", () => {
    it("should return the owner", async () => {
      const ownership = await ethers.getContractAt("OwnershipFacet", diamondAddr);
      expect(await ownership.owner()).to.equal(deployer.address);
    });

    it("should transfer ownership", async () => {
      const ownership = await ethers.getContractAt("OwnershipFacet", diamondAddr);
      await ownership.transferOwnership(user1.address);
      expect(await ownership.owner()).to.equal(user1.address);
    });

    it("should revert if non-owner transfers ownership", async () => {
      const ownership = await ethers.getContractAt("OwnershipFacet", diamondAddr);
      await expect(
        ownership.connect(user1).transferOwnership(user2.address)
      ).to.be.revertedWithCustomError(ownership, "NotContractOwner");
    });
  });

  describe("UserRegistryFacet", () => {
    it("should register a new user", async () => {
      const userRegistry = await ethers.getContractAt("UserRegistryFacet", diamondAddr);
      await userRegistry.connect(user1).registerUser(DID_HASH, PUBLIC_ID_HASH, 0);

      const user = await userRegistry.getUserByAddress(user1.address);
      expect(user.didHash).to.equal(DID_HASH);
      expect(user.walletAddress).to.equal(user1.address);
      expect(user.publicIdHash).to.equal(PUBLIC_ID_HASH);
      expect(user.isActive).to.be.true;
    });

    it("should revert on duplicate address", async () => {
      const userRegistry = await ethers.getContractAt("UserRegistryFacet", diamondAddr);
      await userRegistry.connect(user1).registerUser(DID_HASH, PUBLIC_ID_HASH, 0);
      await expect(
        userRegistry.connect(user1).registerUser(DID_HASH, PUBLIC_ID_HASH, 0)
      ).to.be.revertedWithCustomError(userRegistry, "AddressAlreadyRegistered");
    });

    it("should revert on empty didHash", async () => {
      const userRegistry = await ethers.getContractAt("UserRegistryFacet", diamondAddr);
      await expect(
        userRegistry.connect(user1).registerUser(ethers.ZeroHash, PUBLIC_ID_HASH, 0)
      ).to.be.revertedWithCustomError(userRegistry, "EmptyDIDHash");
    });

    it("should deactivate and reactivate a user", async () => {
      const userRegistry = await ethers.getContractAt("UserRegistryFacet", diamondAddr);
      await userRegistry.connect(user1).registerUser(DID_HASH, PUBLIC_ID_HASH, 0);
      const userId = await userRegistry.getUserIdByAddress(user1.address);

      await userRegistry.connect(user1).deactivateUser(userId);
      expect(await userRegistry.isUserActive(user1.address)).to.be.false;

      await userRegistry.connect(user1).reactivateUser(userId);
      expect(await userRegistry.isUserActive(user1.address)).to.be.true;
    });

    it("should return false for unregistered user", async () => {
      const userRegistry = await ethers.getContractAt("UserRegistryFacet", diamondAddr);
      expect(await userRegistry.isUserActive(user1.address)).to.be.false;
    });
  });

  describe("PaymentFacet", () => {
    it("should return default fees after init", async () => {
      const payment = await ethers.getContractAt("PaymentFacet", diamondAddr);
      const fees = await payment.getFees();
      expect(fees.registrationFee).to.equal(0);
      expect(fees.validationFee).to.equal(0);
      expect(fees.daoProposalFee).to.equal(0);
    });

    it("should set CAS token by owner", async () => {
      const payment = await ethers.getContractAt("PaymentFacet", diamondAddr);
      await payment.setCasToken(user2.address);
      expect(await payment.getCasToken()).to.equal(user2.address);
    });

    it("should set infrastructure fund by owner", async () => {
      const payment = await ethers.getContractAt("PaymentFacet", diamondAddr);
      await payment.setInfrastructureFund(user2.address);
      expect(await payment.getInfrastructureFund()).to.equal(user2.address);
    });

    it("should update fees by owner", async () => {
      const payment = await ethers.getContractAt("PaymentFacet", diamondAddr);
      await payment.updateFees({ registrationFee: 200, validationFee: 20, daoProposalFee: 100, userRegistrationFee: 0 });
      const fees = await payment.getFees();
      expect(fees.registrationFee).to.equal(200);
      expect(fees.validationFee).to.equal(20);
      expect(fees.daoProposalFee).to.equal(100);
    });

    it("should revert setting CAS token to zero address", async () => {
      const payment = await ethers.getContractAt("PaymentFacet", diamondAddr);
      await expect(payment.setCasToken(ethers.ZeroAddress)).to.be.revertedWithCustomError(payment, "ZeroAddress");
    });

    it("should revert setting infra fund to zero address", async () => {
      const payment = await ethers.getContractAt("PaymentFacet", diamondAddr);
      await expect(payment.setInfrastructureFund(ethers.ZeroAddress)).to.be.revertedWithCustomError(payment, "ZeroAddress");
    });

    it("should revert non-owner setting CAS token", async () => {
      const payment = await ethers.getContractAt("PaymentFacet", diamondAddr);
      await expect(payment.connect(user1).setCasToken(user2.address)).to.be.reverted;
    });
  });

  describe("GasPromotionFacet", () => {
    it("should be disabled by default after init", async () => {
      const gasPromo = await ethers.getContractAt("GasPromotionFacet", diamondAddr);
      expect(await gasPromo.isGlobalPromotionEnabled()).to.be.false;
    });

    it("should enable global promotion by owner", async () => {
      const gasPromo = await ethers.getContractAt("GasPromotionFacet", diamondAddr);
      await gasPromo.setGlobalPromotion(true);
      expect(await gasPromo.isGlobalPromotionEnabled()).to.be.true;
    });

    it("should set relayer by owner", async () => {
      const gasPromo = await ethers.getContractAt("GasPromotionFacet", diamondAddr);
      await gasPromo.setRelayer(deployer.address);
      expect(await gasPromo.getRelayer()).to.equal(deployer.address);
    });

    it("should revert setting relayer to zero address", async () => {
      const gasPromo = await ethers.getContractAt("GasPromotionFacet", diamondAddr);
      await expect(gasPromo.setRelayer(ethers.ZeroAddress)).to.be.revertedWithCustomError(gasPromo, "ZeroAddress");
    });

    it("should activate promotion for user registration", async () => {
      const gasPromo = await ethers.getContractAt("GasPromotionFacet", diamondAddr);
      await gasPromo.setGlobalPromotion(true);
      // OperationType.USER_REGISTRATION = 0
      await gasPromo.activatePromotion(0, ethers.parseEther("10"), ethers.parseEther("0.1"), 30 * 24 * 3600);

      const promo = await gasPromo.getPromotion(0);
      expect(promo.isActive).to.be.true;
      expect(promo.budget).to.equal(ethers.parseEther("10"));
      expect(promo.perUserLimit).to.equal(ethers.parseEther("0.1"));
    });

    it("should check isPromoted for user registration", async () => {
      const gasPromo = await ethers.getContractAt("GasPromotionFacet", diamondAddr);
      await gasPromo.setGlobalPromotion(true);
      await gasPromo.activatePromotion(0, ethers.parseEther("10"), ethers.parseEther("0.1"), 30 * 24 * 3600);

      const [active, remainingBudget, userRemaining] = await gasPromo.isPromoted(0, user1.address);
      expect(active).to.be.true;
      expect(remainingBudget).to.equal(ethers.parseEther("10"));
      expect(userRemaining).to.equal(ethers.parseEther("0.1"));
    });

    it("should record gas spending by relayer", async () => {
      const gasPromo = await ethers.getContractAt("GasPromotionFacet", diamondAddr);
      await gasPromo.setGlobalPromotion(true);
      await gasPromo.setRelayer(deployer.address);
      await gasPromo.activatePromotion(0, ethers.parseEther("10"), ethers.parseEther("0.1"), 30 * 24 * 3600);

      await gasPromo.recordGasSpending(0, user1.address, ethers.parseEther("0.05"));

      const spent = await gasPromo.getUserSpending(0, user1.address);
      expect(spent).to.equal(ethers.parseEther("0.05"));
    });

    it("should revert recording by non-relayer", async () => {
      const gasPromo = await ethers.getContractAt("GasPromotionFacet", diamondAddr);
      await gasPromo.setGlobalPromotion(true);
      await gasPromo.setRelayer(deployer.address);
      await gasPromo.activatePromotion(0, ethers.parseEther("10"), ethers.parseEther("0.1"), 30 * 24 * 3600);

      await expect(
        gasPromo.connect(user1).recordGasSpending(0, user1.address, ethers.parseEther("0.05"))
      ).to.be.revertedWithCustomError(gasPromo, "NotRelayer");
    });

    it("should deactivate promotion by owner", async () => {
      const gasPromo = await ethers.getContractAt("GasPromotionFacet", diamondAddr);
      await gasPromo.setGlobalPromotion(true);
      await gasPromo.activatePromotion(0, ethers.parseEther("10"), ethers.parseEther("0.1"), 30 * 24 * 3600);
      await gasPromo.deactivatePromotion(0);

      const promo = await gasPromo.getPromotion(0);
      expect(promo.isActive).to.be.false;
    });

    it("should revert activating with zero budget", async () => {
      const gasPromo = await ethers.getContractAt("GasPromotionFacet", diamondAddr);
      await expect(gasPromo.activatePromotion(0, 0, ethers.parseEther("0.1"), 30 * 24 * 3600))
        .to.be.revertedWithCustomError(gasPromo, "InvalidBudget");
    });

    it("should revert recording when global promotion is disabled", async () => {
      const gasPromo = await ethers.getContractAt("GasPromotionFacet", diamondAddr);
      await gasPromo.setRelayer(deployer.address);
      await gasPromo.activatePromotion(0, ethers.parseEther("10"), ethers.parseEther("0.1"), 30 * 24 * 3600);
      // global is still false

      await expect(
        gasPromo.recordGasSpending(0, user1.address, ethers.parseEther("0.05"))
      ).to.be.revertedWithCustomError(gasPromo, "PromotionNotActive");
    });

    it("should refill budget for a promotion", async () => {
      const gasPromo = await ethers.getContractAt("GasPromotionFacet", diamondAddr);
      await gasPromo.activatePromotion(0, ethers.parseEther("10"), ethers.parseEther("0.1"), 30 * 24 * 3600);
      await gasPromo.refillBudget(0, ethers.parseEther("5"));

      const promo = await gasPromo.getPromotion(0);
      expect(promo.budget).to.equal(ethers.parseEther("15"));
    });
  });

  describe("AgentRegistryFacet", () => {
    beforeEach(async () => {
      await registerUser(user1, DID_HASH, PUBLIC_ID_HASH);
    });

    it("should revert if user not registered", async () => {
      const registry = await ethers.getContractAt("AgentRegistryFacet", diamondAddr);
      await expect(
        registry.connect(user2).registerAgent(DID_HASH, PUBLIC_ID, AUID, NAME, DESCRIPTION, PARENT_PUBLIC_ID, MERKLE_ROOT, PROMPT_COUNT)
      ).to.be.revertedWithCustomError(registry, "UserNotRegistered");
    });

    it("should register a new agent", async () => {
      const registry = await ethers.getContractAt("AgentRegistryFacet", diamondAddr);
      await registry.connect(user1).registerAgent(DID_HASH, PUBLIC_ID, AUID, NAME, DESCRIPTION, PARENT_PUBLIC_ID, MERKLE_ROOT, PROMPT_COUNT);

      const agentId = await registry.computeAgentId(DID_HASH, user1.address);
      const agent = await registry.getAgent(agentId);

      expect(agent.didHash).to.equal(DID_HASH);
      expect(agent.ownerAddress).to.equal(user1.address);
      expect(agent.publicId).to.equal(PUBLIC_ID);
      expect(agent.auid).to.equal(AUID);
      expect(agent.name).to.equal(NAME);
      expect(agent.description).to.equal(DESCRIPTION);
      expect(agent.merkleRoot).to.equal(MERKLE_ROOT);
      expect(agent.promptCount).to.equal(PROMPT_COUNT);
      expect(agent.isActive).to.be.true;
    });

    it("should revert on duplicate agent", async () => {
      const registry = await ethers.getContractAt("AgentRegistryFacet", diamondAddr);
      await registry.connect(user1).registerAgent(DID_HASH, PUBLIC_ID, AUID, NAME, DESCRIPTION, PARENT_PUBLIC_ID, MERKLE_ROOT, PROMPT_COUNT);
      await expect(
        registry.connect(user1).registerAgent(DID_HASH, "another-id", "another-auid", "Another", DESCRIPTION, PARENT_PUBLIC_ID, MERKLE_ROOT, PROMPT_COUNT)
      ).to.be.revertedWithCustomError(registry, "AgentAlreadyRegistered");
    });

    it("should revert on duplicate publicId", async () => {
      const registry = await ethers.getContractAt("AgentRegistryFacet", diamondAddr);
      await registry.connect(user1).registerAgent(DID_HASH, PUBLIC_ID, AUID, NAME, DESCRIPTION, PARENT_PUBLIC_ID, MERKLE_ROOT, PROMPT_COUNT);
      const did2 = "did:ethr:0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
      const did2Hash = ethers.keccak256(ethers.toUtf8Bytes(did2));
      const publicIdHash2 = ethers.keccak256(ethers.toUtf8Bytes("user-02"));
      await registerUser(user2, did2Hash, publicIdHash2);
      await expect(
        registry.connect(user2).registerAgent(did2Hash, PUBLIC_ID, "auid-2", "Another", DESCRIPTION, PARENT_PUBLIC_ID, MERKLE_ROOT, PROMPT_COUNT)
      ).to.be.revertedWithCustomError(registry, "PublicIdAlreadyTaken");
    });

    it("should deactivate and reactivate an agent", async () => {
      const registry = await ethers.getContractAt("AgentRegistryFacet", diamondAddr);
      await registry.connect(user1).registerAgent(DID_HASH, PUBLIC_ID, AUID, NAME, DESCRIPTION, PARENT_PUBLIC_ID, MERKLE_ROOT, PROMPT_COUNT);
      const agentId = await registry.computeAgentId(DID_HASH, user1.address);

      await registry.connect(user1).deactivateAgent(agentId);
      expect(await registry.isAgentActive(agentId)).to.be.false;

      await registry.connect(user1).reactivateAgent(agentId);
      expect(await registry.isAgentActive(agentId)).to.be.true;
    });

    it("should return agents by owner", async () => {
      const registry = await ethers.getContractAt("AgentRegistryFacet", diamondAddr);
      await registry.connect(user1).registerAgent(DID_HASH, PUBLIC_ID, AUID, NAME, DESCRIPTION, PARENT_PUBLIC_ID, MERKLE_ROOT, PROMPT_COUNT);
      const agentId = await registry.computeAgentId(DID_HASH, user1.address);

      const agentIds = await registry.getAgentsByOwner(user1.address);
      expect(agentIds.length).to.equal(1);
      expect(agentIds[0]).to.equal(agentId);
    });

    it("should update Merkle root for new prompts", async () => {
      const registry = await ethers.getContractAt("AgentRegistryFacet", diamondAddr);
      await registry.connect(user1).registerAgent(DID_HASH, PUBLIC_ID, AUID, NAME, DESCRIPTION, PARENT_PUBLIC_ID, MERKLE_ROOT, PROMPT_COUNT);
      const agentId = await registry.computeAgentId(DID_HASH, user1.address);

      const newRoot = ethers.keccak256(ethers.toUtf8Bytes("updated-merkle-root"));
      await registry.connect(user1).updateMerkleRoot(agentId, newRoot, 5);

      expect(await registry.getMerkleRoot(agentId)).to.equal(newRoot);
      expect(await registry.getPromptCount(agentId)).to.equal(5);

      const history = await registry.getMerkleRootHistory(agentId);
      expect(history.length).to.equal(2);
      expect(history[0]).to.equal(MERKLE_ROOT);
      expect(history[1]).to.equal(newRoot);
    });

    it("should revert updating Merkle root with same value", async () => {
      const registry = await ethers.getContractAt("AgentRegistryFacet", diamondAddr);
      await registry.connect(user1).registerAgent(DID_HASH, PUBLIC_ID, AUID, NAME, DESCRIPTION, PARENT_PUBLIC_ID, MERKLE_ROOT, PROMPT_COUNT);
      const agentId = await registry.computeAgentId(DID_HASH, user1.address);

      await expect(
        registry.connect(user1).updateMerkleRoot(agentId, MERKLE_ROOT, PROMPT_COUNT)
      ).to.be.revertedWithCustomError(registry, "MerkleRootUnchanged");
    });

    it("should revert updating Merkle root by non-owner", async () => {
      const registry = await ethers.getContractAt("AgentRegistryFacet", diamondAddr);
      await registry.connect(user1).registerAgent(DID_HASH, PUBLIC_ID, AUID, NAME, DESCRIPTION, PARENT_PUBLIC_ID, MERKLE_ROOT, PROMPT_COUNT);
      const agentId = await registry.computeAgentId(DID_HASH, user1.address);

      const newRoot = ethers.keccak256(ethers.toUtf8Bytes("updated-merkle-root"));
      await expect(
        registry.connect(user2).updateMerkleRoot(agentId, newRoot, 5)
      ).to.be.revertedWithCustomError(registry, "NotAgentOwner");
    });

    it("should verify a prompt against Merkle root", async () => {
      const registry = await ethers.getContractAt("AgentRegistryFacet", diamondAddr);

      // Build a simple Merkle tree with 2 leaves
      const contentHash1 = ethers.keccak256(ethers.toUtf8Bytes("AGENTS.md content"));
      const contentHash2 = ethers.keccak256(ethers.toUtf8Bytes("IDENTITY.md content"));

      // Compute leaves using MerkleLib.computeLeaf: keccak256(promptName, promptType, contentHash)
      const leaf1 = ethers.keccak256(
        ethers.solidityPacked(["string", "uint8", "bytes32"], ["AGENTS.md", 0, contentHash1])
      );
      const leaf2 = ethers.keccak256(
        ethers.solidityPacked(["string", "uint8", "bytes32"], ["IDENTITY.md", 0, contentHash2])
      );

      // Compute root: parent(sorted(leaf1, leaf2))
      const [left, right] = leaf1 < leaf2 ? [leaf1, leaf2] : [leaf2, leaf1];
      const root = ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"], [left, right]));

      await registry.connect(user1).registerAgent(DID_HASH, PUBLIC_ID, AUID, NAME, DESCRIPTION, PARENT_PUBLIC_ID, root, 2);
      const agentId = await registry.computeAgentId(DID_HASH, user1.address);

      // Verify leaf1 with proof = [leaf2]
      const verified = await registry.verifyPrompt(agentId, "AGENTS.md", 0, contentHash1, [leaf2]);
      expect(verified).to.be.true;
    });

    it("should reject invalid Merkle proof", async () => {
      const registry = await ethers.getContractAt("AgentRegistryFacet", diamondAddr);

      const contentHash1 = ethers.keccak256(ethers.toUtf8Bytes("AGENTS.md content"));
      const leaf1 = ethers.keccak256(
        ethers.solidityPacked(["string", "uint8", "bytes32"], ["AGENTS.md", 0, contentHash1])
      );
      const fakeLeaf = ethers.keccak256(ethers.toUtf8Bytes("fake"));
      const [left, right] = leaf1 < fakeLeaf ? [leaf1, fakeLeaf] : [fakeLeaf, leaf1];
      const root = ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"], [left, right]));

      await registry.connect(user1).registerAgent(DID_HASH, PUBLIC_ID, AUID, NAME, DESCRIPTION, PARENT_PUBLIC_ID, root, 2);
      const agentId = await registry.computeAgentId(DID_HASH, user1.address);

      // Try to verify with wrong content hash
      const wrongHash = ethers.keccak256(ethers.toUtf8Bytes("wrong content"));
      const verified = await registry.verifyPrompt(agentId, "AGENTS.md", 0, wrongHash, [fakeLeaf]);
      expect(verified).to.be.false;
    });

    it("should revert registering with non-existent parent", async () => {
      const registry = await ethers.getContractAt("AgentRegistryFacet", diamondAddr);
      await expect(
        registry.connect(user1).registerAgent(DID_HASH, PUBLIC_ID, AUID, NAME, DESCRIPTION, "nonexistent-parent", MERKLE_ROOT, PROMPT_COUNT)
      ).to.be.revertedWithCustomError(registry, "ParentAgentNotFound");
    });

    it("should revert registering with empty name", async () => {
      const registry = await ethers.getContractAt("AgentRegistryFacet", diamondAddr);
      await expect(
        registry.connect(user1).registerAgent(DID_HASH, PUBLIC_ID, AUID, "", DESCRIPTION, PARENT_PUBLIC_ID, MERKLE_ROOT, PROMPT_COUNT)
      ).to.be.revertedWithCustomError(registry, "EmptyName");
    });

    it("should revert registering with zero Merkle root", async () => {
      const registry = await ethers.getContractAt("AgentRegistryFacet", diamondAddr);
      await expect(
        registry.connect(user1).registerAgent(DID_HASH, PUBLIC_ID, AUID, NAME, DESCRIPTION, PARENT_PUBLIC_ID, ethers.ZeroHash, PROMPT_COUNT)
      ).to.be.revertedWithCustomError(registry, "InvalidMerkleRoot");
    });

    it("should revert registering with empty description", async () => {
      const registry = await ethers.getContractAt("AgentRegistryFacet", diamondAddr);
      await expect(
        registry.connect(user1).registerAgent(DID_HASH, PUBLIC_ID, AUID, NAME, "", PARENT_PUBLIC_ID, MERKLE_ROOT, PROMPT_COUNT)
      ).to.be.revertedWithCustomError(registry, "EmptyDescription");
    });
  });

  describe("AgentValidatorFacet", () => {
    beforeEach(async () => {
      await registerUser(user1, DID_HASH, PUBLIC_ID_HASH);
    });

    it("should validate an agent with MetaMask wallet type", async () => {
      const registry = await ethers.getContractAt("AgentRegistryFacet", diamondAddr);
      const validator = await ethers.getContractAt("AgentValidatorFacet", diamondAddr);

      await registry.connect(user1).registerAgent(DID_HASH, PUBLIC_ID, AUID, NAME, DESCRIPTION, PARENT_PUBLIC_ID, MERKLE_ROOT, PROMPT_COUNT);
      const agentId = await registry.computeAgentId(DID_HASH, user1.address);

      const promptHash = ethers.keccak256(ethers.toUtf8Bytes("test-prompt"));

      const tx = await validator.connect(deployer).validateAgent(agentId, promptHash, 1); // MetaMask = 1
      const receipt = await tx.wait();
      const event = receipt.logs.find((log: any) => {
        try {
          return validator.interface.parseLog(log)?.name === "AgentValidated";
        } catch { return false; }
      });
      const parsed = validator.interface.parseLog(event);
      const vcId = parsed.args[2];

      expect(await validator.isValidated(agentId, promptHash)).to.be.true;

      const record = await validator.getValidation(vcId);
      expect(record.agentId).to.equal(agentId);
      expect(record.promptHash).to.equal(promptHash);
      expect(record.isValid).to.be.true;
    });

    it("should revert on unsupported wallet type", async () => {
      const registry = await ethers.getContractAt("AgentRegistryFacet", diamondAddr);
      const validator = await ethers.getContractAt("AgentValidatorFacet", diamondAddr);

      await registry.connect(user1).registerAgent(DID_HASH, PUBLIC_ID, AUID, NAME, DESCRIPTION, PARENT_PUBLIC_ID, MERKLE_ROOT, PROMPT_COUNT);
      const agentId = await registry.computeAgentId(DID_HASH, user1.address);

      const promptHash = ethers.keccak256(ethers.toUtf8Bytes("test-prompt"));
      await expect(
        validator.connect(deployer).validateAgent(agentId, promptHash, 3) // Coinbase = 3, not yet supported
      ).to.be.revertedWithCustomError(validator, "WalletTypeNotSupported");
    });

    it("should support adding new wallet types", async () => {
      const validator = await ethers.getContractAt("AgentValidatorFacet", diamondAddr);

      expect(await validator.isWalletTypeSupported(3)).to.be.false; // Coinbase
      await validator.setWalletTypeSupported(3, true);
      expect(await validator.isWalletTypeSupported(3)).to.be.true;
    });

    it("should revert validation for inactive agent", async () => {
      const registry = await ethers.getContractAt("AgentRegistryFacet", diamondAddr);
      const validator = await ethers.getContractAt("AgentValidatorFacet", diamondAddr);

      await registry.connect(user1).registerAgent(DID_HASH, PUBLIC_ID, AUID, NAME, DESCRIPTION, PARENT_PUBLIC_ID, MERKLE_ROOT, PROMPT_COUNT);
      const agentId = await registry.computeAgentId(DID_HASH, user1.address);
      await registry.connect(user1).deactivateAgent(agentId);

      const promptHash = ethers.keccak256(ethers.toUtf8Bytes("test-prompt"));
      await expect(
        validator.connect(deployer).validateAgent(agentId, promptHash, 1)
      ).to.be.revertedWithCustomError(validator, "AgentNotActive");
    });
  });

  describe("PausableFacet", () => {
    beforeEach(async () => {
      await registerUser(user1, DID_HASH, PUBLIC_ID_HASH);
    });

    it("should pause and unpause the diamond", async () => {
      const pausable = await ethers.getContractAt("PausableFacet", diamondAddr);
      const registry = await ethers.getContractAt("AgentRegistryFacet", diamondAddr);

      await pausable.pause();
      expect(await pausable.isPaused()).to.be.true;

      await expect(
        registry.connect(user1).registerAgent(DID_HASH, PUBLIC_ID, AUID, NAME, DESCRIPTION, PARENT_PUBLIC_ID, MERKLE_ROOT, PROMPT_COUNT)
      ).to.be.reverted;

      await pausable.unpause();
      expect(await pausable.isPaused()).to.be.false;

      await registry.connect(user1).registerAgent(DID_HASH, PUBLIC_ID, AUID, NAME, DESCRIPTION, PARENT_PUBLIC_ID, MERKLE_ROOT, PROMPT_COUNT);
    });
  });

  describe("ContractRegistryFacet", () => {
    it("should register and query a contract", async () => {
      const contractRegistry = await ethers.getContractAt("ContractRegistryFacet", diamondAddr);

      await contractRegistry.register("TestContract", 1, user2.address);
      const registeredAddr = await contractRegistry["getAddress(string)"]("TestContract");
      expect(registeredAddr).to.equal(user2.address);
      expect(await contractRegistry.getCurrentVersion("TestContract")).to.equal(1);
    });

    it("should update contract version", async () => {
      const contractRegistry = await ethers.getContractAt("ContractRegistryFacet", diamondAddr);

      await contractRegistry.register("TestContract", 1, user1.address);
      await contractRegistry.register("TestContract", 2, user2.address);

      const updatedAddr = await contractRegistry["getAddress(string)"]("TestContract");
      expect(updatedAddr).to.equal(user2.address);
      expect(await contractRegistry.getCurrentVersion("TestContract")).to.equal(2);
    });
  });

  describe("AccessControlFacet", () => {
    it("should grant a role by owner", async () => {
      const acl = await ethers.getContractAt("AccessControlFacet", diamondAddr);
      const agentRole = await acl.AGENT_ROLE();
      await acl.grantRole(agentRole, user1.address);
      expect(await acl.hasRole(agentRole, user1.address)).to.be.true;
    });

    it("should revert if non-owner grants a role", async () => {
      const acl = await ethers.getContractAt("AccessControlFacet", diamondAddr);
      const agentRole = await acl.AGENT_ROLE();
      await expect(
        acl.connect(user1).grantRole(agentRole, user2.address)
      ).to.be.revertedWithCustomError(acl, "NotContractOwner");
    });

    it("should revoke a role by owner", async () => {
      const acl = await ethers.getContractAt("AccessControlFacet", diamondAddr);
      const agentRole = await acl.AGENT_ROLE();
      await acl.grantRole(agentRole, user1.address);
      expect(await acl.hasRole(agentRole, user1.address)).to.be.true;
      await acl.revokeRole(agentRole, user1.address);
      expect(await acl.hasRole(agentRole, user1.address)).to.be.false;
    });

    it("should allow self-renunciation", async () => {
      const acl = await ethers.getContractAt("AccessControlFacet", diamondAddr);
      const agentRole = await acl.AGENT_ROLE();
      await acl.grantRole(agentRole, user1.address);
      await acl.connect(user1).renounceRole(agentRole);
      expect(await acl.hasRole(agentRole, user1.address)).to.be.false;
    });

    it("should list role members", async () => {
      const acl = await ethers.getContractAt("AccessControlFacet", diamondAddr);
      const agentRole = await acl.AGENT_ROLE();
      await acl.grantRole(agentRole, user1.address);
      await acl.grantRole(agentRole, user2.address);
      const count = await acl.getRoleMemberCount(agentRole);
      expect(count).to.equal(2);
      const members = await acl.getRoleMembers(agentRole);
      expect(members).to.include(user1.address);
      expect(members).to.include(user2.address);
    });

    it("should revert granting to zero address", async () => {
      const acl = await ethers.getContractAt("AccessControlFacet", diamondAddr);
      const agentRole = await acl.AGENT_ROLE();
      await expect(
        acl.grantRole(agentRole, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(acl, "CannotGrantToZeroAddress");
    });
  });

  describe("DiamondCut", () => {
    it("should revert if non-owner calls diamondCut", async () => {
      const diamondCut = await ethers.getContractAt("IDiamondCut", diamondAddr);
      await expect(
        diamondCut.connect(user1).diamondCut([], ethers.ZeroAddress, "0x")
      ).to.be.revertedWithCustomError(diamondCutFacet, "NotContractOwner");
    });
  });
});
