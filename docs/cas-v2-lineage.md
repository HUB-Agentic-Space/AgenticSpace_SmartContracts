![header](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=200&section=header&text=CAS%20Lineage%20e%20Branches&fontSize=36&fontAlignY=35&animation=twinkling)

![visitors](https://visitor-badge.laobi.icu/badge?page_id=RapportTecnologia.AgenticSpace.smartcontracts_cas-v2-lineage)
[![License: CC BY-SA 4.0](https://img.shields.io/badge/License-CC_BY--SA_4.0-blue.svg)](https://creativecommons.org/licenses/by-sa/4.0/)
![Language: Portuguese](https://img.shields.io/badge/Language-Portuguese-brightgreen.svg)
![Status](https://img.shields.io/badge/Status-Ongoing-yellow)
[![GitHub Issues](https://img.shields.io/github/issues/RapportTecnologia/AgenticSpace)](https://github.com/RapportTecnologia/AgenticSpace/issues)

# Linhagem do Token CAS e mapa de branches

Documento de referência do branch `release/cas-v2`: o que roda em produção
na Polygon hoje, como o código versionado se relaciona com o bytecode
on-chain e qual a política de congelamento deste branch.

## Linhagem do token

| Geração | Identificação | Estado |
|---|---|---|
| **V1** | `0x23222C45505576AC35A5f28458D02d8E715E48A7` (Amoy) | Legado — sem `MAX_SUPPLY`; migrável via `CASMigration` (ratio 1:1) |
| **V2.0** | `0x5151A34EaC7bA08cd6B540b32cD30316218A2287` (mainnet) | **EM PRODUÇÃO** — `MAX_SUPPLY` 10M, mint/burn/pausable, UUPS-shaped mas deploy **standalone (sem proxy ERC1967)** |
| **V2.1** | impl `0xb6D08a85a0bA8ED374dFb4aE47285C90889683B8` (mainnet) | **Dormente** — adiciona `COMPLIANCE_ROLE`, `freeze`/`freezeUntil`/`unfreeze`/`isFrozen`/`setVotingLock`. Deployado, **nunca ativado** (o token de produção não está atrás de proxy — `upgradeTo*` não tem efeito observável) |
| **V3 (CASv3)** | em desenvolvimento em `main` | Futuro — inclui a base V2.1 e demais melhorias aprovadas |

## Mapa de branches

| Branch | Papel |
|---|---|
| `main` | Linha de desenvolvimento do **CASv3**. Contém o `CASToken.sol` V2.1 (fonte do impl dormente) e todo o trabalho novo da constelação. |
| `release/cas-v2` | Linha de **manutenção de produção V2.0**. Contratos da família do token **congelados** nas fontes verificadas on-chain; recebe melhorias periféricas (scripts, docs, bridge, liquidez) que não alteram o bytecode congelado. |

## Contratos em produção (Polygon PoS, chainId 137)

| Contrato | Endereço | Verificado | Paridade com este branch |
|---|---|---|---|
| CASToken (V2.0) | `0x5151A34EaC7bA08cd6B540b32cD30316218A2287` | sim | bytecode-exact |
| CASSwap | `0x9399878Ce33EA9D4859ab708a111fB3f274BACF4` | sim | bytecode-exact |
| InfrastructureFund | `0x190A9D2f206dbeb72Ce8b88Dc2603745fB5f50dB` | sim | bytecode-exact |
| Diamond | `0x80BD976cB588cD2F9aD9Ac671FB19174E9F3172b` | sim | bytecode-exact |
| LiquidityLock | `0x42060386024b69F0365ae22a41501AdA2D53AA31` | não | fonte presumida |
| FundTrackerToken (CAS/POL) | `0xdF5Df5Eb32fa1a53749c66364B877C39b7031377` / `0x5b82Fb12Cd034dAFC932ABb0995E9652EebE34CF` | não | fonte presumida |
| MultiTokenLiquidityLockFacet | `0x64Dc5D98b68A09747920C9106E68aa9006bE2470` | não | fonte presumida |

## Política de congelamento

1. **Escopo congelado**: todos os arquivos em `contracts/token/`, mais
   `contracts/diamond/Diamond.sol` e as interfaces de produção
   `contracts/interfaces/ICASToken.sol` e `ICASSwap.sol` — listados com
   sha256 em `docs/cas-v2/frozen-manifest.json`.
2. **Guarda**: `npm run check:frozen` valida os hashes;
   `npm run check:frozen:onchain` prova a paridade de bytecode
   (`eth_getCode` vs `deployedBytecode` compilado, normalizando o
   immutable `__self` do UUPSUpgradeable).
3. **Capacidades V2.1+**: vivem em `main`. Neste branch, facets que
   chamam freeze/voting lock usam `ICASTokenCompliance` (superset de
   `ICASToken`) — compilam, mas **revertem on-chain** em produção até a
   ativação de uma nova geração do token (redeploy + migração).
4. **Specs pendentes**: testes que exigem V2.1+ foram preservados em
   `test-casv3-pending/` (fora do globo do Hardhat) — nada é deletado;
   os originais seguem ativos em `main`.
5. **Promoção**: mudanças aprovadas na constelação fluem para `main`
   (CASv3). Correções de produção que exijam alterar arquivos congelados
   exigem novo deploy + migração — não há upgrade in-place no token V2.0.

## Fontes verificadas usadas na restauração

As fontes foram extraídas das verificações oficiais no Polygonscan
(compilador v0.8.28+commit.7893614a, `viaIR`, optimizer 200, cancun) —
bytecode idêntico ao on-chain, exceto o immutable `__self` que contém o
endereço do próprio contrato por construção do `UUPSUpgradeable`.

## Changelog

| Data | Versão | Descrição |
|---|---|---|
| 2026-11-13 | 0.1.0 | Criação do branch release/cas-v2; restauração das fontes V2.0 verificadas; freeze guard e specs pendentes documentados |

![footer](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=100&section=footer&animation=twinkling)
