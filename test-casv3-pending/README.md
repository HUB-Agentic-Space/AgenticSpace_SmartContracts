![header](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=200&section=header&text=Specs%20Pendentes%20CASv3&fontSize=36&fontAlignY=35&animation=twinkling)

![visitors](https://visitor-badge.laobi.icu/badge?page_id=RapportTecnologia.AgenticSpace.smartcontracts_test-casv3-pending)
[![License: CC BY-SA 4.0](https://img.shields.io/badge/License-CC_BY--SA_4.0-blue.svg)](https://creativecommons.org/licenses/by-sa/4.0/)
![Language: Portuguese](https://img.shields.io/badge/Language-Portuguese-brightgreen.svg)
![Status](https://img.shields.io/badge/Status-Ongoing-yellow)
[![GitHub Issues](https://img.shields.io/github/issues/RapportTecnologia/AgenticSpace)](https://github.com/RapportTecnologia/AgenticSpace/issues)

# Specs pendentes — capacidades CASv3

Este diretório abriga specs **fora do globo `test/` do Hardhat** (e fora do
`tsconfig.json`), preservadas intactas mas não executadas neste branch.

## Por que existem

No `release/cas-v2`, os contratos da família do token foram restaurados às
fontes **verificadas em produção** na Polygon (ver
`docs/cas-v2-lineage.md` e `docs/cas-v2/frozen-manifest.json`). O token em
produção (`0x5151A34E…2287`) é a geração **V2.0** — sem `freeze`,
`freezeUntil`, `unfreeze`, `isFrozen`, `setVotingLock` e sem `withdrawCAS`
no `CASSwap`.

Os specs aqui exercitam exatamente essas capacidades V2.1+/CASv3, então
falhariam contra o código de produção por design — não por defeito.

## Conteúdo

| Arquivo | Capacidade V2.1+ exercitada |
|---|---|
| `token/CASTokenFreeze.test.ts` | `freeze`/`freezeUntil`/`unfreeze`/`isFrozen` (COMPLIANCE_ROLE) |
| `token/CASTokenVotingLock.test.ts` | `setVotingLock`/voting lock de arbitragem |
| `token/CASSwap.withdrawCAS.spec-fragment.ts` | fragmento do describe `withdrawCAS` (CASSwap CASv3) |
| `diamond/AgentDAOFreeze.test.ts` | AgentDAO → `isFrozen` no token |
| `diamond/CommunityDAOFreeze.test.ts` | CommunityDAO → `isFrozen` no token |
| `diamond/ArbitrationFacet.test.ts` | Arbitration → `freezeUntil`/`setVotingLock` |
| `diamond/ArbitrationMajorityRule.test.ts` | idem (regra de maioria com freeze) |
| `scripts/19_freeze_fraud_addresses.test.ts` | script operacional de freeze |
| `scripts/22_daily_fraud_monitor.test.ts` | monitor de fraude (freeze) |

## Política

- **Nada é deletado** — os mesmos arquivos continuam ativos em `main`
  (linha CASv3). Este diretório é uma cópia de conveniência/preservação
  neste branch.
- **Não executar** contra o token V2.0 de produção — as chamadas
  revertem, pois o contrato não expõe as funções.
- Reintegrar a `test/` quando (e se) a linha deste branch for promovida
  para um token com as capacidades V2.1+.

## Changelog

| Data | Versão | Descrição |
|---|---|---|
| 2026-11-13 | 0.1.0 | Realocação inicial dos specs dependentes de V2.1 |

![footer](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=100&section=footer&animation=twinkling)
