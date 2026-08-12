import { expect, test } from "bun:test";
import { AuthStorage } from "@gajae-code/ai";
import { BUILTIN_MODEL_PROFILES, type ModelProfileDefinition } from "../src/config/model-profiles";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import {
	CURATED_WORK_MODES,
	type CuratedWorkMode,
	validateCuratedWorkModeProfile,
} from "../src/config/work-mode-catalog";
import type { WorkModePreviewResult } from "../src/config/work-mode-result";
import { type WorkModeSessionRuntime, WorkModeTransaction } from "../src/config/work-mode-transaction";

type Effects = {
	setModelTemporary: number;
	setConfiguredModelChain: number;
	setActiveModelProfile: number;
};

type ShadowFixture = {
	authStorage: AuthStorage;
	transaction: WorkModeTransaction;
	effects: Effects;
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

async function createShadowFixture(profiles: ReadonlyMap<string, ModelProfileDefinition>): Promise<ShadowFixture> {
	const authStorage = await AuthStorage.create(":memory:");
	authStorage.setRuntimeApiKey("openai-codex", "work-mode-test-key");
	const registry = new ModelRegistry(authStorage);
	const initialModel = registry.getAll()[0];
	if (!initialModel) throw new Error("Expected a bundled model for the Work Mode shadow fixture");

	const effects: Effects = {
		setModelTemporary: 0,
		setConfiguredModelChain: 0,
		setActiveModelProfile: 0,
	};
	const configuredChains = new Map<string, readonly string[]>();
	let activeProfile: string | undefined;
	const session: WorkModeSessionRuntime = {
		sessionId: "work-mode-shadowing-test",
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

	registry.getModelProfiles = () => copyProfiles(profiles);
	registry.getModelProfile = name => profiles.get(name);
	const transaction = new WorkModeTransaction({
		session,
		modelRegistry: registry,
		settings: Settings.isolated(),
	});
	return { authStorage, transaction, effects };
}

function expectShadowUnavailable(preview: WorkModePreviewResult, mode: CuratedWorkMode): void {
	expect(preview.phase).toBe("preview");
	expect(preview.state).toBe("unavailable");
	if (preview.state !== "unavailable") throw new Error("Expected a shadowed Work Mode to be unavailable");
	expect(preview.reason).toBe("curated_profile_shadowed");
	expect(preview.details).toEqual({ code: "curated_profile_shadowed", category: "profile" });
	expect("facts" in preview).toBe(false);

	const catalog = preview.fingerprint.payload.catalog;
	expect(catalog.presence).toBe("present");
	if (catalog.presence !== "present") throw new Error("Expected a present catalog fingerprint");
	expect(catalog.value.modeId).toBe(mode.id);
	expect(catalog.value.profileId).toBe(mode.profileId);
	expect(preview.fingerprint.payload.effectiveDefinition).toEqual({
		presence: "missing",
		reason: "curated_profile_shadowed",
	});
}

test("a user definition with a curated id is shadowing, not a replacement route", async () => {
	const mode = CURATED_WORK_MODES[1];
	const bundled = BUILTIN_MODEL_PROFILES.find(profile => profile.name === mode.profileId);
	if (!bundled) throw new Error(`Missing bundled profile ${mode.profileId}`);
	const shadowed: ModelProfileDefinition = { ...bundled, source: "user" };
	const profiles = builtinProfiles();
	profiles.set(mode.profileId, shadowed);

	const validation = validateCuratedWorkModeProfile(mode, profiles);
	expect(validation).toMatchObject({
		modeId: mode.id,
		profileId: mode.profileId,
		available: false,
		reason: "curated_profile_shadowed",
	});
	expect(validation.bundledDefinition).toBe(bundled);
	expect(validation.effectiveDefinition).toBe(shadowed);

	const fixture = await createShadowFixture(profiles);
	try {
		const preview = await fixture.transaction.preview(mode.id);
		expectShadowUnavailable(preview, mode);
		expect(fixture.effects).toEqual({
			setModelTemporary: 0,
			setConfiguredModelChain: 0,
			setActiveModelProfile: 0,
		});
	} finally {
		fixture.authStorage.close();
	}
});
