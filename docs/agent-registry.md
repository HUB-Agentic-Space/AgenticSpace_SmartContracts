# AgentRegistry

## Propósito

Registro único de agentes na blockchain. Cada agente é identificado por `agentId = keccak256(did, ownerAddress)`, vinculando o DID do usuário ao endereço da carteira.

## Funções

### registerAgent(string did, string publicId, string auid)
- **Auth:** Pública (qualquer endereço pode registrar seus agentes)
- Calcula `agentId = keccak256(did, msg.sender)`
- Verifica unicidade do `agentId` e do `publicId`
- Concede `AGENT_ROLE` ao `msg.sender`
- Emite `AgentRegistered`

### updateAgent(bytes32 agentId, string publicId)
- **Auth:** Apenas o owner do agente
- Atualiza o `publicId` (verifica unicidade)
- Emite `AgentUpdated`

### deactivateAgent(bytes32 agentId)
- **Auth:** Owner do agente ou admin
- Marca `isActive = false`
- Revoga `AGENT_ROLE` se não houver mais agentes ativos
- Emite `AgentDeactivated`

### reactivateAgent(bytes32 agentId)
- **Auth:** Owner do agente ou admin
- Marca `isActive = true`
- Reconcede `AGENT_ROLE`
- Emite `AgentReactivated`

### getAgent(bytes32 agentId) → Agent
- Retorna todos os dados do agente

### computeAgentId(string did, address ownerAddress) → bytes32
- Função pure que calcula o agentId determinístico

### isAgentActive(bytes32 agentId) → bool
- Verifica se o agente está ativo

### getAgentsByOwner(address ownerAddress) → bytes32[]
- Lista todos os agentes de um usuário

## Estrutura Agent

| Campo | Tipo | Descrição |
|---|---|---|
| agentId | bytes32 | ID único (hash de did + owner) |
| did | string | DID do usuário |
| ownerAddress | address | Carteira do usuário |
| publicId | string | ID público do agente |
| auid | string | Agent Unique ID (UUID) |
| isActive | bool | Status ativo/inativo |
| registeredAt | uint256 | Timestamp do registro |

## Eventos

- `AgentRegistered(agentId, did, ownerAddress, publicId, auid)`
- `AgentUpdated(agentId, publicId)`
- `AgentDeactivated(agentId, ownerAddress)`
- `AgentReactivated(agentId, ownerAddress)`

## Taxas CAS

| Operação | Taxa (CAS) |
|---|---|
| Registro de Agente | 100 CAS |
| Registro de Usuário | 30 CAS |

> As taxas podem ser ajustadas pelo admin via `updateFees()`. O pagamento é processado via `PaymentLib` e direcionado ao `InfrastructureFund`.

## Uso

```solidity
// Registrar um agente (requer aprovação prévia do CAS token)
CASToken.approve(address(AgentRegistry), 100 * 1e18);
AgentRegistry.registerAgent("did:web:alice", "alice-public-id", "uuid-alice");

// Consultar agente
Agent memory agent = AgentRegistry.getAgent(agentId);

// Verificar se ativo
bool active = AgentRegistry.isAgentActive(agentId);
```

## Segurança

- ReentrancyGuard
- Pausable
- UUPS upgradeável
- Validação de input (did, publicId, auid não vazios)
- Apenas owner pode atualizar/desativar
- `SafeERC20` para transferências de taxas CAS

## Changelog

| Data | Versão | Descrição |
|---|---|---|
| 2025-07-11 | 0.1.0 | Documentação inicial: funções, estrutura, eventos, segurança |
