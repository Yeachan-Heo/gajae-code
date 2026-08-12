import { expect, test } from "bun:test";
import { BUILTIN_MODEL_PROFILES } from "../src/config/model-profiles";
import { getCuratedWorkMode, type WorkModeId } from "../src/config/work-mode-catalog";
import type { WorkModeExecutionCaseMap } from "../src/config/work-mode-execution-cases";
import {
	buildWorkModeRoleTuple,
	computeWorkModeFingerprint,
	definitionFactFromProfile,
	presentFingerprintFact,
	type ReadinessFact,
	type RoleResolutionFact,
	relateWorkModeFingerprints,
	type WorkModeEventPhase,
	type WorkModeFingerprint,
	type WorkModeFingerprintInput,
	type WorkModeOperationReceipt,
	type WorkModePreviewResult,
	type WorkModeRoleReadiness,
} from "../src/config/work-mode-result";
import {
	adaptWorkModeOperation,
	adaptWorkModePreview,
	createWorkModeExplainView,
	createWorkModePreviewView,
	createWorkModeReceiptView,
	createWorkModeStatusView,
	renderWorkModeExplainLines,
	renderWorkModePreviewLines,
	renderWorkModeStatusLines,
} from "../src/config/work-mode-view";

function buildFingerprint(modeId: WorkModeId): WorkModeFingerprint {
	const mode = getCuratedWorkMode(modeId);
	if (!mode) throw new Error(`Unknown Work Mode: ${modeId}`);
	const profile = BUILTIN_MODEL_PROFILES.find(candidate => candidate.name === mode.profileId);
	if (!profile) throw new Error(`Missing bundled profile: ${mode.profileId}`);
	const definition = definitionFactFromProfile(profile, profile.name);
	if (!definition) throw new Error(`Missing profile facts: ${profile.name}`);
	const readiness: ReadinessFact = {
		strictProviders: profile.requiredProviders.map(providerId => ({ providerId, state: "ready" })),
		alternativeGroups: [],
	};
	const input: WorkModeFingerprintInput = {
		catalog: presentFingerprintFact({
			version: 1,
			modeId: mode.id,
			profileId: mode.profileId,
			entryDigest: `entry:${mode.id}`,
		}),
		bundledDefinition: presentFingerprintFact(definition),
		effectiveDefinition: presentFingerprintFact(definition),
		registryResolution: presentFingerprintFact({
			registryRevision: "registry",
			resolutionRevision: "resolution",
			resolutionDigest: "digest",
		}),
		readiness: presentFingerprintFact(readiness),
		roles: buildWorkModeRoleTuple((_index, role) => {
			const requested = profile.modelMapping[role] ?? null;
			const fact: RoleResolutionFact = {
				role,
				requested,
				resolved: requested === null ? null : String(requested),
				effort: requested === null ? null : "high",
				state: requested === null ? "not_configured" : "resolved",
			};
			return presentFingerprintFact(fact);
		}),
		fallback: presentFingerprintFact({
			defaultChain: [String(profile.modelMapping.default ?? "")],
			activeIndex: 0,
			skips: [],
		}),
		confirmation: { required: false, roleDegradation: [] },
	};
	return computeWorkModeFingerprint(input);
}

function buildPreview(modeId: WorkModeId): WorkModePreviewResult {
	const mode = getCuratedWorkMode(modeId);
	if (!mode) throw new Error(`Unknown Work Mode: ${modeId}`);
	const roleReadiness: WorkModeRoleReadiness = { kind: "complete", confirmation: "not_required" };
	return {
		phase: "preview",
		state: "ready",
		fingerprint: buildFingerprint(modeId),
		facts: {
			mode,
			profileId: mode.profileId,
			requestedRoleReadiness: roleReadiness,
		},
		roleReadiness,
		confirmationRequired: false,
	};
}

function equalRelation(fingerprint: WorkModeFingerprint) {
	const relation = relateWorkModeFingerprints(fingerprint, fingerprint);
	if (relation.kind !== "equal") throw new Error("Expected equal fingerprint relation");
	return relation;
}

