import { beforeAll, describe, expect, test, vi } from "bun:test";
import { ThinkingLevel } from "@gajae-code/agent-core";
import { Effort, type Model } from "@gajae-code/ai";
import type { GjcModelAssignmentTargetId, ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { ModelSelectorComponent } from "@gajae-code/coding-agent/modes/components/model-selector";
import { getThemeByName, setThemeInstance } from "@gajae-code/coding-agent/modes/theme/theme";
import type { TUI } from "@gajae-code/tui";

const DOWN = "\x1b[B";

function normalizeRenderedText(text: string): string {
	return text
		.replace(/\x1b\[[0-9;]*m/g, "")
		.replace(/\s+/g, " ")
		.trim();
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

function createSelector(
	model: Model,
	settings: Settings,
	onSelect: (selection: TestModelSelectorSelection) => void,
): ModelSelectorComponent {
	const modelRegistry = {
		getAll: () => [model],
		getDiscoverableProviders: () => [],
		getCanonicalModels: () => [],
		resolveCanonicalModel: () => undefined,
	} as unknown as ModelRegistry;
	const ui = { requestRender: vi.fn() } as unknown as TUI;
	return new ModelSelectorComponent(
		ui,
		model,
		settings,
		modelRegistry,
		[{ model, thinkingLevel: ThinkingLevel.Off }],
		selection => onSelect(selection as TestModelSelectorSelection),
		() => {},
		{},
	);
}

/**
 * Reasoning model whose provider alone does NOT force an explicit thinking
 * choice for the DEFAULT target (unlike openai/openai-codex), mirroring
 * Anthropic reasoning models such as claude-fable-5. Role-agent targets
 * (task.agentModelOverrides) still require an explicit choice, so batch
 * assignment must surface the reasoning menu.
 */
function createAnthropicReasoningModel(id: string): Model {
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		thinking: {
			minLevel: Effort.Low,
			maxLevel: Effort.XHigh,
			mode: "anthropic-adaptive",
		},
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 64000,
	} as Model;
}

function createCodexReasoningModel(id: string): Model {
	return {
		id,
		name: id,
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		thinking: {
			minLevel: Effort.Low,
			maxLevel: Effort.XHigh,
			mode: "effort",
		},
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272_000,
		maxTokens: 128000,
	} as Model;
}

let testTheme = await getThemeByName("red-claw");

function installTestTheme(): void {
	if (!testTheme) throw new Error("Failed to load test theme");
	setThemeInstance(testTheme);
}

/** Enter the action menu and move the cursor onto the requested action row. */
function selectActionRow(selector: ModelSelectorComponent, rowIndex: number): void {
	selector.handleInput("\n");
	for (let i = 0; i < rowIndex; i++) selector.handleInput(DOWN);
	selector.handleInput("\n");
}

// Action menu rows: 0..4 = default/executor/architect/planner/critic,
// 5 = "Set for all role agents", 6 = "Set for all targets".
const ALL_ROLE_AGENTS_ROW = 5;
const ALL_TARGETS_ROW = 6;

describe("ModelSelector batch assignment thinking menu", () => {
	beforeAll(async () => {
		testTheme = await getThemeByName("red-claw");
		installTestTheme();
	});

	test("all role agents batch opens the reasoning menu for anthropic reasoning models", async () => {
		installTestTheme();
		const model = createAnthropicReasoningModel("claude-fable-5");
		const settings = Settings.isolated();

		let selected: SelectionCapture | undefined;
		const selector = createSelector(model, settings, selection => {
			if (selection.kind === "assignment") selected = selection;
		});
		await Bun.sleep(0);
		installTestTheme();

		selectActionRow(selector, ALL_ROLE_AGENTS_ROW);

		// The batch includes role-agent targets, so an explicit effort choice is required.
		expect(selected).toBeUndefined();
		const thinkingRendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(thinkingRendered).toContain("Reasoning for all role agents");

		// Levels are [off, low, medium, high, xhigh]; pick xhigh.
		for (let i = 0; i < 4; i++) selector.handleInput(DOWN);
		selector.handleInput("\n");

		const selectedAfterEnter = selected;
		if (!selectedAfterEnter) throw new Error("Expected batch selection after picking a thinking level");
		expect(selectedAfterEnter.role).toBe("default");
		expect(selectedAfterEnter.roles).toEqual(["executor", "architect", "planner", "critic"]);
		expect(selectedAfterEnter.thinkingLevel).toBe(ThinkingLevel.XHigh);
		expect(selectedAfterEnter.selector).toBe("anthropic/claude-fable-5:xhigh");
	});

	test("all targets batch keeps every target through the reasoning menu", async () => {
		installTestTheme();
		const model = createCodexReasoningModel("gpt-5.5");
		const settings = Settings.isolated();

		let selected: SelectionCapture | undefined;
		const selector = createSelector(model, settings, selection => {
			if (selection.kind === "assignment") selected = selection;
		});
		await Bun.sleep(0);
		installTestTheme();

		selectActionRow(selector, ALL_TARGETS_ROW);

		expect(selected).toBeUndefined();
		const thinkingRendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(thinkingRendered).toContain("Reasoning for all targets");

		// Pick "high" (levels are [off, low, medium, high, xhigh]).
		for (let i = 0; i < 3; i++) selector.handleInput(DOWN);
		selector.handleInput("\n");

		const selectedAfterEnter = selected;
		if (!selectedAfterEnter) throw new Error("Expected batch selection after picking a thinking level");
		expect(selectedAfterEnter.role).toBe("default");
		expect(selectedAfterEnter.roles).toEqual(["default", "executor", "architect", "planner", "critic"]);
		expect(selectedAfterEnter.thinkingLevel).toBe(ThinkingLevel.High);
		expect(selectedAfterEnter.selector).toBe("openai-codex/gpt-5.5:high");
	});

	test("cancelling the batch reasoning menu restores the batch action row", async () => {
		installTestTheme();
		const model = createAnthropicReasoningModel("claude-fable-5");
		const settings = Settings.isolated();

		let selected: SelectionCapture | undefined;
		const selector = createSelector(model, settings, selection => {
			if (selection.kind === "assignment") selected = selection;
		});
		await Bun.sleep(0);
		installTestTheme();

		selectActionRow(selector, ALL_TARGETS_ROW);
		expect(normalizeRenderedText(selector.render(220).join("\n"))).toContain("Reasoning for all targets");

		// Escape back to the action menu; no selection must have been emitted.
		selector.handleInput("\x1b");
		expect(selected).toBeUndefined();
		const actionRendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(actionRendered).toContain("Action for:");
		expect(actionRendered).toContain("Set for all targets");
	});
});
