// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title PaymentStorage
 * @dev Diamond Storage namespace for payment configuration and fee processing.
 *      Stores CAS token address, infrastructure fund address and fee parameters
 *      used during agent registration and other payable operations.
 *
 *      Padrões: Diamond Storage (EIP-2535), Memento (state persistence)
 */
library PaymentStorage {
    bytes32 internal constant STORAGE_POSITION =
        keccak256("agentic.space.diamond.payment.storage");

    // -----------------------------------------------------------------------
    // Data structures
    // -----------------------------------------------------------------------

    struct FeeConfig {
        uint256 registrationFee;
        uint256 validationFee;
        uint256 daoProposalFee;
        uint256 userRegistrationFee;
    }

    struct PaymentStorageData {
        IERC20 casToken;
        address infrastructureFund;
        FeeConfig fees;
        address wethToken;
        address casSwap;
        // Extensible fee system — allows adding new fee types without
        // modifying FeeConfig struct. Appended at end for storage safety.
        mapping(uint256 => uint256) customFees;
        mapping(uint256 => bool) feeTypeExists;
        uint256[] registeredFeeTypes;
    }

    // -----------------------------------------------------------------------
    // Access
    // -----------------------------------------------------------------------

    function paymentStorage()
        internal
        pure
        returns (PaymentStorageData storage s)
    {
        bytes32 position = STORAGE_POSITION;
        assembly {
            s.slot := position
        }
    }
}
