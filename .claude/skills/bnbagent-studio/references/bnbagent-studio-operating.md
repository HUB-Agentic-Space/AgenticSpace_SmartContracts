---
name: bnbagent-studio-operating
description: When the user wants to run, debug, diagnose, or operate a bnbagent-studio agent project. Covers dev server, doctor checks, balance/RPC queries, job status reads, and incident triage — including driving the native `agentcore` CLI (dev / status / logs / traces / invoke), twak-wallet issues, and `PolicyViolation` / `X402PolicyError` signing-policy errors (deep-dive playbooks for those ship as references of the `bnbagent-studio` router skill; read them on demand).
---

> **Reference file** of the `bnbagent-studio` router skill — installed at `bnbagent-studio/references/` and loaded on demand (not a standalone skill). Route here via the router's decision tree.

# bnbagent-studio-operating

Procedure for **day-to-day operation** of an existing bnbagent-studio project.
Audience: Claude Code in a v0.0.1 workspace (thin root with the `agentcore/`
config dir + the workspace-root `.studio/wallets/` + funded wallet, plus the
single sub-project `app/agent/` holding `studio.toml` + `main.py` /
`seller_core.py` / `executor.py` / `agent_card.py` / `signing.py`). Most commands run from the
workspace root; the v0.0.1 `find_project_root()` fallback locates the
`app/agent/` sub-project automatically for wallet/LLM/budget ops.

**Different from**:
- `bnbagent-studio-scaffolding-agent.md` (in this same references/ directory) — creates a brand new project
- `bnbagent-studio-selling-via-8183.md` (in this same references/ directory) — seller flow (`run_work` value, rule-based quote pricing, dispute defense)
- `funding-pieverse-llm` (project-scope skill, Pieverse projects only) — Pieverse credit lifecycle / topup decisions

**Deep-dive references** — plain markdown files in this SAME references/
directory (Claude Code: `~/.claude/skills/bnbagent-studio/references/`; Cursor:
`bnbagent-studio/references/` beside the `.mdc` rules). READ
the file when the topic comes up — don't answer from memory:
- `bnbagent-studio-use-aws-agentcore.md` — the native `agentcore` CLI (dev / deploy / status / invoke / logs / traces / fetch / validate / stop) + AWS prerequisites
- `bnbagent-studio-using-twak-wallet.md` — `[wallet].kind = "twak"` create / fund / SIWE-bind / container deploy / limitations
- `bnbagent-studio-extending-signing.md` — `PolicyViolation` / `X402PolicyError` diagnosis + extending the EIP-712 allowlist
- `bnbagent-studio-adding-to-project.md` — adding the seller runtime to an existing Python project
- `bnbagent-studio-buying-via-8183.md` — buyer flow (find provider → buy → fetch → settle)

This playbook covers **generic ops**: dev / doctor / balances / RPC / incident triage.
For seller job-lifecycle decisions (settle / submit / dispute defense), read
`bnbagent-studio-selling-via-8183.md` (same directory); for the buyer side, read the buying reference.

## Quick triage decision tree

| User said... | Run first |
|---|---|
| "is it healthy?" / "doctor" | `bag doctor` (scans the `app/agent/` sub-project from the workspace root) |
| "run locally" / "start it" / "dev" | `bag dev` (serves the selected protocol: A2A on `:9000`, MCP on `:8000/mcp` — same for any destination) |
| "what's my balance?" / "how much U?" | `bag wallet balance` (native + U; `--network X` / `--all` available. `--address X` is **v0.2 backlog — not in v0.0.x**) |
| "send X tBNB / U to another address" | ⚠️ **v0.2 backlog — `bag wallet transfer` does not exist in v0.0.x.** No transfer CLI yet; move funds with an external wallet |
| "approve commerce contract to spend U" | ⚠️ **v0.2 backlog — `bag erc20` group does not exist in v0.0.x** (funding flows auto-approve U; no manual approve CLI) |
| "how much have I approved 0x... for?" | ⚠️ **v0.2 backlog — `bag erc20 allowance` does not exist in v0.0.x** |
| "is my agent registered?" | `bag erc8004 show` (note: registration is normally automatic at `bag deploy verify` — manual `bag erc8004 register` only if you need an identity before deploy) |
| "what's the status of job X?" | `bag erc8183 status <id>` (read-only — neutral) |
| "settle job X" | `bag erc8183 settle <id> --action approve\|reject\|dispute` (default `approve`) — **seller's manual step** after the dispute window; deeper context in `bnbagent-studio-selling-via-8183.md` (same directory) |
| "submit work for job X" | **seller action** — read `bnbagent-studio-selling-via-8183.md` (same directory) for the submit/dispute flow |
| "tx not confirming" | Read BscScan link from prior tx output + check `eth_getTransactionCount` |
| "wallet balance is wrong" | Check both tBNB (gas) and U (token); see balance section |
| "is it deployed?" / "deploy status" / "deploy logs" / "tear it down" | `bag deploy {status,logs,destroy}` — **destination-aware**: they work for both `self` (your AWS/Azure) and the `platform` managed trial, dispatching on `studio.toml [deploy].destination`. For a platform-destined project, `bag platform {whoami,agents,credit}` inspects the trial account + the remaining 48h countdown |

