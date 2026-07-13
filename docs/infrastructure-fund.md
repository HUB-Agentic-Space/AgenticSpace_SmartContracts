---
tags:
  - smartcontracts
  - token
  - treasury
---

![header](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=200&section=header&text=InfrastructureFund&fontSize=36&fontAlignY=35&animation=twinkling)

![visitors](https://visitor-badge.laobi.icu/badge?page_id=RapportTecnologia.AgenticSpace.smartcontracts_infrastructure-fund)
[![License: CC BY-SA 4.0](https://img.shields.io/badge/License-CC_BY--SA_4.0-blue.svg)](https://creativecommons.org/licenses/by-sa/4.0/)
![Language: Portuguese](https://img.shields.io/badge/Language-Portuguese-brightgreen.svg)
![Status](https://img.shields.io/badge/Status-Ongoing-yellow)
[![GitHub Issues](https://img.shields.io/github/issues/RapportTecnologia/AgenticSpace)](https://github.com/RapportTecnologia/AgenticSpace/issues)

# InfrastructureFund

**Caminho:** `contracts/token/InfrastructureFund.sol`

Treasury do Agentic Space que gerencia receitas em CAS (ERC-20) e POL (nativo). Os fundos são usados para manutenção da infraestrutura e podem ser transferidos para o endereço da Rapport ou do autor.

## Visão Geral

- **Padrão:** UUPS Upgradeable (OpenZeppelin 5.x)
- Gerencia dois ativos: CAS (ERC-20) e POL (nativo)
- Recebe taxas coletadas pelo `PaymentLib` via `CASToken.transferFrom`
- Aceita depósitos diretos de CAS e POL
- `TREASURER_ROLE` pode transferir fundos para Rapport ou autor
- `PAUSER_ROLE` pode pausar depósitos e transferências

## Roles

| Role | Descrição |
|---|---|
| `DEFAULT_ADMIN_ROLE` | Gerencia roles e endereços de Rapport/Autor |
| `TREASURER_ROLE` | Pode transferir fundos |
| `PAUSER_ROLE` | Pode pausar/despausar |

## Funções

### initialize

```solidity
function initialize(
    address admin,
    address casTokenAddress,
    address rapport,
    address author
) public initializer
```

Inicializa o fundo com admin, endereço do CASToken, e endereços de Rapport e Autor.

### Depósitos

```solidity
function depositCas(uint256 amount) external whenNotPaused
function depositNative() external payable whenNotPaused
```

- `depositCas`: transfere CAS do `msg.sender` para o fundo via `safeTransferFrom`
- `depositNative`: aceita POL nativo

### Transferências CAS

```solidity
function transferCasToRapport(uint256 amount) external onlyRole(TREASURER_ROLE) whenNotPaused
function transferCasToAuthor(uint256 amount) external onlyRole(TREASURER_ROLE) whenNotPaused
```

Transfere CAS do fundo para o endereço da Rapport ou do Autor.

### Transferências POL

```solidity
function transferNativeToRapport(uint256 amount) external onlyRole(TREASURER_ROLE) whenNotPaused
function transferNativeToAuthor(uint256 amount) external onlyRole(TREASURER_ROLE) whenNotPaused
```

Transfere POL nativo do fundo para o endereço da Rapport ou do Autor.

### Configuração

```solidity
function setRapportAddress(address newRapport) external onlyRole(DEFAULT_ADMIN_ROLE)
function setAuthorAddress(address newAuthor) external onlyRole(DEFAULT_ADMIN_ROLE)
```

### Consultas

| Função | Retorno | Descrição |
|---|---|---|
| `casBalance()` | `uint256` | Saldo de CAS no fundo |
| `nativeBalance()` | `uint256` | Saldo de POL no fundo |
| `casToken()` | `IERC20` | Endereço do CASToken |
| `rapportAddress()` | `address` | Endereço da Rapport |
| `authorAddress()` | `address` | Endereço do Autor |

### Pausable

```solidity
function pause() external onlyRole(PAUSER_ROLE)
function unpause() external onlyRole(PAUSER_ROLE)
```

### Upgrade

```solidity
function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE)
```

## Events

- `CasReceived(address indexed from, uint256 amount)`
- `NativeReceived(address indexed from, uint256 amount)`
- `CasTransferred(address indexed to, uint256 amount)`
- `NativeTransferred(address indexed to, uint256 amount)`
- `RapportAddressUpdated(address indexed oldAddress, address indexed newAddress)`
- `AuthorAddressUpdated(address indexed oldAddress, address indexed newAddress)`

## Custom Errors

- `TransferToZeroAddress()`
- `InsufficientCasBalance(uint256 available, uint256 required)`
- `InsufficientNativeBalance(uint256 available, uint256 required)`
- `ZeroAmount()`

## Integração com Diamond

O InfrastructureFund é registrado no Diamond via `ContractRegistryFacet.register("InfrastructureFund", 1, address)`. O `PaymentFacet` vincula o endereço via `setInfrastructureFund()`. O `PaymentLib` transfere taxas CAS para este contrato.

## Deploy

```bash
npx hardhat run scripts/deploy/01_deploy_tokens.ts --network polygonAmoy
```

O script inicializa com o deployer como admin, treasurer e pauser. Os endereços de Rapport e Autor podem ser alterados depois via `setRapportAddress()` e `setAuthorAddress()`.

## Dependências

- OpenZeppelin 5.x: `PausableUpgradeable`, `AccessControlEnumerableUpgradeable`, `UUPSUpgradeable`, `SafeERC20`, `IERC20`
- [[cas-token]] — `CASToken` (ERC-20)

## Segurança

- UUPS com `_authorizeUpgrade` restrito a `DEFAULT_ADMIN_ROLE`
- `SafeERC20` para transferências de CAS
- Validação de saldo antes de transferir
- Pausable em depósitos e transferências
- Custom errors para economizar gas

## Changelog

| Data | Versão | Descrição |
|---|---|---|
| 2025-07-12 | 0.2.0 | Documentação inicial do InfrastructureFund como contrato standalone UUPS |

![footer](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=100&section=footer&animation=twinkling)
