// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { LibDiamond } from "../diamond/libraries/LibDiamond.sol";
import { DiamondAccessControl } from "../diamond/access/DiamondAccessControl.sol";
import { CASSwapStorage } from "../diamond/storage/CASSwapStorage.sol";
import { LibCASSwap } from "../libs/LibCASSwap.sol";
import { ICASSwapUSDCPOL } from "../interfaces/ICASSwapUSDCPOL.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title CASSwapUSDCPOLFacet
 * @dev Facet do Rapport Trader que executa swaps CAS <-> USDC e CAS <-> POL
 *      no Diamond do Agentic Space. O ratio é definido OFF-CHAIN pelo backend
 *      (RATIO_SETTER_ROLE) e aqui apenas armazenado/aplicado — o contrato é um
 *      instrumento. Também oferece resgate genérico e suporte de preço (DCA).
 *
 *      Rede: Polygon PoS (chainId 137). Currency: 0 = POL, 1 = USDC.
 *
 *      Segurança: ReentrancyGuard (Diamond Storage slot), CEI, Pausable
 *      (estado em CASSwapStorage, controlado pelo TraderGovernanceFacet),
 *      AccessControl (owner + RATIO_SETTER_ROLE), custom errors.
 *
 *      Padrões: Diamond Storage (EIP-2535), Strategy (ratio ajustável),
 *               Adapter (POL nativo + USDC ERC-20).
 */
