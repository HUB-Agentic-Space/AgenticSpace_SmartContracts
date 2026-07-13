---
tags:
  - smartcontracts
  - access-control
  - security
---

![header](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=200&section=header&text=Access%20Control&fontSize=36&fontAlignY=35&animation=twinkling)

![visitors](https://visitor-badge.laobi.icu/badge?page_id=RapportTecnologia.AgenticSpace.smartcontracts_access-control)
[![License: CC BY-SA 4.0](https://img.shields.io/badge/License-CC_BY--SA_4.0-blue.svg)](https://creativecommons.org/licenses/by-sa/4.0/)
![Language: Portuguese](https://img.shields.io/badge/Language-Portuguese-brightgreen.svg)
![Status](https://img.shields.io/badge/Status-Ongoing-yellow)
[![GitHub Issues](https://img.shields.io/github/issues/RapportTecnologia/AgenticSpace)](https://github.com/RapportTecnologia/AgenticSpace/issues)

# Access Control — DiamondAccessControl

O controle de acesso do Diamond é implementado via Diamond Storage, sem depender do `AccessControl` da OpenZeppelin. Isso permite que as roles sejam compartilhadas entre todas as facets do Diamond.

## DiamondAccessControl.sol

**Caminho:** `contracts/diamond/access/DiamondAccessControl.sol`

Biblioteca que implementa RBAC (Role-Based Access Control) via Diamond Storage.

### Storage

```solidity
struct RoleStorage {
    mapping(bytes32 => mapping(address => bool)) roles;
    mapping(bytes32 => RoleData) roleData;
}
```

Slot: `keccak256("agentic.space.diamond.access.storage")`

### Roles

| Role | Hash | Descrição |
|---|---|---|
| `DEFAULT_ADMIN_ROLE` | `0x00` | Admin global (geralmente o deployer) |
| `OWNER_ROLE` | `keccak256("OWNER_ROLE")` | Owner do Diamond (diamondCut, ownership) |
| `PAUSER_ROLE` | `keccak256("PAUSER_ROLE")` | Pode pausar/despausar o Diamond |
| `AGENT_ROLE` | `keccak256("AGENT_ROLE")` | Agentes registrados e ativos |
| `VALIDATOR_ROLE` | `keccak256("VALIDATOR_ROLE")` | Validadores de agentes |
| `DAO_ADMIN_ROLE` | `keccak256("DAO_ADMIN_ROLE")` | Admin das DAOs (configura quorum, etc.) |
| `CONTRACT_REGISTRY_ROLE` | `keccak256("CONTRACT_REGISTRY_ROLE")` | Pode registrar contratos no registry |
| `PAYMENT_ADMIN_ROLE` | `keccak256("PAYMENT_ADMIN_ROLE")` | Pode configurar taxas e endereços de pagamento |
| `GAS_PROMOTION_ADMIN_ROLE` | `keccak256("GAS_PROMOTION_ADMIN_ROLE")` | Pode configurar promoções de gas |
| `USER_REGISTRY_ROLE` | `keccak256("USER_REGISTRY_ROLE")` | Pode registrar/desativar usuários |

### Funções da Biblioteca

| Função | Descrição |
|---|---|
| `grantRole(bytes32, address)` | Concede role a um endereço |
| `revokeRole(bytes32, address)` | Revoga role de um endereço |
| `hasRole(bytes32, address)` | Verifica se endereço tem role |
| `enforceRole(bytes32, address)` | Reverte se endereço não tem role |
| `renounceRole(bytes32, address)` | Renuncia a role |

### Events

- `RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)`
- `RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)`

### Modifiers

As facets usam o modifier `onlyRole(bytes32 role)` que internamente chama `enforceRole(role, msg.sender)`.

## AccessControlFacet.sol

**Caminho:** `contracts/facets/AccessControlFacet.sol`

Expõe gestão de roles como funções external do Diamond.

### Funções

| Função | Descrição | Role Requerida |
|---|---|---|
| `grantRole(bytes32, address)` | Concede role | `DEFAULT_ADMIN_ROLE` |
| `revokeRole(bytes32, address)` | Revoga role | `DEFAULT_ADMIN_ROLE` |
| `renounceRole(bytes32)` | Renuncia própria role | Qualquer (apenas self) |
| `hasRole(bytes32, address)` | Consulta role | Nenhuma (view) |

> [!warning] DEFAULT_ADMIN_ROLE
> Apenas `DEFAULT_ADMIN_ROLE` pode conceder e revogar roles. O deployer recebe `DEFAULT_ADMIN_ROLE` e `OWNER_ROLE` durante `DiamondInit.init()`.

## Fluxo de Roles

1. **Deploy:** `DiamondInit.init()` concede `DEFAULT_ADMIN_ROLE` e `OWNER_ROLE` ao deployer
2. **Configuração:** Deployer concede `PAUSER_ROLE`, `DAO_ADMIN_ROLE`, `PAYMENT_ADMIN_ROLE`, etc. via `AccessControlFacet.grantRole()`
3. **Registro de Agente:** `AgentRegistryFacet.registerAgent()` concede `AGENT_ROLE` ao agente
4. **Validação:** `AgentValidatorFacet` exige `VALIDATOR_ROLE` para validar
5. **DAO:** `AgentDAOFacet` exige `AGENT_ROLE` para criar propostas e votar

## Changelog

| Data | Versão | Descrição |
|---|---|---|
| 2025-07-12 | 0.2.0 | Documentação inicial do DiamondAccessControl e AccessControlFacet |

![footer](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=100&section=footer&animation=twinkling)
