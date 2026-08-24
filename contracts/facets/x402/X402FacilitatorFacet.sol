// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { LibDiamond } from "../../diamond/libraries/LibDiamond.sol";
import { DiamondAccessControl } from "../../diamond/access/DiamondAccessControl.sol";
import { PaymentStorage } from "../../diamond/storage/PaymentStorage.sol";
import { X402Storage } from "../../diamond/storage/X402Storage.sol";
import { SignatureLib } from "../../libs/SignatureLib.sol";

/**
 * @title X402FacilitatorFacet
 * @dev On-chain facilitator/verifier for the x402 (HTTP 402 Payment
 *      Required) pay-per-call pattern between agents. Two settlement
 *      paths are supported:
 *
 *      1. `payDirect` — the payer's own wallet calls the Diamond
 *         directly; `msg.sender` alone authorizes the transfer (no
 *         third party is relaying on their behalf, so relying on
 *         `msg.sender` here is legitimate, per solidity-security.md §9).
 *      2. `settleWithAuthorization` — a `X402_RELAYER_ROLE` account (the
 *         backend facilitator) submits an EIP-712 payment authorization
 *         signed off-chain by the payer, enabling gasless/pay-per-call
 *         flows where the payer never sends their own transaction.
 *
 *      Both paths settle CAS from payer to payee, minus a protocol fee
 *      sent to the InfrastructureFund, and use `requestHash` (unique per
 *      off-chain HTTP request) as the anti-replay key — never a plain
 *      counter, since the caller does not control request ordering.
 *
 *      Padrões: Diamond Storage (EIP-2535), Facilitator (x402 role),
 *      Strategy (direct vs. authorized settlement)
 */
contract X402FacilitatorFacet {
    using SafeERC20 for IERC20;

    // -----------------------------------------------------------------------
    // EIP-712 typed data
    // -----------------------------------------------------------------------

    string private constant DOMAIN_NAME = "AgenticSpaceX402";
    string private constant DOMAIN_VERSION = "1";

    bytes32 private constant X402_AUTHORIZATION_TYPEHASH = keccak256(
        "X402Authorization(address payer,address payee,bytes32 requestHash,uint256 amount,uint256 deadline)"
    );

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    event X402Initialized(uint256 protocolFeeBps);
    event PaymentSettled(address indexed payer, address indexed payee, bytes32 indexed requestHash, uint256 amount, uint256 fee, bool viaAuthorization);

    // -----------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------

    error AlreadyInitialized();
    error InvalidBps(uint256 bps);
    error InvalidAmount();
    error InvalidPayee();
    error DeadlineExpired(uint256 deadline);
    error RequestAlreadySettled(address payer, bytes32 requestHash);
    error InvalidSignature();
    error CasTokenNotSet();
    error InfrastructureFundNotSet();

    uint256 private constant BPS_DENOMINATOR = 10_000;

    // -----------------------------------------------------------------------
    // Admin
    // -----------------------------------------------------------------------

    function initX402(uint256 protocolFeeBps) external {
        LibDiamond.enforceIsContractOwner();
        X402Storage.X402StorageData storage s = X402Storage.x402Storage();
        if (s.initialized) revert AlreadyInitialized();
        if (protocolFeeBps > BPS_DENOMINATOR) revert InvalidBps(protocolFeeBps);

        s.protocolFeeBps = protocolFeeBps;
        s.initialized = true;

        DiamondAccessControl.grantRole(DiamondAccessControl.X402_RELAYER_ROLE, LibDiamond.contractOwner());

        emit X402Initialized(protocolFeeBps);
    }

    function setX402ProtocolFeeBps(uint256 bps) external {
        DiamondAccessControl.enforceRoleOrOwner(DiamondAccessControl.X402_RELAYER_ROLE);
        if (bps > BPS_DENOMINATOR) revert InvalidBps(bps);
        X402Storage.x402Storage().protocolFeeBps = bps;
    }

    // -----------------------------------------------------------------------
    // Settlement
    // -----------------------------------------------------------------------

    /**
     * @dev Direct settlement: `msg.sender` is the payer and pays `payee`
     *      `amount` CAS for the HTTP request identified by `requestHash`.
     */
    function payDirect(address payee, bytes32 requestHash, uint256 amount, uint256 deadline) external {
        LibDiamond.enforceNotPaused();
        if (block.timestamp > deadline) revert DeadlineExpired(deadline);
        _settle(msg.sender, payee, requestHash, amount, false);
    }

    /**
     * @dev Facilitator settlement: an account with `X402_RELAYER_ROLE`
     *      submits a payment authorization signed off-chain by `payer`
     *      (EIP-712), so the payer never needs to send a transaction.
     */
    function settleWithAuthorization(
        address payer,
        address payee,
        bytes32 requestHash,
        uint256 amount,
        uint256 deadline,
        bytes calldata signature
    ) external {
        LibDiamond.enforceNotPaused();
        DiamondAccessControl.enforceRoleOrOwner(DiamondAccessControl.X402_RELAYER_ROLE);
        if (block.timestamp > deadline) revert DeadlineExpired(deadline);

        bytes32 structHash = keccak256(
            abi.encode(X402_AUTHORIZATION_TYPEHASH, payer, payee, requestHash, amount, deadline)
        );
        bytes32 digest = SignatureLib.hashTypedData(
            SignatureLib.domainSeparator(DOMAIN_NAME, DOMAIN_VERSION),
            structHash
        );
        address signer = SignatureLib.recover(digest, signature);
        if (signer != payer) revert InvalidSignature();

        _settle(payer, payee, requestHash, amount, true);
    }

    function _settle(
        address payer,
        address payee,
        bytes32 requestHash,
        uint256 amount,
        bool viaAuthorization
    ) private {
        if (amount == 0) revert InvalidAmount();
        if (payee == address(0)) revert InvalidPayee();

        X402Storage.X402StorageData storage s = X402Storage.x402Storage();
        if (s.usedRequests[payer][requestHash]) revert RequestAlreadySettled(payer, requestHash);
        s.usedRequests[payer][requestHash] = true;

        PaymentStorage.PaymentStorageData storage ps = PaymentStorage.paymentStorage();
        if (address(ps.casToken) == address(0)) revert CasTokenNotSet();
        if (ps.infrastructureFund == address(0)) revert InfrastructureFundNotSet();

        uint256 fee = (amount * s.protocolFeeBps) / BPS_DENOMINATOR;
        uint256 net = amount - fee;

        if (net > 0) ps.casToken.safeTransferFrom(payer, payee, net);
        if (fee > 0) ps.casToken.safeTransferFrom(payer, ps.infrastructureFund, fee);

        emit PaymentSettled(payer, payee, requestHash, amount, fee, viaAuthorization);
    }

    // -----------------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------------

    function isRequestSettled(address payer, bytes32 requestHash) external view returns (bool) {
        return X402Storage.x402Storage().usedRequests[payer][requestHash];
    }

    function getX402ProtocolFeeBps() external view returns (uint256) {
        return X402Storage.x402Storage().protocolFeeBps;
    }

    function computeAuthorizationDigest(
        address payer,
        address payee,
        bytes32 requestHash,
        uint256 amount,
        uint256 deadline
    ) external view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(X402_AUTHORIZATION_TYPEHASH, payer, payee, requestHash, amount, deadline)
        );
        return SignatureLib.hashTypedData(
            SignatureLib.domainSeparator(DOMAIN_NAME, DOMAIN_VERSION),
            structHash
        );
    }
}
