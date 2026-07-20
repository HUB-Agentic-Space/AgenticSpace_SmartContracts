---
name: bnbagent-studio-using-twak-wallet
description: When the user's project has [wallet].kind = "twak" (a fully-supported wallet kind, opt in with `--wallet-kind twak`) — creating the Trust Wallet Agent Kit wallet, anchoring its address, funding it, SIWE-binding for Pieverse, deploying it as a container, and working around its known limitations.
---

> **Reference file** of the `bnbagent-studio` router skill — installed at `bnbagent-studio/references/` and loaded on demand (not a standalone skill). Route here via the router's decision tree.

# bnbagent-studio-using-twak-wallet

Procedure for setting up and operating the **twak** wallet kind (Trust Wallet
Agent Kit CLI) in a bnbagent-studio project. twak is a **fully-supported**
wallet kind — opt in at scaffold with `bag init <name> --wallet-kind twak`
(`evm-local`, a local keystore, is the default). The wallet is a **self-custody,
AES-256-GCM-encrypted mnemonic** the user controls (not a hosted service),
living by default in a **project-dedicated** home `.studio/twak`
(`[wallet].twak_home`), isolated from your main `~/.twak`. The default kind is
`evm-local` (local keystore); re-scaffold with `--wallet-kind twak` to use twak.

## 1. Install the CLI

Needs Node ≥ 20 (the same requirement as the `agentcore` CLI):

```bash
npm install -g @trustwallet/cli@0.19.1
twak --version
```

studio requires **>= 0.19.1** (the SDK sends v0.19-only flags: `--opt-params`
for seller submit, `--expected-budget` for fund); `bag doctor` and
`bag deploy prepare` verify the floor.

## 2. Create the wallet — one time, in YOUR terminal

studio can't create it for you (the twak CLI takes the password on argv, upstream
S-8, and studio never puts secrets on argv). Do these steps yourself.

**Every twak command is prefixed with the dedicated home.** Without `HOME=$DH`,
twak uses your real `~/.twak` (your MAIN wallet) and macOS pops a login-keychain
password prompt. Set it once:

```bash
DH=<workspace>/.studio/twak     # e.g. ~/proj/.studio/twak
```

