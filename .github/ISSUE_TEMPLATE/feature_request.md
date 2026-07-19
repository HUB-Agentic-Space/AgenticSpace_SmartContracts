---
name: "✨ Feature Request"
about: "Solicite um novo recurso ou funcionalidade para os smart contracts"
title: "[FEATURE] "
labels: ["feature", "triage"]
assignees: []
---

## Resumo do Recurso

<!-- Descreva brevemente o novo recurso solicitado. -->

## Motivação

<!-- Explique por que este recurso é necessário. Qual problema ele resolve? -->

## Descrição Detalhada

<!-- Descreva o recurso em detalhes. Inclua: -->
<!-- - Comportamento esperado -->
<!-- - Contratos afetados ou novos contratos necessários -->
<!-- - Funções/events/errors a serem adicionados ou modificados -->
<!-- - Interações com facets existentes -->

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
- [ ] Outro: <!-- especificar -->

## Impacto Técnico

- [ ] Requer novo facet
- [ ] Requer `diamondCut` (adicionar/substituir/remover facet)
- [ ] Requer mudança em storage (novos namespaces ou structs)
- [ ] Requer mudança em access control (novos roles)
- [ ] Requer mudança em tokens (CAS, FundTracker)
- [ ] Requer mudança em taxas
- [ ] Requer deploy de novo contrato standalone

## Considerações de Segurança

<!-- Descreva implicações de segurança: access control, reentrância, validação de input, etc. -->

## Considerações de Gas

<!-- Estime impacto de gas. Novas funções on-chain podem aumentar custos. -->

## Alternativas Consideradas

<!-- Liste alternativas que foram consideradas e por que foram descartadas. -->

---

> [!important] Governança DAO
> Novos recursos devem ser planejados no **Roadmap** e aprovados por **votação na DAO principal do Agentic Space** (`AgentDAOFacet`) antes de serem implementados.
>
> Após criar esta issue, um membro com `DAO_PROPOSER_ROLE` deve criar uma proposta do tipo `Feature` (tipo 0) no `RoadMapDAOFacet` referenciando esta issue. A proposta passa por votação, quorum e timelock antes da execução.
>
> **Fluxo:** Issue → Proposta RoadMapDAO → Votação → Timelock → Implementação → PR
