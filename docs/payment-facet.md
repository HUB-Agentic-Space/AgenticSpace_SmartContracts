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

Facet responsável pela configuração de pagamentos em CAS dentro do Diamond. Gerencia o endereço do CASToken, do InfrastructureFund e o catálogo extensível de taxas/requisitos financeiros exibido pela aplicação.

## Visão Geral

- Usa `PaymentStorage` como namespace de Diamond Storage
- Configura as quatro taxas-base e tipos extensíveis numerados
- Expõe `getAllFeeTypes()` para que interfaces descubram novos tipos sem manter valores fixos no frontend
- `PaymentLib` é usado internamente pelas outras facets para processar pagamentos
- Operações administrativas são restritas ao owner do Diamond
- O tipo 6 representa a reserva de emissão do certificado; ele é catalogado aqui, mas movimentado pelo `RapportCertificate` diretamente para a TBA ERC-6551

## Funções

### Inicialização

```solidity
function initPayment() external
```

Configura as taxas padrão:
- `registrationFee`: 100 CAS (100 * 1e18)
- `validationFee`: 10 CAS (10 * 1e18)
- `daoProposalFee`: 50 CAS (50 * 1e18)
- `userRegistrationFee`: 1 CAS (1 * 1e18)

Também registra os tipos extensíveis 4, 5 e 6. Em upgrade de um Diamond já
inicializado, **não** chame `initPayment()`, porque isso redefine as quatro
taxas-base. Use `registerFeeType(6, 50e18)` ou o script idempotente
`13_register_certificate_fee.ts`.

### Configuração

```solidity
function setCasToken(address casToken) external
function setInfrastructureFund(address fund) external
function updateFees(PaymentStorage.FeeConfig calldata newFees) external
function registerFeeType(uint256 feeType, uint256 amount) external
function setCustomFee(uint256 feeType, uint256 amount) external
```

### Consultas

| Função | Retorno | Descrição |
|---|---|---|
| `getCasToken()` | `address` | Endereço do CASToken |
| `getInfrastructureFund()` | `address` | Endereço do InfrastructureFund |
| `getFees()` | `FeeConfig` | Quatro taxas-base atuais |
| `getCustomFee(uint256)` | `uint256` | Valor de um tipo extensível |
| `isFeeTypeRegistered(uint256)` | `bool` | Existência de um tipo extensível |
| `getAllFeeTypes()` | `(uint256[], uint256[])` | IDs e valores de todos os tipos extensíveis |

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
| `FEE_TYPE_USER_REGISTRATION` | 3 | Registro de usuário |
| `FEE_TYPE_PAUTA_SUBMISSION` | 4 | Envio de pauta comunitária (10 CAS) |
| `FEE_TYPE_VOTING` | 5 | Voto comunitário (50 CAS) |
| `FEE_TYPE_CERTIFICATE_ISSUANCE` | 6 | Emissão/reserva do certificado (50 CAS) |

### Sem cobrança dupla no certificado

O tipo 6 é a configuração oficial usada para exibição e auditoria. Ele não é
passado a `processFeePayment`: a emissão já transfere exatamente 50 CAS para a
conta ERC-6551 vinculada ao NFT. Cobrá-lo também pelo Diamond enviaria outros
50 CAS ao InfrastructureFund e seria uma cobrança duplicada.

## Events

- `CasTokenUpdated(address oldAddress, address newAddress)`
- `InfrastructureFundUpdated(address oldAddress, address newAddress)`
- `FeesUpdated(uint256 registrationFee, uint256 validationFee, uint256 daoProposalFee, uint256 userRegistrationFee)`
- `FeeTypeRegistered(uint256 indexed feeType, uint256 amount)`
- `CustomFeeSet(uint256 indexed feeType, uint256 amount)`

## Dependências

- [[cas-token]] — `CASToken` (IERC20)
- [[infrastructure-fund]] — `InfrastructureFund` (destino das taxas)
- [[access-control]] — `DiamondAccessControl` (`PAYMENT_ADMIN_ROLE`)
- [[storage-namespaces]] — `PaymentStorage`

## Segurança

- Apenas o owner do Diamond pode alterar configurações
- Reverte se CAS token ou InfrastructureFund não configurados
- Transferências usam `SafeERC20`
- Cada valor é limitado a 10.000 CAS

## Changelog

| Data | Versão | Descrição |
|---|---|---|
| 2025-07-12 | 0.2.0 | Documentação inicial da PaymentFacet e PaymentLib |
| 2026-07-17 | 0.3.0 | Catálogo extensível documentado e tipo 6 adicionado para emissão/reserva de certificado (50 CAS), sem cobrança duplicada |

![footer](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=100&section=footer&animation=twinkling)
