---
trigger: model_decision
description: Aplicado ao criar, modificar ou revisar smart contracts em Solidity no diretório smartcontracts/. Define padrões de projeto, organização, convenções e boas práticas.
---

# Smart Contracts Development Rule

> Regras de deploy e operações on-chain: ver `deploy.md`
> Regras de segurança e auditoria: ver `solidity-security.md`
> Regras de governança DAO: ver `dao-contracts.md`

## Organização

- Contratos em `smartcontracts/contracts/` agrupados por domínio: `core/`, `dao/`, `access/`, `libs/`, `interfaces/`.
- Cada contrato em seu próprio arquivo. Nome do arquivo = nome do contrato.
- Interfaces prefixadas com `I` (ex: `IAgentRegistry.sol`).
- Libraries prefixadas com `Lib` ou sufixo `Lib` (ex: `AgentHashLib.sol`).
- Arquivos de teste em `smartcontracts/test/` espelhando a estrutura de `contracts/`.

## Padrões de Projeto (GoF + PoEAA)

- **Registry:** `ContractRegistry` como ponto central para descoberta de endereços. Nunca hardcode endereços no backend ou frontend.
- **Factory:** Usar factories para deploy de instâncias de contratos quando aplicável.
- **Strategy:** Estratégias de validação e votação intercambiáveis via interfaces.
- **Proxy (Transparent):** Contratos upgradeáveis via OpenZeppelin TransparentUpgradeableProxy.
- **Observer:** Eventos Solidity como mecanismo de notificação para off-chain.
- **Command:** Propostas de DAO como comandos executáveis após aprovação.
- **Diamond:** Em estruturas complexas com mais de 4 contratos use Diamond, certifique-se sempre se o projeto já está usando para evitar redeploy desnecessário.

## Convenções de Código

- Versão Solidity: `^0.8.24` (pragma no topo de cada arquivo).
- Usar `pragma solidity ^0.8.24;` em todos os contratos.
- Visibilidade explícita em todas as funções e variáveis de estado.
- Usar `custom errors` ao invés de `require` com strings longas (economiza gas).
- Eventos para todas as mutações de estado.
- Modifiers para access control reutilizável.
- Usar `uint256` ao invés de `uint` para clareza.
- Constantes em `UPPER_SNAKE_CASE`.
- Funções em `camelCase`.
- Eventos em `CamelCase`.
- Contratos em `PascalCase`.

## Estrutura de Contrato

```solidity
// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity ^0.8.24;

import {...} from "...";

contract ExampleContract is Initializable, AccessControlUpgradeable {
    // --- State ---
    // --- Events ---
    // --- Modifiers ---
    // --- Initializer ---
    // --- External functions ---
    // --- Internal functions ---
    // --- View functions ---
}
```

## Upgradeabilidade (Transparent Proxy)

- Contratos core devem herdar de `Initializable` (OpenZeppelin).
- Usar `initialize()` ao invés de `constructor()` para contratos upgradeáveis.
- Nunca usar `constructor` para definir estado em contratos upgradeáveis.
- Usar `__gap` em contratos herdados para reservar espaço de storage.
- Usar `@openzeppelin/contracts-upgradeable` (não a versão não-upgradeable).

## Escalabilidade

- Backend e frontend consultam `ContractRegistry` para descobrir endereços.
- Nunca hardcode endereços de contratos no código off-chain.
- Registro de contratos após deploy: ver `deploy.md` (Pós-Deploy).

## Gas Optimization

- Usar `calldata` ao invés de `memory` em parâmetros de funções external quando possível.
- Cache de storage em variáveis locais dentro de loops.
- Usar `unchecked` blocks quando overflow é impossível por design.
- Pack structs para economizar slots de storage.
- Usar `custom errors` ao invés de `require` com strings.
- Limite de 24KB por contrato (EIP-170).

## Testes

- Todo contrato deve ter testes unitários em `test/`.
- Todo fluxo crítico deve ter teste de integração em `test/integration/`.
- Usar `describe` blocks organizados por funcionalidade.
- Testar: caminho feliz, edge cases, access control, reentrância, e falhas esperadas.
- Usar `forge test` para fuzzing e invariant testing.

