// SPDX-License-Identifier: CC-BY-SA-4.0
pragma solidity 0.8.28;

import { AccessControlEnumerableUpgradeable }
    from "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import { RapportCertificateStorage } from "./RapportCertificateStorage.sol";

/// @title Rapport Certificate — Phase Admin Facet
/// @notice Holds phase-administration functions (createPhase,
///         setPhaseExtraFeeType, setPhaseMultipleIssuance,
///         updatePhaseMetadata, setPhasePrerequisites, activatePhase,
///         deactivatePhase) for `RapportCertificateUpgradeable`.
/// @dev This contract is NEVER deployed behind its own proxy and NEVER
///      initialized — it is deployed once as plain logic and reached only
///      via `RapportCertificateUpgradeable.fallback()` + `delegatecall`,
///      which means every state read/write below executes against the
///      MAIN PROXY's storage, not this contract's own (a delegatecall never
///      creates its own storage context). This split exists solely to keep
///      the main implementation under the EIP-170 24576-byte contract size
///      limit — see `RapportCertificateStorage` for why sharing storage this
///      way is safe with the OpenZeppelin Upgradeable v5 mixins in use.
///      `onlyRole(PHASE_MANAGER_ROLE)` below resolves correctly because
///      `AccessControlUpgradeable`'s state lives in an ERC-7201 namespaced
///      slot keyed by a fixed hash, not by declaration order — identical in
///      both this facet and the main contract as long as both inherit the
///      exact same OpenZeppelin version (enforced by a single
///      `package.json` dependency for the whole repo).
contract RapportCertificatePhaseAdminFacet is
    RapportCertificateStorage,
    AccessControlEnumerableUpgradeable
{
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // -----------------------------------------------------------------------
    // Phase management
    // -----------------------------------------------------------------------

    function createPhase(
        string calldata name_,
        bytes32 templateHash,
        uint256 minCasDeposit,
        uint256 startsAt,
        uint256 endsAt,
        string calldata skillsDescription_,
        string calldata instructions_,
        uint256 extraFeeTypeId_,
        uint256 tbaRebateBps_
    ) external onlyRole(PHASE_MANAGER_ROLE) returns (uint256 phaseId) {
        if (bytes(name_).length == 0) revert EmptyName();
        if (templateHash == bytes32(0)) revert EmptyHash();
        if (minCasDeposit == 0) revert InsufficientCasDeposit(1, 0);
        if (tbaRebateBps_ > BPS_DENOMINATOR) {
            revert InvalidRebateBps(tbaRebateBps_, BPS_DENOMINATOR);
        }

        uint256 effectiveStart = startsAt == 0 ? block.timestamp : startsAt;
        if (endsAt != 0 && endsAt <= effectiveStart) {
            revert InvalidPhaseWindow(effectiveStart, endsAt);
        }

        phaseId = ++phaseCount;
        phases[phaseId] = Phase({
            name: name_,
            templateHash: templateHash,
            minCasDeposit: minCasDeposit,
            startsAt: effectiveStart,
            endsAt: endsAt,
            minted: 0,
            active: false,
            skillsDescription: skillsDescription_,
            instructions: instructions_,
            extraFeeTypeId: extraFeeTypeId_,
            tbaRebateBps: tbaRebateBps_,
            // Multiple issuance always starts disabled; use
            // setPhaseMultipleIssuance(phaseId, true, ...) as a follow-up
            // call to enable it — same convention as extraFeeTypeId_/
            // tbaRebateBps_ above being configurable later via
            // setPhaseExtraFeeType.
            allowMultipleIssuance: false,
            maxPerRecipient: 0,
            maxTotalSupply: 0
        });

        emit PhaseCreated(
            phaseId,
            name_,
            templateHash,
            minCasDeposit,
            effectiveStart,
            endsAt
        );

        if (extraFeeTypeId_ != 0 || tbaRebateBps_ != 0) {
            emit PhaseExtraFeeTypeUpdated(phaseId, extraFeeTypeId_, tbaRebateBps_);
        }
    }

    function setPhaseExtraFeeType(
        uint256 phaseId,
        uint256 extraFeeTypeId_,
        uint256 tbaRebateBps_
    ) external onlyRole(PHASE_MANAGER_ROLE) {
        Phase storage phase = phases[phaseId];
        if (bytes(phase.name).length == 0) revert InvalidPhase(phaseId);
        if (tbaRebateBps_ > BPS_DENOMINATOR) {
            revert InvalidRebateBps(tbaRebateBps_, BPS_DENOMINATOR);
        }
        phase.extraFeeTypeId = extraFeeTypeId_;
        phase.tbaRebateBps = tbaRebateBps_;
        emit PhaseExtraFeeTypeUpdated(phaseId, extraFeeTypeId_, tbaRebateBps_);
    }

    /// @notice Enables/updates or disables multiple issuance for a phase.
    /// @dev When `allow` is true, both `maxPerRecipient_` and
    ///      `maxTotalSupply_` are mandatory (> 0), and `maxTotalSupply_`
    ///      cannot be set below the phase's already-minted count nor below
    ///      `maxPerRecipient_`. Disabling (`allow = false`) never invalidates
    ///      certificates already issued — it only blocks new mints beyond
    ///      what each recipient already holds.
    function setPhaseMultipleIssuance(
        uint256 phaseId,
        bool allow,
        uint256 maxPerRecipient_,
        uint256 maxTotalSupply_
    ) external onlyRole(PHASE_MANAGER_ROLE) {
        Phase storage phase = phases[phaseId];
        if (bytes(phase.name).length == 0) revert InvalidPhase(phaseId);
        _validateMultipleIssuanceConfig(allow, maxPerRecipient_, maxTotalSupply_, phase.minted);

        phase.allowMultipleIssuance = allow;
        phase.maxPerRecipient = maxPerRecipient_;
        phase.maxTotalSupply = maxTotalSupply_;
        emit PhaseMultipleIssuanceUpdated(phaseId, allow, maxPerRecipient_, maxTotalSupply_);
    }

    /// @dev Reverts with `MultipleIssuanceConfigInvalid` unless the config is
    ///      internally consistent: when multiple issuance is enabled, both
    ///      caps must be set and the global cap must be >= the per-recipient
    ///      cap and >= what has already been minted. When disabled, the caps
    ///      are ignored (any value is accepted).
    function _validateMultipleIssuanceConfig(
        bool allow,
        uint256 maxPerRecipient_,
        uint256 maxTotalSupply_,
        uint256 currentMinted
    ) private pure {
        if (!allow) return;
        if (
            maxPerRecipient_ == 0 || maxTotalSupply_ == 0
                || maxTotalSupply_ < maxPerRecipient_ || maxTotalSupply_ < currentMinted
        ) {
            revert MultipleIssuanceConfigInvalid(maxPerRecipient_, maxTotalSupply_);
        }
    }

    function updatePhaseMetadata(
        uint256 phaseId,
        string calldata skillsDescription_,
        string calldata instructions_
    ) external onlyRole(PHASE_MANAGER_ROLE) {
        Phase storage phase = phases[phaseId];
        if (bytes(phase.name).length == 0) revert InvalidPhase(phaseId);
        phase.skillsDescription = skillsDescription_;
        phase.instructions = instructions_;
        emit PhaseMetadataUpdated(phaseId, skillsDescription_, instructions_);
    }

    function activatePhase(uint256 phaseId) external onlyRole(PHASE_MANAGER_ROLE) {
        Phase storage phase = phases[phaseId];
        if (bytes(phase.name).length == 0) revert InvalidPhase(phaseId);
        if (activePhases[phaseId]) revert PhaseAlreadyActive(phaseId);

        phase.active = true;
        activePhases[phaseId] = true;
        currentPhaseId = phaseId;
        emit PhaseActivated(phaseId, 0);
    }

    function deactivatePhase(uint256 phaseId) external onlyRole(PHASE_MANAGER_ROLE) {
        Phase storage phase = phases[phaseId];
        if (bytes(phase.name).length == 0) revert InvalidPhase(phaseId);
        if (!activePhases[phaseId]) revert PhaseNotActiveForDeactivation(phaseId);

        phase.active = false;
        activePhases[phaseId] = false;
        if (currentPhaseId == phaseId) {
            currentPhaseId = 0;
        }
        emit PhaseDeactivated(phaseId);
    }

    function setPhasePrerequisites(
        uint256 phaseId,
        uint256[] calldata prerequisitePhaseIds
    ) external onlyRole(PHASE_MANAGER_ROLE) {
        Phase storage phase = phases[phaseId];
        if (bytes(phase.name).length == 0) revert InvalidPhase(phaseId);

        for (uint256 i = 0; i < prerequisitePhaseIds.length; i++) {
            uint256 prereqId = prerequisitePhaseIds[i];
            if (prereqId == phaseId) revert SelfPrerequisite(phaseId);
            if (bytes(phases[prereqId].name).length == 0) {
                revert PrerequisitePhaseNotFound(prereqId);
            }
            if (_wouldCreateCycle(prereqId, phaseId, 0)) {
                revert PrerequisiteCycleDetected(phaseId, prereqId);
            }
        }

        phasePrerequisites[phaseId] = prerequisitePhaseIds;
        emit PhasePrerequisitesSet(phaseId, prerequisitePhaseIds);
    }

    // getPhasePrerequisites removed — read phasePrerequisites mapping directly.

    /// @dev DFS cycle detection using a bitmap to track visited nodes.
    ///      Each bit position represents a phase ID. This avoids array
    ///      allocations that bloat bytecode.
    function _wouldCreateCycle(
        uint256 current,
        uint256 target,
        uint256 visitedBitmap
    ) internal view returns (bool) {
        if (current == target) return true;
        if (visitedBitmap & (1 << current) != 0) return false;
        visitedBitmap |= (1 << current);

        uint256[] storage prereqs = phasePrerequisites[current];
        for (uint256 i = 0; i < prereqs.length; i++) {
            if (_wouldCreateCycle(prereqs[i], target, visitedBitmap)) {
                return true;
            }
        }
        return false;
    }
}
