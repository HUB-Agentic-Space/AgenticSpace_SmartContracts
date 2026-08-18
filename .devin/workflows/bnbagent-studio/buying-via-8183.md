---
description: When the user is acting as an ERC-8183 buyer — finding a provider, negotiating a quote, funding a job on-chain, notifying the seller agent, fetching the deliverable, and deciding whether to approve, dispute, or reject the submitted work.
---

> **Playbook** of the `bnbagent-studio` workflow — at `.devin/workflows/bnbagent-studio/buying-via-8183.md`. Route here via the router's decision tree.

# bnbagent-studio-buying-via-8183

Procedure for the **buyer flow**: find a provider → `negotiate` → `fund` →
`notify_funded` → fetch the deliverable → `settle` (approve / dispute / reject).

Audience: Windsurf in a working repo with a funded wallet (tBNB + U).

**Different from**:
- `selling-via-8183.md` (same directory) — the seller side (implementing value, quoting, delivering, defending disputes)
- `buying-from-bazaar.md` (same directory) — buying flat pay-per-call x402 APIs (no job lifecycle)

## Preconditions

- `bag doctor` is clean
- Wallet has tBNB (gas) + U (payment token, 18 decimals)
- You know the provider's agent address (from ERC-8004 lookup or direct)

## Step 1 — Find a provider

```bash
bag erc8004 show --agent-id <id>          # by numeric ID
bag erc8004 show --address 0xPROV         # by owner address
bag erc8004 list                          # browse registered agents
```

The ERC-8004 record includes the provider's `AgentEndpoint` (A2A card URL or
MCP `/mcp` URL). For A2A, fetch the card to see advertised skills:

```bash
curl -s https://<provider-endpoint>/.well-known/agent-card.json
```

## Step 2 — Negotiate (get a signed quote)

For A2A providers, send a `negotiate` skill message via `message/send` JSON-RPC:

```bash
curl -X POST https://<provider-endpoint>/ \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"message":{"role":"user","parts":[{"kind":"data","data":{
    "skill":"negotiate",
    "task_description":"summarize this webpage: https://example.com",
    "terms":{"deliverables":"a 200-word summary","quality_standards":"factual accuracy"}
  }}],"messageId":"nego-1"}}}'
```

The reply data part is the SDK `NegotiationResult` envelope: `price`, `currency`,
`negotiation_hash`, `provider_sig`, `valid_until`, `chain_id`, `verifying_contract`.

> **`terms` MUST include `deliverables` + `quality_standards`.** Without them the
> quote is rejected `reason_code 0x04` (missing required fields). This is a
> protocol-level guard, not a studio opinion.

For MCP providers, connect an MCP client and call the `negotiate` tool with the
same fields.

## Step 3 — Fund the job on-chain

```bash
bag erc8183 buy \
  --provider 0xPROV \
  --negotiation-hash <hash> \
  --price <price_in_wei> \
  --currency <token_addr> \
  --provider-sig <sig> \
  --task-description "..." \
  --deliverables "..." \
  --quality-standards "..." \
  --deadline-min 60
```

This calls `createJob` + `register` + `setBudget` + `fund` on-chain. The job is
now `FUNDED` and the provider can deliver.

> **`--deadline-min` is the seller's submission window.** The on-chain job
> lifetime is automatically `deadline_minutes + 24h dispute_window`. Use ≥ 60
> minutes for real work.

## Step 4 — Notify the seller agent

For A2A providers, push a `notify_funded` message so the agent starts delivery:

```bash
curl -X POST https://<provider-endpoint>/ \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"message/send","params":{"message":{"role":"user","parts":[{"kind":"data","data":{
    "skill":"notify_funded",
    "job_id": <int>
  }}],"messageId":"notify-1"}}}'
```

The agent acks `accepted` immediately (A2A) and delivers in the background. For
MCP, the `notify_funded` tool call runs work synchronously and returns the result.

> **The agent also sweeps for FUNDED jobs on every `notify_funded`.** If you
> funded on-chain but forgot to notify, the next notify from any buyer triggers
> a sweep that catches your job. But don't rely on this — always notify.

## Step 5 — Fetch the deliverable

Poll the chain for job status:

```bash
bag erc8183 status <job_id>
```

When status reaches `SUBMITTED`, the on-chain record carries a
`deliverable_url` (IPFS CID or other URI). Fetch it:

```bash
bag erc8183 fetch <job_id>
```

This reads the deliverable content from the submitted URL.

## Step 6 — Settle (approve / dispute / reject)

After reviewing the deliverable, within the `dispute_window` (24h on testnet):

```bash
bag erc8183 settle <job_id> --action approve    # accept the work → funds release to seller
bag erc8183 settle <job_id> --action dispute    # reject → goes to quorum vote
bag erc8183 settle <job_id> --action reject     # reject → funds return to buyer
```

> **You cannot `approve` before the dispute window elapses.** The contract
> reverts with `0x17be5b7b` if you try. Wait 24h (testnet) or use `dispute` /
> `reject` within the window.

If you do nothing, the job auto-completes after the dispute window + settle
window, releasing funds to the seller.

## Job status reference

| Status | Code | Meaning |
|---|---|---|
| `OPEN` | 0 | Job created, not yet funded |
| `FUNDED` | 1 | Budget deposited, provider can deliver |
| `SUBMITTED` | 2 | Provider submitted deliverable, buyer review window open |
| `COMPLETED` | 3 | Settled (approved or auto-completed) — funds released |
| `REJECTED` | 4 | Buyer rejected — funds returned |
| `EXPIRED` | 5 | Deadline passed without submission |

## Common errors + remediation

| Error | Cause | Fix |
|---|---|---|
| `negotiate` reply `reason_code 0x04` | Missing `deliverables` or `quality_standards` in `terms` | Add both fields to the `terms` object |
| `createJob` reverts | Quote signature invalid or expired | Re-negotiate; check `valid_until` |
| `fund` reverts | Insufficient U allowance or balance | Check `bag wallet balance`; fund wallet |
| Job stays `FUNDED`, never `SUBMITTED` | Provider didn't deliver (agent down, work failed) | Wait for deadline → job expires → funds return |
| `settle approve` reverts `0x17be5b7b` | Dispute window hasn't elapsed | Wait 24h (testnet) |
| `settle dispute` after window | Dispute window closed | Can only `approve` or wait for auto-complete |

## Reference

- `docs/design/buyer-push-protocol.md` — full A2A line protocol
- `selling-via-8183.md` (same directory) — the seller's perspective
- `buying-from-bazaar.md` (same directory) — x402 pay-per-call (no job lifecycle)
