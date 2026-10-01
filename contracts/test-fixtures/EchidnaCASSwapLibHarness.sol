// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { CASSwapStorage } from "../diamond/storage/CASSwapStorage.sol";
import { LibCASSwap } from "../libs/LibCASSwap.sol";
import { MockERC20 } from "../mocks/MockERC20.sol";

/**
 * @title EchidnaCASSwapLibHarness
 * @dev Harness de fuzzing para as funções internas do LibCASSwap.
 *      O setup usa tokens mock com balanço máximo e executa self-transfers,
 *      permitindo que o Echidna encontre overflow/precisão nos cálculos de
 *      swap sem precisar de aprovações de carteiras externas.
 */
contract EchidnaCASSwapLibHarness {
    using LibCASSwap for CASSwapStorage.Data;

    uint256 private constant BPS = 10000;

    MockERC20 public casToken;
    MockERC20 public usdcToken;
    MockERC20 public brlaToken;

    // Last cross/generic swap
    uint8 public lastSwapIn;
    uint8 public lastSwapOut;
    uint256 public lastSwapAmountIn;
    uint256 public lastSwapAmountOut;
    uint256 public lastSwapFee;
    uint256 public lastSwapFeeBps;
    uint256 public lastSwapInNum;
    uint256 public lastSwapInDen;
    uint256 public lastSwapOutNum;
    uint256 public lastSwapOutDen;

    // Last buy POL
    uint256 public lastBuyPolIn;
    uint256 public lastBuyCasOut;
    uint256 public lastBuyFee;
    uint256 public lastBuyPolFeeBps;
    uint256 public lastBuyPolNum;
    uint256 public lastBuyPolDen;

    // Last buy USDC
    uint256 public lastBuyUsdcIn;
    uint256 public lastBuyCasOutUsdc;
    uint256 public lastBuyFeeUsdc;
    uint256 public lastBuyUsdcFeeBps;
    uint256 public lastBuyUsdcNum;
    uint256 public lastBuyUsdcDen;

    // Last sell POL
    uint256 public lastSellCasIn;
    uint256 public lastSellPolOut;
    uint256 public lastSellFeePol;
    uint256 public lastSellPolFeeBps;
    uint256 public lastSellPolNum;
    uint256 public lastSellPolDen;

    // Last sell USDC
    uint256 public lastSellCasInUsdc;
    uint256 public lastSellUsdcOut;
    uint256 public lastSellFeeUsdc;
    uint256 public lastSellUsdcFeeBps;
    uint256 public lastSellUsdcNum;
    uint256 public lastSellUsdcDen;

    constructor() payable {
        casToken = new MockERC20("CAS", "CAS", 18);
        usdcToken = new MockERC20("USDC", "USDC", 6);
        brlaToken = new MockERC20("BRLA", "BRLA", 18);

        CASSwapStorage.Data storage s = CASSwapStorage.layout();
        s.casToken = casToken;
        s.usdcToken = usdcToken;
        s.brlaToken = brlaToken;

        s.ratioPolNum = 1;
        s.ratioPolDen = 1;
        s.ratioUsdcNum = 1;
        s.ratioUsdcDen = 1;
        s.ratioPolSellNum = 1;
        s.ratioPolSellDen = 1;
        s.ratioUsdcSellNum = 1;
        s.ratioUsdcSellDen = 1;
        s.ratioBrlaNum = 1;
        s.ratioBrlaDen = 1;
        s.ratioBrlaSellNum = 1;
        s.ratioBrlaSellDen = 1;
        s.swapFeeBps = 0;
        s.paused = false;
        s.initialized = true;

        casToken.mint(address(this), type(uint256).max);
        usdcToken.mint(address(this), type(uint256).max);
        brlaToken.mint(address(this), type(uint256).max);

        casToken.approve(address(this), type(uint256).max);
        usdcToken.approve(address(this), type(uint256).max);
        brlaToken.approve(address(this), type(uint256).max);
    }

    // -----------------------------------------------------------------------
    // Ações que o Echidna pode invocar
    // -----------------------------------------------------------------------

    function setPolRatio(uint256 n, uint256 d) public {
        require(n > 0 && d > 0, "pol ratio");
        CASSwapStorage.Data storage s = CASSwapStorage.layout();
        s.ratioPolNum = n;
        s.ratioPolDen = d;
    }

    function setUsdcRatio(uint256 n, uint256 d) public {
        require(n > 0 && d > 0, "usdc ratio");
        CASSwapStorage.Data storage s = CASSwapStorage.layout();
        s.ratioUsdcNum = n;
        s.ratioUsdcDen = d;
    }

    function setPolSellRatio(uint256 n, uint256 d) public {
        require(n > 0 && d > 0, "pol sell ratio");
        CASSwapStorage.Data storage s = CASSwapStorage.layout();
        s.ratioPolSellNum = n;
        s.ratioPolSellDen = d;
    }

    function setUsdcSellRatio(uint256 n, uint256 d) public {
        require(n > 0 && d > 0, "usdc sell ratio");
        CASSwapStorage.Data storage s = CASSwapStorage.layout();
        s.ratioUsdcSellNum = n;
        s.ratioUsdcSellDen = d;
    }

    function setFee(uint256 feeBps) public {
        require(feeBps <= BPS, "fee");
        CASSwapStorage.Data storage s = CASSwapStorage.layout();
        s.swapFeeBps = feeBps;
    }

    function setBrlaRatio(uint256 n, uint256 d) public {
        require(n > 0 && d > 0, "brla ratio");
        CASSwapStorage.Data storage s = CASSwapStorage.layout();
        s.ratioBrlaNum = n;
        s.ratioBrlaDen = d;
    }

    function setBrlaSellRatio(uint256 n, uint256 d) public {
        require(n > 0 && d > 0, "brla sell ratio");
        CASSwapStorage.Data storage s = CASSwapStorage.layout();
        s.ratioBrlaSellNum = n;
        s.ratioBrlaSellDen = d;
    }

    function _buyRatioOf(CASSwapStorage.Data storage s, uint8 currency) internal view returns (uint256, uint256) {
        if (currency == 1) return (s.ratioUsdcNum, s.ratioUsdcDen);
        if (currency == 2) return (s.ratioBrlaNum, s.ratioBrlaDen);
        revert("bad currency");
    }

    function _sellRatioOf(CASSwapStorage.Data storage s, uint8 currency) internal view returns (uint256 num, uint256 den) {
        if (currency == 1) { num = s.ratioUsdcSellNum; den = s.ratioUsdcSellDen; }
        else if (currency == 2) { num = s.ratioBrlaSellNum; den = s.ratioBrlaSellDen; }
        else revert("bad currency");
        if (num == 0 || den == 0) return _buyRatioOf(s, currency);
    }

    /// @dev Swap genérico entre os ERC-20 (USDC=1, BRLA=2, CAS=3); POL fica
    ///      fora porque depende de msg.value. Cobre rotas diretas (X->CAS,
    ///      CAS->Y) e cruzadas (X->Y) via quoteSwap/swapExact.
    function genericSwap(uint8 currencyInSeed, uint8 currencyOutSeed, uint256 amountIn, uint256 minOut) public {
        uint8 currencyIn = currencyInSeed % 3 + 1;
        uint8 currencyOut = currencyOutSeed % 3 + 1;
        if (currencyIn == currencyOut) return;
        CASSwapStorage.Data storage s = CASSwapStorage.layout();
        (uint256 inNum, uint256 inDen) = currencyIn == 3
            ? (uint256(1), uint256(1))
            : _buyRatioOf(s, currencyIn);
        (uint256 outNum, uint256 outDen) = currencyOut == 3
            ? (uint256(1), uint256(1))
            : _sellRatioOf(s, currencyOut);
        (uint256 amountOut, uint256 fee) = s.swapExact(address(this), currencyIn, currencyOut, amountIn, minOut, address(this));
        lastSwapIn = currencyIn;
        lastSwapOut = currencyOut;
        lastSwapAmountIn = amountIn;
        lastSwapAmountOut = amountOut;
        lastSwapFee = fee;
        lastSwapFeeBps = s.swapFeeBps;
        lastSwapInNum = inNum;
        lastSwapInDen = inDen;
        lastSwapOutNum = outNum;
        lastSwapOutDen = outDen;
    }

    function buyPol(uint256 minOut) public payable {
        CASSwapStorage.Data storage s = CASSwapStorage.layout();
        (uint256 casOut, uint256 fee) = s.buyWithPol(msg.value, minOut, address(this));
        lastBuyPolIn = msg.value;
        lastBuyCasOut = casOut;
        lastBuyFee = fee;
        lastBuyPolFeeBps = s.swapFeeBps;
        lastBuyPolNum = s.ratioPolNum;
        lastBuyPolDen = s.ratioPolDen;
    }

    function buyUsdc(uint256 amount, uint256 minOut) public {
        CASSwapStorage.Data storage s = CASSwapStorage.layout();
        (uint256 casOut, uint256 fee) = s.buyWithUsdc(address(this), amount, minOut, address(this));
        lastBuyUsdcIn = amount;
        lastBuyCasOutUsdc = casOut;
        lastBuyFeeUsdc = fee;
        lastBuyUsdcFeeBps = s.swapFeeBps;
        lastBuyUsdcNum = s.ratioUsdcNum;
        lastBuyUsdcDen = s.ratioUsdcDen;
    }

    function sellPol(uint256 casAmount, uint256 minOut) public {
        CASSwapStorage.Data storage s = CASSwapStorage.layout();
        uint256 sellNum = s.ratioPolSellNum != 0 ? s.ratioPolSellNum : s.ratioPolNum;
        uint256 sellDen = s.ratioPolSellDen != 0 ? s.ratioPolSellDen : s.ratioPolDen;
        (uint256 polOut, uint256 fee) = s.sellForPol(address(this), casAmount, minOut, address(this));
        lastSellCasIn = casAmount;
        lastSellPolOut = polOut;
        lastSellFeePol = fee;
        lastSellPolFeeBps = s.swapFeeBps;
        lastSellPolNum = sellNum;
        lastSellPolDen = sellDen;
    }

    function sellUsdc(uint256 casAmount, uint256 minOut) public {
        CASSwapStorage.Data storage s = CASSwapStorage.layout();
        uint256 sellNum = s.ratioUsdcSellNum != 0 ? s.ratioUsdcSellNum : s.ratioUsdcNum;
        uint256 sellDen = s.ratioUsdcSellDen != 0 ? s.ratioUsdcSellDen : s.ratioUsdcDen;
        (uint256 usdcOut, uint256 fee) = s.sellForUsdc(address(this), casAmount, minOut, address(this));
        lastSellCasInUsdc = casAmount;
        lastSellUsdcOut = usdcOut;
        lastSellFeeUsdc = fee;
        lastSellUsdcFeeBps = s.swapFeeBps;
        lastSellUsdcNum = sellNum;
        lastSellUsdcDen = sellDen;
    }

    // -----------------------------------------------------------------------
    // Invariantes
    // -----------------------------------------------------------------------

    function echidna_ratio_den_not_zero() public view returns (bool) {
        CASSwapStorage.Data storage s = CASSwapStorage.layout();
        return s.ratioPolDen > 0 && s.ratioUsdcDen > 0 && s.ratioPolSellDen > 0 && s.ratioUsdcSellDen > 0;
    }

    function echidna_fee_capped() public view returns (bool) {
        CASSwapStorage.Data storage s = CASSwapStorage.layout();
        return s.swapFeeBps <= BPS;
    }

    function echidna_buy_pol_math() public view returns (bool) {
        if (lastBuyPolIn == 0) return true;
        uint256 expectedFee = Math.mulDiv(lastBuyPolIn, lastBuyPolFeeBps, BPS);
        if (lastBuyFee != expectedFee) return false;
        uint256 net = lastBuyPolIn - lastBuyFee;
        uint256 expectedOut = Math.mulDiv(net, lastBuyPolNum, lastBuyPolDen);
        return lastBuyCasOut == expectedOut;
    }

    function echidna_buy_usdc_math() public view returns (bool) {
        if (lastBuyUsdcIn == 0) return true;
        uint256 expectedFee = Math.mulDiv(lastBuyUsdcIn, lastBuyUsdcFeeBps, BPS);
        if (lastBuyFeeUsdc != expectedFee) return false;
        uint256 net = lastBuyUsdcIn - lastBuyFeeUsdc;
        uint256 expectedOut = Math.mulDiv(net, lastBuyUsdcNum, lastBuyUsdcDen);
        return lastBuyCasOutUsdc == expectedOut;
    }

    function echidna_sell_pol_math() public view returns (bool) {
        if (lastSellCasIn == 0) return true;
        uint256 raw = Math.mulDiv(lastSellCasIn, lastSellPolDen, lastSellPolNum);
        uint256 expectedFee = Math.mulDiv(raw, lastSellPolFeeBps, BPS);
        if (lastSellFeePol != expectedFee) return false;
        uint256 expectedOut = raw - expectedFee;
        return lastSellPolOut == expectedOut;
    }

    function echidna_sell_usdc_math() public view returns (bool) {
        if (lastSellCasInUsdc == 0) return true;
        uint256 raw = Math.mulDiv(lastSellCasInUsdc, lastSellUsdcDen, lastSellUsdcNum);
        uint256 expectedFee = Math.mulDiv(raw, lastSellUsdcFeeBps, BPS);
        if (lastSellFeeUsdc != expectedFee) return false;
        uint256 expectedOut = raw - expectedFee;
        return lastSellUsdcOut == expectedOut;
    }

    /// @dev Reproduz a matemática de LibCASSwap.quoteSwap para a última
    ///      genericSwap registrada: direta para CAS usa buy-ratio, CAS de
    ///      saída usa sell-ratio, cruzada compõe buy(in) x sell(out) com a
    ///      fee cobrada uma única vez sobre o input.
    function echidna_generic_swap_math() public view returns (bool) {
        if (lastSwapAmountIn == 0) return true;
        uint256 feeBps = lastSwapFeeBps;
        uint256 expectedOut;
        uint256 expectedFee;
        if (lastSwapOut == 3) {
            expectedFee = Math.mulDiv(lastSwapAmountIn, feeBps, BPS);
            expectedOut = Math.mulDiv(lastSwapAmountIn - expectedFee, lastSwapInNum, lastSwapInDen);
        } else if (lastSwapIn == 3) {
            uint256 outEq = Math.mulDiv(lastSwapAmountIn, lastSwapOutDen, lastSwapOutNum);
            expectedFee = Math.mulDiv(outEq, feeBps, BPS);
            expectedOut = outEq - expectedFee;
        } else {
            expectedFee = Math.mulDiv(lastSwapAmountIn, feeBps, BPS);
            uint256 casEq = Math.mulDiv(lastSwapAmountIn - expectedFee, lastSwapInNum, lastSwapInDen);
            expectedOut = Math.mulDiv(casEq, lastSwapOutDen, lastSwapOutNum);
        }
        return lastSwapAmountOut == expectedOut && lastSwapFee == expectedFee;
    }

    function echidna_brla_ratio_set() public view returns (bool) {
        CASSwapStorage.Data storage s = CASSwapStorage.layout();
        return address(s.brlaToken) != address(0) && s.ratioBrlaDen > 0;
    }

    receive() external payable {}
    fallback() external payable {}
}
