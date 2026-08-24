// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { AccessControlEnumerableUpgradeable }
    from "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ERC721Upgradeable }
    from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import { PausableUpgradeable }
    from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import { EIP712Upgradeable }
    from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import { UUPSUpgradeable }
    from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { SignatureChecker } from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import { IERC5192 } from "../interfaces/IERC5192.sol";
import { IERC6551Registry } from "../interfaces/IERC6551Registry.sol";
import { RapportCertificateStorage } from "./RapportCertificateStorage.sol";

/// @title Rapport Certificate (Upgradeable)
/// @notice Non-transferable ERC-721 certificates whose owners control a
///         dedicated ERC-6551 token-bound account holding their CAS reserve.
/// @dev UUPS proxy pattern. Storage layout MUST be preserved across upgrades.
///      Gap variables are reserved for future fields. Do NOT reorder existing
///      storage slots when upgrading. All state, structs, roles, events and
///      errors live in `RapportCertificateStorage`, shared with
///      `RapportCertificatePhaseAdminFacet` (phase-administration functions,
///      reached via `fallback()` + `delegatecall` — see `phaseAdminFacet`
///      below) to keep this implementation under the EIP-170 24576-byte
///      contract size limit.
contract RapportCertificateUpgradeable is
    RapportCertificateStorage,
    ERC721Upgradeable,
    IERC5192,
    AccessControlEnumerableUpgradeable,
    PausableUpgradeable,
    EIP712Upgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    // -----------------------------------------------------------------------
    // Reentrancy guard (manual, compatible with proxy storage)
    // -----------------------------------------------------------------------

    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;

    modifier nonReentrant() {
        if (_reentrancyStatus == _ENTERED) revert ReentrantCall();
        _reentrancyStatus = _ENTERED;
        _;
        _reentrancyStatus = _NOT_ENTERED;
    }

    // -----------------------------------------------------------------------
    // Initializer (replaces constructor)
    // -----------------------------------------------------------------------

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address admin,
        address casTokenAddress,
        address registryAddress,
        address accountImplementationAddress,
        string memory baseTokenURI_
    ) external virtual initializer {
        if (
            admin == address(0) || casTokenAddress == address(0)
                || registryAddress == address(0)
                || accountImplementationAddress == address(0)
        ) revert ZeroAddress();
        if (casTokenAddress.code.length == 0) revert InvalidContract(casTokenAddress);
        if (registryAddress.code.length == 0) revert InvalidContract(registryAddress);
        if (accountImplementationAddress.code.length == 0) {
            revert InvalidContract(accountImplementationAddress);
        }

        __ERC721_init("Rapport Certificate", "RPTCERT");
        __EIP712_init("RapportCertificate", "1");
        __Pausable_init();
        __AccessControlEnumerable_init();
        // UUPSUpgradeable in OZ 5.x has no init function.

        casToken = IERC20(casTokenAddress);
        erc6551Registry = IERC6551Registry(registryAddress);
        accountImplementation = accountImplementationAddress;
        baseTokenURI = baseTokenURI_;
        _reentrancyStatus = _NOT_ENTERED;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ISSUER_ROLE, admin);
        _grantRole(PHASE_MANAGER_ROLE, admin);
        _grantRole(REVOKER_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
        _grantRole(BONUS_MANAGER_ROLE, admin);

        phaseCount = 1;
        currentPhaseId = 1;
        phases[1] = Phase({
            name: unicode"Sócio Fundador",
            templateHash: FOUNDERS_TEMPLATE_HASH,
            minCasDeposit: FOUNDERS_MIN_CAS_DEPOSIT,
            startsAt: block.timestamp,
            endsAt: 0,
            minted: 0,
            active: true,
            skillsDescription: "",
            instructions: "",
            extraFeeTypeId: 0,
            tbaRebateBps: 0,
            allowMultipleIssuance: false,
            maxPerRecipient: 0,
            maxTotalSupply: 0
        });
        activePhases[1] = true;

        emit PhaseCreated(
            1,
            unicode"Sócio Fundador",
            FOUNDERS_TEMPLATE_HASH,
            FOUNDERS_MIN_CAS_DEPOSIT,
            block.timestamp,
            0
        );
        emit PhaseActivated(1, 0);
    }

    // -----------------------------------------------------------------------
    // UUPS authorization
    // -----------------------------------------------------------------------

    function _authorizeUpgrade(address newImplementation)
        internal
        override
        onlyRole(DEFAULT_ADMIN_ROLE)
    {}

    // -----------------------------------------------------------------------
    // Phase-admin facet wiring
    // -----------------------------------------------------------------------

    /// @notice Points phase-administration calls (createPhase,
    ///         setPhaseExtraFeeType, setPhaseMultipleIssuance,
    ///         updatePhaseMetadata, setPhasePrerequisites, activatePhase,
    ///         deactivatePhase) to a logic contract reached via `fallback()`.
    /// @dev The facet is plain (non-proxied) logic executed via
    ///      `delegatecall` from this proxy's implementation, so it shares
    ///      this contract's storage — see `RapportCertificateStorage` for
    ///      why this is safe. Restricted to `DEFAULT_ADMIN_ROLE` since it
    ///      controls which code effectively runs as part of this contract,
    ///      equivalent in sensitivity to an upgrade.
    function setPhaseAdminFacet(address facet) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (facet == address(0)) revert ZeroAddress();
        if (facet.code.length == 0) revert InvalidContract(facet);
        emit PhaseAdminFacetUpdated(phaseAdminFacet, facet);
        phaseAdminFacet = facet;
    }

    /// @notice Updates the base URI used by `tokenURI`.
    /// @dev Restricted to DEFAULT_ADMIN_ROLE. Allows correcting the
    ///      metadata endpoint after domain migration without redeploying
    ///      tokens. Emits `BaseURIUpdated` for auditability.
    function setBaseURI(string calldata newBaseURI) external onlyRole(DEFAULT_ADMIN_ROLE) {
        emit BaseURIUpdated(baseTokenURI, newBaseURI);
        baseTokenURI = newBaseURI;
    }

    /// @dev Forwards any call that doesn't match a function on this
    ///      implementation to `phaseAdminFacet` via `delegatecall`, so
    ///      external callers (backend, dashboard) see a single, unchanged
    ///      ABI surface at this proxy's address regardless of which
    ///      contract actually holds the phase-admin function bodies.
    fallback() external {
        address facet = phaseAdminFacet;
        if (facet == address(0)) revert PhaseAdminFacetNotSet();
        assembly {
            calldatacopy(0, 0, calldatasize())
            let result := delegatecall(gas(), facet, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch result
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }

    // -----------------------------------------------------------------------
    // CAS deposits
    // -----------------------------------------------------------------------

    function depositCasForMint(uint256 phaseId) external nonReentrant whenNotPaused {
        if (phaseId == 0 || !activePhases[phaseId]) {
            revert DepositPhaseNotActive(phaseId);
        }
        Phase storage phase = phases[phaseId];
        if (!phase.active) revert DepositPhaseNotActive(phaseId);

        uint256 contractBalance = casToken.balanceOf(address(this));
        uint256 unaccounted = contractBalance > _totalCasDeposited
            ? contractBalance - _totalCasDeposited
            : 0;
        if (unaccounted == 0) revert InsufficientCasDepositBalance(0, phase.minCasDeposit);

        _depositCasForMint(msg.sender, phaseId, unaccounted);
    }

    function depositCasForMintFor(
        address beneficiary,
        uint256 phaseId,
        uint256 amount
    )
        external
        nonReentrant
        whenNotPaused
        onlyRole(TRUSTED_CALLER_ROLE)
    {
        if (phaseId == 0 || !activePhases[phaseId]) {
            revert DepositPhaseNotActive(phaseId);
        }
        Phase storage phase = phases[phaseId];
        if (!phase.active) revert DepositPhaseNotActive(phaseId);
        if (amount == 0) revert InsufficientCasDepositBalance(0, phase.minCasDeposit);

        uint256 contractBalance = casToken.balanceOf(address(this));
        if (contractBalance - _totalCasDeposited < amount) {
            revert InsufficientCasDepositBalance(contractBalance - _totalCasDeposited, amount);
        }

        _depositCasForMint(beneficiary, phaseId, amount);
    }

    function _depositCasForMint(address beneficiary, uint256 phaseId, uint256 amount) private {
        casDeposits[beneficiary][phaseId] += amount;
        _totalCasDeposited += amount;
        emit CasDeposited(beneficiary, phaseId, amount, casDeposits[beneficiary][phaseId]);
    }

    function withdrawCasDeposit(uint256 phaseId) external nonReentrant whenNotPaused {
        uint256 available = casDeposits[msg.sender][phaseId];
        if (available == 0) revert NoCasDepositToWithdraw(0);

        casDeposits[msg.sender][phaseId] = 0;
        _totalCasDeposited -= available;

        casToken.safeTransfer(msg.sender, available);

        emit CasDeposited(msg.sender, phaseId, 0, 0);
    }

    // casDepositBalance removed — read casDeposits mapping directly via getter.
    // The public mapping generates a getter automatically.

    // -----------------------------------------------------------------------
    // Minting
    // -----------------------------------------------------------------------

    function mintCertificate(
        CertificateMintAuthorization calldata authorization,
        address issuer,
        bytes calldata signature
    )
        external
        nonReentrant
        whenNotPaused
        returns (uint256 tokenId, address tokenBoundAccount_)
    {
        if (
            authorization.recipient != msg.sender
                && !hasRole(TRUSTED_CALLER_ROLE, msg.sender)
        ) {
            revert RecipientMustCall(authorization.recipient, msg.sender);
        }
        if (authorization.recipient == address(0)) revert ZeroAddress();
        if (
            authorization.issuanceId == bytes32(0)
                || authorization.nameHash == bytes32(0)
                || authorization.metadataHash == bytes32(0)
        ) revert EmptyHash();
        if (block.timestamp > authorization.deadline) {
            revert AuthorizationExpired(authorization.deadline);
        }
        if (issuanceUsed[authorization.issuanceId]) {
            revert IssuanceAlreadyUsed(authorization.issuanceId);
        }

        uint256 expectedNonce = nonces[authorization.recipient];
        if (authorization.nonce != expectedNonce) {
            revert InvalidNonce(expectedNonce, authorization.nonce);
        }

        Phase storage phase = phases[authorization.phaseId];
        if (
            authorization.phaseId == 0 || !activePhases[authorization.phaseId]
                || !phase.active
        ) revert PhaseNotActive(authorization.phaseId);
        if (block.timestamp < phase.startsAt) {
            revert PhaseNotStarted(authorization.phaseId, phase.startsAt);
        }
        if (phase.endsAt != 0 && block.timestamp > phase.endsAt) {
            revert PhaseEnded(authorization.phaseId, phase.endsAt);
        }
        if (authorization.casAmount < phase.minCasDeposit) {
            revert InsufficientCasDeposit(phase.minCasDeposit, authorization.casAmount);
        }

        uint256[] storage prereqs = phasePrerequisites[authorization.phaseId];
        for (uint256 i = 0; i < prereqs.length; i++) {
            if (certificatesByRecipientAndPhase[authorization.recipient][prereqs[i]] == 0) {
                revert PhasePrerequisitesNotMet(authorization.phaseId, prereqs[i]);
            }
        }

        if (phase.allowMultipleIssuance) {
            if (
                mintCountByRecipientAndPhase[authorization.recipient][authorization.phaseId]
                    >= phase.maxPerRecipient
            ) {
                revert MaxIssuancePerRecipientReached(
                    authorization.phaseId,
                    authorization.recipient,
                    phase.maxPerRecipient
                );
            }
            if (phase.minted >= phase.maxTotalSupply) {
                revert MaxTotalSupplyReached(authorization.phaseId, phase.maxTotalSupply);
            }
        } else {
            uint256 existingTokenId = certificatesByRecipientAndPhase[
                authorization.recipient
            ][authorization.phaseId];
            if (existingTokenId != 0) {
                revert CertificateAlreadyIssued(
                    authorization.recipient,
                    authorization.phaseId,
                    existingTokenId
                );
            }
        }

        bytes32 digest = _getMintDigest(authorization);
        if (
            !hasRole(ISSUER_ROLE, issuer)
                || !SignatureChecker.isValidSignatureNow(issuer, digest, signature)
        ) revert InvalidIssuerSignature(issuer);

        uint256 availableDeposit = casDeposits[authorization.recipient][authorization.phaseId];
        if (availableDeposit < authorization.casAmount) {
            revert InsufficientCasDepositBalance(availableDeposit, authorization.casAmount);
        }

        issuanceUsed[authorization.issuanceId] = true;
        nonces[authorization.recipient] = expectedNonce + 1;
        casDeposits[authorization.recipient][authorization.phaseId] -= authorization.casAmount;
        _totalCasDeposited -= authorization.casAmount;

        tokenId = ++totalCertificates;
        phase.minted++;

        address expectedTokenBoundAccount = erc6551Registry.account(
            accountImplementation,
            ACCOUNT_SALT,
            block.chainid,
            address(this),
            tokenId
        );
        tokenBoundAccount_ = erc6551Registry.createAccount(
            accountImplementation,
            ACCOUNT_SALT,
            block.chainid,
            address(this),
            tokenId
        );
        if (tokenBoundAccount_ != expectedTokenBoundAccount) {
            revert TokenBoundAccountAddressMismatch(
                expectedTokenBoundAccount,
                tokenBoundAccount_
            );
        }

        bytes32 expectedAccountCodeHash = keccak256(
            abi.encodePacked(
                ERC6551_PROXY_PREFIX,
                accountImplementation,
                ERC6551_PROXY_SUFFIX,
                abi.encode(ACCOUNT_SALT, block.chainid, address(this), tokenId)
            )
        );
        bytes32 actualAccountCodeHash = tokenBoundAccount_.codehash;
        if (actualAccountCodeHash != expectedAccountCodeHash) {
            revert TokenBoundAccountCodeMismatch(
                tokenBoundAccount_,
                expectedAccountCodeHash,
                actualAccountCodeHash
            );
        }

        certificates[tokenId] = Certificate({
            phaseId: authorization.phaseId,
            recipient: authorization.recipient,
            tokenBoundAccount: tokenBoundAccount_,
            issuanceId: authorization.issuanceId,
            nameHash: authorization.nameHash,
            metadataHash: authorization.metadataHash,
            casDeposited: authorization.casAmount,
            issuedAt: block.timestamp,
            revoked: false,
            revocationReasonHash: bytes32(0),
            revokedAt: 0,
            documentHash: bytes32(0)
        });
        certificatesByRecipientAndPhase[authorization.recipient][authorization.phaseId] =
            tokenId;
        mintCountByRecipientAndPhase[authorization.recipient][authorization.phaseId]++;

        uint256 balanceBefore = casToken.balanceOf(tokenBoundAccount_);
        casToken.safeTransfer(tokenBoundAccount_, authorization.casAmount);
        uint256 balanceAfterTransfer = casToken.balanceOf(tokenBoundAccount_);
        uint256 expectedBalance = balanceBefore + authorization.casAmount;
        if (balanceAfterTransfer < expectedBalance) {
            revert CasDepositMismatch(expectedBalance, balanceAfterTransfer);
        }

        _safeMint(authorization.recipient, tokenId);

        uint256 finalBalance = casToken.balanceOf(tokenBoundAccount_);
        if (finalBalance < expectedBalance) {
            revert CasDepositMismatch(expectedBalance, finalBalance);
        }

        emit CertificateMinted(
            tokenId,
            authorization.phaseId,
            authorization.recipient,
            tokenBoundAccount_,
            authorization.issuanceId,
            authorization.nameHash,
            authorization.metadataHash,
            authorization.casAmount
        );
    }

    // -----------------------------------------------------------------------
    // Revocation
    // -----------------------------------------------------------------------

    function revokeCertificate(uint256 tokenId, bytes32 reasonHash)
        external
        onlyRole(REVOKER_ROLE)
    {
        Certificate storage certificate = _requireCertificate(tokenId);
        if (reasonHash == bytes32(0)) revert EmptyHash();
        if (certificate.revoked) revert CertificateAlreadyRevoked(tokenId);

        certificate.revoked = true;
        certificate.revocationReasonHash = reasonHash;
        certificate.revokedAt = block.timestamp;
        emit CertificateRevoked(tokenId, reasonHash, msg.sender);
    }

    // -----------------------------------------------------------------------
    // Attestations
    // -----------------------------------------------------------------------

    function attestDocumentHash(uint256 tokenId, bytes32 documentHash)
        external
        onlyRole(ISSUER_ROLE)
    {
        Certificate storage certificate = _requireCertificate(tokenId);
        if (documentHash == bytes32(0)) revert EmptyHash();
        if (certificate.revoked) revert CertificateIsRevoked(tokenId);
        if (certificate.documentHash != bytes32(0)) {
            revert DocumentHashAlreadySet(tokenId);
        }

        uint256 existingTokenId = tokensByDocumentHash[documentHash];
        if (existingTokenId != 0) {
            revert DocumentHashAlreadyUsed(documentHash, existingTokenId);
        }

        certificate.documentHash = documentHash;
        tokensByDocumentHash[documentHash] = tokenId;
        emit DocumentHashAttested(tokenId, documentHash, msg.sender);
    }

    function attestMerkleRoot(uint256 tokenId, bytes32 merkleRoot)
        external
        onlyRole(ISSUER_ROLE)
    {
        Certificate storage certificate = _requireCertificate(tokenId);
        if (merkleRoot == bytes32(0)) revert EmptyHash();
        if (certificate.revoked) revert CertificateIsRevoked(tokenId);
        if (certificateMerkleRoots[tokenId] != bytes32(0)) {
            revert MerkleRootAlreadySet(tokenId);
        }
        certificateMerkleRoots[tokenId] = merkleRoot;
        emit MerkleRootAttested(tokenId, merkleRoot, msg.sender);
    }

    function attestMerkleRootProof(uint256 tokenId, bytes32 merkleRootProof_)
        external
        onlyRole(ISSUER_ROLE)
    {
        Certificate storage certificate = _requireCertificate(tokenId);
        if (merkleRootProof_ == bytes32(0)) revert EmptyHash();
        if (certificate.revoked) revert CertificateIsRevoked(tokenId);
        if (certificateMerkleRootProofs[tokenId] != bytes32(0)) {
            revert MerkleRootProofAlreadySet(tokenId);
        }
        certificateMerkleRootProofs[tokenId] = merkleRootProof_;
        emit MerkleRootProofAttested(tokenId, merkleRootProof_, msg.sender);
    }

    // -----------------------------------------------------------------------
    // CAS bonus
    // -----------------------------------------------------------------------

    function grantCasBonus(uint256 tokenId)
        external
        onlyRole(BONUS_MANAGER_ROLE)
        nonReentrant
        whenNotPaused
        returns (uint256 amount)
    {
        Certificate storage certificate = _requireCertificate(tokenId);
        if (certificate.revoked) revert CertificateIsRevoked(tokenId);
        if (casBonusGranted[tokenId]) revert CasBonusAlreadyGranted(tokenId);

        amount = phases[certificate.phaseId].minCasDeposit;
        casBonusGranted[tokenId] = true;

        uint256 balanceBefore = casToken.balanceOf(certificate.recipient);
        casToken.safeTransferFrom(msg.sender, certificate.recipient, amount);
        uint256 balanceAfter = casToken.balanceOf(certificate.recipient);
        uint256 received = balanceAfter >= balanceBefore
            ? balanceAfter - balanceBefore
            : 0;
        if (received < amount) {
            revert CasBonusTransferMismatch(amount, received);
        }

        emit CasBonusGranted(
            tokenId,
            certificate.recipient,
            msg.sender,
            amount
        );
    }

    // -----------------------------------------------------------------------
    // Pausable
    // -----------------------------------------------------------------------

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // -----------------------------------------------------------------------
    // View functions
    // -----------------------------------------------------------------------

    // getPhase removed — phases mapping is public with auto-getter.
    // getPhasePrerequisites removed — read phasePrerequisites mapping directly.
    // The public mapping would generate a getter, but it's private.
    // Backend can use eth_getStorageAt or a future facet to read prerequisites.

    // hasCertificateForPhase removed — check via casDeposits or getCertificate.
    // getMerkleRootProof/getMerkleRoot removed — certificateMerkleRootProofs
    // and certificateMerkleRoots are public mappings with auto-getters.
    // getPhase/certificateOf/getCertificate/tokenBoundAccount explicit
    // getters intentionally omitted: the deployed contract (verified on
    // Polygonscan) does not have them either — callers use the public
    // mapping getters (phases/certificatesByRecipientAndPhase/certificates)
    // directly, which backend/certificate-service.js already does via its
    // fetchPhase/getCertificateOrFallback/certificateOfOrFallback helpers.
    // getMintCount also omitted — mintCountByRecipientAndPhase is a public
    // mapping with an auto-generated getter of the same shape.
    // createPhase/setPhaseExtraFeeType/setPhaseMultipleIssuance/
    // updatePhaseMetadata/setPhasePrerequisites/activatePhase/
    // deactivatePhase moved to RapportCertificatePhaseAdminFacet (see
    // fallback() above) — all size-constrained tradeoffs, see EIP-170 note.

    function locked(uint256 tokenId) external view override returns (bool) {
        _requireCertificate(tokenId);
        return true;
    }

    // -----------------------------------------------------------------------
    // ERC-721 overrides (soulbound)
    // -----------------------------------------------------------------------

    function approve(address, uint256 tokenId) public pure override {
        revert CertificateLocked(tokenId);
    }

    function setApprovalForAll(address, bool) public pure override {
        revert CertificateLocked(0);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721Upgradeable, AccessControlEnumerableUpgradeable, IERC165)
        returns (bool)
    {
        return interfaceId == type(IERC5192).interfaceId
            || super.supportsInterface(interfaceId);
    }

    function _baseURI() internal view override returns (string memory) {
        return baseTokenURI;
    }

    function _update(address to, uint256 tokenId, address auth)
        internal
        override
        returns (address)
    {
        address from = _ownerOf(tokenId);
        if (from != address(0)) revert CertificateLocked(tokenId);
        return super._update(to, tokenId, auth);
    }

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------

    function _getMintDigest(CertificateMintAuthorization calldata authorization)
        internal
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                MINT_AUTHORIZATION_TYPEHASH,
                authorization.issuanceId,
                authorization.recipient,
                authorization.nameHash,
                authorization.phaseId,
                authorization.metadataHash,
                authorization.casAmount,
                authorization.nonce,
                authorization.deadline
            )
        );
        return _hashTypedDataV4(structHash);
    }

    function _requireCertificate(uint256 tokenId)
        internal
        view
        returns (Certificate storage certificate)
    {
        if (_ownerOf(tokenId) == address(0)) revert CertificateNotFound(tokenId);
        return certificates[tokenId];
    }
}
