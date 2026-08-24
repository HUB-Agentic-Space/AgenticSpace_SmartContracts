// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { LibDiamond } from "../diamond/libraries/LibDiamond.sol";
import { DiamondAccessControl } from "../diamond/access/DiamondAccessControl.sol";
import { DAOStorage } from "../diamond/storage/DAOStorage.sol";
import { VotingLib } from "../libs/VotingLib.sol";

/**
 * @title RoadMapDAOFacet
 * @dev Facet for RoadMap DAO governance using Diamond Storage.
 *      Team members create proposals (features, bugfixes, refactors) and vote.
 *      Approved proposals pass through timelock before execution.
 *
 *      Padrões: Diamond Storage (EIP-2535), Command (proposals)
 */
contract RoadMapDAOFacet {
    using VotingLib for DAOStorage.Proposal;

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    event ProposalCreated(
        uint256 indexed proposalId,
        address indexed proposer,
        uint8 proposalType,
        string title,
        uint256 votingDeadline
    );
    event VoteCast(uint256 indexed proposalId, address indexed voter, uint8 support, uint256 weight);
    event ProposalCanceled(uint256 indexed proposalId);
    event ProposalExecuted(uint256 indexed proposalId, bytes result);
    event ProposalQueued(uint256 indexed proposalId, uint256 eta);
    event QuorumUpdated(uint256 oldQuorum, uint256 newQuorum);
    event VotingDurationUpdated(uint256 oldDuration, uint256 newDuration);

    // -----------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------

    error ProposalNotFound(uint256 proposalId);
    error ProposalNotActive(uint256 proposalId);
    error VotingEnded(uint256 proposalId);
    error AlreadyVoted(uint256 proposalId, address voter);
    error QuorumNotReached(uint256 proposalId);
    error ProposalNotQueued(uint256 proposalId);
    error TimelockActive(uint256 proposalId, uint256 eta);
    error ExecutionWindowExpired(uint256 proposalId);
    error MaxActiveProposalsReached(uint256 max);
    error ProposalCooldownActive(address proposer, uint256 availableAt);
    error EmptyTitle();
    error EmptyDescription();

    uint256 internal constant MIN_VOTING_DURATION = 1 days;
    uint256 internal constant MAX_VOTING_DURATION = 14 days;
    uint256 internal constant MIN_TIMELOCK_DELAY = 1 days;
    uint256 internal constant MAX_TIMELOCK_DELAY = 30 days;
    uint256 internal constant EXECUTION_WINDOW = 7 days;

    // -----------------------------------------------------------------------
    // Init (called via diamondCut delegatecall)
    // -----------------------------------------------------------------------

    function initRoadMapDAO() external {
        LibDiamond.enforceIsContractOwner();
        DAOStorage.DAONamespace storage ns = DAOStorage.roadmapNamespace();
        ns.quorumBps = 400;
        ns.votingDuration = 3 days;
        ns.timelockDelay = 2 days;
        ns.maxActiveProposals = 20;
        ns.proposalCooldown = 1 days;
    }

    // -----------------------------------------------------------------------
    // Admin
    // -----------------------------------------------------------------------

    function addTeamMember(address member) external {
        DiamondAccessControl.enforceIsContractOwner();
        DiamondAccessControl.grantRole(DiamondAccessControl.DAO_PROPOSER_ROLE, member);
        DiamondAccessControl.grantRole(DiamondAccessControl.DAO_VOTER_ROLE, member);
    }

    function removeTeamMember(address member) external {
        DiamondAccessControl.enforceIsContractOwner();
        DiamondAccessControl.revokeRole(DiamondAccessControl.DAO_PROPOSER_ROLE, member);
        DiamondAccessControl.revokeRole(DiamondAccessControl.DAO_VOTER_ROLE, member);
    }

    function setRoadMapQuorum(uint256 newQuorum) external {
        DiamondAccessControl.enforceIsContractOwner();
        require(newQuorum > 0 && newQuorum <= 10000, "RoadMapDAO: invalid quorum");
        DAOStorage.DAONamespace storage ns = DAOStorage.roadmapNamespace();
        uint256 old = ns.quorumBps;
        ns.quorumBps = newQuorum;
        emit QuorumUpdated(old, newQuorum);
    }

    function setRoadMapVotingDuration(uint256 newDuration) external {
        DiamondAccessControl.enforceIsContractOwner();
        require(newDuration >= MIN_VOTING_DURATION, "DAO: voting duration too short");
        require(newDuration <= MAX_VOTING_DURATION, "DAO: voting duration too long");
        DAOStorage.DAONamespace storage ns = DAOStorage.roadmapNamespace();
        uint256 old = ns.votingDuration;
        ns.votingDuration = newDuration;
        emit VotingDurationUpdated(old, newDuration);
    }

    function setRoadMapTimelockDelay(uint256 newDelay) external {
        DiamondAccessControl.enforceIsContractOwner();
        require(newDelay >= MIN_TIMELOCK_DELAY, "DAO: timelock too short");
        require(newDelay <= MAX_TIMELOCK_DELAY, "DAO: timelock too long");
        DAOStorage.roadmapNamespace().timelockDelay = newDelay;
    }

    function setRoadMapMaxActiveProposals(uint256 max) external {
        DiamondAccessControl.enforceIsContractOwner();
        DAOStorage.roadmapNamespace().maxActiveProposals = max;
    }

    function setRoadMapProposalCooldown(uint256 cooldown) external {
        DiamondAccessControl.enforceIsContractOwner();
        DAOStorage.roadmapNamespace().proposalCooldown = cooldown;
    }

    // -----------------------------------------------------------------------
    // Proposal lifecycle
    // -----------------------------------------------------------------------

    function createRoadMapProposal(
        uint8 proposalType,
        string calldata title,
        string calldata description,
        bytes calldata data
    ) external returns (uint256) {
        LibDiamond.enforceNotPaused();
        DiamondAccessControl.enforceRoleOrOwner(DiamondAccessControl.DAO_PROPOSER_ROLE);

        if (bytes(title).length == 0) revert EmptyTitle();
        if (bytes(description).length == 0) revert EmptyDescription();

        DAOStorage.DAONamespace storage ns = DAOStorage.roadmapNamespace();
        if (ns.activeProposalCount >= ns.maxActiveProposals) {
            revert MaxActiveProposalsReached(ns.maxActiveProposals);
        }
        if (block.timestamp < ns.lastProposalAt[msg.sender] + ns.proposalCooldown) {
            revert ProposalCooldownActive(msg.sender, ns.lastProposalAt[msg.sender] + ns.proposalCooldown);
        }

        uint256 proposalId = ++ns.proposalCount;
        uint256 deadline = block.timestamp + ns.votingDuration;

        ns.proposals[proposalId] = DAOStorage.Proposal({
            proposalId: proposalId,
            proposer: msg.sender,
            proposalType: proposalType,
            title: title,
            description: description,
            data: data,
            createdAt: block.timestamp,
            votingDeadline: deadline,
            executedAt: 0,
            state: DAOStorage.ProposalState.Active,
            forVotes: 0,
            againstVotes: 0,
            abstainVotes: 0
        });

        ns.activeProposalCount++;
        ns.lastProposalAt[msg.sender] = block.timestamp;

        emit ProposalCreated(proposalId, msg.sender, proposalType, title, deadline);
        return proposalId;
    }

    function castRoadMapVote(uint256 proposalId, uint8 support) external {
        LibDiamond.enforceNotPaused();
        DiamondAccessControl.enforceRole(DiamondAccessControl.DAO_VOTER_ROLE);

        DAOStorage.DAONamespace storage ns = DAOStorage.roadmapNamespace();
        DAOStorage.Proposal storage proposal = ns.proposals[proposalId];
        if (proposal.proposer == address(0)) revert ProposalNotFound(proposalId);
        if (proposal.state != DAOStorage.ProposalState.Active) revert ProposalNotActive(proposalId);
        if (block.timestamp >= proposal.votingDeadline) revert VotingEnded(proposalId);
        if (ns.hasVoted[proposalId][msg.sender]) revert AlreadyVoted(proposalId, msg.sender);

        require(support <= 2, "RoadMapDAO: invalid support");

        if (support == 0) {
            proposal.againstVotes += 1;
        } else if (support == 1) {
            proposal.forVotes += 1;
        } else {
            proposal.abstainVotes += 1;
        }

        ns.hasVoted[proposalId][msg.sender] = true;
        emit VoteCast(proposalId, msg.sender, support, 1);
    }

    function cancelRoadMapProposal(uint256 proposalId) external {
        LibDiamond.enforceNotPaused();
        DiamondAccessControl.enforceRoleOrOwner(DiamondAccessControl.DAO_CANCELLER_ROLE);

        DAOStorage.DAONamespace storage ns = DAOStorage.roadmapNamespace();
        DAOStorage.Proposal storage proposal = ns.proposals[proposalId];
        if (proposal.proposer == address(0)) revert ProposalNotFound(proposalId);
        require(
            proposal.state == DAOStorage.ProposalState.Active ||
            proposal.state == DAOStorage.ProposalState.Pending,
            "RoadMapDAO: not cancelable"
        );

        proposal.state = DAOStorage.ProposalState.Canceled;
        ns.activeProposalCount--;
        emit ProposalCanceled(proposalId);
    }

    function queueRoadMapProposal(uint256 proposalId) external {
        LibDiamond.enforceNotPaused();
        DiamondAccessControl.enforceRoleOrOwner(DiamondAccessControl.DAO_EXECUTOR_ROLE);

        DAOStorage.DAONamespace storage ns = DAOStorage.roadmapNamespace();
        DAOStorage.Proposal storage proposal = ns.proposals[proposalId];
        if (proposal.proposer == address(0)) revert ProposalNotFound(proposalId);

        _updateProposalState(proposalId);

        if (proposal.state != DAOStorage.ProposalState.Succeeded) {
            revert QuorumNotReached(proposalId);
        }

        proposal.state = DAOStorage.ProposalState.Queued;
        proposal.executedAt = block.timestamp + ns.timelockDelay;
        emit ProposalQueued(proposalId, proposal.executedAt);
    }

    function executeRoadMapProposal(uint256 proposalId) external returns (bytes memory) {
        LibDiamond.enforceNotPaused();
        DiamondAccessControl.enforceRoleOrOwner(DiamondAccessControl.DAO_EXECUTOR_ROLE);

        DAOStorage.DAONamespace storage ns = DAOStorage.roadmapNamespace();
        DAOStorage.Proposal storage proposal = ns.proposals[proposalId];
        if (proposal.proposer == address(0)) revert ProposalNotFound(proposalId);
        if (proposal.state != DAOStorage.ProposalState.Queued) revert ProposalNotQueued(proposalId);
        if (block.timestamp < proposal.executedAt) revert TimelockActive(proposalId, proposal.executedAt);
        if (block.timestamp > proposal.executedAt + EXECUTION_WINDOW) revert ExecutionWindowExpired(proposalId);

        proposal.state = DAOStorage.ProposalState.Executed;
        ns.activeProposalCount--;

        bytes memory result = proposal.data;
        emit ProposalExecuted(proposalId, result);
        return result;
    }

    // -----------------------------------------------------------------------
    // View
    // -----------------------------------------------------------------------

    function getRoadMapProposal(uint256 proposalId) external view returns (DAOStorage.Proposal memory) {
        DAOStorage.DAONamespace storage ns = DAOStorage.roadmapNamespace();
        if (ns.proposals[proposalId].proposer == address(0)) revert ProposalNotFound(proposalId);
        return ns.proposals[proposalId];
    }

    function getRoadMapProposalState(uint256 proposalId) external view returns (DAOStorage.ProposalState) {
        DAOStorage.DAONamespace storage ns = DAOStorage.roadmapNamespace();
        DAOStorage.Proposal storage proposal = ns.proposals[proposalId];
        if (proposal.proposer == address(0)) revert ProposalNotFound(proposalId);

        if (proposal.state == DAOStorage.ProposalState.Active &&
            block.timestamp >= proposal.votingDeadline) {
            return _calculateOutcome(proposal) ? DAOStorage.ProposalState.Succeeded : DAOStorage.ProposalState.Defeated;
        }
        return proposal.state;
    }

    // -----------------------------------------------------------------------
    // Internal
    // -----------------------------------------------------------------------

    function _updateProposalState(uint256 proposalId) internal {
        DAOStorage.DAONamespace storage ns = DAOStorage.roadmapNamespace();
        DAOStorage.Proposal storage proposal = ns.proposals[proposalId];
        if (proposal.state == DAOStorage.ProposalState.Active &&
            block.timestamp >= proposal.votingDeadline) {
            ns.activeProposalCount--;
            if (_calculateOutcome(proposal)) {
                proposal.state = DAOStorage.ProposalState.Succeeded;
            } else {
                proposal.state = DAOStorage.ProposalState.Defeated;
            }
        }
    }

    function _calculateOutcome(DAOStorage.Proposal storage proposal) internal view returns (bool) {
        DAOStorage.DAONamespace storage ns = DAOStorage.roadmapNamespace();
        uint256 totalVotes = proposal.forVotes + proposal.againstVotes + proposal.abstainVotes;
        uint256 totalEligible = DiamondAccessControl.getRoleMemberCount(DiamondAccessControl.DAO_VOTER_ROLE);
        if (!VotingLib.isQuorumReached(totalVotes, ns.quorumBps, totalEligible)) {
            return false;
        }
        return VotingLib.isApproved(proposal.forVotes, proposal.againstVotes);
    }
}
