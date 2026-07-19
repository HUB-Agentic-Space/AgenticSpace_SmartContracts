![header](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=200&section=header&text=Agentic%20Space%20-%20Smart%20Contracts&fontSize=40&fontAlignY=35&animation=twinkling)

# Agentic Space — Smart Contracts

![visitors](https://visitor-badge.laobi.icu/badge?page_id=HUB-Agentic-Space/AgenticSpace_SmartContracts)
[![License: CC BY-SA 4.0](https://img.shields.io/badge/License-CC_BY--SA_4.0-blue.svg)](https://creativecommons.org/licenses/by-sa/4.0/)
![Language: Portuguese](https://img.shields.io/badge/Language-Portuguese-brightgreen.svg)
![Status](https://img.shields.io/badge/Status-Ongoing-yellow)
[![Solidity](https://img.shields.io/badge/Solidity-0.8.28-363636?logo=solidity&logoColor=white)](https://soliditylang.org/)
[![Hardhat](https://img.shields.io/badge/Hardhat-2.22-FFF60C?logo=hardhat&logoColor=black)](https://hardhat.org/)
[![Foundry](https://img.shields.io/badge/Foundry-1.0-FF8C00?logo=foundry&logoColor=black)](https://getfoundry.sh/)
[![OpenZeppelin](https://img.shields.io/badge/OpenZeppelin-5.x-4E5FBA?logo=openzeppelin&logoColor=white)](https://openzeppelin.com/)
[![Polygon](https://img.shields.io/badge/Polygon-PoS-8247E5?logo=polygon&logoColor=white)](https://polygon.technology/)
[![GitHub stars](https://img.shields.io/github/stars/HUB-Agentic-Space/AgenticSpace_SmartContracts?style=social)](https://github.com/HUB-Agentic-Space/AgenticSpace_SmartContracts)
[![GitHub Issues](https://img.shields.io/github/issues/HUB-Agentic-Space/AgenticSpace_SmartContracts)](https://github.com/HUB-Agentic-Space/AgenticSpace_SmartContracts/issues)

## Visão Geral

Smart contracts do **Agentic Space** em Solidity, deployados na rede **Polygon PoS** (mainnet, chainId 137).

O sistema utiliza o padrão **Diamond Proxy (EIP-2535)** para permitir a troca e adição de facets sem alterar o endereço do contrato principal. Cada facet é responsável por um domínio (agentes, validação, DAOs, registry) e usa **Diamond Storage** para persistir estado em namespaces isolados, garantindo baixo acoplamento e alta escalabilidade.

O projeto está focado na **Web 4.0** — onde agentes de IA interagem autonomamente — e está pesquisando ativamente dois protocolos chave:

- **EIP-8004 (Trustless Agents)**: implementação planejada de uma Trust Layer on-chain com três registries (Identity, Reputation, Validation) para descoberta e confiança entre agentes sem relações prévias. Mais informações em https://eips.ethereum.org/EIPS/eip-8004
- **A2A (Agent-to-Agent)**: pesquisa do protocolo A2A para comunicação e interoperabilidade entre agentes across organizational boundaries.

Para detalhes econômicos do token, consulte o [Tokenomics](../frontend/public/tokens/tokenomics.md) e o [Whitepaper](../frontend/public/tokens/cas-whitepaper.md).

- **Repositório**: [github.com/Hub-Agentic-Space](https://github.com/Hub-Agentic-Space)
- **Licença**: CC-BY-SA-4.0
- **Solidity**: 0.8.28
- **OpenZeppelin**: 5.x (upgradeable)
- **Tooling**: Hardhat + Foundry + TypeChain + Slither + Solhint
- **Padrão Proxy**: EIP-2535 Diamond (multi-facet proxy)

## Contratos

### Diamond (EIP-2535)

| Contrato | Descrição |
|---|---|
| `Diamond` | Proxy principal — delega chamadas para facets via `delegatecall` |
| `DiamondInit` | Inicialização executada via `delegatecall` durante `diamondCut` |
| `DiamondCutFacet` | Adiciona, substitui e remove facets (apenas owner) |
| `DiamondLoupeFacet` | Introspecção de facets (EIP-2535 loupe + EIP-165) |
| `OwnershipFacet` | Gestão de ownership do Diamond |

### Domain Facets

| Facet | Descrição | Storage |
|---|---|---|
| `UserRegistryFacet` | Registro de usuários (didHash, publicIdHash, walletAddress). Apenas hashes on-chain para preservar anonimidade | `UserStorage` |
| `AgentRegistryFacet` | Registro de agentes (didHash, ownerUserId, AUID, address, publicId, name, description, parentPublicId, Merkle root). Usuário deve estar registrado e ativo | `AgentStorage` |
| `AgentValidatorFacet` | Validação de VC hashes de prompts (wallet plugável) | `VCStorage` |
| `RoadMapDAOFacet` | DAO da Equipe de Projetos (propostas, votação, timelock) | `DAOStorage` |
| `AgentDAOFacet` | DAO dos Agentes (votação autônoma, delegação) | `DAOStorage` |
| `ContractRegistryFacet` | Descoberta dinâmica de endereços de contratos | Próprio namespace |
| `AccessControlFacet` | Gestão de roles em runtime (grant/revoke/list) | `DiamondAccessControl` |
| `PaymentFacet` | Gestão de taxas em CAS tokens (setCasToken, setInfrastructureFund, updateFees) | `PaymentStorage` |
| `GasPromotionFacet` | Promoções de gas sponsorship: ativar/desativar cobertura de gas por operação, budget, limite por usuário, relayer | `GasPromotionStorage` |
| `PausableFacet` | Pausa/despausa o Diamond inteiro | `LibDiamond` |

### Faucet (Contratos Avulsos)

| Contrato | Descrição |
|---|---|
| `Faucet` | Faucet avulso para distribuição de POL nativo na Polygon. Cooldown configurável, blacklist, saque de emergência. Não faz parte do Diamond |
| `PoWFaucet` | Faucet baseado em Proof of Work (keccak256). Mineradores resolvem desafios computacionais para receber POL. Difficulty ajustável substitui cooldown. Minerador GPU em `facelt_miner/` |

### Diamond Storage Namespaces

| Storage | Descrição |
|---|---|
| `AgentStorage` | Persiste didHash, ownerUserId, AUID, address, publicId, name, description, parentPublicId e Merkle root dos agentes |
| `ProjectStorage` | Persiste DID, AUID, address e publicId dos projetos |
| `UserStorage` | Persiste didHash (keccak256 do DID), walletAddress e publicIdHash dos usuários. DID em texto fica apenas off-chain |
| `PaymentStorage` | Persiste endereço do CAS Token, InfrastructureFund e configuração de taxas |
| `GasPromotionStorage` | Persiste estado de promoções de gas (global, por operação, budget, gasto por usuário, relayer) |
| `VCStorage` | Persiste hashes de VCs (Verifiable Credentials) com wallet plugável |
| `DAOStorage` | Persiste propostas, votos, delegações (namespaces por DAO) |

## Bibliotecas e Interfaces

| Arquivo | Descrição |
|---|---|
| `PaymentLib` | Processamento de taxas em CAS tokens (transferFrom para InfrastructureFund) |
| `VotingLib` | Lógica de votação (quorum, aprovação) |
| `AgentHashLib` | Hashes de agentes e usuários (computeAgentId, computeUserId, computePromptHash) |
| `MerkleLib` | Verificação de Merkle proofs para prompts |
| `ICASToken` | Interface do CAS Token |
| `IInfrastructureFund` | Interface do InfrastructureFund |

## Estrutura de Diretórios

```
smartcontracts/
├── contracts/
│   ├── diamond/         # EIP-2535 Diamond infrastructure
│   │   ├── facets/      # DiamondCutFacet, DiamondLoupeFacet, OwnershipFacet
│   │   ├── interfaces/  # IDiamondCut, IDiamondLoupe, IERC165
│   │   ├── libraries/   # LibDiamond
│   │   ├── storage/     # AgentStorage, ProjectStorage, UserStorage, VCStorage, DAOStorage, PaymentStorage, GasPromotionStorage
│   │   ├── access/      # DiamondAccessControl
│   │   ├── Diamond.sol  # Proxy principal
│   │   └── DiamondInit.sol
│   ├── facets/          # Domain facets (UserRegistry, AgentRegistry, AgentValidator, DAOs, etc.)
│   ├── interfaces/      # ICASToken, IInfrastructureFund
│   ├── libs/            # VotingLib, AgentHashLib, MerkleLib
│   ├── token/           # CASToken, InfrastructureFund, FundTrackerToken
│   └── faucet/          # Faucet avulso (POL nativo) + PoWFaucet (keccak256 PoW)
├── scripts/
│   ├── deploy/          # 00_deploy_diamond.ts, 01_deploy_fund_tracker.ts
│   ├── audit/           # Scripts de auditoria (slither, mythril, echidna)
│   ├── analysis/        # Análise de gas, tamanho, cobertura
│   └── utils/           # Utilitários (verify, etc)
├── test/
│   ├── diamond/         # Testes do Diamond (EIP-2535)
│   ├── token/           # Testes do FundTrackerToken
│   └── faucet/          # Testes do Faucet
├── docs/                # Documentação dos contratos
├── deploy/              # Endereços deployados por rede
├── hardhat.config.ts
├── foundry.toml
├── slither.config.json
├── .solhint.json
└── package.json
```

## Arquitetura

### Diamond Proxy (EIP-2535)

```
Diamond (single proxy address)
  ├── DiamondCutFacet       → add/replace/remove facets
  ├── DiamondLoupeFacet     → facet introspection (EIP-2535 loupe)
  ├── OwnershipFacet        → ownership management
  ├── PausableFacet         → emergency pause
  ├── AgentRegistryFacet    → agent registration + Merkle root (AgentStorage)
  ├── AgentValidatorFacet   → VC hash validation (VCStorage)
  ├── RoadMapDAOFacet       → team governance (DAOStorage: RoadMap namespace)
  ├── AgentDAOFacet         → agent governance (DAOStorage: Agent namespace)
  ├── ContractRegistryFacet → contract discovery
  └── AccessControlFacet    → runtime role management (DiamondAccessControl)
```

### Merkle Tree de Prompts

Cada agente possui uma **árvore de Merkle** que agrega os hashes de
todos os seus prompts. Apenas a **raiz da árvore** é persistida on-chain,
reduzindo gas e mantendo os hashes individuais no backend.

### Binding Usuário → Agente (Não Transferível)

O registro de usuário é **obrigatório** antes de registrar agentes.
Apenas `didHash` (keccak256 do DID) é armazenado on-chain — o DID em
texto fica apenas no backend para preservar anonimidade.

```
User (on-chain)
  ├── didHash         → bytes32 (keccak256 do DID)
  ├── walletAddress   → address (MetaMask)
  ├── publicIdHash    → bytes32 (keccak256 do publicId)
  └── isActive        → bool

Agent (on-chain, imutável e não transferível)
  ├── didHash         → bytes32 (hash do DID do criador)
  ├── ownerUserId     → bytes32 (referência imutável ao usuário)
  └── ownerAddress    → address (wallet do criador)
```

**Agentes são não transferíveis** — permanentemente vinculados ao
usuário que os criou. Não há mecanismo de transferência de
responsabilidade. Se o usuário deseja "passar" um agente, deve
desativar o agente e criar um novo sob o novo responsável.

### Gas Sponsorship (Promoções de Gas)

O **registro de usuário é gratuito** (sem taxa em CAS tokens, apenas gas).
Durante períodos promocionais, o Agentic Space pode **cobrir os custos de gas**
para operações específicas (ex: registro de usuário, registro de agente).

O `GasPromotionFacet` gerencia o estado da promoção on-chain:

- **Toggle global**: liga/desliga todas as promoções (`setGlobalPromotion`)
- **Por operação**: ativa/desativa promoção para cada tipo de operação
  (`activatePromotion`, `deactivatePromotion`)
- **Budget e limite por usuário**: previne abuso com teto total e teto por usuário
- **Relayer**: apenas o relayer designado pode registrar gastos de gas
  (`setRelayer`, `recordGasSpending`)
- **Recarga de budget**: adiciona mais budget sem recriar a promoção
  (`refillBudget`)
- **Views**: `isPromoted`, `getPromotion`, `getUserSpending` para o backend
  verificar elegibilidade antes de patrocinar a transação

**Operações patrocináveis** (`OperationType`):
- `USER_REGISTRATION` (0) — registro de usuário
- `AGENT_REGISTRATION` (1) — registro de agente
- `USER_DEACTIVATION` (2) — desativação de usuário
- `AGENT_DEACTIVATION` (3) — desativação de agente
- `MERKLE_ROOT_UPDATE` (4) — atualização de Merkle root

**Fluxo de uso**:
1. Owner ativa a promoção global (`setGlobalPromotion(true)`)
2. Owner designa o relayer (`setRelayer`)
3. Owner ativa a promoção para uma operação com budget e duração
   (`activatePromotion`)
4. Backend consulta `isPromoted` para verificar elegibilidade do usuário
5. Relayer submete a transação e registra o gasto (`recordGasSpending`)
6. Owner pode desativar a promoção a qualquer momento (`deactivatePromotion`)

```
Agent (on-chain)
  ├── merkleRoot     → bytes32 (raiz da árvore)
  ├── promptCount    → uint256 (número de prompts)
  └── merkleRootHistory → bytes32[] (histórico de raízes para auditoria)

Prompt leaf = keccak256(promptName, promptType, contentHash)
  ├── promptName: "AGENTS.md", "IDENTITY.md", "SOUL.md", ...
  ├── promptType: 0 = imutável, 1 = secundário
  └── contentHash: hash do conteúdo gerado pela wallet
```

**Prompts imutáveis** (AGENTS.md, IDENTITY.md, SOUL.md) são incluídos
na raiz inicial no registro do agente. **Prompts secundários** podem
ser adicionados via `updateMerkleRoot`, mas uma vez registrados, os
hashes não podem mudar — alterá-los invalida a identidade do agente.

A função `verifyPrompt` permite verificar on-chain que um prompt
pertence à raiz atual usando um Merkle proof. `verifyPromptHistorical`
permite auditar prompts contra raízes anteriores.

**Segurança:**
- A chave privada do agente é responsabilidade do próprio agente
- O Agentic Space não armazena chaves privadas
- A geração de hashes é feita via wallet (MetaMask inicialmente,
  outras wallets no futuro)
- O hash do prompt inclui metadados de identificação, **nunca** API keys

### Diamond Storage (namespaces isolados)

Cada facet persiste estado em um storage slot único, garantindo que
facets não colidam e possam ser trocados independentemente:

```
AgentStorage   → keccak256("agentic.space.diamond.agent.storage")
ProjectStorage → keccak256("agentic.space.diamond.project.storage")
UserStorage    → keccak256("agentic.space.diamond.user.storage")
VCStorage      → keccak256("agentic.space.diamond.vc.storage")
DAOStorage     → keccak256("agentic.space.diamond.dao.storage")
DiamondAccess  → keccak256("agentic.space.diamond.access.storage")
LibDiamond     → keccak256("agentic.space.diamond.storage")
```

### Persistência On-Chain

| Entidade | Dados persistidos | Storage |
|---|---|---|
| **Agentes** | DID, AUID, ownerAddress, publicId, isActive | `AgentStorage` |
| **Projetos** | DID, AUID, ownerAddress, publicId, isActive | `ProjectStorage` |
| **Usuários** | DID, walletAddress, publicId, isActive | `UserStorage` |
| **VCs** | promptHash, signer, walletType, isValid | `VCStorage` |
| **Propostas** | proposalId, proposer, state, votes, timelock | `DAOStorage` |

### Wallet Plugável para VC Hashes

Os hashes de prompts são gerados inicialmente pelo **MetaMask** e
futuramente por qualquer wallet integrável. O `AgentValidatorFacet`
registra o tipo de wallet (`WalletType` enum) e o endereço do signer
para cada VC, permitindo adicionar novas wallets via
`setWalletTypeSupported()` sem alterar o contrato.

### Fluxo de Diamond Cut (upgrade de facets)

```
Owner
  │
  ├─ diamondCut(FacetCut[], initAddress, initCalldata)
  │
  ▼
DiamondCutFacet
  │
  ├─ LibDiamond.diamondCut()
  │    ├─ Add:      addFunctions(facetAddress, selectors)
  │    ├─ Replace:  replaceFunctions(facetAddress, selectors)
  │    └─ Remove:   removeFunctions(facetAddress, selectors)
  │
  └─ initializeDiamondCut(init, calldata)  ← delegatecall para init
```

### Arquitetura Legada (UUPS — compatibilidade)

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

## FundTrackerToken (Wrapper ERC-20)

O `InfrastructureFund` é um contrato de tesouraria que **não é ERC-20** —
ele apenas custodia CAS e POL. Para visualizar os saldos do fundo no
MetaMask, deployamos **duas instâncias** do `FundTrackerToken`:

| Instância | Símbolo | assetType | Espelha |
|---|---|---|---|
| CAS Tracker | `aCAS` | 0 | `fund.casBalance()` |
| POL Tracker | `aPOL` | 1 | `fund.nativeBalance()` |

**Como funciona:**
- `totalSupply()` retorna dinamicamente o saldo do ativo no InfrastructureFund
- `balanceOf(admin)` retorna o mesmo valor (o admin vê o saldo no MetaMask)
- `balanceOf(outros)` retorna 0 (não é distributivo)
- Transferências são **bloqueadas** — o token é apenas um espelho de leitura

**Deploy:**
```bash
# Requer INFRASTRUCTURE_FUND_ADDRESS no .env
npx hardhat run scripts/deploy/01_deploy_fund_tracker.ts --network polygonAmoy
```

**Adicionar no MetaMask:**
1. Importar token com o endereço do CAS Tracker → verá saldo em aCAS
2. Importar token com o endereço do POL Tracker → verá saldo em aPOL
3. Os saldos atualizam automaticamente quando o fundo recebe ou envia recursos

**Transferir "propriedade" do tracker:**
- `transferOwnership(novoAdmin)` — o novo admin passa a ver o saldo no MetaMask
- Não afeta o InfrastructureFund, apenas muda quem visualiza o espelho

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
# Testnet (Amoy) — deploy do Diamond com todas as facets
npm run deploy:amoy

# Mainnet (Polygon)
npm run deploy:polygon
```

> O deploy do Diamond (`00_deploy_diamond.ts`) cria o proxy Diamond, anexa todas as facets em uma única transação `diamondCut`, e inicializa os namespaces de storage. O endereço do Diamond permanece o mesmo mesmo após trocas de facets.

> Os scripts `01-05` permanecem para deploy dos contratos legados UUPS, se necessário.

### Contratos Deployados — Polygon Mainnet (chainId: 137)

Deployado em 14/07/2026. Todos os contratos verificados no Polygonscan.

| Contrato | Endereço | Polygonscan |
|---|---|---|
| **Diamond (Proxy)** | `0x80BD976cB588cD2F9aD9Ac671FB19174E9F3172b` | [link](https://polygonscan.com/address/0x80BD976cB588cD2F9aD9Ac671FB19174E9F3172b#code) |
| **CASToken (UUPS)** | `0x5151A34EaC7bA08cd6B540b32cD30316218A2287` | [link](https://polygonscan.com/address/0x5151A34EaC7bA08cd6B540b32cD30316218A2287#code) |
| **InfrastructureFund (UUPS)** | `0x190A9D2f206dbeb72Ce8b88Dc2603745fB5f50dB` | [link](https://polygonscan.com/address/0x190A9D2f206dbeb72Ce8b88Dc2603745fB5f50dB#code) |
| **CASSwap (UUPS)** | `0x9399878Ce33EA9D4859ab708a111fB3f274BACF4` | [link](https://polygonscan.com/address/0x9399878Ce33EA9D4859ab708a111fB3f274BACF4#code) |
| DiamondInit | `0x0DE5DeE3B6946BD2A540558Fbb5E17163f296dC7` | [link](https://polygonscan.com/address/0x0DE5DeE3B6946BD2A540558Fbb5E17163f296dC7#code) |
| DiamondCutFacet | `0xFA75D96a1F0297FB1de7547B09837Ea98d434570` | [link](https://polygonscan.com/address/0xFA75D96a1F0297FB1de7547B09837Ea98d434570#code) |
| DiamondLoupeFacet | `0x6ae32434d9Ec8C188195326bf321dBe9Ee77C062` | [link](https://polygonscan.com/address/0x6ae32434d9Ec8C188195326bf321dBe9Ee77C062#code) |
| OwnershipFacet | `0xa9e0Cc843d7C2D4f2Ead780CD2F806C080392415` | [link](https://polygonscan.com/address/0xa9e0Cc843d7C2D4f2Ead780CD2F806C080392415#code) |
| PausableFacet | `0x2056172c469a60E5290C27661CCF7D5785F8635B` | [link](https://polygonscan.com/address/0x2056172c469a60E5290C27661CCF7D5785F8635B#code) |
| UserRegistryFacet | `0x1Cf9d6cF0Fa979D09761D4f41bc78267f78977bE` | [link](https://polygonscan.com/address/0x1Cf9d6cF0Fa979D09761D4f41bc78267f78977bE#code) |
| AgentRegistryFacet | `0x8AAd53FEF5CFD63598C7caF28B0F640245F778a7` | [link](https://polygonscan.com/address/0x8AAd53FEF5CFD63598C7caF28B0F640245F778a7#code) |
| AgentValidatorFacet | `0x72Fd77B3cdb81066165787f494352399F0dB0027` | [link](https://polygonscan.com/address/0x72Fd77B3cdb81066165787f494352399F0dB0027#code) |
| RoadMapDAOFacet | `0x7A2bDd7c0B80c78b4aE9677839976B5A28EBcbF1` | [link](https://polygonscan.com/address/0x7A2bDd7c0B80c78b4aE9677839976B5A28EBcbF1#code) |
| AgentDAOFacet | `0xd8A3719afbaC8bb19291BF7fb33333a0eC903637` | [link](https://polygonscan.com/address/0xd8A3719afbaC8bb19291BF7fb33333a0eC903637#code) |
| ContractRegistryFacet | `0x7f76C4F89E70C31B12Ba14bfB943Ce206cf1809b` | [link](https://polygonscan.com/address/0x7f76C4F89E70C31B12Ba14bfB943Ce206cf1809b#code) |
| AccessControlFacet | `0xd14430836CF34B3B97b1D87B52FF47bff03b3F8a` | [link](https://polygonscan.com/address/0xd14430836CF34B3B97b1D87B52FF47bff03b3F8a#code) |
| PaymentFacet | `0x9E54710842A1E752D618604567B3c53A4ca7baca` | [link](https://polygonscan.com/address/0x9E54710842A1E752D618604567B3c53A4ca7baca#code) |
| GasPromotionFacet | `0x455Bc25088f40c688B76974dF34626219931aD19` | [link](https://polygonscan.com/address/0x455Bc25088f40c688B76974dF34626219931aD19#code) |

> **CASToken**: 1,000,000 CAS cunhados no deploy (supply máximo: 10,000,000 CAS).
> **CASSwap**: 500,000 CAS depositados como reserva de swap. Ratio 2:1 (1 POL = 2 CAS).
> **Custo total do deploy**: ~7.55 POL (tokens + diamond + facets).
> **DEX Liquidez**: Pendente — executar `04_add_dex_liquidity.ts` para adicionar liquidez CAS/POL no QuickSwap.

### Verificação no Polygonscan

```bash
# Listar contratos verificados
npm run verify

# Verificar contrato específico
npx hardhat verify --network polygon <CONTRACT_ADDRESS> [constructor-args]

# Verificar Diamond (com constructor args)
npx hardhat run scripts/utils/verify_diamond.ts --network polygon
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

## CI/CD (GitHub Actions)

O workflow `.github/workflows/contract-analysis.yml` executa automaticamente em pushes e PRs para `main`/`develop` e pode ser disparado manualmente via `workflow_dispatch`.

### Jobs

| Job | Descrição | Gatilho |
|---|---|---|
| `lint` | Solhint linting nos contratos | push / PR |
| `compile` | Compilação Hardhat + TypeChain | push / PR |
| `test-hardhat` | Testes Hardhat (Diamond, Faucet, FundTracker) | push / PR |
| `test-foundry` | Testes Foundry com profile `ci` (fuzz/invariant mais rigoroso) | push / PR |
| `slither` | Análise estática com Slither (falha em High severity) | push / PR |
| `coverage` | Cobertura de testes com Hardhat | push / PR |
| `contract-size` | Verificação de tamanho (EIP-170: 24KB) | push / PR |
| `gas-report` | Relatório de gas | push / PR |
| `mythril` | Análise simbólica com Mythril (não-bloqueante) | push / PR |
| `echidna` | Fuzzing com Echidna (não-bloqueante) | apenas `workflow_dispatch` |

### Configuração de Secrets no GitHub

O arquivo `.env.github` serve como **referência** para as variáveis necessárias. Configure os secrets em **Repository Settings > Secrets and Variables > Actions**:

| Secret | Obrigatório | Descrição |
|---|---|---|
| `POLYGON_AMOY_RPC_URL` | Não (default: RPC pública) | URL RPC da testnet Amoy |
| `POLYGON_AMOY_PRIVATE_KEY` | Não (placeholder) | Chave privada para testes na testnet |
| `POLYGON_RPC_URL` | Não (default: RPC pública) | URL RPC da mainnet Polygon |
| `POLYGON_PRIVATE_KEY` | Não (placeholder) | Chave privada para mainnet |
| `POLYGONSCAN_API_KEY` | Não | API Key do Polygonscan para verificação |
| `DEPLOYER_ADDRESS` | Não | Endereço do deployer |
| `ALCHEMY_API_KEY` | Não | API Key do Alchemy (RPC alternativo) |
| `CHAINSTACK_API_KEY` | Não | API Key do Chainstack (RPC alternativo) |
| `TATUM_API_KEY` | Não | API Key do Tatum (RPC alternativo) |
| `DIAMOND_ADDRESS` | Não | Endereço do Diamond (pós-deploy) |
| `FAUCET_ADDRESS` | Não | Endereço do Faucet (pós-deploy) |
| `INFRASTRUCTURE_FUND_ADDRESS` | Não | Endereço do InfrastructureFund |
| `CAS_TOKEN_ADDRESS` | Não | Endereço do CAS Token |
| `RELAYER_ADDRESS` | Não | Endereço do relayer backend |
| `RELAYER_PRIVATE_KEY` | Não | Chave privada do relayer |
| `FAUCET_TESTER_PRIVATE_KEY` | Não | Chave privada para testes do faucet |

> **Aviso:** Nunca commite secrets reais. O `.env.github` contém apenas placeholders. Use o GitHub UI para definir os valores reais.

## Taxas CAS Padrão

| Operação | Taxa (CAS) |
|---|---|
| Registro de Agente | 100 CAS |
| Validação de Agente | 50 CAS |
| Criar Proposta (DAO) | 200 CAS |
| Votar em Proposta | 10 CAS |
| Registro de Usuário | 30 CAS |
| Emissão/reserva do Certificado (tipo 6) | 50 CAS |

> As taxas podem ser ajustadas pelo admin via `updateFees()`.
> O tipo 6 é enumerado por `getAllFeeTypes()` e representa o depósito feito
> diretamente na TBA ERC-6551; ele não é cobrado uma segunda vez para o
> InfrastructureFund.

## Certificado de Sócio Fundador — Atuação Empreendedora e Voluntária

O **Certificado de Sócio Fundador** é uma iniciativa do Agentic Space para
engajar pessoas no projeto — sejam **leigos**, **especialistas em IA** ou
**desenvolvedores** — reconhecendo sua participação empreendedora e
voluntária na construção de um ecossistema de Inteligência Artificial
Generativa descentralizado.

### O que é o certificado?

O certificado é um **NFT ERC-721** com suporte a **ERC-6551** (Token Bound
Accounts), emitido pelo contrato `RapportCertificate` na Polygon mainnet.
Ao receber o certificado, o titular ganha uma **conta on-chain associada**
(TBA) que pode custodiar tokens CAS e outros ativos digitais.

O certificado de **Sócio Fundador** corresponde à **Phase 1** do sistema
de fases do `RapportCertificate`, exigindo um aporte mínimo de **50 CAS**
que fica depositado na TBA do próprio certificado.

### Para quem?

- **Leigos** — pessoas curiosas sobre IA e Web3 que querem fazer parte
  de uma comunidade aberta e aprender na prática
- **Especialistas em IA** — pesquisadores e profissionais que contribuem
  com conhecimento, prompts e validação de agentes
- **Desenvolvedores** — engenheiros que constroem e auditam contratos,
  agentes e infraestrutura

### Como participar?

1. **Solicite seu certificado** acessando:
   [https://agenticspace.vercel.app/certificado](https://agenticspace.vercel.app/certificado)

2. **Receba 1.000 CAS do Airdrop** — envie o endereço da sua carteira
   Ethereum/Polygon (ex.: MetaMask) via WhatsApp para **+55 (85) 98520-5490**
   para participar da campanha de distribuição de CAS e iniciar a
   circulação da moeda no ecossistema de IA Generativa.

> **Airdrop:** A campanha de distribuição visa colocar CAS nas mãos de
> participantes ativos para fomentar a circulação da moeda em operações
> reais — registro de agentes, validação de prompts, propostas na DAO e
> emissão de certificados.

### Fluxo de emissão

```
Participante
    │
    ├─ Acessa agenticspace.vercel.app/certificado
    │
    ├─ Envia endereço da carteira via WhatsApp (+55 85 98520-5490)
    │
    ▼
Agentic Space (Issuer)
    │
    ├— Transfere 1.000 CAS (Airdrop) para a carteira do participante
    │
    ├— Participante aprova 50 CAS → RapportCertificate
    │
    ├— mintCertificate() com autorização assinada pelo issuer
    │
    ▼
Certificado ERC-721 + TBA ERC-6551
    │
    ├— NFT não-transferível (ERC-5192) vinculado ao titular
    └— TBA custodia os 50 CAS depositados
```

### Contratos relacionados

| Contrato | Endereço | Função |
|---|---|---|
| `RapportCertificate` | Consulte `RAPPORT_CERTIFICATE_ADDRESS` no `.env` | Emissão e gestão de certificados |
| `CertificateFacet` (Diamond) | Integrado via `diamondCut` | Interação com certificados via Diamond |
| `ERC6551Registry` | `0x000000006551c19487814612e58FE06813775758` | Registry canônico de TBAs |

> **CTA:** [https://agenticspace.vercel.app/certificado](https://agenticspace.vercel.app/certificado)
>
> **WhatsApp:** +55 (85) 98520-5490 — envie o endereço da sua carteira
> Ethereum/Polygon para receber 1.000 CAS do Airdrop.

## Segurança

- Diamond usa EIP-2535 com `DiamondCutFacet` restrito ao owner
- `DiamondAccessControl` com roles granulares (AGENT_ROLE, VALIDATOR_ROLE, DAO_*, etc.)
- `PausableFacet` para emergências — pausa todos os facets via `LibDiamond`
- Diamond Storage em slots isolados previne colisões entre facets
- Validação de input em todas as funções externas com custom errors
- Sem secrets no código fonte — todas as chaves via `.env`
- `msg.sender` em vez de `tx.origin` (proibido pelo padrão de segurança)
- Eventos para todas as mutações de estado (Observer pattern)

## Documentação

Documentação detalhada em [`docs/`](./docs/):

- [`rapport-certificates.md`](docs/rapport-certificates.md) — certificados ERC-721/ERC-5192 com contas ERC-6551 e aporte CAS
- [`architecture.md`](docs/architecture.md) — Visão arquitetural
- [`deployment.md`](docs/deployment.md) — Guia de deploy
- [`agent-registry.md`](docs/agent-registry.md) — AgentRegistry
- [`agent-validator.md`](docs/agent-validator.md) — AgentValidator
- [`roadmap-dao.md`](docs/roadmap-dao.md) — RoadMapDAO
- [`agent-dao.md`](docs/agent-dao.md) — AgentDAO
- [`contract-registry.md`](docs/contract-registry.md) — ContractRegistry
- [`audit-guide.md`](docs/audit-guide.md) — Guia de auditoria
- [`keys-setup.md`](docs/keys-setup.md) — Como obter chaves privadas, API Key e endereço do deployer
- [`faucet.md`](docs/faucet.md) — Faucet avulso de POL na Polygon
- [Tokenomics do CAS](../frontend/public/tokens/tokenomics.md) — Supply, taxas, swap, distribuição
- [Whitepaper do CAS](../frontend/public/tokens/cas-whitepaper.md) — Whitepaper completo do CAS Token

## Changelog

| Data | Versão | Descrição |
|---|---|---|
| 2025-07-11 | 0.1.0 | Documentação inicial: contratos, arquitetura, deploy, auditoria |
| 2025-07-11 | 0.2.0 | Diamond Proxy (EIP-2535): facets plugáveis, Diamond Storage, VC com wallet plugável |
| 2025-07-11 | 0.3.0 | AccessControlFacet (grant/revoke roles em runtime), contratos legados deprecated, CASToken/InfraFund registrados via ContractRegistryFacet |
| 2025-07-11 | 0.4.0 | Merkle Tree de prompts: AgentStorage com name, description, parentPublicId, merkleRoot; MerkleLib para verificação; verifyPrompt e verifyPromptHistorical; viaIR habilitado |
| 2025-07-11 | 0.5.0 | UserRegistryFacet: registro de usuário on-chain com didHash (anonimato); AgentStorage com didHash + ownerUserId; agentes não transferíveis; USER_ROLE em DiamondAccessControl |
| 2025-07-11 | 0.6.0 | Remoção completa de contratos legados (core/, dao/, access/, PaymentLib, interfaces legadas); unificação total na arquitetura Diamond |
| 2025-07-11 | 0.7.0 | PaymentFacet + PaymentStorage + PaymentLib: taxas em CAS tokens no registro de agentes; binding CASToken/InfraFund no deploy |
| 2025-07-11 | 0.8.0 | GasPromotionFacet: gas sponsorship para operações (ex: registro de usuário); ativar/desativar promoções, budget, limite por usuário, relayer |
| 2025-07-11 | 0.8.1 | Tutorial de obtenção de chaves (keys-setup.md): guia passo a passo para POLYGON_AMOY_PRIVATE_KEY, POLYGON_PRIVATE_KEY, POLYGONSCAN_API_KEY e DEPLOYER_ADDRESS |
| 2025-07-11 | 0.9.0 | Faucet avulso: contrato standalone para distribuição de POL nativo na Polygon com cooldown, blacklist e saque de emergência |
| 2025-07-12 | 0.10.0 | PoWFaucet: faucet baseado em Proof of Work (keccak256) com difficulty ajustável; minerador GPU CUDA em `facelt_miner/` otimizado para RTX 4060; fallback CPU; dashboard de monitoramento |
| 2025-07-12 | 0.11.0 | FundTrackerToken: wrapper ERC-20 que espelha saldos do InfrastructureFund no MetaMask (aCAS para CAS, aPOL para POL); deploy script 01_deploy_fund_tracker.ts; 20 testes |
| 2025-07-12 | 0.12.0 | CI/CD GitHub Actions: workflow de análise e testes (lint, compile, Hardhat/Foundry tests, Slither, Mythril, Echidna, coverage, gas, contract size); `.env.github` como referência de secrets |
| 2026-07-14 | 0.13.0 | Mainnet deploy (Polygon PoS); atualização de taxas (30/100/50/200/10); menção a EIP-8004 e A2A como direções de pesquisa |
| 2026-07-18 | 0.14.0 | Seção Certificado de Sócio Fundador: atuação empreendedora e voluntária; CTA para certificado; campanha Airdrop de 1.000 CAS via WhatsApp |

## Licença

CC-BY-SA-4.0

![footer](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=100&section=footer&animation=twinkling)
