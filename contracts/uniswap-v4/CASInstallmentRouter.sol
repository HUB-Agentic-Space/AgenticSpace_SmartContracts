// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

/// @notice Single-hop ERC-20 swaps. The caller always pays and receives the output.
contract CASInstallmentRouter is IUnlockCallback {
    using SafeERC20 for IERC20;

    IPoolManager public immutable manager;
    address public immutable hook;

    error UnsupportedPool();
    error InvalidAmount();
    error Expired();
    error OnlyManager();
    error PartialFill();
    error SlippageExceeded();
    error IncorrectPayment();

    constructor(IPoolManager manager_) {
        manager = manager_;
        hook = msg.sender;
    }

    /// @param amountSpecified Negative for exact input, positive for exact output.
    /// @param limit Minimum output (exact input) or maximum input (exact output), in base units.
    /// @param lotId Zero to buy CAS, or the caller's lot number to sell an installment.
    function swap(
        PoolKey calldata key, bool zeroForOne, int128 amountSpecified,
        uint128 limit, uint256 lotId, uint256 deadline
    ) external returns (uint256 amountIn, uint256 amountOut) {
        if (block.timestamp > deadline) revert Expired();
        if (amountSpecified == 0 || limit == 0) revert InvalidAmount();
        if (address(key.hooks) != hook || Currency.unwrap(key.currency0) == address(0)) revert UnsupportedPool();
        bytes memory result = manager.unlock(abi.encode(msg.sender, key, zeroForOne, amountSpecified, limit, lotId));
        return abi.decode(result, (uint256, uint256));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(manager)) revert OnlyManager();
        (address trader, PoolKey memory key, bool zeroForOne, int128 specified, uint128 limit, uint256 lotId) =
            abi.decode(data, (address, PoolKey, bool, int128, uint128, uint256));
        SwapParams memory params = SwapParams({
            zeroForOne: zeroForOne,
            amountSpecified: specified,
            sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
        });
        BalanceDelta delta = manager.swap(key, params, abi.encode(trader, lotId));
        int128 inputDelta = zeroForOne ? delta.amount0() : delta.amount1();
        int128 outputDelta = zeroForOne ? delta.amount1() : delta.amount0();
        if (inputDelta >= 0 || outputDelta <= 0) revert PartialFill();
        uint256 amountIn = uint256(-int256(inputDelta));
        uint256 amountOut = uint128(outputDelta);
        if (specified < 0) {
            if (amountIn != uint256(-int256(specified))) revert PartialFill();
            if (amountOut < limit) revert SlippageExceeded();
        } else {
            if (amountOut != uint128(specified)) revert PartialFill();
            if (amountIn > limit) revert SlippageExceeded();
        }

        Currency input = zeroForOne ? key.currency0 : key.currency1;
        manager.sync(input);
        IERC20(Currency.unwrap(input)).safeTransferFrom(trader, address(manager), amountIn);
        if (manager.settle() != amountIn) revert IncorrectPayment();
        manager.take(zeroForOne ? key.currency1 : key.currency0, trader, amountOut);
        return abi.encode(amountIn, amountOut);
    }
}
