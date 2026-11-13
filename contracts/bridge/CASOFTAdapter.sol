// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

// Author:  Carlos Delfino
// Email:   consultoria@carlosdelfino.eti.br
// WhatsApp: +55 (85) 98520-5490

import { OFTAdapter } from "@layerzerolabs/oft-evm/contracts/OFTAdapter.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title CASOFTAdapter
 * @dev Adaptador LayerZero OFT (lock/unlock) para o CAS na Polygon PoS.
 *
 *      Trava o CAS (ERC-20 UUPS existente) e emite o recibo cross-chain que
 *      libera mint do CASOFT na BNB Smart Chain. Implementa o padrao Adapter
 *      (GoF) sobre o OFTAdapter auditado da LayerZero — nenhuma logica de
 *      negocio e adicionada: toda a seguranca da mensageria vem do OFTCore
 *      + EndpointV2 + DVNs configurados via `setConfig` pelo `delegate`.
 *
 *      IMPORTANTE: apenas 1 OFTAdapter pode existir para um dado token na
 *      mesh LayerZero (ver WARNING no contrato base).
 *
 *      O contrato base da LayerZero foi escrito para OpenZeppelin 4.x
 *      (`Ownable` sem argumento). Como o projeto usa OZ 5.x, o `initialOwner`
 *      de `Ownable` e passado aqui, no contrato mais derivado, com o mesmo
 *      `_delegate` — mantendo owner e delegate LZ alinhados.
 */
contract CASOFTAdapter is OFTAdapter {
    /**
     * @notice Cria o adaptador OFT do CAS na chain de origem (Polygon).
     * @param _token Endereco do CASToken (ERC-20 a ser travado/liberado).
     * @param _lzEndpoint EndpointV2 da LayerZero na chain de origem.
     * @param _delegate Conta autorizada a configurar o OApp no endpoint
     *        (owner do OApp — deve ser o deployer no bootstrap e pode ser
     *        transferido para a Safe de governanca depois).
     */
    constructor(
        address _token,
        address _lzEndpoint,
        address _delegate
    ) OFTAdapter(_token, _lzEndpoint, _delegate) Ownable(_delegate) {}
}
