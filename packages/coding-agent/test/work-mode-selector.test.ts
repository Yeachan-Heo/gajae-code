import { expect, test } from "bun:test";
import { BUILTIN_MODEL_PROFILES } from "../src/config/model-profiles";
import { CURATED_WORK_MODES, getCuratedWorkMode, type WorkModeId } from "../src/config/work-mode-catalog";
import {
	buildWorkModeRoleTuple,
	type CatalogFact,
	computeWorkModeFingerprint,
	definitionFactFromProfile,
	type FallbackFact,
	presentFingerprintFact,
	type ReadinessFact,
	type RoleResolutionFact,
	WORK_MODE_ROLE_IDS,
	type WorkModeFacts,
	type WorkModeFingerprintInput,
	type WorkModePreviewResult,
	type WorkModeRoleReadiness,
} from "../src/config/work-mode-result";
import { createWorkModePreviewView, renderWorkModePreviewLines } from "../src/config/work-mode-view";

function buildFingerprint(modeId: WorkModeId) {
	const mode = getCuratedWorkMode(modeId);
	if (!mode) throw new Error(`Unknown Work Mode: ${modeId}`);
	const profile = BUILTIN_MODEL_PROFILES.find(candidate => candidate.name === mode.profileId);
	if (!profile) throw new Error(`Missing bundled profile: ${mode.profileId}`);
	const definition = definitionFactFromProfile(profile, profile.name);
	if (!definition) throw new Error(`Missing profile facts: ${profile.name}`);

	const catalog: CatalogFact = {
		version: 1,
		modeId: mode.id,
		profileId: mode.profileId,
		entryDigest: `catalog-entry:${mode.id}`,
	};
	const readiness: ReadinessFact = {
		strictProviders: profile.requiredProviders.map(providerId => ({ providerId, state: "ready" })),
		alternativeGroups: (profile.alternativeProviderGroups ?? []).map(providerIds => ({
			providerIds,
			state: "ready",
			selectedProviderId: providerIds[0] ?? null,
		})),
	};
	const roleFacts = buildWorkModeRoleTuple((_index, role) => {
		const requested = profile.modelMapping[role] ?? null;
		const fact: RoleResolutionFact = {
			role,
			requested,
			resolved: requested === null ? null : String(requested),
			effort: requested === null ? null : "high",
			state: requested === null ? "not_configured" : "resolved",
		};
		return presentFingerprintFact(fact);
	});
	const fallback: FallbackFact = {
		defaultChain: [String(profile.modelMapping.default ?? "")],
		activeIndex: 0,
		skips: [{ selector: "openai-codex/fallback", reason: "credential unavailable" }],
	};
	const input: WorkModeFingerprintInput = {
		catalog: presentFingerprintFact(catalog),
		bundledDefinition: presentFingerprintFact(definition),
		effectiveDefinition: presentFingerprintFact(definition),
		registryResolution: presentFingerprintFact({
			registryRevision: "registry-revision",
			resolutionRevision: "resolution-revision",
			resolutionDigest: "resolution-digest",
		}),
		readiness: presentFingerprintFact(readiness),
		roles: roleFacts,
		fallback: presentFingerprintFact(fallback),
		confirmation: { required: false, roleDegradation: [] },
	};
	return computeWorkModeFingerprint(input);
}

function buildPreview(modeId: WorkModeId): WorkModePreviewResult {
	const mode = getCuratedWorkMode(modeId);
	if (!mode) throw new Error(`Unknown Work Mode: ${modeId}`);
	const profile = BUILTIN_MODEL_PROFILES.find(candidate => candidate.name === mode.profileId);
	if (!profile) throw new Error(`Missing bundled profile: ${mode.profileId}`);
	const roleReadiness: WorkModeRoleReadiness = {
		kind: "complete",
		confirmation: "not_required",
	};
	const facts: WorkModeFacts = {
		mode,
		profileId: profile.name,
		requestedRoleReadiness: roleReadiness,
	};
	return {
		phase: "preview",
		state: "ready",
		fingerprint: buildFingerprint(modeId),
		facts,
		roleReadiness,
		confirmationRequired: false,
	};
}

