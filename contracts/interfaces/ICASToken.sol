// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

/**
 * @title ICASToken
 * @dev Interface for the CAS (Cryptocoin Agentic Space) token.
 *      ERC-20 Adaptável with mintable supply, max cap, and access control.
 *      Used for DAO transactions, agent validation, user registration, identity,
 *      and CAS↔POL swap.
 */
interface ICASToken {
    event Minted(address indexed to, uint256 amount);
    event Burned(address indexed from, uint256 amount);
    event MaxSupplyAnnounced(uint256 maxSupply);
    event Frozen(address indexed account, uint256 untilTime);
    event Unfrozen(address indexed account);
    event VotingLockStateChanged(bool active);

    function mint(address to, uint256 amount) external;
    function burn(uint256 amount) external;
    function burnFrom(address from, uint256 amount) external;
    function isMinter(address account) external view returns (bool);
    function isRatioAdmin(address account) external view returns (bool);
    function disclaimer() external view returns (string memory);
    function maxSupply() external view returns (uint256);

    function freeze(address account) external;
    function freezeUntil(address account, uint256 endTime) external;
    function unfreeze(address account) external;
    function isFrozen(address account) external view returns (bool);
    function freezeUntilOf(address account) external view returns (uint256);
    function setVotingLock(bool active) external;
    function isVotingLockActive() external view returns (bool);
}
