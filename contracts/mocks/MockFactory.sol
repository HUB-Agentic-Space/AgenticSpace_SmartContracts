// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title MockFactory
 * @dev Mock de factory Uniswap V2 para testes locais.
 *      NAO use em producao.
 */
contract MockFactory {
    mapping(address => mapping(address => address)) public getPair;

    constructor(address tokenA, address tokenB, address pair) {
        getPair[tokenA][tokenB] = pair;
        getPair[tokenB][tokenA] = pair;
    }
}
