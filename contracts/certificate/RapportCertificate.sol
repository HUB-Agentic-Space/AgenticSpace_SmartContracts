// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { AccessControlEnumerable } from "@openzeppelin/contracts/access/extensions/AccessControlEnumerable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ERC721 } from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";
import { ReentrancyGuardTransient } from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { SignatureChecker } from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import { IERC5192 } from "../interfaces/IERC5192.sol";
import { IERC6551Registry } from "../interfaces/IERC6551Registry.sol";

/// @title Rapport Certificate
/// @notice Non-transferable ERC-721 certificates whose owners control a
///         dedicated ERC-6551 token-bound account holding their CAS reserve.
contract RapportCertificate is
    ERC721,
    IERC5192,
    AccessControlEnumerable,
    Pausable,
    ReentrancyGuardTransient,
    EIP712
{
    using SafeERC20 for IERC20;

    string public constant ISSUER_LEGAL_NAME = "Raport Tecnologia Inova Simples";
    string public constant ISSUER_CNPJ = "67.904.299/0001-80";
    string public constant RAPPORT_WEBSITE = "https://rapport.tec.br";
    string public constant AGENTIC_SPACE_WEBSITE =
        "https://agenticspace.rapport.tec.br";

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

    // ERC-1167 runtime used by the canonical ERC-6551 v0.3.1 registry. The
    // registry appends abi.encode(salt, chainId, tokenContract, tokenId).
    bytes10 private constant ERC6551_PROXY_PREFIX =
        0x363d3d373d3d3d363d73;
    bytes15 private constant ERC6551_PROXY_SUFFIX =
        0x5af43d82803e903d91602b57fd5bf3;

    bytes32 public constant MINT_AUTHORIZATION_TYPEHASH = keccak256(
        "CertificateMintAuthorization(bytes32 issuanceId,address recipient,bytes32 nameHash,uint256 phaseId,bytes32 metadataHash,uint256 casAmount,uint256 nonce,uint256 deadline)"
    );

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

    IERC20 public immutable casToken;
    IERC6551Registry public immutable erc6551Registry;
    address public immutable accountImplementation;

    uint256 public phaseCount;
    uint256 public currentPhaseId;
    uint256 public totalCertificates;

    mapping(address recipient => uint256 nonce) public nonces;
    mapping(bytes32 issuanceId => bool used) public issuanceUsed;
    mapping(uint256 tokenId => bool granted) public casBonusGranted;

    mapping(uint256 phaseId => Phase phase) private phases;
    mapping(uint256 tokenId => Certificate certificate) private certificates;
    mapping(address recipient => mapping(uint256 phaseId => uint256 tokenId))
        private certificatesByRecipientAndPhase;
    mapping(bytes32 documentHash => uint256 tokenId) private tokensByDocumentHash;

    /// @dev Tracks CAS deposited by a user for a specific phase via
    ///      depositCasForMint(). The mint consumes from this balance instead
    ///      of pulling CAS via transferFrom, avoiding MetaMask Blockaid flags.
    mapping(address recipient => mapping(uint256 phaseId => uint256 amount))
        private casDeposits;

    /// @dev Total CAS accounted for in the deposit ledger. Used to compute
    ///      unaccounted balance when a new deposit arrives.
    uint256 private _totalCasDeposited;

    string private baseTokenURI;

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
    error CasBonusAlreadyGranted(uint256 tokenId);
    error CasBonusTransferMismatch(uint256 expectedMinimum, uint256 received);
    error InsufficientCasDepositBalance(uint256 available, uint256 required);
    error NoCasDepositToWithdraw(uint256 available);
    error DepositPhaseNotActive(uint256 phaseId);

    constructor(
        address admin,
        address casTokenAddress,
        address registryAddress,
        address accountImplementationAddress,
        string memory baseTokenURI_
    ) ERC721("Rapport Certificate", "RPTCERT") EIP712("RapportCertificate", "1") {
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

        casToken = IERC20(casTokenAddress);
        erc6551Registry = IERC6551Registry(registryAddress);
        accountImplementation = accountImplementationAddress;
        baseTokenURI = baseTokenURI_;

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
            active: true
        });

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

    /// @notice Creates an immutable phase configuration. Activation is a
    ///         separate action so the dashboard can prepare phases in advance.
    function createPhase(
        string calldata name_,
        bytes32 templateHash,
        uint256 minCasDeposit,
        uint256 startsAt,
        uint256 endsAt
    ) external onlyRole(PHASE_MANAGER_ROLE) returns (uint256 phaseId) {
        if (bytes(name_).length == 0) revert EmptyName();
        if (templateHash == bytes32(0)) revert EmptyHash();
        if (minCasDeposit == 0) revert InsufficientCasDeposit(1, 0);

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
            active: false
        });

        emit PhaseCreated(
            phaseId,
            name_,
            templateHash,
            minCasDeposit,
            effectiveStart,
            endsAt
        );
    }

    function activatePhase(uint256 phaseId) external onlyRole(PHASE_MANAGER_ROLE) {
        Phase storage phase = phases[phaseId];
        if (bytes(phase.name).length == 0) revert InvalidPhase(phaseId);

        uint256 previousPhaseId = currentPhaseId;
        if (previousPhaseId != 0) {
            phases[previousPhaseId].active = false;
        }

        phase.active = true;
        currentPhaseId = phaseId;
        emit PhaseActivated(phaseId, previousPhaseId);
    }

    function deactivateCurrentPhase() external onlyRole(PHASE_MANAGER_ROLE) {
        uint256 phaseId = currentPhaseId;
        if (phaseId == 0) revert InvalidPhase(0);
        phases[phaseId].active = false;
        currentPhaseId = 0;
        emit PhaseDeactivated(phaseId);
    }

    /// @notice Deposits CAS into this contract for a future mint in the given
    ///         phase. The user calls cas.transfer(certificateContract, amount)
    ///         first, then this function to register the deposit. This avoids
    ///         the approve+transferFrom pattern that triggers MetaMask Blockaid
    ///         deceptive-request warnings.
    /// @dev The CAS must already be in this contract's balance. The function
    ///      credits the caller's deposit ledger for the specified phase.
    function depositCasForMint(uint256 phaseId) external nonReentrant whenNotPaused {
        if (phaseId == 0 || phaseId != currentPhaseId) {
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

    /// @notice Deposits a specific amount of CAS on behalf of a beneficiary.
    ///         Used by the Diamond proxy so the user can transfer CAS to the
    ///         trusted Diamond and the proxy deposits for them on the certificate
    ///         contract.
    /// @dev Only callers with TRUSTED_CALLER_ROLE may credit deposits for others.
    ///      The function checks that the contract balance has grown by at least
    ///      the requested amount compared to the accounted total.
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
        if (phaseId == 0 || phaseId != currentPhaseId) {
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

    /// @notice Withdraws any unused CAS deposit for a phase. Only available
    ///         before the certificate is minted. After mint, the CAS is in the
    ///         token-bound account and cannot be withdrawn here.
    function withdrawCasDeposit(uint256 phaseId) external nonReentrant whenNotPaused {
        uint256 available = casDeposits[msg.sender][phaseId];
        if (available == 0) revert NoCasDepositToWithdraw(0);

        casDeposits[msg.sender][phaseId] = 0;
        _totalCasDeposited -= available;

        casToken.safeTransfer(msg.sender, available);

        emit CasDeposited(msg.sender, phaseId, 0, 0);
    }

    /// @notice Returns the CAS deposit balance for a recipient and phase.
    function casDepositBalance(address recipient, uint256 phaseId)
        external
        view
        returns (uint256)
    {
        return casDeposits[recipient][phaseId];
    }

    /// @notice Mints a certificate using a short-lived EIP-712 authorization
    ///         created by an address holding ISSUER_ROLE. The recipient must
    ///         have previously deposited CAS via depositCasForMint. The
    ///         deposited CAS is moved to the token-bound account.
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
            authorization.phaseId == 0 || authorization.phaseId != currentPhaseId
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

        // Move deposited CAS from this contract to the token-bound account.
        uint256 balanceBefore = casToken.balanceOf(tokenBoundAccount_);
        casToken.safeTransfer(tokenBoundAccount_, authorization.casAmount);
        uint256 balanceAfterTransfer = casToken.balanceOf(tokenBoundAccount_);
        uint256 expectedBalance = balanceBefore + authorization.casAmount;
        if (balanceAfterTransfer < expectedBalance) {
            revert CasDepositMismatch(expectedBalance, balanceAfterTransfer);
        }

        _safeMint(authorization.recipient, tokenId);

        // A contract recipient gets control during onERC721Received. Ensure it
        // cannot remove the just-deposited reserve before issuance completes.
        uint256 finalBalance = casToken.balanceOf(tokenBoundAccount_);
        if (finalBalance < expectedBalance) {
            revert CasDepositMismatch(expectedBalance, finalBalance);
        }

        emit Locked(tokenId);
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

    /// @notice Permanently marks a certificate invalid without burning the NFT
    ///         or blocking access to CAS held in its token-bound account.
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

    /// @notice Anchors the SHA-256 hash of the canonical signed PDF. The hash
    ///         is intentionally one-time to keep verification history stable.
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

    /// @notice Pays the certificate holder a one-time CAS bonus equal to the
    ///         minimum deposit configured for the certificate's phase. Extra
    ///         CAS deposited by the holder does not increase the bonus. The
    ///         authorized caller funds the payment through transferFrom; CAS
    ///         held in the TBA is untouched.
    /// @dev The caller must approve this contract for the phase minimum.
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

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function getPhase(uint256 phaseId) external view returns (Phase memory) {
        Phase storage phase = phases[phaseId];
        if (bytes(phase.name).length == 0) revert InvalidPhase(phaseId);
        return phase;
    }

    function getCertificate(uint256 tokenId)
        external
        view
        returns (Certificate memory)
    {
        return _requireCertificate(tokenId);
    }

    function certificateOf(address recipient, uint256 phaseId)
        external
        view
        returns (uint256 tokenId)
    {
        return certificatesByRecipientAndPhase[recipient][phaseId];
    }

    function tokenBoundAccount(uint256 tokenId) external view returns (address) {
        return _requireCertificate(tokenId).tokenBoundAccount;
    }

    function verifyCertificate(uint256 tokenId)
        external
        view
        returns (
            bool valid,
            address recipient,
            uint256 phaseId,
            address account,
            uint256 currentCasBalance,
            bytes32 metadataHash,
            bytes32 documentHash
        )
    {
        Certificate storage certificate = _requireCertificate(tokenId);
        return (
            !certificate.revoked,
            certificate.recipient,
            certificate.phaseId,
            certificate.tokenBoundAccount,
            casToken.balanceOf(certificate.tokenBoundAccount),
            certificate.metadataHash,
            certificate.documentHash
        );
    }

    function verifyDocument(bytes32 documentHash)
        external
        view
        returns (bool valid, uint256 tokenId)
    {
        tokenId = tokensByDocumentHash[documentHash];
        if (tokenId == 0) return (false, 0);
        return (!certificates[tokenId].revoked, tokenId);
    }

    function getMintDigest(CertificateMintAuthorization calldata authorization)
        external
        view
        returns (bytes32)
    {
        return _getMintDigest(authorization);
    }

    function locked(uint256 tokenId) external view override returns (bool) {
        _requireCertificate(tokenId);
        return true;
    }

    function approve(address, uint256 tokenId) public pure override {
        revert CertificateLocked(tokenId);
    }

    function setApprovalForAll(address, bool) public pure override {
        revert CertificateLocked(0);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721, AccessControlEnumerable, IERC165)
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
