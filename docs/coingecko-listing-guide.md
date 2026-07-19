# Guia de Listagem do CAS no CoinGecko

Guia passo a passo para submeter o token CAS (Cryptocoin Agentic Space) no CoinGecko, incluindo pré-requisitos, formulário, logo, links sociais e pós-listagem.

## 1. Pré-requisitos

O CoinGecko exige que o token atenda aos seguintes critérios antes da submissão:

| Critério | Status do CAS | Observação |
|---|---|---|
| Contrato verificado no explorer | ✅ Verificado no Polygonscan | 17/17 contratos verificados |
| Token negociado em DEX com liquidez | ⚠️ Parcial | SushiSwap, QuickSwap, ApeSwap, Dfyn — aumentar liquidez |
| Volume de transações nas últimas 24h | ⚠️ Verificar | Usar `npm run listing:readiness` para validar |
| Website funcional | ✅ https://app.agenticspace.rapport.tec.br | Online |
| Whitepaper/tokenomics público | ✅ Disponível no website | whitepaper.md + tokenomics.md |
| Logo público (PNG) | ✅ 256x256 PNG | URL pública servida pelo frontend |
| Links sociais (Twitter, Discord) | ❌ Pendente | Configurar antes de submeter |
| Comunidade ativa | ⚠️ Em construção | Mínimo recomendado: 50+ holders |

### Validar prontidão

```bash
cd smartcontracts
npm run listing:readiness
```

O script gera um relatório com score 0-100 e lista pendências bloqueantes vs não-bloqueantes.

## 2. Formulário de Listagem

### URL do formulário

O CoinGecko oferece dois caminhos:

1. **Listing gratuito** (recomendado): https://www.coingecko.com/en/coins/list — clique em "Submit a Coin"
2. **CoinGecko Pro/Paid** (não recomendado inicialmente): plano pago com listagem mais rápida

### Campos obrigatórios do formulário

| Campo | Valor a preencher |
|---|---|
| **Coin Name** | Cryptocoin Agentic Space |
| **Symbol** | CAS |
| **Blockchain** | Polygon |
| **Contract Address** | `0x5151A34EaC7bA08cd6B540b32cD30316218A2287` |
| **Decimals** | 18 |
| **Total Supply** | 1,000,000 CAS (initial mint) |
| **Max Supply** | 10,000,000 CAS |
| **Website** | https://app.agenticspace.rapport.tec.br |
| **Explorer URL** | https://polygonscan.com/token/0x5151A34EaC7bA08cd6B540b32cD30316218A2287 |
| **Logo URL** | https://app.agenticspace.rapport.tec.br/tokens/0x5151A34EaC7bA08cd6B540b32cD30316218A2287.png |
| **Whitepaper URL** | https://app.agenticspace.rapport.tec.br/tokens/cas-whitepaper.md |
| **GitHub URL** | https://github.com/RapportTecnologia/AgenticSpace |
| **Twitter/X** | (preencher após criar conta @AgenticSpace) |
| **Discord** | (preencher após criar servidor) |
| **Telegram** | (preencher após criar canal) |
| **Description** | Ver `description_long` em `coingecko-listing-metadata.json` |
| **DEX Pair URL** | https://dexscreener.com/polygon/0x5151A34EaC7bA08cd6B540b32cD30316218A2287 |

### Dados de mercado (DEX)

Incluir no formulário todos os pares DEX onde o CAS está listado:

| DEX | Pair | LP Token |
|---|---|---|
| SushiSwap (principal) | CAS/WPOL | `0x265D86d4D43c32037b032097e8bFB6893E1C3964` |
| QuickSwap | CAS/WPOL | `0xf77BD26fE17adb1bC99BE6Cd63414b2A7819690E` |
| ApeSwap | CAS/WPOL | `0xF27F3c3E305FEdf21B491A1d531fd4c3c80312B4` |
| Dfyn | CAS/WETH | `0x2275BFC0b1E26fB36a42E26fA1E5e4D823E62bc3` |

### Exchange on-chain (CASSwap)

Incluir também o CASSwap como exchange oficial:

- **Contrato**: `0x9399878Ce33EA9D4859ab708a111fB3f274BACF4`
- **Tipo**: On-chain atomic swap (CAS ↔ POL)
- **URL**: https://polygonscan.com/address/0x9399878Ce33EA9D4859ab708a111fB3f274BACF4

