---
trigger: model_decision
description: Applies when authoring, modifying, auditing, or revalidating Solidity smart contracts, including explicit isolated and atomic requests. Orchestrates available skills and workflows with scoped execution, evidence, and security gates while preserving independent audits, multisig/timelock governance, and the mirrored checklist.
---

# Solidity Security Rule

## Skill and Workflow Orchestration

This rule defines mandatory security policy. Skills provide specialized procedures;
workflows compose those procedures into an explicit execution sequence. Neither
may weaken this rule, override higher-priority instructions, or grant permissions
that the current runtime or user has not authorized.

### Discovery and capability selection

1. Identify the requested mode, target subproject, contracts, dependencies, and
   acceptance criteria before executing any procedure.
2. Discover applicable skills using the runtime's skill discovery mechanism.
   Invoke relevant available skills and read their instructions from the actual
   source paths reported by that mechanism, including required references.
3. Inspect existing project workflows under `.devin/workflows/`. Read the selected
   workflow before following it. The existing `../workflows/pdcl.md` supplies the
   iterative Plan → Do → Check Logs process, bounded by the requested mode.
4. Prefer existing specialized security, testing, fuzzing, invariant, and upgrade
   procedures over inventing replacements. For library or tool API details, use
   the available documentation skill/provider and the installed toolchain version.
5. Verify tool availability, package scripts, configuration, and prerequisites
   before execution. The audit commands below express required checks; they do
   not prove that the corresponding scripts or tools are installed.
6. If a skill, workflow, or tool is missing, report the gap and use a documented
   local equivalent only when it preserves the required check. Otherwise mark the
   step as blocked. Never fabricate an invocation, result, or passing status.
7. Record which skills, workflow paths, tool versions, and commands were actually
   used. Do not load unrelated skills or install third-party code automatically.

New reusable configuration belongs under `.devin/`: skills use
`.devin/skills/<name>/SKILL.md`. Reuse canonical procedures through references
instead of copying their content. A workflow document is not automatically a
registered slash command; use a slash invocation only if runtime discovery
confirms it exists. Otherwise read and follow the document explicitly.

### Execution modes and boundaries

Each mode may be requested directly in natural language, without first running
an umbrella workflow. Apply the same security policy to standalone and composed
executions.

| Mode | Purpose and allowed scope | Required handoff |
|---|---|---|
| Authoring | Create or modify only the agreed contracts, tests, and related requirements/documentation. Run scoped checks; do not self-certify an independent audit. | Diff, requirement IDs, tests and logs, known risks, and pending review gates. |
| Audit | Review a specified revision or working-tree snapshot and its dependencies. Do not modify contracts or apply fixes; only update explicitly authorized audit evidence and the mandatory mirrored checklist. | Threat model, findings with evidence, coverage limits, and gate status. |
| Revalidation | Reproduce specified findings and verify their fixes against a named baseline and current snapshot. Do not expand into unrelated implementation. | Per-finding disposition, regression evidence, and remaining risks. |
| Full cycle | Compose authoring, checks, review, remediation, and revalidation through PDCL within the authorized scope. | Consolidated evidence and unresolved release gates; never implicit deployment approval. |

An isolated **audit** is as directly callable as isolated **authoring**. If the
request does not distinguish them, clarify before making source changes. A
request to audit does not authorize remediation; a request to author does not
waive subsequent audit requirements.

### Atomic execution contract

Before each unit of work, establish:

- **Identity:** a task/run ID, mode, objective, and applicable requirement or
  finding IDs.
- **Inputs:** target paths, baseline revision, working-tree changes, relevant
  dependencies, threat assumptions, and supplied evidence. Preserve pre-existing
  user changes and exclude secrets from prompts and artifacts.
- **Permissions:** allowed reads, writes, commands, environment/network access,
  and explicit exclusions. Local tests are the default; production credentials,
  broadcasts, upgrades, and real-fund operations are excluded.
- **Acceptance:** the exact checks and expected outputs, plus prerequisites and
  conditions that must stop execution.
- **Outputs:** changed files or reviewed snapshot, findings, commands and exit
  statuses, sanitized evidence locations, unresolved blockers, and next action.

Atomic means one bounded objective with an explicit completion decision, not a
claim that filesystem edits or external actions can be rolled back automatically.
Do not silently cascade into another mode. On failure, preserve evidence, report
partial changes, and request approval before expanding scope or discarding work.

Use `passed`, `failed`, `blocked`, or `not_run` for each check. A justified
`not_applicable` must identify the supporting evidence and reviewer. Missing
checks never count as passed. A scoped pass is not approval of the entire system.

### Composition, isolation, and release gates

- Model the workflow as prerequisite-linked steps: scope/threat model → authoring
  when requested → tests and analysis → review → authorized remediation →
  revalidation → release-gate assessment. Standalone modes run only their required
  prerequisites and requested steps.
