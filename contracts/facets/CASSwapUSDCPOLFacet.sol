// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { LibDiamond } from "../diamond/libraries/LibDiamond.sol";
import { DiamondAccessControl } from "../diamond/access/DiamondAccessControl.sol";
import { CASSwapStorage } from "../diamond/storage/CASSwapStorage.sol";
import { LibCASSwap } from "../libs/LibCASSwap.sol";
import { ICASSwapUSDCPOL } from "../interfaces/ICASSwapUSDCPOL.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

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
    uint8 internal constant CURRENCY_BRLA = 2;
    uint8 internal constant CURRENCY_CAS = 3;

    bytes32 internal constant RATIO_SETTER_ROLE_HASH = keccak256("RATIO_SETTER_ROLE");
    uint256 internal constant BPS_DENOMINATOR = 10000;

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
    error InvalidFeeBps();
    error InvalidImpactBps();
    error RatioChangeExceeded(uint256 oldNum, uint256 oldDen, uint256 newNum, uint256 newDen, uint256 maxImpactBps);
    error ReverseSpread(uint8 currency);

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
    // Helpers
    // -----------------------------------------------------------------------

    // CAS/quote ratios are inverse prices: buy ratio MUST be <= sell ratio.
    function _requireNormalSpread(uint8 currency, uint256 bn, uint256 bd, uint256 sn, uint256 sd) internal pure {
        (uint256 bh, uint256 bl) = Math.mul512(bn, sd);
        (uint256 sh, uint256 sl) = Math.mul512(sn, bd);
        if (bh > sh || (bh == sh && bl > sl)) revert ReverseSpread(currency);
    }

    function _requireRatioWithinImpact(
        uint256 oldNum,
        uint256 oldDen,
        uint256 newNum,
        uint256 newDen,
        uint256 maxImpactBps
    ) internal pure {
        if (oldNum == 0 || oldDen == 0 || maxImpactBps == 0) return;

        uint256 newScaled = newNum * oldDen;
        uint256 oldScaled = oldNum * newDen;
        if (newScaled == oldScaled) return;

        uint256 diff = newScaled > oldScaled ? newScaled - oldScaled : oldScaled - newScaled;
        uint256 impact = (diff * BPS_DENOMINATOR) / oldScaled;
        if (impact > maxImpactBps) {
            revert RatioChangeExceeded(oldNum, oldDen, newNum, newDen, maxImpactBps);
        }
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
        _requireNormalSpread(CURRENCY_POL, numerator, denominator,
            s.ratioPolSellNum != 0 ? s.ratioPolSellNum : numerator,
            s.ratioPolSellDen != 0 ? s.ratioPolSellDen : denominator);
        _requireRatioWithinImpact(s.ratioPolNum, s.ratioPolDen, numerator, denominator, s.maxImpactBps);
        s.ratioPolNum = numerator;
        s.ratioPolDen = denominator;
        s.ratiosSetAt = uint64(block.timestamp);
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
        _requireNormalSpread(CURRENCY_USDC, numerator, denominator,
            s.ratioUsdcSellNum != 0 ? s.ratioUsdcSellNum : numerator,
            s.ratioUsdcSellDen != 0 ? s.ratioUsdcSellDen : denominator);
        _requireRatioWithinImpact(s.ratioUsdcNum, s.ratioUsdcDen, numerator, denominator, s.maxImpactBps);
        s.ratioUsdcNum = numerator;
        s.ratioUsdcDen = denominator;
        s.ratiosSetAt = uint64(block.timestamp);
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
        _requireNormalSpread(CURRENCY_POL, s.ratioPolNum, s.ratioPolDen, numerator, denominator);
        _requireRatioWithinImpact(s.ratioPolSellNum, s.ratioPolSellDen, numerator, denominator, s.maxImpactBps);
        s.ratioPolSellNum = numerator;
        s.ratioPolSellDen = denominator;
        s.ratiosSetAt = uint64(block.timestamp);
        emit RatioUpdated(2, numerator, denominator, msg.sender);
    }

    function setSwapRatioUSDCSell(uint256 numerator, uint256 denominator)
        external
        whenNotPaused
    {
        DiamondAccessControl.enforceRoleOrOwner(RATIO_SETTER_ROLE_HASH);
        if (numerator == 0 || denominator == 0) revert InvalidRatioArg();
        CASSwapStorage.Data storage s = CASSwapStorage.layout();
        _requireNormalSpread(CURRENCY_USDC, s.ratioUsdcNum, s.ratioUsdcDen, numerator, denominator);
        _requireRatioWithinImpact(s.ratioUsdcSellNum, s.ratioUsdcSellDen, numerator, denominator, s.maxImpactBps);
        s.ratioUsdcSellNum = numerator;
        s.ratioUsdcSellDen = denominator;
        s.ratiosSetAt = uint64(block.timestamp);
        emit RatioUpdated(3, numerator, denominator, msg.sender);
    }

    // -----------------------------------------------------------------------
    // BRLA — configuração (owner) e ratios (RATIO_SETTER_ROLE ou owner)
    // -----------------------------------------------------------------------

    /// @notice Registra o token BRLA usado como moeda de cotação adicional.
    /// @dev Apenas o owner do Diamond (governança). Configurável uma vez por
    ///      upgrade; para trocar o endereço é preciso nova decisão de owner.
    function setBRLAToken(address brlaToken) external {
        LibDiamond.enforceIsContractOwner();
        if (brlaToken == address(0)) revert ZeroAddress();
        CASSwapStorage.layout().brlaToken = IERC20(brlaToken);
        emit BRLATokenUpdated(brlaToken, msg.sender);
    }

    function setSwapRatioBRLA(uint256 numerator, uint256 denominator)
        external
        whenNotPaused
    {
        DiamondAccessControl.enforceRoleOrOwner(RATIO_SETTER_ROLE_HASH);
        if (numerator == 0 || denominator == 0) revert InvalidRatioArg();
        CASSwapStorage.Data storage s = CASSwapStorage.layout();
        if (address(s.brlaToken) == address(0)) revert LibCASSwap.BRLANotConfigured();
        _requireNormalSpread(CURRENCY_BRLA, numerator, denominator,
            s.ratioBrlaSellNum != 0 ? s.ratioBrlaSellNum : numerator,
            s.ratioBrlaSellDen != 0 ? s.ratioBrlaSellDen : denominator);
        _requireRatioWithinImpact(s.ratioBrlaNum, s.ratioBrlaDen, numerator, denominator, s.maxImpactBps);
        s.ratioBrlaNum = numerator;
        s.ratioBrlaDen = denominator;
        s.ratiosSetAt = uint64(block.timestamp);
        emit RatioUpdated(4, numerator, denominator, msg.sender);
    }

    function setSwapRatioBRLASell(uint256 numerator, uint256 denominator)
        external
        whenNotPaused
    {
        DiamondAccessControl.enforceRoleOrOwner(RATIO_SETTER_ROLE_HASH);
        if (numerator == 0 || denominator == 0) revert InvalidRatioArg();
        CASSwapStorage.Data storage s = CASSwapStorage.layout();
        if (address(s.brlaToken) == address(0)) revert LibCASSwap.BRLANotConfigured();
        _requireNormalSpread(CURRENCY_BRLA, s.ratioBrlaNum, s.ratioBrlaDen, numerator, denominator);
        _requireRatioWithinImpact(s.ratioBrlaSellNum, s.ratioBrlaSellDen, numerator, denominator, s.maxImpactBps);
        s.ratioBrlaSellNum = numerator;
        s.ratioBrlaSellDen = denominator;
        s.ratiosSetAt = uint64(block.timestamp);
        emit RatioUpdated(5, numerator, denominator, msg.sender);
    }

    // -----------------------------------------------------------------------
    // Governance / configuration (RATIO_SETTER_ROLE ou owner)
    // -----------------------------------------------------------------------

    function setSwapFeeBps(uint256 newFeeBps) external override whenNotPaused {
        DiamondAccessControl.enforceRoleOrOwner(RATIO_SETTER_ROLE_HASH);
        if (newFeeBps > BPS_DENOMINATOR) revert InvalidFeeBps();
        CASSwapStorage.Data storage s = CASSwapStorage.layout();
        uint256 oldFeeBps = s.swapFeeBps;
        s.swapFeeBps = newFeeBps;
        emit SwapFeeUpdated(oldFeeBps, newFeeBps);
    }

    function setMaxImpactBps(uint256 newMaxImpactBps) external override whenNotPaused {
        DiamondAccessControl.enforceRoleOrOwner(RATIO_SETTER_ROLE_HASH);
        if (newMaxImpactBps > BPS_DENOMINATOR) revert InvalidImpactBps();
        CASSwapStorage.Data storage s = CASSwapStorage.layout();
        uint256 oldMaxImpactBps = s.maxImpactBps;
        s.maxImpactBps = newMaxImpactBps;
        emit MaxImpactBpsUpdated(oldMaxImpactBps, newMaxImpactBps);
    }

    function setAllSwapRatios(
        uint256 polBuyNum,
        uint256 polBuyDen,
        uint256 usdcBuyNum,
        uint256 usdcBuyDen,
        uint256 polSellNum,
        uint256 polSellDen,
        uint256 usdcSellNum,
        uint256 usdcSellDen
    ) external override whenNotPaused {
        DiamondAccessControl.enforceRoleOrOwner(RATIO_SETTER_ROLE_HASH);
        if (polBuyNum == 0 || polBuyDen == 0) revert InvalidRatioArg();
        if (usdcBuyNum == 0 || usdcBuyDen == 0) revert InvalidRatioArg();
        if (polSellNum == 0 || polSellDen == 0) revert InvalidRatioArg();
        if (usdcSellNum == 0 || usdcSellDen == 0) revert InvalidRatioArg();
        _requireNormalSpread(CURRENCY_POL, polBuyNum, polBuyDen, polSellNum, polSellDen);
        _requireNormalSpread(CURRENCY_USDC, usdcBuyNum, usdcBuyDen, usdcSellNum, usdcSellDen);

        CASSwapStorage.Data storage s = CASSwapStorage.layout();
        _requireRatioWithinImpact(s.ratioPolNum, s.ratioPolDen, polBuyNum, polBuyDen, s.maxImpactBps);
        _requireRatioWithinImpact(s.ratioUsdcNum, s.ratioUsdcDen, usdcBuyNum, usdcBuyDen, s.maxImpactBps);
        _requireRatioWithinImpact(s.ratioPolSellNum, s.ratioPolSellDen, polSellNum, polSellDen, s.maxImpactBps);
        _requireRatioWithinImpact(s.ratioUsdcSellNum, s.ratioUsdcSellDen, usdcSellNum, usdcSellDen, s.maxImpactBps);

        s.ratioPolNum = polBuyNum;
        s.ratioPolDen = polBuyDen;
        s.ratioUsdcNum = usdcBuyNum;
        s.ratioUsdcDen = usdcBuyDen;
        s.ratioPolSellNum = polSellNum;
        s.ratioPolSellDen = polSellDen;
        s.ratioUsdcSellNum = usdcSellNum;
        s.ratioUsdcSellDen = usdcSellDen;
        s.ratiosSetAt = uint64(block.timestamp);

        emit RatioUpdated(CURRENCY_POL, polBuyNum, polBuyDen, msg.sender);
        emit RatioUpdated(CURRENCY_USDC, usdcBuyNum, usdcBuyDen, msg.sender);
        emit RatioUpdated(2, polSellNum, polSellDen, msg.sender);
        emit RatioUpdated(3, usdcSellNum, usdcSellDen, msg.sender);
    }

    /// @dev Versão multi-ativo do setter atômico: inclui os ratios buy/sell
    ///      de BRLA. Mantido separado para não alterar o seletor já
    ///      publicado de setAllSwapRatios.
    function setAllSwapRatiosV2(
        uint256 polBuyNum,
        uint256 polBuyDen,
        uint256 usdcBuyNum,
        uint256 usdcBuyDen,
        uint256 brlaBuyNum,
        uint256 brlaBuyDen,
        uint256 polSellNum,
        uint256 polSellDen,
        uint256 usdcSellNum,
        uint256 usdcSellDen,
        uint256 brlaSellNum,
        uint256 brlaSellDen
    ) external whenNotPaused {
        DiamondAccessControl.enforceRoleOrOwner(RATIO_SETTER_ROLE_HASH);
        if (polBuyNum == 0 || polBuyDen == 0) revert InvalidRatioArg();
        if (usdcBuyNum == 0 || usdcBuyDen == 0) revert InvalidRatioArg();
        if (brlaBuyNum == 0 || brlaBuyDen == 0) revert InvalidRatioArg();
        if (polSellNum == 0 || polSellDen == 0) revert InvalidRatioArg();
        if (usdcSellNum == 0 || usdcSellDen == 0) revert InvalidRatioArg();
        if (brlaSellNum == 0 || brlaSellDen == 0) revert InvalidRatioArg();
        _requireNormalSpread(CURRENCY_POL, polBuyNum, polBuyDen, polSellNum, polSellDen);
        _requireNormalSpread(CURRENCY_USDC, usdcBuyNum, usdcBuyDen, usdcSellNum, usdcSellDen);
        _requireNormalSpread(CURRENCY_BRLA, brlaBuyNum, brlaBuyDen, brlaSellNum, brlaSellDen);

        CASSwapStorage.Data storage s = CASSwapStorage.layout();
        if (address(s.brlaToken) == address(0)) revert LibCASSwap.BRLANotConfigured();
        _requireRatioWithinImpact(s.ratioPolNum, s.ratioPolDen, polBuyNum, polBuyDen, s.maxImpactBps);
        _requireRatioWithinImpact(s.ratioUsdcNum, s.ratioUsdcDen, usdcBuyNum, usdcBuyDen, s.maxImpactBps);
        _requireRatioWithinImpact(s.ratioBrlaNum, s.ratioBrlaDen, brlaBuyNum, brlaBuyDen, s.maxImpactBps);
        _requireRatioWithinImpact(s.ratioPolSellNum, s.ratioPolSellDen, polSellNum, polSellDen, s.maxImpactBps);
        _requireRatioWithinImpact(s.ratioUsdcSellNum, s.ratioUsdcSellDen, usdcSellNum, usdcSellDen, s.maxImpactBps);
        _requireRatioWithinImpact(s.ratioBrlaSellNum, s.ratioBrlaSellDen, brlaSellNum, brlaSellDen, s.maxImpactBps);

        s.ratioPolNum = polBuyNum;
        s.ratioPolDen = polBuyDen;
        s.ratioUsdcNum = usdcBuyNum;
        s.ratioUsdcDen = usdcBuyDen;
        s.ratioBrlaNum = brlaBuyNum;
        s.ratioBrlaDen = brlaBuyDen;
        s.ratioPolSellNum = polSellNum;
        s.ratioPolSellDen = polSellDen;
        s.ratioUsdcSellNum = usdcSellNum;
        s.ratioUsdcSellDen = usdcSellDen;
        s.ratioBrlaSellNum = brlaSellNum;
        s.ratioBrlaSellDen = brlaSellDen;
        s.ratiosSetAt = uint64(block.timestamp);

        emit RatioUpdated(CURRENCY_POL, polBuyNum, polBuyDen, msg.sender);
        emit RatioUpdated(CURRENCY_USDC, usdcBuyNum, usdcBuyDen, msg.sender);
        emit RatioUpdated(4, brlaBuyNum, brlaBuyDen, msg.sender);
        emit RatioUpdated(2, polSellNum, polSellDen, msg.sender);
        emit RatioUpdated(3, usdcSellNum, usdcSellDen, msg.sender);
        emit RatioUpdated(5, brlaSellNum, brlaSellDen, msg.sender);
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
    // Swaps: BRLA
    // -----------------------------------------------------------------------

    function buyCASWithBRLA(uint256 brlaAmount, uint256 minCasOut, uint256 deadline)
        external
        nonReentrant
        whenNotPaused
        ensureDeadline(deadline)
        returns (uint256 casReceived)
    {
        uint256 fee;
        (casReceived, fee) = LibCASSwap.buyWithBrla(CASSwapStorage.layout(), msg.sender, brlaAmount, minCasOut, msg.sender);
        emit CASBoughtWithBRLA(msg.sender, brlaAmount, casReceived, fee);
    }

    function sellCASForBRLA(uint256 casAmount, uint256 minBrlaOut, uint256 deadline)
        external
        nonReentrant
        whenNotPaused
        ensureDeadline(deadline)
        returns (uint256 brlaReceived)
    {
        uint256 fee;
        (brlaReceived, fee) = LibCASSwap.sellForBrla(CASSwapStorage.layout(), msg.sender, casAmount, minBrlaOut, msg.sender);
        emit CASSoldForBRLA(msg.sender, casAmount, brlaReceived, fee);
    }

    // -----------------------------------------------------------------------
    // Swap genérico multi-ativo (CAS como moeda-pivô)
    // -----------------------------------------------------------------------

    /**
     * @notice Swap entre quaisquer dois ativos suportados.
     * @dev    currencyIn/currencyOut: 0 = POL, 1 = USDC, 2 = BRLA, 3 = CAS.
     *         Rotas com CAS usam uma perna; rotas entre ativos cotados
     *         compõem `in -> CAS -> out` (CAS é unidade de conta, sua
     *         reserva não se move) e aplicam o buy-ratio do ativo de
     *         entrada + sell-ratio do de saída, com a fee cobrada uma
     *         única vez sobre o input. msg.value deve ser igual a
     *         `amountIn` somente quando currencyIn == POL.
     */
    function swapExact(
        uint8 currencyIn,
        uint8 currencyOut,
        uint256 amountIn,
        uint256 minOut,
        uint256 deadline
    )
        external
        payable
        nonReentrant
        whenNotPaused
        ensureDeadline(deadline)
        returns (uint256 amountOut)
    {
        if (currencyIn == CURRENCY_POL) {
            if (msg.value != amountIn) revert MsgValueMismatch(amountIn, msg.value);
        } else if (msg.value != 0) {
            revert MsgValueMismatch(0, msg.value);
        }

        CASSwapStorage.Data storage s = CASSwapStorage.layout();
        uint256 fee;
        (amountOut, fee) = LibCASSwap.swapExact(s, msg.sender, currencyIn, currencyOut, amountIn, minOut, msg.sender);

        // Eventos específicos de par preservam a compatibilidade com os
        // indexadores das rotas CAS <-> POL/USDC já existentes.
        if (currencyOut == CURRENCY_CAS) {
            if (currencyIn == CURRENCY_POL) emit CASBoughtWithPOL(msg.sender, amountIn, amountOut, fee);
            else if (currencyIn == CURRENCY_USDC) emit CASBoughtWithUSDC(msg.sender, amountIn, amountOut, fee);
            else emit CASBoughtWithBRLA(msg.sender, amountIn, amountOut, fee);
        } else if (currencyIn == CURRENCY_CAS) {
            if (currencyOut == CURRENCY_POL) emit CASSoldForPOL(msg.sender, amountIn, amountOut, fee);
            else if (currencyOut == CURRENCY_USDC) emit CASSoldForUSDC(msg.sender, amountIn, amountOut, fee);
            else emit CASSoldForBRLA(msg.sender, amountIn, amountOut, fee);
        }
        emit SwapExecuted(msg.sender, currencyIn, currencyOut, amountIn, amountOut, fee);
    }

    /// @notice Cotação de um swap sem executá-lo (mesma matemática de swapExact).
    function quoteSwap(uint8 currencyIn, uint8 currencyOut, uint256 amountIn)
        external
        view
        returns (uint256 amountOut, uint256 fee)
    {
        return LibCASSwap.quoteSwap(CASSwapStorage.layout(), currencyIn, currencyOut, amountIn);
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
        } else if (currencyOut == CURRENCY_BRLA) {
            (amountOut, fee) = LibCASSwap.sellForBrla(s, msg.sender, casAmount, minOut, msg.sender);
            emit CASSoldForBRLA(msg.sender, casAmount, amountOut, fee);
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
        } else if (currencyIn == CURRENCY_BRLA) {
            if (msg.value != 0) revert MsgValueMismatch(0, msg.value);
            (casReceived, fee) = LibCASSwap.buyWithBrla(s, msg.sender, amountIn, minCasOut, msg.sender);
            emit CASBoughtWithBRLA(msg.sender, amountIn, casReceived, fee);
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

    function getRatioBRLA() external view returns (uint256 numerator, uint256 denominator) {
        CASSwapStorage.Data storage s = CASSwapStorage.layout();
        return (s.ratioBrlaNum, s.ratioBrlaDen);
    }

    function getRatioBRLASell() external view returns (uint256 numerator, uint256 denominator) {
        CASSwapStorage.Data storage s = CASSwapStorage.layout();
        if (s.ratioBrlaSellNum != 0 && s.ratioBrlaSellDen != 0) {
            return (s.ratioBrlaSellNum, s.ratioBrlaSellDen);
        }
        return (s.ratioBrlaNum, s.ratioBrlaDen);
    }

    /// @notice Endereço do token BRLA configurado (address(0) se não configurado).
    function getBRLAToken() external view returns (address) {
        return address(CASSwapStorage.layout().brlaToken);
    }

    /**
     * @notice CAS recebidos por 1 token inteiro do ativo, no lado de compra
     *         (currency -> CAS), já normalizado pelos decimais do ativo.
     * @dev    POL e BRLA (18 dec): retorna o buy-ratio num/den direto.
     *         USDC (6 dec): den multiplicado por 1e12, pois o ratio on-chain
     *         é expresso em base units. CAS retorna (1, 1).
     *         Para cotações direcionais completas (incluindo fee e sell
     *         spread), use `quoteSwap`.
     */
    function getCasRate(uint8 currency) external view returns (uint256 numerator, uint256 denominator) {
        if (currency == CURRENCY_CAS) return (1, 1);
        CASSwapStorage.Data storage s = CASSwapStorage.layout();
        (numerator, denominator) = LibCASSwap.buyRatioFor(s, currency);
        if (currency == CURRENCY_USDC) denominator = denominator * 1e12;
    }

    function getSwapFeeBps() external view override returns (uint256) {
        return CASSwapStorage.layout().swapFeeBps;
    }

    /// @notice Reservas de todos os ativos suportados (brla = 0 se não configurado).
    function getReservesMulti()
        external
        view
        returns (uint256 casBalance, uint256 polBalance, uint256 usdcBalance, uint256 brlaBalance)
    {
        CASSwapStorage.Data storage s = CASSwapStorage.layout();
        casBalance = address(s.casToken) == address(0) ? 0 : s.casToken.balanceOf(address(this));
        polBalance = address(this).balance;
        usdcBalance = address(s.usdcToken) == address(0) ? 0 : s.usdcToken.balanceOf(address(this));
        brlaBalance = address(s.brlaToken) == address(0) ? 0 : s.brlaToken.balanceOf(address(this));
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
