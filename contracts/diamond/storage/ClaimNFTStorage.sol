// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

/**
 * @title ClaimNFTStorage
 * @dev Namespaced Diamond storage for non-transferable voucher claim receipts.
 * @author Carlos Delfino
 * @notice Contact: consultoria@carlosdelfino.eti.br | WhatsApp: +55 (85) 98520-5490
 */
library ClaimNFTStorage {
    bytes32 internal constant STORAGE_POSITION =
        keccak256("agentic.space.diamond.claim.nft.storage");

    struct ClaimNFTStorageData {
        string name;
        string symbol;
        string baseTokenURI;
        uint256 nextTokenId;
        bool initialized;
        mapping(uint256 => address) owners;
        mapping(address => uint256) balances;
        mapping(uint256 => bytes32) voucherByToken;
        mapping(bytes32 => uint256) tokenByVoucher;
    }

    function claimNFTStorage()
        internal
        pure
        returns (ClaimNFTStorageData storage s)
    {
        bytes32 position = STORAGE_POSITION;
        assembly {
            s.slot := position
        }
    }
}
