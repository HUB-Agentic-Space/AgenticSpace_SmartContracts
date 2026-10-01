// SPDX-License-Identifier: MIT
// Author:   Carlos Delfino
// Email:    consultoria@carlosdelfino.eti.br
// WhatsApp: +55 (85) 98520-5490
pragma solidity 0.8.28;

/**
 * @title MockChainlinkFeed
 * @dev Mock de AggregatorV3 (Chainlink) para testes locais do oráculo do
 *      CASSwap. Permite ajustar answer/updatedAt/decimals livremente.
 *      NAO use em producao.
 */
contract MockChainlinkFeed {
    uint8 public decimals;
    int256 public answer;
    uint256 public updatedAt;

    constructor(uint8 decimals_) {
        decimals = decimals_;
    }

    function setAnswer(int256 answer_, uint256 updatedAt_) external {
        answer = answer_;
        updatedAt = updatedAt_;
    }

    function latestRoundData() external view returns (
        uint80 roundId, int256 answer_, uint256 startedAt, uint256 updatedAt_, uint80 answeredInRound
    ) {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}
