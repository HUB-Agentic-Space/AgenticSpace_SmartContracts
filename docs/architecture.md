---
tags:
  - smartcontracts
  - architecture
---

![header](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=200&section=header&text=Arquitetura%20dos%20Smart%20Contracts&fontSize=36&fontAlignY=35&animation=twinkling)

![visitors](https://visitor-badge.laobi.icu/badge?page_id=RapportTecnologia.AgenticSpace.smartcontracts_architecture)
[![License: CC BY-SA 4.0](https://img.shields.io/badge/License-CC_BY--SA_4.0-blue.svg)](https://creativecommons.org/licenses/by-sa/4.0/)
![Language: Portuguese](https://img.shields.io/badge/Language-Portuguese-brightgreen.svg)
![Status](https://img.shields.io/badge/Status-Ongoing-yellow)
[![GitHub Issues](https://img.shields.io/github/issues/RapportTecnologia/AgenticSpace)](https://github.com/RapportTecnologia/AgenticSpace/issues)

# Arquitetura dos Smart Contracts

## Visão Geral

O Agentic Space usa uma arquitetura híbrida:

- **Diamond (EIP-2535):** Todos os contratos de domínio são *facets* anexadas a um único proxy Diamond. Um endereço, múltiplas funcionalidades.
- **UUPS Standalone:** `CASToken` e `InfrastructureFund` são contratos UUPS independentes, registrados no Diamond via `ContractRegistryFacet`.
- **Standalone:** `FundTrackerToken` e `Faucet` são contratos independentes sem proxy.

```
Diamond (EIP-2535 Proxy — um endereço)
  ├── DiamondCutFacet          (gestão de facets)
  ├── DiamondLoupeFacet        (inspeção)
  ├── OwnershipFacet           (transferência de ownership)
  ├── PausableFacet            (pause global)
  ├── AccessControlFacet       (gestão de roles)
  ├── UserRegistryFacet        (registro de usuários)
  ├── AgentRegistryFacet       (registro de agentes + Merkle roots)
  ├── AgentValidatorFacet      (validação de VC hashes)
  ├── RoadMapDAOFacet          (DAO de equipe)
  ├── AgentDAOFacet            (DAO de agentes)
  ├── ContractRegistryFacet    (descoberta de endereços)
  ├── PaymentFacet             (configuração de taxas CAS)
  └── GasPromotionFacet        (patrocínio de gas)

CASToken (UUPS standalone)           ← registrado no Diamond
InfrastructureFund (UUPS standalone)  ← registrado no Diamond
FundTrackerToken (standalone x2)     ← aCAS, aPOL
Faucet (Ownable standalone)          ← distribuição de POL
```

## Padrões de Projeto

### Diamond Proxy (EIP-2535)
O `Diamond` é um proxy que delega chamadas para facets via `delegatecall` no `fallback()`. O mapeamento seletor → facet é gerenciado por `LibDiamond`. Upgrades são feitos via `diamondCut` — apenas o contract owner pode adicionar, substituir ou remover facets.

### Diamond Storage (EIP-2535)
Cada domínio possui seu próprio namespace de storage, acessado via slots fixos (`keccak256("agentic.space.diamond.<domain>.storage")`). Isso evita colisões de storage entre facets. Ver [[storage-namespaces]].

### Registry (GoF)
`ContractRegistryFacet` é o ponto central para descoberta de endereços dentro do Diamond. `CASToken` e `InfrastructureFund` são registrados após deploy, permitindo que backend e frontend consultem endereços dinamicamente.

### Strategy (GoF)
- `VCStorage.WalletType` permite diferentes tipos de carteira (MetaMask, WalletConnect, Coinbase, Custom) para geração de hashes de VC.
- `GasPromotionStorage.OperationType` permite patrocinar diferentes operações com configurações independentes.

### Command (GoF)
Propostas das DAOs encapsulam ações a serem executadas. O campo `data` (bytes) contém a codificação da função alvo.

### Adapter (GoF)
`FundTrackerToken` adapta o `InfrastructureFund` para a interface ERC-20, permitindo que o saldo do fundo apareça no MetaMask como um token.

### Memento (GoF)
`AgentStorage.merkleRootHistory` mantém o histórico de Merkle roots por agente, permitindo verificação de prompts contra roots históricos.

### Observer (GoF)
Eventos Solidity servem como mecanismo de notificação para componentes off-chain (backend, frontend, indexers).

## Estrutura de Diretórios

```
contracts/
├── diamond/
│   ├── Diamond.sol              # Proxy EIP-2535
│   ├── DiamondInit.sol          # Inicialização (roles, interfaces)
│   ├── access/
│   │   └── DiamondAccessControl.sol  # RBAC via Diamond Storage
│   ├── facets/
│   │   ├── DiamondCutFacet.sol       # diamondCut (add/replace/remove)
│   │   ├── DiamondLoupeFacet.sol     # facets(), facetFunctionSelectors()
│   │   └── OwnershipFacet.sol        # transferOwnership()
│   ├── interfaces/
│   │   ├── IDiamondCut.sol
│   │   ├── IDiamondLoupe.sol
│   │   └── IERC165.sol
│   ├── libraries/
│   │   └── LibDiamond.sol            # Storage, ownership, pause, diamondCut
│   └── storage/
│       ├── AgentStorage.sol
│       ├── DAOStorage.sol
│       ├── GasPromotionStorage.sol
│       ├── PaymentStorage.sol
│       ├── ProjectStorage.sol
│       ├── UserStorage.sol
│       └── VCStorage.sol
├── facets/
│   ├── AccessControlFacet.sol
│   ├── AgentDAOFacet.sol
│   ├── AgentRegistryFacet.sol
│   ├── AgentValidatorFacet.sol
│   ├── ContractRegistryFacet.sol
│   ├── GasPromotionFacet.sol
│   ├── PausableFacet.sol
│   ├── PaymentFacet.sol
│   ├── RoadMapDAOFacet.sol
│   └── UserRegistryFacet.sol
├── faucet/
│   ├── Faucet.sol
│   └── IFaucet.sol
├── interfaces/
│   ├── ICASToken.sol
│   └── IInfrastructureFund.sol
├── libs/
│   ├── AgentHashLib.sol
│   ├── MerkleLib.sol
│   ├── PaymentLib.sol
│   └── VotingLib.sol
└── token/
    ├── CASToken.sol
    ├── FundTrackerToken.sol
    └── InfrastructureFund.sol
```

## Fluxo de Identidade

1. Usuário autentica via Google ou MetaMask (backend)
2. Backend gera DID e hash do DID (`keccak256(did)`)
3. `UserRegistryFacet.registerUser(didHash, publicIdHash)` registra o usuário on-chain
4. `AgentRegistryFacet.registerAgent(didHash, publicId, auid, name, description, parentPublicId, merkleRoot, promptCount)` registra o agente com Merkle root dos prompts
5. `AgentValidatorFacet.validateAgent(agentId, promptHash, walletType)` valida o VC hash do agente
6. Agente com `AGENT_ROLE` pode votar no `AgentDAOFacet`

> [!note] Pré-requisito
> O usuário deve estar registrado e ativo no `UserRegistryFacet` antes de registrar agentes. O `AgentRegistryFacet` verifica isso automaticamente.

## Fluxo de Pagamentos

1. `PaymentFacet.setCasToken(address)` vincula o CASToken ao Diamond
2. `PaymentFacet.setInfrastructureFund(address)` vincula o InfrastructureFund
3. `PaymentFacet.initPayment()` configura as taxas padrão
4. Operações pagas chamam `PaymentLib.processFeePayment(payer, feeType)` internamente
5. `PaymentLib` transfere CAS do pagador para o `InfrastructureFund` via `transferFrom`

| Operação | Fee Type | Taxa Padrão (CAS) |
|---|---|---|
| Registro de Agente | `FEE_TYPE_REGISTRATION` (0) | 100 CAS |
| Validação de Agente | `FEE_TYPE_VALIDATION` (1) | 10 CAS |
| Proposta de DAO | `FEE_TYPE_DAO_PROPOSAL` (2) | 50 CAS |

> As taxas podem ser ajustadas pelo owner via `PaymentFacet.updateFees()`.

## Segurança

- **Diamond:** Upgrades via `diamondCut` restritos ao contract owner
- **Pausable:** `PausableFacet` pausa todas as facets de domínio via `LibDiamond.enforceNotPaused()`
- **AccessControl:** Roles granulares via `DiamondAccessControl` — ver [[access-control]]
- **Custom errors:** Em todos os contratos para economizar gas
- **Checks-Effects-Interactions:** No `Faucet.requestTokens()`
- **Validação de input:** Em todas as funções external
- **SafeERC20:** No `InfrastructureFund` para transferências de CAS
- **UUPS:** `_authorizeUpgrade` restrito a `DEFAULT_ADMIN_ROLE` em `CASToken` e `InfrastructureFund`
- **Sem secrets no código fonte** — todas as chaves via `.env`

## Restrições Operacionais

- **Limite EIP-170:** Cada facet não pode exceder 24KB de bytecode. Use `npm run analyze:size` para verificar. O padrão Diamond mitiga esse limite ao dividir lógica em facets.
- **Gas:** Otimizador habilitado com 200 runs (Hardhat e Foundry). EVM version: Cancun. `viaIR: true`.
- **Solidity:** 0.8.28 (fixado em `hardhat.config.ts` e `foundry.toml`).
- **OpenZeppelin:** 5.x — `@openzeppelin/contracts-upgradeable` para tokens UUPS, `@openzeppelin/contracts` para interfaces.
- **TypeChain:** Tipos gerados para ethers-v6 em `./typechain-types`.
- **Foundry CI:** Perfil `ci` com 1000 fuzz runs e 500 invariant runs.

## Changelog

| Data | Versão | Descrição |
|---|---|---|
| 2025-07-12 | 0.2.0 | Reescrita completa: Diamond EIP-2535, Diamond Storage, facets, novos fluxos |
| 2025-07-11 | 0.1.0 | Documentação inicial: padrões de projeto, camadas, fluxo de identidade, segurança |

![footer](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=100&section=footer&animation=twinkling)
