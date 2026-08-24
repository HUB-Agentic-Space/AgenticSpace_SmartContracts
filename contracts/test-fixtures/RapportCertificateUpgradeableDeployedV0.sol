// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

// TEST-ONLY FIXTURE — do not deploy to any real network.
//
// This is a verbatim copy of the RapportCertificateUpgradeable source that
// is actually verified and deployed on Polygon mainnet as the current
// implementation behind the RapportCertificate proxy (fetched from
// Polygonscan's "Exact Match" verified source for
// 0x16aA44ab5ed4f7B2A33d6350680104c9F6bcF31D on 2026-08-18). It exists
// solely so upgrade-safety tests can simulate the REAL storage layout
// transition (old deployed contract -> new split main contract + phase
// admin facet) instead of a synthetic/idealized starting point, per
// solidity-security.md's storage-layout validation requirement.
//
// Renamed to `RapportCertificateUpgradeableDeployedV0` to avoid colliding
// with the real `RapportCertificateUpgradeable` contract name during
// compilation and Hardhat Upgrades' manifest tracking.

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

/// @title Rapport Certificate (Upgradeable)
/// @notice Non-transferable ERC-721 certificates whose owners control a
///         dedicated ERC-6551 token-bound account holding their CAS reserve.
/// @dev UUPS proxy pattern. Storage layout MUST be preserved across upgrades.
///      Gap variables are reserved for future fields. Do NOT reorder existing
///      storage slots when upgrading.
contract RapportCertificateUpgradeableDeployedV0 is
    ERC721Upgradeable,
    IERC5192,
    AccessControlEnumerableUpgradeable,
    PausableUpgradeable,
    EIP712Upgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    // -----------------------------------------------------------------------
    // Constants (do not occupy storage slots)
    // -----------------------------------------------------------------------

    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");
    bytes32 public constant PHASE_MANAGER_ROLE = keccak256("PHASE_MANAGER_ROLE");
    bytes32 public constant REVOKER_ROLE = keccak256("REVOKER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant BONUS_MANAGER_ROLE = keccak256("BONUS_MANAGER_ROLE");
    bytes32 public constant TRUSTED_CALLER_ROLE = keccak256("TRUSTED_CALLER_ROLE");

    bytes32 public constant ACCOUNT_SALT =
        keccak256("RAPPORT_CERTIFICATE_ACCOUNT_V1");
    bytes32 public constant FOUNDERS_TEMPLATE_HASH =
        keccak256("RAPPORT_FOUNDERS_CERTIFICATE_SVG_V1");
    uint256 public constant FOUNDERS_MIN_CAS_DEPOSIT = 50 * 1e18;

    uint256 public constant FOUNDER_PHASE_ID = 1;
    uint256 public constant BPS_DENOMINATOR = 10000;

    bytes10 private constant ERC6551_PROXY_PREFIX =
        0x363d3d373d3d3d363d73;
    bytes15 private constant ERC6551_PROXY_SUFFIX =
        0x5af43d82803e903d91602b57fd5bf3;

    bytes32 public constant MINT_AUTHORIZATION_TYPEHASH = keccak256(
        "CertificateMintAuthorization(bytes32 issuanceId,address recipient,bytes32 nameHash,uint256 phaseId,bytes32 metadataHash,uint256 casAmount,uint256 nonce,uint256 deadline)"
    );

    // -----------------------------------------------------------------------
    // Structs
    // -----------------------------------------------------------------------

    struct CertificateMintAuthorization {
        bytes32 issuanceId;
        address recipient;
        bytes32 nameHash;
        uint256 phaseId;
        bytes32 metadataHash;
        uint256 casAmount;
        uint256 nonce;
        uint256 deadline;
    }

    struct Phase {
        string name;
        bytes32 templateHash;
        uint256 minCasDeposit;
        uint256 startsAt;
        uint256 endsAt;
        uint256 minted;
        bool active;
        string skillsDescription;
        string instructions;
        uint256 extraFeeTypeId;
        uint256 tbaRebateBps;
    }

    struct Certificate {
        uint256 phaseId;
        address recipient;
        address tokenBoundAccount;
        bytes32 issuanceId;
        bytes32 nameHash;
        bytes32 metadataHash;
        uint256 casDeposited;
        uint256 issuedAt;
        bool revoked;
        bytes32 revocationReasonHash;
        uint256 revokedAt;
        bytes32 documentHash;
    }

    // -----------------------------------------------------------------------
    // Storage — slots 1..N (DO NOT REORDER)
    // -----------------------------------------------------------------------

    /// @dev Address of the CAS token. Set once in initializer (not immutable
    ///      because proxy storage cannot use immutable).
    IERC20 public casToken;

    /// @dev ERC-6551 registry singleton.
    IERC6551Registry public erc6551Registry;

    /// @dev ERC-6551 account implementation.
    address public accountImplementation;

    uint256 public phaseCount;
    uint256 public currentPhaseId;
    uint256 public totalCertificates;

    mapping(address recipient => uint256 nonce) public nonces;
    mapping(bytes32 issuanceId => bool used) public issuanceUsed;
    mapping(uint256 tokenId => bool granted) public casBonusGranted;

    mapping(uint256 phaseId => Phase phase) public phases;
    mapping(uint256 tokenId => Certificate certificate) public certificates;
    mapping(address recipient => mapping(uint256 phaseId => uint256 tokenId))
        public certificatesByRecipientAndPhase;
    mapping(bytes32 documentHash => uint256 tokenId) public tokensByDocumentHash;

    mapping(uint256 tokenId => bytes32 merkleRoot) public certificateMerkleRoots;
    mapping(uint256 tokenId => bytes32 merkleRootProof)
        public certificateMerkleRootProofs;

    mapping(uint256 phaseId => bool) public activePhases;

    mapping(uint256 phaseId => uint256[]) public phasePrerequisites;

    mapping(address recipient => mapping(uint256 phaseId => uint256 amount))
        public casDeposits;

    uint256 private _totalCasDeposited;

    string private baseTokenURI;

    /// @dev Manual reentrancy guard (OZ 5.x upgradeable set lacks
    ///      ReentrancyGuardUpgradeable). Uses transient storage when available.
    uint256 private _reentrancyStatus;

    // -----------------------------------------------------------------------
    // Storage gap — reserve space for future upgrades.
    // -----------------------------------------------------------------------
    uint256[40] private __gap;

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    event PhaseCreated(
        uint256 indexed phaseId,
        string name,
        bytes32 indexed templateHash,
        uint256 minCasDeposit,
        uint256 startsAt,
        uint256 endsAt
    );
    event PhaseActivated(uint256 indexed phaseId, uint256 indexed previousPhaseId);
    event PhaseDeactivated(uint256 indexed phaseId);
    event CertificateMinted(
        uint256 indexed tokenId,
        uint256 indexed phaseId,
        address indexed recipient,
        address tokenBoundAccount,
        bytes32 issuanceId,
        bytes32 nameHash,
        bytes32 metadataHash,
        uint256 casAmount
    );
    event CertificateRevoked(
        uint256 indexed tokenId,
        bytes32 indexed reasonHash,
        address indexed revokedBy
    );
    event DocumentHashAttested(
        uint256 indexed tokenId,
        bytes32 indexed documentHash,
        address indexed attestedBy
    );
    event MerkleRootAttested(
        uint256 indexed tokenId,
        bytes32 indexed merkleRoot,
        address indexed attestedBy
    );
    event CasBonusGranted(
        uint256 indexed tokenId,
        address indexed recipient,
        address indexed paidBy,
        uint256 amount
    );
    event CasDeposited(
        address indexed recipient,
        uint256 indexed phaseId,
        uint256 amount,
        uint256 newBalance
    );
    event PhasePrerequisitesSet(
        uint256 indexed phaseId,
        uint256[] prerequisitePhaseIds
    );
    event PhaseMetadataUpdated(
        uint256 indexed phaseId,
        string skillsDescription,
        string instructions
    );
    event MerkleRootProofAttested(
        uint256 indexed tokenId,
        bytes32 indexed merkleRootProof,
        address indexed attestedBy
    );
    event PhaseExtraFeeTypeUpdated(
        uint256 indexed phaseId,
        uint256 extraFeeTypeId,
        uint256 tbaRebateBps
    );

    // -----------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------

    error ZeroAddress();
    error InvalidContract(address account);
    error EmptyName();
    error EmptyHash();
    error InvalidPhase(uint256 phaseId);
    error PhaseNotActive(uint256 phaseId);
    error PhaseNotStarted(uint256 phaseId, uint256 startsAt);
    error PhaseEnded(uint256 phaseId, uint256 endsAt);
    error InvalidPhaseWindow(uint256 startsAt, uint256 endsAt);
    error RecipientMustCall(address recipient, address caller);
    error AuthorizationExpired(uint256 deadline);
    error InvalidNonce(uint256 expected, uint256 provided);
    error IssuanceAlreadyUsed(bytes32 issuanceId);
    error InvalidIssuerSignature(address issuer);
    error InsufficientCasDeposit(uint256 required, uint256 provided);
    error CasDepositMismatch(uint256 expectedMinimum, uint256 received);
    error TokenBoundAccountAddressMismatch(address expected, address returnedAccount);
    error TokenBoundAccountCodeMismatch(
        address account,
        bytes32 expectedCodeHash,
        bytes32 actualCodeHash
    );
    error CertificateAlreadyIssued(address recipient, uint256 phaseId, uint256 tokenId);
    error CertificateNotFound(uint256 tokenId);
    error CertificateLocked(uint256 tokenId);
    error CertificateAlreadyRevoked(uint256 tokenId);
    error CertificateIsRevoked(uint256 tokenId);
    error DocumentHashAlreadySet(uint256 tokenId);
    error DocumentHashAlreadyUsed(bytes32 documentHash, uint256 tokenId);
    error MerkleRootAlreadySet(uint256 tokenId);
    error MerkleRootProofAlreadySet(uint256 tokenId);
    error CasBonusAlreadyGranted(uint256 tokenId);
    error CasBonusTransferMismatch(uint256 expectedMinimum, uint256 received);
    error InsufficientCasDepositBalance(uint256 available, uint256 required);
    error NoCasDepositToWithdraw(uint256 available);
    error DepositPhaseNotActive(uint256 phaseId);
    error PhaseAlreadyActive(uint256 phaseId);
    error PhaseNotActiveForDeactivation(uint256 phaseId);
    error PrerequisitePhaseNotFound(uint256 phaseId);
    error PrerequisiteCycleDetected(uint256 phaseId, uint256 prerequisitePhaseId);
    error PhasePrerequisitesNotMet(uint256 phaseId, uint256 missingPrerequisite);
    error SelfPrerequisite(uint256 phaseId);
    error InvalidRebateBps(uint256 provided, uint256 max);
    error ReentrantCall();

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
            tbaRebateBps: 0
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
    // Phase management
    // -----------------------------------------------------------------------

    function createPhase(
        string calldata name_,
        bytes32 templateHash,
        uint256 minCasDeposit,
        uint256 startsAt,
        uint256 endsAt,
        string calldata skillsDescription_,
        string calldata instructions_,
        uint256 extraFeeTypeId_,
        uint256 tbaRebateBps_
    ) external onlyRole(PHASE_MANAGER_ROLE) returns (uint256 phaseId) {
        if (bytes(name_).length == 0) revert EmptyName();
        if (templateHash == bytes32(0)) revert EmptyHash();
        if (minCasDeposit == 0) revert InsufficientCasDeposit(1, 0);
        if (tbaRebateBps_ > BPS_DENOMINATOR) {
            revert InvalidRebateBps(tbaRebateBps_, BPS_DENOMINATOR);
        }

        uint256 effectiveStart = startsAt == 0 ? block.timestamp : startsAt;
        if (endsAt != 0 && endsAt <= effectiveStart) {
            revert InvalidPhaseWindow(effectiveStart, endsAt);
        }

        phaseId = ++phaseCount;
        phases[phaseId] = Phase({
            name: name_,
            templateHash: templateHash,
            minCasDeposit: minCasDeposit,
            startsAt: effectiveStart,
            endsAt: endsAt,
            minted: 0,
            active: false,
            skillsDescription: skillsDescription_,
            instructions: instructions_,
            extraFeeTypeId: extraFeeTypeId_,
            tbaRebateBps: tbaRebateBps_
        });

        emit PhaseCreated(
            phaseId,
            name_,
            templateHash,
            minCasDeposit,
            effectiveStart,
            endsAt
        );

        if (extraFeeTypeId_ != 0 || tbaRebateBps_ != 0) {
            emit PhaseExtraFeeTypeUpdated(phaseId, extraFeeTypeId_, tbaRebateBps_);
        }
    }

    function setPhaseExtraFeeType(
        uint256 phaseId,
        uint256 extraFeeTypeId_,
        uint256 tbaRebateBps_
    ) external onlyRole(PHASE_MANAGER_ROLE) {
        Phase storage phase = phases[phaseId];
        if (bytes(phase.name).length == 0) revert InvalidPhase(phaseId);
        if (tbaRebateBps_ > BPS_DENOMINATOR) {
            revert InvalidRebateBps(tbaRebateBps_, BPS_DENOMINATOR);
        }
        phase.extraFeeTypeId = extraFeeTypeId_;
        phase.tbaRebateBps = tbaRebateBps_;
        emit PhaseExtraFeeTypeUpdated(phaseId, extraFeeTypeId_, tbaRebateBps_);
    }

    function updatePhaseMetadata(
        uint256 phaseId,
        string calldata skillsDescription_,
        string calldata instructions_
    ) external onlyRole(PHASE_MANAGER_ROLE) {
        Phase storage phase = phases[phaseId];
        if (bytes(phase.name).length == 0) revert InvalidPhase(phaseId);
        phase.skillsDescription = skillsDescription_;
        phase.instructions = instructions_;
        emit PhaseMetadataUpdated(phaseId, skillsDescription_, instructions_);
    }

    function activatePhase(uint256 phaseId) external onlyRole(PHASE_MANAGER_ROLE) {
        Phase storage phase = phases[phaseId];
        if (bytes(phase.name).length == 0) revert InvalidPhase(phaseId);
        if (activePhases[phaseId]) revert PhaseAlreadyActive(phaseId);

        phase.active = true;
        activePhases[phaseId] = true;
        currentPhaseId = phaseId;
        emit PhaseActivated(phaseId, 0);
    }

    function deactivatePhase(uint256 phaseId) external onlyRole(PHASE_MANAGER_ROLE) {
        Phase storage phase = phases[phaseId];
        if (bytes(phase.name).length == 0) revert InvalidPhase(phaseId);
        if (!activePhases[phaseId]) revert PhaseNotActiveForDeactivation(phaseId);

        phase.active = false;
        activePhases[phaseId] = false;
        if (currentPhaseId == phaseId) {
            currentPhaseId = 0;
        }
        emit PhaseDeactivated(phaseId);
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

    function setPhasePrerequisites(
        uint256 phaseId,
        uint256[] calldata prerequisitePhaseIds
    ) external onlyRole(PHASE_MANAGER_ROLE) {
        Phase storage phase = phases[phaseId];
        if (bytes(phase.name).length == 0) revert InvalidPhase(phaseId);

        for (uint256 i = 0; i < prerequisitePhaseIds.length; i++) {
            uint256 prereqId = prerequisitePhaseIds[i];
            if (prereqId == phaseId) revert SelfPrerequisite(phaseId);
            if (bytes(phases[prereqId].name).length == 0) {
                revert PrerequisitePhaseNotFound(prereqId);
            }
            if (_wouldCreateCycle(prereqId, phaseId, 0)) {
                revert PrerequisiteCycleDetected(phaseId, prereqId);
            }
        }

        phasePrerequisites[phaseId] = prerequisitePhaseIds;
        emit PhasePrerequisitesSet(phaseId, prerequisitePhaseIds);
    }

    // getPhasePrerequisites removed — read phasePrerequisites mapping directly.
    // The public mapping would generate a getter, but it's private.
    // Backend can use eth_getStorageAt or a future facet to read prerequisites.

    // hasCertificateForPhase removed — check via casDeposits or getCertificate.
    // getMerkleRootProof/getMerkleRoot removed — certificateMerkleRootProofs
    // and certificateMerkleRoots are public mappings with auto-getters.

    // getCertificate removed — certificates mapping is public with auto-getter.

    // certificateOf removed — read certificatesByRecipientAndPhase via getCertificate.
    // tokenBoundAccount removed — read via getCertificate(tokenId).tokenBoundAccount.

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

    /// @dev DFS cycle detection using a bitmap to track visited nodes.
    ///      Each bit position represents a phase ID. This avoids array
    ///      allocations that bloat bytecode.
    function _wouldCreateCycle(
        uint256 current,
        uint256 target,
        uint256 visitedBitmap
    ) internal view returns (bool) {
        if (current == target) return true;
        if (visitedBitmap & (1 << current) != 0) return false;
        visitedBitmap |= (1 << current);

        uint256[] storage prereqs = phasePrerequisites[current];
        for (uint256 i = 0; i < prereqs.length; i++) {
            if (_wouldCreateCycle(prereqs[i], target, visitedBitmap)) {
                return true;
            }
        }
        return false;
    }
}
