// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

/**
 * @title ICASToken
 * @dev Interface for the CAS (Criptocoin Agentic Space) token.
 *      ERC-20 Adaptável with mintable supply, max cap, and access control.
 *      Used for DAO transactions, agent validation, user registration, identity,
 *      and CAS↔POL swap.
 */
interface ICASToken {
    event Minted(address indexed to, uint256 amount);
    event Burned(address indexed from, uint256 amount);
    event MaxSupplyAnnounced(uint256 maxSupply);

    function mint(address to, uint256 amount) external;
    function burn(uint256 amount) external;
    function burnFrom(address from, uint256 amount) external;
    function isMinter(address account) external view returns (bool);
    function isRatioAdmin(address account) external view returns (bool);
    function disclaimer() external view returns (string memory);
    function maxSupply() external view returns (uint256);
}
