import { beforeAll, describe, expect, test, vi } from "bun:test";
import { Effort, type Model } from "@gajae-code/ai";
import { BUILTIN_MODEL_PROFILES, type ModelProfileDefinition } from "@gajae-code/coding-agent/config/model-profiles";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import {
	ModelSelectorComponent,
	type ModelSelectorSelection,
} from "@gajae-code/coding-agent/modes/components/model-selector";
import { getThemeByName, setThemeInstance } from "@gajae-code/coding-agent/modes/theme/theme";
import type { TUI } from "@gajae-code/tui";

function normalizeRenderedText(text: string): string {
	return text
		.replace(/\x1b\[[0-9;]*m/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

const model = (provider: string, id: string, minLevel = Effort.Low): Model =>
	({
		provider,
		id,
		name: id,
		api: "openai-responses",
		contextWindow: 1000,
		maxTokens: 1000,
		thinking: { minLevel, maxLevel: Effort.XHigh, mode: "effort" },
	}) as Model;

const codexModel = model("openai-codex", "gpt-5.5", Effort.Low);
const anthropicModel = model("anthropic", "claude-opus-4-8");
const minimaxModel = model("minimax-code", "minimax-v3");
const noSuffixModel = model("provider-a", "default");

const builtinCodexModels = [
	model("openai-codex", "gpt-5.6-terra", Effort.Low),
	model("openai-codex", "gpt-5.6-luna", Effort.Low),
	model("openai-codex", "gpt-5.6-sol", Effort.Low),
];
const builtinComboModels = [
	model("anthropic", "claude-opus-4-8", Effort.Low),
	model("anthropic", "claude-fable-5", Effort.Low),
	model("anthropic", "claude-sonnet-5"),
	model("opencode-go", "deepseek-v4-pro"),
	model("opencode-go", "kimi-k2.6"),
	model("opencode-go", "mimo-v2.5-pro"),
];

function builtinProfile(name: string): ModelProfileDefinition {
	const profile = BUILTIN_MODEL_PROFILES.find(candidate => candidate.name === name);
	if (!profile) throw new Error(`Missing built-in profile: ${name}`);
	return profile;
}
const codexEco: ModelProfileDefinition = {
	name: "codex-eco",
	requiredProviders: ["openai-codex"],
	modelMapping: {
		default: "openai-codex/gpt-5.5:low",
		executor: "openai-codex/gpt-5.5:minimal",
		planner: "openai-codex/gpt-5.5:low",
	},
	source: "builtin",
};
const combo: ModelProfileDefinition = {
	name: "opus-codex",
	requiredProviders: ["anthropic", "openai-codex"],
	modelMapping: { default: "anthropic/claude-opus-4-8:xhigh", executor: "openai-codex/gpt-5.5:low" },
	source: "builtin",
};
const comboOpencode: ModelProfileDefinition = {
	name: "codex-opencodego",
	requiredProviders: ["openai-codex", "opencode-go"],
	modelMapping: { default: "opencode-go/kimi-k2.6", executor: "openai-codex/gpt-5.5:low" },
	source: "builtin",
};
const minimax: ModelProfileDefinition = {
	name: "minimax-medium",
	requiredProviders: ["minimax-code"],
	modelMapping: { default: "minimax-code/minimax-v3:medium" },
	source: "builtin",
};
const noSuffixProfile: ModelProfileDefinition = {
	name: "profile-no-suffix",
	requiredProviders: ["provider-a"],
	modelMapping: { default: "provider-a/default" },
	source: "user",
};
const codexMedium: ModelProfileDefinition = {
	name: "codex-medium",
	requiredProviders: ["openai-codex"],
	modelMapping: { default: "openai-codex/gpt-5.5:medium" },
	source: "builtin",
};
const codexPro: ModelProfileDefinition = {
	name: "codex-pro",
	requiredProviders: ["openai-codex"],
	modelMapping: { default: "openai-codex/gpt-5.5:high" },
	source: "builtin",
};

let testTheme = await getThemeByName("red-claw");
function installTestTheme(): void {
	if (!testTheme) throw new Error("Failed to load test theme");
	setThemeInstance(testTheme);
}

function createRegistry(
	authenticatedProviders: readonly string[],
	profiles: ModelProfileDefinition[] = [codexEco, combo, minimax, noSuffixProfile],
) {
	const profileMap = new Map(profiles.map(profile => [profile.name, profile]));
	return {
		refresh: vi.fn(async () => {}),
		getError: () => undefined,
		getAvailable: () => [
			codexModel,
			anthropicModel,
			minimaxModel,
			noSuffixModel,
			...builtinCodexModels,
			...builtinComboModels,
		],
		getAll: () => [
			codexModel,
			anthropicModel,
			minimaxModel,
			noSuffixModel,
			...builtinCodexModels,
			...builtinComboModels,
		],
		getDiscoverableProviders: () => [],
		getCanonicalModels: () => [],
		resolveCanonicalModel: () => undefined,
		getModelProfiles: () => new Map(profileMap),
		getModelProfile: (name: string) => profileMap.get(name),
		getAvailableModelProfileNames: () => [...profileMap.keys()],
		getApiKeyForProvider: async (provider: string) => (authenticatedProviders.includes(provider) ? "key" : undefined),
		getApiKey: async () => "key",
	};
}

function createSelector(
	options: {
		authenticatedProviders?: readonly string[];
		temporaryOnly?: boolean;
		initialSearchInput?: string;
		scopedModels?: Array<{ model: Model }>;
		onCancel?: () => void;
		onSelect?: (selection: ModelSelectorSelection) => void | Promise<void>;
		profiles?: ModelProfileDefinition[];
	} = {},
) {
	const ui = { requestRender: vi.fn() } as unknown as TUI;
	return new ModelSelectorComponent(
		ui,
		undefined,
		Settings.isolated(),
		createRegistry(
			options.authenticatedProviders ?? ["openai-codex", "anthropic", "minimax-code", "provider-a"],
			options.profiles,
		) as never,
		options.scopedModels ?? [],
		options.onSelect ?? (() => {}),
		options.onCancel ?? (() => {}),
		{ temporaryOnly: options.temporaryOnly, initialSearchInput: options.initialSearchInput },
	);
}

async function rendered(selector: ModelSelectorComponent): Promise<string> {
	await Bun.sleep(10);
	installTestTheme();
	return normalizeRenderedText(selector.render(260).join("\n"));
}

// Returns the label of the row the navigation cursor (❯) currently sits on,
// with ANSI/whitespace normalized. Used to assert exact cursor placement after
// preset list navigation.
function cursorRowLabel(selector: ModelSelectorComponent): string | undefined {
	installTestTheme();
	const lines = selector.render(260).map(line => line.replace(/\x1b\[[0-9;]*m/g, ""));
	const cursorLine = lines.find(line => line.includes("❯"));
	return cursorLine?.replace("❯", "").replace(/\s+/g, " ").trim();
}

describe("preset landing adversarial QA", () => {
	beforeAll(async () => {
		testTheme = await getThemeByName("red-claw");
		installTestTheme();
	});

	test("Escape closes exactly one preset layer in order", async () => {
		const cancel = vi.fn();
		const selector = createSelector({ onCancel: cancel });
		await rendered(selector);
		selector.handleInput("\x1b[C");
		selector.handleInput("\x1b[B");
		selector.handleInput("\n"); // preview first expanded profile
		selector.handleInput("\n"); // scope menu
		expect(normalizeRenderedText(selector.render(260).join("\n"))).toContain("Apply for this session");

		selector.handleInput("\x1b");
		let text = normalizeRenderedText(selector.render(260).join("\n"));
		expect(text).not.toContain("Apply for this session");
		expect(text).toContain("Preset preview: Codex Eco");

		selector.handleInput("\x1b");
		text = normalizeRenderedText(selector.render(260).join("\n"));
		expect(text).not.toContain("Preset preview:");
		expect(text).toContain("Codex Eco");

		selector.handleInput("\x1b");
		text = normalizeRenderedText(selector.render(260).join("\n"));
		expect(text).not.toContain("codex-eco");
		expect(text).toContain("CODEX");

		selector.handleInput("\x1b");
		expect(cancel).toHaveBeenCalledTimes(1);
	});

	test("printable input exits preview/scope menu into seeded model search", async () => {
		const selector = createSelector();
		await rendered(selector);
		selector.handleInput("\x1b[C");
		selector.handleInput("\x1b[B");
		selector.handleInput("\n");
		selector.handleInput("\n");
		selector.handleInput("g");
		const text = normalizeRenderedText(selector.render(260).join("\n"));
		expect(text).toContain("Models");
		expect(text).toContain("gpt-5.5");
		expect(text).not.toContain("Preset preview:");
		expect(text).not.toContain("Apply for this session");
	});

	test("up/down wraps at landing boundaries and Browse all preserves model role menu", async () => {
		const selector = createSelector();
		await rendered(selector);
		selector.handleInput("\x1b[A");
		let text = normalizeRenderedText(selector.render(260).join("\n"));
		expect(text).toContain("Browse all models");
		selector.handleInput("\x1b[B");
		text = normalizeRenderedText(selector.render(260).join("\n"));
		expect(text).toContain("CODEX");
		selector.handleInput("\x1b[A");
		selector.handleInput("\n");
		selector.handleInput("\n");
		text = normalizeRenderedText(selector.render(260).join("\n"));
		expect(text).toContain("Action for:");
		expect(text).toContain("Set as DEFAULT");
		expect(text).toContain("Set as EXECUTOR");
	});

	test("temporaryOnly, initialSearchInput, and scoped models bypass preset landing", async () => {
		expect(await rendered(createSelector({ temporaryOnly: true }))).not.toContain("Model presets");
		const initial = await rendered(createSelector({ initialSearchInput: "claude" }));
		expect(initial).not.toContain("Model presets");
		expect(initial).toContain("Models");
		const scoped = await rendered(createSelector({ scopedModels: [{ model: codexModel }] }));
		expect(scoped).not.toContain("Model presets");
		expect(scoped).toContain("Showing models from --models scope");
	});

	test("partial combo auth blocks selection and MiniMax hint uses canonical provider id only", async () => {
		const selections: ModelSelectorSelection[] = [];
		const comboSelector = createSelector({
			authenticatedProviders: ["openai-codex"],
			onSelect: selection => {
				selections.push(selection);
			},
		});
		await rendered(comboSelector);
		comboSelector.handleInput("\x1b[C"); // expand CODEX so COMBOS is visible
		comboSelector.handleInput("\x1b[B"); // codex-eco profile
		comboSelector.handleInput("\x1b[B"); // MINIMAX group
		comboSelector.handleInput("\x1b[B"); // COMBOS group
		comboSelector.handleInput("\n");
		let text = normalizeRenderedText(comboSelector.render(260).join("\n"));
		expect(text).toContain("✗ COMBOS");
		expect(text).toContain("anthropic");
		expect(selections).toEqual([]);

		const miniSelector = createSelector({ authenticatedProviders: ["openai-codex", "anthropic", "provider-a"] });
		await rendered(miniSelector);
		miniSelector.handleInput("\x1b[B");
		miniSelector.handleInput("\n");
		text = normalizeRenderedText(miniSelector.render(260).join("\n"));
		expect(text).toContain("/login minimax-code");
		expect(text).not.toContain("minimax/");
		expect(text).not.toContain("/login minimax ");
	});

	test("COMBOS group stays available when at least one combo is usable", async () => {
		// Regression: a group is a list of alternative presets, not an all-or-nothing
		// bundle. With codex + opencode-go authenticated, codex-opencodego is fully
		// usable, so the COMBOS group must render as available (✓) even though the
		// sibling opus-codex preset is missing its anthropic credential.
		const selector = createSelector({
			authenticatedProviders: ["openai-codex", "opencode-go"],
			profiles: [codexEco, combo, comboOpencode],
		});
		const text = await rendered(selector);
		expect(text).toContain("✓ COMBOS");
		expect(text).not.toContain("✗ COMBOS");
	});

	test("preview clamps codex eco executor to low and omits suffix for suffixless selector", async () => {
		const selector = createSelector();
		await rendered(selector);
		selector.handleInput("\x1b[C");
		selector.handleInput("\x1b[B");
		selector.handleInput("\n");
		let text = normalizeRenderedText(selector.render(260).join("\n"));
		expect(text).toContain("EXECUTOR: openai-codex/gpt-5.5");
		expect(text).not.toContain("EXECUTOR: openai-codex/gpt-5.5:minimal");

		const suffixless = createSelector({ profiles: [noSuffixProfile] });
		await rendered(suffixless);
		suffixless.handleInput("\x1b[C");
		suffixless.handleInput("\x1b[B");
		suffixless.handleInput("\n");
		text = normalizeRenderedText(suffixless.render(260).join("\n"));
		expect(text).toContain("DEFAULT: provider-a/default");
		expect(text).not.toContain("DEFAULT: provider-a/default:");
	});

	test("built-in Codex Eco preview preserves the Terra and Luna role models", async () => {
		const selector = createSelector({ profiles: [builtinProfile("codex-eco")] });
		await rendered(selector);
		selector.refreshPresetProfiles("codex-eco");

		const text = await rendered(selector);
		expect(text).toContain("DEFAULT: openai-codex/gpt-5.6-terra");
		expect(text).toContain("EXECUTOR: openai-codex/gpt-5.6-luna");
		expect(text).toContain("PLANNER: openai-codex/gpt-5.6-luna");
		expect(text).toContain("CRITIC: openai-codex/gpt-5.6-terra");
		expect(text).toContain("ARCHITECT: openai-codex/gpt-5.6-terra");
		expect(text).not.toContain("gpt-5.6-sol");
	});

	test("built-in Codex + OpenCodeGo preview preserves provider role models", async () => {
		const selector = createSelector({
			authenticatedProviders: ["openai-codex", "opencode-go"],
			profiles: [builtinProfile("codex-opencodego")],
		});
		await rendered(selector);
		selector.refreshPresetProfiles("codex-opencodego");

		const text = await rendered(selector);
		expect(text).toContain("DEFAULT: openai-codex/gpt-5.6-sol");
		expect(text).toContain("EXECUTOR: opencode-go/deepseek-v4-pro");
		expect(text).toContain("PLANNER: opencode-go/kimi-k2.6");
		expect(text).toContain("CRITIC: opencode-go/mimo-v2.5-pro");
		expect(text).toContain("ARCHITECT: openai-codex/gpt-5.6-sol");
	});

	test("#688 Down crossing a group boundary lands on the destination group header", async () => {
		// Regression: pressing Down off the last profile of the expanded group used
		// to clamp the cursor by numeric index after the source group collapsed,
		// overshooting past the destination group header onto its first profile.
		const selector = createSelector();
		await rendered(selector);
		selector.handleInput("\x1b[C"); // expand CODEX explicitly
		selector.handleInput("\x1b[B"); // CODEX header -> Codex Eco profile
		selector.handleInput("\x1b[B"); // cross boundary into MINIMAX group
		const label = cursorRowLabel(selector);
		expect(label).toContain("MINIMAX");
		expect(label).not.toContain("MiniMax Medium");
	});

	test("#688 Down from a multi-profile group does not skip the destination header onto Browse", async () => {
		// With several profiles in the source group, the old numeric clamp could
		// overshoot the destination group entirely (header + only profile) and land
		// on the trailing Browse row.
		const selector = createSelector({ profiles: [codexEco, codexMedium, codexPro, minimax] });
		await rendered(selector);
		selector.handleInput("\x1b[C"); // expand CODEX explicitly
		selector.handleInput("\x1b[B"); // Codex Eco
		selector.handleInput("\x1b[B"); // Codex Medium
		selector.handleInput("\x1b[B"); // Codex Pro (last profile of CODEX)
		selector.handleInput("\x1b[B"); // cross boundary into MINIMAX group
		const headerLabel = cursorRowLabel(selector);
		expect(headerLabel).toContain("MINIMAX");
		expect(headerLabel).not.toContain("Browse all models");
		expect(headerLabel).not.toContain("MiniMax Medium");

		// Navigation continues correctly through the destination group after
		// explicit expansion; focus/up-down alone must not auto-expand.
		selector.handleInput("\x1b[C");
		selector.handleInput("\x1b[B"); // MINIMAX header -> MiniMax Medium profile
		expect(cursorRowLabel(selector)).toContain("MiniMax Medium");
	});
});
