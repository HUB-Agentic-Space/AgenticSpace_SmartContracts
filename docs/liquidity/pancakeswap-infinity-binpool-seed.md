---
tags:
  - liquidity
  - pancakeswap-infinity
  - layerzero
  - bsc
  - cas
---

# Seed de Liquidez PancakeSwap Infinity — BinPool CAS/BNB (BSC)

Documento operacional do processo cross-chain de liquidez do CAS na
**BNB Smart Chain**: bridge via **LayerZero OFT** (lock na Polygon →
mint/burn na BSC) e seed de um **BinPool CAS/BNB** na PancakeSwap
Infinity ao **preço médio em USD dos pools CAS vigentes na Polygon**
(mesma metodologia do `21_balance_dex_prices.ts` / seed Uniswap V4).

Issue relacionada: `HUB-Agentic-Space/AgenticSpace_SmartContracts#16`.

## Arquitetura

```
Polygon PoS (137)                    LayerZero V2                BNB Chain (56)
┌─────────────────────┐              ┌───────────┐              ┌──────────────────┐
│ CASToken (UUPS)     │  approve+send│ EndpointV2│  lzReceive   │ CASOFT (ERC-20)  │
│ 0x5151…2287         ├─────────────►│ 0x1a44…728c├─────────────►│ mint/burn        │
│ CASOFTAdapter (lock)│              │ DVN+Exec  │              │                  │
└─────────────────────┘              └───────────┘              └────────┬─────────┘
                                                                       │ Permit2
                                                              ┌────────▼─────────┐
                                                              │ BinPositionManager│
                                                              │ 0x3D31…2850       │
                                                              │ BinPool CAS/BNB   │
                                                              └──────────────────┘
```

- **CASOFTAdapter** (`contracts/bridge/CASOFTAdapter.sol`): trava o CASToken
  UUPS existente na Polygon e libera na volta. 1:1 lossless.
- **CASOFT** (`contracts/bridge/CASOFT.sol`): representação omnichain do CAS
  na BSC (ERC-20 mint/burn exclusivo do EndpointV2). Sem roles de
  freeze/votingLock — é o ativo negociável nos DEXs da BSC.
- **Pool BinPool** (Liquidity Book da PancakeSwap Infinity): `currency0 =
  BNB nativo (address 0)`, `currency1 = CASOFT`, `fee = BIN_FEE`,
  `parameters = binStep<<16`. Liquidez mintada como ERC-1155 no
  BinPositionManager.

## Scripts

| Script | Rede | O que faz |
|---|---|---|
| `55_deploy_cas_oftadapter_polygon.ts` | polygon | Deploy do CASOFTAdapter apontando para o CASToken existente. |
| `56_deploy_cas_oft_bsc.ts` | bsc | Deploy do CASOFT + `setPeer` bidirecional (BSC e Polygon via segundo provider). |
| `57_mint_bridge_cas_bsc.ts` | polygon | **Mint opcional** (respeita `MAX_SUPPLY`/pausa/`MINTER_ROLE`) + `send` LZ com `quoteSend`; polling do LayerZero Scan até `DELIVERED`; confere saldo CASOFT na BSC. |
| `58_seed_pancakeswap_binpool_bsc.ts` | bsc | Média CAS/USD (Polygon) + BNB/USD (Chainlink BSC) → `activeId`; `initializePool` (idempotente); approves Permit2; `modifyLiquidities` com `[BIN_ADD_LIQUIDITY, CLOSE×2, SWEEP]`. |

## Modos de operação (independentes)

O processo é deliberadamente desacoplado — cada etapa pode rodar sozinha:

| Objetivo | Configuração |
|---|---|
| Só mint na Polygon (abastecer deployer) | `BRIDGE_MINT_ENABLED=true BRIDGE_SEND_ENABLED=false` + script 57 |
| Só bridge (usar CAS já existente) | `BRIDGE_MINT_ENABLED=false BRIDGE_SEND_ENABLED=true` + script 57 |
| Mint + bridge completo | ambos `true` + script 57 |
| Só preencher o pool (CASOFT já na BSC) | script 58 diretamente |

## Preço médio (metodologia)

`scripts/utils/cas_price_feed.ts` reproduz a média do
`21_balance_dex_prices.ts`:

1. **Pares V2** (QuickSwap, SushiSwap, ApeSwap, Dfyn via `*_LP_TOKEN_ADDRESS`)
   — preço spot = reserva da contraparte / reserva CAS.
2. **Uniswap V3** — melhor `quoteExactInputSingle(WPOL→CAS, 1 WPOL)` nas fee
   tiers 100/500/3000/10000.
3. Cada fonte vira **CAS/USD** via Chainlink (POL/USD, ETH/USD; stablecoins ≈
   $1); a média é a **média aritmética simples** das fontes com liquidez.
4. **Fallback fail-closed**: sem liquidez em nenhuma fonte, usa
   `CAS_WPOL_PRICE` (se numérico) × POL/USD, senão `CAS_PRICE_USD` — e marca
   `source="env-fallback"` com WARN.
5. **CAS por BNB** = `BNB_USD / CAS_USD` → `activeId = 2²³ +
   round(ln(preço)/ln(1+BIN_STEP/10000))` (`idFromPrice` em
   `binpool_math.ts`).

