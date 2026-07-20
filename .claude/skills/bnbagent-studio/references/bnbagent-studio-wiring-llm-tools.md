---
name: bnbagent-studio-wiring-llm-tools
description: When the user wants their agent's LLM to call read-only chain queries (wallet balance, ERC-8004 agent info, ERC-8183 job status, etc.) — exposes the 15 functions in `bnbagent_studio_core.tools.chain_readonly` as LLM tools for ADK / LangChain / AutoGen / Agno / any framework.
---

> **Reference file** of the `bnbagent-studio` router skill — installed at `bnbagent-studio/references/` and loaded on demand (not a standalone skill). Route here via the router's decision tree.

# bnbagent-studio-wiring-llm-tools

Wire `bnbagent-studio`'s 15 chain readonly functions into the user's agent so
the LLM can autonomously query wallet, balance, ERC-8004 identity, ERC-8183
jobs, etc. Studio ships only the pure functions and an ADK template (recipe
location: `frameworks/adk/code/{{PKG}}/tools.py.tmpl`, emitted to the Agent
sub-project as `app/agent/tools.py`); for other frameworks you (Claude Code) write
a thin wrapping file in the Agent sub-project.

In v1 the workspace contains one sub-project, `app/agent/` — the single
selected-protocol seller runtime. LLM tools always live in
**`app/agent/tools.py`**. The `{{PKG}}` recipe
variable resolves to `agent` (the sub-project package), so the emit target is
`app/agent/tools.py` — its meaning is "sub-project of the workspace", not
"package inside a single-root project".

## Audience

Claude Code (or another agent) editing the user's workspace. The user has run
`bag init` and wants their Agent sub-project to expose read-only chain queries
to its LLM (`app/agent/tools.py`). These are READ-ONLY — the Agent's signing
always stays in `app/agent/signing.py` (fixed code), never an LLM tool.

## When to use this skill

- The user says "let my agent query its balance" / "agent should know about its
  on-chain jobs" / "give the LLM access to chain state"
- The user wants to wire chain tools into a **non-ADK** framework (LangChain,
  AutoGen, Agno, CrewAI, OpenAI Assistants, custom)
- The user wants to **customize** which chain queries their LLM sees
- The user uses `bag init` but wants to extend / re-emit the tool list

## When NOT to use this skill

- The user wants the Agent to **sign transactions / pay** — in the single seller
  model all signing (quote-sign, submit, settle) is FIXED code
  in `app/agent/signing.py` (called by A2A's `SellerAgentExecutor` or MCP's
  `mcp_main.py` tools), **never** an
  LLM-callable tool. The LLM only produces work text after a job is verified
  funded; fixed code prices, clamps, signs, and submits. There is no "wire a
  signing @tool into the LLM" path in v1.
- The user is doing dev-time debugging via Claude Code — that's the `bag` CLI
  read commands (`bag wallet`, `bag erc8183 status/list`, …), not LLM tools.

---

## The 15 functions

All in `bnbagent_studio_core.tools.chain_readonly`. Each returns a `dict` (or `str`);
docstrings serve as the LLM tool description.

### Wallet & chain basics — always safe

| Function | Reads | Dependency |
|---|---|---|
| `wallet_info()` | active wallet address + source + keystore dir | none |
| `wallet_address()` | active wallet address (alias of wallet_info) | none |
| `wallet_list()` | all configured keystore addresses | dev concern |
| `balance_native(address?, network?)` | BNB / tBNB balance | none |
| `balance_u(address?, network?)` | U token balance | `[u_token]` |
| `network_info(network?)` | chain id, RPC host, contract addresses | none |
| `tx_status(tx_hash, network?)` | tx receipt + revert reason | none |

### LLM provider — Pieverse-specific

| Function | Reads | Dependency |
|---|---|---|
| `pieverse_usage(days=7)` | LLM spend on Pieverse | `[llm.provider=pieverse-llm]` |

Note: `pieverse_usage` does a SIWE EIP-191 personal_sign (no on-chain effect,
domain-locked). Other functions are pure RPC reads.

### ERC-8004 identity

| Function | Reads | Dependency |
|---|---|---|
| `agent_info(agent_id, network?)` | on-chain ERC-8004 record by ID | `[erc8004]` |
| `agent_by_address(address, network?)` | look up agent by owner address | `[erc8004]` |

### ERC-8183 jobs

| Function | Reads | Dependency |
|---|---|---|
| `job_status(job_id, network?)` | job state, client, provider, budget | `[erc8183]` |
| `job_list(limit=10, mine=False, provider?, network?)` | recent jobs | `[erc8183]` |
| `job_count(network?)` | network-wide inflight job count | `[erc8183]` |

### Advanced / footguns

