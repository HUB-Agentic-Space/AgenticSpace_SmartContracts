// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

/**
 * @title ICASSwapWrapper
 * @dev Interface de wrappers one-call para os pares CAS <-> POL / USDC.
 *      Mesmos princípios do CASSwapUSDCPOLFacet, mas com entradas de conveniência
 *      (swapExactETHForCAS, swapExactUSDCForCAS, etc.).
 */
interface ICASSwapWrapper {
    event WrapperSwapExecuted(
        address indexed user,
        uint8 indexed direction,
        uint256 inputAmount,
        uint256 outputAmount
    );

    // direction: 0 = ETH->CAS, 1 = CAS->ETH, 2 = USDC->CAS, 3 = CAS->USDC
    function swapExactETHForCAS(uint256 minCasOut, uint256 deadline)
        external
        payable
        returns (uint256 casOut);

    function swapExactUSDCForCAS(uint256 usdcAmount, uint256 minCasOut, uint256 deadline)
        external
        returns (uint256 casOut);

    function swapExactCASForETH(uint256 casAmount, uint256 minEthOut, uint256 deadline)
        external
        returns (uint256 ethOut);

    function swapExactCASForUSDC(uint256 casAmount, uint256 minUsdcOut, uint256 deadline)
        external
        returns (uint256 usdcOut);
}
