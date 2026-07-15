---
tags:
  - smartcontracts
  - token
  - liquidity
  - lock
---

![header](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=200&section=header&text=LiquidityLock&fontSize=36&fontAlignY=35&animation=twinkling)

![visitors](https://visitor-badge.laobi.icu/badge?page_id=RapportTecnologia.AgenticSpace.smartcontracts_liquidity-lock)
[![License: CC BY-SA 4.0](https://img.shields.io/badge/License-CC_BY--SA_4.0-blue.svg)](https://creativecommons.org/licenses/by-sa/4.0/)
![Language: Portuguese](https://img.shields.io/badge/Language-Portuguese-brightgreen.svg)
![Status](https://img.shields.io/badge/Status-Ongoing-yellow)

# LiquidityLock

**Caminho:** `contracts/token/LiquidityLock.sol`

Contrato que bloqueia tokens LP (Liquidity Provider) por um período determinado, impedindo saque antes do tempo de unlock.

## Visão Geral

- **Padrão:** Standalone (não upgradeável)
- **Função:** Bloquear LP tokens recebidos do QuickSwap/DEX
- **Unlock time:** Imutável após deploy (pode apenas ser estendido)
- **Owner:** Único endereço autorizado a sacar após unlock

## Funções

### constructor

```solidity
constructor(address lpToken, uint256 lockDuration)
```

Define o endereço do LP token e a duração do lock em segundos. O unlock time é calculado como `block.timestamp + lockDuration`.

### withdraw

```solidity
function withdraw() external onlyOwner
```

Saca todos os LP tokens do contrato. Reverte com `LockNotExpired` se chamado antes do unlock time. Reverte com `NoTokensToWithdraw` se não houver tokens.

### extendLock

```solidity
function extendLock(uint256 newUnlockTime) external onlyOwner
```

Estende o tempo de unlock. O novo tempo deve ser maior que o atual. Emite evento `LockExtended`.

### Consultas

| Função | Retorno | Descrição |
|---|---|---|
| `lpToken()` | `address` | Endereço do LP token bloqueado |
| `unlockTime()` | `uint256` | Timestamp de desbloqueio |
| `owner()` | `address` | Endereço autorizado a sacar |
| `isExpired()` | `bool` | Retorna `true` se já passou o unlock time |

## Events

- `LockExtended(uint256 oldUnlockTime, uint256 newUnlockTime)`
- `TokensWithdrawn(address indexed to, uint256 amount)`

## Custom Errors

- `LockNotExpired(uint256 unlockTime, uint256 currentTime)`
- `NoTokensToWithdraw()`
- `InvalidUnlockTime(uint256 newTime, uint256 currentTime)`
- `NotOwner(address caller, address owner)`

## Deploy

```bash
npx hardhat run scripts/deploy/05_lock_liquidity.ts --network polygonAmoy
```

O script:
1. Verifica o saldo de LP tokens do deployer
2. Deploy do LiquidityLock com duração configurável
3. Transfere LP tokens para o contrato de lock
4. Loga o unlock time e endereço do contrato

## Segurança

- Unlock time é imutável (só pode ser estendido, nunca reduzido)
- Apenas o owner pode sacar ou estender
- Validação de saldo antes do saque
- Custom errors para economizar gas

## Changelog

| Data | Versão | Descrição |
|---|---|---|
| 2025-07-12 | 0.1.0 | Documentação inicial do LiquidityLock |

![footer](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=100&section=footer&animation=twinkling)
