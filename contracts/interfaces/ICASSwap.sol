// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

/**
 * @title ICASSwap
 * @dev Interface for the CASSwap contract.
 *      On-chain swap between CAS (ERC-20) and POL (native) with flexible ratio.
 *      Ratio is adjustable by RATIO_ADMIN_ROLE — any numerator/denominator > 0.
 */
interface ICASSwap {
    event CASBought(address indexed buyer, uint256 polSent, uint256 casReceived, uint256 fee);
    event CASSold(address indexed seller, uint256 casSent, uint256 polReceived, uint256 fee);
    event RatioUpdated(uint256 numerator, uint256 denominator);
    event SwapFeeUpdated(uint256 oldFeeBps, uint256 newFeeBps);
    event CASDeposited(address indexed depositor, uint256 amount);
    event POLWithdrawn(address indexed to, uint256 amount);
    event PausedStateChanged(bool paused);

    function buyCAS(uint256 minCasOut, uint256 deadline) external payable returns (uint256 casReceived);
    function sellCAS(uint256 casAmount, uint256 minPolOut, uint256 deadline) external returns (uint256 polReceived);
    function setRatio(uint256 numerator, uint256 denominator) external;
    function setSwapFee(uint256 feeBps) external;
    function depositCAS(uint256 amount) external;
    function withdrawPOL(uint256 amount) external;
    function pause() external;
    function unpause() external;

    function getRatio() external view returns (uint256 numerator, uint256 denominator);
    function getSwapFee() external view returns (uint256);
    function getCASBalance() external view returns (uint256);
    function getPOLBalance() external view returns (uint256);
    function isPaused() external view returns (bool);
}
