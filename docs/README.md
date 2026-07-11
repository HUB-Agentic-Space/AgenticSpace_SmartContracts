![header](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=200&section=header&text=Smart%20Contracts%20-%20Documenta%C3%A7%C3%A3o&fontSize=36&fontAlignY=35&animation=twinkling)

![visitors](https://visitor-badge.laobi.icu/badge?page_id=RapportTecnologia.AgenticSpace.smartcontracts_docs_README)
[![License: CC BY-SA 4.0](https://img.shields.io/badge/License-CC_BY--SA_4.0-blue.svg)](https://creativecommons.org/licenses/by-sa/4.0/)
![Language: Portuguese](https://img.shields.io/badge/Language-Portuguese-brightgreen.svg)
![Status](https://img.shields.io/badge/Status-Ongoing-yellow)
[![GitHub Issues](https://img.shields.io/github/issues/RapportTecnologia/AgenticSpace)](https://github.com/RapportTecnologia/AgenticSpace/issues)

# Smart Contracts - Agentic Space

## Visão Geral

Smart contracts do Agentic Space em Solidity, deployados na rede **Polygon PoS** com testes na testnet **Amoy**.

## Contratos

| Contrato | Descrição | Adaptável |
|---|---|---|
| `CASToken` | Token ERC-20 interno (CAS) — mintable, burnable, pausable | Sim (UUPS) |
| `InfrastructureFund` | Treasury — gerencia CAS e POL nativo | Sim (UUPS) |
| `ContractRegistry` | Registry central para descoberta dinâmica de endereços | Sim (UUPS) |
| `AgentRegistry` | Registro único de agentes (DID + address) com taxa CAS | Sim (UUPS) |
| `AgentValidator` | Validação de prompts/hashes na blockchain com taxa CAS | Sim (UUPS) |
| `RoadMapDAO` | DAO da Equipe de Projetos para RoadMap com taxa CAS | Sim (UUPS) |
| `AgentDAO` | DAO dos Agentes (votação autônoma/humana) com taxa CAS | Sim (UUPS) |

## Setup

```bash
cd smartcontracts
npm install
cp .env.example .env
# Editar .env com suas chaves
npx hardhat compile
```

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

## Interfaces e Bibliotecas

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

Backend e frontend consultam o `ContractRegistry` para descobrir endereços dinamicamente, eliminando hardcode. O CAS (Criptocoin Agentic Space) é usado para pagar taxas em todas as operações, com fundos direcionados ao InfrastructureFund para manutenção da infraestrutura.

## Segurança

- Contratos usam padrão UUPS com `_authorizeUpgrade` restrito a `DEFAULT_ADMIN_ROLE`
- `ReentrancyGuard` em operações críticas
- `Pausable` para emergências
- `SafeERC20` para transferências seguras
- Validação de input em todas as funções externas
- Sem secrets no código fonte — todas as chaves via `.env`
- `.env` está no `.gitignore` e nunca deve ser commitado

## Changelog

| Data | Versão | Descrição |
|---|---|---|
| 2025-07-11 | 0.1.0 | Documentação inicial: contratos, arquitetura, deploy, auditoria |

## Licença

CC-BY-SA-4.0

![footer](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=100&section=footer&animation=twinkling)
