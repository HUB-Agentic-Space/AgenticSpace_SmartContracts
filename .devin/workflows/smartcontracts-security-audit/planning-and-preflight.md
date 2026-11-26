---
description: Establish the security audit scope, snapshot, permissions, threat model, skills, and local toolchain prerequisites before any check.
---

# Planning and preflight

Start from the [entry point](../smartcontracts-security-audit.md) and apply the
[canonical security rule](../../rules/smartcontracts-solidity-security.md).
This playbook is mandatory for audit, atomic-check, and revalidation modes.

## Execution contract and safety boundaries

Record the run ID, UTC timestamp, mode, reviewer, target paths, baseline and target
snapshot, requirement/finding IDs, dependency boundaries, permitted writes,
resource/time budget, expected checks, and stop conditions. Atomic execution means
one bounded objective, not automatic filesystem or external-action rollback.

- Read [security policy](../../rules/security.md),
  [Node/NVM requirements](../../rules/smartcontracts-node.md),
  [test requirements](../../rules/tests_and_analysis.md), and
  [build constraints](../../rules/builds-deploy.md). Consult
  [deployment policy](../../rules/smartcontracts-deploy.md) only for release-gate
  assessment; it does not authorize deployment.
- Discover and invoke applicable available skills. Read actual source paths and
  required references. Use documentation skills/providers for version-specific
  syntax. Do not invent skills, install tools automatically, or broaden permissions.
- Execute inline unless the user explicitly authorizes subagents and the runtime
  allows them. Parallelize only independent checks with isolated outputs;
  serialize shared-artifact operations. Declare actual isolation boundaries.
- Do not modify contracts, tests, lockfiles, compiler settings, security controls,
  or deployment configuration. Proposed tests/fixes require separate authorization.
- Inspect configuration, imports, plugins, tests, and wrapper scripts before
  execution: repository code is untrusted and may perform external actions.
- Use a local environment without production credentials. Do not print `.env`,
  private keys, tokens, private payloads, or complete environment dumps.
- No broadcasts, public-chain writes, production access, deploys, upgrades, role
  changes, issue/PR publication, or Git mutations are authorized.
- Default to deterministic offline/local tests. Forks or remote reads require
  explicit approval of endpoint, chain, pinned block, data handling, and budget;
  use no production signer and label that evidence separately.
- Preserve user changes and historical reports. Never overwrite a report or reset
  the working tree to create a baseline. Stop for conflicting writes.

Missing scope or baseline must be resolved before execution. A read-only request
that prohibits mandatory evidence writes permits preliminary review only; report
the checklist gate as blocked.

## 1. Plan — establish a reproducible snapshot

1. Confirm the module root containing `package.json`, contracts, and tool configs.
   Capture `git status --short`, HEAD, baseline, and reviewed diff. Identify relevant
   untracked files without copying secrets. For working-tree audits include both
   tracked and relevant untracked changes in the snapshot identity.
2. Read applicable requirements, prior audit evidence, and the mirrored checklist.
   Identify dependencies, proxies/facets, shared storage, token/oracle interactions,
   privileged actors, and public entry points.
3. Define threat model and invariants. Prioritize access control, funds,
   signatures/replay, privacy, upgrade/storage safety, and collateral accounting.
4. Map each applicable canonical checklist section and requirement to a planned
   command or manual review. Justify exclusions; dependencies outside changed
   files are not implicitly excluded.
5. Identify report paths before running wrappers: several write fixed filenames
   in the module root. Preserve existing outputs through an approved isolated
   workspace or supported alternate paths; otherwise block that command.

## 2. Do — verify prerequisites

Read `.nvmrc` first. From the module root, load NVM in the same shell as subsequent
Node commands:

```bash
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
nvm ls
nvm use
node -v
npm -v
```

If the required version is unavailable, report it and request approval for
installation; never silently fall back to system Node. Record compiler, Foundry,
and analyzer versions using supported version commands after discovery.

Inspect `package.json`, lockfile, Hardhat/Foundry configurations, analyzer
configurations, wrappers, and installed dependencies. Confirm compiler versions,
optimizer runs, EVM target, remappings, linking, local-network selection, absence
of automatic RPC/fork/broadcast behavior, and actual scoped test/harness coverage
including proxies. Missing tools/dependencies are `blocked`, not `passed`;
installation is a separate approved operation.

## Handoff

Return the bounded plan, snapshot identity, invoked skills, permitted commands,
evidence locations, and blockers. Continue only to the requested
[automated checks](automated-checks.md), [manual review](manual-review.md), or
[revalidation](revalidation.md), then [evidence and gates](evidence-and-gates.md).
