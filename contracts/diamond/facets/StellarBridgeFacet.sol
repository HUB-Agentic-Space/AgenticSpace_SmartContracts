// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { LibDiamond } from "../libraries/LibDiamond.sol";
import { DiamondAccessControl } from "../access/DiamondAccessControl.sol";
import { StellarBridgeStorage } from "../storage/StellarBridgeStorage.sol";
import { IStellarBridge } from "../interfaces/IStellarBridge.sol";

/**
 * @title StellarBridgeFacet
 * @dev EVM side of the CAS ↔ Stellar bridge, implemented as a Diamond facet.
 *
 *      Funcionalidades:
 *      - lockForStellar: Locka CAS no Diamond e emite evento para o relayer
 *        mintar CAS-S no Stellar.
 *      - confirmStellarLock: Marca um lock como completado após confirmação
 *        no Stellar.
 *      - unlockFromStellar: Minta CAS no EVM quando CAS-S é lockado no Stellar.
 *      - cancelLock: Cancela um lock pendente e devolve o CAS.
 *
 *      Segurança:
 *      - Apenas o bridge operator pode confirmar locks e unlockar do Stellar.
 *      - Nonces por usuário previnem replay.
 *      - Lock IDs são hashes determinísticos (sender + recipient + amount + nonce).
 *      - Replay protection para unlocks via stellarLockId.
 *
 *      Padrões: Proxy (EIP-2535 Diamond facet), Strategy (bridge operations),
 *               Memento (lock records as state snapshots)
 */
