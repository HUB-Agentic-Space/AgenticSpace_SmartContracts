// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { IERC6551Registry } from "../interfaces/IERC6551Registry.sol";

/// @dev Test-only registry that returns an address without deploying the
///      canonical ERC-6551 proxy runtime.
contract MockERC6551Registry is IERC6551Registry {
    address private immutable returnedAccount;

    constructor(address returnedAccount_) {
        returnedAccount = returnedAccount_;
    }

    function createAccount(address, bytes32, uint256, address, uint256)
        external
        view
        returns (address)
    {
        return returnedAccount;
    }

    function account(address, bytes32, uint256, address, uint256)
        external
        view
        returns (address)
    {
        return returnedAccount;
    }
}
