---
name: bnbagent-studio
description: The single entry point for bnbagent-studio — a Python CLI (`bag`) for building a blockchain SELLER agent that earns $U on BNB Chain via ERC-8004 + ERC-8183 + x402 (Pieverse LLM inside). Load this skill whenever the user works in a bnbagent-studio / `bag` project, or wants to create/scaffold, deploy, run, debug, operate, or monetize such a seller agent (A2A or MCP; AWS Bedrock AgentCore self-deploy or the BNB Chain managed-platform trial). All detailed playbooks ship as references/ files inside this skill — route via the decision tree in the body. When invoked with arguments, treat them as the user's intent and route the same way.
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

Invoked as `/bnbagent-studio <ask>`? Treat `<ask>` as the user's intent and
route it through the decision tree below, exactly like a natural-language ask.

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
Manager at deploy. `settle` is manual (`bag erc8183 settle`). Full layout and
lifecycle details live in the references below — read them before acting.

## Decision tree — which reference to read next

**References are plain markdown files installed in THIS skill's directory** at
`references/<name>.md`. When a row matches, READ THAT FILE before acting — do
not answer from memory.

| User intent | Read / do |
|---|---|
| Create a brand new single seller project from zero | `references/bnbagent-studio-scaffolding-agent.md` |
| Add wallet / the single seller runtime to an existing Python agent | `references/bnbagent-studio-adding-to-project.md` |
| Run / debug / dev / doctor / RPC / balance / incident triage | `references/bnbagent-studio-operating.md` |
| Implement what the Agent sells, tune pricing, publish over A2A or MCP, defend disputes (seller flow) | `references/bnbagent-studio-selling-via-8183.md` |
| Deploy: read `studio.toml [deploy].destination` FIRST | `platform` (absent ⇒ see next rows) → run `bag deploy agent` (account/trial ops: `bag platform {login,whoami,agents,credit}`; full flow `docs/guides/platform-deploy.md`). `self` or absent → read `references/bnbagent-studio-use-aws-agentcore.md` (bag deploy + the native `agentcore` CLI lifecycle: dev / status / logs / traces / invoke) |
| Wire chain-read tools into the Agent's LLM (ADK / LangChain / AutoGen / Agno / etc.) | `references/bnbagent-studio-wiring-llm-tools.md` |
| Buy a service from another ERC-8183 seller via CLI — incl. testing your own seller from the buyer side (v2/internal — NOT the v1 seller product flow) | `references/bnbagent-studio-buying-via-8183.md` |
| Give the agent a PAID x402 capability — CMC market data / Binance Bazaar (B402) merchants / any pay-per-call API (`bag x402 trust`, x402-buyer recipe, 402 buyer errors) | `references/bnbagent-studio-buying-from-bazaar.md` |
| Extend the EIP-712 signing allowlist (custom contract / new x402 service / diagnose `PolicyViolation` / `X402PolicyError`) | `references/bnbagent-studio-extending-signing.md` |
| Project uses `[wallet].kind = "twak"` (create / fund / SIWE-bind / container deploy / known limitations) | `references/bnbagent-studio-using-twak-wallet.md` |
| (Pieverse projects only) Fund the LLM, switch to a paid model, hit insufficient credits (`PieverseBudgetExhaustedError` / `PieverseAccountBalanceExhaustedError`) | skill `funding-pieverse-llm` (project-scope; emitted at `bag init --llm-provider pieverse-llm`) |

If two or more match, read both — they're designed to be orthogonal.

### Where the references live

Next to this file: this skill installs as a directory with a `references/`
subdirectory (Claude Code: `~/.claude/skills/bnbagent-studio/references/` or the
project-scope `<project>/.claude/skills/bnbagent-studio/references/`; Cursor:
`bnbagent-studio/references/` under the rules directory, beside the `.mdc`
rules). If a reference file is missing, `bag skills install` (re)installs it.

<!-- Maintainers: this skill's DESCRIPTION only carries ENTRY intents (identity
+ create/deploy/run/debug/operate/monetize). Mid-journey topics (twak, EIP-712,
disputes, buyer flow, tool wiring, ...) are routed by the decision tree above and
must NOT be added to the description — see docs/design/decisions.md §14. -->

## 5 core commitments (always honor)

1. **Agent project code is user-owned** — recipe-emitted files are theirs to edit; studio doesn't auto-rewrite them.
2. **Private keys live in a user-controlled environment, never transmitted to studio or third parties** — the encrypted keystore lives at the workspace root, outside the deploy codeLocation (no packaging path can bundle it), and is injected only into the user's own single agent via AWS Secrets Manager at deploy. (Scoped, consented exception: the 48h testnet-trial platform destination — testnet-forced, throwaway wallet recommended.)
3. **Signing is fixed handler code, never an LLM-callable tool** — A2A and MCP expose only bounded `negotiate` / `notify_funded` flows; raw/arbitrary signing is never exposed. Read-only chain queries remain read-only tools.
4. **SDK protocol layer stays pure** — studio's opinions don't pollute `bnbagent-sdk`.
5. **The user can jump ship at any point** — emitted code is theirs to edit / fork / migrate; studio depends on no closed SaaS. Emitted code imports `from bnbagent_studio_core import …` and depends on the `bnbagent-studio-core` runtime lib (not the CLI), so uninstalling the `bnbagent-studio` CLI never breaks a deployed agent.

## CLI groups at a glance

`init`, `scan`, `recipe`, `skills`, `wallet`, `erc8004`, `erc8183`, `x402`, `agents`, `config`, `env`, `dev`, `doctor`, `audit`, `deploy`, `platform`, `llm`, `bundle`, `budget` — see `bag --help` for details. `bag deploy` is `{prepare, agent, verify, status, info, destroy, logs, fix-gitignore, provision-cognito}`; AgentCore lifecycle ops (status / logs / invoke) run via the native `agentcore` CLI (read `references/bnbagent-studio-use-aws-agentcore.md`).

## Tool surface

- **CLI** — write-side (wallet ops, on-chain register, x402 buy, deploy)
- **MCP** — an external seller protocol (`bag init --protocol MCP`), peer to A2A
- **`bnbagent_studio_core.tools.chain_readonly`** — 15 pure functions, wrapped into LLM tools by the chain-tools recipe (read `references/bnbagent-studio-wiring-llm-tools.md`)

## Where docs live

- `docs/design/architecture.md` — layered architecture
- `docs/design/decisions.md` — decision records (Pieverse default, signing policy, chain tools, zero-deposit, skill reorg, **single seller runtime + protocol choice**)
- `docs/guides/pieverse-integration.md` — Pieverse LLM full lifecycle
- `docs/guides/user-guide.md` — end-user procedures
