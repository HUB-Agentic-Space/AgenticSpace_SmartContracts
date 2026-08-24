// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title StellarBridgeStorage
 * @dev Diamond Storage namespace for the Stellar bridge facet.
 *      Stores CAS token reference, Stellar bridge operator address,
 *      lock records, nonce tracking, and bridge configuration.
 *
 *      Padrões: Diamond Storage (EIP-2535), Memento (state persistence)
 */
library StellarBridgeStorage {
    bytes32 internal constant STORAGE_POSITION =
        keccak256("agentic.space.diamond.stellar.bridge.storage");

    // -----------------------------------------------------------------------
    // Data structures
    // -----------------------------------------------------------------------

    /// @dev Status of a bridge lock (CAS → Stellar direction).
    enum LockStatus {
        None,       // 0 — no record
        Pending,    // 1 — CAS locked, waiting for Stellar confirmation
        Completed,  // 2 — CAS-S minted on Stellar, CAS burned on EVM
        Cancelled   // 3 — lock cancelled, CAS refunded
    }

    /// @dev Record of a CAS lock for bridging to Stellar.
    struct LockRecord {
        address evmSender;
        bytes32 stellarRecipient;   // Stellar G... address encoded as bytes32
        uint256 amount;
        uint64 nonce;
        uint64 timestamp;
        LockStatus status;
    }

    /// @dev Record of a Stellar→EVM unlock (CAS-S locked on Stellar, CAS minted on EVM).
    struct UnlockRecord {
        bytes32 stellarLockId;      // lock_id from Stellar side
        address evmRecipient;
        uint256 amount;
        uint64 timestamp;
        bool claimed;
    }

    struct StellarBridgeStorageData {
        // CAS token used for bridging
        IERC20 casToken;
        // Authorized bridge operator (backend relayer)
        address bridgeOperator;
        // Admin who can set operator and config
        address bridgeAdmin;
        // Bridge paused state
        bool bridgePaused;
        // Fee in basis points (e.g. 30 = 0.3%)
        uint32 feeBps;
        // Minimum bridge amount (in wei)
        uint256 minBridgeAmount;
        // Maximum bridge amount (in wei)
        uint256 maxBridgeAmount;
        // Nonce per user for CAS→Stellar locks
        mapping(address => uint64) nonces;
        // Lock records keyed by lockId (keccak256 of sender, recipient, amount, nonce)
        mapping(bytes32 => LockRecord) lockRecords;
        // Unlock records keyed by stellarLockId (prevents replay)
        mapping(bytes32 => UnlockRecord) unlockRecords;
        // Total CAS locked (pending completion)
        uint256 totalLockedPending;
        // Total CAS bridged to Stellar (completed)
        uint256 totalBridgedToStellar;
        // Total CAS bridged from Stellar (unlocked/minted)
        uint256 totalBridgedFromStellar;
    }

    // -----------------------------------------------------------------------
    // Access
    // -----------------------------------------------------------------------

    function bridgeStorage()
        internal
        pure
        returns (StellarBridgeStorageData storage s)
    {
        bytes32 position = STORAGE_POSITION;
        assembly {
            s.slot := position
        }
    }
}
