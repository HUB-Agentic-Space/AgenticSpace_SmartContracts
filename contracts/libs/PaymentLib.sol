// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { PaymentStorage } from "../diamond/storage/PaymentStorage.sol";

/**
 * @title PaymentLib
 * @dev Internal library for processing CAS token fee payments.
 *      Transfers fees from the payer to the infrastructure fund.
 *
 *      Padrões: Strategy (fee processing), Template Method (processFeePayment)
 */
library PaymentLib {
    using SafeERC20 for IERC20;

    uint256 internal constant FEE_TYPE_REGISTRATION = 0;
    uint256 internal constant FEE_TYPE_VALIDATION = 1;
    uint256 internal constant FEE_TYPE_DAO_PROPOSAL = 2;
    uint256 internal constant FEE_TYPE_USER_REGISTRATION = 3;
    uint256 internal constant FEE_TYPE_PAUTA_SUBMISSION = 4;
    uint256 internal constant FEE_TYPE_VOTING = 5;
    /// @dev Catalog entry for the CAS reserve required when a certificate is
    ///      issued. RapportCertificate transfers this amount to the holder's
    ///      ERC-6551 account; it must not be processed again as treasury fee.
    uint256 internal constant FEE_TYPE_CERTIFICATE_ISSUANCE = 6;
    uint256 internal constant CERTIFICATE_ISSUANCE_FEE = 50 * 1e18;
    uint256 internal constant FEE_TYPE_ARBITRATION_PROPOSAL = 100010;
    uint256 internal constant FEE_TYPE_ARBITRATION_VOTE = 100011;

    error CasTokenNotSet();
    error InfrastructureFundNotSet();
    error FeeTransferFailed();
    error CasSwapNotSet();
    error WethNotSupported();
    error InsufficientPayment(uint256 required, uint256 provided);
    error UnknownFeeType(uint256 feeType);
    error FeeTypeNotRegistered(uint256 feeType);

    function defaultFees() internal pure returns (PaymentStorage.FeeConfig memory) {
        return PaymentStorage.FeeConfig({
            registrationFee: 100 * 1e18,
            validationFee: 10 * 1e18,
            daoProposalFee: 50 * 1e18,
            userRegistrationFee: 1 * 1e18
        });
    }

    function processFeePayment(
        address payer,
        uint256 feeType
    ) internal returns (uint256 amount) {
        PaymentStorage.PaymentStorageData storage ps = PaymentStorage.paymentStorage();

        if (feeType == FEE_TYPE_REGISTRATION) {
            amount = ps.fees.registrationFee;
        } else if (feeType == FEE_TYPE_VALIDATION) {
            amount = ps.fees.validationFee;
        } else if (feeType == FEE_TYPE_DAO_PROPOSAL) {
            amount = ps.fees.daoProposalFee;
        } else if (feeType == FEE_TYPE_USER_REGISTRATION) {
            amount = ps.fees.userRegistrationFee;
        } else if (ps.feeTypeExists[feeType]) {
            amount = ps.customFees[feeType];
        } else {
            revert UnknownFeeType(feeType);
        }

        if (amount == 0) return 0;

        if (address(ps.casToken) == address(0)) revert CasTokenNotSet();
        if (ps.infrastructureFund == address(0)) revert InfrastructureFundNotSet();

        ps.casToken.safeTransferFrom(payer, ps.infrastructureFund, amount);
    }

    function processCustomFeePayment(
        address payer,
        uint256 feeType
    ) internal returns (uint256 amount) {
        PaymentStorage.PaymentStorageData storage ps = PaymentStorage.paymentStorage();
        if (!ps.feeTypeExists[feeType]) revert FeeTypeNotRegistered(feeType);
        amount = ps.customFees[feeType];
        if (amount == 0) return 0;
        if (address(ps.casToken) == address(0)) revert CasTokenNotSet();
        if (ps.infrastructureFund == address(0)) revert InfrastructureFundNotSet();
        ps.casToken.safeTransferFrom(payer, ps.infrastructureFund, amount);
    }

    function getCustomFee(uint256 feeType) internal view returns (uint256) {
        return PaymentStorage.paymentStorage().customFees[feeType];
    }

    function isFeeTypeRegistered(uint256 feeType) internal view returns (bool) {
        return PaymentStorage.paymentStorage().feeTypeExists[feeType];
    }

    function registerFeeType(uint256 feeType, uint256 amount) internal {
        PaymentStorage.PaymentStorageData storage ps = PaymentStorage.paymentStorage();
        if (!ps.feeTypeExists[feeType]) {
            ps.feeTypeExists[feeType] = true;
            ps.registeredFeeTypes.push(feeType);
        }
        ps.customFees[feeType] = amount;
    }

    function getRegisteredFeeTypes() internal view returns (uint256[] memory) {
        return PaymentStorage.paymentStorage().registeredFeeTypes;
    }

    function initDefaultCustomFees() internal {
        registerFeeType(FEE_TYPE_PAUTA_SUBMISSION, 10 * 1e18);
        registerFeeType(FEE_TYPE_VOTING, 50 * 1e18);
        registerFeeType(
            FEE_TYPE_CERTIFICATE_ISSUANCE,
            CERTIFICATE_ISSUANCE_FEE
        );
        registerFeeType(FEE_TYPE_ARBITRATION_PROPOSAL, 5 * 1e18);
        registerFeeType(FEE_TYPE_ARBITRATION_VOTE, 5 * 1e17);
    }

    function getUserRegistrationFee() internal view returns (uint256) {
        return PaymentStorage.paymentStorage().fees.userRegistrationFee;
    }

    function convertCasToPol(uint256 casAmount) internal view returns (uint256) {
        PaymentStorage.PaymentStorageData storage ps = PaymentStorage.paymentStorage();
        if (ps.casSwap == address(0)) revert CasSwapNotSet();

        (bool ok, bytes memory data) = ps.casSwap.staticcall(
            abi.encodeWithSignature("getRatio()")
        );
        if (!ok || data.length < 64) return casAmount;

        (uint256 numerator, uint256 denominator) = abi.decode(data, (uint256, uint256));
        if (numerator == 0 || denominator == 0) return casAmount;

        return (casAmount * denominator) / numerator;
    }

    function convertCasToWeth(uint256 casAmount) internal view returns (uint256) {
        PaymentStorage.PaymentStorageData storage ps = PaymentStorage.paymentStorage();
        if (ps.wethToken == address(0)) revert WethNotSupported();

        return convertCasToPol(casAmount);
    }

    function processUserRegistrationPaymentCas(address payer) internal returns (uint256) {
        return processFeePayment(payer, FEE_TYPE_USER_REGISTRATION);
    }

    function processUserRegistrationPaymentPol(address fund) internal returns (uint256 requiredPol) {
        uint256 casFee = getUserRegistrationFee();
        if (casFee == 0) return 0;

        requiredPol = convertCasToPol(casFee);

        if (fund == address(0)) revert InfrastructureFundNotSet();

        (bool ok, ) = fund.call{value: requiredPol}("");
        if (!ok) revert FeeTransferFailed();
    }

    function processUserRegistrationPaymentWeth(address payer, address fund) internal returns (uint256 requiredWeth) {
        PaymentStorage.PaymentStorageData storage ps = PaymentStorage.paymentStorage();
        if (ps.wethToken == address(0)) revert WethNotSupported();

        uint256 casFee = getUserRegistrationFee();
        if (casFee == 0) return 0;

        requiredWeth = convertCasToWeth(casFee);
        if (fund == address(0)) revert InfrastructureFundNotSet();

        IERC20 weth = IERC20(ps.wethToken);
        uint256 allowance = weth.allowance(payer, address(this));
        if (allowance < requiredWeth) revert InsufficientPayment(requiredWeth, allowance);

        weth.safeTransferFrom(payer, fund, requiredWeth);
    }
}
