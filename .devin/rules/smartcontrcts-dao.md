---
trigger: model_decision
description: Aplicado ao criar, modificar ou revisar contratos DAO customizados em Solidity. Define estrutura de propostas, votação, quorum, timelock e padrões de governança on-chain.
---

# DAO Contracts Rule

> Padrões de projeto e convenções gerais: ver `smartcontracts.md`
> Deploy de DAOs via Factory e registro no ContractRegistry: ver `deploy.md`
> Segurança e auditoria (ReentrancyGuard, Pausable, access control): ver `solidity-security.md`

## Estrutura de Propostas

- Cada proposta tem: `proposalId` (uint256), `proposer` (address), `proposalType` (enum), `title` (string), `description` (string), `data` (bytes), `createdAt` (uint256), `votingDeadline` (uint256), `executedAt` (uint256), `state` (enum).
- `proposalId` gerado por contador incremental (`_proposalCount++`).
- `proposalType` deve ser um enum explícito (ex: `Feature, Bugfix, Refactor, GovernanceChange`).

## Estados de Proposta

```solidity
enum ProposalState {
    Pending,      // Criada, aguardando início da votação
    Active,       // Votação em andamento
    Canceled,     // Cancelada pelo proposer ou admin
    Defeated,       // Votação encerrada, não atingiu quorum
    Succeeded,    // Votação encerrada, aprovada
    Queued,       // Aguardando timelock
    Executed,     // Executada
    Expired       // Não executada dentro do prazo
}
```

## Votação

- **Voto:** `enum VoteSupport { Against, For, Abstain }`.
- **Peso do voto:** 1 agente = 1 voto (para AgentDAO). 1 membro = 1 voto (para RoadMapDAO).
- **Delegação:** Agentes podem delegar seu voto em outro agente (AgentDAO apenas).
- **Quorum:** Percentual mínimo de participação para proposta ser válida. Configurável via setter com access control.
- **Duração da votação:** Configurável (ex: 3 dias em blocos). Usar `block.timestamp` apenas como aproximação.
- **Limite de mudança de voto:** Voto é final após ser depositado (não permite mudança).

## Timelock

- Propostas aprovadas devem aguardar `timelockDelay` antes da execução.
- Timelock permite cancelamento por admin em caso de emergência.
- `timelockDelay` configurável via setter com access control.
- Janela de execução: após timelock, proposta pode ser executada em até `executionWindow` blocos.

## Access Control

- **RoadMapDAO:** Apenas membros da Equipe de Projetos podem criar e votar em propostas.
- **AgentDAO:** Apenas agentes registrados no `AgentRegistry` e validados no `AgentValidator` podem votar.
- **AgentDAO - Votação Autônoma:** Agentes podem votar autonomamente se tiverem `AGENT_ROLE` ativo.
- **AgentDAO - Votação Dirigida:** Humanos podem dirigir o voto de seus agentes via assinatura off-chain + relayer.

## Padrões de Projeto para DAOs

- **Command:** Propostas encapsulam ações a serem executadas. `data` (bytes) contém a codificação da função alvo.
- **Strategy:** `IVotingStrategy` permite diferentes métodos de votação (majoritária, quadrática, ponderada).
- **Factory:** Deploy de novas instâncias de DAO via factory, registradas no `ContractRegistry`.
- **Template:** Contratos base (`DAOTemplate`) que podem ser clonados via EIP-1167 minimal proxy.

## Eventos Obrigatórios

```solidity
event ProposalCreated(uint256 indexed proposalId, address indexed proposer, uint8 proposalType, string title, uint256 votingDeadline);
event VoteCast(uint256 indexed proposalId, address indexed voter, uint8 support, uint256 weight);
event ProposalCanceled(uint256 indexed proposalId);
event ProposalExecuted(uint256 indexed proposalId, bytes result);
event ProposalQueued(uint256 indexed proposalId, uint256 eta);
event QuorumUpdated(uint256 oldQuorum, uint256 newQuorum);
event VotingDurationUpdated(uint256 oldDuration, uint256 newDuration);
event VoteDelegated(address indexed delegator, address indexed delegatee);
```

## Segurança Específica

- **ReentrancyGuard:** Proteger funções de votação e execução.
- **Pausable:** Permitir pausar criação de propostas em emergência.
- **Max proposals:** Limite de propostas ativas simultâneas para evitar DoS.
- **Min delay entre propostas:** Cooldown para evitar spam de propostas pelo mesmo endereço.
- **Validação de executor:** Apenas endereços whitelistados podem ser alvo de execução de propostas.

## Deploy de DAOs

- Deploy de novas instâncias de DAO via Factory, registradas no `ContractRegistry`.
- Ver `deploy.md` para processo completo de deploy, ambientes e checklist.