contract CASSwapUSDCPOLFacet is ICASSwapUSDCPOL {
    using SafeERC20 for IERC20;

    uint8 internal constant CURRENCY_POL = 0;
    uint8 internal constant CURRENCY_USDC = 1;

    bytes32 internal constant RATIO_SETTER_ROLE_HASH = keccak256("RATIO_SETTER_ROLE");

    // --- Reentrancy guard (Diamond Storage slot, compartilhado com o wrapper) ---
    bytes32 internal constant REENTRANCY_SLOT =
        keccak256("agenticspace.casswap.usdcpol.reentrancy");
    uint256 internal constant _NOT_ENTERED = 1;
    uint256 internal constant _ENTERED = 2;

    error ReentrantCall();
    error SwapPaused();
    error DeadlineExpired(uint256 deadline, uint256 nowTs);
    error AlreadyInitialized();
    error ZeroAddress();
    error InvalidRatioArg();
    error InvalidCurrency(uint8 currency);
    error MsgValueMismatch(uint256 expected, uint256 sent);
    error BudgetExceeded(uint256 requested, uint256 remaining);
    error InsufficientReserve(uint256 available, uint256 required);

    modifier nonReentrant() {
        bytes32 slot = REENTRANCY_SLOT;
        uint256 status;
        assembly { status := sload(slot) }
        if (status == _ENTERED) revert ReentrantCall();
        assembly { sstore(slot, _ENTERED) }
        _;
        assembly { sstore(slot, _NOT_ENTERED) }
    }

    modifier whenNotPaused() {
        if (CASSwapStorage.layout().paused) revert SwapPaused();
        _;
    }

    modifier ensureDeadline(uint256 deadline) {
        if (block.timestamp > deadline) revert DeadlineExpired(deadline, block.timestamp);
        _;
    }

    // -----------------------------------------------------------------------
    // Init (via diamondCut delegatecall)
    // -----------------------------------------------------------------------

    function initCASSwapUSDCPOL(address casToken, address usdcToken) external override {
        LibDiamond.enforceIsContractOwner();
        if (casToken == address(0) || usdcToken == address(0)) revert ZeroAddress();

        CASSwapStorage.Data storage s = CASSwapStorage.layout();
        if (s.initialized) revert AlreadyInitialized();

        s.casToken = IERC20(casToken);
        s.usdcToken = IERC20(usdcToken);
        // ratios default 1:1 (base units) — devem ser ajustados pelo backend
        s.ratioPolNum = 1;
        s.ratioPolDen = 1;
        s.ratioUsdcNum = 1;
        s.ratioUsdcDen = 1;
        s.swapFeeBps = 0;
        s.paused = false;
        s.maxImpactBps = 100;      // 1%
        s.slippageLimitBps = 200;  // 2%
        s.periodDuration = 30 days;
        s.periodStart = block.timestamp;
        s.periodSpent = 0;
        s.initialized = true;

        emit CASSwapUSDCPOLInitialized(casToken, usdcToken);
    }

    // -----------------------------------------------------------------------
    // Backend-controlled ratio (RATIO_SETTER_ROLE ou owner)
    // -----------------------------------------------------------------------

    function setSwapRatio(uint256 numerator, uint256 denominator)
        external
        override
        whenNotPaused
    {
        DiamondAccessControl.enforceRoleOrOwner(RATIO_SETTER_ROLE_HASH);
        if (numerator == 0 || denominator == 0) revert InvalidRatioArg();
        CASSwapStorage.Data storage s = CASSwapStorage.layout();
        s.ratioPolNum = numerator;
        s.ratioPolDen = denominator;
        emit RatioUpdated(CURRENCY_POL, numerator, denominator, msg.sender);
    }

    function setSwapRatioUSDC(uint256 numerator, uint256 denominator)
        external
        override
        whenNotPaused
    {
        DiamondAccessControl.enforceRoleOrOwner(RATIO_SETTER_ROLE_HASH);
        if (numerator == 0 || denominator == 0) revert InvalidRatioArg();
        CASSwapStorage.Data storage s = CASSwapStorage.layout();
        s.ratioUsdcNum = numerator;
        s.ratioUsdcDen = denominator;
        emit RatioUpdated(CURRENCY_USDC, numerator, denominator, msg.sender);
    }

    // -----------------------------------------------------------------------
    // Sell ratios (spread assimétrico) — RATIO_SETTER_ROLE ou owner
    // -----------------------------------------------------------------------

    function setSwapRatioSell(uint256 numerator, uint256 denominator)
        external
        whenNotPaused
    {
        DiamondAccessControl.enforceRoleOrOwner(RATIO_SETTER_ROLE_HASH);
        if (numerator == 0 || denominator == 0) revert InvalidRatioArg();
        CASSwapStorage.Data storage s = CASSwapStorage.layout();
        s.ratioPolSellNum = numerator;
        s.ratioPolSellDen = denominator;
        emit RatioUpdated(2, numerator, denominator, msg.sender);
    }

    function setSwapRatioUSDCSell(uint256 numerator, uint256 denominator)
        external
        whenNotPaused
    {
        DiamondAccessControl.enforceRoleOrOwner(RATIO_SETTER_ROLE_HASH);
        if (numerator == 0 || denominator == 0) revert InvalidRatioArg();
        CASSwapStorage.Data storage s = CASSwapStorage.layout();
        s.ratioUsdcSellNum = numerator;
        s.ratioUsdcSellDen = denominator;
        emit RatioUpdated(3, numerator, denominator, msg.sender);
    }

    // -----------------------------------------------------------------------
    // Swaps: POL
    // -----------------------------------------------------------------------

    function buyCASWithPOL(uint256 minCasOut, uint256 deadline)
        external
        payable
        override
        nonReentrant
        whenNotPaused
        ensureDeadline(deadline)
        returns (uint256 casReceived)
    {
        uint256 fee;
        (casReceived, fee) = LibCASSwap.buyWithPol(CASSwapStorage.layout(), msg.value, minCasOut, msg.sender);
        emit CASBoughtWithPOL(msg.sender, msg.value, casReceived, fee);
    }

    function sellCASForPOL(uint256 casAmount, uint256 minPolOut, uint256 deadline)
        external
        override
        nonReentrant
        whenNotPaused
        ensureDeadline(deadline)
        returns (uint256 polReceived)
    {
        uint256 fee;
        (polReceived, fee) = LibCASSwap.sellForPol(CASSwapStorage.layout(), msg.sender, casAmount, minPolOut, msg.sender);
        emit CASSoldForPOL(msg.sender, casAmount, polReceived, fee);
    }

    // -----------------------------------------------------------------------
    // Swaps: USDC
    // -----------------------------------------------------------------------

    function buyCASWithUSDC(uint256 usdcAmount, uint256 minCasOut, uint256 deadline)
        external
        override
        nonReentrant
        whenNotPaused
        ensureDeadline(deadline)
        returns (uint256 casReceived)
    {
        uint256 fee;
        (casReceived, fee) = LibCASSwap.buyWithUsdc(CASSwapStorage.layout(), msg.sender, usdcAmount, minCasOut, msg.sender);
        emit CASBoughtWithUSDC(msg.sender, usdcAmount, casReceived, fee);
    }

    function sellCASForUSDC(uint256 casAmount, uint256 minUsdcOut, uint256 deadline)
        external
        override
        nonReentrant
        whenNotPaused
        ensureDeadline(deadline)
        returns (uint256 usdcReceived)
    {
        uint256 fee;
        (usdcReceived, fee) = LibCASSwap.sellForUsdc(CASSwapStorage.layout(), msg.sender, casAmount, minUsdcOut, msg.sender);
        emit CASSoldForUSDC(msg.sender, casAmount, usdcReceived, fee);
    }

    // -----------------------------------------------------------------------
    // Resgate genérico
    // -----------------------------------------------------------------------

    function redeemCAS(uint256 casAmount, uint8 currencyOut, uint256 minOut, uint256 deadline)
        external
        override
        nonReentrant
        whenNotPaused
        ensureDeadline(deadline)
        returns (uint256 amountOut)
    {
        CASSwapStorage.Data storage s = CASSwapStorage.layout();
        uint256 fee;
        if (currencyOut == CURRENCY_POL) {
            (amountOut, fee) = LibCASSwap.sellForPol(s, msg.sender, casAmount, minOut, msg.sender);
            emit CASSoldForPOL(msg.sender, casAmount, amountOut, fee);
        } else if (currencyOut == CURRENCY_USDC) {
            (amountOut, fee) = LibCASSwap.sellForUsdc(s, msg.sender, casAmount, minOut, msg.sender);
            emit CASSoldForUSDC(msg.sender, casAmount, amountOut, fee);
        } else {
            revert InvalidCurrency(currencyOut);
        }
    }

    function redeemForCAS(uint8 currencyIn, uint256 amountIn, uint256 minCasOut, uint256 deadline)
        external
        payable
        override
        nonReentrant
        whenNotPaused
        ensureDeadline(deadline)
        returns (uint256 casReceived)
    {
        CASSwapStorage.Data storage s = CASSwapStorage.layout();
        uint256 fee;
        if (currencyIn == CURRENCY_POL) {
            if (msg.value != amountIn) revert MsgValueMismatch(amountIn, msg.value);
            (casReceived, fee) = LibCASSwap.buyWithPol(s, amountIn, minCasOut, msg.sender);
            emit CASBoughtWithPOL(msg.sender, amountIn, casReceived, fee);
        } else if (currencyIn == CURRENCY_USDC) {
            if (msg.value != 0) revert MsgValueMismatch(0, msg.value);
            (casReceived, fee) = LibCASSwap.buyWithUsdc(s, msg.sender, amountIn, minCasOut, msg.sender);
            emit CASBoughtWithUSDC(msg.sender, amountIn, casReceived, fee);
        } else {
            revert InvalidCurrency(currencyIn);
        }
    }

    // -----------------------------------------------------------------------
    // Suporte de preço (DCA via reserva) — RATIO_SETTER_ROLE/owner
    // -----------------------------------------------------------------------

    /**
     * @notice Retira `amount` da reserva (POL ou USDC) do Diamond para o
     *         endereço `to` (operador) executar DCA de suporte em DEXs externas.
     * @dev Bounded pelo orçamento mensal (para USDC) e pelo saldo disponível.
     *      Acionado pela decisão off-chain SUPPORT_SWAP.
     */
    function supportSwap(uint8 reserveCurrency, uint256 amount, address to)
        external
        override
        nonReentrant
        whenNotPaused
    {
        DiamondAccessControl.enforceRoleOrOwner(RATIO_SETTER_ROLE_HASH);
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert LibCASSwap.ZeroAmount();

        CASSwapStorage.Data storage s = CASSwapStorage.layout();

        if (reserveCurrency == CURRENCY_USDC) {
            _accrueBudget(s, amount);
            uint256 bal = s.usdcToken.balanceOf(address(this));
            if (bal < amount) revert InsufficientReserve(bal, amount);
            s.usdcToken.safeTransfer(to, amount);
        } else if (reserveCurrency == CURRENCY_POL) {
            uint256 bal = address(this).balance;
            if (bal < amount) revert InsufficientReserve(bal, amount);
            (bool ok, ) = payable(to).call{ value: amount }("");
            if (!ok) revert LibCASSwap.POLTransferFailed();
        } else {
            revert InvalidCurrency(reserveCurrency);
        }

        emit SupportSwapExecuted(reserveCurrency, amount, to);
    }

    /// @dev Verifica e atualiza o orçamento do período (apenas para USDC).
    function _accrueBudget(CASSwapStorage.Data storage s, uint256 amountUsdc) private {
        if (s.periodDuration > 0 && block.timestamp >= s.periodStart + s.periodDuration) {
            s.periodStart = block.timestamp;
            s.periodSpent = 0;
        }
        if (s.monthlyBudgetUsdc > 0) {
            uint256 remaining = s.periodSpent >= s.monthlyBudgetUsdc
                ? 0
                : s.monthlyBudgetUsdc - s.periodSpent;
            if (amountUsdc > remaining) revert BudgetExceeded(amountUsdc, remaining);
        }
        s.periodSpent += amountUsdc;
    }

    // -----------------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------------

    function getRatio() external view override returns (uint256 numerator, uint256 denominator) {
        CASSwapStorage.Data storage s = CASSwapStorage.layout();
        return (s.ratioPolNum, s.ratioPolDen);
    }

    function getRatioUSDC() external view override returns (uint256 numerator, uint256 denominator) {
        CASSwapStorage.Data storage s = CASSwapStorage.layout();
        return (s.ratioUsdcNum, s.ratioUsdcDen);
    }

    function getRatioSell() external view returns (uint256 numerator, uint256 denominator) {
        CASSwapStorage.Data storage s = CASSwapStorage.layout();
        // Return sell ratio if set, otherwise return buy ratio (legacy compat)
        if (s.ratioPolSellNum != 0 && s.ratioPolSellDen != 0) {
            return (s.ratioPolSellNum, s.ratioPolSellDen);
        }
        return (s.ratioPolNum, s.ratioPolDen);
    }

    function getRatioUSDCSell() external view returns (uint256 numerator, uint256 denominator) {
        CASSwapStorage.Data storage s = CASSwapStorage.layout();
        if (s.ratioUsdcSellNum != 0 && s.ratioUsdcSellDen != 0) {
            return (s.ratioUsdcSellNum, s.ratioUsdcSellDen);
        }
        return (s.ratioUsdcNum, s.ratioUsdcDen);
    }

    function getSwapFeeBps() external view override returns (uint256) {
        return CASSwapStorage.layout().swapFeeBps;
    }

    function getReserves()
        external
        view
        override
        returns (uint256 casBalance, uint256 usdcBalance, uint256 polBalance)
    {
        CASSwapStorage.Data storage s = CASSwapStorage.layout();
        casBalance = address(s.casToken) == address(0) ? 0 : s.casToken.balanceOf(address(this));
        usdcBalance = address(s.usdcToken) == address(0) ? 0 : s.usdcToken.balanceOf(address(this));
        polBalance = address(this).balance;
    }

    function isSwapPaused() external view override returns (bool) {
        return CASSwapStorage.layout().paused;
    }

    function RATIO_SETTER_ROLE() external pure override returns (bytes32) {
        return RATIO_SETTER_ROLE_HASH;
    }
}
