// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { IDiamondCut } from "./interfaces/IDiamondCut.sol";
import { IDiamondLoupe } from "./interfaces/IDiamondLoupe.sol";
import { IERC165 } from "./interfaces/IERC165.sol";
import { LibDiamond } from "./libraries/LibDiamond.sol";

/**
 * @title Diamond
 * @dev EIP-2535 Diamond Proxy for the Agentic Space.
 *      Single proxy address delegates calls to pluggable facets.
 *      Facets can be added, replaced, or removed via diamondCut.
 *
 *      Padrões: Proxy (EIP-2535 Diamond), Registry (facet mapping via LibDiamond)
 */
contract Diamond {
    // -----------------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------------

    constructor(
        address _contractOwner,
        IDiamondCut.FacetCut[] memory _diamondCut
    ) {
        if (_contractOwner == address(0)) {
            revert LibDiamond.ContractOwnerCannotBeZeroAddress();
        }

        LibDiamond.setContractOwner(_contractOwner);

        // Register EIP-165, EIP-2535 interfaces
        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        ds.supportedInterfaces[type(IERC165).interfaceId] = true;
        ds.supportedInterfaces[type(IDiamondCut).interfaceId] = true;
        ds.supportedInterfaces[type(IDiamondLoupe).interfaceId] = true;

        // Execute initial diamond cut (adds loupe, ownership, and domain facets)
        LibDiamond.diamondCut(_diamondCut, address(0), "");
    }

    // -----------------------------------------------------------------------
    // Fallback — delegate to facet
    // -----------------------------------------------------------------------

    fallback() external payable {
        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        address facet = ds.selectorToFacet[msg.sig].facetAddress;
        if (facet == address(0)) {
            revert FunctionNotFound(msg.sig);
        }

        assembly {
            calldatacopy(0, 0, calldatasize())
            let result := delegatecall(gas(), facet, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch result
            case 0 {
                revert(0, returndatasize())
            }
            default {
                return(0, returndatasize())
            }
        }
    }

    receive() external payable {}

    error FunctionNotFound(bytes4 selector);
}
