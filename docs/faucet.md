---
tags:
  - smartcontracts
  - faucet
---

![header](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=200&section=header&text=Faucet&fontSize=36&fontAlignY=35&animation=twinkling)

![visitors](https://visitor-badge.laobi.icu/badge?page_id=RapportTecnologia.AgenticSpace.smartcontracts_faucet)
[![License: CC BY-SA 4.0](https://img.shields.io/badge/License-CC_BY--SA_4.0-blue.svg)](https://creativecommons.org/licenses/by-sa/4.0/)
![Language: Portuguese](https://img.shields.io/badge/Language-Portuguese-brightgreen.svg)
![Status](https://img.shields.io/badge/Status-Ongoing-yellow)
[![GitHub Issues](https://img.shields.io/github/issues/RapportTecnologia/AgenticSpace)](https://github.com/RapportTecnologia/AgenticSpace/issues)

# Faucet — Distribuição de POL na Polygon

**Caminho:** `contracts/faucet/Faucet.sol`

Contrato avulso de faucet para distribuição de **POL nativo** na rede **Polygon PoS** (mainnet e testnet Amoy). Permite que qualquer endereço solicite saques com cooldown configurável, valor por saque ajustável e blacklist para bloqueio de endereços abusivos.

## Visão Geral

- **Padrão:** Ownable standalone (não faz parte do Diamond)
- **Interface:** `IFaucet`
- Cooldown configurável entre saques
- Valor por saque ajustável
- Blacklist para bloqueio de endereços abusivos
- `withdrawFunds` para recuperação de emergência

## Arquitetura

```
Faucet (standalone contract)
  ├── requestTokens()      → saque público de POL com cooldown
  ├── setBlacklist()       → bloqueio/desbloqueio de endereços
  ├── setInterval()        → configura cooldown entre saques
  ├── setAmount()          → configura valor por saque
  ├── setNextTry()         → ajuste manual de cooldown de um endereço
  ├── withdrawFunds()      → saque de emergência (apenas owner)
  ├── transferOwnership()  → transferência de ownership
  └── receive()            → aceita depósitos para alimentar o faucet
```

### Padrões de Projeto

- **Ownable (GoF):** acesso administrativo restrito ao owner
- **Checks-Effects-Interactions:** proteção contra reentrância no `requestTokens`
- **Strategy:** parâmetros configuráveis (interval, amount) via setters

## Funções

### Públicas

| Função | Descrição |
|---|---|
| `requestTokens()` | Solicita saque de POL. Valida blacklist, cooldown e saldo. |
| `getBalance()` | Retorna saldo de POL do faucet. |

### Admin (apenas owner)

| Função | Descrição |
|---|---|
| `transferOwnership(newOwner)` | Transfere ownership do contrato. |
| `setInterval(_interval)` | Define intervalo de cooldown em segundos. |
| `setAmount(_amount)` | Define quantidade de POL por saque em wei. |
| `setBlacklist(account, bool)` | Adiciona/remove endereço da blacklist. |
| `setNextTry(account, timestamp)` | Define manualmente o próximo horário de saque. |
| `withdrawFunds(amount)` | Saca POL do faucet (emergência). |

### Views

| Função | Descrição |
|---|---|
| `owner()` | Retorna endereço do owner. |
| `interval()` | Retorna intervalo de cooldown. |
| `amount()` | Retorna quantidade por saque. |
| `nextTry(address)` | Retorna próximo horário de saque permitido. |
| `isBlacklisted(address)` | Retorna se endereço está na blacklist. |

## Events

| Evento | Descrição |
|---|---|
| `Withdrawn(recipient, amount, nextAvailable)` | Saque realizado. |
| `IntervalUpdated(oldInterval, newInterval)` | Intervalo atualizado. |
| `AmountUpdated(oldAmount, newAmount)` | Quantidade atualizada. |
| `BlacklistUpdated(account, isBlacklisted)` | Blacklist atualizada. |
| `OwnershipTransferred(previousOwner, newOwner)` | Ownership transferida. |
| `FundsDeposited(from, amount)` | Depósito recebido. |
| `FundsWithdrawn(owner, amount)` | Fundos sacado pelo owner. |

## Custom Errors

- `NotOwner(address caller)`
- `OwnerCannotBeZeroAddress()`
- `Blacklisted(address account)`
- `CooldownNotElapsed(address account, uint256 nextAvailable)`
- `InsufficientFunds(uint256 available, uint256 required)`
- `InvalidInterval(uint256 interval)`
- `InvalidAmount(uint256 amount)`
- `NoFundsToWithdraw()`

## Deploy

### Variáveis de Ambiente

```env
FAUCET_INTERVAL=86400              # Cooldown em segundos (default: 24h)
FAUCET_AMOUNT=100000000000000000   # 0.1 POL em wei
```

### Testnet (Amoy)

```bash
npx hardhat run scripts/deploy/02_deploy_faucet.ts --network polygonAmoy
```

### Mainnet (Polygon)

```bash
npx hardhat run scripts/deploy/02_deploy_faucet.ts --network polygon
```

### Pós-Deploy

1. **Alimentar o faucet:** envie POL para o endereço do contrato
2. **Verificar no Polygonscan:** `npx hardhat verify --network polygonAmoy <FAUCET_ADDRESS> 86400 100000000000000000`
3. **Usuários chamam:** `requestTokens()` para receber POL

## Parâmetros Padrão

| Parâmetro | Valor Default | Descrição |
|---|---|---|
| `interval` | 86400 (24h) | Cooldown entre saques |
| `amount` | 0.1 POL (100000000000000000 wei) | POL por saque |

> Os parâmetros podem ser ajustados a qualquer momento pelo owner via `setInterval` e `setAmount`.

## Fluxo de Uso

```
Owner
  │
  ├─ deploy Faucet(interval, amount)
  │
  ├─ sendTransaction({ to: faucet, value: POL })
  │
  ├─ setBlacklist(abuser, true)         ← se necessário
  │
  └─ withdrawFunds(amount)              ← emergência

Usuário
  │
  ├─ requestTokens()
  │    ├─ Checks: blacklist, cooldown, saldo
  │    ├─ Effects: nextTry = now + interval
  │    └─ Interactions: transfer POL
  │
  └─ aguardar intervalo → requestTokens() novamente
```

## Segurança

- **Checks-Effects-Interactions** no `requestTokens` para prevenir reentrância
- `msg.sender` em vez de `tx.origin`
- Custom errors para gas eficiente
- Validação de input em todas as funções
- Eventos para todas as mutações de estado
- Blacklist para bloqueio de endereços abusivos
- `withdrawFunds` para recuperação de emergência (apenas owner)
- Sem secrets no código fonte — todas as chaves via `.env`

## Changelog

| Data | Versão | Descrição |
|---|---|---|
| 2025-07-12 | 0.2.0 | Reescrita: Obsidian format, removida seção PoW Faucet (contrato inexistente) |
| 2025-07-11 | 0.1.0 | Documentação inicial do Faucet com PoW Faucet |

![footer](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=100&section=footer&animation=twinkling)
