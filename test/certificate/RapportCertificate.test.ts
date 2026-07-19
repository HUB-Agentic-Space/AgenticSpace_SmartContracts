import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("RapportCertificate (ERC-721 + ERC-6551)", function () {
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
    const casToken = await MockERC20.deploy("Criptocoin Agentic Space", "CAS", 18) as any;
    await casToken.waitForDeployment();

    const Registry = await ethers.getContractFactory("ERC6551Registry");
    const registry = await Registry.deploy() as any;
    await registry.waitForDeployment();

    const Account = await ethers.getContractFactory("RapportCertificateAccount");
    const accountImplementation = await Account.deploy() as any;
    await accountImplementation.waitForDeployment();

    const Certificate = await ethers.getContractFactory("RapportCertificate");
    const certificate = await Certificate.deploy(
      admin.address,
      await casToken.getAddress(),
      await registry.getAddress(),
      await accountImplementation.getAddress(),
      BASE_URI,
    ) as any;
    await certificate.waitForDeployment();

    const issuerRole = await certificate.ISSUER_ROLE();
    await certificate.grantRole(issuerRole, issuer.address);

    await casToken.mint(user.address, ethers.parseEther("1000"));
    await casToken.mint(admin.address, ethers.parseEther("1000"));
    // grantCasBonus uses transferFrom internally — admin must approve.
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
    return signer.signTypedData(domain, AUTH_TYPES, authorization);
  }

  async function depositAndMint(
    fixture: Awaited<ReturnType<typeof deployFixture>>,
    signer: any = fixture.user,
    recipient: string = fixture.user.address,
  ) {
    const authorization = await buildAuthorization(
      fixture.certificate,
      recipient,
    );
    const signature = await signAuthorization(
      fixture.certificate,
      fixture.issuer,
      authorization,
    );
    const certAddr = await fixture.certificate.getAddress();
    // Step 1: transfer CAS to the certificate contract
    const transferTx = await fixture.casToken
      .connect(signer)
      .transfer(certAddr, authorization.casAmount);
    await transferTx.wait();
    // Step 2: register the deposit
    const depositTx = await fixture.certificate
      .connect(signer)
      .depositCasForMint(authorization.phaseId);
    await depositTx.wait();
    // Step 3: mint the certificate
    const tx = await fixture.certificate
      .connect(signer)
      .mintCertificate(authorization, fixture.issuer.address, signature);
    await tx.wait();
    return { authorization, signature, tokenId: 1n };
  }

  async function mintDefault(fixture: Awaited<ReturnType<typeof deployFixture>>) {
    return depositAndMint(fixture);
  }

  describe("initial configuration", function () {
    it("creates and activates the Sócio Fundador phase with a 50 CAS minimum", async function () {
      const { certificate } = await loadFixture(deployFixture);
      const phase = await certificate.getPhase(1);

      expect(await certificate.currentPhaseId()).to.equal(1);
      expect(await certificate.phaseCount()).to.equal(1);
      expect(phase.name).to.equal("Sócio Fundador");
      expect(phase.minCasDeposit).to.equal(MIN_CAS);
      expect(phase.active).to.equal(true);
      expect(phase.minted).to.equal(0);
    });

    it("exposes issuer identity and ERC-5192 support", async function () {
      const { certificate } = await loadFixture(deployFixture);

      expect(await certificate.ISSUER_LEGAL_NAME()).to.equal(
        "Raport Tecnologia Inova Simples",
      );
      expect(await certificate.ISSUER_CNPJ()).to.equal("67.904.299/0001-80");
      expect(await certificate.supportsInterface("0xb45a3c0e")).to.equal(true);
    });
  });

  describe("one-time CAS bonus", function () {
    it("returns the phase minimum to the holder without touching the TBA", async function () {
      const fixture = await loadFixture(deployFixture);
      const { admin, certificate, casToken, user } = fixture;
      await mintDefault(fixture);

      const account = await certificate.tokenBoundAccount(1);
      const holderBalanceBefore = await casToken.balanceOf(user.address);
      const payerBalanceBefore = await casToken.balanceOf(admin.address);
      const tbaBalanceBefore = await casToken.balanceOf(account);

      await expect(certificate.connect(admin).grantCasBonus(1))
        .to.emit(certificate, "CasBonusGranted")
        .withArgs(1, user.address, admin.address, MIN_CAS);

      expect(await certificate.casBonusGranted(1)).to.equal(true);
      expect(await casToken.balanceOf(user.address)).to.equal(
        holderBalanceBefore + MIN_CAS,
      );
      expect(await casToken.balanceOf(admin.address)).to.equal(
        payerBalanceBefore - MIN_CAS,
      );
      expect(await casToken.balanceOf(account)).to.equal(tbaBalanceBefore);
      expect((await certificate.getCertificate(1)).casDeposited).to.equal(MIN_CAS);
    });

    it("caps the bonus at the phase minimum when the holder deposits more CAS", async function () {
      const fixture = await loadFixture(deployFixture);
      const { admin, certificate, casToken, issuer, user } = fixture;
      const largerDeposit = ethers.parseEther("75");
      const authorization = await buildAuthorization(certificate, user.address, {
        casAmount: largerDeposit,
        seed: "larger-reserve",
      });
      const certAddr = await certificate.getAddress();
      await casToken.connect(user).transfer(certAddr, largerDeposit);
      await certificate.connect(user).depositCasForMint(authorization.phaseId);
      await certificate.connect(user).mintCertificate(
        authorization,
        issuer.address,
        await signAuthorization(certificate, issuer, authorization),
      );

      await casToken.connect(admin).approve(certAddr, MIN_CAS);

      const account = await certificate.tokenBoundAccount(1);
      const holderBalanceBefore = await casToken.balanceOf(user.address);
      const payerBalanceBefore = await casToken.balanceOf(admin.address);

      await expect(certificate.connect(admin).grantCasBonus(1))
        .to.emit(certificate, "CasBonusGranted")
        .withArgs(1, user.address, admin.address, MIN_CAS);

      expect((await certificate.getCertificate(1)).casDeposited).to.equal(largerDeposit);
      expect(await casToken.balanceOf(account)).to.equal(largerDeposit);
      expect(await casToken.balanceOf(user.address)).to.equal(
        holderBalanceBefore + MIN_CAS,
      );
      expect(await casToken.balanceOf(admin.address)).to.equal(
        payerBalanceBefore - MIN_CAS,
      );
    });

    it("rejects a bonus for a revoked certificate without consuming eligibility", async function () {
      const fixture = await loadFixture(deployFixture);
      const { certificate } = fixture;
      await mintDefault(fixture);
      await certificate.revokeCertificate(
        1,
        ethers.keccak256(ethers.toUtf8Bytes("revoked-before-bonus")),
      );

      await expect(certificate.grantCasBonus(1))
        .to.be.revertedWithCustomError(certificate, "CertificateIsRevoked")
        .withArgs(1);
      expect(await certificate.casBonusGranted(1)).to.equal(false);
    });

    it("rejects an unauthorized payer and preserves bonus eligibility", async function () {
      const fixture = await loadFixture(deployFixture);
      const { certificate, other } = fixture;
      await mintDefault(fixture);

      await expect(
        certificate.connect(other).grantCasBonus(1),
      ).to.be.revertedWithCustomError(
        certificate,
        "AccessControlUnauthorizedAccount",
      );
      expect(await certificate.casBonusGranted(1)).to.equal(false);
    });

    it("prevents a second bonus for the same certificate", async function () {
      const fixture = await loadFixture(deployFixture);
      const { certificate, casToken, admin } = fixture;
      await mintDefault(fixture);

      await casToken.connect(admin).approve(await certificate.getAddress(), MIN_CAS);
      await certificate.connect(admin).grantCasBonus(1);
      await expect(certificate.connect(admin).grantCasBonus(1))
        .to.be.revertedWithCustomError(certificate, "CasBonusAlreadyGranted")
        .withArgs(1);
    });

    it("rolls back the bonus flag when allowance is missing and honors pause", async function () {
      const fixture = await loadFixture(deployFixture);
      const { admin, certificate, casToken } = fixture;
      await mintDefault(fixture);

      await casToken.connect(admin).approve(await certificate.getAddress(), 0);
      await expect(certificate.connect(admin).grantCasBonus(1)).to.be.reverted;
      expect(await certificate.casBonusGranted(1)).to.equal(false);

      await certificate.pause();
      await expect(
        certificate.connect(admin).grantCasBonus(1),
      ).to.be.revertedWithCustomError(certificate, "EnforcedPause");
      expect(await certificate.casBonusGranted(1)).to.equal(false);
    });

    it("rejects a fee-on-transfer bonus shortfall atomically", async function () {
      const fixture = await loadFixture(deployFixture);
      const { admin, issuer, user, registry, accountImplementation } = fixture;
      const FeeToken = await ethers.getContractFactory("MockToggleFeeERC20");
      const feeToken = await FeeToken.deploy() as any;
      await feeToken.waitForDeployment();

      const Certificate = await ethers.getContractFactory("RapportCertificate");
      const guardedCertificate = await Certificate.deploy(
        admin.address,
        await feeToken.getAddress(),
        await registry.getAddress(),
        await accountImplementation.getAddress(),
        BASE_URI,
      ) as any;
      await guardedCertificate.waitForDeployment();
      await guardedCertificate.grantRole(
        await guardedCertificate.ISSUER_ROLE(),
        issuer.address,
      );

      await feeToken.mint(user.address, MIN_CAS);
      await feeToken.mint(admin.address, MIN_CAS);
      await feeToken.connect(admin).approve(
        await guardedCertificate.getAddress(),
        MIN_CAS,
      );

      const authorization = await buildAuthorization(
        guardedCertificate,
        user.address,
        { seed: "bonus-fee-token" },
      );
      const guardedCertAddr = await guardedCertificate.getAddress();
      await feeToken.connect(user).transfer(guardedCertAddr, MIN_CAS);
      await guardedCertificate.connect(user).depositCasForMint(authorization.phaseId);
      await guardedCertificate.connect(user).mintCertificate(
        authorization,
        issuer.address,
        await signAuthorization(guardedCertificate, issuer, authorization),
      );
      const account = await guardedCertificate.tokenBoundAccount(1);

      await feeToken.setFeeEnabled(true);
      await expect(guardedCertificate.connect(admin).grantCasBonus(1))
        .to.be.revertedWithCustomError(
          guardedCertificate,
          "CasBonusTransferMismatch",
        )
        .withArgs(MIN_CAS, MIN_CAS - (MIN_CAS / 100n));

      expect(await guardedCertificate.casBonusGranted(1)).to.equal(false);
      expect(await feeToken.balanceOf(admin.address)).to.equal(MIN_CAS);
      expect(await feeToken.balanceOf(user.address)).to.equal(0);
      expect(await feeToken.balanceOf(account)).to.equal(MIN_CAS);
    });
  });

  describe("EIP-712 issuance and CAS deposit", function () {
    it("mints, creates the deterministic TBA and deposits CAS atomically", async function () {
      const fixture = await loadFixture(deployFixture);
      const { certificate, registry, accountImplementation, casToken, user, issuer } = fixture;
      const authorization = await buildAuthorization(certificate, user.address);
      const signature = await signAuthorization(certificate, issuer, authorization);

      const predictedAccount = await registry.account(
        await accountImplementation.getAddress(),
        await certificate.ACCOUNT_SALT(),
        (await ethers.provider.getNetwork()).chainId,
        await certificate.getAddress(),
        1,
      );

      const certAddr = await certificate.getAddress();
      await casToken.connect(user).transfer(certAddr, MIN_CAS);
      await certificate.connect(user).depositCasForMint(authorization.phaseId);

      await expect(
        certificate
          .connect(user)
          .mintCertificate(authorization, issuer.address, signature),
      )
        .to.emit(certificate, "CertificateMinted")
        .withArgs(
          1,
          1,
          user.address,
          predictedAccount,
          authorization.issuanceId,
          authorization.nameHash,
          authorization.metadataHash,
          MIN_CAS,
        );

      expect(await certificate.ownerOf(1)).to.equal(user.address);
      expect(await certificate.tokenBoundAccount(1)).to.equal(predictedAccount);
      expect(await certificate.certificateOf(user.address, 1)).to.equal(1);
      expect(await casToken.balanceOf(predictedAccount)).to.equal(MIN_CAS);
      expect(await ethers.provider.getCode(predictedAccount)).not.to.equal("0x");
      expect(await certificate.nonces(user.address)).to.equal(1);
      expect(await certificate.issuanceUsed(authorization.issuanceId)).to.equal(true);
      expect(await certificate.tokenURI(1)).to.equal(`${BASE_URI}1`);

      const record = await certificate.getCertificate(1);
      expect(record.nameHash).to.equal(authorization.nameHash);
      expect(record.metadataHash).to.equal(authorization.metadataHash);
      expect(record.casDeposited).to.equal(MIN_CAS);
      expect(record.revoked).to.equal(false);

      const verification = await certificate.verifyCertificate(1);
      expect(verification.valid).to.equal(true);
      expect(verification.currentCasBalance).to.equal(MIN_CAS);
    });

    it("matches the backend EIP-712 digest", async function () {
      const { certificate, issuer, user } = await loadFixture(deployFixture);
      const authorization = await buildAuthorization(certificate, user.address);
      const network = await ethers.provider.getNetwork();
      const offchainDigest = ethers.TypedDataEncoder.hash(
        {
          name: "RapportCertificate",
          version: "1",
          chainId: network.chainId,
          verifyingContract: await certificate.getAddress(),
        },
        AUTH_TYPES,
        authorization,
      );

      expect(await certificate.getMintDigest(authorization)).to.equal(offchainDigest);
      const signature = await signAuthorization(certificate, issuer, authorization);
      expect(ethers.verifyTypedData(
        {
          name: "RapportCertificate",
          version: "1",
          chainId: network.chainId,
          verifyingContract: await certificate.getAddress(),
        },
        AUTH_TYPES,
        authorization,
        signature,
      )).to.equal(issuer.address);
    });

    it("rejects insufficient CAS and missing allowance", async function () {
      const { certificate, issuer, user, casToken } = await loadFixture(deployFixture);
      const tooSmall = await buildAuthorization(certificate, user.address, {
        casAmount: MIN_CAS - 1n,
      });
      const signature = await signAuthorization(certificate, issuer, tooSmall);

      await expect(
        certificate.connect(user).mintCertificate(tooSmall, issuer.address, signature),
      ).to.be.revertedWithCustomError(certificate, "InsufficientCasDeposit");

      const valid = await buildAuthorization(certificate, user.address, { seed: "allowance" });
      const validSignature = await signAuthorization(certificate, issuer, valid);
      await expect(
        certificate.connect(user).mintCertificate(valid, issuer.address, validSignature),
      ).to.be.revertedWithCustomError(certificate, "InsufficientCasDepositBalance");
    });

    it("rejects a fee-on-transfer CAS shortfall without moving funds", async function () {
      const fixture = await loadFixture(deployFixture);
      const { admin, issuer, user, registry, accountImplementation } = fixture;
      const FeeToken = await ethers.getContractFactory("MockFeeOnTransferERC20");
      const feeToken = await FeeToken.deploy() as any;
      await feeToken.waitForDeployment();

      const Certificate = await ethers.getContractFactory("RapportCertificate");
      const guardedCertificate = await Certificate.deploy(
        admin.address,
        await feeToken.getAddress(),
        await registry.getAddress(),
        await accountImplementation.getAddress(),
        BASE_URI,
      ) as any;
      await guardedCertificate.waitForDeployment();
      await guardedCertificate.grantRole(
        await guardedCertificate.ISSUER_ROLE(),
        issuer.address,
      );

      await feeToken.mint(user.address, MIN_CAS);
      const guardedCertAddr = await guardedCertificate.getAddress();
      await feeToken.connect(user).transfer(guardedCertAddr, MIN_CAS);
      const authorization = await buildAuthorization(
        guardedCertificate,
        user.address,
        { seed: "fee-token" },
      );
      const signature = await signAuthorization(
        guardedCertificate,
        issuer,
        authorization,
      );

      await guardedCertificate.connect(user).depositCasForMint(authorization.phaseId);

      await expect(
        guardedCertificate
          .connect(user)
          .mintCertificate(authorization, issuer.address, signature),
      ).to.be.revertedWithCustomError(guardedCertificate, "InsufficientCasDepositBalance");

      expect(await feeToken.balanceOf(user.address)).to.equal(0);
      expect(await feeToken.balanceOf(guardedCertAddr)).to.equal(MIN_CAS - (MIN_CAS / 100n));
      expect(await guardedCertificate.totalCertificates()).to.equal(0);
    });

    it("rejects expired, wrong-recipient, wrong-nonce and unauthorized signatures", async function () {
      const { certificate, issuer, user, other } = await loadFixture(deployFixture);
      const now = await time.latest();

      const expired = await buildAuthorization(certificate, user.address, {
        deadline: BigInt(now - 1),
      });
      await expect(
        certificate.connect(user).mintCertificate(
          expired,
          issuer.address,
          await signAuthorization(certificate, issuer, expired),
        ),
      ).to.be.revertedWithCustomError(certificate, "AuthorizationExpired");

      const wrongRecipient = await buildAuthorization(certificate, user.address, {
        seed: "recipient",
      });
      await expect(
        certificate.connect(other).mintCertificate(
          wrongRecipient,
          issuer.address,
          await signAuthorization(certificate, issuer, wrongRecipient),
        ),
      ).to.be.revertedWithCustomError(certificate, "RecipientMustCall");

      const wrongNonce = await buildAuthorization(certificate, user.address, {
        nonce: 7n,
        seed: "nonce",
      });
      await expect(
        certificate.connect(user).mintCertificate(
          wrongNonce,
          issuer.address,
          await signAuthorization(certificate, issuer, wrongNonce),
        ),
      ).to.be.revertedWithCustomError(certificate, "InvalidNonce");

      const unauthorized = await buildAuthorization(certificate, user.address, {
        seed: "unauthorized",
      });
      await expect(
        certificate.connect(user).mintCertificate(
          unauthorized,
          other.address,
          await signAuthorization(certificate, other, unauthorized),
        ),
      ).to.be.revertedWithCustomError(certificate, "InvalidIssuerSignature");
    });

    it("prevents replay, authorization tampering and duplicate phase issuance", async function () {
      const fixture = await loadFixture(deployFixture);
      const { certificate, casToken, issuer, user } = fixture;
      const authorization = await buildAuthorization(certificate, user.address);
      const signature = await signAuthorization(certificate, issuer, authorization);
      const tamperedAuthorization = {
        ...authorization,
        metadataHash: ethers.keccak256(ethers.toUtf8Bytes("tampered-metadata")),
      };

      await expect(
        certificate
          .connect(user)
          .mintCertificate(tamperedAuthorization, issuer.address, signature),
      ).to.be.revertedWithCustomError(certificate, "InvalidIssuerSignature");

      const certAddr = await certificate.getAddress();
      await casToken.connect(user).transfer(certAddr, MIN_CAS);
      await certificate.connect(user).depositCasForMint(authorization.phaseId);
      await certificate
        .connect(user)
        .mintCertificate(authorization, issuer.address, signature);

      await expect(
        certificate.connect(user).mintCertificate(authorization, issuer.address, signature),
      ).to.be.revertedWithCustomError(certificate, "IssuanceAlreadyUsed");

      const duplicate = await buildAuthorization(certificate, user.address, {
        seed: "duplicate",
      });
      await expect(
        certificate.connect(user).mintCertificate(
          duplicate,
          issuer.address,
          await signAuthorization(certificate, issuer, duplicate),
        ),
      ).to.be.revertedWithCustomError(certificate, "CertificateAlreadyIssued");
    });
  });

  describe("phases and operational controls", function () {
    it("creates a new phase, activates it and allows a second certificate", async function () {
      const fixture = await loadFixture(deployFixture);
      const { certificate, casToken, admin, issuer, user } = fixture;
      await mintDefault(fixture);

      const templateHash = ethers.keccak256(ethers.toUtf8Bytes("supporters-v1"));
      await expect(
        certificate.createPhase(
          "Apoiadores",
          templateHash,
          ethers.parseEther("150"),
          0,
          0,
        ),
      ).to.emit(certificate, "PhaseCreated");
      await certificate.activatePhase(2);

      const phaseOne = await certificate.getPhase(1);
      const phaseTwo = await certificate.getPhase(2);
      expect(phaseOne.active).to.equal(false);
      expect(phaseTwo.active).to.equal(true);
      expect(await certificate.currentPhaseId()).to.equal(2);

      const authorization = await buildAuthorization(certificate, user.address, {
        phaseId: 2n,
        casAmount: ethers.parseEther("150"),
        seed: "phase-2",
      });
      const signature = await signAuthorization(certificate, issuer, authorization);
      const certAddr = await certificate.getAddress();
      await casToken.connect(user).transfer(certAddr, ethers.parseEther("150"));
      await certificate.connect(user).depositCasForMint(2n);
      await certificate.connect(user).mintCertificate(
        authorization,
        issuer.address,
        signature,
      );

      expect(await certificate.ownerOf(2)).to.equal(user.address);
      expect(await certificate.certificateOf(user.address, 2)).to.equal(2);

      await certificate.connect(admin).deactivateCurrentPhase();
      expect(await certificate.currentPhaseId()).to.equal(0);
    });

    it("pauses issuance without freezing access to existing TBA assets", async function () {
      const fixture = await loadFixture(deployFixture);
      const { certificate, casToken, issuer, user } = fixture;
      const authorization = await buildAuthorization(certificate, user.address);
      const signature = await signAuthorization(certificate, issuer, authorization);

      await certificate.pause();
      await expect(
        certificate.connect(user).depositCasForMint(authorization.phaseId),
      ).to.be.revertedWithCustomError(certificate, "EnforcedPause");
      await certificate.unpause();
      const certAddr = await certificate.getAddress();
      await casToken.connect(user).transfer(certAddr, MIN_CAS);
      await certificate.connect(user).depositCasForMint(authorization.phaseId);
      await certificate.connect(user).mintCertificate(authorization, issuer.address, signature);
      expect(await certificate.ownerOf(1)).to.equal(user.address);
    });
  });

  describe("soulbound status, revocation and PDF hash", function () {
    it("implements permanently locked ERC-5192 behavior", async function () {
      const fixture = await loadFixture(deployFixture);
      const { certificate, user, other } = fixture;
      await mintDefault(fixture);

      expect(await certificate.locked(1)).to.equal(true);
      await expect(
        certificate.connect(user).transferFrom(user.address, other.address, 1),
      ).to.be.revertedWithCustomError(certificate, "CertificateLocked");
      await expect(
        certificate.connect(user).approve(other.address, 1),
      ).to.be.revertedWithCustomError(certificate, "CertificateLocked");
    });

    it("revokes validity but preserves ownership and the TBA reserve", async function () {
      const fixture = await loadFixture(deployFixture);
      const { certificate, casToken, user } = fixture;
      await mintDefault(fixture);
      const account = await certificate.tokenBoundAccount(1);
      const reasonHash = ethers.keccak256(ethers.toUtf8Bytes("fraud-confirmed"));

      await expect(certificate.revokeCertificate(1, reasonHash))
        .to.emit(certificate, "CertificateRevoked")
        .withArgs(1, reasonHash, fixture.admin.address);

      expect(await certificate.ownerOf(1)).to.equal(user.address);
      expect(await casToken.balanceOf(account)).to.equal(MIN_CAS);
      const verification = await certificate.verifyCertificate(1);
      expect(verification.valid).to.equal(false);
    });

    it("anchors a unique one-time signed PDF hash and verifies it", async function () {
      const fixture = await loadFixture(deployFixture);
      const { certificate, issuer } = fixture;
      await mintDefault(fixture);
      const documentHash = ethers.sha256(ethers.toUtf8Bytes("signed-pdf-bytes"));

      await expect(certificate.connect(issuer).attestDocumentHash(1, documentHash))
        .to.emit(certificate, "DocumentHashAttested")
        .withArgs(1, documentHash, issuer.address);

      const [valid, tokenId] = await certificate.verifyDocument(documentHash);
      expect(valid).to.equal(true);
      expect(tokenId).to.equal(1);
      expect((await certificate.getCertificate(1)).documentHash).to.equal(documentHash);

      await expect(
        certificate.connect(issuer).attestDocumentHash(
          1,
          ethers.sha256(ethers.toUtf8Bytes("replacement")),
        ),
      ).to.be.revertedWithCustomError(certificate, "DocumentHashAlreadySet");
    });

    it("rejects document attestation after certificate revocation", async function () {
      const fixture = await loadFixture(deployFixture);
      const { certificate, issuer } = fixture;
      await mintDefault(fixture);
      await certificate.revokeCertificate(
        1,
        ethers.keccak256(ethers.toUtf8Bytes("revoked-before-attestation")),
      );
      const documentHash = ethers.sha256(ethers.toUtf8Bytes("revoked-pdf"));

      await expect(certificate.connect(issuer).attestDocumentHash(1, documentHash))
        .to.be.revertedWithCustomError(certificate, "CertificateIsRevoked")
        .withArgs(1);
      expect((await certificate.getCertificate(1)).documentHash).to.equal(
        ethers.ZeroHash,
      );
      expect(await certificate.verifyDocument(documentHash)).to.deep.equal([
        false,
        0n,
      ]);
    });
  });

  describe("ERC-6551 account", function () {
    it("reports its token and lets only the NFT owner execute CALL", async function () {
      const fixture = await loadFixture(deployFixture);
      const { certificate, casToken, user, other, destination } = fixture;
      await mintDefault(fixture);

      const accountAddress = await certificate.tokenBoundAccount(1);
      const account = await ethers.getContractAt(
        "RapportCertificateAccount",
        accountAddress,
      ) as any;
      const token = await account.token();
      expect(token.chainId).to.equal((await ethers.provider.getNetwork()).chainId);
      expect(token.tokenContract).to.equal(await certificate.getAddress());
      expect(token.tokenId).to.equal(1);
      expect(await account.owner()).to.equal(user.address);

      const transferData = casToken.interface.encodeFunctionData("transfer", [
        destination.address,
        ethers.parseEther("10"),
      ]);
      await expect(
        account.connect(other).execute(await casToken.getAddress(), 0, transferData, 0),
      ).to.be.revertedWithCustomError(account, "Unauthorized");

      await account.connect(user).execute(
        await casToken.getAddress(),
        0,
        transferData,
        0,
      );
      expect(await casToken.balanceOf(destination.address)).to.equal(
        ethers.parseEther("10"),
      );
      expect(await account.state()).to.equal(1);

      await expect(
        account.connect(user).execute(await casToken.getAddress(), 0, "0x", 1),
      ).to.be.revertedWithCustomError(account, "UnsupportedOperation");
    });

    it("rolls back issuance if a contract recipient drains CAS in the mint callback", async function () {
      const fixture = await loadFixture(deployFixture);
      const { certificate, casToken, issuer, user, destination } = fixture;
      const Receiver = await ethers.getContractFactory("MockCertificateReceiver");
      const receiver = await Receiver.deploy(
        await certificate.getAddress(),
        await casToken.getAddress(),
        destination.address,
      ) as any;
      await receiver.waitForDeployment();
      const receiverAddress = await receiver.getAddress();
      const certAddr = await certificate.getAddress();
      await casToken.connect(user).transfer(receiverAddress, MIN_CAS);

      const authorization = await buildAuthorization(
        certificate,
        receiverAddress,
        { seed: "callback-drain" },
      );
      const signature = await signAuthorization(certificate, issuer, authorization);

      await expect(
        receiver.mint(authorization, issuer.address, signature),
      ).to.be.revertedWithCustomError(certificate, "CasDepositMismatch");

      expect(await casToken.balanceOf(receiverAddress)).to.equal(MIN_CAS);
      expect(await casToken.balanceOf(destination.address)).to.equal(0);
      expect(await certificate.totalCertificates()).to.equal(0);
    });

    it("implements ERC-165, ERC-1271 and ERC-6551 signer validation", async function () {
      const fixture = await loadFixture(deployFixture);
      const { certificate, user, other } = fixture;
      await mintDefault(fixture);
      const account = await ethers.getContractAt(
        "RapportCertificateAccount",
        await certificate.tokenBoundAccount(1),
      ) as any;

      expect(await account.supportsInterface("0x01ffc9a7")).to.equal(true);
      expect(await account.supportsInterface("0x1626ba7e")).to.equal(true);
      expect(await account.supportsInterface("0x6faff5f1")).to.equal(true);
      expect(await account.supportsInterface("0x51945447")).to.equal(true);
      expect(await account.isValidSigner(user.address, "0x")).to.equal("0x523e3260");
      expect(await account.isValidSigner(other.address, "0x")).to.equal("0x00000000");

      const message = ethers.keccak256(ethers.toUtf8Bytes("account-signature"));
      const signature = await user.signMessage(ethers.getBytes(message));
      const signedHash = ethers.hashMessage(ethers.getBytes(message));
      expect(await account.isValidSignature(signedHash, signature)).to.equal("0x1626ba7e");
      expect(await account.isValidSignature(
        signedHash,
        await other.signMessage(ethers.getBytes(message)),
      )).to.equal("0x00000000");
    });

    it("uses an idempotent deterministic ERC-6551 registry", async function () {
      const {
        certificate,
        registry,
        accountImplementation,
      } = await loadFixture(deployFixture);
      const chainId = (await ethers.provider.getNetwork()).chainId;
      const args = [
        await accountImplementation.getAddress(),
        await certificate.ACCOUNT_SALT(),
        chainId,
        await certificate.getAddress(),
        77,
      ] as const;

      const predicted = await registry.account(...args);
      expect(await registry.createAccount.staticCall(...args)).to.equal(predicted);
      await registry.createAccount(...args);
      expect(await ethers.provider.getCode(predicted)).not.to.equal("0x");
      expect(await registry.createAccount.staticCall(...args)).to.equal(predicted);
      await registry.createAccount(...args);
    });

    it("rejects an incompatible registry before transferring CAS", async function () {
      const fixture = await loadFixture(deployFixture);
      const {
        admin,
        issuer,
        user,
        destination,
        casToken,
        accountImplementation,
      } = fixture;

      const BadRegistry = await ethers.getContractFactory("MockERC6551Registry");
      const badRegistry = await BadRegistry.deploy(destination.address) as any;
      await badRegistry.waitForDeployment();

      const Certificate = await ethers.getContractFactory("RapportCertificate");
      const guardedCertificate = await Certificate.deploy(
        admin.address,
        await casToken.getAddress(),
        await badRegistry.getAddress(),
        await accountImplementation.getAddress(),
        BASE_URI,
      ) as any;
      await guardedCertificate.waitForDeployment();
      await guardedCertificate.grantRole(
        await guardedCertificate.ISSUER_ROLE(),
        issuer.address,
      );
      const guardedCertAddr = await guardedCertificate.getAddress();
      await casToken.connect(user).transfer(guardedCertAddr, MIN_CAS);
      await guardedCertificate.connect(user).depositCasForMint(1n);

      const authorization = await buildAuthorization(
        guardedCertificate,
        user.address,
        { seed: "bad-registry" },
      );
      const signature = await signAuthorization(
        guardedCertificate,
        issuer,
        authorization,
      );

      await expect(
        guardedCertificate
          .connect(user)
          .mintCertificate(authorization, issuer.address, signature),
      ).to.be.revertedWithCustomError(
        guardedCertificate,
        "TokenBoundAccountCodeMismatch",
      );

      expect(await casToken.balanceOf(user.address)).to.equal(ethers.parseEther("1000") - MIN_CAS);
      expect(await casToken.balanceOf(destination.address)).to.equal(0);
      expect(await guardedCertificate.totalCertificates()).to.equal(0);
    });
  });
});
