---
name: bnbagent-studio-buying-via-8183
description: When the user is acting as ERC-8183 buyer — finding a provider, getting a quote, buying a service, fetching the deliverable, and deciding to approve / dispute / reject the work. Owns the buyer-side decision tree for the entire job lifecycle including settle-window timing (24h dispute window), dispute governance flow, and `Submission deadline has passed` recovery.
---

> **Reference file** of the `bnbagent-studio` router skill — installed at `bnbagent-studio/references/` and loaded on demand (not a standalone skill). Route here via the router's decision tree.

# bnbagent-studio-buying-via-8183

> **v1 scope note:** v1 is **seller-only** — buyer flows are **NOT**
> the main v1 payment path. The x402 buyer kernel survives only as the Agent's
> *automatic* LLM top-up (`bnbagent_studio_core.x402`, budget-gated, not an LLM tool),
> and the erc8183 `buy_workflow` survives as an **underlying capability** still
> reachable via the `bag erc8183 buy/status/fetch/settle` CLI. Full buyer-side
> *product* flows (a buyer agent, buyer-side negotiation wrapping) are deferred
> to v2. The CLI procedure below still works for manual / testing use.

Procedure for **buyer-side flow**: have your agent (or you directly via CLI)
purchase a service from another ERC-8183 seller, verify the deliverable, and
close out the job with the right `settle` action.

Audience: Claude Code in a v0.0.x workspace with a funded wallet (tBNB + U).
The buying CLI (`bag erc8183 buy/status/fetch/settle`) targets the **Agent
sub-project's** wallet — these commands resolve to `<workspace>/app/agent/`
automatically (via `find_project_root()`) when run from the workspace root.

> **Protocol facts** (independent of the local filesystem layout): 24h dispute
> window, `0x17be5b7b` revert, `expired_at` arithmetic.

**Different from**:
- `bnbagent-studio-operating.md` (same directory) — generic ops (dev / doctor / balance / RPC); jumps here for buyer-specific decisions
- `bnbagent-studio-adding-to-project` — covers wiring buyer `@tool` set into an existing project (the static setup, not the runtime decisions)
- `bnbagent-studio-selling-via-8183.md` (same directory) — the mirror playbook for the seller side (`on_job`, dispute defense)

This skill owns: **buy → fetch → approve/dispute/reject loop**, whether
driven via CLI or the agent's LLM calling `erc8183_buyer_set` tools.

## Buyer settle decision tree (load this skill when the user hits any of these)

`SUBMITTED` job → buyer has three options, **time-gated by the on-chain dispute window**:

| Action | Allowed | What happens |
|---|---|---|
| `bag erc8183 settle <id> --action approve` | **After 24h dispute_window has passed** (chain enforces; reverts with `0x17be5b7b` if early) | Job → `COMPLETED`; seller receives U |
| `bag erc8183 settle <id> --action dispute` | **Within dispute_window** | Opens governance flow; quorum vote decides; refund possible |
| `bag erc8183 settle <id> --action reject` | **Only if you're a quorum voter, not the buyer** | Job → `REJECTED` via governance |

If the buyer agent (or LLM) is about to call `settle --action approve` and it's
been <24h since SUBMITTED, **wait** or use `dispute`. Don't try to retry
through the revert — read the error and pick the right action.

Common error: `Submission deadline has passed` → buyer set `expiredAt` too
short (< dispute_window). Fix: re-buy with `--deadline-min ≥ 1` (the buyer
@tool now auto-adds dispute_window).

## Preconditions

- `bag doctor` is clean (or only warns on LLM key)
- Wallet has ≥ 0.05 tBNB (gas) and ≥ 0.2 U (token + slack). On BSC testnet the
  ERC-8183 kernel writes (`create_job` / `fund` deposit / `settle` …) are
  gas-sponsored via the SDK's MegaFuel paymaster, so you spend far less tBNB than
  that — but **not zero**: `fund` sends an ERC-20 `approve` (a token call, not
  sponsored) when the token allowance is too low — typically just the first fund,
  since studio approves a floored cap that later jobs reuse. Keep a little tBNB for
  it. (Mainnet is never sponsored.)
- You know the **provider's wallet address** (the seller agent's address)
- The seller is **reachable** (its A2A agent is deployed somewhere); discoverable
  via the provider's `bag erc8004 resolve <agent_id>` endpoint URI

## Stage 1 — Pre-flight checks

```bash
# 1. Confirm wallet + balances
bag wallet show
bag doctor       # tBNB + U checks should be PASS

# 2. Confirm the provider's 8004 record (optional but recommended)
bag erc8004 resolve <provider_agent_id>
# → returns the agent_uri; decode it (base64 data: URI) to verify the endpoint URL
```

If the provider's endpoint URL points somewhere reachable (e.g. an `https://`
AgentCore runtime URL), proceed. If it's `http://localhost:...`, that means you
must be on the same host.

## Stage 2 — (Optional) Negotiate price

