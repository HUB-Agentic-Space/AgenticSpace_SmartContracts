// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Test-only ERC-20 whose 1% transfer fee can be enabled on demand.
contract MockToggleFeeERC20 is ERC20 {
    bool public feeEnabled;

    constructor() ERC20("Toggle Fee CAS", "tfCAS") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setFeeEnabled(bool enabled) external {
        feeEnabled = enabled;
    }

    function _update(address from, address to, uint256 amount) internal override {
        if (feeEnabled && from != address(0) && to != address(0)) {
            uint256 fee = amount / 100;
            super._update(from, address(0), fee);
            super._update(from, to, amount - fee);
            return;
        }
        super._update(from, to, amount);
    }
}
