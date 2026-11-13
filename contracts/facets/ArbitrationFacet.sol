// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { LibDiamond } from "../diamond/libraries/LibDiamond.sol";
import { DiamondAccessControl } from "../diamond/access/DiamondAccessControl.sol";
import { ArbitrationStorage } from "../diamond/storage/ArbitrationStorage.sol";
import { PaymentLib } from "../libs/PaymentLib.sol";
import { VotingPowerLib } from "../libs/VotingPowerLib.sol";
import { ICASTokenCompliance } from "../interfaces/ICASTokenCompliance.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ReentrancyGuardTransient } from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

/**
 * @title ArbitrationFacet
 * @dev Facet for fraud arbitration cases using Diamond Storage.
 *      Compliance officers file cases, DAO members vote, and outcomes
 *      trigger freeze/unfreeze on the CAS token.
 *
 *      Features:
 *      - File arbitration case with accused addresses and evidence
 *      - Vote with CAS fee (0.5 CAS per vote)
 *      - Quorum and timelock for execution
 *      - Expired cases get 6-month freeze + retry (max 3)
 *      - Reentrancy protection
 *
 *      Padrões: Diamond Storage (EIP-2535), Command (cases), Observer (events),
 *               Strategy (freeze types), Template Method (execution flow)
 */
