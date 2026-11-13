// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

/**
 * Author:  Carlos Delfino
 * Email:   consultoria@carlosdelfino.eti.br
 * WhatsApp: +55 (85) 98520-5490
 */

import { ICASToken } from "./ICASToken.sol";

/**
 * @title ICASTokenCompliance
 * @dev Interface para as capacidades de compliance do CASToken na geracao
 *      V2.1+ (freeze de contas e voting lock de arbitragem), implementadas
 *      pela implementacao 0xb6D08a85a0bA8ED374dFb4aE47285C90889683B8
 *      deployada na Polygon mas ainda nao ativada.
 *
 *      Mantida separada de `ICASToken` porque o token em producao
 *      (0x5151A34EaC7bA08cd6B540b32cD30316218A2287, geracao V2.0) nao expoe
 *      essas funcoes: chamadas a elas revertem on-chain ate que uma nova
 *      geracao do token seja ativada via redeploy + migracao (o contrato em
 *      producao nao esta atras de proxy ERC1967, portanto nao e atualizavel
 *      via UUPS).
 *
 *      Facets da constelacao que emitem decisoes de compliance
 *      (ArbitrationFacet, AgentDAOFacet, CommunityDAOFacet) fazem cast para
 *      esta interface apenas nos pontos em que exigem as funcoes V2.1+,
 *      preservando a compilacao sem quebrar a fidelidade da interface de
 *      producao `ICASToken`.
 */
interface ICASTokenCompliance is ICASToken {
    event Frozen(address indexed account, uint256 untilTime);
    event Unfrozen(address indexed account);
    event VotingLockStateChanged(bool active);

    function freeze(address account) external;
    function freezeUntil(address account, uint256 endTime) external;
    function unfreeze(address account) external;
    function isFrozen(address account) external view returns (bool);
    function freezeUntilOf(address account) external view returns (uint256);
    function setVotingLock(bool active) external;
    function isVotingLockActive() external view returns (bool);
}
