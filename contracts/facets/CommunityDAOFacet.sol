// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { LibDiamond } from "../diamond/libraries/LibDiamond.sol";
import { DiamondAccessControl } from "../diamond/access/DiamondAccessControl.sol";
import { DAOStorage } from "../diamond/storage/DAOStorage.sol";
import { VotingLib } from "../libs/VotingLib.sol";
import { PaymentLib } from "../libs/PaymentLib.sol";
import { MerkleTreeLib } from "../libs/MerkleTreeLib.sol";
import { PaymentStorage } from "../diamond/storage/PaymentStorage.sol";
import { ICASToken } from "../interfaces/ICASToken.sol";

/**
 * @title CommunityDAOFacet
 * @dev Facet for community DAO governance using Diamond Storage.
 *      Members (humans with USER_ROLE or agents with AGENT_ROLE) propose pautas.
 *      Admins (DAO_PROPOSER_ROLE) approve/reject pautas and create votações.
 *      Votações store a Merkle root on-chain for integrity of off-chain text.
 *      Fees: pauta submission (1/10 agent registration), voting (1/2 agent registration).
 *      All fees are transferred to the InfrastructureFund.
 *
 *      Padrões: Diamond Storage (EIP-2535), Command (proposals), Observer (events),
 *               Factory (fee integration via PaymentLib)
 */
