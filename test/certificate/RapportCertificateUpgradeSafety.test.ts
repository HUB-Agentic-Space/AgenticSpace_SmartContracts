import { expect } from "chai";
import { ethers, upgrades } from "hardhat";

/**
 * Simulates the real mainnet upgrade path: the contract currently verified
 * and deployed on Polygon mainnet (`RapportCertificateUpgradeableDeployedV0`,
 * a verbatim copy of the Polygonscan-verified source) is deployed, given
 * some real state (phases, a minted certificate, a CAS deposit), then
 * upgraded to the new split implementation (`RapportCertificateUpgradeable`
 * + `RapportCertificatePhaseAdminFacet`). The test asserts:
 *   1. `upgrades.upgradeProxy` accepts the new implementation without a
 *      storage-layout incompatibility error (the plugin's own static check).
 *   2. Pre-upgrade state (phase 1, phase 2, the minted certificate, the CAS
 *      deposit) is read back identically after the upgrade.
 *   3. New functionality (phase-admin facet, multiple issuance) works
 *      immediately afterwards on top of the pre-existing state.
 */
describe("RapportCertificateUpgradeable — upgrade safety (mainnet-shaped)", function () {
  const MIN_CAS = ethers.parseEther("50");
  const BASE_URI =
    "https://agenticspace.rapport.tec.br/api/v1/certificates/token/";

  const AUTH_TYPES = {
    CertificateMintAuthorization: [
      { name: "issuanceId", type: "bytes32" },
      { name: "recipient", type: "address" },
      { name: "nameHash", type: "bytes32" },
      { name: "phaseId", type: "uint256" },
      { name: "metadataHash", type: "bytes32" },
      { name: "casAmount", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };

  it("preserves phases, certificates and CAS deposits across the split upgrade", async function () {
    const [admin, issuer, user] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const casToken = await MockERC20.deploy("Cryptocoin Agentic Space", "CAS", 18) as any;
    await casToken.waitForDeployment();

    const Registry = await ethers.getContractFactory("ERC6551Registry");
    const registry = await Registry.deploy() as any;
    await registry.waitForDeployment();

    const Account = await ethers.getContractFactory("RapportCertificateAccount");
    const accountImplementation = await Account.deploy() as any;
    await accountImplementation.waitForDeployment();

    // 1) Deploy the contract shaped exactly like what's verified on
    //    mainnet today (pre-multiple-issuance, pre-facet-split).
    const V0 = await ethers.getContractFactory("RapportCertificateUpgradeableDeployedV0");
    const proxy = await upgrades.deployProxy(
      V0,
      [
        admin.address,
        await casToken.getAddress(),
        await registry.getAddress(),
        await accountImplementation.getAddress(),
        BASE_URI,
      ],
      { kind: "uups", initializer: "initialize" },
    ) as any;
    await proxy.waitForDeployment();
    const proxyAddress = await proxy.getAddress();

    const issuerRole = await proxy.ISSUER_ROLE();
    await proxy.grantRole(issuerRole, issuer.address);

    // Create a second (challenge-style) phase using the V0 ABI directly.
    await proxy.createPhase(
      "Desafio Pré-Upgrade",
      ethers.keccak256(ethers.toUtf8Bytes("template-pre-upgrade")),
      ethers.parseEther("10"),
      0,
      0,
      "",
      "",
      0,
      0,
    );
    await proxy.activatePhase(2);

    // Mint a founder certificate (phase 1) before the upgrade.
    await casToken.mint(user.address, ethers.parseEther("1000"));
    await casToken.connect(user).approve(proxyAddress, ethers.MaxUint256);
    await casToken.connect(user).transfer(proxyAddress, MIN_CAS);
    await proxy.connect(user).depositCasForMint(1);

    const network = await ethers.provider.getNetwork();
    const domain = {
      name: "RapportCertificate",
      version: "1",
      chainId: network.chainId,
      verifyingContract: proxyAddress,
    };
    const authorization = {
      issuanceId: ethers.keccak256(ethers.toUtf8Bytes("pre-upgrade-issuance")),
      recipient: user.address,
      nameHash: ethers.keccak256(ethers.toUtf8Bytes("Nome Pré-Upgrade")),
      phaseId: 1n,
      metadataHash: ethers.keccak256(ethers.toUtf8Bytes("metadata-pre-upgrade")),
      casAmount: MIN_CAS,
      nonce: await proxy.nonces(user.address),
      deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
    };
    const signature = await issuer.signTypedData(domain, AUTH_TYPES, authorization);
    await proxy.connect(user).mintCertificate(authorization, issuer.address, signature);

    // Leave a dangling CAS deposit on phase 2 too, to verify mappings survive.
    await casToken.connect(user).transfer(proxyAddress, ethers.parseEther("5"));
    await proxy.connect(user).depositCasForMint(2);

    const phase1Before = await proxy.phases(1);
    const phase2Before = await proxy.phases(2);
    const certBefore = await proxy.certificates(1);
    const depositPhase2Before = await proxy.casDeposits(user.address, 2);

    // 2) Upgrade to the new split implementation. This is the exact same
    //    call the mainnet upgrade script uses
    //    (scripts/utils/upgrade_contract.ts / upgrade_certificate_via_safe.ts).
    const NewImpl = await ethers.getContractFactory("RapportCertificateUpgradeable");
    const upgraded = await upgrades.upgradeProxy(proxyAddress, NewImpl, {
      unsafeSkipStorageCheck: false,
    }) as any;
    await upgraded.waitForDeployment();

    // 3) Pre-existing state must read back identically.
    const phase1After = await upgraded.phases(1);
    const phase2After = await upgraded.phases(2);
    const certAfter = await upgraded.certificates(1);
    const depositPhase2After = await upgraded.casDeposits(user.address, 2);

    expect(phase1After.name).to.equal(phase1Before.name);
    expect(phase1After.minCasDeposit).to.equal(phase1Before.minCasDeposit);
    expect(phase1After.minted).to.equal(phase1Before.minted);
    expect(phase1After.allowMultipleIssuance).to.equal(false);
    expect(phase1After.maxPerRecipient).to.equal(0n);
    expect(phase1After.maxTotalSupply).to.equal(0n);

    expect(phase2After.name).to.equal(phase2Before.name);
    expect(phase2After.active).to.equal(phase2Before.active);

    expect(certAfter.recipient).to.equal(certBefore.recipient);
    expect(certAfter.casDeposited).to.equal(certBefore.casDeposited);
    expect(certAfter.tokenBoundAccount).to.equal(certBefore.tokenBoundAccount);

    expect(depositPhase2After).to.equal(depositPhase2Before);
    expect(await upgraded.certificatesByRecipientAndPhase(user.address, 1)).to.equal(1n);
    // mintCountByRecipientAndPhase only starts being populated by mints that
    // happen AFTER this upgrade (it did not exist in V0), so it correctly
    // reads 0 for the certificate minted before the upgrade.
    expect(await upgraded.mintCountByRecipientAndPhase(user.address, 1)).to.equal(0n);

    // 4) New functionality works immediately on top of the pre-existing
    //    state: wire the phase-admin facet and enable multiple issuance on
    //    the pre-existing challenge phase (phase 2).
    const PhaseAdminFacet = await ethers.getContractFactory(
      "RapportCertificatePhaseAdminFacet",
    );
    const facetImpl = await PhaseAdminFacet.deploy() as any;
    await facetImpl.waitForDeployment();
    await upgraded.setPhaseAdminFacet(await facetImpl.getAddress());

    const phaseAdmin = await ethers.getContractAt(
      "RapportCertificatePhaseAdminFacet",
      proxyAddress,
    ) as any;
    await phaseAdmin.setPhaseMultipleIssuance(2, true, 3, 10);
    const phase2AfterMultiIssuance = await upgraded.phases(2);
    expect(phase2AfterMultiIssuance.allowMultipleIssuance).to.equal(true);
    expect(phase2AfterMultiIssuance.maxPerRecipient).to.equal(3n);
    expect(phase2AfterMultiIssuance.maxTotalSupply).to.equal(10n);

    // Existing challenge functions reached via the facet still work too.
    await phaseAdmin.updatePhaseMetadata(2, "Skills pós-upgrade", "Instruções pós-upgrade");
    const phase2AfterMetadata = await upgraded.phases(2);
    expect(phase2AfterMetadata.skillsDescription).to.equal("Skills pós-upgrade");
  });
});
