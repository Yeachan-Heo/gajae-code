import { beforeAll, describe, expect, test, vi } from "bun:test";
import { ThinkingLevel } from "@gajae-code/agent-core";
import type { Model } from "@gajae-code/ai";
import type { ModelProfileDefinition } from "@gajae-code/coding-agent/config/model-profiles";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import {
	ModelSelectorComponent,
	type ModelSelectorSelection,
} from "@gajae-code/coding-agent/modes/components/model-selector";
import { SelectorController } from "@gajae-code/coding-agent/modes/controllers/selector-controller";
import { getThemeByName, setThemeInstance } from "@gajae-code/coding-agent/modes/theme/theme";
import type { TUI } from "@gajae-code/tui";

const model = (provider: string, id: string): Model =>
	({ provider, id, name: id, api: "openai-responses", contextWindow: 1000, maxTokens: 1000 }) as Model;

function normalizeRenderedText(text: string): string {
	return text
		.replace(/\x1b\[[0-9;]*m/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

let testTheme = await getThemeByName("red-claw");

function installTestTheme(): void {
	if (!testTheme) throw new Error("Failed to load test theme");
	setThemeInstance(testTheme);
}

const defaultModel = model("provider-a", "default");
const alternateModel = model("provider-a", "alternate");
const aliasModel = model("provider-b", "org/flare-alias");
const providerBDefault = model("provider-b", "default");
const profile: ModelProfileDefinition = {
	name: "profile-a",
	displayName: "Profile Alpha",
	requiredProviders: ["provider-a"],
	modelMapping: { default: "provider-a/default:high", executor: "provider-a/alternate" },
	source: "user",
};
const profileB: ModelProfileDefinition = {
	name: "codex-eco",
	requiredProviders: ["provider-b"],
	modelMapping: { default: "provider-b/default" },
	source: "user",
};

function createRegistry(options: { missingCredentials?: boolean } = {}) {
	const profiles = new Map([
		[profile.name, profile],
		[profileB.name, profileB],
	]);
	return {
		refresh: vi.fn(async () => {}),
		getError: () => undefined,
		getAvailable: () => [defaultModel, alternateModel, aliasModel, providerBDefault],
		getAll: () => [defaultModel, alternateModel, aliasModel, providerBDefault],
		hasConfiguredProviderAuth: () => false,
		getDiscoverableProviders: () => [],
		getCanonicalModels: () => [],
		getCanonicalModelSelections: () => [],
		resolveCanonicalModel: () => undefined,
		lookupAliasExists: (alias: string) => alias === "flare-alias",
		resolveModelByLookupAlias: vi.fn(
			(
				_alias: string,
				lookupOptions?: {
					candidates?: readonly Model[];
					sessionId?: string;
					credentialSessionId?: string;
				},
			) => lookupOptions?.candidates?.find(candidate => candidate === aliasModel),
		),
		getModelProfiles: () => new Map(profiles),
		getModelProfile: (name: string) => profiles.get(name),
		getAvailableModelProfileNames: () => [...profiles.keys()],
		getApiKeyForProvider: async () => (options.missingCredentials ? undefined : "key"),
		getApiKey: async () => "key",
	};
}

type TestModelRegistry = {
	getModelProfiles: () => ReadonlyMap<string, ModelProfileDefinition>;
	getModelProfile: (name: string) => ModelProfileDefinition | undefined;
} & Record<string, unknown>;

function createSelector(
	onSelect: (selection: ModelSelectorSelection) => void,
	options: {
		temporaryOnly?: boolean;
		initialSearchInput?: string;
		settings?: Settings;
		currentModel?: Model;
		currentThinkingLevel?: ThinkingLevel;
		activeModelProfile?: string;
		configuredDefaultChain?: readonly string[];
		registry?: TestModelRegistry;
		sessionId?: string;
	} = {},
) {
	const ui = { requestRender: vi.fn() } as unknown as TUI;
	return new ModelSelectorComponent(
		ui,
		options.currentModel,
		options.settings ?? Settings.isolated(),
		(options.registry ?? createRegistry()) as never,
		[],
		onSelect,
		() => {},
		{ ...options, sessionId: options.sessionId },
	);
}

function createControllerContext(options: { missingCredentials?: boolean } = {}) {
	const settings = Settings.isolated({
		"task.agentModelOverrides": { executor: "provider-a/original-executor" },
		"modelProfile.default": "old-profile",
	});
	const flush = vi.fn(async () => {});
	settings.flushOrThrow = flush as typeof settings.flushOrThrow;
	const setCalls: Array<{ path: string; value: unknown }> = [];
	const originalSet = settings.set.bind(settings);
	settings.set = ((path: never, value: never) => {
		setCalls.push({ path: path as string, value });
		return originalSet(path, value);
	}) as typeof settings.set;
	const session = {
		model: alternateModel as Model | undefined,
		thinkingLevel: ThinkingLevel.Low as ThinkingLevel | undefined,
		sessionId: "session-1",
		scopedModels: [],
		modelRegistry: createRegistry(options),
		configuredChains: {} as Record<string, readonly string[]>,
		getConfiguredModelChain(role: string): readonly string[] | undefined {
			return this.configuredChains[role];
		},
		setConfiguredModelChain(role: string, entries: readonly string[]) {
			this.configuredChains[role] = entries;
		},
		setModelTemporaryCalls: [] as Array<{ model: Model; thinkingLevel?: ThinkingLevel }>,
		async setModelTemporary(next: Model, thinkingLevel?: ThinkingLevel) {
			this.setModelTemporaryCalls.push({ model: next, thinkingLevel });
			this.model = next;
			this.thinkingLevel = thinkingLevel;
		},
	};
	const ctx = {
		ui: { setFocus: vi.fn(), requestRender: vi.fn() },
		editorContainer: { clear: vi.fn(), detachChild: vi.fn(), addChild: vi.fn() },
		editor: {},
		settings,
		session,
		statusLine: { invalidate: vi.fn() },
		updateEditorBorderColor: vi.fn(),
		showStatus: vi.fn(),
		showError: vi.fn(),
		restoreComposer: vi.fn(),
	};
	return { ctx, settings, session, flush, setCalls };
}

async function selectFirstProfile(controller: SelectorController, setDefault = false): Promise<void> {
	controller.showModelSelector();
	const selector = (controller as unknown as { ctx: { editorContainer: { addChild: ReturnType<typeof vi.fn> } } }).ctx
		.editorContainer.addChild.mock.calls[0]?.[0] as ModelSelectorComponent;
	await Bun.sleep(10);
	installTestTheme();
	await selector.__testSelectProfile("profile-a", setDefault);
	await Bun.sleep(0);
}

describe("model selector profiles", () => {
	test("catalog changes rebuild the active preset landing instead of switching to model view", async () => {
		installTestTheme();
		const profiles = new Map<string, ModelProfileDefinition>([[profile.name, profile]]);
		const models = [defaultModel, alternateModel, aliasModel, providerBDefault];
		let catalogChanged: (() => void) | undefined;
		const registry = createRegistry() as unknown as TestModelRegistry & {
			onCatalogChanged: (listener: () => void) => () => void;
		};
		registry.getAvailable = () => models;
		registry.getModelProfiles = () => new Map(profiles);
		registry.getModelProfile = (name: string) => profiles.get(name);
		registry.getAvailableModelProfileNames = () => [...profiles.keys()];
		registry.onCatalogChanged = listener => {
			catalogChanged = listener;
			return () => {};
		};
		const selector = createSelector(() => {}, { registry });
		await Bun.sleep(0);
		profiles.set("registry-live", {
			name: "registry-live",
			displayName: "Registry Live",
			providerGroup: "REGISTRY LIVE",
			requiredProviders: ["provider-a"],
			modelMapping: { default: "provider-a/default" },
			source: "registry",
		});
		models.push(model("provider-a", "fresh-registry-model"));
		catalogChanged?.();
		let rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("Model presets");
		expect(rendered).toContain("REGISTRY LIVE");
		expect(rendered).not.toContain("Models (all)");
		selector.handleInput("f");
		await Bun.sleep(0);
		rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("fresh-registry-model");
	});

	test("catalog additions refresh preset authentication state", async () => {
		installTestTheme();
		const liveProfile: ModelProfileDefinition = {
			name: "registry-auth-refresh",
			displayName: "Auth Refresh",
			providerGroup: "LIVE CATALOG",
			requiredProviders: ["provider-a"],
			modelMapping: { default: "provider-a/fresh-model" },
			source: "registry",
		};
		const models = [model("provider-a", "existing-model")];
		let catalogChanged: (() => void) | undefined;
		const registry = createRegistry() as unknown as TestModelRegistry & {
			getAvailable: () => Model[];
			getAll: () => Model[];
			getModelProfiles: () => ReadonlyMap<string, ModelProfileDefinition>;
			onCatalogChanged: (listener: () => void) => () => void;
		};
		registry.getAvailable = () => models;
		registry.getAll = () => models;
		registry.getModelProfiles = () => new Map([[liveProfile.name, liveProfile]]);
		registry.getModelProfile = (name: string) => (name === liveProfile.name ? liveProfile : undefined);
		registry.getApiKeyForProvider = async () => "provider-a-key";
		registry.onCatalogChanged = listener => {
			catalogChanged = listener;
			return () => {};
		};

		const selector = createSelector(() => {}, { registry });
		await Bun.sleep(10);
		let rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("✗ LIVE CATALOG");

		models.push(model("provider-a", "fresh-model"));
		catalogChanged?.();
		await Bun.sleep(10);
		rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("✓ LIVE CATALOG");
	});

	test("resolves a repeated preset selector once per authentication refresh", async () => {
		installTestTheme();
		const repeatedProfiles = new Map<string, ModelProfileDefinition>([
			[
				"repeated-a",
				{
					name: "repeated-a",
					requiredProviders: [],
					modelMapping: { default: "flare-alias", executor: "flare-alias" },
					source: "user",
				},
			],
			[
				"repeated-b",
				{
					name: "repeated-b",
					requiredProviders: [],
					modelMapping: { default: "flare-alias" },
					source: "user",
				},
			],
		]);
		let catalogChanged: (() => void) | undefined;
		let authGenerationChanged: (() => void) | undefined;
		let resolvedAliasModel = aliasModel;
		const registryBase = createRegistry();
		const resolveAlias = registryBase.resolveModelByLookupAlias;
		const getApiKeyForProvider = vi.fn(async () => "key" as const);
		registryBase.getApiKeyForProvider = getApiKeyForProvider;
		const registry = registryBase as unknown as TestModelRegistry & {
			onCatalogChanged: (listener: () => void) => () => void;
			authStorage: { onGenerationChanged: (listener: () => void) => () => void };
		};
		resolveAlias.mockImplementation((_alias, lookupOptions) =>
			lookupOptions?.candidates?.find(candidate => candidate === resolvedAliasModel),
		);
		registry.getModelProfiles = () => new Map(repeatedProfiles);
		registry.getModelProfile = (name: string) => repeatedProfiles.get(name);
		registry.getAvailableModelProfileNames = () => [...repeatedProfiles.keys()];
		registry.onCatalogChanged = listener => {
			catalogChanged = listener;
			return () => {};
		};
		registry.authStorage = {
			onGenerationChanged: listener => {
				authGenerationChanged = listener;
				return () => {};
			},
		};

		createSelector(() => {}, { registry, sessionId: "profile-session" });
		await Bun.sleep(10);
		resolveAlias.mockClear();
		getApiKeyForProvider.mockClear();

		catalogChanged?.();

		expect(resolveAlias).toHaveBeenCalledTimes(1);
		expect(getApiKeyForProvider).toHaveBeenCalledWith("provider-b", "profile-session");

		await Bun.sleep(10);
		resolveAlias.mockClear();
		getApiKeyForProvider.mockClear();
		resolvedAliasModel = defaultModel;

		authGenerationChanged?.();

		expect(resolveAlias).toHaveBeenCalledTimes(1);
		expect(resolveAlias.mock.calls[0]?.[1]?.credentialSessionId).toBe("profile-session");
		expect(getApiKeyForProvider).toHaveBeenCalledWith("provider-a", "profile-session");
	});

	test("renders a registry preset unavailable when its configured proxy lacks the model", async () => {
		installTestTheme();
		const proxyProfile: ModelProfileDefinition = {
			name: "registry-proxy-missing",
			displayName: "Proxy Missing",
			providerGroup: "REGISTRY",
			requiredProviders: ["xai"],
			modelMapping: { default: "xai/grok-4.3" },
			source: "registry",
		};
		const registry = createRegistry() as unknown as TestModelRegistry & {
			getModelProfiles: () => ReadonlyMap<string, ModelProfileDefinition>;
		};
		registry.getModelProfiles = () => new Map([[proxyProfile.name, proxyProfile]]);
		registry.getModelProfile = (name: string) => (name === proxyProfile.name ? proxyProfile : undefined);
		registry.getAvailable = () => [model("xai", "grok-4.3"), model("litellm", "other-model")];
		registry.getAll = registry.getAvailable;
		registry.getApiKeyForProvider = (async (provider: string) =>
			provider === "litellm" ? "proxy-key" : undefined) as typeof registry.getApiKeyForProvider;
		const selector = createSelector(() => {}, {
			registry,
			settings: Settings.isolated({ "modelProfile.proxyProvider": "litellm" }),
		});
		await Bun.sleep(10);
		expect(() => selector.render(220)).not.toThrow();
	});

	test("renders a registry preset unavailable when a qualified role is absent from the effective catalog", async () => {
		installTestTheme();
		const registryProfile: ModelProfileDefinition = {
			name: "registry-role-missing",
			displayName: "Registry Role Missing",
			providerGroup: "REGISTRY ROLE",
			requiredProviders: ["provider-a"],
			modelMapping: { default: "provider-a/default", executor: "provider-a/missing" },
			source: "registry",
		};
		const registry = createRegistry() as unknown as TestModelRegistry & {
			getAvailableForProfileActivation: () => Model[];
		};
		registry.getModelProfiles = () => new Map([[registryProfile.name, registryProfile]]);
		registry.getModelProfile = (name: string) => (name === registryProfile.name ? registryProfile : undefined);
		registry.getAvailable = () => [defaultModel, model("provider-a", "missing")];
		registry.getAll = registry.getAvailable;
		registry.getAvailableForProfileActivation = () => [defaultModel];
		const selector = createSelector(() => {}, { registry });
		await Bun.sleep(10);
		selector.handleInput("\x1b[C");
		const rendered = normalizeRenderedText(selector.render(220).join("\n"));

		expect(rendered).toContain("✗ REGISTRY ROLE");
		expect(rendered).toContain("✗ Registry Role Missing");
	});

	test("renders presets safely when the configured proxy identifier is malformed", async () => {
		installTestTheme();
		const registry = createRegistry() as unknown as TestModelRegistry & {
			getModelProfiles: () => ReadonlyMap<string, ModelProfileDefinition>;
		};
		const registryProfile: ModelProfileDefinition = {
			name: "registry-direct",
			providerGroup: "REGISTRY",
			requiredProviders: ["provider-a"],
			modelMapping: { default: "provider-a/default" },
			source: "registry",
		};
		registry.getModelProfiles = () => new Map([[registryProfile.name, registryProfile]]);
		registry.getModelProfile = (name: string) => (name === registryProfile.name ? registryProfile : undefined);
		const selector = createSelector(() => {}, {
			registry,
			settings: Settings.isolated({ "modelProfile.proxyProvider": "proxy/name" }),
		});
		await Bun.sleep(10);
		const rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("REGISTRY");
		expect(() => selector.render(220)).not.toThrow();
	});

	test("marks a registry preset unavailable when always-mode proxy auth is missing", async () => {
		installTestTheme();
		const registry = createRegistry() as unknown as TestModelRegistry;
		const alwaysProfile: ModelProfileDefinition = {
			name: "registry-always",
			providerGroup: "REGISTRY ALWAYS",
			requiredProviders: ["provider-a"],
			modelMapping: { default: "provider-a/default" },
			source: "registry",
		};
		registry.getModelProfiles = () => new Map([[alwaysProfile.name, alwaysProfile]]);
		registry.getModelProfile = (name: string) => (name === alwaysProfile.name ? alwaysProfile : undefined);
		registry.getConfiguredProviderIds = () => ["litellm"];
		registry.getApiKeyForProvider = (async (provider: string) =>
			provider === "provider-a" ? "direct-key" : undefined) as typeof registry.getApiKeyForProvider;
		const selector = createSelector(() => {}, {
			registry,
			settings: Settings.isolated({
				"modelProfile.proxyProvider": "litellm",
				"modelProfile.proxyMode": "always",
			}),
		});
		await Bun.sleep(10);
		const rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("REGISTRY ALWAYS");
		expect(rendered).toContain("✗ REGISTRY ALWAYS");
	});

	test("keeps a registry preset available in fallback mode with direct auth and an unauthenticated proxy", async () => {
		installTestTheme();
		const fallbackProfile: ModelProfileDefinition = {
			name: "registry-fallback",
			displayName: "Registry Fallback",
			providerGroup: "REGISTRY FALLBACK",
			requiredProviders: ["provider-a"],
			modelMapping: { default: "provider-a/default" },
			source: "registry",
		};
		const registry = createRegistry() as unknown as TestModelRegistry;
		registry.getModelProfiles = () => new Map([[fallbackProfile.name, fallbackProfile]]);
		registry.getModelProfile = (name: string) => (name === fallbackProfile.name ? fallbackProfile : undefined);
		registry.getConfiguredProviderIds = () => ["litellm"];
		registry.getApiKeyForProvider = (async (provider: string) =>
			provider === "provider-a" ? "direct-key" : undefined) as typeof registry.getApiKeyForProvider;
		const settings = Settings.isolated({
			"modelProfile.proxyProvider": "litellm",
			"modelProfile.proxyMode": "fallback",
		});
		const selector = createSelector(() => {}, {
			registry,
			settings,
		});
		await Bun.sleep(10);
		let rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("✓ REGISTRY FALLBACK");

		settings.set("modelProfile.proxyMode", "always");
		await Bun.sleep(10);
		rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("✗ REGISTRY FALLBACK");
	});

	test("fences preset actions and rebuilds availability when disabled providers change", async () => {
		installTestTheme();
		const settings = Settings.isolated();
		const profiles = new Map<string, ModelProfileDefinition>([[profile.name, profile]]);
		const refreshGate = Promise.withResolvers<"key">();
		let delayProviderAuth = false;
		const registry = createRegistry() as unknown as TestModelRegistry & {
			getAvailableForProfileActivation: () => Model[];
			getApiKeyForProvider: (provider: string) => Promise<string>;
		};
		registry.getModelProfiles = () => new Map(profiles);
		registry.getModelProfile = (name: string) => profiles.get(name);
		registry.getAvailableModelProfileNames = () => [...profiles.keys()];
		registry.getAvailableForProfileActivation = () =>
			settings.get("disabledProviders").includes("provider-a") ? [] : [defaultModel, alternateModel];
		registry.getApiKeyForProvider = async provider => {
			if (delayProviderAuth && provider === "provider-a") return refreshGate.promise;
			return "key";
		};

		const selector = createSelector(() => {}, { registry, settings });
		await Bun.sleep(10);
		expect(normalizeRenderedText(selector.render(220).join("\n"))).toContain("✓ CUSTOM");

		delayProviderAuth = true;
		settings.set("disabledProviders", ["provider-a"]);
		let rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("… CUSTOM");

		selector.handleInput("\n");
		rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("Refreshing preset availability...");
		expect(rendered).not.toContain("No available model matches this preset");

		refreshGate.resolve("key");
		await Bun.sleep(10);
		expect(normalizeRenderedText(selector.render(220).join("\n"))).toContain("✗ CUSTOM");
	});

	beforeAll(async () => {
		testTheme = await getThemeByName("red-claw");
		installTestTheme();
	});

	test("renders preset landing above model rows", async () => {
		installTestTheme();
		const selector = createSelector(() => {});
		await Bun.sleep(10);
		installTestTheme();

		const rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("Model presets");
		expect(rendered).toContain("CODEX");
		expect(rendered).toContain("CUSTOM");
		expect(rendered).not.toContain("profile-a");
		expect(rendered).toContain("Browse all models");
	});

	test("provider focus does not auto-expand until right arrow", async () => {
		installTestTheme();
		const selector = createSelector(() => {});
		await Bun.sleep(10);
		installTestTheme();

		let rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("CODEX");
		expect(rendered).not.toContain("Codex Eco");

		selector.handleInput("\x1b[C");
		rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("Codex Eco");

		selector.handleInput("\x1b[D");
		rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("CODEX");
		expect(rendered).not.toContain("Codex Eco");
	});

	test("defers authenticated preset actions while availability refresh is pending", async () => {
		installTestTheme();
		const gate = Promise.withResolvers<"key">();
		const registry = createRegistry();
		registry.getApiKeyForProvider = async () => gate.promise;
		const selector = createSelector(() => {}, { registry });
		await Bun.sleep(0);

		let rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("… CODEX");

		selector.handleInput("\n");
		rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("Refreshing preset availability...");
		expect(rendered).not.toContain("No available model matches this preset");

		gate.resolve("key");
		await Bun.sleep(10);
		selector.handleInput("\n");
		rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("Codex Eco");
	});

	test("defers preset actions while the initial static catalog refresh is pending", async () => {
		installTestTheme();
		const gate = Promise.withResolvers<void>();
		const registry = createRegistry() as unknown as TestModelRegistry & {
			refreshStatic: () => Promise<void>;
		};
		registry.refreshStatic = () => gate.promise;
		const selector = createSelector(() => {}, { registry });
		await Bun.sleep(0);

		let rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("… CODEX");

		selector.handleInput("\n");
		rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("Refreshing preset availability...");
		expect(rendered).not.toContain("Run /login provider-a");

		gate.resolve();
		await Bun.sleep(10);
		selector.handleInput("\n");
		rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("Codex Eco");
	});

	test("up and down navigation stays on provider rows while collapsed", async () => {
		installTestTheme();
		const registry = createRegistry();
		const getAvailable = vi.fn(registry.getAvailable);
		registry.getAvailable = getAvailable;
		const selector = createSelector(() => {}, { registry });
		await Bun.sleep(10);
		installTestTheme();
		getAvailable.mockClear();

		let rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("CODEX");
		expect(rendered).toContain("CUSTOM");
		expect(rendered).toContain("Browse all models");
		expect(rendered).not.toContain("Codex Eco");
		expect(rendered).not.toContain("profile-a");

		selector.handleInput("\x1b[B");
		rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("CUSTOM");
		expect(rendered).toContain("Browse all models");
		expect(rendered).not.toContain("Codex Eco");
		expect(rendered).not.toContain("profile-a");

		selector.handleInput("\x1b[A");
		rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("CODEX");
		expect(rendered).not.toContain("Codex Eco");
		expect(rendered).not.toContain("profile-a");
		expect(getAvailable).not.toHaveBeenCalled();
	});

	test("rebuilds preset availability after profiles change in place", async () => {
		installTestTheme();
		const profiles = new Map<string, ModelProfileDefinition>([[profile.name, profile]]);
		const registry = createRegistry();
		registry.getModelProfiles = () => new Map(profiles);
		registry.getModelProfile = (name: string) => profiles.get(name);
		let selected: ModelSelectorSelection | undefined;
		const selector = createSelector(
			selection => {
				selected = selection;
			},
			{ registry },
		);
		await Bun.sleep(10);

		const addedProfile: ModelProfileDefinition = {
			name: "added-profile",
			displayName: "Added Profile",
			providerGroup: "ADDED",
			requiredProviders: ["provider-a"],
			modelMapping: { default: "provider-a/default" },
			source: "user",
		};
		profiles.set(addedProfile.name, addedProfile);
		selector.refreshPresetProfiles(addedProfile.name);
		await Bun.sleep(10);

		selector.handleInput("\n");
		selector.handleInput("\n");
		expect(selected).toEqual({ kind: "profile", profileName: "added-profile", setDefault: false });
	});

	test("landing header shows the session's current preset, model, and role assignments", async () => {
		installTestTheme();
		const selector = createSelector(() => {}, {
			currentModel: defaultModel,
			currentThinkingLevel: ThinkingLevel.High,
			activeModelProfile: "profile-a",
			settings: Settings.isolated({
				"task.agentModelOverrides": { executor: "provider-a/alternate" },
			}),
		});
		await Bun.sleep(10);
		installTestTheme();

		const rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("Current: preset Profile Alpha · provider-a/default (high)");
		expect(rendered).toContain("DEFAULT: provider-a/default (high)");
		expect(rendered).toContain("EXECUTOR: provider-a/alternate");
		expect(rendered).toContain("(current)");
	});

	test("active profile role badges resolve bare aliases without mutating canonical session affinity", async () => {
		installTestTheme();
		const registry = createRegistry();
		const selector = createSelector(() => {}, {
			currentModel: defaultModel,
			activeModelProfile: "profile-a",
			settings: Settings.isolated({
				"task.agentModelOverrides": { executor: "flare-alias" },
			}),
			registry,
			sessionId: "profile-session",
		});
		await Bun.sleep(10);
		installTestTheme();

		const rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("EXECUTOR: provider-b/org/flare-alias");
		const aliasCalls = registry.resolveModelByLookupAlias.mock.calls.filter(([alias]) => alias === "flare-alias");
		expect(aliasCalls.length).toBeGreaterThan(0);
		expect(aliasCalls.every(([, options]) => options?.sessionId === undefined)).toBe(true);
		expect(aliasCalls.some(([, options]) => options?.credentialSessionId === "profile-session")).toBe(true);
	});

	test("landing header reflects the active fallback model snapshot", async () => {
		installTestTheme();
		const selector = createSelector(() => {}, {
			currentModel: alternateModel,
			currentThinkingLevel: ThinkingLevel.Low,
			activeModelProfile: "profile-a",
		});
		await Bun.sleep(10);
		installTestTheme();

		const rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("Current: preset Profile Alpha · provider-a/alternate (low)");
		expect(rendered).not.toContain("Current: preset Profile Alpha · provider-a/default");
		expect(rendered).toContain("DEFAULT: provider-a/alternate (low)");
		expect(rendered).not.toContain("DEFAULT: provider-a/default");
	});

	test("enter toggles a usable provider group's expansion", async () => {
		installTestTheme();
		const selector = createSelector(() => {});
		await Bun.sleep(10);
		installTestTheme();

		let rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("CODEX");
		expect(rendered).not.toContain("Codex Eco");

		selector.handleInput("\r");
		rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("Codex Eco");

		selector.handleInput("\r");
		rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).not.toContain("Codex Eco");
	});
	test("preset search keeps first typed character before subsequent input", async () => {
		installTestTheme();
		const selector = createSelector(() => {});
		await Bun.sleep(10);
		installTestTheme();

		selector.handleInput("c");
		selector.handleInput("l");
		selector.handleInput("a");

		expect(selector.getSearchInput().getValue()).toBe("cla");
	});

	test("initial search input appends new typing at the end", async () => {
		installTestTheme();
		const selector = createSelector(() => {}, { initialSearchInput: "cla" });
		await Bun.sleep(10);
		installTestTheme();

		selector.handleInput("u");

		expect(selector.getSearchInput().getValue()).toBe("clau");
	});

	test("temporary-only mode hides Profiles", async () => {
		installTestTheme();
		const selector = createSelector(() => {}, { temporaryOnly: true });
		await Bun.sleep(10);
		installTestTheme();

		const rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).not.toContain("Profiles");
		expect(rendered).not.toContain("profile-a");
	});

	test("active profile makes DEFAULT badge follow runtime model instead of stored default", async () => {
		installTestTheme();
		const settings = Settings.isolated({ modelRoles: { default: "provider-a/alternate" } });
		const selector = createSelector(() => {}, {
			settings,
			currentModel: defaultModel,
			currentThinkingLevel: ThinkingLevel.High,
			activeModelProfile: "profile-a",
			initialSearchInput: "provider-a",
		});
		await Bun.sleep(10);
		installTestTheme();

		const rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("provider-a/default DEFAULT (high)");
		expect(rendered).not.toContain("provider-a/alternate DEFAULT");
	});

	test("without active profile DEFAULT badge follows persisted default model", async () => {
		installTestTheme();
		const settings = Settings.isolated({ modelRoles: { default: "provider-a/alternate" } });
		const selector = createSelector(() => {}, {
			settings,
			currentModel: defaultModel,
			currentThinkingLevel: ThinkingLevel.High,
			initialSearchInput: "provider-a",
		});
		await Bun.sleep(10);
		installTestTheme();

		const rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("provider-a/alternate DEFAULT (inherit)");
		expect(rendered).not.toContain("provider-a/default DEFAULT");
	});

	test("direct fallback chains make the runtime fallback both Current and DEFAULT", async () => {
		installTestTheme();
		const settings = Settings.isolated({
			modelRoles: { default: ["provider-a/default:high", "provider-a/alternate:low"] },
		});
		const selector = createSelector(() => {}, {
			settings,
			currentModel: alternateModel,
			currentThinkingLevel: ThinkingLevel.Low,
		});
		await Bun.sleep(10);
		installTestTheme();

		const rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("Current: provider-a/alternate (low)");
		expect(rendered).toContain("DEFAULT: provider-a/alternate (low)");
		expect(rendered).not.toContain("DEFAULT: provider-a/default");
	});

	test("persisted session fallback chains make the active head both Current and DEFAULT", async () => {
		installTestTheme();
		const settings = Settings.isolated({ modelRoles: { default: "provider-a/default:high" } });
		const selector = createSelector(() => {}, {
			settings,
			currentModel: alternateModel,
			currentThinkingLevel: ThinkingLevel.Low,
			configuredDefaultChain: ["provider-a/alternate:low", "provider-a/default:high"],
		});
		await Bun.sleep(10);
		installTestTheme();

		const rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("Current: provider-a/alternate (low)");
		expect(rendered).toContain("DEFAULT: provider-a/alternate (low)");
		expect(rendered).not.toContain("DEFAULT: provider-a/default");
	});

	test("Apply for this session activates profile through setModelTemporary", async () => {
		const { ctx, settings, session } = createControllerContext();
		const controller = new SelectorController(ctx as never);
		await selectFirstProfile(controller);

		expect(session.setModelTemporaryCalls).toHaveLength(1);
		expect(session.model).toBe(defaultModel);
		expect(session.thinkingLevel).toBe(ThinkingLevel.High);
		expect(settings.get("task.agentModelOverrides")).toMatchObject({ executor: "provider-a/alternate" });
		expect(settings.get("modelProfile.default")).toBe("old-profile");
		expect(ctx.showStatus).toHaveBeenCalledWith("Model profile: Profile Alpha");
		expect(ctx.restoreComposer).toHaveBeenCalledTimes(1);
	});

	test("Set as default persists and flushes modelProfile.default", async () => {
		const { ctx, flush, setCalls } = createControllerContext();
		const controller = new SelectorController(ctx as never);
		await selectFirstProfile(controller, true);

		expect(ctx.showStatus).toHaveBeenCalledWith("Default model profile: Profile Alpha");
		expect(setCalls).toContainEqual({ path: "modelProfile.default", value: "profile-a" });
		expect(setCalls).toContainEqual({ path: "defaultThinkingLevel", value: ThinkingLevel.High });
		expect(flush).toHaveBeenCalledTimes(1);
		expect(ctx.showStatus).toHaveBeenCalledWith("Default model profile: Profile Alpha");
		expect(ctx.restoreComposer).toHaveBeenCalledTimes(1);
	});

	test("credential failure shows error and leaves model and overrides unchanged", async () => {
		const { ctx, settings, session } = createControllerContext({ missingCredentials: true });
		const controller = new SelectorController(ctx as never);
		await selectFirstProfile(controller);

		expect(ctx.showError).toHaveBeenCalledWith(
			'Model profile "Profile Alpha" requires credentials for: provider-a. Run /login and configure the missing provider(s), then retry.',
		);
		expect(session.setModelTemporaryCalls).toEqual([]);
		expect(session.model).toBe(alternateModel);
		expect(session.thinkingLevel).toBe(ThinkingLevel.Low);
		expect(settings.get("task.agentModelOverrides")).toEqual({ executor: "provider-a/original-executor" });
		expect(settings.get("modelProfile.default")).toBe("old-profile");
	});

	test("settings Default Model Profile applies the profile live and persists it", async () => {
		const { ctx, session, flush, setCalls } = createControllerContext();
		const controller = new SelectorController(ctx as never);

		controller.handleSettingChange("modelProfile.default", "profile-a");
		await Bun.sleep(10);

		expect(session.setModelTemporaryCalls).toHaveLength(1);
		expect(session.model?.id).toBe("default");
		expect(setCalls).toContainEqual({ path: "modelProfile.default", value: "profile-a" });
		expect(setCalls).toContainEqual({ path: "defaultThinkingLevel", value: ThinkingLevel.High });
		expect(flush).toHaveBeenCalledTimes(1);
		expect(ctx.showStatus).toHaveBeenCalledWith("Default model profile: Profile Alpha");
	});

	test("settings Default Model Profile surfaces credential errors without switching", async () => {
		const { ctx, settings, session } = createControllerContext({ missingCredentials: true });
		const controller = new SelectorController(ctx as never);

		controller.handleSettingChange("modelProfile.default", "profile-a");
		await Bun.sleep(10);

		expect(ctx.showError).toHaveBeenCalledWith(
			'Model profile "Profile Alpha" requires credentials for: provider-a. Run /login and configure the missing provider(s), then retry.',
		);
		expect(session.setModelTemporaryCalls).toEqual([]);
		expect(session.model).toBe(alternateModel);
		expect(settings.get("modelProfile.default")).toBe("old-profile");
	});
});
