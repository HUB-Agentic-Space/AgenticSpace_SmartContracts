// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { PausableUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import { AccessControlEnumerableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import { ReentrancyGuardTransient } from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IBuybackBurn } from "../interfaces/IBuybackBurn.sol";

/**
 * @title BuybackBurn
 * @dev Compra CAS na DEX com POL nativo e queima os tokens comprados,
 *      criando pressao deflacionaria no token. UUPS upgradeable para
 *      ajustes futuros de parametros e logica de buyback.
 *
 *      Fluxo:
 *      1. OPERATOR_ROLE chama executeBuyback(minCasOut, deadline)
 *      2. Contrato envia POL para o DEX router via swapExactETHForTokens
 *      3. CAS recebido e queimado via burn()
 *      4. Evento BuybackExecuted emitido com detalhes
 *
 *      Seguranca:
 *      - ReentrancyGuard on executeBuyback
 *      - Checks-Effects-Interactions pattern
 *      - Pausable for emergencies
 *      - AccessControl with granular roles
 *      - Custom errors for gas efficiency
 *      - Slippage protection via minCasOut
 *      - Deadline protection against stale transactions
 *      - Max slippage 5% (500 bps) configuravel
 *
 *      Padroes: Strategy (router ajustavel), Adapter (POL nativo),
 *               Factory (CAS binding via initialize)
 *
 *      Roles:
 *      - DEFAULT_ADMIN_ROLE: gerencia roles e upgrade
 *      - OPERATOR_ROLE: executa buyback, ajusta router/slippage/min
 *      - PAUSER_ROLE: pausa/despausa
 *      - TREASURER_ROLE: saque de POL em emergencia
 */
