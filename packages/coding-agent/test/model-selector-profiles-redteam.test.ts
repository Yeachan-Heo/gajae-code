import { beforeAll, describe, expect, test, vi } from "bun:test";
import { ThinkingLevel } from "@gajae-code/agent-core";
import type { Model } from "@gajae-code/ai";
import type { ModelProfileDefinition } from "@gajae-code/coding-agent/config/model-profiles";
import type { ModelSelectorValue } from "@gajae-code/coding-agent/config/model-selector-value";
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
const flatModel = model("provider-b", "zzz-flat-model");

const userProfile: ModelProfileDefinition = {
	name: "profile-a",
	displayName: "Profile Alpha",
	requiredProviders: ["provider-a"],
	modelMapping: { default: "provider-a/default:high", executor: "provider-a/alternate" },
	source: "user",
};

function createRegistry(options: { profiles?: ModelProfileDefinition[]; missingCredentials?: boolean } = {}) {
	const profiles = new Map((options.profiles ?? [userProfile]).map(profile => [profile.name, profile]));
	return {
		refresh: vi.fn(async () => {}),
		getError: () => undefined,
		getAvailable: () => [defaultModel, alternateModel, flatModel],
		getAll: () => [defaultModel, alternateModel, flatModel],
		getDiscoverableProviders: () => [],
		getCanonicalModels: () => [],
		resolveCanonicalModel: () => undefined,
		getModelProfiles: () => new Map(profiles),
		getModelProfile: (name: string) => profiles.get(name),
		getAvailableModelProfileNames: () => [...profiles.keys()],
		getApiKeyForProvider: async () => (options.missingCredentials ? undefined : "key"),
		getApiKey: async () => "key",
	};
}

function createSelector(
	onSelect: (selection: ModelSelectorSelection) => void | Promise<void>,
	options: { profiles?: ModelProfileDefinition[]; temporaryOnly?: boolean } = {},
) {
	const ui = { requestRender: vi.fn() } as unknown as TUI;
	return new ModelSelectorComponent(
		ui,
		undefined,
		Settings.isolated(),
		createRegistry({ profiles: options.profiles }) as never,
		[],
		onSelect,
		() => {},
		{ temporaryOnly: options.temporaryOnly },
	);
}

async function renderSelector(selector: ModelSelectorComponent): Promise<string> {
	await Bun.sleep(10);
	installTestTheme();
	return normalizeRenderedText(selector.render(240).join("\n"));
}

function createControllerContext(options: { missingCredentials?: boolean } = {}) {
	const settings = Settings.isolated({
		"task.agentModelOverrides": { executor: "provider-a/original-executor" },
		"modelProfile.default": "old-profile",
	});
	const flush = vi.fn(async () => {});
	settings.flush = flush as typeof settings.flush;
	const setCalls: Array<{ path: string; value: unknown }> = [];
	const originalSet = settings.set.bind(settings);
	settings.set = ((path: never, value: never) => {
		setCalls.push({ path: path as string, value });
		return originalSet(path, value);
	}) as typeof settings.set;
	const overrideCalls: Array<{ path: string; value: unknown }> = [];
	const originalOverride = settings.override.bind(settings);
	settings.override = ((path: never, value: never) => {
		overrideCalls.push({ path: path as string, value });
		return originalOverride(path, value);
	}) as typeof settings.override;
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
		editorContainer: { clear: vi.fn(), addChild: vi.fn() },
		editor: {},
		settings,
		session,
		statusLine: { invalidate: vi.fn() },
		updateEditorBorderColor: vi.fn(),
		showStatus: vi.fn(),
		showError: vi.fn(),
	};
	return { ctx, settings, session, flush, setCalls, overrideCalls };
}

async function selectProfileThroughController(controller: SelectorController, setDefault = false): Promise<void> {
	controller.showModelSelector();
	const selector = (controller as unknown as { ctx: { editorContainer: { addChild: ReturnType<typeof vi.fn> } } }).ctx
		.editorContainer.addChild.mock.calls[0]?.[0] as ModelSelectorComponent;
	await Bun.sleep(10);
	installTestTheme();
	await selector.__testSelectProfile("profile-a", setDefault);
	await Bun.sleep(0);
}

