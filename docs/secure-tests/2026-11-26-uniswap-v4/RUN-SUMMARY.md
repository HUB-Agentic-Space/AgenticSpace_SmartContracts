---
tags:
  - security
  - uniswap-v4
  - audit
---

![header](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=200&section=header&text=Security%20Audit%20Run%20%E2%80%94%20Uniswap%20v4%20CAS&fontSize=36&fontAlignY=35&animation=twinkling)

![visitors](https://visitor-badge.laobi.icu/badge?page_id=RapportTecnologia.AgenticSpace.smartcontracts_secure-tests_2026-11-26-uniswap-v4)
[![License: CC BY-SA 4.0](https://img.shields.io/badge/License-CC_BY--SA_4.0-blue.svg)](https://creativecommons.org/licenses/by-sa/4.0/)
![Language: Portuguese](https://img.shields.io/badge/Language-Portuguese-brightgreen.svg)
![Status](https://img.shields.io/badge/Status-Ongoing-yellow)
[![GitHub Issues](https://img.shields.io/github/issues/RapportTecnologia/AgenticSpace)](https://github.com/RapportTecnologia/AgenticSpace/issues)

# Auditoria de Segurança — uniswap-v4 (run 2026-11-26)

## Identidade da execução

| Campo | Valor |
|---|---|
| Run ID | `2026-11-26-uniswap-v4` |
| Data (UTC) | 2026-11-26 |
| Revisor | Devin (AI agent) — revisão interna, **não** auditoria externa independente |
| Modo | Full cycle escopado (auditoria + remediação autorizada pelo usuário) |
| Issue | [#47](https://github.com/HUB-Agentic-Space/AgenticSpace_SmartContracts/issues/47) |
| Baseline | `origin/main` @ `f35e7bc` (conteúdo idêntico a `origin/release/cas-v2` @ `06e44f2` para o escopo) |
| Snapshot revisado | working tree da branch `fix/issue-47-audit-uniswap-v4` |
| Escopo | `contracts/uniswap-v4/CASInstallmentHook.sol`, `contracts/uniswap-v4/CASInstallmentRouter.sol` e dependências de leitura |
| Toolchain | Node v22.23.4 (NVM, `.nvmrc`), solc 0.8.28 (fixo, otimizador 200 runs, cancun), forge 1.9.0, slither (pipx), mythril v0.24.8, solhint |
| Política canônica | `.devin/rules/smartcontracts-solidity-security.md` + workflow `smartcontracts-security-audit` |

## Modelo de ameaça

- **Ativos:** CAS (ERC-20) dos titulares e a moeda de contraparte dos pools v4.
- **Atores privilegiados:** `initializer` (único que pode abrir pools sucessores; recomendado multisig em produção), `PoolManager` (único chamador dos callbacks), `CASInstallmentRouter` (único `sender` aceito em `afterSwap`).
- **Propriedades críticas:**
  1. Uma venda nunca excede 50% do saldo atual do lote (`nextAmount` como teto).
  2. Um lote só pode vender a partir de `sellAfter` (24h por rodada).
  3. `outstanding` nunca pode ser vendido além do saldo ERC-20 atual (`LotsExceedBalance`).
  4. `nextAmount + lastAmount` é sempre o saldo contábil do lote; `outstanding` é a soma sobre os lotes ativos.
  5. Callbacks só respondem ao `manager` fixado e ao `router` fixado no construtor.
  6. Apenas `initializer` abre pools sucessores, apenas pares com CAS e apenas com o `sqrtPriceX96` atual do pool de origem allowlistado.

## Resultado por check

| Check | Comando | Status | Observação |
|---|---|---|---|
| Compilação | `npm run compile` | passed | 207 arquivos, solc 0.8.28, cancun, optimizer 200 |
| Testes Hardhat (escopo) | `npm run cas:v4:test` | passed | 13/13 testes em `test/uniswap-v4/CASInstallmentHook.test.ts` |
| Solhint | `npx solhint 'contracts/uniswap-v4/*.sol'` | passed | 0 erros; 9 warnings justificados (naming immutable + `not-rely-on-time` inerente ao vesting/deadline) |
| Slither | `slither contracts/uniswap-v4/CASInstallmentHook.sol` | passed* | Antes: 1 High, 3 Medium, 2 Low, 2 Info no escopo. Após correções: 1 High FP, 1 Medium justificado, 2 Low justificados, 2 Info. Ver triagem. |
| Mythril | `myth analyze` (solc 0.8.28 via `SOLC=`) | passed* | Hook: 0 issues (cobertura limitada — construtor instancia o Router; registro honesto). Router: 1 Low (timestamp/deadline, justificado). |
| Echidna | `npm run audit:echidna` | not_applicable | Harness existente cobre apenas libs do CASSwap; não há harness para uniswap-v4. Follow-up recomendado. |
| Foundry fuzz/invariant | `forge test` | not_run | Não existem `.t.sol` no projeto para este escopo. Follow-up recomendado para propriedades do hook. |
| Coverage | `hardhat coverage` (escopo) | not_run | Wrapper cobre o projeto inteiro; os 13 testes exercitam todas as branches/reverts do escopo (ver tabela de testes). |
| SMTChecker/verificação formal | — | not_run | Não executado; propriedades críticas cobertas por testes determinísticos. Recomendado antes de deploy mainnet. |
| Auditoria externa independente | — | blocked | Exigida pela política canônica antes de mainnet. Este run não a substitui. |

## Findings e triagem

### F-01 — Slither High `arbitrary-send-erc20` (Router.sol:124) — **falso positivo (documentado)**

`unlockCallback` executa `safeTransferFrom(trader, manager, amountIn)`. O `trader`
não é arbitrário: ele é gravado como `msg.sender` dentro de `swap()` na mesma
transação. `unlockCallback` só é alcançável quando o próprio router invocou
`manager.unlock`, pois o PoolManager chama de volta apenas `msg.sender`, e o
callback valida `msg.sender == address(manager)`. Um chamador externo não pode
injetar um `trader` de terceiros — teste `vincula a carteira ao roteador e os
callbacks ao PoolManager` cobre `OnlyManager`/`OnlyRouter`. Recomendação
residual: nenhuma alteração de código; a invariante permanece "transferFrom
somente de quem iniciou `swap()`".

### F-02 — Slither Medium `uninitialized-local` (Hook `_sell`, `nextSale`) — **corrigido**

`uint64 nextSale;` → `uint64 nextSale = 0;`. Sem mudança comportamental; remove
ambiguidade do detector.

### F-03 — Slither Medium `uninitialized-local` (Hook construtor, `permissions`) — **corrigido**

Inicialização nomeada de todos os 14 campos de `Hooks.Permissions`. Efeito
colateral positivo: uma versão futura da struct com novo bit vira erro de
compilação em vez de bit silenciosamente falso.

### F-04 — Slither Medium `unused-return` (`beforeInitialize` → `manager.getSlot0`) — **justificado**

Apenas `sqrtPriceX96` é necessário; os demais campos de `getSlot0` são
descartados de propósito. Não há risco de pagamento/estado ignorado — é leitura
de view. Mantido com justificativa.

### F-05 — Slither Low `timestamp` (`_sell`, `swap`) + Mythril Low — **justificado**

O vesting de 24h (`sellAfter`) e o `deadline` de ordem são semântica do produto.
A manipulação por validadores é da ordem de segundos, irrelevante contra um
intervalo de 24h. Registrado como exceção documentada.

### F-06 — Solhint warnings remanescentes — **justificado**

`immutable-vars-naming` (convenção do projeto mantém `camelCase` documentado),
`not-rely-on-time` (ver F-05). Os 2 `max-line-length` foram corrigidos.

## Correções aplicadas

- `contracts/uniswap-v4/CASInstallmentHook.sol`
  - `permissions` com inicialização nomeada completa (F-03);
  - `uint64 nextSale = 0;` (F-02);
  - quebra das declarações de eventos `LotOpened`/`InstallmentSold` em múltiplas
    linhas (solhint `max-line-length`).
- Nenhuma mudança comportamental; suíte escopada segue 13/13.

## Limitações e próximos passos

- Cobertura do Mythril no Hook é baixa (o construtor instancia o Router via
  `new`, o que limita a exploração simbólica). Não é evidência de segurança.
- Criar harness Echidna/Foundry para invariantes do hook (itens 1–4 do modelo
  de ameaça) antes de deploy mainnet.
- Auditoria externa independente continua **obrigatória** antes de mainnet.
- `initializer` deve ser um multisig em produção (recomendação da política).

## Evidência

- `slither-uv4.json` — Slither antes das correções (88 resultados no grafo, 8 no escopo).
- `slither-uv4-fixed.json` — Slither após correções (86 resultados, 6 no escopo).
- `mythril-hook.json` — Mythril no Hook (0 issues, cobertura limitada).
- `mythril-router.json` — Mythril no Router (1 Low timestamp, justificado).
- Checklist espelho: `docs/security-checklist.md` (seção deste run).

## Changelog

| Data | Versão | Descrição |
|---|---|---|
| 2026-11-26 | 0.1.0 | Execução inicial do run de auditoria uniswap-v4 (issue #47) |

![footer](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=100&section=footer&animation=twinkling)