**1. Get Trust Wallet NaaS API credentials** (one time; account-level, NOT
   wallet-specific). Make an app at https://portal.trustwallet.com/dashboard/apps
   → copy its Access ID + HMAC secret. (`twak wallet create` fails with "No API
   credentials found" without them.)

**2. Run the setup wizard** — writes the credentials into the dedicated home:
   ```bash
   HOME="$DH" twak setup
   ```
   - **Step 1 (API credentials):** paste the Access ID + HMAC secret.
     WalletConnect Project ID → leave blank, ENTER.
   - **Step 2 ("which harnesses to wire up"): SELECT NONE — press ENTER** on the
     empty list (do NOT press SPACE or `a`). 🔒 This would register twak's
     signing MCP into Claude Code / Cursor / etc., handing wallet+signing power
     to your AI assistant (and any prompt-injection reaching it) — studio forbids
     that: signing is fixed `signing.py` code, the LLM only receives read-only
     chain tools, and the deployed agent never calls twak via MCP.
   - **Step 3 (Wallet "Pick one"): choose `3) Skip for now`** (you create it in
     the next step). NOT `2) Use WalletConnect with my existing wallet` (binds
     your main/real wallet).

**3. Create the wallet** (password UPPER + lower + digit, e.g. `Mypasswd01`;
   `mypasswd01` is rejected):
   ```bash
   HOME="$DH" twak wallet create --password '<StrongPw>' --no-keychain
   ```
   `--no-keychain` keeps the password OUT of the OS keychain — it lives only in
   `TWAK_WALLET_PASSWORD` (step 4), so creation triggers **no macOS keychain
   prompt**. Expect: "Agent wallet created successfully / Wallet registered with backend /
   Generated addresses for 25 chains". (twak then prints "Restart your harness… /
   Try a sample query…" — that's for MCP users; ignore it, studio doesn't use
   twak's MCP.)

   > **Already have a wallet here?** If twak says `Wallet already exists. Back up
   > … then delete it`, the wallet is already created — do **NOT** follow the
   > literal "delete it". `wallet.json` is the ONLY copy of your AES-256-GCM
   > encrypted mnemonic; deleting it without the mnemonic backed up loses the funds
   > **forever**. Confirm it's yours (`HOME="$DH" twak wallet addresses`), skip
   > create, and go straight to step 5 — `bag wallet new` just ADOPTS the existing
   > address (idempotent, never destructive). Only recreate if you've safely backed
   > up the mnemonic, and then `mv` `wallet.json` to a `.bak` rather than deleting.

**4. Put the unlock password in `.env.local`** — **YOU edit the file** (never
   through the chat, never `bag env set <literal>` — the password must not reach
   the assistant or argv). Same value as Step 3:
   ```
   # .studio/.env.local
   TWAK_WALLET_PASSWORD=<StrongPw>
   ```
   studio AND the deployed runtime unlock via this env — the keychain copy is
   local-only and never deploys, so this line is mandatory or deploy can't sign.

**5. Anchor + activate** — back in a NORMAL shell (**no `HOME=` prefix**; studio
   resolves the home from `[wallet].twak_home` itself, and `bag wallet new`
   ADOPTS the address — it does not create a second wallet):
   ```bash
   cd <workspace>/app/agent
   bag wallet new      # writes the NEW address into studio.toml [wallet].address — confirm it's the new wallet, not your main one
   bag llm activate    # zero-deposit Pieverse key
   bag doctor          # all PASS (zero balance is a WARN, fine)
   ```

### macOS keychain — bypassed by default

With `--no-keychain` (step 3) the wallet password lives ONLY in
`TWAK_WALLET_PASSWORD` (step 4) — twak never reads or writes the OS keychain, so
both creation and signing trigger **no macOS password prompt**. studio and the
deployed runtime unlock via that env, so nothing is lost by skipping the keychain.

> **Safety net (you normally never see it):** for the rare case you create a wallet
> WITHOUT `--no-keychain`, `bag init` (and `bag wallet new`) also auto-creates an
> isolated, **empty-password** keychain under `$DH/Library/Keychains` —
> secret-free, scoped to `$DH` (your real login keychain untouched), never
> deployed. With `--no-keychain` twak doesn't touch any keychain at all.

> ⚠️ **If you omitted `--no-keychain` and a macOS prompt LOOPS** (or a bare `twak
> setup` prompted against your **main** login keychain and rejects every password):
> **Do NOT click "Reset Default Keychain"** — it erases your Wi-Fi passwords, SSH
> passphrases, and saved app secrets. Quit it with `pkill -9 -f twak`, then
> recreate the wallet **disk-only**:
> ```bash
> HOME="$DH" twak wallet create --password '<StrongPw>' --no-keychain
> ```
> and rely on `TWAK_WALLET_PASSWORD` (step 4) to unlock — same end state, no
> keychain involved.

### Other wallet placements

`bag init` always writes a project-dedicated `[wallet].twak_home`; the flow above
is the default (a brand-new dedicated wallet). Alternatives:
- **Reuse an existing wallet** across agents → `bag init --twak-home <path>`
  (that wallet's HOME-style dir, containing `.twak/wallet.json`). Same flow:
  create with `--no-keychain`, unlock via `TWAK_WALLET_PASSWORD`.
- **Your main `~/.twak`** (DISCOURAGED — real funds / bound identities) → opt-in
  only via `bag init --twak-home ~`, or "yes" to the warned prompt (default "no")
  when a machine wallet is detected. Recorded as `[wallet].twak_home = <$HOME>`.

Each wallet is its own address → its own ERC-8004 identity, Pieverse SIWE
binding, and secret bundle; `bag doctor` / `bag deploy` resolve the right one via
`[wallet].twak_home`.

## 3. Fund it — and keep it a HOT wallet

Two assets, two different rules:

- **U (payment token)** — the principal for x402 topups (LLM credit) and what
  buyers pay you. x402 payments are **GASLESS** (EIP-3009, the facilitator
  settles), so topping up burns no BNB.
- **BNB (gas)** — on **mainnet, none needed**: intent writes (`bag 8004
  register`, `8183 settle` / `fund`) are gas-sponsored by twak (MegaFuel),
  and x402 was already gasless. On **testnet** intents still self-pay —
  keep ~0.007 tBNB there.

**Hot-wallet rule**: fund only a few days of spend. The Agent wallet is an
operational hot wallet, not a treasury — the on-chain balance is the one
spending limit nothing can bypass. Studio's daily caps
(`[budget].max_per_day_usd`) are in-process guardrails: real across CLI runs
(persisted to `.studio/spend-ledger.json`), best-effort in the deployed
runtime (in-memory, resets on cold start).

Testnet faucet: https://www.bnbchain.org/en/testnet-faucet (tBNB).
Mainnet: U via PancakeSwap (BNB not needed — gas is sponsored).

## 4. SIWE binding (Pieverse) — ALWAYS bind before paying

Pieverse attributes x402 topups to the **SIWE-bound payer address** (the paid
call carries no session header on the twak path). `bag llm activate` performs
the SIWE login (an EIP-191 `sign_message`, which twak supports) before any
payment, so the normal flow is safe. If you ever top up through a custom
path: bind first, pay second — an unbound payment cannot be attributed.

## 5. Local dev (no Docker) vs deploy (Container image)

**Local dev needs no Docker.** `bag dev` runs the agent **in-process** by
default (`python main.py`, no Docker) — the keystore/twak materialize hooks are
no-ops locally, so in-process exercises the same code path as the deployed
container minus the image. Use `bag dev --container` only if you want the
AgentCore dev container for full image parity (that mode runs via `agentcore
dev` and needs Docker / Podman / Finch); it is **not** required to develop or
test the twak agent locally.

**Deploy ships a Container image.** The managed AgentCore Python runtime has no
Node, so a twak Agent deploys as a **custom container** (Python 3.12 + Node ≥ 20
+ the twak CLI). `bag init` already configured everything: `agentcore.json`
registers a `Container` runtime and `app/agent/Dockerfile` builds the image
(linux/arm64 — an x86 machine needs docker buildx for cross-build).

- Local Docker is **optional** for `bag deploy agent`: with Docker running it
  builds the image locally (linux/arm64) and pushes to ECR; **without Docker,
  agentcore builds it via AWS CodeBuild** in your AWS account instead (slower,
  no local Docker needed). `bag deploy prepare` only WARNs (never blocks) when
  Docker is absent — CodeBuild covers the build either way.
- Wallet material reaches the runtime ONLY via AWS Secrets Manager
  (`TWAK_WALLET_JSON` / `TWAK_CREDENTIALS_JSON` / `TWAK_WALLET_PASSWORD`),
  never inside the image. `bag deploy prepare` verifies all of this.

## 6. Known limitations (upstream twak CLI v0.19.1)

| Limitation | Upstream ref | What you see |
|---|---|---|
| ~~Seller `submit` unavailable~~ | ~~REQ-1~~ RESOLVED in v0.19.0 | `submit --opt-params` works — verified on-chain. |
| ~~Seller `quote` signing broken~~ | ~~S-11 regression in v0.19.0~~ RESOLVED in v0.19.1 | v0.19.0 hex-decoded `0x…` messages and signed the bytes, so provider_sig never verified (testnet also rejected `sign-message --chain bsctestnet`). v0.19.1 signs the literal text (EIP-191): `sign_quote` works on both wallet kinds. The CLI floor is now **0.19.1** — `bag doctor` / `bag deploy prepare` reject older. |
| Testnet intent writes self-pay gas | REQ-2 (mainnet resolved via sponsorship) | keep a little tBNB on testnet; mainnet needs no BNB. |
| No generic EIP-712 signing | P0 (won't fix) | `[wallet.signing]` is ignored; payments go through the delegated payer's own prechecks + `--max-payment`. Endpoints needing an `Authorization` header *and* x402 are unavailable (e.g. `bag llm key new --initial-usd > 0` — use `--initial-usd 0` + topup + allocate instead, same end state). |
| No wallet import | S-6 | Switching wallet kinds changes your address → re-run `bag 8004 register` (new on-chain identity). |
| Programmatic wallet creation forces password onto argv | S-8 | Why step 2 is manual. |
| CLI has no daily/monthly caps | — | Studio's policy layer (`[budget].max_per_day_usd`, host allowlist, per-request caps) is the spend authority for both wallet kinds. |

## 7. Quick health checks

```bash
bag doctor                  # [wallet] twak CLI / wallet / address-anchor checks
bag wallet show             # describe(): address, key_location, capabilities
bag wallet balance          # BNB + U via RPC (works on testnet too)
bag deploy prepare          # container/Dockerfile/secret checks before deploy
```
