---
tags:
  - smartcontracts
  - facet
  - payment
---

![header](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=200&section=header&text=PaymentFacet&fontSize=36&fontAlignY=35&animation=twinkling)

![visitors](https://visitor-badge.laobi.icu/badge?page_id=RapportTecnologia.AgenticSpace.smartcontracts_payment-facet)
[![License: CC BY-SA 4.0](https://img.shields.io/badge/License-CC_BY--SA_4.0-blue.svg)](https://creativecommons.org/licenses/by-sa/4.0/)
![Language: Portuguese](https://img.shields.io/badge/Language-Portuguese-brightgreen.svg)
![Status](https://img.shields.io/badge/Status-Ongoing-yellow)
[![GitHub Issues](https://img.shields.io/github/issues/RapportTecnologia/AgenticSpace)](https://github.com/RapportTecnologia/AgenticSpace/issues)

# PaymentFacet

**Caminho:** `contracts/facets/PaymentFacet.sol`

Facet responsável pela configuração de pagamentos em CAS dentro do Diamond. Gerencia o endereço do CASToken, do InfrastructureFund e a tabela de taxas.

## Visão Geral

- Usa `PaymentStorage` como namespace de Diamond Storage
- Configura taxas para registro, validação e propostas de DAO
- `PaymentLib` é usado internamente pelas outras facets para processar pagamentos
- Requer `PAYMENT_ADMIN_ROLE` para configuração

## Funções

### Inicialização

```solidity
function initPayment() external
```

Configura as taxas padrão:
- `registrationFee`: 100 CAS (100 * 1e18)
- `validationFee`: 10 CAS (10 * 1e18)
- `daoProposalFee`: 50 CAS (50 * 1e18)

### Configuração

```solidity
function setCasToken(address casToken) external onlyRole(PAYMENT_ADMIN_ROLE)
function setInfrastructureFund(address fund) external onlyRole(PAYMENT_ADMIN_ROLE)
function updateFees(
    uint256 registrationFee,
    uint256 validationFee,
    uint256 daoProposalFee
) external onlyRole(PAYMENT_ADMIN_ROLE)
```

### Consultas

| Função | Retorno | Descrição |
|---|---|---|
| `getCasToken()` | `address` | Endereço do CASToken |
| `getInfrastructureFund()` | `address` | Endereço do InfrastructureFund |
| `getFees()` | `(uint256, uint256, uint256)` | Taxas atuais (reg, val, dao) |
| `getRegistrationFee()` | `uint256` | Taxa de registro |
| `getValidationFee()` | `uint256` | Taxa de validação |
| `getDaoProposalFee()` | `uint256` | Taxa de proposta de DAO |

## PaymentLib

**Caminho:** `contracts/libs/PaymentLib.sol`

Biblioteca interna usada por `AgentRegistryFacet`, `AgentValidatorFacet` e as DAOs para processar pagamentos.

```solidity
function processFeePayment(address payer, uint256 feeType) internal returns (uint256 amount)
```

- Transfere CAS do `payer` para o `InfrastructureFund` via `transferFrom`
- Reverte se CAS token ou InfrastructureFund não estiverem configurados
- Reverte se a transferência falhar

### Fee Types

| Constante | Valor | Descrição |
|---|---|---|
| `FEE_TYPE_REGISTRATION` | 0 | Registro de agente |
| `FEE_TYPE_VALIDATION` | 1 | Validação de agente |
| `FEE_TYPE_DAO_PROPOSAL` | 2 | Proposta de DAO |

## Events

- `CasTokenUpdated(address oldAddress, address newAddress)`
- `InfrastructureFundUpdated(address oldAddress, address newAddress)`
- `FeesUpdated(uint256 registrationFee, uint256 validationFee, uint256 daoProposalFee)`

## Dependências

- [[cas-token]] — `CASToken` (IERC20)
- [[infrastructure-fund]] — `InfrastructureFund` (destino das taxas)
- [[access-control]] — `DiamondAccessControl` (`PAYMENT_ADMIN_ROLE`)
- [[storage-namespaces]] — `PaymentStorage`

## Segurança

- Apenas `PAYMENT_ADMIN_ROLE` pode alterar configurações
- Reverte se CAS token ou InfrastructureFund não configurados
- `transferFrom` com verificação de sucesso

## Changelog

| Data | Versão | Descrição |
|---|---|---|
| 2025-07-12 | 0.2.0 | Documentação inicial da PaymentFacet e PaymentLib |

![footer](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=100&section=footer&animation=twinkling)
