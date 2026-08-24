// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { IDiamondCut } from "../interfaces/IDiamondCut.sol";
import { LibDiamond } from "../libraries/LibDiamond.sol";

/**
 * @title DiamondCutFacet
 * @dev Implements the diamondCut function for adding, replacing and removing
 *      facet function selectors. Only the diamond owner can call this.
 */
contract DiamondCutFacet is IDiamondCut {
    function diamondCut(
        FacetCut[] calldata _diamondCut,
        address _init,
        bytes calldata _calldata
    ) external override {
        LibDiamond.enforceIsContractOwner();
        LibDiamond.diamondCut(_diamondCut, _init, _calldata);
    }
}
