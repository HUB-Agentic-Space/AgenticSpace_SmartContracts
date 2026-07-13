---
tags:
  - smartcontracts
  - facet
  - gas-promotion
---

![header](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=200&section=header&text=GasPromotionFacet&fontSize=36&fontAlignY=35&animation=twinkling)

![visitors](https://visitor-badge.laobi.icu/badge?page_id=RapportTecnologia.AgenticSpace.smartcontracts_gas-promotion)
[![License: CC BY-SA 4.0](https://img.shields.io/badge/License-CC_BY--SA_4.0-blue.svg)](https://creativecommons.org/licenses/by-sa/4.0/)
![Language: Portuguese](https://img.shields.io/badge/Language-Portuguese-brightgreen.svg)
![Status](https://img.shields.io/badge/Status-Ongoing-yellow)
[![GitHub Issues](https://img.shields.io/github/issues/RapportTecnologia/AgenticSpace)](https://github.com/RapportTecnologia/AgenticSpace/issues)

# GasPromotionFacet

**Caminho:** `contracts/facets/GasPromotionFacet.sol`

Facet responsável por gerenciar promoções de patrocínio de gas. Permite que o Agentic Space cubra os custos de gas de operações específicas (ex: registro de usuários) durante períodos promocionais.

## Visão Geral

- Usa `GasPromotionStorage` como namespace de Diamond Storage
- O backend relayer pode verificar on-chain se uma operação é patrocinada antes de submeter a meta-transação
- Promoções podem ser globais (toggle) ou por operação
- Orçamento total e limite por usuário
- Requer `GAS_PROMOTION_ADMIN_ROLE` para configuração

## Operation Types

| Enum | Valor | Descrição |
|---|---|---|
| `USER_REGISTRATION` | 0 | Registro de usuário |
| `AGENT_REGISTRATION` | 1 | Registro de agente |
| `USER_DEACTIVATION` | 2 | Desativação de usuário |
| `AGENT_DEACTIVATION` | 3 | Desativação de agente |
| `MERKLE_ROOT_UPDATE` | 4 | Atualização de Merkle root |

## Funções

### Inicialização

```solidity
function initGasPromotion() external
```

Inicializa com promoções desativadas (`globalEnabled = false`).

### Toggle Global

```solidity
function setGlobalEnabled(bool enabled) external onlyRole(GAS_PROMOTION_ADMIN_ROLE)
```

Ativa ou desativa todas as promoções globalmente.

### Configuração por Operação

```solidity
function setOperationPromotion(
    OperationType opType,
    bool isActive,
    uint256 budget,
    uint256 perUserLimit,
    uint256 endsAt
) external onlyRole(GAS_PROMOTION_ADMIN_ROLE)
```

Configura a promoção para uma operação específica.

### Relayer

```solidity
function setRelayer(address relayer) external onlyRole(GAS_PROMOTION_ADMIN_ROLE)
```

Define o endereço do relayer autorizado a registrar gastos de gas.

### Registro de Gastos

```solidity
function recordGasSpent(
    OperationType opType,
    address user,
    uint256 amount
) external onlyRole(GAS_PROMOTION_ADMIN_ROLE)
```

Registra quanto gas foi gasto para um usuário em uma operação. Atualiza `spent` e `userSpending`.

### Consultas

| Função | Retorno | Descrição |
|---|---|---|
| `isGlobalEnabled()` | `bool` | Promoções ativas globalmente |
| `isOperationPromoted(OperationType)` | `bool` | Operação específica patrocinada |
| `getPromotion(OperationType)` | `(OperationPromotion)` | Configuração completa |
| `getUserSpending(OperationType, address)` | `uint256` | Gasto do usuário |
| `getRelayer()` | `address` | Endereço do relayer |

## Struct `OperationPromotion`

| Campo | Tipo | Descrição |
|---|---|---|
| `isActive` | `bool` | Promoção ativa |
| `budget` | `uint256` | Orçamento total |
| `spent` | `uint256` | Gasto até agora |
| `perUserLimit` | `uint256` | Limite por usuário |
| `startedAt` | `uint256` | Início |
| `endsAt` | `uint256` | Fim |

## Events

- `GlobalEnabledChanged(bool enabled)`
- `PromotionUpdated(OperationType opType, bool isActive, uint256 budget, uint256 perUserLimit)`
- `GasSpent(OperationType opType, address user, uint256 amount)`
- `RelayerUpdated(address oldRelayer, address newRelayer)`

## Dependências

- [[access-control]] — `DiamondAccessControl` (`GAS_PROMOTION_ADMIN_ROLE`)
- [[storage-namespaces]] — `GasPromotionStorage`

## Segurança

- Apenas `GAS_PROMOTION_ADMIN_ROLE` pode configurar
- Verificação de orçamento e limite por usuário
- Relayer autorizado separadamente

## Changelog

| Data | Versão | Descrição |
|---|---|---|
| 2025-07-12 | 0.2.0 | Documentação inicial da GasPromotionFacet |

![footer](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=100&section=footer&animation=twinkling)
