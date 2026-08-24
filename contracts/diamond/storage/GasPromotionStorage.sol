// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

/**
 * @title GasPromotionStorage
 * @dev Diamond Storage namespace for gas sponsorship promotions.
 *      Allows the Agentic Space to cover gas costs for specific operations
 *      (e.g. user registration) during promotional periods.
 *
 *      The promotion state is stored on-chain so that the backend relayer
 *      can trustlessly verify whether a given operation is sponsored before
 *      submitting the meta-transaction on behalf of the user.
 *
 *      Padrões: Diamond Storage (EIP-2535), Memento (state persistence)
 */
library GasPromotionStorage {
    bytes32 internal constant STORAGE_POSITION =
        keccak256("agentic.space.diamond.gaspromotion.storage");

    // -----------------------------------------------------------------------
    // Data structures
    // -----------------------------------------------------------------------

    /// @notice Operation types that can be sponsored.
    enum OperationType {
        USER_REGISTRATION,
        AGENT_REGISTRATION,
        USER_DEACTIVATION,
        AGENT_DEACTIVATION,
        MERKLE_ROOT_UPDATE
    }

    /// @notice Promotion configuration for a specific operation.
    struct OperationPromotion {
        bool isActive;
        uint256 budget;
        uint256 spent;
        uint256 perUserLimit;
        uint256 startedAt;
        uint256 endsAt;
    }

    /// @notice Per-user spending tracker for an operation.
    /// @dev Keyed by (operationType, userAddress) => amount spent.
    struct GasPromotionStorageData {
        bool globalEnabled;
        mapping(OperationType => OperationPromotion) promotions;
        mapping(bytes32 => uint256) userSpending; // keccak256(operationType, userAddress) => spent
        address relayer;
    }

    // -----------------------------------------------------------------------
    // Access
    // -----------------------------------------------------------------------

    function gasPromotionStorage()
        internal
        pure
        returns (GasPromotionStorageData storage s)
    {
        bytes32 position = STORAGE_POSITION;
        assembly {
            s.slot := position
        }
    }
}
