---
tags:
  - cas
  - mint
  - csv
  - operacoes
---

![header](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=200&section=header&text=Mint%20CAS%20em%20Lote%20via%20CSV&fontSize=36&fontAlignY=35&animation=twinkling)

![visitors](https://visitor-badge.laobi.icu/badge?page_id=RapportTecnologia.AgenticSpace.smartcontracts_mint-cas-csv)
[![License: CC BY-SA 4.0](https://img.shields.io/badge/License-CC_BY--SA_4.0-blue.svg)](https://creativecommons.org/licenses/by-sa/4.0/)
![Language: Portuguese](https://img.shields.io/badge/Language-Portuguese-brightgreen.svg)
![Status](https://img.shields.io/badge/Status-Ongoing-yellow)
[![GitHub Issues](https://img.shields.io/github/issues/RapportTecnologia/AgenticSpace)](https://github.com/RapportTecnologia/AgenticSpace/issues)

# Mint em lote de CAS via CSV

Script `scripts/casswap/27_mint_cas_csv.ts`: cunha CAS diretamente para uma
lista de contas descrita em um arquivo CSV e registra no próprio arquivo os
valores equivalentes em BRLA/USDC e o hash de cada transação.

## Formato do CSV

Header obrigatório (nomes de coluna flexíveis, ver tabela abaixo). Modelo:
`data/mint-2026-11-30.csv`.

```csv
name, email, whatsapp, address, amount, brla_value, usdc_value
Maria Silva, maria@ex.com, +5585988880001, 0x1234…abcd, 1000, ,
```

| Coluna | Obrigatória | Sinônimos aceitos | Descrição |
|---|---|---|---|
| `address` | sim | `addr`, `wallet`, `carteira`, `endereco`, `recipient`, `destino` | Conta EVM destino |
| `amount` | sim | `quantidade`, `qtd`, `cas`, `valor` | CAS a mintar (aceita `1000.5` e `1.000,5`) |
| `brla_value` | não | `brla`, `brl`, `valorbrla` | Equivalente em BRLA; vazio → preenchido no mint |
| `usdc_value` | não | `usdc`, `usd`, `valorusd` | Equivalente em USDC; vazio → preenchido no mint |
| `tx_hash` | auto | `tx`, `hash`, `minttx` | Hash da tx de mint; linha preenchida é **pulada** |
| `minted_at` | auto | `datamint`, `timestamp` | Timestamp ISO da confirmação |

As colunas `tx_hash`/`minted_at` (e `brla_value`/`usdc_value`, se ausentes) são
acrescentadas automaticamente na primeira execução.

## Preenchimento de `brla_value` / `usdc_value`

No momento de cada mint o script calcula o equivalente do `amount`:

- **Polygon mainnet (137):** CAS/USD derivado do spot SushiSwap WPOL/CAS
  (`0x265D…C3964`) × Chainlink POL/USD; BRLA derivado pelo feed Chainlink
  BRL/USD.
- **Outras redes ou override manual:** definir `CAS_USD_PRICE` e
  `BRL_USD_PRICE` (USD por unidade, ex.: `0.0001331` e `0.1818`).
- Se apenas um dos dois estiver preenchido, o outro é derivado do valor
  informado (consistência com o preço registrado pelo operador).

## Uso

```bash
# Simulação (padrão — nenhuma tx enviada, CSV não alterado)
MINT_CSV=data/mint-2026-11-30.csv DRY_RUN=true \
  npx hardhat run scripts/casswap/27_mint_cas_csv.ts --network polygon

# Execução
MINT_CSV=data/mint-2026-11-30.csv DRY_RUN=false \
  npx hardhat run scripts/casswap/27_mint_cas_csv.ts --network polygon

# Atalho npm
MINT_CSV=data/mint-2026-11-30.csv DRY_RUN=false npm run mint:cas:csv
```

O caminho do CSV também pode ser passado como argumento posicional terminado
em `.csv`. O signer é `POLYGON_PRIVATE_KEY` (mainnet) ou
`POLYGON_AMOY_PRIVATE_KEY` (Amoy) — precisa deter `MINTER_ROLE`.

## Validações e segurança

Antes de qualquer transação o script aborta se:

- alguma linha pendente tiver `address` inválido ou `amount <= 0`
  (todos os erros são listados);
- signer não tiver `MINTER_ROLE`, contrato pausado ou voting lock ativo;
- algum destino estiver congelado (`AccountFrozen`);
- `totalSupply + total do lote > MAX_SUPPLY` (10M CAS);
- houver coluna vazia a preencher e nenhuma fonte de preço disponível.

O CSV é reescrito **após cada mint confirmado** (backup em `<arquivo>.bak`),
então uma re-execução após falha parcial retoma de onde parou — linhas com
`tx_hash` nunca são re-mintadas.

## Exemplo de saída

```text
  Linhas:   3 pendentes, 1 já mintadas
  Total:    425.5 CAS
  Supply:   1000000.0 CAS → 1000425.5 (máx 10000000.0)
  1 CAS = $0.00013343 | BRL/USD = $0.18180661

  L2 Maria — 0x1234…  100.0 CAS | BRLA 0.073391 | USDC 0.013343
```

## Changelog

| Data | Versão | Descrição |
|---|---|---|
| 2026-11-06 | 0.1.0 | Documentação inicial do script `27_mint_cas_csv.ts` |

![footer](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=100&section=footer&animation=twinkling)
