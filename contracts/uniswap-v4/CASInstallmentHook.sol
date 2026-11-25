// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {CASInstallmentRouter} from "./CASInstallmentRouter.sol";

/// @notice Wallet-level, noncustodial sale schedules shared by the participating v4 pools.
contract CASInstallmentHook {
    using StateLibrary for IPoolManager;

    uint64 public constant INTERVAL = 1 days;
    IPoolManager public immutable manager;
    IERC20 public immutable cas;
    CASInstallmentRouter public immutable router;
    address public immutable initializer;
    mapping(PoolId => bool) public sourceAllowed;

    struct Lot {
        uint128 nextAmount;
        uint128 lastAmount;
        uint64 sellAfter;
    }

    mapping(address => uint256) public lastLotId;
    mapping(address => uint256) public outstanding;
    mapping(address => uint256) public discardedThrough;
    mapping(address => mapping(uint256 => Lot)) private _lots;

    error InvalidConfig();
    error OnlyManager();
    error OnlyInitializer();
    error OnlyRouter();
    error UnsupportedPool();
    error SourcePriceChanged();
    error InvalidAmount();
    error UnregisteredBalance(uint256 available);
    error LotsExceedBalance(uint256 booked, uint256 balance);
    error UnknownLot();
    error TooEarly(uint64 sellAfter);
    error WrongInstallment(uint128 expected);

    /// @dev A zero pool ID denotes registration of CAS already in the wallet.
    event LotOpened(address indexed wallet, uint256 indexed lotId, PoolId indexed pool, uint128 amount, uint64 sellAfter);
    event InstallmentSold(address indexed wallet, uint256 indexed lotId, PoolId indexed pool, uint128 amount, uint64 nextSale);
    event LotsDiscarded(address indexed wallet, uint256 throughLotId);

    constructor(IPoolManager manager_, IERC20 cas_, address initializer_, PoolId[] memory sourceIds) {
        Hooks.Permissions memory permissions;
        permissions.beforeInitialize = true;
        permissions.afterSwap = true;
        Hooks.validateHookPermissions(IHooks(address(this)), permissions);
        if (address(manager_).code.length == 0 || address(cas_).code.length == 0 ||
            initializer_ == address(0) || sourceIds.length == 0) revert InvalidConfig();
        manager = manager_;
        cas = cas_;
        initializer = initializer_;
        for (uint256 i; i < sourceIds.length; ++i) {
            if (sourceAllowed[sourceIds[i]]) revert InvalidConfig();
            sourceAllowed[sourceIds[i]] = true;
        }
        router = new CASInstallmentRouter(manager_);
    }

    /// @dev A successor uses the same currencies, fee and tick spacing as its hookless source.
    function beforeInitialize(address sender, PoolKey calldata key, uint160 price) external view returns (bytes4) {
        if (msg.sender != address(manager)) revert OnlyManager();
        if (sender != initializer) revert OnlyInitializer();
        if (Currency.unwrap(key.currency0) == address(0) ||
            (Currency.unwrap(key.currency0) != address(cas) && Currency.unwrap(key.currency1) != address(cas))) {
            revert UnsupportedPool();
        }
        PoolKey memory source = key;
        source.hooks = IHooks(address(0));
        PoolId sourceId = source.toId();
        if (!sourceAllowed[sourceId]) revert UnsupportedPool();
        (uint160 referencePrice,,,) = manager.getSlot0(sourceId);
        // A stale plan must be regenerated. Price is sqrt(currency1/currency0) in Q64.96.
        if (referencePrice == 0 || price != referencePrice) revert SourcePriceChanged();
        return IHooks.beforeInitialize.selector;
    }

    /// @notice Amount of external CAS this wallet can register without counting outstanding lots twice.
    function registrableBalance(address wallet) public view returns (uint256) {
        uint256 balance = cas.balanceOf(wallet);
        uint256 booked = outstanding[wallet];
        return balance > booked ? balance - booked : 0;
    }

    /// @notice Register existing/transferred CAS under the same clock as a purchase. No approval or transfer.
    function registerBalance(uint128 amount) external returns (uint256) {
        if (amount == 0) revert InvalidAmount();
        uint256 available = registrableBalance(msg.sender);
        if (amount > available) revert UnregisteredBalance(available);
        return _open(msg.sender, amount, PoolId.wrap(bytes32(0)));
    }

    function lots(address wallet, uint256 id) external view returns (Lot memory) {
        if (id <= discardedThrough[wallet]) return Lot(0, 0, 0);
        return _lots[wallet][id];
    }

    /// @notice Surrender all outstanding rights after a transfer. Re-registering starts a fresh clock.
    /// @dev All-or-nothing so discarding a fresh purchase cannot make a stale, matured lot usable.
    function discardAllLots() external {
        if (outstanding[msg.sender] == 0) revert UnknownLot();
        outstanding[msg.sender] = 0;
        discardedThrough[msg.sender] = lastLotId[msg.sender];
        emit LotsDiscarded(msg.sender, lastLotId[msg.sender]);
    }

    /// @dev A revert here rolls back the entire swap. Only the fixed router authenticates the wallet.
    function afterSwap(
        address sender, PoolKey calldata key, SwapParams calldata, BalanceDelta delta, bytes calldata hookData
    ) external returns (bytes4, int128) {
        if (msg.sender != address(manager)) revert OnlyManager();
        if (sender != address(router)) revert OnlyRouter();
        (address trader, uint256 lotId) = abi.decode(hookData, (address, uint256));
        int128 casDelta = Currency.unwrap(key.currency0) == address(cas) ? delta.amount0() : delta.amount1();
        if (casDelta > 0) {
            if (lotId != 0) revert UnknownLot();
            _open(trader, uint128(casDelta), key.toId());
        } else if (casDelta < 0) {
            _sell(trader, lotId, uint128(uint256(-int256(casDelta))), key.toId());
        } else {
            revert InvalidAmount();
        }
        return (IHooks.afterSwap.selector, 0);
    }

    function _open(address wallet, uint128 amount, PoolId pool) private returns (uint256 id) {
        id = ++lastLotId[wallet];
        uint128 second = amount / 2;
        uint64 sellAfter = uint64(block.timestamp + INTERVAL);
        _lots[wallet][id] = Lot(amount - second, second, sellAfter);
        outstanding[wallet] += amount;
        emit LotOpened(wallet, id, pool, amount, sellAfter);
    }

    function _sell(address wallet, uint256 id, uint128 amount, PoolId pool) private {
        Lot storage lot = _lots[wallet][id];
        if (lot.nextAmount == 0 || id <= discardedThrough[wallet]) revert UnknownLot();
        if (block.timestamp < lot.sellAfter) revert TooEarly(lot.sellAfter);
        if (amount != lot.nextAmount) revert WrongInstallment(lot.nextAmount);
        // The router settles after this callback. A matured lot cannot consume CAS
        // earmarked for another registered lot when funds have left the wallet.
        uint256 booked = outstanding[wallet];
        uint256 balance = cas.balanceOf(wallet);
        if (balance < booked) revert LotsExceedBalance(booked, balance);
        outstanding[wallet] = booked - amount;
        uint64 nextSale;
        if (lot.lastAmount == 0) {
            delete _lots[wallet][id];
        } else {
            nextSale = uint64(block.timestamp + INTERVAL);
            lot.nextAmount = lot.lastAmount;
            lot.lastAmount = 0;
            lot.sellAfter = nextSale;
        }
        emit InstallmentSold(wallet, id, pool, amount, nextSale);
    }
}
