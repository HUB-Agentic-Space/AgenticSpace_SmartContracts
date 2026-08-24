// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { LibDiamond } from "../diamond/libraries/LibDiamond.sol";
import { DiamondAccessControl } from "../diamond/access/DiamondAccessControl.sol";

/**
 * @title AccessControlFacet
 * @dev Facet for runtime role management in the Diamond.
 *      Allows the contract owner to grant and revoke roles, and anyone
 *      to query role assignments. All role state is persisted in
 *      DiamondAccessControl storage namespace.
 *
 *      Padrões: Diamond Storage (EIP-2535), Command (grant/revoke)
 */
contract AccessControlFacet {
    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender);
    event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender);

    // -----------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------

    error CannotRevokeFromSelf();
    error CannotGrantToZeroAddress();
    error RoleNotAssigned(bytes32 role, address account);

    // -----------------------------------------------------------------------
    // Admin — only owner can grant/revoke
    // -----------------------------------------------------------------------

    function grantRole(bytes32 role, address account) external {
        DiamondAccessControl.enforceIsContractOwner();
        if (account == address(0)) revert CannotGrantToZeroAddress();
        DiamondAccessControl.grantRole(role, account);
        emit RoleGranted(role, account, msg.sender);
    }

    function revokeRole(bytes32 role, address account) external {
        DiamondAccessControl.enforceIsContractOwner();
        if (account == msg.sender) revert CannotRevokeFromSelf();
        DiamondAccessControl.revokeRole(role, account);
        emit RoleRevoked(role, account, msg.sender);
    }

    function renounceRole(bytes32 role) external {
        DiamondAccessControl.revokeRole(role, msg.sender);
        emit RoleRevoked(role, msg.sender, msg.sender);
    }

    // -----------------------------------------------------------------------
    // View
    // -----------------------------------------------------------------------

    function hasRole(bytes32 role, address account) external view returns (bool) {
        return DiamondAccessControl.hasRole(role, account);
    }

    function getRoleMemberCount(bytes32 role) external view returns (uint256) {
        return DiamondAccessControl.getRoleMemberCount(role);
    }

    function getRoleMembers(bytes32 role) external view returns (address[] memory) {
        return DiamondAccessControl.accessStorage().roleMembers[role];
    }

    function getMemberRoles(address account) external view returns (bytes32[] memory) {
        return DiamondAccessControl.accessStorage().memberRoles[account];
    }

    // -----------------------------------------------------------------------
    // Role constants (for convenience)
    // -----------------------------------------------------------------------

    function AGENT_ROLE() external pure returns (bytes32) {
        return DiamondAccessControl.AGENT_ROLE;
    }

    function VALIDATOR_ROLE() external pure returns (bytes32) {
        return DiamondAccessControl.VALIDATOR_ROLE;
    }

    function DAO_PROPOSER_ROLE() external pure returns (bytes32) {
        return DiamondAccessControl.DAO_PROPOSER_ROLE;
    }

    function DAO_VOTER_ROLE() external pure returns (bytes32) {
        return DiamondAccessControl.DAO_VOTER_ROLE;
    }

    function DAO_EXECUTOR_ROLE() external pure returns (bytes32) {
        return DiamondAccessControl.DAO_EXECUTOR_ROLE;
    }

    function DAO_CANCELLER_ROLE() external pure returns (bytes32) {
        return DiamondAccessControl.DAO_CANCELLER_ROLE;
    }

    function PAUSER_ROLE() external pure returns (bytes32) {
        return DiamondAccessControl.PAUSER_ROLE;
    }

    function REGISTRAR_ROLE() external pure returns (bytes32) {
        return DiamondAccessControl.REGISTRAR_ROLE;
    }
}
