// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title SignatureLib
 * @dev EIP-712 domain separator and digest helpers safe for use inside
 *      Diamond facets. `address(this)` and `block.chainid` are read at
 *      call time (never cached as `immutable`), because a facet's
 *      immutables are baked in at the facet's own deployment and would
 *      otherwise resolve to the facet address instead of the Diamond
 *      address once invoked via delegatecall — a well-known Diamond +
 *      EIP-712 pitfall.
 *
 *      Padrões: Strategy (signature verification), Library (Solidity)
 */
library SignatureLib {
    bytes32 internal constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    /// @dev Builds the EIP-712 domain separator for the calling contract
    ///      (the Diamond address, when invoked via delegatecall from a facet).
    function domainSeparator(string memory name, string memory version) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                block.chainid,
                address(this)
            )
        );
    }

    /// @dev Combines a domain separator and a struct hash into the final
    ///      EIP-712 digest to be signed/recovered (`\x19\x01` prefix).
    function hashTypedData(bytes32 domainSep, bytes32 structHash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSep, structHash));
    }

    /// @dev Recovers the signer of an EIP-712 digest. Reverts (via OZ
    ///      ECDSA) on malformed or malleable (high-s) signatures.
    function recover(bytes32 digest, bytes memory signature) internal pure returns (address) {
        return ECDSA.recover(digest, signature);
    }
}
