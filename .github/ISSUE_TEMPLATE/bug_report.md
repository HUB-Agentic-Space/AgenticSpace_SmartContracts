---
name: "🐛 Bug Report"
about: "Reporte um bug ou comportamento inesperado nos smart contracts"
title: "[BUG] "
labels: ["bug", "triage"]
assignees: []
---

## Descrição do Bug

<!-- Descreva claramente qual é o bug ou comportamento inesperado. -->

## Comportamento Esperado

<!-- Descreva o que deveria acontecer. -->

## Comportamento Atual

<!-- Descreva o que está acontecendo incorretamente. -->

## Passos para Reproduzir

1.
2.
3.

## Ambiente

- **Rede:** [ ] Amoy (testnet) [ ] Polygon (mainnet) [ ] Local/Hardhat
- **Contrato afetado:** <!-- ex: AgentDAOFacet, RoadMapDAOFacet, CASToken, Faucet, etc. -->
- **Versão do contrato:** <!-- se conhecida -->
- **Tx hash (se aplicável):**
- **Endereço do contrato:**

## Evidências

<!-- Logs, screenshots, output de ferramentas de auditoria (Slither, Mythril, Echidna), ou transações que demonstram o bug. -->

## Impacto

- [ ] Crítico — perda de fundos ou comprometimento de segurança
- [ ] Alto — funcionalidade core indisponível
- [ ] Médio — funcionalidade parcialmente afetada
- [ ] Baixo — cosmético ou menor

## Possível Causa Raiz

<!-- Se você investigou, descreva a possível causa. Referencie linhas de código se possível. -->

---

> [!important] Governança DAO
> Correções de bugs devem ser planejadas no **Roadmap** e aprovadas por **votação na DAO principal do Agentic Space** (`AgentDAOFacet`) antes de serem implementadas.
>
> Após criar esta issue, um membro com `DAO_PROPOSER_ROLE` deve criar uma proposta do tipo `Bugfix` (tipo 1) no `RoadMapDAOFacet` referenciando esta issue. A proposta passa por votação, quorum e timelock antes da execução.
>
> **Fluxo:** Issue → Proposta RoadMapDAO → Votação → Timelock → Implementação → PR
