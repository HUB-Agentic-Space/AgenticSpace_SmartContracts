// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuardTransient } from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import { LibDiamond } from "../libraries/LibDiamond.sol";
import { MultiRouteSwapStorage } from "../storage/MultiRouteSwapStorage.sol";
import { IMultiRouteSwapFacet } from "../interfaces/IMultiRouteSwapFacet.sol";

/**
 * @title IV2RouterMinimal
 * @dev Minimal V2 DEX router interface for multi-route swaps.
 */
interface IV2RouterMinimal {
    function swapExactETHForTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable returns (uint256[] memory amounts);

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);

    function swapExactTokensForETH(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

/**
 * @title MultiRouteSwapFacet
 * @dev EIP-2535 Diamond facet for atomic multi-hop swaps across different
 *      DEX V2 routers with intermediate tokens.
 *
 *      Enables routes like:
 *        CAS → WETH (Dfyn router) → WPOL (QuickSwap router) → CAS (ApeSwap router)
 *
 *      All hops execute in a single transaction (atomic). If any hop fails,
 *      the entire operation reverts.
 *
 *      Security:
 *        - Owner-only route management (LibDiamond.enforceIsContractOwner)
 *        - Reentrancy guard on execute functions
 *        - SafeERC20 for all token transfers
 *        - Slippage protection via minAmountOut
 *        - No arbitrary external calls — only to known V2 router interfaces
 *
 *      Padrões: Strategy (route selection), Facade (multi-router orchestration),
 *               Diamond Facet (EIP-2535)
 */
contract MultiRouteSwapFacet is
    IMultiRouteSwapFacet,
    ReentrancyGuardTransient
{
    using SafeERC20 for IERC20;

    // -----------------------------------------------------------------------
    // Initialization
    // -----------------------------------------------------------------------

    function initMultiRouteSwap(address casToken) external {
        LibDiamond.enforceIsContractOwner();
        MultiRouteSwapStorage.Data storage s = MultiRouteSwapStorage.layout();

        if (casToken == address(0)) revert ZeroAddress("casToken");
        if (s.initialized) revert("Already initialized");

        s.casToken = casToken;
        s.initialized = true;
    }

    // -----------------------------------------------------------------------
    // Route management (owner only)
    // -----------------------------------------------------------------------

    function addRoute(string calldata name, Hop[] calldata hops) external {
        LibDiamond.enforceIsContractOwner();
        if (hops.length == 0) revert RouteHasNoHops();
        if (bytes(name).length == 0) revert ZeroAddress("name");

        MultiRouteSwapStorage.Data storage s = MultiRouteSwapStorage.layout();

        // Validate hops
        for (uint256 i = 0; i < hops.length; i++) {
            if (hops[i].router == address(0)) revert ZeroAddress("router");
            if (hops[i].path.length < 2) revert InvalidPath();
        }

        // Store route
        IMultiRouteSwapFacet.Route storage route = s.routes[name];
        if (route.hops.length == 0) {
            // New route
            s.routeNames.push(name);
            s.routeIndex[name] = s.routeNames.length; // 1-indexed
        }
        // Clear existing hops
        delete route.hops;
        // Copy new hops
        for (uint256 i = 0; i < hops.length; i++) {
            route.hops.push(hops[i]);
        }
        route.name = name;
        route.active = true;

        emit RouteAdded(name, hops.length);
    }

    function removeRoute(string calldata name) external {
        LibDiamond.enforceIsContractOwner();
        MultiRouteSwapStorage.Data storage s = MultiRouteSwapStorage.layout();

        uint256 idx = s.routeIndex[name];
        if (idx == 0) revert RouteNotFound(name);

        // Swap-and-pop from routeNames
        uint256 lastIdx = s.routeNames.length;
        if (idx != lastIdx) {
            string memory lastName = s.routeNames[lastIdx - 1];
            s.routeNames[idx - 1] = lastName;
            s.routeIndex[lastName] = idx;
        }
        s.routeNames.pop();
        delete s.routeIndex[name];
        delete s.routes[name];

        emit RouteRemoved(name);
    }

    function setRouteActive(string calldata name, bool active) external {
        LibDiamond.enforceIsContractOwner();
        MultiRouteSwapStorage.Data storage s = MultiRouteSwapStorage.layout();

        if (s.routeIndex[name] == 0) revert RouteNotFound(name);
        s.routes[name].active = active;

        emit RouteToggled(name, active);
    }

    // -----------------------------------------------------------------------
    // View functions
    // -----------------------------------------------------------------------

    function getRoute(string calldata name) external view returns (Route memory route) {
        MultiRouteSwapStorage.Data storage s = MultiRouteSwapStorage.layout();
        if (s.routeIndex[name] == 0) revert RouteNotFound(name);
        return s.routes[name];
    }

    function listRoutes() external view returns (string[] memory names) {
        return MultiRouteSwapStorage.layout().routeNames;
    }

    // -----------------------------------------------------------------------
    // Execution
    // -----------------------------------------------------------------------

    function executeRoute(string calldata routeName, uint256 minAmountOut)
        external
        payable
        nonReentrant
        returns (uint256 finalAmountOut)
    {
        MultiRouteSwapStorage.Data storage s = MultiRouteSwapStorage.layout();

        if (s.routeIndex[routeName] == 0) revert RouteNotFound(routeName);
        Route storage route = s.routes[routeName];
        if (!route.active) revert RouteNotActive(routeName);

        // Copy hops to memory for execution
        Hop[] memory hopsMem = new Hop[](route.hops.length);
        for (uint256 i = 0; i < route.hops.length; i++) {
            hopsMem[i] = route.hops[i];
        }

        finalAmountOut = _executeHops(hopsMem, minAmountOut);

        emit MultiRouteExecuted(
            msg.sender,
            routeName,
            msg.value,
            finalAmountOut,
            blockhash(block.number - 1)
        );
    }

    function executeHops(Hop[] calldata hops, uint256 minAmountOut)
        external
        payable
        nonReentrant
        returns (uint256 finalAmountOut)
    {
        finalAmountOut = _executeHops(hops, minAmountOut);

        emit MultiRouteExecuted(
            msg.sender,
            "inline",
            msg.value,
            finalAmountOut,
            blockhash(block.number - 1)
        );
    }

    // -----------------------------------------------------------------------
    // Internal: execute hops sequentially
    // -----------------------------------------------------------------------

    function _executeHops(Hop[] memory hops, uint256 minAmountOut)
        internal
        returns (uint256 finalAmountOut)
    {
        if (hops.length == 0) revert RouteHasNoHops();

        uint256 currentAmount = 0;
        address currentToken = hops[0].path[0];
        uint256 deadline = block.timestamp + 600;

        for (uint256 i = 0; i < hops.length; i++) {
            Hop memory hop = hops[i];

            // Determine input amount
            if (hop.useNativeIn) {
                currentAmount = msg.value;
            } else if (i == 0) {
                // First hop: pull tokens from caller
                currentAmount = hop.amountIn;
                if (currentAmount == 0) revert InvalidPath();
                IERC20(hop.path[0]).safeTransferFrom(
                    msg.sender,
                    address(this),
                    currentAmount
                );
            } else {
                // Subsequent hop: use output from previous
                currentAmount = finalAmountOut;
            }

            // Approve router for the input token (if not native)
            if (!hop.useNativeIn) {
                IERC20(hop.path[0]).forceApprove(hop.router, currentAmount);
            }

            // Execute swap
            uint256 amountOut;
            if (hop.useNativeIn) {
                // swapExactETHForTokens
                uint256[] memory amounts = IV2RouterMinimal(hop.router)
                    .swapExactETHForTokens{ value: currentAmount }(
                        0,
                        hop.path,
                        address(this),
                        deadline
                    );
                amountOut = amounts[amounts.length - 1];
            } else if (hop.useNativeOut) {
                // swapExactTokensForETH
                uint256[] memory amounts = IV2RouterMinimal(hop.router)
                    .swapExactTokensForETH(
                        currentAmount,
                        0,
                        hop.path,
                        address(this),
                        deadline
                    );
                amountOut = amounts[amounts.length - 1];
            } else {
                // swapExactTokensForTokens
                uint256[] memory amounts = IV2RouterMinimal(hop.router)
                    .swapExactTokensForTokens(
                        currentAmount,
                        0,
                        hop.path,
                        address(this),
                        deadline
                    );
                amountOut = amounts[amounts.length - 1];
            }

            finalAmountOut = amountOut;
            currentToken = hop.path[hop.path.length - 1];

            // Reset approval to zero (security)
            if (!hop.useNativeIn) {
                IERC20(hop.path[0]).forceApprove(hop.router, 0);
            }
        }

        // Slippage check
        if (finalAmountOut < minAmountOut) {
            revert InsufficientOutput(minAmountOut, finalAmountOut);
        }

        // Transfer final output to caller
        if (hops[hops.length - 1].useNativeOut) {
            // Native POL
            (bool ok, ) = msg.sender.call{ value: finalAmountOut }("");
            if (!ok) revert("POL transfer failed");
        } else {
            // ERC-20 token
            IERC20(currentToken).safeTransfer(msg.sender, finalAmountOut);
        }

        // Refund any excess native POL
        uint256 remaining = address(this).balance;
        if (remaining > 0) {
            (bool ok, ) = msg.sender.call{ value: remaining }("");
            if (!ok) revert("POL refund failed");
        }
    }

    // -----------------------------------------------------------------------
    // Receive — accept native POL for swaps
    // -----------------------------------------------------------------------

    receive() external payable {}
}
