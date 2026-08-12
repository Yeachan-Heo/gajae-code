import { expect, test } from "bun:test";
import { AuthStorage } from "@gajae-code/ai";
import { BUILTIN_MODEL_PROFILES, type ModelProfileDefinition } from "../src/config/model-profiles";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import {
	CURATED_WORK_MODES,
	type CuratedWorkMode,
	type CuratedWorkModeProfileFailure,
	getCuratedWorkMode,
	validateCuratedWorkModeProfile,
} from "../src/config/work-mode-catalog";
import type { WorkModePreviewResult } from "../src/config/work-mode-result";
import { type WorkModeSessionRuntime, WorkModeTransaction } from "../src/config/work-mode-transaction";

type Effects = {
	setModelTemporary: number;
	setConfiguredModelChain: number;
	setActiveModelProfile: number;
};

type PreviewFixture = {
	authStorage: AuthStorage;
	transaction: WorkModeTransaction;
	effects: Effects;
};

type FixtureOptions = {
	profileMap?: ReadonlyMap<string, ModelProfileDefinition>;
	registryUnavailable?: boolean;
};

function builtinProfiles(): Map<string, ModelProfileDefinition> {
	const profiles = new Map<string, ModelProfileDefinition>();
	for (const profile of BUILTIN_MODEL_PROFILES) profiles.set(profile.name, profile);
	return profiles;
}

function copyProfiles(profiles: ReadonlyMap<string, ModelProfileDefinition>): Map<string, ModelProfileDefinition> {
	const copy = new Map<string, ModelProfileDefinition>();
	for (const [name, profile] of profiles) copy.set(name, profile);
	return copy;
}

async function createPreviewFixture(options: FixtureOptions = {}): Promise<PreviewFixture> {
	const authStorage = await AuthStorage.create(":memory:");
	authStorage.setRuntimeApiKey("openai-codex", "work-mode-test-key");
	authStorage.setRuntimeApiKey("anthropic", "work-mode-test-key");
	const registry = new ModelRegistry(authStorage);
	const profiles = options.profileMap ?? builtinProfiles();
	const initialModel = registry.getAll()[0];
	if (!initialModel) throw new Error("Expected a bundled model for the Work Mode session fixture");

	const effects: Effects = {
		setModelTemporary: 0,
		setConfiguredModelChain: 0,
		setActiveModelProfile: 0,
	};
	const configuredChains = new Map<string, readonly string[]>();
	let activeProfile: string | undefined;
	const session: WorkModeSessionRuntime = {
		sessionId: "work-mode-availability-test",
		model: initialModel,
		thinkingLevel: undefined,
		setModelTemporary: async () => {
			effects.setModelTemporary += 1;
		},
		beginTemporaryProviderSessionScope: reason => ({ reason }),
		restoreTemporaryProviderSessionScope: () => true,
		setActiveModelProfile: profileName => {
			effects.setActiveModelProfile += 1;
			activeProfile = profileName;
		},
		getActiveModelProfile: () => activeProfile,
		getConfiguredModelChain: role => configuredChains.get(role),
		setConfiguredModelChain: (role, entries) => {
			effects.setConfiguredModelChain += 1;
			configuredChains.set(role, [...entries]);
		},
	};

	registry.getModelProfiles = () => {
		if (options.registryUnavailable) throw new Error("model profile registry unavailable");
		return copyProfiles(profiles);
	};
	registry.getModelProfile = name => profiles.get(name);

	const transaction = new WorkModeTransaction({
		session,
		modelRegistry: registry,
		settings: Settings.isolated(),
	});
	return { authStorage, transaction, effects };
}

function expectCatalogIdentity(preview: WorkModePreviewResult, mode: CuratedWorkMode): void {
	const catalog = preview.fingerprint.payload.catalog;
	expect(catalog.presence).toBe("present");
	if (catalog.presence !== "present") throw new Error("Expected a present catalog fingerprint");
	expect(catalog.value.modeId).toBe(mode.id);
	expect(catalog.value.profileId).toBe(mode.profileId);
}

function expectUnavailable(
	preview: WorkModePreviewResult,
	mode: CuratedWorkMode,
	reason: CuratedWorkModeProfileFailure,
): void {
	expect(preview.phase).toBe("preview");
	expect(preview.state).toBe("unavailable");
	if (preview.state !== "unavailable") throw new Error("Expected an unavailable Work Mode preview");
	expect(preview.reason).toBe(reason);
	expect(preview.details).toEqual({ code: reason, category: "profile" });
	expect("facts" in preview).toBe(false);
	expectCatalogIdentity(preview, mode);
}

