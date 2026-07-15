# Security Audit Report — smartcontracts

> **Data:** 2026-07-14
> **Responsável:** Cascade (AI Assistant)
> **Escopo:** Todos os contratos Solidity em `smartcontracts/contracts/`
> **Referência:** `.devin/rules/solidity-security.md` — Checklist de 26 seções
> **Ferramentas:** Revisão manual de código-fonte

---

## Contratos revisados

| Categoria | Contratos |
|-----------|-----------|
| Diamond Core | `Diamond.sol`, `DiamondInit.sol`, `LibDiamond.sol`, `DiamondAccessControl.sol` |
| Diamond Facets | `DiamondCutFacet.sol`, `DiamondLoupeFacet.sol`, `OwnershipFacet.sol` |
| Domain Facets | `AccessControlFacet.sol`, `AgentRegistryFacet.sol`, `AgentDAOFacet.sol`, `AgentValidatorFacet.sol`, `ContractRegistryFacet.sol`, `GasPromotionFacet.sol`, `PaymentFacet.sol`, `PausableFacet.sol`, `RoadMapDAOFacet.sol`, `UserRegistryFacet.sol` |
| Diamond Storage | `AgentStorage.sol`, `UserStorage.sol`, `VCStorage.sol`, `PaymentStorage.sol`, `DAOStorage.sol`, `GasPromotionStorage.sol`, `ProjectStorage.sol` |
| Token | `CASToken.sol`, `CASSwap.sol`, `CASMigration.sol`, `CASBatchTransfer.sol`, `InfrastructureFund.sol`, `FundTrackerToken.sol`, `LiquidityLock.sol` |
| Libraries | `AgentHashLib.sol`, `MerkleLib.sol`, `PaymentLib.sol`, `VotingLib.sol` |
| Faucet | `Faucet.sol`, `IFaucet.sol` |
| Interfaces | `ICASSwap.sol`, `ICASToken.sol`, `IInfrastructureFund.sol` |
| Mocks | `MockERC20.sol` |

---

## Sumário executivo

| Severidade | Quantidade |
|------------|-----------|
| **CRÍTICO** | 2 |
| **ALTO** | 9 |
| **MÉDIO** | 8 |
| **INFO** | 5 |

---

## Achados CRÍTICOS

### C-1. Funções `init()` sem controle de acesso

**Severidade:** CRÍTICO
**Arquivos:** `AgentDAOFacet.sol:72`, `AgentValidatorFacet.sol:55`, `GasPromotionFacet.sol:72`, `RoadMapDAOFacet.sol:65`, `PaymentFacet.sol:55`, `DiamondInit.sol:16`

**Descrição:**
As funções `initAgentDAO()`, `initValidator()`, `initGasPromotion()`, `initRoadMapDAO()`, `initPayment()` e `DiamondInit.init()` são `external` sem qualquer modificador de acesso. Uma vez que as facets são registradas no Diamond via `diamondCut`, os seletores dessas funções ficam acessíveis a qualquer chamador através do proxy Diamond. Isso permite que um atacante:

- Reset todos os parâmetros da DAO (quorum, voting duration, timelock, max proposals, cooldown)
- Redefina as taxas de pagamento para valores arbitrários (`initPayment()` chama `PaymentLib.defaultFees()`)
- Ative/desative tipos de carteira suportados
- Redefina o estado do gas promotion

**Impacto:**
Um atacante pode chamar `initAgentDAO()` a qualquer momento para resetar `quorumBps` para 500 (5%), `votingDuration` para 5 days, etc., invalidando configurações definidas pelo admin. Pode chamar `initPayment()` para resetar taxas. Isso compromete totalmente a governança e a configuração financeira do sistema.

**Recomendação:**
Adicionar `DiamondAccessControl.enforceIsContractOwner()` ou `LibDiamond.enforceIsContractOwner()` em todas as funções `init*()`. Alternativamente, usar um padrão de inicialização que só permite execução uma vez (com flag `bool initialized`).

