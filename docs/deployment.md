---
tags:
  - smartcontracts
  - deployment
  - operations
---

![header](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=200&section=header&text=Guia%20de%20Deploy&fontSize=36&fontAlignY=35&animation=twinkling)

![visitors](https://visitor-badge.laobi.icu/badge?page_id=RapportTecnologia.AgenticSpace.smartcontracts_deployment)
[![License: CC BY-SA 4.0](https://img.shields.io/badge/License-CC_BY--SA_4.0-blue.svg)](https://creativecommons.org/licenses/by-sa/4.0/)
![Language: Portuguese](https://img.shields.io/badge/Language-Portuguese-brightgreen.svg)
![Status](https://img.shields.io/badge/Status-Ongoing-yellow)
[![GitHub Issues](https://img.shields.io/github/issues/RapportTecnologia/AgenticSpace)](https://github.com/RapportTecnologia/AgenticSpace/issues)

# Guia de Deploy

## Pré-requisitos

1. Node.js 18+
2. `npm install` executado em `smartcontracts/`
3. Carteira com POL (testnet ou mainnet)
4. Polygonscan API Key (para verificação)
5. Foundry instalado (opcional, para testes e fuzzing)

## Configuração

```bash
cd smartcontracts
cp .env.example .env
```

Editar `.env`:

```env
# Network
POLYGON_AMOY_RPC_URL=https://rpc-amoy.polygon.technology
POLYGON_RPC_URL=https://polygon-rpc.com
POLYGON_AMOY_PRIVATE_KEY=sua_chave_privada
POLYGON_PRIVATE_KEY=sua_chave_privada_mainnet

# API Keys
POLYGONSCAN_API_KEY=sua_api_key

# Deploy (opcionais — preenchidos após deploy)
CAS_TOKEN_ADDRESS=
INFRASTRUCTURE_FUND_ADDRESS=
DIAMOND_ADDRESS=
FAUCET_INTERVAL=86400
FAUCET_AMOUNT=100000000000000000
```

> [!warning] Segurança
> Nunca commite o `.env`. Use chaves privadas dedicadas para deploy. Ver [[keys-setup]].

## Ordem de Deploy

> [!important] Sequência obrigatória
> 1. **Diamond** (com todas as facets)
> 2. **Tokens** (CASToken + InfrastructureFund)
> 3. **Registrar tokens no Diamond** (re-executar deploy do Diamond ou manualmente)
> 4. **FundTrackerTokens** (aCAS + aPOL) — opcional
> 5. **Faucet** — independente

## 1. Deploy do Diamond

### Testnet (Amoy)

```bash
npm run deploy:amoy
```

### Mainnet (Polygon)

```bash
npm run deploy:polygon
```

### O que o script faz

O script `scripts/deploy/00_deploy_diamond.ts` executa:

1. Deploy do `DiamondCutFacet`
2. Deploy do `Diamond` (proxy) com `DiamondCutFacet` anexada
3. Deploy do `DiamondInit`
4. Deploy de todas as facets restantes:
   - `DiamondLoupeFacet`, `OwnershipFacet`, `PausableFacet`
   - `UserRegistryFacet`, `AgentRegistryFacet`, `AgentValidatorFacet`
   - `RoadMapDAOFacet`, `AgentDAOFacet`, `ContractRegistryFacet`
   - `AccessControlFacet`, `PaymentFacet`, `GasPromotionFacet`
5. Executa `diamondCut` para anexar todas as facets + `DiamondInit.init()`
6. Inicializa facets de domínio:
   - `AgentValidatorFacet.initValidator()` — adiciona MetaMask como wallet suportado
   - `RoadMapDAOFacet.initRoadMapDAO()` — configura parâmetros padrão
   - `AgentDAOFacet.initAgentDAO()` — configura parâmetros padrão
   - `PaymentFacet.initPayment()` — configura taxas padrão
   - `GasPromotionFacet.initGasPromotion()` — desativado por padrão
7. Registra `CASToken` e `InfrastructureFund` no `ContractRegistryFacet` (se endereços no `.env`)
8. Vincula tokens ao `PaymentFacet` (se endereços no `.env`)

### Pós-Deploy

```env
DIAMOND_ADDRESS=0x...
```

> [!note] Deploy incremental
> O script `scripts/deploy/02_deploy_incremental.ts` permite reanexar facets a um Diamond já deployado. Útil para recuperação de deploy parcial.

## 2. Deploy dos Tokens

```bash
npx hardhat run scripts/deploy/01_deploy_tokens.ts --network polygonAmoy
```

O script:
1. Deploy do `CASToken` (UUPS proxy) — inicializa com 1.000.000 CAS
2. Deploy do `InfrastructureFund` (UUPS proxy) — inicializa com deployer como rapport e author

### Pós-Deploy

```env
CAS_TOKEN_ADDRESS=0x...
INFRASTRUCTURE_FUND_ADDRESS=0x...
```

> [!warning] Re-executar deploy do Diamond
> Após definir `CAS_TOKEN_ADDRESS` e `INFRASTRUCTURE_FUND_ADDRESS` no `.env`, re-execute o passo 1 para registrar os tokens no Diamond e vinculá-los ao `PaymentFacet`. Alternativamente, chame manualmente:
> - `ContractRegistryFacet.register("CASToken", 1, casTokenAddress)`
> - `ContractRegistryFacet.register("InfrastructureFund", 1, infraFundAddress)`
> - `PaymentFacet.setCasToken(casTokenAddress)`
> - `PaymentFacet.setInfrastructureFund(infraFundAddress)`

## 3. Deploy dos FundTrackerTokens (opcional)

```bash
npx hardhat run scripts/deploy/01_deploy_fund_tracker.ts --network polygonAmoy
```

Requer `INFRASTRUCTURE_FUND_ADDRESS` no `.env`. Opcional: `FUND_TRACKER_ADMIN` (padrão: deployer).

Deploy duas instâncias:
- **CAS Tracker** (aCAS) — espelha `fund.casBalance()`
- **POL Tracker** (aPOL) — espelha `fund.nativeBalance()`

### Pós-Deploy

Adicione os endereços no MetaMask como tokens customizados (decimais: 18).

## 4. Deploy do Faucet

```bash
# Testnet
npx hardhat run scripts/deploy/02_deploy_faucet.ts --network polygonAmoy

# Mainnet
npx hardhat run scripts/deploy/02_deploy_faucet.ts --network polygon
```

Parâmetros via `.env`:
- `FAUCET_INTERVAL` — cooldown em segundos (default: 86400 = 24h)
- `FAUCET_AMOUNT` — POL por saque em wei (default: 0.1 POL)

### Pós-Deploy

1. Envie POL para o endereço do faucet
2. Verifique no Polygonscan
3. Usuários chamam `requestTokens()`

## Verificação no Polygonscan

```bash
# Verificar contrato específico
npx hardhat verify --network polygonAmoy <CONTRACT_ADDRESS> [constructor-args]

# Exemplo: Faucet
npx hardhat verify --network polygonAmoy <FAUCET_ADDRESS> 86400 100000000000000000
```

> [!note] Verificação do Diamond
> O Diamond e suas facets podem ser verificados individualmente. O proxy `Diamond` recebe `(address, FacetCut[])` no constructor.

## Upgrade de Facets

Para adicionar, substituir ou remover facets do Diamond:

```solidity
// Via DiamondCutFacet
IDiamondCut.FacetCut[] memory cut = new IDiamondCut.FacetCut[](1);
cut[0] = IDiamondCut.FacetCut({
    facetAddress: newFacetAddress,
    action: 0, // 0=Add, 1=Replace, 2=Remove
    functionSelectors: selectors
});
diamondCut.diamondCut(cut, address(0), "");
```

> [!warning] Apenas contract owner
> Apenas o owner do Diamond pode executar `diamondCut`. Use `OwnershipFacet.transferOwnership()` para transferir para um multisig após o deploy.

## Upgrade de Tokens (UUPS)

```bash
# CASToken e InfrastructureFund são UUPS
# Use OpenZeppelin Upgrades plugin ou Hardhat defend
npx hardhat run scripts/upgrade_token.ts --network polygonAmoy
```

## Segurança

- **Nunca** commite o `.env` — ele está no `.gitignore`
- Use chaves privadas dedicadas para deploy, não reutilize carteiras principais
- Após o deploy, verifique todos os endereços no Polygonscan antes de prosseguir
- Transfira `DEFAULT_ADMIN_ROLE` e ownership para um multisig após o deploy inicial
- Conceda roles específicas (`PAUSER_ROLE`, `DAO_ADMIN_ROLE`, etc.) via `AccessControlFacet.grantRole()`
- Mantenha os manifestos `.openzeppelin/` versionados para rastreabilidade de upgrades UUPS

## Changelog

| Data | Versão | Descrição |
|---|---|---|
| 2025-07-12 | 0.2.0 | Reescrita completa: deploy do Diamond, tokens, fund trackers, faucet |
| 2025-07-11 | 0.1.0 | Documentação inicial: deploy de contratos standalone UUPS |

![footer](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=100&section=footer&animation=twinkling)
