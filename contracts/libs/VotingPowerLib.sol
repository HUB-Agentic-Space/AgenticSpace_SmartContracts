// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { DiamondAccessControl } from "../diamond/access/DiamondAccessControl.sol";

/**
 * @title VotingPowerLib
 * @dev Library for calculating weighted voting power in arbitration cases.
 *
 *      Voting power combines multiple criteria:
 *      1. Token balance component (proportional to CAS holdings)
 *      2. Staking duration component (time tokens held without moving)
 *      3. Reputation/participation component (based on role and history)
 *      4. Quadratic voting (diminishing returns on large holdings)
 *      5. Maximum power cap per wallet
 *
 *      Padrões: Strategy (power calculation), Factory (component weights)
 */
library VotingPowerLib {
    // -----------------------------------------------------------------------
    // Structs
    // -----------------------------------------------------------------------

    /// @dev Configuration for voting power calculation.
    struct VotingPowerConfig {
        // Weight for balance component (in basis points, e.g. 4000 = 40%)
        uint256 balanceWeightBps;
        // Weight for staking duration component (in basis points)
        uint256 stakingWeightBps;
        // Weight for reputation component (in basis points)
        uint256 reputationWeightBps;
        // Maximum voting power per wallet (in raw units, before quadratic)
        uint256 maxVotingPower;
        // Minimum staking duration to get full staking bonus (in seconds)
        uint256 minStakingDuration;
        // Whether quadratic voting is enabled
        bool quadraticEnabled;
        // Challenge period duration (in seconds) after result
        uint256 challengePeriodDuration;
        // Minimum quorum in basis points (e.g. 2000 = 20% of total power)
        uint256 minQuorumBps;
    }

    /// @dev Per-voter staking state.
    struct VoterStakeInfo {
        uint256 firstStakeTimestamp;
        uint256 lastStakeChangeTimestamp;
        uint256 stakedAmount;
    }

    /// @dev Delegation state.
    struct DelegationInfo {
        address delegatee;
        uint256 delegatedPower; // Power delegated to this address
    }

    /// @dev Storage for voting power data.
    struct VotingPowerStorage {
        VotingPowerConfig config;
        mapping(address => VoterStakeInfo) stakeInfo;
        mapping(address => DelegationInfo) delegations;
        mapping(address => uint256) reputationScores; // 0-10000 scale
        mapping(address => bool) technicalCouncilMembers;
        uint256 totalDelegatedPower;
    }

    // -----------------------------------------------------------------------
    // Constants
    // -----------------------------------------------------------------------

    uint256 internal constant BPS_DENOMINATOR = 10000;
    uint256 internal constant REPUTATION_MAX = 10000;
    uint256 internal constant DEFAULT_MAX_POWER = 1000; // Max 1000 power units per wallet
    uint256 internal constant DEFAULT_MIN_STAKING = 30 days;
    uint256 internal constant DEFAULT_CHALLENGE_PERIOD = 3 days;
    uint256 internal constant DEFAULT_MIN_QUORUM = 2000; // 20%

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    event VotingPowerConfigUpdated(
        uint256 balanceWeight,
        uint256 stakingWeight,
        uint256 reputationWeight,
        uint256 maxPower,
        bool quadraticEnabled
    );
    event StakeRecorded(address indexed voter, uint256 amount, uint256 timestamp);
    event DelegationUpdated(address indexed delegator, address indexed delegatee, uint256 power);
    event ReputationUpdated(address indexed voter, uint256 score);
    event TechnicalCouncilUpdated(address indexed member, bool isMember);

    // -----------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------

    error InvalidWeights();
    error InvalidMaxPower();
    error CannotDelegateToSelf();
    error CannotDelegateToFrozen(address delegatee);
    error InvalidReputationScore();
    error ChallengePeriodActive(uint256 remainingTime);

    // -----------------------------------------------------------------------
    // Config management
    // -----------------------------------------------------------------------

    function initConfig(VotingPowerStorage storage vps) internal {
        vps.config = VotingPowerConfig({
            balanceWeightBps: 4000,       // 40% balance
            stakingWeightBps: 3000,        // 30% staking duration
            reputationWeightBps: 3000,    // 30% reputation
            maxVotingPower: DEFAULT_MAX_POWER,
            minStakingDuration: DEFAULT_MIN_STAKING,
            quadraticEnabled: true,
            challengePeriodDuration: DEFAULT_CHALLENGE_PERIOD,
            minQuorumBps: DEFAULT_MIN_QUORUM
        });
    }

    function updateConfig(
        VotingPowerStorage storage vps,
        uint256 balanceWeightBps,
        uint256 stakingWeightBps,
        uint256 reputationWeightBps,
        uint256 maxVotingPower,
        bool quadraticEnabled
    ) internal {
        if (balanceWeightBps + stakingWeightBps + reputationWeightBps != BPS_DENOMINATOR)
            revert InvalidWeights();
        if (maxVotingPower == 0) revert InvalidMaxPower();

        vps.config.balanceWeightBps = balanceWeightBps;
        vps.config.stakingWeightBps = stakingWeightBps;
        vps.config.reputationWeightBps = reputationWeightBps;
        vps.config.maxVotingPower = maxVotingPower;
        vps.config.quadraticEnabled = quadraticEnabled;

        emit VotingPowerConfigUpdated(
            balanceWeightBps, stakingWeightBps, reputationWeightBps, maxVotingPower, quadraticEnabled
        );
    }

    // -----------------------------------------------------------------------
    // Staking
    // -----------------------------------------------------------------------

    function recordStake(
        VotingPowerStorage storage vps,
        address voter,
        uint256 amount
    ) internal {
        VoterStakeInfo storage info = vps.stakeInfo[voter];
        if (info.firstStakeTimestamp == 0) {
            info.firstStakeTimestamp = block.timestamp;
        }
        info.lastStakeChangeTimestamp = block.timestamp;
        info.stakedAmount = amount;
        emit StakeRecorded(voter, amount, block.timestamp);
    }

    // -----------------------------------------------------------------------
    // Delegation
    // -----------------------------------------------------------------------

    function delegate(
        VotingPowerStorage storage vps,
        address delegator,
        address delegatee,
        uint256 power
    ) internal {
        if (delegator == delegatee) revert CannotDelegateToSelf();

        // Remove old delegation
        address oldDelegatee = vps.delegations[delegator].delegatee;
        if (oldDelegatee != address(0)) {
            vps.delegations[oldDelegatee].delegatedPower -= vps.delegations[delegator].delegatedPower;
            vps.totalDelegatedPower -= vps.delegations[delegator].delegatedPower;
        }

        // Set new delegation
        vps.delegations[delegator].delegatee = delegatee;
        vps.delegations[delegator].delegatedPower = power;
        vps.delegations[delegatee].delegatedPower += power;
        vps.totalDelegatedPower += power;

        emit DelegationUpdated(delegator, delegatee, power);
    }

    function clearDelegation(VotingPowerStorage storage vps, address delegator) internal {
        address oldDelegatee = vps.delegations[delegator].delegatee;
        if (oldDelegatee != address(0)) {
            vps.delegations[oldDelegatee].delegatedPower -= vps.delegations[delegator].delegatedPower;
            vps.totalDelegatedPower -= vps.delegations[delegator].delegatedPower;
            delete vps.delegations[delegator];
        }
    }

    function getDelegatee(VotingPowerStorage storage vps, address delegator)
        internal
        view
        returns (address)
    {
        return vps.delegations[delegator].delegatee;
    }

    // -----------------------------------------------------------------------
    // Reputation
    // -----------------------------------------------------------------------

    function setReputation(
        VotingPowerStorage storage vps,
        address voter,
        uint256 score
    ) internal {
        if (score > REPUTATION_MAX) revert InvalidReputationScore();
        vps.reputationScores[voter] = score;
        emit ReputationUpdated(voter, score);
    }

    function getReputation(VotingPowerStorage storage vps, address voter)
        internal
        view
        returns (uint256)
    {
        return vps.reputationScores[voter];
    }

    // -----------------------------------------------------------------------
    // Technical Council
    // -----------------------------------------------------------------------

    function setTechnicalCouncilMember(
        VotingPowerStorage storage vps,
        address member,
        bool isMember
    ) internal {
        vps.technicalCouncilMembers[member] = isMember;
        emit TechnicalCouncilUpdated(member, isMember);
    }

    function isTechnicalCouncilMember(VotingPowerStorage storage vps, address member)
        internal
        view
        returns (bool)
    {
        return vps.technicalCouncilMembers[member];
    }

    // -----------------------------------------------------------------------
    // Voting Power Calculation
    // -----------------------------------------------------------------------

    /// @dev Calculate the voting power for a voter.
    ///      Combines balance, staking duration, and reputation with quadratic
    ///      voting and a maximum cap.
    /// @param vps Voting power storage
    /// @param voter The voter's address
    /// @param tokenBalance The voter's CAS token balance
    /// @return The calculated voting power (capped at maxVotingPower)
    function calculateVotingPower(
        VotingPowerStorage storage vps,
        address voter,
        uint256 tokenBalance
    ) internal
        view
        returns (uint256)
    {
        VotingPowerConfig memory cfg = vps.config;

        // 1. Balance component (normalized to 0-10000 scale)
        uint256 balanceComponent = _normalizeBalance(tokenBalance);

        // 2. Staking duration component
        VoterStakeInfo storage stake = vps.stakeInfo[voter];
        uint256 stakingComponent = _calculateStakingScore(stake, cfg.minStakingDuration);

        // 3. Reputation component
        uint256 reputationComponent = vps.reputationScores[voter];
        if (reputationComponent == 0) {
            // Default reputation based on role
            bool isAgent = DiamondAccessControl.hasRole(DiamondAccessControl.AGENT_ROLE, voter);
            reputationComponent = isAgent ? 5000 : 3000;
        }

        // Weighted sum (each component is 0-10000, weights sum to 10000)
        uint256 rawPower = (
            balanceComponent * cfg.balanceWeightBps +
            stakingComponent * cfg.stakingWeightBps +
            reputationComponent * cfg.reputationWeightBps
        ) / BPS_DENOMINATOR;

        // 4. Quadratic voting: sqrt(rawPower) * scale factor
        if (cfg.quadraticEnabled && rawPower > 0) {
            rawPower = _sqrt(rawPower * 100); // Scale up before sqrt for precision
        }

        // 5. Add delegated power
        rawPower += vps.delegations[voter].delegatedPower;

        // 6. Cap at maximum
        if (rawPower > cfg.maxVotingPower) {
            rawPower = cfg.maxVotingPower;
        }

        return rawPower;
    }

    /// @dev Normalize token balance to 0-10000 scale.
    ///      Uses a logarithmic scale so that more tokens = more power,
    ///      but with diminishing returns.
    function _normalizeBalance(uint256 balance) private pure returns (uint256) {
        if (balance == 0) return 0;
        // Log2-based normalization: 1 token = ~1000, 100 tokens = ~6643, 10000 tokens = ~10000
        // Using a simple linear approximation with cap
        if (balance >= 10000 * 1e18) return 10000;
        if (balance >= 1000 * 1e18) return 8000 + (balance - 1000 * 1e18) * 2000 / (9000 * 1e18);
        if (balance >= 100 * 1e18) return 6000 + (balance - 100 * 1e18) * 2000 / (900 * 1e18);
        if (balance >= 10 * 1e18) return 4000 + (balance - 10 * 1e18) * 2000 / (90 * 1e18);
        return 2000 + balance * 2000 / (10 * 1e18);
    }

    /// @dev Calculate staking score based on how long tokens were held.
    ///      Returns 0-10000 scale.
    function _calculateStakingScore(
        VoterStakeInfo storage stake,
        uint256 minDuration
    ) private view returns (uint256) {
        if (stake.firstStakeTimestamp == 0 || stake.stakedAmount == 0) return 0;

        uint256 duration = block.timestamp - stake.firstStakeTimestamp;
        if (duration >= minDuration) return 10000;

        // Linear ramp up to minDuration
        return (duration * 10000) / minDuration;
    }

    /// @dev Babylonian method for integer square root.
    function _sqrt(uint256 x) private pure returns (uint256) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        uint256 y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
        return y;
    }
}
