# Pull Request

## Descrição

<!-- Descreva claramente o que este PR faz e por quê. -->

## Issue Relacionada

<!-- Referencie a issue que este PR resolve. Use "Fixes #N", "Closes #N" ou "Resolves #N". -->

Fixes #

## Proposta DAO Relacionada

<!-- Todo PR deve estar vinculado a uma proposta aprovada na DAO. -->

- **DAO:** [ ] RoadMapDAO [ ] AgentDAO
- **Proposal ID:** <!-- ID da proposta aprovada -->
- **Tipo de Proposta:** [ ] Feature (0) [ ] Bugfix (1) [ ] Refactor (2) [ ] GovernanceChange (3)
- **Estado da Proposta:** [ ] Succeeded [ ] Queued [ ] Executed
- **Tx hash da execução:** <!-- se aplicável -->

> [!warning] Aprovação Prévia Obrigatória
> Este PR **não será revisado** sem uma proposta aprovada na DAO principal do Agentic Space (`AgentDAOFacet` ou `RoadMapDAOFacet`). Toda mudança deve ser planejada no Roadmap e aprovada por votação antes da implementação.

## Tipo de Mudança

- [ ] Bug fix (correção de bug aprovado via DAO)
- [ ] New feature (novo recurso aprovado via DAO)
- [ ] Refactor (melhoria aprovada via DAO)
- [ ] Governance change (mudança de governança aprovada via DAO)
- [ ] Documentação
- [ ] Testes
- [ ] Configuração/CI

## Contratos Modificados

<!-- Liste os contratos modificados ou adicionados. -->

- `contracts/...`

## Mudanças de Storage

- [ ] Nenhuma mudança de storage
- [ ] Novo namespace de storage
- [ ] Modificação em struct existente (requer cuidado com slots)
- [ ] Novo facet adicionado (requer `diamondCut`)

## Access Control

- [ ] Nenhuma mudança em access control
- [ ] Novo role adicionado
- [ ] Role modificado
- [ ] Função de admin alterada

## Checklist de Segurança

- [ ] Visibilidade explícita em todas as funções e variáveis
- [ ] Custom errors usados ao invés de require com strings
- [ ] Events emitidos para todas as mutações de estado
- [ ] Validação de input em todas as funções external
- [ ] Checks-Effects-Interactions respeitado
- [ ] Reentrância considerada e mitigada
- [ ] Access control verificado (roles corretos)
- [ ] Pausable verificado (whenNotPaused onde aplicável)
- [ ] Sem secrets no código
- [ ] Gas otimizado (calldata, cache de storage, unchecked onde seguro)

## Checklist de Código

- [ ] SPDX-License-Identifier: CC-BY-SA-4.0
- [ ] Pragma: `^0.8.28`
- [ ] Nome do arquivo = nome do contrato
- [ ] Estrutura: State → Events → Errors → Init → External → Internal → View
- [ ] `uint256` ao invés de `uint`
- [ ] Constantes em `UPPER_SNAKE_CASE`
- [ ] Funções em `camelCase`
- [ ] Contratos em `PascalCase`

## Testes

- [ ] Testes unitários adicionados/atualizados
- [ ] Testes de integração adicionados/atualizados (se aplicável)
- [ ] Caminho feliz testado
- [ ] Edge cases testados
- [ ] Access control testado (revert para roles incorretos)
- [ ] Reentrância testada (se aplicável)
- [ ] Fuzzing com Foundry (se aplicável)

```bash
# Comandos para rodar os testes
npm test
npm run test:foundry
npm run test:coverage
```

## Auditoria

- [ ] `npm run audit:solhint` — sem erros
- [ ] `npm run audit:slither` — sem issues críticas/high
- [ ] `npm run audit:mythril` — sem vulnerabilidades (se aplicável)
- [ ] `npm run audit:echidna` — invariantes mantidos (se aplicável)

```bash
# Comandos de auditoria
npm run audit:solhint
npm run audit:slither
npm run audit:full
```

## Deploy

- [ ] Não requer deploy (apenas documentação/testes)
- [ ] Requer `diamondCut` (adicionar/substituir/remover facet)
- [ ] Requer deploy de novo contrato standalone
- [ ] Requer registro no `ContractRegistry`
- [ ] Requer inicialização (`init*()`)
- [ ] Requer configuração pós-deploy (setters)

### Script de Deploy

<!-- Se aplicável, descreva o script e os passos de deploy. -->

```bash
# Comando de deploy
npm run deploy:amoy    # testnet
npm run deploy:polygon # mainnet
```

## Documentação

- [ ] docs/ atualizado (se mudança de comportamento)
- [ ] README.md atualizado (se mudança de setup/uso)
- [ ] REQUIREMENTS.md atualizado (se mudança de requisitos)
- [ ] NatSpec comments adicionados/atualizados nos contratos

## Breaking Changes

- [ ] Sem breaking changes
- [ ] Breaking change documentado abaixo

<!-- Se houver breaking changes, descreva aqui e o plano de migração. -->

---

> [!important] Governança DAO — Lembrete
> Todo PR deve estar vinculado a uma **proposta aprovada** na DAO principal do Agentic Space. O Roadmap é a fonte de verdade para o planejamento. Mudanças não aprovadas via votação serão recusadas.
>
> **Fluxo completo:** Issue → Proposta RoadMapDAO → Votação (quorum + maioria) → Timelock → Execução → Implementação (este PR) → Revisão → Merge
