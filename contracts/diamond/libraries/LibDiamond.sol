// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { IDiamondCut } from "../interfaces/IDiamondCut.sol";

/**
 * @title LibDiamond
 * @dev Library for Diamond Storage management (EIP-2535).
 *      Provides storage slot, facet mapping, ownership and access control
 *      for the Agentic Space Diamond.
 *
 *      Padrões: Library (Solidity), Registry (facet mapping)
 */
library LibDiamond {
    error NoSelectorsGivenToAdd();
    error NotContractOwner(address _user);
    error NoSelectorsGivenToReplace();
    error NoSelectorsGivenToRemove();
    error ReplaceWithSameFunctionSelectors();
    error RemoveImmutablesFromDiamondNotSupported();
    error CannotRemoveFunctionThatDoesNotExist(bytes4 _selector);
    error CannotAddFunctionToDiamondThatAlreadyExists(bytes4 _selector);
    error CannotAddSelectorsFromZeroAddress();
    error NoCodeForFacet();
    error ContractOwnerCannotBeZeroAddress();

    bytes32 internal constant DIAMOND_STORAGE_POSITION =
        keccak256("agentic.space.diamond.storage");

    // -----------------------------------------------------------------------
    // Storage layout
    // -----------------------------------------------------------------------

    struct FacetAddressAndPosition {
        address facetAddress;
        uint96 functionSelectorPosition;
    }

    struct FacetFunctionSelectors {
        bytes4[] functionSelectors;
        uint256 facetAddressPosition;
    }

    struct DiamondStorage {
        mapping(bytes4 => FacetAddressAndPosition) selectorToFacet;
        mapping(address => FacetFunctionSelectors) facetFunctionSelectors;
        address[] facetAddresses;
        mapping(bytes4 => bool) supportedInterfaces;
        address contractOwner;
        bool paused;
    }

    // -----------------------------------------------------------------------
    // Access
    // -----------------------------------------------------------------------

    function diamondStorage()
        internal
        pure
        returns (DiamondStorage storage ds)
    {
        bytes32 position = DIAMOND_STORAGE_POSITION;
        assembly {
            ds.slot := position
        }
    }

    // -----------------------------------------------------------------------
    // Ownership
    // -----------------------------------------------------------------------

    function setContractOwner(address _newOwner) internal {
        DiamondStorage storage ds = diamondStorage();
        if (_newOwner == address(0)) revert ContractOwnerCannotBeZeroAddress();
        ds.contractOwner = _newOwner;
    }

    function contractOwner() internal view returns (address) {
        return diamondStorage().contractOwner;
    }

    function enforceIsContractOwner() internal view {
        if (msg.sender != diamondStorage().contractOwner) {
            revert NotContractOwner(msg.sender);
        }
    }

    // -----------------------------------------------------------------------
    // Pause
    // -----------------------------------------------------------------------

    function enforceNotPaused() internal view {
        if (diamondStorage().paused) {
            revert EnforcedPause();
        }
    }

    error EnforcedPause();

    function setPaused(bool _paused) internal {
        diamondStorage().paused = _paused;
    }

    function isPaused() internal view returns (bool) {
        return diamondStorage().paused;
    }

    // -----------------------------------------------------------------------
    // Diamond Cut
    // -----------------------------------------------------------------------

    event DiamondCut(
        IDiamondCut.FacetCut[] _diamondCut,
        address _init,
        bytes _calldata
    );

    event OwnershipTransferred(
        address indexed previousOwner,
        address indexed newOwner
    );

    event Paused(address account);
    event Unpaused(address account);

    function diamondCut(
        IDiamondCut.FacetCut[] memory _diamondCut,
        address _init,
        bytes memory _calldata
    ) internal {
        for (uint256 facetIndex = 0; facetIndex < _diamondCut.length; facetIndex++) {
            IDiamondCut.FacetCutAction action = _diamondCut[facetIndex].action;
            if (action == IDiamondCut.FacetCutAction.Add) {
                addFunctions(
                    _diamondCut[facetIndex].facetAddress,
                    _diamondCut[facetIndex].functionSelectors
                );
            } else if (action == IDiamondCut.FacetCutAction.Replace) {
                replaceFunctions(
                    _diamondCut[facetIndex].facetAddress,
                    _diamondCut[facetIndex].functionSelectors
                );
            } else if (action == IDiamondCut.FacetCutAction.Remove) {
                removeFunctions(
                    _diamondCut[facetIndex].facetAddress,
                    _diamondCut[facetIndex].functionSelectors
                );
            } else {
                revert IDiamondCut.IncorrectFacetCutAction(action);
            }
        }
        emit DiamondCut(_diamondCut, _init, _calldata);
        initializeDiamondCut(_init, _calldata);
    }

    function addFunctions(
        address _facetAddress,
        bytes4[] memory _functionSelectors
    ) internal {
        if (_functionSelectors.length == 0) revert NoSelectorsGivenToAdd();
        if (_facetAddress == address(0)) revert CannotAddSelectorsFromZeroAddress();
        DiamondStorage storage ds = diamondStorage();
        uint16 selectorCount = uint16(ds.facetAddresses.length);
        enforceHasContractCode(_facetAddress, "Add: facet has no code");
        for (uint256 selectorIndex = 0; selectorIndex < _functionSelectors.length; selectorIndex++) {
            bytes4 selector = _functionSelectors[selectorIndex];
            address oldFacetAddress = ds.selectorToFacet[selector].facetAddress;
            if (oldFacetAddress != address(0)) {
                revert CannotAddFunctionToDiamondThatAlreadyExists(selector);
            }
            ds.selectorToFacet[selector].facetAddress = _facetAddress;
            ds.selectorToFacet[selector].functionSelectorPosition = uint96(
                ds.facetFunctionSelectors[_facetAddress].functionSelectors.length
            );
            ds.facetFunctionSelectors[_facetAddress].functionSelectors.push(selector);
            if (ds.facetFunctionSelectors[_facetAddress].facetAddressPosition == 0) {
                ds.facetFunctionSelectors[_facetAddress].facetAddressPosition = selectorCount;
                ds.facetAddresses.push(_facetAddress);
                selectorCount++;
            }
        }
    }

    function replaceFunctions(
        address _facetAddress,
        bytes4[] memory _functionSelectors
    ) internal {
        if (_functionSelectors.length == 0) revert NoSelectorsGivenToReplace();
        DiamondStorage storage ds = diamondStorage();
        if (_facetAddress == address(0)) {
            for (uint256 selectorIndex = 0; selectorIndex < _functionSelectors.length; selectorIndex++) {
                bytes4 selector = _functionSelectors[selectorIndex];
                address oldFacetAddress = ds.selectorToFacet[selector].facetAddress;
                if (oldFacetAddress == address(0)) {
                    revert CannotRemoveFunctionThatDoesNotExist(selector);
                }
                if (oldFacetAddress == address(this)) {
                    revert ReplaceWithSameFunctionSelectors();
                }
                // Remove old facet
                removeFunctionFromFacet(selector, oldFacetAddress);
                // Add as immutable
                ds.selectorToFacet[selector].facetAddress = address(this);
                ds.selectorToFacet[selector].functionSelectorPosition = uint96(
                    ds.facetFunctionSelectors[address(this)].functionSelectors.length
                );
                ds.facetFunctionSelectors[address(this)].functionSelectors.push(selector);
                if (ds.facetFunctionSelectors[address(this)].facetAddressPosition == 0) {
                    ds.facetFunctionSelectors[address(this)].facetAddressPosition = ds.facetAddresses.length;
                    ds.facetAddresses.push(address(this));
                }
            }
        } else {
            enforceHasContractCode(_facetAddress, "Replace: facet has no code");
            for (uint256 selectorIndex = 0; selectorIndex < _functionSelectors.length; selectorIndex++) {
                bytes4 selector = _functionSelectors[selectorIndex];
                address oldFacetAddress = ds.selectorToFacet[selector].facetAddress;
                if (oldFacetAddress == _facetAddress) {
                    revert ReplaceWithSameFunctionSelectors();
                }
                if (oldFacetAddress == address(0)) {
                    revert CannotRemoveFunctionThatDoesNotExist(selector);
                }
                removeFunctionFromFacet(selector, oldFacetAddress);
                ds.selectorToFacet[selector].facetAddress = _facetAddress;
                ds.selectorToFacet[selector].functionSelectorPosition = uint96(
                    ds.facetFunctionSelectors[_facetAddress].functionSelectors.length
                );
                ds.facetFunctionSelectors[_facetAddress].functionSelectors.push(selector);
                if (ds.facetFunctionSelectors[_facetAddress].facetAddressPosition == 0) {
                    ds.facetFunctionSelectors[_facetAddress].facetAddressPosition = ds.facetAddresses.length;
                    ds.facetAddresses.push(_facetAddress);
                }
            }
        }
    }

    function removeFunctions(
        address _facetAddress,
        bytes4[] memory _functionSelectors
    ) internal {
        // _facetAddress is accepted per EIP-2535 but not used in removal.
        if (_functionSelectors.length == 0) revert NoSelectorsGivenToRemove();
        DiamondStorage storage ds = diamondStorage();
        for (uint256 selectorIndex = 0; selectorIndex < _functionSelectors.length; selectorIndex++) {
            bytes4 selector = _functionSelectors[selectorIndex];
            address facet = ds.selectorToFacet[selector].facetAddress;
            if (facet == address(0)) {
                revert CannotRemoveFunctionThatDoesNotExist(selector);
            }
            if (facet == address(this)) {
                revert RemoveImmutablesFromDiamondNotSupported();
            }
            removeFunctionFromFacet(selector, facet);
            delete ds.selectorToFacet[selector];
        }
    }

    function removeFunctionFromFacet(bytes4 selector, address facetAddress) internal {
        DiamondStorage storage ds = diamondStorage();
        uint256 selectorPosition = ds.selectorToFacet[selector].functionSelectorPosition;
        uint256 lastSelectorPosition = ds.facetFunctionSelectors[facetAddress].functionSelectors.length - 1;
        if (selectorPosition != lastSelectorPosition) {
            bytes4 lastSelector = ds.facetFunctionSelectors[facetAddress].functionSelectors[lastSelectorPosition];
            ds.facetFunctionSelectors[facetAddress].functionSelectors[selectorPosition] = lastSelector;
            ds.selectorToFacet[lastSelector].functionSelectorPosition = uint96(selectorPosition);
        }
        ds.facetFunctionSelectors[facetAddress].functionSelectors.pop();
        if (ds.facetFunctionSelectors[facetAddress].functionSelectors.length == 0) {
            uint256 lastFacetAddressPosition = ds.facetAddresses.length - 1;
            if (ds.facetFunctionSelectors[facetAddress].facetAddressPosition != lastFacetAddressPosition) {
                address lastFacetAddress = ds.facetAddresses[lastFacetAddressPosition];
                ds.facetAddresses[ds.facetFunctionSelectors[facetAddress].facetAddressPosition] = lastFacetAddress;
                ds.facetFunctionSelectors[lastFacetAddress].facetAddressPosition = ds.facetFunctionSelectors[facetAddress].facetAddressPosition;
            }
            ds.facetAddresses.pop();
            delete ds.facetFunctionSelectors[facetAddress];
        }
    }

    function initializeDiamondCut(address _init, bytes memory _calldata) internal {
        if (_init == address(0) && _calldata.length == 0) {
            return;
        }
        if (_init == address(0) && _calldata.length > 0) {
            revert IDiamondCut.InitAddressZeroButCalldataNotEmpty();
        }
        if (_init != address(0) && _calldata.length == 0) {
            revert IDiamondCut.InitAddressNotZeroButCalldataEmpty();
        }
        enforceHasContractCode(_init, "_init: no code");
        (bool success, bytes memory error) = _init.delegatecall(_calldata);
        if (!success) {
            if (error.length > 0) {
                assembly {
                    revert(add(error, 0x20), mload(error))
                }
            }
            revert IDiamondCut.InitReverted();
        }
    }

    function enforceHasContractCode(address _contract, string memory) internal view {
        uint256 contractSize;
        assembly {
            contractSize := extcodesize(_contract)
        }
        if (contractSize == 0) {
            revert NoCodeForFacet();
        }
    }
}
