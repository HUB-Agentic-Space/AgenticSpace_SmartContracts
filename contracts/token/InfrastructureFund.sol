// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { PausableUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import { ReentrancyGuardTransient } from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import { AccessControlEnumerableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IInfrastructureFund } from "../interfaces/IInfrastructureFund.sol";

/**
 * @title InfrastructureFund
 * @dev Treasury do Agentic Space que gerencia receitas em CAS (ERC-20) e POL (nativo).
 *      Funds are used for infrastructure maintenance and can be transferred
 *      to the Rapport address or the author address by authorized roles.
 *
 *      Padrões: Proxy (UUPS), Strategy (CAS vs native), Observer (events)
 *
 *      Roles:
 *      - DEFAULT_ADMIN_ROLE: gerencia roles e endereços
 *      - TREASURER_ROLE: pode transferir fundos
 *      - PAUSER_ROLE: pode pausar
 */
contract InfrastructureFund is
    Initializable,
    PausableUpgradeable,
    ReentrancyGuardTransient,
    AccessControlEnumerableUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    bytes32 public constant TREASURER_ROLE = keccak256("TREASURER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    IERC20 public casToken;
    IERC20 public wethToken;
    address public rapportAddress;
    address public authorAddress;

    error ZeroAddress();
    error TransferToZeroAddress();
    error InsufficientCasBalance(uint256 available, uint256 required);
    error InsufficientNativeBalance(uint256 available, uint256 required);
    error InsufficientWethBalance(uint256 available, uint256 required);
    error ZeroAmount();
    error WethNotSupported();

    event CasReceived(address indexed from, uint256 amount);
    event NativeReceived(address indexed from, uint256 amount);
    event WethReceived(address indexed from, uint256 amount);
    event CasTransferred(address indexed to, uint256 amount);
    event NativeTransferred(address indexed to, uint256 amount);
    event WethTransferred(address indexed to, uint256 amount);
    event RapportAddressUpdated(address indexed oldAddress, address indexed newAddress);
    event AuthorAddressUpdated(address indexed oldAddress, address indexed newAddress);
    event WethTokenUpdated(address indexed oldAddress, address indexed newAddress);

    // -----------------------------------------------------------------------
    // Initializer
    // -----------------------------------------------------------------------

    /**
     * @dev Inicializa o InfrastructureFund.
     * @param admin Administrador do fundo.
     * @param casTokenAddress Endereço do contrato CAS.
     * @param rapport Endereço da Rapport.
     * @param author Endereço do autor do contrato.
     */
    function initialize(
        address admin,
        address casTokenAddress,
        address rapport,
        address author
    ) public initializer {
        if (admin == address(0)) revert ZeroAddress();
        if (casTokenAddress == address(0)) revert ZeroAddress();
        if (rapport == address(0)) revert ZeroAddress();
        if (author == address(0)) revert ZeroAddress();

        __Pausable_init();
        __AccessControlEnumerable_init();

        casToken = IERC20(casTokenAddress);
        rapportAddress = rapport;
        authorAddress = author;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(TREASURER_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
    }

    // -----------------------------------------------------------------------
    // Deposit
    // -----------------------------------------------------------------------

    /**
     * @dev Deposita tokens CAS no fundo via transferFrom.
     * @param amount Quantidade em wei.
     */
    function depositCas(uint256 amount) external whenNotPaused {
        if (amount == 0) revert ZeroAmount();

        casToken.safeTransferFrom(msg.sender, address(this), amount);
        emit CasReceived(msg.sender, amount);
    }

    /**
     * @dev Deposita POL nativo no fundo.
     */
    function depositNative() external payable nonReentrant whenNotPaused {
        if (msg.value == 0) revert ZeroAmount();

        emit NativeReceived(msg.sender, msg.value);
    }

    // -----------------------------------------------------------------------
    // Transfer CAS
    // -----------------------------------------------------------------------

    /**
     * @dev Transfere CAS para o endereço da Rapport.
     * @param amount Quantidade em wei.
     */
    function transferCasToRapport(uint256 amount) external onlyRole(TREASURER_ROLE) whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        if (rapportAddress == address(0)) revert TransferToZeroAddress();

        uint256 bal = casToken.balanceOf(address(this));
        if (bal < amount) revert InsufficientCasBalance(bal, amount);

        casToken.safeTransfer(rapportAddress, amount);
        emit CasTransferred(rapportAddress, amount);
    }

    /**
     * @dev Transfere CAS para o endereço do autor.
     * @param amount Quantidade em wei.
     */
    function transferCasToAuthor(uint256 amount) external onlyRole(TREASURER_ROLE) whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        if (authorAddress == address(0)) revert TransferToZeroAddress();

        uint256 bal = casToken.balanceOf(address(this));
        if (bal < amount) revert InsufficientCasBalance(bal, amount);

        casToken.safeTransfer(authorAddress, amount);
        emit CasTransferred(authorAddress, amount);
    }

    // -----------------------------------------------------------------------
    // Transfer Native (POL)
    // -----------------------------------------------------------------------

    /**
     * @dev Transfere POL nativo para o endereço da Rapport.
     * @param amount Quantidade em wei.
     */
    function transferNativeToRapport(uint256 amount) external nonReentrant onlyRole(TREASURER_ROLE) whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        if (rapportAddress == address(0)) revert TransferToZeroAddress();

        uint256 bal = address(this).balance;
        if (bal < amount) revert InsufficientNativeBalance(bal, amount);

        (bool sent, ) = rapportAddress.call{value: amount}("");
        require(sent, "InfrastructureFund: native transfer failed");
        emit NativeTransferred(rapportAddress, amount);
    }

    /**
     * @dev Transfere POL nativo para o endereço do autor.
     * @param amount Quantidade em wei.
     */
    function transferNativeToAuthor(uint256 amount) external nonReentrant onlyRole(TREASURER_ROLE) whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        if (authorAddress == address(0)) revert TransferToZeroAddress();

        uint256 bal = address(this).balance;
        if (bal < amount) revert InsufficientNativeBalance(bal, amount);

        (bool sent, ) = authorAddress.call{value: amount}("");
        require(sent, "InfrastructureFund: native transfer failed");
        emit NativeTransferred(authorAddress, amount);
    }

    // -----------------------------------------------------------------------
    // Deposit WETH (mainnet only — wethToken must be set)
    // -----------------------------------------------------------------------

    /**
     * @dev Deposita WETH no fundo via transferFrom.
     *      Reverte se wethToken não estiver configurado (testnet fallback).
     * @param amount Quantidade em wei.
     */
    function depositWeth(uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        if (address(wethToken) == address(0)) revert WethNotSupported();

        wethToken.safeTransferFrom(msg.sender, address(this), amount);
        emit WethReceived(msg.sender, amount);
    }

    // -----------------------------------------------------------------------
    // Transfer WETH
    // -----------------------------------------------------------------------

    function transferWethToRapport(uint256 amount) external nonReentrant onlyRole(TREASURER_ROLE) whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        if (rapportAddress == address(0)) revert TransferToZeroAddress();
        if (address(wethToken) == address(0)) revert WethNotSupported();

        uint256 bal = wethToken.balanceOf(address(this));
        if (bal < amount) revert InsufficientWethBalance(bal, amount);

        wethToken.safeTransfer(rapportAddress, amount);
        emit WethTransferred(rapportAddress, amount);
    }

    function transferWethToAuthor(uint256 amount) external nonReentrant onlyRole(TREASURER_ROLE) whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        if (authorAddress == address(0)) revert TransferToZeroAddress();
        if (address(wethToken) == address(0)) revert WethNotSupported();

        uint256 bal = wethToken.balanceOf(address(this));
        if (bal < amount) revert InsufficientWethBalance(bal, amount);

        wethToken.safeTransfer(authorAddress, amount);
        emit WethTransferred(authorAddress, amount);
    }

    // -----------------------------------------------------------------------
    // Configuration
    // -----------------------------------------------------------------------

    /**
     * @dev Atualiza o endereço da Rapport.
     * @param newRapport Novo endereço.
     */
    function setRapportAddress(address newRapport) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newRapport == address(0)) revert TransferToZeroAddress();

        address old = rapportAddress;
        rapportAddress = newRapport;
        emit RapportAddressUpdated(old, newRapport);
    }

    /**
     * @dev Atualiza o endereço do autor.
     * @param newAuthor Novo endereço.
     */
    function setAuthorAddress(address newAuthor) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newAuthor == address(0)) revert TransferToZeroAddress();

        address old = authorAddress;
        authorAddress = newAuthor;
        emit AuthorAddressUpdated(old, newAuthor);
    }

    /**
     * @dev Atualiza o endereço do WETH token.
     *      Use address(0) para desativar WETH (testnet fallback).
     * @param newWeth Novo endereço do WETH ou zero para desativar.
     */
    function setWethToken(address newWeth) external onlyRole(DEFAULT_ADMIN_ROLE) {
        address old = address(wethToken);
        wethToken = IERC20(newWeth);
        emit WethTokenUpdated(old, newWeth);
    }

    // -----------------------------------------------------------------------
    // View
    // -----------------------------------------------------------------------

    function casBalance() external view returns (uint256) {
        return casToken.balanceOf(address(this));
    }

    function nativeBalance() external view returns (uint256) {
        return address(this).balance;
    }

    function wethBalance() external view returns (uint256) {
        if (address(wethToken) == address(0)) return 0;
        return wethToken.balanceOf(address(this));
    }

    // -----------------------------------------------------------------------
    // Pausable
    // -----------------------------------------------------------------------

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // -----------------------------------------------------------------------
    // UUPS authorization
    // -----------------------------------------------------------------------

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

    // -----------------------------------------------------------------------
    // Receive — accept direct POL transfers (e.g. from CASSwap.withdrawPOL)
    // -----------------------------------------------------------------------

    receive() external payable {
        emit NativeReceived(msg.sender, msg.value);
    }
}
