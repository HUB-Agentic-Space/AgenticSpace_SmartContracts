---
tags:
  - smartcontracts
  - diamond
  - swap
  - multi-route
  - dex
---

![header](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=200&section=header&text=MultiRouteSwapFacet&fontSize=36&fontAlignY=35&animation=twinkling)

![visitors](https://visitor-badge.laobi.icu/badge?page_id=RapportTecnologia.AgenticSpace.smartcontracts_multiroute-swap-facet)
[![License: CC BY-SA 4.0](https://img.shields.io/badge/License-CC_BY--SA_4.0-blue.svg)](https://creativecommons.org/licenses/by-sa/4.0/)
![Language: Portuguese](https://img.shields.io/badge/Language-Portuguese-brightgreen.svg)
![Status](https://img.shields.io/badge/Status-Ongoing-yellow)
[![GitHub Issues](https://img.shields.io/github/issues/RapportTecnologia/AgenticSpace)](https://github.com/RapportTecnologia/AgenticSpace/issues)

# MultiRouteSwapFacet

**Caminho:** `contracts/diamond/facets/MultiRouteSwapFacet.sol`

Facet do Diamond (EIP-2535) para swaps atômicos multi-hop entre diferentes DEXs com tokens intermediários. Permite executar rotas como:

```
CAS → WETH (Dfyn) → WPOL (QuickSwap) → CAS (ApeSwap)
```

tudo em uma única transação, com proteção contra MEV e slippage.

## Visão Geral

- **Padrão:** Diamond Facet (EIP-2535), Strategy (seleção de rota), Facade (orquestração multi-router)
- **Storage:** `MultiRouteSwapStorage.sol` — slot isolado `keccak256("agenticspace.multiroute.swap.storage")`
- **Acesso:** Apenas o owner do Diamond pode gerenciar rotas (`addRoute`, `removeRoute`, `setRouteActive`)
- **Execução:** Qualquer usuário pode executar rotas (`executeRoute`, `executeHops`)
- **Reentrancy:** `ReentrancyGuardTransient` (OpenZeppelin 5.x)
- **Segurança:** `SafeERC20` para todas as transferências, approval resetado após cada hop

## Arquitetura

```
Diamond Proxy (EIP-2535)
  └── MultiRouteSwapFacet
        ├── executeRoute(name, minAmountOut)   → executa rota nomeada
        ├── executeHops(hops[], minAmountOut)   → executa hops inline
        ├── addRoute(name, hops[])              → cadastra rota (owner)
        ├── removeRoute(name)                   → remove rota (owner)
        ├── setRouteActive(name, active)        → ativa/desativa (owner)
        ├── getRoute(name)                      → consulta rota
        ├── listRoutes()                        → lista rotas
        └── initMultiRouteSwap(casToken)        → inicialização (owner)
```

## Estrutura Hop

```solidity
struct Hop {
    address router;       // Endereço do router V2 da DEX
    address[] path;       // Caminho de tokens (ex: [CAS, WETH])
    bool useNativeIn;     // true = envia POL nativo como entrada
    bool useNativeOut;    // true = recebe POL nativo como saída
    uint256 amountIn;     // Quantidade de entrada (0 se useNativeIn)
}
```

## Rotas Pré-cadastradas

### `dfyn_to_apeswap`

Rota de equilíbrio: vende CAS na Dfyn (mais cara), converte WETH→WPOL na QuickSwap, compra CAS na ApeSwap (mais barata).

| Hop | Router | Path | Native In | Native Out |
|-----|--------|------|-----------|------------|
| 1 | Dfyn Router | [CAS, WETH] | false | false |
| 2 | QuickSwap V2 | [WETH, WPOL] | false | false |
| 3 | ApeSwap Router | [WPOL, CAS] | true | false |

## Segurança

- **Atômico:** Todos os hops executam em uma única transação. Se qualquer hop falhar, tudo reverte.
- **Slippage:** `minAmountOut` protege contra slippage no valor final.
- **Approvals:** Token approvals são resetados para zero após cada hop.
- **Refund:** Excesso de POL nativo é devolvido ao caller ao final.
- **Access control:** Apenas o owner do Diamond pode cadastrar/remover rotas.
- **Reentrancy:** Proteção via `ReentrancyGuardTransient`.

## Deploy

### Pré-requisitos

- Diamond já deployado (`DIAMOND_ADDRESS` no `.env`)
- `CAS_TOKEN_ADDRESS` no `.env`

### Passo a passo

```bash
# 1. Compilar
npx hardhat compile

# 2. Deploy do facet + diamond cut
npx hardhat run scripts/deploy/15_deploy_multi_route_swap_facet.ts --network polygonAmoy

# 3. Cadastrar rotas (exemplo)
# Via script ou interagindo diretamente com o Diamond
```

### Variáveis de ambiente

| Variável | Obrigatória | Descrição |
|---|---|---|
| `DIAMOND_ADDRESS` | Sim | Endereço do Diamond proxy |
| `CAS_TOKEN_ADDRESS` | Sim | Endereço do token CAS |
| `MULTI_ROUTE_SWAP_FACET_ADDRESS` | Não | Se já deployado, pula o deploy |

## Integração com script 21

O script `scripts/casswap/21_balance_dex_prices.ts` usa o facet automaticamente quando `DIAMOND_ADDRESS` está configurado:

```bash
# Equilíbrio atômico via facet
npx tsx scripts/casswap/21_balance_dex_prices.ts --allbuy apeswap --allsell dfyn
```

Se `DIAMOND_ADDRESS` não estiver configurado, o script faz a execução non-atomic (3 transações separadas) como fallback.

## Events

| Event | Descrição |
|---|---|
| `MultiRouteExecuted(caller, routeName, totalAmountIn, totalAmountOut, txHash)` | Emitido após execução bem-sucedida |
| `RouteAdded(name, hopCount)` | Nova rota cadastrada |
| `RouteRemoved(name)` | Rota removida |
| `RouteToggled(name, active)` | Rota ativada/desativada |

## Custom Errors

| Error | Descrição |
|---|---|
| `RouteNotFound(string name)` | Rota não existe |
| `RouteNotActive(string name)` | Rota existe mas está desativada |
| `RouteHasNoHops()` | Rota sem hops definidos |
| `ZeroAddress(string param)` | Endereço zero inválido |
| `InvalidPath()` | Caminho de tokens inválido (< 2 tokens) |
| `SwapFailed(uint256 hopIndex, string reason)` | Falha em um hop específico |
| `InsufficientOutput(uint256 expected, uint256 received)` | Output abaixo do mínimo |
| `NotAuthorized()` | Caller não autorizado |

## Changelog

| Data | Versão | Descrição |
|---|---|---|
| 2025-08-05 | 0.1.0 | Implementação inicial do MultiRouteSwapFacet com rotas nomeadas, execução atômica e integração com script 21 |

![footer](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=100&section=footer&animation=twinkling)
