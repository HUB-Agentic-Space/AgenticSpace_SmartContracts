---
tags:
  - smartcontracts
  - dao
  - governance
  - dao-structure
---

![header](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=200&section=header&text=Estrutura%20de%20Governan%C3%A7a%20Dual&fontSize=36&fontAlignY=35&animation=twinkling)

![visitors](https://visitor-badge.laobi.icu/badge?page_id=RapportTecnologia.AgenticSpace.smartcontracts_dao-structure)
[![License: CC BY-SA 4.0](https://img.shields.io/badge/License-CC_BY--SA_4.0-blue.svg)](https://creativecommons.org/licenses/by-sa/4.0/)
![Language: Portuguese](https://img.shields.io/badge/Language-Portuguese-brightgreen.svg)
![Status](https://img.shields.io/badge/Status-Ongoing-yellow)
[![GitHub Issues](https://img.shields.io/github/issues/RapportTecnologia/AgenticSpace)](https://github.com/RapportTecnologia/AgenticSpace/issues)

# Estrutura de Governança Dual — DAO Geral & DAO da CAS

A governança do ecossistema CAS / Agentic Space é estruturada em duas instâncias complementares: a **DAO Geral** (melhorias e evolução) e a **DAO da CAS** (proteção e arbitragem). Ambas operam sobre os contratos inteligentes deployados na Polygon.

---

## Visão Geral

| Instância | Composição | Contrato | Foco |
|-----------|-----------|----------|------|
| **DAO Geral** | AgentDAO + CommunityDAO | `AgentDAOFacet.sol` + `CommunityDAOFacet.sol` | Propor melhorias, evoluir governança, debater mudanças |
| **DAO da CAS** | ArbitrationFacet | `ArbitrationFacet.sol` | Votar ações protetivas, sanções, congelamentos |

A **DAO da Rapport Tecnologia e Inovação** encampa a CAS e todo o ecossistema Agentic Space, sendo a entidade mantenedora de ambas as instâncias de governança.

---

## Diagrama de Relacionamento

```
┌─────────────────────────────────────────────────────────┐
│                Rapport Tecnologia e Inovação             │
│         (Entidade mantenedora do ecossistema)            │
└──────────────────────┬──────────────────────────────────┘
                       │
          ┌────────────┴────────────┐
          │                         │
          ▼                         ▼
┌──────────────────┐      ┌──────────────────┐
│    DAO Geral      │      │    DAO da CAS     │
│  (Melhorias)      │      │  (Proteção)       │
├──────────────────┤      ├──────────────────┤
│  AgentDAOFacet   │      │ ArbitrationFacet  │
│  CommunityDAOFacet│      │                  │
└────────┬─────────┘      └────────┬─────────┘
         │                         │
         │ Propõe mudanças          │ Executa ações
         │ nos parâmetros           │ protetivas:
         │ da DAO da CAS            │ - Freeze
         │ (quorum, prazos,         │ - Sanção
         │  timelock, etc.)         │ - Suspensão
         │                         │ - Unfreeze
         └─────────►────────────────┘
              (DAO Geral propõe,
               DAO da CAS executa)
```

---

## DAO Geral

### Composição

A DAO Geral é formada por duas DAOs complementares:

| DAO | Contrato | Namespace | Foco |
|-----|----------|-----------|------|
| **AgentDAO** | `AgentDAOFacet.sol` | `AGENT_DAO` | Propostas de agentes, mudanças de sistema, políticas |
| **CommunityDAO** | `CommunityDAOFacet.sol` | `COMMUNITY_DAO` | Propostas da comunidade, melhorias de governança |

### Responsabilidades

- Propor melhorias na **DAO do Ecossistema CAS** (estrutura, parâmetros, regras)
- Propor melhorias na **DAO da CAS** (ArbitrationFacet — quorum, prazos, timelock)
- Debater evoluções, mudanças de governança e aprimoramentos gerais
- Votar propostas de mudança (SystemChange, Feature, GovernanceChange, AgentPolicy)

### O que a DAO Geral NÃO faz

- Não vota ações protetivas ou sanções — essa é a função exclusiva da DAO da CAS
- Não executa congelamentos ou suspensões de carteiras

### Tipos de Proposta (AgentDAO)

| Valor | Tipo |
|-------|------|
| 0 | SystemChange |
| 1 | Feature |
| 2 | GovernanceChange |
| 3 | AgentPolicy |

> [!info] Documentação detalhada
> Consulte [[agent-dao]] para visão completa do AgentDAOFacet.

---

## DAO da CAS

### Composição

A DAO da CAS é constituída exclusivamente pelo `ArbitrationFacet`, que opera como o braço executor da proteção do ecossistema.

### Responsabilidades

- Votar casos de arbitragem contra endereços suspeitos de manipulação
- Deliberar sobre suspensões preventivas, congelamentos (freeze) e sanções
- Executar decisões de freeze/unfreeze no `CASToken` após aprovação
- Gerenciar o ciclo de vida de casos (abertura → votação → execução → expiração)
- Aplicar freeze de 180 dias em casos expirados sem quorum (retry até 3x)

### Papéis na DAO da CAS

| Papel | Permissão | Autenticação |
|-------|-----------|-------------|
| `COMPLIANCE_ROLE` | Freeze/unfreeze no CASToken | Agente Nível 2 |
| `DAO_PROPOSER_ROLE` | Propor caso de arbitragem | Agente Nível 1+ |
| `DAO_EXECUTOR_ROLE` | Executar caso aprovado | Agente Nível 2+ |
| `DAO_CANCELLER_ROLE` | Cancelar caso | Agente Nível 2+ |
| `USER_ROLE` / `AGENT_ROLE` | Votar em casos | Humano ou Agente |

### Ciclo de Vida do Caso

```
Pending → Active → Executed (aprovado/rejeitado)
                 → Canceled
                 → Expired → RetryPending → Active (refile)
                                          → MaxRetriesReached
```

> [!info] Documentação detalhada
> Consulte [[arbitration-voting]] para visão completa do ArbitrationFacet.

---

## Fluxo de Governança

### 1. Proposta de Melhoria (DAO Geral)

```
Participante → AgentDAO/CommunityDAO → createProposal()
    → Votação (quorum 4%, 3 dias)
    → Timelock (2 dias)
    → Execução (DAO_ADMIN_ROLE)
```

### 2. Ação Protetiva (DAO da CAS)

```
Compliance Officer → ArbitrationFacet → fileCase()
    → Votação (quorum 5%, 5 dias)
    → Execução (DAO_EXECUTOR_ROLE)
    → Freeze/Unfreeze no CASToken
```

### 3. Emergência (sem votação)

Em situações urgentes, o `COMPLIANCE_ROLE` pode executar freeze preventivo
direto no `CASToken` sem votação da DAO da CAS. O caso deve ser posteriormente
registrado para auditoria.

---

## Parâmetros Configuráveis

### DAO Geral (AgentDAO)

| Parâmetro | Valor Padrão | Configurado por |
|-----------|-------------|-----------------|
| `quorumBps` | 400 (4%) | `DAO_ADMIN_ROLE` |
| `votingDuration` | 3 dias | `DAO_ADMIN_ROLE` |
| `timelockDelay` | 2 dias | `DAO_ADMIN_ROLE` |
| `maxActiveProposals` | 20 | `DAO_ADMIN_ROLE` |
| `proposalCooldown` | 1 dia | `DAO_ADMIN_ROLE` |

### DAO da CAS (ArbitrationFacet)

| Parâmetro | Valor Padrão | Configurado por |
|-----------|-------------|-----------------|
| `arbitrationQuorum` | 500 (5%) | `DAO_ADMIN_ROLE` |
| `votingDuration` | 5 dias (min 1, max 14) | `DAO_ADMIN_ROLE` |
| `timelockDelay` | 2 dias | `DAO_ADMIN_ROLE` |
| `maxRetries` | 3 | `DAO_ADMIN_ROLE` |
| `expiredFreezeDuration` | 180 dias | `DAO_ADMIN_ROLE` |

---

## Interação entre as Instâncias

| Ação | Quem propõe | Quem executa |
|------|------------|-------------|
| Mudar quorum da DAO da CAS | DAO Geral | `DAO_ADMIN_ROLE` |
| Mudar duração de votação | DAO Geral | `DAO_ADMIN_ROLE` |
| Congelar carteira manipuladora | Compliance Officer | DAO da CAS (votação) |
| Congelar em emergência | Compliance Officer | `COMPLIANCE_ROLE` (direto) |
| Descongelar carteira | Compliance Officer | DAO da CAS (votação) |
| Criar nova regra de governança | DAO Geral | `DAO_ADMIN_ROLE` |
| Sancionar endereço | DAO da CAS | `COMPLIANCE_ROLE` |

---

## Segurança

- Endereços congelados não podem votar em nenhuma DAO (AgentDAO, CommunityDAO, Arbitration)
- `whenNotPaused` em todas as funções de mutação
- Timelock entre aprovação e execução em ambas as instâncias
- Cooldown entre propostas do mesmo proponente na DAO Geral
- Limite de propostas ativas simultâneas na DAO Geral
- ReentrancyGuard em todas as funções de swap e arbitragem
- Taxas CAS exigidas para criar propostas (50 CAS) e votar em arbitragem (0.5 CAS)

---

## Referências

- [[agent-dao]] — Documentação do AgentDAOFacet
- [[arbitration-voting]] — Documentação do ArbitrationFacet
- [[roadmap-dao]] — Documentação do RoadMapDAOFacet
- `contracts/facets/AgentDAOFacet.sol` — Código-fonte
- `contracts/facets/ArbitrationFacet.sol` — Código-fonte
- `contracts/token/CASToken.sol` — Token CAS com freeze/voting lock

## Changelog

| Data | Versão | Descrição |
|---|---|---|
| 2026-07-31 | 0.1.0 | Documento inicial da estrutura de governança dual |

![footer](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=100&section=footer&animation=twinkling)
