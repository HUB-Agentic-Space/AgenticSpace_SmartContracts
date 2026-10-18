import { expect } from "chai";
import { ethers } from "hardhat";

/**
 * REQ-QR-CLAIM-001/002/003: validates atomic voucher transfer, replay protection,
 * signer authorization, campaign accounting, and ERC-5192 soulbound issuance.
 */
describe("ClaimVaultFacet and ClaimNFTFacet", () => {
  let owner: any;
  let claimSigner: any;
  let relayer: any;
  let recipient: any;
  let attacker: any;
  let diamondAddress: string;
  let vault: any;
  let nft: any;
  let token: any;

  function selectors(contract: any): string[] {
    return contract.interface.fragments
      .filter((fragment: any) => fragment.type === "function")
      .map((fragment: any) => contract.interface.getFunction(fragment.format("sighash"))!.selector);
  }

  async function addFacet(diamondCut: any, facet: any) {
    await (await diamondCut.diamondCut([{
      facetAddress: await facet.getAddress(),
      action: 0,
      functionSelectors: selectors(facet),
    }], ethers.ZeroAddress, "0x")).wait();
  }

  beforeEach(async () => {
    [owner, claimSigner, relayer, recipient, attacker] = await ethers.getSigners();

    const DiamondCutFacet = await ethers.getContractFactory("DiamondCutFacet");
    const cutFacet = await DiamondCutFacet.deploy();
    await cutFacet.waitForDeployment();

    const Diamond = await ethers.getContractFactory("Diamond");
    const diamond = await Diamond.deploy(owner.address, [{
      facetAddress: await cutFacet.getAddress(),
      action: 0,
      functionSelectors: selectors(cutFacet),
    }]);
    await diamond.waitForDeployment();
    diamondAddress = await diamond.getAddress();
    const diamondCut = await ethers.getContractAt("IDiamondCut", diamondAddress);

    const DiamondLoupeFacet = await ethers.getContractFactory("DiamondLoupeFacet");
    const loupeImpl = await DiamondLoupeFacet.deploy();
    await loupeImpl.waitForDeployment();
    await addFacet(diamondCut, loupeImpl);

    const ClaimVaultFacet = await ethers.getContractFactory("ClaimVaultFacet");
    const vaultImpl = await ClaimVaultFacet.deploy();
    await vaultImpl.waitForDeployment();
    await addFacet(diamondCut, vaultImpl);

    const ClaimNFTFacet = await ethers.getContractFactory("ClaimNFTFacet");
    const nftImpl = await ClaimNFTFacet.deploy();
    await nftImpl.waitForDeployment();
    await addFacet(diamondCut, nftImpl);

    vault = await ethers.getContractAt("ClaimVaultFacet", diamondAddress);
    nft = await ethers.getContractAt("ClaimNFTFacet", diamondAddress);
    await (await vault.initClaimVault(claimSigner.address)).wait();
    await (await nft.initClaimNFT("Rapport Claim", "RCLAIM", "https://hubagentic.space/api/v1/nft/claim/")).wait();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    token = await MockERC20.deploy("CAS Test", "CAST", 18);
    await token.waitForDeployment();
    await (await vault.setClaimAssetSupport(await token.getAddress(), true)).wait();
    await (await token.mint(owner.address, ethers.parseEther("100"))).wait();
    await (await token.approve(diamondAddress, ethers.parseEther("100"))).wait();
    await (await vault.depositAsset(await token.getAddress(), ethers.parseEther("100"))).wait();
  });

  async function authorization(overrides: Record<string, any> = {}) {
    const latest = await ethers.provider.getBlock("latest");
    return {
      voucherId: ethers.keccak256(ethers.toUtf8Bytes("voucher-1")),
      campaignId: ethers.keccak256(ethers.toUtf8Bytes("campaign-1")),
      recipient: recipient.address,
      asset: await token.getAddress(),
      amount: ethers.parseEther("10"),
      nonce: 1n,
      deadline: BigInt(latest!.timestamp + 3600),
      ...overrides,
    };
  }

  async function sign(auth: any, signer = claimSigner) {
    const network = await ethers.provider.getNetwork();
    return signer.signTypedData(
      {
        name: "RapportClaimVault",
        version: "1",
        chainId: network.chainId,
        verifyingContract: diamondAddress,
      },
      {
        ClaimAuthorization: [
          { name: "voucherId", type: "bytes32" },
          { name: "campaignId", type: "bytes32" },
          { name: "recipient", type: "address" },
          { name: "asset", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      auth,
    );
  }

  it("REQ-QR-CLAIM-001 transfers CAS and atomically mints exactly one locked NFT", async () => {
    const auth = await authorization();
    await (await vault.reserveCampaign(auth.campaignId, auth.asset, auth.amount)).wait();

    await expect(vault.connect(relayer).claim(auth, await sign(auth)))
      .to.emit(vault, "VoucherClaimed")
      .withArgs(auth.voucherId, auth.campaignId, recipient.address, auth.asset, auth.amount, 1n);

    expect(await token.balanceOf(recipient.address)).to.equal(auth.amount);
    expect(await nft.ownerOf(1n)).to.equal(recipient.address);
    expect(await nft.balanceOf(recipient.address)).to.equal(1n);
    expect(await nft.locked(1n)).to.equal(true);
    expect(await nft.tokenOfVoucher(auth.voucherId)).to.equal(1n);
    expect(await vault.isVoucherClaimed(auth.voucherId)).to.equal(true);
    expect(await vault.isNonceUsed(auth.nonce)).to.equal(true);
  });

  it("REQ-QR-CLAIM-002 rejects voucher and nonce replay", async () => {
    const auth = await authorization();
    await (await vault.reserveCampaign(auth.campaignId, auth.asset, auth.amount * 2n)).wait();
    const signature = await sign(auth);
    await (await vault.connect(relayer).claim(auth, signature)).wait();

    await expect(vault.connect(relayer).claim(auth, signature))
      .to.be.revertedWithCustomError(vault, "VoucherAlreadyClaimed");

    const second = await authorization({
      voucherId: ethers.keccak256(ethers.toUtf8Bytes("voucher-2")),
    });
    await expect(vault.connect(relayer).claim(second, await sign(second)))
      .to.be.revertedWithCustomError(vault, "NonceAlreadyUsed");
  });

  it("REQ-QR-CLAIM-003 rejects forged signatures without consuming state", async () => {
    const auth = await authorization();
    await (await vault.reserveCampaign(auth.campaignId, auth.asset, auth.amount)).wait();

    await expect(vault.connect(relayer).claim(auth, await sign(auth, attacker)))
      .to.be.revertedWithCustomError(vault, "InvalidClaimSignature");
    expect(await vault.isVoucherClaimed(auth.voucherId)).to.equal(false);
    expect(await nft.tokenOfVoucher(auth.voucherId)).to.equal(0n);
  });

  it("REQ-QR-CLAIM-004 prevents transfers and approvals of claim NFTs", async () => {
    const auth = await authorization();
    await (await vault.reserveCampaign(auth.campaignId, auth.asset, auth.amount)).wait();
    await (await vault.connect(relayer).claim(auth, await sign(auth))).wait();

    await expect(nft.connect(recipient).transferFrom(recipient.address, attacker.address, 1n))
      .to.be.revertedWithCustomError(nft, "Soulbound");
    await expect(nft.connect(recipient).approve(attacker.address, 1n))
      .to.be.revertedWithCustomError(nft, "Soulbound");
    const loupe = await ethers.getContractAt("DiamondLoupeFacet", diamondAddress);
    expect(await loupe.supportsInterface("0xb45a3c0e")).to.equal(true);
    expect(await loupe.supportsInterface("0x80ac58cd")).to.equal(true);
  });

  it("REQ-QR-CLAIM-005 enforces vault-backed campaign reservations", async () => {
    const auth = await authorization({ amount: ethers.parseEther("101") });
    await expect(vault.reserveCampaign(auth.campaignId, auth.asset, auth.amount))
      .to.be.revertedWithCustomError(vault, "InsufficientAvailableBalance");
  });

  it("REQ-QR-CLAIM-006 rejects expired and mismatched-asset authorizations", async () => {
    const auth = await authorization();
    await (await vault.reserveCampaign(auth.campaignId, auth.asset, auth.amount)).wait();

    const expired = await authorization({ deadline: 1n });
    await expect(vault.connect(relayer).claim(expired, await sign(expired)))
      .to.be.revertedWithCustomError(vault, "ClaimExpired");

    const wrongAsset = await authorization({ asset: attacker.address });
    await expect(vault.connect(relayer).claim(wrongAsset, await sign(wrongAsset)))
      .to.be.revertedWithCustomError(vault, "WrongCampaignAsset");
  });

  it("REQ-QR-CLAIM-007 supports native POL claims end to end", async () => {
    const amount = ethers.parseEther("1");
    await (await owner.sendTransaction({ to: diamondAddress, value: 0 })).wait();
    await (await vault.depositNative({ value: amount * 2n })).wait();

    const auth = await authorization({ asset: ethers.ZeroAddress, amount });
    await (await vault.reserveCampaign(auth.campaignId, ethers.ZeroAddress, amount)).wait();

    const before = await ethers.provider.getBalance(recipient.address);
    await (await vault.connect(relayer).claim(auth, await sign(auth))).wait();
    expect(await ethers.provider.getBalance(recipient.address)).to.equal(before + amount);
    expect(await nft.ownerOf(1n)).to.equal(recipient.address);
  });

  it("REQ-QR-CLAIM-008 blocks claims while paused or campaign released", async () => {
    const auth = await authorization();
    await (await vault.reserveCampaign(auth.campaignId, auth.asset, auth.amount)).wait();

    await (await vault.setClaimsPaused(true)).wait();
    await expect(vault.connect(relayer).claim(auth, await sign(auth)))
      .to.be.revertedWithCustomError(vault, "ClaimsPaused");
    await (await vault.setClaimsPaused(false)).wait();

    await (await vault.releaseCampaign(auth.campaignId)).wait();
    await expect(vault.connect(relayer).claim(auth, await sign(auth)))
      .to.be.revertedWithCustomError(vault, "CampaignNotActive");
  });

  it("REQ-QR-CLAIM-009 restricts withdraw to uncommitted funds and owner", async () => {
    const auth = await authorization();
    await (await vault.reserveCampaign(auth.campaignId, auth.asset, ethers.parseEther("60"))).wait();

    await expect(vault.withdrawUncommitted(auth.asset, ethers.parseEther("41"), owner.address))
      .to.be.revertedWithCustomError(vault, "InsufficientAvailableBalance");
    await expect(vault.connect(attacker).withdrawUncommitted(auth.asset, 1n, attacker.address))
      .to.be.revertedWithCustomError(vault, "NotContractOwner");

    await (await vault.withdrawUncommitted(auth.asset, ethers.parseEther("40"), owner.address)).wait();
    const [, committed] = await vault.getVaultBalance(auth.asset);
    expect(committed).to.equal(ethers.parseEther("60"));
  });

  it("REQ-QR-CLAIM-010 keeps Diamond ERC-165 and loupe interfaces working", async () => {
    const loupe = await ethers.getContractAt("DiamondLoupeFacet", diamondAddress);
    expect(await loupe.supportsInterface("0x01ffc9a7")).to.equal(true);
    const facets = await loupe.facets();
    const addresses = facets.map((f: any) => f.facetAddress.toLowerCase());
    expect(addresses.length).to.be.greaterThan(2);
  });
});
