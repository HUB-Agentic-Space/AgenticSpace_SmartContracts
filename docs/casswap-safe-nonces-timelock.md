![header](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=200&section=header&text=CASSwap%20Safe%20e%20Nonces&fontSize=36&fontAlignY=35&animation=twinkling)

![visitors](https://visitor-badge.laobi.icu/badge?page_id=RapportTecnologia.AgenticSpace.smartcontracts_casswap-safe-nonces-timelock)

[![License: CC BY-SA 4.0](https://img.shields.io/badge/License-CC_BY--SA_4.0-blue.svg)](https://creativecommons.org/licenses/by-sa/4.0/)
![Language: Portuguese](https://img.shields.io/badge/Language-Portuguese-brightgreen.svg)
![Status](https://img.shields.io/badge/Status-Ongoing-yellow)
[![GitHub Issues](https://img.shields.io/github/issues/RapportTecnologia/AgenticSpace)](https://github.com/RapportTecnologia/AgenticSpace/issues)

# CASSwap — Safe, nonces, threshold e timelock

## Finalidade

Este documento explica a transformação do Safe administrativo de 1-de-1 para 2-de-3 e como nonces e thresholds protegem futuros upgrades do Diamond CASSwap.

Nenhuma chave privada é registrada neste documento. Os endereços são públicos e identificam os participantes da governança on-chain.

## Componentes

| Componente | Endereço | Função |
|---|---|---|
| Safe administrativo | `0x1743abe1A64DAB3c81e394adb4e3B56ef05F0D26` | Aprovar propostas administrativas |
| Owner 1 | `0x63cf627357A9C4C8EabA4b3d2d563dE825d71f25` | Signatário original |
| Owner 2 | `0x253174e88515beCB71444229BaC1461c26A5d5D7` | Segundo signatário |
| Owner 3 | `0x06aE104567Fe969ba57371940730111FaeD33E9a` | Terceiro signatário |
| Diamond mainnet | `0x80BD976cB588cD2F9aD9Ac671FB19174E9F3172b` | Proxy EIP-2535 do AgenticSpace |

## O que é o nonce do Safe

O nonce é um contador sequencial armazenado no Safe. Cada transação executada com sucesso consome exatamente um nonce.

Ele possui três objetivos principais:

1. Impedir que uma transação assinada seja executada novamente.
2. Fixar a ordem das operações administrativas.
3. Vincular as assinaturas a uma proposta específica do Safe.

Uma proposta criada para nonce 9 não pode ser reutilizada como nonce 10. Depois que o nonce 9 é confirmado, o Safe passa a aceitar a próxima execução com nonce 10.

O nonce não é o número da transação da conta Ethereum que paga o gas. O Safe possui seu próprio nonce interno, enquanto a EOA que transmite `execTransaction` possui outro nonce no protocolo da Polygon.

## O que é o threshold

O threshold é a quantidade mínima de aprovações de owners necessária para o Safe executar uma operação.

- **1-de-1:** existe um owner e uma assinatura é suficiente.
- **1-de-2:** existem dois owners, mas apenas um ainda pode executar.
- **2-de-3:** existem três owners e quaisquer dois precisam concordar.

O estado intermediário 1-de-2 foi mantido somente entre os nonces 9 e 10 para permitir a inclusão segura do terceiro owner. O estado final é 2-de-3.

## Nonce 9 — inclusão do owner 2

| Campo | Valor |
|---|---|
| Safe nonce | `9` |
| Destino interno | O próprio Safe |
| Função | `addOwnerWithThreshold(address,uint256)` |
| Novo owner | `0x253174e88515beCB71444229BaC1461c26A5d5D7` |
| Threshold solicitado | `1` |
| Signatário autorizado | Owner 1 |
| Transação Polygon | `0xdbc29ded52efdb34a967050088afe2196c18656bcf110abdf6e0eea0010f5d3d` |
| Bloco | `93994857` |
| Resultado | Safe passou de 1-de-1 para 1-de-2 |

O threshold permaneceu 1 porque o owner 2 ainda não fazia parte do Safe antes dessa execução. Ele só se tornou signatário válido depois da confirmação do nonce 9.

## Nonce 10 — inclusão do owner 3 e ativação do 2-de-3

| Campo | Valor |
|---|---|
| Safe nonce | `10` |
| Destino interno | O próprio Safe |
| Função | `addOwnerWithThreshold(address,uint256)` |
| Novo owner | `0x06aE104567Fe969ba57371940730111FaeD33E9a` |
| Threshold solicitado | `2` |
| Signatário e pagador de gas | Owner 1 |
| Transação Polygon | `0x3090d961bdc15bdad31c3f84f024e226e03abaf35e003892eb94274111d57ffd` |
| Bloco | `93994924` |
| Resultado | Safe passou de 1-de-2 para 2-de-3 |

A tentativa inicial de transmitir o nonce 10 pelo owner 2 não chegou à rede porque essa carteira não possuía POL para gas. O payload não foi consumido e o nonce continuou 10. O owner 1 então transmitiu a mesma operação autorizada, sem necessidade de financiar outra carteira.

## Estado final verificado

Após o nonce 10:

- Owners: 3.
- Threshold: 2.
- Próximo nonce: 11.
- Nenhum owner individual consegue executar sozinho uma nova transação do Safe.
- As chaves dos owners 2 e 3 podem formar um par válido para futuras propostas 2-de-3.

## Como serão assinadas futuras operações

Uma futura operação administrativa deve seguir este fluxo:

1. Construir destino, valor, calldata, operação, parâmetros de gas e nonce do Safe.
2. Calcular `getTransactionHash` no próprio Safe.
3. Coletar assinaturas de pelo menos dois owners.
4. Ordenar as assinaturas pelo endereço numérico crescente dos signatários, conforme validação do Safe.
5. Concatenar as assinaturas e chamar `execTransaction`.
6. Confirmar o evento `ExecutionSuccess` e o incremento do nonce.

O endereço que transmite a transação paga o gas, mas não precisa ser um dos signatários quando as assinaturas criptográficas completas já foram fornecidas.

## Relação com o timelock

O Safe e o timelock resolvem riscos diferentes:

- O Safe exige concordância entre múltiplos signatários.
- O timelock impede execução imediata, mesmo depois da concordância.

A configuração definida para o CASSwap é:

- Delay mínimo: 48 horas (`172800` segundos).
- Proposer: Safe 2-de-3.
- Canceller: Safe 2-de-3, concedido pelo construtor do `TimelockController` ao proposer.
- Executor: aberto por meio do papel atribuído a `address(0)`; qualquer conta pode executar uma operação pronta, mas não pode alterar seu conteúdo.
- Admin inicial: Safe durante a configuração.
- Owner final do Diamond: timelock.

O fluxo de upgrade será:

1. Duas assinaturas do Safe aprovam `schedule` no timelock.
2. O timelock registra operação, salt, predecessor e instante mínimo.
3. A operação aguarda pelo menos 48 horas.
4. Após o prazo, qualquer executor chama `execute` com exatamente os mesmos parâmetros.
5. O timelock chama `diamondCut` como owner do Diamond.

## Restrições operacionais

- Nunca compartilhar seed phrase ou private key.
- Manter cada owner em dispositivo ou cofre independente.
- Não armazenar duas chaves do quorum no mesmo host de produção.
- Conferir chain ID, Safe, nonce, destino, calldata e valor antes de assinar.
- Não assinar hashes apresentados sem reconstruir localmente a proposta.
- Registrar cada proposta, assinatura, agendamento e execução no checklist de segurança.

## Operação CASSwap agendada

| Campo | Valor |
|---|---|
| Timelock | `0x6e14dA17C2B9df7A5d829897F9c39b61D9E8d4B5` |
| Nova facet | `0x659c0c67c55BC933708a297276BB32D9DeA43499` |
| Operation ID | `0x19470007af95dfdfa5ee42b86f3d32bec78aaaf382d3361286bff71b9ba73f7a` |
| Transferência de ownership | `0xa799a09d5496469760baa4aa42c8201888b8c54cd679c79576172ad7d0ab3005` |
| Agendamento pelo Safe | `0x24702bfd50215ce04f08ef254650218d603bc36b5d50c7c953b6615503abe8b9` |
| Safe nonce consumido | `11` |
| Estado do Safe após agendamento | nonce `12`, threshold `2`, três owners |
| Disponível a partir de | `2026-09-20 02:30:24 UTC` |
| Execução automática | timer de usuário para `2026-09-20 02:32:00 UTC`, com nova tentativa a cada cinco minutos em caso de falha |

O Diamond reconhece o timelock como owner. A operação está pendente e ainda não está pronta. O executor automático valida o operation ID, executa a calldata previamente registrada, confere os 23 seletores e remove suas unidades locais somente depois da confirmação bem-sucedida.

## Migração de liquidez do CASSwap antigo

O CASSwap antigo (standalone `0x9399878Ce33EA9D4859ab708a111fB3f274BACF4`) não possuía a função `withdrawCAS` no bytecode real, apesar de constar no código-fonte. Ele também não era upgradeável como proxy UUPS. Para transferir o estoque de CAS para o novo swap no Diamond, foi utilizado o *ratio trick* já documentado no script `06_redistribute_cas.ts`.

### Resumo da migração

| Campo | Valor |
|---|---|
| CASSwap antigo | `0x9399878Ce33EA9D4859ab708a111fB3f274BACF4` |
| Diamond (novo swap) | `0x80BD976cB588cD2F9aD9Ac671FB19174E9F3172b` |
| Operador | `0x66682BBeD9e540017967692cCdd069fE5F833888` |
| Ratio original | `5000:3` |
| Ratio temporário | `10000000:1` |
| CAS migrado | `106457.05676799954 CAS` |
| POL residual no CASSwap antigo | `0.010645705676799954 POL` |

### Transações da migração

| Etapa | Função | Hash |
|---|---|---|
| Definir ratio extremo | `setRatio(10000000, 1)` | `0x8b524368c54b62b8ca0f43873d9afdc39e3a5131b3f9632f2a341efc9067121a` |
| Extrair CAS via ratio trick | `buyCAS(0, deadline)` | `0xec0a5650d03f28a37f55758fbe92bca7d56bb77869e0047182853003e53c3551` |
| Transferir CAS para o Diamond | `casToken.transfer(DIAMOND, amount)` | `0x664e387d3be9d9cd50a360edc15a311ef9588f9f2fff1882ebd4d2ac4bcd2ff8` |
| Restaurar ratio original | `setRatio(5000, 3)` | `0xa9c0a99106b3a60e2c43982d4af8d782d220995fe22f973fdf4bb2a8078f44dc` |
| Pausar CASSwap antigo | `pause()` | `0xdbe862d8a8227876667d07bc68e3899d5a683a0d833b535873d1115ce4af237d` |

### Estado após migração

- O CASSwap antigo está pausado com ratio `5000:3`.
- O CASSwap antigo retém apenas `0.0000000000078088 CAS` (resíduo de arredondamento) e `0.010645705676799954 POL`.
- O Diamond recebeu `106457.05676799954 CAS`.
- O novo swap ainda não está ativo no Diamond: aguarda a execução do upgrade via timelock.

## Histórico

| Data | Versão | Alteração |
|---|---|---|
| 2026-09-18 | 1.2.0 | Migração de liquidez do CASSwap antigo para o Diamond via ratio trick |
| 2026-09-17 | 1.1.0 | Registro do timelock, transferência de ownership, agendamento e automação da execução |
| 2026-09-17 | 1.0.0 | Documentação dos nonces 9 e 10 e da migração do Safe para 2-de-3 |

![footer](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=100&section=footer&animation=twinkling)
