// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { PausableUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import { ReentrancyGuardTransient } from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import { AccessControlEnumerableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ICASSwap } from "../interfaces/ICASSwap.sol";

/**
 * @title CASSwap
 * @dev On-chain swap between CAS (ERC-20) and POL (native) with flexible ratio.
 *
 *      Ratio starts at 1:1 (1 CAS = 1 POL) and can be adjusted to any value > 0
 *      by RATIO_ADMIN_ROLE. There is no fixed limit — the ratio is fully governed
 *      by admins financeiros and the multisig.
 *
 *      Security:
 *      - ReentrancyGuard on all swap functions
 *      - Checks-Effects-Interactions pattern
 *      - Pausable for emergencies
 *      - AccessControl with granular roles
 *      - Custom errors for gas efficiency
 *      - Input validation on all external functions
 *      - POL received from buys stays in contract for sell liquidity;
 *        excess can be withdrawn to InfrastructureFund by TREASURER_ROLE
 *
 *      Padrões: Strategy (ratio ajustável), Adapter (POL nativo),
 *               Factory (CAS binding via initialize)
 *
 *      Roles:
 *      - DEFAULT_ADMIN_ROLE: gerencia roles
 *      - RATIO_ADMIN_ROLE: pode ajustar o ratio do swap
 *      - TREASURER_ROLE: pode sacar POL excedente para InfrastructureFund
 *      - PAUSER_ROLE: pode pausar/despausar
 */
