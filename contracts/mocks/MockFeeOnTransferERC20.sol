// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Test-only token that burns 1% of each regular transfer.
contract MockFeeOnTransferERC20 is ERC20 {
    constructor() ERC20("Fee CAS", "fCAS") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 amount) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = amount / 100;
            super._update(from, address(0), fee);
            super._update(from, to, amount - fee);
            return;
        }
        super._update(from, to, amount);
    }
}
