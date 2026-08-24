// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC6551Registry } from "../interfaces/IERC6551Registry.sol";

/// @title Rapport Certificate — Shared Storage
/// @notice Holds every state variable, struct, role constant, error and event
///         shared between `RapportCertificateUpgradeable` (the UUPS proxy's
///         main implementation) and `RapportCertificatePhaseAdminFacet` (a
///         plain, non-proxied logic contract reached only via the main
///         contract's `fallback()` + `delegatecall`, introduced to keep the
///         main implementation under the EIP-170 24576-byte size limit).
/// @dev CRITICAL: this contract must be the FIRST item in the inheritance
///      list of both `RapportCertificateUpgradeable` and
///      `RapportCertificatePhaseAdminFacet`, and its state variables must
///      NEVER be reordered, retyped, or removed — a `delegatecall` from the
///      main proxy into the facet only works correctly if both contracts
///      agree on the exact same sequential storage slot layout for these
///      variables. The OpenZeppelin Upgradeable v5 mixins used by the main
///      contract (ERC721Upgradeable, AccessControlEnumerableUpgradeable,
///      PausableUpgradeable, EIP712Upgradeable, UUPSUpgradeable) use
///      ERC-7201 namespaced storage internally and do NOT consume any of
///      these sequential slots (verified empirically against the deployed
///      mainnet contract: slot 0 holds `casToken`, with no gap from any OZ
///      mixin) — this is what makes this pattern safe here.
abstract contract RapportCertificateStorage {
    // -----------------------------------------------------------------------
    // Roles (constants — do not occupy storage slots)
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

    bytes10 internal constant ERC6551_PROXY_PREFIX =
        0x363d3d373d3d3d363d73;
    bytes15 internal constant ERC6551_PROXY_SUFFIX =
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
        // Multiple issuance (added by upgrade). Appended at the end of the
        // struct: safe for existing mapping entries (each Phase occupies its
        // own contiguous storage region keyed by phaseId, same pattern used
        // when extraFeeTypeId/tbaRebateBps were added).
        bool allowMultipleIssuance;
        uint256 maxPerRecipient;
        uint256 maxTotalSupply;
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
    // Storage — sequential slots, in this exact order (DO NOT REORDER)
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

    uint256 internal _totalCasDeposited;

    string internal baseTokenURI;

    /// @dev Manual reentrancy guard (OZ 5.x upgradeable set lacks
    ///      ReentrancyGuardUpgradeable). Uses transient storage when available.
    uint256 internal _reentrancyStatus;

    /// @dev Number of certificates minted to `recipient` under `phaseId`.
    ///      Only meaningful for phases with `allowMultipleIssuance = true`;
    ///      for single-issuance phases, `certificatesByRecipientAndPhase`
    ///      remains the source of truth. Added by upgrade: takes one slot
    ///      from `__gap` below (40 -> 38, one more slot also consumed by
    ///      `phaseAdminFacet` below) instead of appending after it, per the
    ///      project's upgrade-safety convention (see solidity-security.md).
    mapping(address recipient => mapping(uint256 phaseId => uint256 count))
        public mintCountByRecipientAndPhase;

    /// @dev Address of the logic contract holding phase-administration
    ///      functions (createPhase, setPhaseExtraFeeType,
    ///      setPhaseMultipleIssuance, updatePhaseMetadata,
    ///      setPhasePrerequisites, activatePhase, deactivatePhase), reached
    ///      via `RapportCertificateUpgradeable.fallback()` + `delegatecall`.
    ///      Kept out of the main implementation to stay under the EIP-170
    ///      24576-byte contract size limit. Never itself used as a proxy
    ///      target — it is deployed as a plain contract and only ever
    ///      delegatecalled into.
    address public phaseAdminFacet;

    // -----------------------------------------------------------------------
    // Storage gap — reserve space for future upgrades.
    // -----------------------------------------------------------------------
    uint256[38] private __gap;

    // -----------------------------------------------------------------------
    // Events (shared by main contract and phase-admin facet)
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
    event PhaseMultipleIssuanceUpdated(
        uint256 indexed phaseId,
        bool allowMultipleIssuance,
        uint256 maxPerRecipient,
        uint256 maxTotalSupply
    );
    event PhaseAdminFacetUpdated(address indexed oldFacet, address indexed newFacet);
    event BaseURIUpdated(string oldBaseURI, string newBaseURI);

    // -----------------------------------------------------------------------
    // Errors (shared by main contract and phase-admin facet)
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
    error MultipleIssuanceConfigInvalid(uint256 maxPerRecipient, uint256 maxTotalSupply);
    error MaxIssuancePerRecipientReached(uint256 phaseId, address recipient, uint256 max);
    error MaxTotalSupplyReached(uint256 phaseId, uint256 max);
    error PhaseAdminFacetNotSet();
}
