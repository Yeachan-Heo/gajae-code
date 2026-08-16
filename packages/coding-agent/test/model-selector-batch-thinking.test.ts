import { beforeAll, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ThinkingLevel } from "@gajae-code/agent-core";
import { Effort, type Model } from "@gajae-code/ai";
import { type GjcModelAssignmentTargetId, ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { ModelSelectorComponent } from "@gajae-code/coding-agent/modes/components/model-selector";
import { getThemeByName, setThemeInstance } from "@gajae-code/coding-agent/modes/theme/theme";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import type { TUI } from "@gajae-code/tui";
import { hookFetch } from "@gajae-code/utils";

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
	knownModels: readonly Model[] = [model],
	scopedModels: ReadonlyArray<{ model: Model; thinkingLevel?: ThinkingLevel }> = [
		{ model, thinkingLevel: ThinkingLevel.Off },
	],
): ModelSelectorComponent {
	const modelRegistry = {
		getAll: () => knownModels,
		refresh: async () => {},
		getAvailable: () => knownModels,
		getError: () => undefined,
		onCatalogChanged: () => () => {},
		hasConfiguredProviderAuth: () => false,
		getDiscoverableProviders: () => [],
		getCanonicalModels: () => [],
		getCanonicalModelSelections: () => [],
		resolveCanonicalModel: () => undefined,
	} as unknown as ModelRegistry;
	const ui = { requestRender: vi.fn() } as unknown as TUI;
	return new ModelSelectorComponent(
		ui,
		model,
		settings,
		modelRegistry,
		scopedModels,
		selection => onSelect(selection as TestModelSelectorSelection),
		() => {},
		{},
	);
}

/**
 * Reasoning model whose provider alone does NOT force an explicit thinking
 * choice (unlike openai/openai-codex), mirroring Anthropic reasoning models
 * such as claude-fable-5. DEFAULT and role-agent targets both require an
 * explicit choice, so single and batch assignment must surface the
 * reasoning menu.
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

function createXaiGrokReasoningModel(id: "grok-4.5" | "grok-4.6"): Model {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "xai",
		baseUrl: "https://api.x.ai/v1",
		reasoning: true,
		thinking: {
			minLevel: Effort.Low,
			maxLevel: id === "grok-4.6" ? Effort.XHigh : Effort.High,
			mode: "effort",
		},
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 500_000,
		maxTokens: 500_000,
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

// Action menu rows: 0..5 = default/executor/architect/planner/critic/image,
// 6 = "Set for all role agents", 7 = "Set for all targets".
const ALL_ROLE_AGENTS_ROW = 6;
const ALL_TARGETS_ROW = 7;

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

	test("direct xAI Grok default assignment requires an explicit supported effort", async () => {
		installTestTheme();
		const model = createXaiGrokReasoningModel("grok-4.6");
		let selected: SelectionCapture | undefined;
		const selector = createSelector(model, Settings.isolated(), selection => {
			if (selection.kind === "assignment") selected = selection;
		});
		await Bun.sleep(0);
		installTestTheme();

		selectActionRow(selector, 0);

		expect(selected).toBeUndefined();
		const thinkingRendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(thinkingRendered).toContain("Reasoning for Default");
		expect(thinkingRendered).toContain("xhigh");

		// Levels are [off, low, medium, high, xhigh]; pick xhigh.
		for (let i = 0; i < 4; i++) selector.handleInput(DOWN);
		selector.handleInput("\n");

		const selectedAfterEnter = selected;
		if (!selectedAfterEnter) throw new Error("Expected default selection after picking a thinking level");
		expect(selectedAfterEnter.role).toBe("default");
		expect(selectedAfterEnter.thinkingLevel).toBe(ThinkingLevel.XHigh);
		expect(selectedAfterEnter.selector).toBe("xai/grok-4.6");
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
		expect(selectedAfterEnter.roles).toEqual(["default", "executor", "architect", "planner", "critic", "image"]);
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
	test("drops an unsupported inherited thinking level when selecting a plain model", async () => {
		installTestTheme();
		const previousModel = createAnthropicReasoningModel("claude-fable-5");
		const targetModel = {
			...previousModel,
			id: "claude-plain",
			name: "claude-plain",
			reasoning: false,
			thinking: undefined,
		} as Model;
		const settings = Settings.isolated({
			"task.agentModelOverrides": { executor: `${previousModel.provider}/${previousModel.id}:xhigh` },
		});
		let selected: SelectionCapture | undefined;
		const selector = createSelector(
			targetModel,
			settings,
			selection => {
				if (selection.kind === "assignment") selected = selection;
			},
			[targetModel, previousModel],
			[{ model: targetModel }],
		);
		await Bun.sleep(0);
		installTestTheme();

		selectActionRow(selector, 1);
		await Bun.sleep(0);

		const selectedAssignment = selected;
		if (!selectedAssignment) throw new Error("Expected executor assignment selection");
		expect(selectedAssignment.selector).toBe("anthropic/claude-plain");
	});
});

test("updates the rendered catalog when an in-flight registry refresh completes", async () => {
	installTestTheme();
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-model-selector-catalog-"));
	const modelsPath = path.join(tempDir, "models.json");
	const authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	let selector: ModelSelectorComponent | undefined;

	try {
		await Bun.write(
			modelsPath,
			JSON.stringify({
				providers: {
					"catalog-refresh": {
						baseUrl: "https://catalog-refresh.example.com/v1",
						api: "openai-responses",
						discovery: { type: "openai-models-list" },
					},
				},
			}),
		);
		authStorage.setRuntimeApiKey("catalog-refresh", "test-key");
		const response = Promise.withResolvers<Response>();
		using _hook = hookFetch(input => {
			expect(String(input)).toBe("https://catalog-refresh.example.com/v1/models");
			return response.promise;
		});
		const registry = new ModelRegistry(authStorage, modelsPath);

		const ui = { requestRender: vi.fn() } as unknown as TUI;
		selector = new ModelSelectorComponent(
			ui,
			undefined,
			Settings.isolated(),
			registry,
			[],
			() => {},
			() => {},
			{ initialSearchInput: "newly" },
		);
		await Bun.sleep(0);
		installTestTheme();
		const refresh = registry.refresh("online");
		await Bun.sleep(0);
		expect(normalizeRenderedText(selector.render(220).join("\n"))).not.toContain("newly-available-model");

		response.resolve(
			new Response(JSON.stringify({ data: [{ id: "newly-available-model" }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		await refresh;
		await Bun.sleep(0);
		installTestTheme();

		expect(normalizeRenderedText(selector.render(220).join("\n"))).toContain("newly-available-model");
	} finally {
		selector?.dispose();
		authStorage.close();
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});
