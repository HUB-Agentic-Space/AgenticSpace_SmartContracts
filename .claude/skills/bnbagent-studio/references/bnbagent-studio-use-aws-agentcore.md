---
name: bnbagent-studio-use-aws-agentcore
description: When the user wants to drive the native `agentcore` CLI (the npm `@aws/agentcore` package) inside a bnbagent-studio project — run the agent locally with `agentcore dev`, deploy to AWS via CDK with `agentcore deploy`, inspect a deployed runtime with `agentcore status` / `invoke` / `logs` / `traces` / `fetch`, validate config with `agentcore validate`, or stop resources with `agentcore stop`. Also covers the env-var loading gotcha and AWS prerequisites.
---

> **Reference file** of the `bnbagent-studio` router skill — installed at `bnbagent-studio/references/` and loaded on demand (not a standalone skill). Route here via the router's decision tree.

# bnbagent-studio-use-aws-agentcore

Procedure for driving the **native `agentcore` CLI** (the npm
`@aws/agentcore` package) inside a bnbagent-studio workspace. The CLI
is driven entirely by the `agentcore/` config dir; `app/agent/` is the code it
deploys.

The deployed product is **one** valuable Agent that serves its selected protocol
**directly** (`agentcore configure --protocol A2A` → `0.0.0.0:9000`, or
`agentcore configure --protocol MCP` → `0.0.0.0:8000/mcp`): it holds the key,
signs in-process, and is its own public endpoint behind a mandatory Cognito
OAuth2 authorizer. There is no separate service to deploy — the agent IS the
public surface, so this one procedure is the whole runtime deploy.

```
<workspace>/
├── agentcore/
│   ├── agentcore.json     # runtimes[]: build/entrypoint/codeLocation/envVars
│   └── aws-targets.json   # AWS account + region
└── app/agent/             # the CodeZip deployed to AgentCore (entrypoint lives here)
```

> **Always run `agentcore` from the WORKSPACE ROOT.** The CLI reads
> `agentcore/agentcore.json`, whose `codeLocation` / `entrypoint` are relative to
> the workspace root. Running it elsewhere breaks path resolution.

> **Commands change between toolkit versions.** Trust `agentcore --help` and
> `agentcore <command> --help` for the authoritative command/flag set rather than
> guessing. Do NOT invent flags.

## Prerequisites

1. **The `agentcore` binary is available** — install the npm CLI globally
   (needs Node ≥ 20): `npm install -g @aws/agentcore`.
   ⚠️ The PyPI package `bedrock-agentcore-starter-toolkit` installs a
   **same-named but incompatible** Python `agentcore` shim; if it lives in an
   active venv it shadows the npm CLI on PATH (symptom: typer-style
   `No such option: --logs` errors). Check with `which -a agentcore` and
   `pip uninstall bedrock-agentcore-starter-toolkit` if present.
