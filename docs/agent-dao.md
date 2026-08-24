---
tags:
  - smartcontracts
  - facet
  - dao
  - agent-dao
---

![header](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=200&section=header&text=AgentDAOFacet&fontSize=36&fontAlignY=35&animation=twinkling)

![visitors](https://visitor-badge.laobi.icu/badge?page_id=RapportTecnologia.AgenticSpace.smartcontracts_agent-dao)
[![License: CC BY-SA 4.0](https://img.shields.io/badge/License-CC_BY--SA_4.0-blue.svg)](https://creativecommons.org/licenses/by-sa/4.0/)
![Language: Portuguese](https://img.shields.io/badge/Language-Portuguese-brightgreen.svg)
![Status](https://img.shields.io/badge/Status-Ongoing-yellow)
[![GitHub Issues](https://img.shields.io/github/issues/RapportTecnologia/AgenticSpace)](https://github.com/RapportTecnologia/AgenticSpace/issues)

# AgentDAOFacet

**Caminho:** `contracts/facets/AgentDAOFacet.sol`

Facet de governança para agentes votarem de forma autônoma ou dirigida por humano. Apenas agentes registrados e ativos no `AgentRegistryFacet` podem votar.

## Visão Geral

- Usa `DAOStorage` com namespace `AGENT_DAO = keccak256("AgentDAO")`
- Suporta delegação de voto entre agentes
- Propostas com lifecycle completo: criação → votação → timelock → execução
- Requer pagamento de taxa CAS para criar propostas
- Parâmetros configuráveis via `DAO_ADMIN_ROLE`

## Tipos de Proposta

| Valor | Tipo |
|---|---|
| 0 | SystemChange |
| 1 | Feature |
| 2 | GovernanceChange |
| 3 | AgentPolicy |

## Funções

### Inicialização

```solidity
function initAgentDAO() external
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

- **Auth:** `AGENT_ROLE`
- Respeita `proposalCooldown` entre propostas do mesmo proponente
- Respeita `maxActiveProposals` simultâneas
- Processa taxa CAS via `PaymentLib.processFeePayment(msg.sender, FEE_TYPE_DAO_PROPOSAL)`
- Emite `ProposalCreated`

### Votar

```solidity
function castVote(uint256 proposalId, uint8 support) external whenNotPaused
```

- **Auth:** `AGENT_ROLE`
- Voto: 0=Against, 1=For, 2=Abstain
- Se o votante delegou seu voto, o delegado vota em seu lugar
- Um voto por endereço por proposta
- Emite `VoteCast`

### Delegação

```solidity
function delegateVote(address delegatee) external whenNotPaused
function revokeDelegation() external whenNotPaused
```

- `delegateVote`: delega voto para outro agente com `AGENT_ROLE`
- Não permite auto-delegação nem delegação dupla
- `revokeDelegation`: revoga delegação ativa
- Emite `VoteDelegated` / `VoteDelegationRevoked`

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
| `getDelegation(address delegator)` | `address` | Retorna delegado |

## Parâmetros Padrão

| Parâmetro | Valor |
|---|---|
| `quorumBps` | 500 (5%) |
| `votingDuration` | 5 dias |
| `timelockDelay` | 3 dias |
| `maxActiveProposals` | 50 |
| `proposalCooldown` | 2 dias |

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
- `VoteDelegated(address delegator, address delegatee)`
- `VoteDelegationRevoked(address delegator)`

## Taxas CAS

| Operação | Fee Type | Taxa Padrão |
|---|---|---|
| `createProposal` | `FEE_TYPE_DAO_PROPOSAL` (2) | 50 CAS |
| `castVote` | — | Grátis |

> [!warning] Aprovação prévia
> O pagador deve aprovar o CASToken para o Diamond antes de chamar `createProposal`.

## Dependências

- [[agent-registry]] — `AgentRegistryFacet` (verifica `AGENT_ROLE`)
- [[payment-facet]] — `PaymentLib` (processa taxa CAS)
- [[libs]] — `VotingLib` (quorum, aprovação)
- [[access-control]] — `DiamondAccessControl` (`AGENT_ROLE`, `DAO_ADMIN_ROLE`)
- [[storage-namespaces]] — `DAOStorage` (namespace `AGENT_DAO`)

## Segurança

- `whenNotPaused` em todas as funções de mutação
- Apenas `AGENT_ROLE` pode criar propostas e votar
- `DAO_ADMIN_ROLE` para cancelar, queue, execute e configurar
- Timelock entre aprovação e execução
- Não permite auto-delegação nem delegação dupla
- Cooldown entre propostas do mesmo proponente
- Limite de propostas ativas simultâneas

## DAO Geral — Visão Conceitual

A **DAO Geral** da Rapport Tecnologia e Inovação é a instância de governança responsável por propor melhorias no ecossistema CAS e no Agentic Space. Ela é formada por duas DAOs complementares que operam em conjunto:

| DAO | Contrato | Foco |
|-----|----------|------|
| **AgentDAO** | `AgentDAOFacet.sol` | Propostas de agentes, mudanças de sistema, políticas e features |
| **CommunityDAO** | `CommunityDAOFacet.sol` | Propostas da comunidade, melhorias de governança e participações |

### Responsabilidades da DAO Geral

- Propor melhorias na **DAO do Ecossistema CAS** (estrutura, parâmetros, regras)
- Propor melhorias na **DAO da CAS** (ArbitrationFacet — processo de arbitragem, quorum, prazos)
- Debater evoluções, mudanças de governança e aprimoramentos gerais
- Não vota ações protetivas ou sanções — essa é a função da **DAO da CAS**

### Relação com a DAO da CAS

A DAO Geral e a DAO da CAS são instâncias complementares:

- **DAO Geral** (AgentDAO + CommunityDAO): evolui o ecossistema, propõe melhorias
- **DAO da CAS** (ArbitrationFacet): protege a moeda, vota sanções e congelamentos

A DAO Geral pode propor mudanças nos parâmetros da DAO da CAS (ex.: quorum, duração de votação, timelock), mas a execução de ações protetivas é exclusiva da DAO da CAS.

> [!info] Documento central
> Para visão completa da estrutura de governança dual, consulte [[dao-structure]].

## Changelog

| Data | Versão | Descrição |
|---|---|---|
| 2026-07-31 | 0.3.0 | Adicionada seção DAO Geral — Visão Conceitual |
| 2025-07-12 | 0.2.0 | Reescrita completa: facet com DAOStorage, delegação, PaymentLib |
| 2025-07-11 | 0.1.0 | Documentação inicial do AgentDAO standalone |

![footer](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=100&section=footer&animation=twinkling)
