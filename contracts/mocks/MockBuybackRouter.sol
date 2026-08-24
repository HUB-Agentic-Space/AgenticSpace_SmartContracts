// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title MockBuybackRouter
 * @dev Mock DEX router for BuybackBurn tests. Implements swapExactETHForTokens
 *      that returns CAS from its pre-funded balance. NAO use em producao.
 */
contract MockBuybackRouter {
    address public casToken;
    address public wpol;

    constructor(address _casToken, address _wpol) {
        casToken = _casToken;
        wpol = _wpol;
    }

    function swapExactETHForTokens(
        uint256 /* amountOutMin */,
        address[] calldata path,
        address to,
        uint256 /* deadline */
    ) external payable returns (uint256[] memory amounts) {
        require(path.length >= 2, "Invalid path");
        require(path[0] == wpol, "Path must start with WPOL");
        require(path[path.length - 1] == casToken, "Path must end with CAS");

        uint256 casBalance = IERC20(casToken).balanceOf(address(this));
        IERC20(casToken).transfer(to, casBalance);

        amounts = new uint256[](2);
        amounts[0] = msg.value;
        amounts[1] = casBalance;
    }
}
