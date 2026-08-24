// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { MockPair } from "./MockPair.sol";

/**
 * @title MockDEXRouter
 * @dev Mock de router Uniswap V2 para testes locais.
 *      NAO use em producao.
 */
contract MockDEXRouter {
    address public factory;
    address public tokenA;
    address public tokenB;
    address public pair;

    constructor(address _factory, address _tokenA, address _tokenB, address _pair) {
        factory = _factory;
        tokenA = _tokenA;
        tokenB = _tokenB;
        pair = _pair;
    }

    function addLiquidity(
        address _tokenA,
        address _tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256,
        uint256,
        address to,
        uint256 deadline
    ) external returns (uint256 amountA, uint256 amountB, uint256 liquidity) {
        require(block.timestamp <= deadline, "Expired");
        require(
            (_tokenA == tokenA && _tokenB == tokenB) || (_tokenA == tokenB && _tokenB == tokenA),
            "Invalid pair"
        );

        IERC20(_tokenA).transferFrom(msg.sender, address(this), amountADesired);
        IERC20(_tokenB).transferFrom(msg.sender, address(this), amountBDesired);

        uint256 lpAmount = amountADesired + amountBDesired;
        MockPair(pair).mint(to, lpAmount);

        return (amountADesired, amountBDesired, lpAmount);
    }
}
