![header](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=200&section=header&text=Fraud%20Arbitration%20System&fontSize=36&fontAlignY=35&animation=twinkling)

![visitors](https://visitor-badge.laobi.icu/badge?page_id=RapportTecnologia.AgenticSpace.smartcontracts_arbitration)

[![License: CC BY-SA 4.0](https://img.shields.io/badge/License-CC_BY--SA_4.0-blue.svg)](https://creativecommons.org/licenses/by-sa/4.0/)
![Language: Portuguese](https://img.shields.io/badge/Language-Portuguese-brightgreen.svg)
![Status](https://img.shields.io/badge/Status-Ongoing-yellow)
[![GitHub Issues](https://img.shields.io/github/issues/RapportTecnologia/AgenticSpace)](https://github.com/RapportTecnologia/AgenticSpace/issues)

# Sistema de Arbitragem de Fraude

## Visão Geral

O Sistema de Arbitragem de Fraude permite congelar endereços fraudulentos no ecossistema Agentic Space através de um processo on-chain democrático. O CSV (`data/fraude.csv`) é a fonte da verdade, espelhada em um banco SQLite (`cas_tracker.db`) para rastreabilidade.

## Arquitetura

### Componentes

- **CASToken (UUPS)**: Adiciona `freeze`, `freezeUntil`, `unfreeze`, `isFrozen` com `COMPLIANCE_ROLE`
- **ArbitrationFacet (Diamond)**: Casos de arbitragem com votação, quorum, timelock e retry
- **AgentDAOFacet / CommunityDAOFacet**: Bloqueiam votação de endereços congelados
- **agentic_space_commons**: `CsvParser`, `FraudDatabase`, `FraudAddressService` (lógica compartilhada)
- **Scripts TypeScript**: Freeze, votação, sanção DAO, monitor diário
- **Systemd**: Timer diário às 23:59

### Fluxo de Arbitragem

1. **CSV → DB → On-chain**: Script `19_freeze_fraud_addresses.ts` lê o CSV, insere no SQLite, aplica freeze on-chain e cria caso de arbitragem
2. **Divulgação**: Período inicial onde o caso é apresentado à comunidade (2 dias configurável). Todos podem operar CAS normalmente, exceto suspeitos
3. **Votação**: Membros com `USER_ROLE` ou `AGENT_ROLE` votam pagando 0.5 CAS (script `20_arbitration_vote.ts`). **Transferências de CAS são bloqueadas** para evitar compra de votos, exceto transferências para endereços com `COMPLIANCE_ROLE` (permitindo pagamento de taxas de votação)
4. **Resultado**: `executeArbitrationCase` avalia o resultado — se uma opção obtiver >50% dos votos válidos, aprova/rejeita; caso contrário, disnova votação (revote). Operações com CAS voltam ao normal (script `21_dao_sanction_proposal.ts`)
5. **Revotação**: Se nenhuma opção alcançar maioria absoluta (>50% dos votos válidos), o caso retorna ao período de Divulgação para nova votação (máx 3 revotes configurável)
6. **Expiração**: Casos sem quorum entram em `handleExpiredCase` — freeze de 6 meses + retry (máx 3)
7. **Monitor Diário**: Script `22_daily_fraud_monitor.ts` detecta novos/removidos, expirados e reincidências

### Três Períodos de Votação

| Período | Duração | Transferências CAS | Votação | Descrição |
|---------|---------|-------------------|---------|-----------|
| **Divulgação** | 2 dias (configurável, 1–7) | ✅ Permitidas (exceto suspeitos) | ❌ Não | Evidências apresentadas; comunidade revisa acusações |
| **Votação** | 5 dias (configurável, 1–14) | 🔒 **Bloqueadas** (exceto COMPLIANCE_ROLE) | ✅ Ativa | DAO vota com poder ponderado; transfers bloqueadas para evitar compra de votos; taxas de votação são permitidas |
| **Resultado** | Até execução | ✅ Retomadas | ❌ Encerrada | Decisão aplicada: culpados congelados, inocentes descongelados |
| **Contestação** | 3 dias (configurável) | ✅ Permitidas | ❌ Encerrada | Período para contestar o resultado antes da execução definitiva |

### Regra de Maioria Absoluta

Para que um caso de arbitragem tenha resultado definitivo, uma das opções (a favor ou contra) deve obter **mais de 50% dos votos válidos** (excluindo abstenções). Se nenhuma opção alcançar essa maioria absoluta, o caso é reaberto para nova votação:

- O contrato retorna ao período de **Divulgação** com novos prazos
- Todos os votantes podem votar novamente (o mapping `hasVotedRound` rastreia qual rodada cada votante participou)
- Os contadores de votos são zerados
- O limite máximo de revotes é configurável via `setMaxRevotes` (padrão: 3)
- Se o limite for atingido sem maioria, a execução reverte com `MaxRevotesReached`

### Votantes Cadastrados

Apenas usuários registrados podem votar — **não há votos anônimos**. O contrato verifica se o votante possui `USER_ROLE` ou `AGENT_ROLE` antes de aceitar o voto. Endereços sem nenhum desses roles recebem o erro `VoterNotRegistered`.

### Sistema de Poder de Voto Ponderado

O sistema de arbitragem utiliza **poder de voto ponderado** que combina múltiplos critérios, em vez de usar apenas o saldo de tokens:

| Critério | Peso Padrão | Descrição |
|---|---|---|
| **Saldo de tokens** | 40% | Componente baseado no saldo de CAS (escala logarítmica para retornos decrescentes) |
| **Tempo de staking** | 30% | Tempo que os tokens permanecem sem movimentação (até 30 dias para bônus total) |
| **Reputação** | 30% | Pontuação de reputação (0–10000), baseada em papel e participação histórica |

**Características adicionais:**

- **Votação quadrática**: `sqrt(poder_bruto)` para reduzir o impacto de grandes saldos (ativável/desativável)
- **Limite máximo de poder**: Cap configurável por carteira (padrão: 1000 unidades)
- **Delegação de votos**: Usuários podem delegar seu poder de voto a outro endereço (`delegateArbitrationVote`)
- **Quórum mínimo**: Percentual mínimo de poder total que deve ser exercido (padrão: 20%)
- Funções admin: `setVotingPowerConfig`, `setReputation`, `getVotingPower`

### Período de Contestação (Challenge)

Após o resultado da votação, o caso entra em um **período de contestação** (padrão: 3 dias) antes da execução definitiva:

- Qualquer usuário cadastrado pode contestar o resultado pagando uma taxa (`challengeResult`)
- O **Conselho Técnico** (membros designados via `setTechnicalCouncilMember`) avalia a contestação:
  - Se **mantida** (`uphold = true`): o resultado original é executado
  - Se **anulada** (`uphold = false`): uma nova rodada de votação é disparada
- Se ninguém contestar, o caso é finalizado automaticamente após o prazo (`finalizeCase`)

### Conselho Técnico

O Conselho Técnico é um grupo de membros confiáveis com poder restrito:

- Apenas membros do conselho podem resolver contestações (`resolveChallenge`)
- O conselho não pode votar diretamente — apenas julgar contestações
- Membros são designados pelo owner do Diamond via `setTechnicalCouncilMember`
- O conselho pode anular um resultado e forçar revotação

### Mecanismo de Recurso (Appeal)

Após a execução definitiva, ainda é possível recorrer:

- Qualquer usuário cadastrado pode apresentar um recurso (`fileAppeal`) pagando uma taxa
- O recurso reabre o caso para nova votação (revote)
- Limite máximo de recursos: 2 (configurável)
- Após o limite, o resultado é definitivo

### Prevenção de Compra de Votos

Durante o período de **Votação**, um lock global é ativado no contrato CASToken (`setVotingLock(true)`). Isso bloqueia transferências de tokens — nenhum usuário pode enviar, receber ou trocar CAS, **exceto transferências para endereços com `COMPLIANCE_ROLE`**, garantindo que o pagamento da taxa de votação (0.5 CAS) possa ser processado. O lock é desativado automaticamente quando não há mais casos ativos no período de Votação.

### Tipos de Freeze

| Tipo | Descrição | Função CASToken |
|---|---|---|
| Permanent | Congelamento definitivo | `freeze(addr)` |
| Temporary | Sem data final (até votação) | `freeze(addr)` |
| Limited | Com data de término | `freezeUntil(addr, endTime)` |

### Taxas

| Operação | Fee Type | Valor |
|---|---|---|
| Propor arbitragem | `FEE_TYPE_ARBITRATION_PROPOSAL` (100010) | 5 CAS |
| Votar em arbitragem | `FEE_TYPE_ARBITRATION_VOTE` (100011) | 0.5 CAS |

### Chave Composta

A chave única no SQLite é `(fraud_date, address, reason)`, garantindo que o mesmo endereço possa ser registrado múltiplas vezes para fraudes diferentes.

### Imutabilidade

Após `is_voted = true`, os campos `case_id`, `voting_deadline`, `freeze_until` e `vote_outcome` tornam-se imutáveis no banco de dados.

## Scripts

| Script | Descrição | Comando |
|---|---|---|
| `18_upgrade_cas_token.ts` | Upgrade UUPS do CASToken | `npm run upgrade:cas-token:polygon` |
| `19_freeze_fraud_addresses.ts` | Freeze + criação de casos | `npm run freeze:fraud:polygon` |
| `20_arbitration_vote.ts` | Votar em caso | `npm run arbitration:vote:polygon` |
| `21_dao_sanction_proposal.ts` | Executar sanção | `npm run arbitration:sanction:polygon` |
| `22_daily_fraud_monitor.ts` | Monitor diário | `npm run fraud:monitor:polygon` |
| `23_diamond_cut_arbitration.ts` | Diamond cut ArbitrationFacet | `npm run diamond-cut:arbitration:polygon` |

## Variáveis de Ambiente

Ver `.env.example` na seção "Fraud Arbitration System".

## Segurança

- Apenas `COMPLIANCE_ROLE` pode freeze/unfreeze no CASToken e ativar/desativar o voting lock
- Apenas `DAO_PROPOSER_ROLE` pode propor casos de arbitragem
- Apenas `DAO_EXECUTOR_ROLE` pode executar casos
- Endereços congelados não podem votar em nenhuma DAO
- `ReentrancyGuardTransient` protege todas as funções de estado
- Auto-unfreeze é aplicado em `_update` do CASToken
- Voting lock bloqueia transferências durante o período de Votação (exceto transferências para endereços com `COMPLIANCE_ROLE`, permitindo pagamento de taxas)
- Maioria absoluta (>50% dos votos válidos ponderados) é obrigatória para resultado definitivo
- Apenas votantes cadastrados (`USER_ROLE` ou `AGENT_ROLE`) podem votar — sem votos anônimos
- Revotação automática quando não há maioria, com limite configurável de 3 revotes
- Poder de voto ponderado combina saldo (40%), staking (30%) e reputação (30%) com votação quadrática
- Limite máximo de poder por carteira (padrão: 1000) evita concentração de voto
- Delegação de votos permite representação, mas o delegador pode revogar a qualquer momento
- Período de contestação (3 dias) permite questionar resultados antes da execução
- Conselho Técnico com poder restrito apenas para resolver contestações
- Mecanismo de recurso (até 2 recursos) permite reabrir casos executados
- Quórum mínimo de 20% do poder total deve ser exercido para resultado válido

## Changelog

| Data | Versão | Descrição |
|---|---|---|
| 2025-07-30 | 0.1.0 | Documentação inicial do sistema de arbitragem |
| 2025-07-30 | 0.2.0 | Adicionados 3 períodos de votação (Divulgação/Votação/Resultado) e voting lock no CASToken |
| 2025-07-31 | 0.3.0 | Adicionada regra de maioria absoluta (>50%), revotação automática, proibição de votos anônimos e exceção de COMPLIANCE_ROLE no voting lock |
| 2025-07-31 | 0.4.0 | Sistema de poder de voto ponderado (saldo + staking + reputação + votação quadrática + cap), delegação de votos, período de contestação, conselho técnico, mecanismo de recurso e correção do voting lock |

![footer](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=100&section=footer&animation=twinkling)
