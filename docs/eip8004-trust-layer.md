---
tags:
  - smartcontracts
  - facet
  - eip-8004
  - trust-layer
---

![header](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=200&section=header&text=EIP-8004%20Trust%20Layer&fontSize=36&fontAlignY=35&animation=twinkling)

![visitors](https://visitor-badge.laobi.icu/badge?page_id=RapportTecnologia.AgenticSpace.smartcontracts_eip8004-trust-layer)
[![License: CC BY-SA 4.0](https://img.shields.io/badge/License-CC_BY--SA_4.0-blue.svg)](https://creativecommons.org/licenses/by-sa/4.0/)
![Language: Portuguese](https://img.shields.io/badge/Language-Portuguese-brightgreen.svg)
![Status](https://img.shields.io/badge/Status-Ongoing-yellow)
[![GitHub Issues](https://img.shields.io/github/issues/RapportTecnologia/AgenticSpace)](https://github.com/RapportTecnologia/AgenticSpace/issues)

# EIP-8004 Trust Layer

**Caminho:** `contracts/facets/eip8004/`

Três facets que implementam o padrão **EIP-8004 (Trustless Agents)** sobre a
identidade já existente no `AgentRegistryFacet`/`AgentStorage`:
`IdentityRegistryFacet`, `ReputationRegistryFacet` e
`ValidationRegistryFacet`. Juntas formam a "camada de confiança" que
permite a um agente avaliar outro antes de negociar (EIP-8183) ou pagar
(x402) por um serviço.

## Visão Geral

- **Não recria identidade.** O EIP-8004 padrão define Identity, Reputation
  e Validation Registries; aqui a Identity **reaproveita** `agentId`,
  `ownerAddress`, `publicId` e `isActive` já persistidos em `AgentStorage`
  pelo `AgentRegistryFacet`. `IdentityRegistryFacet` apenas adiciona a
  extensão específica do EIP-8004 — a URI do *agent card* / manifest
  off-chain.
- Usa o novo namespace `Eip8004Storage` (ver [[storage-namespaces#Eip8004Storage]]).
- Somente hashes e URIs residem on-chain — nunca o conteúdo do agent card,
  o texto do feedback ou o relatório de validação em si.
- Leituras cross-facet (ex.: `ReputationRegistryFacet` chamando
  `AgentCommerceFacet.isJobSettledBetween`) são feitas via `address(this)`
  (o próprio Diamond), nunca por import direto de bytecode de outra facet —
  preserva o isolamento do padrão Diamond Storage.

## Relação com AgentRegistryFacet

| Responsabilidade | Contrato |
|---|---|
| `agentId`, owner, `publicId`, `isActive`, Merkle root de prompts | `AgentRegistryFacet` / `AgentStorage` |
| URI do agent card / manifest EIP-8004 | `IdentityRegistryFacet` / `Eip8004Storage` |
| Agregação de feedback (reputação) | `ReputationRegistryFacet` / `Eip8004Storage` |
| Solicitação/resolução de validação por terceiros | `ValidationRegistryFacet` / `Eip8004Storage` |

Todas as três novas facets **exigem** que o agente já exista e esteja ativo
em `AgentStorage` antes de aceitar qualquer chamada — elas não substituem
o registro, apenas o estendem.

## Estrutura de Dados

Ver [[storage-namespaces#Eip8004Storage]] para o struct `ValidationRequest`
completo e os mappings do namespace.

## IdentityRegistryFacet

**Caminho:** `contracts/facets/eip8004/IdentityRegistryFacet.sol`

### Funções

```solidity
function setAgentMetadataURI(bytes32 agentId, string calldata uri) external
```

Define/atualiza a URI do agent card (ex.: `https://.../agent-card.json`).
Apenas o `ownerAddress` do agente (em `AgentStorage`) pode chamar.

| Função | Retorno | Descrição |
|---|---|---|
| `getAgentMetadataURI(bytes32 agentId)` | `string` | URI atual (vazia se nunca setada) |
| `resolveAgent(bytes32 agentId)` | `(address ownerAddress, string publicId, bool active, string metadataURI)` | Facade — combina identidade + metadata em uma única leitura |
| `isTrustedAgent(bytes32 agentId)` | `bool` | Atalho para `AgentStorage.activeAgents[agentId]` |

`resolveAgent` é o ponto de entrada recomendado para um agente
contraparte avaliar `agentId` antes de negociar ou pagar por um serviço.

### Events

- `AgentMetadataUpdated(bytes32 indexed agentId, string uri)`

### Errors

- `AgentNotFound(bytes32 agentId)`
- `NotAgentOwner(bytes32 agentId, address caller)`
- `EmptyMetadataURI()`

## ReputationRegistryFacet

**Caminho:** `contracts/facets/eip8004/ReputationRegistryFacet.sol`

### Design anti-Sybil

O ponto central desta facet: **feedback só pode ser emitido se referenciar
um job realmente liquidado (`Settled`/`Resolved`) no `AgentCommerceFacet`
(EIP-8183) entre exatamente os dois agentes envolvidos.** Isso é verificado
chamando de volta o próprio Diamond:

```solidity
interface IAgentCommerceView {
    function isJobSettledBetween(uint256 offerId, bytes32 agentA, bytes32 agentB) external view returns (bool);
}
```

`submitFeedback` reverte com `JobNotSettled(jobId)` se o `offerId`
informado como `jobId` não corresponder a uma oferta nos estados
`Settled` ou `Resolved` envolvendo `fromAgentId` e `toAgentId` (em
qualquer ordem — vendedor ou comprador). Isso elimina o vetor clássico de
Sybil/fake-review: não é possível inflar a reputação de um agente sem
antes executar (e pagar) uma transação real e verificável on-chain.

Adicionalmente, `feedbackGiven[bytes32(jobId)][fromAgentId]` impede que o
mesmo lado do mesmo job envie feedback duas vezes.

### Funções

```solidity
function submitFeedback(
    bytes32 fromAgentId,
    bytes32 toAgentId,
    uint256 jobId,
    uint8 score,
    bytes32 commentHash
) external
```

**Pré-requisitos:**
- `fromAgentId != toAgentId`
- `score <= 100`
- `msg.sender` deve ser o `ownerAddress` de `fromAgentId`
- Ambos os agentes devem estar registrados e ativos
- `jobId` (= `offerId` do `AgentCommerceFacet`) deve estar liquidado entre os dois agentes
- Feedback ainda não emitido para este `jobId` por `fromAgentId`

| Função | Retorno | Descrição |
|---|---|---|
| `getFeedbackCount(bytes32 agentId)` | `uint256` | Total de avaliações recebidas |
| `getFeedbackScoreSum(bytes32 agentId)` | `uint256` | Soma bruta das notas |
| `getAverageScore(bytes32 agentId)` | `uint256` | Média (0–100); `0` se sem feedback |
| `hasFeedbackGiven(uint256 jobId, bytes32 fromAgentId)` | `bool` | Se aquele lado já avaliou aquele job |

### Events

- `FeedbackSubmitted(bytes32 indexed fromAgentId, bytes32 indexed toAgentId, uint256 indexed jobId, uint8 score, bytes32 commentHash)`

### Errors

- `AgentNotFound(bytes32 agentId)`
- `NotAgentOwner(bytes32 agentId, address caller)`
- `AgentNotActive(bytes32 agentId)`
- `SameAgent()`
- `InvalidScore(uint8 score)`
- `JobNotSettled(uint256 jobId)`
- `FeedbackAlreadyGiven(uint256 jobId, bytes32 fromAgentId)`

> [!note] `commentHash`
> O texto do comentário nunca é armazenado on-chain, apenas seu hash —
> segue a mesma prática de privacidade usada para VCs e Merkle roots de
> prompts em `AgentStorage`.

## ValidationRegistryFacet

**Caminho:** `contracts/facets/eip8004/ValidationRegistryFacet.sol`

Registro de validação de terceiros: um agente solicita atestação sobre um
trabalho off-chain (`workHash`), e uma conta com `VALIDATOR_ROLE`
(`DiamondAccessControl`) resolve a solicitação com aprovação/rejeição e um
hash de relatório.

### Funções

```solidity
function requestValidation(bytes32 agentId, bytes32 workHash) external returns (uint256 validationId)
```

- Apenas o `ownerAddress` de `agentId` pode solicitar
- `agentId` deve estar registrado e ativo
- `workHash != bytes32(0)`
- Emite `ValidationRequested`

```solidity
function submitValidation(uint256 validationId, bool approved, bytes32 reportHash) external
```

- **Auth:** `VALIDATOR_ROLE` (via `DiamondAccessControl.enforceRoleOrOwner`)
- Só pode resolver uma vez (`ValidationAlreadyResolved` no reenvio)
- Emite `ValidationSubmitted`

| Função | Retorno | Descrição |
|---|---|---|
| `getValidation(uint256 validationId)` | `Eip8004Storage.ValidationRequest` | Registro completo |
| `getValidationsByAgent(bytes32 agentId)` | `uint256[]` | IDs de validação do agente |
| `getValidationCount()` | `uint256` | Total de validações solicitadas |
| `computeWorkHash(bytes content)` | `bytes32` | Helper — `AgentHashLib.computePromptHashFromBytes(content)` |

### Events

- `ValidationRequested(uint256 indexed validationId, bytes32 indexed agentId, bytes32 workHash, address requester)`
- `ValidationSubmitted(uint256 indexed validationId, address indexed validator, bool approved, bytes32 reportHash)`

### Errors

- `AgentNotFound(bytes32 agentId)`
- `NotAgentOwner(bytes32 agentId, address caller)`
- `AgentNotActive(bytes32 agentId)`
- `EmptyWorkHash()`
- `ValidationNotFound(uint256 validationId)`
- `ValidationAlreadyResolved(uint256 validationId)`

## Segurança

- `whenNotPaused` (via `LibDiamond.enforceNotPaused()`) em todas as
  mutações de `IdentityRegistryFacet`, `ReputationRegistryFacet` e
  `requestValidation`/`submitValidation` de `ValidationRegistryFacet`.
- Verificação de ownership (`ownerAddress == msg.sender`) antes de
  qualquer atualização de metadata, feedback ou solicitação de validação.
- `AgentNotActive` bloqueia interações envolvendo agentes desativados
  (`deactivateAgent` no `AgentRegistryFacet`).
- Anti-Sybil de reputação: feedback exige job liquidado real
  (`isJobSettledBetween`) — ver seção acima.
- `feedbackGiven` previne double-feedback no mesmo job/direção.
- `VALIDATOR_ROLE` obrigatório para resolver validações — apenas hashes
  (nunca o conteúdo do trabalho ou do relatório) trafegam on-chain.
- Nenhuma das três facets movimenta CAS ou fundos — reduzem a superfície
  de ataque financeiro em comparação com `AgentCommerceFacet`/`X402FacilitatorFacet`.

## Dependências

- [[agent-registry]] — `AgentRegistryFacet`/`AgentStorage` (identidade base)
- [[eip8183-agent-commerce]] — `AgentCommerceFacet.isJobSettledBetween` (prova anti-Sybil de reputação)
- [[access-control]] — `DiamondAccessControl` (`VALIDATOR_ROLE`)
- [[storage-namespaces]] — `Eip8004Storage`
- `AgentHashLib` — `computePromptHashFromBytes` usado por `computeWorkHash`

## Changelog

| Data | Versão | Descrição |
|---|---|---|
| 2026-08-24 | 0.1.0 | Documentação inicial do Trust Layer EIP-8004 (Identity, Reputation, Validation) |

![footer](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=100&section=footer&animation=twinkling)
