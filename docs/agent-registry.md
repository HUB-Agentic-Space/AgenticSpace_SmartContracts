---
tags:
  - smartcontracts
  - facet
  - agent-registry
---

![header](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=200&section=header&text=AgentRegistryFacet&fontSize=36&fontAlignY=35&animation=twinkling)

![visitors](https://visitor-badge.laobi.icu/badge?page_id=RapportTecnologia.AgenticSpace.smartcontracts_agent-registry)
[![License: CC BY-SA 4.0](https://img.shields.io/badge/License-CC_BY--SA_4.0-blue.svg)](https://creativecommons.org/licenses/by-sa/4.0/)
![Language: Portuguese](https://img.shields.io/badge/Language-Portuguese-brightgreen.svg)
![Status](https://img.shields.io/badge/Status-Ongoing-yellow)
[![GitHub Issues](https://img.shields.io/github/issues/RapportTecnologia/AgenticSpace)](https://github.com/RapportTecnologia/AgenticSpace/issues)

# AgentRegistryFacet

**Caminho:** `contracts/facets/AgentRegistryFacet.sol`

Facet responsável pelo registro único de agentes no Diamond. Cada agente é identificado por um `agentId` único, calculado a partir do hash do DID do usuário e do endereço do owner.

## Visão Geral

- Armazena apenas hashes na blockchain — o DID original nunca é persistido on-chain
- `agentId = keccak256(didHash, ownerAddress)` via `AgentHashLib.computeAgentId()`
- Suporta Merkle roots para verificação de prompts off-chain
- Requer que o usuário esteja registrado e ativo no `UserRegistryFacet`
- Requer pagamento de taxa CAS via `PaymentLib`
- Usa `AgentStorage` como namespace de Diamond Storage

## Estrutura de Dados

Ver [[storage-namespaces#AgentStorage]] para detalhes completos.

## Funções

### Registro

```solidity
function registerAgent(
    bytes32 didHash,
    string calldata publicId,
    string calldata auid,
    string calldata name,
    string calldata description,
    string calldata parentPublicId,
    bytes32 merkleRoot,
    uint256 promptCount
) external whenNotPaused
```

Registra um novo agente.

**Pré-requisitos:**
- Usuário do `msg.sender` deve estar registrado e ativo no `UserRegistryFacet`
- `didHash != bytes32(0)`
- `publicId` deve ser único
- `msg.sender` deve ter aprovado o CASToken para o Diamond (fee)

**Processamento:**
1. Calcula `userId` e verifica se usuário está ativo
2. Calcula `agentId = keccak256(didHash, msg.sender)`
3. Verifica que `agentId` não existe
4. Processa taxa CAS via `PaymentLib.processFeePayment(msg.sender, FEE_TYPE_REGISTRATION)`
5. Cria o `Agent` no storage
6. Concede `AGENT_ROLE` ao `msg.sender`
7. Emite `AgentRegistered`

### Atualização

```solidity
function updateAgent(
    bytes32 agentId,
    string calldata name,
    string calldata description
) external whenNotPaused
```

Atualiza nome e descrição. Apenas o owner do agente pode chamar.

### Atualização de Merkle Root

```solidity
function updateMerkleRoot(
    bytes32 agentId,
    bytes32 newRoot,
    uint256 promptCount
) external whenNotPaused
```

Atualiza o Merkle root dos prompts do agente. O root anterior é preservado no `merkleRootHistory`.

- Apenas o owner do agente pode chamar
- Emite `MerkleRootUpdated(agentId, oldRoot, newRoot)`

### Verificação de Prompt

```solidity
function verifyPrompt(
    bytes32 agentId,
    bytes32 leaf,
    bytes32[] calldata proof
) external view returns (bool)
```

Verifica se um `leaf` (hash de prompt com metadata) pertence ao Merkle root atual do agente, usando `MerkleLib.verify()`.

### Desativação / Reativação

```solidity
function deactivateAgent(bytes32 agentId) external whenNotPaused
function reactivateAgent(bytes32 agentId) external whenNotPaused
```

- `deactivateAgent`: marca `isActive = false`, revoga `AGENT_ROLE`
- `reactivateAgent`: marca `isActive = true`, concede `AGENT_ROLE`
- Apenas o owner do agente pode chamar

### Consultas

| Função | Retorno | Descrição |
|---|---|---|
| `getAgent(bytes32 agentId)` | `(Agent)` | Retorna dados completos |
| `getAgentByPublicId(string publicId)` | `(Agent)` | Busca por publicId |
| `getAgentsByOwner(address owner)` | `bytes32[]` | Lista de agentIds |
| `isAgentActive(bytes32 agentId)` | `bool` | Verifica se ativo |
| `getAgentCount()` | `uint256` | Total de agentes |
| `getActiveAgentCount()` | `uint256` | Total ativos |
| `getMerkleRootHistory(bytes32 agentId)` | `bytes32[]` | Histórico de roots |

## Events

- `AgentRegistered(bytes32 indexed agentId, bytes32 indexed didHash, address indexed owner, string publicId, string auid, bytes32 merkleRoot)`
- `AgentUpdated(bytes32 indexed agentId, string name, string description)`
- `AgentDeactivated(bytes32 indexed agentId, address indexed by)`
- `AgentReactivated(bytes32 indexed agentId, address indexed by)`
- `MerkleRootUpdated(bytes32 indexed agentId, bytes32 oldRoot, bytes32 newRoot)`

## Taxas CAS

| Operação | Fee Type | Taxa Padrão |
|---|---|---|
| `registerAgent` | `FEE_TYPE_REGISTRATION` (0) | 100 CAS |
| `updateMerkleRoot` | — | Grátis (apenas owner) |

> [!warning] Aprovação prévia
> O pagador deve aprovar o CASToken para o Diamond antes de chamar `registerAgent`. Use `CASToken.approve(diamondAddress, fee)`.

## Dependências

- [[user-registry]] — `UserRegistryFacet` (verifica usuário ativo)
- [[payment-facet]] — `PaymentLib` (processa taxa CAS)
- [[libs]] — `AgentHashLib`, `MerkleLib`
- [[access-control]] — `DiamondAccessControl` (concede `AGENT_ROLE`)
- [[storage-namespaces]] — `AgentStorage`

## Segurança

- `whenNotPaused` em todas as funções de mutação
- Validação de usuário ativo antes do registro
- Prevenção de registro duplicado (agentId único)
- Verificação de ownership em update, deactivate, reactivate
- Merkle proof verification via `MerkleLib.verify()`
- Taxa CAS obrigatória em `registerAgent`

## Changelog

| Data | Versão | Descrição |
|---|---|---|
| 2025-07-12 | 0.2.0 | Reescrita completa: facet com Merkle roots, UserRegistry, PaymentLib |
| 2025-07-11 | 0.1.0 | Documentação inicial do AgentRegistry standalone |

![footer](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=100&section=footer&animation=twinkling)
