// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title MockV2Router
 * @dev Mock Uniswap V2-style router for testing MultiRouteSwapFacet.
 *      Simulates swaps by transferring tokens at a fixed 1:1 ratio.
 *      DO NOT use in production.
 */
contract MockV2Router {
    function swapExactETHForTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable returns (uint256[] memory amounts) {
        require(path.length >= 2, "Invalid path");
        require(msg.value > 0, "No POL sent");

        amounts = new uint256[](path.length);
        amounts[0] = msg.value;
        amounts[amounts.length - 1] = msg.value;

        // Mint output tokens to recipient (simulates swap)
        // In real tests, the mock would hold tokens and transfer them
        // For simplicity, we assume the mock has been funded
        IERC20 outputToken = IERC20(path[path.length - 1]);
        uint256 balance = outputToken.balanceOf(address(this));
        require(balance >= msg.value, "Mock router: insufficient output");

        outputToken.transfer(to, msg.value);
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts) {
        require(path.length >= 2, "Invalid path");
        require(amountIn > 0, "Zero input");

        // Transfer input from caller
        IERC20 inputToken = IERC20(path[0]);
        inputToken.transferFrom(msg.sender, address(this), amountIn);

        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        amounts[amounts.length - 1] = amountIn;

        // Transfer output to recipient (1:1 ratio)
        IERC20 outputToken = IERC20(path[path.length - 1]);
        uint256 balance = outputToken.balanceOf(address(this));
        require(balance >= amountIn, "Mock router: insufficient output");

        outputToken.transfer(to, amountIn);
    }

    function swapExactTokensForETH(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts) {
        require(path.length >= 2, "Invalid path");
        require(amountIn > 0, "Zero input");

        // Transfer input from caller
        IERC20 inputToken = IERC20(path[0]);
        inputToken.transferFrom(msg.sender, address(this), amountIn);

        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        amounts[amounts.length - 1] = amountIn;

        // Send POL to recipient
        require(address(this).balance >= amountIn, "Mock router: insufficient POL");
        (bool ok, ) = to.call{ value: amountIn }("");
        require(ok, "POL transfer failed");
    }

    // Fund the mock router with tokens and POL for testing
    receive() external payable {}
}
