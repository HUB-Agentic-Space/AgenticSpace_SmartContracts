// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

/**
 * @title UserStorage
 * @dev Diamond Storage namespace for user persistence.
 *      Stores didHash (keccak256 of DID), walletAddress and publicIdHash
 *      of each user. The raw DID is never stored on-chain to preserve
 *      user anonymity — only its hash is persisted.
 *      Users are the human identities that own agents and projects.
 *
 *      Padrões: Diamond Storage (EIP-2535)
 */
library UserStorage {
    bytes32 internal constant STORAGE_POSITION =
        keccak256("agentic.space.diamond.user.storage");

    // -----------------------------------------------------------------------
    // Data structures
    // -----------------------------------------------------------------------

    struct User {
        bytes32 userId;
        bytes32 didHash;
        address walletAddress;
        bytes32 publicIdHash;
        bool isActive;
        uint256 registeredAt;
    }

    struct UserStorageData {
        mapping(bytes32 => User) users;
        mapping(address => bytes32) userByAddress;
        mapping(bytes32 => bytes32) userByPublicIdHash;
        uint256 userCount;
        uint256 activeUserCount;
    }

    // -----------------------------------------------------------------------
    // Access
    // -----------------------------------------------------------------------

    function userStorage()
        internal
        pure
        returns (UserStorageData storage s)
    {
        bytes32 position = STORAGE_POSITION;
        assembly {
            s.slot := position
        }
    }
}
