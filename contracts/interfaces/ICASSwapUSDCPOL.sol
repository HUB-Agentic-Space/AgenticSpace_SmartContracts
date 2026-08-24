// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

/**
 * @title ICASSwapUSDCPOL
 * @dev Interface do facet de swap CAS <-> USDC / POL (Rapport Trader) no
 *      Diamond do Agentic Space. Cobre swaps, resgate genérico, definição de
 *      ratio pelo backend e suporte de preço via reserva. Rede: Polygon PoS.
 *
 *      Currency: 0 = POL (nativo), 1 = USDC (ERC-20 nativo Polygon).
 */
interface ICASSwapUSDCPOL {
    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    event CASSwapUSDCPOLInitialized(address indexed casToken, address indexed usdcToken);
    event RatioUpdated(uint8 indexed pair, uint256 numerator, uint256 denominator, address indexed updater);
    event SwapFeeUpdated(uint256 oldFeeBps, uint256 newFeeBps);

    event CASBoughtWithPOL(address indexed buyer, uint256 polIn, uint256 casOut, uint256 fee);
    event CASSoldForPOL(address indexed seller, uint256 casIn, uint256 polOut, uint256 fee);
    event CASBoughtWithUSDC(address indexed buyer, uint256 usdcIn, uint256 casOut, uint256 fee);
    event CASSoldForUSDC(address indexed seller, uint256 casIn, uint256 usdcOut, uint256 fee);

    event SupportSwapExecuted(uint8 indexed reserveCurrency, uint256 amount, address indexed to);

    // -----------------------------------------------------------------------
    // Init
    // -----------------------------------------------------------------------

    function initCASSwapUSDCPOL(address casToken, address usdcToken) external;

    // -----------------------------------------------------------------------
    // Backend-controlled ratio
    // -----------------------------------------------------------------------

    function setSwapRatio(uint256 numerator, uint256 denominator) external;
    function setSwapRatioUSDC(uint256 numerator, uint256 denominator) external;
    function setSwapRatioSell(uint256 numerator, uint256 denominator) external;
    function setSwapRatioUSDCSell(uint256 numerator, uint256 denominator) external;

    // -----------------------------------------------------------------------
    // Swaps
    // -----------------------------------------------------------------------

    function buyCASWithPOL(uint256 minCasOut, uint256 deadline) external payable returns (uint256 casReceived);
    function sellCASForPOL(uint256 casAmount, uint256 minPolOut, uint256 deadline) external returns (uint256 polReceived);
    function buyCASWithUSDC(uint256 usdcAmount, uint256 minCasOut, uint256 deadline) external returns (uint256 casReceived);
    function sellCASForUSDC(uint256 casAmount, uint256 minUsdcOut, uint256 deadline) external returns (uint256 usdcReceived);

    function redeemCAS(uint256 casAmount, uint8 currencyOut, uint256 minOut, uint256 deadline) external returns (uint256 amountOut);
    function redeemForCAS(uint8 currencyIn, uint256 amountIn, uint256 minCasOut, uint256 deadline) external payable returns (uint256 casReceived);

    // -----------------------------------------------------------------------
    // Support (DCA via reserva)
    // -----------------------------------------------------------------------

    function supportSwap(uint8 reserveCurrency, uint256 amount, address to) external;

    // -----------------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------------

    function getRatio() external view returns (uint256 numerator, uint256 denominator);
    function getRatioUSDC() external view returns (uint256 numerator, uint256 denominator);
    function getRatioSell() external view returns (uint256 numerator, uint256 denominator);
    function getRatioUSDCSell() external view returns (uint256 numerator, uint256 denominator);
    function getSwapFeeBps() external view returns (uint256);
    function getReserves() external view returns (uint256 casBalance, uint256 usdcBalance, uint256 polBalance);
    function isSwapPaused() external view returns (bool);
    function RATIO_SETTER_ROLE() external pure returns (bytes32);
}
