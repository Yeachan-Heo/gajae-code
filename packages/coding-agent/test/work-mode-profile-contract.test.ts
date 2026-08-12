import { expect, test } from "bun:test";
import { BUILTIN_MODEL_PROFILES, type ModelProfileDefinition } from "../src/config/model-profiles";
import {
	CURATED_WORK_MODES,
	modelProfileDefinitionsEqual,
	validateCuratedWorkModeProfile,
} from "../src/config/work-mode-catalog";

function bundledProfiles(): ReadonlyMap<string, ModelProfileDefinition> {
	return new Map(BUILTIN_MODEL_PROFILES.map(profile => [profile.name, profile]));
}

test("curated ids use the exact approved builtin provider and five-role mappings", () => {
	const expected = [
		{
			profileId: "codex-eco",
			requiredProviders: ["openai-codex"],
			modelMapping: {
				default: "openai-codex/gpt-5.6-terra:low",
				executor: "openai-codex/gpt-5.6-luna:low",
				planner: "openai-codex/gpt-5.6-luna:high",
				critic: "openai-codex/gpt-5.6-terra:xhigh",
				architect: "openai-codex/gpt-5.6-terra:high",
			},
		},
		{
			profileId: "codex-medium",
			requiredProviders: ["openai-codex"],
			modelMapping: {
				default: "openai-codex/gpt-5.6-sol:low",
				executor: "openai-codex/gpt-5.6-terra:low",
				planner: "openai-codex/gpt-5.6-terra:high",
				critic: "openai-codex/gpt-5.6-sol:xhigh",
				architect: "openai-codex/gpt-5.6-sol:high",
			},
		},
		{
			profileId: "claude-opus",
			requiredProviders: ["anthropic"],
			modelMapping: {
				default: "anthropic/claude-opus-5:xhigh",
				executor: "anthropic/claude-sonnet-5",
				planner: "anthropic/claude-opus-5:low",
				critic: "anthropic/claude-opus-5:high",
				architect: "anthropic/claude-opus-5:xhigh",
			},
		},
		{
			profileId: "claude-fable",
			requiredProviders: ["anthropic"],
			modelMapping: {
				default: "anthropic/claude-fable-5:xhigh",
				executor: "anthropic/claude-sonnet-5",
				planner: "anthropic/claude-fable-5:low",
				critic: "anthropic/claude-fable-5:high",
				architect: "anthropic/claude-fable-5:xhigh",
			},
		},
		{
			profileId: "lunamaxxing",
			requiredProviders: ["openai-codex"],
			modelMapping: {
				default: "openai-codex/gpt-5.6-luna:medium",
				executor: "openai-codex/gpt-5.6-luna:xhigh",
				planner: "openai-codex/gpt-5.6-luna:max",
				critic: "openai-codex/gpt-5.6-luna:max",
				architect: "openai-codex/gpt-5.6-luna:max",
			},
		},
	];

	for (const expectedProfile of expected) {
		const profile = BUILTIN_MODEL_PROFILES.find(candidate => candidate.name === expectedProfile.profileId);
		expect(profile?.source).toBe("builtin");
		expect(profile?.requiredProviders).toEqual(expectedProfile.requiredProviders);
		expect(profile?.alternativeProviderGroups).toBeUndefined();
		expect(profile?.modelMapping).toEqual(expectedProfile.modelMapping);
	}
});

test("every curated profile validates only against its exact bundled definition", () => {
	const profiles = bundledProfiles();

	for (const mode of CURATED_WORK_MODES) {
		const validation = validateCuratedWorkModeProfile(mode, profiles);
		expect(validation).toMatchObject({
			modeId: mode.id,
			profileId: mode.profileId,
			available: true,
			reason: null,
		});
		expect(validation.bundledDefinition).toEqual(validation.effectiveDefinition);
	}
});

test("missing and user-shadowed curated profiles fail closed", () => {
	const mode = CURATED_WORK_MODES[1];
	const missing = validateCuratedWorkModeProfile(mode, new Map());
	expect(missing.available).toBe(false);
	expect(missing.reason).toBe("curated_profile_missing");
	expect(missing.bundledDefinition?.name).toBe(mode.profileId);
	expect(missing.effectiveDefinition).toBeUndefined();

	const bundled = BUILTIN_MODEL_PROFILES.find(profile => profile.name === mode.profileId);
	if (!bundled) throw new Error(`Missing bundled profile ${mode.profileId}`);
	const shadowed: ModelProfileDefinition = { ...bundled, source: "user" };
	const shadowedResult = validateCuratedWorkModeProfile(mode, new Map([[mode.profileId, shadowed]]));
	expect(shadowedResult.available).toBe(false);
	expect(shadowedResult.reason).toBe("curated_profile_shadowed");
	expect(shadowedResult.effectiveDefinition?.source).toBe("user");
});

test("malformed and mapping-mismatched effective profiles fail closed", () => {
	const mode = CURATED_WORK_MODES[0];
	const bundled = BUILTIN_MODEL_PROFILES.find(profile => profile.name === mode.profileId);
	if (!bundled) throw new Error(`Missing bundled profile ${mode.profileId}`);

	const malformed = { ...bundled };
	Object.defineProperty(malformed, "modelMapping", { value: null });
	const malformedResult = validateCuratedWorkModeProfile(mode, new Map([[mode.profileId, malformed]]));
	expect(malformedResult.available).toBe(false);
	expect(malformedResult.reason).toBe("curated_profile_malformed");

	const mismatched = {
		...bundled,
		modelMapping: { ...bundled.modelMapping, default: "openai-codex/not-the-bundled-selector" },
	};
	const mismatchedResult = validateCuratedWorkModeProfile(mode, new Map([[mode.profileId, mismatched]]));
	expect(mismatchedResult.available).toBe(false);
	expect(mismatchedResult.reason).toBe("curated_profile_mismatch");
});

test("profile-definition equality canonicalizes provider ordering but not semantic changes", () => {
	const left: ModelProfileDefinition = {
		name: "fixture",
		requiredProviders: ["provider-b", "provider-a"],
		alternativeProviderGroups: [["provider-y", "provider-x"]],
		modelMapping: {
			default: "provider-a/default",
			executor: "provider-a/executor",
		},
		source: "builtin",
	};
	const reordered: ModelProfileDefinition = {
		name: "fixture",
		requiredProviders: ["provider-a", "provider-b"],
		alternativeProviderGroups: [["provider-y", "provider-x"]],
		modelMapping: {
			executor: "provider-a/executor",
			default: "provider-a/default",
		},
		source: "builtin",
	};
	const changed: ModelProfileDefinition = {
		...reordered,
		modelMapping: { ...reordered.modelMapping, executor: "provider-a/different" },
	};

	expect(modelProfileDefinitionsEqual(left, reordered)).toBe(true);
	expect(modelProfileDefinitionsEqual(left, changed)).toBe(false);
});
