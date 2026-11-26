---
description: Run approved local Solidity checks and verify actual analyzer reports, test coverage, harness discovery, and wrapper failure behavior.
---

# Automated checks

Read [planning and preflight](planning-and-preflight.md) first. Run only checks
required by the agreed audit scope or named atomic objective; do not modify
source, tests, wrappers, configuration, or dependencies to make them pass.

## Check matrix

These commands exist in the module's package scripts. Recheck current contents
before execution. Run individually so failures do not hide later statuses, using
NVM in the same shell. Execute only commands with approved scope and side effects.

| Check | Candidate command | Evidence to inspect |
|---|---|---|
| Compilation | `npm run compile` | Complete build result and compiler/settings match. |
| Hardhat tests | `npm test -- --network hardhat` | Relevant and adjacent suites, actual test counts, failures and skips. |
| Foundry tests/fuzz/invariants | `npm run test:foundry` | Discovered tests/properties, actors, seeds, run/depth settings, failures and counterexamples. |
| Coverage | `npm run test:coverage` | Per-core-contract coverage; enforce the canonical minimum 90%, identify uncovered sensitive branches. |
| Solidity lint | `npm run audit:solhint` | Every error and warning; mandatory gate requires zero errors. |
| Static analysis | `npm run audit:slither` | Actual scope, configuration exclusions, High/Medium findings and documented triage. |
| Symbolic analysis | `npm run audit:mythril` | Valid per-contract reports, successful analysis, timeouts, errors, and critical findings. |
| Property fuzzing | `npm run audit:echidna` | Correct executable/harness selection, discovered properties, iterations, counterexamples, and invariant failures. |

Use only supported target selectors confirmed in installed-version documentation.
If a wrapper cannot honor scope, obtain approval for broader local analysis or
mark the check blocked. Assess formal verification for critical properties;
record why it is or is not required and whether SMTChecker or another verified
tool actually ran.

## Wrapper-specific evidence checks

- `scripts/audit/mythril_analyze.sh` currently masks individual failures with
  `|| true`, excludes interface/library directories, and writes per-contract
  reports. Zero wrapper exit status is not proof of analysis. Validate each
  report and account for exclusions through dependency review.
- `scripts/audit/echidna_fuzz.sh` currently checks for `echidna` but invokes
  `echidna-test`, targets a fixed facet list, and masks failures. Verify executable
  compatibility and actual property discovery. Contracts outside that list,
  including dedicated harnesses, are not covered implicitly.
- `scripts/audit/slither_analyze.sh` prints a summary, but its final gate alone
  does not enforce the complete policy for Medium findings. Inspect JSON, raw
  output, detector coverage, and configuration, not only the summary.
- `npm run audit:full` chains tools with `&&`; later checks may never execute.
  It does not substitute for individual statuses and report inspection.

Reinspect wrappers on every run. These warnings do not authorize fixes or
suppression. An empty harness, timeout, parser error, or unavailable tool is not
evidence of security.

## Check Logs and handoff

For every command record start/end time, exact sanitized arguments, tool version,
exit status, observed completion, analyzed snapshot/scope, and evidence location.
Inspect crashes, skipped tests, empty harnesses, stale reports, truncated output,
compiler mismatches, and unreviewed alerts. Enforce the resource budget; timeouts
mean incomplete analysis, not absence of vulnerabilities.

Send alerts to [manual review](manual-review.md) and always complete
[evidence and gates](evidence-and-gates.md). A passing atomic check is only a
scoped result; mark unexecuted checks explicitly.
