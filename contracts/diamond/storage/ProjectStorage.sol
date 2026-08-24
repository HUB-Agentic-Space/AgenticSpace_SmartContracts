// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

/**
 * @title ProjectStorage
 * @dev Diamond Storage namespace for project persistence.
 *      Stores DID, AUID, ownerAddress and publicId of each project.
 *      Projects are entities that group agents and users around a goal.
 *
 *      Padrões: Diamond Storage (EIP-2535)
 */
library ProjectStorage {
    bytes32 internal constant STORAGE_POSITION =
        keccak256("agentic.space.diamond.project.storage");

    // -----------------------------------------------------------------------
    // Data structures
    // -----------------------------------------------------------------------

    struct Project {
        bytes32 projectId;
        string did;
        address ownerAddress;
        string publicId;
        string auid;
        bool isActive;
        uint256 createdAt;
    }

    struct ProjectStorageData {
        mapping(bytes32 => Project) projects;
        mapping(address => bytes32[]) projectsByOwner;
        mapping(string => bytes32) projectByPublicId;
        mapping(bytes32 => bytes32[]) agentsByProject;
        mapping(bytes32 => bytes32[]) usersByProject;
        uint256 projectCount;
        uint256 activeProjectCount;
    }

    // -----------------------------------------------------------------------
    // Access
    // -----------------------------------------------------------------------

    function projectStorage()
        internal
        pure
        returns (ProjectStorageData storage s)
    {
        bytes32 position = STORAGE_POSITION;
        assembly {
            s.slot := position
        }
    }
}
