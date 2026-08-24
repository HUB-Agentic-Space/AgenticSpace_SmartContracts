// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { LibDiamond } from "../diamond/libraries/LibDiamond.sol";
import { DiamondAccessControl } from "../diamond/access/DiamondAccessControl.sol";

/**
 * @title PausableFacet
 * @dev Facet for pausing and unpausing the Diamond.
 *      Uses LibDiamond's pause state. All domain facets call
 *      LibDiamond.enforceNotPaused() to respect this.
 */
contract PausableFacet {
    event Paused(address account);
    event Unpaused(address account);

    function pause() external {
        DiamondAccessControl.enforceRoleOrOwner(DiamondAccessControl.PAUSER_ROLE);
        LibDiamond.setPaused(true);
        emit Paused(msg.sender);
    }

    function unpause() external {
        DiamondAccessControl.enforceRoleOrOwner(DiamondAccessControl.PAUSER_ROLE);
        LibDiamond.setPaused(false);
        emit Unpaused(msg.sender);
    }

    function isPaused() external view returns (bool) {
        return LibDiamond.isPaused();
    }
}
