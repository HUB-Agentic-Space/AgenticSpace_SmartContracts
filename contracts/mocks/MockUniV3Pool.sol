// SPDX-License-Identifier: MIT
// Author:   Carlos Delfino
// Email:    consultoria@carlosdelfino.eti.br
// WhatsApp: +55 (85) 98520-5490
pragma solidity 0.8.28;

/**
 * @title MockUniV3Pool
 * @dev Mock de pool Uniswap V3 para testes do TWAP CAS/WPOL. `observe`
 *      devolve cumulativos configuráveis: o tick médio da janela é
 *      `cumDelta / secondsAgo`. `revertObserve` simula cardinalidade
 *      insuficiente. NAO use em producao.
 */
contract MockUniV3Pool {
    address public token0;
    address public token1;
    uint128 public liquidity;
    int56 public cumDelta;
    bool public revertObserve;

    constructor(address token0_, address token1_) {
        token0 = token0_;
        token1 = token1_;
    }

    function setLiquidity(uint128 liquidity_) external {
        liquidity = liquidity_;
    }

    function setObserveDelta(int56 delta, bool revert_) external {
        cumDelta = delta;
        revertObserve = revert_;
    }

    function observe(uint32[] calldata)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s)
    {
        require(!revertObserve, "MockUniV3Pool: observe reverted");
        tickCumulatives = new int56[](2);
        tickCumulatives[0] = 0;
        tickCumulatives[1] = cumDelta;
        secondsPerLiquidityCumulativeX128s = new uint160[](2);
    }
}
