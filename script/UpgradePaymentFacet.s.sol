// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { Script, console } from "forge-std/Script.sol";
import { IDiamondCut } from "../contracts/diamond/interfaces/IDiamondCut.sol";
import { IDiamondLoupe } from "../contracts/diamond/interfaces/IDiamondLoupe.sol";
import { PaymentFacet } from "../contracts/facets/PaymentFacet.sol";

contract UpgradePaymentFacet is Script {
    uint256 internal constant FEE_TYPE_PAUTA_SUBMISSION = 4;
    uint256 internal constant FEE_TYPE_VOTING = 5;
    uint256 internal constant FEE_TYPE_CERTIFICATE_ISSUANCE = 6;

    function run() external {
        address diamond = vm.envAddress("DIAMOND_ADDRESS");
        string memory pkStr = vm.envString("POLYGON_PRIVATE_KEY");
        bytes memory pkBytes = bytes(pkStr);
        uint256 deployerPrivateKey;
        if (pkBytes.length >= 2 && pkBytes[0] == '0' && (pkBytes[1] == 'x' || pkBytes[1] == 'X')) {
            deployerPrivateKey = vm.parseUint(pkStr);
        } else {
            deployerPrivateKey = vm.parseUint(string.concat("0x", pkStr));
        }

        vm.startBroadcast(deployerPrivateKey);

        PaymentFacet newPaymentFacet = new PaymentFacet();
        console.log("New PaymentFacet:", address(newPaymentFacet));

        bytes4[] memory selectors = new bytes4[](18);
        selectors[0] = bytes4(keccak256("initPayment()"));
        selectors[1] = bytes4(keccak256("setCasToken(address)"));
        selectors[2] = bytes4(keccak256("setInfrastructureFund(address)"));
        selectors[3] = bytes4(keccak256("updateFees((uint256,uint256,uint256,uint256))"));
        selectors[4] = bytes4(keccak256("setWethToken(address)"));
        selectors[5] = bytes4(keccak256("setCasSwap(address)"));
        selectors[6] = bytes4(keccak256("registerFeeType(uint256,uint256)"));
        selectors[7] = bytes4(keccak256("setCustomFee(uint256,uint256)"));
        selectors[8] = bytes4(keccak256("batchTransfer(address[],uint256[])"));
        selectors[9] = bytes4(keccak256("distribute(address[],uint256[])"));
        selectors[10] = bytes4(keccak256("getCasToken()"));
        selectors[11] = bytes4(keccak256("getInfrastructureFund()"));
        selectors[12] = bytes4(keccak256("getFees()"));
        selectors[13] = bytes4(keccak256("getWethToken()"));
        selectors[14] = bytes4(keccak256("getCasSwap()"));
        selectors[15] = bytes4(keccak256("getCustomFee(uint256)"));
        selectors[16] = bytes4(keccak256("isFeeTypeRegistered(uint256)"));
        selectors[17] = bytes4(keccak256("getAllFeeTypes()"));

        bytes4[] memory selectorsToAdd = new bytes4[](selectors.length);
        bytes4[] memory selectorsToReplace = new bytes4[](selectors.length);
        uint256 addCount;
        uint256 replaceCount;
        for (uint256 i = 0; i < selectors.length; i++) {
            if (IDiamondLoupe(diamond).facetAddress(selectors[i]) == address(0)) {
                selectorsToAdd[addCount++] = selectors[i];
            } else {
                selectorsToReplace[replaceCount++] = selectors[i];
            }
        }

        uint256 cutCount = (addCount > 0 ? 1 : 0) +
            (replaceCount > 0 ? 1 : 0);
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](cutCount);
        uint256 cutIndex;
        if (addCount > 0) {
            cuts[cutIndex++] = IDiamondCut.FacetCut({
                facetAddress: address(newPaymentFacet),
                action: IDiamondCut.FacetCutAction.Add,
                functionSelectors: _trim(selectorsToAdd, addCount)
            });
        }
        if (replaceCount > 0) {
            cuts[cutIndex] = IDiamondCut.FacetCut({
                facetAddress: address(newPaymentFacet),
                action: IDiamondCut.FacetCutAction.Replace,
                functionSelectors: _trim(selectorsToReplace, replaceCount)
            });
        }

        // Do not call initPayment during an upgrade: it resets the four core
        // fees. Registering these catalog entries is idempotent and preserves
        // every existing configured amount outside the entries below.
        IDiamondCut(diamond).diamondCut(cuts, address(0), "");
        PaymentFacet payment = PaymentFacet(diamond);
        if (!payment.isFeeTypeRegistered(FEE_TYPE_PAUTA_SUBMISSION)) {
            payment.registerFeeType(FEE_TYPE_PAUTA_SUBMISSION, 10 * 1e18);
        }
        if (!payment.isFeeTypeRegistered(FEE_TYPE_VOTING)) {
            payment.registerFeeType(FEE_TYPE_VOTING, 50 * 1e18);
        }
        if (!payment.isFeeTypeRegistered(FEE_TYPE_CERTIFICATE_ISSUANCE)) {
            payment.registerFeeType(
                FEE_TYPE_CERTIFICATE_ISSUANCE,
                50 * 1e18
            );
        } else if (
            payment.getCustomFee(FEE_TYPE_CERTIFICATE_ISSUANCE) != 50 * 1e18
        ) {
            payment.setCustomFee(FEE_TYPE_CERTIFICATE_ISSUANCE, 50 * 1e18);
        }

        console.log("PaymentFacet upgrade completed; fee types 4, 5 and 6 registered.");

        vm.stopBroadcast();
    }

    function _trim(
        bytes4[] memory values,
        uint256 length
    ) internal pure returns (bytes4[] memory trimmed) {
        trimmed = new bytes4[](length);
        for (uint256 i = 0; i < length; i++) {
            trimmed[i] = values[i];
        }
    }
}
