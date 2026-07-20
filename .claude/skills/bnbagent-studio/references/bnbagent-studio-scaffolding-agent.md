---
name: bnbagent-studio-scaffolding-agent
description: When the user wants to create a brand-new blockchain SELLER from zero — a single valuable Agent on AWS Bedrock AgentCore that serves A2A by default or MCP optionally, holds the key, and signs in-process — earning $U on BNB Chain via ERC-8004 + ERC-8183 + x402. Drives the full intake → todo-list → execute flow.
---

> **Reference file** of the `bnbagent-studio` router skill — installed at `bnbagent-studio/references/` and loaded on demand (not a standalone skill). Route here via the router's decision tree.

# bnbagent-studio-scaffolding-agent

Procedure for **greenfield** seller creation. Audience: Claude Code (or another
agent) running in an empty directory with shell + edit access.

**Different from** the `bnbagent-studio-adding-to-project.md` reference (in this same references/ directory): that one adds to an existing
repo; this one creates from zero.

## The single seller runtime (v0.0.1 workspace layout)

`bag init` scaffolds a **blockchain seller** as a thin workspace root containing
**one sub-project** under `app/agent/`:

```
<name>/                              workspace root (thin wrapper / deploy anchor)
├── pyproject.toml                   [tool.uv.workspace] members = ["app/agent"]
├── README.md                        1-page pointer at app/agent/
├── .gitignore
├── agentcore/                       AgentCore config dir (drives the agentcore CLI)
│   ├── agentcore.json               deploy descriptor ("protocol":"A2A" or "MCP" + authorizerConfiguration)
│   └── aws-targets.json             AWS account + region
├── .studio/wallets/                 evm-local keystore — Agent SOLE reader; at the WORKSPACE
│                                    root, OUTSIDE the codeLocation (no packaging path can bundle
│                                    it). twak instead keeps its mnemonic at ~/.twak (or
│                                    .studio/twak/ when project-dedicated)
└── app/
    └── agent/                       the single sub-project — the seller agent
        ├── pyproject.toml           bnbagent-studio-core + bnbagent>=0.4.0 + ADK
        │                            + protocol deps (A2A: bedrock-agentcore[a2a]
        │                            + a2a-sdk<1.0; MCP: mcp>=1.0)
        ├── studio.toml              wallet / llm / budget / payments.erc8183 bounds / payments.x402 / storage
        ├── .env.local               TWAK_WALLET_PASSWORD (twak) / WALLET_PASSWORD (evm-local), PIEVERSE_LLM_API_KEY, STORAGE_API_URL/_KEY (IPFS pinning)
        └── main.py / mcp_main.py / seller_core.py / executor.py / agent_card.py / signing.py / tools.py / managed_model.py / Dockerfile
```

- **The Agent (`<name>/app/agent/`, → AWS Bedrock AgentCore).** ONE valuable agent
  (memory / tools / skills / KB / LLM) that **serves the selected protocol
  directly** (A2A: `0.0.0.0:9000`; MCP: `0.0.0.0:8000/mcp`), holds the key, and
  signs **in-process**. Its outward surface is two fixed-code commerce
  operations (A2A skills on `SellerAgentExecutor`, or MCP tools on FastMCP):
  - **`negotiate`** → rule-based list price CLAMPED to `[min,max]` →
    `signing.sign_quote` EIP-191 sign. **No LLM.**
  - **`notify_funded`** → `signing.verify_signed_job` (synchronous) → delivery:
    A2A ACKs then runs LLM work + `signing.submit_result` in the background (plus
    a best-effort in-process sweep of other FUNDED jobs); MCP runs the work and
    submit synchronously inside the tool call.

  ALL signing is fixed `app/agent/signing.py` code, **never** an LLM tool — the LLM
  gets read-only chain tools only. The keystore lives at the **workspace root**
  `.studio/wallets/` (outside the `app/agent/` codeLocation) and is injected at
  deploy via AWS Secrets Manager — see Step 3 and Stage 4.

There is **no** second service, **no** keyless EC2 host, **no** `InvokeAgentRuntime`
relay, and **no** background poller. The agent is its own public surface.

v1 is **seller-only**; chat / buyer roles are deferred to v2. (A studio agent can
still *buy* other agents' 8183 services via `bag erc8183 buy/fetch/...`, but the
buyer flow is not yet productized.)

## Preconditions

