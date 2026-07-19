// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev ERC-165 interface id: 0x51945447.
interface IERC6551Executable {
    function execute(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation
    ) external payable returns (bytes memory result);
}
