// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { LibDiamond } from "../diamond/libraries/LibDiamond.sol";
import { DiamondAccessControl } from "../diamond/access/DiamondAccessControl.sol";
import { CASSwapStorage } from "../diamond/storage/CASSwapStorage.sol";
import { LibCASSwap } from "../libs/LibCASSwap.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title TraderGovernanceFacet
 * @dev Facet de governança do Rapport Trader. Controla pausa, configurações
 *      de execução (fee, impacto, slippage), orçamento mensal e resgates de
 *      excedente pelo tesouro. Usa o mesmo CASSwapStorage do swap facet para
 *      manter atomicidade e simplicidade.
 *
 *      Padrões: Diamond Storage (EIP-2535), Command (config setters).
 */
contract TraderGovernanceFacet {
    using SafeERC20 for IERC20;

    bytes32 internal constant TREASURER_ROLE_HASH = keccak256("TREASURER_ROLE");

    error ZeroAddress();
    error ZeroAmount();
    error FeeTooHigh(uint256 provided, uint256 max);
    error InvalidPeriod();
    error NotInitialized();
    error AlreadyUnpaused();
    error AlreadyPaused();

    event SwapPaused(address indexed account);
    event SwapUnpaused(address indexed account);
    event SwapFeeSet(uint256 oldFeeBps, uint256 newFeeBps);
    event MaxImpactBpsSet(uint256 oldValue, uint256 newValue);
    event SlippageLimitBpsSet(uint256 oldValue, uint256 newValue);
    event MonthlyBudgetSet(uint256 oldBudget, uint256 newBudget);
    event PeriodDurationSet(uint256 oldDuration, uint256 newDuration);
    event ExcessWithdrawn(address indexed token, uint256 amount, address indexed to);

    modifier onlyOwner() {
        LibDiamond.enforceIsContractOwner();
        _;
    }

    modifier onlyTreasurer() {
        DiamondAccessControl.enforceRoleOrOwner(TREASURER_ROLE_HASH);
        _;
    }

    // -----------------------------------------------------------------------
    // Pause
    // -----------------------------------------------------------------------

    function pauseSwap() external onlyOwner {
        CASSwapStorage.Data storage s = CASSwapStorage.layout();
        if (s.paused) revert AlreadyPaused();
        s.paused = true;
        emit SwapPaused(msg.sender);
    }

    function unpauseSwap() external onlyOwner {
        CASSwapStorage.Data storage s = CASSwapStorage.layout();
        if (!s.paused) revert AlreadyUnpaused();
        s.paused = false;
        emit SwapUnpaused(msg.sender);
    }

    // -----------------------------------------------------------------------
    // Configurações de execução (owner)
    // -----------------------------------------------------------------------

    function setSwapFeeBps(uint256 feeBps) external onlyOwner {
        if (feeBps > 1000) revert FeeTooHigh(feeBps, 1000); // máx 10%
        CASSwapStorage.Data storage s = CASSwapStorage.layout();
        uint256 old = s.swapFeeBps;
        s.swapFeeBps = feeBps;
        emit SwapFeeSet(old, feeBps);
    }

    function setMaxImpactBps(uint256 maxImpactBps) external onlyOwner {
        CASSwapStorage.Data storage s = CASSwapStorage.layout();
        uint256 old = s.maxImpactBps;
        s.maxImpactBps = maxImpactBps;
        emit MaxImpactBpsSet(old, maxImpactBps);
    }

    function setSlippageLimitBps(uint256 slippageLimitBps) external onlyOwner {
        CASSwapStorage.Data storage s = CASSwapStorage.layout();
        uint256 old = s.slippageLimitBps;
        s.slippageLimitBps = slippageLimitBps;
        emit SlippageLimitBpsSet(old, slippageLimitBps);
    }

    // -----------------------------------------------------------------------
    // Orçamento mensal (owner)
    // -----------------------------------------------------------------------

    function setMonthlyBudgetUsdc(uint256 budgetUsdc) external onlyOwner {
        CASSwapStorage.Data storage s = CASSwapStorage.layout();
        uint256 old = s.monthlyBudgetUsdc;
        s.monthlyBudgetUsdc = budgetUsdc;
        emit MonthlyBudgetSet(old, budgetUsdc);
    }

    function setPeriodDuration(uint256 periodDuration) external onlyOwner {
        if (periodDuration == 0) revert InvalidPeriod();
        CASSwapStorage.Data storage s = CASSwapStorage.layout();
        uint256 old = s.periodDuration;
        s.periodDuration = periodDuration;
        emit PeriodDurationSet(old, periodDuration);
    }

    function resetPeriodSpent() external onlyOwner {
        CASSwapStorage.Data storage s = CASSwapStorage.layout();
        s.periodStart = block.timestamp;
        s.periodSpent = 0;
    }

    // -----------------------------------------------------------------------
    // Resgates de excedente (tesoureiro/owner)
    // -----------------------------------------------------------------------

    function withdrawExcessPOL(address to, uint256 amount) external onlyTreasurer {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        (bool ok, ) = payable(to).call{ value: amount }("");
        if (!ok) revert LibCASSwap.POLTransferFailed();
        emit ExcessWithdrawn(address(0), amount, to);
    }

    function withdrawExcessToken(address token, address to, uint256 amount) external onlyTreasurer {
        if (token == address(0) || to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        IERC20(token).safeTransfer(to, amount);
        emit ExcessWithdrawn(token, amount, to);
    }

    // -----------------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------------

    function getGovernanceConfig()
        external
        view
        returns (
            uint256 swapFeeBps,
            uint256 maxImpactBps,
            uint256 slippageLimitBps,
            uint256 monthlyBudgetUsdc,
            uint256 periodStart,
            uint256 periodSpent,
            uint256 periodDuration
        )
    {
        CASSwapStorage.Data storage s = CASSwapStorage.layout();
        return (
            s.swapFeeBps,
            s.maxImpactBps,
            s.slippageLimitBps,
            s.monthlyBudgetUsdc,
            s.periodStart,
            s.periodSpent,
            s.periodDuration
        );
    }
}