- Parallelize independent checks only when their inputs and output locations are
  isolated. Serialize shared-state changes and revalidate after integrating fixes.
- Skills execute inline unless the user explicitly authorizes subagents and the
  runtime permits them. Context isolation does not by itself provide filesystem,
  credential, or network isolation; declare the actual boundary.
- An author, automated scanner, second model, or separate agent context does not
  satisfy the external independent-audit requirement below. Never represent a
  self-review as an independent audit.
- Bind evidence to the reviewed revision and any uncommitted diff, compiler
  settings, and dependency lockfile. Source or configuration changes affecting
  that evidence require the relevant checks to run again.
- Update the mirrored checklist only for checks actually performed. Preserve
  earlier history and unrelated evidence; label partial scope explicitly.
- Never suppress findings, lower severity, weaken tests, or bypass governance to
  obtain a pass. Tool failure or unavailable independent review remains a blocker
  for the gates that require it.
- Merge, publication, deployment, governance transactions, and privileged actions
  remain separate approval boundaries. A completed workflow does not authorize them.

### Direct invocation examples

For the executable audit procedure, follow the
[Smart Contract Security Audit Workflow](../workflows/smartcontracts-security-audit.md).
It supports scoped audits, atomic checks, and finding revalidation without
implicitly authorizing remediation or deployment.

These are natural-language requests, not claims of installed slash commands:

```text
Apply smartcontracts-solidity-security in isolated authoring mode.
Scope: <contract paths>; requirements: <IDs>; permitted writes: <paths>.
Implement one bounded change, run its tests, and stop with a review handoff.
Do not audit independently, publish, or deploy.

Apply smartcontracts-solidity-security in isolated audit mode.
Baseline: <revision>; target snapshot: <revision and working-tree diff>.
Scope: <contracts and dependencies>; do not modify source code.
Record findings and checklist evidence, report blockers, and stop before fixes.

Apply smartcontracts-solidity-security in atomic revalidation mode.
Findings: <IDs>; baseline: <revision>; fixed snapshot: <revision/diff>.
Run the relevant regression checks and report each finding's disposition.
```

## Mirrored Checklist File (Mandatory)

Whenever a security check is performed on Solidity contracts, a mirrored
checklist file **must** be created and maintained at
`<subproject>/docs/security-checklist.md`, where `<subproject>` is the root
directory containing the contracts (e.g., `smartcontracts/docs/`).

### Mirrored file rules

- The file must faithfully reflect the complete checklist defined in the
  **Security Checklist** section below.
- Update the file **after every security check** performed.
- Mark verified items with `[x]` and pending items with `[ ]`.
- Each item must include the date of its latest verification and the responsible
  reviewer.
- **Do not remove** the file: removal compromises security traceability.
- Changes to this rule's checklist require immediate updates to mirrored files
  in all subprojects containing Solidity contracts.
- The mirrored file is the operational source of truth for audits and reviews.

### Mirrored file structure

The file must contain:

1. A header with the latest review date and responsible reviewer.
2. A completed threat-model section.
3. The complete checklist with the 24 sections defined below; deployment-related
   checks are covered by `smartcontracts-deploy.md`.
4. A section documenting invariants.
5. A section describing project-specific priorities.
6. A revision history (date, reviewer, changes).

---

## Mandatory Principles

### 1. Defensive Patterns

- **Checks-Effects-Interactions:** Always update state before external calls.
- **ReentrancyGuard:** Use `ReentrancyGuardUpgradeable` in all contracts making external calls.
- **Access Control:** Every contract must enforce access control through modifiers. Use OpenZeppelin's `AccessControlUpgradeable`.
- **Input Validation:** Validate all parameters with `require` or custom errors. Never trust external input.
- **Integer Overflow:** Solidity 0.8+ provides native overflow checking. Use `unchecked` only when proven safe.

### 2. Prohibitions

- **PROHIBITED:** Using `tx.origin` for authentication (use `msg.sender`).
- **PROHIBITED:** Unaudited assembly without explicit review.
- **PROHIBITED:** Using `delegatecall` to non-allowlisted contracts.
- **PROHIBITED:** Using `selfdestruct` without multisig authorization.
- **PROHIBITED:** Hardcoding private keys or secrets in code.
- **PROHIBITED:** Using `block.timestamp` for critical timing logic (miners/validators can manipulate it).
- **PROHIBITED:** Depending on `block.number` for precise deadlines.
- **PROHIBITED:** Storing complete personal data (name, identification document, email, phone) on-chain.
- **PROHIBITED:** Relying solely on `msg.sender` when an operation depends on an external signature; use EIP-712.
- **PROHIBITED:** Importing contracts from unstable branches.
- **PROHIBITED:** Manually reimplementing ERC-20, access control, or signature verification; use OpenZeppelin.

### 3. Obligations

