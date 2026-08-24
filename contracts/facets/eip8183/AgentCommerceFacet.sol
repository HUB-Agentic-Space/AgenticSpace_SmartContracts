// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { LibDiamond } from "../../diamond/libraries/LibDiamond.sol";
import { DiamondAccessControl } from "../../diamond/access/DiamondAccessControl.sol";
import { AgentStorage } from "../../diamond/storage/AgentStorage.sol";
import { PaymentStorage } from "../../diamond/storage/PaymentStorage.sol";
import { CommerceStorage } from "../../diamond/storage/CommerceStorage.sol";

/**
 * @title AgentCommerceFacet
 * @dev EIP-8183 agent-to-agent commerce protocol: a seller agent publishes
 *      a service offer, a buyer agent negotiates the price with a
 *      rule-based clamp (no off-chain LLM signs money — only the bounds
 *      enforced here decide what counter-price is acceptable), the
 *      accepted price is escrowed in CAS by the Diamond itself, the seller
 *      marks delivery, and either the buyer confirms or, after the
 *      dispute window, anyone can trigger settlement. A dispute pauses
 *      settlement until `COMMERCE_ARBITER_ROLE` resolves the split.
 *
 *      Only two agents negotiate a given offer; other agents may create
 *      their own offers freely. All state-changing functions follow
 *      Checks-Effects-Interactions: storage state is finalized before any
 *      CAS transfer.
 *
 *      Padrões: Diamond Storage (EIP-2535), State (JobState lifecycle),
 *      Strategy (negotiation bounds), Command (offer as a pending job)
 */
