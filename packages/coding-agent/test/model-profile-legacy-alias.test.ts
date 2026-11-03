import { describe, expect, test } from "bun:test";
import { ThinkingLevel } from "@gajae-code/agent-core";
import type { Model } from "@gajae-code/ai";
import { activateModelProfile, prepareModelProfileActivation } from "../src/config/model-profile-activation";
import { validateModelProfileName } from "../src/config/model-profile-contract";
import type { ModelProfileDefinition } from "../src/config/model-profiles";
import { BUILTIN_MODEL_PROFILES } from "../src/config/model-profiles";
import { Settings } from "../src/config/settings";
import type { PreparedProfileModelSelection } from "../src/session/agent-session";

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
	id: "gpt-6.1-sol",
	name: "gpt-6.1-sol",
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
	disposed: boolean;
	readonly sessionLifecycle: {
		readonly generation: number;
		readonly transitioning: boolean;
		readonly disposed: boolean;
	};
	dispose(): Promise<void>;
	readonly committedModelSelections: PreparedProfileModelSelection[];
	prepareModelSelectionForProfileActivation(
		next: Model,
		thinkingLevel?: ThinkingLevel,
		signal?: AbortSignal,
	): Promise<PreparedProfileModelSelection>;
	commitPreparedProfileModelSelection(selection: PreparedProfileModelSelection): void;
	setModelTemporary(next: Model, thinkingLevel?: ThinkingLevel): Promise<void>;
	setActiveModelProfile(name: string | undefined, activatedByThisProcess?: boolean): void;
	getActiveModelProfile(): string | undefined;
	getActivatedModelProfile(): string | undefined;
	getConfiguredModelChain(role: string): readonly string[] | undefined;
	setConfiguredModelChain(role: string, entries: readonly string[]): void;
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
		isSelectorCircuitOpen: () => false,
	};
}

