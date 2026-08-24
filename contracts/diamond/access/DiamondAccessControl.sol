// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { LibDiamond } from "../libraries/LibDiamond.sol";

/**
 * @title DiamondAccessControl
 * @dev Role-based access control for Diamond facets using Diamond Storage.
 *      Extends LibDiamond ownership with role management stored in a
 *      dedicated storage namespace. Pluggable and low-coupling: facets
 *      only need to call the modifiers, not know about the storage layout.
 *
 *      Padrões: Strategy (roles), Template (abstract base for facets)
 */
library DiamondAccessControl {
    bytes32 internal constant STORAGE_POSITION =
        keccak256("agentic.space.diamond.access.storage");

    // -----------------------------------------------------------------------
    // Roles
    // -----------------------------------------------------------------------

    bytes32 internal constant USER_ROLE = keccak256("USER_ROLE");
    bytes32 internal constant AGENT_ROLE = keccak256("AGENT_ROLE");
    bytes32 internal constant VALIDATOR_ROLE = keccak256("VALIDATOR_ROLE");
    bytes32 internal constant DAO_PROPOSER_ROLE = keccak256("DAO_PROPOSER_ROLE");
    bytes32 internal constant DAO_VOTER_ROLE = keccak256("DAO_VOTER_ROLE");
    bytes32 internal constant DAO_EXECUTOR_ROLE = keccak256("DAO_EXECUTOR_ROLE");
    bytes32 internal constant DAO_CANCELLER_ROLE = keccak256("DAO_CANCELLER_ROLE");
    bytes32 internal constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 internal constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");

    // -----------------------------------------------------------------------
    // Storage
    // -----------------------------------------------------------------------

    struct AccessStorageData {
        mapping(bytes32 => mapping(address => bool)) roles;
        mapping(bytes32 => address[]) roleMembers;
        mapping(address => bytes32[]) memberRoles;
    }

    function accessStorage()
        internal
        pure
        returns (AccessStorageData storage s)
    {
        bytes32 position = STORAGE_POSITION;
        assembly {
            s.slot := position
        }
    }

    // -----------------------------------------------------------------------
    // Modifiers (as internal functions for use in facets)
    // -----------------------------------------------------------------------

    error MissingRole(bytes32 role, address account);

    function enforceRole(bytes32 role) internal view {
        if (!accessStorage().roles[role][msg.sender]) {
            if (msg.sender != LibDiamond.contractOwner()) {
                revert MissingRole(role, msg.sender);
            }
        }
    }

    function enforceRoleOrOwner(bytes32 role) internal view {
        if (!accessStorage().roles[role][msg.sender] &&
            msg.sender != LibDiamond.contractOwner()) {
            revert MissingRole(role, msg.sender);
        }
    }

    function enforceIsContractOwner() internal view {
        LibDiamond.enforceIsContractOwner();
    }

    function enforceNotPaused() internal view {
        LibDiamond.enforceNotPaused();
    }

    // -----------------------------------------------------------------------
    // Role management
    // -----------------------------------------------------------------------

    event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender);
    event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender);

    function grantRole(bytes32 role, address account) internal {
        AccessStorageData storage s = accessStorage();
        if (!s.roles[role][account]) {
            s.roles[role][account] = true;
            s.roleMembers[role].push(account);
            s.memberRoles[account].push(role);
            emit RoleGranted(role, account, msg.sender);
        }
    }

    function revokeRole(bytes32 role, address account) internal {
        AccessStorageData storage s = accessStorage();
        if (s.roles[role][account]) {
            s.roles[role][account] = false;
            emit RoleRevoked(role, account, msg.sender);
        }
    }

    function hasRole(bytes32 role, address account) internal view returns (bool) {
        return accessStorage().roles[role][account];
    }

    function getRoleMemberCount(bytes32 role) internal view returns (uint256) {
        return accessStorage().roleMembers[role].length;
    }
}
