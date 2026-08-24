// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

/**
 * @title IMultiRouteSwapFacet
 * @dev Interface for atomic multi-hop swaps across different DEX routers
 *      with intermediate tokens. Enables routes like:
 *      CAS → WETH (Dfyn) → WPOL (QuickSwap) → CAS (ApeSwap)
 *
 *      Padrões: Interface (Gang of Four), Strategy (route selection)
 */
interface IMultiRouteSwapFacet {
    /// @notice A single hop in a multi-route swap
    struct Hop {
        address router;       // DEX V2 router address
        address[] path;       // token path for this hop (e.g. [CAS, WETH])
        bool useNativeIn;     // if true, send native POL with the call
        bool useNativeOut;    // if true, expect native POL back (swapTokensForETH)
        uint256 amountIn;     // amount of input token (0 if useNativeIn, uses msg.value)
    }

    /// @notice A named route preset (stored on-chain for reuse)
    struct Route {
        Hop[] hops;
        string name;
        bool active;
    }

    event MultiRouteExecuted(
        address indexed caller,
        string routeName,
        uint256 totalAmountIn,
        uint256 totalAmountOut,
        bytes32 txHash
    );

    event RouteAdded(string name, uint256 hopCount);
    event RouteRemoved(string name);
    event RouteToggled(string name, bool active);

    error RouteNotFound(string name);
    error RouteNotActive(string name);
    error RouteHasNoHops();
    error ZeroAddress(string param);
    error InvalidPath();
    error SwapFailed(uint256 hopIndex, string reason);
    error InsufficientOutput(uint256 expected, uint256 received);
    error NotAuthorized();

    /**
     * @notice Execute a multi-hop swap atomically using a stored route preset.
     * @param routeName  Name of the stored route to execute.
     * @param minAmountOut Minimum final output amount (slippage protection).
     * @return finalAmountOut The amount of the final output token received.
     */
    function executeRoute(string calldata routeName, uint256 minAmountOut)
        external
        payable
        returns (uint256 finalAmountOut);

    /**
     * @notice Execute a multi-hop swap atomically with inline hops.
     * @param hops       Array of hops to execute in sequence.
     * @param minAmountOut Minimum final output amount (slippage protection).
     * @return finalAmountOut The amount of the final output token received.
     */
    function executeHops(Hop[] calldata hops, uint256 minAmountOut)
        external
        payable
        returns (uint256 finalAmountOut);

    /**
     * @notice Add or replace a named route preset.
     * @param name  Route name (e.g. "dfyn_to_apeswap").
     * @param hops  Array of hops for this route.
     */
    function addRoute(string calldata name, Hop[] calldata hops) external;

    /**
     * @notice Remove a named route preset.
     * @param name  Route name to remove.
     */
    function removeRoute(string calldata name) external;

    /**
     * @notice Enable or disable a route without removing it.
     * @param name    Route name.
     * @param active  New active state.
     */
    function setRouteActive(string calldata name, bool active) external;

    /**
     * @notice Get a stored route by name.
     * @param name  Route name.
     * @return route The stored route struct.
     */
    function getRoute(string calldata name) external view returns (Route memory route);

    /**
     * @notice List all stored route names.
     * @return names Array of route names.
     */
    function listRoutes() external view returns (string[] memory names);

    /**
     * @notice Initialize the facet with the CAS token address.
     * @param casToken  Address of the CAS ERC-20 token.
     */
    function initMultiRouteSwap(address casToken) external;
}