## 3. Especificações do Logo

O CoinGecko aceita logos nas seguintes especificações:

- **Formato**: PNG (sem fundo transparente preferencialmente)
- **Tamanho recomendado**: 200x200px ou 256x256px
- **Tamanho máximo**: 512x512px
- **Peso máximo**: 1MB
- **Fundo**: sólido ou gradiente (evitar transparência)

O logo atual do CAS está em:
```
https://app.agenticspace.rapport.tec.br/tokens/0x5151A34EaC7bA08cd6B540b32cD30316218A2287.png
```

Arquivo fonte: `images/mainnet/0x5151A34EaC7bA08cd6B540b32cD30316218A2287/logo-256.png`

## 4. Links Sociais

O CoinGecko exige pelo menos 2 links sociais. Configurar na seguinte ordem de prioridade:

### Twitter/X (prioridade máxima)

1. Criar conta @AgenticSpace no X
2. Fazer pelo menos 5-10 posts antes da submissão
3. Incluir link do website e GitHub na bio
4. URL a submeter: `https://twitter.com/AgenticSpace`

### Discord (alta prioridade)

1. Criar servidor "Agentic Space" no Discord
2. Configurar canais: #anúncios, #geral, #cas-token, #agentes, #governança
3. URL a submeter: `https://discord.gg/<invite-code>`

### Telegram (média prioridade)

1. Criar canal de anúncios "Agentic Space Official"
2. Postar roadmap e links importantes
3. URL a submeter: `https://t.me/AgenticSpace`

### Reddit (opcional)

1. Criar subreddit r/AgenticSpace
2. URL a submeter: `https://reddit.com/r/AgenticSpace`

## 5. Tempo de Resposta

- **Listing gratuito**: 7 a 30 dias úteis (sem garantia de aprovação)
- **CoinGecko não envia email de rejeição** — se não for listado em 30 dias, reavaliar critérios
- **Fatores que aceleram**: comunidade ativa, volume DEX crescente, presença em múltiplas exchanges
- **Fatores que atrasam**: poucos holders, baixa liquidez, links sociais inexistentes

## 6. Pós-Listagem

Após a listagem ser aprovada:

### Atualizar dados

1. Acessar https://www.coingecko.com/en/coins/list e selecionar "Update Coin Info"
2. Adicionar novos pares DEX conforme forem criados
3. Atualizar links sociais se mudarem
4. Manter circulating supply atualizado

### Adicionar exchanges

1. Para cada nova exchange (DEX ou CEX), submeter via "Add Market" no CoinGecko
2. Incluir URL do par, volume e liquidez
3. O CoinGecko verifica automaticamente via API

### Manter info atualizada

- **Preço**: atualizado automaticamente via API do DexScreener/exchanges
- **Market cap**: calculado automaticamente (price × circulating supply)
- **Volume**: atualizado a cada hora via APIs conectadas
- **Social links**: atualizar manualmente quando mudarem

### GeckoTerminal

Após listagem no CoinGecko, o token é automaticamente indexado no GeckoTerminal (subproduto do CoinGecko focado em DEXs).

## 7. Troubleshooting — Motivos Comuns de Rejeição

| Motivo | Solução |
|---|---|
| Contrato não verificado | Verificar no Polygonscan antes de submeter |
| Liquidez DEX insuficiente | Aumentar liquidez para mínimo $5.000+ |
| Poucos holders | Distribuir tokens via airdrop, programa de embaixadores |
| Sem links sociais | Criar Twitter/X e Discord antes de submeter |
| Website não funcional | Garantir que o site está online e responsivo |
| Token parece especulativo | Destacar disclaimer on-chain de utility token |
| Volume artificial detectado | Garantir volume orgânico, não wash trading |
| Informação inconsistente | Validar metadata em `coingecko-listing-metadata.json` |

## 8. Metadata Consolidada

Todos os dados necessários para a submissão estão consolidados em:

```
smartcontracts/docs/coingecko-listing-metadata.json
```

Este arquivo é usado também pelos scripts de automação (`scripts/listing/`) para submissões em outras plataformas.

## Changelog

| Data | Versão | Descrição |
|---|---|---|
| 2026-07-19 | 1.0.0 | Guia inicial criado |