```solidity
function initAgentDAO() external {
    LibDiamond.enforceIsContractOwner();
    // ... restante
}
```

---

### C-2. `PaymentLib.processFeePayment` usa `transferFrom` sem `SafeERC20`

**Severidade:** CRÍTICO
**Arquivo:** `PaymentLib.sol:59`

**Descrição:**
A linha 59 usa `ps.casToken.transferFrom(payer, ps.infrastructureFund, amount)` diretamente, sem usar `SafeERC20`. Se o token CAS for um token não-padrão (que não retorna `bool`), esta chamada pode falhar silenciosamente ou reverter. O contrato `PaymentFacet` importa `SafeERC20` e usa `using SafeERC20 for IERC20`, mas `PaymentLib` não.

**Impacto:**
Se o token CAS não seguir estritamente o ERC-20 (alguns tokens não retornam `bool` em `transferFrom`), a chamada pode falhar, bloqueando todos os pagamentos de registro de agentes e usuários. O `bool success` é verificado, mas tokens que não retornam nada farão o decode falhar.

**Recomendação:**
Importar e usar `SafeERC20` em `PaymentLib`:

```solidity
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
// ...
using SafeERC20 for IERC20;
// ...
ps.casToken.safeTransferFrom(payer, ps.infrastructureFund, amount);
```

---

## Achados ALTO

### A-1. `PaymentFacet.setWethToken` e `setCasSwap` sem validação de endereço zero

**Severidade:** ALTO
**Arquivo:** `PaymentFacet.sol:84-88, 90-93`

**Descrição:**
`setWethToken(address token)` e `setCasSwap(address swap)` não validam se o endereço é zero. Definir `wethToken` ou `casSwap` para `address(0)` faria com que chamadas subsequentes em `PaymentLib` falhassem com erros confusos ou comportamento inesperado.

**Recomendação:**
Adicionar `if (token == address(0)) revert ZeroAddress();` em ambas as funções.

---

### A-2. `PaymentFacet.updateFees` sem validação de valores

**Severidade:** ALTO
**Arquivo:** `PaymentFacet.sol:78-82`

**Descrição:**
`updateFees(FeeConfig memory newFees)` aceita qualquer valor para as taxas, sem verificar limites máximos. Um admin comprometido poderia definir `registrationFee` para `type(uint256).max`, bloqueando efetivamente todos os registros.

**Recomendação:**
Definir limites máximos para cada taxa e validar antes de aceitar.

---

### A-3. `PaymentFacet.batchTransfer` e `distribute` sem `ReentrancyGuard`

**Severidade:** ALTO
**Arquivo:** `PaymentFacet.sol:108-134, 142-175`

**Descrição:**
As funções `batchTransfer` e `distribute` fazem múltiplas chamadas `safeTransferFrom` / `safeTransfer` em loop sem `ReentrancyGuard`. Se o token CAS tiver hooks (ERC-777, ou tokens com callbacks), um destinatário malicioso poderia reentrar na função.

**Recomendação:**
Adicionar `nonReentrant` (importando `ReentrancyGuard` ou usando o padrão transient).

---

### A-4. `Faucet.requestTokens` sem `ReentrancyGuard`

**Severidade:** ALTO
**Arquivo:** `Faucet.sol:150-168`

**Descrição:**
Embora siga o padrão CEI (atualiza `nextTry` antes da transferência), a função não tem `ReentrancyGuard`. A transferência de POL via `call{value: amount}` dá controle ao destinatário, que poderia reentrar. O check de cooldown protege contra reentrância simples, mas não é uma defesa completa.

**Recomendação:**
Adicionar `ReentrancyGuard` ao contrato `Faucet`.

---

### A-5. `Faucet` sem mecanismo de pausa

**Severidade:** ALTO
**Arquivo:** `Faucet.sol`

**Descrição:**
O `Faucet` não tem função `pause()`. Em caso de ataque ou bug, não há como parar distribuições sem `withdrawFunds` (que só o owner pode chamar). O `withdrawFunds` esvazia o contrato mas não impede novas tentativas.