| Function | Reads | Why footgun |
|---|---|---|
| `block_info(block?, network?)` | block summary | usually noise for LLM |
| `contract_call_view(address, function_signature, args?, output_types?, network?)` | arbitrary `eth_call` | accepts **any** ABI — LLM can be prompt-injected into calling attacker contracts |

---

## Step 1 — Confirm the user has run `bag init`

```bash
# from workspace root:
ls app/agent/studio.toml && (ls app/agent/main.py 2>/dev/null || ls app/agent/mcp_main.py)
```

If `app/agent/tools.py` already exists, the user has the ADK form already. Skip to
Step 4 if they want to customize.

---

## Step 2 — Identify the framework

Look at `app/agent/main.py` or `app/agent/mcp_main.py` imports / `app/agent/pyproject.toml`:

| Sign in code | Framework |
|---|---|
| `from google.adk.agents import Agent` | **ADK** (use stock recipe) |
| `from langchain_core` / `from langchain` | **LangChain** |
| `import autogen` / `from autogen` | **AutoGen** |
| `from agno` | **Agno** |
| `from crewai` | **CrewAI** |
| `OpenAI(...).beta.assistants.create` | **OpenAI Assistants** |

If ADK: emit the stock recipe and stop.

```bash
bag recipe code tools-adk > app/agent/tools.py    # canonical v0.0.1 path
```

Then in the protocol entrypoint (`app/agent/main.py` for A2A, `app/agent/mcp_main.py` for MCP):

```python
from .tools import LLM_READ_TOOLS
agent = Agent(..., tools=LLM_READ_TOOLS)
```

For non-ADK, continue.

---

## Step 3 — Write a framework-specific wrapper

Studio doesn't ship adapters for non-ADK frameworks (commitment: "agent code
the user owns"). You write a wrapper file in the user's project. Pattern:
import the pure functions, wrap each with the framework's tool primitive.

### LangChain

```python
# app/agent/tools.py
from langchain_core.tools import StructuredTool
from bnbagent_studio_core.tools import chain_readonly as cr

LLM_READ_TOOLS = [
    StructuredTool.from_function(cr.wallet_info),
    StructuredTool.from_function(cr.balance_native),
    StructuredTool.from_function(cr.balance_u),         # requires [u_token]
    StructuredTool.from_function(cr.network_info),
    StructuredTool.from_function(cr.tx_status),
    # StructuredTool.from_function(cr.pieverse_usage),  # requires [llm.provider=pieverse-llm]
    StructuredTool.from_function(cr.agent_info),        # requires [erc8004]
    StructuredTool.from_function(cr.agent_by_address),  # requires [erc8004]
    StructuredTool.from_function(cr.job_status),        # requires [erc8183]
    StructuredTool.from_function(cr.job_list),          # requires [erc8183]
    # StructuredTool.from_function(cr.job_count),
    # StructuredTool.from_function(cr.contract_call_view),  # ⚠️ accepts any ABI
    # StructuredTool.from_function(cr.block_info),
    # StructuredTool.from_function(cr.wallet_list),
    # StructuredTool.from_function(cr.wallet_address),
]
```

Wire into agent (e.g., `create_react_agent(model, LLM_READ_TOOLS)`).

### AutoGen

AutoGen registers functions on an agent rather than constructing tool objects:

```python
# app/agent/tools.py
from autogen import register_function
from bnbagent_studio_core.tools import chain_readonly as cr

CHAIN_READ_FUNCTIONS = [
    cr.wallet_info, cr.balance_native, cr.balance_u,
    cr.network_info, cr.tx_status,
    # cr.pieverse_usage,                         # requires [llm.provider=pieverse-llm]
    cr.agent_info, cr.agent_by_address,          # require [erc8004]
    cr.job_status, cr.job_list,                  # require [erc8183]
    # cr.job_count,
    # cr.contract_call_view, cr.block_info, cr.wallet_list, cr.wallet_address,
]

def register_chain_tools(caller_agent, executor_agent) -> None:
    for fn in CHAIN_READ_FUNCTIONS:
        register_function(
            fn, caller=caller_agent, executor=executor_agent,
            name=fn.__name__, description=(fn.__doc__ or fn.__name__).splitlines()[0],
        )
```

### Agno

```python
# app/agent/tools.py
from agno.tools import tool
from bnbagent_studio_core.tools import chain_readonly as cr

LLM_READ_TOOLS = [
    tool(cr.wallet_info),
    tool(cr.balance_native),
    tool(cr.balance_u),         # requires [u_token]
    tool(cr.network_info),
    tool(cr.tx_status),
    # tool(cr.pieverse_usage),  # requires [llm.provider=pieverse-llm]
    tool(cr.agent_info),        # requires [erc8004]
    tool(cr.agent_by_address),  # requires [erc8004]
    tool(cr.job_status),        # requires [erc8183]
    tool(cr.job_list),          # requires [erc8183]
]
```

