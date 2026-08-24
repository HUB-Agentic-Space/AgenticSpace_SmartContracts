// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { IFaucet } from "./IFaucet.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title Faucet
 * @dev Faucet avulso para distribuição de POL nativo na rede Polygon.
 *      Permite que qualquer endereço solicite saques com intervalo de cooldown
 *      e valor configuráveis. Inclui blacklist para bloqueio de endereços.
 *
 *      Baseado no artigo:
 *      https://www.luiztools.com.br/post/como-criar-seu-proprio-faucet-de-criptomoedas-com-solidity/
 *
 *      Segurança:
 *      - Padrão Checks-Effects-Interactions para prevenir reentrância
 *      - msg.sender em vez de tx.origin
 *      - Custom errors para gas eficiente
 *      - Validação de input em todas as funções
 *      - Eventos para todas as mutações de estado
 *
 *      Padrões: Ownable (Gang of Four), Strategy (configurável via setter)
 */
contract Faucet is IFaucet, ReentrancyGuard {
    // -----------------------------------------------------------------------
    // State variables
    // -----------------------------------------------------------------------

    address private _owner;
    uint256 public override interval;
    uint256 public override amount;

    mapping(address => uint256) public override nextTry;
    mapping(address => bool) public override isBlacklisted;

    bool private _paused;

    // -----------------------------------------------------------------------
    // Modifiers
    // -----------------------------------------------------------------------

    modifier onlyOwner() {
        if (msg.sender != _owner) revert NotOwner(msg.sender);
        _;
    }

    modifier whenNotPaused() {
        if (_paused) revert FaucetIsPaused();
        _;
    }

    // -----------------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------------

    /**
     * @dev Inicializa o faucet com intervalo e quantidade de saque.
     * @param _interval Tempo mínimo entre saques, em segundos.
     * @param _amount Quantidade de POL por saque, em wei.
     */
    constructor(uint256 _interval, uint256 _amount) {
        if (_interval == 0) revert InvalidInterval(_interval);
        if (_amount == 0) revert InvalidAmount(_amount);

        _owner = msg.sender;
        interval = _interval;
        amount = _amount;

        emit OwnershipTransferred(address(0), msg.sender);
        emit IntervalUpdated(0, _interval);
        emit AmountUpdated(0, _amount);
    }

    // -----------------------------------------------------------------------
    // Admin functions
    // -----------------------------------------------------------------------

    /**
     * @dev Transfere ownership do faucet. Apenas o owner atual.
     * @param newOwner Endereço do novo owner.
     */
    function transferOwnership(address newOwner) external override onlyOwner {
        if (newOwner == address(0)) revert OwnerCannotBeZeroAddress();
        address prev = _owner;
        _owner = newOwner;
        emit OwnershipTransferred(prev, newOwner);
    }

    /**
     * @dev Atualiza o intervalo de cooldown entre saques. Apenas owner.
     * @param _interval Novo intervalo em segundos (deve ser > 0).
     */
    function setInterval(uint256 _interval) external override onlyOwner {
        if (_interval == 0) revert InvalidInterval(_interval);
        uint256 old = interval;
        interval = _interval;
        emit IntervalUpdated(old, _interval);
    }

    /**
     * @dev Atualiza a quantidade de POL por saque. Apenas owner.
     * @param _amount Nova quantidade em wei (deve ser > 0).
     */
    function setAmount(uint256 _amount) external override onlyOwner {
        if (_amount == 0) revert InvalidAmount(_amount);
        uint256 old = amount;
        amount = _amount;
        emit AmountUpdated(old, _amount);
    }

    /**
     * @dev Adiciona ou remove um endereço da blacklist. Apenas owner.
     * @param account Endereço a ser atualizado.
     * @param _isBlacklisted true para bloquear, false para desbloquear.
     */
    function setBlacklist(address account, bool _isBlacklisted) external override onlyOwner {
        isBlacklisted[account] = _isBlacklisted;
        emit BlacklistUpdated(account, _isBlacklisted);
    }

    function pause() external onlyOwner {
        _paused = true;
        emit FaucetPaused();
    }

    function unpause() external onlyOwner {
        _paused = false;
        emit FaucetUnpaused();
    }

    function isPaused() external view returns (bool) {
        return _paused;
    }

    /**
     * @dev Define manualmente o próximo horário de saque de um endereço.
     *      Útil para resetar cooldown ou bloquear temporariamente um endereço.
     * @param account Endereço alvo.
     * @param timestamp Timestamp do próximo saque permitido.
     */
    function setNextTry(address account, uint256 timestamp) external override onlyOwner {
        nextTry[account] = timestamp;
    }

    /**
     * @dev Permite ao owner sacar fundos do faucet em caso de emergência.
     * @param _amount Quantidade de POL a sacar, em wei.
     */
    function withdrawFunds(uint256 _amount) external override onlyOwner {
        uint256 balance = address(this).balance;
        if (balance == 0) revert NoFundsToWithdraw();
        if (balance < _amount) revert InsufficientFunds(balance, _amount);

        (bool success, ) = payable(_owner).call{value: _amount}("");
        require(success, "Transfer failed");

        emit FundsWithdrawn(_owner, _amount);
    }

    // -----------------------------------------------------------------------
    // Public functions
    // -----------------------------------------------------------------------

    /**
     * @dev Solicita saque de POL do faucet.
     *      Segue o padrão Checks-Effects-Interactions:
     *      1. Validações (checks)
     *      2. Atualização do nextTry (effects)
     *      3. Transferência (interactions)
     */
    function requestTokens() external override nonReentrant whenNotPaused {
        // --- Checks ---
        if (isBlacklisted[msg.sender]) revert Blacklisted(msg.sender);
        if (block.timestamp < nextTry[msg.sender]) {
            revert CooldownNotElapsed(msg.sender, nextTry[msg.sender]);
        }
        uint256 balance = address(this).balance;
        if (balance < amount) revert InsufficientFunds(balance, amount);

        // --- Effects ---
        uint256 nextAvailable = block.timestamp + interval;
        nextTry[msg.sender] = nextAvailable;

        // --- Interactions ---
        (bool success, ) = payable(msg.sender).call{value: amount}("");
        require(success, "Transfer failed");

        emit Withdrawn(msg.sender, amount, nextAvailable);
    }

    // -----------------------------------------------------------------------
    // View functions
    // -----------------------------------------------------------------------

    /**
     * @dev Retorna o saldo de POL do faucet.
     */
    function getBalance() external view override returns (uint256) {
        return address(this).balance;
    }

    /**
     * @dev Retorna o endereço do owner.
     */
    function owner() external view override returns (address) {
        return _owner;
    }

    // -----------------------------------------------------------------------
    // Receive — aceita depósitos de POL para alimentar o faucet
    // -----------------------------------------------------------------------

    receive() external payable {
        emit FundsDeposited(msg.sender, msg.value);
    }
}
