// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title LiquidityLock
 * @dev Lock de LP tokens da DEX por um período definido.
 *      Impede early withdrawal — o admin só pode sacar após o unlockTime.
 *      O lock pode ser estendido, mas nunca reduzido.
 *
 *      Padrões: Template Method (lock flow), Singleton (uma instância por LP)
 *
 *      Uso:
 *      1. Deploy após adicionar liquidez na DEX
 *      2. Transferir LP tokens para este contrato
 *      3. Após unlockTime, o admin pode withdraw os LP tokens
 */
contract LiquidityLock is Ownable {
    using SafeERC20 for IERC20;

    /// @dev Endereço do LP token (ERC-20).
    IERC20 public immutable lpToken;

    /// @dev Timestamp de desbloqueio. Mutável apenas para extensão (nunca redução).
    uint256 public unlockTime;

    error AlreadyLocked();
    error LockNotExpired(uint256 currentTime, uint256 unlockTime);
    error InvalidUnlockTime(uint256 proposed, uint256 minimum);
    error NoTokensToWithdraw();
    error ZeroAddress();

    event LiquidityLocked(address indexed lpToken, uint256 amount, uint256 unlockTime);
    event LiquidityWithdrawn(address indexed to, uint256 amount);
    event LockExtended(uint256 oldUnlockTime, uint256 newUnlockTime);

    /**
     * @param lpTokenAddress Endereço do LP token.
     * @param lockDuration Duração do lock em segundos (a partir do deploy).
     * @param admin Endereço do admin que pode withdraw após unlock.
     */
    constructor(
        address lpTokenAddress,
        uint256 lockDuration,
        address admin
    ) Ownable(admin) {
        if (lpTokenAddress == address(0)) revert ZeroAddress();
        if (lockDuration == 0) revert InvalidUnlockTime(0, 1);

        lpToken = IERC20(lpTokenAddress);
        unlockTime = block.timestamp + lockDuration;

        emit LiquidityLocked(lpTokenAddress, 0, unlockTime);
    }

    /**
     * @dev Saca os LP tokens após o tempo de lock expirar.
     *      Apenas o owner (admin).
     */
    function withdraw() external onlyOwner {
        if (block.timestamp < unlockTime) revert LockNotExpired(block.timestamp, unlockTime);

        uint256 balance = lpToken.balanceOf(address(this));
        if (balance == 0) revert NoTokensToWithdraw();

        lpToken.safeTransfer(owner(), balance);

        emit LiquidityWithdrawn(owner(), balance);
    }

    /**
     * @dev Estende o tempo de lock. Só pode aumentar, nunca diminuir.
     *      Apenas o owner (admin).
     * @param newUnlockTime Novo timestamp de desbloqueio (deve ser > unlockTime atual).
     */
    function extendLock(uint256 newUnlockTime) external onlyOwner {
        if (newUnlockTime <= unlockTime) revert InvalidUnlockTime(newUnlockTime, unlockTime + 1);

        uint256 old = unlockTime;
        unlockTime = newUnlockTime;

        emit LockExtended(old, newUnlockTime);
    }

    /**
     * @dev Retorna o saldo de LP tokens locked.
     */
    function getLPTokenBalance() external view returns (uint256) {
        return lpToken.balanceOf(address(this));
    }

    /**
     * @dev Retorna o timestamp de desbloqueio.
     */
    function getUnlockTime() external view returns (uint256) {
        return unlockTime;
    }

    /**
     * @dev Retorna o endereço do LP token.
     */
    function getLPToken() external view returns (address) {
        return address(lpToken);
    }

    /**
     * @dev Verifica se o lock já expirou.
     */
    function isExpired() external view returns (bool) {
        return block.timestamp >= unlockTime;
    }
}