contract ArbitrationFacet is ReentrancyGuardTransient {
    using ArbitrationStorage for ArbitrationStorage.ArbitrationStorageData;

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    event ArbitrationCaseFiled(
        uint256 indexed caseId,
        address indexed filer,
        uint8 freezeType,
        uint256 votingDeadline
    );
    event ArbitrationVoteCast(
        uint256 indexed caseId,
        address indexed voter,
        uint8 support,
        uint256 weight
    );
    event ArbitrationCaseExecuted(
        uint256 indexed caseId,
        bool approved,
        uint256 timestamp
    );
    event ArbitrationCaseCanceled(uint256 indexed caseId);
    event ArbitrationCaseExpired(uint256 indexed caseId, uint256 retryCount);
    event ArbitrationRetryFrozen(address indexed account, uint256 untilTime);
    event QuorumUpdated(uint256 oldQuorum, uint256 newQuorum);
    event VotingDurationUpdated(uint256 oldDuration, uint256 newDuration);
    event DisclosureDurationUpdated(uint256 oldDuration, uint256 newDuration);
    event CasTokenSet(address indexed casToken);
    event FeePaid(address indexed payer, uint256 feeType, uint256 amount);
    event VotingPeriodChanged(uint256 indexed caseId, uint8 newPeriod);
    event VotingLockActivated(uint256 indexed caseId);
    event VotingLockDeactivated(uint256 indexed caseId);
    event ArbitrationRevoteRequired(uint256 indexed caseId, uint256 revoteCount);
    event MaxRevotesUpdated(uint256 oldMax, uint256 newMax);
    event VotingPowerCast(uint256 indexed caseId, address indexed voter, uint256 power);
    event VoteDelegated(address indexed delegator, address indexed delegatee, uint256 power);
    event ReputationScoreUpdated(address indexed voter, uint256 score);
    event TechnicalCouncilMemberSet(address indexed member, bool isMember);
    event CaseChallenged(uint256 indexed caseId, address indexed challenger);
    event ChallengeResolved(uint256 indexed caseId, bool upheld);
    event AppealFiled(uint256 indexed caseId, uint256 appealCount);
    event VotingPowerConfigUpdated(
        uint256 balanceWeight, uint256 stakingWeight,
        uint256 reputationWeight, uint256 maxPower, bool quadraticEnabled
    );
    event StakeRecorded(address indexed voter, uint256 amount);

    // -----------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------

    error CaseNotFound(uint256 caseId);
    error CaseNotActive(uint256 caseId);
    error CaseNotPending(uint256 caseId);
    error VotingEnded(uint256 caseId);
    error AlreadyVoted(uint256 caseId, address voter);
    error QuorumNotReached(uint256 caseId);
    error TimelockActive(uint256 caseId, uint256 eta);
    error ExecutionWindowExpired(uint256 caseId);
    error EmptyAccusedList();
    error AccusedArrayLengthMismatch();
    error ZeroAddress();
    error InvalidFreezeType();
    error FreezeUntilMustBeFuture();
    error MaxRetriesReached(uint256 maxRetries);
    error CasTokenNotSet();
    error NotAuthorized(address caller);
    error CaseNotInVotingPeriod(uint256 caseId, uint8 currentPeriod);
    error CaseNotInDisclosurePeriod(uint256 caseId);
    error VotingLockActive();
    error InvalidSupport();
    error VoterNotRegistered(address voter);
    error NoMajorityReached(uint256 caseId, uint256 forVotes, uint256 againstVotes);
    error MaxRevotesReached(uint256 maxRevotes);
    error CannotDelegateToSelf();
    error InvalidReputationScore();
    error ChallengePeriodNotActive(uint256 caseId);
    error ChallengePeriodExpired(uint256 caseId);
    error AlreadyChallenged(uint256 caseId);
    error NotTechnicalCouncil(address caller);
    error MaxAppealsReached(uint256 maxAppeals);
    error InvalidWeights();
    error InvalidMaxPower();

    // -----------------------------------------------------------------------
    // Constants
    // -----------------------------------------------------------------------

    uint256 internal constant EXECUTION_WINDOW = 7 days;
    uint256 internal constant MIN_VOTING_DURATION = 1 days;
    uint256 internal constant MAX_VOTING_DURATION = 14 days;
    uint256 internal constant DEFAULT_DISCLOSURE_DURATION = 2 days;
    uint256 internal constant MIN_DISCLOSURE_DURATION = 1 days;
    uint256 internal constant MAX_DISCLOSURE_DURATION = 7 days;
    uint256 internal constant DEFAULT_MAX_REVOTES = 3;

    /// @dev Outcome of a vote calculation: 0 = Inconclusive, 1 = Approved, 2 = Rejected
    uint8 internal constant OUTCOME_INCONCLUSIVE = 0;
    uint8 internal constant OUTCOME_APPROVED = 1;
    uint8 internal constant OUTCOME_REJECTED = 2;

    // -----------------------------------------------------------------------
    // Init (called via diamondCut delegatecall)
    // -----------------------------------------------------------------------

    function initArbitration() external {
        LibDiamond.enforceIsContractOwner();
        ArbitrationStorage.ArbitrationStorageData storage s = ArbitrationStorage.arbitrationStorage();
        s.quorumBps = 500;
        s.votingDuration = 5 days;
        s.disclosureDuration = DEFAULT_DISCLOSURE_DURATION;
        s.timelockDelay = 3 days;
        s.maxRetries = 3;
        s.retryFreezeDuration = 180 days;
        s.maxRevotes = DEFAULT_MAX_REVOTES;
        s.votingLockActive = false;
        s.maxAppeals = 2;
        VotingPowerLib.initConfig(s.votingPower);
    }

    // -----------------------------------------------------------------------
    // Admin functions
    // -----------------------------------------------------------------------

    function setArbitrationQuorum(uint256 newQuorum) external {
        DiamondAccessControl.enforceIsContractOwner();
        require(newQuorum > 0 && newQuorum <= 10000, "Arbitration: invalid quorum");
        ArbitrationStorage.ArbitrationStorageData storage s = ArbitrationStorage.arbitrationStorage();
        uint256 old = s.quorumBps;
        s.quorumBps = newQuorum;
        emit QuorumUpdated(old, newQuorum);
    }

    function setArbitrationVotingDuration(uint256 newDuration) external {
        DiamondAccessControl.enforceIsContractOwner();
        require(newDuration >= MIN_VOTING_DURATION, "Arbitration: voting duration too short");
        require(newDuration <= MAX_VOTING_DURATION, "Arbitration: voting duration too long");
        ArbitrationStorage.ArbitrationStorageData storage s = ArbitrationStorage.arbitrationStorage();
        uint256 old = s.votingDuration;
        s.votingDuration = newDuration;
        emit VotingDurationUpdated(old, newDuration);
    }

    function setArbitrationDisclosureDuration(uint256 newDuration) external {
        DiamondAccessControl.enforceIsContractOwner();
        require(newDuration >= MIN_DISCLOSURE_DURATION, "Arbitration: disclosure duration too short");
        require(newDuration <= MAX_DISCLOSURE_DURATION, "Arbitration: disclosure duration too long");
        ArbitrationStorage.ArbitrationStorageData storage s = ArbitrationStorage.arbitrationStorage();
        uint256 old = s.disclosureDuration;
        s.disclosureDuration = newDuration;
        emit DisclosureDurationUpdated(old, newDuration);
    }

    function setArbitrationCasToken(address casToken) external {
        DiamondAccessControl.enforceIsContractOwner();
        if (casToken == address(0)) revert ZeroAddress();
        ArbitrationStorage.arbitrationStorage().casToken = casToken;
        emit CasTokenSet(casToken);
    }

    function setMaxRevotes(uint256 newMax) external {
        DiamondAccessControl.enforceIsContractOwner();
        require(newMax > 0, "Arbitration: max revotes must be > 0");
        ArbitrationStorage.ArbitrationStorageData storage s = ArbitrationStorage.arbitrationStorage();
        uint256 old = s.maxRevotes;
        s.maxRevotes = newMax;
        emit MaxRevotesUpdated(old, newMax);
    }

    // -----------------------------------------------------------------------
    // Case lifecycle
    // -----------------------------------------------------------------------

    function fileArbitrationCase(
        address[] calldata accused,
        string[] calldata reasons,
        bytes32 evidenceHash,
        uint8 freezeType,
        uint256 freezeUntilTime
    ) external nonReentrant returns (uint256) {
        LibDiamond.enforceNotPaused();
        DiamondAccessControl.enforceRoleOrOwner(DiamondAccessControl.DAO_PROPOSER_ROLE);

        if (accused.length == 0) revert EmptyAccusedList();
        if (accused.length != reasons.length) revert AccusedArrayLengthMismatch();
        if (freezeType > 2) revert InvalidFreezeType();
        if (freezeType == 0 && freezeUntilTime <= block.timestamp) revert FreezeUntilMustBeFuture();

        for (uint256 i = 0; i < accused.length; i++) {
            if (accused[i] == address(0)) revert ZeroAddress();
        }

        ArbitrationStorage.ArbitrationStorageData storage s = ArbitrationStorage.arbitrationStorage();

        uint256 feeAmount = PaymentLib.processCustomFeePayment(msg.sender, PaymentLib.FEE_TYPE_ARBITRATION_PROPOSAL);
        emit FeePaid(msg.sender, PaymentLib.FEE_TYPE_ARBITRATION_PROPOSAL, feeAmount);

        uint256 caseId = ++s.caseCount;
        uint256 disclosureDeadline = block.timestamp + s.disclosureDuration;
        uint256 votingDeadline = disclosureDeadline + s.votingDuration;

        ArbitrationStorage.ArbitrationCase storage newCase = s.cases[caseId];
        newCase.caseId = caseId;
        newCase.filer = msg.sender;
        newCase.accused = accused;
        newCase.reasons = reasons;
        newCase.evidenceHash = evidenceHash;
        newCase.freezeType = ArbitrationStorage.FreezeType(freezeType);
        newCase.freezeUntilTime = freezeUntilTime;
        newCase.createdAt = block.timestamp;
        newCase.disclosureDeadline = disclosureDeadline;
        newCase.votingDeadline = votingDeadline;
        newCase.executedAt = 0;
        newCase.state = ArbitrationStorage.CaseState.Active;
        newCase.votingPeriod = ArbitrationStorage.VotingPeriod.Disclosure;
        newCase.forVotes = 0;
        newCase.againstVotes = 0;
        newCase.abstainVotes = 0;
        newCase.retryCount = 0;

        emit ArbitrationCaseFiled(caseId, msg.sender, freezeType, votingDeadline);
        emit VotingPeriodChanged(caseId, uint8(ArbitrationStorage.VotingPeriod.Disclosure));
        return caseId;
    }

    function castArbitrationVote(uint256 caseId, uint8 support) external nonReentrant {
        LibDiamond.enforceNotPaused();

        ArbitrationStorage.ArbitrationStorageData storage s = ArbitrationStorage.arbitrationStorage();
        ArbitrationStorage.ArbitrationCase storage arbCase = s.cases[caseId];
        if (arbCase.filer == address(0)) revert CaseNotFound(caseId);
        if (arbCase.state != ArbitrationStorage.CaseState.Active) revert CaseNotActive(caseId);

        // Auto-transition: Disclosure -> Voting
        if (arbCase.votingPeriod == ArbitrationStorage.VotingPeriod.Disclosure && block.timestamp >= arbCase.disclosureDeadline) {
            _enterVotingPeriod(s, arbCase);
        }

        if (arbCase.votingPeriod != ArbitrationStorage.VotingPeriod.Voting) revert CaseNotInVotingPeriod(caseId, uint8(arbCase.votingPeriod));
        if (block.timestamp >= arbCase.votingDeadline) revert VotingEnded(caseId);
        if (s.hasVotedRound[caseId][msg.sender] == arbCase.revoteCount + 1) revert AlreadyVoted(caseId, msg.sender);
        if (support > 2) revert InvalidSupport();

        bool isUser = DiamondAccessControl.hasRole(DiamondAccessControl.USER_ROLE, msg.sender);
        bool isAgent = DiamondAccessControl.hasRole(DiamondAccessControl.AGENT_ROLE, msg.sender);
        if (!isUser && !isAgent) revert VoterNotRegistered(msg.sender);

        address casTokenAddr = s.casToken;
        if (casTokenAddr == address(0)) revert CasTokenNotSet();
        if (ICASTokenCompliance(casTokenAddr).isFrozen(msg.sender)) revert NotAuthorized(msg.sender);

        uint256 feeAmount = PaymentLib.processCustomFeePayment(msg.sender, PaymentLib.FEE_TYPE_ARBITRATION_VOTE);
        emit FeePaid(msg.sender, PaymentLib.FEE_TYPE_ARBITRATION_VOTE, feeAmount);

        // Calculate weighted voting power
        uint256 tokenBalance = IERC20(casTokenAddr).balanceOf(msg.sender);
        uint256 votingPower = VotingPowerLib.calculateVotingPower(
            s.votingPower, msg.sender, tokenBalance
        );

        // Record stake info for future staking duration calculations
        VotingPowerLib.recordStake(s.votingPower, msg.sender, tokenBalance);

        if (support == 0) {
            arbCase.againstVotes += votingPower;
        } else if (support == 1) {
            arbCase.forVotes += votingPower;
        } else {
            arbCase.abstainVotes += votingPower;
        }
        arbCase.totalPowerCast += votingPower;
        s.votedPower[caseId][msg.sender] = votingPower;

        s.hasVotedRound[caseId][msg.sender] = arbCase.revoteCount + 1;

        emit ArbitrationVoteCast(caseId, msg.sender, support, votingPower);
        emit VotingPowerCast(caseId, msg.sender, votingPower);
    }

    function executeArbitrationCase(uint256 caseId) external nonReentrant {
        LibDiamond.enforceNotPaused();
        DiamondAccessControl.enforceRoleOrOwner(DiamondAccessControl.DAO_EXECUTOR_ROLE);

        ArbitrationStorage.ArbitrationStorageData storage s = ArbitrationStorage.arbitrationStorage();
        ArbitrationStorage.ArbitrationCase storage arbCase = s.cases[caseId];
        if (arbCase.filer == address(0)) revert CaseNotFound(caseId);
        if (arbCase.state != ArbitrationStorage.CaseState.Active) revert CaseNotActive(caseId);
        if (block.timestamp < arbCase.votingDeadline) revert VotingEnded(caseId);

        // Auto-transition: Voting -> Result
        if (arbCase.votingPeriod == ArbitrationStorage.VotingPeriod.Voting) {
            _enterResultPeriod(s, arbCase);
        }

        uint8 outcome = _calculateOutcome(arbCase);

        // If no majority, trigger a new voting round
        if (outcome == OUTCOME_INCONCLUSIVE) {
            if (arbCase.revoteCount >= s.maxRevotes) revert MaxRevotesReached(s.maxRevotes);
            _triggerRevote(s, arbCase);
            return;
        }

        bool approved = (outcome == OUTCOME_APPROVED);

        // Enter challenge period instead of immediate execution
        arbCase.votingPeriod = ArbitrationStorage.VotingPeriod.Challenge;
        arbCase.challengeDeadline = block.timestamp + s.votingPower.config.challengePeriodDuration;
        arbCase.state = ArbitrationStorage.CaseState.Challenged;

        emit VotingPeriodChanged(caseId, uint8(ArbitrationStorage.VotingPeriod.Challenge));
    }

    function cancelArbitrationCase(uint256 caseId) external {
        LibDiamond.enforceNotPaused();
        DiamondAccessControl.enforceRoleOrOwner(DiamondAccessControl.DAO_CANCELLER_ROLE);

        ArbitrationStorage.ArbitrationStorageData storage s = ArbitrationStorage.arbitrationStorage();
        ArbitrationStorage.ArbitrationCase storage arbCase = s.cases[caseId];
        if (arbCase.filer == address(0)) revert CaseNotFound(caseId);
        require(
            arbCase.state == ArbitrationStorage.CaseState.Active ||
            arbCase.state == ArbitrationStorage.CaseState.Pending,
            "Arbitration: not cancelable"
        );

        arbCase.state = ArbitrationStorage.CaseState.Canceled;
        emit ArbitrationCaseCanceled(caseId);
    }

    function handleExpiredCase(uint256 caseId) external nonReentrant {
        LibDiamond.enforceNotPaused();
        DiamondAccessControl.enforceRoleOrOwner(DiamondAccessControl.DAO_EXECUTOR_ROLE);

        ArbitrationStorage.ArbitrationStorageData storage s = ArbitrationStorage.arbitrationStorage();
        ArbitrationStorage.ArbitrationCase storage arbCase = s.cases[caseId];
        if (arbCase.filer == address(0)) revert CaseNotFound(caseId);
        if (arbCase.state != ArbitrationStorage.CaseState.Active) revert CaseNotActive(caseId);
        if (block.timestamp < arbCase.votingDeadline) revert VotingEnded(caseId);

        uint8 outcome = _calculateOutcome(arbCase);
        if (outcome == OUTCOME_APPROVED) {
            arbCase.state = ArbitrationStorage.CaseState.Executed;
            arbCase.executedAt = block.timestamp;
            emit ArbitrationCaseExecuted(caseId, true, block.timestamp);
            return;
        }
        if (outcome == OUTCOME_REJECTED) {
            arbCase.state = ArbitrationStorage.CaseState.Executed;
            arbCase.executedAt = block.timestamp;
            emit ArbitrationCaseExecuted(caseId, false, block.timestamp);
            return;
        }

        if (arbCase.retryCount >= s.maxRetries) revert MaxRetriesReached(s.maxRetries);

        arbCase.retryCount += 1;
        arbCase.state = ArbitrationStorage.CaseState.RetryPending;

        address casTokenAddr = s.casToken;
        if (casTokenAddr == address(0)) revert CasTokenNotSet();
        ICASTokenCompliance casToken = ICASTokenCompliance(casTokenAddr);

        uint256 freezeUntilTime = block.timestamp + s.retryFreezeDuration;
        for (uint256 i = 0; i < arbCase.accused.length; i++) {
            casToken.freezeUntil(arbCase.accused[i], freezeUntilTime);
            s.frozenByArbitration[arbCase.accused[i]] = true;
            emit ArbitrationRetryFrozen(arbCase.accused[i], freezeUntilTime);
        }

        emit ArbitrationCaseExpired(caseId, arbCase.retryCount);
    }

    function refileExpiredCase(uint256 caseId) external nonReentrant {
        LibDiamond.enforceNotPaused();
        DiamondAccessControl.enforceRoleOrOwner(DiamondAccessControl.DAO_PROPOSER_ROLE);

        ArbitrationStorage.ArbitrationStorageData storage s = ArbitrationStorage.arbitrationStorage();
        ArbitrationStorage.ArbitrationCase storage arbCase = s.cases[caseId];
        if (arbCase.filer == address(0)) revert CaseNotFound(caseId);
        if (arbCase.state != ArbitrationStorage.CaseState.RetryPending) revert CaseNotPending(caseId);

        uint256 feeAmount = PaymentLib.processCustomFeePayment(msg.sender, PaymentLib.FEE_TYPE_ARBITRATION_PROPOSAL);
        emit FeePaid(msg.sender, PaymentLib.FEE_TYPE_ARBITRATION_PROPOSAL, feeAmount);

        arbCase.state = ArbitrationStorage.CaseState.Active;
        arbCase.votingPeriod = ArbitrationStorage.VotingPeriod.Disclosure;
        uint256 disclosureDeadline = block.timestamp + s.disclosureDuration;
        arbCase.disclosureDeadline = disclosureDeadline;
        arbCase.votingDeadline = disclosureDeadline + s.votingDuration;
        arbCase.forVotes = 0;
        arbCase.againstVotes = 0;
        arbCase.abstainVotes = 0;

        emit ArbitrationCaseFiled(caseId, msg.sender, uint8(arbCase.freezeType), arbCase.votingDeadline);
        emit VotingPeriodChanged(caseId, uint8(ArbitrationStorage.VotingPeriod.Disclosure));
    }

    // -----------------------------------------------------------------------
    // View functions
    // -----------------------------------------------------------------------

    function getCase(uint256 caseId) external view returns (ArbitrationStorage.ArbitrationCase memory) {
        ArbitrationStorage.ArbitrationStorageData storage s = ArbitrationStorage.arbitrationStorage();
        if (s.cases[caseId].filer == address(0)) revert CaseNotFound(caseId);
        return s.cases[caseId];
    }

    function getCaseCount() external view returns (uint256) {
        return ArbitrationStorage.arbitrationStorage().caseCount;
    }

    function getCaseState(uint256 caseId) external view returns (ArbitrationStorage.CaseState) {
        ArbitrationStorage.ArbitrationStorageData storage s = ArbitrationStorage.arbitrationStorage();
        if (s.cases[caseId].filer == address(0)) revert CaseNotFound(caseId);
        return s.cases[caseId].state;
    }

    function getVotingPeriod(uint256 caseId) external view returns (ArbitrationStorage.VotingPeriod) {
        ArbitrationStorage.ArbitrationStorageData storage s = ArbitrationStorage.arbitrationStorage();
        if (s.cases[caseId].filer == address(0)) revert CaseNotFound(caseId);
        return s.cases[caseId].votingPeriod;
    }

    function isVotingLockActive() external view returns (bool) {
        return ArbitrationStorage.arbitrationStorage().votingLockActive;
    }

    function getArbitrationDisclosureDuration() external view returns (uint256) {
        return ArbitrationStorage.arbitrationStorage().disclosureDuration;
    }

    function hasVotedInCase(uint256 caseId, address voter) external view returns (bool) {
        ArbitrationStorage.ArbitrationStorageData storage s = ArbitrationStorage.arbitrationStorage();
        if (s.cases[caseId].filer == address(0)) revert CaseNotFound(caseId);
        return s.hasVotedRound[caseId][voter] == s.cases[caseId].revoteCount + 1;
    }

    function isFrozenByArbitration(address account) external view returns (bool) {
        return ArbitrationStorage.arbitrationStorage().frozenByArbitration[account];
    }

    function getArbitrationQuorum() external view returns (uint256) {
        return ArbitrationStorage.arbitrationStorage().quorumBps;
    }

    function getArbitrationVotingDuration() external view returns (uint256) {
        return ArbitrationStorage.arbitrationStorage().votingDuration;
    }

    function getArbitrationCasToken() external view returns (address) {
        return ArbitrationStorage.arbitrationStorage().casToken;
    }

    function getMaxRetries() external view returns (uint256) {
        return ArbitrationStorage.arbitrationStorage().maxRetries;
    }

    function getRetryFreezeDuration() external view returns (uint256) {
        return ArbitrationStorage.arbitrationStorage().retryFreezeDuration;
    }

    function getMaxRevotes() external view returns (uint256) {
        return ArbitrationStorage.arbitrationStorage().maxRevotes;
    }

    function getRevoteCount(uint256 caseId) external view returns (uint256) {
        ArbitrationStorage.ArbitrationStorageData storage s = ArbitrationStorage.arbitrationStorage();
        if (s.cases[caseId].filer == address(0)) revert CaseNotFound(caseId);
        return s.cases[caseId].revoteCount;
    }

    // -----------------------------------------------------------------------
    // Voting Power: Delegation
    // -----------------------------------------------------------------------

    function delegateArbitrationVote(address delegatee) external nonReentrant {
        LibDiamond.enforceNotPaused();
        ArbitrationStorage.ArbitrationStorageData storage s = ArbitrationStorage.arbitrationStorage();
        if (msg.sender == delegatee) revert CannotDelegateToSelf();

        address casTokenAddr = s.casToken;
        if (casTokenAddr == address(0)) revert CasTokenNotSet();
        uint256 tokenBalance = IERC20(casTokenAddr).balanceOf(msg.sender);
        uint256 power = VotingPowerLib.calculateVotingPower(s.votingPower, msg.sender, tokenBalance);

        VotingPowerLib.delegate(s.votingPower, msg.sender, delegatee, power);
        emit VoteDelegated(msg.sender, delegatee, power);
    }

    function clearArbitrationDelegation() external nonReentrant {
        LibDiamond.enforceNotPaused();
        ArbitrationStorage.ArbitrationStorageData storage s = ArbitrationStorage.arbitrationStorage();
        VotingPowerLib.clearDelegation(s.votingPower, msg.sender);
    }

    function getArbitrationDelegatee(address delegator) external view returns (address) {
        return VotingPowerLib.getDelegatee(
            ArbitrationStorage.arbitrationStorage().votingPower, delegator
        );
    }

    // -----------------------------------------------------------------------
    // Voting Power: Reputation & Technical Council
    // -----------------------------------------------------------------------

    function setReputation(address voter, uint256 score) external {
        DiamondAccessControl.enforceIsContractOwner();
        if (score > 10000) revert InvalidReputationScore();
        ArbitrationStorage.ArbitrationStorageData storage s = ArbitrationStorage.arbitrationStorage();
        VotingPowerLib.setReputation(s.votingPower, voter, score);
        emit ReputationScoreUpdated(voter, score);
    }

    function getReputation(address voter) external view returns (uint256) {
        return VotingPowerLib.getReputation(
            ArbitrationStorage.arbitrationStorage().votingPower, voter
        );
    }

    function setTechnicalCouncilMember(address member, bool isMember) external {
        DiamondAccessControl.enforceIsContractOwner();
        ArbitrationStorage.ArbitrationStorageData storage s = ArbitrationStorage.arbitrationStorage();
        VotingPowerLib.setTechnicalCouncilMember(s.votingPower, member, isMember);
        emit TechnicalCouncilMemberSet(member, isMember);
    }

    function isTechnicalCouncilMember(address member) external view returns (bool) {
        return VotingPowerLib.isTechnicalCouncilMember(
            ArbitrationStorage.arbitrationStorage().votingPower, member
        );
    }

    // -----------------------------------------------------------------------
    // Voting Power: Config
    // -----------------------------------------------------------------------

    function setVotingPowerConfig(
        uint256 balanceWeightBps,
        uint256 stakingWeightBps,
        uint256 reputationWeightBps,
        uint256 maxVotingPower,
        bool quadraticEnabled
    ) external {
        DiamondAccessControl.enforceIsContractOwner();
        ArbitrationStorage.ArbitrationStorageData storage s = ArbitrationStorage.arbitrationStorage();
        VotingPowerLib.updateConfig(
            s.votingPower,
            balanceWeightBps,
            stakingWeightBps,
            reputationWeightBps,
            maxVotingPower,
            quadraticEnabled
        );
        emit VotingPowerConfigUpdated(
            balanceWeightBps, stakingWeightBps, reputationWeightBps, maxVotingPower, quadraticEnabled
        );
    }

    function getVotingPower(address voter) external view returns (uint256) {
        ArbitrationStorage.ArbitrationStorageData storage s = ArbitrationStorage.arbitrationStorage();
        uint256 balance = s.casToken != address(0) ? IERC20(s.casToken).balanceOf(voter) : 0;
        return VotingPowerLib.calculateVotingPower(s.votingPower, voter, balance);
    }

    function getVotedPower(uint256 caseId, address voter) external view returns (uint256) {
        return ArbitrationStorage.arbitrationStorage().votedPower[caseId][voter];
    }

    // -----------------------------------------------------------------------
    // Challenge & Appeal System
    // -----------------------------------------------------------------------

    /// @dev Challenge a case result during the challenge period.
    ///      Any registered user can challenge by paying a fee.
    function challengeResult(uint256 caseId) external nonReentrant {
        LibDiamond.enforceNotPaused();

        ArbitrationStorage.ArbitrationStorageData storage s = ArbitrationStorage.arbitrationStorage();
        ArbitrationStorage.ArbitrationCase storage arbCase = s.cases[caseId];
        if (arbCase.filer == address(0)) revert CaseNotFound(caseId);
        if (arbCase.state != ArbitrationStorage.CaseState.Challenged) revert ChallengePeriodNotActive(caseId);
        if (block.timestamp >= arbCase.challengeDeadline) revert ChallengePeriodExpired(caseId);
        if (arbCase.challenger != address(0)) revert AlreadyChallenged(caseId);

        bool isUser = DiamondAccessControl.hasRole(DiamondAccessControl.USER_ROLE, msg.sender);
        bool isAgent = DiamondAccessControl.hasRole(DiamondAccessControl.AGENT_ROLE, msg.sender);
        if (!isUser && !isAgent) revert VoterNotRegistered(msg.sender);

        uint256 feeAmount = PaymentLib.processCustomFeePayment(msg.sender, PaymentLib.FEE_TYPE_ARBITRATION_PROPOSAL);
        emit FeePaid(msg.sender, PaymentLib.FEE_TYPE_ARBITRATION_PROPOSAL, feeAmount);

        arbCase.challenger = msg.sender;
        emit CaseChallenged(caseId, msg.sender);
    }

    /// @dev Resolve a challenge. Only the technical council can resolve.
    ///      If upheld, the original result stands. If overturned, a revote is triggered.
    function resolveChallenge(uint256 caseId, bool uphold) external nonReentrant {
        LibDiamond.enforceNotPaused();
        DiamondAccessControl.enforceRoleOrOwner(DiamondAccessControl.DAO_EXECUTOR_ROLE);

        ArbitrationStorage.ArbitrationStorageData storage s = ArbitrationStorage.arbitrationStorage();
        ArbitrationStorage.ArbitrationCase storage arbCase = s.cases[caseId];
        if (arbCase.filer == address(0)) revert CaseNotFound(caseId);
        if (arbCase.state != ArbitrationStorage.CaseState.Challenged) revert ChallengePeriodNotActive(caseId);
        if (arbCase.challenger == address(0)) revert ChallengePeriodNotActive(caseId);

        // Technical council member must approve the resolution
        if (!VotingPowerLib.isTechnicalCouncilMember(s.votingPower, msg.sender)) {
            revert NotTechnicalCouncil(msg.sender);
        }

        if (uphold) {
            // Original result stands — execute it
            _executeResult(s, arbCase);
            emit ChallengeResolved(caseId, true);
        } else {
            // Overturn — trigger a revote
            arbCase.challenger = address(0);
            if (arbCase.revoteCount >= s.maxRevotes) revert MaxRevotesReached(s.maxRevotes);
            _triggerRevote(s, arbCase);
            emit ChallengeResolved(caseId, false);
        }
    }

    /// @dev Finalize a case after the challenge period expires without challenge.
    function finalizeCase(uint256 caseId) external nonReentrant {
        LibDiamond.enforceNotPaused();

        ArbitrationStorage.ArbitrationStorageData storage s = ArbitrationStorage.arbitrationStorage();
        ArbitrationStorage.ArbitrationCase storage arbCase = s.cases[caseId];
        if (arbCase.filer == address(0)) revert CaseNotFound(caseId);
        if (arbCase.state != ArbitrationStorage.CaseState.Challenged) revert ChallengePeriodNotActive(caseId);
        if (arbCase.challenger != address(0)) revert AlreadyChallenged(caseId);
        if (block.timestamp < arbCase.challengeDeadline) revert ChallengePeriodNotActive(caseId);

        _executeResult(s, arbCase);
    }

    /// @dev File an appeal against an executed case. Appeals trigger a new revote
    ///      if the appeal count is within limits.
    function fileAppeal(uint256 caseId) external nonReentrant {
        LibDiamond.enforceNotPaused();

        ArbitrationStorage.ArbitrationStorageData storage s = ArbitrationStorage.arbitrationStorage();
        ArbitrationStorage.ArbitrationCase storage arbCase = s.cases[caseId];
        if (arbCase.filer == address(0)) revert CaseNotFound(caseId);
        if (arbCase.state != ArbitrationStorage.CaseState.Executed) revert CaseNotActive(caseId);

        uint256 appeals = s.appealCount[caseId];
        if (appeals >= s.maxAppeals) revert MaxAppealsReached(s.maxAppeals);

        uint256 feeAmount = PaymentLib.processCustomFeePayment(msg.sender, PaymentLib.FEE_TYPE_ARBITRATION_PROPOSAL);
        emit FeePaid(msg.sender, PaymentLib.FEE_TYPE_ARBITRATION_PROPOSAL, feeAmount);

        s.appealCount[caseId] = appeals + 1;

        // Reopen the case for a new revote
        arbCase.state = ArbitrationStorage.CaseState.Active;
        arbCase.executedAt = 0;
        _triggerRevote(s, arbCase);

        emit AppealFiled(caseId, appeals + 1);
    }

    function getAppealCount(uint256 caseId) external view returns (uint256) {
        return ArbitrationStorage.arbitrationStorage().appealCount[caseId];
    }

    function getChallengeDeadline(uint256 caseId) external view returns (uint256) {
        ArbitrationStorage.ArbitrationStorageData storage s = ArbitrationStorage.arbitrationStorage();
        if (s.cases[caseId].filer == address(0)) revert CaseNotFound(caseId);
        return s.cases[caseId].challengeDeadline;
    }

    // -----------------------------------------------------------------------
    // Internal
    // -----------------------------------------------------------------------

    function _calculateOutcome(
        ArbitrationStorage.ArbitrationCase storage arbCase
    ) internal view returns (uint8) {
        ArbitrationStorage.ArbitrationStorageData storage s = ArbitrationStorage.arbitrationStorage();
        uint256 totalVotes = arbCase.forVotes + arbCase.againstVotes + arbCase.abstainVotes;

        uint256 totalEligible = DiamondAccessControl.getRoleMemberCount(DiamondAccessControl.USER_ROLE) +
            DiamondAccessControl.getRoleMemberCount(DiamondAccessControl.AGENT_ROLE);

        if (totalEligible == 0) return OUTCOME_INCONCLUSIVE;

        uint256 requiredVotes = (totalEligible * s.quorumBps) / 10000;
        if (totalVotes < requiredVotes) return OUTCOME_INCONCLUSIVE;

        // Valid votes = for + against (abstentions are neutral, not decisive)
        uint256 validVotes = arbCase.forVotes + arbCase.againstVotes;
        if (validVotes == 0) return OUTCOME_INCONCLUSIVE;

        // Require >50% majority for one option
        if (arbCase.forVotes * 2 > validVotes) return OUTCOME_APPROVED;
        if (arbCase.againstVotes * 2 > validVotes) return OUTCOME_REJECTED;

        // No majority — inconclusive
        return OUTCOME_INCONCLUSIVE;
    }

    /// @dev Transition from Disclosure to Voting period.
    ///      Activates the global voting lock on CAS token transfers.
    function _enterVotingPeriod(
        ArbitrationStorage.ArbitrationStorageData storage s,
        ArbitrationStorage.ArbitrationCase storage arbCase
    ) internal {
        arbCase.votingPeriod = ArbitrationStorage.VotingPeriod.Voting;
        if (!s.votingLockActive) {
            s.votingLockActive = true;
            // Lock CAS token transfers to prevent vote buying
            address casTokenAddr = s.casToken;
            if (casTokenAddr != address(0)) {
                ICASTokenCompliance(casTokenAddr).setVotingLock(true);
            }
        }
        emit VotingPeriodChanged(arbCase.caseId, uint8(ArbitrationStorage.VotingPeriod.Voting));
        emit VotingLockActivated(arbCase.caseId);
    }

    /// @dev Transition from Voting to Result period.
    ///      Deactivates the global voting lock on CAS token transfers.
    function _enterResultPeriod(
        ArbitrationStorage.ArbitrationStorageData storage s,
        ArbitrationStorage.ArbitrationCase storage arbCase
    ) internal {
        arbCase.votingPeriod = ArbitrationStorage.VotingPeriod.Result;
        // Only deactivate lock if no other case is in Voting period
        bool anyVoting = false;
        for (uint256 i = 1; i <= s.caseCount; i++) {
            if (s.cases[i].state == ArbitrationStorage.CaseState.Active &&
                s.cases[i].votingPeriod == ArbitrationStorage.VotingPeriod.Voting) {
                anyVoting = true;
                break;
            }
        }
        if (!anyVoting) {
            s.votingLockActive = false;
            // Unlock CAS token transfers
            address casTokenAddr = s.casToken;
            if (casTokenAddr != address(0)) {
                ICASTokenCompliance(casTokenAddr).setVotingLock(false);
            }
        }
        emit VotingPeriodChanged(arbCase.caseId, uint8(ArbitrationStorage.VotingPeriod.Result));
        emit VotingLockDeactivated(arbCase.caseId);
    }

    /// @dev Execute the result of an arbitration case: freeze or unfreeze accused.
    function _executeResult(
        ArbitrationStorage.ArbitrationStorageData storage s,
        ArbitrationStorage.ArbitrationCase storage arbCase
    ) internal {
        uint8 outcome = _calculateOutcome(arbCase);
        bool approved = (outcome == OUTCOME_APPROVED);

        arbCase.state = ArbitrationStorage.CaseState.Executed;
        arbCase.executedAt = block.timestamp;

        address casTokenAddr = s.casToken;
        if (casTokenAddr == address(0)) revert CasTokenNotSet();
        ICASTokenCompliance casToken = ICASTokenCompliance(casTokenAddr);

        if (approved) {
            for (uint256 i = 0; i < arbCase.accused.length; i++) {
                if (arbCase.freezeType == ArbitrationStorage.FreezeType.Permanent) {
                    casToken.freeze(arbCase.accused[i]);
                } else if (arbCase.freezeType == ArbitrationStorage.FreezeType.Limited) {
                    casToken.freezeUntil(arbCase.accused[i], arbCase.freezeUntilTime);
                } else {
                    casToken.freeze(arbCase.accused[i]);
                }
                s.frozenByArbitration[arbCase.accused[i]] = true;
            }
        } else {
            for (uint256 i = 0; i < arbCase.accused.length; i++) {
                if (s.frozenByArbitration[arbCase.accused[i]]) {
                    casToken.unfreeze(arbCase.accused[i]);
                    s.frozenByArbitration[arbCase.accused[i]] = false;
                }
            }
        }

        emit ArbitrationCaseExecuted(arbCase.caseId, approved, block.timestamp);
    }

    /// @dev Trigger a new voting round when no majority is reached.
    ///      Resets the case to Disclosure period with fresh deadlines and zeroed votes.
    ///      Clears the hasVoted mapping so all eligible voters can vote again.
    function _triggerRevote(
        ArbitrationStorage.ArbitrationStorageData storage s,
        ArbitrationStorage.ArbitrationCase storage arbCase
    ) internal {
        arbCase.revoteCount += 1;
        arbCase.votingPeriod = ArbitrationStorage.VotingPeriod.Disclosure;
        uint256 disclosureDeadline = block.timestamp + s.disclosureDuration;
        arbCase.disclosureDeadline = disclosureDeadline;
        arbCase.votingDeadline = disclosureDeadline + s.votingDuration;
        arbCase.forVotes = 0;
        arbCase.againstVotes = 0;
        arbCase.abstainVotes = 0;
        arbCase.totalPowerCast = 0;
        arbCase.challengeDeadline = 0;
        arbCase.challenger = address(0);
        arbCase.technicalCouncilVeto = false;

        // hasVotedRound tracks which revote round a voter participated in.
        // By incrementing revoteCount, all voters can vote again in the new round.

        emit ArbitrationRevoteRequired(arbCase.caseId, arbCase.revoteCount);
        emit VotingPeriodChanged(arbCase.caseId, uint8(ArbitrationStorage.VotingPeriod.Disclosure));
    }
}
