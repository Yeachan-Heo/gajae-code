import { describe, expect, test } from "bun:test";
import { ThinkingLevel } from "@gajae-code/agent-core";
import type { Model } from "@gajae-code/ai";
import { activateModelProfile, prepareModelProfileActivation } from "../src/config/model-profile-activation";
import type { ModelProfileDefinition } from "../src/config/model-profiles";
import { BUILTIN_MODEL_PROFILES } from "../src/config/model-profiles";
import { Settings } from "../src/config/settings";

const codexModel = {
	id: "gpt-5.5",
	name: "gpt-5.5",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://codex.example.test",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 272_000,
	maxTokens: 128_000,
	thinking: {
		mode: "effort",
		minLevel: ThinkingLevel.Low,
		maxLevel: ThinkingLevel.XHigh,
	},
} satisfies Model<"openai-codex-responses">;

const codexSolModel = {
	...codexModel,
	id: "gpt-5.6-sol",
	name: "gpt-5.6-sol",
	contextWindow: 373_000,
} satisfies Model<"openai-codex-responses">;

const codexTerraModel = {
	...codexSolModel,
	id: "gpt-5.6-terra",
	name: "gpt-5.6-terra",
} satisfies Model<"openai-codex-responses">;

const codexLunaModel = {
	...codexSolModel,
	id: "gpt-5.6-luna",
	name: "gpt-5.6-luna",
} satisfies Model<"openai-codex-responses">;

interface TestSession {
	model: Model | undefined;
	thinkingLevel: ThinkingLevel | undefined;
	readonly sessionId: string;
	readonly setModelTemporaryCalls: Array<{ model: Model; thinkingLevel?: ThinkingLevel }>;
	setModelTemporary(next: Model, thinkingLevel?: ThinkingLevel): Promise<void>;
	setActiveModelProfile(name: string | undefined): void;
	getActiveModelProfile(): string | undefined;
}

function fakeRegistry(extraProfiles: ModelProfileDefinition[] = []) {
	const profiles = new Map<string, ModelProfileDefinition>();
	for (const profile of BUILTIN_MODEL_PROFILES) profiles.set(profile.name, profile);
	for (const profile of extraProfiles) profiles.set(profile.name, profile);
	return {
		getModelProfile: (name: string) => profiles.get(name),
		getModelProfiles: () => new Map(profiles),
		getAvailableModelProfileNames: () => [...profiles.keys()].sort(),
		getApiKeyForProvider: async () => "key-openai-codex",
		getAll: () => [codexModel, codexSolModel, codexTerraModel, codexLunaModel],
		resolveCanonicalModel: () => undefined,
		getCanonicalVariants: () => [],
		getCanonicalId: () => undefined,
	};
}

function fakeSession() {
	let activeModelProfile: string | undefined;
	const session: TestSession = {
		model: codexModel,
		thinkingLevel: ThinkingLevel.Low,
		sessionId: "session-1",
		setModelTemporaryCalls: [],
		async setModelTemporary(next: Model, thinkingLevel?: ThinkingLevel) {
			session.setModelTemporaryCalls.push({ model: next, thinkingLevel });
			session.model = next;
			session.thinkingLevel = thinkingLevel;
		},
		setActiveModelProfile(name: string | undefined) {
			activeModelProfile = name;
		},
		getActiveModelProfile() {
			return activeModelProfile;
		},
	};
	return session;
}

describe("legacy model profile aliases", () => {
	test("maps retired codex-standard default to codex-medium during activation", async () => {
		const settings = Settings.isolated({ "modelProfile.default": "codex-standard" });
		const session = fakeSession();

		await activateModelProfile({
			session,
			modelRegistry: fakeRegistry(),
			settings,
			profileName: settings.get("modelProfile.default") ?? "",
		});

		expect(session.getActiveModelProfile()).toBe("codex-medium");
		expect(session.setModelTemporaryCalls).toEqual([{ model: codexSolModel, thinkingLevel: ThinkingLevel.Medium }]);
		expect(settings.get("modelProfile.default")).toBe("codex-standard");
	});

	test("--default persists the canonical replacement name for codex-standard", async () => {
		const settings = Settings.isolated();
		const session = fakeSession();

		await activateModelProfile(
			{ session, modelRegistry: fakeRegistry(), settings, profileName: "codex-standard" },
			{ persistDefault: true },
		);

		expect(session.getActiveModelProfile()).toBe("codex-medium");
		expect(settings.get("modelProfile.default")).toBe("codex-medium");
		expect(settings.get("defaultThinkingLevel")).toBe(ThinkingLevel.Medium);
	});

	test("preparation exposes the canonical replacement profile name", async () => {
		const prepared = await prepareModelProfileActivation({
			session: fakeSession(),
			modelRegistry: fakeRegistry(),
			settings: Settings.isolated(),
			profileName: "codex-standard",
		});

		expect(prepared.profileName).toBe("codex-medium");
		expect(prepared.defaultThinkingLevel).toBe(ThinkingLevel.Medium);
	});

	test("does not remap codex-standard when a user-defined profile shadows it", async () => {
		const customCodexStandard: ModelProfileDefinition = {
			name: "codex-standard",
			requiredProviders: ["openai-codex"],
			modelMapping: { default: "openai-codex/gpt-5.5:xhigh" },
			source: "user",
		};

		const prepared = await prepareModelProfileActivation({
			session: fakeSession(),
			modelRegistry: fakeRegistry([customCodexStandard]),
			settings: Settings.isolated(),
			profileName: "codex-standard",
		});

		// The retired-name alias must NOT shadow an explicitly defined profile.
		expect(prepared.profileName).toBe("codex-standard");
		expect(prepared.defaultThinkingLevel).toBe(ThinkingLevel.XHigh);
	});
});
