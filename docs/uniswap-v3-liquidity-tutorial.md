---
tags:
  - uniswap
  - v3
  - liquidez
  - tutorial
  - polygon
---

![header](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=200&section=header&text=Uniswap%20V3%20Liquidity%20Tutorial&fontSize=36&fontAlignY=35&animation=twinkling)

![visitors](https://visitor-badge.laobi.icu/badge?page_id=RapportTecnologia.AgenticSpace.smartcontracts_uniswap-v3-liquidity-tutorial)
[![License: CC BY-SA 4.0](https://img.shields.io/badge/License-CC_BY--SA_4.0-blue.svg)](https://creativecommons.org/licenses/by-sa/4.0/)
![Language: Portuguese](https://img.shields.io/badge/Language-Portuguese-brightgreen.svg)
![Status](https://img.shields.io/badge/Status-Ongoing-yellow)
[![GitHub Issues](https://img.shields.io/github/issues/RapportTecnologia/AgenticSpace)](https://github.com/RapportTecnologia/AgenticSpace/issues)

# Tutorial: Liquidez Uniswap V3 (CAS/WPOL) na Polygon

Guia passo-a-passo para criar, monitorar e rebalancear uma posição de liquidez concentrada Uniswap V3 para o par CAS/WPOL na Polygon mainnet.

## Sumário

- [Pré-requisitos](#pré-requisitos)
- [Visão Geral do Fluxo](#visão-geral-do-fluxo)
- [Passo 1: Configurar Variáveis de Ambiente](#passo-1-configurar-variáveis-de-ambiente)
- [Passo 2: Configurar Ratios do Diamond Swap](#passo-2-configurar-ratios-do-diamond-swap)
- [Passo 3: Depositar POL no Diamond](#passo-3-depositar-pol-no-diamond)
- [Passo 4: Deploy BuybackBurn](#passo-4-deploy-buybackburn)
- [Passo 5: Executar Buyback](#passo-5-executar-buyback)
- [Passo 6: Adicionar Liquidez Uniswap V3](#passo-6-adicionar-liquidez-uniswap-v3)
- [Passo 7: Monitorar Posição V3](#passo-7-monitorar-posição-v3)
- [Passo 8: Rebalancear Posição V3](#passo-8-rebalancear-posição-v3)
- [Automação com systemd](#automação-com-systemd)
- [Troubleshooting](#troubleshooting)

---

## Pré-requisitos

- Node.js 20+ e npm
- Hardhat configurado com `hardhat-ethers` e rede Polygon
- Saldo suficiente de POL no relayer (owner do Diamond): ~50 POL para gas + liquidez
- Saldo de CAS tokens no deployer
- Variáveis de ambiente no `.env` (ver [Passo 1](#passo-1-configurar-variáveis-de-ambiente))

### Endereços Importantes (Polygon Mainnet)

| Contrato | Endereço |
|---|---|
| Uniswap V3 Factory | `0x1F98431c8aD98523631AE4a59f267346ea31F984` |
| NonfungiblePositionManager | `0xC36442b4a4522E871399CD717aBDD847Ab11FE88` |
| WPOL (Wrapped POL) | `0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270` |
| Chainlink POL/USD Feed | `0xAB594600376Ec9fD91F8e885dADF0CE036862dE0` |
| CAS Token | `0x5151A34EaC7bA08cd6B540b32cD30316218A2287` |

### Carteiras

| Papel | Endereço | Função |
|---|---|---|
| Deployer | `0x66682BBeD9e540017967692cCdd069fE5F833888` | Detém CAS tokens, assina deploy |
| Relayer (Owner) | `0x8950dD90B86D72e3F03A6d47Fb25B92808d40c7a` | Owner do Diamond, assina setSwapRatio |

---

## Visão Geral do Fluxo

```
1. Configurar .env
2. setSwapRatio (Diamond)     → define preço CAS/POL e CAS/USDC
3. Deposit POL (Diamond)      → fornece liquidez para swap
4. Deploy BuybackBurn         → contrato de buyback e queima
5. Execute Buyback            → compra CAS e queima
6. Add Liquidity V3           → cria pool e posição concentrada
7. Monitor V3                 → verifica saúde da posição
8. Rebalance V3               → ajusta range se necessário
```

---

## Passo 1: Configurar Variáveis de Ambiente

Certifique-se de que o `.env` contém:

```bash
# Diamond
DIAMOND_ADDRESS=<seu_diamond_address>

# Chainlink
CHAINLINK_POL_USD_FEED=0xAB594600376Ec9fD91F8e885dADF0CE036862dE0

# CAS Token
CAS_TOKEN_ADDRESS=0x5151A34EaC7bA08cd6B540b32cD30316218A2287

# Relayer (owner do Diamond)
RELAYER_PRIVATE_KEY=<sua_chave_privada>

# Uniswap V3
UNIV3_FEE_TIER=3000
UNIV3_POL_AMOUNT=20
UNIV3_TICK_RANGE_PERCENT=10
UNIV3_POOL_ADDRESS=        # preencher após Passo 6
UNIV3_NFT_TOKEN_ID=        # preencher após Passo 6

# Liquidity Recovery
CAS_PRICE_USD=0.0005
SELL_SPREAD_BPS=2000       # 20% spread de sell
```

> **Segurança:** Nunca versione o `.env` com chaves reais. Use `.env.example` apenas com placeholders.

---

## Passo 2: Configurar Ratios do Diamond Swap

O Diamond Swap precisa ter os ratios configurados para que os usuários possam trocar POL/USDC por CAS a um preço alvo.

```bash
npm run diamond:set-ratio:polygon
```

### O que o script faz:

1. **Verifica controle de acesso** — confirma que o signer é owner ou tem `RATIO_SETTER_ROLE`
2. **Consulta Chainlink POL/USD** — obtém preço atual do POL
3. **Calcula ratios** — baseado em `CAS_PRICE_USD=0.0005`:
   - **POL buy ratio**: `casPerPol = polPriceUsd / casPriceUsd` (18 decimais)
   - **USDC buy ratio**: `casPerUsdc = 1 / casPriceUsd` (12 decimais)
   - **Sell ratios**: aplica spread de 20% (`sellNum = buyNum * 8000 / 10000`)
4. **Envia 4 transações**: `setSwapRatio`, `setSwapRatioUSDC`, `setSwapRatioSell`, `setSwapRatioUSDCSell`
5. **Verifica estado final**

### Exemplo de output:

```
POL buy ratio:  145942540000000008149/1000000000000000000
USDC buy ratio: 2000000000000000/1
POL sell ratio: 116754032000000006519/1000000000000000000
USDC sell ratio:1600000000000000/1
```

### Formato dos Ratios

O contrato `CASSwapUSDCPOLFacet` armazena ratios como `uint256 numerator / uint256 denominator`:

- **POL ratio**: 18 decimais (usa `ethers.parseEther`)
  - Ex: 145.94 CAS/POL → `num = 145942540000000008149, den = 1000000000000000000`
- **USDC ratio**: 12 decimais (CAS tem 18, USDC tem 6)
  - Ex: 2000 CAS/USDC → `num = 2000000000000000, den = 1`

---

## Passo 3: Depositar POL no Diamond

Para que o Diamond Swap possa vender CAS em troca de POL, é necessário depositar POL no contrato:

```bash
npm run diamond:deposit-pol:polygon
```

---

## Passo 4: Deploy BuybackBurn

O contrato BuybackBurn compra CAS no DEX e queima os tokens, reduzindo a oferta circulante:

```bash
npm run deploy:buyback:polygon
```

Após o deploy, atualize `BUYBACK_BURN_ADDRESS` no `.env`.

---

## Passo 5: Executar Buyback

```bash
npm run buyback:execute:polygon
```

O script usa o Chainlink para obter o preço do POL, calcula quanto CAS comprar e executa a swap + burn.

---

## Passo 6: Adicionar Liquidez Uniswap V3

```bash
npm run deploy:v3:polygon
```

### O que o script faz:

1. **Consulta Chainlink** para preço atual do POL
2. **Calcula preço CAS/POL** baseado em `CAS_PRICE_USD`
3. **Determina ordenação de tokens** (token0 < token1 por endereço)
4. **Calcula ticks** baseado no preço e fee tier (3000 = 0.3%)
5. **Cria pool V3** se não existir (via `UniswapV3Factory.createPool`)
6. **Inicializa pool** com `sqrtPriceX96` se `sqrtPriceX96 == 0`
7. **Aprova CAS e WPOL** para o PositionManager
8. **Faz wrap de POL → WPOL** (`WPOL.deposit`)
9. **Minta posição NFT** com `PositionManager.mint`
10. **Extrai tokenId** do evento `IncreaseLiquidity`

### Parâmetros configuráveis:

| Variável | Default | Descrição |
|---|---|---|
| `UNIV3_FEE_TIER` | 3000 | Fee tier (500=0.05%, 3000=0.3%, 10000=1%) |
| `UNIV3_POL_AMOUNT` | 20 | Quantidade de POL para liquidez |
| `UNIV3_TICK_RANGE_PERCENT` | 10 | Range +/- em torno do tick atual |

### Após executar:

O script exibirá o `UNIV3_POOL_ADDRESS` e `UNIV3_NFT_TOKEN_ID`. Atualize o `.env`:

```bash
UNIV3_POOL_ADDRESS=0x2a37bcA556c39418B779901f9b2988414Ee550Dc
UNIV3_NFT_TOKEN_ID=<token_id_do_nft>
```

---

## Passo 7: Monitorar Posição V3

```bash
npm run v3:monitor:polygon
```

### O que o script verifica:

1. **Estado da pool** — `sqrtPriceX96`, `tick`, `liquidity`
2. **Estado da posição** — `tickLower`, `tickUpper`, `liquidity`, fees acumulados
3. **Verifica se está em range** — `currentTick` dentro de `[tickLower, tickUpper]`
4. **Calcula utilização** — distância do tick atual em relação ao centro do range
5. **Estima valor da posição** — baseado em CAS e WPOL alocados
6. **Recomendações**:
   - ✓ Posição saudável (utilização < 70%)
   - ⚠ Atenção (utilização > 70%, considerar rebalanceamento)
   - ⚠ Fora de range (rebalanceamento imediato)

### Exemplo de output:

```
Pool:              0x2a37bcA556c39418B779901f9b2988414Ee550Dc
Token ID:          123
Preco atual:       1 WPOL = 145.94 CAS
Tick atual:        49843
Range:             [44820, 54840]
Em range:          SIM
Utilizacao:        15% do centro
✓ Posicao saudavel e dentro do range.
```

### Frequência recomendada:

- **Semanal** em condições normais
- **Diária** em períodos de alta volatilidade
- **Imediata** após movimentações de preço > 5%

---

## Passo 8: Rebalancear Posição V3

Quando o preço sai do range ou se aproxima dos limites, execute o rebalanceamento:

```bash
npm run v3:rebalance:polygon
```

### O que o script faz:

1. **Consulta Chainlink** para preço atual
2. **Calcula novo range de ticks** baseado no preço atual
3. **Verifica se rebalanceamento é necessário** (se tick range já está ideal, aborta)
4. **Remove liquidez** — `decreaseLiquidity` (retira toda a liquidez)
5. **Coleta tokens e fees** — `collect` (recebe CAS + WPOL + fees acumulados)
6. **Re-aprova tokens** para o PositionManager
7. **Adiciona liquidez no novo range** — `increaseLiquidity`
8. **Verifica estado final**

### Quando rebalancear:

| Condição | Ação |
|---|---|
| Preço fora do range | Rebalanceamento imediato |
| Utilização > 70% | Rebalanceamento em breve |
| Fees acumulados significativos | Coletar fees (monitor) |
| Mudança de estratégia de preço | Reconfigurar range |

> **Custo:** Cada rebalanceamento custa ~0.05-0.10 POL em gas. Evite rebalanceamentos frequentes desnecessários.

---

## Automação com systemd

Para monitoramento automático, crie um timer systemd:

### `/etc/systemd/system/rapport-v3-monitor.service`

```ini
[Unit]
Description=Rapport V3 Position Monitor
After=network-online.target

[Service]
Type=oneshot
User=carlosdelfino
WorkingDirectory=/home/carlosdelfino/workspace/Rapport/AgenticSpace/smartcontracts
Environment=NODE_ENV=production
ExecStart=/usr/bin/npm run v3:monitor:polygon
StandardOutput=journal
StandardError=journal
```

### `/etc/systemd/system/rapport-v3-monitor.timer`

```ini
[Unit]
Description=Run V3 monitor daily

[Timer]
OnCalendar=daily
Persistent=true

[Install]
WantedBy=timers.target
```

### Ativar:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now rapport-v3-monitor.timer
```

### Verificar:

```bash
systemctl list-timers rapport-v3-monitor
journalctl -u rapport-v3-monitor -f
```

---

## Troubleshooting

### `execution reverted` ao chamar `setSwapRatio`

**Causa:** O signer não é owner nem tem `RATIO_SETTER_ROLE`.

**Solução:** O script usa `RELAYER_PRIVATE_KEY` (owner do Diamond). Verifique se a chave está correta no `.env`.

### `execution reverted: LOK` ao mintar posição V3

**Causa:** A pool não foi inicializada (`sqrtPriceX96 == 0`).

**Solução:** O script detecta pools não-inicializadas e chama `initialize` automaticamente. Se o erro persistir, verifique se a pool address está correta.

### `Cannot mix BigInt and other types`

**Causa:** ethers v6 retorna `bigint` de chamadas de contrato, que não pode ser misturado com `number` em operações aritméticas.

**Solução:** Converter explicitamente: `Number(await contract.decimals())` ou `BigInt(value)`.

### `Do not know how to serialize a BigInt`

**Causa:** `JSON.stringify` não suporta `BigInt`.

**Solução:** Converter para `String` ou `Number` antes de passar para funções de log: `value.toString()` ou `Number(value)`.

### `bad address checksum`

**Causa:** ethers v6 valida checksum de endereços mixed-case.

**Solução:** Usar endereços em lowercase ou `ethers.getAddress()` com checksum válido.

### Pool já existe mas não foi inicializada

**Causa:** A criação da pool foi bem-sucedida mas a inicialização falhou (ex: erro anterior no script).

**Solução:** O script verifica `sqrtPriceX96 == 0` e inicializa automaticamente. Basta rodar `npm run deploy:v3:polygon` novamente.

---

## Arquivos Relacionados

| Arquivo | Descrição |
|---|---|
| `scripts/casswap/19_set_diamond_ratio_target.ts` | Configura ratios do Diamond Swap |
| `scripts/casswap/17_deposit_pol_to_diamond.ts` | Deposita POL no Diamond |
| `scripts/deploy/09_deploy_buyback_burn.ts` | Deploy do BuybackBurn |
| `scripts/casswap/18_execute_buyback.ts` | Executa buyback e queima |
| `scripts/deploy/05_add_uniswap_v3_liquidity.ts` | Cria pool e posição V3 |
| `scripts/deploy/06_monitor_v3_position.ts` | Monitora posição V3 |
| `scripts/deploy/07_rebalance_v3_position.ts` | Rebalanceia posição V3 |
| `contracts/facets/CASSwapUSDCPOLFacet.sol` | Facet do Diamond para swaps |

---

## Changelog

| Data | Versão | Descrição |
|---|---|---|
| 2026-08-03 | 0.1.0 | Tutorial inicial com scripts de deploy, monitoramento e rebalanceamento V3 |

![footer](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=100&section=footer&animation=twinkling)
