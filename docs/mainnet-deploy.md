# Mainnet Deployment Guide — CAS Token

Guia passo a passo para deploy do CAS Token e contratos relacionados na
Polygon Mainnet, com pareamento POL no QuickSwap e governança via Safe multisig.

## Pré-requisitos

1. **Node.js 18+** e dependências instaladas (`npm install` em `smartcontracts/`)
2. **Carteira deployer** com POL suficiente para:
   - Gas de deploy (~2-3 POL)
   - Liquidez inicial do DEX (configurável, padrão 500 POL)
   - Reserva do CASSwap (CAS, não POL)
3. **Polygonscan API Key** para verificação de contratos
4. **Safe multisig** criado em [app.safe.global](https://app.safe.global) na Polygon
5. **Endereços de Rapport e Autor** para o InfrastructureFund

## 1. Configuração do .env

```bash
cd smartcontracts
cp .env.example .env
```

Editar `.env` com os valores de mainnet:

```env
# Network
POLYGON_RPC_URL=https://polygon-rpc.com
POLYGON_PRIVATE_KEY=sua_chave_privada_deployer

# API
POLYGONSCAN_API_KEY=sua_api_key

# QuickSwap (mainnet router)
DEX_ROUTER_ADDRESS=0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff

# Chainlink POL/USD (mainnet)
CHAINLINK_POL_USD_FEED=0xAB594600376Ec9fD91F8e88dCd467f77F3BFE7f9

# Safe multisig (preencher antes do passo 6)
SAFE_MULTISIG_ADDRESS=0x...
RAPPORT_ADDRESS=0x...
AUTHOR_ADDRESS=0x...

# Liquidity lock (6 meses = 15768000 segundos)
LIQUIDITY_LOCK_DURATION_SECONDS=15768000
```

> [!danger] Segurança
> - Nunca commite o `.env` — está no `.gitignore`
> - Use uma chave privada dedicada para deploy, não a carteira principal
> - A chave deployer terá controle até o passo 6 (transfer para multisig)

## 2. Sequência de Deploy

### Passo 1: Diamond

```bash
npm run deploy:polygon
```

Salve `DIAMOND_ADDRESS` no `.env`.

### Passo 2: CASToken + InfrastructureFund

```bash
npx hardhat run scripts/deploy/01_deploy_tokens.ts --network polygon
```

Salve `CAS_TOKEN_ADDRESS` e `INFRASTRUCTURE_FUND_ADDRESS` no `.env`.

> Re-execute `deploy:polygon` ou chame manualmente:
> - `ContractRegistryFacet.register("CASToken", 1, casTokenAddress)`
> - `PaymentFacet.setCasToken(casTokenAddress)`
> - `PaymentFacet.setInfrastructureFund(infraFundAddress)`

### Passo 3: CASSwap

```bash
npx hardhat run scripts/deploy/03_deploy_cas_swap.ts --network polygon
```

Salve `CAS_SWAP_ADDRESS` no `.env`.

O script deposita 500.000 CAS como reserva inicial de swap.

### Passo 4: Adicionar Liquidez DEX (QuickSwap)

```bash
npx hardhat run scripts/deploy/04_add_dex_liquidity.ts --network polygon
```

Este script:
1. Aprova CAS e POL no router do QuickSwap
2. Adiciona liquidez com `addLiquidityETH`
3. Detecta e salva `LP_TOKEN_ADDRESS`

> [!warning] Configurar liquidez
> Ajuste `DEX_LIQUIDITY_CAS_AMOUNT` e `DEX_LIQUIDITY_POL_AMOUNT` no `.env`
> conforme a estratégia de lançamento. O padrão é 1.000 CAS + 500 POL (ratio 2:1).

### Passo 5: Lock de Liquidez

```bash
npx hardhat run scripts/deploy/05_lock_liquidity.ts --network polygon
```

Bloqueia os LP tokens no `LiquidityLock` por `LIQUIDITY_LOCK_DURATION_SECONDS`.

Salve `LIQUIDITY_LOCK_ADDRESS` no `.env`.

### Passo 6: Transferência para Multisig

```bash
npx hardhat run scripts/deploy/06_transfer_to_multisig.ts --network polygon
```

> [!danger] Verifique o endereço do Safe
> Confirme `SAFE_MULTISIG_ADDRESS` antes de executar. Esta operação transfere
> todas as roles de admin para o multisig e é irreversível.

O script:
1. Transfere `DEFAULT_ADMIN_ROLE` do CASToken para o Safe
2. Transfere `DEFAULT_ADMIN_ROLE` do InfrastructureFund para o Safe
3. Transfere `DEFAULT_ADMIN_ROLE` do CASSwap para o Safe
4. Define `RAPPORT_ADDRESS` e `AUTHOR_ADDRESS` no InfrastructureFund

### Passo 7: Verificação no Polygonscan

```bash
npx hardhat verify --network polygon <CONTRACT_ADDRESS> [constructor-args]
```

Verificar todos os contratos deployados:
- Diamond proxy
- CASToken (UUPS)
- InfrastructureFund (UUPS)
- CASSwap (UUPS)
- LiquidityLock (standalone)

### Passo 8: Validação

Para validar na testnet Amoy antes da mainnet:

```bash
npx hardhat run scripts/utils/validate_amoy.ts --network polygonAmoy
```

## 3. Pós-Deploy

### Configurar roles no Diamond

Após transferir para o multisig, execute via Safe:

1. **Grant RATIO_ADMIN_ROLE** para o endereço financeiro:
   ```solidity
   AccessControlFacet.grantRole(RATIO_ADMIN_ROLE, financeAddress)
   ```

2. **Grant TREASURER_ROLE** no InfrastructureFund:
   ```solidity
   InfrastructureFund.grantRole(TREASURER_ROLE, financeAddress)
   ```

3. **Grant PAUSER_ROLE** para o endereço de segurança:
   ```solidity
   CASToken.grantRole(PAUSER_ROLE, securityAddress)
   CASSwap.grantRole(PAUSER_ROLE, securityAddress)
   ```

### Atualizar trustwallet_assets

Atualizar o arquivo `trustwallet_assets/blockchains/polygon/info/` com:
- Endereço do CASToken
- Nome, símbolo, decimais
- Logo
- Links sociais

### Submeter para CoinGecko/CoinMarketCap

Após confirmar o deploy:
1. Adicionar o contrato no [CoinGecko](https://www.coingecko.com/en/coins/list)
2. Adicionar no [CoinMarketCap](https://coinmarketcap.com/)
3. Informar o endereço do pair CAS/POL no QuickSwap

## 4. Endereços Deployados (Polygon Mainnet — 14/07/2026)

### Contratos Principais

| Recurso | Endereço | Status |
|---|---|---|
| **Diamond (Proxy)** | `0x80BD976cB588cD2F9aD9Ac671FB19174E9F3172b` | Verificado |
| **CASToken (UUPS)** | `0x5151A34EaC7bA08cd6B540b32cD30316218A2287` | Verificado |
| **InfrastructureFund (UUPS)** | `0x190A9D2f206dbeb72Ce8b88Dc2603745fB5f50dB` | Verificado |
| **CASSwap (UUPS)** | `0x9399878Ce33EA9D4859ab708a111fB3f274BACF4` | Verificado |
| DiamondInit | `0x0DE5DeE3B6946BD2A540558Fbb5E17163f296dC7` | Verificado |

### Facets (anexados ao Diamond)

| Facet | Endereço | Status |
|---|---|---|
| DiamondCutFacet | `0xFA75D96a1F0297FB1de7547B09837Ea98d434570` | Verificado |
| DiamondLoupeFacet | `0x6ae32434d9Ec8C188195326bf321dBe9Ee77C062` | Verificado |
| OwnershipFacet | `0xa9e0Cc843d7C2D4f2Ead780CD2F806C080392415` | Verificado |
| PausableFacet | `0x2056172c469a60E5290C27661CCF7D5785F8635B` | Verificado |
| UserRegistryFacet | `0x1Cf9d6cF0Fa979D09761D4f41bc78267f78977bE` | Verificado |
| AgentRegistryFacet | `0x8AAd53FEF5CFD63598C7caF28B0F640245F778a7` | Verificado |
| AgentValidatorFacet | `0x72Fd77B3cdb81066165787f494352399F0dB0027` | Verificado |
| RoadMapDAOFacet | `0x7A2bDd7c0B80c78b4aE9677839976B5A28EBcbF1` | Verificado |
| AgentDAOFacet | `0xd8A3719afbaC8bb19291BF7fb33333a0eC903637` | Verificado |
| ContractRegistryFacet | `0x7f76C4F89E70C31B12Ba14bfB943Ce206cf1809b` | Verificado |
| AccessControlFacet | `0xd14430836CF34B3B97b1D87B52FF47bff03b3F8a` | Verificado |
| PaymentFacet | `0x9E54710842A1E752D618604567B3c53A4ca7baca` | Verificado |
| GasPromotionFacet | `0x455Bc25088f40c688B76974dF34626219931aD19` | Verificado |

### Endereços de Referência

| Recurso | Endereço |
|---|---|
| QuickSwap Router | `0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff` |
| Chainlink POL/USD | `0xAB594600376Ec9fD91F8e88dCd467f77F3BFE7f9` |
| POL Token (ERC-20) | `0x455e53CDe89585AeD2C5E8C8aAb9931c4E14C27E` |
| Deployer | `0x66682BBeD9e540017967692cCdd069fE5F833888` |

### Resumo do Deploy

- **Data**: 14/07/2026
- **Rede**: Polygon PoS Mainnet (chainId: 137)
- **Custo total**: ~7.55 POL
- **CASToken supply inicial**: 1,000,000 CAS
- **CASToken max supply**: 10,000,000 CAS
- **Contratos verificados**: 17/17

## 5. Checklist de Segurança

- [x] Chave privada deployer dedicada (não reutilizada)
- [x] `.env` não commitado
- [x] Contratos verificados no Polygonscan
- [x] Documentação atualizada com endereços finais
- [ ] Safe multisig criado e verificado
- [ ] Endereços de Rapport e Autor confirmados
- [ ] Liquidez DEX confirmada no QuickSwap
- [ ] LP tokens bloqueados no LiquidityLock
- [ ] Roles transferidas para o multisig
- [ ] PAUSER_ROLE concedido a endereço de segurança
- [ ] RATIO_ADMIN_ROLE concedido a endereço financeiro
- [ ] TREASURER_ROLE concedido a endereço financeiro
- [ ] Backup dos manifestos `.openzeppelin/`
