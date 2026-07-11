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
| 2025-07-11 | 0.1.0 | Documentação inicial: ferramentas, instalação, critérios, análise |
