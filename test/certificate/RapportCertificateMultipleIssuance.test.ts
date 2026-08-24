import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("RapportCertificateUpgradeable — multiple issuance", function () {
  const MIN_CAS = ethers.parseEther("50");
  const MANTENEDOR_MIN_CAS = ethers.parseEther("10");
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

  async function deployFixture() {
    const [admin, issuer, user, other, trusted] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const casToken = await MockERC20.deploy("Cryptocoin Agentic Space", "CAS", 18) as any;
    await casToken.waitForDeployment();

    const Registry = await ethers.getContractFactory("ERC6551Registry");
    const registry = await Registry.deploy() as any;
    await registry.waitForDeployment();

    const Account = await ethers.getContractFactory("RapportCertificateAccount");
    const accountImplementation = await Account.deploy() as any;
    await accountImplementation.waitForDeployment();

    const Certificate = await ethers.getContractFactory("RapportCertificateUpgradeable");
    const certificate = await upgrades.deployProxy(
      Certificate,
      [
        admin.address,
        await casToken.getAddress(),
        await registry.getAddress(),
        await accountImplementation.getAddress(),
        BASE_URI,
      ],
      { kind: "uups", initializer: "initialize" },
    ) as any;
    await certificate.waitForDeployment();

    const issuerRole = await certificate.ISSUER_ROLE();
    await certificate.grantRole(issuerRole, issuer.address);

    const PhaseAdminFacet = await ethers.getContractFactory(
      "RapportCertificatePhaseAdminFacet",
    );
    const phaseAdminFacetImpl = await PhaseAdminFacet.deploy() as any;
    await phaseAdminFacetImpl.waitForDeployment();
    await certificate.setPhaseAdminFacet(await phaseAdminFacetImpl.getAddress());
    const phaseAdmin = await ethers.getContractAt(
      "RapportCertificatePhaseAdminFacet",
      await certificate.getAddress(),
    ) as any;

    for (const account of [user, other, trusted]) {
      await casToken.mint(account.address, ethers.parseEther("10000"));
      await casToken.connect(account).approve(
        await certificate.getAddress(),
        ethers.MaxUint256,
      );
    }

    // Create and activate a "Mantenedor" phase with multiple issuance
    // allowed: max 3 per person, 5 globally.
    await phaseAdmin.createPhase(
      "Mantenedor",
      ethers.keccak256(ethers.toUtf8Bytes("mantenedor-template-v1")),
      MANTENEDOR_MIN_CAS,
      0,
      0,
      "",
      "",
      0,
      0,
    );
    const mantenedorPhaseId = 2n;
    await phaseAdmin.setPhaseMultipleIssuance(mantenedorPhaseId, true, 3, 5);
    await phaseAdmin.activatePhase(mantenedorPhaseId);

    return {
      admin,
      issuer,
      user,
      other,
      trusted,
      casToken,
      certificate,
      phaseAdmin,
      mantenedorPhaseId,
    };
  }

  async function depositAndBuildAuthorization(
    certificate: any,
    casToken: any,
    recipient: any,
    phaseId: bigint,
    amount: bigint,
    seed: string,
  ) {
    await casToken.connect(recipient).transfer(await certificate.getAddress(), amount);
    await certificate.connect(recipient).depositCasForMint(phaseId);

    const nonce = await certificate.nonces(recipient.address);
    const now = await time.latest();
    return {
      issuanceId: ethers.keccak256(
        ethers.toUtf8Bytes(`issuance-${recipient.address}-${phaseId}-${seed}`),
      ),
      recipient: recipient.address,
      nameHash: ethers.keccak256(ethers.toUtf8Bytes("Nome completo do titular")),
      phaseId,
      metadataHash: ethers.keccak256(ethers.toUtf8Bytes(`metadata-${seed}`)),
      casAmount: amount,
      nonce,
      deadline: BigInt(now + 3600),
    };
  }

  async function signAuthorization(certificate: any, signer: any, authorization: any) {
    const network = await ethers.provider.getNetwork();
    const domain = {
      name: "RapportCertificate",
      version: "1",
      chainId: network.chainId,
      verifyingContract: await certificate.getAddress(),
    };
    return signer.signTypedData(domain, AUTH_TYPES, authorization);
  }

  async function mintOnce(
    certificate: any,
    casToken: any,
    issuer: any,
    recipient: any,
    phaseId: bigint,
    amount: bigint,
    seed: string,
  ) {
    const authorization = await depositAndBuildAuthorization(
      certificate,
      casToken,
      recipient,
      phaseId,
      amount,
      seed,
    );
    const signature = await signAuthorization(certificate, issuer, authorization);
    return certificate
      .connect(recipient)
      .mintCertificate(authorization, issuer.address, signature);
  }

  describe("setPhaseMultipleIssuance validation", function () {
    it("rejects enabling with maxPerRecipient = 0", async function () {
      const { phaseAdmin, mantenedorPhaseId } = await loadFixture(deployFixture);
      await expect(
        phaseAdmin.setPhaseMultipleIssuance(mantenedorPhaseId, true, 0, 10),
      ).to.be.revertedWithCustomError(phaseAdmin, "MultipleIssuanceConfigInvalid");
    });

    it("rejects enabling with maxTotalSupply = 0", async function () {
      const { phaseAdmin, mantenedorPhaseId } = await loadFixture(deployFixture);
      await expect(
        phaseAdmin.setPhaseMultipleIssuance(mantenedorPhaseId, true, 3, 0),
      ).to.be.revertedWithCustomError(phaseAdmin, "MultipleIssuanceConfigInvalid");
    });

    it("rejects maxTotalSupply below maxPerRecipient", async function () {
      const { phaseAdmin, mantenedorPhaseId } = await loadFixture(deployFixture);
      await expect(
        phaseAdmin.setPhaseMultipleIssuance(mantenedorPhaseId, true, 5, 3),
      ).to.be.revertedWithCustomError(phaseAdmin, "MultipleIssuanceConfigInvalid");
    });

    it("rejects lowering maxTotalSupply below already-minted count", async function () {
      const { certificate, casToken, issuer, user, other, phaseAdmin, mantenedorPhaseId } =
        await loadFixture(deployFixture);
      await mintOnce(certificate, casToken, issuer, user, mantenedorPhaseId, MANTENEDOR_MIN_CAS, "a");
      await mintOnce(certificate, casToken, issuer, other, mantenedorPhaseId, MANTENEDOR_MIN_CAS, "b");
      await expect(
        phaseAdmin.setPhaseMultipleIssuance(mantenedorPhaseId, true, 3, 1),
      ).to.be.revertedWithCustomError(phaseAdmin, "MultipleIssuanceConfigInvalid");
    });

    it("allows disabling multiple issuance regardless of caps", async function () {
      const { phaseAdmin, mantenedorPhaseId, certificate } = await loadFixture(deployFixture);
      await phaseAdmin.setPhaseMultipleIssuance(mantenedorPhaseId, false, 0, 0);
      const phase = await certificate.phases(mantenedorPhaseId);
      expect(phase.allowMultipleIssuance).to.equal(false);
    });
  });

  describe("per-recipient cap", function () {
    it("allows minting up to maxPerRecipient for the same user", async function () {
      const { certificate, casToken, issuer, user, mantenedorPhaseId } =
        await loadFixture(deployFixture);

      for (const seed of ["1", "2", "3"]) {
        await expect(
          mintOnce(certificate, casToken, issuer, user, mantenedorPhaseId, MANTENEDOR_MIN_CAS, seed),
        ).to.not.be.reverted;
      }
      expect(
        await certificate.mintCountByRecipientAndPhase(user.address, mantenedorPhaseId),
      ).to.equal(3n);
    });

    it("reverts with MaxIssuancePerRecipientReached on the 4th mint by the same user", async function () {
      const { certificate, casToken, issuer, user, mantenedorPhaseId } =
        await loadFixture(deployFixture);

      for (const seed of ["1", "2", "3"]) {
        await mintOnce(certificate, casToken, issuer, user, mantenedorPhaseId, MANTENEDOR_MIN_CAS, seed);
      }

      const authorization = await depositAndBuildAuthorization(
        certificate,
        casToken,
        user,
        mantenedorPhaseId,
        MANTENEDOR_MIN_CAS,
        "4",
      );
      const signature = await signAuthorization(certificate, issuer, authorization);
      await expect(
        certificate.connect(user).mintCertificate(authorization, issuer.address, signature),
      )
        .to.be.revertedWithCustomError(certificate, "MaxIssuancePerRecipientReached")
        .withArgs(mantenedorPhaseId, user.address, 3n);
    });
  });

  describe("global cap", function () {
    it("reverts with MaxTotalSupplyReached once the phase-wide limit is hit", async function () {
      const { certificate, casToken, issuer, user, other, trusted, admin, mantenedorPhaseId } =
        await loadFixture(deployFixture);

      // maxTotalSupply = 5. Mint 3 for `user`, 2 for `other` -> exhausts it.
      await mintOnce(certificate, casToken, issuer, user, mantenedorPhaseId, MANTENEDOR_MIN_CAS, "1");
      await mintOnce(certificate, casToken, issuer, user, mantenedorPhaseId, MANTENEDOR_MIN_CAS, "2");
      await mintOnce(certificate, casToken, issuer, user, mantenedorPhaseId, MANTENEDOR_MIN_CAS, "3");
      await mintOnce(certificate, casToken, issuer, other, mantenedorPhaseId, MANTENEDOR_MIN_CAS, "1");
      await mintOnce(certificate, casToken, issuer, other, mantenedorPhaseId, MANTENEDOR_MIN_CAS, "2");

      // A third, distinct recipient (still under their own per-recipient cap)
      // must still be rejected because the phase-wide cap (5) is exhausted.
      const authorization = await depositAndBuildAuthorization(
        certificate,
        casToken,
        trusted,
        mantenedorPhaseId,
        MANTENEDOR_MIN_CAS,
        "1",
      );
      const signature = await signAuthorization(certificate, issuer, authorization);
      await expect(
        certificate.connect(trusted).mintCertificate(authorization, issuer.address, signature),
      )
        .to.be.revertedWithCustomError(certificate, "MaxTotalSupplyReached")
        .withArgs(mantenedorPhaseId, 5n);

      const phase = await certificate.phases(mantenedorPhaseId);
      expect(phase.minted).to.equal(5n);
    });
  });

  describe("regression — single-issuance phases unaffected", function () {
    it("still reverts with CertificateAlreadyIssued on the 2nd mint for the founder phase", async function () {
      const { certificate, casToken, issuer, user } = await loadFixture(deployFixture);
      const founderPhaseId = 1n;

      await mintOnce(certificate, casToken, issuer, user, founderPhaseId, MIN_CAS, "1");

      const authorization = await depositAndBuildAuthorization(
        certificate,
        casToken,
        user,
        founderPhaseId,
        MIN_CAS,
        "2",
      );
      const signature = await signAuthorization(certificate, issuer, authorization);
      await expect(
        certificate.connect(user).mintCertificate(authorization, issuer.address, signature),
      ).to.be.revertedWithCustomError(certificate, "CertificateAlreadyIssued");
    });
  });
});
