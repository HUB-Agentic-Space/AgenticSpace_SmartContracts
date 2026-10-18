// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { IERC721Metadata } from "@openzeppelin/contracts/token/ERC721/extensions/IERC721Metadata.sol";
import { IERC5192 } from "./IERC5192.sol";

/**
 * @title IClaimNFT
 * @dev ERC-721 metadata and ERC-5192 interface for soulbound claim receipts.
 * @author Carlos Delfino
 * @notice Contact: consultoria@carlosdelfino.eti.br | WhatsApp: +55 (85) 98520-5490
 */
interface IClaimNFT is IERC721Metadata, IERC5192 {
    function tokenOfVoucher(bytes32 voucherId) external view returns (uint256);
    function voucherOfToken(uint256 tokenId) external view returns (bytes32);
}
