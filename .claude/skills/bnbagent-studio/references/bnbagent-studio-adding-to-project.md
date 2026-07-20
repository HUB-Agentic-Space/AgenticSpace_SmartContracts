---
name: bnbagent-studio-adding-to-project
description: When the user wants to add bnbagent-studio's single ERC-8183 seller runtime (one valuable Agent on AWS Bedrock AgentCore that serves A2A by default or MCP optionally, holds the key, and signs in-process) to an existing Python agent project.
---

> **Reference file** of the `bnbagent-studio` router skill — installed at `bnbagent-studio/references/` and loaded on demand (not a standalone skill). Route here via the router's decision tree.

# bnbagent-studio-adding-to-project

Procedure for adding `bnbagent-studio`'s **single selected-protocol seller** to an
**existing** Python repo. Audience: Claude Code (or another agent) running with
shell + edit access in the user's repo.

## The single seller runtime model (v1 workspace)

studio turns the user's existing valuable agent into a paid blockchain seller as
a **thin workspace root with one sub-project** under it:

- **Agent (`app/agent/` sub-project, → AWS Bedrock AgentCore).** The user's
  agent value (LLM / memory / tools / KB) AND the **sole key-holder/signer**.
  AgentCore runs the container with the selected protocol (A2A:
  `0.0.0.0:9000`; MCP: `0.0.0.0:8000/mcp`), so the Agent **serves directly** —
  it is its own public HTTPS surface, gated by a mandatory Cognito OAuth2
  authorizer. Owns its own `app/agent/pyproject.toml`, `app/agent/studio.toml`,
  and `.studio/.env.local`; the keystore lives at the WORKSPACE root
  `.studio/wallets/` (outside the AgentCore codeLocation, so no deploy packaging
  path can bundle it — at deploy it is injected via AWS Secrets Manager as
  `WALLET_KEYSTORE_JSON`). The outward surface is A2A's `SellerAgentExecutor`
  (`negotiate` / `notify_funded` skills) or MCP's FastMCP tools with the same
  bounded operations; ALL signing is fixed `app/agent/signing.py` code, never an
  LLM tool.

There is **no** second service: the Agent signs in-process and answers buyers
directly over its selected protocol. (The earlier two-layer split — an
invoke-only Agent plus a public keyless EC2 service relaying to it — was removed
once AgentCore could serve the protocol surface on a public endpoint; see
`docs/design/single-a2a-agent.md` for the A2A decision history.)

"Adding to an existing project" in v1 means **scaffolding a fresh workspace and
migrating your value into it** — `bag init` always creates a *new* workspace
directory (there is no in-place adoption); you then move your existing agent's
LLM / tools / memory code into the generated `app/agent/` sub-project.

v1 is **seller-only**; chat / buyer roles are deferred to v2.

## Preconditions

- The repo is a Python project (has `pyproject.toml` or at least an `app/` package).
- The user has Python 3.10+ and can install the `bnbagent-studio` CLI — `pip install bnbagent-studio` or `uv tool install bnbagent-studio` (auto-pulls the `bnbagent-studio-core` runtime lib); for local dev use editable installs from a monorepo clone (`pip install -e packages/bnbagent-studio-core -e packages/bnbagent-studio`, or `uv sync`).
- Network access to BSC testnet RPC (default: `https://data-seed-prebsc-1-s1.binance.org:8545`).

## Step 1 — Bootstrap studio config

Check for the v1 workspace layout — `app/agent/studio.toml` (not a root-level
`studio.toml`):

```bash
ls app/agent/studio.toml 2>/dev/null || echo MISSING
```

If missing, scaffold a new workspace. `bag init <name>` **always creates a new
directory `<name>/` under the current working directory** — it does not adopt the
current repo in place. Pick a workspace name, then migrate your existing agent's
value into the generated `app/agent/` sub-project (Step 4):

```bash
bag init my-agent && cd my-agent   # creates ./my-agent/ with the single app/agent/ sub-project
```

