// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import { IERC1271 } from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import { SignatureChecker } from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import { IERC6551Account } from "../interfaces/IERC6551Account.sol";
import { IERC6551Executable } from "../interfaces/IERC6551Executable.sol";

/// @title Rapport Certificate Token-Bound Account
/// @notice Minimal ERC-6551 account controlled by the owner of a Rapport
///         certificate. It deliberately supports CALL only.
/// @dev The canonical ERC-6551 registry appends salt/chain/token context to an
///      ERC-1167 proxy. This implementation reads that immutable context from
///      the proxy runtime bytecode.
contract RapportCertificateAccount is
    IERC165,
    IERC1271,
    IERC6551Account,
    IERC6551Executable
{
    bytes4 internal constant ERC1271_MAGIC_VALUE = IERC1271.isValidSignature.selector;

    uint256 public override state;
    bool private executing;

    error Unauthorized(address caller);
    error UnsupportedOperation(uint8 operation);
    error ZeroTarget();
    error ReentrantExecution();

    event Executed(
        address indexed owner,
        address indexed to,
        uint256 value,
        bytes data,
        bytes result
    );

    receive() external payable {}

    /// @inheritdoc IERC6551Account
    function token()
        public
        view
        override
        returns (uint256 chainId, address tokenContract, uint256 tokenId)
    {
        bytes memory encoded = new bytes(0x60);
        assembly {
            // Runtime layout: ERC-1167 runtime (0x2d), salt (0x20), then
            // chainId/tokenContract/tokenId at offset 0x4d.
            extcodecopy(address(), add(encoded, 0x20), 0x4d, 0x60)
        }
        return abi.decode(encoded, (uint256, address, uint256));
    }

    /// @notice Current controller of this account.
    /// @dev Returns zero for a foreign chain, an unminted token or a burned
    ///      token instead of making account introspection revert.
    function owner() public view returns (address) {
        (uint256 chainId, address tokenContract, uint256 tokenId) = token();
        if (chainId != block.chainid || tokenContract == address(0)) {
            return address(0);
        }

        try IERC721(tokenContract).ownerOf(tokenId) returns (address tokenOwner) {
            return tokenOwner;
        } catch {
            return address(0);
        }
    }

    /// @inheritdoc IERC6551Account
    function isValidSigner(address signer, bytes calldata)
        external
        view
        override
        returns (bytes4 magicValue)
    {
        address accountOwner = owner();
        if (accountOwner != address(0) && signer == accountOwner) {
            return IERC6551Account.isValidSigner.selector;
        }
        return bytes4(0);
    }

    /// @inheritdoc IERC1271
    function isValidSignature(bytes32 hash, bytes memory signature)
        external
        view
        override
        returns (bytes4 magicValue)
    {
        address accountOwner = owner();
        if (
            accountOwner != address(0)
                && SignatureChecker.isValidSignatureNow(accountOwner, hash, signature)
        ) {
            return ERC1271_MAGIC_VALUE;
        }
        return bytes4(0);
    }

    /// @inheritdoc IERC6551Executable
    function execute(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation
    ) external payable override returns (bytes memory result) {
        address accountOwner = owner();
        if (msg.sender != accountOwner || accountOwner == address(0)) {
            revert Unauthorized(msg.sender);
        }
        if (operation != 0) revert UnsupportedOperation(operation);
        if (to == address(0)) revert ZeroTarget();
        if (executing) revert ReentrantExecution();

        executing = true;
        unchecked {
            state++;
        }

        (bool success, bytes memory returnData) = to.call{ value: value }(data);
        if (!success) {
            assembly {
                revert(add(returnData, 0x20), mload(returnData))
            }
        }

        executing = false;
        emit Executed(accountOwner, to, value, data, returnData);
        return returnData;
    }

    function supportsInterface(bytes4 interfaceId)
        external
        pure
        override
        returns (bool)
    {
        return interfaceId == type(IERC165).interfaceId
            || interfaceId == type(IERC1271).interfaceId
            || interfaceId == type(IERC6551Account).interfaceId
            || interfaceId == type(IERC6551Executable).interfaceId;
    }
}
