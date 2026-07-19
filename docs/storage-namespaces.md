---
tags:
  - smartcontracts
  - storage
  - eip-2535
---

![header](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=200&section=header&text=Storage%20Namespaces&fontSize=36&fontAlignY=35&animation=twinkling)

![visitors](https://visitor-badge.laobi.icu/badge?page_id=RapportTecnologia.AgenticSpace.smartcontracts_storage-namespaces)
[![License: CC BY-SA 4.0](https://img.shields.io/badge/License-CC_BY--SA_4.0-blue.svg)](https://creativecommons.org/licenses/by-sa/4.0/)
![Language: Portuguese](https://img.shields.io/badge/Language-Portuguese-brightgreen.svg)
![Status](https://img.shields.io/badge/Status-Ongoing-yellow)
[![GitHub Issues](https://img.shields.io/github/issues/RapportTecnologia/AgenticSpace)](https://github.com/RapportTecnologia/AgenticSpace/issues)

# Storage Namespaces — Diamond Storage

Cada domínio do Diamond possui seu próprio namespace de storage, acessado via slots fixos definidos por `keccak256`. Isso evita colisões de storage entre facets e permite que cada facet gerencie seu próprio estado independentemente.

## Visão Geral

| Biblioteca | Slot | Domínio |
|---|---|---|
| `LibDiamond` | `keccak256("agentic.space.diamond.storage")` | Proxy, facets, owner, pause |
| `DiamondAccessControl` | `keccak256("agentic.space.diamond.access.storage")` | Roles |
| `AgentStorage` | `keccak256("agentic.space.diamond.agent.storage")` | Agentes |
| `UserStorage` | `keccak256("agentic.space.diamond.user.storage")` | Usuários |
| `DAOStorage` | `keccak256("agentic.space.diamond.dao.storage")` | Propostas e votação |
| `VCStorage` | `keccak256("agentic.space.diamond.vc.storage")` | VC hashes |
| `PaymentStorage` | `keccak256("agentic.space.diamond.payment.storage")` | Taxas e endereços |
| `GasPromotionStorage` | `keccak256("agentic.space.diamond.gaspromotion.storage")` | Promoções de gas |
| `ProjectStorage` | `keccak256("agentic.space.diamond.project.storage")` | Projetos |

## AgentStorage

**Caminho:** `contracts/diamond/storage/AgentStorage.sol`

### Struct `Agent`

| Campo | Tipo | Descrição |
|---|---|---|
| `agentId` | `bytes32` | ID único (`keccak256(didHash, ownerAddress)`) |
| `didHash` | `bytes32` | Hash do DID do usuário |
| `ownerUserId` | `bytes32` | ID do usuário dono |
| `ownerAddress` | `address` | Endereço da carteira |
| `publicId` | `string` | ID público do agente |
| `auid` | `string` | AUID do agente |
| `name` | `string` | Nome |
| `description` | `string` | Descrição |
| `parentPublicId` | `string` | ID público do agente pai |
| `merkleRoot` | `bytes32` | Merkle root dos prompts |
| `promptCount` | `uint256` | Número de prompts |
| `isActive` | `bool` | Ativo ou não |
| `registeredAt` | `uint256` | Timestamp de registro |

### Mappings

- `agents[bytes32] → Agent` — agentId → Agent
- `agentsByOwner[address] → bytes32[]` — owner → agentIds
- `agentByPublicId[string] → bytes32` — publicId → agentId
- `activeAgents[bytes32] → bool` — agentId → active
- `merkleRootHistory[bytes32] → bytes32[]` — agentId → histórico de roots

## UserStorage

**Caminho:** `contracts/diamond/storage/UserStorage.sol`

### Struct `User`

| Campo | Tipo | Descrição |
|---|---|---|
| `userId` | `bytes32` | ID único (`keccak256(didHash, walletAddress)`) |
| `didHash` | `bytes32` | Hash do DID |
| `walletAddress` | `address` | Endereço da carteira |
| `publicIdHash` | `bytes32` | Hash do publicId |
| `isActive` | `bool` | Ativo ou não |
| `registeredAt` | `uint256` | Timestamp de registro |

### Mappings

- `users[bytes32] → User` — userId → User
- `userByAddress[address] → bytes32` — wallet → userId
- `userByPublicIdHash[bytes32] → bytes32` — publicIdHash → userId

## DAOStorage

**Caminho:** `contracts/diamond/storage/DAOStorage.sol`

### Enum `ProposalState`

`Pending → Active → Canceled | Defeated | Succeeded → Queued → Executed | Expired`

### Struct `Proposal`

| Campo | Tipo | Descrição |
|---|---|---|
| `proposalId` | `uint256` | ID da proposta |
| `proposer` | `address` | Endereço do proponente |
| `proposalType` | `uint8` | Tipo da proposta |
| `title` | `string` | Título |
| `description` | `string` | Descrição |
| `data` | `bytes` | Dados para execução |
| `createdAt` | `uint256` | Timestamp de criação |
| `votingDeadline` | `uint256` | Deadline da votação |
| `executedAt` | `uint256` | Timestamp de execução |
| `state` | `ProposalState` | Estado atual |
| `forVotes` | `uint256` | Votos a favor |
| `againstVotes` | `uint256` | Votos contra |
| `abstainVotes` | `uint256` | Abstenções |

### Struct `DAONamespace`

Cada DAO (RoadMap, Agent) tem seu próprio namespace:

- `proposals[uint256] → Proposal`
- `hasVoted[uint256][address] → bool`
- `lastProposalAt[address] → uint256`
- `voteDelegation[address] → address`
- `hasDelegated[address] → bool`
- `proposalCount`, `activeProposalCount`
- `quorumBps`, `votingDuration`, `timelockDelay`, `maxActiveProposals`, `proposalCooldown`

### Namespaces

- `ROADMAP_DAO = keccak256("RoadMapDAO")`
- `AGENT_DAO = keccak256("AgentDAO")`

## VCStorage

**Caminho:** `contracts/diamond/storage/VCStorage.sol`

### Struct `VCRecord`

| Campo | Tipo | Descrição |
|---|---|---|
| `vcId` | `bytes32` | ID do VC |
| `agentId` | `bytes32` | ID do agente |
| `promptHash` | `bytes32` | Hash do prompt |
| `signer` | `address` | Endereço que assinou |
| `walletType` | `bytes32` | Tipo de carteira |
| `isValid` | `bool` | Válido ou revogado |
| `timestamp` | `uint256` | Timestamp da validação |

### Enum `WalletType`

`None, MetaMask, WalletConnect, Coinbase, Custom`

### Mappings

- `records[bytes32] → VCRecord` — vcId → record
- `recordsByAgent[bytes32] → bytes32[]` — agentId → vcIds
- `agentPromptValidated[bytes32][bytes32] → bool` — (agentId, promptHash) → validado
- `supportedWallets[bytes32] → bool` — walletType → suportado

## PaymentStorage

**Caminho:** `contracts/diamond/storage/PaymentStorage.sol`

### Struct `FeeConfig`

| Campo | Tipo | Descrição |
|---|---|---|
| `registrationFee` | `uint256` | Taxa de registro de agente (default: 100 CAS) |
| `validationFee` | `uint256` | Taxa de validação (default: 10 CAS) |
| `daoProposalFee` | `uint256` | Taxa de proposta de DAO (default: 50 CAS) |
| `userRegistrationFee` | `uint256` | Taxa de registro de usuário (default: 1 CAS) |

### Storage

- `casToken` — endereço do CASToken (IERC20)
- `infrastructureFund` — endereço do InfrastructureFund
- `customFees` — valores dos tipos extensíveis (4+)
- `feeTypeExists` — presença de cada tipo extensível
- `registeredFeeTypes` — IDs enumeráveis por `getAllFeeTypes()`; o tipo 6 é o requisito de 50 CAS do certificado

## GasPromotionStorage

**Caminho:** `contracts/diamond/storage/GasPromotionStorage.sol`

### Enum `OperationType`

`USER_REGISTRATION, AGENT_REGISTRATION, USER_DEACTIVATION, AGENT_DEACTIVATION, MERKLE_ROOT_UPDATE`

### Struct `OperationPromotion`

| Campo | Tipo | Descrição |
|---|---|---|
| `isActive` | `bool` | Promoção ativa |
| `budget` | `uint256` | Orçamento total |
| `spent` | `uint256` | Gasto até agora |
| `perUserLimit` | `uint256` | Limite por usuário |
| `startedAt` | `uint256` | Início |
| `endsAt` | `uint256` | Fim |

### Storage

- `globalEnabled` — toggle global
- `promotions[OperationType] → OperationPromotion`
- `userSpending[keccak256(opType, user)] → uint256`
- `relayer` — endereço do relayer autorizado

## ProjectStorage

**Caminho:** `contracts/diamond/storage/ProjectStorage.sol`

### Struct `Project`

| Campo | Tipo | Descrição |
|---|---|---|
| `projectId` | `bytes32` | ID único |
| `did` | `string` | DID do projeto |
| `ownerAddress` | `address` | Owner |
| `publicId` | `string` | ID público |
| `auid` | `string` | AUID |
| `isActive` | `bool` | Ativo |
| `createdAt` | `uint256` | Timestamp |

> [!note] Não implementado
> `ProjectStorage` está definido mas nenhuma facet o utiliza atualmente. Reservado para uso futuro.

## Changelog

| Data | Versão | Descrição |
|---|---|---|
| 2025-07-12 | 0.2.0 | Documentação inicial dos 7 namespaces de Diamond Storage |

![footer](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=100&section=footer&animation=twinkling)
