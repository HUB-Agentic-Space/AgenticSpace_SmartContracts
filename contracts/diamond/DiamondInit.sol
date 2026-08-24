// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { LibDiamond } from "./libraries/LibDiamond.sol";
import { DiamondAccessControl } from "./access/DiamondAccessControl.sol";

/**
 * @title DiamondInit
 * @dev Initialization contract executed via delegatecall during diamondCut.
 *      Sets up initial roles, grants admin roles to the contract owner,
 *      and initializes DAO namespaces and validator wallet support.
 *
 *      Padrões: Template Method (initialization steps), Factory (init via delegatecall)
 */
contract DiamondInit {
    function init() external {
        LibDiamond.enforceIsContractOwner();
        address owner = LibDiamond.contractOwner();

        // Grant core roles to owner
        DiamondAccessControl.grantRole(DiamondAccessControl.PAUSER_ROLE, owner);
        DiamondAccessControl.grantRole(DiamondAccessControl.VALIDATOR_ROLE, owner);
        DiamondAccessControl.grantRole(DiamondAccessControl.REGISTRAR_ROLE, owner);
        DiamondAccessControl.grantRole(DiamondAccessControl.DAO_PROPOSER_ROLE, owner);
        DiamondAccessControl.grantRole(DiamondAccessControl.DAO_VOTER_ROLE, owner);
        DiamondAccessControl.grantRole(DiamondAccessControl.DAO_EXECUTOR_ROLE, owner);
        DiamondAccessControl.grantRole(DiamondAccessControl.DAO_CANCELLER_ROLE, owner);

        // Register additional EIP-165 interface IDs if needed
        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        ds.supportedInterfaces[0x48e2b219] = true; // IDiamondLoupe
    }
}
