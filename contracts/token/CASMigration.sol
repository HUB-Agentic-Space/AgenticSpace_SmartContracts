// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title CASMigration — Converte CAS antigo (v1) para CAS novo (v2) na ratio 1:1
/// @notice Usuários depositam CAS v1 e recebem CAS v2 equivalente. O CAS v1 é queimado
///         (enviado para 0xdead). O resgate de tokens só é permitido com a migração
///         desativada, protegendo a reserva durante o período de migração.
contract CASMigration is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @dev Endereço de queima — tokens enviados aqui são irrecuperáveis.
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    IERC20 public immutable oldCAS;
    IERC20 public immutable newCAS;

    uint256 public totalMigrated;
    bool public migrationActive;

    event Migrated(address indexed user, uint256 amount);
    event MigrationActivated();
    event MigrationDeactivated();
    event TokensRescued(address indexed token, address indexed to, uint256 amount);

    error MigrationNotActive();
    error MigrationStillActive();
    error ZeroAmount();
    error ZeroAddress();
    error InsufficientReserve(uint256 available, uint256 required);
    error LengthMismatch(uint256 usersLength, uint256 amountsLength);
    error BatchTooLarge(uint256 provided, uint256 max);

    uint256 public constant MAX_BATCH = 100;

    constructor(address _oldCAS, address _newCAS) Ownable(msg.sender) {
        if (_oldCAS == address(0) || _newCAS == address(0)) revert ZeroAddress();
        oldCAS = IERC20(_oldCAS);
        newCAS = IERC20(_newCAS);
        migrationActive = true;
        emit MigrationActivated();
    }

    /// @notice Migra CAS v1 para CAS v2. Requer aprovação prévia do oldCAS.
    /// @param amount Quantidade de CAS v1 a migrar (com 18 decimais)
    function migrate(uint256 amount) external nonReentrant {
        if (!migrationActive) revert MigrationNotActive();
        if (amount == 0) revert ZeroAmount();

        uint256 reserve = newCAS.balanceOf(address(this));
        if (reserve < amount) revert InsufficientReserve(reserve, amount);

        // Effects before interactions (CEI)
        totalMigrated += amount;

        // Old CAS goes straight to the burn address — reverts on failure
        oldCAS.safeTransferFrom(msg.sender, BURN_ADDRESS, amount);

        // Transfer new CAS to user
        newCAS.safeTransfer(msg.sender, amount);

        emit Migrated(msg.sender, amount);
    }

    /// @notice Migra em lote para múltiplos usuários (apenas owner).
    ///         Cada usuário deve ter aprovado este contrato previamente.
    /// @param users Lista de endereços
    /// @param amounts Lista de quantidades (mesmo índice)
    function batchMigrate(address[] calldata users, uint256[] calldata amounts)
        external
        onlyOwner
        nonReentrant
    {
        if (!migrationActive) revert MigrationNotActive();
        if (users.length != amounts.length) revert LengthMismatch(users.length, amounts.length);
        if (users.length > MAX_BATCH) revert BatchTooLarge(users.length, MAX_BATCH);

        for (uint256 i = 0; i < users.length; i++) {
            if (amounts[i] == 0) continue;
            if (users[i] == address(0)) revert ZeroAddress();

            uint256 reserve = newCAS.balanceOf(address(this));
            if (reserve < amounts[i]) revert InsufficientReserve(reserve, amounts[i]);

            totalMigrated += amounts[i];

            oldCAS.safeTransferFrom(users[i], BURN_ADDRESS, amounts[i]);
            newCAS.safeTransfer(users[i], amounts[i]);

            emit Migrated(users[i], amounts[i]);
        }
    }

    function setMigrationActive(bool active) external onlyOwner {
        migrationActive = active;
        if (active) emit MigrationActivated();
        else emit MigrationDeactivated();
    }

    /// @notice Resgata tokens não migrados. Apenas owner e somente com a
    ///         migração desativada — impede drenagem da reserva durante a migração.
    function rescueTokens(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (migrationActive) revert MigrationStillActive();
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        IERC20(token).safeTransfer(to, amount);
        emit TokensRescued(token, to, amount);
    }

    /// @notice Verifica saldo de newCAS disponível para migração
    function availableNewCAS() external view returns (uint256) {
        return newCAS.balanceOf(address(this));
    }
}
