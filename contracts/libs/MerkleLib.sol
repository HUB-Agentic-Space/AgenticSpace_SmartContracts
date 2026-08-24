// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

/**
 * @title MerkleLib
 * @dev Library for Merkle tree verification (binary tree, sorted pairs).
 *      Each leaf is a keccak256 hash of a prompt's identification metadata.
 *      Internal nodes are keccak256(abi.encode(left, right)) with sorting.
 *
 *      Used by AgentRegistryFacet to verify that a specific prompt hash
 *      belongs to an agent's Merkle root without storing all hashes on-chain.
 *
 *      Padrões: Strategy (verification algorithm), Library (Solidity)
 */
library MerkleLib {
    /**
     * @dev Verifies a Merkle proof for a given leaf hash.
     * @param root The Merkle root stored on-chain.
     * @param leaf The leaf hash (prompt hash with metadata).
     * @param proof Array of sibling hashes from leaf to root.
     * @return True if the proof is valid.
     */
    function verify(
        bytes32 root,
        bytes32 leaf,
        bytes32[] memory proof
    ) internal pure returns (bool) {
        bytes32 computedHash = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 proofElement = proof[i];
            if (computedHash < proofElement) {
                computedHash = keccak256(abi.encode(computedHash, proofElement));
            } else {
                computedHash = keccak256(abi.encode(proofElement, computedHash));
            }
        }
        return computedHash == root;
    }

    /**
     * @dev Computes a parent node from two children (sorted).
     * @param left First child hash.
     * @param right Second child hash.
     * @return Parent hash.
     */
    function parent(bytes32 left, bytes32 right) internal pure returns (bytes32) {
        if (left < right) {
            return keccak256(abi.encode(left, right));
        }
        return keccak256(abi.encode(right, left));
    }

    /**
     * @dev Computes a leaf hash from prompt metadata.
     *      The hash includes: promptName, promptType, contentHash.
     *      It never includes API keys or private content.
     * @param promptName Name of the prompt (e.g. "AGENTS.md", "IDENTITY.md").
     * @param promptType Type: 0 = immutable, 1 = secondary.
     * @param contentHash Hash of the actual prompt content (from wallet).
     * @return leaf The leaf hash for the Merkle tree.
     */
    function computeLeaf(
        string memory promptName,
        uint8 promptType,
        bytes32 contentHash
    ) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(promptName, promptType, contentHash));
    }
}