- **Events:** Every state mutation must emit an event.
- **Modifiers:** Enforce access control through named, documented modifiers.
- **Custom Errors:** Use custom errors instead of strings in `require` to save gas.
- **NatSpec:** Document external/public functions with `@dev`, `@param`, and `@return`.
- **License:** Include SPDX-License-Identifier at the top of each file.
- **Pragma:** Use a fixed version (e.g., `pragma solidity 0.8.36;`); avoid open ranges such as `>=0.8.20`.
- **Dependencies:** Lock versions in `package-lock.json` or its equivalent.
- **Compiler:** Record the compiler version, optimizer settings, and optimizer run count.
- **Bytecode:** Verify that published bytecode matches the audited source code.

### 4. Mandatory Audit

Before any merge into main or mainnet deployment:

1. **Solhint:** `npm run audit:solhint` — zero errors.
2. **Slither:** `npm run audit:slither` — zero high/medium findings without documented justification.
3. **Mythril:** `npm run audit:mythril` — zero critical issues.
4. **Echidna:** `npm run audit:echidna` — zero invariant violations.
5. **Coverage:** At least 90% for core contracts.
6. **Fuzzing:** Run Foundry or Echidna fuzzing on properties and invariants.
7. **Formal verification:** Consider SMTChecker for critical properties.
8. **Manual review:** Review every alert; never ignore one without documented justification.

#### Independent Audit and Multisig/Timelock Governance

Before publishing or upgrading contracts on mainnet:

- **Independent audit:** Every core contract must be audited by an independent external firm or specialist. Store the report at `<subproject>/docs/audit-report.md` and record it in the mirrored checklist.
- **Multisig governance:** Critical actions (upgrades, parameter changes, treasury withdrawals, administrative role grants/revocations, and oracle/bridge configuration) must require multiple signatures with a documented quorum.
- **Timelock:** Sensitive changes must undergo an on-chain waiting period of at least 48 hours, unless a documented exception is approved by governance.
- **Transparency:** Document multisig and timelock addresses and make them publicly verifiable. Membership changes must emit events and follow the same process.
- **Post-audit review:** Implement and revalidate fixes recommended by the independent audit before deployment.

### 5. Secure Upgradeability

- Never use a `constructor` to initialize implementation contract state; use `initialize`.
- Protect initialization against a second execution.
- Disable initializers on the implementation contract.
- Protect `_authorizeUpgrade`.
- Never remove existing state variables.
- Never change existing state variable order or types.
- Append new variables at the end of the contract.
- Use `__gap` in inherited contracts to reserve storage space.
- Test upgrades on a mainnet fork before execution.
- Test state preservation after upgrades.
- Use `OpenZeppelin Defender` or the `upgrade_contract.ts` script for upgrades.
- Use multisig and timelock for upgrades.
- Emit an event and document every upgrade.
- Maintain an operational rollback mechanism.

### 6. Role-Based Access Control

- `DEFAULT_ADMIN_ROLE`: role management (multisig recommended).
- `AGENT_ROLE`: agents registered in `AgentRegistry`.
- `VALIDATOR_ROLE`: authorized validators.
- `DAO_PROPOSER_ROLE`: accounts allowed to create DAO proposals.
- `DAO_VOTER_ROLE`: accounts allowed to vote in DAOs.
- `ISSUER_ROLE`: credential issuers.
- `REVOKER_ROLE`: authorized revokers.
- `PAUSER_ROLE`: emergency pause operators.
- `UPGRADER_ROLE`: upgrade operators.
- `MINTER_ROLE`: mint operators.
- Apply least privilege: each role has only the permissions it needs.
- Do not grant all permissions to a single wallet.
- Prevent administrators from granting themselves privileges without controls.
- Prefer two-step ownership transfers.
- Remove temporary deployer privileges after deployment.
- Test calls from unauthorized users.

### 7. Security Events

Log all security events on-chain:

- `AgentRegistered(agentId, did, ownerAddress)`
- `AgentValidated(agentId, promptHash, validationId)`
- `ProposalCreated(proposalId, proposer, proposalType)`
- `VoteCast(proposalId, voter, support)`
- `RoleGranted(role, account, sender)`
- `RoleRevoked(role, account, sender)`
- `ContractUpgraded(name, oldVersion, newVersion, newAddress)`

Do not emit complete personal data in events. Index only useful, non-sensitive
fields.

### 8. Limits and Guards

- Maximum contract size: 24 KB (EIP-170).
- Per-transaction gas limits: configurable and monitored.
- Apply on-chain rate limiting to critical functions (e.g., `require(block.number >= lastBlock + cooldown)`).
- Emergency pause: core contracts must implement `PausableUpgradeable`.
- Separate pause and resume authorities when necessary.
- Do not allow minting or issuance while paused.
- Create an incident runbook with contacts and responsibilities.

### 9. Authentication and Signatures

