// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { LibDiamond } from "../../diamond/libraries/LibDiamond.sol";
import { AgentStorage } from "../../diamond/storage/AgentStorage.sol";
import { Eip8004Storage } from "../../diamond/storage/Eip8004Storage.sol";

/**
 * @title IdentityRegistryFacet
 * @dev EIP-8004 (Trustless Agents) Identity Registry, built on top of the
 *      identity already established by AgentRegistryFacet/AgentStorage.
 *      Adds an off-chain agent card / manifest URI per agent and a single
 *      trust-layer resolution view used by counterpart agents before
 *      negotiating (EIP-8183) or paying (x402) another agent.
 *
 *      Only hashes and URIs are stored on-chain — never personal data or
 *      the agent card content itself.
 *
 *      Padrões: Diamond Storage (EIP-2535), Facade (resolveAgent), Registry (GoF)
 */
contract IdentityRegistryFacet {
    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    event AgentMetadataUpdated(bytes32 indexed agentId, string uri);

    // -----------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------

    error AgentNotFound(bytes32 agentId);
    error NotAgentOwner(bytes32 agentId, address caller);
    error EmptyMetadataURI();

    // -----------------------------------------------------------------------
    // Mutations
    // -----------------------------------------------------------------------

    /**
     * @dev Sets (or updates) the EIP-8004 agent card / manifest URI for an
     *      agent already registered in AgentRegistryFacet.
     * @param agentId ID of the agent (see AgentRegistryFacet.computeAgentId).
     * @param uri Off-chain URI of the agent card/manifest (e.g. https://.../agent-card.json).
     */
    function setAgentMetadataURI(bytes32 agentId, string calldata uri) external {
        LibDiamond.enforceNotPaused();
        if (bytes(uri).length == 0) revert EmptyMetadataURI();

        AgentStorage.AgentStorageData storage as_ = AgentStorage.agentStorage();
        AgentStorage.Agent storage agent = as_.agents[agentId];
        if (agent.registeredAt == 0) revert AgentNotFound(agentId);
        if (agent.ownerAddress != msg.sender) revert NotAgentOwner(agentId, msg.sender);

        Eip8004Storage.eip8004Storage().metadataURI[agentId] = uri;
        emit AgentMetadataUpdated(agentId, uri);
    }

    // -----------------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------------

    function getAgentMetadataURI(bytes32 agentId) external view returns (string memory) {
        return Eip8004Storage.eip8004Storage().metadataURI[agentId];
    }

    /**
     * @dev Trust-layer resolution: combines identity (AgentStorage) with
     *      the EIP-8004 metadata URI into a single read for counterparty
     *      agents evaluating whether to transact with `agentId`.
     */
    function resolveAgent(bytes32 agentId)
        external
        view
        returns (
            address ownerAddress,
            string memory publicId,
            bool active,
            string memory metadataURI
        )
    {
        AgentStorage.AgentStorageData storage as_ = AgentStorage.agentStorage();
        AgentStorage.Agent storage agent = as_.agents[agentId];
        if (agent.registeredAt == 0) revert AgentNotFound(agentId);

        return (
            agent.ownerAddress,
            agent.publicId,
            agent.isActive,
            Eip8004Storage.eip8004Storage().metadataURI[agentId]
        );
    }

    function isTrustedAgent(bytes32 agentId) external view returns (bool) {
        return AgentStorage.agentStorage().activeAgents[agentId];
    }
}