2. **AWS credentials** for `deploy` / `status` / `invoke` / `logs`
   (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION`, or a profile).
   Verify you're in the RIGHT account: `aws sts get-caller-identity`'s `Account`
   must match `agentcore/aws-targets.json`. With SAML/SSO/AssumeRole, don't paste
   the federation account's access key into `[default]` — use a named profile. See
   <https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-files.html>.
3. **Valid `agentcore/` config** — set the real AWS account + region in
   `aws-targets.json`, then run `agentcore validate` before deploying.

## ⚠️ The env-var gotcha (read this first)

`agentcore` does **NOT** auto-load `.env.local` — nothing sources it into the
process, so a **raw** `agentcore dev` and the deployed runtime start with an
empty environment. (Studio's own `bag dev` does auto-load `.env.local` via a
python-dotenv parser and, by default, runs the agent in-process — prefer it for
local dev; this gotcha only bites when you call `agentcore` directly.) To get
the vars into a raw `agentcore dev`:

- **Local (raw `agentcore dev`) — export into the shell first:**

```bash
cd <workspace>/app/agent
set -a; . ./.env.local; set +a     # `set -a` is REQUIRED so vars are exported
cd <workspace>
agentcore dev
```

  Without `set -a` the sourced `KEY=VALUE` lines stay shell-local and the
  `agentcore dev` child process never sees them.

> ⚠️ **Caveat — `. ./.env.local` is shell `eval`.** Sourcing runs every line
> through zsh/bash, so a value with spaces, `$`, backticks, `~`, or quotes
> (common in `WALLET_PASSWORD` / API keys) is word-split or expanded and
> silently corrupted. If a secret has special characters, `export KEY='...'` it
> explicitly with single quotes instead of sourcing — or just use `bag dev`,
> which loads the file without shell eval.

- **Deploy — declare them in `agentcore/agentcore.json` `envVars[]`** (how
  AgentCore injects env into the deployed runtime):

```json
"envVars": [{ "name": "SOME_KEY", "value": "..." }]
```

  Don't commit real secrets — prefer your platform's secret store. Check
  `agentcore deploy --help` for any env-injection flag.

> **The KEYSTORE does NOT go in `envVars[]` (and is never bundled).** The
> encrypted wallet keystore lives at the WORKSPACE root (`.studio/wallets/`,
> outside the `codeLocation`, so no packaging path can include it) and is
> injected into the runtime via AWS Secrets Manager (`WALLET_KEYSTORE_JSON`,
> the default `--secrets-mode secretsmanager`). `bag deploy agent` handles
> this; only put non-secret runtime config in `envVars[]`.

## Command reference

Confirmed commands (with aliases) from `agentcore --help`. All run from the
**workspace root** and target the runtime declared in `agentcore/agentcore.json`
(`runtimes[].name`). Run `agentcore <command> --help` for options.

| Command (alias) | What it does |
|---|---|
| `agentcore validate` | Validate the `agentcore/` config files (run before deploy). |
| `agentcore dev` (`d`) `[prompt]` | Launch the **local** dev server, or invoke the agent locally. Needs env loaded (see gotcha). |
| `agentcore deploy` (`dp`) | Deploy infrastructure to AWS **via CDK** (reads `agentcore.json` + `aws-targets.json`). Re-run to redeploy. |
| `agentcore package` (`pkg`) | Package agent artifacts **without** deploying. |
| `agentcore status` (`s`) | Show deployed resource details and status. |
| `agentcore invoke` (`i`) `[prompt]` | Invoke a deployed agent endpoint. |
| `agentcore logs` (`l`) | Stream or search agent runtime logs. |
| `agentcore traces` (`t`) | View and download agent traces. |
| `agentcore fetch` | Fetch access info for deployed resources. |
| `agentcore stop` | Stop resources. |
| `agentcore add` / `remove` `[subcommand]` | Add / remove resources in the project config. |
| `agentcore import` | Import a runtime / memory / starter toolkit into this project. |
| `agentcore update` | Check for and install CLI updates. |

Other commands exist (`create`, `evals`, `run`, `pause`, `resume`, `promote`,
`telemetry`, `feedback`, `recommendations`, `config-bundle`, `dataset`,
`archive`, `ab-test`) — see `agentcore --help`.

## Typical workflows

### A. Run locally

Prefer `bag dev` (auto-loads `.env.local`, runs in-process, no Docker). For a
raw `agentcore dev` you must export the env yourself (see the env-var gotcha and
its special-character caveat above):

```bash
cd <workspace>/app/agent
set -a; . ./.env.local; set +a
cd <workspace>
agentcore dev
```

### B. Deploy to AWS (CDK)

> ⚠️ **First deploy: relay the AWS-permissions notice to the user.** Deploying
> provisions resources in the user's AWS account. `bag deploy agent` prints a
> pre-deploy notice (required-permission guides, AWS best-practice links, and a
> disclaimer) and gates the project's FIRST deploy on an explicit acceptance —
> in a non-interactive run it exits with an error instead of prompting. When
> that happens: show the printed notice to the user **verbatim**, get their
> explicit consent, then re-run with `--accept-risk`. NEVER add `--accept-risk`
> without asking the user first.

> 🔒 **Provision Cognito to serve external buyers.** An AgentCore seller endpoint is
> **never anonymous**: with no authorizer it defaults to IAM/SigV4 (owner-only —
> needs AWS creds — NOT open), and external buyers (no AWS creds) can't reach it.
> To admit external buyers you MUST configure the Cognito OAuth2 authorizer;
> `bag deploy prepare` **warns** (W9) if it's unset but does **not** block an
> owner-only deploy. Provision it:
>
> 1. `bag deploy provision-cognito` emits a self-contained Cognito CDK app
>    (UserPool + M2M app client) — the user runs `cdk deploy --outputs-file
>    cdk-outputs.json` themselves (the one AWS-touching step).
> 2. `bag deploy provision-cognito --wire` reads that local outputs file and
>    patches `agentcore.json`'s `authorizerConfiguration.customJwtAuthorizer` +
>    the card's `OAUTH_TOKEN_URL` / `OAUTH_SCOPE` (no AWS call). W9 clears once
>    those are real values.
>
> Buyers then reach the agent over plain HTTPS + an OAuth2 Bearer (the
> client-credentials grant) — **no AWS SigV4 / IAM credentials**. Locally,
> `bag dev` runs without Cognito env, so the card omits the scheme.

```bash
# 0. To serve external buyers: provision Cognito (once) + wire it in
#    (W9 warns if unset; owner-only IAM deploy is valid without it).
bag deploy provision-cognito        # then: cdk deploy --outputs-file cdk-outputs.json
bag deploy provision-cognito --wire # patches agentcore.json + .env.local (no AWS call)
# 1. Set the real AWS account + region in agentcore/aws-targets.json.
# 2. Declare runtime secrets in agentcore/agentcore.json envVars[].
# 3. Configure the runtime to serve the selected protocol (one-time), validate, then deploy:
#    use the value from app/agent/studio.toml [stack].protocol:
agentcore configure --protocol A2A   # or: agentcore configure --protocol MCP
agentcore validate
agentcore deploy
```

> After deploy, ERC-8004 registration records the **AgentCore endpoint**:
> A2A uses the normalized agent-card URL (`AgentEndpoint.a2a`), while MCP records
> the `/mcp` endpoint plus access metadata. `bag deploy verify` handles this. The
> on-chain identity points buyers straight at the agent; there is no proxy or
> relay in front of it.

### B1. Troubleshooting `agentcore deploy`

**`Cloud assembly schema version mismatch: Maximum schema version supported
is X, but found Y. Please upgrade your CLI`**

- **Cause:** the `agentcore` CLI's *bundled* CDK Toolkit is older than the
  aws-cdk-lib freshly npm-installed into the scaffolded `agentcore/cdk/`
  project. That project pins a floating `aws-cdk-lib` `^2.x`, so a fresh
  `npm install` can outrun the CLI's frozen toolkit. The toolkit *reads* the
  cloud assembly the lib *writes*; the read fails when the lib's schema is newer
  than the toolkit supports.
- **Diagnose:**
  - `agentcore --version` — the CLI (toolkit) side.
  - Read the lib version: `agentcore/cdk/node_modules/aws-cdk-lib/package.json`
    (`"version"`).
  - ⚠️ Do **NOT** compare the `aws-cdk` CLI vs `aws-cdk-lib` version *strings*:
    since early 2025 those two lines diverged (CLI `2.1000+` vs lib `2.2xx`), so
    a naive number compare is meaningless. The real contract is the
    **cloud-assembly schema** version, carried by
    `@aws-cdk/cloud-assembly-schema` (its MAJOR — e.g. `39`, `48`, `53` — *is*
    the schema version). Compare that package's MAJOR on both sides if present:
    - toolkit side: under the agentcore CLI's tree, e.g.
      `<cli-pkg>/node_modules/@aws-cdk/cloud-assembly-schema/package.json`;
    - lib side: under `agentcore/cdk/node_modules/` (hoisted at top level, or
      nested under `aws-cdk-lib/node_modules/`).
    - Toolkit MAJOR `>=` lib MAJOR → compatible; toolkit `<` lib → the mismatch.
- **Fix (in order):**
  1. Update the CLI so its bundled toolkit catches up:
     `npm install -g @aws/agentcore@latest`.
  2. Or pin `aws-cdk-lib` in `agentcore/cdk/package.json` to a version
     compatible with the installed CLI, then reinstall:
     `cd agentcore/cdk && rm -rf node_modules && npm install`.

> `bag deploy prepare` also WARNs about this skew *before* you hit it (the W8
> check compares the two `@aws-cdk/cloud-assembly-schema` majors when both are
> resolvable) — but it is best-effort and silently skips when either side is not
> yet installed, so this entry carries the diagnosis when the warning didn't
> fire.

### C. Inspect / operate

```bash
agentcore status                 # deployed resource details + health
agentcore invoke '<prompt-or-json-payload>'
agentcore logs                   # stream/search runtime logs
agentcore traces                 # view/download traces
agentcore fetch                  # access info for deployed resources
agentcore stop                   # stop resources
```

(Run each with `--help` for the exact flags/positional payload format.)

> `bag deploy status` also exists — a studio-side check of the deploy state
> (reads `[deploy].runtime_arn` from `app/agent/studio.toml`). Use it for a
> quick "is the Agent deployed?" answer; drop to `agentcore status` for the full
> AWS resource detail.

## Reference

- `agentcore --help` / `agentcore <command> --help` (authoritative for commands + flags)
- `agentcore/agentcore.json` — runtimes[] (build/entrypoint/codeLocation/envVars)
- `agentcore/aws-targets.json` — AWS account + region
