// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { LibDiamond } from "../diamond/libraries/LibDiamond.sol";
import { DiamondAccessControl } from "../diamond/access/DiamondAccessControl.sol";

/**
 * @title ContractRegistryFacet
 * @dev Facet for contract address discovery within the Diamond.
 *      Allows registering and querying contract addresses by name and version.
 *      Uses its own Diamond Storage namespace.
 *
 *      Padrões: Diamond Storage (EIP-2535), Registry (GoF)
 */
contract ContractRegistryFacet {
    bytes32 internal constant STORAGE_POSITION =
        keccak256("agentic.space.diamond.contract.registry.storage");

    struct ContractEntry {
        address currentAddress;
        uint256 currentVersion;
        bool exists;
    }

    struct RegistryStorageData {
        mapping(string => ContractEntry) contracts;
        mapping(string => uint256[]) versionHistory;
        mapping(string => mapping(uint256 => address)) versionAddresses;
        mapping(address => string) addressToName;
    }

    event ContractRegistered(string name, uint256 version, address contractAddress);
    event ContractUpdated(
        string name,
        uint256 oldVersion,
        uint256 newVersion,
        address oldAddress,
        address newAddress
    );

    error ContractAlreadyRegistered(string name);
    error ContractNotFound(string name);
    error VersionNotFound(string name, uint256 version);

    function registryStorage() internal pure returns (RegistryStorageData storage s) {
        bytes32 position = STORAGE_POSITION;
        assembly {
            s.slot := position
        }
    }

    function register(string calldata name, uint256 version, address contractAddress) external {
        DiamondAccessControl.enforceRoleOrOwner(DiamondAccessControl.REGISTRAR_ROLE);
        require(bytes(name).length > 0, "Registry: empty name");
        require(contractAddress != address(0), "Registry: zero address");
        require(version > 0, "Registry: zero version");

        RegistryStorageData storage s = registryStorage();
        bool isNew = !s.contracts[name].exists;
        if (isNew) {
            s.contracts[name] = ContractEntry({
                currentAddress: contractAddress,
                currentVersion: version,
                exists: true
            });
            emit ContractRegistered(name, version, contractAddress);
        } else {
            uint256 oldVersion = s.contracts[name].currentVersion;
            address oldAddress = s.contracts[name].currentAddress;
            require(version > oldVersion, "Registry: version must be higher");

            s.contracts[name].currentAddress = contractAddress;
            s.contracts[name].currentVersion = version;
            emit ContractUpdated(name, oldVersion, version, oldAddress, contractAddress);
        }

        s.versionHistory[name].push(version);
        s.versionAddresses[name][version] = contractAddress;
        s.addressToName[contractAddress] = name;
    }

    function getAddress(string calldata name) external view returns (address) {
        RegistryStorageData storage s = registryStorage();
        if (!s.contracts[name].exists) revert ContractNotFound(name);
        return s.contracts[name].currentAddress;
    }

    function getAddressByVersion(string calldata name, uint256 version) external view returns (address) {
        RegistryStorageData storage s = registryStorage();
        address addr = s.versionAddresses[name][version];
        if (addr == address(0)) revert VersionNotFound(name, version);
        return addr;
    }

    function isRegistered(string calldata name) external view returns (bool) {
        return registryStorage().contracts[name].exists;
    }

    function getCurrentVersion(string calldata name) external view returns (uint256) {
        RegistryStorageData storage s = registryStorage();
        if (!s.contracts[name].exists) revert ContractNotFound(name);
        return s.contracts[name].currentVersion;
    }

    function getNameByAddress(address contractAddress) external view returns (string memory) {
        return registryStorage().addressToName[contractAddress];
    }
}