contract CommunityDAOFacet {
    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    event PautaItemProposed(uint256 indexed itemId, address indexed proposer, bytes32 contentHash);
    event PautaItemApproved(uint256 indexed itemId, address indexed admin);
    event PautaItemRejected(uint256 indexed itemId, address indexed admin, string reason);
    event VotacaoCreated(
        uint256 indexed votacaoId,
        bytes32 merkleRoot,
        uint256 votingDeadline,
        uint256 timelockEnd
    );
    event PautaItemAddedToVotacao(uint256 indexed votacaoId, uint256 indexed itemId);
    event CommunityVoteCast(uint256 indexed votacaoId, address indexed voter, uint8 support);
    event VotacaoCanceled(uint256 indexed votacaoId);
    event VotacaoQueued(uint256 indexed votacaoId, uint256 eta);
    event VotacaoExecuted(uint256 indexed votacaoId);
    event QuorumUpdated(uint256 oldQuorum, uint256 newQuorum);
    event VotingDurationUpdated(uint256 oldDuration, uint256 newDuration);
    event FeePaid(address indexed payer, uint256 feeType, uint256 amount);

    // -----------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------

    error PautaItemNotFound(uint256 itemId);
    error PautaItemNotPending(uint256 itemId);
    error PautaItemAlreadyApproved(uint256 itemId);
    error PautaItemAlreadyRejected(uint256 itemId);
    error VotacaoNotFound(uint256 votacaoId);
    error VotacaoNotActive(uint256 votacaoId);
    error VotingEnded(uint256 votacaoId);
    error AlreadyVoted(uint256 votacaoId, address voter);
    error QuorumNotReached(uint256 votacaoId);
    error VotacaoNotQueued(uint256 votacaoId);
    error TimelockActive(uint256 votacaoId, uint256 eta);
    error ExecutionWindowExpired(uint256 votacaoId);
    error NotAuthorized(address caller);
    error EmptyContentHash();
    error InvalidVoteChoice();
    error MerkleRootNotSet();
    error PautaItemNotApproved(uint256 itemId);
    error PautaItemAlreadyInVotacao(uint256 itemId);
    error AccountFrozen(address account);

    // -----------------------------------------------------------------------
    // Constants
    // -----------------------------------------------------------------------

    uint256 internal constant MIN_VOTING_DURATION = 1 days;
    uint256 internal constant MAX_VOTING_DURATION = 14 days;
    uint256 internal constant MIN_TIMELOCK_DELAY = 1 days;
    uint256 internal constant MAX_TIMELOCK_DELAY = 30 days;
    uint256 internal constant EXECUTION_WINDOW = 7 days;

    // -----------------------------------------------------------------------
    // Pauta item state
    // -----------------------------------------------------------------------

    enum PautaItemState { Pending, Approved, Rejected, InVotacao }

    struct PautaItem {
        uint256 itemId;
        address proposer;
        bytes32 contentHash;
        uint256 createdAt;
        PautaItemState state;
        uint256 votacaoId;
    }

    struct Votacao {
        uint256 votacaoId;
        bytes32 merkleRoot;
        address creator;
        uint256 createdAt;
        uint256 votingDeadline;
        uint256 executedAt;
        DAOStorage.ProposalState state;
        uint256 forVotes;
        uint256 againstVotes;
        uint256 abstainVotes;
        uint256[] itemIds;
    }

    // -----------------------------------------------------------------------
    // Storage (Diamond Storage extension via COMMUNITY_DAO namespace)
    // -----------------------------------------------------------------------

    bytes32 internal constant COMMUNITY_STORAGE_POSITION =
        keccak256("agentic.space.diamond.community.dao.storage");

    struct CommunityStorage {
        mapping(uint256 => PautaItem) pautaItems;
        mapping(uint256 => Votacao) votacoes;
        mapping(uint256 => mapping(address => bool)) hasVoted;
        mapping(uint256 => mapping(uint256 => bool)) itemInVotacao;
        uint256 pautaItemCount;
        uint256 votacaoCount;
        uint256 quorumBps;
        uint256 votingDuration;
        uint256 timelockDelay;
    }

    function communityStorage() internal pure returns (CommunityStorage storage s) {
        bytes32 position = COMMUNITY_STORAGE_POSITION;
        assembly {
            s.slot := position
        }
    }

    // -----------------------------------------------------------------------
    // Init (called via diamondCut delegatecall)
    // -----------------------------------------------------------------------

    function initCommunityDAO() external {
        LibDiamond.enforceIsContractOwner();
        CommunityStorage storage cs = communityStorage();
        cs.quorumBps = 500; // 5%
        cs.votingDuration = 5 days;
        cs.timelockDelay = 3 days;
    }

    // -----------------------------------------------------------------------
    // Admin functions
    // -----------------------------------------------------------------------

    function setCommunityQuorum(uint256 newQuorum) external {
        DiamondAccessControl.enforceIsContractOwner();
        require(newQuorum > 0 && newQuorum <= 10000, "CommunityDAO: invalid quorum");
        CommunityStorage storage cs = communityStorage();
        uint256 old = cs.quorumBps;
        cs.quorumBps = newQuorum;
        emit QuorumUpdated(old, newQuorum);
    }

    function setCommunityVotingDuration(uint256 newDuration) external {
        DiamondAccessControl.enforceIsContractOwner();
        require(newDuration >= MIN_VOTING_DURATION, "CommunityDAO: voting duration too short");
        require(newDuration <= MAX_VOTING_DURATION, "CommunityDAO: voting duration too long");
        CommunityStorage storage cs = communityStorage();
        uint256 old = cs.votingDuration;
        cs.votingDuration = newDuration;
        emit VotingDurationUpdated(old, newDuration);
    }

    function setCommunityTimelockDelay(uint256 newDelay) external {
        DiamondAccessControl.enforceIsContractOwner();
        require(newDelay >= MIN_TIMELOCK_DELAY, "CommunityDAO: timelock too short");
        require(newDelay <= MAX_TIMELOCK_DELAY, "CommunityDAO: timelock too long");
        communityStorage().timelockDelay = newDelay;
    }

    // -----------------------------------------------------------------------
    // Pauta lifecycle
    // -----------------------------------------------------------------------

    /**
     * @notice Propose a new pauta item. Requires CAS fee (1/10 agent registration).
     * @dev Caller must have USER_ROLE or AGENT_ROLE. Fee transferred to InfrastructureFund.
     * @param contentHash Hash of the off-chain text content for the pauta item.
     * @return itemId The new pauta item ID.
     */
    function proposePautaItem(bytes32 contentHash) external returns (uint256) {
        LibDiamond.enforceNotPaused();

        if (contentHash == bytes32(0)) revert EmptyContentHash();

        bool isUser = DiamondAccessControl.hasRole(DiamondAccessControl.USER_ROLE, msg.sender);
        bool isAgent = DiamondAccessControl.hasRole(DiamondAccessControl.AGENT_ROLE, msg.sender);
        if (!isUser && !isAgent) revert NotAuthorized(msg.sender);

        uint256 feeAmount = PaymentLib.processCustomFeePayment(msg.sender, PaymentLib.FEE_TYPE_PAUTA_SUBMISSION);
        emit FeePaid(msg.sender, PaymentLib.FEE_TYPE_PAUTA_SUBMISSION, feeAmount);

        CommunityStorage storage cs = communityStorage();
        uint256 itemId = ++cs.pautaItemCount;

        cs.pautaItems[itemId] = PautaItem({
            itemId: itemId,
            proposer: msg.sender,
            contentHash: contentHash,
            createdAt: block.timestamp,
            state: PautaItemState.Pending,
            votacaoId: 0
        });

        emit PautaItemProposed(itemId, msg.sender, contentHash);
        return itemId;
    }

    /**
     * @notice Approve a pending pauta item. Only DAO_PROPOSER_ROLE (admin).
     * @param itemId The pauta item ID to approve.
     */
    function approvePautaItem(uint256 itemId) external {
        LibDiamond.enforceNotPaused();
        DiamondAccessControl.enforceRole(DiamondAccessControl.DAO_PROPOSER_ROLE);

        CommunityStorage storage cs = communityStorage();
        PautaItem storage item = cs.pautaItems[itemId];
        if (item.proposer == address(0)) revert PautaItemNotFound(itemId);
        if (item.state != PautaItemState.Pending) revert PautaItemNotPending(itemId);

        item.state = PautaItemState.Approved;
        emit PautaItemApproved(itemId, msg.sender);
    }

    /**
     * @notice Reject a pending pauta item. Only DAO_PROPOSER_ROLE (admin).
     * @param itemId The pauta item ID to reject.
     * @param reason Human-readable reason for rejection.
     */
    function rejectPautaItem(uint256 itemId, string calldata reason) external {
        LibDiamond.enforceNotPaused();
        DiamondAccessControl.enforceRole(DiamondAccessControl.DAO_PROPOSER_ROLE);

        CommunityStorage storage cs = communityStorage();
        PautaItem storage item = cs.pautaItems[itemId];
        if (item.proposer == address(0)) revert PautaItemNotFound(itemId);
        if (item.state != PautaItemState.Pending) revert PautaItemNotPending(itemId);

        item.state = PautaItemState.Rejected;
        emit PautaItemRejected(itemId, msg.sender, reason);
    }

    // -----------------------------------------------------------------------
    // Votação lifecycle
    // -----------------------------------------------------------------------

    /**
     * @notice Create a votação from approved pauta items. Only DAO_PROPOSER_ROLE.
     * @param merkleRoot Merkle root of all pauta item hashes in this votação.
     * @param itemIds Array of approved pauta item IDs to include.
     * @return votacaoId The new votação ID.
     */
    function createVotacao(
        bytes32 merkleRoot,
        uint256[] calldata itemIds
    ) external returns (uint256) {
        LibDiamond.enforceNotPaused();
        DiamondAccessControl.enforceRole(DiamondAccessControl.DAO_PROPOSER_ROLE);

        if (merkleRoot == bytes32(0)) revert MerkleRootNotSet();
        if (itemIds.length == 0) revert EmptyContentHash();

        CommunityStorage storage cs = communityStorage();

        for (uint256 i = 0; i < itemIds.length; i++) {
            PautaItem storage item = cs.pautaItems[itemIds[i]];
            if (item.proposer == address(0)) revert PautaItemNotFound(itemIds[i]);
            if (item.state != PautaItemState.Approved) revert PautaItemNotApproved(itemIds[i]);
            if (item.votacaoId != 0) revert PautaItemAlreadyInVotacao(itemIds[i]);
        }

        uint256 votacaoId = ++cs.votacaoCount;
        uint256 deadline = block.timestamp + cs.votingDuration;

        Votacao storage v = cs.votacoes[votacaoId];
        v.votacaoId = votacaoId;
        v.merkleRoot = merkleRoot;
        v.creator = msg.sender;
        v.createdAt = block.timestamp;
        v.votingDeadline = deadline;
        v.executedAt = 0;
        v.state = DAOStorage.ProposalState.Active;
        v.forVotes = 0;
        v.againstVotes = 0;
        v.abstainVotes = 0;

        for (uint256 i = 0; i < itemIds.length; i++) {
            v.itemIds.push(itemIds[i]);
            cs.pautaItems[itemIds[i]].state = PautaItemState.InVotacao;
            cs.pautaItems[itemIds[i]].votacaoId = votacaoId;
            cs.itemInVotacao[votacaoId][itemIds[i]] = true;
            emit PautaItemAddedToVotacao(votacaoId, itemIds[i]);
        }

        emit VotacaoCreated(votacaoId, merkleRoot, deadline, 0);
        return votacaoId;
    }

    /**
     * @notice Cast a vote on a votação. Requires CAS fee (1/2 agent registration).
     * @dev Caller must have USER_ROLE or AGENT_ROLE. Fee transferred to InfrastructureFund.
     * @param votacaoId The votação ID.
     * @param support   Vote choice: 0=Against, 1=For, 2=Abstain.
     */
    function castCommunityVote(uint256 votacaoId, uint8 support) external {
        LibDiamond.enforceNotPaused();

        _enforceNotFrozen(msg.sender);

        bool isUser = DiamondAccessControl.hasRole(DiamondAccessControl.USER_ROLE, msg.sender);
        bool isAgent = DiamondAccessControl.hasRole(DiamondAccessControl.AGENT_ROLE, msg.sender);
        if (!isUser && !isAgent) revert NotAuthorized(msg.sender);

        CommunityStorage storage cs = communityStorage();
        Votacao storage v = cs.votacoes[votacaoId];
        if (v.creator == address(0)) revert VotacaoNotFound(votacaoId);
        if (v.state != DAOStorage.ProposalState.Active) revert VotacaoNotActive(votacaoId);
        if (block.timestamp >= v.votingDeadline) revert VotingEnded(votacaoId);
        if (cs.hasVoted[votacaoId][msg.sender]) revert AlreadyVoted(votacaoId, msg.sender);

        if (support > 2) revert InvalidVoteChoice();

        uint256 feeAmount = PaymentLib.processCustomFeePayment(msg.sender, PaymentLib.FEE_TYPE_VOTING);
        emit FeePaid(msg.sender, PaymentLib.FEE_TYPE_VOTING, feeAmount);

        if (support == 0) {
            v.againstVotes += 1;
        } else if (support == 1) {
            v.forVotes += 1;
        } else {
            v.abstainVotes += 1;
        }

        cs.hasVoted[votacaoId][msg.sender] = true;

        emit CommunityVoteCast(votacaoId, msg.sender, support);
    }

    /**
     * @notice Cancel a votação. Only DAO_CANCELLER_ROLE.
     * @param votacaoId The votação ID to cancel.
     */
    function cancelVotacao(uint256 votacaoId) external {
        LibDiamond.enforceNotPaused();
        DiamondAccessControl.enforceRole(DiamondAccessControl.DAO_CANCELLER_ROLE);

        CommunityStorage storage cs = communityStorage();
        Votacao storage v = cs.votacoes[votacaoId];
        if (v.creator == address(0)) revert VotacaoNotFound(votacaoId);
        require(
            v.state == DAOStorage.ProposalState.Active ||
            v.state == DAOStorage.ProposalState.Pending,
            "CommunityDAO: not cancelable"
        );

        v.state = DAOStorage.ProposalState.Canceled;
        emit VotacaoCanceled(votacaoId);
    }

    /**
     * @notice Queue a succeeded votação for execution after timelock.
     * @param votacaoId The votação ID to queue.
     */
    function queueVotacao(uint256 votacaoId) external {
        LibDiamond.enforceNotPaused();
        DiamondAccessControl.enforceRoleOrOwner(DiamondAccessControl.DAO_EXECUTOR_ROLE);

        CommunityStorage storage cs = communityStorage();
        Votacao storage v = cs.votacoes[votacaoId];
        if (v.creator == address(0)) revert VotacaoNotFound(votacaoId);

        _updateVotacaoState(votacaoId);

        if (v.state != DAOStorage.ProposalState.Succeeded) {
            revert QuorumNotReached(votacaoId);
        }

        v.state = DAOStorage.ProposalState.Queued;
        v.executedAt = block.timestamp + cs.timelockDelay;
        emit VotacaoQueued(votacaoId, v.executedAt);
    }

    /**
     * @notice Execute a queued votação after timelock expires.
     * @param votacaoId The votação ID to execute.
     */
    function executeVotacao(uint256 votacaoId) external {
        LibDiamond.enforceNotPaused();
        DiamondAccessControl.enforceRoleOrOwner(DiamondAccessControl.DAO_EXECUTOR_ROLE);

        CommunityStorage storage cs = communityStorage();
        Votacao storage v = cs.votacoes[votacaoId];
        if (v.creator == address(0)) revert VotacaoNotFound(votacaoId);
        if (v.state != DAOStorage.ProposalState.Queued) revert VotacaoNotQueued(votacaoId);
        if (block.timestamp < v.executedAt) revert TimelockActive(votacaoId, v.executedAt);
        if (block.timestamp > v.executedAt + EXECUTION_WINDOW) revert ExecutionWindowExpired(votacaoId);

        v.state = DAOStorage.ProposalState.Executed;
        emit VotacaoExecuted(votacaoId);
    }

    // -----------------------------------------------------------------------
    // Merkle proof verification
    // -----------------------------------------------------------------------

    /**
     * @notice Verify a Merkle proof for a pauta item in a votação.
     * @param votacaoId The votação ID.
     * @param itemId    The pauta item ID.
     * @param contentHash The content hash of the item.
     * @param proof     Merkle proof array.
     * @return True if the proof is valid.
     */
    function verifyPautaProof(
        uint256 votacaoId,
        uint256 itemId,
        bytes32 contentHash,
        bytes32[] calldata proof
    ) external view returns (bool) {
        CommunityStorage storage cs = communityStorage();
        Votacao storage v = cs.votacoes[votacaoId];
        if (v.creator == address(0)) revert VotacaoNotFound(votacaoId);

        bytes32 leaf = MerkleTreeLib.computeLeaf(itemId, contentHash);
        return MerkleTreeLib.verify(v.merkleRoot, leaf, proof);
    }

    // -----------------------------------------------------------------------
    // View functions
    // -----------------------------------------------------------------------

    function getPautaItem(uint256 itemId) external view returns (PautaItem memory) {
        CommunityStorage storage cs = communityStorage();
        if (cs.pautaItems[itemId].proposer == address(0)) revert PautaItemNotFound(itemId);
        return cs.pautaItems[itemId];
    }

    function getVotacao(uint256 votacaoId) external view returns (Votacao memory) {
        CommunityStorage storage cs = communityStorage();
        if (cs.votacoes[votacaoId].creator == address(0)) revert VotacaoNotFound(votacaoId);
        return cs.votacoes[votacaoId];
    }

    function getVotacaoState(uint256 votacaoId) external view returns (DAOStorage.ProposalState) {
        CommunityStorage storage cs = communityStorage();
        Votacao storage v = cs.votacoes[votacaoId];
        if (v.creator == address(0)) revert VotacaoNotFound(votacaoId);

        if (v.state == DAOStorage.ProposalState.Active &&
            block.timestamp >= v.votingDeadline) {
            return _calculateOutcome(v) ? DAOStorage.ProposalState.Succeeded : DAOStorage.ProposalState.Defeated;
        }
        return v.state;
    }

    function getPautaItemCount() external view returns (uint256) {
        return communityStorage().pautaItemCount;
    }

    function getVotacaoCount() external view returns (uint256) {
        return communityStorage().votacaoCount;
    }

    function hasVotedInVotacao(uint256 votacaoId, address voter) external view returns (bool) {
        return communityStorage().hasVoted[votacaoId][voter];
    }

    function isItemInVotacao(uint256 votacaoId, uint256 itemId) external view returns (bool) {
        return communityStorage().itemInVotacao[votacaoId][itemId];
    }

    function getCommunityQuorum() external view returns (uint256) {
        return communityStorage().quorumBps;
    }

    function getCommunityVotingDuration() external view returns (uint256) {
        return communityStorage().votingDuration;
    }

    function getCommunityTimelockDelay() external view returns (uint256) {
        return communityStorage().timelockDelay;
    }

    // -----------------------------------------------------------------------
    // Internal
    // -----------------------------------------------------------------------

    function _updateVotacaoState(uint256 votacaoId) internal {
        CommunityStorage storage cs = communityStorage();
        Votacao storage v = cs.votacoes[votacaoId];
        if (v.state == DAOStorage.ProposalState.Active &&
            block.timestamp >= v.votingDeadline) {
            if (_calculateOutcome(v)) {
                v.state = DAOStorage.ProposalState.Succeeded;
            } else {
                v.state = DAOStorage.ProposalState.Defeated;
            }
        }
    }

    function _calculateOutcome(Votacao storage v) internal view returns (bool) {
        CommunityStorage storage cs = communityStorage();
        uint256 totalVotes = v.forVotes + v.againstVotes + v.abstainVotes;

        uint256 totalEligible = DiamondAccessControl.getRoleMemberCount(DiamondAccessControl.USER_ROLE) +
            DiamondAccessControl.getRoleMemberCount(DiamondAccessControl.AGENT_ROLE);

        if (!VotingLib.isQuorumReached(totalVotes, cs.quorumBps, totalEligible)) {
            return false;
        }
        return VotingLib.isApproved(v.forVotes, v.againstVotes);
    }

    function _enforceNotFrozen(address account) internal view {
        address casTokenAddr = address(PaymentStorage.paymentStorage().casToken);
        if (casTokenAddr != address(0)) {
            if (ICASToken(casTokenAddr).isFrozen(account)) revert AccountFrozen(account);
        }
    }
}
