# Estratégia de Listagem do CAS em Agregadores e Plataformas

Documento de referência para listagem do CAS em múltiplas plataformas de agregação de mercado cripto, divididas por nível de automação e prioridade.

## 1. Visão Geral

A estratégia de listagem do CAS segue três frentes paralelas:

1. **Automatizáveis** — scripts preparam e enviam submissões programaticamente
2. **Manuais** — formulários web que exigem intervenção humana
3. **Já implementadas** — integrações já funcionais

## 2. Plataformas Automatizáveis (Scripts)

Estas plataformas oferecem APIs gratuitas ou formulários web que podem ser submetidos via script. Os scripts estão em `smartcontracts/scripts/listing/`.

### DexScreener

- **Status**: Listagem automática (indexa ao detectar pool DEX)
- **Custo**: Gratuito (listagem básica); ~$300 para Enhanced Token Info (opcional)
- **API**: `https://api.dexscreener.com/latest/dex/tokens/<address>` (gratuita, sem key)
- **Script**: `npm run listing:dexscreener`
- **Ação**: Script monitora se token está indexado e se Enhanced Token Info está sendo exibida
- **Observação**: DexScreener lê metadata do CoinGecko automaticamente após listagem

### Trust Wallet

- **Status**: Assets repo já preparado localmente
- **Custo**: Gratuito (PR no GitHub)
- **Requisitos**: Token listado no CoinGecko ou CoinMarketCap (recomendado), 10K+ holders
- **Script**: `npm run listing:trustwallet`
- **Ação**: Script prepara `info.json` + `logo.png` e abre PR no repo `trustwallet/assets` via GitHub CLI (`gh`)
- **Requer**: GitHub CLI instalado e autenticado (`gh auth login`)

### CoinBrain

- **Status**: Pendente
- **Custo**: Gratuito
- **API**: API pública disponível
- **Script**: `npm run listing:coinbrain`
- **Ação**: Script envia metadata do token via API pública

### LiveCoinWatch

- **Status**: Pendente
- **Custo**: Gratuito
- **URL**: https://www.livecoinwatch.com/requests/coin
- **Script**: `npm run listing:livecoinwatch`
- **Ação**: Script envia POST com dados do token para formulário de "Request a Coin"

### CoinStats

- **Status**: Listagem automática por critérios
- **Custo**: Gratuito
- **Critérios mínimos**: FDV ≥ $100K, Volume 24h ≥ $100K, Liquidez ≥ $20K
- **Script**: `npm run listing:coinstats`
- **Ação**: Script monitora se token atinge thresholds (listagem é automática)
- **Observação**: CoinStats monitora top 40-500 coins por chain automaticamente

### GeckoTerminal

- **Status**: Indexação automática via CoinGecko
- **Custo**: Gratuito
- **Script**: `npm run listing:geckoterminal`
- **Ação**: Script verifica se CAS já está indexado no GeckoTerminal
- **Observação**: Indexação automática após listagem no CoinGecko

### Blockspot

- **Status**: Pendente
- **Custo**: Gratuito
- **Script**: `npm run listing:blockspot`
- **Ação**: Script envia dados do token via formulário web

## 3. Plataformas Manuais (Formulário Web)

### CoinMarketCap

- **Status**: Pendente (exige 60 dias de operação)
- **Custo**: Gratuito (tier free) ou $5K (tier prioritário C1)
- **URL**: https://support.coinmarketcap.com/hc/en-us/requests/new?ticket_form_id=360000493112
- **Requisitos**:
  - 60 dias de operação desde deploy
  - Volume mínimo em exchange rastreada pelo CMC
  - Website funcional
  - Block explorer funcional
  - Representante do projeto para comunicação
- **Quando submeter**: Após 60 dias do deploy (12/09/2026) OU após listagem no CoinGecko
- **Observação**: CMC agora rastreia automaticamente 50M+ tokens via DEXScan — CAS pode já ser indexado automaticamente