contract BuybackBurn is
    Initializable,
    PausableUpgradeable,
    ReentrancyGuardTransient,
    AccessControlEnumerableUpgradeable,
    UUPSUpgradeable,
    IBuybackBurn
{
    using SafeERC20 for IERC20;

    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant TREASURER_ROLE = keccak256("TREASURER_ROLE");

    /// @dev Basis points denominator (10000 = 100%).
    uint256 public constant BPS_DENOMINATOR = 10000;

    /// @dev Maximum allowed slippage: 5% (500 bps).
    uint256 public constant MAX_SLIPPAGE_BPS = 500;

    /// @dev CAS token to buy and burn.
    IERC20 public casToken;

    /// @dev DEX router (Uniswap V2 compatible: SushiSwap, QuickSwap).
    address public dexRouter;

    /// @dev Wrapped POL (WMATIC/WPOL) address for router path.
    address public wpol;

    /// @dev Slippage tolerance in basis points (default 50 = 0.5%).
    uint256 public slippageBps;

    /// @dev Minimum POL amount per buyback execution (default 5 POL).
    uint256 public minBuybackAmount;

    error ZeroAddress();
    error ZeroAmount();
    error InsufficientPOL(uint256 available, uint256 required);
    error SlippageExceeded(uint256 minExpected, uint256 actual);
    error InvalidSlippage(uint256 bps);
    error DeadlineExpired(uint256 deadline, uint256 currentBlockTime);
    error BelowMinAmount(uint256 provided, uint256 minimum);
    error SwapFailed();

    // -----------------------------------------------------------------------
    // Initializer
    // -----------------------------------------------------------------------

    /**
     * @dev Inicializa o BuybackBurn.
     * @param admin Administrador do contrato.
     * @param casTokenAddress Endereco do CAS Token (ERC-20 com burn).
     * @param dexRouterAddress Endereco do DEX router (Uniswap V2 compatible).
     * @param wpolAddress Endereco do Wrapped POL.
     */
    function initialize(
        address admin,
        address casTokenAddress,
        address dexRouterAddress,
        address wpolAddress
    ) public initializer {
        if (admin == address(0)) revert ZeroAddress();
        if (casTokenAddress == address(0)) revert ZeroAddress();
        if (dexRouterAddress == address(0)) revert ZeroAddress();
        if (wpolAddress == address(0)) revert ZeroAddress();

        __Pausable_init();
        __AccessControlEnumerable_init();

        casToken = IERC20(casTokenAddress);
        dexRouter = dexRouterAddress;
        wpol = wpolAddress;
        slippageBps = 50;
        minBuybackAmount = 5 ether;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(OPERATOR_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
        _grantRole(TREASURER_ROLE, admin);
    }

    // -----------------------------------------------------------------------
    // Buyback: Buy CAS with POL and burn
    // -----------------------------------------------------------------------

    /**
     * @dev Executa buyback: compra CAS na DEX com POL do contrato e queima.
     *      Apenas OPERATOR_ROLE.
     * @param minCasOut Quantidade minima de CAS esperada (slippage protection).
     * @param deadline Timestamp limite para a transacao.
     * @return casBought Quantidade de CAS comprada.
     * @return casBurned Quantidade de CAS queimada (== casBought).
     */
    function executeBuyback(uint256 minCasOut, uint256 deadline)
        external
        override
        nonReentrant
        whenNotPaused
        onlyRole(OPERATOR_ROLE)
        returns (uint256 casBought, uint256 casBurned)
    {
        if (block.timestamp > deadline) revert DeadlineExpired(deadline, block.timestamp);

        uint256 polBalance = address(this).balance;
        if (polBalance < minBuybackAmount) revert BelowMinAmount(polBalance, minBuybackAmount);
        if (minCasOut == 0) revert ZeroAmount();

        // Swap: POL -> WPOL -> CAS via router
        address[] memory path = new address[](2);
        path[0] = wpol;
        path[1] = address(casToken);

        uint256 casBefore = casToken.balanceOf(address(this));

        (bool ok, ) = dexRouter.call{value: polBalance}(
            abi.encodeWithSignature(
                "swapExactETHForTokens(uint256,address[],address,uint256)",
                minCasOut,
                path,
                address(this),
                deadline
            )
        );
        if (!ok) revert SwapFailed();

        casBought = casToken.balanceOf(address(this)) - casBefore;
        if (casBought < minCasOut) revert SlippageExceeded(minCasOut, casBought);

        // Burn the bought CAS
        _burnCAS(casBought);
        casBurned = casBought;

        emit BuybackExecuted(msg.sender, polBalance, casBought, casBurned);
    }

    // -----------------------------------------------------------------------
    // Deposit POL
    // -----------------------------------------------------------------------

    /**
     * @dev Deposita POL no contrato para o fundo de buyback.
     */
    function depositPOL() external payable override {
        if (msg.value == 0) revert ZeroAmount();
        emit POLDeposited(msg.sender, msg.value);
    }

    // -----------------------------------------------------------------------
    // Admin: Operator
    // -----------------------------------------------------------------------

    /**
     * @dev Atualiza o endereco do DEX router.
     *      Apenas OPERATOR_ROLE.
     */
    function setDEXRouter(address newRouter) external override onlyRole(OPERATOR_ROLE) {
        if (newRouter == address(0)) revert ZeroAddress();
        address old = dexRouter;
        dexRouter = newRouter;
        emit RouterUpdated(old, newRouter);
    }

    /**
     * @dev Ajusta a tolerancia de slippage em basis points.
     *      Limitada a MAX_SLIPPAGE_BPS (500 = 5%).
     *      Apenas OPERATOR_ROLE.
     */
    function setSlippageBps(uint256 bps) external override onlyRole(OPERATOR_ROLE) {
        if (bps > MAX_SLIPPAGE_BPS) revert InvalidSlippage(bps);
        uint256 old = slippageBps;
        slippageBps = bps;
        emit SlippageUpdated(old, bps);
    }

    /**
     * @dev Ajusta o valor minimo de POL por execucao de buyback.
     *      Apenas OPERATOR_ROLE.
     */
    function setMinBuybackAmount(uint256 minAmount) external override onlyRole(OPERATOR_ROLE) {
        if (minAmount == 0) revert ZeroAmount();
        uint256 old = minBuybackAmount;
        minBuybackAmount = minAmount;
        emit MinAmountUpdated(old, minAmount);
    }

    // -----------------------------------------------------------------------
    // Admin: Treasurer
    // -----------------------------------------------------------------------

    /**
     * @dev Saca POL do contrato em caso de emergencia.
     *      Apenas TREASURER_ROLE.
     * @param amount Quantidade de POL a sacar.
     */
    function withdrawPOL(uint256 amount) external override onlyRole(TREASURER_ROLE) whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        uint256 bal = address(this).balance;
        if (bal < amount) revert InsufficientPOL(bal, amount);

        (bool sent, ) = payable(msg.sender).call{value: amount}("");
        require(sent, "BuybackBurn: POL withdrawal failed");

        emit POLWithdrawn(msg.sender, amount);
    }

    // -----------------------------------------------------------------------
    // Pausable
    // -----------------------------------------------------------------------

    function pause() external override onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external override onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // -----------------------------------------------------------------------
    // Internal: Burn CAS
    // -----------------------------------------------------------------------

    /**
     * @dev Queima CAS do saldo do contrato.
     *      Usa burn(uint256) do CAS Token.
     */
    function _burnCAS(uint256 amount) internal {
        (bool ok, ) = address(casToken).call(
            abi.encodeWithSignature("burn(uint256)", amount)
        );
        require(ok, "BuybackBurn: CAS burn failed");
    }

    // -----------------------------------------------------------------------
    // View functions
    // -----------------------------------------------------------------------

    function getCasToken() external view override returns (address) {
        return address(casToken);
    }

    function getDexRouter() external view override returns (address) {
        return dexRouter;
    }

    function getWpol() external view override returns (address) {
        return wpol;
    }

    function getSlippageBps() external view override returns (uint256) {
        return slippageBps;
    }

    function getMinBuybackAmount() external view override returns (uint256) {
        return minBuybackAmount;
    }

    function getPOLBalance() external view override returns (uint256) {
        return address(this).balance;
    }

    function isPaused() external view override returns (bool) {
        return paused();
    }

    // -----------------------------------------------------------------------
    // UUPS authorization
    // -----------------------------------------------------------------------

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

    // -----------------------------------------------------------------------
    // Receive — accept direct POL deposits for buyback fund
    // -----------------------------------------------------------------------

    receive() external payable {
        emit POLDeposited(msg.sender, msg.value);
    }
}
