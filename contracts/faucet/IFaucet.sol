// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

/**
 * @title IFaucet
 * @dev Interface for the standalone POL Faucet contract.
 *      Permite saque de POL nativo com cooldown e blacklist.
 *
 *      Padrões: Interface (Gang of Four), Abstraction (DDD)
 */
interface IFaucet {
    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    event Withdrawn(address indexed recipient, uint256 amount, uint256 nextAvailable);
    event IntervalUpdated(uint256 oldInterval, uint256 newInterval);
    event AmountUpdated(uint256 oldAmount, uint256 newAmount);
    event BlacklistUpdated(address indexed account, bool isBlacklisted);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event FundsDeposited(address indexed from, uint256 amount);
    event FundsWithdrawn(address indexed owner, uint256 amount);
    event FaucetPaused();
    event FaucetUnpaused();

    // -----------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------

    error NotOwner(address caller);
    error OwnerCannotBeZeroAddress();
    error Blacklisted(address account);
    error CooldownNotElapsed(address account, uint256 nextAvailable);
    error InsufficientFunds(uint256 available, uint256 required);
    error InvalidInterval(uint256 interval);
    error InvalidAmount(uint256 amount);
    error NoFundsToWithdraw();
    error FaucetIsPaused();

    // -----------------------------------------------------------------------
    // Admin functions
    // -----------------------------------------------------------------------

    function transferOwnership(address newOwner) external;
    function setInterval(uint256 _interval) external;
    function setAmount(uint256 _amount) external;
    function setBlacklist(address account, bool _isBlacklisted) external;
    function setNextTry(address account, uint256 timestamp) external;
    function withdrawFunds(uint256 amount) external;

    // -----------------------------------------------------------------------
    // Public functions
    // -----------------------------------------------------------------------

    function requestTokens() external;
    function getBalance() external view returns (uint256);

    // -----------------------------------------------------------------------
    // View functions
    // -----------------------------------------------------------------------

    function owner() external view returns (address);
    function interval() external view returns (uint256);
    function amount() external view returns (uint256);
    function nextTry(address account) external view returns (uint256);
    function isBlacklisted(address account) external view returns (bool);
}
