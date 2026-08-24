// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { LibDiamond } from "../diamond/libraries/LibDiamond.sol";
import { DiamondAccessControl } from "../diamond/access/DiamondAccessControl.sol";
import { PaymentStorage } from "../diamond/storage/PaymentStorage.sol";
import { PaymentLib } from "../libs/PaymentLib.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title PaymentFacet
 * @dev Facet for managing CAS token payment configuration.
 *      Admin functions to set CAS token, infrastructure fund and fee schedule.
 *      Fee charging happens inside AgentRegistryFacet and other facets
 *      via PaymentLib.
 *
 *      Also provides promotional batch CAS transfers (batchTransfer / distribute)
 *      for admin promotional distributions — replaces standalone CASBatchTransfer.
 *
 *      Padrões: Diamond Storage (EIP-2535), Factory (token binding)
 */
contract PaymentFacet {
    using SafeERC20 for IERC20;

    uint256 internal constant MAX_BATCH_RECIPIENTS = 200;
    uint256 internal constant MAX_FEE = 10000 * 1e18;

    // -----------------------------------------------------------------------
    // Reentrancy guard (Diamond Storage)
    // -----------------------------------------------------------------------

    bytes32 internal constant REENTRANCY_SLOT =
        keccak256("agentic.space.diamond.payment.reentrancy");
    uint256 internal constant _NOT_ENTERED = 1;
    uint256 internal constant _ENTERED = 2;

    modifier nonReentrant() {
        bytes32 slot = REENTRANCY_SLOT;
        uint256 status;
        assembly { status := sload(slot) }
        if (status == _ENTERED) revert("ReentrancyGuard: reentrant call");
        assembly { sstore(slot, _ENTERED) }
        _;
        assembly { sstore(slot, _NOT_ENTERED) }
    }

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    event CasTokenSet(address indexed token);
    event InfrastructureFundSet(address indexed fund);
    event FeesUpdated(uint256 registrationFee, uint256 validationFee, uint256 daoProposalFee, uint256 userRegistrationFee);
    event FeePaid(address indexed payer, uint256 feeType, uint256 amount);
    event CustomFeeSet(uint256 indexed feeType, uint256 amount);
    event FeeTypeRegistered(uint256 indexed feeType, uint256 amount);
    event WethTokenSet(address indexed token);
    event CasSwapSet(address indexed swap);
    event BatchTransferExecuted(address indexed from, uint256 totalAmount, uint256 recipientCount);
    event BatchDistributed(address indexed by, uint256 totalAmount, uint256 recipientCount);

    // -----------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------

    error ZeroAddress();
    error LengthMismatch(uint256 recipients, uint256 amounts);
    error MaxRecipientsExceeded(uint256 max, uint256 provided);
    error CasTokenNotSet();
    error InsufficientCasBalance(uint256 available, uint256 required);
    error FeeTooHigh(uint256 provided, uint256 max);
    error FeeTypeNotRegistered(uint256 feeType);

    // -----------------------------------------------------------------------
    // Init (called via diamondCut delegatecall)
    // -----------------------------------------------------------------------

    function initPayment() external {
        LibDiamond.enforceIsContractOwner();
        PaymentStorage.PaymentStorageData storage ps = PaymentStorage.paymentStorage();
        ps.fees = PaymentLib.defaultFees();
        PaymentLib.initDefaultCustomFees();
    }

    // -----------------------------------------------------------------------
    // Admin functions
    // -----------------------------------------------------------------------

    function setCasToken(address token) external {
        DiamondAccessControl.enforceIsContractOwner();
        if (token == address(0)) revert ZeroAddress();
        PaymentStorage.paymentStorage().casToken = IERC20(token);
        emit CasTokenSet(token);
    }

    function setInfrastructureFund(address fund) external {
        DiamondAccessControl.enforceIsContractOwner();
        if (fund == address(0)) revert ZeroAddress();
        PaymentStorage.paymentStorage().infrastructureFund = fund;
        emit InfrastructureFundSet(fund);
    }

    function updateFees(PaymentStorage.FeeConfig memory newFees) external {
        DiamondAccessControl.enforceIsContractOwner();
        if (newFees.registrationFee > MAX_FEE) revert FeeTooHigh(newFees.registrationFee, MAX_FEE);
        if (newFees.validationFee > MAX_FEE) revert FeeTooHigh(newFees.validationFee, MAX_FEE);
        if (newFees.daoProposalFee > MAX_FEE) revert FeeTooHigh(newFees.daoProposalFee, MAX_FEE);
        if (newFees.userRegistrationFee > MAX_FEE) revert FeeTooHigh(newFees.userRegistrationFee, MAX_FEE);
        PaymentStorage.paymentStorage().fees = newFees;
        emit FeesUpdated(newFees.registrationFee, newFees.validationFee, newFees.daoProposalFee, newFees.userRegistrationFee);
    }

    function setWethToken(address token) external {
        DiamondAccessControl.enforceIsContractOwner();
        if (token == address(0)) revert ZeroAddress();
        PaymentStorage.paymentStorage().wethToken = token;
        emit WethTokenSet(token);
    }

    function setCasSwap(address swap) external {
        DiamondAccessControl.enforceIsContractOwner();
        if (swap == address(0)) revert ZeroAddress();
        PaymentStorage.paymentStorage().casSwap = swap;
        emit CasSwapSet(swap);
    }

    // -----------------------------------------------------------------------
    // Custom fee management (extensible)
    // -----------------------------------------------------------------------

    function registerFeeType(uint256 feeType, uint256 amount) external {
        DiamondAccessControl.enforceIsContractOwner();
        if (amount > MAX_FEE) revert FeeTooHigh(amount, MAX_FEE);
        PaymentLib.registerFeeType(feeType, amount);
        emit FeeTypeRegistered(feeType, amount);
    }

    function setCustomFee(uint256 feeType, uint256 amount) external {
        DiamondAccessControl.enforceIsContractOwner();
        if (amount > MAX_FEE) revert FeeTooHigh(amount, MAX_FEE);
        PaymentStorage.PaymentStorageData storage ps = PaymentStorage.paymentStorage();
        if (!ps.feeTypeExists[feeType]) revert FeeTypeNotRegistered(feeType);
        ps.customFees[feeType] = amount;
        emit CustomFeeSet(feeType, amount);
    }

    // -----------------------------------------------------------------------
    // Promotional Batch Transfer
    // -----------------------------------------------------------------------

    /**
     * @notice Transfere CAS do caller para múltiplos destinatários em 1 tx.
     * @dev Caller deve aprovar o Diamond para gastar CAS previamente.
     *      Destinatários com address(0) ou amount=0 são silenciosamente pulados.
     *      Padrão CEI: efeitos (event) após interações (safeTransferFrom).
     * @param recipients Lista de endereços destinatários.
     * @param amounts Lista de quantidades (mesmo índice dos recipients).
     */
    function batchTransfer(
        address[] calldata recipients,
        uint256[] calldata amounts
    ) external nonReentrant {
        PaymentStorage.PaymentStorageData storage ps = PaymentStorage.paymentStorage();
        IERC20 cas = ps.casToken;
        if (address(cas) == address(0)) revert CasTokenNotSet();

        if (recipients.length != amounts.length)
            revert LengthMismatch(recipients.length, amounts.length);
        if (recipients.length > MAX_BATCH_RECIPIENTS)
            revert MaxRecipientsExceeded(MAX_BATCH_RECIPIENTS, recipients.length);

        uint256 totalNeeded = 0;
        for (uint256 i = 0; i < amounts.length; i++) {
            totalNeeded += amounts[i];
        }

        uint256 successCount = 0;
        for (uint256 i = 0; i < recipients.length; i++) {
            if (recipients[i] == address(0) || amounts[i] == 0) continue;
            cas.safeTransferFrom(msg.sender, recipients[i], amounts[i]);
            successCount++;
        }

        emit BatchTransferExecuted(msg.sender, totalNeeded, successCount);
    }

    /**
     * @notice Distribui CAS do saldo do Diamond para múltiplos destinatários.
     * @dev Apenas o contract owner. CAS deve estar no saldo do Diamond.
     * @param recipients Lista de endereços destinatários.
     * @param amounts Lista de quantidades (mesmo índice dos recipients).
     */
    function distribute(
        address[] calldata recipients,
        uint256[] calldata amounts
    ) external nonReentrant {
        DiamondAccessControl.enforceIsContractOwner();

        PaymentStorage.PaymentStorageData storage ps = PaymentStorage.paymentStorage();
        IERC20 cas = ps.casToken;
        if (address(cas) == address(0)) revert CasTokenNotSet();

        if (recipients.length != amounts.length)
            revert LengthMismatch(recipients.length, amounts.length);
        if (recipients.length > MAX_BATCH_RECIPIENTS)
            revert MaxRecipientsExceeded(MAX_BATCH_RECIPIENTS, recipients.length);

        uint256 totalNeeded = 0;
        for (uint256 i = 0; i < amounts.length; i++) {
            totalNeeded += amounts[i];
        }

        uint256 balance = cas.balanceOf(address(this));
        if (balance < totalNeeded) {
            revert InsufficientCasBalance(balance, totalNeeded);
        }

        uint256 successCount = 0;
        for (uint256 i = 0; i < recipients.length; i++) {
            if (recipients[i] == address(0) || amounts[i] == 0) continue;
            cas.safeTransfer(recipients[i], amounts[i]);
            successCount++;
        }

        emit BatchDistributed(msg.sender, totalNeeded, successCount);
    }

    // -----------------------------------------------------------------------
    // View functions
    // -----------------------------------------------------------------------

    function getCasToken() external view returns (address) {
        return address(PaymentStorage.paymentStorage().casToken);
    }

    function getInfrastructureFund() external view returns (address) {
        return PaymentStorage.paymentStorage().infrastructureFund;
    }

    function getFees() external view returns (PaymentStorage.FeeConfig memory) {
        return PaymentStorage.paymentStorage().fees;
    }

    function getWethToken() external view returns (address) {
        return PaymentStorage.paymentStorage().wethToken;
    }

    function getCasSwap() external view returns (address) {
        return PaymentStorage.paymentStorage().casSwap;
    }

    function getCustomFee(uint256 feeType) external view returns (uint256) {
        return PaymentLib.getCustomFee(feeType);
    }

    function isFeeTypeRegistered(uint256 feeType) external view returns (bool) {
        return PaymentLib.isFeeTypeRegistered(feeType);
    }

    function getAllFeeTypes() external view returns (uint256[] memory feeTypes, uint256[] memory amounts) {
        feeTypes = PaymentLib.getRegisteredFeeTypes();
        amounts = new uint256[](feeTypes.length);
        for (uint256 i = 0; i < feeTypes.length; i++) {
            amounts[i] = PaymentStorage.paymentStorage().customFees[feeTypes[i]];
        }
    }
}
