// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

/**
 * @title IDiamondCut
 * @dev EIP-2535 interface for adding, replacing and removing facet function selectors.
 */
interface IDiamondCut {
    enum FacetCutAction {
        Add,
        Replace,
        Remove
    }

    struct FacetCut {
        address facetAddress;
        FacetCutAction action;
        bytes4[] functionSelectors;
    }

    event DiamondCut(FacetCut[] _diamondCut, address _init, bytes _calldata);

    error IncorrectFacetCutAction(FacetCutAction action);
    error FunctionAlreadyExists(bytes4 selector);
    error FunctionDoesNotExist(bytes4 selector);
    error FunctionIsImmutable(bytes4 selector);
    error InitAddressZeroButCalldataNotEmpty();
    error InitAddressNotZeroButCalldataEmpty();
    error InitReverted();

    /**
     * @dev Add/replace/remove any number of functions and optionally execute
     *      a function with delegatecall.
     * @param _diamondCut Contains the facet addresses and function selectors.
     * @param _init The address of the contract or facet to execute _calldata.
     * @param _calldata A function call, including function selector that
     *        is executed in delegatecall on _init.
     */
    function diamondCut(
        FacetCut[] calldata _diamondCut,
        address _init,
        bytes calldata _calldata
    ) external;
}
