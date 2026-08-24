// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

/**
 * @title X402Storage
 * @dev Diamond Storage namespace for the x402 (HTTP 402 Payment Required)
 *      facilitator: pay-per-call CAS settlements between agents, either
 *      paid directly by the caller's own wallet or authorized off-chain
 *      via EIP-712 and submitted by a relayer.
 *
 *      Padrões: Diamond Storage (EIP-2535), Facilitator (x402 role)
 */
library X402Storage {
    bytes32 internal constant STORAGE_POSITION =
        keccak256("agentic.space.diamond.x402.storage");

    struct X402StorageData {
        // payer => requestHash => already settled (anti-replay).
        mapping(address => mapping(bytes32 => bool)) usedRequests;
        uint256 protocolFeeBps;
        bool initialized;
    }

    function x402Storage()
        internal
        pure
        returns (X402StorageData storage s)
    {
        bytes32 position = STORAGE_POSITION;
        assembly {
            s.slot := position
        }
    }
}
