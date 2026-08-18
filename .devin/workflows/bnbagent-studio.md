---
description: The single entry point for bnbagent-studio — a Python CLI (bag) for building a blockchain SELLER agent that earns $U on BNB Chain via ERC-8004 + ERC-8183 + x402. Load this workflow whenever the user works in a bnbagent-studio / bag project, or wants to create/scaffold, deploy, run, debug, operate, or monetize such a seller agent.
---

# bnbagent-studio (the single entry point)

`bnbagent-studio` (CLI: `bag`) wires the `bnbagent-sdk` protocol layer (wallet /
ERC-8004 / ERC-8183 / Pieverse LLM) into a Python agent project, then deploys it
as a **single blockchain seller runtime**. A2A is the default protocol and MCP is
selectable at scaffold time. Where it deploys is `studio.toml
[deploy].destination`: `platform` (the init default while the trial campaign
runs) hosts it on the BNB Chain managed platform as a 48h testnet trial; `self`
runs it in **your own** AWS Bedrock AgentCore. Goal: a valuable agent earns $U
on BNB Chain with a few CLI commands + recipe-emitted files; the user's project
remains portable.

## Usage

Type `/bnbagent-studio <ask>` to route the user's intent through the decision tree.

## Examples

- `/bnbagent-studio create a new seller agent`
- `/bnbagent-studio deploy my agent`
- `/bnbagent-studio debug my agent`
- `/bnbagent-studio add wallet to existing project`

## The single seller runtime model (the invariants)

One deployed runtime, one signer: a single valuable Agent serves the selected
protocol directly (A2A `serve_a2a` on `:9000`, or MCP FastMCP on `:8000/mcp`),
holds the key, and signs in-process. Its outward surface is exactly two bounded
operations — **`negotiate`** (rule-based price clamp + EIP-191 sign; **no LLM
touches money**) and **`notify_funded`** (verify the funded job → produce the
deliverable → submit on-chain; A2A acks then delivers in the background, MCP
delivers synchronously in the tool call) — plus read-only chain tools. ALL
signing is fixed entrypoint code in `app/agent/signing.py`, never an
LLM-callable tool. The encrypted keystore lives at the workspace root
`.studio/wallets/`, outside the deploy codeLocation, injected only via Secrets
Manager at deploy. `settle` is manual (`bag erc8183 settle`).

## Decision tree — which playbook to read next

**Playbooks are plain markdown files in this workflow's subdirectory** at
`.devin/workflows/bnbagent-studio/<name>.md`. When a row matches, READ THAT FILE
before acting — do not answer from memory.

| User intent | Read |
|---|---|
| Create a brand new single seller project from zero | `bnbagent-studio/scaffolding-agent.md` |
| Add wallet / the single seller runtime to an existing Python agent | `bnbagent-studio/adding-to-project.md` |
| Run / debug / dev / doctor / RPC / balance / incident triage | `bnbagent-studio/operating.md` |
| Implement what the Agent sells, tune pricing, publish over A2A or MCP, defend disputes (seller flow) | `bnbagent-studio/selling-via-8183.md` |
| Deploy: read `studio.toml [deploy].destination` FIRST | `platform` → run `bag deploy agent`. `self` or absent → read `bnbagent-studio/use-aws-agentcore.md` |
| Wire chain-read tools into the Agent's LLM (ADK / LangChain / AutoGen / Agno / etc.) | `bnbagent-studio/wiring-llm-tools.md` |
| Buy a service from another ERC-8183 seller via CLI | `bnbagent-studio/buying-via-8183.md` |
| Give the agent a PAID x402 capability (CMC / Bazaar / any pay-per-call API) | `bnbagent-studio/buying-from-bazaar.md` |
| Extend the EIP-712 signing allowlist (custom contract / new x402 service / diagnose PolicyViolation) | `bnbagent-studio/extending-signing.md` |
| Project uses `[wallet].kind = "twak"` (create / fund / SIWE-bind / container deploy) | `bnbagent-studio/using-twak-wallet.md` |

If two or more match, read both — they're designed to be orthogonal.

## 5 core commitments (always honor)

1. **Agent project code is user-owned** — recipe-emitted files are theirs to edit; studio doesn't auto-rewrite them.
2. **Private keys live in a user-controlled environment, never transmitted to studio or third parties** — the encrypted keystore lives at the workspace root, outside the deploy codeLocation, and is injected only into the user's own single agent via AWS Secrets Manager at deploy.
3. **Signing is fixed handler code, never an LLM-callable tool** — A2A and MCP expose only bounded `negotiate` / `notify_funded` flows; raw/arbitrary signing is never exposed.
4. **SDK protocol layer stays pure** — studio's opinions don't pollute `bnbagent-sdk`.
5. **The user can jump ship at any point** — emitted code is theirs to edit / fork / migrate; studio depends on no closed SaaS.

## CLI groups at a glance

`init`, `scan`, `recipe`, `skills`, `wallet`, `erc8004`, `erc8183`, `x402`, `agents`, `config`, `env`, `dev`, `doctor`, `audit`, `deploy`, `platform`, `llm`, `bundle`, `budget` — see `bag --help` for details.

## Tool surface

- **CLI** — write-side (wallet ops, on-chain register, x402 buy, deploy)
- **MCP** — an external seller protocol (`bag init --protocol MCP`), peer to A2A
- **`bnbagent_studio_core.tools.chain_readonly`** — 15 pure functions, wrapped into LLM tools by the chain-tools recipe (read `bnbagent-studio/wiring-llm-tools.md`)

## Installation (Linux)

```bash
pip install bnbagent-studio --break-system-packages
bag skills install --scope project
```

See `smartcontracts/docs/bnbagent-studio-install.md` for the full installation guide.