- Python 3.10+ available.
- `bnbagent-studio` (the CLI) installed — `pip install bnbagent-studio` or `uv tool install bnbagent-studio` (auto-pulls the `bnbagent-studio-core` runtime lib); for local dev use editable installs from a monorepo clone (`pip install -e packages/bnbagent-studio-core -e packages/bnbagent-studio`, or `uv sync`). `bag --version` works.
- `bag skills install` was run so this skill is loaded.
- **`agentcore` CLI (npm `@aws/agentcore`) on PATH, backed by Node ≥20.**
  `bag init` shells out to it to lay down the `agentcore/` skeleton, and it is
  **NOT** pulled in by `pip install bnbagent-studio` — install separately with
  `npm install -g @aws/agentcore` (the CLI requires Node ≥20 and crashes on
  older Node). Ensure the `agentcore` that resolves first on PATH is this npm
  CLI, not a Python `bedrock-agentcore-starter-toolkit` shim (e.g. from pyenv) —
  the Python one has a different, incompatible `create` and will fail `bag init`.
  (Python 3.10+ and `bag` itself are NOT listed here: installing the CLI already
  required Python, and this skill only runs because `bag` is installed.)
- **Permission prompts on `bag` calls are normal — do not try to remove them.**
  The IDE asking the user to confirm each `bag` command is the expected flow;
  whether to allowlist anything is the user's own decision, made in their own
  settings UI/file. NEVER edit permission settings yourself, NEVER run
  `claude config` (or any equivalent) to grant yourself permissions, and do
  not ask the user to pre-authorize `bag` — `bag:*` includes money-spending
  commands (deploy, erc8183 buy/settle), so a blanket grant is unsafe.
- Current working directory is where the project should live. The project is
  created at `<cwd>/<name>/` — pick the parent before triggering this skill.

## Stage 1 — Intake (collect ALL answers in one round, then echo back)

**Do not ask one question at a time.** Present the full form in a single
message, with defaults pre-filled. Accept the user's reply (which may be just
"go with defaults" or selective overrides), then echo a confirmation block and
proceed. This matches a shell-style prompt — one round-trip, then execute.

The fields (give the user all of them at once):

