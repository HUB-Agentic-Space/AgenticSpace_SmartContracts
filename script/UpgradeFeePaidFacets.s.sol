// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { Script, console } from "forge-std/Script.sol";
import { IDiamondCut } from "../contracts/diamond/interfaces/IDiamondCut.sol";
import { UserRegistryFacet } from "../contracts/facets/UserRegistryFacet.sol";
import { AgentRegistryFacet } from "../contracts/facets/AgentRegistryFacet.sol";

contract UpgradeFeePaidFacets is Script {
    function run() external {
        address diamond = vm.envAddress("DIAMOND_ADDRESS");
        string memory pkStr = vm.envString("POLYGON_PRIVATE_KEY");
        // Ensure 0x prefix for private key
        bytes memory pkBytes = bytes(pkStr);
        uint256 deployerPrivateKey;
        if (pkBytes.length >= 2 && pkBytes[0] == '0' && (pkBytes[1] == 'x' || pkBytes[1] == 'X')) {
            deployerPrivateKey = vm.parseUint(pkStr);
        } else {
            deployerPrivateKey = vm.parseUint(string.concat("0x", pkStr));
        }

        vm.startBroadcast(deployerPrivateKey);

        // Deploy new facets
        UserRegistryFacet newUserRegistry = new UserRegistryFacet();
        AgentRegistryFacet newAgentRegistry = new AgentRegistryFacet();

        console.log("New UserRegistryFacet:", address(newUserRegistry));
        console.log("New AgentRegistryFacet:", address(newAgentRegistry));

        // Build diamond cut - Replace action = 1
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](2);

        // UserRegistryFacet selectors
        bytes4[] memory userSelectors = new bytes4[](8);
        userSelectors[0] = bytes4(keccak256("computeUserId(bytes32,address)"));
        userSelectors[1] = bytes4(keccak256("deactivateUser(bytes32)"));
        userSelectors[2] = bytes4(keccak256("getUser(bytes32)"));
        userSelectors[3] = bytes4(keccak256("getUserByAddress(address)"));
        userSelectors[4] = bytes4(keccak256("getUserIdByAddress(address)"));
        userSelectors[5] = bytes4(keccak256("isUserActive(address)"));
        userSelectors[6] = bytes4(keccak256("reactivateUser(bytes32)"));
        userSelectors[7] = bytes4(keccak256("registerUser(bytes32,bytes32,uint8)"));

        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(newUserRegistry),
            action: IDiamondCut.FacetCutAction.Replace,
            functionSelectors: userSelectors
        });

        // AgentRegistryFacet selectors
        bytes4[] memory agentSelectors = new bytes4[](17);
        agentSelectors[0] = bytes4(keccak256("deactivateAgent(bytes32)"));
        agentSelectors[1] = bytes4(keccak256("getActiveAgentCount()"));
        agentSelectors[2] = bytes4(keccak256("getAgent(bytes32)"));
        agentSelectors[3] = bytes4(keccak256("getAgentByPublicId(string)"));
        agentSelectors[4] = bytes4(keccak256("getAgentCount()"));
        agentSelectors[5] = bytes4(keccak256("getAgentsByOwner(address)"));
        agentSelectors[6] = bytes4(keccak256("getMerkleRoot(bytes32)"));
        agentSelectors[7] = bytes4(keccak256("getMerkleRootHistory(bytes32)"));
        agentSelectors[8] = bytes4(keccak256("getPromptCount(bytes32)"));
        agentSelectors[9] = bytes4(keccak256("isAgentActive(bytes32)"));
        agentSelectors[10] = bytes4(keccak256("reactivateAgent(bytes32)"));
        agentSelectors[11] = bytes4(keccak256("registerAgent(bytes32,string,string,string,string,string,bytes32,uint256)"));
        agentSelectors[12] = bytes4(keccak256("updateAgent(bytes32,string)"));
        agentSelectors[13] = bytes4(keccak256("updateMerkleRoot(bytes32,bytes32,uint256)"));
        agentSelectors[14] = bytes4(keccak256("verifyPrompt(bytes32,string,uint8,bytes32,bytes32[])"));
        agentSelectors[15] = bytes4(keccak256("verifyPromptHistorical(bytes32,uint256,string,uint8,bytes32,bytes32[])"));
        agentSelectors[16] = bytes4(keccak256("computeAgentId(bytes32,address)"));

        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(newAgentRegistry),
            action: IDiamondCut.FacetCutAction.Replace,
            functionSelectors: agentSelectors
        });

        // Execute diamond cut
        IDiamondCut(diamond).diamondCut(cuts, address(0), "");

        console.log("DiamondCut completed successfully!");

        vm.stopBroadcast();
    }
}
