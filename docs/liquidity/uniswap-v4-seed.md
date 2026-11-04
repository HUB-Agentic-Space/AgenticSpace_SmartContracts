---
tags:
  - liquidity
  - uniswap-v4
  - cas
---

![header](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=200&section=header&text=Uniswap%20V4%20Seed&fontSize=36&fontAlignY=35&animation=twinkling)

![visitors](https://visitor-badge.laobi.icu/badge?page_id=RapportTecnologia.AgenticSpace.smartcontracts_uniswap-v4-seed)
[![License: CC BY-SA 4.0](https://img.shields.io/badge/License-CC_BY--SA_4.0-blue.svg)](https://creativecommons.org/licenses/by-sa/4.0/)
![Language: Portuguese](https://img.shields.io/badge/Language-Portuguese-brightgreen.svg)
![Status](https://img.shields.io/badge/Status-Ongoing-yellow)
[![GitHub Issues](https://img.shields.io/github/issues/RapportTecnologia/AgenticSpace)](https://github.com/RapportTecnologia/AgenticSpace/issues)

# Seed de Liquidez Uniswap V4 — Pools CAS (Polygon)

Documento operacional da criação de pools CAS no Uniswap V4 (Polygon mainnet,
chainId 137) ao preço de referência **1 CAS = 0,0003 WPOL**, e da reprecificação
do CASSwap novo (facet multi-token no Diamond) para evitar drenagem por
arbitragem.

Issue relacionada: `HUB-Agentic-Space/AgenticSpace_SmartContracts#2`.

## Escopo

- 5 pools Uniswap V4, fee `3000` (0,3%), `tickSpacing 60`, faixa concentrada
  **±10%** em torno do preço inicial:
  | Pool | currency0 | currency1 |
  |---|---|---|
  | CAS/USDC | USDC `0x3c49…3359` (nativo Circle, 6 dec) | CAS |
  | CAS/USDT | CAS | USDT `0xc213…8e8F` (6 dec) |
  | CAS/WPOL | WPOL `0x0d50…1270` | CAS |
  | CAS/WETH | CAS | WETH `0x7ceB…f619` |
  | CAS/BRLA | CAS | BRLA `0xE6A5…DDFb` |
- **500.000 CAS por pool** (2.500.000 CAS total) — mint via `CAS_V4_MINT_AMOUNT`
  no próprio script (deployer detém `MINTER_ROLE`; `MAX_SUPPLY=10M`).
- Contrapartida: calculada on-chain no momento (Chainlink POL/USD, ETH/USD,
  BRL/USD) para equivaler a ~150 WPOL por pool.

## Contratos V4 (oficiais, Polygon)

| Contrato | Endereço |
|---|---|
| PoolManager | `0x67366782805870060151383F4BbFF9daB53e5cD6` |
| PositionManager | `0x1ec2ebf4f37e7363fdfe3551602425af0b3ceef9` |
| StateView | `0x5ea1bd7974c8a611cbab0bdcafcb1d9cc9b3ba5a` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |

## Reprecificação do CASSwap novo (Diamond)

O CASSwap **novo** é o facet `CASSwapUSDCPOLFacet` no Diamond
(`DIAMOND_ADDRESS`) — multi-token (POL/USDC/BRLA, ratios buy+sell separados).
O CASSwap **antigo** (standalone `0x9399…ACF4`) não é tocado e permanece pausado.

Script: `scripts/casswap/26_adjust_diamond_ratio_and_pause.ts`

Sequência (executada em 2026-11-04):

1. `unpauseSwap()` — deployer (`PAUSER_ROLE`).
2. `setMaxImpactBps(10000)` — ratio signer (`RATIO_SETTER_ROLE`,
   `CAS_RATIO_SIGNER_PRIVATE_KEY`). O facet rejeita `maxImpactBps > 10000`.
3. `setAllSwapRatiosV2(...)` em **passos ≤1,9×** (a guarda `maxImpactBps`
   rejeita saltos maiores; a mudança total foi ~700%, exigindo 4 steps):
   - POL buy `10000:3` / sell `50000:12` (spread sell = buy × 1,25);
   - USDC e BRLA equivalentes via Chainlink (CAS = 0,0003 WPOL);
   - `ratiosSetAt` atualizado (fallback do oráculo fica fresco).
4. `setMaxImpactBps(100)` — restaura o valor original.
5. `pauseSwap()` — deployer.

> **Nota:** `oracleEnabled=true` no storage do swap — quando o swap for
> despausado, o preço efetivo segue os feeds/TWAP do oráculo (pool V3 + par
> SushiSwap), não os ratios armazenados. Para o Diamond usar 0,0003 WPOL como
> referência efetiva, o owner (Safe) deve `setOracleEnabled(false)` ou
> repontar as fontes do oráculo para pools compatíveis.

## Script de seed

`scripts/deploy/13_seed_uniswap_v4_pools.ts`

- `DRY_RUN=true` (padrão): nenhuma tx; imprime a **tabela de provisão** —
  saldo × necessário × faltante por moeda (CAS, WPOL, USDC, USDT, WETH, BRLA)
  e **POL de gas estimado** (+20%). O faltante de CAS já desconta o mint
  planejado.
- `DRY_RUN=false`: mint → `approve` ERC20→Permit2 → `Permit2.approve`
  → por pool: `PoolManager.initialize` (se inexistente) +
  `PositionManager.modifyLiquidities` com `MINT_POSITION` + `SETTLE_PAIR`.

Variáveis `.env` novas: `UNIV4_POOL_MANAGER`, `UNIV4_POSITION_MANAGER`,
`UNIV4_STATE_VIEW`, `PERMIT2_ADDRESS`, `UNIV4_FEE_TIER`, `UNIV4_TICK_SPACING`,
`UNIV4_RANGE_PCT`, `BRLA_ADDRESS`, `CAS_WPOL_PRICE`, `CAS_V4_AMOUNT_PER_POOL`,
`CAS_V4_MINT_AMOUNT`.

## Provisão de fundos (dry-run de 2026-11-04)

Valores aproximados — recalculados a cada execução via oráculos:

| Moeda | Necessário aprox. |
|---|---|
| CAS | 2.500.000 (mint cobre) |
| USDC | ~13,3 |
| USDT | ~15,7 |
| WPOL | ~136 |
| WETH | ~0,0069 |
| BRLA | ~87 |
| POL (gas) | ~2,8 (estimado a ~289 gwei) |

## Changelog

| Data | Versão | Descrição |
|---|---|---|
| 2026-11-04 | 0.1.0 | Documentação inicial; reprecificação do Diamond executada |

![footer](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=100&section=footer&animation=twinkling)
