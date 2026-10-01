// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { CASSwapStorage } from "../diamond/storage/CASSwapStorage.sol";
import { LibCASOracle } from "./LibCASOracle.sol";

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
    error InsufficientBRLABalance(uint256 available, uint256 required);
    error SlippageExceeded(uint256 minExpected, uint256 actual);
    error POLTransferFailed();
    error InvalidCurrency(uint8 currency);
    error SameTokenSwap();
    error BRLANotConfigured();

    // Currency ids: 0 = POL (nativo), 1 = USDC, 2 = BRLA, 3 = CAS.
    // CAS (3) só é válido como ponta de um swap genérico — nunca como
    // moeda de cotação de ratio.
    uint8 internal constant CURRENCY_POL = 0;
    uint8 internal constant CURRENCY_USDC = 1;
    uint8 internal constant CURRENCY_BRLA = 2;
    uint8 internal constant CURRENCY_CAS = 3;

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
        LibCASOracle.pokeCasTwap(s);
        (uint256 num, uint256 den) = buyRatioFor(s, CURRENCY_POL);
        uint256 feeBps = s.swapFeeBps;
        if (num == 0 || den == 0) revert InvalidRatio();

        fee = Math.mulDiv(polIn, feeBps, BPS_DENOMINATOR);
        uint256 net = polIn - fee;
        casOut = Math.mulDiv(net, num, den);
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
        LibCASOracle.pokeCasTwap(s);
        (uint256 sellNum, uint256 sellDen) = sellRatioFor(s, CURRENCY_POL);
        uint256 feeBps = s.swapFeeBps;
        if (sellNum == 0 || sellDen == 0) revert InvalidRatio();

        uint256 polEq = Math.mulDiv(casIn, sellDen, sellNum);
        if (polEq == 0) revert ZeroAmount();
        fee = Math.mulDiv(polEq, feeBps, BPS_DENOMINATOR);
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
        LibCASOracle.pokeCasTwap(s);
        (uint256 num, uint256 den) = buyRatioFor(s, CURRENCY_USDC);
        uint256 feeBps = s.swapFeeBps;
        if (num == 0 || den == 0) revert InvalidRatio();

        fee = Math.mulDiv(usdcIn, feeBps, BPS_DENOMINATOR);
        uint256 net = usdcIn - fee;
        casOut = Math.mulDiv(net, num, den);
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
        LibCASOracle.pokeCasTwap(s);
        (uint256 sellNum, uint256 sellDen) = sellRatioFor(s, CURRENCY_USDC);
        uint256 feeBps = s.swapFeeBps;
        if (sellNum == 0 || sellDen == 0) revert InvalidRatio();

        uint256 usdcEq = Math.mulDiv(casIn, sellDen, sellNum);
        if (usdcEq == 0) revert ZeroAmount();
        fee = Math.mulDiv(usdcEq, feeBps, BPS_DENOMINATOR);
        usdcOut = usdcEq - fee;
        if (usdcOut < minUsdcOut) revert SlippageExceeded(minUsdcOut, usdcOut);

        uint256 usdcBal = s.usdcToken.balanceOf(address(this));
        if (usdcBal < usdcOut) revert InsufficientUSDCBalance(usdcBal, usdcOut);

        s.casToken.safeTransferFrom(from, address(this), casIn);
        s.usdcToken.safeTransfer(to, usdcOut);
    }

    // -----------------------------------------------------------------------
    // Buy CAS with BRLA / Sell CAS for BRLA
    // -----------------------------------------------------------------------

    function buyWithBrla(
        CASSwapStorage.Data storage s,
        address from,
        uint256 brlaIn,
        uint256 minCasOut,
        address to
    ) internal returns (uint256 casOut, uint256 fee) {
        return swapExact(s, from, CURRENCY_BRLA, CURRENCY_CAS, brlaIn, minCasOut, to);
    }

    function sellForBrla(
        CASSwapStorage.Data storage s,
        address from,
        uint256 casIn,
        uint256 minBrlaOut,
        address to
    ) internal returns (uint256 brlaOut, uint256 fee) {
        return swapExact(s, from, CURRENCY_CAS, CURRENCY_BRLA, casIn, minBrlaOut, to);
    }

    // -----------------------------------------------------------------------
    // Generic multi-asset swap (CAS como moeda-pivô)
    // -----------------------------------------------------------------------
    // Rotas com CAS em uma ponta usam o ratio do ativo cotado diretamente.
    // Rotas entre dois ativos cotados (ex.: BRLA -> USDC) compõem
    // `in -> CAS -> out` usando o buy-ratio do ativo de entrada e o
    // sell-ratio do de saída — o CAS é apenas unidade de conta e a reserva
    // de CAS não se move. A fee é cobrada uma única vez sobre o input
    // (como nos buyWith*).

    /// @dev Buy ratio (CAS por base unit do ativo) por currency id.
    ///      Com `oracleEnabled`, deriva do oráculo (LibCASOracle); quando o
    ///      oráculo está indisponível para o ativo, cai para o ratio
    ///      armazenado desde que ainda fresco (`legacyRatioMaxAge`).
    function buyRatioFor(CASSwapStorage.Data storage s, uint8 currency)
        internal
        view
        returns (uint256 num, uint256 den)
    {
        if (s.oracleEnabled) {
            (num, den) = _oracleRatio(s, currency, false);
            if (num != 0) return (num, den);
            if (!_legacyRatioFresh(s)) return (0, 0);
        }
        if (currency == CURRENCY_POL) return (s.ratioPolNum, s.ratioPolDen);
        if (currency == CURRENCY_USDC) return (s.ratioUsdcNum, s.ratioUsdcDen);
        if (currency == CURRENCY_BRLA) {
            if (address(s.brlaToken) == address(0)) revert BRLANotConfigured();
            return (s.ratioBrlaNum, s.ratioBrlaDen);
        }
        revert InvalidCurrency(currency);
    }

    /// @dev Sell ratio por currency id; fallback para o buy ratio quando o
    ///      sell ainda não foi configurado (compatibilidade com versões
    ///      anteriores).
    function sellRatioFor(CASSwapStorage.Data storage s, uint8 currency)
        internal
        view
        returns (uint256 num, uint256 den)
    {
        uint256 bn = 0; uint256 bd = 0; uint256 sn = 0; uint256 sd = 0;
        if (currency == CURRENCY_POL) {
            bn = s.ratioPolNum; bd = s.ratioPolDen; sn = s.ratioPolSellNum; sd = s.ratioPolSellDen;
        } else if (currency == CURRENCY_USDC) {
            bn = s.ratioUsdcNum; bd = s.ratioUsdcDen; sn = s.ratioUsdcSellNum; sd = s.ratioUsdcSellDen;
        } else if (currency == CURRENCY_BRLA) {
            if (address(s.brlaToken) == address(0)) revert BRLANotConfigured();
            bn = s.ratioBrlaNum; bd = s.ratioBrlaDen; sn = s.ratioBrlaSellNum; sd = s.ratioBrlaSellDen;
        } else {
            revert InvalidCurrency(currency);
        }
        if (s.oracleEnabled) {
            (uint256 on, uint256 od) = _oracleRatio(s, currency, true);
            if (on != 0) return (on, od);
            if (!_legacyRatioFresh(s)) return (0, 0);
        }
        num = sn != 0 ? sn : bn;
        den = sd != 0 ? sd : bd;
    }

    /// @dev Ratio derivado do oráculo; (0,0) quando indisponível para o ativo.
    function _oracleRatio(CASSwapStorage.Data storage s, uint8 currency, bool sell)
        private
        view
        returns (uint256 num, uint256 den)
    {
        bool ok;
        (num, den, ok) = LibCASOracle.casRatio(s, currency, sell);
        if (!ok) return (0, 0);
    }

    /// @dev True quando o ratio armazenado ainda é aceitável como fallback:
    ///      `legacyRatioMaxAge == 0` desativa o limite (legado sempre válido).
    function _legacyRatioFresh(CASSwapStorage.Data storage s) private view returns (bool) {
        if (!s.oracleEnabled) return true;
        if (s.legacyRatioMaxAge == 0) return true;
        return s.ratiosSetAt != 0 && block.timestamp - s.ratiosSetAt <= s.legacyRatioMaxAge;
    }

    /// @dev Token ERC-20 associado ao currency id; POL reverte (é nativo).
    function tokenFor(CASSwapStorage.Data storage s, uint8 currency)
        internal
        view
        returns (IERC20)
    {
        if (currency == CURRENCY_USDC) return s.usdcToken;
        if (currency == CURRENCY_CAS) return s.casToken;
        if (currency == CURRENCY_BRLA) {
            if (address(s.brlaToken) == address(0)) revert BRLANotConfigured();
            return s.brlaToken;
        }
        revert InvalidCurrency(currency);
    }

    /// @notice Cotação pura de um swap (sem transferências).
    function quoteSwap(
        CASSwapStorage.Data storage s,
        uint8 currencyIn,
        uint8 currencyOut,
        uint256 amountIn
    ) internal view returns (uint256 amountOut, uint256 fee) {
        if (amountIn == 0) revert ZeroAmount();
        if (currencyIn == currencyOut) revert SameTokenSwap();
        uint256 feeBps = s.swapFeeBps;

        if (currencyOut == CURRENCY_CAS) {
            (uint256 num, uint256 den) = buyRatioFor(s, currencyIn);
            if (num == 0 || den == 0) revert InvalidRatio();
            fee = Math.mulDiv(amountIn, feeBps, BPS_DENOMINATOR);
            amountOut = Math.mulDiv(amountIn - fee, num, den);
        } else if (currencyIn == CURRENCY_CAS) {
            (uint256 num, uint256 den) = sellRatioFor(s, currencyOut);
            if (num == 0 || den == 0) revert InvalidRatio();
            uint256 outEq = Math.mulDiv(amountIn, den, num);
            fee = Math.mulDiv(outEq, feeBps, BPS_DENOMINATOR);
            amountOut = outEq - fee;
        } else {
            (uint256 inNum, uint256 inDen) = buyRatioFor(s, currencyIn);
            (uint256 outNum, uint256 outDen) = sellRatioFor(s, currencyOut);
            if (inNum == 0 || inDen == 0 || outNum == 0 || outDen == 0) revert InvalidRatio();
            fee = Math.mulDiv(amountIn, feeBps, BPS_DENOMINATOR);
            uint256 casEq = Math.mulDiv(amountIn - fee, inNum, inDen);
            amountOut = Math.mulDiv(casEq, outDen, outNum);
        }
        if (amountOut == 0) revert ZeroAmount();
    }

    /// @notice Executa o swap: cota, valida slippage e reserva, puxa o input
    ///         e envia o output. POL entra via msg.value (conferido pelo
    ///         caller); os demais ativos usam safeTransferFrom.
    function swapExact(
        CASSwapStorage.Data storage s,
        address from,
        uint8 currencyIn,
        uint8 currencyOut,
        uint256 amountIn,
        uint256 minOut,
        address to
    ) internal returns (uint256 amountOut, uint256 fee) {
        LibCASOracle.pokeCasTwap(s);
        (amountOut, fee) = quoteSwap(s, currencyIn, currencyOut, amountIn);
        if (amountOut < minOut) revert SlippageExceeded(minOut, amountOut);

        _checkReserve(s, currencyOut, amountOut);
        _pullIn(s, from, currencyIn, amountIn);
        _pushOut(s, to, currencyOut, amountOut);
    }

    function _checkReserve(CASSwapStorage.Data storage s, uint8 currency, uint256 required) private view {
        if (currency == CURRENCY_POL) {
            uint256 polBal = address(this).balance;
            if (polBal < required) revert InsufficientPOLBalance(polBal, required);
            return;
        }
        uint256 bal = tokenFor(s, currency).balanceOf(address(this));
        if (bal >= required) return;
        if (currency == CURRENCY_CAS) revert InsufficientCASBalance(bal, required);
        if (currency == CURRENCY_USDC) revert InsufficientUSDCBalance(bal, required);
        revert InsufficientBRLABalance(bal, required);
    }

    function _pullIn(CASSwapStorage.Data storage s, address from, uint8 currency, uint256 amount) private {
        if (currency == CURRENCY_POL) return; // POL chega via msg.value
        tokenFor(s, currency).safeTransferFrom(from, address(this), amount);
    }

    function _pushOut(CASSwapStorage.Data storage s, address to, uint8 currency, uint256 amount) private {
        if (currency == CURRENCY_POL) {
            (bool ok, ) = payable(to).call{ value: amount }("");
            if (!ok) revert POLTransferFailed();
            return;
        }
        tokenFor(s, currency).safeTransfer(to, amount);
    }
}
