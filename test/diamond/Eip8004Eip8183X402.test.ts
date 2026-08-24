import { expect } from "chai";
import { ethers } from "hardhat";

/**
 * Integration tests for the EIP-8004 (Trust Layer), EIP-8183 (agent
 * commerce) and x402 (pay-per-call facilitator) facets, exercised through
 * a real Diamond proxy — mirroring the pattern used by
 * test/diamond/ArbitrationFacet.test.ts.
 */
describe("EIP-8004 / EIP-8183 / x402 — Diamond integration", () => {
  let deployer: any;
  let sellerUser: any;
  let buyerUser: any;
  let validatorAccount: any;

  let diamondAddress: string;
  let casToken: any;

  let userRegistry: any;
  let agentRegistry: any;
  let identityFacet: any;
  let reputationFacet: any;
  let validationFacet: any;
  let commerceFacet: any;
  let x402Facet: any;

  let sellerAgentId: string;
  let buyerAgentId: string;

  const FEE_ONE = ethers.keccak256(ethers.toUtf8Bytes("FEE_ONE"));
  void FEE_ONE;

  async function addFacet(diamond: any, facet: any, initSelectors: string[] = [], initFn?: string) {
    const cut = [[
      await facet.getAddress(),
      0,
      facet.interface.fragments
        .filter((f: any) => f.type === "function")
        .map((f: any) => facet.interface.getFunction(f.name)!.selector),
    ]];
    const initCalldata = initFn ? facet.interface.encodeFunctionData(initFn) : "0x";
    const diamondCut = new ethers.Contract(await diamond.getAddress(), [
      "function diamondCut((address,uint8,bytes4[])[], address, bytes) external",
    ], deployer);
    await (await diamondCut.diamondCut(cut, initFn ? await facet.getAddress() : ethers.ZeroAddress, initCalldata)).wait();
    void initSelectors;
  }

  beforeEach(async () => {
    [deployer, sellerUser, buyerUser, validatorAccount] = await ethers.getSigners();

    // ---- Diamond core ----
    const DiamondCutFacet = await ethers.getContractFactory("DiamondCutFacet");
    const diamondCutFacet = await DiamondCutFacet.deploy();
    await diamondCutFacet.waitForDeployment();

    const DiamondLoupeFacet = await ethers.getContractFactory("DiamondLoupeFacet");
    const diamondLoupeFacet = await DiamondLoupeFacet.deploy();
    await diamondLoupeFacet.waitForDeployment();

    const OwnershipFacet = await ethers.getContractFactory("OwnershipFacet");
    const ownershipFacet = await OwnershipFacet.deploy();
    await ownershipFacet.waitForDeployment();

    const initialCut = [
      [
        await diamondCutFacet.getAddress(),
        0,
        [diamondCutFacet.interface.getFunction("diamondCut")!.selector],
      ],
      [
        await diamondLoupeFacet.getAddress(),
        0,
        diamondLoupeFacet.interface.fragments
          .filter((f: any) => f.type === "function")
          .map((f: any) => diamondLoupeFacet.interface.getFunction(f.name)!.selector),
      ],
      [
        await ownershipFacet.getAddress(),
        0,
        ownershipFacet.interface.fragments
          .filter((f: any) => f.type === "function")
          .map((f: any) => ownershipFacet.interface.getFunction(f.name)!.selector),
      ],
    ];

    const Diamond = await ethers.getContractFactory("Diamond");
    const diamond = await Diamond.deploy(deployer.address, initialCut);
    await diamond.waitForDeployment();
    diamondAddress = await diamond.getAddress();

    const DiamondInit = await ethers.getContractFactory("DiamondInit");
    const diamondInit = await DiamondInit.deploy();
    await diamondInit.waitForDeployment();

    const diamondCut = new ethers.Contract(diamondAddress, [
      "function diamondCut((address,uint8,bytes4[])[], address, bytes) external",
    ], deployer);
    await (await diamondCut.diamondCut([], await diamondInit.getAddress(), diamondInit.interface.encodeFunctionData("init"))).wait();

    // ---- Domain facets ----
    const UserRegistryFacet = await ethers.getContractFactory("UserRegistryFacet");
    const userRegistryImpl = await UserRegistryFacet.deploy();
    await userRegistryImpl.waitForDeployment();
    await addFacet(diamond, userRegistryImpl);

    const AgentRegistryFacet = await ethers.getContractFactory("AgentRegistryFacet");
    const agentRegistryImpl = await AgentRegistryFacet.deploy();
    await agentRegistryImpl.waitForDeployment();
    await addFacet(diamond, agentRegistryImpl);

    const PaymentFacet = await ethers.getContractFactory("PaymentFacet");
    const paymentFacetImpl = await PaymentFacet.deploy();
    await paymentFacetImpl.waitForDeployment();
    await addFacet(diamond, paymentFacetImpl);

    const IdentityRegistryFacet = await ethers.getContractFactory("IdentityRegistryFacet");
    const identityImpl = await IdentityRegistryFacet.deploy();
    await identityImpl.waitForDeployment();
    await addFacet(diamond, identityImpl);

    const ReputationRegistryFacet = await ethers.getContractFactory("ReputationRegistryFacet");
    const reputationImpl = await ReputationRegistryFacet.deploy();
    await reputationImpl.waitForDeployment();
    await addFacet(diamond, reputationImpl);

    const ValidationRegistryFacet = await ethers.getContractFactory("ValidationRegistryFacet");
    const validationImpl = await ValidationRegistryFacet.deploy();
    await validationImpl.waitForDeployment();
    await addFacet(diamond, validationImpl);

    const AgentCommerceFacet = await ethers.getContractFactory("AgentCommerceFacet");
    const commerceImpl = await AgentCommerceFacet.deploy();
    await commerceImpl.waitForDeployment();
    await addFacet(diamond, commerceImpl);

    const X402FacilitatorFacet = await ethers.getContractFactory("X402FacilitatorFacet");
    const x402Impl = await X402FacilitatorFacet.deploy();
    await x402Impl.waitForDeployment();
    await addFacet(diamond, x402Impl);

    userRegistry = new ethers.Contract(diamondAddress, userRegistryImpl.interface, deployer);
    agentRegistry = new ethers.Contract(diamondAddress, agentRegistryImpl.interface, deployer);
    identityFacet = new ethers.Contract(diamondAddress, identityImpl.interface, deployer);
    reputationFacet = new ethers.Contract(diamondAddress, reputationImpl.interface, deployer);
    validationFacet = new ethers.Contract(diamondAddress, validationImpl.interface, deployer);
    commerceFacet = new ethers.Contract(diamondAddress, commerceImpl.interface, deployer);
    x402Facet = new ethers.Contract(diamondAddress, x402Impl.interface, deployer);

    const paymentFacet = new ethers.Contract(diamondAddress, paymentFacetImpl.interface, deployer);

    // ---- CAS token + payment wiring ----
    const CASToken = await ethers.getContractFactory("CASToken");
    casToken = await CASToken.deploy();
    await casToken.waitForDeployment();
    await (await casToken["initialize(address,uint256,string,string)"](
      deployer.address,
      ethers.parseEther("1000000"),
      "Cryptocoin Agentic Space",
      "CAS",
    )).wait();

    await (await paymentFacet.setCasToken(await casToken.getAddress())).wait();
    await (await paymentFacet.setInfrastructureFund(deployer.address)).wait();
    await (await paymentFacet.initPayment()).wait();

    await (await casToken.mint(sellerUser.address, ethers.parseEther("10000"))).wait();
    await (await casToken.mint(buyerUser.address, ethers.parseEther("10000"))).wait();
    await (await casToken.connect(sellerUser).approve(diamondAddress, ethers.MaxUint256)).wait();
    await (await casToken.connect(buyerUser).approve(diamondAddress, ethers.MaxUint256)).wait();

    // ---- Grant VALIDATOR_ROLE via DiamondInit already granted to owner; add extra validator ----
    // AccessControlFacet is out of scope here — grant via a minimal ad-hoc facet call is not
    // available, so validation tests use the deployer (already VALIDATOR_ROLE via DiamondInit).
    void validatorAccount;

    // ---- Register two users + two agents (seller & buyer) ----
    const sellerDidHash = ethers.keccak256(ethers.toUtf8Bytes("did:agenticspace:seller"));
    const sellerPublicIdHash = ethers.keccak256(ethers.toUtf8Bytes("seller-public-id"));
    await (await userRegistry.connect(sellerUser).registerUser(sellerDidHash, sellerPublicIdHash, 0)).wait();

    const buyerDidHash = ethers.keccak256(ethers.toUtf8Bytes("did:agenticspace:buyer"));
    const buyerPublicIdHash = ethers.keccak256(ethers.toUtf8Bytes("buyer-public-id"));
    await (await userRegistry.connect(buyerUser).registerUser(buyerDidHash, buyerPublicIdHash, 0)).wait();

    const sellerMerkleRoot = ethers.keccak256(ethers.toUtf8Bytes("seller-prompts-root"));
    await (await agentRegistry.connect(sellerUser).registerAgent(
      sellerDidHash, "seller-agent", "AUID-SELLER", "Seller Agent", "Sells pentest reports", "", sellerMerkleRoot, 3,
    )).wait();
    sellerAgentId = await agentRegistry.computeAgentId(sellerDidHash, sellerUser.address);

    const buyerMerkleRoot = ethers.keccak256(ethers.toUtf8Bytes("buyer-prompts-root"));
    await (await agentRegistry.connect(buyerUser).registerAgent(
      buyerDidHash, "buyer-agent", "AUID-BUYER", "Buyer Agent", "Buys pentest reports", "", buyerMerkleRoot, 2,
    )).wait();
    buyerAgentId = await agentRegistry.computeAgentId(buyerDidHash, buyerUser.address);

    // ---- Init the new EIP-8004/8183/x402 facets ----
    await (await commerceFacet.initAgentCommerce(250, 3 * 24 * 60 * 60)).wait(); // 2.5% fee, 3d dispute window
    await (await x402Facet.initX402(100)).wait(); // 1% fee
  });

  describe("EIP-8004 — IdentityRegistryFacet", () => {
    it("lets the agent owner set and read the metadata URI", async () => {
      await expect(identityFacet.connect(sellerUser).setAgentMetadataURI(sellerAgentId, "https://hubagentic.space/agents/seller/agent-card.json"))
        .to.emit(identityFacet, "AgentMetadataUpdated");

      const [ownerAddress, publicId, active, uri] = await identityFacet.resolveAgent(sellerAgentId);
      expect(ownerAddress).to.equal(sellerUser.address);
      expect(publicId).to.equal("seller-agent");
      expect(active).to.equal(true);
      expect(uri).to.equal("https://hubagentic.space/agents/seller/agent-card.json");
    });

    it("rejects metadata updates from a non-owner", async () => {
      await expect(identityFacet.connect(buyerUser).setAgentMetadataURI(sellerAgentId, "https://evil.example/card.json"))
        .to.be.revertedWithCustomError(identityFacet, "NotAgentOwner");
    });
  });

  describe("EIP-8004 — ValidationRegistryFacet", () => {
    it("requests and resolves a validation", async () => {
      const workHash = ethers.keccak256(ethers.toUtf8Bytes("pentest-report-v1"));
      await expect(validationFacet.connect(sellerUser).requestValidation(sellerAgentId, workHash))
        .to.emit(validationFacet, "ValidationRequested");

      const validationId = await validationFacet.getValidationCount();
      const reportHash = ethers.keccak256(ethers.toUtf8Bytes("validation-report"));

      // deployer holds VALIDATOR_ROLE (granted by DiamondInit.init()).
      await expect(validationFacet.connect(deployer).submitValidation(validationId, true, reportHash))
        .to.emit(validationFacet, "ValidationSubmitted");

      const record = await validationFacet.getValidation(validationId);
      expect(record.resolved).to.equal(true);
      expect(record.approved).to.equal(true);
    });

    it("rejects validation submission from a non-validator", async () => {
      const workHash = ethers.keccak256(ethers.toUtf8Bytes("work"));
      await (await validationFacet.connect(sellerUser).requestValidation(sellerAgentId, workHash)).wait();
      const validationId = await validationFacet.getValidationCount();
      await expect(validationFacet.connect(buyerUser).submitValidation(validationId, true, ethers.ZeroHash))
        .to.be.revertedWithCustomError(validationFacet, "MissingRole");
    });
  });

  describe("EIP-8183 — AgentCommerceFacet", () => {
    it("runs the full happy path: offer -> negotiate -> accept -> fund -> deliver -> settle", async () => {
      const scopeHash = ethers.keccak256(ethers.toUtf8Bytes("pentest-scope-v1"));
      const price = ethers.parseEther("100");
      const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 7 * 24 * 60 * 60;

      await expect(commerceFacet.connect(sellerUser).createOffer(sellerAgentId, scopeHash, price, deadline))
        .to.emit(commerceFacet, "OfferCreated");
      const offerId = await commerceFacet.getOfferCount();

      // Buyer counters within the 50%-150% negotiation bounds.
      const counter = ethers.parseEther("90");
      await expect(commerceFacet.connect(buyerUser).negotiate(offerId, counter))
        .to.emit(commerceFacet, "OfferNegotiated");

      await expect(commerceFacet.connect(sellerUser).acceptOffer(offerId, buyerAgentId))
        .to.emit(commerceFacet, "OfferAccepted");

      const sellerBalanceBefore = await casToken.balanceOf(sellerUser.address);
      const fundBalanceBefore = await casToken.balanceOf(deployer.address);

      await expect(commerceFacet.connect(buyerUser).fundJob(offerId)).to.emit(commerceFacet, "JobFunded");
      await expect(commerceFacet.connect(sellerUser).markDelivered(offerId)).to.emit(commerceFacet, "JobDelivered");
      await expect(commerceFacet.connect(buyerUser).confirmDelivery(offerId)).to.emit(commerceFacet, "JobSettled");

      const offer = await commerceFacet.getOffer(offerId);
      expect(offer.state).to.equal(6n); // JobState.Settled

      const fee = (counter * 250n) / 10000n;
      expect(await casToken.balanceOf(sellerUser.address)).to.equal(sellerBalanceBefore + counter - fee);
      expect(await casToken.balanceOf(deployer.address)).to.equal(fundBalanceBefore + fee);
    });

    it("rejects a counter-price outside the negotiation bounds", async () => {
      const scopeHash = ethers.keccak256(ethers.toUtf8Bytes("scope"));
      const price = ethers.parseEther("100");
      const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 3600;
      await (await commerceFacet.connect(sellerUser).createOffer(sellerAgentId, scopeHash, price, deadline)).wait();
      const offerId = await commerceFacet.getOfferCount();

      await expect(commerceFacet.connect(buyerUser).negotiate(offerId, ethers.parseEther("1000")))
        .to.be.revertedWithCustomError(commerceFacet, "PriceOutOfNegotiationBounds");
    });

    it("allows the buyer to dispute and the arbiter to split the escrow", async () => {
      const scopeHash = ethers.keccak256(ethers.toUtf8Bytes("scope-dispute"));
      const price = ethers.parseEther("100");
      const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 3600;
      await (await commerceFacet.connect(sellerUser).createOffer(sellerAgentId, scopeHash, price, deadline)).wait();
      const offerId = await commerceFacet.getOfferCount();

      await (await commerceFacet.connect(buyerUser).negotiate(offerId, price)).wait();
      await (await commerceFacet.connect(sellerUser).acceptOffer(offerId, buyerAgentId)).wait();
      await (await commerceFacet.connect(buyerUser).fundJob(offerId)).wait();
      await (await commerceFacet.connect(sellerUser).markDelivered(offerId)).wait();

      const reasonHash = ethers.keccak256(ethers.toUtf8Bytes("incomplete-report"));
      await expect(commerceFacet.connect(buyerUser).raiseDispute(offerId, reasonHash)).to.emit(commerceFacet, "DisputeRaised");

      // deployer holds COMMERCE_ARBITER_ROLE (granted in initAgentCommerce).
      await expect(commerceFacet.connect(deployer).resolveDispute(offerId, 5000)).to.emit(commerceFacet, "DisputeResolved");

      const offer = await commerceFacet.getOffer(offerId);
      expect(offer.state).to.equal(8n); // JobState.Resolved
    });

    it("backs ReputationRegistryFacet feedback with a real settled job", async () => {
      const scopeHash = ethers.keccak256(ethers.toUtf8Bytes("scope-feedback"));
      const price = ethers.parseEther("50");
      const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 3600;
      await (await commerceFacet.connect(sellerUser).createOffer(sellerAgentId, scopeHash, price, deadline)).wait();
      const offerId = await commerceFacet.getOfferCount();
      await (await commerceFacet.connect(buyerUser).negotiate(offerId, price)).wait();
      await (await commerceFacet.connect(sellerUser).acceptOffer(offerId, buyerAgentId)).wait();
      await (await commerceFacet.connect(buyerUser).fundJob(offerId)).wait();
      await (await commerceFacet.connect(sellerUser).markDelivered(offerId)).wait();
      await (await commerceFacet.connect(buyerUser).confirmDelivery(offerId)).wait();

      await expect(
        reputationFacet.connect(buyerUser).submitFeedback(buyerAgentId, sellerAgentId, offerId, 95, ethers.ZeroHash),
      ).to.emit(reputationFacet, "FeedbackSubmitted");

      expect(await reputationFacet.getAverageScore(sellerAgentId)).to.equal(95n);
    });

    it("rejects feedback that is not backed by a settled job", async () => {
      await expect(
        reputationFacet.connect(buyerUser).submitFeedback(buyerAgentId, sellerAgentId, 999999, 50, ethers.ZeroHash),
      ).to.be.revertedWithCustomError(reputationFacet, "JobNotSettled");
    });
  });

  describe("x402 — X402FacilitatorFacet", () => {
    it("settles a direct pay-per-call payment", async () => {
      const requestHash = ethers.keccak256(ethers.toUtf8Bytes("req-001"));
      const amount = ethers.parseEther("5");
      const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 3600;

      const payeeBalanceBefore = await casToken.balanceOf(sellerUser.address);
      const fundBalanceBefore = await casToken.balanceOf(deployer.address);

      await expect(x402Facet.connect(buyerUser).payDirect(sellerUser.address, requestHash, amount, deadline))
        .to.emit(x402Facet, "PaymentSettled");

      const fee = (amount * 100n) / 10000n;
      expect(await casToken.balanceOf(sellerUser.address)).to.equal(payeeBalanceBefore + amount - fee);
      expect(await casToken.balanceOf(deployer.address)).to.equal(fundBalanceBefore + fee);
      expect(await x402Facet.isRequestSettled(buyerUser.address, requestHash)).to.equal(true);
    });

    it("rejects replaying the same requestHash for the same payer", async () => {
      const requestHash = ethers.keccak256(ethers.toUtf8Bytes("req-002"));
      const amount = ethers.parseEther("1");
      const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 3600;

      await (await x402Facet.connect(buyerUser).payDirect(sellerUser.address, requestHash, amount, deadline)).wait();
      await expect(x402Facet.connect(buyerUser).payDirect(sellerUser.address, requestHash, amount, deadline))
        .to.be.revertedWithCustomError(x402Facet, "RequestAlreadySettled");
    });

    it("settles a relayer-submitted EIP-712 authorized payment", async () => {
      const requestHash = ethers.keccak256(ethers.toUtf8Bytes("req-eip712-001"));
      const amount = ethers.parseEther("3");
      const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 3600;

      const domain = {
        name: "AgenticSpaceX402",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: diamondAddress,
      };
      const types = {
        X402Authorization: [
          { name: "payer", type: "address" },
          { name: "payee", type: "address" },
          { name: "requestHash", type: "bytes32" },
          { name: "amount", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      };
      const value = {
        payer: buyerUser.address,
        payee: sellerUser.address,
        requestHash,
        amount,
        deadline,
      };
      const signature = await buyerUser.signTypedData(domain, types, value);

      // deployer holds X402_RELAYER_ROLE (granted in initX402).
      await expect(
        x402Facet.connect(deployer).settleWithAuthorization(
          buyerUser.address, sellerUser.address, requestHash, amount, deadline, signature,
        ),
      ).to.emit(x402Facet, "PaymentSettled");

      expect(await x402Facet.isRequestSettled(buyerUser.address, requestHash)).to.equal(true);
    });

    it("rejects an authorization signed by someone other than the declared payer", async () => {
      const requestHash = ethers.keccak256(ethers.toUtf8Bytes("req-eip712-bad"));
      const amount = ethers.parseEther("1");
      const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 3600;

      const domain = {
        name: "AgenticSpaceX402",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: diamondAddress,
      };
      const types = {
        X402Authorization: [
          { name: "payer", type: "address" },
          { name: "payee", type: "address" },
          { name: "requestHash", type: "bytes32" },
          { name: "amount", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      };
      const value = { payer: buyerUser.address, payee: sellerUser.address, requestHash, amount, deadline };
      // Signed by sellerUser instead of the declared payer (buyerUser).
      const signature = await sellerUser.signTypedData(domain, types, value);

      await expect(
        x402Facet.connect(deployer).settleWithAuthorization(
          buyerUser.address, sellerUser.address, requestHash, amount, deadline, signature,
        ),
      ).to.be.revertedWithCustomError(x402Facet, "InvalidSignature");
    });

    it("rejects settleWithAuthorization from a non-relayer", async () => {
      const requestHash = ethers.keccak256(ethers.toUtf8Bytes("req-eip712-role"));
      const amount = ethers.parseEther("1");
      const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 3600;
      const domain = {
        name: "AgenticSpaceX402",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: diamondAddress,
      };
      const types = {
        X402Authorization: [
          { name: "payer", type: "address" },
          { name: "payee", type: "address" },
          { name: "requestHash", type: "bytes32" },
          { name: "amount", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      };
      const value = { payer: buyerUser.address, payee: sellerUser.address, requestHash, amount, deadline };
      const signature = await buyerUser.signTypedData(domain, types, value);

      await expect(
        x402Facet.connect(buyerUser).settleWithAuthorization(
          buyerUser.address, sellerUser.address, requestHash, amount, deadline, signature,
        ),
      ).to.be.revertedWithCustomError(x402Facet, "MissingRole");
    });
  });
});