- Use EIP-712 for structured messages with a domain (name, version, chainId, contract address).
- Include a unique nonce and deadline in every signature.
- Mark the nonce as consumed after execution.
- Prevent cross-chain and cross-contract replay.
- Validate the recovered address; reject the zero address.
- Verify smart-wallet signatures using ERC-1271.
- Use established ECDSA libraries (OpenZeppelin).
- Check for signature malleability.
- Ensure signed content exactly matches the executed operation.

### 10. Privacy and Personal Data

- Store only hashes, cryptographic commitments, or minimal references on-chain.
- Solidity `private` data is not secret.
- Use salts or commitments when the value space can be enumerated.
- Do not include private keys, API tokens, passwords, or credentials in contracts.
- Separate proof of existence, credential content, revocation state, and identity data.
- Document which information is public, pseudonymous, or confidential.

---

## Security Checklist for Solidity Smart Contracts

### Legend

- **[CRITICAL]** May cause loss of funds, system takeover, or identity fraud.
- **[HIGH]** May disrupt the system, violate privacy, or allow unauthorized operations.
- **[MEDIUM]** Impairs maintainability, traceability, or robustness.

### 1. Threat model definition

- [ ] Identify contracts controlling money or tokens.
- [ ] Identify contracts controlling identities, DIDs, and credentials.
- [ ] Identify functions that can create, update, suspend, or revoke records.
- [ ] Identify administrators, issuers, validators, oracles, bridges, and operators.
- [ ] List the impact of each key being compromised.
- [ ] Define what happens if the frontend, backend, database, or IPFS is compromised.
- [ ] Define what happens if a VC issuer behaves maliciously.
- [ ] Define what happens if a wallet is stolen.
- [ ] Define what happens if a signature is reused.
- [ ] Define what happens if an external contract returns false data.
- [ ] Define emergency states: pause, revocation, recovery, and migration.
- [ ] Document invariants that must never be violated.

**Example invariants:**
- Total supply must never exceed the defined cap.
- A user cannot register twice with the same identifier.
- A revoked VC cannot become valid again without new issuance.
- Only authorized issuers may issue credentials.
- Wrapped tokens must never exceed locked assets.

### 2. Compiler, dependencies, and build

- [ ] **[HIGH]** Use a recent stable Solidity version.
- [ ] Pin the compiler version, avoiding excessively open ranges.
- [ ] Check whether the selected version appears in the known-bugs list.
- [ ] Lock dependency versions in `package-lock.json` or its equivalent.
- [ ] Do not import contracts directly from unstable branches.
- [ ] Use established libraries (OpenZeppelin) instead of reimplementing them.
- [ ] Check breaking changes when upgrading OpenZeppelin major versions.
- [ ] Compile with the same settings used in tests.
- [ ] Record compiler version, optimizer settings, and optimizer run count.
- [ ] Verify that published bytecode matches the audited source code.
- [ ] Verify the contract on a block explorer after deployment.

### 3. Access control

- [ ] **[CRITICAL]** Does every administrative function enforce access control?
- [ ] **[CRITICAL]** Are mint, burn, pause, upgrade, revoke, issue, and withdraw functions protected?
- [ ] Use `Ownable` only for genuinely simple systems.
- [ ] For larger systems, use `AccessControl` or `AccessManager`.
- [ ] Separate responsibilities by role.
- [ ] Do not grant all permissions to a single wallet.
- [ ] Use a multisig wallet for critical administration.
- [ ] Apply least privilege.
- [ ] Verify who administers `DEFAULT_ADMIN_ROLE`.
- [ ] Prevent administrators from granting themselves privileges without controls.
- [ ] Implement a secure administration-transfer process.
- [ ] Prefer two-step ownership transfers.
- [ ] Remove temporary deployer privileges after deployment.
- [ ] Emit events when roles are granted or revoked.
- [ ] Consider timelocks for upgrades, parameter changes, and large withdrawals.
- [ ] Test calls from unauthorized users.
- [ ] Check whether sensitive internal functions were exposed as `public` or `external`.
- [ ] Check whether callbacks can bypass access control.

### 4. Authentication and signatures

- [ ] **[CRITICAL]** Do not rely solely on `msg.sender` when an operation depends on an external signature.
- [ ] Use EIP-712 structured messages.
- [ ] Include the signature domain (name, version, chainId, contract address).
- [ ] Include a unique nonce.
- [ ] Include a validity deadline.
- [ ] Mark the nonce as consumed after execution.
- [ ] Prevent replay on another blockchain.
- [ ] Prevent replay on another contract.
- [ ] Prevent replay after upgrades or version changes.
- [ ] Validate the address recovered from the signature.
- [ ] Reject the zero address.
- [ ] Verify smart-wallet signatures using ERC-1271.
- [ ] Do not assume every user is an EOA.
- [ ] Use established ECDSA libraries.
- [ ] Check for signature malleability.
- [ ] Ensure signed content exactly matches the executed operation.

