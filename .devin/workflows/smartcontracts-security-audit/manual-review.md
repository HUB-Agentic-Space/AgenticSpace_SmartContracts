---
description: Review scoped Solidity threat models, integrations, and security properties; triage findings with evidence without applying fixes.
---

# Manual review and finding triage

Read [planning and preflight](planning-and-preflight.md) first. Apply all relevant
sections of the [canonical checklist](../../rules/smartcontracts-solidity-security.md).
Do not replace the complete checklist with this overview.

## Review the actual system boundary

Review threat model, access control, signatures/replay, DIDs/VCs, privacy,
reentrancy, external calls, token behavior, funds and collateral accounting,
oracles/MEV, arithmetic, DoS, events, pause/incident response, upgradeability,
shared storage, and proxy/module integration paths. Review dependencies even when
outside changed files. Prioritize asset loss, privilege escalation, replay, and
data exposure.

Review tests and analyzer evidence for each relevant property, including revert
paths, unauthorized actors, state transitions, and invariants. A clean scan or
100% coverage does not replace manual review. For atomic review, explicitly bound
which properties were examined and which remain unreviewed.

## Record each finding

- Stable ID, title, severity, confidence, affected paths/lines, and requirement or
  checklist mapping.
- Preconditions, affected actors/assets, impact, root cause, and safe local
  reproduction or counterexample; never interact with real funds.
- Supporting command/report/test evidence, remediation recommendation, and
  disposition: open, confirmed, false positive with evidence, or revalidated.
- Residual risk and reviewer/date for justified exceptions. Never downgrade or
  dismiss a finding merely to pass a gate.

Do not execute an unapproved proof of concept, change tests, apply fixes, or
publish sensitive findings. Missing regression coverage becomes a handoff item,
not permission to author tests in audit mode. Another model or separate agent
context does not constitute an external independent audit.

## Handoff

Complete [evidence and gates](evidence-and-gates.md), including findings,
limitations, and remediation recommendations. Stop before implementation. Use
[revalidation](revalidation.md) only when corrected code is supplied and that
verification is requested.