**v0.0.x**: bnbagent_studio_core *does* wrap the buyer-side negotiation handshake
(`bnbagent_studio_core.erc8183.negotiate.negotiate_with_seller`, wired into
`buy_workflow`). It fires automatically when you buy by `--agent-id` (resolves
the seller's endpoint from its ERC-8004 record, then POSTs `/negotiate`); pass
`--no-negotiate` to skip it. When you buy by `--provider <addr>` you supply the
budget directly and assume the price was agreed off-chain.

If you want to talk to the seller manually, the seller now exposes its
`negotiate` skill over **A2A** (the seller's ERC-8004 endpoint URI is an A2A base
URL): send an A2A `message/send` JSON-RPC call carrying a `DataPart`
`{"skill": "negotiate", "task_description": "...", "terms": {...}}` (+ the seller's
OAuth2 Bearer when deployed). The reply data part is the signed `NegotiationResult`
quote. But you don't need this for v0.0.x — go straight to buy.

## Stage 3 — Buy

```bash
bag erc8183 buy --provider <provider_addr> "<task description>" \
  --budget-u <amount>           \  # capped by policy.budget_cap_u
  --deadline-min <minutes>      \  # default 30; this is the seller's submission window
  --network bsc-testnet
# provider is a REQUIRED flag (--provider <addr> OR --agent-id <id>), not a positional;
# `--agent-id` resolves the endpoint + negotiates first.
```

> **Task can be passed two ways** (both accepted): as a positional argument
> `bag erc8183 buy --provider <addr> "<task>"` OR via the flag
> `bag erc8183 buy --provider <addr> --task "<task>"`. Pass it once — supplying
> both at the same time is an error.

The 4 on-chain steps run sequentially:

1. `create_job(provider, expired_at, description)` → returns `job_id`
2. `register_job(job_id, policy=None)`
3. `set_budget(job_id, raw_budget)`
4. `fund(job_id, raw_budget, approve_floor=raw_budget)` — auto-approves U

Output prints 4 tx hashes + `job_id`. Note the `job_id` for later.

**Gotcha**: `expired_at = now + deadline_minutes*60 + dispute_window` (24h). This
is intentional — the chain enforces that submission must happen before
`expired_at - dispute_window`. If you set `deadline_minutes=30`, the seller has
30 min to submit (then a 24h dispute window starts).

## Stage 4 — Wait for SUBMITTED

The single seller runtime has **no standalone poller** — after funding, send a
`notify_funded` A2A message to the seller ("I funded job X, please deliver"). The
seller **acks `accepted` immediately and delivers in the background**, so you do
**not** get the deliverable in the A2A reply — you poll the chain for it. The
seller also sweeps other funded jobs on each `notify_funded` (in the background,
deduped). Check status:

```bash
bag erc8183 status <job_id>
```

Statuses:

- `OPEN` → not yet funded (shouldn't see this after Step 3)
- `FUNDED` → waiting for seller to pick up + submit
- `SUBMITTED` → ready to fetch + settle
- `EXPIRED` → seller missed the deadline; use `bag erc8183 settle --action ...` or
  the SDK's `mark_expired` / `claim_refund`

Delivery is no longer instant: because the seller works in the background, the
wait is however long its work takes (seconds to minutes). Poll until `SUBMITTED`,
then read `deliverable_url` (Stage 5). If it stays `FUNDED`, either no one sent
`notify_funded` (and the sweep hasn't run — the seller may be scaled to zero), or
the seller's background work failed or hasn't finished yet — re-send
`notify_funded` to nudge it while the runtime is warm. (Also possible: a config
mismatch, most often `expired_at` too soon — but the workflow auto-fixes this now.)

## Stage 5 — Fetch the deliverable

The single seller runtime serves **no** job-query endpoint — the deliverable is read
back from the on-chain submission (the `submit` tx carries the `deliverable_url`,
typically `ipfs://...`) and the IPFS object. Get the URL via CLI:

```bash
bag erc8183 fetch <job_id>
```

Prints the `deliverable_url`. Fetch it yourself (e.g. via an IPFS gateway) to read
the `DeliverableManifest`: `{"chain_id", "contracts", "job_id", "response": {"content": ..., "content_type": ...}, "metadata": {...}}`.

## Stage 6 — Settle

```bash
# Happy path: accept the deliverable. NOTE: must wait 24h dispute_window first.
bag erc8183 settle <job_id> --action approve

# Bad deliverable: dispute (within dispute_window, no wait needed)
bag erc8183 settle <job_id> --action dispute

# (rare) you're a quorum voter and want to reject:
bag erc8183 settle <job_id> --action reject
```

Returns a tx hash. Verify on BscScan.

**On `--action approve` revert with `0x17be5b7b`**: chain refuses because
`submitted_at + dispute_window > now`. Either wait the remaining time or
use `--action dispute` for immediate effect.

## Stage 7 — Verify on-chain settlement

```bash
bag erc8183 status <job_id>
# Expect: status COMPLETED (after approve) or unchanged SUBMITTED (after dispute, until voters resolve)
```

Check seller's U balance increased (minus platform fee — see `CommerceClient.platform_fee_bp()`).

## End-to-end smoke (one-shot, for testing your setup)

```bash
# Buyer side (this assumes the seller's A2A agent is already deployed somewhere)
PROVIDER=<seller_address>
JOB=$(bag erc8183 buy --provider $PROVIDER "test task" --budget-u 0.5 | awk -F': *' '/job_id:/{print $2; exit}')
# send a `notify_funded` A2A message to the seller for that JOB (buyer-push),
# then poll the chain (the seller acks at once and delivers in the background):
sleep 60
bag erc8183 status $JOB
bag erc8183 settle $JOB --action dispute
```

This is the exact end-to-end flow used to validate real-chain buying. See the
references below for the canonical picture.

## Reference

- `docs/design/erc8183-sdk-reference.md` (SDK surface map / negotiation envelope)
- `docs/design/single-a2a-agent.md` + `docs/design/buyer-push-protocol.md` (the v1 single-agent model + buyer-push flow)
- `docs/guides/verification.md` (manual on-chain verification)
