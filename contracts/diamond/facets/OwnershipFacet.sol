// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { LibDiamond } from "../libraries/LibDiamond.sol";

/**
 * @title OwnershipFacet
 * @dev Ownership management for the Diamond. Provides transferOwnership
 *      and owner queries. Enforces owner-only access.
 */
contract OwnershipFacet {
    function transferOwnership(address _newOwner) external {
        LibDiamond.enforceIsContractOwner();
        address prevOwner = LibDiamond.contractOwner();
        LibDiamond.setContractOwner(_newOwner);
        emit LibDiamond.OwnershipTransferred(prevOwner, _newOwner);
    }

    function owner() external view returns (address) {
        return LibDiamond.contractOwner();
    }
}
