// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

/**
 * @title IBuybackBurn
 * @dev Interface do contrato BuybackBurn — compra CAS na DEX com POL e queima.
 *      UUPS upgradeable para ajustes futuros de parametros e logica.
 *
 *      Autenticacao: requer DEFAULT_ADMIN_ROLE para upgrade, OPERATOR_ROLE
 *      para ajustes de operacao, PAUSER_ROLE para pausa, TREASURER_ROLE
 *      para saque de emergencia. Nao utilizavel por humanos diretamente
 *      (apenas OPERATOR_ROLE chama executeBuyback).
 */
interface IBuybackBurn {
    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    event BuybackExecuted(
        address indexed caller,
        uint256 polSpent,
        uint256 casBought,
        uint256 casBurned
    );
    event RouterUpdated(address indexed oldRouter, address indexed newRouter);
    event SlippageUpdated(uint256 oldBps, uint256 newBps);
    event MinAmountUpdated(uint256 oldMin, uint256 newMin);
    event POLDeposited(address indexed from, uint256 amount);
    event POLWithdrawn(address indexed to, uint256 amount);

    // -----------------------------------------------------------------------
    // Init
    // -----------------------------------------------------------------------

    function initialize(
        address admin,
        address casToken,
        address dexRouter,
        address wpol
    ) external;

    // -----------------------------------------------------------------------
    // Buyback
    // -----------------------------------------------------------------------

    function executeBuyback(uint256 minCasOut, uint256 deadline)
        external
        returns (uint256 casBought, uint256 casBurned);

    function depositPOL() external payable;

    // -----------------------------------------------------------------------
    // Admin — Operator
    // -----------------------------------------------------------------------

    function setDEXRouter(address newRouter) external;
    function setSlippageBps(uint256 bps) external;
    function setMinBuybackAmount(uint256 minAmount) external;

    // -----------------------------------------------------------------------
    // Admin — Treasurer
    // -----------------------------------------------------------------------

    function withdrawPOL(uint256 amount) external;

    // -----------------------------------------------------------------------
    // Admin — Pauser
    // -----------------------------------------------------------------------

    function pause() external;
    function unpause() external;

    // -----------------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------------

    function getCasToken() external view returns (address);
    function getDexRouter() external view returns (address);
    function getWpol() external view returns (address);
    function getSlippageBps() external view returns (uint256);
    function getMinBuybackAmount() external view returns (uint256);
    function getPOLBalance() external view returns (uint256);
    function isPaused() external view returns (bool);

    // -----------------------------------------------------------------------
    // Roles
    // -----------------------------------------------------------------------

    function OPERATOR_ROLE() external view returns (bytes32);
    function PAUSER_ROLE() external view returns (bytes32);
    function TREASURER_ROLE() external view returns (bytes32);
}
