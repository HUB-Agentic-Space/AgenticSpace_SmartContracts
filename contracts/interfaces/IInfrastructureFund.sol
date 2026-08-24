// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

/**
 * @title IInfrastructureFund
 * @dev Interface for the Agentic Space Infrastructure Fund treasury.
 *      Manages CAS (ERC-20) and POL (native) collected from fees.
 *      Funds are used for infrastructure maintenance and can be transferred
 *      to the Rapport address or the author address by authorized roles.
 */
interface IInfrastructureFund {
    event CasReceived(address indexed from, uint256 amount);
    event NativeReceived(address indexed from, uint256 amount);
    event WethReceived(address indexed from, uint256 amount);
    event CasTransferred(address indexed to, uint256 amount);
    event NativeTransferred(address indexed to, uint256 amount);
    event WethTransferred(address indexed to, uint256 amount);
    event RapportAddressUpdated(address indexed oldAddress, address indexed newAddress);
    event AuthorAddressUpdated(address indexed oldAddress, address indexed newAddress);
    event WethTokenUpdated(address indexed oldAddress, address indexed newAddress);

    function depositCas(uint256 amount) external;
    function depositNative() external payable;
    function depositWeth(uint256 amount) external;

    function transferCasToRapport(uint256 amount) external;
    function transferCasToAuthor(uint256 amount) external;
    function transferNativeToRapport(uint256 amount) external;
    function transferNativeToAuthor(uint256 amount) external;
    function transferWethToRapport(uint256 amount) external;
    function transferWethToAuthor(uint256 amount) external;

    function setRapportAddress(address newRapport) external;
    function setAuthorAddress(address newAuthor) external;
    function setWethToken(address newWeth) external;

    function casBalance() external view returns (uint256);
    function nativeBalance() external view returns (uint256);
    function wethBalance() external view returns (uint256);
}