### 5. User registration and enrollment

- [ ] Clearly define the user's unique identifier.
- [ ] Prevent duplicate registration.
- [ ] Do not use only a wallet address as permanent identity.
- [ ] Consider wallet replacement or recovery.
- [ ] Do not allow arbitrary wallets to register data on behalf of others without authorization.
- [ ] Validate against the zero address.
- [ ] Validate against empty fields.
- [ ] Limit input string and array sizes.
- [ ] Avoid loops over all users.
- [ ] Avoid storing unbounded lists that must be traversed.
- [ ] Use `mapping` for existence checks.
- [ ] Define whether a wallet may control multiple DIDs.
- [ ] Define whether a DID may have multiple controllers.
- [ ] Define the controller-update process.
- [ ] Define recovery for lost keys.
- [ ] Implement explicit states: active, suspended, revoked, or removed.
- [ ] Avoid removals that completely erase history needed for audits.
- [ ] Emit events for registration, updates, suspension, and revocation.
- [ ] Do not emit complete personal data in events.
- [ ] Prevent front-running of registrations using public identifiers.
- [ ] Use a commit-reveal scheme when necessary.

### 6. Privacy and personal data

- [ ] **[CRITICAL]** Do not store complete personal data directly on-chain.
- [ ] Do not record names, identification documents, addresses, phone numbers, emails, or medical information in plaintext.
- [ ] Remember that Solidity `private` data is not secret.
- [ ] Store only hashes, cryptographic commitments, or minimal references.
- [ ] Do not treat a simple hash of a national identification number or email as secure anonymization.
- [ ] Use salts or commitments when the value space can be enumerated.
- [ ] Do not include complete VC content in events.
- [ ] Do not include private keys or secrets in contracts.
- [ ] Do not store API tokens, passwords, JWTs, or infrastructure credentials.
- [ ] Avoid URLs that enable individual tracking.
- [ ] Assess correlation between different presentations of the same credential.
- [ ] Use selective disclosure when required.
- [ ] Separate proof of existence, credential content, revocation state, and identity data.
- [ ] Assess what happens when off-chain data is removed but its hash remains on-chain.
- [ ] Document which information is public, pseudonymous, or confidential.

### 7. DIDs

- [ ] Validate the expected DID syntax and method.
- [ ] Do not accept arbitrary strings as DIDs without normalization.
- [ ] Define whether the contract stores the full DID, DID hash, controller, DID Document hash, or an external reference.
- [ ] Check whether the DID method actually uses blockchain.
- [ ] Validate controller changes.
- [ ] Require authorization from the current controller for rotation.
- [ ] Implement recovery or multiple controllers when necessary.
- [ ] Prevent removed keys from remaining authorized.
- [ ] Maintain a document version number or nonce.
- [ ] Prevent rollback to an old DID Document.
- [ ] Record the update date or block.
- [ ] Define a permanent deactivation mechanism.
- [ ] Separate document updates from control transfers.
- [ ] Avoid complete dependence on a centralized resolver.
- [ ] Check resolver unavailability.
- [ ] Validate the returned document against the requested identifier.
- [ ] Do not automatically trust URLs in a DID Document.
- [ ] Protect DID-document URL resolution in the backend against SSRF.
- [ ] Check for expired, revoked, or rotated keys.
- [ ] Determine whether earlier signatures remain valid after key rotation.

### 8. Verifiable Credentials — VCs

- [ ] Only authorized issuers may register or issue a VC.
- [ ] Verify the issuer's identity and key.
- [ ] Verify `issuer`.
- [ ] Verify `credentialSubject`.
- [ ] Verify the cryptographic proof.
- [ ] Verify the allowed algorithm.
- [ ] Reject unsupported algorithms or missing integrity protection.
- [ ] Verify `validFrom`, `validUntil`, or equivalent fields.
- [ ] Verify suspension or revocation status.
- [ ] Verify the credential schema.
- [ ] Verify that the credential type is accepted.
- [ ] Prevent the same credential identifier from being issued twice.
- [ ] Do not treat a hash registered on-chain as sufficient proof of validity.
- [ ] Confirm that an authorized issuer registered the hash.
- [ ] Confirm that the presented VC produces exactly the same hash.
- [ ] Define consistent canonicalization before hashing.
- [ ] Avoid hashing JSON without a defined canonicalization scheme.
- [ ] Do not rely on JSON property order.
- [ ] Verify the binding between holder and credential subject.
- [ ] Prevent presentation of stolen credentials.
- [ ] Use `challenge` and `domain` in presentations.
- [ ] Prevent replay of a Verifiable Presentation.
- [ ] Implement scalable revocation.
- [ ] Test expired, suspended, revoked, and malformed credentials.
- [ ] Avoid storing complete VCs on-chain.
- [ ] Consider selective disclosure to reduce attribute exposure.

