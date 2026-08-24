// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { LibDiamond } from "../diamond/libraries/LibDiamond.sol";

/**
 * @title MultiTokenLiquidityLockFacet
 * @dev Facet do Diamond para travar múltiplos LP tokens (um por pool)
 *      sob um único endereço: o próprio Diamond proxy. Cada LP token
 *      mantém seu próprio saldo bloqueado e timestamp de desbloqueio.
 *
 *      Padrões: Facet (EIP-2535), Diamond Storage
 */
library MultiTokenLiquidityLockStorage {
    bytes32 internal constant STORAGE_POSITION =
        keccak256("agentic.space.diamond.liquidity.lock.storage");

    struct LockInfo {
        uint256 amount;
        uint256 unlockTime;
        bool withdrawn;
    }

    struct Storage {
        mapping(address => LockInfo) locks;
    }

    function storage_() internal pure returns (Storage storage s) {
        bytes32 position = STORAGE_POSITION;
        assembly {
            s.slot := position
        }
    }
}

contract MultiTokenLiquidityLockFacet {
    using SafeERC20 for IERC20;

    error ZeroAddress();
    error ZeroAmount();
    error AlreadyLocked(address lpToken);
    error LockNotExpired(address lpToken, uint256 currentTime, uint256 unlockTime);
    error InvalidUnlockTime(uint256 proposed, uint256 minimum);
    error NoTokensToWithdraw(address lpToken);

    event LiquidityLocked(
        address indexed lpToken,
        address indexed sender,
        uint256 amount,
        uint256 unlockTime
    );
    event LockExtended(
        address indexed lpToken,
        uint256 oldUnlockTime,
        uint256 newUnlockTime
    );
    event LiquidityWithdrawn(
        address indexed lpToken,
        address indexed to,
        uint256 amount
    );

    modifier onlyOwner() {
        LibDiamond.enforceIsContractOwner();
        _;
    }

    /**
     * @dev Trava `amount` de LP tokens até `unlockTime`.
     *      Apenas o owner do Diamond. Requer aprovação prévia do LP token.
     */
    function lockLiquidity(
        address lpToken,
        uint256 amount,
        uint256 unlockTime
    ) external onlyOwner {
        if (lpToken == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (unlockTime <= block.timestamp) {
            revert InvalidUnlockTime(unlockTime, block.timestamp + 1);
        }

        MultiTokenLiquidityLockStorage.Storage storage s = MultiTokenLiquidityLockStorage
            .storage_();
        MultiTokenLiquidityLockStorage.LockInfo storage info = s.locks[lpToken];

        if (!info.withdrawn && info.amount > 0) revert AlreadyLocked(lpToken);

        info.amount = amount;
        info.unlockTime = unlockTime;
        info.withdrawn = false;

        IERC20(lpToken).safeTransferFrom(msg.sender, address(this), amount);

        emit LiquidityLocked(lpToken, msg.sender, amount, unlockTime);
    }

    /**
     * @dev Estende o lock de um LP token. Só pode aumentar o prazo.
     */
    function extendLock(
        address lpToken,
        uint256 newUnlockTime
    ) external onlyOwner {
        MultiTokenLiquidityLockStorage.Storage storage s = MultiTokenLiquidityLockStorage
            .storage_();
        MultiTokenLiquidityLockStorage.LockInfo storage info = s.locks[lpToken];

        if (info.amount == 0) revert NoTokensToWithdraw(lpToken);
        if (newUnlockTime <= info.unlockTime) {
            revert InvalidUnlockTime(newUnlockTime, info.unlockTime + 1);
        }

        uint256 old = info.unlockTime;
        info.unlockTime = newUnlockTime;

        emit LockExtended(lpToken, old, newUnlockTime);
    }

    /**
     * @dev Retorna LP tokens travados para `to` após expiração.
     */
    function withdrawLockedLiquidity(
        address lpToken,
        address to
    ) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();

        MultiTokenLiquidityLockStorage.Storage storage s = MultiTokenLiquidityLockStorage
            .storage_();
        MultiTokenLiquidityLockStorage.LockInfo storage info = s.locks[lpToken];

        if (info.amount == 0) revert NoTokensToWithdraw(lpToken);
        if (info.withdrawn) revert NoTokensToWithdraw(lpToken);
        if (block.timestamp < info.unlockTime) {
            revert LockNotExpired(lpToken, block.timestamp, info.unlockTime);
        }

        uint256 amount = info.amount;
        info.withdrawn = true;

        IERC20(lpToken).safeTransfer(to, amount);

        emit LiquidityWithdrawn(lpToken, to, amount);
    }

    /**
     * @dev Saldo de LP tokens ainda travados para um pool.
     */
    function getLockedLiquidity(address lpToken) external view returns (uint256) {
        MultiTokenLiquidityLockStorage.Storage storage s = MultiTokenLiquidityLockStorage
            .storage_();
        MultiTokenLiquidityLockStorage.LockInfo storage info = s.locks[lpToken];
        return info.withdrawn ? 0 : info.amount;
    }

    /**
     * @dev Timestamp de desbloqueio de um pool.
     */
    function getUnlockTime(address lpToken) public view returns (uint256) {
        return MultiTokenLiquidityLockStorage.storage_().locks[lpToken].unlockTime;
    }

    /**
     * @dev Verifica se o lock já expirou (independente de saldo).
     */
    function isLockExpired(address lpToken) external view returns (bool) {
        return block.timestamp >= getUnlockTime(lpToken);
    }

    /**
     * @dev Retorna todos os dados de lock de um pool.
     */
    function getLockInfo(
        address lpToken
    ) external view returns (uint256 amount, uint256 unlockTime, bool withdrawn) {
        MultiTokenLiquidityLockStorage.LockInfo storage info = MultiTokenLiquidityLockStorage
            .storage_()
            .locks[lpToken];
        amount = info.withdrawn ? 0 : info.amount;
        unlockTime = info.unlockTime;
        withdrawn = info.withdrawn;
    }
}