**Recomendação:**
Adicionar um flag `bool paused` e modifier `whenNotPaused` em `requestTokens()`.

---

### A-6. `CASMigration.batchMigrate` sem limite de array

**Severidade:** ALTO
**Arquivo:** `CASMigration.sol:70-92`

**Descrição:**
`batchMigrate(address[] calldata users, uint256[] calldata amounts)` não tem limite no tamanho do array. Um array muito grande pode exceder o limite de gás do bloco, tornando a função inexecutável. Além disso, cada iteração faz duas chamadas externas (`safeTransferFrom` + `safeTransfer`), consumindo muito gás.

**Recomendação:**
Adicionar `require(users.length <= MAX_BATCH, "too many users")` com um limite razoável (ex: 100).

---

### A-7. `CASSwap` sem proteção contra slippage e deadline

**Severidade:** ALTO
**Arquivo:** `CASSwap.sol:127-143, 154-172`

**Descrição:**
`buyCAS()` e `sellCAS(uint256 casAmount)` não aceitam parâmetros de slippage (minimum output) ou deadline. Um usuário pode receber menos tokens do que espera se o ratio for alterado na mesma transação (via sandwich attack do admin).

**Recomendação:**
Adicionar parâmetros `uint256 minCasOut` em `buyCAS` e `uint256 minPolOut` em `sellCAS`, além de `uint256 deadline`.

---

### A-8. Pragma `^0.8.28` não fixado

**Severidade:** ALTO
**Arquivo:** Todos os contratos

**Descrição:**
Todos os contratos usam `pragma solidity ^0.8.28`, permitindo compilação com qualquer versão 0.8.x futura. O `hardhat.config.ts` fixa `0.8.28`, mas o pragma aberto significa que uma compilação manual ou em outro contexto poderia usar versão diferente.

**Recomendação:**
Mudar para `pragma solidity 0.8.28;` (sem `^`) em todos os contratos.

---

### A-9. Sem multisig ou timelock para upgrades do Diamond

**Severidade:** ALTO
**Arquivo:** `DiamondCutFacet.sol:13-20`

**Descrição:**
`diamondCut()` só exige `enforceIsContractOwner()`. Não há timelock nem multisig. O owner pode instantaneamente adicionar, remover ou substituir facets, efetivamente mudando toda a lógica do contrato. O mesmo vale para upgrades UUPS em `CASToken`, `CASSwap` e `InfrastructureFund`.

**Recomendação:**
Implementar timelock para diamond cuts e upgrades UUPS. Usar multisig como owner.

---

## Achados MÉDIO

### M-1. `AgentRegistryFacet` armazena `name`, `description`, `publicId` em texto aberto

**Severidade:** MÉDIO
**Arquivo:** `AgentRegistryFacet.sol:159-173`, `AgentStorage.sol:26-40`

**Descrição:**
O struct `Agent` armazena `publicId`, `auid`, `name`, `description` e `parentPublicId` como strings on-chain. Estes dados são públicos e permanentes. O evento `AgentRegistered` também emite esses campos. Embora não sejam dados pessoais diretos (nome de agente ≠ nome de pessoa), podem conter informação sensível dependendo do uso.

**Recomendação:**
Considerar armazenar apenas hashes desses campos on-chain, mantendo o conteúdo off-chain. Ou documentar claramente que esses campos são públicos por design.

---

### M-2. `DiamondAccessControl.enforceRole` permite bypass pelo owner

**Severidade:** MÉDIO
**Arquivo:** `DiamondAccessControl.sol:60-66`

**Descrição:**
`enforceRole(bytes32 role)` verifica se o caller tem o role, mas se não tiver, verifica se é o `contractOwner()`. Isso significa que o owner pode executar qualquer função protegida por qualquer role, bypassando a separação de papéis.

**Recomendação:**
Para funções críticas, usar `enforceRole` sem o fallback de owner, ou documentar explicitamente que o owner é super-admin.

---

### M-3. `DiamondAccessControl.revokeRole` não remove dos arrays `roleMembers` e `memberRoles`

