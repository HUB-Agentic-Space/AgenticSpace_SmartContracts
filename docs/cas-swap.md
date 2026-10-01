---
tags:
  - smartcontracts
  - token
  - swap
  - dex
  - diamond
---

![header](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=200&section=header&text=CASSwap&fontSize=36&fontAlignY=35&animation=twinkling)

![visitors](https://visitor-badge.laobi.icu/badge?page_id=RapportTecnologia.AgenticSpace.smartcontracts_cas-swap)
[![License: CC BY-SA 4.0](https://img.shields.io/badge/License-CC_BY--SA_4.0-blue.svg)](https://creativecommons.org/licenses/by-sa/4.0/)
![Language: Portuguese](https://img.shields.io/badge/Language-Portuguese-brightgreen.svg)
![Status](https://img.shields.io/badge/Status-Ongoing-yellow)
[![GitHub Issues](https://img.shields.io/github/issues/RapportTecnologia/AgenticSpace)](https://github.com/RapportTecnologia/AgenticSpace/issues)

# CASSwap

**Facet:** `contracts/facets/CASSwapUSDCPOLFacet.sol`
**Library:** `contracts/libs/LibCASSwap.sol`
**Storage:** `contracts/diamond/storage/CASSwapStorage.sol`
**Interface:** `contracts/interfaces/ICASSwapUSDCPOL.sol`
**Wrapper:** `contracts/facets/CASSwapWrapperFacet.sol`
**Oracle facet:** `contracts/facets/CASSwapOracleFacet.sol` · **Oracle lib:** `contracts/libs/LibCASOracle.sol`

Swap multi-ativo integrado ao Diamond (EIP-2535). Permite trocar entre **CAS, POL (nativo), USDC e BRLA** em todas as direções, com spread explícito que financia a manutenção das reservas. Os ratios podem ser **derivados on-chain por oráculos** (Chainlink + TWAP UniV3/SushiSwap — ver [Precificação por Oráculo](#precificação-por-oráculo-on-chain)) ou mantidos por `RATIO_SETTER_ROLE` no modo legado.

> O contrato standalone legado `contracts/token/CASSwap.sol` (UUPS, CAS↔POL) permanece para compatibilidade; a operação ativa acontece na facet do Diamond.

## Visão Geral

- **Padrão:** EIP-2535 Diamond facet (diamond storage em namespace próprio)
- **Pares suportados:** CAS ↔ POL, CAS ↔ USDC, CAS ↔ BRLA e cruzados BRLA ↔ POL, BRLA ↔ USDC, POL ↔ USDC (12 direções)
- **Roteamento cruzado:** o CAS é a unidade de conta — `X → CAS → Y` compõe o buy-ratio de X e o sell-ratio de Y, sem movimentar a reserva de CAS
- **Ratios:** pares numerator/denominator **por ativo e por direção** (buy e sell independentes)
- **Spread:** `buyRatio <= sellRatio` garantido on-chain (`ReverseSpread` reverte configuração invertida)
- **Swap fee:** `swapFeeBps` em basis points, cobrada uma única vez sobre o valor de entrada (transição **300 → 50 bps = 0,5%** agendada no timelock em 2026-09-23, operationId `0x25b6…a2ad`, executável a partir de 2026-09-26 via `scripts/deploy/39_execute_casswap_fee.ts`)
- **Proteções:** `nonReentrant`, `whenNotPaused`, slippage (`minOut`), deadline e verificação de reserva do ativo de saída
- **Guarda de impacto:** `maxImpactBps` limita a variação de ratio por atualização

## Currency IDs (API genérica)

| ID | Ativo | Decimais | Tipo |
| :-: | :--- | :------: | :--- |
| 0 | POL (nativo) | 18 | `msg.value` |
| 1 | USDC | **6** | ERC-20 |
| 2 | BRLA | 18 | ERC-20 |
| 3 | CAS | 18 | ERC-20 |

## Semântica dos Ratios

Cada ratio é expresso como **`num / den` = unidades base de CAS por unidade base do ativo de quote**.

- Para POL e BRLA (18 decimais), `num/den` já é o valor humano de CAS por token.
- Para USDC (6 decimais), a normalização de unidades base exige o fator `1e12`: o valor humano de CAS por 1 USDC é `(num/den) × 1e12`. O getter `getCasRate(1)` já aplica essa correção.
- **Direção do spread:** como o ratio mede "quanto CAS o usuário recebe por unidade do ativo", um ratio **menor** significa CAS **mais caro**. O backend publica:
  - `buyRatio` = **menor** CAS-por-quote entre os DEXs monitorados → quem compra CAS paga o **maior** preço de mercado;
  - `sellRatio` = **maior** CAS-por-quote → quem vende CAS recebe o **menor** preço de mercado.
  - A diferença entre buy e sell (mais a fee) fica nas reservas do swap — é a receita de manutenção do sistema.

## Roles

| Role | Descrição |
|---|---|
| `DEFAULT_ADMIN_ROLE` | Gerencia roles, define `swapFeeBps` e `maxImpactBps` |
| `RATIO_SETTER_ROLE` | Ajusta os ratios de compra/venda (backend publicador) |
| `PAUSER_ROLE` | Pausa/despausa os swaps |

## Funções

### Rotas diretas CAS ↔ ativo

```solidity
function buyCASWithPOL(uint256 minCasOut, uint256 deadline) external payable;
function sellCASForPOL(uint256 casIn, uint256 minPolOut, uint256 deadline) external;
function buyCASWithUSDC(uint256 usdcIn, uint256 minCasOut, uint256 deadline) external;
function sellCASForUSDC(uint256 casIn, uint256 minUsdcOut, uint256 deadline) external;
function buyCASWithBRLA(uint256 brlaIn, uint256 minCasOut, uint256 deadline) external;
function sellCASForBRLA(uint256 casIn, uint256 minBrlaOut, uint256 deadline) external;
```

### Swap genérico multi-par

```solidity
function swapExact(
    uint8 currencyIn,
    uint8 currencyOut,
    uint256 amountIn,
    uint256 minOut,
    uint256 deadline
) external payable returns (uint256 amountOut);
```

Executa qualquer rota entre os 4 ativos. Rotas diretas contra CAS usam um único ratio; rotas cruzadas compõem `buyRatio(in) × sellRatio(out)`. Requer `amountIn == msg.value` quando `currencyIn = 0` (POL) e allowance ERC-20 nos demais casos. Reverte com `SlippageExceeded` abaixo de `minOut` e com `DeadlineExceeded` após `deadline`.

```solidity
function quoteSwap(uint8 currencyIn, uint8 currencyOut, uint256 amountIn)
    external view returns (uint256 amountOut, uint256 feeBps);
```

Simulação read-only do `swapExact` com a mesma matemática — usada pelo frontend para preview.

### Setters de ratio

```solidity
function setSwapRatio(uint256 num, uint256 den) external;            // POL buy
function setSwapRatioSell(uint256 num, uint256 den) external;        // POL sell
function setSwapRatioUSDC(uint256 num, uint256 den) external;        // USDC buy
function setSwapRatioUSDCSell(uint256 num, uint256 den) external;    // USDC sell
function setSwapRatioBRLA(uint256 num, uint256 den) external;        // BRLA buy
function setSwapRatioBRLASell(uint256 num, uint256 den) external;    // BRLA sell
function setAllSwapRatios(uint256 polNum, uint256 polDen, uint256 usdcNum, uint256 usdcDen,
                          uint256 polSellNum, uint256 polSellDen,
                          uint256 usdcSellNum, uint256 usdcSellDen) external;
function setAllSwapRatiosV2(... + brlaNum/Den, brlaSellNum/Den) external;
function setBRLAToken(address token) external;
```

Todos restritos a `RATIO_SETTER_ROLE` (ou owner). Validam `num > 0`, `den > 0`, `buy <= sell` (`ReverseSpread`) e `maxImpactBps`. `setAllSwapRatios`/`V2` atualizam atomicamente — o publisher prefere esses seletores e só usa os sequenciais como fallback, em ordem que nunca cria spread invertido transitório.

### Configuração

```solidity
function setSwapFeeBps(uint256 feeBps) external;   // <= 10000
function setMaxImpactBps(uint256 bps) external;    // <= 10000
function pause() / unpause() external;             // PAUSER_ROLE
```

### Consultas

| Função | Retorno | Descrição |
|---|---|---|
| `getRatio()` / `getRatioSell()` | `(uint256, uint256)` | Ratios POL buy/sell (sell faz fallback para buy quando 0) |
| `getRatioUSDC()` / `getRatioUSDCSell()` | `(uint256, uint256)` | Ratios USDC buy/sell |
| `getRatioBRLA()` / `getRatioBRLASell()` | `(uint256, uint256)` | Ratios BRLA buy/sell |
| `getCasRate(uint8 currency)` | `(uint256, uint256)` | Ratio humano CAS por 1 token inteiro; para USDC já divide o `1e12` |
| `getReservesMulti()` | tupla | Reservas de POL, CAS, USDC e BRLA |
| `getBRLAToken()` | `address` | Endereço do token BRLA configurado |
| `casReserve()` | `uint256` | Saldo de CAS da facet |
| `swapFeeBps()` / `maxImpactBps()` | `uint256` | Parâmetros atuais |
| `paused()` | `bool` | Estado de pausa |

## Eventos

- `BoughtCAS`, `SoldCAS`, `Swapped`
- `RatioUpdated(uint8 indexed ratioSlot, uint256 num, uint256 den)`
- `SwapFeeUpdated`, `BRLATokenUpdated`

## Custom Errors

`ZeroAmount`, `ZeroAddress`, `InsufficientCASBalance`, `InsufficientPOLBalance`, `InsufficientReserve`, `InvalidFeeBps`, `ZeroNumerator`, `ZeroDenominator`, `ReverseSpread`, `RatioChangeExceeded`, `SlippageExceeded`, `DeadlineExceeded`, `InvalidCurrency`, `UnsupportedRoute`, `ReentrancyGuarded`.

## Precificação por Oráculo On-Chain

Quando `oracleEnabled = true` e as fontes estão válidas, `buyRatioFor`/`sellRatioFor` (usados por `quoteSwap`, `swapExact` e todas as rotas diretas) derivam o ratio efetivo de oráculos — os ratios armazenados deixam de ser o caminho autoritativo e viram **fallback limitado por `legacyRatioMaxAge`**.

### Fontes (Polygon mainnet)

| Tipo | Fonte | Endereço | Fornece |
|---|---|---|---|
| Chainlink | MATIC/USD | `0xAB594600376Ec9fD91F8e885dADF0CE036862dE0` | USD por POL |
| Chainlink | USDC/USD | `0xfE4A8cc5b5B2366C1B58Bea3858e81843581b2F7` | USD por USDC |
| Chainlink | **BRL/USD** | `0xB90DA3ff54C3ED09115abf6FbA0Ff4645586af2c` | USD por BRL (~0,19 — não inverter) |
| UniV3 TWAP | CAS/WPOL fee 3000 | `0x2a37bcA556c39418B779901f9b2988414Ee550Dc` | `observe([twapWindow, 0])` |
| SushiSwap V2 | CAS/WPOL | `0x265D86d4D43c32037b032097e8bFB6893E1C3964` | TWAP via `price*CumulativeLast` com checkpoints no storage |

CAS/WPOL vem das fontes DEX válidas; a perna USD usa Chainlink: `CAS/quote = CAS/WPOL × (USD_por_quote ÷ USD_por_POL)`, com normalização de decimais (CAS/WPOL 18, USDC 6, feeds Chainlink 8).

### Envelope (regra "contrato sempre ganha")

- **buy** (usuário compra CAS): **menor** CAS/quote entre as fontes CAS válidas → CAS **mais caro** para o usuário;
- **sell** (usuário vende CAS): **maior** CAS/quote → CAS **mais barato**;
- uma fonte CAS indisponível apenas estreita o envelope; zero fontes válidas aciona o fallback.

### Warm-up, poke e fallback

- `setOracleConfig` registra a **âncora** do cumulativo SushiSwap; o primeiro TWAP fecha `twapWindow` segundos depois. O pool UniV3 precisa de liquidez e cardinalidade de observação > 1 (`increaseObservationCardinalityNext`) — hoje está com `liquidity=0`, então a fonte é ignorada até ser semeada.
- `updateCasTwap()` é **permissionless** e publica novo checkpoint quando a janela fecha; `pokeCasTwap` interno roda automaticamente no início de cada swap/setter, então o uso normal já mantém o TWAP andando.
- Oráculo indisponível (feed stale além de `clStaleCrypto`/`clStaleFx`, TWAP sem janela fechada) → ratio armazenado, **se** escrito dentro de `legacyRatioMaxAge` (`ratiosSetAt` carimba todo setter de ratio); fora disso reverte `InvalidRatio`.
- `oracleEnabled = false` → comportamento legado integral.

### Funções do oracle facet

| Função | Acesso | Descrição |
|---|---|---|
| `setOracleConfig(feeds, pools, janelas, enabled)` | owner | Configura fontes e liga o modo oráculo — usado como `initCalldata` do diamondCut |
| `setOracleEnabled(bool)` | owner | Liga/desliga isoladamente |
| `updateCasTwap()` | permissionless | Avança o checkpoint SushiSwap ao fechar a janela |
| `getCasPriceSources()` | view | CAS/WPOL (1e18) por fonte + flag — zeros = indisponível |
| `getOracleRatio(uint8 currency, bool sell)` | view | Ratio efetivo do oráculo (0,0 se indisponível; sem fallback) |
| `oraclePricingEnabled()` | view | Flag atual |

**Deploy:** `scripts/deploy/47_prepare_casswap_oracle_cut.ts` gera `deployments/casswap-oracle-cut.json` (replace dos seletores do swap facet + add do oracle facet + init `setOracleConfig` com `enabled=true`), seguido de schedule no timelock 48h via Safe — a âncora do TWAP nasce na execução do corte e o fallback legado cobre o aquecimento.

## Publicação de Ratios (backend)

> **Transição para oráculo:** com o oracle cut ativo e as fontes aquecidas, o publisher do trader é desligado via `TRADER_PUBLISH_RATIOS=false` — os ratios armazenados passam a servir só de fallback (`legacyRatioMaxAge`). O texto abaixo descreve o modo legado.

O `rapport-trader-cycle.service` (~1 min) é o **único publisher** autoritativo no modo legado. A cada ciclo:

1. Coleta amostras frescas das pools CAS/WPOL nos DEXs monitorados;
2. Monta o envelope: `buy = min(pools)`, `sell = max(pools)` — compra pelo maior preço, venda pelo menor;
3. Converte para o ratio USDC pela taxa POL/USD com normalização `1e12` exata;
4. Deriva o ratio BRLA da perna USDC: `CAS/BRLA = CAS/USDC × USD_por_BRL`, com a taxa vinda do feed Chainlink BRL/USD (`CHAINLINK_BRL_USD_FEED`, staleness máx. 26h) ou do fallback `BRLA_USD_RATE`;
5. Rejeita spreads invertidos e publicações com avaliadores anti-fraude suspeitos;
6. Publica pelo melhor seletor disponível — `setAllSwapRatiosV2` (6 ratios atômicos) → `setAllSwapRatios` (4) → setters sequenciais em ordem segura — e **verifica os getters** no bloco de confirmação. Sem targets BRLA no ciclo, o V2 republica os ratios BRLA on-chain inalterados; sem BRLA semeado, cai para V1 (POL/USDC).

A banda histórica do consolidator pertence à decisão de trading e **não** bloqueia a publicação.

## Segurança

- `DiamondAccessControl.enforceRoleOrOwner` em todos os setters
- `nonReentrant` em todas as funções de swap; `SafeERC20` para tokens
- `whenNotPaused` em swaps; pausa via `PAUSER_ROLE`
- `ReverseSpread` impede `buy > sell` on-chain
- `maxImpactBps` limita variação por atualização de ratio
- `Math.mulDiv` nos cálculos para evitar overflow
- Reserva do ativo de saída verificada antes da transferência
- Upgrades da facet via Safe multisig 2-de-3 + timelock (48h) — scripts `32_prepare_casswap_multiasset_cut.ts`, `33_configure_brla_ratios.ts`, `34_schedule_casswap_multiasset_cut.ts`, `35_execute_casswap_multiasset_cut.ts` e `36_reschedule_casswap_multiasset_cut.ts`
- Upgrade multi-ativo **executado** (2026-09-22): facet `0xbab9038B430db567a894676efe0f1De230b85d5B` ativa, operationId `0x662e7e03...49af` done, `getBRLAToken()` = `0xE6A537a407488807F0bbeb0038B79004f19DDDFb`. Pendências operacionais: ratios BRLA (publicados pelo trader cycle via `setAllSwapRatiosV2`) e seed da reserva BRLA para habilitar CAS→BRLA
- A carteira publisher do trader pode ser conta delegada **EIP-7702** (limite de 1 tx in-flight por pool de nó): o publisher faz preflight `latest`/`pending`, registra deferrals e faz failover de broadcast por `POLYGON_RPC_URLS`; `operator_trader/src/scripts/clear-stuck-nonce.ts` substitui um nonce travado por self-transfer com fee bump
- `supportSwap(uint8,uint256,address)` aceita apenas `CURRENCY_POL` (0) e `CURRENCY_USDC` (1) — retirada/suporte da reserva BRLA exigiria nova facet via diamondCut; seed de BRLA é feito por transferência ERC-20 direta ao Diamond
- Oráculo: staleness Chainlink por feed (`clStaleCrypto`/`clStaleFx` — BRL/USD é FX e fecha fds), TWAP só após janela fechada, `oracleEnabled` restrito ao owner (Timelock) e fallback legado expira em `legacyRatioMaxAge` para não prolongar preço morto indefinidamente

## Changelog

| Data | Versão | Descrição |
|---|---|---|
| 2026-09-25 | 0.9.0 | Precificação por oráculo on-chain: `LibCASOracle` + `CASSwapOracleFacet` (EIP-170) derivam CAS/WPOL por TWAP UniV3 (`observe`) e SushiSwap V2 (cumulativos com checkpoints) e perna USD por Chainlink POL/USD, USDC/USD e **BRL/USD** (USD por BRL). Envelope preserva "compra caro / vende barato". Ratios legados viram fallback com `legacyRatioMaxAge=96h`; `ratiosSetAt` carimba setters. **Agendado no timelock** (Safe nonce 18, tx `0x1de4d57e…0761`): facets `0x4dbc282c…E1292` (swap) + `0xDd3ACC56…a04ad` (oracle), operationId `0x2c45a354…7cff6`, executável a partir de **2026-09-27 20:57:57 UTC** via `49_execute_casswap_oracle_cut.ts` (timer `agenticspace-casswap-oracle-execute.timer` armado). Scripts: `47_prepare`/`48_schedule`/`49_execute`. Pendente: semear UniV3 CAS/WPOL + `increaseObservationCardinalityNext`. Trader ganha gate `TRADER_PUBLISH_RATIOS` |
| 2026-09-25 | 0.8.0 | Pause passa a ser governado por role: `TraderGovernanceFacet` v2 (`0x605A5991…B7B0`) com `pauseSwap`/`unpauseSwap` via `enforceRoleOrOwner(PAUSER_ROLE)` — pausa/retomada imediata pelo Safe sem delay. Batch agendado no timelock (Safe nonce 17, tx `0x6d424c7a…d0cc`): diamondCut Replace dos 9 seletores + `grantRole(PAUSER_ROLE→Safe)`, operationId `0xba3ade6c…1dea`, executável a partir de **2026-09-27 13:55:14 UTC**. Scripts: `43_deploy_trader_governance_facet.ts`, `44_prepare_pause_governance_cut.ts`, `45_schedule_pause_governance.ts`, `46_execute_pause_governance.ts`; execução automática via `agenticspace-casswap-pausegov-execute.timer` |
| 2026-09-25 | 0.7.0 | Pause do swap agendado via governança: `pauseSwap()` no Diamond (facet `0x94b1AE50...C96b`, `TraderGovernanceFacet`) agendado pelo Safe 2-de-3 (nonce 16, tx `0x95b5e2c2...e0d5`) — operationId `0xab3876cd...23cc`, executável a partir de **2026-09-27 12:34:54 UTC** por qualquer executor (EXECUTOR_ROLE aberto). Scripts: `40_prepare_casswap_pause.ts` (payload `deployments/casswap-pause.json`), `41_schedule_casswap_pause.ts`, `42_execute_casswap_pause.ts`; execução automática via `agenticspace-casswap-pause-execute.timer`. Standalone legado `0x9399878C…` já constava pausado on-chain (`isPaused()=true`). Frontend: leituras `view` de `CASSwapInline`/`CASSwapModal` migradas para `JsonRpcProvider` público (independente da rede da carteira) |
| 2026-09-23 | 0.6.0 | Swap fee 3% → 0,5%: default de `set_swap_fee.ts` para 50 bps, fallback de exibição no frontend (CASSwapInline/CASSwapModal) e pipeline de governança `37_prepare`/`38_schedule`/`39_execute_casswap_fee` (Safe 2-de-3 → timelock 48h; agendado no nonce 15 do Safe, executável em 2026-09-26) |
| 2026-09-22 | 0.5.0 | Cut multi-ativo executado; trader passa a operar CAS↔BRLA (`buyCASWithBRLA`/`sellCASForBRLA`/`swapExact`/`quoteSwap` como fallback de execução), snapshots/estado com BRLA via `getReservesMulti`, resiliência EIP-7702 no publisher (preflight in-flight, failover RPC, `clear-stuck-nonce.ts`) e nota sobre `supportSwap` não cobrir BRLA |
| 2026-09-20 | 0.4.0 | Publisher BRLA no trader cycle (Chainlink BRL/USD + fallback `BRLA_USD_RATE`, derivação via perna USDC, `setAllSwapRatiosV2` com reuse dos ratios on-chain). Echidna: 8/8 invariantes no harness da Lib |
| 2026-09-19 | 0.3.0 | Multi-ativo: BRLA + swap genérico `swapExact`/`quoteSwap`/`getCasRate` (12 direções, CAS pivot), `setAllSwapRatiosV2`, `setBRLAToken`, documentação do envelope compra-alto/vende-baixo e da normalização USDC 1e12 |
| 2026-09-17 | 0.2.0 | Guarda `maxImpactBps`, `setAllSwapRatios` atômico, `Math.mulDiv`, ratios sell separados |
| 2025-07-12 | 0.1.0 | Documentação inicial do CASSwap standalone com ratio flexível |

![footer](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=100&section=footer&animation=twinkling)
