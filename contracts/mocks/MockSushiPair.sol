// SPDX-License-Identifier: MIT
// Author:   Carlos Delfino
// Email:    consultoria@carlosdelfino.eti.br
// WhatsApp: +55 (85) 98520-5490
pragma solidity 0.8.28;

/**
 * @title MockSushiPair
 * @dev Mock de par SushiSwap V2 para testes do TWAP cumulativo CAS/WPOL.
 *      Os cumulativos UQ112.112 são ajustáveis: entre duas leituras, o TWAP é
 *      `cumDelta / elapsed`. NAO use em producao.
 */
contract MockSushiPair {
    address public token0;
    address public token1;
    uint256 public price0CumulativeLast;
    uint256 public price1CumulativeLast;

    constructor(address token0_, address token1_) {
        token0 = token0_;
        token1 = token1_;
    }

    function setCumulatives(uint256 cum0, uint256 cum1) external {
        price0CumulativeLast = cum0;
        price1CumulativeLast = cum1;
    }
}
