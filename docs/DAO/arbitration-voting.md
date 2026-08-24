![header](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=200&section=header&text=Arbitration%20Voting&fontSize=36&fontAlignY=35&animation=twinkling)

![visitors](https://visitor-badge.laobi.icu/badge?page_id=RapportTecnologia.AgenticSpace.smartcontracts_arbitration-voting)

[![License: CC BY-SA 4.0](https://img.shields.io/badge/License-CC_BY--SA_4.0-blue.svg)](https://creativecommons.org/licenses/by-sa/4.0/)
![Language: Portuguese](https://img.shields.io/badge/Language-Portuguese-brightgreen.svg)
![Status](https://img.shields.io/badge/Status-Ongoing-yellow)
[![GitHub Issues](https://img.shields.io/github/issues/RapportTecnologia/AgenticSpace)](https://github.com/RapportTecnologia/AgenticSpace/issues)

# Arbitragem e Votação DAO

## Visão Geral

O sistema de arbitragem de fraude integra-se com a governança DAO do Agentic Space para permitir que membros votem em casos de congelamento de endereços fraudulentos.

## Papéis e Permissões

| Papel | Permissão | Autenticação |
|---|---|---|
| `COMPLIANCE_ROLE` | Freeze/unfreeze no CASToken | Agente Nível 2 |
| `DAO_PROPOSER_ROLE` | Propor caso de arbitragem | Agente Nível 1+ |
| `DAO_EXECUTOR_ROLE` | Executar caso aprovado | Agente Nível 2+ |
| `DAO_CANCELLER_ROLE` | Cancelar caso | Agente Nível 2+ |
| `USER_ROLE` / `AGENT_ROLE` | Votar em casos | Humano ou Agente |

**Nota**: Endereços congelados não podem votar em nenhuma DAO (AgentDAO, CommunityDAO, Arbitration).

## Ciclo de Vida do Caso

```
Pending → Active → Executed (aprovado/rejeitado)
                 → Canceled
                 → Expired → RetryPending → Active (refile)
                                          → MaxRetriesReached
```

### 1. Abertura do Caso

- **Quem**: `DAO_PROPOSER_ROLE`
- **Fee**: 5 CAS (`FEE_TYPE_ARBITRATION_PROPOSAL`)
- **Campos**: lista de acusados, motivos, hash de evidência, tipo de freeze, data de término (se limitado)
- **Prazo de votação**: configurável (padrão 5 dias, min 1, max 14)

### 2. Votação

- **Quem**: `USER_ROLE` ou `AGENT_ROLE` (não congelados)
- **Fee**: 0.5 CAS (`FEE_TYPE_ARBITRATION_VOTE`)
- **Opções**: 0=Contra, 1=A favor, 2=Abstenção
- **Quorum**: 5% do total de elegíveis (configurável via `setArbitrationQuorum`)

### 3. Execução

- **Quem**: `DAO_EXECUTOR_ROLE`
- **Quando**: após `votingDeadline`
- **Aprovação**: `forVotes > againstVotes` E quorum atingido
- **Ação**: freeze/unfreeze no CASToken conforme resultado

### 4. Expiração (sem quorum)

- **Quem**: `DAO_EXECUTOR_ROLE` (via `handleExpiredCase`)
- **Ação**: Freeze de 180 dias (6 meses) + incrementa `retryCount`
- **Retry**: `refileExpiredCase` reabre votação (máx 3 tentativas)

## Integração com DAOs Existentes

### AgentDAOFacet

- `castAgentVote`: verifica `_enforceNotFrozen(msg.sender)` antes de processar voto
- Importa `PaymentStorage` e `ICASToken` para verificar freeze

### CommunityDAOFacet

- `castCommunityVote`: verifica `_enforceNotFrozen(msg.sender)` antes de processar voto
- Mesma lógica de verificação via `PaymentStorage.casToken`

## Frontend

A página `/arbitration` exibe todos os casos on-chain com:
- Auto-refresh a cada 30 segundos
- Status de freeze em tempo real
- i18n (pt/en/fr)
- Links para Polygonscan

## Próximos Passos (next_step)

Após implementação completa:
1. Executar `npm run upgrade:cas-token:polygon` para adicionar freeze ao CASToken
2. Executar `npm run diamond-cut:arbitration:polygon` para adicionar ArbitrationFacet
3. Configurar `FRAUD_CSV_PATH` e executar `npm run freeze:fraud:polygon`
4. Habilitar o timer systemd: `systemctl enable --now agentic-fraud-monitor.timer`

## DAO da CAS — Visão Conceitual

A **DAO da CAS** é a instância de governança responsável por votar ações protetivas contra quem insiste em promover más práticas contra a moeda e a economia CAS. É constituída pelo `ArbitrationFacet`, que opera como o braço executor da proteção do ecossistema.

### Responsabilidades da DAO da CAS

- Votar casos de arbitragem contra endereços suspeitos de manipulação
- Deliberar sobre suspensões preventivas, congelamentos (freeze) e sanções
- Executar decisões de freeze/unfreeze no `CASToken` após aprovação
- Gerenciar o ciclo de vida de casos (abertura → votação → execução → expiração)
- Aplicar freeze de 180 dias em casos expirados sem quorum (retry até 3x)

### O que a DAO da CAS NÃO faz

- Não propõe melhorias no ecossistema — isso é função da **DAO Geral**
- Não altera seus próprios parâmetros de governança (quorum, prazos) — mudanças são propostas pela DAO Geral e executadas via `DAO_ADMIN_ROLE`
- Não cria novas regras de manipulação — aplica as regras já definidas nos contratos

### Relação com a DAO Geral

| Instância | Composição | Foco |
|-----------|-----------|------|
| **DAO Geral** | AgentDAO + CommunityDAO | Propor melhorias, evoluir governança, debater mudanças |
| **DAO da CAS** | ArbitrationFacet | Votar ações protetivas, sanções, congelamentos |

A DAO Geral pode propor mudanças nos parâmetros da DAO da CAS (quorum, duração de votação, timelock, max revotes), mas a execução de ações protetivas é exclusiva da DAO da CAS.

> [!info] Documento central
> Para visão completa da estrutura de governança dual, consulte [[dao-structure]].

## Changelog

| Data | Versão | Descrição |
|---|---|---|
| 2026-07-31 | 0.2.0 | Adicionada seção DAO da CAS — Visão Conceitual |
| 2025-07-30 | 0.1.0 | Documentação inicial de arbitragem e votação DAO |

![footer](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=100&section=footer&animation=twinkling)
