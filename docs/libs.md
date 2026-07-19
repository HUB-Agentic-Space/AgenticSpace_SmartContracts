---
tags:
  - smartcontracts
  - libs
---

![header](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=200&section=header&text=Bibliotecas&fontSize=36&fontAlignY=35&animation=twinkling)

![visitors](https://visitor-badge.laobi.icu/badge?page_id=RapportTecnologia.AgenticSpace.smartcontracts_libs)
[![License: CC BY-SA 4.0](https://img.shields.io/badge/License-CC_BY--SA_4.0-blue.svg)](https://creativecommons.org/licenses/by-sa/4.0/)
![Language: Portuguese](https://img.shields.io/badge/Language-Portuguese-brightgreen.svg)
![Status](https://img.shields.io/badge/Status-Ongoing-yellow)
[![GitHub Issues](https://img.shields.io/github/issues/RapportTecnologia/AgenticSpace)](https://github.com/RapportTecnologia/AgenticSpace/issues)

# Bibliotecas

Bibliotecas reutilizáveis usadas pelas facets do Diamond e pelos contratos standalone.

## AgentHashLib

**Caminho:** `contracts/libs/AgentHashLib.sol`

Centraliza a lógica de hash para garantir consistência entre facets.

| Função | Descrição |
|---|---|
| `computeAgentId(bytes32 didHash, address ownerAddress)` | `keccak256(didHash, ownerAddress)` |
| `computeUserId(bytes32 didHash, address walletAddress)` | `keccak256(didHash, walletAddress)` |
| `computeValidationId(bytes32 agentId, bytes32 promptHash, uint256 timestamp)` | `keccak256(agentId, promptHash, timestamp)` |
| `computePromptHash(string content)` | `keccak256(content)` |
| `computePromptHashFromBytes(bytes content)` | `keccak256(content)` |
| `stringsEqual(string a, string b)` | Compara strings via hash |

## MerkleLib

**Caminho:** `contracts/libs/MerkleLib.sol`

Verificação de Merkle tree (binary tree, sorted pairs). Usada pelo `AgentRegistryFacet` para verificar que um prompt hash pertence ao Merkle root de um agente sem armazenar todos os hashes on-chain.

| Função | Descrição |
|---|---|
| `verify(bytes32 root, bytes32 leaf, bytes32[] proof)` | Verifica proof contra root |
| `parent(bytes32 left, bytes32 right)` | Calcula nó pai (sorted) |
| `computeLeaf(string promptName, uint8 promptType, bytes32 contentHash)` | Calcula leaf hash com metadata |

> [!info] Leaf hash
> O leaf inclui: `promptName`, `promptType` (0=immutable, 1=secondary), e `contentHash`. Nunca inclui API keys ou conteúdo privado.

## PaymentLib

**Caminho:** `contracts/libs/PaymentLib.sol`

Processamento interno de taxas CAS. Usado por `AgentRegistryFacet`, `AgentValidatorFacet` e as DAOs.

| Função | Descrição |
|---|---|
| `processFeePayment(address payer, uint256 feeType)` | Transfere CAS do payer para o InfrastructureFund |
| `defaultFees()` | Retorna as quatro taxas-base (100, 10, 50 e 1 CAS) |
| `initDefaultCustomFees()` | Registra os tipos extensíveis 4, 5 e 6 |

### Fee Types

| Constante | Valor | Descrição |
|---|---|---|
| `FEE_TYPE_REGISTRATION` | 0 | Registro de agente |
| `FEE_TYPE_VALIDATION` | 1 | Validação de agente |
| `FEE_TYPE_DAO_PROPOSAL` | 2 | Proposta de DAO |
| `FEE_TYPE_USER_REGISTRATION` | 3 | Registro de usuário |
| `FEE_TYPE_PAUTA_SUBMISSION` | 4 | Envio de pauta comunitária |
| `FEE_TYPE_VOTING` | 5 | Voto comunitário |
| `FEE_TYPE_CERTIFICATE_ISSUANCE` | 6 | Emissão/reserva do certificado (50 CAS na TBA; não processar novamente para o fundo) |

### Custom Errors

- `CasTokenNotSet()`
- `InfrastructureFundNotSet()`
- `FeeTransferFailed()`

## VotingLib

**Caminho:** `contracts/libs/VotingLib.sol`

Lógica de votação reutilizável pelas DAOs (`AgentDAOFacet`, `RoadMapDAOFacet`).

| Função | Descrição |
|---|---|
| `recordVote(VoteTally tally, uint8 support, uint256 weight)` | Registra voto no tally |
| `isQuorumReached(uint256 totalVotes, uint256 quorumPercent, uint256 totalEligible)` | Verifica quorum (basis points) |
| `isApproved(uint256 forVotes, uint256 againstVotes)` | Aprovação por maioria simples |
| `isApprovedQualified(uint256 forVotes, uint256 againstVotes, uint256 thresholdPercent)` | Aprovação por maioria qualificada |
| `daysToSeconds(uint256 days_)` | Converte dias para segundos |
| `isVotingExpired(uint256 deadline)` | Verifica se votação expirou |

### Struct `VoteTally`

| Campo | Tipo | Descrição |
|---|---|---|
| `forVotes` | `uint256` | Votos a favor |
| `againstVotes` | `uint256` | Votos contra |
| `abstainVotes` | `uint256` | Abstenções |
| `totalVotes` | `uint256` | Total |

## Changelog

| Data | Versão | Descrição |
|---|---|---|
| 2025-07-12 | 0.2.0 | Documentação inicial das bibliotecas (AgentHashLib, MerkleLib, PaymentLib, VotingLib) |

![footer](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=100&section=footer&animation=twinkling)