**Severidade:** MÉDIO
**Arquivo:** `DiamondAccessControl.sol:100-106`

**Descrição:**
`revokeRole` define `roles[role][account] = false` mas não remove o endereço de `roleMembers[role]` nem remove o role de `memberRoles[account]`. Isso faz com que `getRoleMembers()` e `getMemberRoles()` retornem dados inconsistentes — incluindo contas que não têm mais o role.

**Recomendação:**
Implementar remoção correta dos arrays (swap-and-pop) ou usar `AccessControlEnumerable` da OpenZeppelin que já trata isso.

---

### M-4. `AgentDAOFacet.castAgentVote` — delegação não verifica elegibilidade do delegador

**Severidade:** MÉDIO
**Arquivo:** `AgentDAOFacet.sol:213-217`

**Descrição:**
Quando um usuário delegou seu voto, `castAgentVote` verifica a elegibilidade do delegatee (linha 219), mas o voto é registrado em nome do delegatee. No entanto, o `msg.sender` (delegador) também é marcado como `hasVoted` (linha 230). Se o delegador for comprometido, ele não pode votar diretamente, mas o delegatee pode não saber que foi delegado. Não há verificação de que o delegador também é um agente elegível.

**Recomendação:**
Verificar elegibilidade tanto do delegador quanto do delegatee.

---

### M-5. `UserRegistryFacet` — pagamento POL envia diretamente para `infrastructureFund` via `call`

**Severidade:** MÉDIO
**Arquivo:** `UserRegistryFacet.sol:117`

**Descrição:**
O pagamento POL usa `ps.infrastructureFund.call{value: requiredPol}("")` sem verificar se o `infrastructureFund` é um contrato que poderia reentrar. Embora o estado do usuário já esteja gravado (CEI), a falta de `ReentrancyGuard` é uma preocupação.

**Recomendação:**
Adicionar `nonReentrant` à função `registerUser` ou usar `ReentrancyGuard`.

---

### M-6. `PaymentLib.processUserRegistrationPaymentWeth` usa low-level `call` para `transferFrom`

**Severidade:** MÉDIO
**Arquivo:** `PaymentLib.sol:122-125`

**Descrição:**
A função usa `ps.wethToken.call(abi.encodeWithSignature("transferFrom(...)..."))` em vez de `SafeERC20.safeTransferFrom`. Não verifica o retorno corretamente — apenas verifica `success` mas não decodifica o `bool` de retorno.

**Recomendação:**
Usar `SafeERC20.safeTransferFrom` ou verificar o retorno decodificado.

---

### M-7. Sem testes para facets críticas

**Severidade:** MÉDIO
**Arquivo:** Diretório `test/`

**Descrição:**
Não há testes para `AgentRegistryFacet`, `AgentDAOFacet`, `AgentValidatorFacet`, `ContractRegistryFacet`, `GasPromotionFacet`, `RoadMapDAOFacet`, `AccessControlFacet`, `PausableFacet`, `DiamondAccessControl`. Apenas token contracts e Diamond core têm testes.

**Recomendação:**
Escrever testes unitários e de integração para todas as facets, cobrindo caminhos felizes, erros, access control e edge cases.

---

### M-8. `DiamondInit.init()` concede todos os roles ao owner

**Severidade:** MÉDIO
**Arquivo:** `DiamondInit.sol:16-31`

**Descrição:**
`init()` concede `PAUSER_ROLE`, `VALIDATOR_ROLE`, `REGISTRAR_ROLE`, `DAO_PROPOSER_ROLE`, `DAO_VOTER_ROLE`, `DAO_EXECUTOR_ROLE`, `DAO_CANCELLER_ROLE` todos ao owner. Isso viola o princípio do menor privilégio.

**Recomendação:**
Conceder apenas roles administrativos mínimos ao owner e atribuir roles operacionais a carteiras separadas (idealmente multisig).

---

## Achados INFO

### I-1. Sem fuzzing ou testes de invariantes

