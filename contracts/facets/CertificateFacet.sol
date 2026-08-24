// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { PaymentStorage } from "../diamond/storage/PaymentStorage.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { ContractRegistryFacet } from "./ContractRegistryFacet.sol";

// -----------------------------------------------------------------------
// RapportCertificate interface / struct
// -----------------------------------------------------------------------

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

interface IRapportCertificate {
    struct Phase {
        string name;
        bytes32 templateHash;
        uint256 minCasDeposit;
        uint256 startsAt;
        uint256 endsAt;
        uint256 minted;
        bool active;
        string skillsDescription;
        string instructions;
        uint256 extraFeeTypeId;
        uint256 tbaRebateBps;
    }

    function depositCasForMintFor(address beneficiary, uint256 phaseId, uint256 amount) external;
    function certificateOf(address recipient, uint256 phaseId) external view returns (uint256);
    function tokenBoundAccount(uint256 tokenId) external view returns (address);
    function mintCertificate(
        CertificateMintAuthorization calldata authorization,
        address issuer,
        bytes calldata signature
    ) external returns (uint256 tokenId, address tokenBoundAccount_);
    function getPhase(uint256 phaseId) external view returns (Phase memory);
    function attestMerkleRootProof(uint256 tokenId, bytes32 merkleRootProof) external;
    function getMerkleRootProof(uint256 tokenId) external view returns (bytes32);
}

/**
 * @title CertificateFacet
 * @dev Facet do Diamond Proxy que orquestra a emissão de certificados
 *      RapportCertificate. O usuário transfere CAS para o Diamond (endereço
 *      já conhecido/confiável pelo MetaMask/Blockaid) e chama
 *      `depositAndMintCertificate` em uma única transação via Diamond. O próprio
 *      Diamond repassa o CAS ao contrato de certificados e executa o mint,
 *      sem que a carteira do usuário interaja diretamente com o contrato de
 *      certificados recém-implantado.
 *
 *      Padrões: Diamond Storage (EIP-2535), Facade/Adapter
 */
