// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC721Receiver } from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import { IERC6551Executable } from "../interfaces/IERC6551Executable.sol";

interface IRapportCertificateMint {
    struct CertificateMintAuthorization {
        bytes32 issuanceId;
        address recipient;
        bytes32 nameHash;
        uint256 phaseId;
        bytes32 metadataHash;
        uint256 casAmount;
        uint256 nonce;
        uint256 deadline;
    }

    function mintCertificate(
        CertificateMintAuthorization calldata authorization,
        address issuer,
        bytes calldata signature
    ) external returns (uint256 tokenId, address tokenBoundAccount);

    function depositCasForMint(uint256 phaseId) external;

    function tokenBoundAccount(uint256 tokenId) external view returns (address);
}

/// @dev Test-only ERC-721 receiver that tries to empty the newly controlled TBA
///      from inside onERC721Received.
contract MockCertificateReceiver is IERC721Receiver {
    IRapportCertificateMint private immutable certificate;
    IERC20 private immutable casToken;
    address private immutable destination;
    uint256 private amountToDrain;

    constructor(address certificate_, address casToken_, address destination_) {
        certificate = IRapportCertificateMint(certificate_);
        casToken = IERC20(casToken_);
        destination = destination_;
    }

    function mint(
        IRapportCertificateMint.CertificateMintAuthorization calldata authorization,
        address issuer,
        bytes calldata signature
    ) external {
        amountToDrain = authorization.casAmount;
        casToken.transfer(address(certificate), authorization.casAmount);
        certificate.depositCasForMint(authorization.phaseId);
        certificate.mintCertificate(authorization, issuer, signature);
    }

    function onERC721Received(address, address, uint256 tokenId, bytes calldata)
        external
        override
        returns (bytes4)
    {
        address account = certificate.tokenBoundAccount(tokenId);
        IERC6551Executable(account).execute(
            address(casToken),
            0,
            abi.encodeCall(IERC20.transfer, (destination, amountToDrain)),
            0
        );
        return IERC721Receiver.onERC721Received.selector;
    }
}
