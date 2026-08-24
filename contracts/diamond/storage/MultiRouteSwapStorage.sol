// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { IMultiRouteSwapFacet } from "../interfaces/IMultiRouteSwapFacet.sol";

/**
 * @title MultiRouteSwapStorage
 * @dev Diamond Storage namespace for the MultiRouteSwapFacet.
 *      Stores named route presets and configuration.
 *
 *      Slot: keccak256("agenticspace.multiroute.swap.storage")
 *
 *      Padrões: Diamond Storage (EIP-2535), Memento (state persistence)
 */
library MultiRouteSwapStorage {
    bytes32 internal constant STORAGE_POSITION =
        keccak256("agenticspace.multiroute.swap.storage");

    struct Data {
        // --- Config ---
        address casToken;
        bool initialized;

        // --- Named routes ---
        mapping(string => IMultiRouteSwapFacet.Route) routes;
        string[] routeNames;
        mapping(string => uint256) routeIndex; // 1-indexed, 0 = not found
    }

    function layout() internal pure returns (Data storage s) {
        bytes32 position = STORAGE_POSITION;
        assembly {
            s.slot := position
        }
    }
}