test("exposes exact five-role profile, fallback, and fingerprint facts through the selector view", () => {
	const preview = buildPreview("quick-edit");
	const view = createWorkModePreviewView("quick-edit", preview);

	expect(WORK_MODE_ROLE_IDS).toEqual(["default", "executor", "planner", "critic", "architect"]);
	expect(view.roles).toEqual([
		{
			role: "default",
			requested: "openai-codex/gpt-5.6-terra:low",
			resolved: "openai-codex/gpt-5.6-terra:low",
			effort: "high",
			state: "resolved",
		},
		{
			role: "executor",
			requested: "openai-codex/gpt-5.6-luna:low",
			resolved: "openai-codex/gpt-5.6-luna:low",
			effort: "high",
			state: "resolved",
		},
		{
			role: "planner",
			requested: "openai-codex/gpt-5.6-luna:high",
			resolved: "openai-codex/gpt-5.6-luna:high",
			effort: "high",
			state: "resolved",
		},
		{
			role: "critic",
			requested: "openai-codex/gpt-5.6-terra:xhigh",
			resolved: "openai-codex/gpt-5.6-terra:xhigh",
			effort: "high",
			state: "resolved",
		},
		{
			role: "architect",
			requested: "openai-codex/gpt-5.6-terra:high",
			resolved: "openai-codex/gpt-5.6-terra:high",
			effort: "high",
			state: "resolved",
		},
	]);
	expect(view.profileId).toBe("codex-eco");
	expect(view.classification).toEqual({ kind: "curated", modeId: "quick-edit", profileId: "codex-eco" });
	expect(view.fallback).toEqual({
		defaultChain: ["openai-codex/gpt-5.6-terra:low"],
		activeIndex: 0,
		skips: [{ selector: "openai-codex/fallback", reason: "credential unavailable" }],
	});
	expect(view.providerReadiness).toEqual({
		strictProviders: [{ providerId: "openai-codex", state: "ready" }],
		alternativeGroups: [],
	});
	expect(view.fingerprint).toEqual({
		digest: preview.fingerprint.digest,
		qualified: true,
		catalogEntryDigest: "catalog-entry:quick-edit",
	});
	expect(preview.fingerprint.payload.catalog).toEqual({
		presence: "present",
		value: {
			version: 1,
			modeId: "quick-edit",
			profileId: "codex-eco",
			entryDigest: "catalog-entry:quick-edit",
		},
	});
	expect(renderWorkModePreviewLines(view, 120)).toEqual([
		"Quick Edit — Short, constrained code changes.",
		"Classification: curated",
		"Profile: codex-eco",
		"State: ready",
		`Fingerprint: qualified ${preview.fingerprint.digest}`,
		"Required provider: openai-codex (ready)",
		"default: requested openai-codex/gpt-5.6-terra:low; resolved openai-codex/gpt-5.6-terra:low; effort high (resolved)",
		"executor: requested openai-codex/gpt-5.6-luna:low; resolved openai-codex/gpt-5.6-luna:low; effort high (resolved)",
		"planner: requested openai-codex/gpt-5.6-luna:high; resolved openai-codex/gpt-5.6-luna:high; effort high (resolved)",
		"critic: requested openai-codex/gpt-5.6-terra:xhigh; resolved openai-codex/gpt-5.6-terra:xhigh; effort high (resolved)",
		"architect: requested openai-codex/gpt-5.6-terra:high; resolved openai-codex/gpt-5.6-terra:high; effort high (resolved)",
		"Fallback chain: openai-codex/gpt-5.6-terra:low",
		"Fallback skipped: openai-codex/fallback (credential unavailable)",
	]);

	for (const mode of CURATED_WORK_MODES) {
		const modePreview = buildPreview(mode.id);
		const modeView = createWorkModePreviewView(mode.id, modePreview);
		expect(modeView.profileId).toBe(mode.profileId);
		expect(modeView.roles).toHaveLength(5);
		expect(modeView.fingerprint.qualified).toBe(true);
	}
});
