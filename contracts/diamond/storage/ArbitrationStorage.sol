// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { VotingPowerLib } from "../../libs/VotingPowerLib.sol";

/**
 * @title ArbitrationStorage
 * @dev Diamond Storage namespace for arbitration cases and voting state.
 *      Used by ArbitrationFacet for fraud dispute resolution.
 *
 *      Padrões: Diamond Storage (EIP-2535), Memento (case state)
 */
library ArbitrationStorage {
    bytes32 internal constant STORAGE_POSITION =
        keccak256("agentic.space.diamond.arbitration.storage");

    enum CaseState {
        Pending,
        Active,
        Executed,
        Canceled,
        Expired,
        RetryPending,
        RevotePending,
        Challenged
    }

    enum FreezeType {
        Limited,
        Temporary,
        Permanent
    }

    /// @dev 4 voting periods: Disclosure, Voting, Result, Challenge
    ///      Disclosure: everyone can operate except suspects
    ///      Voting: CAS transfers locked to prevent vote buying
    ///      Result: operations resume with decision applied
    ///      Challenge: contestation period where result can be disputed
    enum VotingPeriod {
        Disclosure,
        Voting,
        Result,
        Challenge
    }

    struct ArbitrationCase {
        uint256 caseId;
        address filer;
        address[] accused;
        string[] reasons;
        bytes32 evidenceHash;
        FreezeType freezeType;
        uint256 freezeUntilTime;
        uint256 createdAt;
        uint256 disclosureDeadline;
        uint256 votingDeadline;
        uint256 executedAt;
        CaseState state;
        VotingPeriod votingPeriod;
        uint256 forVotes;       // Weighted: for
        uint256 againstVotes;   // Weighted: against
        uint256 abstainVotes;   // Weighted: abstain
        uint256 totalPowerCast;  // Sum of all voting power cast
        uint256 retryCount;
        uint256 revoteCount;
        uint256 challengeDeadline;
        address challenger;
        bool technicalCouncilVeto;
    }

    struct ArbitrationStorageData {
        mapping(uint256 => ArbitrationCase) cases;
        mapping(uint256 => mapping(address => uint256)) hasVotedRound;
        mapping(uint256 => mapping(address => uint256)) votedPower;
        mapping(address => bool) frozenByArbitration;
        uint256 caseCount;
        uint256 quorumBps;
        uint256 votingDuration;
        uint256 disclosureDuration;
        uint256 timelockDelay;
        address casToken;
        uint256 maxRetries;
        uint256 retryFreezeDuration;
        uint256 maxRevotes;
        bool votingLockActive;
        // Voting power system
        VotingPowerLib.VotingPowerStorage votingPower;
        // Appeal system
        mapping(uint256 => uint256) appealCount;
        uint256 maxAppeals;
    }

    function arbitrationStorage()
        internal
        pure
        returns (ArbitrationStorageData storage s)
    {
        bytes32 position = STORAGE_POSITION;
        assembly {
            s.slot := position
        }
    }
}
