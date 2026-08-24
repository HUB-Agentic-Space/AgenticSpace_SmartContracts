---
tags:
  - smartcontracts
  - buyback
  - burn
  - uups
  - liquidity
---

![header](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=200&section=header&text=BuybackBurn&fontSize=36&fontAlignY=35&animation=twinkling)

![visitors](https://visitor-badge.laobi.icu/badge?page_id=RapportTecnologia.AgenticSpace.smartcontracts_buyback-burn)
[![License: CC BY-SA 4.0](https://img.shields.io/badge/License-CC_BY--SA_4.0-blue.svg)](https://creativecommons.org/licenses/by-sa/4.0/)
![Language: Portuguese](https://img.shields.io/badge/Language-Portuguese-brightgreen.svg)
![Status](https://img.shields.io/badge/Status-Ongoing-yellow)
[![GitHub Issues](https://img.shields.io/github/issues/RapportTecnologia/AgenticSpace)](https://github.com/RapportTecnologia/AgenticSpace/issues)

# BuybackBurn (UUPS Upgradeable)

Contrato UUPS upgradeable que compra CAS na DEX com POL nativo e queima os
tokens comprados, criando pressão deflacionária no token.

## Arquitetura

```
┌─────────────┐     POL      ┌───────────────┐    swapExactETHForTokens    ┌───────────┐
│  OPERATOR   │ ──────────►  │  BuybackBurn  │ ─────────────────────────► │  DEX Router│
│  (caller)   │              │  (UUPS proxy) │                             │  (SushiSwap)│
└─────────────┘              └───────────────┘ ◄────────────────────────── └───────────┘
                                    │ CAS received
                                    ▼
                             ┌───────────────┐
                             │  CAS Token    │
                             │  burn(amount) │
                             └───────────────┘
```

## Arquivos

| Arquivo | Descrição |
|---|---|
| `contracts/interfaces/IBuybackBurn.sol` | Interface do contrato |
| `contracts/token/BuybackBurn.sol` | Implementação UUPS |
| `contracts/mocks/MockBuybackRouter.sol` | Mock router para testes |
| `scripts/deploy/09_deploy_buyback_burn.ts` | Script de deploy |
| `scripts/casswap/18_execute_buyback.ts` | Script de execução |
| `test/buyback/BuybackBurn.test.ts` | Testes unitários (20 testes) |

## Roles

| Role | Permissão | Autenticação |
|---|---|---|
| `DEFAULT_ADMIN_ROLE` | Upgrade UUPS, gerenciar roles | Agente admin / multisig |
| `OPERATOR_ROLE` | Executar buyback, ajustar router/slippage/min | Agente operador |
| `PAUSER_ROLE` | Pausar/despausar | Agente admin |
| `TREASURER_ROLE` | Sacar POL em emergência | Agente tesoureiro / multisig |

> **Nota**: Este contrato **não é utilizável por humanos diretamente**.
> Apenas agentes com roles apropriadas podem chamar `executeBuyback`.

## Funções

### `executeBuyback(uint256 minCasOut, uint256 deadline)`

Compra CAS na DEX com todo o POL disponível no contrato e queima.

- **Auth**: `OPERATOR_ROLE`
- **Checks**: não pausado, deadline válida, POL >= minBuybackAmount
- **Effects**: CAS comprado é queimado via `burn()`
- **Events**: `BuybackExecuted(caller, polSpent, casBought, casBurned)`

### `depositPOL() payable`

Deposita POL no contrato para o fundo de buyback.

- **Auth**: pública
- **Events**: `POLDeposited(from, amount)`

### `setDEXRouter(address newRouter)`

Atualiza o endereço do DEX router.

- **Auth**: `OPERATOR_ROLE`
- **Events**: `RouterUpdated(oldRouter, newRouter)`

### `setSlippageBps(uint256 bps)`

Ajusta tolerância de slippage (máx 500 bps = 5%).

- **Auth**: `OPERATOR_ROLE`
- **Events**: `SlippageUpdated(oldBps, newBps)`

### `setMinBuybackAmount(uint256 minAmount)`

Ajusta o valor mínimo de POL por execução.

- **Auth**: `OPERATOR_ROLE`
- **Events**: `MinAmountUpdated(oldMin, newMin)`

### `withdrawPOL(uint256 amount)`

Saca POL em emergência.

- **Auth**: `TREASURER_ROLE`, `whenNotPaused`
- **Events**: `POLWithdrawn(to, amount)`

### `pause()` / `unpause()`

Pausa/despausa o contrato.

- **Auth**: `PAUSER_ROLE`

### `_authorizeUpgrade(address)`

Autoriza upgrade UUPS.

- **Auth**: `DEFAULT_ADMIN_ROLE`

## Deploy

```bash
npm run deploy:buyback:polygon
```

Variáveis de ambiente necessárias:

```env
CAS_TOKEN_ADDRESS=<endereço do CAS Token>
BUYBACK_DEX_ROUTER=0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506
WPOL_ADDRESS=0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270
```

Após o deploy, salvar o endereço do proxy:

```env
BUYBACK_BURN_ADDRESS=<endereço do proxy UUPS>
```

## Executar Buyback

1. Depositar POL no contrato (via `depositPOL` ou `sendTransaction`)
2. Executar:

```bash
npm run buyback:execute:polygon
```

O script calcula `minCasOut` usando Chainlink POL/USD e o preço alvo CAS.

## Segurança

- **ReentrancyGuard**: proteção contra reentrância em `executeBuyback`
- **Pausable**: emergência via `PAUSER_ROLE`
- **AccessControl**: roles granulares
- **Custom errors**: gas eficiente
- **Slippage protection**: `minCasOut` + `deadline`
- **Max slippage**: limitado a 5% (500 bps)
- **SafeERC20**: transfers seguros
- **CEI pattern**: Checks-Effects-Interactions

## Testes

```bash
npx hardhat test test/buyback/BuybackBurn.test.ts
```

Cobertura: 20 testes cobrindo inicialização, deposit, buyback+burn, roles,
pause/unpause, admin functions, e upgrade UUPS.

## Changelog

| Data | Versão | Descrição |
|---|---|---|
| 2026-08-02 | 0.1.0 | Implementação inicial UUPS com 20 testes |

![footer](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=100&section=footer&animation=twinkling)
