// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { IDiamondCut } from "../diamond/interfaces/IDiamondCut.sol";
import { Diamond } from "../diamond/Diamond.sol";
import { DiamondCutFacet } from "../diamond/facets/DiamondCutFacet.sol";
import { CASSwapUSDCPOLFacet } from "../facets/CASSwapUSDCPOLFacet.sol";
import { CASSwapWrapperFacet } from "../facets/CASSwapWrapperFacet.sol";
import { TraderGovernanceFacet } from "../facets/TraderGovernanceFacet.sol";
import { MockERC20 } from "../mocks/MockERC20.sol";

/**
 * @title EchidnaCASSwapHarness
 * @dev Harness de fuzzing para o CASSwap. O Echidna chama as funções
 *      públicas deste contrato e verifica as invariantes `echidna_*`.
 *      O setup monta um Diamond real com os facets CASSwap.
 */
contract EchidnaCASSwapHarness {
    CASSwapUSDCPOLFacet public swap;
    CASSwapWrapperFacet public wrapper;
    TraderGovernanceFacet public gov;
    MockERC20 public casToken;
    MockERC20 public usdcToken;

    constructor() {
        DiamondCutFacet diamondCutFacet = new DiamondCutFacet();

        bytes4[] memory cutSelectors = new bytes4[](1);
        cutSelectors[0] = IDiamondCut.diamondCut.selector;

        IDiamondCut.FacetCut[] memory initialCuts = new IDiamondCut.FacetCut[](1);
        initialCuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(diamondCutFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: cutSelectors
        });

        Diamond diamond = new Diamond(address(this), initialCuts);
        address diamondAddr = address(diamond);

        CASSwapUSDCPOLFacet swapFacet = new CASSwapUSDCPOLFacet();
        CASSwapWrapperFacet wrapperFacet = new CASSwapWrapperFacet();
        TraderGovernanceFacet govFacet = new TraderGovernanceFacet();

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](3);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(swapFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: getSwapSelectors(swapFacet)
        });
        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(wrapperFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: getWrapperSelectors(wrapperFacet)
        });
        cuts[2] = IDiamondCut.FacetCut({
            facetAddress: address(govFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: getGovSelectors(govFacet)
        });

        IDiamondCut(diamondAddr).diamondCut(cuts, address(0), "");

        swap = CASSwapUSDCPOLFacet(diamondAddr);
        wrapper = CASSwapWrapperFacet(diamondAddr);
        gov = TraderGovernanceFacet(diamondAddr);

        casToken = new MockERC20("CAS Token", "CAS", 18);
        usdcToken = new MockERC20("USDC Token", "USDC", 6);

        swap.initCASSwapUSDCPOL(address(casToken), address(usdcToken));

        // Normalize USDC ratio; temporarily disable impact guard.
        swap.setMaxImpactBps(0);
        swap.setSwapRatioUSDC(1_000_000_000_000, 1);
        swap.setMaxImpactBps(10000);

        // Fund Diamond reserves.
        casToken.mint(diamondAddr, 100_000 * 1e18);
        usdcToken.mint(diamondAddr, 1_000_000 * 1e6);

        // Fund and approve harness.
        casToken.mint(address(this), 10_000 * 1e18);
        usdcToken.mint(address(this), 100_000 * 1e6);
        casToken.approve(diamondAddr, type(uint256).max);
        usdcToken.approve(diamondAddr, type(uint256).max);
    }

    // -----------------------------------------------------------------------
    // Selectors
    // -----------------------------------------------------------------------

    function getSwapSelectors(CASSwapUSDCPOLFacet f) internal pure returns (bytes4[] memory) {
        bytes4[] memory s = new bytes4[](20);
        s[0] = f.initCASSwapUSDCPOL.selector;
        s[1] = f.setSwapRatio.selector;
        s[2] = f.setSwapRatioUSDC.selector;
        s[3] = f.setSwapRatioSell.selector;
        s[4] = f.setSwapRatioUSDCSell.selector;
        s[5] = f.setAllSwapRatios.selector;
        s[6] = f.setSwapFeeBps.selector;
        s[7] = f.setMaxImpactBps.selector;
        s[8] = f.buyCASWithPOL.selector;
        s[9] = f.buyCASWithUSDC.selector;
        s[10] = f.sellCASForPOL.selector;
        s[11] = f.sellCASForUSDC.selector;
        s[12] = f.getRatio.selector;
        s[13] = f.getRatioUSDC.selector;
        s[14] = f.getRatioSell.selector;
        s[15] = f.getRatioUSDCSell.selector;
        s[16] = f.getSwapFeeBps.selector;
        s[17] = f.getReserves.selector;
        s[18] = f.isSwapPaused.selector;
        s[19] = f.RATIO_SETTER_ROLE.selector;
        return s;
    }

    function getWrapperSelectors(CASSwapWrapperFacet f) internal pure returns (bytes4[] memory) {
        bytes4[] memory s = new bytes4[](4);
        s[0] = f.swapExactETHForCAS.selector;
        s[1] = f.swapExactUSDCForCAS.selector;
        s[2] = f.swapExactCASForETH.selector;
        s[3] = f.swapExactCASForUSDC.selector;
        return s;
    }

    function getGovSelectors(TraderGovernanceFacet f) internal pure returns (bytes4[] memory) {
        bytes4[] memory s = new bytes4[](4);
        s[0] = f.pauseSwap.selector;
        s[1] = f.unpauseSwap.selector;
        s[2] = f.getGovernanceConfig.selector;
        s[3] = f.setSlippageLimitBps.selector;
        return s;
    }

    // -----------------------------------------------------------------------
    // Ações que o Echidna pode invocar
    // -----------------------------------------------------------------------

    function setPolRatio(uint256 n, uint256 d) public { swap.setSwapRatio(n, d); }
    function setUsdcRatio(uint256 n, uint256 d) public { swap.setSwapRatioUSDC(n, d); }
    function setPolSellRatio(uint256 n, uint256 d) public { swap.setSwapRatioSell(n, d); }
    function setUsdcSellRatio(uint256 n, uint256 d) public { swap.setSwapRatioUSDCSell(n, d); }

    function setAllRatios(
        uint256 polBuyNum, uint256 polBuyDen,
        uint256 usdcBuyNum, uint256 usdcBuyDen,
        uint256 polSellNum, uint256 polSellDen,
        uint256 usdcSellNum, uint256 usdcSellDen
    ) public {
        swap.setAllSwapRatios(
            polBuyNum, polBuyDen,
            usdcBuyNum, usdcBuyDen,
            polSellNum, polSellDen,
            usdcSellNum, usdcSellDen
        );
    }

    function setSwapFee(uint256 feeBps) public { swap.setSwapFeeBps(feeBps); }
    function setImpact(uint256 impactBps) public { swap.setMaxImpactBps(impactBps); }
    function setSlippage(uint256 slippageBps) public { gov.setSlippageLimitBps(slippageBps); }
    function pause() public { gov.pauseSwap(); }
    function unpause() public { gov.unpauseSwap(); }

    function buyPol(uint256 minOut) public payable {
        uint256 deadline;
        unchecked { deadline = block.timestamp + 3600; }
        swap.buyCASWithPOL{value: msg.value}(minOut, deadline);
    }

    function buyUsdc(uint256 amount, uint256 minOut) public {
        uint256 deadline;
        unchecked { deadline = block.timestamp + 3600; }
        swap.buyCASWithUSDC(amount, minOut, deadline);
    }

    function sellPol(uint256 casAmount, uint256 minOut) public {
        uint256 deadline;
        unchecked { deadline = block.timestamp + 3600; }
        swap.sellCASForPOL(casAmount, minOut, deadline);
    }

    function sellUsdc(uint256 casAmount, uint256 minOut) public {
        uint256 deadline;
        unchecked { deadline = block.timestamp + 3600; }
        swap.sellCASForUSDC(casAmount, minOut, deadline);
    }

    function wrapBuyEth(uint256 minOut) public payable {
        uint256 deadline;
        unchecked { deadline = block.timestamp + 3600; }
        wrapper.swapExactETHForCAS{value: msg.value}(minOut, deadline);
    }

    function wrapBuyUsdc(uint256 amount, uint256 minOut) public {
        uint256 deadline;
        unchecked { deadline = block.timestamp + 3600; }
        wrapper.swapExactUSDCForCAS(amount, minOut, deadline);
    }

    function wrapSellEth(uint256 casAmount, uint256 minOut) public {
        uint256 deadline;
        unchecked { deadline = block.timestamp + 3600; }
        wrapper.swapExactCASForETH(casAmount, minOut, deadline);
    }

    function wrapSellUsdc(uint256 casAmount, uint256 minOut) public {
        uint256 deadline;
        unchecked { deadline = block.timestamp + 3600; }
        wrapper.swapExactCASForUSDC(casAmount, minOut, deadline);
    }

    // -----------------------------------------------------------------------
    // Invariantes
    // -----------------------------------------------------------------------

    function echidna_ratio_den_not_zero() public view returns (bool) {
        (, uint256 polDen) = swap.getRatio();
        (, uint256 usdcDen) = swap.getRatioUSDC();
        (, uint256 polSellDen) = swap.getRatioSell();
        (, uint256 usdcSellDen) = swap.getRatioUSDCSell();
        return polDen > 0 && usdcDen > 0 && polSellDen > 0 && usdcSellDen > 0;
    }

    function echidna_fee_capped() public view returns (bool) {
        return swap.getSwapFeeBps() <= 10000;
    }

    function echidna_governance_capped() public view returns (bool) {
        (uint256 feeBps, uint256 impactBps, uint256 slippageBps, , , , ) = gov.getGovernanceConfig();
        return feeBps <= 10000 && impactBps <= 10000 && slippageBps <= 10000;
    }

    receive() external payable {}
    fallback() external payable {}
}