const zeroEffects = {
	setModelTemporary: 0,
	setConfiguredModelChain: 0,
	setActiveModelProfile: 0,
};

test("catalog lookup preserves direct ordered mode/profile identity and rejects unknown ids", () => {
	expect(CURATED_WORK_MODES.map(mode => getCuratedWorkMode(mode.id)?.profileId)).toEqual([
		"codex-eco",
		"codex-medium",
		"claude-opus",
		"claude-fable",
		"lunamaxxing",
	]);
	expect(getCuratedWorkMode("not-a-curated-mode")).toBeUndefined();
});

test("every curated mode validates against its exact bundled definition", () => {
	const profiles = builtinProfiles();
	for (const mode of CURATED_WORK_MODES) {
		const validation = validateCuratedWorkModeProfile(mode, profiles);
		expect(validation).toMatchObject({
			modeId: mode.id,
			profileId: mode.profileId,
			available: true,
			reason: null,
		});
		expect(validation.bundledDefinition).toBe(validation.effectiveDefinition);
	}
});

test("an exact builtin profile produces a ready preview for only the selected mode/profile", async () => {
	const fixture = await createPreviewFixture();
	const mode = CURATED_WORK_MODES[0];
	try {
		const preview = await fixture.transaction.preview(mode.id);
		expect(preview.state).toBe("ready");
		if (preview.state !== "ready") throw new Error("Expected a ready Work Mode preview");
		expect(preview.facts.mode.id).toBe(mode.id);
		expect(preview.facts.profileId).toBe(mode.profileId);
		expect(preview.fingerprint.payload.catalog.presence).toBe("present");
		expect(preview.fingerprint.payload.effectiveDefinition.presence).toBe("present");
		expect(fixture.effects).toEqual(zeroEffects);
	} finally {
		fixture.authStorage.close();
	}
});

test("missing, malformed, and mapping/provider-mismatched profiles fail closed without substitution", async () => {
	const mode = CURATED_WORK_MODES[1];
	const bundled = BUILTIN_MODEL_PROFILES.find(profile => profile.name === mode.profileId);
	if (!bundled) throw new Error(`Missing bundled profile ${mode.profileId}`);

	const malformed = { ...bundled };
	Object.defineProperty(malformed, "modelMapping", { value: null });
	const mappingMismatch = {
		...bundled,
		modelMapping: { ...bundled.modelMapping, default: "openai-codex/not-the-bundled-selector" },
	};
	const providerMismatch = { ...bundled, requiredProviders: ["anthropic"] };
	const scenarios: readonly {
		profileMap: ReadonlyMap<string, ModelProfileDefinition>;
		reason: CuratedWorkModeProfileFailure;
	}[] = [
		{ profileMap: new Map<string, ModelProfileDefinition>(), reason: "curated_profile_missing" },
		{ profileMap: new Map([[mode.profileId, malformed]]), reason: "curated_profile_malformed" },
		{ profileMap: new Map([[mode.profileId, mappingMismatch]]), reason: "curated_profile_mismatch" },
		{ profileMap: new Map([[mode.profileId, providerMismatch]]), reason: "curated_profile_mismatch" },
	];

	for (const scenario of scenarios) {
		const validation = validateCuratedWorkModeProfile(mode, scenario.profileMap);
		expect(validation.available).toBe(false);
		expect(validation.reason).toBe(scenario.reason);
		const fixture = await createPreviewFixture({ profileMap: scenario.profileMap });
		try {
			const preview = await fixture.transaction.preview(mode.id);
			expectUnavailable(preview, mode, scenario.reason);
			expect(fixture.effects).toEqual(zeroEffects);
		} finally {
			fixture.authStorage.close();
		}
	}
});

test("an unavailable profile registry has one stable reason and never chooses another profile", async () => {
	const mode = CURATED_WORK_MODES[2];
	const fixture = await createPreviewFixture({ registryUnavailable: true });
	try {
		const preview = await fixture.transaction.preview(mode.id);
		expectUnavailable(preview, mode, "model_profile_registry_unavailable");
		expect(fixture.effects).toEqual(zeroEffects);
	} finally {
		fixture.authStorage.close();
	}
});
