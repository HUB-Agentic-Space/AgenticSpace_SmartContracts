// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title CASBatchTransfer
 * @dev Gas-efficient batch transfer of CAS tokens to multiple recipients
 *      in a single transaction. Used for promotional distributions.
 *
 *      Two modes:
 *      - batchTransfer: pulls CAS from caller via transferFrom (requires approve)
 *      - distribute: sends CAS from this contract's own balance (owner only)
 *
 *      Padrões: Command (batch operations), ReentrancyGuard (security)
 */
contract CASBatchTransfer is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable casToken;

    uint256 public constant MAX_RECIPIENTS = 200;

    event BatchTransferExecuted(
        address indexed from,
        uint256 totalAmount,
        uint256 recipientCount
    );
    event BatchTransferFailed(
        address indexed recipient,
        uint256 amount,
        string reason
    );
    event Distributed(
        address indexed by,
        uint256 totalAmount,
        uint256 recipientCount
    );
    event TokensRescued(address indexed token, address indexed to, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error LengthMismatch(uint256 recipients, uint256 amounts);
    error InsufficientAllowance(uint256 available, uint256 required);
    error InsufficientBalance(uint256 available, uint256 required);
    error MaxRecipientsExceeded(uint256 max, uint256 provided);

    constructor(address casToken_) Ownable(msg.sender) {
        if (casToken_ == address(0)) revert ZeroAddress();
        casToken = IERC20(casToken_);
    }

    /**
     * @notice Transfere CAS do caller para múltiplos destinatários em 1 tx.
     * @dev Caller deve aprovar este contrato para gastar CAS previamente.
     *      Destinatários com address(0) ou amount=0 são silenciosamente pulados.
     * @param recipients Lista de endereços destinatários.
     * @param amounts Lista de quantidades (mesmo índice dos recipients).
     */
    function batchTransfer(
        address[] calldata recipients,
        uint256[] calldata amounts
    ) external nonReentrant {
        if (recipients.length != amounts.length)
            revert LengthMismatch(recipients.length, amounts.length);
        if (recipients.length > MAX_RECIPIENTS)
            revert MaxRecipientsExceeded(MAX_RECIPIENTS, recipients.length);

        uint256 totalNeeded = 0;
        for (uint256 i = 0; i < amounts.length; i++) {
            totalNeeded += amounts[i];
        }

        uint256 allowanceVal = casToken.allowance(msg.sender, address(this));
        if (allowanceVal < totalNeeded)
            revert InsufficientAllowance(allowanceVal, totalNeeded);

        uint256 successCount = 0;
        for (uint256 i = 0; i < recipients.length; i++) {
            if (recipients[i] == address(0) || amounts[i] == 0) continue;

            casToken.safeTransferFrom(msg.sender, recipients[i], amounts[i]);
            successCount++;
        }

        emit BatchTransferExecuted(msg.sender, totalNeeded, successCount);
    }

    /**
     * @notice Distribui CAS do saldo deste contrato para múltiplos destinatários.
     * @dev Apenas owner. Útil quando o admin deposita CAS primeiro e depois distribui.
     * @param recipients Lista de endereços destinatários.
     * @param amounts Lista de quantidades (mesmo índice dos recipients).
     */
    function distribute(
        address[] calldata recipients,
        uint256[] calldata amounts
    ) external onlyOwner nonReentrant {
        if (recipients.length != amounts.length)
            revert LengthMismatch(recipients.length, amounts.length);
        if (recipients.length > MAX_RECIPIENTS)
            revert MaxRecipientsExceeded(MAX_RECIPIENTS, recipients.length);

        uint256 totalNeeded = 0;
        for (uint256 i = 0; i < amounts.length; i++) {
            totalNeeded += amounts[i];
        }

        uint256 balance = casToken.balanceOf(address(this));
        if (balance < totalNeeded)
            revert InsufficientBalance(balance, totalNeeded);

        uint256 successCount = 0;
        for (uint256 i = 0; i < recipients.length; i++) {
            if (recipients[i] == address(0) || amounts[i] == 0) continue;

            casToken.safeTransfer(recipients[i], amounts[i]);
            successCount++;
        }

        emit Distributed(msg.sender, totalNeeded, successCount);
    }

    /**
     * @notice Resgata tokens acidentalmente enviados para este contrato.
     * @dev Apenas owner. Não permite resgatar CAS (use distribute).
     */
    function rescueTokens(address token, address to, uint256 amount) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        IERC20(token).safeTransfer(to, amount);
        emit TokensRescued(token, to, amount);
    }
}
