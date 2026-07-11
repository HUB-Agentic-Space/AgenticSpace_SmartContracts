![header](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=200&section=header&text=Agentic%20Space%20-%20Smart%20Contracts&fontSize=40&fontAlignY=35&animation=twinkling)

# Agentic Space — Smart Contracts

![visitors](https://visitor-badge.laobi.icu/badge?page_id=RapportTecnologia.AgenticSpace.smartcontracts_README)
[![License: CC BY-SA 4.0](https://img.shields.io/badge/License-CC_BY--SA_4.0-blue.svg)](https://creativecommons.org/licenses/by-sa/4.0/)
![Language: Portuguese](https://img.shields.io/badge/Language-Portuguese-brightgreen.svg)
![Status](https://img.shields.io/badge/Status-Ongoing-yellow)
[![Solidity](https://img.shields.io/badge/Solidity-0.8.28-363636?logo=solidity&logoColor=white)](https://soliditylang.org/)
[![Hardhat](https://img.shields.io/badge/Hardhat-2.22-FFF60C?logo=hardhat&logoColor=black)](https://hardhat.org/)
[![Foundry](https://img.shields.io/badge/Foundry-1.0-FF8C00?logo=foundry&logoColor=black)](https://getfoundry.sh/)
[![OpenZeppelin](https://img.shields.io/badge/OpenZeppelin-5.x-4E5FBA?logo=openzeppelin&logoColor=white)](https://openzeppelin.com/)
[![Polygon](https://img.shields.io/badge/Polygon-PoS-8247E5?logo=polygon&logoColor=white)](https://polygon.technology/)
[![GitHub stars](https://img.shields.io/github/stars/RapportTecnologia/AgenticSpace?style=social)](https://github.com/RapportTecnologia/AgenticSpace)
[![GitHub Issues](https://img.shields.io/github/issues/RapportTecnologia/AgenticSpace)](https://github.com/RapportTecnologia/AgenticSpace/issues)

## Visão Geral

Smart contracts do **Agentic Space** em Solidity, deployados na rede **Polygon PoS** com testes na testnet **Amoy**.

Os contratos são adaptáveis (UUPS), com controle de acesso baseado em roles (AccessControl), e utilizam o token interno **CAS (Criptocoin Agentic Space)** para pagamentos de taxas operacionais.

- **Repositório**: [github.com/RapportTecnologia/AgenticSpace](https://github.com/RapportTecnologia/AgenticSpace)
- **Licença**: CC-BY-SA-4.0
- **Solidity**: 0.8.28
- **OpenZeppelin**: 5.x (upgradeable)
- **Tooling**: Hardhat + Foundry + TypeChain + Slither + Solhint

## Contratos

| Contrato | Descrição | Adaptável |
|---|---|---|
| `CASToken` | Token ERC-20 interno (CAS) — mintable, burnable, pausable | Sim (UUPS) |
| `InfrastructureFund` | Treasury — gerencia CAS e POL nativo | Sim (UUPS) |
| `ContractRegistry` | Registry central para descoberta dinâmica de endereços | Sim (UUPS) |
| `AgentRegistry` | Registro único de agentes (DID + address) com taxa CAS | Sim (UUPS) |
| `AgentValidator` | Validação de prompts/hashes com taxa CAS | Sim (UUPS) |
| `RoadMapDAO` | DAO da Equipe de Projetos para RoadMap com taxa CAS | Sim (UUPS) |
| `AgentDAO` | DAO dos Agentes (votação autônoma/humana) com taxa CAS | Sim (UUPS) |

## Bibliotecas e Interfaces

| Arquivo | Descrição |
|---|---|
| `PaymentLib` | Cálculo e processamento de pagamentos em CAS |
| `VotingLib` | Lógica de votação (quorum, aprovação) |
| `AgentHashLib` | Hashes de agentes e validações |
| `ICASToken` | Interface do CAS Token |
| `IInfrastructureFund` | Interface do InfrastructureFund |
| `IAgentRegistry` | Interface do AgentRegistry |
| `IAgentValidator` | Interface do AgentValidator |
| `IContractRegistry` | Interface do ContractRegistry |
| `IDAO` | Interface base das DAOs (RoadMapDAO, AgentDAO) |
| `IVotingStrategy` | Interface para estratégias de votação intercambiáveis |

## Estrutura de Diretórios

```
smartcontracts/
├── contracts/
│   ├── access/          # AgentRoles, DAOAccessControl
│   ├── core/            # AgentRegistry, AgentValidator, ContractRegistry
│   ├── dao/             # RoadMapDAO, AgentDAO, interfaces
│   ├── interfaces/      # ICASToken, IInfrastructureFund, IAgentRegistry, ...
│   ├── libs/            # PaymentLib, VotingLib, AgentHashLib
│   └── token/           # CASToken, InfrastructureFund
├── scripts/
│   ├── deploy/          # Scripts de deploy (01-05, 06-07 pendentes)
│   ├── audit/           # Scripts de auditoria (slither, mythril, echidna)
│   ├── analysis/        # Análise de gas, tamanho, cobertura
│   └── utils/           # Utilitários (upgrade, etc)
├── test/
│   ├── core/            # Testes do AgentRegistry, AgentValidator, ContractRegistry
│   ├── dao/             # Testes do RoadMapDAO, AgentDAO
│   └── integration/     # Testes de integração
├── docs/                # Documentação dos contratos
├── deploy/              # Endereços deployados por rede
├── hardhat.config.ts
├── foundry.toml
├── slither.config.json
├── .solhint.json
└── package.json
```

## Arquitetura

```
ContractRegistry (central registry)
  ├── CASToken (ERC-20 internal token)
  ├── InfrastructureFund (treasury: CAS + POL)
  ├── AgentRegistry (agent registration, CAS fee)
  ├── AgentValidator (prompt validation, CAS fee)
  ├── RoadMapDAO (team governance, CAS fees)
  └── AgentDAO (agent governance, CAS fees)
```

### Fluxo de Pagamentos CAS

```
Usuário/Agente
    │
    ├─ approve(CAS, contrato, amount)
    │
    ▼
Contrato (AgentRegistry / AgentValidator / DAO)
    │
    ├─ PaymentLib.processFeePayment(CAS, from, treasury, feeType, fees)
    │
    ▼
InfrastructureFund (treasury)
    │
    ├─ transferCasToRapport() / transferCasToAuthor()
    │
    ▼
Rapport / Autor (manutenção da infraestrutura)
```

### Roles de Acesso

| Role | Descrição |
|---|---|
| `DEFAULT_ADMIN_ROLE` | Admin geral — gerencia roles, upgrades, configurações |
| `MINTER_ROLE` | Pode cunhar novos tokens CAS |
| `PAUSER_ROLE` | Pode pausar/despausar contratos |
| `AGENT_ROLE` | Agentes registrados |
| `VALIDATOR_ROLE` | Validadores autorizados |
| `DAO_PROPOSER_ROLE` | Pode criar propostas na DAO |
| `DAO_VOTER_ROLE` | Pode votar em propostas |
| `DAO_EXECUTOR_ROLE` | Pode executar propostas aprovadas |
| `TREASURER_ROLE` | Pode transferir fundos do InfrastructureFund |

## Setup

```bash
cd smartcontracts
npm install
cp .env.example .env
# Editar .env com suas chaves
npx hardhat compile
```

### Variáveis de Ambiente

| Variável | Descrição |
|---|---|
| `POLYGON_AMOY_RPC_URL` | RPC da testnet Amoy |
| `POLYGON_AMOY_PRIVATE_KEY` | Chave privada para deploy na testnet |
| `POLYGON_RPC_URL` | RPC da mainnet Polygon |
| `POLYGON_PRIVATE_KEY` | Chave privada para deploy na mainnet |
| `POLYGONSCAN_API_KEY` | Chave para verificação no Polygonscan |
| `DEPLOYER_ADDRESS` | Endereço do deployer |
| `CONTRACT_REGISTRY_ADDRESS` | Endereço do ContractRegistry (preenchido após deploy) |

## Testes

```bash
npm test                          # Testes Hardhat
npm run test:foundry              # Fuzzing com Foundry
npm run test:coverage             # Cobertura
```

## Deploy

```bash
# Testnet (Amoy)
npm run deploy:amoy

# Mainnet (Polygon)
npm run deploy:polygon
```

> **Nota**: Scripts de deploy 06 (CASToken) e 07 (InfrastructureFund) estão pendentes. Atualmente apenas 5 contratos são deployados automaticamente (01-05). CASToken e InfrastructureFund precisam ser deployados manualmente.

### Verificação no Polygonscan

```bash
# Listar contratos verificados na testnet
npm run verify

# Verificar contrato específico
npx hardhat verify --network polygonAmoy <CONTRACT_ADDRESS> [constructor-args]

# Utilitário de verificação
npx hardhat run scripts/utils/verify_contracts.ts --network polygonAmoy
```

## Auditoria

```bash
npm run audit:solhint             # Linting
npm run audit:slither             # Análise estática
npm run audit:mythril             # Análise simbólica
npm run audit:echidna             # Fuzzing
npm run audit:full                # Todas as auditorias
```

## Análise

```bash
npm run analyze:gas               # Relatório de gas
npm run analyze:size              # Tamanho dos contratos
npm run analyze:coverage          # Cobertura de testes
```

## Taxas CAS Padrão

| Operação | Taxa (CAS) |
|---|---|
| Registro de Agente | 100 CAS |
| Validação de Agente | 50 CAS |
| Criar Proposta (DAO) | 200 CAS |
| Votar em Proposta | 10 CAS |
| Registro de Usuário | 30 CAS |

> As taxas podem ser ajustadas pelo admin via `updateFees()`.

## Segurança

- Contratos usam padrão UUPS com `_authorizeUpgrade` restrito a `DEFAULT_ADMIN_ROLE`
- `ReentrancyGuard` em operações críticas
- `Pausable` para emergências
- `SafeERC20` para transferências seguras
- Validação de input em todas as funções externas
- Sem secrets no código fonte — todas as chaves via `.env`

## Documentação

Documentação detalhada em [`docs/`](./docs/):

- [`architecture.md`](docs/architecture.md) — Visão arquitetural
- [`deployment.md`](docs/deployment.md) — Guia de deploy
- [`agent-registry.md`](docs/agent-registry.md) — AgentRegistry
- [`agent-validator.md`](docs/agent-validator.md) — AgentValidator
- [`roadmap-dao.md`](docs/roadmap-dao.md) — RoadMapDAO
- [`agent-dao.md`](docs/agent-dao.md) — AgentDAO
- [`contract-registry.md`](docs/contract-registry.md) — ContractRegistry
- [`audit-guide.md`](docs/audit-guide.md) — Guia de auditoria

## Changelog

| Data | Versão | Descrição |
|---|---|---|
| 2025-07-11 | 0.1.0 | Documentação inicial: contratos, arquitetura, deploy, auditoria |

## Licença

CC-BY-SA-4.0

![footer](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=100&section=footer&animation=twinkling)
