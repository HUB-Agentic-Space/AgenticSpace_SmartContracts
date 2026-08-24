// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

/**
 * @title IDiamondLoupe
 * @dev EIP-2535 loupe interface for facet introspection.
 */
interface IDiamondLoupe {
    struct Facet {
        address facetAddress;
        bytes4[] functionSelectors;
    }

    /**
     * @dev Gets all facet addresses and their four byte function selectors.
     * @return facets_ Array of Facet structs.
     */
    function facets() external view returns (Facet[] memory facets_);

    /**
     * @dev Gets all the function selectors supported by a specific facet.
     * @param _facet The facet address.
     * @return facetFunctionSelectors_ Array of function selectors.
     */
    function facetFunctionSelectors(address _facet)
        external
        view
        returns (bytes4[] memory facetFunctionSelectors_);

    /**
     * @dev Get all the facet addresses used by a diamond.
     * @return facetAddresses_ Array of facet addresses.
     */
    function facetAddresses()
        external
        view
        returns (address[] memory facetAddresses_);

    /**
     * @dev Gets the facet that supports the given selector.
     * @param _functionSelector The function selector.
     * @return facetAddress_ The facet address.
     */
    function facetAddress(bytes4 _functionSelector)
        external
        view
        returns (address facetAddress_);
}
