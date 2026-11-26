---
description: Atomically reproduce named security findings and verify supplied fixes against a baseline without applying remediation.
---

# Finding revalidation

Read [planning and preflight](planning-and-preflight.md) first. Require finding
IDs, original evidence, baseline, corrected snapshot, scoped dependencies, and
acceptance criteria. Resolve missing inputs before running checks.

## Procedure

1. Read each finding and its root cause, preconditions, impact, affected paths,
   prior reproduction, and requirement/checklist mapping.
2. Identify baseline and corrected snapshot, including relevant working-tree
   changes. Do not check out over user changes, reset files, or rewrite history.
   If baseline execution needs another workspace, obtain approval for that setup.
3. Reproduce the original finding locally within approved permissions. If it
   cannot be reproduced, record the reason and limitation; do not claim it fixed
   merely because reproduction failed.
4. Inspect supplied fixes and their dependencies for root-cause coverage and new
   access-control, accounting, storage-layout, or integration risks. Do not apply
   additional corrections in this mode.
5. Run the affected regression and adjacent checks using
   [automated checks](automated-checks.md). Confirm regression evidence fails on
   the vulnerable baseline and passes on the corrected snapshot where execution
   is available. Missing tests are a handoff item unless creation was separately
   authorized; unavailable baseline execution remains an explicit evidence gap.
6. Review results through [manual review](manual-review.md). Close only findings
   supported by new evidence. Record each finding as revalidated, still open, or
   blocked, with evidence and residual risk. Invalidate affected stale evidence.
7. Complete [evidence and gates](evidence-and-gates.md), updating checklist history
   and the per-finding status without erasing original findings or prior runs.

## Stop conditions

Stay within the named findings and necessary integration boundary. Report new
unrelated findings without silently expanding implementation scope. Missing
prerequisites, failed checks, timeouts, and absent independent review remain
visible blockers for their respective gates. No source changes, broadcasts,
publication, or deployment follow automatically from successful revalidation.