**Descrição:**
O `package.json` tem script `audit:echidna` mas não há config nem testes Echidna. Não há testes Foundry `.t.sol`. Não há testes de invariantes.

### I-2. Sem evidência de execução de Slither/Mythril

**Descrição:**
Scripts existem mas não há evidência de execução recente ou relatórios.

### I-3. `MockERC20` com mint público

**Descrição:**
`MockERC20.sol:22-24` tem `mint` sem controle de acesso. Marcado como "DO NOT use in production" — garantir que não seja deployado em mainnet.

### I-4. `ProjectStorage` armazena `did` em texto aberto

**Descrição:**
`ProjectStorage.Project` tem campo `string did` (não hash). Se usado, exporia o DID do projeto publicamente.

### I-5. `FundTrackerToken` — `renounceOwnership` desabilitado corretamente

**Descrição:**
Boa prática: `renounceOwnership()` reverte. Impede que o tracker fique sem owner, o que faria `balanceOf(address(0))` retornar o total supply.

---

## Resumo por seção do checklist

| Seção | Status | Achados |
|-------|--------|---------|
| 1. Modelo de ameaça | Parcial | Sem multisig, sem timelock |
| 2. Compilador/dependências | Parcial | Pragma não fixado (A-8) |
| 3. Controle de acesso | Falha | Init sem auth (C-1), owner bypass (M-2) |
| 4. Autenticação/assinaturas | N/A | Sem assinaturas on-chain |
| 5. Cadastro de usuários | OK | CEI aplicado, hashes usados |
| 6. Privacidade | Parcial | name/description em texto aberto (M-1) |
| 7. DIDs | OK | Apenas hashes armazenados |
| 8. VCs | Parcial | Sem validação de expiração, sem challenge/domain |
| 9. Reentrância | Falha | PaymentFacet e Faucet sem guard (A-3, A-4, M-5) |
| 10. Chamadas externas | Parcial | PaymentLib sem SafeERC20 (C-2, M-6) |
| 11. Ether/pagamentos | Parcial | receive() sem restrição em vários contratos |
| 12. ERC-20 | Parcial | SafeERC20 não usado em PaymentLib (C-2) |
| 13. Wrapped coin | N/A | Não aplicável |
| 14. Oráculos | Parcial | Ratio admin-controlado sem circuit breaker |
| 15. MEV/front-running | Falha | Swap sem slippage/deadline (A-7) |
| 16. DoS/gás | Parcial | batchMigrate sem limite (A-6) |
| 17. Aritmética | OK | Solidity 0.8+, sem unchecked |
| 18. Eventos | OK | Eventos emitidos em todas as mutações |
| 19. Upgradeable | Parcial | Init sem proteção (C-1), sem timelock (A-9) |
| 20. delegatecall | OK | Diamond pattern, sem delegatecall user-controlado |
| 21. Pausa | Parcial | Faucet sem pausa (A-5), sem separação pause/unpause |
| 22. Testes | Falha | Cobertura insuficiente (M-7) |
| 23. Fuzzing | Falha | Não implementado (I-1) |
| 24. Análise estática | Pendente | Scripts existem mas sem evidência (I-2) |
| 25. dApp security | Pendente | Fora do escopo da revisão de contratos |
| 26. Deploy final | Pendente | Requer verificação pré-deploy |

---

## Prioridade de correção

1. **C-1:** Adicionar controle de acesso às funções `init*()` — bloqueio imediato
2. **C-2:** Usar SafeERC20 em PaymentLib — correção simples
3. **A-3, A-4:** Adicionar ReentrancyGuard em PaymentFacet e Faucet
4. **A-7:** Adicionar slippage e deadline em CASSwap
5. **A-6:** Limitar array em CASMigration.batchMigrate
6. **A-1, A-2:** Validar endereços e taxas em PaymentFacet
7. **A-5:** Adicionar pausa ao Faucet
8. **A-8:** Fixar pragma de versão
9. **A-9:** Implementar timelock para upgrades
10. **M-1 a M-8:** Correções de médio impacto

---

