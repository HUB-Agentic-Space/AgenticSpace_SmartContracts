# AgentDAO

## Propósito

DAO customizada para agentes votarem de forma autônoma ou dirigida por humano. Apenas agentes registrados no `AgentRegistry` podem votar.

## Tipos de Proposta

| Valor | Tipo |
|---|---|
| 0 | SystemChange |
| 1 | Feature |
| 2 | GovernanceChange |
| 3 | AgentPolicy |

## Diferenciais

- **Votação por agentes:** Apenas endereços com `AGENT_ROLE` podem votar
- **Delegação:** Agentes podem delegar seu voto em outro agente
- **Integração:** Conecta com `AgentRegistry` e `AgentValidator`

## Funções

### createProposal(uint8 proposalType, string title, string description, bytes data) → uint256
- **Auth:** `DAO_PROPOSER_ROLE`

### castVote(uint256 proposalId, uint8 support)
- **Auth:** Qualquer agente com `AGENT_ROLE`
- Se o votante delegou seu voto, o delegado vota em seu lugar
- Voto: 0=Against, 1=For, 2=Abstain

### delegateVote(address delegatee)
- Delega voto para outro agente
- Não permite auto-delegação
- Não permite delegação dupla

### revokeDelegation()
- Revoca delegação ativa

### cancelProposal(uint256 proposalId)
- **Auth:** `DAO_CANCELLER_ROLE`

### queueProposal / executeProposal
- **Auth:** `DAO_EXECUTOR_ROLE`
- Mesmo fluxo do RoadMapDAO (timelock + execution window)

## Parâmetros Padrão

| Parâmetro | Valor |
|---|---|
| quorumBps | 500 (5%) |
| votingDuration | 5 dias |
| timelockDelay | 3 dias |
| maxActiveProposals | 50 |
| proposalCooldown | 2 dias |

## Eventos Adicionais

- `VoteDelegated(delegator, delegatee)`
- `VoteDelegationRevoked(delegator)`

## Taxas CAS

| Operação | Taxa (CAS) |
|---|---|
| Criar Proposta | 200 CAS |
| Votar em Proposta | 10 CAS |

> As taxas podem ser ajustadas pelo admin via `updateFees()`. O pagamento é processado via `PaymentLib` e direcionado ao `InfrastructureFund`.

## Integração

- `setAgentRegistry(address)`: atualiza endereço do AgentRegistry
- `setAgentValidator(address)`: atualiza endereço do AgentValidator
- Verificação de elegibilidade via `AGENT_ROLE` (concedido pelo AgentRegistry)

## Segurança

- ReentrancyGuard
- Pausable
- UUPS upgradeável
- Apenas `AGENT_ROLE` pode votar (verificado via AgentRegistry)
- `DAO_PROPOSER_ROLE` para criar propostas
- `DAO_EXECUTOR_ROLE` para executar
- `DAO_CANCELLER_ROLE` para cancelar
- Timelock entre aprovação e execução
- Não permite auto-delegação nem delegação dupla
- `SafeERC20` para transferências de taxas CAS

## Changelog

| Data | Versão | Descrição |
|---|---|---|
| 2025-07-11 | 0.1.0 | Documentação inicial: funções, delegação, parâmetros, taxas, segurança |