### 9. Reentrancy

- [ ] **[CRITICAL]** Identify all external calls.
- [ ] Apply Checks–Effects–Interactions.
- [ ] Use `ReentrancyGuard` for sensitive operations.
- [ ] Do not protect only the main function; analyze cross-function reentrancy.
- [ ] Assess read-only reentrancy.
- [ ] Update balances before transfers.
- [ ] Avoid external calls during partial state changes.
- [ ] Account for ERC-721 and ERC-1155 callbacks.
- [ ] Account for ERC-777 or non-standard tokens.
- [ ] Do not assume a token call is safe.
- [ ] Do not rely on the legacy `transfer()` gas limit as protection.

### 10. External calls and untrusted contracts

- [ ] Treat every external address as potentially malicious.
- [ ] Verify that the expected address contains code when required.
- [ ] Do not use `extcodesize` as the sole distinction between users and contracts.
- [ ] Validate return values.
- [ ] Check `success` for low-level calls.
- [ ] Do not ignore ERC-20 return values.
- [ ] Use `SafeERC20`.
- [ ] Define behavior when an external call fails.
- [ ] Do not allow external failures to leave inconsistent state.
- [ ] Limit the impact of pluggable or configurable contracts.
- [ ] Emit events when dependency addresses change.
- [ ] Protect functions changing token, oracle, bridge, or verifier addresses.
- [ ] Check whether external contracts can call back into the contract.
- [ ] Avoid `delegatecall` to user-supplied addresses.
- [ ] Never use `delegatecall` to an unvalidated implementation.
- [ ] Avoid arbitrary external calls controlled by input parameters.

### 11. Ether, payments, and withdrawals

- [ ] Verify whether the contract actually needs to receive Ether.
- [ ] Implement `receive()` and `fallback()` deliberately.
- [ ] Reject unexpected Ether.
- [ ] Do not assume the contract balance matches internal accounting.
- [ ] Account for Ether being forced into a contract.
- [ ] Use a withdrawal model instead of automatically paying many users.
- [ ] Limit administrative withdrawals.
- [ ] Use multisig and timelock for treasury operations.
- [ ] Prevent withdrawals to the zero address.
- [ ] Emit withdrawal events.
- [ ] Test recipients that reject Ether.
- [ ] Test recipient contracts attempting reentrancy.
- [ ] Check rounding when dividing amounts.
- [ ] Define residual dust handling.
- [ ] Do not use `tx.origin` for authorization.

### 12. ERC-20 and Token Coin

- [ ] Use an established ERC-20 implementation.
- [ ] Clearly define initial supply.
- [ ] Define whether a maximum supply exists.
- [ ] Protect minting.
- [ ] Protect `burnFrom`, when present.
- [ ] Check whether administrators can mint without limits.
- [ ] Document freezing or pausing powers.
- [ ] Define behavior while paused.
- [ ] Verify `decimals`.
- [ ] Do not treat `decimals` as changing the internal unit in security calculations.
- [ ] Verify `approve` and `transferFrom` permissions.
- [ ] Consider allowance-change risks.
- [ ] Consider `permit`, if used.
- [ ] For `permit`, validate nonce, deadline, EIP-712 domain, and signature.
- [ ] Prevent `permit` replay.
- [ ] Verify compatibility with contracts that do not return `bool`.
- [ ] Use `SafeERC20` when interacting with external tokens.
- [ ] Test fee-on-transfer tokens.
- [ ] Test rebasing tokens if accepted.
- [ ] Do not assume the received amount equals the transfer parameter.
- [ ] Measure balances before and after when necessary.
- [ ] Avoid complex transfer hooks.
- [ ] Check whether blacklists or pauses can block the protocol's own contracts.
- [ ] Verify that administrative policy is clearly documented.

### 13. Wrapped Coin

- [ ] **[CRITICAL]** Does every mint have corresponding locked assets?
- [ ] **[CRITICAL]** Does every burn release no more than the corresponding assets?
- [ ] Does minting occur only after valid deposit confirmation?
- [ ] Is double processing of a deposit prevented?
- [ ] Does every deposit have a unique identifier?
- [ ] Are message nonces or IDs consumed?
- [ ] Does the system prevent cross-chain replay?
- [ ] Are source and destination `chainId` values included in the message?
- [ ] Are source and destination contract addresses included in the message?
- [ ] Is a minimum number of block confirmations required?
- [ ] Are blockchain reorganizations handled?
- [ ] Are per-transaction and per-period limits enforced?
- [ ] Is an emergency pause available?
- [ ] Does the system use multisig or a distributed validator set?
- [ ] Is a minimum signature quorum required?
- [ ] Are duplicate validators rejected?
- [ ] Repeated signatures do not count twice.
- [ ] Validator-set changes cannot take effect instantly.
- [ ] Critical changes have a timelock.
- [ ] The contract maintains collateral accounting.
- [ ] Fees do not break the deposit-to-mint correspondence.
- [ ] Different asset decimals are handled correctly.
- [ ] Rounding cannot create value.
- [ ] A plan exists for stuck assets.
- [ ] A procedure exists for a compromised bridge.
- [ ] Administrative ownership cannot mint arbitrarily without deposit evidence.

