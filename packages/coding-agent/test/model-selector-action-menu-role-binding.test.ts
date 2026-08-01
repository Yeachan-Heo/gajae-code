import { beforeAll, describe, expect, test, vi } from "bun:test";
import { ThinkingLevel } from "@gajae-code/agent-core";
import { getBundledModel, type Model } from "@gajae-code/ai";
import type { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { ModelSelectorComponent } from "@gajae-code/coding-agent/modes/components/model-selector";
import { getThemeByName, setThemeInstance } from "@gajae-code/coding-agent/modes/theme/theme";
import type { TUI } from "@gajae-code/tui";

function normalizeRenderedText(text: string): string {
	return text
		.replace(/\x1b\[[0-9;]*m/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

type TestRegistryOptions = {
	getAvailable?: () => Model[];
	refresh?: (mode: "offline") => Promise<void>;
	refreshProvider?: (providerId: string) => Promise<void>;
	getDiscoverableProviders?: () => string[];
	requestRender?: () => void;
};
function createSelector(
	model: Model,
	settings: Settings,
	knownModels: Model[],
	scopedModels: Array<{ model: Model }> = [{ model }],
	registryOptions: TestRegistryOptions = {},
): ModelSelectorComponent {
	const modelRegistry = {
		getAll: () => knownModels,
		getAvailable: registryOptions.getAvailable ?? (() => knownModels),
		getError: () => undefined,
		refresh: registryOptions.refresh ?? (async () => {}),
		refreshProvider: registryOptions.refreshProvider ?? (async () => {}),
		hasConfiguredProviderAuth: () => false,
		getDiscoverableProviders: registryOptions.getDiscoverableProviders ?? (() => []),
		getProviderDiscoveryState: () => undefined,
		getCanonicalModels: () => [],
		resolveCanonicalModel: () => undefined,
	} as unknown as ModelRegistry;
	const ui = { requestRender: vi.fn(registryOptions.requestRender ?? (() => {})) } as unknown as TUI;

	return new ModelSelectorComponent(
		ui,
		model,
		settings,
		modelRegistry,
		scopedModels,
		() => {},
		() => {},
	);
}

let testTheme = await getThemeByName("red-claw");

function installTestTheme(): void {
	if (!testTheme) throw new Error("Failed to load theme for ModelSelector tests");
	setThemeInstance(testTheme);
}

/** Open the assignment menu for the first model and return its normalized rendering. */
async function renderActionMenu(model: Model, settings: Settings, knownModels: Model[]): Promise<string> {
	installTestTheme();
	const selector = createSelector(model, settings, knownModels);
	await Bun.sleep(0);
	installTestTheme();
	selector.handleInput("\n");
	installTestTheme();
	return normalizeRenderedText(selector.render(240).join("\n"));
}

describe("ModelSelector assignment menu role bindings", () => {
	beforeAll(async () => {
		testTheme = await getThemeByName("red-claw");
		if (!testTheme) throw new Error("Failed to load theme for ModelSelector tests");
	});

	test("shows the model each role currently resolves to", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		const executorModel = getBundledModel("anthropic", "claude-haiku-4-5");
		if (!model || !executorModel) throw new Error("Expected bundled anthropic models");

		const settings = Settings.isolated({
			modelRoles: { default: `${model.provider}/${model.id}:low` },
			"task.agentModelOverrides": { executor: `${executorModel.provider}/${executorModel.id}` },
		});

		const rendered = await renderActionMenu(model, settings, [model, executorModel]);

		expect(rendered).toContain(`Set as DEFAULT (Default) — now: ${model.provider}/${model.id} (low)`);
		expect(rendered).toContain(`Set as EXECUTOR (Executor) — now: ${executorModel.provider}/${executorModel.id}`);
		expect(rendered).toContain("Set as ARCHITECT (Architect) — now: inherits default");
	});

	test("distinguishes unset, inherited, and unresolvable role bindings", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model anthropic/claude-sonnet-4-5");

		const settings = Settings.isolated({
			"task.agentModelOverrides": {
				planner: "retired-provider/retired-model",
				critic: "default",
			},
		});

		const rendered = await renderActionMenu(model, settings, [model]);

		expect(rendered).toContain("Set as DEFAULT (Default) — now: unset");
		expect(rendered).toContain("Set as PLANNER (Planner) — now: retired-provider/retired-model (unavailable)");
		expect(rendered).toContain("Set as CRITIC (Critic) — now: default (unavailable)");
	});

	test("reports the effective default when an active profile supplies it", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model anthropic/claude-sonnet-4-5");

		const selector = createSelector(model, Settings.isolated({}), [model]);
		await Bun.sleep(0);
		installTestTheme();
		selector.handleInput("\n");
		selector.refreshRoleAssignments({
			currentModel: model,
			currentThinkingLevel: ThinkingLevel.High,
			activeModelProfile: "profile-a",
		});
		installTestTheme();
		const rendered = normalizeRenderedText(selector.render(240).join("\n"));

		expect(rendered).toContain(`Set as DEFAULT (Default) — now: ${model.provider}/${model.id} (high)`);
	});

	test("restores the last-good view and shows role-refresh failures", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model anthropic/claude-sonnet-4-5");
		const replacement = { ...model, id: "replacement", name: "replacement" };
		const catalog: Model[] = [model];
		let failProviderTabs = false;

		const selector = createSelector(
			model,
			Settings.isolated({ modelRoles: { default: `${model.provider}/${model.id}` } }),
			catalog,
			[],
			{
				getDiscoverableProviders: () => {
					if (failProviderTabs) {
						failProviderTabs = false;
						throw new Error("role refresh presentation failed");
					}
					return [model.provider];
				},
			},
		);
		await Bun.sleep(0);
		catalog.splice(0, 1, replacement);
		failProviderTabs = true;
		selector.refreshRoleAssignments();
		installTestTheme();
		const rendered = normalizeRenderedText(selector.render(240).join("\n"));

		expect(rendered).toContain("claude-sonnet-4-5");
		expect(rendered).toContain("role refresh presentation failed");
		expect(rendered).not.toContain("replacement");
	});

	test("reports inheritance aliases as inherited even when the default resolves", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model anthropic/claude-sonnet-4-5");

		const settings = Settings.isolated({
			modelRoles: { default: `${model.provider}/${model.id}` },
			"task.agentModelOverrides": {
				critic: "pi/default",
				planner: "pi/default:high",
			},
		});

		const rendered = await renderActionMenu(model, settings, [model]);

		// The alias resolves to the default's model; the menu must still report the
		// relationship instead of a concrete id that hides the inheritance.
		expect(rendered).toContain("Set as CRITIC (Critic) — now: inherits default");
		expect(rendered).toContain("Set as PLANNER (Planner) — now: inherits default (high)");
		expect(rendered).toContain(`Set as DEFAULT (Default) — now: ${model.provider}/${model.id}`);
	});

	test("treats a literal default model id as a model, not an inheritance alias", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model anthropic/claude-sonnet-4-5");
		const literalDefault = { ...model, id: "default", name: "default" };

		const settings = Settings.isolated({
			modelRoles: { default: `${model.provider}/${model.id}` },
			"task.agentModelOverrides": { critic: "default" },
		});

		const rendered = await renderActionMenu(model, settings, [model, literalDefault]);

		expect(rendered).toContain(`Set as CRITIC (Critic) — now: ${literalDefault.provider}/${literalDefault.id}`);
		expect(rendered).not.toContain("Set as CRITIC (Critic) — now: inherits default");
	});

	test("resolves an alias-headed fallback chain to its effective entry", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		const tailModel = getBundledModel("anthropic", "claude-haiku-4-5");
		if (!model || !tailModel) throw new Error("Expected bundled anthropic models");

		const settings = Settings.isolated({
			modelRoles: { default: "retired-provider/retired-model" },
			"task.agentModelOverrides": {
				executor: ["pi/default", `${tailModel.provider}/${tailModel.id}`],
			},
		});

		const rendered = await renderActionMenu(model, settings, [model, tailModel]);

		// The chain is only headed by the alias: an unresolvable default advances
		// resolution to the tail, so claiming inheritance would be a lie.
		expect(rendered).toContain(`Set as EXECUTOR (Executor) — now: ${tailModel.provider}/${tailModel.id}`);
		expect(rendered).not.toContain("Set as EXECUTOR (Executor) — now: inherits default");
		expect(rendered).toContain("Set as DEFAULT (Default) — now: retired-provider/retired-model (unavailable)");
	});

	test("re-resolves role bindings once the model catalog finishes loading", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		const lateModel = getBundledModel("anthropic", "claude-haiku-4-5");
		if (!model || !lateModel) throw new Error("Expected bundled anthropic models");

		const settings = Settings.isolated({
			modelRoles: { default: `${model.provider}/${model.id}` },
			"task.agentModelOverrides": { executor: `${lateModel.provider}/${lateModel.id}` },
		});

		installTestTheme();
		const catalog: Model[] = [model];
		const selector = createSelector(model, settings, catalog, []);
		// The provider's models land while the selector is still loading its catalog.
		catalog.push(lateModel);
		await Bun.sleep(0);
		installTestTheme();
		selector.handleInput("\n");
		installTestTheme();
		const rendered = normalizeRenderedText(selector.render(240).join("\n"));

		expect(rendered).toContain(`Set as EXECUTOR (Executor) — now: ${lateModel.provider}/${lateModel.id}`);
		expect(rendered).not.toContain(
			`Set as EXECUTOR (Executor) — now: ${lateModel.provider}/${lateModel.id} (unavailable)`,
		);

		catalog.splice(1, 1);
		selector.refreshRoleAssignments();
		installTestTheme();
		const refreshed = normalizeRenderedText(selector.render(240).join("\n"));

		expect(refreshed).toContain(
			`Set as EXECUTOR (Executor) — now: ${lateModel.provider}/${lateModel.id} (unavailable)`,
		);
	});

	test("materializes a replacement catalog after provider refresh failure", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model anthropic/claude-sonnet-4-5");
		const replacement = { ...model, id: "replacement", name: "replacement" };
		const catalog: Model[] = [model];

		const selector = createSelector(
			model,
			Settings.isolated({ modelRoles: { default: `${model.provider}/${model.id}` } }),
			catalog,
			[],
			{
				getDiscoverableProviders: () => [model.provider],
				refreshProvider: async () => {
					catalog.splice(0, 1, replacement);
					throw new Error("provider refresh failed");
				},
			},
		);
		await Bun.sleep(0);
		installTestTheme();

		selector.handleInput("\t");
		selector.handleInput("\t");
		await Bun.sleep(0);
		installTestTheme();
		const rendered = normalizeRenderedText(selector.render(240).join("\n"));

		expect(rendered).toContain("replacement");
		expect(rendered).toContain("provider refresh failed");
		expect(rendered).not.toContain("claude-sonnet-4-5");
	});

	test("keeps the last good catalog when provider refresh succeeds but catalog loading fails", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model anthropic/claude-sonnet-4-5");
		const replacement = { ...model, id: "replacement", name: "replacement" };
		const catalog: Model[] = [model];
		let catalogReadFailed = false;
		let catalogReadAttempts = 0;

		const selector = createSelector(
			model,
			Settings.isolated({ modelRoles: { default: `${model.provider}/${model.id}` } }),
			catalog,
			[],
			{
				getAvailable: () => {
					catalogReadAttempts++;
					if (catalogReadFailed) throw new Error(`catalog read failed #${catalogReadAttempts}`);
					return catalog;
				},
				getDiscoverableProviders: () => [model.provider],
				refreshProvider: async () => {
					catalog.splice(0, 1, replacement);
					catalogReadFailed = true;
				},
			},
		);
		await Bun.sleep(0);
		installTestTheme();

		selector.handleInput("\t");
		selector.handleInput("\t");
		await Bun.sleep(0);
		installTestTheme();
		const rendered = normalizeRenderedText(selector.render(240).join("\n"));

		expect(rendered).toContain("claude-sonnet-4-5");
		expect(rendered).toContain("catalog read failed #2");
		expect(rendered).not.toContain("replacement");
		expect(catalogReadAttempts).toBe(2);
	});

	test("rolls back the catalog when presentation fails after provider refresh", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model anthropic/claude-sonnet-4-5");
		const replacement = { ...model, id: "replacement", name: "replacement" };
		const catalog: Model[] = [model];
		let failNextRender = false;

		const selector = createSelector(
			model,
			Settings.isolated({ modelRoles: { default: `${model.provider}/${model.id}` } }),
			catalog,
			[],
			{
				getDiscoverableProviders: () => [model.provider],
				refreshProvider: async () => {
					catalog.splice(0, 1, replacement);
					failNextRender = true;
				},
				requestRender: () => {
					if (failNextRender) {
						failNextRender = false;
						throw new Error("presentation failed");
					}
				},
			},
		);
		await Bun.sleep(0);
		installTestTheme();

		selector.handleInput("\t");
		selector.handleInput("\t");
		await Bun.sleep(0);
		installTestTheme();
		const rendered = normalizeRenderedText(selector.render(240).join("\n"));

		expect(rendered).toContain("claude-sonnet-4-5");
		expect(rendered).toContain("presentation failed");
		expect(rendered).not.toContain("replacement");
	});

	test("keeps the last good catalog when offline refresh fails", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model anthropic/claude-sonnet-4-5");
		const replacement = { ...model, id: "replacement", name: "replacement" };
		const catalog: Model[] = [model];
		let refreshCalls = 0;
		const selector = createSelector(
			model,
			Settings.isolated({ modelRoles: { default: `${model.provider}/${model.id}` } }),
			catalog,
			[],
			{
				refresh: async () => {
					refreshCalls++;
					if (refreshCalls > 1) throw new Error("offline refresh failed");
				},
				getDiscoverableProviders: () => [model.provider],
				refreshProvider: async () => {
					catalog.splice(0, 1, replacement);
				},
			},
		);
		await Bun.sleep(0);
		installTestTheme();

		selector.handleInput("\t");
		selector.handleInput("\t");
		await Bun.sleep(0);
		installTestTheme();
		const rendered = normalizeRenderedText(selector.render(240).join("\n"));

		expect(rendered).toContain("claude-sonnet-4-5");
		expect(rendered).toContain("offline refresh failed");
		expect(rendered).not.toContain("replacement");
	});

	test("keeps the last good catalog when rejected refresh recovery cannot read models", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model anthropic/claude-sonnet-4-5");
		const replacement = { ...model, id: "replacement", name: "replacement" };
		const catalog: Model[] = [model];
		let catalogReadFailed = false;
		let catalogReadAttempts = 0;

		const selector = createSelector(
			model,
			Settings.isolated({ modelRoles: { default: `${model.provider}/${model.id}` } }),
			catalog,
			[],
			{
				getAvailable: () => {
					catalogReadAttempts++;
					if (catalogReadFailed) throw new Error(`catalog read failed #${catalogReadAttempts}`);
					return catalog;
				},
				getDiscoverableProviders: () => [model.provider],
				refreshProvider: async () => {
					catalog.splice(0, 1, replacement);
					catalogReadFailed = true;
					throw new Error("provider refresh failed");
				},
			},
		);
		await Bun.sleep(0);
		installTestTheme();

		selector.handleInput("\t");
		selector.handleInput("\t");
		await Bun.sleep(0);
		installTestTheme();
		const rendered = normalizeRenderedText(selector.render(240).join("\n"));

		expect(rendered).toContain("claude-sonnet-4-5");
		expect(rendered).toContain("provider refresh failed");
		expect(rendered).toContain("catalog recovery failed: catalog read failed #2");
		expect(catalogReadAttempts).toBe(2);
		expect(rendered).not.toContain("replacement");
	});

	test("bounds and sanitizes an unresolvable selector before rendering it", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model anthropic/claude-sonnet-4-5");

		const hostile = `\x1b[31mred\x1b]0;title\x07/gone\nsecond-line-${"x".repeat(80)}`;
		const settings = Settings.isolated({
			modelRoles: { default: `${model.provider}/${model.id}` },
			"task.agentModelOverrides": { architect: hostile },
		});

		installTestTheme();
		const selector = createSelector(model, settings, [model]);
		await Bun.sleep(0);
		installTestTheme();
		selector.handleInput("\n");
		installTestTheme();
		const frame = selector.render(240).join("\n");
		const architectRow = frame.split("\n").find(line => line.includes("Set as ARCHITECT"));
		if (!architectRow) throw new Error("Expected an architect row in the assignment menu");

		expect(architectRow).toContain("(unavailable)");
		// No OSC title write and no raw SGR from the selector value survive into the row.
		expect(architectRow).not.toContain("\x1b]0;");
		expect(architectRow).not.toContain("\x1b[31m");
		// Bounded: the echoed selector cannot grow the row without limit.
		expect(normalizeRenderedText(architectRow).length).toBeLessThan(120);
	});

	test("bounds and sanitizes resolved model metadata before rendering it", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model anthropic/claude-sonnet-4-5");

		const hostileProvider = "evil\x1b]0;provider-title\x07";
		const hostileId = `model\nsecond-line-${"x".repeat(80)}`;
		const hostileModel = { ...model, provider: hostileProvider, id: hostileId, name: hostileId };
		const settings = Settings.isolated({
			modelRoles: { default: `${hostileModel.provider}/${hostileModel.id}` },
		});

		installTestTheme();
		const selector = createSelector(model, settings, [model, hostileModel]);
		await Bun.sleep(0);
		installTestTheme();
		selector.handleInput("\n");
		installTestTheme();
		const frame = selector.render(240).join("\n");
		const defaultRow = frame.split("\n").find(line => line.includes("Set as DEFAULT"));
		if (!defaultRow) throw new Error("Expected a default row in the assignment menu");

		expect(defaultRow).not.toContain("\x1b]0;");
		expect(defaultRow).not.toContain("(unavailable)");
		expect(normalizeRenderedText(defaultRow)).toContain("evil/model second-line-");
		expect(normalizeRenderedText(defaultRow).length).toBeLessThan(120);
	});
});
