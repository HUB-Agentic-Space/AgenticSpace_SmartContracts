// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { IDiamondLoupe } from "../interfaces/IDiamondLoupe.sol";
import { IERC165 } from "../interfaces/IERC165.sol";
import { LibDiamond } from "../libraries/LibDiamond.sol";

/**
 * @title DiamondLoupeFacet
 * @dev Implements EIP-2535 loupe functions for facet introspection
 *      and EIP-165 supportsInterface.
 */
contract DiamondLoupeFacet is IDiamondLoupe, IERC165 {
    function facets() external view override returns (Facet[] memory facets_) {
        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        uint256 numFacets = ds.facetAddresses.length;
        facets_ = new Facet[](numFacets);
        for (uint256 i = 0; i < numFacets; i++) {
            address addr = ds.facetAddresses[i];
            facets_[i].facetAddress = addr;
            facets_[i].functionSelectors = ds
                .facetFunctionSelectors[addr]
                .functionSelectors;
        }
    }

    function facetFunctionSelectors(address _facet)
        external
        view
        override
        returns (bytes4[] memory facetFunctionSelectors_)
    {
        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        facetFunctionSelectors_ = ds.facetFunctionSelectors[_facet].functionSelectors;
    }

    function facetAddresses()
        external
        view
        override
        returns (address[] memory facetAddresses_)
    {
        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        facetAddresses_ = ds.facetAddresses;
    }

    function facetAddress(bytes4 _functionSelector)
        external
        view
        override
        returns (address facetAddress_)
    {
        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        facetAddress_ = ds.selectorToFacet[_functionSelector].facetAddress;
    }

    function supportsInterface(bytes4 _interfaceId)
        external
        view
        override
        returns (bool)
    {
        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        return ds.supportedInterfaces[_interfaceId];
    }
}
