import { beforeAll, describe, expect, test, vi } from "bun:test";
import { ThinkingLevel } from "@gajae-code/agent-core";
import { getBundledModel, type Model } from "@gajae-code/ai";
import type { GjcModelAssignmentTargetId, ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { ModelSelectorComponent } from "@gajae-code/coding-agent/modes/components/model-selector";
import { getThemeByName, setThemeInstance } from "@gajae-code/coding-agent/modes/theme/theme";
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
	thinkingLevel: ThinkingLevel | undefined;
	selector: string | undefined;
}

interface CreateSelectorOptions {
	modelRegistry?: ModelRegistry;
	temporaryOnly?: boolean;
	thinkingLevel?: ThinkingLevel;
}

function createSelector(
	model: Model,
	settings: Settings,
	onSelect: (
		model: Model,
		role: GjcModelAssignmentTargetId | null,
		thinkingLevel: ThinkingLevel | undefined,
		selector: string | undefined,
	) => void = () => {},
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

	return new ModelSelectorComponent(
		ui,
		model,
		settings,
		modelRegistry,
		[{ model, thinkingLevel: options.thinkingLevel ?? ThinkingLevel.Off }],
		onSelect,
		() => {},
		{ temporaryOnly: options.temporaryOnly },
	);
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
let testTheme = await getThemeByName("dark");

function installTestTheme(): void {
	if (!testTheme) {
		throw new Error("Failed to load dark theme for ModelSelector tests");
	}
	setThemeInstance(testTheme);
}

describe("ModelSelector canonical model selection", () => {
	beforeAll(async () => {
		testTheme = await getThemeByName("dark");
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
		const selector = createSelector(model, settings, (selectedModel, role, thinkingLevel, selectorValue) => {
			selected = { model: selectedModel, role, thinkingLevel, selector: selectorValue };
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
		expect(actionRendered).not.toContain("Set as custom-fast");
		expect(actionRendered).not.toContain("Set as SMOL");
		expect(actionRendered).not.toContain("Set as TASK");

		selector.handleInput("\n");
		installTestTheme();
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
		const selector = createSelector(model, settings, (selectedModel, role, thinkingLevel, selectorValue) => {
			selected = { model: selectedModel, role, thinkingLevel, selector: selectorValue };
		});
		await Bun.sleep(0);
		installTestTheme();

		selector.handleInput("\n");
		selector.handleInput("\x1b[B");
		selector.handleInput("\n");

		const selectedAfterEnter = selected;
		if (!selectedAfterEnter) throw new Error("Expected role-agent selection");
		expect(selectedAfterEnter.role).toBe("executor");
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
			(selectedModel, role, thinkingLevel, selectorValue) => {
				selected = { model: selectedModel, role, thinkingLevel, selector: selectorValue };
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
			(selectedModel, role, thinkingLevel, selectedSelector) => {
				selected = { model: selectedModel, role, thinkingLevel, selector: selectedSelector };
			},
			{ modelRegistry, thinkingLevel: ThinkingLevel.Medium },
		);
		await Bun.sleep(0);
		installTestTheme();

		selector.handleInput("\t");
		selector.handleInput("\n");
		selector.handleInput("\x1b[B");
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
});
