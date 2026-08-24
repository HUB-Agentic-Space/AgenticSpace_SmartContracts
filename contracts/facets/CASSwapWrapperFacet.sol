// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { CASSwapStorage } from "../diamond/storage/CASSwapStorage.sol";
import { LibCASSwap } from "../libs/LibCASSwap.sol";
import { ICASSwapWrapper } from "../interfaces/ICASSwapWrapper.sol";

/**
 * @title CASSwapWrapperFacet
 * @dev Wrappers one-call para os pares CAS <-> POL / USDC.
 *      Reutiliza a biblioteca LibCASSwap para manter a mesma lógica e precisão
 *      do CASSwapUSDCPOLFacet. Todos os swaps respeitam pause, ratio e fee
 *      armazenados em CASSwapStorage.
 *
 *      Os usuários ainda devem aprovar o Diamond para gastar USDC/CAS; este
 *      facet apenas oferece entradas convenientes.
 */
contract CASSwapWrapperFacet is ICASSwapWrapper {
    uint8 internal constant DIR_ETH_TO_CAS = 0;
    uint8 internal constant DIR_CAS_TO_ETH = 1;
    uint8 internal constant DIR_USDC_TO_CAS = 2;
    uint8 internal constant DIR_CAS_TO_USDC = 3;

    // --- Reentrancy guard compartilhado com CASSwapUSDCPOLFacet ---
    bytes32 internal constant REENTRANCY_SLOT =
        keccak256("agenticspace.casswap.usdcpol.reentrancy");
    uint256 internal constant _NOT_ENTERED = 1;
    uint256 internal constant _ENTERED = 2;

    error ReentrantCall();
    error SwapPaused();
    error DeadlineExpired(uint256 deadline, uint256 nowTs);

    modifier nonReentrant() {
        bytes32 slot = REENTRANCY_SLOT;
        uint256 status;
        assembly { status := sload(slot) }
        if (status == _ENTERED) revert ReentrantCall();
        assembly { sstore(slot, _ENTERED) }
        _;
        assembly { sstore(slot, _NOT_ENTERED) }
    }

    modifier whenNotPaused() {
        if (CASSwapStorage.layout().paused) revert SwapPaused();
        _;
    }

    modifier ensureDeadline(uint256 deadline) {
        if (block.timestamp > deadline) revert DeadlineExpired(deadline, block.timestamp);
        _;
    }

    // -----------------------------------------------------------------------
    // ETH -> CAS
    // -----------------------------------------------------------------------

    function swapExactETHForCAS(uint256 minCasOut, uint256 deadline)
        external
        payable
        override
        nonReentrant
        whenNotPaused
        ensureDeadline(deadline)
        returns (uint256 casOut)
    {
        uint256 fee;
        (casOut, fee) = LibCASSwap.buyWithPol(CASSwapStorage.layout(), msg.value, minCasOut, msg.sender);
        emit WrapperSwapExecuted(msg.sender, DIR_ETH_TO_CAS, msg.value, casOut);
    }

    // -----------------------------------------------------------------------
    // USDC -> CAS
    // -----------------------------------------------------------------------

    function swapExactUSDCForCAS(uint256 usdcAmount, uint256 minCasOut, uint256 deadline)
        external
        override
        nonReentrant
        whenNotPaused
        ensureDeadline(deadline)
        returns (uint256 casOut)
    {
        uint256 fee;
        (casOut, fee) = LibCASSwap.buyWithUsdc(CASSwapStorage.layout(), msg.sender, usdcAmount, minCasOut, msg.sender);
        emit WrapperSwapExecuted(msg.sender, DIR_USDC_TO_CAS, usdcAmount, casOut);
    }

    // -----------------------------------------------------------------------
    // CAS -> ETH
    // -----------------------------------------------------------------------

    function swapExactCASForETH(uint256 casAmount, uint256 minEthOut, uint256 deadline)
        external
        override
        nonReentrant
        whenNotPaused
        ensureDeadline(deadline)
        returns (uint256 ethOut)
    {
        uint256 fee;
        (ethOut, fee) = LibCASSwap.sellForPol(CASSwapStorage.layout(), msg.sender, casAmount, minEthOut, msg.sender);
        emit WrapperSwapExecuted(msg.sender, DIR_CAS_TO_ETH, casAmount, ethOut);
    }

    // -----------------------------------------------------------------------
    // CAS -> USDC
    // -----------------------------------------------------------------------

    function swapExactCASForUSDC(uint256 casAmount, uint256 minUsdcOut, uint256 deadline)
        external
        override
        nonReentrant
        whenNotPaused
        ensureDeadline(deadline)
        returns (uint256 usdcOut)
    {
        uint256 fee;
        (usdcOut, fee) = LibCASSwap.sellForUsdc(CASSwapStorage.layout(), msg.sender, casAmount, minUsdcOut, msg.sender);
        emit WrapperSwapExecuted(msg.sender, DIR_CAS_TO_USDC, casAmount, usdcOut);
    }
}
