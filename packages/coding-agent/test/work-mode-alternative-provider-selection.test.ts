import { expect, test } from "bun:test";
import { type Api, AuthStorage, type Model } from "@gajae-code/ai";
import { BUILTIN_MODEL_PROFILES, type ModelProfileDefinition } from "../src/config/model-profiles";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import type { WorkModeSessionRuntime } from "../src/config/work-mode-transaction";
import { WorkModeTransaction } from "../src/config/work-mode-transaction";

const ROLE_MODEL_IDS = ["default", "executor", "planner", "critic", "architect"] as const;

function makeModel(provider: string, id: string): Model<Api> {
	return {
		provider,
		id,
		name: id,
		api: "openai-responses",
		baseUrl: "",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 1000,
	};
}

function installAlternativeProfile(group: readonly string[]): {
	profile: ModelProfileDefinition;
	restore: () => void;
} {
	const profile = BUILTIN_MODEL_PROFILES.find(candidate => candidate.name === "codex-eco");
	if (!profile) throw new Error("Missing codex-eco profile");
	const original = {
		...profile,
		requiredProviders: [...profile.requiredProviders],
		alternativeProviderGroups: profile.alternativeProviderGroups?.map(candidate => [...candidate]),
		modelMapping: { ...profile.modelMapping },
	};
	const modelMapping = Object.fromEntries(ROLE_MODEL_IDS.map(role => [role, `missing-provider/${role}`]));
	Object.assign(profile, {
		requiredProviders: [...group],
		alternativeProviderGroups: [group],
		modelMapping,
	});
	return {
		profile,
		restore: () => Object.assign(profile, original),
	};
}

async function makeFixture(
	profile: ModelProfileDefinition,
	authenticatedProviders: ReadonlySet<string>,
): Promise<{ transaction: WorkModeTransaction; close: () => void }> {
	const authStorage = await AuthStorage.create(":memory:");
	const registry = new ModelRegistry(authStorage);
	const models = [
		...ROLE_MODEL_IDS.map(role => makeModel("alt-a", role)),
		...ROLE_MODEL_IDS.map(role => makeModel("alt-b", role)),
	];
	registry.getModelProfiles = () => new Map([[profile.name, profile]]);
	registry.getModelProfile = (name: string) => (name === profile.name ? profile : undefined);
	registry.getAvailableModelProfileNames = () => [profile.name];
	registry.getApiKeyForProvider = async (provider: string) =>
		authenticatedProviders.has(provider) ? `key-${provider}` : undefined;
	registry.getAll = () => models;
	registry.resolveCanonicalModel = () => undefined;
	registry.getCanonicalVariants = () => [];
	registry.getCanonicalId = () => undefined;

	const configuredChains = new Map<string, readonly string[]>();
	let activeProfile: string | undefined;
	const session: WorkModeSessionRuntime = {
		sessionId: "work-mode-alternative-selection-session",
		model: models[0],
		thinkingLevel: undefined,
		setModelTemporary: async () => {},
		beginTemporaryProviderSessionScope: () => ({ reason: "work-mode-turn" }),
		restoreTemporaryProviderSessionScope: () => true,
		setActiveModelProfile: profileName => {
			activeProfile = profileName;
		},
		getActiveModelProfile: () => activeProfile,
		getConfiguredModelChain: role => configuredChains.get(role),
		setConfiguredModelChain: (role, entries) => {
			configuredChains.set(role, [...entries]);
		},
	};
	return {
		transaction: new WorkModeTransaction({
			session,
			modelRegistry: registry,
			settings: Settings.isolated({ modelRoles: {}, "task.agentModelOverrides": {} }),
		}),
		close: () => authStorage.close(),
	};
}

test("alternative selection follows definition order and fresh preflight fingerprints expose the change", async () => {
	const firstGroup = ["missing-provider", "alt-a", "alt-b"] as const;
	const secondGroup = ["missing-provider", "alt-b", "alt-a"] as const;
	const { profile, restore } = installAlternativeProfile(firstGroup);
	const fixture = await makeFixture(profile, new Set(["alt-a", "alt-b"]));
	try {
		const firstPreview = await fixture.transaction.preview("quick-edit");
		expect(firstPreview.state).toBe("ready");
		if (firstPreview.state !== "ready") throw new Error("Expected the first Work Mode preview to be ready");
		expect(firstPreview.fingerprint.payload.readiness).toEqual({
			presence: "present",
			value: {
				strictProviders: [],
				alternativeGroups: [{ providerIds: [...firstGroup], state: "ready", selectedProviderId: "alt-a" }],
			},
		});
		expect(firstPreview.fingerprint.payload.roles[0]).toEqual(
			expect.objectContaining({
				presence: "present",
				value: expect.objectContaining({ resolved: "alt-a/default" }),
			}),
		);

		profile.requiredProviders = [...secondGroup];
		profile.alternativeProviderGroups = [secondGroup];
		const secondPreview = await fixture.transaction.preview("quick-edit");
		expect(secondPreview.state).toBe("ready");
		if (secondPreview.state !== "ready") throw new Error("Expected the second Work Mode preview to be ready");
		expect(secondPreview.fingerprint.payload.readiness).toEqual({
			presence: "present",
			value: {
				strictProviders: [],
				alternativeGroups: [{ providerIds: [...secondGroup], state: "ready", selectedProviderId: "alt-b" }],
			},
		});
		expect(secondPreview.fingerprint.payload.roles[0]).toEqual(
			expect.objectContaining({
				presence: "present",
				value: expect.objectContaining({ resolved: "alt-b/default" }),
			}),
		);
		expect(secondPreview.fingerprint.digest).not.toBe(firstPreview.fingerprint.digest);
	} finally {
		fixture.close();
		restore();
	}
});
