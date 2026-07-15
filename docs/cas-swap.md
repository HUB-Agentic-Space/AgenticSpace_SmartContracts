---
tags:
  - smartcontracts
  - token
  - swap
  - dex
---

![header](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=200&section=header&text=CASSwap&fontSize=36&fontAlignY=35&animation=twinkling)

![visitors](https://visitor-badge.laobi.icu/badge?page_id=RapportTecnologia.AgenticSpace.smartcontracts_cas-swap)
[![License: CC BY-SA 4.0](https://img.shields.io/badge/License-CC_BY--SA_4.0-blue.svg)](https://creativecommons.org/licenses/by-sa/4.0/)
![Language: Portuguese](https://img.shields.io/badge/Language-Portuguese-brightgreen.svg)
![Status](https://img.shields.io/badge/Status-Ongoing-yellow)

# CASSwap

**Caminho:** `contracts/token/CASSwap.sol`

Contrato de swap entre CAS e POL (nativo). Permite que usuários comprem CAS com POL e vendam CAS por POL, com ratio flexível controlado por `RATIO_ADMIN_ROLE`.

## Visão Geral

- **Padrão:** UUPS Upgradeable (OpenZeppelin 5.x)
- **Swap:** CAS ↔ POL (nativo)
- **Ratio inicial:** 1:1 (1 POL = 1 CAS)
- **Ratio flexível:** `RATIO_ADMIN_ROLE` pode ajustar numerator/denominator livremente (desde que > 0)
- **Swap fee:** Configurável em basis points (0–10000 = 0%–100%)
- **Reentrancy guard:** Manual via storage slot lock
- **Pausable:** `PAUSER_ROLE` pode pausar swaps

## Roles

| Role | Descrição |
|---|---|
| `DEFAULT_ADMIN_ROLE` | Gerencia roles, autoriza upgrades, define swap fee |
| `RATIO_ADMIN_ROLE` | Pode ajustar a ratio (numerator/denominator) |
| `PAUSER_ROLE` | Pode pausar/despausar |
| `TREASURER_ROLE` | Pode sacar excesso de POL para InfrastructureFund |

## Funções

### initialize

```solidity
function initialize(
    address admin,
    address casTokenAddress,
    address infrastructureFundAddress
) public initializer
```

Inicializa o swap com admin, CASToken e InfrastructureFund. Ratio padrão: 1:1, fee: 0.

### buyCAS

```solidity
function buyCAS() external payable whenNotPaused nonReentrant
```

Compra CAS com POL nativo. Calcula: `casAmount = (msg.value * ratioNumerator) / ratioDenominator`. Deduz fee se configurado. Transfere CAS do contrato para o comprador.

### sellCAS

```solidity
function sellCAS(uint256 casAmount) external whenNotPaused nonReentrant
```

Vende CAS por POL. Calcula: `polAmount = (casAmount * ratioDenominator) / ratioNumerator`. Deduz fee se configurado. Transfere POL do contrato para o vendedor.

### setRatio

```solidity
function setRatio(uint256 numerator, uint256 denominator) external onlyRole(RATIO_ADMIN_ROLE)
```

Define a ratio de swap. Ambos numerator e denominator devem ser > 0. Não há limite de range — a ratio pode ser qualquer valor positivo.

### setSwapFee

```solidity
function setSwapFee(uint256 feeBps) external onlyRole(DEFAULT_ADMIN_ROLE)
```

Define a taxa de swap em basis points (0–10000). `feeBps = 100` = 1%.

### depositCAS

```solidity
function depositCAS(uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE)
```

Deposita CAS no contrato para aumentar a reserva de swap. Requer aprovação prévia do CASToken.

### withdrawPOL

```solidity
function withdrawPOL(uint256 amount) external onlyRole(TREASURER_ROLE)
```

Saca excesso de POL do contrato e envia para o InfrastructureFund. Útil para mover POL acumulado para o treasury.

### Pausable

```solidity
function pause() external onlyRole(PAUSER_ROLE)
function unpause() external onlyRole(PAUSER_ROLE)
```

### Consultas

| Função | Retorno | Descrição |
|---|---|---|
| `getRatio()` | `(uint256, uint256)` | Retorna (numerator, denominator) |
| `casReserve()` | `uint256` | Saldo de CAS no contrato |
| `polReserve()` | `uint256` | Saldo de POL no contrato |
| `swapFeeBps()` | `uint256` | Fee atual em basis points |

## Events

- `BoughtCAS(address indexed buyer, uint256 polSent, uint256 casReceived)`
- `SoldCAS(address indexed seller, uint256 casSent, uint256 polReceived)`
- `RatioUpdated(uint256 numerator, uint256 denominator)`
- `SwapFeeUpdated(uint256 feeBps)`
- `CASDeposited(address indexed depositor, uint256 amount)`
- `POLWithdrawn(address indexed treasurer, uint256 amount)`

## Custom Errors

- `ZeroAmount()`
- `ZeroAddress()`
- `InsufficientCASBalance()`
- `InsufficientPOLBalance()`
- `InvalidFeeBps()`
- `ZeroNumerator()`
- `ZeroDenominator()`
- `ReentrancyGuarded()`

## Integração

- O CASSwap é registrado no Diamond via `ContractRegistryFacet.register("CASSwap", 1, address)`
- O POL recebido em swaps fica no contrato para liquidez de venda
- Excesso de POL pode ser movido para InfrastructureFund via `withdrawPOL`
- A ratio é ajustável on-chain por `RATIO_ADMIN_ROLE` sem necessidade de upgrade

## Deploy

```bash
npx hardhat run scripts/deploy/03_deploy_cas_swap.ts --network polygonAmoy
```

O script:
1. Deploy do CASSwap (UUPS proxy)
2. Initialize com admin, CASToken e InfrastructureFund
3. Deposita 500.000 CAS como reserva inicial
4. Registra no ContractRegistry do Diamond

## Segurança

- UUPS com `_authorizeUpgrade` restrito a `DEFAULT_ADMIN_ROLE`
- Reentrancy guard manual via storage slot
- Pausable em todas as operações de swap
- Validação de input em todas as funções external
- SafeERC20 para transferências de CAS
- POL transferido via `call` com verificação de sucesso

## Changelog

| Data | Versão | Descrição |
|---|---|---|
| 2025-07-12 | 0.1.0 | Documentação inicial do CASSwap com ratio flexível |

![footer](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=100&section=footer&animation=twinkling)
