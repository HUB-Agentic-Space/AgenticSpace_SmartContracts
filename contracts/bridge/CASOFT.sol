// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

// Author:  Carlos Delfino
// Email:   consultoria@carlosdelfino.eti.br
// WhatsApp: +55 (85) 98520-5490

import { OFT } from "@layerzerolabs/oft-evm/contracts/OFT.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title CASOFT
 * @dev Representacao omnichain do CAS na BNB Smart Chain (LayerZero OFT).
 *
 *      ERC-20 mint/burn controlado exclusivamente pelo EndpointV2 da
 *      LayerZero: cada token na BSC corresponde a 1 CAS travado no
 *      CASOFTAdapter na Polygon, preservando o supply global cross-chain.
 *
 *      Diferente do CASToken (Polygon), este contrato NAO carrega roles de
 *      freeze/votingLock — e a representacao negociavel do CAS em DEXs da
 *      BSC (par CAS/BNB na PancakeSwap Infinity). O supply e lastreado
 *      1:1 pelo CAS travado na origem.
 *
 *      O contrato base da LayerZero foi escrito para OpenZeppelin 4.x
 *      (`Ownable` sem argumento). Como o projeto usa OZ 5.x, o `initialOwner`
 *      de `Ownable` e passado aqui, no contrato mais derivado, com o mesmo
 *      `_delegate` — mantendo owner e delegate LZ alinhados.
 */
contract CASOFT is OFT {
    /**
     * @notice Cria o OFT do CAS na BSC.
     * @param _lzEndpoint EndpointV2 da LayerZero na BSC.
     * @param _delegate Conta autorizada a configurar o OApp no endpoint
     *        (owner do OApp — deployer no bootstrap; pode ser transferido
     *        para uma Safe depois).
     */
    constructor(
        address _lzEndpoint,
        address _delegate
    ) OFT("Cryptocoin Agentic Space", "CAS", _lzEndpoint, _delegate) Ownable(_delegate) {}
}