### 14. Oracles and prices

- [ ] Do not use prices supplied directly by users.
- [ ] Do not rely solely on instantaneous DEX reserves.
- [ ] Assess flash-loan manipulation.
- [ ] Check price updates and age.
- [ ] Reject stale prices.
- [ ] Check for zero or negative prices when the oracle supports signed values.
- [ ] Define an acceptable range.
- [ ] Use multiple sources when justified by risk.
- [ ] Implement a circuit breaker.
- [ ] Define behavior when the oracle stops.
- [ ] Do not continue financial operations with known stale prices.
- [ ] Test large price changes.
- [ ] Test source unavailability.

### 15. Front-running, MEV, and ordering

- [ ] Identify operations whose public contents allow profitable copying.
- [ ] Protect registration of contested names, DIDs, or identifiers.
- [ ] Consider commit-reveal.
- [ ] Include minimum/maximum prices or slippage limits.
- [ ] Include a deadline.
- [ ] Do not rely on exact transaction ordering.
- [ ] Do not use `block.timestamp` as a secret source.
- [ ] Do not use `blockhash`, timestamp, or difficulty as secure randomness.
- [ ] Assess sandwich attacks on swaps.
- [ ] Prevent operators from observing signatures and executing for their own benefit.
- [ ] Bind signatures to the correct recipient.
- [ ] Bind signatures to the exact function and parameters.

### 16. DoS and gas consumption

- [ ] Do not iterate over unbounded arrays.
- [ ] Do not distribute value to every user in one loop.
- [ ] Use a pull model for withdrawals.
- [ ] Implement pagination.
- [ ] Limit batch sizes.
- [ ] Limit input strings and bytes.
- [ ] Prevent users from growing arrays indefinitely without proportional cost.
- [ ] Avoid expensive array removals.
- [ ] Assess gas griefing.
- [ ] Ensure a malicious recipient cannot block all others.
- [ ] Test with the maximum expected number of records.
- [ ] Verify that administrative functions remain executable with large state.
- [ ] Verify whether bulk revocations are actually necessary.
- [ ] Do not depend on a function that may exceed gas limits in the future.

### 17. Arithmetic and precision

- [ ] Review every `unchecked` block.
- [ ] Use `unchecked` only with documented justification.
- [ ] Check division before multiplication.
- [ ] Assess precision loss.
- [ ] Define rounding rules.
- [ ] Prevent division by zero.
- [ ] Check type conversions.
- [ ] Review casts to smaller types.
- [ ] Check conversions between `uint256` and `int256`.
- [ ] Test minimum and maximum values.
- [ ] Check decimal differences between tokens.
- [ ] Assess accumulated errors in fees, interest, or rewards.
- [ ] Ensure allocated portions do not sum to more than 100%.
- [ ] Validate configurable fees against upper limits.
- [ ] Prevent administrative fees from being configured to 100% or more.

### 18. Events and auditing

- [ ] Emit events for important state changes.
- [ ] Emit events for registration, DID updates, VC issuance, suspension, revocation, minting, burning, deposits, withdrawals, role changes, dependency changes, pauses, and upgrades.
- [ ] Do not rely exclusively on events for critical state.
- [ ] Do not emit personal information.
- [ ] Index only genuinely useful fields.
- [ ] Do not index sensitive data under the assumption that it remains hidden.
- [ ] Ensure events represent the final, actually completed operation.
- [ ] Do not emit success events before a call that may fail.
- [ ] Use clear, consistent names.
- [ ] Monitor administrative events in production.

### 19. Upgradeable contracts

- [ ] **[CRITICAL]** Do not use a `constructor` to initialize implementation contract state.
- [ ] Use an `initialize` function.
- [ ] Protect initialization against a second execution.
- [ ] Disable initializers on the implementation contract.
- [ ] Protect `_authorizeUpgrade`.
- [ ] Do not allow arbitrary users to upgrade.
- [ ] Use multisig and timelock.
- [ ] Verify storage-layout compatibility.
- [ ] Do not change existing variable order.
- [ ] Do not change existing variable types.
- [ ] Do not remove existing variables.
- [ ] Append new variables only at the end.
- [ ] Test upgrades using previously created real state.
- [ ] Verify inherited-module initializers.
- [ ] Do not omit parent-contract initializers.
- [ ] Avoid storage collisions.
- [ ] Check whether attackers can initialize the new implementation.
- [ ] Check for upgrade functions directly exposed on the implementation.
- [ ] Emit an event and document every upgrade.
- [ ] Maintain an operational rollback mechanism.
- [ ] Do not confuse upgrade capability with upgrade safety.

