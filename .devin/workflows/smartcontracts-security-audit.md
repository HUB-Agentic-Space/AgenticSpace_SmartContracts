---
description: The single entry point for Solidity smart contract security audits. Load this workflow for scoped audits, atomic security checks, finding revalidation, or audit evidence and release-gate assessment. Route through the playbooks without implicitly authorizing remediation or on-chain actions.
---

# Smart Contract Security Audit (the single entry point)

`smartcontracts-security-audit` routes Solidity security work through scoped,
evidence-driven playbooks. It combines available skills, local tests, analyzers,
manual review, and checklist evidence without changing contract implementations.
The [security rule](../rules/smartcontracts-solidity-security.md) remains the
canonical policy; this workflow is its execution entry point, not a replacement
standard or an independent external audit.

## Usage

When registered by the runtime, type `/smartcontracts-security-audit <ask>` to
route the user's intent through the decision tree. Otherwise ask the agent to
follow `.devin/workflows/smartcontracts-security-audit.md` with the same intent.
The presence of this file alone does not guarantee slash-command registration.

Supply scope, baseline, target snapshot, requirement/finding IDs, and permitted
writes. Resolve missing scope or baseline before execution; a working-tree audit
must record HEAD and included tracked/untracked changes.

## Examples

- `/smartcontracts-security-audit audit <contract paths> against <baseline>; target: working tree; evidence writes only`
- `/smartcontracts-security-audit run only Slither for <scope> at <revision>; stop after reporting`
- `/smartcontracts-security-audit review access control for <scope> at <revision>; do not modify source`
- `/smartcontracts-security-audit revalidate findings <IDs> from <baseline> against <fixed revision>`
- `/smartcontracts-security-audit assess release gates using evidence from <run-id>; do not deploy`

## The scoped audit model (the invariants)

One run, one bounded objective, one identified snapshot. **Audit** runs the
applicable procedure for the agreed system boundary; **atomic check** runs one
named check and its prerequisites; **revalidation** verifies named findings
against baseline and corrected snapshots. None silently cascades into authoring,
remediation, publication, or deployment. Atomic execution is a bounded completion
decision, not a promise of automatic rollback.

Only authorized evidence files and the mandatory mirrored checklist may be
written. Existing contracts, tests, user changes, and historical reports remain
intact. Local execution without production credentials is the default. A scoped
pass is neither full-system certification nor external independent-audit approval.

## Decision tree — which playbook to read next

**Playbooks are plain markdown files in this workflow's subdirectory** at
`.devin/workflows/smartcontracts-security-audit/<name>.md`. When a row matches,
READ THAT FILE before acting — do not answer from memory. Always start with
[planning and preflight](smartcontracts-security-audit/planning-and-preflight.md).

| User intent | Read |
|---|---|
| Establish scope, baseline, permissions, skills, threat model, or tool readiness | [planning-and-preflight.md](smartcontracts-security-audit/planning-and-preflight.md) |
| Run compilation, tests, coverage, lint, static/symbolic analysis, fuzzing, invariants, or one atomic tool check | [automated-checks.md](smartcontracts-security-audit/automated-checks.md) |
| Review access control, signatures, funds, privacy, upgrades, integrations, or triage alerts manually | [manual-review.md](smartcontracts-security-audit/manual-review.md) |
| Record findings, update the mirrored checklist, consolidate results, or assess release gates | [evidence-and-gates.md](smartcontracts-security-audit/evidence-and-gates.md) |
| Reproduce findings and verify supplied fixes without applying remediation | [revalidation.md](smartcontracts-security-audit/revalidation.md) |
| Perform the full scoped audit | Read all playbooks except `revalidation.md`, in the order above; read it only when fixes are supplied. |

If two or more match, read all applicable playbooks. Atomic checks still require
preflight and an evidence handoff; they do not require unrelated checks. Mark
unexecuted checks explicitly instead of presenting a partial run as a full audit.

## 5 core commitments (always honor)

1. **User code and history remain intact** — no source fixes, test changes, configuration rewrites, report overwrites, or Git mutations without separate authorization.
2. **No secrets or implicit on-chain actions** — no production credentials, broadcasts, deploys, upgrades, role changes, or external publication. Forks and remote reads require explicit bounded approval.
3. **Evidence, not wrapper success** — inspect actual reports, analyzed scope, discovered properties, skipped tests, and errors; missing or incomplete analysis never passes.
4. **Security policy remains canonical** — invoke applicable available skills, preserve mandatory gates, and never suppress findings, lower severity, or weaken tests to obtain a pass.
5. **Review boundaries remain explicit** — stop at the requested mode's handoff. Automated tools, another model, or a separate agent context never substitute for the required external independent audit.

## Check groups at a glance

Compilation, Hardhat tests, Foundry tests/fuzz/invariants, coverage, Solhint,
Slither, Mythril, Echidna, manual review, and formal-verification assessment.
See [automated checks](smartcontracts-security-audit/automated-checks.md) for the
verified package-script candidates and wrapper-specific evidence warnings.

## Tool surface

- **Skills** — discover and invoke relevant installed procedures using their actual source paths; do not invent capabilities or install third-party tools automatically.
- **Local toolchain** — inspect scripts/configuration before execution; use NVM and approved local dependencies, isolated outputs, and bounded resources.
- **Subagents** — inline execution by default; use only with explicit user authorization and runtime support. Context isolation is not filesystem or credential isolation.
- **Evidence** — `docs/security-checklist.md` plus a unique approved run directory such as `docs/secure-tests/<run-id>/`; never mislabel generated evidence as an external audit report.

## Prerequisites

Read the planning playbook before running commands. Missing tools, unsupported
scope selectors, conflicting output paths, or unavailable required reviews are
blockers, not permission to install, rewrite, or bypass controls. This workflow
neither runs an audit merely by being loaded nor authorizes remediation.