contract StellarBridgeFacet is IStellarBridge {
    using SafeERC20 for IERC20;
    using StellarBridgeStorage for StellarBridgeStorage.StellarBridgeStorageData;

    // -----------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------

    error BridgeIsPaused();
    error BridgeNotPaused();
    error NotBridgeOperator(address caller);
    error NotBridgeAdmin(address caller);
    error NotLockOwner(address caller, address owner);
    error LockNotFound(bytes32 lockId);
    error LockNotPending(bytes32 lockId, uint8 status);
    error LockAlreadyCompleted(bytes32 lockId);
    error UnlockAlreadyProcessed(bytes32 stellarLockId);
    error AmountIsZero();
    error AmountBelowMinimum(uint256 amount, uint256 minAmount);
    error AmountAboveMaximum(uint256 amount, uint256 maxAmount);
    error FeeTooHigh(uint32 feeBps);
    error StellarRecipientZero();
    error EvmRecipientZeroAddress();
    error CasTokenNotSet();
    error MinGreaterThanMax(uint256 min, uint256 max);

    // -----------------------------------------------------------------------
    // Constants
    // -----------------------------------------------------------------------

    uint32 internal constant MAX_FEE_BPS = 1000; // 10%

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------

    function _storage()
        internal
        pure
        returns (StellarBridgeStorage.StellarBridgeStorageData storage s)
    {
        return StellarBridgeStorage.bridgeStorage();
    }

    function _enforceNotPaused() internal view {
        if (_storage().bridgePaused) revert BridgeIsPaused();
    }

    function _enforceBridgeOperator() internal view {
        if (msg.sender != _storage().bridgeOperator) {
            revert NotBridgeOperator(msg.sender);
        }
    }

    function _enforceBridgeAdmin() internal view {
        if (msg.sender != _storage().bridgeAdmin &&
            msg.sender != LibDiamond.contractOwner()) {
            revert NotBridgeAdmin(msg.sender);
        }
    }

    function _checkAmount(uint256 amount) internal view {
        if (amount == 0) revert AmountIsZero();
        StellarBridgeStorage.StellarBridgeStorageData storage s = _storage();
        if (amount < s.minBridgeAmount) {
            revert AmountBelowMinimum(amount, s.minBridgeAmount);
        }
        if (amount > s.maxBridgeAmount) {
            revert AmountAboveMaximum(amount, s.maxBridgeAmount);
        }
    }

    function _computeLockId(
        address sender,
        bytes32 stellarRecipient,
        uint256 amount,
        uint64 nonce
    ) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(
            sender,
            stellarRecipient,
            amount,
            nonce
        ));
    }

    // -----------------------------------------------------------------------
    // CAS → Stellar
    // -----------------------------------------------------------------------

    /// @inheritdoc IStellarBridge
    function lockForStellar(
        bytes32 stellarRecipient,
        uint256 amount
    ) external override returns (bytes32 lockId) {
        _enforceNotPaused();
        if (stellarRecipient == bytes32(0)) revert StellarRecipientZero();
        _checkAmount(amount);

        StellarBridgeStorage.StellarBridgeStorageData storage s = _storage();
        if (address(s.casToken) == address(0)) revert CasTokenNotSet();

        // Get and increment nonce
        uint64 nonce = s.nonces[msg.sender];
        s.nonces[msg.sender] = nonce + 1;

        // Compute lock ID
        lockId = _computeLockId(msg.sender, stellarRecipient, amount, nonce);

        // Store lock record
        s.lockRecords[lockId] = StellarBridgeStorage.LockRecord({
            evmSender: msg.sender,
            stellarRecipient: stellarRecipient,
            amount: amount,
            nonce: nonce,
            timestamp: uint64(block.timestamp),
            status: StellarBridgeStorage.LockStatus.Pending
        });

        s.totalLockedPending += amount;

        // Transfer CAS from user to Diamond (lock)
        s.casToken.safeTransferFrom(msg.sender, address(this), amount);

        emit CasLockedForStellar(lockId, msg.sender, stellarRecipient, amount, nonce);
    }

    /// @inheritdoc IStellarBridge
    function confirmStellarLock(
        bytes32 lockId,
        bytes32 stellarTxHash
    ) external override {
        _enforceBridgeOperator();

        StellarBridgeStorage.StellarBridgeStorageData storage s = _storage();
        StellarBridgeStorage.LockRecord storage record = s.lockRecords[lockId];

        if (record.status == StellarBridgeStorage.LockStatus.None) {
            revert LockNotFound(lockId);
        }
        if (record.status != StellarBridgeStorage.LockStatus.Pending) {
            revert LockNotPending(lockId, uint8(record.status));
        }

        // Mark as completed and burn the locked CAS
        record.status = StellarBridgeStorage.LockStatus.Completed;
        s.totalLockedPending -= record.amount;
        s.totalBridgedToStellar += record.amount;

        // Burn the locked CAS (it has been minted as CAS-S on Stellar)
        // Using transfer to a burn address or calling burn if CAS supports it
        // For safety, we transfer to dead address instead of calling burn
        // since the Diamond may not have MINTER_ROLE
        s.casToken.safeTransfer(address(0xdead), record.amount);

        emit StellarLockConfirmed(lockId, stellarTxHash);
    }

    /// @inheritdoc IStellarBridge
    function cancelLock(bytes32 lockId) external override {
        StellarBridgeStorage.StellarBridgeStorageData storage s = _storage();
        StellarBridgeStorage.LockRecord storage record = s.lockRecords[lockId];

        if (record.status == StellarBridgeStorage.LockStatus.None) {
            revert LockNotFound(lockId);
        }
        if (record.status != StellarBridgeStorage.LockStatus.Pending) {
            revert LockNotPending(lockId, uint8(record.status));
        }

        // Only the original sender or admin/owner can cancel
        if (msg.sender != record.evmSender &&
            msg.sender != s.bridgeAdmin &&
            msg.sender != LibDiamond.contractOwner()) {
            revert NotLockOwner(msg.sender, record.evmSender);
        }

        record.status = StellarBridgeStorage.LockStatus.Cancelled;
        s.totalLockedPending -= record.amount;

        // Refund CAS to the original sender
        s.casToken.safeTransfer(record.evmSender, record.amount);

        emit LockCancelled(lockId, record.evmSender, record.amount);
    }

    // -----------------------------------------------------------------------
    // Stellar → CAS
    // -----------------------------------------------------------------------

    /// @inheritdoc IStellarBridge
    function unlockFromStellar(
        bytes32 stellarLockId,
        address evmRecipient,
        uint256 amount
    ) external override {
        _enforceBridgeOperator();
        _enforceNotPaused();
        if (evmRecipient == address(0)) revert EvmRecipientZeroAddress();
        _checkAmount(amount);

        StellarBridgeStorage.StellarBridgeStorageData storage s = _storage();
        if (address(s.casToken) == address(0)) revert CasTokenNotSet();

        // Check for replay
        if (s.unlockRecords[stellarLockId].claimed) {
            revert UnlockAlreadyProcessed(stellarLockId);
        }

        // Record the unlock
        s.unlockRecords[stellarLockId] = StellarBridgeStorage.UnlockRecord({
            stellarLockId: stellarLockId,
            evmRecipient: evmRecipient,
            amount: amount,
            timestamp: uint64(block.timestamp),
            claimed: true
        });

        s.totalBridgedFromStellar += amount;

        // Transfer CAS from Diamond's locked balance to the recipient
        // The Diamond must hold sufficient CAS for unlocks
        s.casToken.safeTransfer(evmRecipient, amount);

        emit CasUnlockedFromStellar(stellarLockId, evmRecipient, amount);
    }

    // -----------------------------------------------------------------------
    // Admin functions
    // -----------------------------------------------------------------------

    /// @inheritdoc IStellarBridge
    function setBridgeOperator(address operator) external override {
        _enforceBridgeAdmin();
        StellarBridgeStorage.StellarBridgeStorageData storage s = _storage();
        address old = s.bridgeOperator;
        s.bridgeOperator = operator;
        emit BridgeOperatorSet(old, operator);
    }

    /// @inheritdoc IStellarBridge
    function setBridgeAdmin(address admin) external override {
        LibDiamond.enforceIsContractOwner();
        StellarBridgeStorage.StellarBridgeStorageData storage s = _storage();
        address old = s.bridgeAdmin;
        s.bridgeAdmin = admin;
        emit BridgeAdminSet(old, admin);
    }

    /// @inheritdoc IStellarBridge
    function setBridgePaused(bool paused) external override {
        _enforceBridgeAdmin();
        _storage().bridgePaused = paused;
        emit BridgePauseChanged(paused);
    }

    /// @inheritdoc IStellarBridge
    function setBridgeFeeBps(uint32 feeBps) external override {
        _enforceBridgeAdmin();
        if (feeBps > MAX_FEE_BPS) revert FeeTooHigh(feeBps);
        _storage().feeBps = feeBps;
    }

    /// @inheritdoc IStellarBridge
    function setBridgeLimits(uint256 minAmount, uint256 maxAmount) external override {
        _enforceBridgeAdmin();
        if (minAmount > maxAmount) revert MinGreaterThanMax(minAmount, maxAmount);
        StellarBridgeStorage.StellarBridgeStorageData storage s = _storage();
        s.minBridgeAmount = minAmount;
        s.maxBridgeAmount = maxAmount;
    }

    // -----------------------------------------------------------------------
    // Initialization (called via diamondCut delegatecall)
    // -----------------------------------------------------------------------

    /// @dev Initializes the Stellar bridge facet. Called once during diamondCut.
    /// @param casToken Address of the CAS token contract.
    /// @param bridgeAdmin Address of the bridge admin.
    /// @param bridgeOperator Address of the bridge operator (backend relayer).
    function initStellarBridge(
        address casToken,
        address bridgeAdmin,
        address bridgeOperator
    ) external {
        LibDiamond.enforceIsContractOwner();

        StellarBridgeStorage.StellarBridgeStorageData storage s = _storage();
        s.casToken = IERC20(casToken);
        s.bridgeAdmin = bridgeAdmin;
        s.bridgeOperator = bridgeOperator;
        s.bridgePaused = false;
        s.feeBps = 30; // 0.3%
        s.minBridgeAmount = 1_000_000; // 0.001 CAS
        s.maxBridgeAmount = 10_000_000 * 1e18; // 10M CAS
    }

    // -----------------------------------------------------------------------
    // View functions
    // -----------------------------------------------------------------------

    /// @inheritdoc IStellarBridge
    function getLockRecord(bytes32 lockId)
        external
        view
        override
        returns (
            address evmSender,
            bytes32 stellarRecipient,
            uint256 amount,
            uint64 nonce,
            uint64 timestamp,
            uint8 status
        )
    {
        StellarBridgeStorage.LockRecord storage r = _storage().lockRecords[lockId];
        return (
            r.evmSender,
            r.stellarRecipient,
            r.amount,
            r.nonce,
            r.timestamp,
            uint8(r.status)
        );
    }

    /// @inheritdoc IStellarBridge
    function getUnlockRecord(bytes32 stellarLockId)
        external
        view
        override
        returns (
            address evmRecipient,
            uint256 amount,
            uint64 timestamp,
            bool claimed
        )
    {
        StellarBridgeStorage.UnlockRecord storage r =
            _storage().unlockRecords[stellarLockId];
        return (r.evmRecipient, r.amount, r.timestamp, r.claimed);
    }

    /// @inheritdoc IStellarBridge
    function getNonce(address user) external view override returns (uint64) {
        return _storage().nonces[user];
    }

    /// @inheritdoc IStellarBridge
    function isBridgePaused() external view override returns (bool) {
        return _storage().bridgePaused;
    }

    /// @inheritdoc IStellarBridge
    function getBridgeOperator() external view override returns (address) {
        return _storage().bridgeOperator;
    }

    /// @inheritdoc IStellarBridge
    function getBridgeAdmin() external view override returns (address) {
        return _storage().bridgeAdmin;
    }

    /// @inheritdoc IStellarBridge
    function getBridgeFeeBps() external view override returns (uint32) {
        return _storage().feeBps;
    }

    /// @inheritdoc IStellarBridge
    function getBridgeLimits()
        external
        view
        override
        returns (uint256 minAmount, uint256 maxAmount)
    {
        StellarBridgeStorage.StellarBridgeStorageData storage s = _storage();
        return (s.minBridgeAmount, s.maxBridgeAmount);
    }

    /// @inheritdoc IStellarBridge
    function getTotalBridgedToStellar() external view override returns (uint256) {
        return _storage().totalBridgedToStellar;
    }

    /// @inheritdoc IStellarBridge
    function getTotalBridgedFromStellar() external view override returns (uint256) {
        return _storage().totalBridgedFromStellar;
    }
}
