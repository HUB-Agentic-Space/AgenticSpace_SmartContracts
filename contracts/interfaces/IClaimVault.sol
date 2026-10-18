// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

/**
 * @title IClaimVault
 * @dev Public interface for cryptographically authorized QR voucher claims.
 * @author Carlos Delfino
 * @notice Contact: consultoria@carlosdelfino.eti.br | WhatsApp: +55 (85) 98520-5490
 */
interface IClaimVault {
    struct ClaimAuthorization {
        bytes32 voucherId;
        bytes32 campaignId;
        address recipient;
        address asset;
        uint256 amount;
        uint256 nonce;
        uint256 deadline;
    }

    event VoucherClaimed(
        bytes32 indexed voucherId,
        bytes32 indexed campaignId,
        address indexed recipient,
        address asset,
        uint256 amount,
        uint256 tokenId
    );

    function claim(
        ClaimAuthorization calldata authorization,
        bytes calldata signature
    ) external returns (uint256 tokenId);
}
