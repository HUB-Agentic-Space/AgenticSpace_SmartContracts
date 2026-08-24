// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

/**
 * @title DAOStorage
 * @dev Diamond Storage namespace for DAO proposals and voting state.
 *      Shared by RoadMapDAOFacet and AgentDAOFacet, each with its own
 *      proposal counter and mapping namespace via a daoType discriminator.
 *
 *      Padrões: Diamond Storage (EIP-2535), Memento (proposal state)
 */
library DAOStorage {
    bytes32 internal constant STORAGE_POSITION =
        keccak256("agentic.space.diamond.dao.storage");

    // -----------------------------------------------------------------------
    // Data structures
    // -----------------------------------------------------------------------

    enum ProposalState {
        Pending,
        Active,
        Canceled,
        Defeated,
        Succeeded,
        Queued,
        Executed,
        Expired
    }

    struct Proposal {
        uint256 proposalId;
        address proposer;
        uint8 proposalType;
        string title;
        string description;
        bytes data;
        uint256 createdAt;
        uint256 votingDeadline;
        uint256 executedAt;
        ProposalState state;
        uint256 forVotes;
        uint256 againstVotes;
        uint256 abstainVotes;
    }

    /// @dev Each DAO type (RoadMap, Agent) has its own state namespace.
    struct DAONamespace {
        mapping(uint256 => Proposal) proposals;
        mapping(uint256 => mapping(address => bool)) hasVoted;
        mapping(address => uint256) lastProposalAt;
        mapping(address => address) voteDelegation;
        mapping(address => bool) hasDelegated;
        uint256 proposalCount;
        uint256 activeProposalCount;
        uint256 quorumBps;
        uint256 votingDuration;
        uint256 timelockDelay;
        uint256 maxActiveProposals;
        uint256 proposalCooldown;
    }

    struct DAOStorageData {
        mapping(bytes32 => DAONamespace) daos;
    }

    bytes32 internal constant ROADMAP_DAO = keccak256("RoadMapDAO");
    bytes32 internal constant AGENT_DAO = keccak256("AgentDAO");
    bytes32 internal constant COMMUNITY_DAO = keccak256("CommunityDAO");

    // -----------------------------------------------------------------------
    // Access
    // -----------------------------------------------------------------------

    function daoStorage()
        internal
        pure
        returns (DAOStorageData storage s)
    {
        bytes32 position = STORAGE_POSITION;
        assembly {
            s.slot := position
        }
    }

    function roadmapNamespace()
        internal
        view
        returns (DAONamespace storage ns)
    {
        return daoStorage().daos[ROADMAP_DAO];
    }

    function agentNamespace()
        internal
        view
        returns (DAONamespace storage ns)
    {
        return daoStorage().daos[AGENT_DAO];
    }

    function communityNamespace()
        internal
        view
        returns (DAONamespace storage ns)
    {
        return daoStorage().daos[COMMUNITY_DAO];
    }
}
