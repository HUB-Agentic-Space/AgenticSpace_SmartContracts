// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import { IERC721Metadata } from "@openzeppelin/contracts/token/ERC721/extensions/IERC721Metadata.sol";
import { Strings } from "@openzeppelin/contracts/utils/Strings.sol";
import { LibDiamond } from "../diamond/libraries/LibDiamond.sol";
import { ClaimNFTStorage } from "../diamond/storage/ClaimNFTStorage.sol";
import { IERC5192 } from "../interfaces/IERC5192.sol";

/**
 * @title ClaimNFTFacet
 * @dev Read-only ERC-721 surface and ERC-5192 lock semantics for voucher receipts.
 * @author Carlos Delfino
 * @notice Contact: consultoria@carlosdelfino.eti.br | WhatsApp: +55 (85) 98520-5490
 */
contract ClaimNFTFacet {
    error AlreadyInitialized();
    error InvalidToken(uint256 tokenId);
    error Soulbound();
    error ZeroAddress();

    event BaseTokenURIUpdated(string baseTokenURI);

    /// @notice Initializes collection metadata once through a Diamond cut.
    function initClaimNFT(
        string calldata collectionName,
        string calldata collectionSymbol,
        string calldata baseTokenURI
    ) external {
        LibDiamond.enforceIsContractOwner();
        ClaimNFTStorage.ClaimNFTStorageData storage s = ClaimNFTStorage.claimNFTStorage();
        if (s.initialized) revert AlreadyInitialized();
        s.initialized = true;
        s.name = collectionName;
        s.symbol = collectionSymbol;
        s.baseTokenURI = baseTokenURI;
        LibDiamond.DiamondStorage storage diamondStorage = LibDiamond.diamondStorage();
        diamondStorage.supportedInterfaces[type(IERC165).interfaceId] = true;
        diamondStorage.supportedInterfaces[type(IERC721).interfaceId] = true;
        diamondStorage.supportedInterfaces[type(IERC721Metadata).interfaceId] = true;
        diamondStorage.supportedInterfaces[type(IERC5192).interfaceId] = true;
    }

    /// @notice Updates the prefix used to resolve token metadata.
    function setClaimNFTBaseURI(string calldata baseTokenURI) external {
        LibDiamond.enforceIsContractOwner();
        ClaimNFTStorage.claimNFTStorage().baseTokenURI = baseTokenURI;
        emit BaseTokenURIUpdated(baseTokenURI);
    }

    function name() external view returns (string memory) {
        return ClaimNFTStorage.claimNFTStorage().name;
    }

    function symbol() external view returns (string memory) {
        return ClaimNFTStorage.claimNFTStorage().symbol;
    }

    function balanceOf(address owner) external view returns (uint256) {
        if (owner == address(0)) revert ZeroAddress();
        return ClaimNFTStorage.claimNFTStorage().balances[owner];
    }

    function ownerOf(uint256 tokenId) public view returns (address owner) {
        owner = ClaimNFTStorage.claimNFTStorage().owners[tokenId];
        if (owner == address(0)) revert InvalidToken(tokenId);
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        ownerOf(tokenId);
        ClaimNFTStorage.ClaimNFTStorageData storage s = ClaimNFTStorage.claimNFTStorage();
        return string.concat(s.baseTokenURI, Strings.toString(tokenId));
    }

    function locked(uint256 tokenId) external view returns (bool) {
        ownerOf(tokenId);
        return true;
    }

    function tokenOfVoucher(bytes32 voucherId) external view returns (uint256) {
        return ClaimNFTStorage.claimNFTStorage().tokenByVoucher[voucherId];
    }

    function voucherOfToken(uint256 tokenId) external view returns (bytes32) {
        ownerOf(tokenId);
        return ClaimNFTStorage.claimNFTStorage().voucherByToken[tokenId];
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        ownerOf(tokenId);
        return address(0);
    }

    function isApprovedForAll(address, address) external pure returns (bool) {
        return false;
    }

    function approve(address, uint256) external pure {
        revert Soulbound();
    }

    function setApprovalForAll(address, bool) external pure {
        revert Soulbound();
    }

    function transferFrom(address, address, uint256) external pure {
        revert Soulbound();
    }

    function safeTransferFrom(address, address, uint256) external pure {
        revert Soulbound();
    }

    function safeTransferFrom(address, address, uint256, bytes calldata) external pure {
        revert Soulbound();
    }

}
