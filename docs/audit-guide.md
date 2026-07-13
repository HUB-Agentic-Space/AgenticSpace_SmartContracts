---
tags:
  - smartcontracts
  - audit
  - security
---

![header](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=200&section=header&text=Auditoria%20e%20An%C3%A1lise&fontSize=36&fontAlignY=35&animation=twinkling)

![visitors](https://visitor-badge.laobi.icu/badge?page_id=RapportTecnologia.AgenticSpace.smartcontracts_audit-guide)
[![License: CC BY-SA 4.0](https://img.shields.io/badge/License-CC_BY--SA_4.0-blue.svg)](https://creativecommons.org/licenses/by-sa/4.0/)
![Language: Portuguese](https://img.shields.io/badge/Language-Portuguese-brightgreen.svg)
![Status](https://img.shields.io/badge/Status-Ongoing-yellow)
[![GitHub Issues](https://img.shields.io/github/issues/RapportTecnologia/AgenticSpace)](https://github.com/RapportTecnologia/AgenticSpace/issues)

# Guia de Auditoria e Análise

## Ferramentas

| Ferramenta | Tipo | Comando |
|---|---|---|
| Solhint | Linting | `npm run audit:solhint` |
| Slither | Análise estática | `npm run audit:slither` |
| Mythril | Análise simbólica | `npm run audit:mythril` |
| Echidna | Fuzzing | `npm run audit:echidna` |
| Hardhat Coverage | Cobertura | `npm run analyze:coverage` |

## Auditoria Completa

```bash
npm run audit:full
```

Executa Solhint → Slither → Mythril → Echidna em sequência.

## Instalação das Ferramentas

### Solhint
```bash
npm install -g solhint
```

### Slither
```bash
pip3 install slither-analyzer
```

### Mythril
```bash
pip3 install mythril
```

### Echidna
```bash
# Linux: https://github.com/crytic/echidna/releases
# ou: nix-env -iA nixpkgs.echidna
```

### Foundry
```bash
curl -L https://foundry.paradigm.xyz | bash
foundryup
```

## Critérios de Aprovação

- **Solhint:** Zero erros
- **Slither:** Zero issues High/Medium sem justificativa
- **Mythril:** Zero issues críticas
- **Echidna:** Zero falhas de invariante
- **Cobertura:** Mínimo 90% em contratos core

## Análise de Gas

```bash
npm run analyze:gas
```

Gera relatório de gas consumption por função.

## Tamanho de Contratos

```bash
npm run analyze:size
```

Verifica se os contratos estão dentro do limite EIP-170 (24KB).

> [!info] Diamond e EIP-170
> No padrão Diamond (EIP-2535), cada facet é um contrato independente e deve respeitar o limite de 24KB individualmente. O proxy `Diamond` em si é pequeno. Se uma facet exceder o limite, divida a lógica em duas facets.

## Fuzzing com Foundry

```bash
npm run test:foundry
```

Executa testes com fuzzing e invariant testing configurados em `foundry.toml`.

## Segurança e Boas Práticas

- **Nunca** rode auditorias com chaves privadas de produção no `.env`
- Use `--network hardhat` (fork local) para testes que precisam de estado on-chain
- Mantenha os relatórios de auditoria versionados em `docs/audits/` (criar se não existir)
- Slither e Mythril requerem Python 3.10+ — instale via `pip3 install slither-analyzer mythril`
- Echidna requer instalação separada (não disponível via npm/pip)
- Após auditoria, documente falsos positivos com justificativa no relatório

## Changelog

| Data | Versão | Descrição |
|---|---|---|
| 2025-07-12 | 0.2.0 | Obsidian format, nota sobre Diamond e EIP-170 |
| 2025-07-11 | 0.1.0 | Documentação inicial: ferramentas, instalação, critérios, análise |

![footer](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=100&section=footer&animation=twinkling)