describe("model selector profile red-team", () => {
	beforeAll(async () => {
		testTheme = await getThemeByName("red-claw");
		installTestTheme();
	});

	test("empty profile catalog omits Profiles section and does not crash", async () => {
		const selector = createSelector(() => {}, { profiles: [] });
		const rendered = await renderSelector(selector);

		expect(rendered).not.toContain("Profiles");
		expect(rendered).toContain("provider-a/default");
	});

	test("temporary-only mode hides Profiles even when profiles exist", async () => {
		const selector = createSelector(() => {}, { temporaryOnly: true });
		const rendered = await renderSelector(selector);

		expect(rendered).not.toContain("Profiles");
		expect(rendered).not.toContain("profile-a");
	});

	test("user-overridden profile name appears once", async () => {
		const builtinProfile: ModelProfileDefinition = { ...userProfile, source: "builtin" };
		const overriddenProfile: ModelProfileDefinition = { ...userProfile, source: "user" };
		const selector = createSelector(() => {}, { profiles: [builtinProfile, overriddenProfile] });
		await renderSelector(selector);
		selector.handleInput("\x1b[C");
		const rendered = normalizeRenderedText(selector.render(240).join("\n"));

		expect(rendered.match(/Profile Alpha/g) ?? []).toHaveLength(1);
	});

	test("profile actions wire Apply for this session to persistDefault false and Set as default to true", async () => {
		const selections: ModelSelectorSelection[] = [];
		const applySelector = createSelector(selection => {
			selections.push(selection);
		});
		await renderSelector(applySelector);
		applySelector.handleInput("\x1b[C");
		applySelector.handleInput("\x1b[B");
		applySelector.handleInput("\n");
		applySelector.handleInput("\n");
		applySelector.handleInput("\n");

		const defaultSelector = createSelector(selection => {
			selections.push(selection);
		});
		await renderSelector(defaultSelector);
		defaultSelector.handleInput("\x1b[C");
		defaultSelector.handleInput("\x1b[B");
		defaultSelector.handleInput("\n");
		defaultSelector.handleInput("\n");
		defaultSelector.handleInput("\x1b[B");
		defaultSelector.handleInput("\n");

		expect(selections).toEqual([
			{ kind: "profile", profileName: "profile-a", setDefault: false },
			{ kind: "profile", profileName: "profile-a", setDefault: true },
		]);
	});

	test("controller persists only Set as default and leaves Apply for this session non-default", async () => {
		const sessionOnly = createControllerContext();
		await selectProfileThroughController(new SelectorController(sessionOnly.ctx as never), false);

		expect(sessionOnly.setCalls).not.toContainEqual({ path: "modelProfile.default", value: "profile-a" });
		expect(sessionOnly.settings.get("modelProfile.default")).toBe("old-profile");
		expect(sessionOnly.ctx.showStatus).toHaveBeenCalledWith("Model profile: Profile Alpha");

		const persistent = createControllerContext();
		await selectProfileThroughController(new SelectorController(persistent.ctx as never), true);

		expect(persistent.setCalls).toContainEqual({ path: "modelProfile.default", value: "profile-a" });
		expect(persistent.setCalls).toContainEqual({ path: "defaultThinkingLevel", value: ThinkingLevel.High });
		expect(persistent.flush).toHaveBeenCalledTimes(1);
		expect(persistent.ctx.showStatus).toHaveBeenCalledWith("Default model profile: Profile Alpha");
	});

	test("activation credential error shows error and preserves active model, thinking, overrides, and default", async () => {
		const { ctx, settings, session, overrideCalls, setCalls } = createControllerContext({ missingCredentials: true });
		await selectProfileThroughController(new SelectorController(ctx as never), false);

		expect(ctx.showError).toHaveBeenCalledWith(
			'Model profile "Profile Alpha" requires credentials for: provider-a. Run /login and configure the missing provider(s), then retry.',
		);
		expect(session.setModelTemporaryCalls).toEqual([]);
		expect(session.model).toBe(alternateModel);
		expect(session.thinkingLevel).toBe(ThinkingLevel.Low);
		expect(settings.get("task.agentModelOverrides")).toEqual({ executor: "provider-a/original-executor" });
		expect(settings.get("modelProfile.default")).toBe("old-profile");
		expect(overrideCalls).toEqual([]);
		expect(setCalls).toEqual([]);
	});

	test("profile names with unusual characters render without breaking the list", async () => {
		const weirdProfile: ModelProfileDefinition = {
			...userProfile,
			name: "Team/Profile: β 🚀 [default] {x}|$",
			displayName: "Team/Profile: β 🚀 [default] {x}|$",
		};
		const selector = createSelector(() => {}, { profiles: [weirdProfile] });
		await renderSelector(selector);
		selector.handleInput("\x1b[C");
		const rendered = normalizeRenderedText(selector.render(240).join("\n"));

		expect(rendered).toContain("Model presets");
		expect(rendered).toContain("Team/Profile: β 🚀 [default] {x}|$");
		expect(rendered).toContain("Browse all models");
	});

	test("custom profile display names strip terminal control characters before rendering", async () => {
		const unsafeProfile: ModelProfileDefinition = {
			...userProfile,
			name: "unsafe-profile",
			displayName: "Unsafe\x1b[31mRed\x1b[0m\nNext\tName",
		};
		const selector = createSelector(() => {}, { profiles: [unsafeProfile] });
		await renderSelector(selector);
		selector.handleInput("\x1b[C");
		const rendered = selector.render(240).join("\n");
		const plain = Bun.stripANSI(rendered);

		expect(plain).toContain("UnsafeRed Next Name");
		expect(plain).not.toContain("UnsafeRed\nNext");
	});

	test("Browse all models switches to flat model rows", async () => {
		const selector = createSelector(() => {});
		await renderSelector(selector);

		const visitedRowIdentities = new Set<string>();
		while (true) {
			const rowIdentity = selector.__testSelectedPresetRowIdentity();
			if (!rowIdentity) throw new Error("Expected a selected preset landing row");
			if (rowIdentity === "browse") break;
			if (visitedRowIdentities.has(rowIdentity)) {
				throw new Error(`Preset landing navigation repeated ${rowIdentity} before browse`);
			}
			visitedRowIdentities.add(rowIdentity);
			selector.handleInput("\x1b[B");
		}

		expect(selector.__testSelectedPresetRowIdentity()).toBe("browse");
		selector.handleInput("\n");
		const rendered = normalizeRenderedText(selector.render(240).join("\n"));

		expect(rendered).toContain("Models");
		expect(rendered).toContain("provider-a/default");
		expect(rendered).toContain("provider-b/zzz-flat-model");
	});
});

