![header](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=200&section=header&text=Whitelist%20de%20Endere%C3%A7os%20Inocentados&fontSize=36&fontAlignY=35&animation=twinkling)

![visitors](https://visitor-badge.laobi.icu/badge?page_id=RapportTecnologia.AgenticSpace.smartcontracts_whitelist)

[![License: CC BY-SA 4.0](https://img.shields.io/badge/License-CC_BY--SA_4.0-blue.svg)](https://creativecommons.org/licenses/by-sa/4.0/)
![Language: Portuguese](https://img.shields.io/badge/Language-Portuguese-brightgreen.svg)
![Status](https://img.shields.io/badge/Status-Ongoing-yellow)
[![GitHub Issues](https://img.shields.io/github/issues/RapportTecnologia/AgenticSpace)](https://github.com/RapportTecnologia/AgenticSpace/issues)

# Whitelist de Endereços Inocentados

O arquivo `data/whitelist.csv` é a **fonte de verdade** para endereços inocentados de fraude no ecossistema CAS. Este arquivo **tem precedência sobre todas as demais listagens de fraude**, incluindo `data/fraude.csv` e registros no banco SQLite.

## Formato do CSV

| Coluna | Descrição | Heurísticas de Detecção |
|---|---|---|
| Nome | Identificação do endereço | `nome`, `name`, `identificacao` |
| Endereço | Endereço EVM (40 hex após 0x) | `endereço`, `endereco`, `address`, `addr`, `carteira`, `wallet` |
| Motivo | Motivo da inocentação | `motivo`, `reason`, `justificativa`, `causa` |

- Separador: vírgula (`,`) ou ponto-e-vírgula (`;`), detectado automaticamente
- BOM UTF-8 aceito
- Endereços inválidos são pulados com aviso
- Duplicatas mantêm a primeira ocorrência

### Exemplo

```csv
Nome,Endereço,motivo
Alice,0x1234567890abcdef1234567890abcdef12345678,Falso positivo — exchange legítima
Bob,0xabcdef1234567890abcdef1234567890abcdef12,Erro de identificação — carteira pessoal
```

## WhitelistService

O serviço `WhitelistService` (em `agentic_space_commons`) é responsável por carregar e consultar a whitelist.

### Métodos

| Método | Descrição |
|---|---|
| `WhitelistService.fromSmartContractsRoot(scRoot)` | Factory estático que aponta para `data/whitelist.csv` |
| `whitelist.load()` | Carrega o CSV (lazy, uma única vez) |
| `whitelist.isWhitelisted(address)` | Retorna `true` se o endereço está na whitelist |
| `whitelist.getRecord(address)` | Retorna `{ name, address, reason }` ou `undefined` |
| `whitelist.filterAddresses(addresses)` | Separa endereços em `{ whitelisted, remaining }` |
| `whitelist.size()` | Número de entradas carregadas |
| `whitelist.allEntries()` | Lista todas as entradas |

## Integração com Scripts e Serviços

### Scripts de Freeze e Arbitragem

| Script | Comportamento |
|---|---|
| `19_freeze_fraud_addresses.ts` | Pula freeze e criação de caso de arbitragem |
| `20_arbitration_vote.ts` | Bloqueia votação em casos de endereços whitelisted |
| `21_dao_sanction_proposal.ts` | Bloqueia execução de sanção sobre inocentados |
| `22_daily_fraud_monitor.ts` | Pula monitoramento diário |

### FraudAddressService

O `FraudAddressService` aceita `whitelistPath` na configuração. Quando presente:
- Endereços whitelisted não são inseridos no banco
- Não recebem freeze
- Não têm casos de arbitragem criados
- Registros existentes no banco são pulados no cleanup

### cas_fraud_trace.ts (Rastreio de Fraude)

- Endereços whitelisted exibem **bandeirinha branca** (🏳️) no label
- Borda branca no grafo vis-network
- Alertas de manipulação cujos endereços estão todos na whitelist são **descartados**
- Alertas não são aplicados a nós whitelisted
- Legenda inclui "🏳️ Whitelist (inocentado)"

## Segurança e Precedência

- **Deny by default**: a whitelist apenas isenta endereços explicitamente listados
- **Precedência absoluta**: se um endereço está em `fraude.csv` e `whitelist.csv`, prevalece a whitelist
- **Auditoria**: todas as pulagens são logadas com motivo
- **Validação**: endereços são normalizados para lowercase e validados como EVM de 40 hex

## Changelog

| Data | Versão | Descrição |
|---|---|---|
| 2026-08-01 | 0.1.0 | Documentação inicial — WhitelistService e integração com scripts de fraude |

![footer](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=100&section=footer&animation=twinkling)