function buildReceipt(phase: WorkModeEventPhase, fingerprint: WorkModeFingerprint): WorkModeOperationReceipt {
	const relation = equalRelation(fingerprint);
	const roleReadiness: WorkModeRoleReadiness = { kind: "complete", confirmation: "not_required" };
	return {
		schema: "work-mode-receipt.v1",
		version: 1,
		receiptId: `${phase}-receipt`,
		operationId: `${phase}-operation`,
		phase,
		scope: "session",
		acceptedFingerprint: fingerprint,
		observedFingerprint: fingerprint,
		relation,
		roleReadiness,
		confirmation: { required: false, accepted: true },
		durable: { kind: "not_requested" },
		runtime: { kind: "applied" },
		reason: null,
		timing: { startedAt: 100, finishedAt: 125 },
		facts: { modeId: "quick-edit", profileId: "codex-eco" },
	};
}

function buildEvent(fingerprint: WorkModeFingerprint): WorkModeExecutionCaseMap["session_apply.ready"] {
	const relation = equalRelation(fingerprint);
	const roleReadiness: WorkModeRoleReadiness = { kind: "complete", confirmation: "not_required" };
	const receipt = buildReceipt("session_apply", fingerprint);
	return {
		caseId: "session_apply.ready",
		phase: "session_apply",
		state: "ready",
		operationId: "session_apply-operation",
		acceptedFingerprint: fingerprint,
		observedFingerprint: fingerprint,
		relation,
		roleReadiness,
		confirmation: { required: false, accepted: true },
		durable: { kind: "not_requested" },
		runtime: { kind: "applied" },
		receipt,
		appliedFingerprint: fingerprint,
	};
}

test("keeps keyboard and pointer consumers on the same status/explain adapter and falls back to Custom profile", () => {
	const preview = buildPreview("quick-edit");
	const previewView = createWorkModePreviewView("quick-edit", preview);
	const explainView = createWorkModeExplainView("quick-edit", preview);
	const adaptedPreview = adaptWorkModePreview("quick-edit", preview);

	expect(explainView).toEqual(previewView);
	expect(adaptedPreview).toEqual(previewView);
	expect(renderWorkModeExplainLines(explainView, 96)).toEqual(renderWorkModePreviewLines(previewView, 96));
	expect(createWorkModeExplainView).toBe(createWorkModePreviewView);
	expect(adaptWorkModePreview).toBe(createWorkModePreviewView);

	const event = buildEvent(preview.fingerprint);
	const qualifiedOptions: {
		readonly currentProfileId: string;
		readonly currentFingerprint: WorkModeFingerprint;
		readonly currentPhase: WorkModeEventPhase;
	} = {
		currentProfileId: "codex-eco",
		currentFingerprint: preview.fingerprint,
		currentPhase: "session_apply",
	};
	const keyboardStatus = createWorkModeStatusView(event, qualifiedOptions);
	const pointerStatus = adaptWorkModeOperation(event, qualifiedOptions);
	expect(pointerStatus).toEqual(keyboardStatus);
	expect(keyboardStatus).toMatchObject({
		status: "applied",
		label: "Quick Edit",
		qualification: { qualified: true, modeId: "quick-edit", profileId: "codex-eco", relation: "equal" },
		classification: { kind: "curated", modeId: "quick-edit", profileId: "codex-eco" },
		receipt: {
			operationId: "session_apply-operation",
			receiptId: "session_apply-receipt",
			scope: "session",
			phase: "session_apply",
			durable: "not_requested",
			runtime: "applied",
		},
	});
	expect(createWorkModeReceiptView(event)).toEqual(event.receipt);
	expect(renderWorkModeStatusLines(keyboardStatus, 96)).toEqual([
		"Quick Edit: applied",
		"Work Mode applied for this session.",
		"Recovery: Review Work Mode",
		"Classification: curated",
	]);

	const customStatus = createWorkModeStatusView(event, {
		currentProfileId: "my-custom-profile",
		currentFingerprint: preview.fingerprint,
		currentPhase: "session_apply",
	});
	expect(customStatus).toMatchObject({
		status: "applied",
		label: "Custom profile",
		qualification: { qualified: false, modeId: "quick-edit", profileId: "codex-eco", relation: "equal" },
		classification: { kind: "custom", profileId: "my-custom-profile", reason: "unavailable" },
	});
	expect(renderWorkModeStatusLines(customStatus, 96)).toContain("Custom profile: applied");
});
