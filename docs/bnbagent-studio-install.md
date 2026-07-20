# bnbagent-studio — Instalação no Linux

Guia de instalação do `bnbagent-studio` (CLI: `bag`) em sistemas Linux.

## Pré-requisitos

- **Python 3.10+** — verifique com `python3 --version`
- **Node.js 20+** — necessário para o `agentcore` CLI (`npm install -g @aws/agentcore`)
- **pip** — geralmente já vem com Python

## Instalação

### 1. Instalar o CLI bnbagent-studio

Em sistemas Linux que usam PEP 668 (Ubuntu 24.04+, Debian 12+, Fedora), use `--break-system-packages`:

```bash
pip install bnbagent-studio --break-system-packages
```

Isso instala o CLI `bag` e automaticamente puxa a biblioteca de runtime `bnbagent-studio-core`.

> Alternativa sem `--break-system-packages`: use um ambiente virtual.
> ```bash
> python3 -m venv ~/.venvs/bag
> source ~/.venvs/bag/bin/activate
> pip install bnbagent-studio
> ```
> Depois ative o venv antes de usar `bag`.

Verifique a instalação:

```bash
bag --version
bag --help
```

### 2. Instalar os skills no projeto

Dentro do diretório do projeto onde os skills devem ser instalados:

```bash
bag skills install --scope project
```

Isso cria a estrutura `.claude/skills/bnbagent-studio/` dentro do projeto, com:

- `SKILL.md` — router com árvore de decisão
- `references/` — 10 playbooks de referência:
  - `bnbagent-studio-scaffolding-agent.md` — criar projeto do zero
  - `bnbagent-studio-adding-to-project.md` — adicionar a projeto existente
  - `bnbagent-studio-operating.md` — operar/debugar
  - `bnbagent-studio-selling-via-8183.md` — fluxo de vendedor
  - `bnbagent-studio-buying-via-8183.md` — fluxo de comprador
  - `bnbagent-studio-buying-from-bazaar.md` — x402/Bazaar
  - `bnbagent-studio-use-aws-agentcore.md` — deploy AWS AgentCore
  - `bnbagent-studio-wiring-llm-tools.md` — integrar chain tools no LLM
  - `bnbagent-studio-extending-signing.md` — EIP-712 signing
  - `bnbagent-studio-using-twak-wallet.md` — wallet TWAK

### 3. Instalar o agentcore CLI (opcional, para deploy AWS)

```bash
npm install -g @aws/agentcore
agentcore --version
```

> Requer Node 20+. Verifique com `node --version`.

### 4. Verificar a instalação

```bash
bag doctor
```

O `bag doctor` verifica:
- `studio.toml` parseable
- wallet keystore
- variáveis de ambiente
- provedor LLM
- rede RPC alcançável
- saldo da wallet

## Estrutura de Diretórios Após Instalação

```
smartcontracts/
├── .claude/
│   └── skills/
│       └── bnbagent-studio/
│           ├── SKILL.md                    # router com árvore de decisão
│           ├── .bag-meta.json              # metadados do pacote
│           └── references/
│               ├── bnbagent-studio-scaffolding-agent.md
│               ├── bnbagent-studio-adding-to-project.md
│               ├── bnbagent-studio-operating.md
│               ├── bnbagent-studio-selling-via-8183.md
│               ├── bnbagent-studio-buying-via-8183.md
│               ├── bnbagent-studio-buying-from-bazaar.md
│               ├── bnbagent-studio-use-aws-agentcore.md
│               ├── bnbagent-studio-wiring-llm-tools.md
│               ├── bnbagent-studio-extending-signing.md
│               └── bnbagent-studio-using-twak-wallet.md
```

## Workflows no Windsurf

Os skills também foram adaptados como workflows do Windsurf em `.devin/workflows/`:

- `/bnbagent-studio` — workflow router principal (árvore de decisão)
- `.devin/workflows/bnbagent-studio/` — 10 playbooks adaptados

A regra `.devin/rules/bnbagent-studio.md` garante os 5 core commitments mesmo sem invocação explícita do workflow.

## Próximos Passos

1. **Criar um projeto do zero**: `/bnbagent-studio scaffolding-agent` ou leia `references/bnbagent-studio-scaffolding-agent.md`
2. **Adicionar a projeto existente**: leia `references/bnbagent-studio-adding-to-project.md`
3. **Operar/debugar**: leia `references/bnbagent-studio-operating.md`
4. **Deploy AWS**: leia `references/bnbagent-studio-use-aws-agentcore.md`

## CLI Groups

`init`, `scan`, `recipe`, `skills`, `wallet`, `erc8004`, `erc8183`, `x402`, `agents`, `config`, `env`, `dev`, `doctor`, `audit`, `deploy`, `platform`, `llm`, `bundle`, `budget`

Use `bag --help` para detalhes de cada grupo.

## Links

- [bnbagent-studio no PyPI](https://pypi.org/project/bnbagent-studio/)
- [BNB Chain Testnet Faucet](https://testnet.bnbchain.org/faucet-smart)
- [U Token Testnet Faucet](https://united-coin-u.github.io/u-faucet/)
