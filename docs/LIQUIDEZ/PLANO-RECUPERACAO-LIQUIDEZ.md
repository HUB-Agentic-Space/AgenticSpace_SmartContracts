---
tags:
  - liquidity
  - plan
  - dex
  - casswap
  - buyback
  - uniswap-v3
---

![header](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=200&section=header&text=Plano%20de%20Recuperacao%20de%20Liquidez%20CAS&fontSize=36&fontAlignY=35&animation=twinkling)

![visitors](https://visitor-badge.laobi.icu/badge?page_id=RapportTecnologia.AgenticSpace.smartcontracts_plano-recuperacao-liquidez)
[![License: CC BY-SA 4.0](https://img.shields.io/badge/License-CC_BY--SA_4.0-blue.svg)](https://creativecommons.org/licenses/by-sa/4.0/)
![Language: Portuguese](https://img.shields.io/badge/Language-Portuguese-brightgreen.svg)
![Status](https://img.shields.io/badge/Status-Ongoing-yellow)
[![GitHub Issues](https://img.shields.io/github/issues/RapportTecnologia/AgenticSpace)](https://github.com/RapportTecnologia/AgenticSpace/issues)

# Plano de Recuperação de Liquidez CAS

> Diagnóstico e plano de ação em 4 fases para restaurar e expandir a liquidez
> do token CAS na Polygon, cobrindo Diamond Swap (CASSwapUSDCPOLFacet),
> DEXs V2, Uniswap V3 e mecanismos de buyback/burn.
>
> **Atualização (2026-08-02)**: O CASSwap standalone está **deprecated**.
> Todo swap agora usa o Diamond (`CASSwapUSDCPOLFacet`) que suporta
> CAS↔POL e CAS↔USDC. Não depositar USDC — CAS gera USDC naturalmente
> via `sellCASForUSDC` quando preço adequado. Aporte de 200 POL confirmado.
> Preço alvo: CAS = $0.0005 USD.

## Diagnóstico Atual (2026-07-28)

### CASSwap (Pausado)

| Métrica | Valor |
|---|---|
| Status | **PAUSADO** |
| Ratio | 17:1 (1 POL = 17 CAS) |
| Reserva CAS | 106.457,06 CAS |
| Reserva POL | 1,80 POL |
| Swap fee | 0 bps |

### DEXs V2 — 4 pares ativos

| DEX | CAS Reserva | POL/OTHER | Preço (CAS/POL) | LP Deployer |
|---|---|---|---|---|
| SushiSwap | 7.258,82 CAS | 73,60 POL | 98,62 | 0,0 |
| Dfyn | 149,66 CAS | 1,87 WETH | 80,02 | 0,0 |
| ApeSwap | 141,74 CAS | 1,57 POL | 90,44 | 0,0 |
| QuickSwap | 55,68 CAS | 0,83 POL | 67,24 | 0,0 |
| **Total** | **7.605,90 CAS** | **~77,57 POL** | — | — |

### Uniswap V3

- **0 pools** — sem liquidez concentrada

### Saldos

| Carteira | POL | CAS |
|---|---|---|
| Deployer | 2,12 POL | 50.013,36 CAS |
| InfrastructureFund | 10,12 POL | 100.101,00 CAS |

### Problemas Críticos

1. **Dispersão de preços**: 67 a 98 CAS/POL entre DEXs — arbitragem não executada
2. **Deployer sem LP**: 0 LP tokens em todos os 4 pares — não há como drenar
3. **CASSwap desequilibrado**: 106.457 CAS vs 1,80 POL — sem liquidez para venda
4. **POL total escasso**: ~12,24 POL no ecossistema (~$5-6 USD)
5. **Sem presença V3**: Perdendo capital efficiency de liquidez concentrada
6. **Liquidez rala**: ~114K CAS total mas apenas ~79 POL reais compráveis

---

## Fase 1: Reativar e Reequilibrar Diamond Swap (Prioridade: Crítica)

### Objetivo

Restaurar o swap nativo CAS↔POL/USDC via Diamond (`CASSwapUSDCPOLFacet`)
como canal principal de descoberta de preço, garantindo reservas
equilibradas e ratio realista baseado no preço alvo CAS = $0.0005.

> **CASSwap standalone está deprecated.** Todo swap agora usa o Diamond.
> Não depositar USDC — CAS gera USDC naturalmente via `sellCASForUSDC`.

### Pré-requisito

- **Capital alocado**: 50 POL para reserva do Diamond swap
- **Aporte total**: 200 POL confirmado pelo deployer
- **Janela**: Imediata (1-3 dias)

### Passos

#### 1.1. Depositar POL no Diamond

```bash
POL_DEPOSIT_AMOUNT=50 npx hardhat run scripts/casswap/17_deposit_pol_to_diamond.ts --network polygon
```

**Script**: `@/home/carlosdelfino/workspace/Rapport/AgenticSpace/smartcontracts/scripts/casswap/17_deposit_pol_to_diamond.ts`

> O POL é transferido diretamente para o `DIAMOND_ADDRESS`.
> O facet `CASSwapUSDCPOLFacet` usa `address(this).balance` como reserva.

#### 1.2. Configurar ratio do Diamond com preço alvo

O ratio é calculado dinamicamente usando o preço Chainlink POL/USD e o
preço alvo CAS = $0.0005. Com POL ≈ $0.15, o ratio POL é ~300:1.

```bash
npx hardhat run scripts/casswap/19_set_diamond_ratio_target.ts --network polygon
```

**Script**: `@/home/carlosdelfino/workspace/Rapport/AgenticSpace/smartcontracts/scripts/casswap/19_set_diamond_ratio_target.ts`

O script define:
- `setSwapRatio()` — ratio POL buy (ex: 300000/1000 = 300 CAS por POL)
- `setSwapRatioUSDC()` — ratio USDC buy (ex: 2000000000/1000000 = 2000 CAS por USDC)
- `setSwapRatioSell()` — ratio POL sell com spread 5%
- `setSwapRatioUSDCSell()` — ratio USDC sell com spread 5%

#### 1.3. Validar estado pós-reativação

```bash
npx hardhat run scripts/casswap/01_check_casswap_state.ts --network polygon
```

### Critério de Sucesso

- Diamond com reserva POL >= 50 POL
- Ratio POL alinhado ao preço alvo (300:1 ±10%)
- Ratio USDC alinhado ao preço alvo (2000:1 ±10%)
- Sell ratios com spread 5% aplicado
- `buyCASWithPOL` e `sellCASForPOL` funcionando via Diamond

---

## Fase 2: Consolidar Liquidez DEX (Prioridade: Alta)

### Objetivo

Reduzir de 4 DEXs dispersos para 2 DEXs principais (SushiSwap + QuickSwap),
concentrando liquidez e unificando o preço.

### Contexto

O deployer **não possui LP tokens** em nenhum par. A liquidez nos 4 DEXs foi
criada por terceiros ou em transações anteriores onde o LP foi transferido/
queimado. A estratégia é:

1. **Não tentar drenar** (impossível sem LP)
2. **Adicionar nova liquidez concentrada** nos 2 DEXs escolhidos
3. **Deixar os pares menores morrerem** naturalmente (sem nova liquidez)

### DEXs Selecionados

| DEX | Motivo | Par |
|---|---|---|
| **SushiSwap** | Maior reserva atual (7.259 CAS), boa visibilidade | CAS/WPOL |
| **QuickSwap** | Maior DEX da Polygon por volume, boa para novos LPs | CAS/WPOL |

### Passos

#### 2.1. Adicionar liquidez no SushiSwap

```bash
CAS_LIQUIDITY_AMOUNT=5000 POL_LIQUIDITY_AMOUNT=50 \
  DEX_ROUTER_ADDRESS=0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506 \
  npx hardhat run scripts/deploy/04_add_dex_liquidity.ts --network polygon
```

**Script**: `@/home/carlosdelfino/workspace/Rapport/AgenticSpace/smartcontracts/scripts/deploy/04_add_dex_liquidity.ts`

#### 2.2. Adicionar liquidez no QuickSwap

```bash
CAS_LIQUIDITY_AMOUNT=2000 POL_LIQUIDITY_AMOUNT=20 \
  DEX_ROUTER_ADDRESS=0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff \
  npx hardhat run scripts/deploy/04_add_dex_liquidity.ts --network polygon
```

#### 2.3. Lockar LP tokens

```bash
npx hardhat run scripts/casswap/14_transfer_lp_to_lock.ts --network polygon
```

**Script**: `@/home/carlosdelfino/workspace/Rapport/AgenticSpace/smartcontracts/scripts/casswap/14_transfer_lp_to_lock.ts`

#### 2.4. Abandonar Dfyn e ApeSwap

- Não adicionar nova liquidez
- Os pares continuarão existindo com liquidez residual (~291 CAS total)
- Eventualmente serão irrelevantes frente aos pares principais

### Capital Necessário

| Item | CAS | POL |
|---|---|---|
| SushiSwap LP | 21.000 CAS | 70 POL |
| QuickSwap LP | 9.000 CAS | 30 POL |
| **Total** | **30.000 CAS** | **100 POL** |

> CAS disponível: 50.013 no deployer + 100.101 no InfraFund
> POL necessário: 70 POL (aporte externo + InfraFund)

### Critério de Sucesso

- SushiSwap: reserva CAS >= 12.000 CAS
- QuickSwap: reserva CAS >= 2.000 CAS
- Preço SushiSwap ≈ Preço QuickSwap (±5%)
- LP tokens lockados por 365 dias

---

## Fase 3: Criar Pool Uniswap V3 (Prioridade: Média)

### Objetivo

Estabelecer uma posição de liquidez concentrada no Uniswap V3 para
maximizar capital efficiency e visibilidade no maior DEX da Polygon.

### Configuração

| Parâmetro | Valor | Motivo |
|---|---|---|
| Fee tier | 3000 (0,3%) | Padrão para pairs não-stable |
| Tick lower | -10% do preço atual | Bandas moderadas |
| Tick upper | +10% do preço atual | Bandas moderadas |
| CAS amount | 6.000 CAS | Capital eficiente com V3 |
| POL amount | 20 POL | Equivalente ao preço alvo |

### Passos

#### 3.1. Criar pool V3 (se não existir)

> Requer interação com o NonfungiblePositionManager:
> `0xC36442b4a4522E871399CD717aBDD847Ab11FE88`

Criar pool via `createAndInitializeData` ou usar script dedicado.

#### 3.2. Mintar posição LP concentrada

> Requer chamada a `mint()` no PositionManager com:
> - token0 = WPOL
> - token1 = CAS
> - fee = 3000
> - tickLower / tickUpper calculados a partir do preço atual
> - amount0Desired / amount1Desired

#### 3.3. Atualizar .env

```env
UNIV3_POOL_ADDRESS=<endereço da pool criada>
UNIV3_NFT_TOKEN_ID=<ID da posição NFT>
```

### Script

```bash
UNIV3_POL_AMOUNT=20 npx hardhat run scripts/deploy/05_add_uniswap_v3_liquidity.ts --network polygon
```

**Script**: `@/home/carlosdelfino/workspace/Rapport/AgenticSpace/smartcontracts/scripts/deploy/05_add_uniswap_v3_liquidity.ts`

O script:
1. Verifica/cria pool V3 com fee 3000
2. Inicializa com sqrtPriceX96 calculado do preço alvo (Chainlink)
3. Mintar posição com tick range ±10%
4. Salvar pool address e NFT ID no .env

### Critério de Sucesso

- Pool V3 criada e com liquidez ativa
- Posição NFT mintada e visível no Uniswap UI
- DexScreener e GeckoTerminal indexam a pool V3
- Liquidez V3 >= 3.000 CAS equivalente

---

## Fase 4: Buyback/Burn + Market Making (Prioridade: Média)

### Objetivo

Implementar mecanismos automáticos de suporte de preço e deflação do token.

### 4.1. Buyback & Burn (UUPS Upgradeable)

#### Mecanismo

- Contrato UUPS upgradeable (`BuybackBurn.sol`) que recebe POL e compra CAS na DEX
- CAS comprado é queimado via `burn()` (reduz supply)
- Parametros ajustaveis: router, slippage, min amount
- Upgrade UUPS permite evolução futura da logica

#### Configuração

| Parâmetro | Valor |
|---|---|
| Modo inicial | Manual (OPERATOR_ROLE) |
| POL mínimo por execução | 5 POL |
| Slippage tolerance | 50 bps (0,5%) |
| Max slippage | 500 bps (5%) |
| DEX alvo | SushiSwap (maior liquidez) |
| POL alocado | 17 POL |

#### Deploy

```bash
npm run deploy:buyback:polygon
```

**Script**: `@/home/carlosdelfino/workspace/Rapport/AgenticSpace/smartcontracts/scripts/deploy/09_deploy_buyback_burn.ts`

#### Executar Buyback

```bash
npm run buyback:execute:polygon
```

**Script**: `@/home/carlosdelfino/workspace/Rapport/AgenticSpace/smartcontracts/scripts/casswap/18_execute_buyback.ts`

#### .env

```env
BUYBACK_BURN_ADDRESS=<endereço do proxy UUPS>
BUYBACK_DEX_ROUTER=0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506
BUYBACK_SLIPPAGE_BPS=50
BUYBACK_MIN_AMOUNT=5
```

#### Roles

| Role | Permissão |
|---|---|
| `DEFAULT_ADMIN_ROLE` | Upgrade UUPS, gerenciar roles |
| `OPERATOR_ROLE` | Executar buyback, ajustar router/slippage/min |
| `PAUSER_ROLE` | Pausar/despausar |
| `TREASURER_ROLE` | Sacar POL em emergência |

### 4.2. Market Making Automatizado

#### Estratégia

- **Bot arbitragem**: Monitora preço CASSwap vs DEXs, executa arbitragem
  quando desvio > 2%
- **Rebalanceamento periódico**: Script cron que verifica reservas e
  reequilibra via swap ou adição de liquidez

#### Script de Monitoramento

```bash
npx hardhat run scripts/casswap/03_monitor_casswap_dex.ts --network polygon
```

**Script**: `@/home/carlosdelfino/workspace/Rapport/AgenticSpace/smartcontracts/scripts/casswap/03_monitor_casswap_dex.ts`

#### Script de Restauração de Ratio

```bash
npx hardhat run scripts/casswap/07_check_and_restore_ratio.ts --network polygon
```

**Script**: `@/home/carlosdelfino/workspace/Rapport/AgenticSpace/smartcontracts/scripts/casswap/07_check_and_restore_ratio.ts`

#### Automação (systemd timer)

> Criar timer systemd que executa o monitoramento a cada 1 hora:
> - `agentic-liquidity-monitor.service`
> - `agentic-liquidity-monitor.timer`

### 4.3. Incentivos de Liquidez

#### Programa de Rewards

- Recompensar LPs em SushiSwap com CAS bonus proporcional ao volume
- Usar `06_redistribute_cas.ts` para distribuir CAS promocional:

```bash
npx hardhat run scripts/casswap/06_redistribute_cas.ts --network polygon
```

**Script**: `@/home/carlosdelfino/workspace/Rapport/AgenticSpace/smartcontracts/scripts/casswap/06_redistribute_cas.ts`

### Critério de Sucesso

- BuybackBurn deployado e operacional (modo manual)
- Monitoramento automatizado rodando a cada 1h
- Arbitragem CASSwap↔DEX executada quando desvio > 2%
- Programa de rewards ativo com pelo menos 5.000 CAS alocados

---

## Resumo de Capital Necessário

| Fase | CAS | POL | USD (est.) |
|---|---|---|---|
| Fase 1: Diamond Swap | 0 | 50 POL | ~$7,5 |
| Fase 2: DEXs V2 | 30.000 CAS | 100 POL | ~$15 |
| Fase 3: Uniswap V3 | 6.000 CAS | 20 POL | ~$3 |
| Fase 4: BuybackBurn | 0 | 17 POL | ~$2,5 |
| Gas reserve | 0 | 3 POL | ~$0,5 |
| Deployer reserve | 0 | 10 POL | ~$1,5 |
| **Total** | **36.000 CAS** | **200 POL** | **~$30** |

### Fontes de CAS

| Fonte | CAS Disponível |
|---|---|
| Deployer | 50.013 CAS |
| InfrastructureFund | 100.101 CAS |
| CASSwap (existente) | 106.457 CAS |
| **Total** | **256.571 CAS** |

> CAS é abundante (256K disponível vs 15K necessário = 6% do supply).

### Fontes de POL

| Fonte | POL Disponível |
|---|---|
| Deployer | 2,12 POL |
| InfrastructureFund | 10,12 POL |
| CASSwap | 1,80 POL |
| **Total existente** | **14,04 POL** |
| **Necessário** | **150 POL** |
| **Déficit** | **~136 POL (~$70-80 USD)** |

> **POL é o gargalo crítico.** É necessário um aporte externo de ~136 POL
> (~$70-80 USD) para executar o plano completo.

---

## Scripts de Verificação Contínua

| Script | Comando | Frequência |
|---|---|---|
| Snapshot liquidez | `npm run snapshot:liquidity:polygon` | Diário |
| Scan DEX | `npm run scan:dex:polygon` | Diário |
| Check CASSwap | `npx hardhat run scripts/casswap/01_check_casswap_state.ts --network polygon` | A cada operação |
| Monitor DEX | `npx hardhat run scripts/casswap/03_monitor_casswap_dex.ts --network polygon` | Horário (automatizado) |
| Restore ratio | `npx hardhat run scripts/casswap/07_check_and_restore_ratio.ts --network polygon` | Sob demanda |

---

## Cronograma

| Fase | Duração | Dependência |
|---|---|---|
| Fase 1 | 1-3 dias | Aporte de 50 POL |
| Fase 2 | 3-7 dias | Aporte de 70 POL + Fase 1 concluída |
| Fase 3 | 7-14 dias | Fase 2 concluída + 30 POL |
| Fase 4 | 14-30 dias | Fases 1-3 concluídas |

> **Marco crítico**: Obter 150 POL de aporte externo antes de iniciar.

---

## Riscos e Mitigações

| Risco | Impacto | Mitigação |
|---|---|---|
| POL não disponível | Bloqueia todas as fases | Priorizar Fase 1 com 50 POL mínimo |
| Arbitragem predatória pós-unpause | Drenagem de reservas | Ajustar ratio antes de unpause + fee 50 bps |
| Preço despenca após unpause | Perda de confiança | Comunicar comunidade antes, fazer em horário de baixo volume |
| Liquidez V3 fora de range | Capital parado | Monitorar e reajustar ticks semanalmente |
| Buyback gasta todo POL | Sem gas para operações | Limitar a 10 POL por execução, modo manual |

## Changelog

| Data | Versão | Descrição |
|---|---|---|
| 2026-08-02 | 1.0.0 | Plano inicial — diagnóstico + 4 fases |
| 2026-08-02 | 2.0.0 | Diamond swap substitui CASSwap standalone; BuybackBurn UUPS implementado; 200 POL alocado; preço alvo $0.0005 |

![footer](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=100&section=footer&animation=twinkling)
