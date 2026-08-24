// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

/**
 * @title IStellarBridge
 * @dev Interface for the Stellar bridge facet (CAS ↔ Stellar).
 *      Implements the EVM side of the bridge using the Diamond Proxy pattern.
 *
 *      Direção CAS → Stellar:
 *        1. Usuário aprova CAS para o Diamond
 *        2. lockForStellar() transfere CAS para o Diamond e emite evento
 *        3. Backend relayer observa o evento e chama lockForBridge no Soroban
 *        4. confirmStellarLock() marca o lock como completado
 *
 *      Direção Stellar → CAS:
 *        1. Usuário chama lock_for_bridge no Soroban (locka CAS-S)
 *        2. Backend relayer observa o evento Stellar
 *        3. unlockFromStellar() minta CAS no EVM para o destinatário
 */
interface IStellarBridge {
    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    /// @dev Emitted when CAS is locked for bridging to Stellar.
    event CasLockedForStellar(
        bytes32 indexed lockId,
        address indexed sender,
        bytes32 indexed stellarRecipient,
        uint256 amount,
        uint64 nonce
    );

    /// @dev Emitted when a Stellar lock is confirmed (CAS-S minted on Stellar).
    event StellarLockConfirmed(
        bytes32 indexed lockId,
        bytes32 stellarTxHash
    );

    /// @dev Emitted when CAS is minted on EVM from a Stellar unlock.
    event CasUnlockedFromStellar(
        bytes32 indexed stellarLockId,
        address indexed recipient,
        uint256 amount
    );

    /// @dev Emitted when a lock is cancelled and CAS refunded.
    event LockCancelled(
        bytes32 indexed lockId,
        address indexed sender,
        uint256 refundAmount
    );

    /// @dev Emitted when bridge operator is set.
    event BridgeOperatorSet(address indexed oldOperator, address indexed newOperator);

    /// @dev Emitted when bridge admin is set.
    event BridgeAdminSet(address indexed oldAdmin, address indexed newAdmin);

    /// @dev Emitted when bridge is paused/unpaused.
    event BridgePauseChanged(bool paused);

    // -----------------------------------------------------------------------
    // CAS → Stellar
    // -----------------------------------------------------------------------

    /// @dev Locks CAS tokens for bridging to Stellar.
    /// @param stellarRecipient The Stellar recipient address (G...) encoded as bytes32.
    /// @param amount Amount of CAS to lock (in wei).
    /// @return lockId Unique identifier for this lock.
    function lockForStellar(
        bytes32 stellarRecipient,
        uint256 amount
    ) external returns (bytes32 lockId);

    /// @dev Confirms that CAS-S was minted on Stellar (called by bridge operator).
    /// @param lockId The lock ID from lockForStellar.
    /// @param stellarTxHash The Stellar transaction hash as proof.
    function confirmStellarLock(
        bytes32 lockId,
        bytes32 stellarTxHash
    ) external;

    /// @dev Cancels a pending lock and refunds the CAS.
    /// @param lockId The lock ID to cancel.
    function cancelLock(bytes32 lockId) external;

    // -----------------------------------------------------------------------
    // Stellar → CAS
    // -----------------------------------------------------------------------

    /// @dev Mints CAS on EVM when CAS-S is locked on Stellar.
    ///      Only callable by the bridge operator.
    /// @param stellarLockId The lock ID from the Stellar side.
    /// @param evmRecipient The EVM address to receive minted CAS.
    /// @param amount Amount of CAS to mint (in wei).
    function unlockFromStellar(
        bytes32 stellarLockId,
        address evmRecipient,
        uint256 amount
    ) external;

    // -----------------------------------------------------------------------
    // Admin functions
    // -----------------------------------------------------------------------

    function setBridgeOperator(address operator) external;
    function setBridgeAdmin(address admin) external;
    function setBridgePaused(bool paused) external;
    function setBridgeFeeBps(uint32 feeBps) external;
    function setBridgeLimits(uint256 minAmount, uint256 maxAmount) external;

    // -----------------------------------------------------------------------
    // View functions
    // -----------------------------------------------------------------------

    function getLockRecord(bytes32 lockId)
        external view returns (
            address evmSender,
            bytes32 stellarRecipient,
            uint256 amount,
            uint64 nonce,
            uint64 timestamp,
            uint8 status
        );

    function getUnlockRecord(bytes32 stellarLockId)
        external view returns (
            address evmRecipient,
            uint256 amount,
            uint64 timestamp,
            bool claimed
        );

    function getNonce(address user) external view returns (uint64);
    function isBridgePaused() external view returns (bool);
    function getBridgeOperator() external view returns (address);
    function getBridgeAdmin() external view returns (address);
    function getBridgeFeeBps() external view returns (uint32);
    function getBridgeLimits() external view returns (uint256 minAmount, uint256 maxAmount);
    function getTotalBridgedToStellar() external view returns (uint256);
    function getTotalBridgedFromStellar() external view returns (uint256);
}
