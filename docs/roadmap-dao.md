---
tags:
  - smartcontracts
  - facet
  - dao
  - roadmap-dao
---

![header](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=200&section=header&text=RoadMapDAOFacet&fontSize=36&fontAlignY=35&animation=twinkling)

![visitors](https://visitor-badge.laobi.icu/badge?page_id=RapportTecnologia.AgenticSpace.smartcontracts_roadmap-dao)
[![License: CC BY-SA 4.0](https://img.shields.io/badge/License-CC_BY--SA_4.0-blue.svg)](https://creativecommons.org/licenses/by-sa/4.0/)
![Language: Portuguese](https://img.shields.io/badge/Language-Portuguese-brightgreen.svg)
![Status](https://img.shields.io/badge/Status-Ongoing-yellow)
[![GitHub Issues](https://img.shields.io/github/issues/RapportTecnologia/AgenticSpace)](https://github.com/RapportTecnologia/AgenticSpace/issues)

# RoadMapDAOFacet

**Caminho:** `contracts/facets/RoadMapDAOFacet.sol`

Facet de governança para a Equipe de Projetos decidir o RoadMap do sistema. Membros da equipe criam propostas e votam.

## Visão Geral

- Usa `DAOStorage` com namespace `ROADMAP_DAO = keccak256("RoadMapDAO")`
- Propostas com lifecycle completo: criação → votação → timelock → execução
- Requer pagamento de taxa CAS para criar propostas
- Parâmetros configuráveis via `DAO_ADMIN_ROLE`

## Tipos de Proposta

| Valor | Tipo |
|---|---|
| 0 | Feature |
| 1 | Bugfix |
| 2 | Refactor |
| 3 | GovernanceChange |

## Funções

### Inicialização

```solidity
function initRoadMapDAO() external
```

Configura parâmetros padrão (quorum, duração, timelock, limites). Chamada uma única vez durante o deploy.

### Criar Proposta

```solidity
function createProposal(
    uint8 proposalType,
    string calldata title,
    string calldata description,
    bytes calldata data
) external whenNotPaused returns (uint256 proposalId)
```

- **Auth:** `DAO_PROPOSER_ROLE` (membro da equipe)
- Respeita `proposalCooldown` entre propostas do mesmo proponente
- Respeita `maxActiveProposals` simultâneas
- Processa taxa CAS via `PaymentLib.processFeePayment(msg.sender, FEE_TYPE_DAO_PROPOSAL)`
- Emite `ProposalCreated`

### Votar

```solidity
function castVote(uint256 proposalId, uint8 support) external whenNotPaused
```

- **Auth:** `DAO_VOTER_ROLE`
- Voto: 0=Against, 1=For, 2=Abstain
- Um voto por endereço por proposta
- Emite `VoteCast`

### Cancelar

```solidity
function cancelProposal(uint256 proposalId) external onlyRole(DAO_ADMIN_ROLE) whenNotPaused
```

Cancela proposta ativa ou pendente. Emite `ProposalCanceled`.

### Queue / Execute

```solidity
function queueProposal(uint256 proposalId) external onlyRole(DAO_ADMIN_ROLE) whenNotPaused
function executeProposal(uint256 proposalId) external onlyRole(DAO_ADMIN_ROLE) whenNotPaused returns (bytes memory)
```

- `queueProposal`: coloca proposta aprovada em fila (timelock)
- `executeProposal`: executa após timelock
- Janela de execução: 7 dias após o timelock

### Configuração (Admin)

```solidity
function setQuorum(uint256 quorumBps) external onlyRole(DAO_ADMIN_ROLE)
function setVotingDuration(uint256 duration) external onlyRole(DAO_ADMIN_ROLE)
function setTimelockDelay(uint256 delay) external onlyRole(DAO_ADMIN_ROLE)
function setMaxActiveProposals(uint256 max) external onlyRole(DAO_ADMIN_ROLE)
function setProposalCooldown(uint256 cooldown) external onlyRole(DAO_ADMIN_ROLE)
```

### Consultas

| Função | Retorno | Descrição |
|---|---|---|
| `getProposal(uint256 proposalId)` | `(Proposal)` | Retorna dados da proposta |
| `getProposalState(uint256 proposalId)` | `ProposalState` | Estado atual |
| `getProposalCount()` | `uint256` | Total de propostas |
| `getActiveProposalCount()` | `uint256` | Propostas ativas |
| `hasVoted(uint256 proposalId, address voter)` | `bool` | Verifica se votou |

## Parâmetros Padrão

| Parâmetro | Valor |
|---|---|
| `quorumBps` | 400 (4%) |
| `votingDuration` | 3 dias |
| `timelockDelay` | 2 dias |
| `maxActiveProposals` | 20 |
| `proposalCooldown` | 1 dia |

## Estados de Proposta

`Pending → Active → Succeeded → Queued → Executed`
`Active → Defeated` (se quorum não atingido)
`Active/Pending → Canceled`
`Queued → Expired` (se não executado em 7 dias)

## Events

- `ProposalCreated(uint256 proposalId, uint8 proposalType, string title, address proposer)`
- `VoteCast(uint256 proposalId, address voter, uint8 support)`
- `ProposalCanceled(uint256 proposalId)`
- `ProposalQueued(uint256 proposalId, uint256 eta)`
- `ProposalExecuted(uint256 proposalId)`
- `ProposalExpired(uint256 proposalId)`

## Taxas CAS

| Operação | Fee Type | Taxa Padrão |
|---|---|---|
| `createProposal` | `FEE_TYPE_DAO_PROPOSAL` (2) | 50 CAS |
| `castVote` | — | Grátis |

> [!warning] Aprovação prévia
> O pagador deve aprovar o CASToken para o Diamond antes de chamar `createProposal`.

## Dependências

- [[payment-facet]] — `PaymentLib` (processa taxa CAS)
- [[libs]] — `VotingLib` (quorum, aprovação)
- [[access-control]] — `DiamondAccessControl` (`DAO_PROPOSER_ROLE`, `DAO_VOTER_ROLE`, `DAO_ADMIN_ROLE`)
- [[storage-namespaces]] — `DAOStorage` (namespace `ROADMAP_DAO`)

## Segurança

- `whenNotPaused` em todas as funções de mutação
- `DAO_PROPOSER_ROLE` para criar propostas
- `DAO_VOTER_ROLE` para votar
- `DAO_ADMIN_ROLE` para cancelar, queue, execute e configurar
- Timelock entre aprovação e execução
- Cooldown entre propostas do mesmo proponente
- Limite de propostas ativas simultâneas

## Changelog

| Data | Versão | Descrição |
|---|---|---|
| 2025-07-12 | 0.2.0 | Reescrita completa: facet com DAOStorage, PaymentLib, roles |
| 2025-07-11 | 0.1.0 | Documentação inicial do RoadMapDAO standalone |

![footer](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=100&section=footer&animation=twinkling)
