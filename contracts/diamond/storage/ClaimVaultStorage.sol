// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

/**
 * @title ClaimVaultStorage
 * @dev Namespaced Diamond storage for QR voucher custody and replay protection.
 * @author Carlos Delfino
 * @notice Contact: consultoria@carlosdelfino.eti.br | WhatsApp: +55 (85) 98520-5490
 */
library ClaimVaultStorage {
    bytes32 internal constant STORAGE_POSITION =
        keccak256("agentic.space.diamond.claim.vault.storage");

    struct CampaignReservation {
        address asset;
        uint256 reserved;
        uint256 claimed;
        bool active;
    }

    struct ClaimRecord {
        bytes32 campaignId;
        address recipient;
        address asset;
        uint256 amount;
        uint256 tokenId;
    }

    struct ClaimVaultStorageData {
        address claimSigner;
        bool initialized;
        bool claimsPaused;
        uint256 reentrancyStatus;
        mapping(address => bool) supportedAssets;
        mapping(address => uint256) vaultBalances;
        mapping(address => uint256) committedBalances;
        mapping(bytes32 => CampaignReservation) campaigns;
        mapping(bytes32 => ClaimRecord) claims;
        mapping(bytes32 => bool) claimedVouchers;
        mapping(uint256 => bool) usedNonces;
    }

    function claimVaultStorage()
        internal
        pure
        returns (ClaimVaultStorageData storage s)
    {
        bytes32 position = STORAGE_POSITION;
        assembly {
            s.slot := position
        }
    }
}
