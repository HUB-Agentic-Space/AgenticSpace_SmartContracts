// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

/**
 * @title AgentStorage
 * @dev Diamond Storage namespace for agent persistence.
 *      Stores DID, AUID, ownerAddress, publicId, name, parentPublicId
 *      and a Merkle root of all prompt hashes for each agent.
 *
 *      The Merkle root aggregates hashes of all prompts (AGENTS.md,
 *      IDENTITY.md, SOUL.md and secondary prompts). Individual prompt
 *      hashes live in the backend; only the root is persisted on-chain.
 *      Each prompt hash includes identification metadata but never
 *      API keys.
 *
 *      Padrões: Diamond Storage (EIP-2535), Memento (state persistence)
 */
library AgentStorage {
    bytes32 internal constant STORAGE_POSITION =
        keccak256("agentic.space.diamond.agent.storage");

    // -----------------------------------------------------------------------
    // Data structures
    // -----------------------------------------------------------------------

    struct Agent {
        bytes32 agentId;
        bytes32 didHash;
        bytes32 ownerUserId;
        address ownerAddress;
        string publicId;
        string auid;
        string name;
        string description;
        string parentPublicId;
        bytes32 merkleRoot;
        uint256 promptCount;
        bool isActive;
        uint256 registeredAt;
    }

    struct AgentStorageData {
        mapping(bytes32 => Agent) agents;
        mapping(address => bytes32[]) agentsByOwner;
        mapping(string => bytes32) agentByPublicId;
        mapping(bytes32 => bool) activeAgents;
        mapping(bytes32 => bytes32[]) merkleRootHistory;
        uint256 agentCount;
        uint256 activeAgentCount;
    }

    // -----------------------------------------------------------------------
    // Access
    // -----------------------------------------------------------------------

    function agentStorage()
        internal
        pure
        returns (AgentStorageData storage s)
    {
        bytes32 position = STORAGE_POSITION;
        assembly {
            s.slot := position
        }
    }
}
