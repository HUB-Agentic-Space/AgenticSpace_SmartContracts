import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("RapportCertificateUpgradeable (UUPS)", function () {
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

  async function deployFixture() {
    const [admin, issuer, user, other, destination] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const casToken = await MockERC20.deploy("Cryptocoin Agentic Space", "CAS", 18) as any;
    await casToken.waitForDeployment();

    const Registry = await ethers.getContractFactory("ERC6551Registry");
    const registry = await Registry.deploy() as any;
    await registry.waitForDeployment();

    const Account = await ethers.getContractFactory("RapportCertificateAccount");
    const accountImplementation = await Account.deploy() as any;
    await accountImplementation.waitForDeployment();

    const Certificate = await ethers.getContractFactory(
      "RapportCertificateUpgradeable",
    );
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

    // Phase-admin functions (createPhase, setPhaseExtraFeeType,
    // setPhaseMultipleIssuance, updatePhaseMetadata, setPhasePrerequisites,
    // activatePhase, deactivatePhase) live in a separate facet reached via
    // `certificate.fallback()` + `delegatecall`, to keep the main
    // implementation under the EIP-170 size limit. Deploy it and wire it up,
    // then attach its ABI at the proxy's address so tests can call those
    // functions naturally (they execute against the proxy's storage either
    // way, since `phaseAdmin` and `certificate` are the same address).
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

    await casToken.mint(user.address, ethers.parseEther("1000"));
    await casToken.mint(admin.address, ethers.parseEther("1000"));
    await casToken.connect(admin).approve(
      await certificate.getAddress(),
      ethers.MaxUint256,
    );

    return {
      admin,
      issuer,
      user,
      other,
      destination,
      casToken,
      registry,
      accountImplementation,
      certificate,
      phaseAdmin,
      phaseAdminFacetImpl,
    };
  }

  async function buildAuthorization(
    certificate: any,
    recipient: string,
    overrides: Record<string, any> = {},
  ) {
    const nonce = await certificate.nonces(recipient);
    const now = await time.latest();
    return {
      issuanceId: ethers.keccak256(
        ethers.toUtf8Bytes(`issuance-${recipient}-${nonce}-${overrides.seed ?? "default"}`),
      ),
      recipient,
      nameHash: ethers.keccak256(ethers.toUtf8Bytes("Nome completo do titular")),
      phaseId: 1n,
      metadataHash: ethers.keccak256(ethers.toUtf8Bytes("metadata-v1")),
      casAmount: MIN_CAS,
      nonce,
      deadline: BigInt(now + 3600),
      ...overrides,
    };
  }

  async function signAuthorization(
    certificate: any,
    signer: any,
    authorization: any,
  ) {
    const network = await ethers.provider.getNetwork();
    const domain = {
      name: "RapportCertificate",
      version: "1",
      chainId: network.chainId,
      verifyingContract: await certificate.getAddress(),
    };
    const sig = await signer.signTypedData(domain, AUTH_TYPES, authorization);
    return sig;
  }

  describe("Initialization", function () {
    it("should initialize with correct name and symbol", async function () {
      const { certificate } = await loadFixture(deployFixture);
      expect(await certificate.name()).to.equal("Rapport Certificate");
      expect(await certificate.symbol()).to.equal("RPTCERT");
    });

    it("should create founder phase (phase 1) on init", async function () {
      const { certificate } = await loadFixture(deployFixture);
      const phase = await certificate.phases(1n);
      expect(phase.name).to.equal("Sócio Fundador");
      expect(phase.active).to.be.true;
      expect(phase.minCasDeposit).to.equal(MIN_CAS);
    });

    it("should grant all roles to admin", async function () {
      const { certificate, admin } = await loadFixture(deployFixture);
      const DEFAULT_ADMIN = await certificate.DEFAULT_ADMIN_ROLE();
      const ISSUER = await certificate.ISSUER_ROLE();
      const PHASE_MANAGER = await certificate.PHASE_MANAGER_ROLE();
      expect(await certificate.hasRole(DEFAULT_ADMIN, admin.address)).to.be.true;
      expect(await certificate.hasRole(ISSUER, admin.address)).to.be.true;
      expect(await certificate.hasRole(PHASE_MANAGER, admin.address)).to.be.true;
    });

    it("should revert if initialize called twice", async function () {
      const { certificate, admin, casToken, registry, accountImplementation } =
        await loadFixture(deployFixture);
      await expect(
        certificate.initialize(
          admin.address,
          await casToken.getAddress(),
          await registry.getAddress(),
          await accountImplementation.getAddress(),
          BASE_URI,
        ),
      ).to.be.revertedWithCustomError(certificate, "InvalidInitialization");
    });
  });

  describe("Phase management with fee split", function () {
    it("should create phase with extraFeeTypeId and tbaRebateBps", async function () {
      const { certificate, phaseAdmin, admin } = await loadFixture(deployFixture);
      const PHASE_MANAGER = await certificate.PHASE_MANAGER_ROLE();
      await certificate.grantRole(PHASE_MANAGER, admin.address);

      const tx = await phaseAdmin.createPhase(
        "Test Challenge",
        ethers.keccak256(ethers.toUtf8Bytes("template-v1")),
        ethers.parseEther("10"),
        0,
        0,
        "Skills desc",
        "Instructions",
        1,
        500,
      );
      await tx.wait();

      const phase = await certificate.phases(2n);
      expect(phase.name).to.equal("Test Challenge");
      expect(phase.extraFeeTypeId).to.equal(1n);
      expect(phase.tbaRebateBps).to.equal(500n);
    });

    it("should revert if tbaRebateBps > 10000", async function () {
      const { certificate, phaseAdmin, admin } = await loadFixture(deployFixture);
      const PHASE_MANAGER = await certificate.PHASE_MANAGER_ROLE();
      await certificate.grantRole(PHASE_MANAGER, admin.address);

      await expect(
        phaseAdmin.createPhase(
          "Invalid",
          ethers.keccak256(ethers.toUtf8Bytes("template")),
          ethers.parseEther("10"),
          0,
          0,
          "",
          "",
          1,
          10001,
        ),
      ).to.be.revertedWithCustomError(phaseAdmin, "InvalidRebateBps");
    });

    it("should update fee type via setPhaseExtraFeeType", async function () {
      const { certificate, phaseAdmin, admin } = await loadFixture(deployFixture);
      const PHASE_MANAGER = await certificate.PHASE_MANAGER_ROLE();
      await certificate.grantRole(PHASE_MANAGER, admin.address);

      await phaseAdmin.createPhase(
        "Fee Test",
        ethers.keccak256(ethers.toUtf8Bytes("template")),
        ethers.parseEther("10"),
        0,
        0,
        "",
        "",
        0,
        0,
      );

      await phaseAdmin.setPhaseExtraFeeType(2, 3, 750);
      const phase = await certificate.phases(2n);
      expect(phase.extraFeeTypeId).to.equal(3n);
      expect(phase.tbaRebateBps).to.equal(750n);
    });
  });

  describe("Phase-admin facet wiring", function () {
    it("reverts phase-admin calls when facet is not set", async function () {
      const { admin, casToken, registry, accountImplementation } = await loadFixture(
        deployFixture,
      );
      // Deploy a fresh proxy without wiring the facet.
      const Certificate = await ethers.getContractFactory("RapportCertificateUpgradeable");
      const bare = await upgrades.deployProxy(
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
      await bare.waitForDeployment();
      const bareAsFacet = await ethers.getContractAt(
        "RapportCertificatePhaseAdminFacet",
        await bare.getAddress(),
      ) as any;
      await expect(
        bareAsFacet.createPhase(
          "X",
          ethers.keccak256(ethers.toUtf8Bytes("t")),
          ethers.parseEther("1"),
          0,
          0,
          "",
          "",
          0,
          0,
        ),
      ).to.be.revertedWithCustomError(bare, "PhaseAdminFacetNotSet");
    });

    it("reverts setPhaseAdminFacet from non-admin", async function () {
      const { certificate, other, phaseAdminFacetImpl } = await loadFixture(deployFixture);
      await expect(
        certificate.connect(other).setPhaseAdminFacet(await phaseAdminFacetImpl.getAddress()),
      ).to.be.revertedWithCustomError(certificate, "AccessControlUnauthorizedAccount");
    });

    it("reverts setPhaseAdminFacet with a non-contract address", async function () {
      const { certificate, other } = await loadFixture(deployFixture);
      await expect(
        certificate.setPhaseAdminFacet(other.address),
      ).to.be.revertedWithCustomError(certificate, "InvalidContract");
    });
  });

  describe("Challenge prerequisites", function () {
    it("does not count a revoked certificate toward prerequisites", async function () {
      const { certificate, phaseAdmin, casToken, issuer, user } = await loadFixture(
        deployFixture,
      );
      await phaseAdmin.createPhase(
        "P2",
        ethers.keccak256(ethers.toUtf8Bytes("p2")),
        ethers.parseEther("10"),
        0,
        0,
        "",
        "",
        0,
        0,
      );
      await phaseAdmin.setPhasePrerequisites(2, [1]);
      await phaseAdmin.activatePhase(2);

      const certAddr = await certificate.getAddress();
      await casToken.connect(user).transfer(certAddr, MIN_CAS);
      await certificate.connect(user).depositCasForMint(1n);
      const authorization = await buildAuthorization(certificate, user.address, {});
      const signature = await signAuthorization(certificate, issuer, authorization);
      await certificate
        .connect(user)
        .mintCertificate(authorization, issuer.address, signature);

      // Revoking the prerequisite certificate must lock phase 2 again.
      await certificate.revokeCertificate(
        1,
        ethers.keccak256(ethers.toUtf8Bytes("reason")),
      );

      await casToken.connect(user).transfer(certAddr, ethers.parseEther("10"));
      await certificate.connect(user).depositCasForMint(2n);
      const auth2 = await buildAuthorization(certificate, user.address, {
        phaseId: 2n,
        casAmount: ethers.parseEther("10"),
        seed: "p2",
      });
      const sig2 = await signAuthorization(certificate, issuer, auth2);
      await expect(
        certificate.connect(user).mintCertificate(auth2, issuer.address, sig2),
      ).to.be.revertedWithCustomError(certificate, "PhasePrerequisitesNotMet");
    });
  });

  describe("UUPS upgrade", function () {
    it("should allow admin to upgrade", async function () {
      const { certificate, admin, casToken, registry, accountImplementation } =
        await loadFixture(deployFixture);

      const V2 = await ethers.getContractFactory("RapportCertificateUpgradeable", admin);
      const upgraded = await upgrades.upgradeProxy(
        await certificate.getAddress(),
        V2,
      );
      expect(await upgraded.name()).to.equal("Rapport Certificate");
    });

    it("should revert upgrade from non-admin", async function () {
      const { certificate, other } = await loadFixture(deployFixture);

      const V2 = await ethers.getContractFactory(
        "RapportCertificateUpgradeable",
        other,
      );
      await expect(
        upgrades.upgradeProxy(await certificate.getAddress(), V2),
      ).to.be.revertedWithCustomError(certificate, "AccessControlUnauthorizedAccount");
    });
  });

  describe("ERC-5192 soulbound lock", function () {
    it("emits Locked on mint and reports the token as locked", async function () {
      const { certificate, casToken, issuer, user } = await loadFixture(deployFixture);
      const certAddr = await certificate.getAddress();
      await casToken.connect(user).transfer(certAddr, MIN_CAS);
      await certificate.connect(user).depositCasForMint(1n);

      const authorization = await buildAuthorization(certificate, user.address, {});
      const signature = await signAuthorization(certificate, issuer, authorization);
      await expect(
        certificate.connect(user).mintCertificate(authorization, issuer.address, signature),
      ).to.emit(certificate, "Locked").withArgs(1n);
      expect(await certificate.locked(1n)).to.equal(true);
    });
  });

  describe("Soulbound (non-transferable)", function () {
    it("should revert approve", async function () {
      const { certificate, user, other } = await loadFixture(deployFixture);
      await expect(
        certificate.connect(user).approve(other.address, 1),
      ).to.be.revertedWithCustomError(certificate, "CertificateLocked");
    });

    it("should revert setApprovalForAll", async function () {
      const { certificate, user, other } = await loadFixture(deployFixture);
      await expect(
        certificate.connect(user).setApprovalForAll(other.address, true),
      ).to.be.revertedWithCustomError(certificate, "CertificateLocked");
    });
  });
});
