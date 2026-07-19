---
tags:
  - smartcontracts
  - token
  - cas
---

![header](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=200&section=header&text=CASToken&fontSize=36&fontAlignY=35&animation=twinkling)

![visitors](https://visitor-badge.laobi.icu/badge?page_id=RapportTecnologia.AgenticSpace.smartcontracts_cas-token)
[![License: CC BY-SA 4.0](https://img.shields.io/badge/License-CC_BY--SA_4.0-blue.svg)](https://creativecommons.org/licenses/by-sa/4.0/)
![Language: Portuguese](https://img.shields.io/badge/Language-Portuguese-brightgreen.svg)
![Status](https://img.shields.io/badge/Status-Ongoing-yellow)
[![GitHub Issues](https://img.shields.io/github/issues/RapportTecnologia/AgenticSpace)](https://github.com/RapportTecnologia/AgenticSpace/issues)

# CASToken

**Caminho:** `contracts/token/CASToken.sol`

Token ERC-20 interno do Agentic Space (CAS — Cryptocoin Agentic Space). Usado para pagar taxas em operações do Diamond (registro de agentes, validação, propostas de DAO).

## Visão Geral

- **Padrão:** ERC-20 UUPS Upgradeable (OpenZeppelin 5.x)
- **Decimais:** 18
- **Símbolo:** CAS
- **Nome:** Cryptocoin Agentic Space
- **Fornecimento inicial:** 1.000.000 CAS (configurável no deploy)
- **Fornecimento máximo (MAX_SUPPLY):** 10.000.000 CAS (imutável)
- **Mintable:** Apenas `MINTER_ROLE` (respeita MAX_SUPPLY)
- **Burnable:** Qualquer holder pode queimar seus próprios tokens
- **Pausable:** `PAUSER_ROLE` pode pausar todas as transferências
- **Disclaimer on-chain:** String pública sobre investimento em infraestrutura

## Roles

| Role | Descrição |
|---|---|
| `DEFAULT_ADMIN_ROLE` | Gerencia roles e autoriza upgrades |
| `MINTER_ROLE` | Pode cunhar novos tokens (respeita MAX_SUPPLY) |
| `PAUSER_ROLE` | Pode pausar/despausar |
| `RATIO_ADMIN_ROLE` | Pode ajustar a ratio do CASSwap (CAS↔POL) |

## Funções

### initialize

```solidity
function initialize(
    address admin,
    uint256 initialSupply,
    string memory name,
    string memory symbol
) public initializer
```

Inicializa o token com admin, fornecimento inicial, nome e símbolo. Concede todas as roles ao admin e cunha `initialSupply` para ele.

### Mint

```solidity
function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) whenNotPaused
```

Cunha novos tokens. Reverte se `to == address(0)` ou `amount == 0`.

### Burn

```solidity
function burn(uint256 amount) external whenNotPaused
function burnFrom(address from, uint256 amount) external whenNotPaused
```

Queima tokens do próprio saldo ou de um endereço com allowance.

### Pausable

```solidity
function pause() external onlyRole(PAUSER_ROLE)
function unpause() external onlyRole(PAUSER_ROLE)
```

Quando pausado, todas as transferências (`_update`) revertem com `EnforcedPause()`.

### MAX_SUPPLY

```solidity
uint256 public constant MAX_SUPPLY = 10_000_000 * 1e18;
```

O fornecimento máximo é imutável e fixado em 10 milhões de CAS. O `mint` reverte com `MaxSupplyExceeded` se `totalSupply + amount > MAX_SUPPLY`. O `initialize` reverte com `MaxSupplyExceeded` se `initialSupply > MAX_SUPPLY`.

### Disclaimer

```solidity
function disclaimer() public pure returns (string memory)
```

Retorna um disclaimer on-chain informando que o CAS representa investimento na infraestrutura do Agentic Space, com pareamento inicial 1:1 com POL sujeito a ajustes.

### Consultas

```solidity
function decimals() public pure override returns (uint8) // retorna 18
function isMinter(address account) external view returns (bool)
function MAX_SUPPLY() public view returns (uint256) // 10.000.000 CAS
```

### Upgrade

```solidity
function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE)
```

Apenas `DEFAULT_ADMIN_ROLE` pode autorizar upgrades UUPS.

## Events

- `Minted(address indexed to, uint256 amount)`
- `Burned(address indexed from, uint256 amount)`
- `MaxSupplyAnnounced(uint256 maxSupply, string disclaimer)` — emitido no `initialize`

## Custom Errors

- `MintToZeroAddress()`
- `BurnFromZeroAddress()`
- `BurnExceedsBalance(uint256 balance, uint256 amount)`
- `ZeroAmount()`
- `MaxSupplyExceeded(uint256 currentSupply, uint256 requested, uint256 maxSupply)`

## Integração com Diamond

O CASToken é registrado no Diamond via `ContractRegistryFacet.register("CASToken", 1, address)`. O `PaymentFacet` vincula o endereço via `setCasToken()`. As facets de domínio usam `PaymentLib.processFeePayment()` que executa `CASToken.transferFrom(payer, InfrastructureFund, amount)`.

> [!warning] Aprovação prévia
> Usuários devem aprovar o Diamond (não o CASToken diretamente) para gastar CAS: `CASToken.approve(diamondAddress, fee)`.

## Deploy

```bash
npx hardhat run scripts/deploy/01_deploy_tokens.ts --network polygonAmoy
```

O script inicializa com 1.000.000 CAS e define o deployer como admin, minter e pauser.

## Dependências

- OpenZeppelin 5.x: `ERC20Upgradeable`, `PausableUpgradeable`, `AccessControlEnumerableUpgradeable`, `UUPSUpgradeable`

## Segurança

- UUPS com `_authorizeUpgrade` restrito a `DEFAULT_ADMIN_ROLE`
- Pausable em todas as transferências via override de `_update`
- Validação de input em mint e burn
- Custom errors para economizar gas

## Changelog

| Data | Versão | Descrição |
|---|---|---|
| 2025-07-12 | 0.3.0 | MAX_SUPPLY 10M, RATIO_ADMIN_ROLE, disclaimer on-chain |
| 2025-07-12 | 0.2.0 | Documentação inicial do CASToken como contrato standalone UUPS |

![footer](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=100&section=footer&animation=twinkling)
