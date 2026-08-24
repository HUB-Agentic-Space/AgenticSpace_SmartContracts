// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

/**
 * @title IERC165
 * @dev EIP-165 interface for detecting supported interfaces.
 */
interface IERC165 {
    /**
     * @dev Returns true if this contract implements the interface defined by
     *      `interfaceId`.
     */
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}
