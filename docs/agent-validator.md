---
tags:
  - smartcontracts
  - facet
  - agent-validator
---

![header](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=200&section=header&text=AgentValidatorFacet&fontSize=36&fontAlignY=35&animation=twinkling)

![visitors](https://visitor-badge.laobi.icu/badge?page_id=RapportTecnologia.AgenticSpace.smartcontracts_agent-validator)
[![License: CC BY-SA 4.0](https://img.shields.io/badge/License-CC_BY--SA_4.0-blue.svg)](https://creativecommons.org/licenses/by-sa/4.0/)
![Language: Portuguese](https://img.shields.io/badge/Language-Portuguese-brightgreen.svg)
![Status](https://img.shields.io/badge/Status-Ongoing-yellow)
[![GitHub Issues](https://img.shields.io/github/issues/RapportTecnologia/AgenticSpace)](https://github.com/RapportTecnologia/AgenticSpace/issues)

# AgentValidatorFacet

**Caminho:** `contracts/facets/AgentValidatorFacet.sol`

Facet responsável pela validação de Verifiable Credential (VC) hashes de agentes. Apenas o hash é armazenado on-chain — o conteúdo completo do VC fica no banco de dados do Agentic Space.

## Visão Geral

- Armazena VC hashes vinculados a agentes e prompts
- Suporta múltiplos tipos de carteira (MetaMask, WalletConnect, Coinbase, Custom)
- Calcula `validationId = keccak256(agentId, promptHash, timestamp)` via `AgentHashLib`
- Requer pagamento de taxa CAS via `PaymentLib`
- Usa `VCStorage` como namespace de Diamond Storage

## Estrutura de Dados

Ver [[storage-namespaces#VCStorage]] para detalhes completos.

## Funções

### Inicialização

```solidity
function initValidator() external
```

Inicializa a facet adicionando MetaMask como wallet type suportado. Chamada uma única vez durante o deploy.

### Validação

```solidity
function validateAgent(
    bytes32 agentId,
    bytes32 promptHash,
    bytes32 walletType
) external whenNotPaused returns (bytes32 validationId)
```

Valida um VC hash para um agente.

**Pré-requisitos:**
- Agente deve estar ativo no `AgentRegistryFacet`
- `walletType` deve ser suportado
- O par `(agentId, promptHash)` não deve ter sido validado antes
- `msg.sender` deve ter aprovado o CASToken para o Diamond (fee)

**Processamento:**
1. Verifica se agente está ativo
2. Verifica se wallet type é suportado
3. Verifica se já não foi validado
4. Processa taxa CAS via `PaymentLib.processFeePayment(msg.sender, FEE_TYPE_VALIDATION)`
5. Calcula `validationId = keccak256(agentId, promptHash, block.timestamp)`
6. Cria `VCRecord` no storage
7. Marca `agentPromptValidated[agentId][promptHash] = true`
8. Emite `AgentValidated`

### Revogação

```solidity
function revokeValidation(bytes32 validationId) external onlyRole(VALIDATOR_ROLE) whenNotPaused
```

Marca uma validação como inválida (`isValid = false`).

### Gestão de Wallet Types

```solidity
function addSupportedWallet(bytes32 walletType) external onlyRole(VALIDATOR_ROLE) whenNotPaused
function removeSupportedWallet(bytes32 walletType) external onlyRole(VALIDATOR_ROLE) whenNotPaused
function isWalletSupported(bytes32 walletType) external view returns (bool)
```

Permite adicionar e remover tipos de carteira suportados. Inicialmente apenas MetaMask é suportado.

### Consultas

| Função | Retorno | Descrição |
|---|---|---|
| `isValidated(bytes32 agentId, bytes32 promptHash)` | `bool` | Verifica se prompt foi validado |
| `getValidation(bytes32 validationId)` | `(VCRecord)` | Retorna registro completo |
| `getValidationsByAgent(bytes32 agentId)` | `bytes32[]` | Lista de validationIds |
| `getValidationCount()` | `uint256` | Total de validações |

## Events

- `AgentValidated(bytes32 indexed validationId, bytes32 indexed agentId, bytes32 indexed promptHash, address signer, bytes32 walletType)`
- `ValidationRevoked(bytes32 indexed validationId, address indexed revoker)`
- `WalletSupported(bytes32 indexed walletType, bool supported)`

## Taxas CAS

| Operação | Fee Type | Taxa Padrão |
|---|---|---|
| `validateAgent` | `FEE_TYPE_VALIDATION` (1) | 10 CAS |

> [!warning] Aprovação prévia
> O pagador deve aprovar o CASToken para o Diamond antes de chamar `validateAgent`.

## Wallet Types

| Enum | Valor | Descrição |
|---|---|---|
| `None` | 0 | Não usado |
| `MetaMask` | 1 | Carteira MetaMask (padrão) |
| `WalletConnect` | 2 | WalletConnect |
| `Coinbase` | 3 | Coinbase Wallet |
| `Custom` | 4 | Carteira customizada |

## Dependências

- [[agent-registry]] — `AgentRegistryFacet` (verifica agente ativo)
- [[payment-facet]] — `PaymentLib` (processa taxa CAS)
- [[libs]] — `AgentHashLib` (cálculo de validationId)
- [[access-control]] — `DiamondAccessControl` (`VALIDATOR_ROLE`)
- [[storage-namespaces]] — `VCStorage`

## Segurança

- `whenNotPaused` em todas as funções de mutação
- Apenas `VALIDATOR_ROLE` pode validar e revogar
- Não permite validação duplicada (mesmo agente + mesmo prompt)
- Verificação de wallet type suportado
- Taxa CAS obrigatória em `validateAgent`

## Changelog

| Data | Versão | Descrição |
|---|---|---|
| 2025-07-12 | 0.2.0 | Reescrita completa: facet com VCStorage, wallet types, PaymentLib |
| 2025-07-11 | 0.1.0 | Documentação inicial do AgentValidator standalone |

![footer](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=100&section=footer&animation=twinkling)
