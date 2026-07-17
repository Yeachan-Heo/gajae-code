import { beforeAll, describe, expect, test, vi } from "bun:test";
import { ThinkingLevel } from "@gajae-code/agent-core";
import { Effort, getBundledModel, type Model } from "@gajae-code/ai";
import type { GjcModelAssignmentTargetId, ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { ModelSelectorComponent } from "@gajae-code/coding-agent/modes/components/model-selector";
import {
	getThemeByName,
	setSymbolPreset,
	setTheme,
	setThemeInstance,
	theme,
} from "@gajae-code/coding-agent/modes/theme/theme";
import type { TUI } from "@gajae-code/tui";

function normalizeRenderedText(text: string): string {
	return (
		text
			// strip ANSI escapes
			.replace(/\x1b\[[0-9;]*m/g, "")
			// collapse whitespace
			.replace(/\s+/g, " ")
			.trim()
	);
}

interface SelectionCapture {
	model: Model;
	role: GjcModelAssignmentTargetId | null;
	thinkingLevel?: ThinkingLevel;
	selector?: string;
	roles?: readonly GjcModelAssignmentTargetId[];
}

type TestModelSelectorSelection = {
	kind: "assignment";
	model: Model;
	role: GjcModelAssignmentTargetId | null;
	thinkingLevel?: ThinkingLevel;
	selector?: string;
	roles?: readonly GjcModelAssignmentTargetId[];
};

interface CreateSelectorOptions {
	modelRegistry?: ModelRegistry;
	temporaryOnly?: boolean;
	thinkingLevel?: ThinkingLevel | null;
	explicitThinkingLevel?: boolean;
}

function createSelector(
	model: Model,
	settings: Settings,
	onSelect: (selection: TestModelSelectorSelection) => void = () => {},
	options: CreateSelectorOptions = {},
): ModelSelectorComponent {
	const modelRegistry =
		options.modelRegistry ??
		({
			getAll: () => [model],
			getDiscoverableProviders: () => [],
			getCanonicalModels: () => [],
			resolveCanonicalModel: () => undefined,
		} as unknown as ModelRegistry);
	const ui = {
		requestRender: vi.fn(),
	} as unknown as TUI;
	const scopedModel =
		options.thinkingLevel === null
			? { model, explicitThinkingLevel: options.explicitThinkingLevel }
			: {
					model,
					thinkingLevel: options.thinkingLevel ?? ThinkingLevel.Off,
					explicitThinkingLevel: options.explicitThinkingLevel,
				};

	return new ModelSelectorComponent(
		ui,
		model,
		settings,
		modelRegistry,
		[scopedModel],
		selection => onSelect(selection as TestModelSelectorSelection),
		() => {},
		{
			temporaryOnly: options.temporaryOnly,
		},
	);
}

function createOpenAIModel(provider: "openai" | "openai-codex", id: string, reasoning = true): Model {
	return {
		id,
		name: id,
		api: provider === "openai-codex" ? "openai-codex-responses" : "openai-responses",
		provider,
		baseUrl: provider === "openai-codex" ? "https://chatgpt.com/backend-api" : "https://api.openai.com/v1",
		reasoning,
		thinking: reasoning
			? {
					minLevel: Effort.Low,
					maxLevel: Effort.High,
					defaultLevel: Effort.Medium,
					mode: "effort",
				}
			: undefined,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 8192,
	};
}

function createOllamaCloudModel(id: string): Model {
	return {
		id,
		name: "DeepSeek V4 Pro",
		api: "ollama-chat",
		provider: "ollama-cloud",
		baseUrl: "https://ollama.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 8192,
	};
}
let testTheme = await getThemeByName("red-claw");

function installTestTheme(): void {
	if (!testTheme) {
		throw new Error("Failed to load dark theme for ModelSelector tests");
	}
	setThemeInstance(testTheme);
}

describe("ModelSelector canonical model selection", () => {
	beforeAll(async () => {
		testTheme = await getThemeByName("red-claw");
		if (!testTheme) {
			throw new Error("Failed to load dark theme for ModelSelector tests");
		}
	});

	test("uses canonical GJC assignment actions while hiding legacy roles", async () => {
		installTestTheme();
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model anthropic/claude-sonnet-4-5");

		const settings = Settings.isolated({
			cycleOrder: ["smol", "custom-fast", "default"],
			modelRoles: {
				default: `${model.provider}/${model.id}:low`,
				"custom-fast": `${model.provider}/${model.id}:high`,
				smol: `${model.provider}/${model.id}`,
			},
			"task.agentModelOverrides": {
				executor: `${model.provider}/${model.id}:high`,
			},
			modelTags: {
				smol: { name: "Quick", color: "error" },
			},
		});

		let selected: SelectionCapture | undefined;
		const selector = createSelector(model, settings, selection => {
			if (selection.kind === "assignment") selected = selection;
		});
		await Bun.sleep(0);
		installTestTheme();

		const rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("DEFAULT (low)");
		expect(rendered).toContain("EXECUTOR (high)");
		expect(rendered).not.toContain("custom-fast");
		expect(rendered).not.toContain("SMOL");

		selector.handleInput("\n");
		installTestTheme();
		const actionRendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(actionRendered).toContain("Action for:");
		expect(actionRendered).toContain("Set as DEFAULT (Default)");
		expect(actionRendered).toContain("Set as EXECUTOR (Executor)");
		expect(actionRendered).toContain("Set as ARCHITECT (Architect)");
		expect(actionRendered).toContain("Set as PLANNER (Planner)");
		expect(actionRendered).toContain("Set as CRITIC (Critic)");
		expect(actionRendered).toContain("Set for all role agents");
		expect(actionRendered).toContain("Set for all targets");
		expect(actionRendered).not.toContain("Set as custom-fast");
		expect(actionRendered).not.toContain("Set as SMOL");
		expect(actionRendered).not.toContain("Set as TASK");

		selector.handleInput("\n");
		const selectedAfterEnter = selected;
		if (!selectedAfterEnter) throw new Error("Expected Enter to select a model");
		expect(selectedAfterEnter.model).toBe(model);
		expect(selectedAfterEnter.role).toBe("default");
		expect(selectedAfterEnter.thinkingLevel).toBe(ThinkingLevel.Off);
		expect(selectedAfterEnter.selector).toBe(`${model.provider}/${model.id}`);
	});

	test("selects role-agent assignment without using stale task role", async () => {
		installTestTheme();
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model anthropic/claude-sonnet-4-5");

		const settings = Settings.isolated({
			modelRoles: {
				default: `${model.provider}/${model.id}:medium`,
			},
			"task.agentModelOverrides": {
				executor: `${model.provider}/${model.id}:high`,
			},
		});

		let selected: SelectionCapture | undefined;
		const selector = createSelector(model, settings, selection => {
			if (selection.kind === "assignment") selected = selection;
		});
		await Bun.sleep(0);
		installTestTheme();

		selector.handleInput("\n");
		selector.handleInput("\x1b[B");
		selector.handleInput("\n");
		expect(selected).toBeUndefined();
		const thinkingRendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(thinkingRendered).toContain("Reasoning for Executor");
		expect(thinkingRendered).toContain("xhigh");
		selector.handleInput("\n");

		const selectedAfterEnter = selected;
		if (!selectedAfterEnter) throw new Error("Expected role-agent selection");
		expect(selectedAfterEnter.role).toBe("executor");
		expect(selectedAfterEnter.thinkingLevel).toBe(ThinkingLevel.Off);
		expect(selectedAfterEnter.selector).toBe(`${model.provider}/${model.id}:off`);
	});

	test("role assignment updates live runtime override for next selector render", async () => {
		installTestTheme();
		const model = createOpenAIModel("openai", "gpt-live-override-test");
		const settings = Settings.isolated();
		settings.set("task.agentModelOverrides", {
			planner: `${model.provider}/${model.id}:low`,
		});
		settings.override("task.agentModelOverrides", {
			planner: `${model.provider}/${model.id}:low`,
		});

		const selector = createSelector(model, settings, selection => {
			if (selection.kind === "assignment" && selection.role) {
				settings.setAgentModelOverride(selection.role, selection.selector ?? `${model.provider}/${model.id}`);
			}
		});
		await Bun.sleep(0);
		installTestTheme();

		selector.handleInput("\n");
		selector.handleInput("\x1b[B");
		selector.handleInput("\x1b[B");
		selector.handleInput("\x1b[B");
		selector.handleInput("\n");
		selector.handleInput("\x1b[B");
		selector.handleInput("\x1b[B");
		selector.handleInput("\x1b[B");
		selector.handleInput("\n");

		const nextSelector = createSelector(model, settings);
		await Bun.sleep(0);
		installTestTheme();
		const rendered = normalizeRenderedText(nextSelector.render(220).join("\n"));

		expect(rendered).toContain("PLANNER (high)");

		settings.clearOverride("task.agentModelOverrides");

		expect(settings.get("task.agentModelOverrides")).toEqual({
			planner: `${model.provider}/${model.id}:high`,
		});
	});

	test("selects batch role-agent assignment action", async () => {
		installTestTheme();
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model anthropic/claude-sonnet-4-5");

		let selected: SelectionCapture | undefined;
		const selector = createSelector(model, Settings.isolated(), selection => {
			if (selection.kind === "assignment") selected = selection;
		});
		await Bun.sleep(0);
		installTestTheme();

		selector.handleInput("\n");
		for (let i = 0; i < 5; i++) selector.handleInput("\x1b[B");
		selector.handleInput("\n");

		// Batch assignment of a reasoning model requires an explicit effort choice.
		expect(selected).toBeUndefined();
		expect(normalizeRenderedText(selector.render(220).join("\n"))).toContain("Reasoning for all role agents");
		selector.handleInput("\n");

		const selectedAfterEnter = selected;
		if (!selectedAfterEnter) throw new Error("Expected batch role-agent selection");
		expect(selectedAfterEnter.role).toBe("default");
		expect(selectedAfterEnter.roles).toEqual(["executor", "architect", "planner", "critic"]);
		expect(selectedAfterEnter.thinkingLevel).toBe(ThinkingLevel.Off);
		expect(selectedAfterEnter.selector).toBe(`${model.provider}/${model.id}:off`);
	});

	test("selects batch all-targets assignment action", async () => {
		installTestTheme();
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model anthropic/claude-sonnet-4-5");

		let selected: SelectionCapture | undefined;
		const selector = createSelector(model, Settings.isolated(), selection => {
			if (selection.kind === "assignment") selected = selection;
		});
		await Bun.sleep(0);
		installTestTheme();

		selector.handleInput("\n");
		for (let i = 0; i < 6; i++) selector.handleInput("\x1b[B");
		selector.handleInput("\n");

		// Batch assignment of a reasoning model requires an explicit effort choice.
		expect(selected).toBeUndefined();
		expect(normalizeRenderedText(selector.render(220).join("\n"))).toContain("Reasoning for all targets");
		selector.handleInput("\n");

		const selectedAfterEnter = selected;
		if (!selectedAfterEnter) throw new Error("Expected all-targets selection");
		expect(selectedAfterEnter.role).toBe("default");
		expect(selectedAfterEnter.roles).toEqual(["default", "executor", "architect", "planner", "critic"]);
		expect(selectedAfterEnter.thinkingLevel).toBe(ThinkingLevel.Off);
		expect(selectedAfterEnter.selector).toBe(`${model.provider}/${model.id}:off`);
	});

	test("temporary scoped model selection carries selected reasoning", async () => {
		installTestTheme();
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model anthropic/claude-sonnet-4-5");

		const settings = Settings.isolated({
			modelRoles: {
				default: `${model.provider}/${model.id}:high`,
			},
		});

		let selected: SelectionCapture | undefined;
		const selector = createSelector(
			model,
			settings,
			selection => {
				if (selection.kind === "assignment") selected = selection;
			},
			{ temporaryOnly: true, thinkingLevel: ThinkingLevel.Low },
		);
		await Bun.sleep(0);
		installTestTheme();

		selector.handleInput("\n");

		const selectedAfterEnter = selected;
		if (!selectedAfterEnter) throw new Error("Expected temporary selection");
		expect(selectedAfterEnter.role).toBeNull();
		expect(selectedAfterEnter.thinkingLevel).toBe(ThinkingLevel.Low);
		expect(selectedAfterEnter.selector).toBe(`${model.provider}/${model.id}`);
	});

	test("canonical scoped model assignment preserves selected reasoning", async () => {
		installTestTheme();
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model anthropic/claude-sonnet-4-5");

		const settings = Settings.isolated({
			modelRoles: {
				default: `${model.provider}/${model.id}:high`,
			},
		});
		const selectorValue = `${model.provider}/${model.id}`;
		const modelRegistry = {
			getAll: () => [model],
			getDiscoverableProviders: () => [],
			getCanonicalModels: () => [
				{
					id: "claude-sonnet",
					name: "Claude Sonnet",
					variants: [{ canonicalId: "claude-sonnet", selector: selectorValue, model, source: "bundled" }],
				},
			],
			resolveCanonicalModel: () => model,
		} as unknown as ModelRegistry;

		let selected: SelectionCapture | undefined;
		const selector = createSelector(
			model,
			settings,
			selection => {
				if (selection.kind === "assignment") selected = selection;
			},
			{ modelRegistry, thinkingLevel: ThinkingLevel.Medium },
		);
		await Bun.sleep(0);
		installTestTheme();

		selector.handleInput("\t");
		selector.handleInput("\n");
		selector.handleInput("\x1b[B");
		selector.handleInput("\n");
		selector.handleInput("\n");

		const selectedAfterEnter = selected;
		if (!selectedAfterEnter) throw new Error("Expected canonical role-agent selection");
		expect(selectedAfterEnter.role).toBe("executor");
		expect(selectedAfterEnter.thinkingLevel).toBe(ThinkingLevel.Medium);
		expect(selectedAfterEnter.selector).toBe("claude-sonnet:medium");
	});

	test("refreshes Ollama Cloud using provider id instead of tab label", async () => {
		installTestTheme();
		const settings = Settings.isolated({});
		const discoveredModel = createOllamaCloudModel("deepseek-v4-pro");
		let availableModels: Model[] = [];
		const refreshProvider = vi.fn(async (providerId: string) => {
			if (providerId === "ollama-cloud") {
				availableModels = [discoveredModel];
			}
		});
		const modelRegistry = {
			getAll: () => availableModels,
			refresh: vi.fn(async () => {}),
			refreshProvider,
			getError: () => undefined,
			getAvailable: () => availableModels,
			getDiscoverableProviders: () => ["ollama-cloud"],
			getCanonicalModels: () => [],
			resolveCanonicalModel: () => undefined,
			getProviderDiscoveryState: () => ({
				provider: "ollama-cloud",
				status: "idle",
				optional: false,
				stale: false,
				models: [],
			}),
		} as unknown as ModelRegistry;
		const ui = {
			requestRender: vi.fn(),
		} as unknown as TUI;

		const selector = new ModelSelectorComponent(
			ui,
			undefined,
			settings,
			modelRegistry,
			[],
			() => {},
			() => {},
		);
		await Bun.sleep(0);
		installTestTheme();

		const initialRendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(initialRendered).toContain("OLLAMA CLOUD");

		selector.handleInput("\t");
		selector.handleInput("\t");
		await Bun.sleep(0);
		installTestTheme();

		expect(refreshProvider).toHaveBeenCalledWith("ollama-cloud");
		const rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("deepseek-v4-pro");
		expect(rendered).not.toContain("Provider has not been refreshed yet");
	});

	test("prompts for reasoning before assigning OpenAI reasoning default models", async () => {
		installTestTheme();
		const model = createOpenAIModel("openai", "gpt-reasoning-test");
		const settings = Settings.isolated({});

		let selected: SelectionCapture | undefined;
		const selector = createSelector(
			model,
			settings,
			selection => {
				if (selection.kind === "assignment") selected = selection;
			},
			{ thinkingLevel: null },
		);
		await Bun.sleep(0);
		installTestTheme();

		selector.handleInput("\n");
		selector.handleInput("\n");

		expect(selected).toBeUndefined();
		const thinkingRendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(thinkingRendered).toContain("Reasoning for Default");
		expect(thinkingRendered).toContain("off");
		expect(thinkingRendered).toContain("high");

		selector.handleInput("\x1b[B");
		selector.handleInput("\x1b[B");
		selector.handleInput("\x1b[B");
		selector.handleInput("\n");

		const selectedAfterThinking = selected;
		if (!selectedAfterThinking) throw new Error("Expected OpenAI selection after reasoning choice");
		expect(selectedAfterThinking.model).toBe(model);
		expect(selectedAfterThinking.role).toBe("default");
		expect(selectedAfterThinking.thinkingLevel).toBe(ThinkingLevel.High);
		expect(selectedAfterThinking.selector).toBe(`${model.provider}/${model.id}`);
	});

	test("can explicitly choose off for OpenAI reasoning default models", async () => {
		installTestTheme();
		const model = createOpenAIModel("openai", "gpt-reasoning-off-test");
		const settings = Settings.isolated({});

		let selected: SelectionCapture | undefined;
		const selector = createSelector(
			model,
			settings,
			selection => {
				if (selection.kind === "assignment") selected = selection;
			},
			{ thinkingLevel: null },
		);
		await Bun.sleep(0);
		installTestTheme();

		selector.handleInput("\n");
		selector.handleInput("\n");
		selector.handleInput("\n");

		const selectedAfterThinking = selected;
		if (!selectedAfterThinking) throw new Error("Expected OpenAI selection after off choice");
		expect(selectedAfterThinking.role).toBe("default");
		expect(selectedAfterThinking.thinkingLevel).toBe(ThinkingLevel.Off);
		expect(selectedAfterThinking.selector).toBe(`${model.provider}/${model.id}`);
	});

	test("prompts for reasoning before assigning OpenAI Codex role-agent models", async () => {
		installTestTheme();
		const model = createOpenAIModel("openai-codex", "gpt-codex-reasoning-test");
		const settings = Settings.isolated({});

		let selected: SelectionCapture | undefined;
		const selector = createSelector(
			model,
			settings,
			selection => {
				if (selection.kind === "assignment") selected = selection;
			},
			{ thinkingLevel: null },
		);
		await Bun.sleep(0);
		installTestTheme();

		selector.handleInput("\n");
		selector.handleInput("\x1b[B");
		selector.handleInput("\n");

		expect(selected).toBeUndefined();
		const thinkingRendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(thinkingRendered).toContain("Reasoning for Executor");

		selector.handleInput("\x1b[B");
		selector.handleInput("\x1b[B");
		selector.handleInput("\x1b[B");
		selector.handleInput("\n");

		const selectedAfterThinking = selected;
		if (!selectedAfterThinking) throw new Error("Expected OpenAI Codex selection after reasoning choice");
		expect(selectedAfterThinking.role).toBe("executor");
		expect(selectedAfterThinking.thinkingLevel).toBe(ThinkingLevel.High);
		expect(selectedAfterThinking.selector).toBe(`${model.provider}/${model.id}:high`);
	});

	test("shows only role assignment actions for OpenAI Codex reasoning models", async () => {
		installTestTheme();
		const model = createOpenAIModel("openai-codex", "gpt-codex-actions-test");
		model.thinking = {
			minLevel: Effort.Low,
			maxLevel: Effort.XHigh,
			defaultLevel: Effort.Medium,
			mode: "effort",
		};
		const settings = Settings.isolated({});

		const selector = createSelector(model, settings, undefined, { thinkingLevel: null });
		await Bun.sleep(0);
		installTestTheme();

		selector.handleInput("\n");
		const actionRendered = normalizeRenderedText(selector.render(260).join("\n"));

		expect(actionRendered).toContain("Set as DEFAULT (Default)");
		expect(actionRendered).toContain("Set as EXECUTOR (Executor)");
		expect(actionRendered).toContain("Set as ARCHITECT (Architect)");
		expect(actionRendered).toContain("Set as PLANNER (Planner)");
		expect(actionRendered).toContain("Set as CRITIC (Critic)");
		expect(actionRendered).not.toContain("Apply OpenAI Codex role preset");
		expect(actionRendered).not.toContain(
			"Default medium, Executor low, Architect xhigh, Planner medium, Critic high",
		);
	});

	test("prompts for reasoning when scoped OpenAI thinking came from defaults", async () => {
		installTestTheme();
		const model = createOpenAIModel("openai", "gpt-defaulted-scope-test");
		const settings = Settings.isolated({});

		let selected: SelectionCapture | undefined;
		const selector = createSelector(
			model,
			settings,
			selection => {
				if (selection.kind === "assignment") selected = selection;
			},
			{ thinkingLevel: ThinkingLevel.High, explicitThinkingLevel: false },
		);
		await Bun.sleep(0);
		installTestTheme();

		selector.handleInput("\n");
		selector.handleInput("\n");

		expect(selected).toBeUndefined();
		const thinkingRendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(thinkingRendered).toContain("Reasoning for Default");

		selector.handleInput("\n");

		const selectedAfterThinking = selected;
		if (!selectedAfterThinking) throw new Error("Expected OpenAI selection after scoped reasoning choice");
		expect(selectedAfterThinking.role).toBe("default");
		expect(selectedAfterThinking.thinkingLevel).toBe(ThinkingLevel.High);
		expect(selectedAfterThinking.selector).toBe(`${model.provider}/${model.id}`);
	});

	test("does not prompt when scoped OpenAI thinking was explicit", async () => {
		installTestTheme();
		const model = createOpenAIModel("openai", "gpt-explicit-scope-test");
		const settings = Settings.isolated({});

		let selected: SelectionCapture | undefined;
		const selector = createSelector(
			model,
			settings,
			selection => {
				if (selection.kind === "assignment") selected = selection;
			},
			{ thinkingLevel: ThinkingLevel.High, explicitThinkingLevel: true },
		);
		await Bun.sleep(0);
		installTestTheme();

		selector.handleInput("\n");
		selector.handleInput("\n");

		const selectedAfterEnter = selected;
		if (!selectedAfterEnter) throw new Error("Expected direct explicit scoped selection");
		expect(selectedAfterEnter.role).toBe("default");
		expect(selectedAfterEnter.thinkingLevel).toBe(ThinkingLevel.High);
		expect(selectedAfterEnter.selector).toBe(`${model.provider}/${model.id}`);
	});

	test("limits missing OpenAI thinking metadata to off choice", async () => {
		installTestTheme();
		const model = createOpenAIModel("openai", "gpt-missing-thinking-metadata");
		model.thinking = undefined;
		const settings = Settings.isolated({});

		const selector = createSelector(model, settings, () => {}, { thinkingLevel: null });
		await Bun.sleep(0);
		installTestTheme();

		selector.handleInput("\n");
		selector.handleInput("\n");

		const thinkingRendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(thinkingRendered).toContain("Reasoning for Default");
		expect(thinkingRendered).toContain("off");
		expect(thinkingRendered).not.toContain("high");
		expect(thinkingRendered).not.toContain("xhigh");
	});

	test("does not prompt for non-reasoning OpenAI models", async () => {
		installTestTheme();
		const model = createOpenAIModel("openai", "gpt-non-reasoning-test", false);
		const settings = Settings.isolated({});

		let selected: SelectionCapture | undefined;
		const selector = createSelector(
			model,
			settings,
			selection => {
				if (selection.kind === "assignment") selected = selection;
			},
			{ thinkingLevel: null },
		);
		await Bun.sleep(0);
		installTestTheme();

		selector.handleInput("\n");
		selector.handleInput("\n");

		const selectedAfterEnter = selected;
		if (!selectedAfterEnter) throw new Error("Expected direct non-reasoning selection");
		expect(selectedAfterEnter.role).toBe("default");
		expect(selectedAfterEnter.thinkingLevel).toBe(ThinkingLevel.Inherit);
		expect(selectedAfterEnter.selector).toBe(`${model.provider}/${model.id}`);
	});
});

function countOccurrences(haystack: string, needle: string): number {
	if (!needle) return 0;
	let count = 0;
	let idx = haystack.indexOf(needle);
	while (idx !== -1) {
		count++;
		idx = haystack.indexOf(needle, idx + needle.length);
	}
	return count;
}

function createFastSelector(args: {
	models: Model[];
	settings: Settings;
	isFastForProvider: (provider?: string) => boolean;
	isFastForSubagentProvider?: (provider?: string) => boolean;
	isCurrentModelFastModeActive?: () => boolean;
	currentModel?: Model;
}): ModelSelectorComponent {
	const { models, settings, isFastForProvider, currentModel } = args;
	// Subagent roles default to the same predicate as the session unless a test
	// exercises the session-vs-subagent tier divergence explicitly.
	const isFastForSubagentProvider = args.isFastForSubagentProvider ?? isFastForProvider;
	const modelRegistry = {
		getAll: () => models,
		getDiscoverableProviders: () => [],
		getCanonicalModels: () => [],
		resolveCanonicalModel: () => undefined,
	} as unknown as ModelRegistry;
	const ui = { requestRender: vi.fn() } as unknown as TUI;
	const scoped = models.map(model => ({ model, thinkingLevel: ThinkingLevel.Off }));
	return new ModelSelectorComponent(
		ui,
		currentModel,
		settings,
		modelRegistry,
		scoped,
		() => {},
		() => {},
		{ isFastForProvider, isFastForSubagentProvider, isCurrentModelFastModeActive: args.isCurrentModelFastModeActive },
	);
}

describe("ModelSelector fast-mode indicator", () => {
	beforeAll(async () => {
		testTheme = await getThemeByName("red-claw");
		if (!testTheme) {
			throw new Error("Failed to load theme for fast-mode indicator tests");
		}
	});

	test("AC-1: renders fast glyph after DEFAULT and EXECUTOR badges for priority tier", async () => {
		installTestTheme();
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model anthropic/claude-sonnet-4-5");
		const settings = Settings.isolated({
			modelRoles: { default: `${model.provider}/${model.id}:low` },
			"task.agentModelOverrides": { executor: `${model.provider}/${model.id}:high` },
		});
		const selector = createFastSelector({
			models: [model],
			settings,
			isFastForProvider: () => true,
			currentModel: model,
		});
		await Bun.sleep(0);
		installTestTheme();
		const iconFast = theme.icon.fast;
		const rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain(`DEFAULT (low) ${iconFast}`);
		expect(rendered).toContain(`EXECUTOR (high) ${iconFast}`);
		// Duplicate-glyph guard: the current model already carries role glyphs, so no
		// extra standalone active-row glyph is added.
		expect(countOccurrences(rendered, iconFast)).toBe(2);
		// Regression: each badge label and thinking label renders exactly once, in order.
		expect(countOccurrences(rendered, "DEFAULT")).toBe(1);
		expect(countOccurrences(rendered, "EXECUTOR")).toBe(1);
		expect(rendered.indexOf("DEFAULT")).toBeLessThan(rendered.indexOf("(low)"));
		expect(rendered.indexOf("(low)")).toBeLessThan(rendered.indexOf(iconFast));
	});

	test("subagent role glyph reflects the subagent tier, not the session tier", async () => {
		// Regression for #691 round-2 blocker: serviceTier=priority but
		// task.serviceTier=none. DEFAULT (modelRoles) runs in the main session and is
		// fast; EXECUTOR (task.agentModelOverrides) runs under the subagent tier and
		// must show no glyph even with the same anthropic model.
		installTestTheme();
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model anthropic/claude-sonnet-4-5");
		const settings = Settings.isolated({
			modelRoles: { default: `${model.provider}/${model.id}:low` },
			"task.agentModelOverrides": { executor: `${model.provider}/${model.id}:high` },
		});
		const selector = createFastSelector({
			models: [model],
			settings,
			isFastForProvider: () => true,
			isFastForSubagentProvider: () => false,
			currentModel: model,
		});
		await Bun.sleep(0);
		installTestTheme();
		const iconFast = theme.icon.fast;
		const rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain(`DEFAULT (low) ${iconFast}`);
		expect(rendered).toContain("EXECUTOR (high)");
		expect(rendered).not.toContain(`EXECUTOR (high) ${iconFast}`);
		// Only the main-session DEFAULT row lights the glyph.
		expect(countOccurrences(rendered, iconFast)).toBe(1);
	});
	test("AC-2: claude-only renders fast glyph only on anthropic rows in mixed-provider selector", async () => {
		installTestTheme();
		const anthropic = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!anthropic) throw new Error("Expected anthropic model");
		const openai = createOpenAIModel("openai", "gpt-5-fast-mixed");
		const settings = Settings.isolated({
			modelRoles: { default: `${anthropic.provider}/${anthropic.id}:low` },
			"task.agentModelOverrides": { executor: `${openai.provider}/${openai.id}:high` },
		});
		const selector = createFastSelector({
			models: [anthropic, openai],
			settings,
			isFastForProvider: provider => provider === "anthropic",
		});
		await Bun.sleep(0);
		installTestTheme();
		const iconFast = theme.icon.fast;
		const rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain(`DEFAULT (low) ${iconFast}`);
		expect(rendered).toContain("EXECUTOR (high)");
		expect(rendered).not.toContain(`EXECUTOR (high) ${iconFast}`);
		expect(countOccurrences(rendered, iconFast)).toBe(1);
	});

	test("AC-3: none tier renders no fast glyph but keeps badges", async () => {
		installTestTheme();
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected model");
		const settings = Settings.isolated({
			modelRoles: { default: `${model.provider}/${model.id}:low` },
			"task.agentModelOverrides": { executor: `${model.provider}/${model.id}:high` },
		});
		const selector = createFastSelector({
			models: [model],
			settings,
			isFastForProvider: () => false,
			currentModel: model,
		});
		await Bun.sleep(0);
		installTestTheme();
		const iconFast = theme.icon.fast;
		const rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("DEFAULT (low)");
		expect(rendered).toContain("EXECUTOR (high)");
		expect(rendered).not.toContain(iconFast);
	});

	test("AC-4: active non-role current model row shows fast glyph via currentModel", async () => {
		installTestTheme();
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected model");
		const settings = Settings.isolated({});
		const selector = createFastSelector({
			models: [model],
			settings,
			isFastForProvider: () => true,
			currentModel: model,
		});
		await Bun.sleep(0);
		installTestTheme();
		const iconFast = theme.icon.fast;
		const rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).not.toContain("DEFAULT");
		expect(rendered).not.toContain("EXECUTOR");
		expect(rendered).toContain(iconFast);
		expect(countOccurrences(rendered, iconFast)).toBe(1);
	});

	test("AC-7: fast glyph uses theme.icon.fast variant, not a hardcoded emoji", async () => {
		await setTheme("red-claw");
		await setSymbolPreset("ascii");
		try {
			const asciiIcon = theme.icon.fast;
			expect(asciiIcon).not.toBe("\u26a1");
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected model");
			const settings = Settings.isolated({
				modelRoles: { default: `${model.provider}/${model.id}:low` },
			});
			const selector = createFastSelector({
				models: [model],
				settings,
				isFastForProvider: () => true,
				currentModel: model,
			});
			await Bun.sleep(0);
			const rendered = normalizeRenderedText(selector.render(220).join("\n"));
			expect(rendered).toContain(asciiIcon);
			expect(rendered).not.toContain("\u26a1");
		} finally {
			await setSymbolPreset("unicode");
			installTestTheme();
		}
	});

	test("AC-8: unset service tier renders no fast glyph", async () => {
		installTestTheme();
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected model");
		const settings = Settings.isolated({
			modelRoles: { default: `${model.provider}/${model.id}:low` },
		});
		// serviceTier === undefined is modeled as the predicate returning false everywhere.
		const selector = createFastSelector({
			models: [model],
			settings,
			isFastForProvider: () => false,
			currentModel: model,
		});
		await Bun.sleep(0);
		installTestTheme();
		const iconFast = theme.icon.fast;
		const rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("DEFAULT (low)");
		expect(rendered).not.toContain(iconFast);
	});

	test("current model's DEFAULT badge uses EFFECTIVE state: no glyph after auto-disable, subagent still on", async () => {
		installTestTheme();
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model anthropic/claude-sonnet-4-5");
		const settings = Settings.isolated({
			modelRoles: { default: `${model.provider}/${model.id}:low` },
			"task.agentModelOverrides": { executor: `${model.provider}/${model.id}:high` },
		});
		// Intent grants fast (isFastForProvider true), the subagent inherits it, but
		// the current model was auto-disabled (effective false). The DEFAULT badge on
		// the current row must drop its glyph while the EXECUTOR subagent badge keeps it.
		const selector = createFastSelector({
			models: [model],
			settings,
			isFastForProvider: () => true,
			isFastForSubagentProvider: () => true,
			isCurrentModelFastModeActive: () => false,
			currentModel: model,
		});
		await Bun.sleep(0);
		installTestTheme();
		const iconFast = theme.icon.fast;
		const rendered = normalizeRenderedText(selector.render(220).join("\n"));
		// Current-model DEFAULT badge: no glyph (effective off).
		expect(rendered).toContain("DEFAULT (low)");
		expect(rendered).not.toContain(`DEFAULT (low) ${iconFast}`);
		// Subagent EXECUTOR badge: glyph present (inherited intent).
		expect(rendered).toContain(`EXECUTOR (high) ${iconFast}`);
	});
});
