// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { LibDiamond } from "../../diamond/libraries/LibDiamond.sol";
import { AgentStorage } from "../../diamond/storage/AgentStorage.sol";
import { Eip8004Storage } from "../../diamond/storage/Eip8004Storage.sol";

interface IAgentCommerceView {
    function isJobSettledBetween(uint256 offerId, bytes32 agentA, bytes32 agentB) external view returns (bool);
}

/**
 * @title ReputationRegistryFacet
 * @dev EIP-8004 (Trustless Agents) Reputation Registry. Feedback about an
 *      agent can only be submitted by the counterparty of a job that was
 *      actually settled through AgentCommerceFacet (EIP-8183) — this
 *      prevents Sybil / fake-review spam, since reputation is always
 *      backed by a verifiable on-chain transaction between the two
 *      agents involved.
 *
 *      Cross-facet reads go through `address(this)` (the Diamond),
 *      never a direct Solidity import of another facet's bytecode.
 *
 *      Padrões: Diamond Storage (EIP-2535), Observer (FeedbackSubmitted event)
 */
contract ReputationRegistryFacet {
    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    event FeedbackSubmitted(
        bytes32 indexed fromAgentId,
        bytes32 indexed toAgentId,
        uint256 indexed jobId,
        uint8 score,
        bytes32 commentHash
    );

    // -----------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------

    error AgentNotFound(bytes32 agentId);
    error NotAgentOwner(bytes32 agentId, address caller);
    error AgentNotActive(bytes32 agentId);
    error SameAgent();
    error InvalidScore(uint8 score);
    error JobNotSettled(uint256 jobId);
    error FeedbackAlreadyGiven(uint256 jobId, bytes32 fromAgentId);

    uint8 private constant MAX_SCORE = 100;

    // -----------------------------------------------------------------------
    // Mutations
    // -----------------------------------------------------------------------

    /**
     * @dev Submits feedback about `toAgentId` on behalf of `fromAgentId`,
     *      referencing the AgentCommerceFacet job (`jobId`) that must have
     *      settled between exactly these two agents.
     * @param fromAgentId Agent giving the feedback (caller must own it).
     * @param toAgentId Agent being rated.
     * @param jobId AgentCommerceFacet offerId used as the settled job reference.
     * @param score Rating from 0 to 100.
     * @param commentHash Hash of an off-chain comment (never stored in full on-chain).
     */
    function submitFeedback(
        bytes32 fromAgentId,
        bytes32 toAgentId,
        uint256 jobId,
        uint8 score,
        bytes32 commentHash
    ) external {
        LibDiamond.enforceNotPaused();
        if (fromAgentId == toAgentId) revert SameAgent();
        if (score > MAX_SCORE) revert InvalidScore(score);

        AgentStorage.AgentStorageData storage as_ = AgentStorage.agentStorage();

        AgentStorage.Agent storage rater = as_.agents[fromAgentId];
        if (rater.registeredAt == 0) revert AgentNotFound(fromAgentId);
        if (rater.ownerAddress != msg.sender) revert NotAgentOwner(fromAgentId, msg.sender);
        if (!rater.isActive) revert AgentNotActive(fromAgentId);

        AgentStorage.Agent storage rated = as_.agents[toAgentId];
        if (rated.registeredAt == 0) revert AgentNotFound(toAgentId);
        if (!rated.isActive) revert AgentNotActive(toAgentId);

        if (!IAgentCommerceView(address(this)).isJobSettledBetween(jobId, fromAgentId, toAgentId)) {
            revert JobNotSettled(jobId);
        }

        Eip8004Storage.Eip8004StorageData storage s = Eip8004Storage.eip8004Storage();
        if (s.feedbackGiven[bytes32(jobId)][fromAgentId]) revert FeedbackAlreadyGiven(jobId, fromAgentId);
        s.feedbackGiven[bytes32(jobId)][fromAgentId] = true;

        s.feedbackCount[toAgentId] += 1;
        s.feedbackScoreSum[toAgentId] += score;

        emit FeedbackSubmitted(fromAgentId, toAgentId, jobId, score, commentHash);
    }

    // -----------------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------------

    function getFeedbackCount(bytes32 agentId) external view returns (uint256) {
        return Eip8004Storage.eip8004Storage().feedbackCount[agentId];
    }

    function getFeedbackScoreSum(bytes32 agentId) external view returns (uint256) {
        return Eip8004Storage.eip8004Storage().feedbackScoreSum[agentId];
    }

    /// @return average Average score (0-100), or 0 if the agent has no feedback yet.
    function getAverageScore(bytes32 agentId) external view returns (uint256 average) {
        Eip8004Storage.Eip8004StorageData storage s = Eip8004Storage.eip8004Storage();
        uint256 count = s.feedbackCount[agentId];
        if (count == 0) return 0;
        return s.feedbackScoreSum[agentId] / count;
    }

    function hasFeedbackGiven(uint256 jobId, bytes32 fromAgentId) external view returns (bool) {
        return Eip8004Storage.eip8004Storage().feedbackGiven[bytes32(jobId)][fromAgentId];
    }
}
