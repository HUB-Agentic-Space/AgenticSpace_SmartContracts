// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { LibDiamond } from "../../diamond/libraries/LibDiamond.sol";
import { DiamondAccessControl } from "../../diamond/access/DiamondAccessControl.sol";
import { AgentStorage } from "../../diamond/storage/AgentStorage.sol";
import { Eip8004Storage } from "../../diamond/storage/Eip8004Storage.sol";
import { AgentHashLib } from "../../libs/AgentHashLib.sol";

/**
 * @title ValidationRegistryFacet
 * @dev EIP-8004 (Trustless Agents) Validation Registry. An agent requests
 *      third-party validation of a piece of off-chain work (identified by
 *      `workHash`); an account holding `VALIDATOR_ROLE` later submits the
 *      approval/rejection plus a report hash. Only hashes are stored
 *      on-chain — the work itself and the validation report live off-chain.
 *
 *      Padrões: Diamond Storage (EIP-2535), Observer (Requested/Submitted events)
 */
contract ValidationRegistryFacet {
    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    event ValidationRequested(uint256 indexed validationId, bytes32 indexed agentId, bytes32 workHash, address requester);
    event ValidationSubmitted(uint256 indexed validationId, address indexed validator, bool approved, bytes32 reportHash);

    // -----------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------

    error AgentNotFound(bytes32 agentId);
    error NotAgentOwner(bytes32 agentId, address caller);
    error AgentNotActive(bytes32 agentId);
    error EmptyWorkHash();
    error ValidationNotFound(uint256 validationId);
    error ValidationAlreadyResolved(uint256 validationId);

    // -----------------------------------------------------------------------
    // Mutations
    // -----------------------------------------------------------------------

    function requestValidation(bytes32 agentId, bytes32 workHash) external returns (uint256 validationId) {
        LibDiamond.enforceNotPaused();
        if (workHash == bytes32(0)) revert EmptyWorkHash();

        AgentStorage.Agent storage agent = AgentStorage.agentStorage().agents[agentId];
        if (agent.registeredAt == 0) revert AgentNotFound(agentId);
        if (agent.ownerAddress != msg.sender) revert NotAgentOwner(agentId, msg.sender);
        if (!agent.isActive) revert AgentNotActive(agentId);

        Eip8004Storage.Eip8004StorageData storage s = Eip8004Storage.eip8004Storage();
        validationId = ++s.validationCount;

        s.validations[validationId] = Eip8004Storage.ValidationRequest({
            validationId: validationId,
            agentId: agentId,
            workHash: workHash,
            requester: msg.sender,
            validator: address(0),
            resolved: false,
            approved: false,
            reportHash: bytes32(0),
            requestedAt: block.timestamp,
            resolvedAt: 0
        });
        s.validationsByAgent[agentId].push(validationId);

        emit ValidationRequested(validationId, agentId, workHash, msg.sender);
    }

    function submitValidation(uint256 validationId, bool approved, bytes32 reportHash) external {
        LibDiamond.enforceNotPaused();
        DiamondAccessControl.enforceRoleOrOwner(DiamondAccessControl.VALIDATOR_ROLE);

        Eip8004Storage.Eip8004StorageData storage s = Eip8004Storage.eip8004Storage();
        Eip8004Storage.ValidationRequest storage req = s.validations[validationId];
        if (req.requestedAt == 0) revert ValidationNotFound(validationId);
        if (req.resolved) revert ValidationAlreadyResolved(validationId);

        req.resolved = true;
        req.approved = approved;
        req.reportHash = reportHash;
        req.validator = msg.sender;
        req.resolvedAt = block.timestamp;

        emit ValidationSubmitted(validationId, msg.sender, approved, reportHash);
    }

    // -----------------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------------

    function getValidation(uint256 validationId) external view returns (Eip8004Storage.ValidationRequest memory) {
        Eip8004Storage.ValidationRequest storage req = Eip8004Storage.eip8004Storage().validations[validationId];
        if (req.requestedAt == 0) revert ValidationNotFound(validationId);
        return req;
    }

    function getValidationIdsByAgent(bytes32 agentId) external view returns (uint256[] memory) {
        return Eip8004Storage.eip8004Storage().validationsByAgent[agentId];
    }

    function getValidationCount() external view returns (uint256) {
        return Eip8004Storage.eip8004Storage().validationCount;
    }

    function computeWorkHash(bytes memory content) external pure returns (bytes32) {
        return AgentHashLib.computePromptHashFromBytes(content);
    }
}
