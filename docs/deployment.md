# Guia de Deploy

## Pré-requisitos

1. Node.js 18+
2. npm install executado em `smartcontracts/`
3. Carteira com MATIC (testnet ou mainnet)
4. Polygonscan API Key (para verificação)

## Configuração

```bash
cd smartcontracts
cp .env.example .env
```

Editar `.env`:

```env
POLYGON_AMOY_RPC_URL=https://rpc-amoy.polygon.technology
POLYGON_AMOY_PRIVATE_KEY=sua_chave_privada
POLYGONSCAN_API_KEY=sua_api_key
```

## Deploy na Testnet (Amoy)

```bash
npm run deploy:amoy
```

Este comando executa os 5 scripts de deploy em sequência:
1. `01_deploy_contract_registry.ts` — Deploy do ContractRegistry
2. `02_deploy_agent_registry.ts` — Deploy do AgentRegistry + registro no ContractRegistry
3. `03_deploy_agent_validator.ts` — Deploy do AgentValidator + registro
4. `04_deploy_roadmap_dao.ts` — Deploy do RoadMapDAO + registro
5. `05_deploy_agent_dao.ts` — Deploy do AgentDAO + registro

Após cada deploy, atualize o `.env` com os endereços retornados.

## Deploy na Mainnet (Polygon)

```bash
npm run deploy:polygon
```

## Verificação no Polygonscan

```bash
# Listar contratos verificados na testnet
npm run verify

# Verificar contrato específico
npx hardhat verify --network polygonAmoy <CONTRACT_ADDRESS> [constructor-args]

# Utilitário de verificação (verifica todos os contratos deployados)
npx hardhat run scripts/utils/verify_contracts.ts --network polygonAmoy
```

## Upgrade de Contrato

```bash
# Setar no .env:
# UPGRADE_CONTRACT_NAME=AgentRegistry
# UPGRADE_PROXY_ADDRESS=0x...

npm run upgrade
```

## Endereços Pós-Deploy

Após o deploy, os endereços ficam salvos em:
- `deploy/polygon-amoy/` — testnet
- `deploy/polygon-mainnet/` — mainnet

Os manifestos do OpenZeppelin (.openzeppelin/) contêm o histórico de upgrades.

## Contratos Pendentes de Deploy

Os scripts de deploy 06 (CASToken) e 07 (InfrastructureFund) ainda não foram implementados. Atualmente apenas 5 contratos são deployados automaticamente (01-05). Para deployar CASToken e InfrastructureFund manualmente:

```bash
npx hardhat run scripts/deploy/06_deploy_cas_token.ts --network polygonAmoy
npx hardhat run scripts/deploy/07_deploy_infrastructure_fund.ts --network polygonAmoy
```

> **Atenção:** Estes scripts ainda não existem e precisam ser criados.

## Segurança

- **Nunca** commite o arquivo `.env` — ele está no `.gitignore`
- Use chaves privais dedicadas para deploy, não reutilize carteiras principais
- Após o deploy, verifique todos os endereços no Polygonscan antes de prosseguir
- Mantenha os manifestos `.openzeppelin/` versionados para rastreabilidade de upgrades
- O `DEFAULT_ADMIN_ROLE` deve ser transferido para um multisig após o deploy inicial

## Changelog

| Data | Versão | Descrição |
|---|---|---|
| 2025-07-11 | 0.1.0 | Documentação inicial: pré-requisitos, configuração, deploy, verificação, upgrade |
