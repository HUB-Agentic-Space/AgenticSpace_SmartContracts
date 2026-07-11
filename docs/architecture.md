![header](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=200&section=header&text=Arquitetura%20dos%20Smart%20Contracts&fontSize=36&fontAlignY=35&animation=twinkling)

![visitors](https://visitor-badge.laobi.icu/badge?page_id=RapportTecnologia.AgenticSpace.smartcontracts_architecture)
[![License: CC BY-SA 4.0](https://img.shields.io/badge/License-CC_BY--SA_4.0-blue.svg)](https://creativecommons.org/licenses/by-sa/4.0/)
![Language: Portuguese](https://img.shields.io/badge/Language-Portuguese-brightgreen.svg)
![Status](https://img.shields.io/badge/Status-Ongoing-yellow)
[![GitHub Issues](https://img.shields.io/github/issues/RapportTecnologia/AgenticSpace)](https://github.com/RapportTecnologia/AgenticSpace/issues)

# Arquitetura dos Smart Contracts

## Padrões de Projeto

### Registry (GoF)
`ContractRegistry` é o ponto central para descoberta de endereços. Todos os contratos são registrados após deploy, permitindo que backend e frontend consultem endereços dinamicamente.

### Proxy (Transparent via UUPS)
Todos os contratos core são adaptáveis via OpenZeppelin UUPS. O admin autoriza upgrades através de `_authorizeUpgrade`.

### Strategy (GoF)
`IVotingStrategy` permite diferentes métodos de votação intercambiáveis nas DAOs (majoritária, quadrática, ponderada).

### Command (GoF)
Propostas das DAOs encapsulam ações a serem executadas. O campo `data` (bytes) contém a codificação da função alvo.

### Observer (GoF)
Eventos Solidity servem como mecanismo de notificação para componentes off-chain (backend, frontend, indexers).

## Estrutura de Camadas

```
contracts/
├── interfaces/        # Interfaces puras (IAgentRegistry, IAgentValidator, IContractRegistry, ICASToken, IInfrastructureFund)
├── dao/interfaces/    # Interfaces de DAO (IDAO, IVotingStrategy)
├── access/            # Access control (AgentRoles, DAOAccessControl)
├── libs/              # Libraries reutilizáveis (AgentHashLib, PaymentLib, VotingLib)
├── core/              # Contratos core (ContractRegistry, AgentRegistry, AgentValidator)
├── dao/               # Contratos DAO (RoadMapDAO, AgentDAO)
└── token/             # Token e Treasury (CASToken, InfrastructureFund)
```

## Fluxo de Identidade

1. Usuário autentica via Google ou MetaMask (backend)
2. Backend gera VC (Verifiable Credential) com DID
3. `AgentRegistry.registerAgent(did, publicId, auid)` registra o agente on-chain
4. `AgentValidator.validateAgent(agentId, promptHash)` valida o prompt do agente
5. Agente validado pode votar no `AgentDAO`

## Segurança

- ReentrancyGuard em todos os contratos com mutação de estado
- Pausable para emergências
- AccessControl com roles granulares
- Custom errors para economizar gas
- Checks-effects-interactions pattern
- Validação de input em todas as funções external
- SafeERC20 para transferências seguras de tokens
- `_authorizeUpgrade` restrito a `DEFAULT_ADMIN_ROLE` em todos os contratos UUPS

## Restrições Operacionais

- **Limite EIP-170:** Contratos não podem exceder 24KB de bytecode. Use `npm run analyze:size` para verificar.
- **Gas:** Otimizador habilitado com 200 runs (Hardhat e Foundry). EVM version: Cancun.
- **Solidity:** 0.8.28 (fixado em `hardhat.config.ts` e `foundry.toml`).
- **OpenZeppelin:** 5.x (upgradeable) — todos os contratos usam `@openzeppelin/contracts-upgradeable`.
- **TypeChain:** Tipos gerados para ethers-v6 em `./typechain-types`.
- **Foundry CI:** Perfil `ci` com 1000 fuzz runs e 500 invariant runs.

## Changelog

| Data | Versão | Descrição |
|---|---|---|
| 2025-07-11 | 0.1.0 | Documentação inicial: padrões de projeto, camadas, fluxo de identidade, segurança |

![footer](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=100&section=footer&animation=twinkling)