## Common ops procedures

### A. Run the agent locally (the default)

```bash
# Configure secrets (idempotent — does NOT duplicate existing keys).
# These write into .studio/.env.local (the Agent's secrets):
bag env set WALLET_PASSWORD <your password>
bag env set OPENROUTER_API_KEY <your key>   # or whichever provider app/agent/studio.toml [llm] uses

# From the workspace root — `bag dev` serves the selected protocol:
bag dev                # A2A agent on :9000, MCP on :8000/mcp (same for any destination)
bag dev --port 9100    # override the port
```

`bag dev` sets `STORAGE_LOCAL_PATH=~/.bag/deliverables/<workspace-name>/` for the
agent subprocess and runs it **without** Cognito env, so the local endpoint is
reachable without a token (Cognito is mandatory only on the deployed AgentCore
runtime). For A2A projects, the agent
(`app/agent/main.py` → `serve_a2a`) exposes `/.well-known/agent-card.json` +
JSON-RPC `message/send` + `GET /ping` on `:9000`. Smoke-test the card with curl:

```bash
curl http://localhost:9000/.well-known/agent-card.json
```

Expect the agent card with its two skills (`negotiate`, `notify_funded`).
For MCP projects, connect an MCP client to `http://localhost:8000/mcp`.

> ⚠️ **The AgentCore inspector chat box cannot test a seller agent.** A seller's
> skills are structured A2A `DataPart`s (`message/send`), but the inspector chat
> box can only send plain text — it can never construct a `{"skill":"negotiate", …}`
> part, so it can't reach the agent's real product surface (and its streaming view
> expects Task events, not the `message` reply the agent emits). **Test locally
> with curl or an A2A client sending a `DataPart`**, not the chat box.

Drive a sale by sending the skills directly (`negotiate` `terms` MUST include
`deliverables` + `quality_standards`, else the quote is rejected `reason_code 0x04`):

```bash
# negotiate → signed quote envelope
curl -s -X POST http://localhost:9000/ -H "Content-Type: application/json" -d '{
  "jsonrpc":"2.0","id":1,"method":"message/send",
  "params":{"message":{"role":"user","parts":[{"kind":"data","data":{
    "skill":"negotiate",
    "task_description":"...",
    "terms":{"deliverables":"...","quality_standards":"..."}
  }}],"messageId":"nego-1"}}}'

# notify_funded → ack (then background delivery; poll the chain for the result)
curl -s -X POST http://localhost:9000/ -H "Content-Type: application/json" -d '{
  "jsonrpc":"2.0","id":2,"method":"message/send",
  "params":{"message":{"role":"user","parts":[{"kind":"data","data":{
    "skill":"notify_funded","job_id":<int>
  }}],"messageId":"notify-1"}}}'
```

See `buyer-push-protocol.md` for the full line protocol. Ctrl-C to stop.

### B. Doctor — full project health

```bash
bag doctor
```

Returns a rich table of checks across the `app/agent/` sub-project:

| Check | What FAIL means | Fix |
|---|---|---|
| app/agent/studio.toml parseable | Missing or syntax error | `bag init` to regenerate, or hand-fix TOML |
| Agent entrypoint imports | Protocol entrypoint raises on import (`main.py` for A2A, `mcp_main.py` for MCP) | Fix the traceback printed by the check (often a missing env var or relative import) |
| wallet keystore | No `<workspace>/.studio/wallets/*.json` | `bag wallet new` (writes to the workspace root keystore dir) |
| WALLET_PASSWORD env | Not in `.studio/.env.local` / not exported | `bag env set WALLET_PASSWORD ...` (targets .studio/.env.local) |
| LLM provider key | API key env not set | Edit `.studio/.env.local` or export the right `*_API_KEY` |
| Network reachable | RPC down/wrong URL | Override via `STUDIO_BSC_TESTNET_RPC=...` (testnet) / `STUDIO_BSC_RPC=...` (mainnet) — per-network env vars read by `bnbagent_studio_core.networks.get_network` |
| Wallet tBNB balance | 0 tBNB | Faucet: testnet.bnbchain.org/faucet-smart |
| Wallet U balance | 0 U | Transfer from holder, or ask for sponsor U |
| 8004 registered | Not registered | Normally registered automatically at `bag deploy verify`. Manual: `bag erc8004 register --endpoint <url>` (only if you need an on-chain identity before deploy). WARN-only in `bag doctor` — it doesn't block local dev. |
| Cognito authorizer (W9) | External-buyer readiness: `agentcore.json` carries no `authorizerConfiguration` / protocol metadata has placeholder `OAUTH_*` values | WARN-only (does NOT block) — needed to serve **external** buyers, not to deploy. With no authorizer the runtime is IAM/SigV4 owner-only (never anonymous). To open it to buyers: `bag deploy provision-cognito` → `cdk deploy --outputs-file cdk-outputs.json` → `bag deploy provision-cognito --wire`. |

