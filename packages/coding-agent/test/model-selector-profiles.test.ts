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
		getAvailable: () => [defaultModel, alternateModel],
		getAll: () => [defaultModel, alternateModel],
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
	onSelect: (selection: ModelSelectorSelection) => void,
	options: {
		temporaryOnly?: boolean;
		initialSearchInput?: string;
		settings?: Settings;
		currentModel?: Model;
		currentThinkingLevel?: ThinkingLevel;
		activeModelProfile?: string;
	} = {},
) {
	const ui = { requestRender: vi.fn() } as unknown as TUI;
	return new ModelSelectorComponent(
		ui,
		options.currentModel,
		options.settings ?? Settings.isolated(),
		createRegistry() as never,
		[],
		onSelect,
		() => {},
		options,
	);
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
	const session = {
		model: alternateModel as Model | undefined,
		thinkingLevel: ThinkingLevel.Low as ThinkingLevel | undefined,
		sessionId: "session-1",
		scopedModels: [],
		modelRegistry: createRegistry(options),
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

	test("up and down navigation stays on provider rows while collapsed", async () => {
		installTestTheme();
		const selector = createSelector(() => {});
		await Bun.sleep(10);
		installTestTheme();

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
	});

	test("Set as default persists and flushes modelProfile.default", async () => {
		const { ctx, flush, setCalls } = createControllerContext();
		const controller = new SelectorController(ctx as never);
		await selectFirstProfile(controller, true);

		expect(ctx.showStatus).toHaveBeenCalledWith("Default model profile: Profile Alpha");
		expect(setCalls).toContainEqual({ path: "modelProfile.default", value: "profile-a" });
		expect(flush).toHaveBeenCalledTimes(1);
		expect(ctx.showStatus).toHaveBeenCalledWith("Default model profile: Profile Alpha");
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
