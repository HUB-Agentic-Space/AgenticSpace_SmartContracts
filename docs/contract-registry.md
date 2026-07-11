![header](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=200&section=header&text=ContractRegistry&fontSize=36&fontAlignY=35&animation=twinkling)

![visitors](https://visitor-badge.laobi.icu/badge?page_id=RapportTecnologia.AgenticSpace.smartcontracts_contract-registry)
[![License: CC BY-SA 4.0](https://img.shields.io/badge/License-CC_BY--SA_4.0-blue.svg)](https://creativecommons.org/licenses/by-sa/4.0/)
![Language: Portuguese](https://img.shields.io/badge/Language-Portuguese-brightgreen.svg)
![Status](https://img.shields.io/badge/Status-Ongoing-yellow)
[![GitHub Issues](https://img.shields.io/github/issues/RapportTecnologia/AgenticSpace)](https://github.com/RapportTecnologia/AgenticSpace/issues)

# ContractRegistry

## Propósito

Registry central para descoberta dinâmica de endereços de contratos. Elimina a necessidade de hardcode de endereços no backend e frontend.

## Funções

### register(string name, uint256 version, address contractAddress)
- **Auth:** `REGISTRAR_ROLE`
- Registra um novo contrato ou atualiza para uma versão superior
- Emite `ContractRegistered` (novo) ou `ContractUpdated` (atualização)

### getAddress(string name) → address
- **Auth:** Pública
- Retorna o endereço atual do contrato pelo nome

### getAddressByVersion(string name, uint256 version) → address
- **Auth:** Pública
- Retorna o endereço de uma versão específica

### getVersions(string name) → (uint256[], address[])
- **Auth:** Pública
- Retorna todas as versões registradas

### isRegistered(string name) → bool
- **Auth:** Pública
- Verifica se um contrato está registrado

## Eventos

- `ContractRegistered(name, version, contractAddress)`
- `ContractUpdated(name, oldVersion, newVersion, oldAddress, newAddress)`

## Roles

- `DEFAULT_ADMIN_ROLE`: admin global, pode pausar e autorizar upgrades
- `REGISTRAR_ROLE`: pode registrar e atualizar contratos

## Uso

```solidity
// Registrar contrato (requer REGISTRAR_ROLE)
ContractRegistry.register("AgentRegistry", 1, address(0x...));

// Consultar endereço atual
address addr = ContractRegistry.getAddress("AgentRegistry");

// Consultar versão específica
address v1 = ContractRegistry.getAddressByVersion("AgentRegistry", 1);

// Listar todas as versões
(uint256[] memory versions, address[] memory addrs) = ContractRegistry.getVersions("AgentRegistry");
```

## Segurança

- Pausable: pode ser pausado em emergência
- UUPS: upgradeável com autorização do admin
- Validação: nome não vazio, endereço não zero, versão > 0
- Apenas `REGISTRAR_ROLE` pode registrar/atualizar
- `DEFAULT_ADMIN_ROLE` para pausar e autorizar upgrades

## Changelog

| Data | Versão | Descrição |
|---|---|---|
| 2025-07-11 | 0.1.0 | Documentação inicial: funções, eventos, roles, segurança |

![footer](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=100&section=footer&animation=twinkling)