**Destination note:** while the trial campaign runs, bare `bag init` defaults to
`--destination platform` (the 48h managed-platform testnet trial — no AWS
account or `agentcore` CLI needed). Pass `--destination self` to deploy to
YOUR own AWS instead. Step 5 below branches on this choice.

Verify the workspace tree: `app/agent/studio.toml`, `.studio/.env.local`,
`.studio/wallets/` at the root, and `.gitignore` at root + sub-project. A
self-deploy scaffold additionally has `agentcore/agentcore.json` +
`agentcore/aws-targets.json`; a platform scaffold has NO `agentcore/` dir (the
operator owns the AgentCore project).

## Step 2 — Detect framework (best-effort)

```bash
bag scan
```

**v1 note**: `scan` is a stub — it just reports detected files. Don't rely on
its decisions; ask the user which framework they're using (ADK / Strands / custom
FastAPI) before emitting recipes.

## Step 3 — Emit the agent

A seller is the single Agent serving the selected protocol. `bag init` already
composes it from recipes — `agent` (the fixed-code `signing.py`),
`runtimes/agentcore` (A2A: `main.py` → `serve_a2a` + `seller_core.py` (the
protocol-neutral core; executor inherits it) + `executor.py` + `agent_card.py`;
MCP: `mcp_main.py`; shared `Dockerfile`),
`frameworks/<fw>` (`tools.py`), and the LLM provider recipe (`managed_model.py`).
Use `bag recipe code` to inspect or re-emit a piece:

```bash
bag recipe code agent              > /dev/null   # inspect; bag init writes app/agent/signing.py for you
bag recipe code runtimes/agentcore > /dev/null   # inspect; bag init writes the A2A serving files for you
```

In practice `bag init` already scaffolds `app/agent/`. Use `bag recipe code agent`
/ `bag recipe code runtimes/agentcore` to inspect or re-emit (auto-resolves
`{{PKG}}` from `[project].name` when run inside the project, or pass `--pkg <name>`
explicitly).

Gotcha: token is **U** (USD-pegged stablecoin on BSC), not BNB. All ERC-8183
amounts are denominated in U.

## Step 4 — Wire your existing agent's value into the Agent

