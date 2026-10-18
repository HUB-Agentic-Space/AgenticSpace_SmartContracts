// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { ClaimNFTStorage } from "../diamond/storage/ClaimNFTStorage.sol";

/**
 * @title ClaimNFTLib
 * @dev Shared mint primitive keeps voucher transfer and soulbound issuance atomic inside the Diamond.
 * @author Carlos Delfino
 * @notice Contact: consultoria@carlosdelfino.eti.br | WhatsApp: +55 (85) 98520-5490
 */
library ClaimNFTLib {
    error ZeroAddress();
    error VoucherAlreadyMinted(bytes32 voucherId);

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Locked(uint256 tokenId);

    function mint(address recipient, bytes32 voucherId) internal returns (uint256 tokenId) {
        if (recipient == address(0)) revert ZeroAddress();

        ClaimNFTStorage.ClaimNFTStorageData storage s = ClaimNFTStorage.claimNFTStorage();
        if (s.tokenByVoucher[voucherId] != 0) revert VoucherAlreadyMinted(voucherId);

        tokenId = ++s.nextTokenId;
        s.owners[tokenId] = recipient;
        s.balances[recipient] += 1;
        s.voucherByToken[tokenId] = voucherId;
        s.tokenByVoucher[voucherId] = tokenId;

        emit Transfer(address(0), recipient, tokenId);
        emit Locked(tokenId);
    }
}
