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
chainId 137) ao **preço de mercado** derivado on-chain do par SushiSwap
WPOL/CAS (modo `CAS_WPOL_PRICE=auto`), de forma a aumentar liquidez sem
impactar o preço vigente, e da reprecificação do CASSwap novo (facet
multi-token no Diamond) para evitar drenagem por arbitragem.

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
- **500.000 CAS por pool** (2.500.000 CAS nos pools; mint de 3.000.000 via
  `CAS_V4_MINT_AMOUNT`, deployer detém `MINTER_ROLE`; `MAX_SUPPLY=10M`).
- **Tesouraria:** o excedente do mint (`3M − 2,5M` = 500.000 CAS) é
  transferido para `TREASURY_ADDRESS` (`0xb72E…B837`) ao final da execução,
  mantido pareado com o lastro captado.
- **Preço de referência:** por padrão o script lê o spot do par SushiSwap
  `0x265D…C3964` (reservas = preço real) — seed a preço de mercado evita
  arbitragem imediata e deixa o mercado convergir. `CAS_WPOL_PRICE=<número>`
  força um preço fixo (com alerta se divergir >25% do spot).
- Contrapartida: calculada on-chain no momento (Chainlink POL/USD, ETH/USD,
  BRL/USD) para equivaler ao preço de referência por pool.

## Análise de preço nas DEXs (2026-11-04)

Única liquidez CAS existente: dois pools WPOL/CAS.

| Fonte | Reservas | Spot CAS |
|---|---|---|
| SushiSwap `0x265D…C3964` | 29,01 WPOL / 20.248 CAS | **1 CAS ≈ 0,00143 WPOL** (~$0,000137) |
| UniV3 `0x2a37…50Dc` (0,3%) | 0,68 WPOL / 19.888 CAS | tick ≈ 0,00415 WPOL — **não confiável** (lado WPOL quase zerado; liquidez concentrada fora da faixa) |

O spot da SushiSwap (produto constante, reservas = preço) é a referência de
mercado usada pelo script. Semear abaixo do spot faria arbitradores comprarem
CAS barato no V4 e venderem na Sushi, derrubando o preço — por isso o modo
`auto` é o padrão.

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
- A lista "O QUE ADQUIRIR" converte cada faltante para **equivalente BRLA**
  (Chainlink BRL/USD) e soma um **total geral em BRLA** (+5% de margem para
  os swaps BRLA→tokens), já que o provisionamento é feito comprando BRLA.
- Por pool, imprime o **preço implícito de CAS em WPOL** derivado dos
  montantes efetivamente depositados (contrapartida convertida a WPOL via
  Chainlink ÷ CAS depositado), ao lado do preço de referência
  `CAS_WPOL_PRICE`. Divergências de ~±10% são esperadas: o depósito cobre
  uma faixa concentrada ±10%, não o preço spot exato.
- `DRY_RUN=false`: mint → `approve` ERC20→Permit2 → `Permit2.approve`
  → por pool: `PoolManager.initialize` (se inexistente) +
  `PositionManager.modifyLiquidities` com `MINT_POSITION` + `SETTLE_PAIR`.

Variáveis `.env` novas: `UNIV4_POOL_MANAGER`, `UNIV4_POSITION_MANAGER`,
`UNIV4_STATE_VIEW`, `PERMIT2_ADDRESS`, `UNIV4_FEE_TIER`, `UNIV4_TICK_SPACING`,
`UNIV4_RANGE_PCT`, `BRLA_ADDRESS`, `CAS_WPOL_PRICE`, `CAS_V4_AMOUNT_PER_POOL`,
`CAS_V4_MINT_AMOUNT`.

## Provisão de fundos (dry-run de 2026-11-04, `CAS_WPOL_PRICE=auto`)

Preço de mercado capturado: 1 CAS ≈ 0,00143 WPOL. Valores aproximados —
recalculados a cada execução via oráculos e spot Sushi:

| Moeda | Necessário aprox. |
|---|---|
| CAS | 2.500.000 (mint de 3M cobre) |
| USDC | ~64,3 |
| USDT | ~76,2 |
| WPOL | ~660 |
| WETH | ~0,031 |
| BRLA | ~420 (saldo 600 cobre) |
| POL (gas) | ~2,7 (estimado a ~278 gwei) |

Preços implícitos reportados pelo dry-run (500k CAS por pool, faixa ±10%):
CAS/USDC ≈ 0,001317 WPOL · CAS/USDT ≈ 0,001560 · CAS/WPOL ≈ 0,001293 ·
CAS/WETH ≈ 0,001529 · CAS/BRLA ≈ 0,001578.

## Changelog

| Data | Versão | Descrição |
|---|---|---|
| 2026-11-04 | 0.1.0 | Documentação inicial; reprecificação do Diamond executada |
| 2026-11-04 | 0.2.0 | Preço via `CAS_WPOL_PRICE` (0,00013); script reporta preço implícito CAS/WPOL por pool |
| 2026-11-04 | 0.3.0 | `CAS_WPOL_PRICE=auto` deriva referência do spot SushiSwap; análise DEX documentada; mint 3M |
| 2026-11-04 | 0.4.0 | Excedente do mint (500k CAS) transferido à tesouraria `TREASURY_ADDRESS` (lastro) |
| 2026-11-04 | 0.5.0 | Lista de aquisição com equivalente e total geral em BRLA (+5% p/ swaps) |

![footer](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=100&section=footer&animation=twinkling)
