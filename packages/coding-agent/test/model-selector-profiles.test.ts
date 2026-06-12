import { beforeAll, describe, expect, test, vi } from "bun:test";
import { ThinkingLevel } from "@gajae-code/agent-core";
import type { Model } from "@gajae-code/ai";
import { BUILTIN_MODEL_PROFILES, type ModelProfileDefinition } from "@gajae-code/coding-agent/config/model-profiles";
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
	requiredProviders: ["provider-a"],
	modelMapping: { default: "provider-a/default:high", executor: "provider-a/alternate" },
	source: "user",
};
const codingPlanProfiles = BUILTIN_MODEL_PROFILES.filter(profile =>
	["minimax-standard", "minimax-cn-standard", "kimi-standard", "glm-standard"].includes(profile.name),
);

function createRegistry(options: { missingCredentials?: boolean; profiles?: ModelProfileDefinition[] } = {}) {
	const profiles = new Map((options.profiles ?? [profile]).map(profile => [profile.name, profile]));
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
	options: { temporaryOnly?: boolean; profiles?: ModelProfileDefinition[] } = {},
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

	test("renders grouped Presets above model rows", async () => {
		installTestTheme();
		const selector = createSelector(() => {});
		await Bun.sleep(10);
		installTestTheme();

		const rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered.indexOf("Presets")).toBeGreaterThanOrEqual(0);
		expect(rendered).toContain("Browse presets");
		expect(rendered).toContain("Enter to open grouped presets");
		expect(rendered.indexOf("provider-a/default")).toBeGreaterThan(rendered.indexOf("Browse presets"));
		expect(rendered).not.toContain("profile-a");
	});

	test("opens profile actions through grouped preset picker", async () => {
		installTestTheme();
		let selected: ModelSelectorSelection | undefined;
		const selector = createSelector(selection => {
			selected = selection;
		});
		await Bun.sleep(10);
		installTestTheme();

		selector.handleInput("\n");
		let rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("Custom (1) — User-defined profiles");
		selector.handleInput("\n");
		rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("profile-a");
		selector.handleInput("\n");
		rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("Action for profile: profile-a");
		selector.handleInput("\n");

		expect(selected).toEqual({ kind: "profile", profileName: "profile-a", setDefault: false });
	});

	test("groups first-class coding plan presets under Coding Plans", async () => {
		installTestTheme();
		const selector = createSelector(() => {}, { profiles: codingPlanProfiles });
		await Bun.sleep(10);
		installTestTheme();

		let rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("Browse presets");
		expect(rendered).not.toContain("minimax-standard");
		expect(rendered).not.toContain("minimax-cn-standard");
		expect(rendered).not.toContain("kimi-standard");
		expect(rendered).not.toContain("glm-standard");

		selector.handleInput("\n");
		rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("Coding Plans (4) — MiniMax, Kimi, and GLM/zAI profiles");

		selector.handleInput("\n");
		rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("minimax-standard");
		expect(rendered).toContain("minimax-cn-standard");
		expect(rendered).toContain("kimi-standard");
		expect(rendered).toContain("glm-standard");
		expect(rendered).not.toContain("provider-a/default");
	});

	test("temporary-only mode hides Presets", async () => {
		installTestTheme();
		const selector = createSelector(() => {}, { temporaryOnly: true });
		await Bun.sleep(10);
		installTestTheme();

		const rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).not.toContain("Presets");
		expect(rendered).not.toContain("Browse presets");
		expect(rendered).not.toContain("profile-a");
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
		expect(ctx.showStatus).toHaveBeenCalledWith("Model profile: profile-a");
	});

	test("Set as default persists and flushes modelProfile.default", async () => {
		const { ctx, flush, setCalls } = createControllerContext();
		const controller = new SelectorController(ctx as never);
		await selectFirstProfile(controller, true);

		expect(ctx.showStatus).toHaveBeenCalledWith("Default model profile: profile-a");
		expect(setCalls).toContainEqual({ path: "modelProfile.default", value: "profile-a" });
		expect(flush).toHaveBeenCalledTimes(1);
		expect(ctx.showStatus).toHaveBeenCalledWith("Default model profile: profile-a");
	});

	test("credential failure shows error and leaves model and overrides unchanged", async () => {
		const { ctx, settings, session } = createControllerContext({ missingCredentials: true });
		const controller = new SelectorController(ctx as never);
		await selectFirstProfile(controller);

		expect(ctx.showError).toHaveBeenCalledWith(
			'Model profile "profile-a" requires credentials for: provider-a. Run /login and configure the missing provider(s), then retry.',
		);
		expect(session.setModelTemporaryCalls).toEqual([]);
		expect(session.model).toBe(alternateModel);
		expect(session.thinkingLevel).toBe(ThinkingLevel.Low);
		expect(settings.get("task.agentModelOverrides")).toEqual({ executor: "provider-a/original-executor" });
		expect(settings.get("modelProfile.default")).toBe("old-profile");
	});
});