contract CertificateFacet {
    using SafeERC20 for IERC20;

    // -----------------------------------------------------------------------
    // Reentrancy guard (Diamond Storage)
    // -----------------------------------------------------------------------

    bytes32 internal constant REENTRANCY_SLOT =
        keccak256("agentic.space.diamond.certificate.reentrancy");
    uint256 internal constant _NOT_ENTERED = 1;
    uint256 internal constant _ENTERED = 2;

    modifier nonReentrant() {
        bytes32 slot = REENTRANCY_SLOT;
        uint256 status;
        assembly { status := sload(slot) }
        if (status == _ENTERED) revert("ReentrancyGuard: reentrant call");
        assembly { sstore(slot, _ENTERED) }
        _;
        assembly { sstore(slot, _NOT_ENTERED) }
    }

    // -----------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------

    error CasTokenNotSet();
    error CertificateNotRegistered();
    error CallerNotRecipient(address caller, address recipient);
    error ExtraFeeTypeNotRegistered(uint256 feeTypeId);
    error InfrastructureFundNotSet();

    /// @dev Phase ID of the founding member certificate ("Sócio Fundador").
    uint256 internal constant FOUNDER_PHASE_ID = 1;
    /// @dev Basis-points denominator (100% = 10000) for the TBA fee rebate.
    uint256 internal constant BPS_DENOMINATOR = 10000;

    event CertificateExtraFeePaid(
        uint256 indexed tokenId,
        uint256 indexed feeTypeId,
        uint256 extraFee,
        uint256 tbaShare,
        uint256 infraShare,
        address tbaAccount,
        address infrastructureFund
    );

    // -----------------------------------------------------------------------
    // Public entry point
    // -----------------------------------------------------------------------

    /**
     * @notice Deposita o CAS do usuário no contrato de certificados e emite o
     *         NFT em uma única transação via Diamond. O usuário deve aprovar o
     *         Diamond para gastar exatamente `authorization.casAmount` CAS
     *         antes de chamar esta função (padrão ERC-20 approve+transferFrom
     *         com spender conhecido/verificado — o Diamond).
     * @dev O CAS é transferido diretamente da carteira do usuário para o
     *      contrato de certificados via transferFrom; o Diamond nunca retém
     *      saldo, evitando consumir CAS de outros fluxos.
     * @param authorization Autorização EIP-712 assinada pelo ISSUER.
     * @param issuer Endereço do emissor que assinou a autorização.
     * @param signature Assinatura EIP-712.
     */
    function depositAndMintCertificate(
        CertificateMintAuthorization calldata authorization,
        address issuer,
        bytes calldata signature
    ) external nonReentrant returns (uint256 tokenId, address tokenBoundAccount_) {
        if (authorization.recipient != msg.sender) {
            revert CallerNotRecipient(msg.sender, authorization.recipient);
        }

        address rapCert = ContractRegistryFacet(address(this)).getAddress("RapportCertificate");
        if (rapCert == address(0)) revert CertificateNotRegistered();

        PaymentStorage.PaymentStorageData storage ps = PaymentStorage.paymentStorage();
        IERC20 cas = ps.casToken;
        if (address(cas) == address(0)) revert CasTokenNotSet();

        // Read the phase to determine if an extra fee applies.
        IRapportCertificate.Phase memory phase = IRapportCertificate(rapCert).getPhase(
            authorization.phaseId
        );
        uint256 extraFee = 0;
        uint256 extraFeeTypeId = phase.extraFeeTypeId;

        if (extraFeeTypeId != 0) {
            if (!ps.feeTypeExists[extraFeeTypeId]) {
                revert ExtraFeeTypeNotRegistered(extraFeeTypeId);
            }
            extraFee = ps.customFees[extraFeeTypeId];
        }

        uint256 casAmount = authorization.casAmount;

        // 1. Pull CAS deposit from user directly to the certificate contract.
        cas.safeTransferFrom(msg.sender, rapCert, casAmount);

        // 2. Credit the deposit to the user (msg.sender == authorization.recipient).
        IRapportCertificate(rapCert).depositCasForMintFor(
            authorization.recipient,
            authorization.phaseId,
            casAmount
        );

        // 3. If extra fee applies, split it between the recipient's Founder TBA
        //    (rebate) and the infrastructure fund. If the recipient does not
        //    hold a Founder certificate, the whole fee goes to the infra fund.
        uint256 tbaShare = 0;
        uint256 infraShare = 0;
        address tbaAccount = address(0);
        if (extraFee > 0) {
            uint256 rebateBps = phase.tbaRebateBps;
            if (rebateBps > 0) {
                uint256 founderTokenId = IRapportCertificate(rapCert).certificateOf(
                    authorization.recipient,
                    FOUNDER_PHASE_ID
                );
                if (founderTokenId != 0) {
                    tbaAccount = IRapportCertificate(rapCert).tokenBoundAccount(
                        founderTokenId
                    );
                    if (tbaAccount != address(0)) {
                        tbaShare = (extraFee * rebateBps) / BPS_DENOMINATOR;
                    }
                }
            }
            infraShare = extraFee - tbaShare;

            if (tbaShare > 0) {
                cas.safeTransferFrom(msg.sender, tbaAccount, tbaShare);
            }
            if (infraShare > 0) {
                address infraFund = ps.infrastructureFund;
                if (infraFund == address(0)) revert InfrastructureFundNotSet();
                cas.safeTransferFrom(msg.sender, infraFund, infraShare);
            }
        }

        // 4. Mint the NFT. RapportCertificate verifies the ISSUER signature.
        (tokenId, tokenBoundAccount_) = IRapportCertificate(rapCert).mintCertificate(
            authorization,
            issuer,
            signature
        );

        if (extraFee > 0) {
            emit CertificateExtraFeePaid(
                tokenId,
                extraFeeTypeId,
                extraFee,
                tbaShare,
                infraShare,
                tbaAccount,
                ps.infrastructureFund
            );
        }
    }

    /**
     * @notice Devolve o endereço do contrato RapportCertificate registrado no
     *         Diamond para conveniência do frontend.
     */
    function getCertificateContract() external view returns (address) {
        return ContractRegistryFacet(address(this)).getAddress("RapportCertificate");
    }

    /**
     * @notice Atessa o Merkle root da prova de trabalho documental para um
     *         certificado. Apenas o ISSUER_ROLE do RapportCertificate pode chamar.
     *         Passthrough para RapportCertificate.attestMerkleRootProof.
     */
    function attestCertificateMerkleRootProof(
        uint256 tokenId,
        bytes32 merkleRootProof
    ) external {
        address rapCert = ContractRegistryFacet(address(this)).getAddress("RapportCertificate");
        if (rapCert == address(0)) revert CertificateNotRegistered();
        IRapportCertificate(rapCert).attestMerkleRootProof(tokenId, merkleRootProof);
    }

    /**
     * @notice Retorna o Merkle root da prova de trabalho documental de um
     *         certificado, ou bytes32(0) se não definido (certificados legados).
     */
    function getCertificateMerkleRootProof(uint256 tokenId)
        external
        view
        returns (bytes32)
    {
        address rapCert = ContractRegistryFacet(address(this)).getAddress("RapportCertificate");
        if (rapCert == address(0)) revert CertificateNotRegistered();
        return IRapportCertificate(rapCert).getMerkleRootProof(tokenId);
    }
}
