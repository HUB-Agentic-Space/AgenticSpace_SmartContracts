// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { LibDiamond } from "../diamond/libraries/LibDiamond.sol";
import { DiamondAccessControl } from "../diamond/access/DiamondAccessControl.sol";
import { DAOStorage } from "../diamond/storage/DAOStorage.sol";
import { AgentStorage } from "../diamond/storage/AgentStorage.sol";
import { VotingLib } from "../libs/VotingLib.sol";
import { PaymentStorage } from "../diamond/storage/PaymentStorage.sol";
import { ICASToken } from "../interfaces/ICASToken.sol";

/**
 * @title AgentDAOFacet
 * @dev Facet for Agent DAO governance using Diamond Storage.
 *      Only agents registered in AgentRegistryFacet and validated in
 *      AgentValidatorFacet can vote. Supports delegation of votes.
 *
 *      Padrões: Diamond Storage (EIP-2535), Command (proposals), Observer (events)
 */
contract AgentDAOFacet {
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
    event VoteDelegated(address indexed delegator, address indexed delegatee);
    event VoteDelegationRevoked(address indexed delegator);

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
    error AgentNotRegistered(address agent);
    error CannotDelegateToSelf();
    error AlreadyDelegated(address delegator);
    error NotDelegated(address delegator);
    error EmptyTitle();
    error EmptyDescription();
    error AccountFrozen(address account);

    uint256 internal constant MIN_VOTING_DURATION = 1 days;
    uint256 internal constant MAX_VOTING_DURATION = 14 days;
    uint256 internal constant MIN_TIMELOCK_DELAY = 1 days;
    uint256 internal constant MAX_TIMELOCK_DELAY = 30 days;
    uint256 internal constant EXECUTION_WINDOW = 7 days;

    // -----------------------------------------------------------------------
    // Init (called via diamondCut delegatecall)
    // -----------------------------------------------------------------------

    function initAgentDAO() external {
        LibDiamond.enforceIsContractOwner();
        DAOStorage.DAONamespace storage ns = DAOStorage.agentNamespace();
        ns.quorumBps = 500;
        ns.votingDuration = 5 days;
        ns.timelockDelay = 3 days;
        ns.maxActiveProposals = 50;
        ns.proposalCooldown = 2 days;
    }

    // -----------------------------------------------------------------------
    // Admin
    // -----------------------------------------------------------------------

    function setAgentQuorum(uint256 newQuorum) external {
        DiamondAccessControl.enforceIsContractOwner();
        require(newQuorum > 0 && newQuorum <= 10000, "AgentDAO: invalid quorum");
        DAOStorage.DAONamespace storage ns = DAOStorage.agentNamespace();
        uint256 old = ns.quorumBps;
        ns.quorumBps = newQuorum;
        emit QuorumUpdated(old, newQuorum);
    }

    function setAgentVotingDuration(uint256 newDuration) external {
        DiamondAccessControl.enforceIsContractOwner();
        require(newDuration >= MIN_VOTING_DURATION, "DAO: voting duration too short");
        require(newDuration <= MAX_VOTING_DURATION, "DAO: voting duration too long");
        DAOStorage.DAONamespace storage ns = DAOStorage.agentNamespace();
        uint256 old = ns.votingDuration;
        ns.votingDuration = newDuration;
        emit VotingDurationUpdated(old, newDuration);
    }

    function setAgentTimelockDelay(uint256 newDelay) external {
        DiamondAccessControl.enforceIsContractOwner();
        require(newDelay >= MIN_TIMELOCK_DELAY, "DAO: timelock too short");
        require(newDelay <= MAX_TIMELOCK_DELAY, "DAO: timelock too long");
        DAOStorage.agentNamespace().timelockDelay = newDelay;
    }

    function setAgentMaxActiveProposals(uint256 max) external {
        DiamondAccessControl.enforceIsContractOwner();
        DAOStorage.agentNamespace().maxActiveProposals = max;
    }

    function setAgentProposalCooldown(uint256 cooldown) external {
        DiamondAccessControl.enforceIsContractOwner();
        DAOStorage.agentNamespace().proposalCooldown = cooldown;
    }

    // -----------------------------------------------------------------------
    // Delegation
    // -----------------------------------------------------------------------

    function delegateVote(address delegatee) external {
        LibDiamond.enforceNotPaused();
        if (delegatee == msg.sender) revert CannotDelegateToSelf();

        DAOStorage.DAONamespace storage ns = DAOStorage.agentNamespace();
        if (ns.hasDelegated[msg.sender]) revert AlreadyDelegated(msg.sender);

        _verifyAgentEligibility(delegatee);

        ns.voteDelegation[msg.sender] = delegatee;
        ns.hasDelegated[msg.sender] = true;

        emit VoteDelegated(msg.sender, delegatee);
    }

    function revokeDelegation() external {
        LibDiamond.enforceNotPaused();
        DAOStorage.DAONamespace storage ns = DAOStorage.agentNamespace();
        if (!ns.hasDelegated[msg.sender]) revert NotDelegated(msg.sender);

        delete ns.voteDelegation[msg.sender];
        ns.hasDelegated[msg.sender] = false;

        emit VoteDelegationRevoked(msg.sender);
    }

    // -----------------------------------------------------------------------
    // Proposal lifecycle
    // -----------------------------------------------------------------------

    function createAgentProposal(
        uint8 proposalType,
        string calldata title,
        string calldata description,
        bytes calldata data
    ) external returns (uint256) {
        LibDiamond.enforceNotPaused();
        DiamondAccessControl.enforceRoleOrOwner(DiamondAccessControl.DAO_PROPOSER_ROLE);

        if (bytes(title).length == 0) revert EmptyTitle();
        if (bytes(description).length == 0) revert EmptyDescription();

        DAOStorage.DAONamespace storage ns = DAOStorage.agentNamespace();
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

    function castAgentVote(uint256 proposalId, uint8 support) external {
        LibDiamond.enforceNotPaused();

        _enforceNotFrozen(msg.sender);

        DAOStorage.DAONamespace storage ns = DAOStorage.agentNamespace();
        DAOStorage.Proposal storage proposal = ns.proposals[proposalId];
        if (proposal.proposer == address(0)) revert ProposalNotFound(proposalId);
        if (proposal.state != DAOStorage.ProposalState.Active) revert ProposalNotActive(proposalId);
        if (block.timestamp >= proposal.votingDeadline) revert VotingEnded(proposalId);
        if (ns.hasVoted[proposalId][msg.sender]) revert AlreadyVoted(proposalId, msg.sender);

        require(support <= 2, "AgentDAO: invalid support");

        address voter = msg.sender;
        if (ns.hasDelegated[voter]) {
            voter = ns.voteDelegation[voter];
            if (ns.hasVoted[proposalId][voter]) revert AlreadyVoted(proposalId, voter);
        }

        _verifyAgentEligibility(voter);

        if (support == 0) {
            proposal.againstVotes += 1;
        } else if (support == 1) {
            proposal.forVotes += 1;
        } else {
            proposal.abstainVotes += 1;
        }

        ns.hasVoted[proposalId][voter] = true;
        ns.hasVoted[proposalId][msg.sender] = true;

        emit VoteCast(proposalId, voter, support, 1);
    }

    function cancelAgentProposal(uint256 proposalId) external {
        LibDiamond.enforceNotPaused();
        DiamondAccessControl.enforceRoleOrOwner(DiamondAccessControl.DAO_CANCELLER_ROLE);

        DAOStorage.DAONamespace storage ns = DAOStorage.agentNamespace();
        DAOStorage.Proposal storage proposal = ns.proposals[proposalId];
        if (proposal.proposer == address(0)) revert ProposalNotFound(proposalId);
        require(
            proposal.state == DAOStorage.ProposalState.Active ||
            proposal.state == DAOStorage.ProposalState.Pending,
            "AgentDAO: not cancelable"
        );

        proposal.state = DAOStorage.ProposalState.Canceled;
        ns.activeProposalCount--;
        emit ProposalCanceled(proposalId);
    }

    function queueAgentProposal(uint256 proposalId) external {
        LibDiamond.enforceNotPaused();
        DiamondAccessControl.enforceRoleOrOwner(DiamondAccessControl.DAO_EXECUTOR_ROLE);

        DAOStorage.DAONamespace storage ns = DAOStorage.agentNamespace();
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

    function executeAgentProposal(uint256 proposalId) external returns (bytes memory) {
        LibDiamond.enforceNotPaused();
        DiamondAccessControl.enforceRoleOrOwner(DiamondAccessControl.DAO_EXECUTOR_ROLE);

        DAOStorage.DAONamespace storage ns = DAOStorage.agentNamespace();
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

    function getAgentProposal(uint256 proposalId) external view returns (DAOStorage.Proposal memory) {
        DAOStorage.DAONamespace storage ns = DAOStorage.agentNamespace();
        if (ns.proposals[proposalId].proposer == address(0)) revert ProposalNotFound(proposalId);
        return ns.proposals[proposalId];
    }

    function getAgentProposalState(uint256 proposalId) external view returns (DAOStorage.ProposalState) {
        DAOStorage.DAONamespace storage ns = DAOStorage.agentNamespace();
        DAOStorage.Proposal storage proposal = ns.proposals[proposalId];
        if (proposal.proposer == address(0)) revert ProposalNotFound(proposalId);

        if (proposal.state == DAOStorage.ProposalState.Active &&
            block.timestamp >= proposal.votingDeadline) {
            return _calculateOutcome(proposal) ? DAOStorage.ProposalState.Succeeded : DAOStorage.ProposalState.Defeated;
        }
        return proposal.state;
    }

    function getDelegation(address delegator) external view returns (address) {
        return DAOStorage.agentNamespace().voteDelegation[delegator];
    }

    function hasDelegated(address delegator) external view returns (bool) {
        return DAOStorage.agentNamespace().hasDelegated[delegator];
    }

    // -----------------------------------------------------------------------
    // Internal
    // -----------------------------------------------------------------------

    function _verifyAgentEligibility(address voter) internal view {
        require(
            DiamondAccessControl.hasRole(DiamondAccessControl.AGENT_ROLE, voter),
            "AgentDAO: not agent role"
        );
    }

    function _updateProposalState(uint256 proposalId) internal {
        DAOStorage.DAONamespace storage ns = DAOStorage.agentNamespace();
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
        DAOStorage.DAONamespace storage ns = DAOStorage.agentNamespace();
        uint256 totalVotes = proposal.forVotes + proposal.againstVotes + proposal.abstainVotes;
        uint256 totalEligible = DiamondAccessControl.getRoleMemberCount(DiamondAccessControl.AGENT_ROLE);
        if (!VotingLib.isQuorumReached(totalVotes, ns.quorumBps, totalEligible)) {
            return false;
        }
        return VotingLib.isApproved(proposal.forVotes, proposal.againstVotes);
    }

    function _enforceNotFrozen(address account) internal view {
        address casTokenAddr = address(PaymentStorage.paymentStorage().casToken);
        if (casTokenAddr != address(0)) {
            if (ICASToken(casTokenAddr).isFrozen(account)) revert AccountFrozen(account);
        }
    }
}
