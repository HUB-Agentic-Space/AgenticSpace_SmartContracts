---
tags:
  - smartcontracts
  - facet
  - x402
  - facilitator
  - eip-712
---

![header](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=200&section=header&text=x402%20Facilitator&fontSize=36&fontAlignY=35&animation=twinkling)

![visitors](https://visitor-badge.laobi.icu/badge?page_id=RapportTecnologia.AgenticSpace.smartcontracts_x402-facilitator)
[![License: CC BY-SA 4.0](https://img.shields.io/badge/License-CC_BY--SA_4.0-blue.svg)](https://creativecommons.org/licenses/by-sa/4.0/)
![Language: Portuguese](https://img.shields.io/badge/Language-Portuguese-brightgreen.svg)
![Status](https://img.shields.io/badge/Status-Ongoing-yellow)
[![GitHub Issues](https://img.shields.io/github/issues/RapportTecnologia/AgenticSpace)](https://github.com/RapportTecnologia/AgenticSpace/issues)

# X402FacilitatorFacet (x402)

**Caminho:** `contracts/facets/x402/X402FacilitatorFacet.sol`

Facilitador on-chain para o padrão **x402 (HTTP 402 Payment Required)**:
liquidação de pagamentos "pay-per-call" em CAS entre agentes, para cenários
de API paga por chamada (ex.: um agente cobrando de outro por cada
requisição HTTP atendida).

## Visão Geral

- Usa o namespace `X402Storage` (ver [[storage-namespaces#X402Storage]]).
- Dois caminhos de liquidação, ambos cobrando uma taxa de protocolo
  (`protocolFeeBps`) enviada ao `InfrastructureFund`.
- Chave anti-replay é `requestHash` (por `payer`), não um nonce sequencial
  — ver seção dedicada abaixo.
- Usa `SignatureLib` para construir o domain separator EIP-712
  dinamicamente a cada chamada — ver seção dedicada abaixo sobre o
  problema específico de Diamond + `immutable`.

## Os Dois Caminhos de Liquidação

### 1. `payDirect` — pagamento direto pela própria carteira

```solidity
function payDirect(address payee, bytes32 requestHash, uint256 amount, uint256 deadline) external
```

`msg.sender` é o próprio pagador; não há assinatura nem terceiro
retransmitindo em seu nome. Como é o próprio `msg.sender` que autoriza a
transferência de seus fundos (via `SafeERC20.safeTransferFrom` mais
adiante), basear a autorização em `msg.sender` é legítimo aqui — não se
trata do antipadrão "usar apenas `msg.sender` quando a operação depende
de assinatura externa" (ver `docs/security-checklist.md`, seção 4),
porque **não existe** assinatura externa neste caminho: quem chama é quem
paga.

- Reverte com `DeadlineExpired` se `block.timestamp > deadline`
- Emite `PaymentSettled(..., viaAuthorization=false)`

### 2. `settleWithAuthorization` — liquidação via EIP-712 por um relayer

```solidity
function settleWithAuthorization(
    address payer,
    address payee,
    bytes32 requestHash,
    uint256 amount,
    uint256 deadline,
    bytes calldata signature
) external
```

Permite fluxos **gasless** / pay-per-call em que o `payer` nunca envia sua
própria transação: ele assina off-chain uma autorização EIP-712, e uma
conta com `X402_RELAYER_ROLE` (o backend facilitador) submete essa
autorização on-chain em nome dele.

**Auth:** `X402_RELAYER_ROLE` (ou contract owner).

Struct assinado (`X402Authorization`):

```solidity
bytes32 private constant X402_AUTHORIZATION_TYPEHASH = keccak256(
    "X402Authorization(address payer,address payee,bytes32 requestHash,uint256 amount,uint256 deadline)"
);
```

Fluxo de verificação:

1. Recalcula `structHash = keccak256(abi.encode(TYPEHASH, payer, payee, requestHash, amount, deadline))`
2. Monta o digest EIP-712 via `SignatureLib.hashTypedData(SignatureLib.domainSeparator(...), structHash)`
3. Recupera o assinante com `SignatureLib.recover` (usa `ECDSA.recover` da OpenZeppelin)
4. Reverte com `InvalidSignature()` se o assinante recuperado != `payer` declarado

Somente depois disso a função chama `_settle(payer, payee, requestHash, amount, true)`.

## Por que o domain separator é calculado em tempo de chamada (não `immutable`)

`SignatureLib.domainSeparator` é **deliberadamente** uma função `view`
que lê `address(this)` e `block.chainid` a cada invocação, em vez de um
valor `immutable` calculado no construtor/deploy:

```solidity
function domainSeparator(string memory name, string memory version) internal view returns (bytes32) {
    return keccak256(
        abi.encode(
            EIP712_DOMAIN_TYPEHASH,
            keccak256(bytes(name)),
            keccak256(bytes(version)),
            block.chainid,
            address(this)
        )
    );
}
```

**O motivo é uma pegadinha conhecida de Diamond (EIP-2535) + EIP-712:**
variáveis `immutable` em Solidity são gravadas no **bytecode** do
contrato no momento do **deploy daquele contrato específico**. No padrão
Diamond, o código de `X402FacilitatorFacet` nunca executa "como ele
mesmo" — o Diamond faz `delegatecall` para o bytecode da facet, mas
`address(this)` dentro desse `delegatecall` resolve para o **endereço do
Diamond** (correto e esperado). Se `domainSeparator` fosse calculado
**uma única vez no deploy da facet** e cacheado como `immutable`, o valor
gravado usaria o **endereço da própria facet** (obtido durante seu
próprio `deploy()`, fora de qualquer `delegatecall`) — não o endereço do
Diamond que efetivamente recebe as chamadas dos usuários.

Consequência prática do erro, caso fosse cacheado: toda assinatura
EIP-712 gerada pelo frontend/SDK usando `verifyingContract = <endereço do
Diamond>` (o único endereço que os usuários conhecem e aprovam) **nunca
bateria** com o domain separator armazenado na facet (que apontaria para
o endereço interno da facet, nunca exposto nem usado por ninguém) — toda
assinatura seria injustamente rejeitada como inválida, ou pior, abriria
brecha para assinaturas verificadas contra o domínio errado caso a facet
fosse reaproveitada por outro proxy.

Por isso, `SignatureLib.domainSeparator` e `hashTypedData` são funções de
biblioteca `internal`/`pure`/`view` chamadas a cada `settleWithAuthorization`
e a cada `computeAuthorizationDigest`, garantindo que `address(this)`
sempre reflita o endereço do Diamond no momento real da chamada.

## `requestHash` como Chave Anti-Replay (em vez de Nonce)

```solidity
mapping(address => mapping(bytes32 => bool)) usedRequests; // payer => requestHash => settled
```

Diferente de um nonce sequencial (`nonces[payer]++`), o x402 usa
`requestHash` — um hash único por requisição HTTP off-chain (calculado
pelo backend a partir do conteúdo/contexto da chamada) — como chave de
unicidade por pagador:

- O **chamador não controla a ordenação** das requisições HTTP
  pay-per-call: múltiplas chamadas podem estar em voo simultaneamente, em
  qualquer ordem de confirmação on-chain, então um nonce sequencial
  causaria falhas espúrias de ordenação (nonce gaps) sempre que duas
  chamadas concorrentes fossem enviadas fora de ordem.
- `requestHash` é determinado pelo **conteúdo da requisição** (URL, corpo,
  timestamp, etc., hasheados off-chain), então cada requisição HTTP única
  produz uma chave única — reenviar a mesma autorização assinada duas
  vezes (replay) é bloqueado por `RequestAlreadySettled(payer, requestHash)`,
  independentemente da ordem de chegada.
- A unicidade é por `payer`, não global — dois pagadores diferentes podem
  legitimamente ter o mesmo `requestHash` (colisão improvável, mas sem
  custo de segurança adicional, já que o mapeamento é aninhado por
  `payer`).

## Roles

| Role | Constante | Uso |
|---|---|---|
| `X402_RELAYER_ROLE` | `keccak256("X402_RELAYER_ROLE")` | Único autorizado a chamar `settleWithAuthorization` e `setX402ProtocolFeeBps`; concedido ao contract owner automaticamente em `initX402` |

Ver [[access-control]] para o mecanismo `DiamondAccessControl.enforceRoleOrOwner`.

## Funções

### Admin

```solidity
function initX402(uint256 protocolFeeBps) external
```

- **Auth:** contract owner
- Chamada única (`AlreadyInitialized` no reenvio); `protocolFeeBps <= 10_000`
- Concede `X402_RELAYER_ROLE` ao owner
- Emite `X402Initialized`

```solidity
function setX402ProtocolFeeBps(uint256 bps) external // X402_RELAYER_ROLE ou owner
```

### Settlement

- `payDirect(address payee, bytes32 requestHash, uint256 amount, uint256 deadline)`
- `settleWithAuthorization(address payer, address payee, bytes32 requestHash, uint256 amount, uint256 deadline, bytes calldata signature)`

### Views

| Função | Retorno | Descrição |
|---|---|---|
| `isRequestSettled(address payer, bytes32 requestHash)` | `bool` | Se aquele par já foi liquidado |
| `getX402ProtocolFeeBps()` | `uint256` | Taxa de protocolo atual |
| `computeAuthorizationDigest(address payer, address payee, bytes32 requestHash, uint256 amount, uint256 deadline)` | `bytes32` | Digest EIP-712 a ser assinado off-chain (útil para SDKs/testes) |

## Events

- `X402Initialized(uint256 protocolFeeBps)`
- `PaymentSettled(address indexed payer, address indexed payee, bytes32 indexed requestHash, uint256 amount, uint256 fee, bool viaAuthorization)`

## Errors

`AlreadyInitialized`, `InvalidBps(uint256)`, `InvalidAmount()`,
`InvalidPayee()`, `DeadlineExpired(uint256)`,
`RequestAlreadySettled(address, bytes32)`, `InvalidSignature()`,
`CasTokenNotSet()`, `InfrastructureFundNotSet()`

## Fluxo de Taxa

`_settle` desconta `protocolFeeBps` (base 10 000) do `amount` bruto:

```solidity
uint256 fee = (amount * s.protocolFeeBps) / BPS_DENOMINATOR;
uint256 net = amount - fee;

if (net > 0) ps.casToken.safeTransferFrom(payer, payee, net);
if (fee > 0) ps.casToken.safeTransferFrom(payer, ps.infrastructureFund, fee);
```

Ambas as pernas (net ao `payee`, fee ao `InfrastructureFund`) saem
diretamente da allowance do `payer` via `SafeERC20.safeTransferFrom` — o
Diamond nunca custodia o CAS entre as duas transferências (diferente do
escrow do `AgentCommerceFacet`, que retém o valor até a liquidação). Isso
é adequado ao caso de uso pay-per-call: a liquidação é atômica e
instantânea, sem período de disputa.

## Segurança

- `whenNotPaused` em `payDirect` e `settleWithAuthorization`.
- `settleWithAuthorization` exige `X402_RELAYER_ROLE` — apenas o backend
  facilitador autorizado pode submeter autorizações assinadas.
- Verificação estrita de deadline (`DeadlineExpired`) em ambos os
  caminhos antes de qualquer efeito.
- Domain separator EIP-712 recalculado em tempo de chamada (nunca
  `immutable`) — ver seção dedicada acima.
- `requestHash` marcado como usado (`usedRequests[payer][requestHash] = true`)
  **antes** das transferências `safeTransferFrom` (Checks-Effects-Interactions).
- `ECDSA.recover` (OpenZeppelin) rejeita assinaturas malformadas ou com
  malleability (high-s) automaticamente.
- `InvalidAmount`/`InvalidPayee` bloqueiam parâmetros degenerados
  (`amount == 0`, `payee == address(0)`).
- Falha explícita (`CasTokenNotSet`/`InfrastructureFundNotSet`) se o
  Diamond ainda não tiver essas dependências configuradas via `PaymentFacet`.

## Dependências

- [[payment-facet]] — `PaymentStorage` (`casToken`, `infrastructureFund`)
- [[access-control]] — `DiamondAccessControl` (`X402_RELAYER_ROLE`)
- [[storage-namespaces]] — `X402Storage`
- `SignatureLib` — domain separator + digest EIP-712 (`contracts/libs/SignatureLib.sol`)
- OpenZeppelin `ECDSA`, `SafeERC20`/`IERC20`

## Changelog

| Data | Versão | Descrição |
|---|---|---|
| 2026-08-24 | 0.1.0 | Documentação inicial do X402FacilitatorFacet |

![footer](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=100&section=footer&animation=twinkling)
