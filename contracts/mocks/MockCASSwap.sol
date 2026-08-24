// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title MockCASSwap
 * @dev Mock do CASSwap para testes locais. Permite definir a ratio CAS/POL.
 *      NAO use em producao.
 */
contract MockCASSwap is Ownable {
    uint256 public ratioNumerator;
    uint256 public ratioDenominator;

    constructor(address admin, uint256 numerator, uint256 denominator) Ownable(admin) {
        require(numerator > 0 && denominator > 0, "Invalid ratio");
        ratioNumerator = numerator;
        ratioDenominator = denominator;
    }

    function setRatio(uint256 numerator, uint256 denominator) external onlyOwner {
        require(numerator > 0 && denominator > 0, "Invalid ratio");
        ratioNumerator = numerator;
        ratioDenominator = denominator;
    }

    function getRatio() external view returns (uint256 numerator, uint256 denominator) {
        return (ratioNumerator, ratioDenominator);
    }
}
