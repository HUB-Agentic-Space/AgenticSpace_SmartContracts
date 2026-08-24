// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

/**
 * @title Eip8004Storage
 * @dev Diamond Storage namespace for the EIP-8004 (Trustless Agents) Trust
 *      Layer: agent metadata (Identity), feedback aggregation (Reputation)
 *      and third-party validation requests (Validation).
 *
 *      Identity itself (agentId, owner, publicId, active flag) already lives
 *      in AgentStorage — this namespace only adds the EIP-8004-specific
 *      extensions on top of the existing AgentRegistryFacet identity.
 *
 *      Padrões: Diamond Storage (EIP-2535), Memento (state persistence)
 */
library Eip8004Storage {
    bytes32 internal constant STORAGE_POSITION =
        keccak256("agentic.space.diamond.eip8004.storage");

    // -----------------------------------------------------------------------
    // Data structures
    // -----------------------------------------------------------------------

    struct ValidationRequest {
        uint256 validationId;
        bytes32 agentId;
        bytes32 workHash;
        address requester;
        address validator;
        bool resolved;
        bool approved;
        bytes32 reportHash;
        uint256 requestedAt;
        uint256 resolvedAt;
    }

    struct Eip8004StorageData {
        // Identity — off-chain agent card / manifest URI per agentId.
        mapping(bytes32 => string) metadataURI;
        // Reputation — aggregated feedback per agentId (the one being rated).
        mapping(bytes32 => uint256) feedbackCount;
        mapping(bytes32 => uint256) feedbackScoreSum;
        // jobId => rater agentId => feedback already given (one per job/direction).
        mapping(bytes32 => mapping(bytes32 => bool)) feedbackGiven;
        // Validation — third-party attestation requests.
        mapping(uint256 => ValidationRequest) validations;
        mapping(bytes32 => uint256[]) validationsByAgent;
        uint256 validationCount;
    }

    // -----------------------------------------------------------------------
    // Access
    // -----------------------------------------------------------------------

    function eip8004Storage()
        internal
        pure
        returns (Eip8004StorageData storage s)
    {
        bytes32 position = STORAGE_POSITION;
        assembly {
            s.slot := position
        }
    }
}
