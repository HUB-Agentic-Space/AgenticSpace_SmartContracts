# Token Icons — Guia de Implementação

## Visão Geral

Este documento descreve a infraestrutura de ícones para os tokens ERC-20 do Agentic Space na Polygon (mainnet + testnet Amoy).

## URLs Públicas

Todos os ícones são servidos estaticamente pelo frontend deployado em:

```
https://app.agenticspace.rapport.tec.br/tokens/<address>.png
```

Exemplo:
```
https://app.agenticspace.rapport.tec.br/tokens/0x5151A34EaC7bA08cd6B540b32cD30316218A2287.png
```

## Uniswap Token List

A token list oficial está disponível em:

```
https://app.agenticspace.rapport.tec.br/.well-known/agentic-space.tokenlist.json
```

Qualquer dApp compatível com o padrão Uniswap Token List (Uniswap, 1inch, etc.) pode importar esta URL para carregar automaticamente os tokens do Agentic Space com seus ícones.

## EIP-747 (wallet_watchAsset)

O frontend implementa o padrão EIP-747 para adicionar tokens à MetaMask programaticamente.

### Componentes

- **`frontend/src/lib/useWatchAsset.js`**: Hook que chama `wallet_watchAsset` com o endereço, símbolo, decimais e URL do ícone.
- **`frontend/src/components/AddTokenButton.js`**: Botão reutilizável com estados de loading/sucesso/erro.
- **`frontend/src/lib/tokens.js`**: Registro centralizado de todos os tokens (mainnet + testnet).

### Uso

```jsx
import AddTokenButton from '@/components/AddTokenButton';

<AddTokenButton
  address="0x5151A34EaC7bA08cd6B540b32cD30316218A2287"
  symbol="CAS"
  decimals={18}
  chainId={137}
/>
```

## Estrutura de Arquivos

### SVGs Fonte

```
smartcontracts/metamask/icons/
├── cas-token.svg          # CAS — gradiente laranja, rede de agentes
├── cas-fund-tracker.svg   # aCAS — gradiente laranja, rede + "F"
├── pol-fund-tracker.svg   # aPOL — gradiente roxo, rede + "F"
├── sushi-lp.svg           # SLP — gradiente rosa, rede + "SLP"
├── quick-lp.svg           # QLP — gradiente azul, rede + "QLP"
├── ape-lp.svg             # ALP — gradiente amarelo, rede + "ALP"
├── dfyn-lp.svg            # DLP — gradiente ciano, rede + "DLP"
└── png/                   # PNGs convertidos (256, 128, 32)
```

### Repositório de Imagens

```
images/
├── mainnet/<address>/
│   ├── info.json          # Metadados do token
│   ├── logo.svg           # SVG fonte
│   ├── logo-256.png       # PNG 256x256
│   ├── logo-128.png       # PNG 128x128
│   └── logo-32.png        # PNG 32x32
├── testnet/<address>/
│   └── ... (mesma estrutura)
└── README.md
```

### Frontend (servido publicamente)

```
frontend/public/
├── tokens/
│   └── <address>.png      # PNG 256x256 por endereço
└── .well-known/
    └── agentic-space.tokenlist.json  # Uniswap Token List
```

### Trust Wallet (preparado para submissão futura)

```
trustwallet_assets/blockchains/polygon/assets/<address>/
├── info.json              # Metadados no formato Trust Wallet
└── logo.png               # PNG 256x256
```

## Design dos Ícones

Base: favicon.svg do projeto (gradiente laranja, 3 círculos brancos conectados = rede de agentes IA).

| Token | Fundo | Diferenciador |
|-------|-------|---------------|
| CAS | Laranja (#f97316 → #ea580c) | Rede de agentes |
| aCAS | Laranja | Rede + "F" |
| aPOL | Roxo (#8247E5 → #6B33C9) | Rede + "F" (cor POL) |
| SLP | Rosa (#FA52A0 → #D63B8C) | Rede + "SLP" |
| QLP | Azul (#3B82F6 → #1D4ED8) | Rede + "QLP" |
| ALP | Amarelo (#F59E0B → #D97706) | Rede + "ALP" |
| DLP | Ciano (#06B6D4 → #0891B2) | Rede + "DLP" |

## Plataformas

| Plataforma | Status | Ação |
|------------|--------|------|
| MetaMask (EIP-747) | ✅ Implementado | Botão "Adicionar à MetaMask" no frontend |
| Uniswap Token List | ✅ Criado | URL pública disponível |
| DexScreener | ⏳ Pendente | Submeter logo via "Update Token Info" |
| CoinGecko | ⏳ Pendente | Submeter formulário com logo 200x200 |
| CoinMarketCap | ⏳ Pendente | Requer 60 dias de operação |
| Trust Wallet | ⏳ Preparado | Aguardando 10k holders + CMC listing |
| 1inch | ⏳ Preparado | Fork do Trust Wallet, mesma estrutura |

## Custo em Gas

**0 POL** — todas as operações são off-chain. EIP-747 é uma chamada RPC client-side, não uma transação on-chain.