### CrewAI / generic OpenAI-tool-format

For any framework that accepts a function with type hints + docstring, the
pattern is identical — wrap each `cr.*` function in the framework's tool
primitive and assemble a list. The function signatures and docstrings already
follow OpenAI-tool-calling conventions (typed params, dict returns, clear
descriptions).

---

## Step 4 — Customize what the LLM sees

The recipe gives a sensible default; the user owns the file. Common edits:

**Remove tools** the agent doesn't need (smaller LLM context = better focus):

```python
LLM_READ_TOOLS = [
    FunctionTool(cr.balance_u),     # only thing this agent really needs
    FunctionTool(cr.tx_status),
]
```

**Uncomment Pieverse usage** if the user's `[llm].provider = "pieverse-llm"`:

```python
FunctionTool(cr.pieverse_usage),   # requires [llm.provider=pieverse-llm]
```

**Uncomment 8004 / 8183 reads** if the user added those sections to
`studio.toml` after `bag init` (e.g., ran `bag erc8004 register` later).

**Never uncomment** `contract_call_view` without thinking — it accepts any ABI
signature and an LLM jailbreak / prompt injection can drain via reads from
malicious contracts (or hammer expensive RPC). Keep commented unless the
agent has a specific debug / introspection job and the user has read the
docstring.

---

## Step 5 — Write operations live in fixed code, NOT LLM tools

Read tools (this skill) are safe-ish — worst case the LLM gives wrong info.
**Write operations** (quote-sign, submit, settle) are the whole point of the
single seller model's signing boundary: they live as FIXED code in
`app/agent/signing.py`, are dispatched by A2A's `SellerCore` (in
`app/agent/seller_core.py`, which `SellerAgentExecutor` inherits) or MCP's
FastMCP tools (`negotiate`/`notify_funded`; `settle` is the manual `bag erc8183 settle`),
and are **never** put in the LLM's `tools=` list. The quote price is rule-based
(fixed code reads the list `price`, clamps it to `[min,max]`, then signs — the
LLM never touches the price); the LLM only PRODUCES the work text in `notify_funded` delivery —
money never flows through a tool call.

The one automatic signing path outside `signing.py` is the budget-gated
managed-model LLM-credit auto-renew hook (in the emitted
`app/agent/managed_model.py`'s `build_model()` factory, backed by
`bnbagent_studio_core.pieverse.PieverseCreditEnsurer`) — also automatic, also **not**
an LLM tool.

The x402 buyer kernel (`bnbagent_studio_core.x402`, `X402Signer.sign_payment`) is **not**
an LLM tool either — in v1 it is reachable only as the Agent's automatic
managed-model LLM-credit auto-renew (above), driven by fixed code, never the
LLM. Do not wire it into the Agent's `tools=` list. The SDK's `SigningPolicy`
is the second-layer gate on every signature regardless.

---

## Common questions

**Q: Why isn't `app/agent/tools.py` auto-synced with `app/agent/studio.toml` changes?**

A: The recipe is emitted once at `bag init` time; the file is the user's. To
refresh after configuring new features (e.g., enabling `[erc8183]` later):

```bash
bag recipe code tools-adk > app/agent/tools.py.new
diff app/agent/tools.py app/agent/tools.py.new
# manually merge — preserves any user customizations
```

**Q: Does this work in AgentCore deployment?**

A: Yes. The functions only need `bnbagent_studio_core.*` (the `bnbagent-studio-core`
runtime lib, already a dependency of the Agent sub-project via `app/agent/pyproject.toml`).
No subprocess, no MCP transport — pure in-process Python calls. The container image
ships `app/agent/tools.py` as part of the Agent that serves A2A or MCP directly on AgentCore.

**Q: Is this the same as `bag init --protocol MCP`?**

A: No. `bag init --protocol MCP` is the Agent's **external seller protocol**
(FastMCP `/mcp` for buyers). This skill wires read-only chain queries into the
Agent's own LLM as in-process Python tools. v0.0.1 doesn't ship MCP-for-agent
(the agent runtime consuming a subprocess
MCP server as its LLM tools). MCP here is instead an *external seller protocol*
(`bag init --protocol MCP`) — see `docs/design/decisions.md` for the discussion.
For now: in-process is simpler, faster, and matches commitment "agent code
the user owns".

**Q: How do I know if my `app/agent/tools.py` is up to date?**

A: Re-emit with `bag recipe code tools-adk > app/agent/tools.py.new` and diff
against your current file. If studio added new tools in a newer version,
they'll appear in the emit; you decide whether to adopt.