WARN-only items don't block; FAIL items do (exit 1).

### C. Balance / wallet inspection

```bash
bag wallet show     # local view: address + keystore path (workspace root .studio/wallets/)
bag wallet list     # all keystores in <workspace>/.studio/wallets/
```

For on-chain balance of the configured wallet (BNB + U):

```bash
bag wallet balance                       # [network].default — BNB + U
bag wallet balance --network bsc-mainnet # override to a specific network
bag wallet balance --all                 # both [network].default AND [llm.pieverse].network
```

The `--all` form is the right move when `app/agent/studio.toml`'s
`[network].default = bsc-testnet` and `[llm].provider = pieverse-llm`:
testnet U pays ERC-8183 jobs, mainnet U pays the Pieverse LLM auto-renew.
Same wallet address on both chains.

> ⚠️ **v0.2 backlog — not in v0.0.x.** There is **no** `bag wallet transfer`,
> no `bag erc20 approve/allowance` group, and no `bag wallet balance --address`
> / `--token` flag in v0.0.x — running any of them errors with
> `invalid choice` / `unrecognized arguments`. To move funds or set allowances
> today, use an external wallet; ERC-8183 funding auto-approves U as part of the
> buy flow. These CLIs are planned for v0.2.

For programmatic access from inside an agent's code, the MCP tools (when wired
into Claude Code) provide `balance_u` / `balance_native` as well — but the CLI
is the fastest path during dev.

### D. Job state inspection (8183)

```bash
bag erc8183 list --mine                    # all jobs where I'm the client
bag erc8183 list --provider 0xPROV         # jobs I could serve as seller
bag erc8183 status <job_id>                # one job's full record
```

JobStatus enum: `OPEN` (0) → `FUNDED` (1) → `SUBMITTED` (2) → `COMPLETED` (3) /
`REJECTED` (4) / `EXPIRED` (5).

`FUNDED` jobs are what the deployed agent delivers — either when the buyer sends a
`notify_funded` A2A message (the agent acks then delivers in the **background**;
read the result from the chain) or via the deduped background sweep on the next
notify (see `buyer-push-protocol.md`). While background work is in flight the
runtime stays warm via `/ping` `HEALTHY_BUSY`; a scaled-to-zero idle agent won't
deliver until the next notify (a v2 Lambda poller closes that cold window).
`SUBMITTED` jobs trigger the **buyer decision
tree** (approve / dispute / reject within the dispute window) — full flow in the
`bnbagent-studio-buying-via-8183.md` reference (see the Deep-dive references
list above). From the seller side, defending a dispute is
covered in `bnbagent-studio-selling-via-8183.md` (same directory).

### E. Common errors + remediation

| Error pattern | Cause | Fix |
|---|---|---|
| `Submission deadline has passed` | Buyer set `expiredAt` too soon (< dispute_window) | Use `--deadline-min` ≥ 1 (workflow auto-adds dispute_window now) |
| `Transaction would revert: ('0x17be5b7b', ...)` | Trying to `settle approve` before dispute_window | Wait 24h or use `--action dispute` |
| `notify_funded` replies `{"status":"rejected","reason":...}` | `verify_signed_job` failed synchronously in the ack — a **permanent** failure | `reason` names it: not our signature / tampered terms / underfunded / expired (or `error` for a malformed `job_id`). The job is refused outright; re-fund/re-notify with a correct, fully-funded job |
| Job stays `FUNDED`, never reaches `SUBMITTED` after an `accepted` ack | Background delivery failed (`run_work` / `submit_result` raised) — **not** visible in the A2A reply | The ack only confirms verify passed; delivery runs in the background. Observe the failure via the chain (job never leaves `FUNDED`) + CloudWatch logs; a later `notify_funded` re-attempts it via the sweep |
| `cannot import name 'ERC8183JobOps' from 'bnbagent'` | pyproject pinned an old `bnbagent` (missing class) | Bump to `>=0.4.0` |
| `OPENROUTER_API_KEY env var is required` | LLM module imports trigger the emitted `build_model()` factory | Set the env var even for `bag dev --help` smoke |
| RPC `limit exceeded` | Public RPC throttle | Retry, or set `STUDIO_BSC_TESTNET_RPC=<private rpc>` |

## Reference

- `docs/design/single-a2a-agent.md` (the A2A deploy model and history)
- `docs/design/buyer-push-protocol.md` (how a buyer drives an A2A sale)
- `docs/design/architecture.md §2.5` (the single seller runtime — as-built truth)