contract CASSwap is
    Initializable,
    PausableUpgradeable,
    ReentrancyGuardTransient,
    AccessControlEnumerableUpgradeable,
    UUPSUpgradeable,
    ICASSwap
{
    using SafeERC20 for IERC20;

    bytes32 public constant RATIO_ADMIN_ROLE = keccak256("RATIO_ADMIN_ROLE");
    bytes32 public constant TREASURER_ROLE = keccak256("TREASURER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @dev Basis points denominator (10000 = 100%).
    uint256 public constant BPS_DENOMINATOR = 10000;

    /// @dev Maximum allowed swap fee: 10% (1000 bps). Protects users from
    ///      confiscatory fees even if an admin key is compromised.
    uint256 public constant MAX_SWAP_FEE_BPS = 1000;

    IERC20 public casToken;

    /// @dev Ratio numerator (CAS per POL). Default: 1.
    uint256 public ratioNumerator;
    /// @dev Ratio denominator (CAS per POL). Default: 1.
    uint256 public ratioDenominator;
    /// @dev Swap fee in basis points (0 = no fee, 100 = 1%).
    uint256 public swapFeeBps;

    /// @dev Infrastructure fund address that receives excess POL.
    address public infrastructureFund;

    error ZeroAddress();
    error ZeroAmount();
    error InsufficientPOLBalance(uint256 available, uint256 required);
    error InsufficientCASBalance(uint256 available, uint256 required);
    error InvalidRatio(uint256 numerator, uint256 denominator);
    error InvalidFee(uint256 feeBps);
    error ExceedsMsgValue(uint256 calculated, uint256 sent);
    error NoFundsToWithdraw();
    error SlippageExceeded(uint256 minExpected, uint256 actual);
    error DeadlineExpired(uint256 deadline, uint256 currentBlockTime);

    event InfrastructureFundUpdated(address indexed oldFund, address indexed newFund);
    event POLReceived(address indexed from, uint256 amount);

    // -----------------------------------------------------------------------
    // Initializer
    // -----------------------------------------------------------------------

    /**
     * @dev Inicializa o CASSwap.
     * @param admin Administrador do swap.
     * @param casTokenAddress Endereço do CAS Token (ERC-20).
     * @param infraFund Endereço do InfrastructureFund para saque de POL excedente.
     */
    function initialize(
        address admin,
        address casTokenAddress,
        address infraFund
    ) public initializer {
        if (admin == address(0)) revert ZeroAddress();
        if (casTokenAddress == address(0)) revert ZeroAddress();
        if (infraFund == address(0)) revert ZeroAddress();

        __Pausable_init();
        __AccessControlEnumerable_init();

        casToken = IERC20(casTokenAddress);
        infrastructureFund = infraFund;
        ratioNumerator = 1;
        ratioDenominator = 1;
        swapFeeBps = 0;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(RATIO_ADMIN_ROLE, admin);
        _grantRole(TREASURER_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
    }

    // -----------------------------------------------------------------------
    // Swap: Buy CAS with POL
    // -----------------------------------------------------------------------

    /**
     * @dev Compra CAS enviando POL. O usuário envia POL e recebe CAS no ratio atual.
     * @return casReceived Quantidade de CAS recebida.
     */
    function buyCAS(uint256 minCasOut, uint256 deadline) external payable nonReentrant whenNotPaused returns (uint256 casReceived) {
        if (block.timestamp > deadline) revert DeadlineExpired(deadline, block.timestamp);
        if (msg.value == 0) revert ZeroAmount();

        uint256 polAmount = msg.value;
        uint256 fee = (polAmount * swapFeeBps) / BPS_DENOMINATOR;
        uint256 polAfterFee = polAmount - fee;

        casReceived = (polAfterFee * ratioNumerator) / ratioDenominator;
        if (casReceived == 0) revert ZeroAmount();
        if (casReceived < minCasOut) revert SlippageExceeded(minCasOut, casReceived);

        uint256 casBal = casToken.balanceOf(address(this));
        if (casBal < casReceived) revert InsufficientCASBalance(casBal, casReceived);

        casToken.safeTransfer(msg.sender, casReceived);

        emit CASBought(msg.sender, polAmount, casReceived, fee);
    }

    // -----------------------------------------------------------------------
    // Swap: Sell CAS for POL
    // -----------------------------------------------------------------------

    /**
     * @dev Vende CAS por POL. O usuário aprova CAS e recebe POL no ratio atual.
     * @param casAmount Quantidade de CAS a vender (em wei).
     * @return polReceived Quantidade de POL recebida.
     */
    function sellCAS(uint256 casAmount, uint256 minPolOut, uint256 deadline) external nonReentrant whenNotPaused returns (uint256 polReceived) {
        if (block.timestamp > deadline) revert DeadlineExpired(deadline, block.timestamp);
        if (casAmount == 0) revert ZeroAmount();

        uint256 polEquivalent = (casAmount * ratioDenominator) / ratioNumerator;
        if (polEquivalent == 0) revert ZeroAmount();

        uint256 fee = (polEquivalent * swapFeeBps) / BPS_DENOMINATOR;
        polReceived = polEquivalent - fee;
        if (polReceived < minPolOut) revert SlippageExceeded(minPolOut, polReceived);

        uint256 polBal = address(this).balance;
        if (polBal < polReceived) revert InsufficientPOLBalance(polBal, polReceived);

        casToken.safeTransferFrom(msg.sender, address(this), casAmount);

        (bool sent, ) = payable(msg.sender).call{value: polReceived}("");
        require(sent, "CASSwap: POL transfer failed");

        emit CASSold(msg.sender, casAmount, polReceived, fee);
    }

    // -----------------------------------------------------------------------
    // Admin: Ratio
    // -----------------------------------------------------------------------

    /**
     * @dev Ajusta o ratio do swap. Ratio flexível: qualquer numerator > 0 e denominator > 0.
     *      Exemplos: 1:1, 1:2, 2:1, 1:10, 5:3, etc.
     *      Apenas RATIO_ADMIN_ROLE.
     * @param numerator Novo numerador do ratio.
     * @param denominator Novo denominador do ratio.
     */
    function setRatio(uint256 numerator, uint256 denominator)
        external
        onlyRole(RATIO_ADMIN_ROLE)
        whenNotPaused
    {
        if (numerator == 0 || denominator == 0) revert InvalidRatio(numerator, denominator);

        ratioNumerator = numerator;
        ratioDenominator = denominator;

        emit RatioUpdated(numerator, denominator);
    }

    // -----------------------------------------------------------------------
    // Admin: Fee
    // -----------------------------------------------------------------------

    /**
     * @dev Ajusta a taxa de swap em basis points (0 = sem taxa, 100 = 1%).
     *      Limitada a MAX_SWAP_FEE_BPS (10%) para proteger usuários.
     *      Apenas DEFAULT_ADMIN_ROLE.
     * @param feeBps Nova taxa em basis points.
     */
    function setSwapFee(uint256 feeBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (feeBps > MAX_SWAP_FEE_BPS) revert InvalidFee(feeBps);

        uint256 old = swapFeeBps;
        swapFeeBps = feeBps;

        emit SwapFeeUpdated(old, feeBps);
    }

    // -----------------------------------------------------------------------
    // Admin: Deposit CAS
    // -----------------------------------------------------------------------

    /**
     * @dev Deposita CAS no swap contract para fornecer liquidez de venda.
     *      O caller deve aprovar o CAS antes de chamar esta função.
     * @param amount Quantidade de CAS a depositar (em wei).
     */
    function depositCAS(uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();

        casToken.safeTransferFrom(msg.sender, address(this), amount);

        emit CASDeposited(msg.sender, amount);
    }

    // -----------------------------------------------------------------------
    // Admin: Withdraw POL
    // -----------------------------------------------------------------------

    /**
     * @dev Saca POL excedente do swap contract para o InfrastructureFund.
     *      Apenas TREASURER_ROLE.
     * @param amount Quantidade de POL a sacar (em wei).
     */
    function withdrawPOL(uint256 amount) external nonReentrant onlyRole(TREASURER_ROLE) whenNotPaused {
        if (amount == 0) revert ZeroAmount();

        uint256 bal = address(this).balance;
        if (bal < amount) revert InsufficientPOLBalance(bal, amount);
        if (infrastructureFund == address(0)) revert ZeroAddress();

        (bool sent, ) = payable(infrastructureFund).call{value: amount}("");
        require(sent, "CASSwap: POL withdrawal failed");

        emit POLWithdrawn(infrastructureFund, amount);
    }

    // -----------------------------------------------------------------------
    // Admin: Withdraw CAS
    // -----------------------------------------------------------------------

    /**
     * @dev Saca CAS excedente do swap contract para um endereço arbitrário.
     *      Apenas DEFAULT_ADMIN_ROLE. Útil para redistribuição de tokens
     *      acumulados no swap que não são necessários como liquidez.
     * @param to Endereço de destino.
     * @param amount Quantidade de CAS a sacar (em wei).
     */
    function withdrawCAS(address to, uint256 amount) external nonReentrant onlyRole(DEFAULT_ADMIN_ROLE) whenNotPaused {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        uint256 bal = casToken.balanceOf(address(this));
        if (bal < amount) revert InsufficientCASBalance(bal, amount);

        casToken.safeTransfer(to, amount);

        emit CASWithdrawn(to, amount);
    }

    // -----------------------------------------------------------------------
    // Admin: Infrastructure Fund
    // -----------------------------------------------------------------------

    /**
     * @dev Atualiza o endereço do InfrastructureFund.
     *      Apenas DEFAULT_ADMIN_ROLE.
     * @param newFund Novo endereço do InfrastructureFund.
     */
    function setInfrastructureFund(address newFund) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newFund == address(0)) revert ZeroAddress();

        address old = infrastructureFund;
        infrastructureFund = newFund;
        emit InfrastructureFundUpdated(old, newFund);
    }

    // -----------------------------------------------------------------------
    // Pausable
    // -----------------------------------------------------------------------

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
        emit PausedStateChanged(true);
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
        emit PausedStateChanged(false);
    }

    // -----------------------------------------------------------------------
    // View functions
    // -----------------------------------------------------------------------

    function getRatio() external view returns (uint256 numerator, uint256 denominator) {
        return (ratioNumerator, ratioDenominator);
    }

    function getSwapFee() external view returns (uint256) {
        return swapFeeBps;
    }

    function getCASBalance() external view returns (uint256) {
        return casToken.balanceOf(address(this));
    }

    function getPOLBalance() external view returns (uint256) {
        return address(this).balance;
    }

    function isPaused() external view returns (bool) {
        return paused();
    }

    // -----------------------------------------------------------------------
    // UUPS authorization
    // -----------------------------------------------------------------------

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

    // -----------------------------------------------------------------------
    // Receive — accept direct POL deposits for liquidity
    // -----------------------------------------------------------------------

    receive() external payable {
        emit POLReceived(msg.sender, msg.value);
    }
}