contract AgentCommerceFacet {
    using SafeERC20 for IERC20;

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    event AgentCommerceInitialized(uint256 protocolFeeBps, uint256 disputeWindow);
    event OfferCreated(uint256 indexed offerId, bytes32 indexed sellerAgentId, address sellerAddress, bytes32 scopeHash, uint256 price, uint256 deadline);
    event OfferNegotiated(uint256 indexed offerId, address indexed proposer, uint256 price);
    event OfferAccepted(uint256 indexed offerId, bytes32 buyerAgentId, address buyerAddress, uint256 price);
    event OfferCancelled(uint256 indexed offerId);
    event JobFunded(uint256 indexed offerId, uint256 amount);
    event JobDelivered(uint256 indexed offerId, uint256 deliveredAt);
    event JobSettled(uint256 indexed offerId, uint256 sellerAmount, uint256 protocolFee);
    event DisputeRaised(uint256 indexed offerId, bytes32 reasonHash);
    event DisputeResolved(uint256 indexed offerId, uint256 buyerRefund, uint256 sellerAmount, uint256 protocolFee);

    // -----------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------

    error AlreadyInitialized();
    error NotInitialized();
    error AgentNotFound(bytes32 agentId);
    error NotAgentOwner(bytes32 agentId, address caller);
    error AgentNotActive(bytes32 agentId);
    error InvalidPrice();
    error InvalidDeadline();
    error OfferNotFound(uint256 offerId);
    error OfferExpired(uint256 offerId);
    error InvalidOfferState(uint256 offerId, CommerceStorage.JobState state);
    error NotOfferParty(uint256 offerId, address caller);
    error CannotNegotiateOwnLastProposal(uint256 offerId);
    error PriceOutOfNegotiationBounds(uint256 proposed, uint256 minAllowed, uint256 maxAllowed);
    error BuyerAlreadySet(uint256 offerId);
    error NotBuyer(uint256 offerId, address caller);
    error NotSeller(uint256 offerId, address caller);
    error CasTokenNotSet();
    error InfrastructureFundNotSet();
    error DisputeWindowNotElapsed(uint256 offerId, uint256 elapsedAt);
    error DisputeWindowElapsed(uint256 offerId);
    error InvalidBps(uint256 bps);

    uint256 private constant BPS_DENOMINATOR = 10_000;

    // -----------------------------------------------------------------------
    // Admin
    // -----------------------------------------------------------------------

    /**
     * @dev One-time initializer, called by the contract owner right after
     *      this facet is added to the Diamond via diamondCut.
     * @param protocolFeeBps Protocol fee taken from the seller's share on
     *        settlement (basis points, e.g. 250 = 2.5%).
     * @param disputeWindow Seconds after delivery during which the buyer
     *        may raise a dispute instead of the job auto-settling.
     */
    function initAgentCommerce(uint256 protocolFeeBps, uint256 disputeWindow) external {
        LibDiamond.enforceIsContractOwner();
        CommerceStorage.CommerceStorageData storage s = CommerceStorage.commerceStorage();
        if (s.initialized) revert AlreadyInitialized();
        if (protocolFeeBps > BPS_DENOMINATOR) revert InvalidBps(protocolFeeBps);

        s.protocolFeeBps = protocolFeeBps;
        s.disputeWindow = disputeWindow;
        s.minNegotiationBps = 5_000; // 50%
        s.maxNegotiationBps = 15_000; // 150%
        s.initialized = true;

        DiamondAccessControl.grantRole(DiamondAccessControl.COMMERCE_ARBITER_ROLE, LibDiamond.contractOwner());

        emit AgentCommerceInitialized(protocolFeeBps, disputeWindow);
    }

    function setProtocolFeeBps(uint256 bps) external {
        DiamondAccessControl.enforceRoleOrOwner(DiamondAccessControl.COMMERCE_ARBITER_ROLE);
        if (bps > BPS_DENOMINATOR) revert InvalidBps(bps);
        CommerceStorage.commerceStorage().protocolFeeBps = bps;
    }

    function setDisputeWindow(uint256 seconds_) external {
        DiamondAccessControl.enforceRoleOrOwner(DiamondAccessControl.COMMERCE_ARBITER_ROLE);
        CommerceStorage.commerceStorage().disputeWindow = seconds_;
    }

    function setNegotiationBounds(uint256 minBps, uint256 maxBps) external {
        DiamondAccessControl.enforceRoleOrOwner(DiamondAccessControl.COMMERCE_ARBITER_ROLE);
        if (minBps == 0 || maxBps < minBps) revert InvalidBps(maxBps);
        CommerceStorage.CommerceStorageData storage s = CommerceStorage.commerceStorage();
        s.minNegotiationBps = minBps;
        s.maxNegotiationBps = maxBps;
    }

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------

    function _requireActiveOwnedAgent(bytes32 agentId, address caller) private view {
        AgentStorage.Agent storage agent = AgentStorage.agentStorage().agents[agentId];
        if (agent.registeredAt == 0) revert AgentNotFound(agentId);
        if (agent.ownerAddress != caller) revert NotAgentOwner(agentId, caller);
        if (!agent.isActive) revert AgentNotActive(agentId);
    }

    function _requireActiveAgent(bytes32 agentId) private view returns (address ownerAddress) {
        AgentStorage.Agent storage agent = AgentStorage.agentStorage().agents[agentId];
        if (agent.registeredAt == 0) revert AgentNotFound(agentId);
        if (!agent.isActive) revert AgentNotActive(agentId);
        return agent.ownerAddress;
    }

    function _casToken() private view returns (IERC20) {
        PaymentStorage.PaymentStorageData storage ps = PaymentStorage.paymentStorage();
        if (address(ps.casToken) == address(0)) revert CasTokenNotSet();
        return ps.casToken;
    }

    function _infrastructureFund() private view returns (address) {
        address fund = PaymentStorage.paymentStorage().infrastructureFund;
        if (fund == address(0)) revert InfrastructureFundNotSet();
        return fund;
    }

    // -----------------------------------------------------------------------
    // Offer lifecycle — publish & negotiate
    // -----------------------------------------------------------------------

    function createOffer(
        bytes32 sellerAgentId,
        bytes32 scopeHash,
        uint256 price,
        uint256 deadline
    ) external returns (uint256 offerId) {
        LibDiamond.enforceNotPaused();
        if (!CommerceStorage.commerceStorage().initialized) revert NotInitialized();
        if (price == 0) revert InvalidPrice();
        if (deadline <= block.timestamp) revert InvalidDeadline();
        _requireActiveOwnedAgent(sellerAgentId, msg.sender);

        CommerceStorage.CommerceStorageData storage s = CommerceStorage.commerceStorage();
        offerId = ++s.offerCount;

        s.offers[offerId] = CommerceStorage.Offer({
            offerId: offerId,
            sellerAgentId: sellerAgentId,
            sellerAddress: msg.sender,
            buyerAgentId: bytes32(0),
            buyerAddress: address(0),
            scopeHash: scopeHash,
            price: price,
            lastProposer: msg.sender,
            deadline: deadline,
            state: CommerceStorage.JobState.Open,
            fundedAmount: 0,
            deliveredAt: 0,
            disputeReasonHash: bytes32(0),
            createdAt: block.timestamp,
            updatedAt: block.timestamp
        });
        s.offersBySeller[sellerAgentId].push(offerId);

        emit OfferCreated(offerId, sellerAgentId, msg.sender, scopeHash, price, deadline);
    }

    /**
     * @dev Proposes a counter-price. The first agent (other than the
     *      seller) to negotiate becomes the offer's buyer. Every
     *      subsequent counter-price must stay within
     *      [minNegotiationBps, maxNegotiationBps] of the *original*
     *      listed price — the contract clamps the negotiation range so
     *      neither side (nor an LLM acting on their behalf) can move the
     *      price arbitrarily; only a human/DAO-configured range can.
     */
    function negotiate(uint256 offerId, uint256 counterPrice) external {
        LibDiamond.enforceNotPaused();
        CommerceStorage.CommerceStorageData storage s = CommerceStorage.commerceStorage();
        CommerceStorage.Offer storage offer = s.offers[offerId];
        if (offer.createdAt == 0) revert OfferNotFound(offerId);
        if (block.timestamp > offer.deadline) revert OfferExpired(offerId);
        if (
            offer.state != CommerceStorage.JobState.Open &&
            offer.state != CommerceStorage.JobState.Negotiating
        ) revert InvalidOfferState(offerId, offer.state);
        if (counterPrice == 0) revert InvalidPrice();

        bool isSeller = msg.sender == offer.sellerAddress;
        bool isKnownBuyer = offer.buyerAddress != address(0) && msg.sender == offer.buyerAddress;
        if (!isSeller && !isKnownBuyer) {
            if (offer.buyerAddress != address(0)) revert NotOfferParty(offerId, msg.sender);
            // First counterparty to negotiate becomes the buyer.
            offer.buyerAddress = msg.sender;
        }
        if (msg.sender == offer.lastProposer) revert CannotNegotiateOwnLastProposal(offerId);

        uint256 minAllowed = (s.minNegotiationBps * offer.price) / BPS_DENOMINATOR;
        uint256 maxAllowed = (s.maxNegotiationBps * offer.price) / BPS_DENOMINATOR;
        if (counterPrice < minAllowed || counterPrice > maxAllowed) {
            revert PriceOutOfNegotiationBounds(counterPrice, minAllowed, maxAllowed);
        }

        offer.price = counterPrice;
        offer.lastProposer = msg.sender;
        offer.state = CommerceStorage.JobState.Negotiating;
        offer.updatedAt = block.timestamp;

        emit OfferNegotiated(offerId, msg.sender, counterPrice);
    }

    /**
     * @dev Accepts the counterparty's last proposed price. Only the party
     *      that did *not* make the last proposal may accept, and the
     *      buyer's agent identity is bound at this point.
     */
    function acceptOffer(uint256 offerId, bytes32 buyerAgentId) external {
        LibDiamond.enforceNotPaused();
        CommerceStorage.Offer storage offer = CommerceStorage.commerceStorage().offers[offerId];
        if (offer.createdAt == 0) revert OfferNotFound(offerId);
        if (block.timestamp > offer.deadline) revert OfferExpired(offerId);
        if (
            offer.state != CommerceStorage.JobState.Open &&
            offer.state != CommerceStorage.JobState.Negotiating
        ) revert InvalidOfferState(offerId, offer.state);
        if (msg.sender == offer.lastProposer) revert CannotNegotiateOwnLastProposal(offerId);
        if (msg.sender != offer.sellerAddress && msg.sender != offer.buyerAddress) {
            revert NotOfferParty(offerId, msg.sender);
        }

        if (msg.sender == offer.sellerAddress) {
            if (offer.buyerAgentId != bytes32(0)) revert BuyerAlreadySet(offerId);
            address buyerOwner = _requireActiveAgent(buyerAgentId);
            if (buyerOwner != offer.buyerAddress) revert NotAgentOwner(buyerAgentId, offer.buyerAddress);
            offer.buyerAgentId = buyerAgentId;
        }

        offer.state = CommerceStorage.JobState.Accepted;
        offer.updatedAt = block.timestamp;

        emit OfferAccepted(offerId, offer.buyerAgentId, offer.buyerAddress, offer.price);
    }

    function cancelOffer(uint256 offerId) external {
        LibDiamond.enforceNotPaused();
        CommerceStorage.Offer storage offer = CommerceStorage.commerceStorage().offers[offerId];
        if (offer.createdAt == 0) revert OfferNotFound(offerId);
        if (msg.sender != offer.sellerAddress) revert NotSeller(offerId, msg.sender);
        if (
            offer.state != CommerceStorage.JobState.Open &&
            offer.state != CommerceStorage.JobState.Negotiating &&
            offer.state != CommerceStorage.JobState.Accepted
        ) revert InvalidOfferState(offerId, offer.state);

        offer.state = CommerceStorage.JobState.Cancelled;
        offer.updatedAt = block.timestamp;

        emit OfferCancelled(offerId);
    }

    // -----------------------------------------------------------------------
    // Escrow, delivery & settlement
    // -----------------------------------------------------------------------

    function fundJob(uint256 offerId) external {
        LibDiamond.enforceNotPaused();
        CommerceStorage.Offer storage offer = CommerceStorage.commerceStorage().offers[offerId];
        if (offer.createdAt == 0) revert OfferNotFound(offerId);
        if (msg.sender != offer.buyerAddress) revert NotBuyer(offerId, msg.sender);
        if (offer.state != CommerceStorage.JobState.Accepted) revert InvalidOfferState(offerId, offer.state);

        uint256 amount = offer.price;
        offer.state = CommerceStorage.JobState.Funded;
        offer.fundedAmount = amount;
        offer.updatedAt = block.timestamp;

        _casToken().safeTransferFrom(msg.sender, address(this), amount);

        emit JobFunded(offerId, amount);
    }

    function markDelivered(uint256 offerId) external {
        LibDiamond.enforceNotPaused();
        CommerceStorage.Offer storage offer = CommerceStorage.commerceStorage().offers[offerId];
        if (offer.createdAt == 0) revert OfferNotFound(offerId);
        if (msg.sender != offer.sellerAddress) revert NotSeller(offerId, msg.sender);
        if (offer.state != CommerceStorage.JobState.Funded) revert InvalidOfferState(offerId, offer.state);

        offer.state = CommerceStorage.JobState.Delivered;
        offer.deliveredAt = block.timestamp;
        offer.updatedAt = block.timestamp;

        emit JobDelivered(offerId, offer.deliveredAt);
    }

    function confirmDelivery(uint256 offerId) external {
        LibDiamond.enforceNotPaused();
        CommerceStorage.Offer storage offer = CommerceStorage.commerceStorage().offers[offerId];
        if (offer.createdAt == 0) revert OfferNotFound(offerId);
        if (msg.sender != offer.buyerAddress) revert NotBuyer(offerId, msg.sender);
        if (offer.state != CommerceStorage.JobState.Delivered) revert InvalidOfferState(offerId, offer.state);

        _settle(offerId, offer);
    }

    /**
     * @dev Anyone (typically a backend keeper) can finalize a delivered
     *      job once the dispute window has elapsed without objection.
     */
    function claimSettlement(uint256 offerId) external {
        LibDiamond.enforceNotPaused();
        CommerceStorage.CommerceStorageData storage s = CommerceStorage.commerceStorage();
        CommerceStorage.Offer storage offer = s.offers[offerId];
        if (offer.createdAt == 0) revert OfferNotFound(offerId);
        if (offer.state != CommerceStorage.JobState.Delivered) revert InvalidOfferState(offerId, offer.state);
        if (block.timestamp < offer.deliveredAt + s.disputeWindow) {
            revert DisputeWindowNotElapsed(offerId, offer.deliveredAt + s.disputeWindow);
        }

        _settle(offerId, offer);
    }

    function raiseDispute(uint256 offerId, bytes32 reasonHash) external {
        LibDiamond.enforceNotPaused();
        CommerceStorage.CommerceStorageData storage s = CommerceStorage.commerceStorage();
        CommerceStorage.Offer storage offer = s.offers[offerId];
        if (offer.createdAt == 0) revert OfferNotFound(offerId);
        if (msg.sender != offer.buyerAddress) revert NotBuyer(offerId, msg.sender);
        if (offer.state != CommerceStorage.JobState.Delivered) revert InvalidOfferState(offerId, offer.state);
        if (block.timestamp > offer.deliveredAt + s.disputeWindow) revert DisputeWindowElapsed(offerId);

        offer.state = CommerceStorage.JobState.Disputed;
        offer.disputeReasonHash = reasonHash;
        offer.updatedAt = block.timestamp;

        emit DisputeRaised(offerId, reasonHash);
    }

    /**
     * @dev Resolves a dispute by splitting the escrowed amount between
     *      buyer refund and seller payout. The protocol fee is only
     *      taken from the seller's share.
     * @param buyerRefundBps Share (basis points) of the escrow refunded
     *        to the buyer; the remainder (minus protocol fee) goes to
     *        the seller.
     */
    function resolveDispute(uint256 offerId, uint256 buyerRefundBps) external {
        DiamondAccessControl.enforceRoleOrOwner(DiamondAccessControl.COMMERCE_ARBITER_ROLE);
        if (buyerRefundBps > BPS_DENOMINATOR) revert InvalidBps(buyerRefundBps);

        CommerceStorage.CommerceStorageData storage s = CommerceStorage.commerceStorage();
        CommerceStorage.Offer storage offer = s.offers[offerId];
        if (offer.createdAt == 0) revert OfferNotFound(offerId);
        if (offer.state != CommerceStorage.JobState.Disputed) revert InvalidOfferState(offerId, offer.state);

        uint256 amount = offer.fundedAmount;
        uint256 buyerRefund = (amount * buyerRefundBps) / BPS_DENOMINATOR;
        uint256 sellerGross = amount - buyerRefund;
        uint256 fee = (sellerGross * s.protocolFeeBps) / BPS_DENOMINATOR;
        uint256 sellerNet = sellerGross - fee;

        offer.state = CommerceStorage.JobState.Resolved;
        offer.updatedAt = block.timestamp;

        IERC20 cas = _casToken();
        if (buyerRefund > 0) cas.safeTransfer(offer.buyerAddress, buyerRefund);
        if (sellerNet > 0) cas.safeTransfer(offer.sellerAddress, sellerNet);
        if (fee > 0) cas.safeTransfer(_infrastructureFund(), fee);

        emit DisputeResolved(offerId, buyerRefund, sellerNet, fee);
    }

    function _settle(uint256 offerId, CommerceStorage.Offer storage offer) private {
        CommerceStorage.CommerceStorageData storage s = CommerceStorage.commerceStorage();
        uint256 amount = offer.fundedAmount;
        uint256 fee = (amount * s.protocolFeeBps) / BPS_DENOMINATOR;
        uint256 sellerAmount = amount - fee;

        offer.state = CommerceStorage.JobState.Settled;
        offer.updatedAt = block.timestamp;

        IERC20 cas = _casToken();
        if (sellerAmount > 0) cas.safeTransfer(offer.sellerAddress, sellerAmount);
        if (fee > 0) cas.safeTransfer(_infrastructureFund(), fee);

        emit JobSettled(offerId, sellerAmount, fee);
    }

    // -----------------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------------

    function getOffer(uint256 offerId) external view returns (CommerceStorage.Offer memory) {
        CommerceStorage.Offer storage offer = CommerceStorage.commerceStorage().offers[offerId];
        if (offer.createdAt == 0) revert OfferNotFound(offerId);
        return offer;
    }

    function getOffersBySeller(bytes32 sellerAgentId) external view returns (uint256[] memory) {
        return CommerceStorage.commerceStorage().offersBySeller[sellerAgentId];
    }

    function getOfferCount() external view returns (uint256) {
        return CommerceStorage.commerceStorage().offerCount;
    }

    function getProtocolFeeBps() external view returns (uint256) {
        return CommerceStorage.commerceStorage().protocolFeeBps;
    }

    function getDisputeWindow() external view returns (uint256) {
        return CommerceStorage.commerceStorage().disputeWindow;
    }

    function getNegotiationBounds() external view returns (uint256 minBps, uint256 maxBps) {
        CommerceStorage.CommerceStorageData storage s = CommerceStorage.commerceStorage();
        return (s.minNegotiationBps, s.maxNegotiationBps);
    }

    /// @dev Used by ReputationRegistryFacet to verify feedback is backed
    ///      by a real settled job between the two agents.
    function isJobSettledBetween(uint256 offerId, bytes32 agentA, bytes32 agentB) external view returns (bool) {
        CommerceStorage.Offer storage offer = CommerceStorage.commerceStorage().offers[offerId];
        if (offer.state != CommerceStorage.JobState.Settled && offer.state != CommerceStorage.JobState.Resolved) {
            return false;
        }
        return (offer.sellerAgentId == agentA && offer.buyerAgentId == agentB) ||
            (offer.sellerAgentId == agentB && offer.buyerAgentId == agentA);
    }
}
