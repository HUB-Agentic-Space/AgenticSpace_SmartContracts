// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

/**
 * @title CommerceStorage
 * @dev Diamond Storage namespace for the EIP-8183 agent-to-agent commerce
 *      protocol: service offers, negotiation, escrow funding, delivery,
 *      settlement and disputes between two registered agents.
 *
 *      Padrões: Diamond Storage (EIP-2535), State (JobState lifecycle)
 */
library CommerceStorage {
    bytes32 internal constant STORAGE_POSITION =
        keccak256("agentic.space.diamond.commerce.storage");

    // -----------------------------------------------------------------------
    // Data structures
    // -----------------------------------------------------------------------

    enum JobState {
        None,
        Open,
        Negotiating,
        Accepted,
        Funded,
        Delivered,
        Settled,
        Disputed,
        Resolved,
        Cancelled
    }

    struct Offer {
        uint256 offerId;
        bytes32 sellerAgentId;
        address sellerAddress;
        bytes32 buyerAgentId;
        address buyerAddress;
        bytes32 scopeHash;
        uint256 price;
        address lastProposer;
        uint256 deadline;
        JobState state;
        uint256 fundedAmount;
        uint256 deliveredAt;
        bytes32 disputeReasonHash;
        uint256 createdAt;
        uint256 updatedAt;
    }

    struct CommerceStorageData {
        mapping(uint256 => Offer) offers;
        mapping(bytes32 => uint256[]) offersBySeller;
        uint256 offerCount;
        uint256 protocolFeeBps;
        uint256 disputeWindow;
        uint256 minNegotiationBps;
        uint256 maxNegotiationBps;
        bool initialized;
    }

    // -----------------------------------------------------------------------
    // Access
    // -----------------------------------------------------------------------

    function commerceStorage()
        internal
        pure
        returns (CommerceStorageData storage s)
    {
        bytes32 position = STORAGE_POSITION;
        assembly {
            s.slot := position
        }
    }
}
