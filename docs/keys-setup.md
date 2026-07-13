---
tags:
  - smartcontracts
  - deployment
  - security
---

![header](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=200&section=header&text=Chaves%20e%20Endereços&fontSize=36&fontAlignY=35&animation=twinkling)

![visitors](https://visitor-badge.laobi.icu/badge?page_id=RapportTecnologia.AgenticSpace.smartcontracts_keys-setup)
[![License: CC BY-SA 4.0](https://img.shields.io/badge/License-CC_BY--SA_4.0-blue.svg)](https://creativecommons.org/licenses/by-sa/4.0/)
![Language: Portuguese](https://img.shields.io/badge/Language-Portuguese-brightgreen.svg)
![Status](https://img.shields.io/badge/Status-Ongoing-yellow)
[![GitHub Issues](https://img.shields.io/github/issues/RapportTecnologia/AgenticSpace)](https://github.com/RapportTecnologia/AgenticSpace/issues)

# Guia de Obtenção de Chaves e Endereços

Este guia explica como obter cada uma das variáveis de ambiente necessárias
para deploy e verificação dos smart contracts do Agentic Space na rede
Polygon (mainnet e testnet Amoy).

## Sumário

- [Visão Geral](#visão-geral)
- [1. POLYGON AMOY PRIVATE KEY (Testnet)](#1-polygon-amoy-private-key-testnet)
- [2. POLYGON PRIVATE KEY (Mainnet)](#2-polygon-private-key-mainnet)
- [3. POLYGONSCAN API KEY](#3-polygonscan-api-key)
- [4. DEPLOYER ADDRESS](#4-deployer-address)
- [Checklist Final](#checklist-final)
- [Avisos de Segurança](#avisos-de-segurança)

---

## Visão Geral

O arquivo `.env` (copiado a partir de `.env.example`) contém as seguintes
variáveis que precisam ser preenchidas:

| Variável | Rede | Finalidade |
|---|---|---|
| `POLYGON_AMOY_PRIVATE_KEY` | Testnet (Amoy) | Assinar transações de deploy e testes na testnet |
| `POLYGON_PRIVATE_KEY` | Mainnet (Polygon PoS) | Assinar transações de deploy na mainnet |
| `POLYGONSCAN_API_KEY` | Ambas | Verificar contratos no Polygonscan (source code verification) |
| `DEPLOYER_ADDRESS` | Ambas | Endereço público derivado da chave privada (para conferência e rastreio) |

> **Importante:** A chave privada e o endereço do deployer estão
> diretamente relacionados — o endereço é derivado da chave privada.
> Você pode usar a **mesma carteira** para testnet e mainnet, ou carteiras
> separadas (recomendado para maior segurança).

---

## 1. POLYGON AMOY PRIVATE KEY (Testnet)

A testnet **Amoy** é a rede de testes oficial da Polygon. Você precisa de
uma chave privada com MATIC de teste (gratuito via faucet) para fazer
deploy e testar.

### Passo a Passo

#### 1.1 — Criar ou usar uma carteira (MetaMask)

1. Instale a extensão **MetaMask** em seu navegador:
   - Chrome: [metamask.io](https://metamask.io/)
2. Crie uma nova carteira ou use uma existente.
3. **Anote a frase de recuperação (seed phrase)** em local seguro e offline.
   Nunca a compartilhe nem a armazene digitalmente.

#### 1.2 — Adicionar a rede Amoy no MetaMask

1. Abra o MetaMask e clique no seletor de redes (topo).
2. Clique em **Add Network** → **Add a network manually**.
3. Preencha:

   | Campo | Valor |
   |---|---|
   | Network Name | Polygon Amoy Testnet |
   | RPC URL | `https://rpc-amoy.polygon.technology` |
   | Chain ID | `80002` |
   | Currency Symbol | `POL` |
   | Block Explorer | `https://www.oklink.com/amoy` |

4. Clique em **Save**.

#### 1.3 — Obter MATIC de teste (Faucet)

1. Acesse um faucet oficial da Polygon Amoy:
   - [https://faucet.polygon.technology/](https://faucet.polygon.technology/)
2. Selecione **Amoy** como rede.
3. Cole o endereço da sua carteira (visível no MetaMask).
4. Clique em **Submit** ou **Claim**.
5. Aguarde alguns segundos — o saldo de POL de teste aparecerá no MetaMask.

> Os tokens de teste **não têm valor real** e servem apenas para testes.

#### 1.4 — Exportar a chave privada

1. No MetaMask, clique nos **três pontos** (menu da conta) →
   **Account details**.
2. Clique em **Show private key**.
3. Digite sua senha do MetaMask.
4. **Copie a chave privada** (começa com `0x...`).

#### 1.5 — Preencher o `.env`

```bash
POLYGON_AMOY_PRIVATE_KEY=0xSUA_CHAVE_PRIVADA_AQUI
```

> **Atenção:** Nunca commite o arquivo `.env` no repositório. Ele já
> está no `.gitignore`.

---

## 2. POLYGON PRIVATE KEY (Mainnet)

A mainnet da Polygon (Polygon PoS) exige POL real para pagar gas fees.
O processo é idêntico ao da testnet, mas com tokens reais.

### Passo a Passo

#### 2.1 — Usar uma carteira separada (recomendado)

Por segurança, **recomenda-se usar uma carteira dedicada** para deploy
na mainnet, distinta da carteira pessoal de uso diário.

1. Crie uma nova carteira no MetaMask (ou use um hardware wallet como
   Ledger/Trezor conectado ao MetaMask).
2. Anote a seed phrase em local seguro.

#### 2.2 — Adicionar a rede Polygon Mainnet

O MetaMask geralmente já inclui a Polygon Mainnet. Se não:

| Campo | Valor |
|---|---|
| Network Name | Polygon |
| RPC URL | `https://polygon-rpc.com` |
| Chain ID | `137` |
| Currency Symbol | `POL` |
| Block Explorer | `https://polygonscan.com` |

#### 2.3 — Obter POL real

Você precisa de POL (antigo MATIC) na carteira para pagar o gas do deploy.

**Opções:**

- **Comprar em exchange** (Binance, Coinbase, etc.) e transferir para
  sua carteira na rede Polygon.
- **Bridge:** Se você tem ETH na Ethereum mainnet, use a
  [Polygon Bridge](https://bridge.polygon.io/) para transferir.
- **Swap:** Se você tem tokens em outra rede, use uma DEX
  (Uniswap, 1inch) com bridge.

> O custo de gas para deploy de todos os contratos do Diamond pode
> variar. Recomenda-se ter pelo menos **0.5–1 POL** para cobrir todos
> os deploys.

#### 2.4 — Exportar a chave privada

Siga o mesmo processo do item [1.4](#14--exportar-a-chave-privada).

> Se estiver usando **Ledger/Trezor**, a chave privada não é exportada —
> o hardware assina as transações diretamente. Nesse caso, configure o
> Hardhat para usar o Ledger via `@nomicfoundation/hardhat-ledger`
> ou similar.

#### 2.5 — Preencher o `.env`

```bash
POLYGON_PRIVATE_KEY=0xSUA_CHAVE_PRIVADA_MAINNET_AQUI
```

---

## 3. POLYGONSCAN API KEY

A API Key do Polygonscan é usada pelo Hardhat para **verificar o código-fonte**
dos contratos após o deploy (source code verification), permitindo que
qualquer pessoa veja e audite o código no explorer.

### Passo a Passo

#### 3.1 — Criar uma conta no Polygonscan

1. Acesse [https://polygonscan.com](https://polygonscan.com).
2. Clique em **Sign In** → **Click to sign up**.
3. Preencha username, email e senha.
4. Confirme o email (verifique sua caixa de entrada e spam).

#### 3.2 — Gerar a API Key

1. Após login, acesse **My API Keys**:
   - [https://polygonscan.com/myapikey](https://polygonscan.com/myapikey)
2. Clique em **Add** para criar uma nova chave.
3. Dê um nome (ex: `AgenticSpace Deploy`).
4. **Copie a API Key** gerada (string alfanumérica).

> A mesma API Key funciona para **mainnet** e **testnet Amoy** no
> Polygonscan.

#### 3.3 — Preencher o `.env`

```bash
POLYGONSCAN_API_KEY=SUA_API_KEY_AQUI
```

---

## 4. DEPLOYER ADDRESS

O `DEPLOYER_ADDRESS` é o **endereço público** da carteira que fará o deploy.
Ele é derivado da chave privada e serve para:

- Conferir que a chave privada corresponde ao endereço esperado.
- Rastrear transações de deploy no explorer.
- Configurar roles iniciais (owner/admin) nos contratos.

### Como obter

#### 4.1 — A partir do MetaMask

1. Abra o MetaMask na conta usada para deploy.
2. O endereço aparece no topo da extensão (formato `0x...`).
3. Clique para copiar.

#### 4.2 — A partir da chave privada (linha de comando)

Se você tem a chave privada e quer confirmar o endereço:

```bash
# Usando Node.js + ethers
node -e "const {Wallet} = require('ethers'); console.log(new Wallet('0xSUA_CHAVE_PRIVADA').address)"
```

Ou usando `cast` (Foundry):

```bash
cast wallet address 0xSUA_CHAVE_PRIVADA
```

#### 4.3 — Preencher o `.env`

```bash
DEPLOYER_ADDRESS=0xSEU_ENDERECO_AQUI
```

> O `DEPLOYER_ADDRESS` deve corresponder à chave privada usada.
> Se usar carteiras diferentes para testnet e mainnet, use o endereço
> da carteira que fará o deploy na mainnet (ou crie variáveis separadas
> se necessário).

---

## Checklist Final

Após seguir este guia, seu arquivo `.env` deve estar parecido com:

```bash
# === Polygon Amoy Testnet ===
POLYGON_AMOY_RPC_URL=https://rpc-amoy.polygon.technology
POLYGON_AMOY_PRIVATE_KEY=0x1234...abcd

# === Polygon Mainnet ===
POLYGON_RPC_URL=https://polygon-rpc.com
POLYGON_PRIVATE_KEY=0x5678...efgh

# === Polygonscan ===
POLYGONSCAN_API_KEY=ABCDEF1234567890

# === Deployer ===
DEPLOYER_ADDRESS=0xAbCdEf1234567890aBcDeF1234567890aBcDeF12

# === Diamond (preenchido após deploy) ===
DIAMOND_ADDRESS=
CAS_TOKEN_ADDRESS=
INFRASTRUCTURE_FUND_ADDRESS=

# === Faucet ===
FAUCET_INTERVAL=86400
FAUCET_AMOUNT=100000000000000000
```

- [ ] Carteira criada (MetaMask ou hardware wallet)
- [ ] Rede Amoy adicionada no MetaMask
- [ ] POL de teste obtido via faucet
- [ ] `POLYGON_AMOY_PRIVATE_KEY` preenchida
- [ ] POL real obtido (se for deployar na mainnet)
- [ ] `POLYGON_PRIVATE_KEY` preenchida
- [ ] Conta criada no Polygonscan
- [ ] `POLYGONSCAN_API_KEY` preenchida
- [ ] `DEPLOYER_ADDRESS` preenchida e conferida
- [ ] `.env` **não** está versionado no git

---

## Avisos de Segurança

- **Nunca** commite o arquivo `.env` no repositório. Ele está no
  `.gitignore` — não remova essa entrada.
- **Nunca** compartilhe sua chave privada em chats, emails, prints ou
  qualquer canal digital.
- **Nunca** cole sua chave privada em sites não confiáveis. O Hardhat
  lê a chave apenas do arquivo `.env` local.
- Use **carteiras dedicadas** para deploy, com saldo mínimo necessário.
- Considere usar **hardware wallets** (Ledger, Trezor) para deploy na
  mainnet.
- Se suspeitar que a chave foi comprometida, **transfira todos os
  fundos imediatamente** para uma nova carteira.
- O `DEPLOYER_ADDRESS` é público e pode ser compartilhado livremente.
  A **chave privada** não.
- Mantenha a **seed phrase** anotada em papel, offline, em local seguro.
  Ela é a única forma de recuperar a carteira.

![footer](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=100&section=footer&animation=twinkling)
