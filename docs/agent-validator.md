# AgentValidator

## Propósito

Valida agentes registrando hashes de prompts na blockchain como únicos. Apenas o hash é armazenado on-chain (não o prompt completo) para economizar gas e preservar privacidade.

## Funções

### validateAgent(bytes32 agentId, bytes32 promptHash) → bytes32
- **Auth:** `VALIDATOR_ROLE`
- Verifica se o agente está ativo no `AgentRegistry`
- Verifica se o `promptHash` ainda não foi validado para aquele agente
- Calcula `validationId = keccak256(agentId, promptHash, block.timestamp)`
- Emite `AgentValidated`

### revokeValidation(bytes32 validationId)
- **Auth:** `VALIDATOR_ROLE` ou admin
- Marca a validação como inválida
- Emite `ValidationRevoked`

### isValidated(bytes32 agentId, bytes32 promptHash) → bool
- Verifica se um agente foi validado para um prompt específico

### getValidation(bytes32 validationId) → ValidationRecord
- Retorna o registro completo de validação

### getValidationsByAgent(bytes32 agentId) → bytes32[]
- Lista todas as validações de um agente

### isAuthorizedValidator(address validator) → bool
- Verifica se um endereço é validador autorizado

## Estrutura ValidationRecord

| Campo | Tipo | Descrição |
|---|---|---|
| validationId | bytes32 | ID único da validação |
| agentId | bytes32 | ID do agente validado |
| promptHash | bytes32 | Hash do prompt |
| validatorAddress | address | Quem validou |
| timestamp | uint256 | Momento da validação |
| isValid | bool | Status da validação |

## Eventos

- `AgentValidated(agentId, promptHash, validationId, validatorAddress)`
- `ValidationRevoked(validationId, revoker)`

## Dependências

- `IAgentRegistry`: verifica se o agente está ativo
- `AgentHashLib`: cálculo de hashes

## Taxas CAS

| Operação | Taxa (CAS) |
|---|---|
| Validação de Agente | 50 CAS |

> As taxas podem ser ajustadas pelo admin via `updateFees()`. O pagamento é processado via `PaymentLib` e direcionado ao `InfrastructureFund`.

## Segurança

- Apenas `VALIDATOR_ROLE` pode validar
- Não permite validação duplicada (mesmo agente + mesmo prompt)
- ReentrancyGuard
- Pausable
- UUPS upgradeável
- `SafeERC20` para transferências de taxas CAS

## Changelog

| Data | Versão | Descrição |
|---|---|---|
| 2025-07-11 | 0.1.0 | Documentação inicial: funções, estrutura, eventos, segurança |