### 20. delegatecall, proxies, and modules

- [ ] Do not use `delegatecall` to user-supplied addresses.
- [ ] Validate every implementation before registering it.
- [ ] Protect changes to facets, modules, and implementations.
- [ ] Check for function-selector collisions.
- [ ] Check for storage collisions.
- [ ] Prevent modules from overwriting administration.
- [ ] Check whether modules can execute `selfdestruct` or destructive calls.
- [ ] Do not assume a facet or library is isolated.
- [ ] Audit the complete system, not only individual modules.
- [ ] Document contracts sharing storage.
- [ ] Test calls through the proxy, not only directly on the implementation.

### 21. Pause and incident response

- [ ] Implement pausing only where it actually reduces risk.
- [ ] Define who can pause.
- [ ] Separate pause and resume authorities when necessary.
- [ ] Define which operations continue while paused.
- [ ] Allow safe withdrawals during certain emergencies, if possible.
- [ ] Do not allow minting or issuance while paused.
- [ ] Prevent alternative functions from bypassing the pause.
- [ ] Emit pause and resume events.
- [ ] Use multisig for critical resumption.
- [ ] Create an incident runbook.
- [ ] Define contacts and responsibilities.
- [ ] Define a key-rotation procedure.
- [ ] Define a procedure for compromised issuers.
- [ ] Define a procedure for fraudulently issued VCs.
- [ ] Define a procedure for insufficient collateral.
- [ ] Define a procedure for compromised bridges or oracles.

### 22. Automated tests

- [ ] Test the happy path.
- [ ] Test every error condition.
- [ ] Test each access modifier.
- [ ] Test unauthorized users.
- [ ] Test the zero address.
- [ ] Test zero values.
- [ ] Test maximum values.
- [ ] Test duplicates.
- [ ] Test signature replay.
- [ ] Test expired signatures.
- [ ] Test signatures for another network.
- [ ] Test signatures for another contract.
- [ ] Test ERC-1271 contracts.
- [ ] Test reentrancy.
- [ ] Test malicious tokens.
- [ ] Test tokens that do not return `bool`.
- [ ] Test fee-on-transfer tokens.
- [ ] Test pausing.
- [ ] Test revocation.
- [ ] Test DID controller rotation.
- [ ] Test expired VCs.
- [ ] Test revoked VCs.
- [ ] Test deactivated DIDs.
- [ ] Test upgrades.
- [ ] Test state preservation after upgrades.
- [ ] Test external-call failures.
- [ ] Test large record counts.
- [ ] Check line, branch, and function coverage.
- [ ] Do not treat 100% coverage as proof of security.

### 23. Fuzzing and invariant tests

- [ ] Create properties that must hold for any call sequence.
- [ ] Run fuzzing with Foundry, Echidna, or an equivalent tool.
- [ ] Test random sequences of registration, issuance, suspension, revocation, transfer, mint, burn, wrap, and unwrap.
- [ ] Test calls from different actors.
- [ ] Test extreme values.
- [ ] Run stateful tests.

**Recommended invariants:**
- `totalSupply` never exceeds `cap`.
- `totalWrapped` never exceeds collateral.
- A revoked VC is never accepted as valid.
- A consumed nonce cannot be reused.
- Only users with `ISSUER_ROLE` may issue credentials.
- A deactivated DID cannot authorize new operations.
- Aggregate balances never exceed total supply.
- No withdrawal exceeds the recorded balance.

### 24. Static and formal analysis

- [ ] Run Slither on every pull request.
- [ ] Manually review every alert.
- [ ] Do not ignore alerts without justification.
- [ ] Use custom detectors for project rules.
- [ ] Run dependency analysis.
- [ ] Use SMTChecker for suitable properties.
- [ ] Consider formal verification for total supply, access control, wrapped-token collateral, replay prevention, permanent revocation, and nonce integrity.
- [ ] Analyze bytecode when justified by criticality.
- [ ] Review differences between audited and deployed code.

> For dApp security, deployment infrastructure, and the final pre-deployment checklist, see `smartcontracts-deploy.md`.

---

## Project-Specific Priorities

For AgenticSpace contracts, the priority order is:

1. Access control and role separation.
2. Signature replay protection.
3. VC and DID privacy.
4. Revocation, suspension, and key rotation.
5. Wrapped-token-to-collateral invariant.
6. Protected minting and burning.
7. Reentrancy and external calls.
8. Safe upgrades and storage layout.
9. Fuzzing and invariant tests.
10. Administrative key and dApp security.

**Architectural recommendation:** Keep personal data and complete credential
content off-chain. Record only the minimum necessary in contracts, such as
hashes, authorized issuers, non-sensitive identifiers, and revocation state.
Blockchain should act as a trust and verification layer, not a public database
of personal documents.
