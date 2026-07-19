---
name: "💡 Sugestão / Melhoria"
about: "Sugira melhorias, otimizações ou mudanças em smart contracts existentes"
title: "[SUGGESTION] "
labels: ["suggestion", "enhancement", "triage"]
assignees: []
---

## Resumo da Sugestão

<!-- Descreva brevemente a sugestão ou melhoria. -->

## Motivação

<!-- Explique por que esta melhoria é importante. Que benefício ela traz? -->

## Descrição Detalhada

<!-- Descreva a sugestão em detalhes: -->
<!-- - O que mudaria? -->
<!-- - Como funcionaria? -->
<!-- - Que contratos/funções seriam afetados? -->

## Tipo de Melhoria

- [ ] Otimização de gas
- [ ] Melhoria de segurança
- [ ] Refatoração de código
- [ ] Melhoria de documentação
- [ ] Melhoria de UX (integração off-chain)
- [ ] Melhoria de testes
- [ ] Melhoria de access control
- [ ] Outro: <!-- especificar -->

## Contratos Afetados

- [ ] Diamond (proxy)
- [ ] AccessControlFacet
- [ ] UserRegistryFacet
- [ ] AgentRegistryFacet
- [ ] AgentValidatorFacet
- [ ] AgentDAOFacet
- [ ] RoadMapDAOFacet
- [ ] ContractRegistryFacet
- [ ] PaymentFacet
- [ ] GasPromotionFacet
- [ ] CASToken
- [ ] InfrastructureFund
- [ ] FundTrackerToken
- [ ] Faucet
- [ ] Bibliotecas (VotingLib, MerkleLib, etc.)
- [ ] Outro: <!-- especificar -->

## Impacto Esperado

<!-- Descreva o impacto esperado da melhoria: -->
<!-- - Redução de gas estimada -->
<!-- - Melhoria de segurança -->
<!-- - Simplificação de código -->
<!-- - Melhor manutenibilidade -->

## Compatibilidade

- [ ] Breaking change (requer migração ou diamondCut de substituição)
- [ ] Compatible com versão atual (aditivo)
- [ ] Requer novo storage namespace
- [ ] Requer mudança em interface

## Exemplo de Implementação (opcional)

```solidity
// Se aplicável, forneça um exemplo de código da mudança sugerida
```

---

> [!important] Governança DAO
> Sugestões e melhorias devem ser planejadas no **Roadmap** e aprovadas por **votação na DAO principal do Agentic Space** (`AgentDAOFacet`) antes de serem implementadas.
>
> Após criar esta issue, um membro com `DAO_PROPOSER_ROLE` deve criar uma proposta do tipo `Refactor` (tipo 2) ou `Feature` (tipo 0) no `RoadMapDAOFacet` referenciando esta issue, dependendo da natureza da sugestão. A proposta passa por votação, quorum e timelock antes da execução.
>
> **Fluxo:** Issue → Proposta RoadMapDAO → Votação → Timelock → Implementação → PR
