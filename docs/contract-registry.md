---
tags:
  - smartcontracts
  - facet
  - contract-registry
---

![header](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=200&section=header&text=ContractRegistryFacet&fontSize=36&fontAlignY=35&animation=twinkling)

![visitors](https://visitor-badge.laobi.icu/badge?page_id=RapportTecnologia.AgenticSpace.smartcontracts_contract-registry)
[![License: CC BY-SA 4.0](https://img.shields.io/badge/License-CC_BY--SA_4.0-blue.svg)](https://creativecommons.org/licenses/by-sa/4.0/)
![Language: Portuguese](https://img.shields.io/badge/Language-Portuguese-brightgreen.svg)
![Status](https://img.shields.io/badge/Status-Ongoing-yellow)
[![GitHub Issues](https://img.shields.io/github/issues/RapportTecnologia/AgenticSpace)](https://github.com/RapportTecnologia/AgenticSpace/issues)

# ContractRegistryFacet

**Caminho:** `contracts/facets/ContractRegistryFacet.sol`

Facet responsável pelo registry central de endereços de contratos dentro do Diamond. Permite que backend e frontend descubram endereços dinamicamente, eliminando hardcode.

## Visão Geral

- Registra contratos por nome e versão
- Consulta por nome (última versão) ou por versão específica
- Usado para registrar `CASToken` e `InfrastructureFund` após deploy
- Requer `CONTRACT_REGISTRY_ROLE` para registrar

## Funções

### Registrar

```solidity
function register(
    string calldata name,
    uint256 version,
    address contractAddress
) external onlyRole(CONTRACT_REGISTRY_ROLE) whenNotPaused
```

Registra um novo contrato ou atualiza para uma versão superior.

- Valida: nome não vazio, endereço não zero, versão > 0
- Emite `ContractRegistered` (novo) ou `ContractUpdated` (atualização)

### Consultas

| Função | Retorno | Descrição |
|---|---|---|
| `getAddress(string name)` | `address` | Endereço da versão mais recente |
| `getAddressByVersion(string name, uint256 version)` | `address` | Endereço de versão específica |
| `getVersions(string name)` | `(uint256[], address[])` | Todas as versões registradas |
| `isRegistered(string name)` | `bool` | Verifica se está registrado |

## Events

- `ContractRegistered(string name, uint256 version, address contractAddress)`
- `ContractUpdated(string name, uint256 oldVersion, uint256 newVersion, address oldAddress, address newAddress)`

## Uso

```solidity
// Registrar contratos (requer CONTRACT_REGISTRY_ROLE)
contractRegistry.register("CASToken", 1, casTokenAddress);
contractRegistry.register("InfrastructureFund", 1, infraFundAddress);

// Consultar endereço atual
address casAddr = contractRegistry.getAddress("CASToken");

// Consultar versão específica
address v1 = contractRegistry.getAddressByVersion("CASToken", 1);
```

> [!info] Deploy automático
> O script `00_deploy_diamond.ts` registra automaticamente `CASToken` e `InfrastructureFund` se `CAS_TOKEN_ADDRESS` e `INFRASTRUCTURE_FUND_ADDRESS` estiverem definidos no `.env`.

## Dependências

- [[access-control]] — `DiamondAccessControl` (`CONTRACT_REGISTRY_ROLE`)

## Segurança

- `whenNotPaused` em funções de mutação
- Apenas `CONTRACT_REGISTRY_ROLE` pode registrar
- Validação: nome não vazio, endereço não zero, versão > 0

## Changelog

| Data | Versão | Descrição |
|---|---|---|
| 2025-07-12 | 0.2.0 | Reescrita completa: facet com Diamond Storage e roles |
| 2025-07-11 | 0.1.0 | Documentação inicial do ContractRegistry standalone |

![footer](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=100&section=footer&animation=twinkling)