## Conclusão

O projeto demonstra boas práticas gerais: uso extensivo de OpenZeppelin, padrão CEI em funções críticas, eventos em todas as mutações de estado, custom errors para eficiência, separação de storage via Diamond Storage, e uso de SafeERC20 na maioria dos contratos.

No entanto, **2 achados críticos** exigem correção imediata antes de qualquer deploy em mainnet: funções `init()` sem controle de acesso (C-1) e uso de `transferFrom` sem `SafeERC20` em PaymentLib (C-2). Os 9 achados de severidade alta devem ser corrigidos antes do deploy em produção.

**Recomendação final:** Não deployar em mainnet até que C-1, C-2 e todos os achados ALTO sejam corrigidos. Realizar auditoria externa após correções.

---

## Status de Correções (2026-07-14)

| ID | Severidade | Descrição | Status |
|----|-----------|-----------|--------|
| C-1 | CRÍTICO | Controle de acesso em `init*()` | ✅ Corrigido — `LibDiamond.enforceIsContractOwner()` adicionado em todas as `init*()` |
| C-2 | CRÍTICO | SafeERC20 em PaymentLib | ✅ Corrigido — `safeTransferFrom` substitui `transferFrom` e `call` |
| A-1 | ALTO | Validar endereço zero em setWethToken/setCasSwap | ✅ Corrigido — `if (addr == address(0)) revert ZeroAddress()` |
| A-2 | ALTO | Validar valores de taxas em updateFees | ✅ Corrigido — `MAX_FEE = 10000 * 1e18` limite |
| A-3 | ALTO | ReentrancyGuard em PaymentFacet | ✅ Corrigido — modifier `nonReentrant` via Diamond Storage slot |
| A-4 | ALTO | ReentrancyGuard em Faucet | ✅ Corrigido — herda `ReentrancyGuard` do OpenZeppelin |
| A-5 | ALTO | Pausa no Faucet | ✅ Corrigido — `_paused`, `pause()`, `unpause()`, `whenNotPaused` |
| A-6 | ALTO | Limitar array em batchMigrate | ✅ Corrigido — `MAX_BATCH = 100` |
| A-7 | ALTO | Slippage e deadline em CASSwap | ✅ Corrigido — `minCasOut`/`minPolOut` e `deadline` em `buyCAS`/`sellCAS` |
| A-8 | ALTO | Fixar pragma | ✅ Corrigido — `pragma solidity 0.8.28` (sem `^`) em todos os contratos |
| A-9 | ALTO | Timelock/multisig para upgrades | 📝 Documentado — ver nota abaixo |

### A-9: Recomendação de Timelock/Multisig

A atual arquitetura Diamond (EIP-2535) permite que o `contractOwner` execute `diamondCut` sem delay, o que significa que um comprometimento da chave do owner permite substituir qualquer facet instantaneamente.

**Recomendações (não implementáveis sem mudança arquitetural):**

1. **Timelock:** Envolver o `DiamondCutFacet.diamondCut()` em um contrato Timelock que impõe um atraso mínimo (ex.: 48h) entre o agendamento e a execução de upgrades. Isso permite que a comunidade audite mudanças antes da execução.

2. **Multisig:** Transferir a propriedade do Diamond para um contrato Gnosis Safe (multisig 3/5 ou 5/7) em vez de uma EOA. Isso elimina ponto único de falha.

3. **Renúncia de ownership:** Para funções puramente administrativas que não precisam de manutenção contínua, considerar renunciar ownership após a configuração inicial.

4. **Governança DAO:** Para descentralização total, transferir a governance do Diamond para um contrato de governança on-chain (ex.: OpenZeppelin Governor) com votação da comunidade.

**Implementação sugerida (fase futura):**
- Fase 1 (mainnet): Multisig Gnosis Safe como owner
- Fase 2: Timelock de 48h envolvendo diamondCut
- Fase 3: Governança DAO completa

**Prioridade:** Média — não bloqueia deploy em testnet, mas é obrigatório antes de mainnet com valor real.
