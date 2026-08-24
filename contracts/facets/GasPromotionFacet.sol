// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { LibDiamond } from "../diamond/libraries/LibDiamond.sol";
import { DiamondAccessControl } from "../diamond/access/DiamondAccessControl.sol";
import { GasPromotionStorage } from "../diamond/storage/GasPromotionStorage.sol";

/**
 * @title GasPromotionFacet
 * @dev Facet for managing gas sponsorship promotions.
 *
 *      The Agentic Space can activate promotional periods where gas costs
 *      for specific operations (e.g. user registration) are covered by the
 *      platform. The backend relayer reads the on-chain promotion state to
 *      decide whether to submit meta-transactions on behalf of users.
 *
 *      Features:
 *        - Global enable/disable switch
 *        - Per-operation activation with budget and time window
 *        - Per-user spending limits to prevent abuse
 *        - Relayer address management (only the designated relayer can
 *          record gas spending)
 *        - View functions for the backend to check promotion status
 *
 *      Padrões: Diamond Storage (EIP-2535), Command (promotion activation),
 *               Observer (events for promotion lifecycle)
 */
contract GasPromotionFacet {

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    event GlobalPromotionToggled(bool enabled);
    event OperationPromotionActivated(
        GasPromotionStorage.OperationType indexed operationType,
        uint256 budget,
        uint256 perUserLimit,
        uint256 endsAt
    );
    event OperationPromotionDeactivated(
        GasPromotionStorage.OperationType indexed operationType
    );
    event RelayerSet(address indexed relayer);
    event GasSpendingRecorded(
        GasPromotionStorage.OperationType indexed operationType,
        address indexed user,
        uint256 amount
    );
    event BudgetRefilled(
        GasPromotionStorage.OperationType indexed operationType,
        uint256 amount
    );

    // -----------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------

    error ZeroAddress();
    error PromotionNotActive(GasPromotionStorage.OperationType operationType);
    error PromotionExpired(GasPromotionStorage.OperationType operationType);
    error BudgetExhausted(GasPromotionStorage.OperationType operationType);
    error UserLimitExceeded(address user, uint256 limit);
    error NotRelayer(address caller);
    error InvalidEndTime();
    error InvalidBudget();

    // -----------------------------------------------------------------------
    // Init (called via diamondCut delegatecall)
    // -----------------------------------------------------------------------

    function initGasPromotion() external {
        LibDiamond.enforceIsContractOwner();
        GasPromotionStorage.gasPromotionStorage().globalEnabled = false;
    }

    // -----------------------------------------------------------------------
    // Admin: global toggle
    // -----------------------------------------------------------------------

    /// @notice Enable or disable all gas promotions globally.
    /// @param enabled True to enable, false to disable.
    function setGlobalPromotion(bool enabled) external {
        DiamondAccessControl.enforceIsContractOwner();
        GasPromotionStorage.gasPromotionStorage().globalEnabled = enabled;
        emit GlobalPromotionToggled(enabled);
    }

    /// @notice Set the designated relayer that can record gas spending.
    /// @param relayer Address of the backend relayer contract or EOA.
    function setRelayer(address relayer) external {
        DiamondAccessControl.enforceIsContractOwner();
        if (relayer == address(0)) revert ZeroAddress();
        GasPromotionStorage.gasPromotionStorage().relayer = relayer;
        emit RelayerSet(relayer);
    }

    // -----------------------------------------------------------------------
    // Admin: per-operation promotion
    // -----------------------------------------------------------------------

    /// @notice Activate a gas promotion for a specific operation.
    /// @param operationType The operation to sponsor.
    /// @param budget Total gas budget (in wei equivalent) for this promotion.
    /// @param perUserLimit Maximum gas per user for this promotion.
    /// @param durationSeconds Duration of the promotion from activation.
    function activatePromotion(
        GasPromotionStorage.OperationType operationType,
        uint256 budget,
        uint256 perUserLimit,
        uint256 durationSeconds
    ) external {
        DiamondAccessControl.enforceIsContractOwner();
        if (budget == 0) revert InvalidBudget();
        if (durationSeconds == 0) revert InvalidEndTime();

        GasPromotionStorage.GasPromotionStorageData storage ds =
            GasPromotionStorage.gasPromotionStorage();

        ds.promotions[operationType] = GasPromotionStorage.OperationPromotion({
            isActive: true,
            budget: budget,
            spent: ds.promotions[operationType].spent, // preserve spent if refilling
            perUserLimit: perUserLimit,
            startedAt: block.timestamp,
            endsAt: block.timestamp + durationSeconds
        });

        emit OperationPromotionActivated(operationType, budget, perUserLimit, block.timestamp + durationSeconds);
    }

    /// @notice Deactivate a gas promotion for a specific operation.
    /// @param operationType The operation to stop sponsoring.
    function deactivatePromotion(GasPromotionStorage.OperationType operationType) external {
        DiamondAccessControl.enforceIsContractOwner();
        GasPromotionStorage.gasPromotionStorage().promotions[operationType].isActive = false;
        emit OperationPromotionDeactivated(operationType);
    }

    /// @notice Refill the budget for an active or inactive promotion.
    /// @param operationType The operation to refill.
    /// @param amount Additional budget to add.
    function refillBudget(
        GasPromotionStorage.OperationType operationType,
        uint256 amount
    ) external {
        DiamondAccessControl.enforceIsContractOwner();
        if (amount == 0) revert InvalidBudget();

        GasPromotionStorage.GasPromotionStorageData storage ds =
            GasPromotionStorage.gasPromotionStorage();
        ds.promotions[operationType].budget += amount;

        emit BudgetRefilled(operationType, amount);
    }

    // -----------------------------------------------------------------------
    // Relayer: record gas spending
    // -----------------------------------------------------------------------

    /// @notice Record gas spent for a user under a promotional operation.
    ///         Only the designated relayer can call this.
    /// @param operationType The sponsored operation.
    /// @param user The address of the user whose gas was sponsored.
    /// @param amount Gas amount (in wei) spent.
    function recordGasSpending(
        GasPromotionStorage.OperationType operationType,
        address user,
        uint256 amount
    ) external {
        GasPromotionStorage.GasPromotionStorageData storage ds =
            GasPromotionStorage.gasPromotionStorage();

        if (msg.sender != ds.relayer) revert NotRelayer(msg.sender);

        GasPromotionStorage.OperationPromotion storage promo =
            ds.promotions[operationType];

        if (!ds.globalEnabled || !promo.isActive) revert PromotionNotActive(operationType);
        if (block.timestamp > promo.endsAt) revert PromotionExpired(operationType);
        if (promo.spent + amount > promo.budget) revert BudgetExhausted(operationType);

        bytes32 userKey = keccak256(abi.encodePacked(uint8(operationType), user));
        if (ds.userSpending[userKey] + amount > promo.perUserLimit) {
            revert UserLimitExceeded(user, promo.perUserLimit);
        }

        promo.spent += amount;
        ds.userSpending[userKey] += amount;

        emit GasSpendingRecorded(operationType, user, amount);
    }

    // -----------------------------------------------------------------------
    // View functions
    // -----------------------------------------------------------------------

    /// @notice Check if a specific operation is currently promoted for a user.
    /// @param operationType The operation to check.
    /// @param user The user address (for per-user limit check).
    /// @return active True if the promotion is active and the user hasn't exceeded their limit.
    /// @return remainingBudget Remaining budget for the promotion.
    /// @return userRemaining Remaining gas the user can use.
    function isPromoted(
        GasPromotionStorage.OperationType operationType,
        address user
    ) external view returns (
        bool active,
        uint256 remainingBudget,
        uint256 userRemaining
    ) {
        GasPromotionStorage.GasPromotionStorageData storage ds =
            GasPromotionStorage.gasPromotionStorage();

        GasPromotionStorage.OperationPromotion storage promo =
            ds.promotions[operationType];

        bool globallyEnabled = ds.globalEnabled;
        bool operationActive = promo.isActive && block.timestamp <= promo.endsAt;
        bool budgetAvailable = promo.spent < promo.budget;

        bytes32 userKey = keccak256(abi.encodePacked(uint8(operationType), user));
        uint256 userSpent = ds.userSpending[userKey];
        bool userHasBudget = userSpent < promo.perUserLimit;

        active = globallyEnabled && operationActive && budgetAvailable && userHasBudget;
        remainingBudget = promo.budget - promo.spent;
        userRemaining = promo.perUserLimit - userSpent;
    }

    /// @notice Get full promotion details for an operation.
    function getPromotion(
        GasPromotionStorage.OperationType operationType
    ) external view returns (GasPromotionStorage.OperationPromotion memory) {
        return GasPromotionStorage.gasPromotionStorage().promotions[operationType];
    }

    /// @notice Check if global promotion is enabled.
    function isGlobalPromotionEnabled() external view returns (bool) {
        return GasPromotionStorage.gasPromotionStorage().globalEnabled;
    }

    /// @notice Get the designated relayer address.
    function getRelayer() external view returns (address) {
        return GasPromotionStorage.gasPromotionStorage().relayer;
    }

    /// @notice Get gas spending for a specific user and operation.
    function getUserSpending(
        GasPromotionStorage.OperationType operationType,
        address user
    ) external view returns (uint256) {
        bytes32 userKey = keccak256(abi.encodePacked(uint8(operationType), user));
        return GasPromotionStorage.gasPromotionStorage().userSpending[userKey];
    }
}
