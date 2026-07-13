---
tags:
  - smartcontracts
  - index
  - MOC
---

![header](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=200&section=header&text=Smart%20Contracts%20Agentic%20Space&fontSize=36&fontAlignY=35&animation=twinkling)

![visitors](https://visitor-badge.laobi.icu/badge?page_id=RapportTecnologia.AgenticSpace.smartcontracts_readme)
[![License: CC BY-SA 4.0](https://img.shields.io/badge/License-CC_BY--SA_4.0-blue.svg)](https://creativecommons.org/licenses/by-sa/4.0/)
![Language: Portuguese](https://img.shields.io/badge/Language-Portuguese-brightgreen.svg)
![Status](https://img.shields.io/badge/Status-Ongoing-yellow)
[![GitHub Issues](https://img.shields.io/github/issues/RapportTecnologia/AgenticSpace)](https://github.com/RapportTecnologia/AgenticSpace/issues)

# Smart Contracts — Agentic Space

## Visão Geral

Smart contracts do Agentic Space em Solidity, deployados na rede **Polygon PoS** com testes na testnet **Amoy**.

A arquitetura utiliza o padrão **EIP-2535 Diamond Proxy**: um único endereço de proxy delega chamadas para *facets* modulares. Contratos de token (`CASToken`, `InfrastructureFund`, `FundTrackerToken`) e o `Faucet` permanecem standalone.

> [!info] Arquitetura Diamond
> Todos os contratos de domínio (registries, DAOs, validator, payments) são **facets** anexadas a um único **Diamond**. Ver [[architecture]].

## Mapa de Documentação

### Infraestrutura Diamond

- [[architecture]] — Arquitetura geral, padrões de projeto, estrutura de camadas
- [[diamond]] — Diamond proxy, DiamondInit, LibDiamond, facets de infraestrutura
- [[access-control]] — DiamondAccessControl + AccessControlFacet (roles)
- [[storage-namespaces]] — Namespaces de Diamond Storage (7 bibliotecas)

### Facets de Domínio

- [[user-registry]] — UserRegistryFacet (registro de usuários)
- [[agent-registry]] — AgentRegistryFacet (registro de agentes com Merkle roots)
- [[agent-validator]] — AgentValidatorFacet (validação de VC hashes)
- [[agent-dao]] — AgentDAOFacet (governança de agentes com delegação)
- [[roadmap-dao]] — RoadMapDAOFacet (governança de equipe com timelock)
- [[contract-registry]] — ContractRegistryFacet (descoberta de endereços)
- [[payment-facet]] — PaymentFacet (configuração de taxas CAS)
- [[gas-promotion]] — GasPromotionFacet (patrocínio de gas via relayer)

### Tokens e Treasury

- [[cas-token]] — CASToken (ERC-20 UUPS, mintable, burnable, pausable)
- [[infrastructure-fund]] — InfrastructureFund (treasury CAS + POL)
- [[fund-tracker-token]] — FundTrackerToken (espelha saldo do fundo no MetaMask)

### Faucet

- [[faucet]] — Faucet standalone (distribuição de POL com cooldown)

### Bibliotecas

- [[libs]] — AgentHashLib, MerkleLib, PaymentLib, VotingLib

### Operação

- [[deployment]] — Guia de deploy (Diamond, tokens, faucet)
- [[keys-setup]] — Obtenção de chaves e endereços
- [[audit-guide]] — Auditoria e análise (Solhint, Slither, Mythril, Echidna)

## Contratos

| Contrato | Tipo | Descrição |
|---|---|---|
| `Diamond` | EIP-2535 Proxy | Proxy único que delega para todas as facets |
| `DiamondCutFacet` | Facet | Adiciona/substitui/remove facets |
| `DiamondLoupeFacet` | Facet | Inspeção de facets e seletores |
| `OwnershipFacet` | Facet | Transferência de ownership do Diamond |
| `PausableFacet` | Facet | Pausa global do Diamond |
| `AccessControlFacet` | Facet | Gestão de roles on-chain |
| `UserRegistryFacet` | Facet | Registro de usuários (DID hash) |
| `AgentRegistryFacet` | Facet | Registro de agentes com Merkle roots |
| `AgentValidatorFacet` | Facet | Validação de VC hashes (wallet types) |
| `RoadMapDAOFacet` | Facet | DAO de equipe (propostas, votação, timelock) |
| `AgentDAOFacet` | Facet | DAO de agentes (votação com delegação) |
| `ContractRegistryFacet` | Facet | Registry de endereços por nome e versão |
| `PaymentFacet` | Facet | Configuração de CAS token e taxas |
| `GasPromotionFacet` | Facet | Patrocínio de gas para operações |
| `CASToken` | UUPS | ERC-20 interno (CAS) — mintable, burnable, pausable |
| `InfrastructureFund` | UUPS | Treasury — gerencia CAS e POL nativo |
| `FundTrackerToken` | Standalone | ERC-20 que espelha saldo do fundo (aCAS, aPOL) |
| `Faucet` | Ownable | Distribuição de POL nativo com cooldown |

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
npm test                    # Testes Hardhat
npm run test:foundry        # Fuzzing com Foundry
npm run test:coverage       # Cobertura
```

## Deploy

```bash
# 1. Deploy do Diamond (todas as facets)
npm run deploy:amoy         # Testnet (Amoy)
npm run deploy:polygon      # Mainnet (Polygon)

# 2. Deploy dos tokens (CASToken + InfrastructureFund)
npx hardhat run scripts/deploy/01_deploy_tokens.ts --network polygonAmoy

# 3. Deploy dos FundTrackerTokens (aCAS + aPOL)
npx hardhat run scripts/deploy/01_deploy_fund_tracker.ts --network polygonAmoy

# 4. Deploy do Faucet
npm run deploy:faucet:amoy
```

> [!warning] Ordem de Deploy
> O Diamond deve ser deployado primeiro. Os tokens devem ser deployados em seguida e seus endereços registrados no Diamond via `PaymentFacet.setCasToken()` e `PaymentFacet.setInfrastructureFund()`. Ver [[deployment]].

## Auditoria

```bash
npm run audit:solhint       # Linting
npm run audit:slither       # Análise estática
npm run audit:mythril       # Análise simbólica
npm run audit:echidna       # Fuzzing
npm run audit:full          # Todas as auditorias
```

## Análise

```bash
npm run analyze:gas         # Relatório de gas
npm run analyze:size        # Tamanho dos contratos
npm run analyze:coverage    # Cobertura de testes
```

## Segurança

- **Diamond (EIP-2535):** Upgrades via `diamondCut` — apenas o contract owner pode adicionar/substituir/remover facets
- **Tokens (UUPS):** `_authorizeUpgrade` restrito a `DEFAULT_ADMIN_ROLE`
- **Pausable:** `PausableFacet` pausa todas as facets de domínio via `LibDiamond.enforceNotPaused()`
- **AccessControl:** Roles granulares via `DiamondAccessControl` (AGENT_ROLE, VALIDATOR_ROLE, DAO_*, etc.)
- **SafeERC20:** Usado no `InfrastructureFund` para transferências seguras
- **Checks-Effects-Interactions:** No `Faucet.requestTokens()`
- **Custom errors:** Em todos os contratos para economizar gas
- **Validação de input:** Em todas as funções external
- **Sem secrets no código fonte** — todas as chaves via `.env`
- **`.env` no `.gitignore`** — nunca deve ser commitado

## Issues, Pull Requests e Governança DAO

O repositório utiliza templates padronizados para Issues e Pull Requests, localizados em `.github/`.

### Templates de Issue

| Template | Arquivo | Descrição |
|---|---|---|
| 🐛 Bug Report | `.github/ISSUE_TEMPLATE/bug_report.md` | Reportar bugs ou comportamentos inesperados |
| ✨ Feature Request | `.github/ISSUE_TEMPLATE/feature_request.md` | Solicitar novos recursos ou funcionalidades |
| ❓ Dúvida / Suporte | `.github/ISSUE_TEMPLATE/question_support.md` | Esclarecer dúvidas ou pedir suporte |
| 💡 Sugestão / Melhoria | `.github/ISSUE_TEMPLATE/suggestion.md` | Sugerir otimizações, refatorações ou melhorias |

### Template de Pull Request

- `.github/PULL_REQUEST_TEMPLATE.md` — Todo PR deve referenciar uma proposta aprovada na DAO.

### Fluxo de Governança

> [!important] Toda mudança no código deve ser planejada no Roadmap e aprovada por votação na DAO principal do Agentic Space.

```
Issue (Bug/Feature/Suggestion)
  ↓
Proposta no RoadMapDAOFacet (tipo: Feature=0, Bugfix=1, Refactor=2, GovernanceChange=3)
  ↓
Votação (quorum + maioria simples)
  ↓
Timelock (2 dias para RoadMapDAO, 3 dias para AgentDAO)
  ↓
Execução da proposta
  ↓
Implementação (Pull Request)
  ↓
Revisão e Merge
```

- **Dúvidas e suporte** não requerem aprovação via DAO, mas se revelarem necessidade de mudança, uma issue específica deve ser criada.
- **Bug fixes, features e sugestões** requerem proposta no `RoadMapDAOFacet` por um membro com `DAO_PROPOSER_ROLE`.
- **Mudanças de governança** podem requerer aprovação adicional no `AgentDAOFacet` (DAO de agentes).

Consulte [[agent-dao]] e [[roadmap-dao]] para detalhes sobre tipos de proposta, quorum, votação e timelock.

## Changelog

| Data | Versão | Descrição |
|---|---|---|
| 2025-07-12 | 0.3.0 | Templates de Issue e PR (.github/), seção de governança DAO na documentação |
| 2025-07-12 | 0.2.0 | Reestruturação completa: Diamond EIP-2535, facets, novas facets (UserRegistry, Payment, GasPromotion), FundTrackerToken, MerkleLib |
| 2025-07-11 | 0.1.0 | Documentação inicial: contratos standalone UUPS, arquitetura, deploy, auditoria |

## Licença

CC-BY-SA-4.0

![footer](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=100&section=footer&animation=twinkling)
