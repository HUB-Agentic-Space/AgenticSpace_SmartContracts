---
tags:
  - smartcontracts
  - diamond
  - eip-2535
---

![header](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=200&section=header&text=Diamond%20EIP-2535%20Proxy&fontSize=36&fontAlignY=35&animation=twinkling)

![visitors](https://visitor-badge.laobi.icu/badge?page_id=RapportTecnologia.AgenticSpace.smartcontracts_diamond)
[![License: CC BY-SA 4.0](https://img.shields.io/badge/License-CC_BY--SA_4.0-blue.svg)](https://creativecommons.org/licenses/by-sa/4.0/)
![Language: Portuguese](https://img.shields.io/badge/Language-Portuguese-brightgreen.svg)
![Status](https://img.shields.io/badge/Status-Ongoing-yellow)
[![GitHub Issues](https://img.shields.io/github/issues/RapportTecnologia/AgenticSpace)](https://github.com/RapportTecnologia/AgenticSpace/issues)

# Diamond — EIP-2535 Proxy

O Diamond é o proxy central do Agentic Space. Um único endereço delega chamadas para múltiplas facets via `delegatecall`.

## Diamond.sol

**Caminho:** `contracts/diamond/Diamond.sol`

Proxy EIP-2535 que recebe todas as chamadas e as delega para a facet correspondente via `fallback()`.

### Constructor

```solidity
constructor(address _contractOwner, IDiamondCut.FacetCut[] memory _diamondCut)
```

- Define o `_contractOwner` no `LibDiamond` storage
- Executa o `_diamondCut` inicial (geralmente `DiamondCutFacet`)
- Emite `DiamondCut` event

### Fallback

```solidity
fallback() external payable
```

- Consulta `LibDiamond.diamondStorage().facetAddressAndSelectorPosition[selector]`
- Se encontrada, executa `delegatecall` para a facet
- Se não encontrada, reverte com `FunctionNotFound(selector)`

### Receive

```solidity
receive() external payable
```

Aceita depósitos de POL nativo diretamente no Diamond.

## DiamondInit.sol

**Caminho:** `contracts/diamond/DiamondInit.sol`

Contrato de inicialização executado via `delegatecall` durante o `diamondCut` final.

### `init()`

```solidity
function init() external
```

- Concede `DEFAULT_ADMIN_ROLE` e `OWNER_ROLE` ao `contractOwner`
- Registra `IDiamondLoupe` e `IERC165` no suporte de interfaces

> [!warning] One-time call
> `DiamondInit.init()` deve ser chamada apenas uma vez, durante o `diamondCut` que anexa as facets restantes. O deploy script garante isso.

## LibDiamond.sol

**Caminho:** `contracts/diamond/libraries/LibDiamond.sol`

Biblioteca central que gerencia storage, ownership, pause e operações de `diamondCut`.

### DiamondStorage

```solidity
struct DiamondStorage {
    mapping(bytes4 => FacetAddressAndPosition) selectorToFacet;
    mapping(address => FacetFunctionSelectors) facetFunctionSelectors;
    address contractOwner;
    bool paused;
    bytes32 pausedBy;
}
```

Slot: `keccak256("agentic.space.diamond.storage")`

### Funções Principais

| Função | Descrição |
|---|---|
| `diamondStorage()` | Retorna o storage do Diamond em slot fixo |
| `setContractOwner(address)` | Define o owner do Diamond |
| `isContractOwner(address)` | Verifica se é o owner |
| `enforceIsContractOwner()` | Reverte se não for owner |
| `setPaused(bool)` | Define estado de pause |
| `enforceNotPaused()` | Reverte se pausado |
| `diamondCut(FacetCut[], address, bytes)` | Adiciona, substitui ou remove facets |
| `addFunctions(address, bytes4[])` | Adiciona seletores a uma facet |
| `replaceFunctions(address, bytes4[])` | Substitui seletores de uma facet |
| `removeFunctions(address, bytes4[])` | Remove seletores de uma facet |

### Events

- `DiamondCut(FacetCut[], address, bytes)` — emitido em toda operação de cut
- `OwnershipTransferred(address, address)` — emitido em transferência de ownership

### Segurança

- `enforceIsContractOwner()` é chamada antes de qualquer `diamondCut`
- `addFunctions` verifica que a facet tem código (`extcodesize > 0`)
- `replaceFunctions` verifica que o seletor já existe
- `removeFunctions` verifica que a facet é a mesma do seletor
- `init` com `address(0)` e `bytes("")` é permitido (sem inicialização)

## DiamondCutFacet.sol

**Caminho:** `contracts/diamond/facets/DiamondCutFacet.sol`

Expõe `diamondCut()` como função external. Apenas o contract owner pode chamar.

```solidity
function diamondCut(
    IDiamondCut.FacetCut[] memory _diamondCut,
    address _init,
    bytes memory _calldata
) external
```

## DiamondLoupeFacet.sol

**Caminho:** `contracts/diamond/facets/DiamondLoupeFacet.sol`

Inspeção do Diamond (EIP-2535 Loupe).

| Função | Descrição |
|---|---|
| `facets()` | Retorna todas as facets e seus seletores |
| `facetFunctionSelectors(address)` | Retorna seletores de uma facet |
| `facetAddress(bytes4)` | Retorna o endereço da facet para um seletor |
| `facetAddresses()` | Retorna todos os endereços de facets |

## OwnershipFacet.sol

**Caminho:** `contracts/diamond/facets/OwnershipFacet.sol`

| Função | Descrição |
|---|---|
| `transferOwnership(address)` | Transfere ownership (apenas owner atual) |
| `owner()` | Retorna o endereço do owner atual |

## PausableFacet.sol

**Caminho:** `contracts/facets/PausableFacet.sol`

| Função | Descrição |
|---|---|
| `pause()` | Pausa o Diamond (requer `PAUSER_ROLE`) |
| `unpause()` | Despausa o Diamond (requer `PAUSER_ROLE`) |
| `paused()` | Retorna o estado de pause |

> [!info] Pausa Global
> Quando pausado, todas as facets de domínio que chamam `LibDiamond.enforceNotPaused()` revertem. As facets de infraestrutura (DiamondCut, Loupe, Ownership) não verificam pause.

## Changelog

| Data | Versão | Descrição |
|---|---|---|
| 2025-07-12 | 0.2.0 | Documentação inicial do Diamond, LibDiamond e facets de infraestrutura |

![footer](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=100&section=footer&animation=twinkling)
