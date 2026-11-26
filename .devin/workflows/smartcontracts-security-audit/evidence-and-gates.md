---
description: Preserve audit evidence, update the mirrored checklist truthfully, assess canonical release gates, and produce a bounded handoff.
---

# Evidence, release gates, and handoff

Apply the [entry point](../smartcontracts-security-audit.md) and
[planning contract](planning-and-preflight.md). This playbook completes every
audit, atomic check, and revalidation; it never authorizes publication or deploy.

## Preserve evidence

Update `docs/security-checklist.md` with the complete canonical checklist,
reviewer/date, threat model, invariants, reviewed snapshot/scope, evidence
references, and revision history. Mark only actually verified items `[x]`; failed,
blocked, and unexecuted items remain unchecked. Record justified non-applicability
separately without representing it as successful execution. Preserve unrelated
prior evidence and identify historical results that do not cover the snapshot.

Store a run summary and sanitized supporting reports in a unique approved path
such as `docs/secure-tests/<run-id>/`, following project documentation rules.
Never overwrite historical runs or publish raw private artifacts. Do not present
a generated report as the required external `docs/audit-report.md`. If required
writes are prohibited, report the evidence/checklist gate as blocked and identify
the review as preliminary.

Bind every result to baseline, reviewed revision and working-tree changes,
compiler settings, dependency lockfile, actual commands, tool versions, and
report locations. Capture invoked skills/workflows and scoped exclusions.
Source/configuration changes affecting the evidence require the relevant checks
to run again. Do not reuse stale outputs as a fresh pass.

## Assess gates

Use `passed`, `failed`, `blocked`, `not_run`, or evidence-backed `not_applicable`
for every check. Non-applicability requires rationale and reviewer. The overall
result is:

- **Failed:** A required security criterion is violated.
- **Blocked/incomplete:** A prerequisite, applicable check, required evidence, or
  review is missing. Include outstanding steps even when another gate failed.
- **Scoped checks passed:** Every applicable check for the stated scope passed;
  list exclusions and remaining release requirements explicitly.

Apply all [canonical merge/mainnet gates](../../rules/smartcontracts-solidity-security.md),
including tool-specific thresholds, minimum coverage, independent external audit,
multisig, and timelock where required. Missing required tools/reviews remain
blockers. Automated scans, self-review, or a separate agent context never satisfy
external independence. A scoped pass is not full-system security certification
or authorization to merge, publish, or deploy.

## Final handoff

Return:

1. Run identity, baseline, reviewed snapshot, scope, and invoked skills/workflows.
2. Findings by severity and requirement/checklist mapping.
3. Per-check commands, statuses, observed results, evidence paths, and coverage gaps.
4. Files created/updated, preserved user changes, and unexecuted checks/blockers.
5. Release-gate assessment and the next recommended action.

Stop at the requested boundary. Request authorization before remediation. Finish
the PDCL loop only for the agreed scope and keep remaining gates visible. For
supplied fixes, follow [revalidation](revalidation.md), not an implicit authoring
step.
