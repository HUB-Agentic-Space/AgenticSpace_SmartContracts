// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

/**
 * @title MerkleTreeLib
 * @dev Library for Merkle tree verification used by CommunityDAO.
 *      Verifies that a leaf (pauta item hash) is part of a Merkle root
 *      stored on-chain. The full tree is built off-chain (backend) and
 *      only the root is committed to the smart contract.
 *
 *      Padrões: Strategy (verification), Template Method (verify)
 */
library MerkleTreeLib {
    error InvalidProofLength();
    error InvalidLeaf();

    /**
     * @dev Verifies a Merkle proof for a single leaf.
     * @param root    Merkle root stored on-chain.
     * @param leaf    Hash of the pauta item content.
     * @param proof   Array of sibling hashes from leaf to root.
     * @return True if the proof is valid.
     */
    function verify(
        bytes32 root,
        bytes32 leaf,
        bytes32[] calldata proof
    ) internal pure returns (bool) {
        if (proof.length == 0) {
            return root == leaf;
        }

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
     * @dev Verifies multiple leaves against the same root.
     * @param root   Merkle root stored on-chain.
     * @param leaves Array of leaf hashes.
     * @param proofs Array of proof arrays (one per leaf).
     * @return True if all proofs are valid.
     */
    function verifyBatch(
        bytes32 root,
        bytes32[] calldata leaves,
        bytes32[][] calldata proofs
    ) internal pure returns (bool) {
        if (leaves.length != proofs.length) {
            return false;
        }
        for (uint256 i = 0; i < leaves.length; i++) {
            if (!verify(root, leaves[i], proofs[i])) {
                return false;
            }
        }
        return true;
    }

    /**
     * @dev Computes the leaf hash from pauta item content.
     * @param itemId     On-chain item ID.
     * @param contentHash Hash of the off-chain text content.
     * @return Leaf hash for Merkle tree.
     */
    function computeLeaf(
        uint256 itemId,
        bytes32 contentHash
    ) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(itemId, contentHash));
    }
}