## Variáveis de ambiente

Bridge (Polygon):
`CAS_OFT_ADAPTER_POLYGON`, `LZ_ENDPOINT`, `LZ_EID_BSC`,
`OFT_DELEGATE_ADDRESS`, `BRIDGE_MINT_ENABLED`, `BRIDGE_MINT_AMOUNT`,
`BRIDGE_SEND_ENABLED`, `BRIDGE_CAS_AMOUNT`, `LZ_RECEIVE_GAS`,
`BRIDGE_EXECUTE` (dry-run por padrão).

BSC/Pool:
`BSC_RPC_URL`, `BSC_PRIVATE_KEY` (vazio = `POLYGON_PRIVATE_KEY`),
`CAS_OFT_BSC`, `PANCAKE_BIN_POOL_MANAGER`, `PANCAKE_BIN_POSITION_MANAGER`,
`BSC_PERMIT2`, `CHAINLINK_BNB_USD_FEED`, `BIN_STEP`, `BIN_RANGE_BINS`,
`BIN_FEE`, `SEED_CAS_AMOUNT`, `SEED_BNB_AMOUNT` (`auto` ou fixo),
`SEED_ID_SLIPPAGE`, `SEED_SLIPPAGE_BPS`, `SEED_EXECUTE` (dry-run por
padrão).

> **Nota sobre DRY_RUN**: os scripts 57/58 **não** usam o `DRY_RUN` global
> do `.env` (que já está `false` para o publisher de ratio). A execução
> real exige `BRIDGE_EXECUTE=true` / `SEED_EXECUTE=true` — dry-run é o
> padrão e imprime a tabela de provisionamento sem enviar nenhuma tx.

## Execução (ordem)

```bash
# 1. Deploy adapter na Polygon
npx hardhat run scripts/deploy/55_deploy_cas_oftadapter_polygon.ts --network polygon
#    → preencher CAS_OFT_ADAPTER_POLYGON no .env

# 2. Deploy OFT na BSC + wiring setPeer bidirecional
npx hardhat run scripts/deploy/56_deploy_cas_oft_bsc.ts --network bsc
#    → preencher CAS_OFT_BSC no .env

# 3. Mint 500k CAS + bridge (dry-run por padrão)
npx hardhat run scripts/deploy/57_mint_bridge_cas_bsc.ts --network polygon
BRIDGE_EXECUTE=true npx hardhat run scripts/deploy/57_mint_bridge_cas_bsc.ts --network polygon

# 4. Seed do BinPool CAS/BNB (dry-run por padrão)
npx hardhat run scripts/deploy/58_seed_pancakeswap_binpool_bsc.ts --network bsc
SEED_EXECUTE=true npx hardhat run scripts/deploy/58_seed_pancakeswap_binpool_bsc.ts --network bsc
```

## Segurança / rollback

- **Provisionamento fail-closed**: os scripts abortam se faltar CAS, POL ou
  BNB, se o token estiver pausado, se faltar `MINTER_ROLE` ou se o mint
  exceder `MAX_SUPPLY` (10M CAS).
- **Slippage**: `SEED_ID_SLIPPAGE` limita o deslocamento do `activeId`
  entre cálculo e execução; `amount0Max = BNB + SEED_SLIPPAGE_BPS` e o
  excedente nativo volta via ação `SWEEP`.
- **Idempotência**: `initializePool` não reverte em pool existente;
  approves/sets de peer são pulados quando já configurados.
- **Bridge reversível**: `send` B→A queima CASOFT na BSC e destrava CAS na
  Polygon — liquidez pode ser resgatada removendo os bins (1155) e
  bridgando de volta.
- **EndpointV2** (`0x1a44…728c`) é o mesmo endereço canônico nas duas
  chains; DVN/executor default da LayerZero — `setConfig` customizado pode
  ser aplicado pelo `delegate` depois, sem redeploy.
- **Testes**: `test/bridge/CASOFT.test.ts` (7 casos com `EndpointV2Mock`:
  lock/mint 1:1, round-trip, pausa, acesso, peer ausente) e
  `test/scripts/binpool_math.test.ts` (13 casos das funções puras de bin).
- **Auditoria**: regra `solidity-security` — revisão independente
  obrigatória antes do uso em produção; os wrappers LZ foram verificados
  contra `infinity-periphery-bsc-base` e `oft-evm@3.2.1`.

## Referências

- PancakeSwap Infinity (BSC): BinPoolManager `0xC697…4a9`, BinPositionManager
  `0x3D31…2850`, Vault `0x238a…e6c4`, BinQuoter `0xC631…D359`.
- `infinity-periphery-bsc-base` — `IBinPositionManager`, `Planner`,
  `Actions` (fonte do encoding `modifyLiquidities`).
- `infinity-core-bsc-base` — `PriceHelper`, `BinPoolParametersHelper`
  (fórmula preço↔bin, layout de `parameters`).
- LayerZero V2: `oft-evm` (`OFT`/`OFTAdapter`), `test-devtools-evm-hardhat`
  (`EndpointV2Mock` usado nos testes).