function fakeSession() {
	let activeModelProfile: string | undefined;
	let activatedModelProfile: string | undefined;
	const configuredModelChains = new Map<string, readonly string[]>();

	const session: TestSession = {
		model: codexModel,
		thinkingLevel: ThinkingLevel.Low,
		sessionId: "session-1",
		disposed: false,
		get sessionLifecycle() {
			return Object.freeze({ generation: 0, transitioning: false, disposed: session.disposed });
		},
		async dispose() {
			session.disposed = true;
		},
		committedModelSelections: [],
		async prepareModelSelectionForProfileActivation(
			next: Model,
			thinkingLevel?: ThinkingLevel,
			signal?: AbortSignal,
		): Promise<PreparedProfileModelSelection> {
			signal?.throwIfAborted();
			return {
				sessionId: session.sessionId,
				model: next,
				thinkingLevel,
				committedThinkingLevel: thinkingLevel,
				previousModel: session.model,
				previousThinkingLevel: session.thinkingLevel,
				previousThinkingLevelMutationRevision: 0,
				previousEditMode: "hashline",
				signal,
			};
		},
		commitPreparedProfileModelSelection(selection: PreparedProfileModelSelection): void {
			selection.signal?.throwIfAborted();
			if (
				session.sessionId !== selection.sessionId ||
				session.model !== selection.previousModel ||
				session.thinkingLevel !== selection.previousThinkingLevel
			)
				throw new Error("Session changed while publishing profile");
			session.model = selection.model;
			session.thinkingLevel = selection.committedThinkingLevel;
			session.committedModelSelections.push(selection);
		},
		async setModelTemporary(next: Model, thinkingLevel?: ThinkingLevel) {
			session.model = next;
			session.thinkingLevel = thinkingLevel;
		},
		getConfiguredModelChain(role: string) {
			return configuredModelChains.get(role);
		},
		setConfiguredModelChain(role: string, entries: readonly string[]) {
			configuredModelChains.set(role, [...entries]);
		},
		setActiveModelProfile(name: string | undefined, activatedByThisProcess = false) {
			activeModelProfile = name;
			activatedModelProfile = activatedByThisProcess ? name : undefined;
		},
		getActiveModelProfile() {
			return activeModelProfile;
		},
		getActivatedModelProfile() {
			return activatedModelProfile === activeModelProfile ? activeModelProfile : undefined;
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
		expect(session.committedModelSelections).toHaveLength(1);
		expect(session.model).toBe(codexSolModel);
		expect(session.thinkingLevel).toBe(ThinkingLevel.Low);
		expect(session.getConfiguredModelChain("default")).toEqual(["openai-codex/gpt-6.1-sol:low"]);
		expect(session.getActivatedModelProfile()).toBe("codex-medium");
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
		expect(session.getActivatedModelProfile()).toBe("codex-medium");
		expect(session.committedModelSelections).toHaveLength(1);
		expect(session.model).toBe(codexSolModel);
		expect(session.thinkingLevel).toBe(ThinkingLevel.Low);
		expect(session.getConfiguredModelChain("default")).toEqual(["openai-codex/gpt-6.1-sol:low"]);
		expect(session.disposed).toBe(false);
		expect(settings.get("modelProfile.default")).toBe("codex-medium");
		expect(settings.get("defaultThinkingLevel")).toBe(ThinkingLevel.Low);
	});

	test("preparation exposes the canonical replacement profile name", async () => {
		const prepared = await prepareModelProfileActivation({
			session: fakeSession(),
			modelRegistry: fakeRegistry(),
			settings: Settings.isolated(),
			profileName: "codex-standard",
		});

		expect(prepared.profileName).toBe("codex-medium");
		expect(prepared.defaultThinkingLevel).toBe(ThinkingLevel.Low);
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

	test("maps retired codex-sol61 default to codex-pro during activation", async () => {
		const settings = Settings.isolated({ "modelProfile.default": "codex-sol61" });
		const session = fakeSession();

		await activateModelProfile({
			session,
			modelRegistry: fakeRegistry(),
			settings,
			profileName: settings.get("modelProfile.default") ?? "",
		});

		expect(session.getActiveModelProfile()).toBe("codex-pro");
		expect(session.committedModelSelections).toHaveLength(1);
		expect(session.model).toBe(codexSolModel);
		expect(session.thinkingLevel).toBe(ThinkingLevel.Medium);
		expect(session.getConfiguredModelChain("default")).toEqual(["openai-codex/gpt-6.1-sol:medium"]);
		expect(session.getActivatedModelProfile()).toBe("codex-pro");
		expect(settings.get("modelProfile.default")).toBe("codex-sol61");
	});

	test("--default persists the canonical replacement name for codex-sol61", async () => {
		const settings = Settings.isolated();
		const session = fakeSession();

		await activateModelProfile(
			{ session, modelRegistry: fakeRegistry(), settings, profileName: "codex-sol61" },
			{ persistDefault: true },
		);

		expect(session.getActiveModelProfile()).toBe("codex-pro");
		expect(session.getActivatedModelProfile()).toBe("codex-pro");
		expect(session.committedModelSelections).toHaveLength(1);
		expect(session.model).toBe(codexSolModel);
		expect(session.thinkingLevel).toBe(ThinkingLevel.Medium);
		expect(session.getConfiguredModelChain("default")).toEqual(["openai-codex/gpt-6.1-sol:medium"]);
		expect(session.disposed).toBe(false);
		expect(settings.get("modelProfile.default")).toBe("codex-pro");
		expect(settings.get("defaultThinkingLevel")).toBe(ThinkingLevel.Medium);
	});

	test("preparation exposes the canonical replacement profile name for codex-sol61", async () => {
		const prepared = await prepareModelProfileActivation({
			session: fakeSession(),
			modelRegistry: fakeRegistry(),
			settings: Settings.isolated(),
			profileName: "codex-sol61",
		});

		expect(prepared.profileName).toBe("codex-pro");
		expect(prepared.defaultThinkingLevel).toBe(ThinkingLevel.Medium);
	});

	test("does not remap codex-sol61 when a user-defined profile shadows it", async () => {
		const customCodexSol61: ModelProfileDefinition = {
			name: "codex-sol61",
			requiredProviders: ["openai-codex"],
			modelMapping: { default: "openai-codex/gpt-5.5:xhigh" },
			source: "user",
		};

		const prepared = await prepareModelProfileActivation({
			session: fakeSession(),
			modelRegistry: fakeRegistry([customCodexSol61]),
			settings: Settings.isolated(),
			profileName: "codex-sol61",
		});

		// The retired-name alias must NOT shadow an explicitly defined profile.
		expect(prepared.profileName).toBe("codex-sol61");
		expect(prepared.defaultThinkingLevel).toBe(ThinkingLevel.XHigh);
	});

	test("validates codex-sol61 to codex-pro against the builtin profile map", () => {
		const builtinProfiles = new Map(BUILTIN_MODEL_PROFILES.map(profile => [profile.name, profile]));

		expect(validateModelProfileName("codex-sol61", builtinProfiles)).toBe("codex-pro");
	});
});
