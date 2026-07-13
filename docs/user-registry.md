---
tags:
  - smartcontracts
  - facet
  - user-registry
---

![header](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=200&section=header&text=UserRegistryFacet&fontSize=36&fontAlignY=35&animation=twinkling)

![visitors](https://visitor-badge.laobi.icu/badge?page_id=RapportTecnologia.AgenticSpace.smartcontracts_user-registry)
[![License: CC BY-SA 4.0](https://img.shields.io/badge/License-CC_BY--SA_4.0-blue.svg)](https://creativecommons.org/licenses/by-sa/4.0/)
![Language: Portuguese](https://img.shields.io/badge/Language-Portuguese-brightgreen.svg)
![Status](https://img.shields.io/badge/Status-Ongoing-yellow)
[![GitHub Issues](https://img.shields.io/github/issues/RapportTecnologia/AgenticSpace)](https://github.com/RapportTecnologia/AgenticSpace/issues)

# UserRegistryFacet

**Caminho:** `contracts/facets/UserRegistryFacet.sol`

Facet responsável pelo registro de usuários (identidades humanas) no Diamond. Usuários são pré-requisito para registro de agentes.

## Visão Geral

- Armazena apenas hashes na blockchain — o DID original nunca é persistido on-chain
- `userId` é calculado como `keccak256(didHash, walletAddress)`
- Usuários podem ser desativados e reativados
- Usa `UserStorage` como namespace de Diamond Storage

## Estrutura de Dados

Ver [[storage-namespaces#UserStorage]] para detalhes completos.

## Funções

### Registro

```solidity
function registerUser(
    bytes32 didHash,
    bytes32 publicIdHash
) external whenNotPaused
```

Registra um novo usuário. Requer que o `msg.sender` não tenha usuário registrado e que o `didHash` seja único.

- Calcula `userId = AgentHashLib.computeUserId(didHash, msg.sender)`
- Reverte se `userId` já existe
- Reverte se `didHash == bytes32(0)`
- Emite `UserRegistered(userId, didHash, msg.sender, publicIdHash)`

### Desativação

```solidity
function deactivateUser() external whenNotPaused
```

Desativa o usuário do `msg.sender`. Não remove do storage — apenas marca `isActive = false`.

- Reverte se usuário não existe ou já está inativo
- Emite `UserDeactivated(userId, msg.sender)`

### Reativação

```solidity
function reactivateUser() external whenNotPaused
```

Reativa o usuário do `msg.sender`.

- Reverte se usuário não existe ou já está ativo
- Emite `UserReactivated(userId, msg.sender)`

### Consultas

| Função | Retorno | Descrição |
|---|---|---|
| `getUser(bytes32 userId)` | `(User)` | Retorna dados completos do usuário |
| `getUserByAddress(address wallet)` | `(User)` | Busca usuário por endereço |
| `isUserActive(bytes32 userId)` | `bool` | Verifica se usuário está ativo |
| `isUserRegistered(bytes32 userId)` | `bool` | Verifica se usuário existe |
| `getUserCount()` | `uint256` | Total de usuários registrados |
| `getActiveUserCount()` | `uint256` | Total de usuários ativos |

### Admin

```solidity
function adminRegisterUser(
    bytes32 didHash,
    bytes32 publicIdHash,
    address wallet
) external onlyRole(USER_REGISTRY_ROLE) whenNotPaused
```

Permite que um admin com `USER_REGISTRY_ROLE` registre um usuário em nome de outro endereço.

## Events

- `UserRegistered(bytes32 indexed userId, bytes32 indexed didHash, address indexed wallet, bytes32 publicIdHash)`
- `UserDeactivated(bytes32 indexed userId, address indexed wallet)`
- `UserReactivated(bytes32 indexed userId, address indexed wallet)`

## Segurança

- `whenNotPaused` — reverte se o Diamond estiver pausado
- Validação de `didHash != bytes32(0)`
- Prevenção de registro duplicado (userId único)
- `adminRegisterUser` exige `USER_REGISTRY_ROLE`

## Integração

- **AgentRegistryFacet:** Verifica se o usuário está registrado e ativo antes de permitir registro de agentes
- **AgentDAOFacet:** Apenas agentes de usuários ativos podem votar

## Changelog

| Data | Versão | Descrição |
|---|---|---|
| 2025-07-12 | 0.2.0 | Documentação inicial da UserRegistryFacet |

![footer](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=100&section=footer&animation=twinkling)
