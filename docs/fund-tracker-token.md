---
tags:
  - smartcontracts
  - token
  - fund-tracker
---

![header](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=200&section=header&text=FundTrackerToken&fontSize=36&fontAlignY=35&animation=twinkling)

![visitors](https://visitor-badge.laobi.icu/badge?page_id=RapportTecnologia.AgenticSpace.smartcontracts_fund-tracker-token)
[![License: CC BY-SA 4.0](https://img.shields.io/badge/License-CC_BY--SA_4.0-blue.svg)](https://creativecommons.org/licenses/by-sa/4.0/)
![Language: Portuguese](https://img.shields.io/badge/Language-Portuguese-brightgreen.svg)
![Status](https://img.shields.io/badge/Status-Ongoing-yellow)
[![GitHub Issues](https://img.shields.io/github/issues/RapportTecnologia/AgenticSpace)](https://github.com/RapportTecnologia/AgenticSpace/issues)

# FundTrackerToken

**Caminho:** `contracts/token/FundTrackerToken.sol`

ERC-20 que espelha o saldo de um ativo (CAS ou POL) custodiado pelo `InfrastructureFund`. O `totalSupply` e o `balanceOf` do admin refletem dinamicamente o saldo do fundo — sem mint/burn.

## Visão Geral

- **Padrão:** ERC-20 + Ownable (não upgradeable)
- **Não transferível:** `transfer()`, `approve()`, `transferFrom()` sempre revertem
- Duas instâncias deployadas:
  - **CAS Tracker** — `assetType = 0`, symbol `aCAS`, name "Agentic CAS Fund"
  - **POL Tracker** — `assetType = 1`, symbol `aPOL`, name "Agentic POL Fund"
- O admin (owner) vê o saldo do fundo no MetaMask como se fosse um token na carteira
- Outros endereços têm saldo 0

## Padrões de Projeto

- **Adapter (GoF):** Adapta o `InfrastructureFund` para a interface ERC-20
- **Strategy (GoF):** CAS vs POL via `assetType`

## Constructor

```solidity
constructor(
    address fundAddress,
    uint8 _assetType,
    string memory name,
    string memory symbol,
    address admin
) ERC20(name, symbol) Ownable(admin)
```

- `fundAddress`: endereço do `InfrastructureFund`
- `_assetType`: 0 = CAS, 1 = POL
- `admin`: endereço que verá o saldo no MetaMask

## Funções Overridden

### totalSupply

```solidity
function totalSupply() public view override returns (uint256)
```

Retorna `fund.casBalance()` (CAS tracker) ou `fund.nativeBalance()` (POL tracker).

### balanceOf

```solidity
function balanceOf(address account) public view override returns (uint256)
```

Se `account == owner()`, retorna `totalSupply()`. Caso contrário, retorna 0.

### transferOwnership

```solidity
function transferOwnership(address newOwner) public override onlyOwner
```

Transfere a "propriedade" do tracker. O novo owner passa a ver o saldo no MetaMask. Não afeta o `InfrastructureFund`.

### Funções Desativadas

```solidity
function transfer(address, uint256) public pure override returns (bool) // revert
function approve(address, uint256) public pure override returns (bool) // revert
function transferFrom(address, address, uint256) public pure override returns (bool) // revert
```

## Deploy

```bash
npx hardhat run scripts/deploy/01_deploy_fund_tracker.ts --network polygonAmoy
```

Requer `INFRASTRUCTURE_FUND_ADDRESS` no `.env`. Opcional: `FUND_TRACKER_ADMIN` (padrão: deployer).

## Constantes

| Constante | Valor | Descrição |
|---|---|---|
| `CAS_TRACKER` | 0 | Tipo CAS |
| `POL_TRACKER` | 1 | Tipo POL |

## Custom Errors

- `InvalidAssetType()`
- `InvalidFundAddress()`

## Dependências

- OpenZeppelin 5.x: `ERC20`, `Ownable`
- [[infrastructure-fund]] — `IInfrastructureFund` (consulta saldos)

## Segurança

- Tokens não são transferíveis (sempre revertem)
- Apenas o owner pode transferir ownership do tracker
- Validação de `fundAddress != address(0)` e `assetType <= POL_TRACKER`

## Changelog

| Data | Versão | Descrição |
|---|---|---|
| 2025-07-12 | 0.2.0 | Documentação inicial do FundTrackerToken |

![footer](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=100&section=footer&animation=twinkling)