| # | Field | Options | Default |
|---|---|---|---|
| 1 | **Project name** | **Must start with a letter; ≤23 chars after sanitizing.** AgentCore runtime names are ASCII-alphanumeric-only — `bag init` **auto-sanitizes the charset** (drops `-`/`_`, so `news-agent` → `newsagent`, and prints the name it used), but it does **NOT** auto-shorten: a name whose alphanumeric form exceeds 23 chars errors out (pick a shorter one). The sanitized name becomes the dir name AND the AgentCore runtime name, so prefer a clean alphanumeric name up front. e.g. `newsagent`, `twcopywriter` | (required) |
| 2 | **Network** | `bsc-testnet` / `bsc-mainnet` | `bsc-testnet` |
| 3 | **LLM provider** | `pieverse-llm` / `openrouter` / `openai` / `anthropic` / `bedrock` | `pieverse-llm` |
| 4 | **Wallet kind** (`--wallet-kind`) | `evm-local` (encrypted local keystore at the workspace root; `bag wallet new` creates it, `--private-key` imports an existing key; CodeZip deploy) / `twak` (**fully supported, opt in with `--wallet-kind twak`** — Trust Wallet Agent Kit CLI ≥0.19.1, self-custody encrypted mnemonic in a **project-dedicated** home `.studio/twak`, isolated from your main `~/.twak`; created manually with `HOME=<ws>/.studio/twak twak wallet create`, then `bag wallet new` adopts; container deploy. Reuse an existing wallet across agents with `--twak-home <path>`) | `evm-local` |
| 5 | **Storage** | `local` (file:// on disk, offline dev only, does **NOT** survive deploy) / `ipfs` (durable, public, deploy-ready; needs your pinning service's upload endpoint + write key as `STORAGE_API_URL` / `STORAGE_API_KEY` in `.studio/.env.local` **before the first real delivery** — see Step 6b) | `local` |
| 6 | **Protocol** (`--protocol`) | `A2A` / `MCP` | `A2A` |
| 7 | **LLM model** | provider catalogue; for `pieverse-llm` the default `auto/free` runs at $0/token | `auto/free` |
| 8 | **Auto-topup** | `enable` / `disable` — lets the Agent auto-pay $U from the wallet when LLM credits run low | deferred (non-interactive `bag init` records no `[budget]`; enable later with `bag budget enable`) |
| 9 | **Deploy destination** (`--destination`) | `self` (deploy to **your own** AWS Bedrock AgentCore; no secret ever leaves your machine) / `platform` (a 48h **testnet-only** trial on the BNB Chain managed platform — runs the *same* agent in the **operator's** AWS, so a wallet key **leaves your machine**; it hard-forces `[network].default = bsc-testnet`, pins runtime=`agentcore`, packages an artifact (a zip for the default evm-local wallet, a container for twak), and auth is GitHub device flow. Use a **throwaway** `bag wallet new`, never your main wallet) | `platform` while the trial campaign runs (bare init falls back to `self` once it ends, or when `--network bsc-mainnet` / a non-agentcore `--runtime` is passed) |

v1 is **seller-only** — there is no role to choose. `bag init` scaffolds the
single seller agent under `app/agent/` (serves the selected protocol directly,
sole signer).
Chat / buyer roles are deferred to v2.

**Architecture selections** (framework/runtime are fixed in v0.0.1; protocol is selected above).
**Render these as their own visible table in the intake form**, right after the
fields above — do NOT compress them to a one-line footnote: they are part of
the config the user is confirming, and "where's A2A / the runtime?" is a real
question. Each row: Field | Value | What it is.

| Field | Value | What it is |
|---|---|---|
| **Framework** | `adk` | Google ADK — the library the agent's brain (LLM, tools) is built with (`--framework adk`). |
| **Runtime** | `agentcore` | AWS Bedrock AgentCore — where the agent is hosted and served (`--runtime agentcore`). |
| **Protocol** | selected above (`A2A` default, `MCP` optional) | the agent's public surface — A2A hosts the agent card + JSON-RPC `message/send` on `0.0.0.0:9000`; MCP hosts FastMCP on `0.0.0.0:8000/mcp`. Local `bag dev` uses `127.0.0.1:9000` for A2A and `localhost:8000/mcp` for MCP by default (a platform-destined project serves the *same* protocol surface — the operator's gateway routes to it). Orthogonal to the framework/runtime: built with ADK, hosted on AgentCore, served over the selected protocol. |

**Not surfaced** (handled automatically, no need to show or ask):
- **Venv provisioning** — on by default (`bag init` builds `app/agent/.venv`
  unless `--no-venv`).
- **IDE skill target** — auto-detected (`--ide`), falls back to `claude-code`.

The following are auto-included by default (don't ask, just mention in the confirmation block):
- **Read-only chain tools** wired into the Agent's LLM (`app/agent/tools.py`) — the LLM
  can query wallet / balances / ERC-8004 / ERC-8183 state but **never signs**.
- **LLM-credit auto-renew** via the emitted `app/agent/managed_model.py` — the
  Agent's `build_model()` factory (in user-owned code, scaffolded by
  `providers/pieverse-llm/code/adk/`) returns a managed LiteLlm subclass whose
  **automatic, budget-gated auto-renew hook** tops up the active Pieverse key
  before an LLM call when the cached balance is below the floor. The framework-
  neutral credit-ensurer logic lives in `bnbagent_studio_core.pieverse.PieverseCreditEnsurer`;
  the framework-specific shell is in the emitted `app/agent/managed_model.py`. This
  is the ONLY automatic signing path outside `signing.py`; it rides on the
  hardened x402 buyer kernel (`bnbagent_studio_core.x402`) but is **not an LLM tool** —
  the Agent (the sole key-holder) does it transparently inside the model wrapper.
  If the budget gate is off / exhausted, the hook raises
  `PieverseAccountBalanceExhaustedError` pointing at `bag llm topup --amount N`.
  Opt out via `[llm.auto_renew].enabled = false`.

Also collect, if natural to gather: a one-sentence description of what the
agent does (used in the agent's instruction prompt and, later, in
ERC-8004 metadata when the user runs `bag deploy verify`).

After collecting, **echo back** a confirmation block like:

```
Will create (single seller agent):
  name:        newsagent           (≤23 chars, alphanumeric, letter-start — AgentCore rule)
  agent:       app/agent/ (AgentCore, --protocol A2A or MCP, sole signer, signs in-process)
  network:     bsc-testnet
  llm:         pieverse-llm (model: auto/free, auto-renew enabled)
  wallet:      evm-local — encrypted keystore at the workspace root (.studio/wallets/)
               (twak is fully supported too — opt in with --wallet-kind twak)
  storage:     local (offline dev; switch to ipfs — needs a pinning endpoint + key — before deploy)
  fixed:       framework=adk (Google ADK), runtime=agentcore (AWS Bedrock AgentCore)
  protocol:    A2A (serve_a2a on 0.0.0.0:9000; local 127.0.0.1:9000)
               or MCP (FastMCP on 0.0.0.0:8000/mcp; local localhost:8000/mcp)
  destination: platform (campaign default while the trial runs — 48h testnet on the operator's AWS; key leaves your machine, use a throwaway wallet)
               or self (deploy to your own AWS Bedrock AgentCore; key never leaves your machine — pass --destination self)
  extras:      read-only chain tools wired into the Agent LLM
  location:    /Users/.../newsagent/

Proceeding in 3 commands… (interrupt now if anything's off)
```

Then execute Stage 2 **without further prompts** until you hit a step that
genuinely requires user action (funding the wallet).

## Stage 2 — Generate a todo list (visible to the user)

Build a TodoWrite list. The shape depends on the `wallet kind`. The
canonical 8-step layout (evm-local default, Pieverse default LLM; plus a conditional
Step 6b when `storage=ipfs`):

> **Step 0 — Pre-flight (run BEFORE `bag init`).** Verify the one toolchain
> that having `bag` does NOT imply: the AgentCore CLI. Do **not** re-check
> Python or `bag` (both are necessarily present — installing the CLI required
> Python, and this skill only loads because `bag` is installed).
> ```bash
> node --version              # must be ≥20, 22 LTS recommended (@aws/agentcore crashes on older Node: "Invalid regular expression flags")
> agentcore create --help     # must succeed AND list `--no-agent`  → confirms it's npm @aws/agentcore
> command -v uv >/dev/null || echo "uv not found — OK, bag init falls back to venv+pip (slower)"
> ```
> If `agentcore create --help` fails or does NOT show `--no-agent`, the wrong
> CLI is on PATH (likely a Python `bedrock-agentcore-starter-toolkit` shim) or
> Node is too old — **PAUSE** and have the USER fix it (`npm install -g
> @aws/agentcore`, switch to Node ≥20, and make sure that CLI wins on PATH). It
> is a global npm tool on the user's machine, so the user installs it, not you.

> **Onboarding note.** On a human TTY, `bag init` runs steps 3, 4 and 6
> automatically (it prompts once for the wallet password, runs `bag wallet
> new`, zero-deposit-activates Pieverse, and prints faucet URLs). **You (Claude
> Code) drive `bag init` non-interactively**, so that auto-flow does NOT fire —
> keep steps 3/4/6 below. Pass `--no-onboard` to `bag init` to make this
> explicit and deterministic regardless of how the shell wires stdin.

1. `bag init <name> --llm-provider <p> --network <n> --storage-provider <s> --wallet-kind <k> --no-onboard`
   — scaffold the v0.0.1 workspace. **`<name>` must start with a letter and be
   ≤23 chars after sanitizing** — `bag init` auto-drops `-`/`_` for the
   AgentCore name (printing what it used) but errors if the alphanumeric form
   is >23 chars; prefer a clean alphanumeric name from Stage 1. Pass
   `--wallet-kind evm-local` (default) or `--wallet-kind twak` (twak is fully
   supported — pass the flag to opt in), and `--storage-provider local`
   (default) or `ipfs`, per the Stage-1 choices; for twak, add
   `--twak-home <path>` ONLY if the user wants to reuse an existing wallet
   (otherwise omit — a project-dedicated `.studio/twak` is the safe default).
   add `--protocol MCP` only if the user chose MCP (omit for A2A default), add
   `--model <m>` only if the user overrode the provider default, and
   `--enable-auto-topup` / `--no-auto-topup` only if they made an explicit
   choice (otherwise omit — consent stays deferred). **Destination:** while the
   trial campaign runs, bare `bag init` (no `--destination`) defaults to
   `platform` — so pass `--destination self` **explicitly** whenever the user
   chose their own AWS, otherwise studio.toml silently records `platform` and the
   confirmation block you echoed no longer matches what was written. Omit
   `--destination` only when the user actually wants the `platform` 48h testnet
   trial (the campaign default) — do NOT treat that default as a mistake or
   re-confirm it; it is the intended behavior while the campaign is open. (Bare
   init also resolves to `self` once the campaign ends, or when `--network
   bsc-mainnet` / a non-agentcore `--runtime` is passed.) On the `platform` path
   `bag init` hard-forces `bsc-testnet`, pins `--runtime agentcore` + packages an
   artifact (a zip for the default evm-local wallet, a container for twak), and a
   wallet key will later leave your machine, so pair it with a throwaway
   `bag wallet new` (full flow: `docs/guides/platform-deploy.md`). Defaults
   `--framework adk`
   and `--runtime agentcore` (only options in v0.0.1). Creates `<name>/` workspace
   root + `<name>/app/agent/` (the single sub-project: A2A emits `main.py`
   (`serve_a2a`) + `seller_core.py` (the protocol-neutral core; executor inherits
   it) + `executor.py` + `agent_card.py`; MCP emits `mcp_main.py`;
   both include `signing.py` + `tools.py` + `managed_model.py` for Pieverse
   projects + `Dockerfile` + own
   `studio.toml` + `.env.local` + `pyproject.toml`) + `<name>/agentcore/`
   (`agentcore.json` + `aws-targets.json`). The workspace root holds the
   `agentcore/` deploy descriptor, the `.studio/wallets/` keystore, a thin
   `pyproject.toml`, README, and `.gitignore`. (v1 is seller-only — no `--role`.)
2. `cd <name>`, then provision the agent's venv. The emitted `app/agent/`
   depends on the `bnbagent-studio-core` runtime lib (NOT the `bnbagent-studio`
   CLI), so `pip install -e ./app/agent` pulls it from PyPI:
   ```bash
   python -m venv app/agent/.venv && app/agent/.venv/bin/pip install -e ./app/agent
   ```
   (For local dev against an unreleased core, add `-e /path/to/packages/bnbagent-studio-core`
   to the install. `uv` works too — `uv venv` + `uv pip install` — but tooling is
   the user's choice; do NOT assume uv.) The sub-project's `pyproject.toml`
   carries its deps: `bnbagent-studio-core` (pinned to the scaffolding CLI's
   version range) + `bnbagent>=0.4.0` + `google-adk` + `litellm>=1.89,<2` plus the
   **protocol-specific** group — A2A adds `bedrock-agentcore[a2a]` + `a2a-sdk<1.0`,
   MCP adds `mcp>=1.0` instead (an A2A-only deploy never ships `mcp`, and an
   MCP-only deploy never ships `a2a-sdk`). (`a2a-sdk` is pinned `<1.0` because
   1.0 removed a class `serve_a2a` needs. Deliberately NO
   `bedrock-agentcore-starter-toolkit` — its Python `agentcore` shim shadows the
   npm `@aws/agentcore` CLI on PATH.)
3. **Set the wallet password** — the USER does this, NOT you.

   🔒 **SECURITY — never route the wallet password through the chat.** It
   encrypts the key material that is the Agent's sole signing key. Do **NOT**
   ask the user to type it into the chat, and do **NOT** run any command with
   the password on the command line (`bag env set <PW_VAR> <literal>`,
   `twak wallet create --password <literal>`, …) — it would land in the
   session transcript, be sent to the model API, and hit shell history / `ps`.

   Tell the user to set it **themselves, in their own terminal**, so it never
   reaches you. The env var depends on the wallet kind:
   - **twak** → `TWAK_WALLET_PASSWORD` (the twak CLI reads it itself)
   - **evm-local** → `WALLET_PASSWORD`
   ```bash
   # In YOUR OWN terminal (not via the agent): open .studio/.env.local and
   # set the line for your wallet kind:
   #     TWAK_WALLET_PASSWORD=<a strong password you choose>   # twak
   #     WALLET_PASSWORD=<a strong password you choose>        # evm-local
   # Save it. Do not paste the password into this chat.
   ```
   `bag` auto-loads `.studio/.env.local` (resolved via the project root), so once
   the line is set you do NOT need to `source` it or `cd` anywhere special —
   `bag wallet new` / `bag llm activate` will read it. Wait for the user to
   confirm they've set it before continuing.
4. **Create / adopt the wallet** — depends on the wallet kind:
   - **twak** (fully supported — opt in with `--wallet-kind twak`): `bag init` writes `[wallet].twak_home =
     "../../.studio/twak"` — a **project-dedicated** wallet isolated from your
     main `~/.twak`, so a deploy never pushes the main wallet's key material to
     Secrets Manager. The user creates it ONCE themselves — the twak CLI forces
     the password onto argv (upstream S-8), so studio never runs it — in their
     own terminal:
     own terminal — the 3-step `twak setup` wizard:
     ```bash
     HOME=<workspace>/.studio/twak twak setup
     ```
     **Tell the user exactly what to pick at each wizard step** — it is not
     obvious and a wrong pick is dangerous:
     - **Step 1 (API credentials):** paste Access ID + HMAC secret from
       https://portal.trustwallet.com/dashboard/apps; WalletConnect Project ID →
       leave blank, ENTER.
     - **Step 2 (wire up harnesses): SELECT NONE, press ENTER** (don't press
       SPACE/`a`) — never wire twak's signing MCP into Claude Code / Cursor /
       etc.; studio keeps signing in fixed code, not MCP.
     - **Step 3 (wallet): pick `3) Skip for now`**, then create the wallet with
       the standalone command below. (`1) Create a new agent wallet` persists the
       password via the OS keychain, which fails on keychain-less environments —
       "OS keychain cannot persist passwords here … headless / Docker" — and
       studio unlocks via `TWAK_WALLET_PASSWORD` env anyway. NEVER pick `2) Use
       WalletConnect` = your main wallet.)

     ```bash
     HOME=<workspace>/.studio/twak twak wallet create --password <StrongPw> --no-keychain  # UPPER + lower + digit
     ```
     Use UPPER + lower + digit; put that same password in `.studio/.env.local`
     as `TWAK_WALLET_PASSWORD`. `--no-keychain` keeps the password out of the OS
     keychain (no macOS prompt); studio unlocks via the env. (If you omit it and a
     macOS prompt *loops*, do NOT "Reset Default Keychain" — `pkill -9 -f twak`,
     then re-run with `--no-keychain`.) Full detail: the
     `bnbagent-studio-using-twak-wallet.md` reference (in the router skill's `references/` directory).
     Then YOU run `bag wallet new`, which **adopts** the address into
     `studio.toml` (and echoes it — confirm it's the intended wallet before
     funding/deploy). To reuse an EXISTING wallet across agents, scaffold with
     `bag init --twak-home <path-to-its-home>` instead. Reusing your main
     `~/.twak` is opt-in only (`--twak-home ~`) and discouraged. Full detail:
     the `bnbagent-studio-using-twak-wallet.md` reference (in the router skill's `references/` directory).
   - **evm-local** (default): `bag wallet new` creates the encrypted keystore. To import
     an existing key, the user pastes it and you immediately run
     `bag wallet new --private-key <pk>` (the key is written only into the
     keystore, nowhere else on disk).
5. **Fund the wallet — OPTIONAL; do NOT block on it.** The default `auto/free`
   LLM model runs at $0 and AgentCore deploy consumes no wallet balance, so a
   brand-new seller can scaffold, run `bag dev`, and deploy with an empty
   wallet. `bag doctor` and `bag deploy` only **WARN** (never block) on zero
   balance. Funding is needed later only for: a paid LLM model, on-chain
   settle, or paying ERC-8183 job buys. When that time comes, the wallet uses
   **TWO distinct U balances on TWO chains** (same wallet address, same private
   key, different chains):

   - **tBNB (gas)** on BSC testnet: https://testnet.bnbchain.org/faucet-smart
     — paste address
   - **BSC mainnet U** (`0xcE24439F2D9C6a2289F741120FE202248B666666`) — for
     Pieverse LLM topup. Minimum **0.2 U** recommended (0.1 for activate +
     slack). Pieverse runs **only on mainnet chainId=56**; testnet U cannot
     pay for LLM credits. Acquire via PancakeSwap. v0.0.1 does NOT
     auto-refill from wallet — keep refilling Account Balance with
     `bag llm topup` as you use credits.
   - **BSC testnet U** (`0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565`) — for
     ERC-8183 job payments if `[network].default = bsc-testnet`. Faucet:
     https://united-coin-u.github.io/u-faucet/ (paste the agent wallet
     address; see also `docs/guides/U-token-testnet.md`).

   Both U balances live in the **same agent wallet** — one address, same
   private key — just on different chains. Verify both with
   `bag wallet balance --all`.
6. **Activate Pieverse LLM** (only if `llm=pieverse-llm`, default): `bag llm
   activate` — **zero-deposit by default** (`--initial-usd` defaults to 0).
   SIWE-logs in with the agent wallet (an off-chain EIP-191 signature — no gas,
   no U), creates an `sk-pv-...` key with a $0 allocation, and writes
   `PIEVERSE_LLM_API_KEY` to `.env.local` + `key_hash` to studio.toml. The
   default model `auto/free` runs at $0/token, so **no funding is required to
   start**. Only when you switch to a paid model do you fund the wallet and run
   `bag llm topup --amount N` (then `[llm.auto_renew]` auto-**allocates** from
   your Pieverse Account Balance to the key below the floor; v0.0.1 never
   auto-spends wallet U). For non-Pieverse providers, manually set the API key
   env var instead.

   **Step 6b — Set the IPFS pinning credentials** (only when the user chose
   `storage=ipfs`; `bag init` defaults to `local`). With `--storage-provider
   ipfs` the Agent pins each deliverable to IPFS at delivery and publishes
   `ipfs://CID` on-chain (durable, public, deploy-ready). Works with **any** IPFS
   pinning service or a self-hosted node:

   > Pick a pinning service and create a write key/JWT in its console (or run
   > your own IPFS node — its `/api/v0/add` endpoint usually needs no key),
   > then:
   > ```bash
   > bag env set STORAGE_API_URL <your-service-upload-endpoint>
   > bag env set STORAGE_API_KEY <your-write-key>
   > ```
   > Written to `.studio/.env.local`. **OPTIONAL to start** (scaffold, `bag
   > dev`, and deploy all work without them) but **required before the first
   > real delivery submits on-chain** — without them the Agent can't pin to
   > IPFS and delivery fails. You can also pass `--ipfs-key <key>` to `bag
   > init` upfront. `bag doctor` WARNs (never blocks) while they're unset. For
   > pure offline dev with no IPFS, scaffold with `--storage-provider local`
   > instead (writes `STORAGE_LOCAL_PATH`, no key — but does NOT survive
   > deploy: the deployed agent and your dev box don't share a filesystem).
7. **Recipe code is already emitted by `bag init`** — the `app/agent/`
   sub-project plus its `studio.toml` is written by step 1, so **skip manual
   recipe emission**. To re-emit or inspect a recipe later, `bag recipe code
   agent` / `bag recipe code runtimes/agentcore` (derives `{{PKG}}` from
   `[project].name`, kebab→snake; pass `--pkg <name>` to override). The real work
   is editing the Agent's `run_work` hook in `app/agent/seller_core.py` (A2A) /
   `app/agent/mcp_main.py` (MCP) (see `bnbagent-studio-selling-via-8183.md` in this same directory).
8. **Verify**: `bag doctor` — confirms the scaffold + Pieverse key activation
   (if applicable) + config. Zero BNB / U are **WARN only** (not failures) —
   funding is optional (see step 5), so do NOT refuse to continue on a balance
   warning. Only refuse on real FAILs (missing keystore, unparseable config,
   etc.).

**Do not** register ERC-8004 identity at this stage — it needs the deployed
agent's public AgentCore endpoint, so it happens **last** at deploy time
(`bag deploy verify`). Telling the user upfront:

> ERC-8004 on-chain identity registers at deploy time with your agent's public
> AgentCore endpoint (A2A card URL or MCP `/mcp` URL + access metadata). Skipped
> now so you don't burn gas before you know whether you'll ship this seller.

ERC-8183 service publishing is also a deploy-time concern — defer it.

Present the todo list to the user; ask "is this OK or do you want me to add/remove steps?"
**only if** the wallet kind is unusual (e.g. `evm-local` with a key import, or
`twak`). For the `evm-local` default, skip the confirmation and execute.

## Stage 3 — Execute step by step

For each todo item:

- Mark `in_progress` before running
- Run the command via shell (or Edit/Write for code changes)
- Show the user the output
- Mark `completed` when done

**Stop and ask the user** at:

- Step 3 (password): the USER sets it **themselves, in their own terminal** —
  never through the chat or on a command line (see Step 3's security note). They
  edit `.studio/.env.local` and set `TWAK_WALLET_PASSWORD` (twak) or
  `WALLET_PASSWORD` (evm-local). `bag` auto-loads that file, so once it's set
  `bag wallet new` / `bag llm activate` pick it up — no `source`/`cd` needed.
  Wait for the user to confirm before continuing.
- Step 5 (funding): OPTIONAL — only stop here if the user explicitly wants a paid LLM model, on-chain settle, or to pay ERC-8183 buys now. Otherwise skip; the `auto/free` default needs no funds.
- Step 6 (Pieverse activation): zero-deposit, so it just works — no funding precheck needed. If `bag llm activate` fails on connectivity, retry once.
- Step 6b (IPFS credentials): only when `storage=ipfs`. OPTIONAL now — do NOT block; the user picks a pinning service and runs `bag env set STORAGE_API_URL <url>` + `bag env set STORAGE_API_KEY <key>` themselves. Remind them they're required before the first real delivery (and `bag doctor` will keep WARNing until set). Skip entirely if they chose `local` storage.
- Business-logic step: ask the user what the Agent should produce when it delivers a job — the `run_work` hook in `app/agent/seller_core.py` (A2A) / `app/agent/mcp_main.py` (MCP) is the developer hook. Leave the generic LLM passthrough stub if they don't know yet

**Never** ask the user to `echo "KEY=VALUE" >> .env.local`. Always call
`bag env set KEY VALUE` — it replaces the existing line if present, otherwise
appends, so it's safe to run repeatedly.

## Stage 4 — Summary

After step 8 passes (doctor clean — Pieverse key activated; balances may be
0 and that's fine), print:

```
✅ <name> ready for local development (single seller agent).

Wallet:    <0x...>
Network:   bsc-testnet
BNB bal:   <X> tBNB
U bal:     <Y> U

Local dev (from workspace root <name>/):
  bag dev                            # A2A: local :9000; MCP: local :8000/mcp (same for any destination)
                                     # (no Cognito env locally)
                                     # For A2A, test with curl/A2A DataPart, NOT the
                                     # AgentCore inspector chat box (it can't send a
                                     # seller's skills). For MCP, use an MCP client.

When ready to deploy:
  bag deploy provision-cognito       # emit the Cognito CDK app — you run `cdk deploy`,
                                     # then its discoveryUrl/clientId wire into the OAuth2 authorizer
  bag deploy prepare                 # readiness sweep
  bag deploy agent                   # ship the Agent to AgentCore (selected protocol);
                                     # keystore injected via Secrets Manager (never in the CodeZip)
  bag deploy verify --endpoint <url> # probe the deployed endpoint + reconcile ERC-8004 identity

Edit (from workspace root):
  app/agent/seller_core.py or mcp_main.py # the VALUE — implement the run_work hook (your work product)
  app/agent/signing.py               # fixed signing code (clamp + sign); NOT LLM tools
  app/agent/tools.py                 # read-only chain tools the LLM may call
  app/agent/agent_card.py            # A2A only: advertised card (2 skills + OAuth2 scheme)
  app/agent/studio.toml              # Agent config (LLM, [payments.erc8183] price clamp, [budget])
```

## Gotchas

- **U is 18 decimals** (not 6 like USDC). The `bnbagent_studio_core.networks.to_raw/from_raw`
  helpers handle this.
- **`buy_workflow`'s `deadline_minutes`** is the seller's *submission* window. The
  on-chain job lifetime is automatically `deadline_minutes + 24h dispute_window`.
- **`bag init` runs wallet onboarding only on a human TTY** (evm-local: prompts
  for the password and runs `bag wallet new`; twak: adopts the existing twak
  wallet — never creates one, since `twak wallet create` puts the password on
  argv). When **Claude Code** runs `bag init` (non-interactively, via the shell
  tool) that auto-flow does NOT fire, so this skill drives Step 3/4 explicitly —
  use `--no-onboard` to make the behavior deterministic. This skill bridges the
  gap by collecting the wallet kind upfront and calling the right form.
- **The agent is the sole key-holder; the key material never enters the deploy
  package.** For **evm-local** the encrypted keystore lives at the **workspace
  root** `.studio/wallets/` (outside the `app/agent/` codeLocation, so no
  packaging path — incl. a raw `agentcore deploy` — can bundle it); for **twak**
  the mnemonic lives at `~/.twak` (or `.studio/twak/`), never in the repo. Either
  way it is injected at deploy via AWS Secrets Manager (default
  `--secrets-mode secretsmanager`) — `WALLET_KEYSTORE_JSON` / `WALLET_PASSWORD`
  for evm-local, `TWAK_WALLET_JSON` / `TWAK_CREDENTIALS_JSON` /
  `TWAK_WALLET_PASSWORD` for twak — reconstructed at cold start, never in the
  package; the testnet-only `--secrets-mode envvars` fallback is refused on
  mainnet.
- **AgentCore seller endpoints are never anonymous.** With no authorizer the runtime defaults
  to IAM/SigV4 (owner-only, NOT open); to serve **external** buyers configure the
  Cognito OAuth2 authorizer — `bag deploy provision-cognito` emits a CDK app the
  user `cdk deploy --outputs-file`s, then `provision-cognito --wire` patches
  `agentcore.json` + the card env. `bag deploy prepare` warns (W9) if unset but
  does NOT block. Locally, `bag dev` runs without Cognito env, so the card omits
  the scheme and is reachable without a token.
- **ERC-8183 does NOT require ERC-8004** at the protocol level (commerce contract
  doesn't check the identity registry). Local two-agent dev can run end-to-end
  without ever touching 8004. Use 8004 only when you actually want discoverable
  identity.
- **Seller code that needs `ERC8183JobOps` directly** should import the public
  `from bnbagent.erc8183 import ERC8183JobOps` — the headless funded-job lifecycle
  ops. `get_pending_jobs()` returns FUNDED jobs assigned to this provider (the
  basis for the executor's best-effort sweep).

## Reference

- the `bnbagent-studio-using-twak-wallet.md` reference (in this same references/ directory) (the fully-supported `twak` wallet kind, opt in with `--wallet-kind twak`: setup / funding / SIWE / container deploy)
- `docs/design/single-a2a-agent.md` (the v1 deploy model)
- `docs/design/buyer-push-protocol.md` (negotiate → fund → notify_funded, the sweep)
- `docs/design/decisions.md` (single seller runtime + protocol choice; CLI vs skill responsibilities)
- `docs/design/architecture.md` §2.5 / §2.7 (the single seller runtime + workspace layout)
- `docs/guides/U-token-testnet.md` (how to obtain testnet U tokens)
