---
tags:
  - smartcontracts
  - facet
  - eip-8183
  - commerce
  - escrow
---

![header](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=200&section=header&text=EIP-8183%20Agent%20Commerce&fontSize=36&fontAlignY=35&animation=twinkling)

![visitors](https://visitor-badge.laobi.icu/badge?page_id=RapportTecnologia.AgenticSpace.smartcontracts_eip8183-agent-commerce)
[![License: CC BY-SA 4.0](https://img.shields.io/badge/License-CC_BY--SA_4.0-blue.svg)](https://creativecommons.org/licenses/by-sa/4.0/)
![Language: Portuguese](https://img.shields.io/badge/Language-Portuguese-brightgreen.svg)
![Status](https://img.shields.io/badge/Status-Ongoing-yellow)
[![GitHub Issues](https://img.shields.io/github/issues/RapportTecnologia/AgenticSpace)](https://github.com/RapportTecnologia/AgenticSpace/issues)

# AgentCommerceFacet (EIP-8183)

**Caminho:** `contracts/facets/eip8183/AgentCommerceFacet.sol`

Facet que implementa o protocolo **EIP-8183** de comércio agente-a-agente:
um agente vendedor publica uma oferta de serviço, um agente comprador
negocia o preço dentro de limites configuráveis, o preço aceito é
custodiado (escrow) em CAS pelo próprio Diamond, o vendedor marca a
entrega e, ou o comprador confirma, ou — após a janela de disputa —
qualquer pessoa pode acionar a liquidação. Uma disputa pausa a liquidação
até que `COMMERCE_ARBITER_ROLE` resolva a divisão dos fundos.

## Visão Geral

- Usa o namespace `CommerceStorage` (ver [[storage-namespaces#CommerceStorage]]).
- Apenas dois agentes negociam uma dada oferta (vendedor e comprador);
  qualquer agente pode criar suas próprias ofertas livremente.
- Todo o fluxo financeiro é em **CAS** via `PaymentStorage.casToken`, com a
  taxa de protocolo enviada ao `InfrastructureFund` (`PaymentStorage.infrastructureFund`).
- Todas as funções que mutam estado seguem **Checks-Effects-Interactions**:
  o estado do `Offer` é finalizado (state, `updatedAt`, `fundedAmount` etc.)
  **antes** de qualquer `safeTransfer`/`safeTransferFrom`.
- `isJobSettledBetween(offerId, agentA, agentB)` é a view usada por
  `ReputationRegistryFacet` (EIP-8004) para validar que um feedback está
  ancorado em uma transação real — ver [[eip8004-trust-layer#Design anti-Sybil]].

## Ciclo de Vida (`JobState`)

```solidity
enum JobState {
    None,          // offerId inexistente
    Open,          // criada, aguardando negociação/aceite
    Negotiating,   // pelo menos uma contraproposta foi feita
    Accepted,      // preço e comprador definidos, aguardando funding
    Funded,        // CAS custodiado pelo Diamond
    Delivered,     // vendedor marcou entrega, janela de disputa correndo
    Settled,       // liquidado sem disputa (confirmDelivery ou claimSettlement)
    Disputed,      // comprador contestou a entrega dentro da janela
    Resolved,      // COMMERCE_ARBITER_ROLE dividiu o escrow
    Cancelled      // vendedor cancelou antes do funding
}
```

Transições válidas:

```
Open ──createOffer──> Open
Open/Negotiating ──negotiate──> Negotiating
Open/Negotiating ──acceptOffer──> Accepted
Open/Negotiating/Accepted ──cancelOffer──> Cancelled
Accepted ──fundJob──> Funded
Funded ──markDelivered──> Delivered
Delivered ──confirmDelivery──> Settled
Delivered (após disputeWindow) ──claimSettlement──> Settled
Delivered (dentro de disputeWindow) ──raiseDispute──> Disputed
Disputed ──resolveDispute──> Resolved
```

## Estrutura de Dados

Ver [[storage-namespaces#CommerceStorage]] para o struct `Offer` completo
e os parâmetros de configuração (`protocolFeeBps`, `disputeWindow`,
`minNegotiationBps`, `maxNegotiationBps`).

## Funções

### Inicialização e Admin

```solidity
function initAgentCommerce(uint256 protocolFeeBps, uint256 disputeWindow) external
```

- **Auth:** contract owner (`LibDiamond.enforceIsContractOwner`)
- Chamada única (`AlreadyInitialized` no reenvio)
- Define `minNegotiationBps = 5_000` (50%) e `maxNegotiationBps = 15_000` (150%) como padrão
- Concede `COMMERCE_ARBITER_ROLE` ao contract owner
- Emite `AgentCommerceInitialized`

```solidity
function setProtocolFeeBps(uint256 bps) external          // COMMERCE_ARBITER_ROLE ou owner
function setDisputeWindow(uint256 seconds_) external       // COMMERCE_ARBITER_ROLE ou owner
function setNegotiationBounds(uint256 minBps, uint256 maxBps) external // COMMERCE_ARBITER_ROLE ou owner
```

`setNegotiationBounds` reverte com `InvalidBps` se `minBps == 0` ou
`maxBps < minBps`.

### Oferta e Negociação

```solidity
function createOffer(bytes32 sellerAgentId, bytes32 scopeHash, uint256 price, uint256 deadline) external returns (uint256 offerId)
```

- Requer `CommerceStorage.initialized == true`, `price != 0`, `deadline > block.timestamp`
- `msg.sender` deve ser owner ativo de `sellerAgentId`
- Emite `OfferCreated`

```solidity
function negotiate(uint256 offerId, uint256 counterPrice) external
```

- Válido apenas em `Open`/`Negotiating` e antes do `deadline`
- O primeiro endereço diferente do vendedor a negociar é fixado como `buyerAddress`
- `msg.sender` não pode ser o autor da última proposta (`CannotNegotiateOwnLastProposal`)
- `counterPrice` deve estar dentro de `[minNegotiationBps, maxNegotiationBps]` do **preço original listado** (ver seção de design abaixo)
- Emite `OfferNegotiated`

```solidity
function acceptOffer(uint256 offerId, bytes32 buyerAgentId) external
```

- Só quem **não** fez a última proposta pode aceitar
- Se quem aceita é o vendedor, vincula `buyerAgentId` (deve pertencer a `offer.buyerAddress`)
- Emite `OfferAccepted`

```solidity
function cancelOffer(uint256 offerId) external
```

- Apenas o vendedor, e apenas em `Open`/`Negotiating`/`Accepted`
- Emite `OfferCancelled`

### Escrow, Entrega e Liquidação

```solidity
function fundJob(uint256 offerId) external
```

- Apenas o comprador, apenas em `Accepted`
- `_casToken().safeTransferFrom(msg.sender, address(this), amount)` — CAS fica custodiado pelo próprio Diamond
- Emite `JobFunded`

```solidity
function markDelivered(uint256 offerId) external
```

- Apenas o vendedor, apenas em `Funded`
- Emite `JobDelivered`

```solidity
function confirmDelivery(uint256 offerId) external
```

- Apenas o comprador, apenas em `Delivered`
- Chama `_settle` imediatamente (sem esperar a janela de disputa)

```solidity
function claimSettlement(uint256 offerId) external
```

- Qualquer conta (tipicamente um keeper/backend) pode chamar
- Apenas em `Delivered` e após `deliveredAt + disputeWindow`
- Reverte com `DisputeWindowNotElapsed` se chamado cedo demais

```solidity
function raiseDispute(uint256 offerId, bytes32 reasonHash) external
```

- Apenas o comprador, apenas em `Delivered`, apenas dentro da janela de disputa
- Emite `DisputeRaised`

```solidity
function resolveDispute(uint256 offerId, uint256 buyerRefundBps) external
```

- **Auth:** `COMMERCE_ARBITER_ROLE` ou owner
- Divide `fundedAmount` entre reembolso do comprador (`buyerRefundBps`) e o
  vendedor; a taxa de protocolo é cobrada **apenas** sobre a parte do
  vendedor
- Emite `DisputeResolved`

### Views

| Função | Retorno | Descrição |
|---|---|---|
| `getOffer(uint256 offerId)` | `CommerceStorage.Offer` | Dados completos da oferta |
| `getOffersBySeller(bytes32 sellerAgentId)` | `uint256[]` | IDs de ofertas do vendedor |
| `getOfferCount()` | `uint256` | Total de ofertas criadas |
| `getProtocolFeeBps()` | `uint256` | Taxa de protocolo atual |
| `getDisputeWindow()` | `uint256` | Janela de disputa (segundos) |
| `getNegotiationBounds()` | `(uint256 minBps, uint256 maxBps)` | Limites de negociação |
| `isJobSettledBetween(uint256 offerId, bytes32 agentA, bytes32 agentB)` | `bool` | Usado por `ReputationRegistryFacet` |

## Design: Clamp de Negociação (Anti-LLM-Arbitrário)

O ponto de design mais importante desta facet: **nenhum agente — humano ou
LLM agindo em nome de um agente — pode mover o preço de forma arbitrária
durante a negociação.** Toda contraproposta em `negotiate()` é recalculada
sempre em relação ao **preço originalmente listado** (`offer.price` no
momento da criação, antes de qualquer negociação subsequente já ter
alterado esse mesmo campo — ou seja, os bounds seguem a última base
armazenada, não um valor calculado fora da cadeia):

```solidity
uint256 minAllowed = (s.minNegotiationBps * offer.price) / BPS_DENOMINATOR;
uint256 maxAllowed = (s.maxNegotiationBps * offer.price) / BPS_DENOMINATOR;
if (counterPrice < minAllowed || counterPrice > maxAllowed) {
    revert PriceOutOfNegotiationBounds(counterPrice, minAllowed, maxAllowed);
}
```

Os limites (`minNegotiationBps`/`maxNegotiationBps`, padrão 50%–150%) são
**parâmetros de governança**, ajustáveis apenas por
`COMMERCE_ARBITER_ROLE`/owner via `setNegotiationBounds`. Isso significa
que:

- Um agente autônomo (LLM) pode propor qualquer `counterPrice` que queira,
  mas o contrato **só aceita** valores dentro da faixa definida
  on-chain — a IA nunca decide sozinha o intervalo de preços aceitável.
- Ataques de manipulação de preço via prompt injection, alucinação ou
  colusão entre agentes ficam limitados ao range configurado pela
  governança, nunca movendo o valor para fora dos bounds regrados.
- A regra é puramente aritmética e determinística (regra de negócio "on
  the rails"), sem depender de heurísticas ou oráculos externos.

## Events

- `AgentCommerceInitialized(uint256 protocolFeeBps, uint256 disputeWindow)`
- `OfferCreated(uint256 indexed offerId, bytes32 indexed sellerAgentId, address sellerAddress, bytes32 scopeHash, uint256 price, uint256 deadline)`
- `OfferNegotiated(uint256 indexed offerId, address indexed proposer, uint256 price)`
- `OfferAccepted(uint256 indexed offerId, bytes32 buyerAgentId, address buyerAddress, uint256 price)`
- `OfferCancelled(uint256 indexed offerId)`
- `JobFunded(uint256 indexed offerId, uint256 amount)`
- `JobDelivered(uint256 indexed offerId, uint256 deliveredAt)`
- `JobSettled(uint256 indexed offerId, uint256 sellerAmount, uint256 protocolFee)`
- `DisputeRaised(uint256 indexed offerId, bytes32 reasonHash)`
- `DisputeResolved(uint256 indexed offerId, uint256 buyerRefund, uint256 sellerAmount, uint256 protocolFee)`

## Errors

`AlreadyInitialized`, `NotInitialized`, `AgentNotFound(bytes32)`,
`NotAgentOwner(bytes32, address)`, `AgentNotActive(bytes32)`,
`InvalidPrice()`, `InvalidDeadline()`, `OfferNotFound(uint256)`,
`OfferExpired(uint256)`, `InvalidOfferState(uint256, CommerceStorage.JobState)`,
`NotOfferParty(uint256, address)`, `CannotNegotiateOwnLastProposal(uint256)`,
`PriceOutOfNegotiationBounds(uint256, uint256, uint256)`,
`BuyerAlreadySet(uint256)`, `NotBuyer(uint256, address)`,
`NotSeller(uint256, address)`, `CasTokenNotSet()`,
`InfrastructureFundNotSet()`, `DisputeWindowNotElapsed(uint256, uint256)`,
`DisputeWindowElapsed(uint256)`, `InvalidBps(uint256)`

## Escrow, CEI e Segurança

- **Custódia:** o próprio Diamond guarda o CAS (`address(this)`) entre
  `fundJob` e a liquidação — não há um cofre externo separado.
- **Checks-Effects-Interactions:** em `fundJob`, `_settle` e
  `resolveDispute`, o `state`/`fundedAmount`/`updatedAt` do `Offer` é
  atualizado **antes** de qualquer `safeTransfer`/`safeTransferFrom`,
  eliminando janelas de reentrância mesmo sem `ReentrancyGuard` explícito
  (o CAS é um ERC-20 OpenZeppelin padrão, sem hooks de callback).
- **SafeERC20:** todas as transferências usam `SafeERC20.safeTransfer` /
  `safeTransferFrom`.
- **Fluxo de taxa:** a taxa de protocolo (`protocolFeeBps`, base
  10 000 = 100%) é sempre descontada do lado do vendedor e enviada ao
  `InfrastructureFund` registrado em `PaymentStorage.infrastructureFund` —
  o mesmo fundo usado por `PaymentLib` para as taxas de registro/validação/DAO.
  Ver [[storage-namespaces#PaymentStorage]] e [[architecture#Fluxo de Pagamentos]].
- **Autorização por papel:** `resolveDispute` e os setters administrativos
  exigem `COMMERCE_ARBITER_ROLE` (ou o contract owner, via
  `DiamondAccessControl.enforceRoleOrOwner`).
- **Janela de disputa:** protege o comprador de liquidação automática
  imediata após `markDelivered`; após a janela, qualquer keeper pode
  finalizar via `claimSettlement`, evitando fundos presos indefinidamente
  se o comprador nunca confirmar.
- **Validação de identidade:** todas as operações que fixam um lado da
  negociação (`createOffer`, `acceptOffer`) verificam que o `agentId`
  informado existe, está ativo e pertence a `msg.sender` em `AgentStorage`.
- **`whenNotPaused`:** todas as mutações respeitam
  `LibDiamond.enforceNotPaused()`.

## Dependências

- [[agent-registry]] — `AgentRegistryFacet`/`AgentStorage` (identidade dos agentes vendedor/comprador)
- [[payment-facet]] — `PaymentStorage` (`casToken`, `infrastructureFund`)
- [[access-control]] — `DiamondAccessControl` (`COMMERCE_ARBITER_ROLE`)
- [[eip8004-trust-layer]] — `ReputationRegistryFacet` consome `isJobSettledBetween`
- [[storage-namespaces]] — `CommerceStorage`
- OpenZeppelin `SafeERC20`/`IERC20`

## Changelog

| Data | Versão | Descrição |
|---|---|---|
| 2026-08-24 | 0.1.0 | Documentação inicial do AgentCommerceFacet (EIP-8183) |

![footer](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=100&section=footer&animation=twinkling)
