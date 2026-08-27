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
  ├── GasPromotionFacet        (patrocínio de gas)
  ├── IdentityRegistryFacet    (EIP-8004 — agent card / manifest URI)
  ├── ReputationRegistryFacet  (EIP-8004 — feedback anti-Sybil)
  ├── ValidationRegistryFacet  (EIP-8004 — validação por terceiros)
  ├── AgentCommerceFacet       (EIP-8183 — comércio agente-a-agente com escrow)
  └── X402FacilitatorFacet     (x402 — pagamentos pay-per-call, EIP-712)

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
│       ├── CommerceStorage.sol      # EIP-8183 — ofertas e escrow
│       ├── DAOStorage.sol
│       ├── Eip8004Storage.sol       # EIP-8004 — metadata, reputação, validação
│       ├── GasPromotionStorage.sol
│       ├── PaymentStorage.sol
│       ├── ProjectStorage.sol
│       ├── UserStorage.sol
│       ├── VCStorage.sol
│       └── X402Storage.sol          # x402 — anti-replay + taxa de protocolo
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
│   ├── UserRegistryFacet.sol
│   ├── eip8004/
│   │   ├── IdentityRegistryFacet.sol
│   │   ├── ReputationRegistryFacet.sol
│   │   └── ValidationRegistryFacet.sol
│   ├── eip8183/
│   │   └── AgentCommerceFacet.sol
│   └── x402/
│       └── X402FacilitatorFacet.sol
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
│   ├── SignatureLib.sol             # EIP-712 domain separator (Diamond-safe)
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

## Fluxo de Comércio Agente-a-Agente (EIP-8183)

1. `IdentityRegistryFacet.resolveAgent(agentId)` — agente comprador avalia a contraparte (identidade + metadata EIP-8004) antes de negociar
2. `AgentCommerceFacet.createOffer(sellerAgentId, scopeHash, price, deadline)` — vendedor publica a oferta
3. `AgentCommerceFacet.negotiate(offerId, counterPrice)` — comprador (ou vendedor) contrapropõe, sempre dentro dos limites `[minNegotiationBps, maxNegotiationBps]` do preço original — nenhum agente/LLM decide o range sozinho
4. `AgentCommerceFacet.acceptOffer(offerId, buyerAgentId)` — a parte que não fez a última proposta aceita
5. `AgentCommerceFacet.fundJob(offerId)` — comprador deposita CAS em escrow no próprio Diamond
6. `AgentCommerceFacet.markDelivered(offerId)` — vendedor marca a entrega, abrindo a janela de disputa
7. `AgentCommerceFacet.confirmDelivery(offerId)` (comprador) ou `claimSettlement(offerId)` (qualquer keeper, após a janela) — liquida o CAS: parte ao vendedor, taxa de protocolo ao `InfrastructureFund`
8. Em caso de desacordo: `raiseDispute(offerId, reasonHash)` (comprador, dentro da janela) → `resolveDispute(offerId, buyerRefundBps)` (`COMMERCE_ARBITER_ROLE`)
9. `ReputationRegistryFacet.submitFeedback(fromAgentId, toAgentId, offerId, score, commentHash)` — feedback só é aceito se `offerId` estiver `Settled`/`Resolved` entre os dois agentes (`isJobSettledBetween`), prevenindo Sybil/fake-review

> [!note] Detalhamento completo
> Ver [[eip8183-agent-commerce]] para o ciclo de vida completo (`JobState`), todas as funções, eventos e o racional do clamp de negociação, e [[eip8004-trust-layer]] para a camada de confiança e o design anti-Sybil da reputação.

## Fluxo x402

1. `PaymentFacet` já deve ter `casToken` e `infrastructureFund` configurados (mesma dependência do `AgentCommerceFacet`)
2. `X402FacilitatorFacet.initX402(protocolFeeBps)` — owner inicializa e recebe `X402_RELAYER_ROLE`
3. **Caminho direto:** o próprio pagador chama `payDirect(payee, requestHash, amount, deadline)` — sem assinatura, `msg.sender` é quem paga
4. **Caminho facilitado (gasless):** o pagador assina off-chain uma autorização EIP-712 (`X402Authorization{payer,payee,requestHash,amount,deadline}`); uma conta com `X402_RELAYER_ROLE` submete via `settleWithAuthorization(...)`
5. Em ambos os caminhos, `requestHash` (hash da requisição HTTP off-chain, não um nonce sequencial) impede replay por `payer`
6. `_settle` desconta `protocolFeeBps` do `amount` e transfere o líquido ao `payee` e a taxa ao `InfrastructureFund`, ambos via `safeTransferFrom` diretamente da allowance do pagador

> [!warning] EIP-712 + Diamond
> `SignatureLib` calcula o domain separator (`address(this)`, `block.chainid`) **em tempo de chamada**, nunca como `immutable` — variáveis `immutable` são gravadas no bytecode da facet durante seu próprio deploy e resolveriam para o endereço da facet, não do Diamond, quebrando toda verificação de assinatura. Ver [[x402-facilitator#Por que o domain separator é calculado em tempo de chamada (não immutable)]].

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
| 2026-08-24 | 0.3.0 | Adicionados EIP-8004 (Trust Layer), EIP-8183 (AgentCommerceFacet) e x402 (X402FacilitatorFacet): 3 novos namespaces de storage, 5 novas facets, fluxos de comércio agente-a-agente e x402 |
| 2025-07-12 | 0.2.0 | Reescrita completa: Diamond EIP-2535, Diamond Storage, facets, novos fluxos |
| 2025-07-11 | 0.1.0 | Documentação inicial: padrões de projeto, camadas, fluxo de identidade, segurança |

![footer](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=100&section=footer&animation=twinkling)
