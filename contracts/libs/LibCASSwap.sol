// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { CASSwapStorage } from "../diamond/storage/CASSwapStorage.sol";

/**
 * @title LibCASSwap
 * @dev Núcleo de cálculo e transferência dos swaps CAS <-> USDC / POL.
 *      Compartilhado entre CASSwapUSDCPOLFacet e CASSwapWrapperFacet para
 *      evitar duplicação de lógica. Todas as funções são `internal`, logo
 *      executam no contexto do Diamond (address(this) == Diamond).
 *
 *      Ratio semantics: `num/den` = CAS (base units) por 1 base unit da moeda
 *      de cotação. Decimais (CAS=18, POL=18, USDC=6) são codificados em num/den
 *      pelo backend. O contrato é apenas o instrumento.
 *
 *      Padrões: Library (Solidity), Strategy (ratio ajustável).
 */
library LibCASSwap {
    using SafeERC20 for IERC20;

    uint256 internal constant BPS_DENOMINATOR = 10000;

    error ZeroAmount();
    error InvalidRatio();
    error InsufficientCASBalance(uint256 available, uint256 required);
    error InsufficientPOLBalance(uint256 available, uint256 required);
    error InsufficientUSDCBalance(uint256 available, uint256 required);
    error SlippageExceeded(uint256 minExpected, uint256 actual);
    error POLTransferFailed();

    // -----------------------------------------------------------------------
    // Buy CAS with POL (POL já recebido via msg.value pela função de entrada)
    // -----------------------------------------------------------------------

    function buyWithPol(
        CASSwapStorage.Data storage s,
        uint256 polIn,
        uint256 minCasOut,
        address to
    ) internal returns (uint256 casOut, uint256 fee) {
        if (polIn == 0) revert ZeroAmount();
        if (s.ratioPolNum == 0 || s.ratioPolDen == 0) revert InvalidRatio();

        fee = (polIn * s.swapFeeBps) / BPS_DENOMINATOR;
        uint256 net = polIn - fee;
        casOut = (net * s.ratioPolNum) / s.ratioPolDen;
        if (casOut == 0) revert ZeroAmount();
        if (casOut < minCasOut) revert SlippageExceeded(minCasOut, casOut);

        uint256 casBal = s.casToken.balanceOf(address(this));
        if (casBal < casOut) revert InsufficientCASBalance(casBal, casOut);

        s.casToken.safeTransfer(to, casOut);
    }

    // -----------------------------------------------------------------------
    // Sell CAS for POL
    // -----------------------------------------------------------------------

    function sellForPol(
        CASSwapStorage.Data storage s,
        address from,
        uint256 casIn,
        uint256 minPolOut,
        address to
    ) internal returns (uint256 polOut, uint256 fee) {
        if (casIn == 0) revert ZeroAmount();
        // Use sell ratio if set, otherwise fall back to buy ratio (legacy compat)
        uint256 sellNum = s.ratioPolSellNum != 0 ? s.ratioPolSellNum : s.ratioPolNum;
        uint256 sellDen = s.ratioPolSellDen != 0 ? s.ratioPolSellDen : s.ratioPolDen;
        if (sellNum == 0 || sellDen == 0) revert InvalidRatio();

        uint256 polEq = (casIn * sellDen) / sellNum;
        if (polEq == 0) revert ZeroAmount();
        fee = (polEq * s.swapFeeBps) / BPS_DENOMINATOR;
        polOut = polEq - fee;
        if (polOut < minPolOut) revert SlippageExceeded(minPolOut, polOut);

        uint256 polBal = address(this).balance;
        if (polBal < polOut) revert InsufficientPOLBalance(polBal, polOut);

        // CEI: pull CAS in (effects on token), then send POL out
        s.casToken.safeTransferFrom(from, address(this), casIn);
        (bool ok, ) = payable(to).call{ value: polOut }("");
        if (!ok) revert POLTransferFailed();
    }

    // -----------------------------------------------------------------------
    // Buy CAS with USDC
    // -----------------------------------------------------------------------

    function buyWithUsdc(
        CASSwapStorage.Data storage s,
        address from,
        uint256 usdcIn,
        uint256 minCasOut,
        address to
    ) internal returns (uint256 casOut, uint256 fee) {
        if (usdcIn == 0) revert ZeroAmount();
        if (s.ratioUsdcNum == 0 || s.ratioUsdcDen == 0) revert InvalidRatio();

        fee = (usdcIn * s.swapFeeBps) / BPS_DENOMINATOR;
        uint256 net = usdcIn - fee;
        casOut = (net * s.ratioUsdcNum) / s.ratioUsdcDen;
        if (casOut == 0) revert ZeroAmount();
        if (casOut < minCasOut) revert SlippageExceeded(minCasOut, casOut);

        uint256 casBal = s.casToken.balanceOf(address(this));
        if (casBal < casOut) revert InsufficientCASBalance(casBal, casOut);

        s.usdcToken.safeTransferFrom(from, address(this), usdcIn);
        s.casToken.safeTransfer(to, casOut);
    }

    // -----------------------------------------------------------------------
    // Sell CAS for USDC
    // -----------------------------------------------------------------------

    function sellForUsdc(
        CASSwapStorage.Data storage s,
        address from,
        uint256 casIn,
        uint256 minUsdcOut,
        address to
    ) internal returns (uint256 usdcOut, uint256 fee) {
        if (casIn == 0) revert ZeroAmount();
        // Use sell ratio if set, otherwise fall back to buy ratio (legacy compat)
        uint256 sellNum = s.ratioUsdcSellNum != 0 ? s.ratioUsdcSellNum : s.ratioUsdcNum;
        uint256 sellDen = s.ratioUsdcSellDen != 0 ? s.ratioUsdcSellDen : s.ratioUsdcDen;
        if (sellNum == 0 || sellDen == 0) revert InvalidRatio();

        uint256 usdcEq = (casIn * sellDen) / sellNum;
        if (usdcEq == 0) revert ZeroAmount();
        fee = (usdcEq * s.swapFeeBps) / BPS_DENOMINATOR;
        usdcOut = usdcEq - fee;
        if (usdcOut < minUsdcOut) revert SlippageExceeded(minUsdcOut, usdcOut);

        uint256 usdcBal = s.usdcToken.balanceOf(address(this));
        if (usdcBal < usdcOut) revert InsufficientUSDCBalance(usdcBal, usdcOut);

        s.casToken.safeTransferFrom(from, address(this), casIn);
        s.usdcToken.safeTransfer(to, usdcOut);
    }
}