test("delete action restores the profile when post-delete notification fails", async () => {
	const profiles = new Map<string, ModelProfileDefinition>([[userProfile.name, { ...userProfile }]]);
	const deletedConfigs: Record<
		string,
		{ required_providers: string[]; model_mapping: Record<string, ModelSelectorValue> }
	> = {};
	const registry = {
		...createRegistry({ profiles: [...profiles.values()] }),
		getModelProfiles: () => new Map(profiles),
		getModelProfile: (name: string) => profiles.get(name),
		getAvailableModelProfileNames: () => [...profiles.keys()],
		deleteCustomModelProfile: vi.fn(async (name: string) => {
			const profile = profiles.get(name);
			if (!profile) throw new Error("missing profile");
			const config = {
				required_providers: [...profile.requiredProviders],
				model_mapping: { ...profile.modelMapping },
			};
			deletedConfigs[name] = config;
			profiles.delete(name);
			return config;
		}),
		saveCustomModelProfile: vi.fn(
			async (
				name: string,
				config: { required_providers: string[]; model_mapping: Record<string, ModelSelectorValue> },
			) => {
				profiles.set(name, {
					name,
					requiredProviders: [...config.required_providers],
					modelMapping: { ...config.model_mapping },
					source: "user",
				});
				return profiles.get(name);
			},
		),
		refresh: vi.fn(async () => {}),
	};
	const settings = Settings.isolated({ "modelProfile.default": "unrelated" });
	const ctx = {
		ui: { setFocus: vi.fn(), requestRender: vi.fn() },
		editorContainer: { clear: vi.fn(), addChild: vi.fn() },
		editor: {},
		settings,
		session: {
			model: alternateModel,
			thinkingLevel: ThinkingLevel.Low,
			sessionId: "session-1",
			scopedModels: [],
			modelRegistry: registry,
			getActiveModelProfile: () => undefined,
			isFastForProvider: () => false,
			isFastForSubagentProvider: () => false,
			isFastModeActive: () => false,
		},
		statusLine: { invalidate: vi.fn() },
		updateEditorBorderColor: vi.fn(),
		showStatus: vi.fn(),
		showError: vi.fn(),
		showHookConfirm: vi.fn(async () => true),
		notifyConfigChanged: vi.fn(async () => {
			throw new Error("notify failed");
		}),
	};
	const controller = new SelectorController(ctx as never);

	controller.showModelSelector();
	const selector = ctx.editorContainer.addChild.mock.calls[0]?.[0] as ModelSelectorComponent;
	await selector.__testSelectPresetAction("profile-a", "delete");

	expect(registry.deleteCustomModelProfile).toHaveBeenCalledWith("profile-a");
	expect(registry.saveCustomModelProfile).toHaveBeenCalledWith("profile-a", deletedConfigs["profile-a"]);
	expect(profiles.has("profile-a")).toBe(true);
	expect(ctx.showError).toHaveBeenCalledWith("Preset delete failed: notify failed");
});