The Agent sub-project (`app/agent/`) is where your existing valuable agent
lives. Move your LLM construction / tools / memory / KB wiring into it, and
implement the `run_work` developer hook (in `app/agent/seller_core.py` for A2A,
`app/agent/mcp_main.py` for MCP; called from `notify_funded`'s delivery) to
produce the deliverable. Read-only chain tools go in `app/agent/tools.py` (see
`bnbagent-studio-wiring-llm-tools`). ALL signing stays in `app/agent/signing.py` —
never expose a signing call as an LLM tool.

Tune the price in `app/agent/studio.toml` (`[payments.erc8183]` `min_price`/
`max_price`): the `negotiate` path is **rule-based, no LLM** — fixed code takes
the configured list price, clamps it to `[min_price, max_price]`, then
`signing.py` EIP-191-signs the offer. For per-task pricing, compute the price
from the request *before* clamping — the LLM still never sets the price. The
buyer anchors the signed envelope on-chain via `createJob` + `fund`.

## Step 4c — LLM credit continuity (automatic, NOT an LLM tool)

For Pieverse projects, the Agent's `build_model()` factory in the emitted
`app/agent/managed_model.py` returns a managed LiteLlm subclass. Its **automatic,
budget-gated auto-renew hook** (the framework-neutral logic lives in
`bnbagent_studio_core.pieverse.PieverseCreditEnsurer`; the framework shell is the emitted
file) tops up the active Pieverse key from the wallet (when
`[budget].enabled = true`) before an LLM call whose cached balance is below
`[llm.auto_renew].min_balance_usd`. The Agent keeps delivering jobs even if it
runs low mid-shift — the resilience is transparent.

Crucially this is **not** an LLM tool. It rides on the hardened x402 buyer
kernel (`bnbagent_studio_core.x402`, `X402Signer.sign_payment`) — but the Agent (the sole
key-holder) drives it transparently inside the managed model wrapper; the LLM
never decides to spend. The LLM-credit self-top-up you get for free is the
managed-model auto-renew hook described above.

If the budget gate is off / exhausted, the hook raises
`PieverseAccountBalanceExhaustedError` — let it surface so the buyer can dispute;
refill with `bag llm topup` or enable the budget with `bag budget enable`.

## Step 5 — Deploy the agent

`bag deploy` dispatches on `studio.toml [deploy].destination` (absent ⇒ self).

**Platform scaffold** (the bare-init default while the campaign runs) — one
command; first run does a GitHub device-flow login, the wallet key goes to the
operator's Secrets Manager (testnet-forced, use a throwaway wallet):

```bash
bag deploy agent                   # ship to the managed platform (48h testnet trial)
```

**Self-deploy scaffold** (`--destination self`) — the Agent serves the selected
protocol directly behind a mandatory Cognito authorizer; register
ERC-8004/8183 **last** with the deployed AgentCore endpoint:

```bash
bag deploy prepare                 # readiness sweep
bag deploy provision-cognito       # emits the Cognito CDK app you run (cdk deploy); wires discoveryUrl/clientId
bag deploy agent                   # ship the Agent to AgentCore (default --secrets-mode secretsmanager)
bag deploy verify                  # probe the endpoint + reconcile ERC-8004 identity
```

Gotcha: to serve external buyers, configure the Cognito authorizer
(`provision-cognito` → `cdk deploy --outputs-file` → `provision-cognito --wire`);
`bag deploy prepare` warns (W9) if unset but does NOT block. With no authorizer
the runtime is IAM/SigV4 owner-only (never anonymous) — external buyers without
AWS creds just can't reach it.

Gotcha: `dispute_window` is read from the on-chain policy contract (24h on
testnet). Buyers can dispute within that window after submit — the Agent can't
claim funds until the window closes.

## Step 6 — Verify

```bash
bag doctor    # run from workspace root; scans the agent sub-project
```

Should show green for: `app/agent/studio.toml` present, wallet decryptable (needs
`WALLET_PASSWORD` set in `.studio/.env.local`), RPC reachable, 8004 identity
registered (if applicable), LLM key present (if `[llm]` configured in
`app/agent/studio.toml`).

If anything is red, fix and re-run `bag doctor` before deploying.

## Step 7 — Smoke test the Agent locally

`bag dev` from the workspace root launches the Agent with the selected protocol.
Locally it runs without Cognito env, so the A2A card / MCP metadata is reachable
without a token:

```bash
bag dev               # A2A on :9000, or MCP on :8000/mcp
```

For A2A projects, in another shell, fetch the card and send a `negotiate` message
(`message/send` JSON-RPC with a single `DataPart`):

```bash
curl -s http://localhost:9000/.well-known/agent-card.json   # 2 skills: negotiate / notify_funded

curl -X POST http://localhost:9000/ \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"message":{"role":"user","parts":[{"kind":"data","data":{"skill":"negotiate","task_description":"summarize a webpage"}}]}}}'
```

The reply data part is the SDK `NegotiationResult` envelope, signed by the agent:
the quoted `price`, `currency`, and the signature fields (`negotiation_hash`,
`provider_sig`). The buyer anchors it on-chain via `createJob` + `fund`, then
sends a `notify_funded` message; the agent acks `accepted` at once and delivers in
the background, and the buyer reads the result from the chain (SUBMITTED →
`deliverable_url`). For MCP projects, connect an MCP client to
`http://localhost:8000/mcp`; `notify_funded` verifies, runs the work, and submits
synchronously inside the tool call (see `bnbagent-studio-selling-via-8183.md` (same directory) and
`docs/design/buyer-push-protocol.md`).

## Reference

- `docs/design/single-a2a-agent.md` (the A2A deploy model and history).
- `docs/design/buyer-push-protocol.md` (how a buyer drives a sale: negotiate → fund → notify_funded).
- `docs/design/decisions.md` (single seller runtime + protocol-choice decision records).
- `docs/design/architecture.md` (recipes, selected-protocol runtime, project layout — §2.5 / §9.2).
- `bnbagent-studio-selling-via-8183.md` (same directory) — the runtime seller flow (negotiate/notify_funded/settle, disputes).
