// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { ERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import { PausableUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import { AccessControlEnumerableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import { ICASToken } from "../interfaces/ICASToken.sol";

/**
 * @title CASToken
 * @dev CAS (Cryptocoin Agentic Space) — ERC-20 Adaptável (UUPS).
 *      Moeda interna do Agentic Space usada para:
 *      - Transações da DAO (propostas e votação)
 *      - Validação de agentes
 *      - Cadastro de usuários e identificação
 *      - Swap CAS↔POL e liquidez DEX
 *
 *      Aviso: CAS representa investimento em infraestrutura do Agentic Space,
 *      não um ativo especulativo. Compradores contribuem para o funcionamento
 *      de todo o Ecossistema Agentic Space.
 *
 *      Padrões: Proxy (UUPS), Factory (mint controlado por role), Strategy (burn)
 *
 *      Roles:
 *      - DEFAULT_ADMIN_ROLE: gerencia roles e pausa
 *      - MINTER_ROLE: pode cunhar novos tokens (até MAX_SUPPLY)
 *      - PAUSER_ROLE: pode pausar/despausar
 *      - RATIO_ADMIN_ROLE: admins financeiros que podem ajustar ratio do CASSwap
 */
contract CASToken is
    Initializable,
    ERC20Upgradeable,
    PausableUpgradeable,
    AccessControlEnumerableUpgradeable,
    UUPSUpgradeable
{
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant RATIO_ADMIN_ROLE = keccak256("RATIO_ADMIN_ROLE");
    bytes32 public constant COMPLIANCE_ROLE = keccak256("COMPLIANCE_ROLE");

    /// @dev Mapping of frozen accounts (permanent or temporary).
    mapping(address => bool) private _frozenAccounts;

    /// @dev Mapping of freeze end timestamps (0 = permanent freeze).
    mapping(address => uint256) private _freezeUntil;

    /// @dev Global voting lock — when active, all transfers are blocked
    ///      to prevent vote buying during arbitration voting period.
    bool private _votingLockActive;

    /// @dev Supply máximo absoluto: 10,000,000 CAS (10M * 1e18).
    uint256 public constant MAX_SUPPLY = 10_000_000 * 1e18;

    /// @dev Aviso on-chain de que CAS é investimento em infraestrutura.
    string public constant INVESTMENT_DISCLAIMER =
        "CAS represents an investment in Agentic Space infrastructure, not a speculative asset. "
        "By acquiring CAS, you contribute to the operation of the entire Agentic Space Ecosystem. "
        "The CAS/POL ratio starts at 1:1 and may be adjusted by governance.";

    error AdminIsZeroAddress();
    error MintToZeroAddress();
    error BurnFromZeroAddress();
    error BurnExceedsBalance(uint256 balance, uint256 amount);
    error ZeroAmount();
    error MaxSupplyExceeded(uint256 currentSupply, uint256 amount, uint256 maxSupply);
    error AccountFrozen(address account);
    error FreezeUntilMustBeFuture(uint256 provided, uint256 current);
    error CannotFreezeZeroAddress();
    error VotingLockActive();

    event Minted(address indexed to, uint256 amount);
    event Burned(address indexed from, uint256 amount);
    event MaxSupplyAnnounced(uint256 maxSupply);
    event Frozen(address indexed account, uint256 untilTime);
    event Unfrozen(address indexed account);
    event VotingLockStateChanged(bool active);

    // -----------------------------------------------------------------------
    // Initializer
    // -----------------------------------------------------------------------

    /**
     * @dev Inicializa o token CAS com admin e fornecimento inicial.
     * @param admin Endereço do administrador do token.
     * @param initialSupply Fornecimento inicial em wei (cunhado para o admin).
     * @param name Nome do token ("Cryptocoin Agentic Space").
     * @param symbol Símbolo do token ("CAS").
     */
    function initialize(
        address admin,
        uint256 initialSupply,
        string memory name,
        string memory symbol
    ) public initializer {
        if (admin == address(0)) revert AdminIsZeroAddress();

        __ERC20_init(name, symbol);
        __Pausable_init();
        __AccessControlEnumerable_init();

        if (initialSupply > MAX_SUPPLY) revert MaxSupplyExceeded(0, initialSupply, MAX_SUPPLY);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
        _grantRole(RATIO_ADMIN_ROLE, admin);

        emit MaxSupplyAnnounced(MAX_SUPPLY);

        if (initialSupply > 0) {
            _mint(admin, initialSupply);
        }
    }

    // -----------------------------------------------------------------------
    // Mint
    // -----------------------------------------------------------------------

    /**
     * @dev Cunha novos tokens CAS. Apenas MINTER_ROLE.
     * @param to Endereço de destino.
     * @param amount Quantidade em wei.
     */
    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) whenNotPaused {
        if (to == address(0)) revert MintToZeroAddress();
        if (amount == 0) revert ZeroAmount();
        uint256 newSupply = totalSupply() + amount;
        if (newSupply > MAX_SUPPLY) revert MaxSupplyExceeded(totalSupply(), amount, MAX_SUPPLY);

        _mint(to, amount);
        emit Minted(to, amount);
    }

    // -----------------------------------------------------------------------
    // Burn
    // -----------------------------------------------------------------------

    /**
     * @dev Queima tokens do próprio saldo.
     * @param amount Quantidade em wei.
     */
    function burn(uint256 amount) external whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        uint256 bal = balanceOf(msg.sender);
        if (bal < amount) revert BurnExceedsBalance(bal, amount);

        _burn(msg.sender, amount);
        emit Burned(msg.sender, amount);
    }

    /**
     * @dev Queima tokens de um endereço com allowance.
     * @param from Endereço de origem.
     * @param amount Quantidade em wei.
     */
    function burnFrom(address from, uint256 amount) external whenNotPaused {
        if (from == address(0)) revert BurnFromZeroAddress();
        if (amount == 0) revert ZeroAmount();
        uint256 bal = balanceOf(from);
        if (bal < amount) revert BurnExceedsBalance(bal, amount);

        _spendAllowance(from, msg.sender, amount);
        _burn(from, amount);
        emit Burned(from, amount);
    }

    // -----------------------------------------------------------------------
    // Pausable overrides
    // -----------------------------------------------------------------------

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // -----------------------------------------------------------------------
    // ERC-20 overrides (pause-aware)
    // -----------------------------------------------------------------------

    function _update(address from, address to, uint256 value) internal override {
        if (paused()) revert EnforcedPause();

        if (_votingLockActive && !hasRole(COMPLIANCE_ROLE, to)) revert VotingLockActive();

        _autoUnfreezeIfNeeded(from);
        _autoUnfreezeIfNeeded(to);

        if (_frozenAccounts[from]) revert AccountFrozen(from);
        if (_frozenAccounts[to]) revert AccountFrozen(to);

        super._update(from, to, value);
    }

    function _autoUnfreezeIfNeeded(address account) internal {
        if (_frozenAccounts[account]) {
            uint256 until = _freezeUntil[account];
            if (until > 0 && block.timestamp >= until) {
                _frozenAccounts[account] = false;
                _freezeUntil[account] = 0;
                emit Unfrozen(account);
            }
        }
    }

    // -----------------------------------------------------------------------
    // View helpers
    // -----------------------------------------------------------------------

    function decimals() public pure override returns (uint8) {
        return 18;
    }

    function isMinter(address account) external view returns (bool) {
        return hasRole(MINTER_ROLE, account);
    }

    function isRatioAdmin(address account) external view returns (bool) {
        return hasRole(RATIO_ADMIN_ROLE, account);
    }

    function disclaimer() external pure returns (string memory) {
        return INVESTMENT_DISCLAIMER;
    }

    function maxSupply() external pure returns (uint256) {
        return MAX_SUPPLY;
    }

    // -----------------------------------------------------------------------
    // UUPS authorization
    // -----------------------------------------------------------------------

    // -----------------------------------------------------------------------
    // Freeze / Unfreeze (COMPLIANCE_ROLE)
    // -----------------------------------------------------------------------

    function freeze(address account) external onlyRole(COMPLIANCE_ROLE) {
        if (account == address(0)) revert CannotFreezeZeroAddress();
        _frozenAccounts[account] = true;
        _freezeUntil[account] = 0;
        emit Frozen(account, 0);
    }

    function freezeUntil(address account, uint256 endTime) external onlyRole(COMPLIANCE_ROLE) {
        if (account == address(0)) revert CannotFreezeZeroAddress();
        if (endTime <= block.timestamp) revert FreezeUntilMustBeFuture(endTime, block.timestamp);
        _frozenAccounts[account] = true;
        _freezeUntil[account] = endTime;
        emit Frozen(account, endTime);
    }

    function unfreeze(address account) external onlyRole(COMPLIANCE_ROLE) {
        if (account == address(0)) revert CannotFreezeZeroAddress();
        _frozenAccounts[account] = false;
        _freezeUntil[account] = 0;
        emit Unfrozen(account);
    }

    function isFrozen(address account) external view returns (bool) {
        if (!_frozenAccounts[account]) return false;
        uint256 until = _freezeUntil[account];
        if (until > 0 && block.timestamp >= until) return false;
        return true;
    }

    function freezeUntilOf(address account) external view returns (uint256) {
        return _freezeUntil[account];
    }

    // -----------------------------------------------------------------------
    // Voting Lock (called by ArbitrationFacet via Diamond)
    // -----------------------------------------------------------------------

    /// @dev Sets the global voting lock. When active, all CAS transfers are blocked.
    ///      Only callable by COMPLIANCE_ROLE (ArbitrationFacet calls this via the Diamond's
    ///      compliance officer, or the Diamond owner).
    function setVotingLock(bool active) external onlyRole(COMPLIANCE_ROLE) {
        _votingLockActive = active;
        emit VotingLockStateChanged(active);
    }

    /// @dev Returns whether the voting lock is currently active.
    function isVotingLockActive() external view returns (bool) {
        return _votingLockActive;
    }

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
