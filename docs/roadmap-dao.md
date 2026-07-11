# RoadMapDAO

## Propósito

DAO customizada para a Equipe de Projetos decidir o RoadMap do sistema. Membros da equipe criam propostas (features, bugfixes, refactors) e votam.

## Tipos de Proposta

| Valor | Tipo |
|---|---|
| 0 | Feature |
| 1 | Bugfix |
| 2 | Refactor |
| 3 | GovernanceChange |

## Funções

### createProposal(uint8 proposalType, string title, string description, bytes data) → uint256
- **Auth:** `DAO_PROPOSER_ROLE`
- Cria proposta com votação de `votingDuration` segundos
- Respeita cooldown de `proposalCooldown` entre propostas
- Limite de `maxActiveProposals` simultâneas

### castVote(uint256 proposalId, uint8 support)
- **Auth:** `DAO_VOTER_ROLE`
- Voto: 0=Against, 1=For, 2=Abstain
- Um voto por endereço por proposta

### cancelProposal(uint256 proposalId)
- **Auth:** `DAO_CANCELLER_ROLE`
- Cancela proposta ativa ou pendente

### queueProposal(uint256 proposalId)
- **Auth:** `DAO_EXECUTOR_ROLE`
- Coloca proposta aprovada em fila (timelock)

### executeProposal(uint256 proposalId) → bytes
- **Auth:** `DAO_EXECUTOR_ROLE`
- Executa proposta após timelock
- Janela de execução: `EXECUTION_WINDOW` (7 dias)

### Configuração (admin apenas)
- `setQuorum(uint256)`: quorum em basis points (ex: 400 = 4%)
- `setVotingDuration(uint256)`: duração em segundos (1-14 dias)
- `setTimelockDelay(uint256)`: delay do timelock (1-30 dias)
- `setMaxActiveProposals(uint256)`: limite de propostas ativas
- `setProposalCooldown(uint256)`: cooldown entre propostas
- `addTeamMember(address)`: concede proposer + voter roles
- `removeTeamMember(address)`: revoga roles

## Parâmetros Padrão

| Parâmetro | Valor |
|---|---|
| quorumBps | 400 (4%) |
| votingDuration | 3 dias |
| timelockDelay | 2 dias |
| maxActiveProposals | 20 |
| proposalCooldown | 1 dia |

## Estados de Proposta

`Pending → Active → Succeeded → Queued → Executed`
`Active → Defeated` (se quorum não atingido)
`Active/Pending → Canceled`
`Queued → Expired` (se não executado em 7 dias)

## Taxas CAS

| Operação | Taxa (CAS) |
|---|---|
| Criar Proposta | 200 CAS |
| Votar em Proposta | 10 CAS |

> As taxas podem ser ajustadas pelo admin via `updateFees()`. O pagamento é processado via `PaymentLib` e direcionado ao `InfrastructureFund`.

## Eventos

- `ProposalCreated(proposalId, proposalType, title, proposer)`
- `VoteCast(proposalId, voter, support)`
- `ProposalCanceled(proposalId)`
- `ProposalQueued(proposalId, eta)`
- `ProposalExecuted(proposalId)`
- `ProposalExpired(proposalId)`

## Segurança

- ReentrancyGuard
- Pausable
- UUPS upgradeável
- `DAO_PROPOSER_ROLE` para criar propostas
- `DAO_VOTER_ROLE` para votar
- `DAO_EXECUTOR_ROLE` para executar
- `DAO_CANCELLER_ROLE` para cancelar
- Timelock entre aprovação e execução
- `SafeERC20` para transferências de taxas CAS

## Changelog

| Data | Versão | Descrição |
|---|---|---|
| 2025-07-11 | 0.1.0 | Documentação inicial: funções, parâmetros, estados, taxas, segurança |