### DexTools

- **Status**: Pendente
- **Custo**: Gratuito (certificação básica) ou pago (certificação premium)
- **URL**: https://www.dextools.io/app/en/pair
- **Ação**: Submeter pair CAS/WPOL do SushiSwap para certificação
- **Requisitos**: Pair ativo com liquidez mínima

### Messari

- **Status**: Pendente (fase posterior)
- **Custo**: Gratuito para submissão
- **URL**: https://messari.io
- **Requisitos**: On-chain metrics, governança ativa, documentação técnica completa
- **Quando submeter**: Fase 3+ (500+ usuários, 250+ agentes)

## 4. Integrações Já Implementadas

| Plataforma | Status | Implementação |
|---|---|---|
| MetaMask (EIP-747) | ✅ Funcional | `frontend/src/lib/useWatchAsset.js` + `AddTokenButton.js` |
| Uniswap Token List | ✅ Publicada | `frontend/public/.well-known/agentic-space.tokenlist.json` |
| 1inch | ✅ Compatível | Token list publicada (1inch lê Uniswap Token Lists) |

## 5. DEXs Adicionais (Aumentar Liquidez e Visibilidade)

| DEX | Tipo | Quando | Benefício |
|---|---|---|---|
| Uniswap V3 | Concentrated liquidity | Fase 1 | Maior DEX da Polygon, aumenta visibilidade |
| Balancer | Weighted pool | Fase 2 | Pool ponderada CAS/WPOL, flexibilidade |
| Curve | Stableswap | Fase 3+ | Se ratio CAS/POL estabilizar |

## 6. Social/Comunidade (Melhoram Ranking)

| Canal | Ação | Prioridade | Impacto no Ranking |
|---|---|---|---|
| Twitter/X @AgenticSpace | Threads sobre CAS, milestones, agentes | Alta | CoinGecko verifica atividade |
| Discord oficial | Comunidade, suporte, anúncios | Alta | CoinGecko exige link social |
| Telegram | Canal de anúncios | Média | Comunidade cripto ativa |
| Reddit r/AgenticSpace | Discussões, atualizações | Baixa | SEO e comunidade |
| CoinGecko Candy | Participar do programa | Baixa | Incentivo de engajamento |

## 7. CEXs (Fase Posterior)

| Exchange | Tier | Quando | Requisitos |
|---|---|---|---|
| MEXC | Tier 2 | Fase 3+ (500 usuários) | Volume mínimo, comunidade ativa |
| Gate.io | Tier 2 | Fase 3+ | Documentação, KYC do projeto |
| Bitget | Tier 2 | Fase 3+ | Volume, comunidade |
| Binance | Tier 1 | Fase 5+ (5K usuários) | Volume alto, auditoria, compliance |
| Coinbase | Tier 1 | Fase 5+ | Listing application, legal review |

## 8. Orquestração de Submissões

Para executar todos os scripts de listagem automatizados em sequência:

```bash
cd smartcontracts
npm run listing:submit-all
```

O orquestrador gera um relatório consolidado em `reports/listing-status-<timestamp>.json` com:
- Plataforma, status (submetido/já listado/falhou/pendente)
- URL de verificação
- Pendências e próximas ações

## 9. Fluxo Recomendado

```
1. Validar prontidão     → npm run listing:readiness
2. Submeter CoinGecko    → Formulário manual (guia em coingecko-listing-guide.md)
3. Executar scripts      → npm run listing:submit-all
4. Monitorar status      → Re-executar scripts periodicamente
5. Submeter CMC          → Após 60 dias + listagem no CoinGecko
6. Aumentar liquidez     → Uniswap V3, Balancer
7. Submeter CEXs         → Conforme roadmap financeiro
```

## Changelog

| Data | Versão | Descrição |
|---|---|---|
| 2026-07-19 | 1.0.0 | Documento inicial — estratégia de listagem |
