import { expect, test } from "bun:test";
import type { Model } from "@gajae-code/ai";
import type { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { ModelSelectorComponent } from "@gajae-code/coding-agent/modes/components/model-selector";
import { getThemeByName, setThemeInstance } from "@gajae-code/coding-agent/modes/theme/theme";
import { Container, TUI } from "@gajae-code/tui";
import { VirtualTerminal } from "../tui/test/virtual-terminal";

// Image-only model (output: ["image"] only)
const imageOnlyModel: Model = {
	id: "gpt-image-2.6-flare",
	name: "GPT Image 2.6 Flare",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "",
	reasoning: false,
	input: ["text"],
	output: ["image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 16_384,
};

// Regular text model (output undefined, defaults to text-only)
const textModel: Model = {
	id: "gpt-4o",
	name: "GPT-4o",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 16_384,
};

// Text + Image model (output: ["text", "image"])
const textAndImageModel: Model = {
	id: "claude-opus-vision",
	name: "Claude Opus Vision",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "",
	reasoning: false,
	input: ["text", "image"],
	output: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 4_096,
};

test("image-only models excluded from ordinary chat selection", async () => {
	await setThemeInstance((await getThemeByName("red-claw"))!);

	const terminal = new VirtualTerminal(100, 40);
	const tui = new TUI(terminal, false, { widthSettleMs: 0 });

	const models = [imageOnlyModel, textModel, textAndImageModel];

	const registry = {
		refresh: () => Promise.resolve(),
		getError: () => undefined,
		getAvailable: () => models,
		getAll: () => models,
		getModelProfiles: () => new Map(),
		getCanonicalModelSelections: () => [],
		getDiscoverableProviders: () => [],
		hasConfiguredProviderAuth: () => false,
		isSelectorCircuitOpen: () => false,
		onCatalogChanged: () => () => {},
	} as unknown as ModelRegistry;

	let selectedModel: Model | undefined;

	try {
		tui.start();
		await terminal.waitForRender();

		const selector = new ModelSelectorComponent(
			tui,
			textModel,
			Settings.isolated(),
			registry,
			[],
			selection => {
				if (selection.kind === "provider") {
					selectedModel = selection.model;
				}
			},
			() => {},
		);

		const container = new Container();
		container.addChild(selector);
		tui.addChild(container);

		// Wait for selector to load models
		await terminal.waitForRender();

		// Check that image-only model is not in the rendered output
		const output = terminal.getViewportAnsi();

		// The text model and text+image model should be visible
		expect(output).toContain("gpt-4o");
		expect(output).toContain("claude-opus-vision");

		// The image-only model should NOT be visible in ordinary chat selection
		expect(output).not.toContain("gpt-image-2.6-flare");
	} finally {
		tui.dispose();
		terminal.dispose();
	}
});

test("image-only models included in image role selection", async () => {
	await setThemeInstance((await getThemeByName("red-claw"))!);

	const terminal = new VirtualTerminal(100, 40);
	const tui = new TUI(terminal, false, { widthSettleMs: 0 });

	const models = [imageOnlyModel, textModel, textAndImageModel];

	const registry = {
		refresh: () => Promise.resolve(),
		getError: () => undefined,
		getAvailable: () => models,
		getAll: () => models,
		getModelProfiles: () => new Map(),
		getCanonicalModelSelections: () => [],
		getDiscoverableProviders: () => [],
		hasConfiguredProviderAuth: () => false,
		isSelectorCircuitOpen: () => false,
		onCatalogChanged: () => () => {},
	} as unknown as ModelRegistry;

	try {
		tui.start();
		await terminal.waitForRender();

		// Create selector with imageRoleFilter = true to simulate image role selection
		const selector = new ModelSelectorComponent(
			tui,
			imageOnlyModel,
			Settings.isolated({ modelRoles: { image: "openai/gpt-image-2.6-flare" } }),
			registry,
			[],
			() => {},
			() => {},
			{ imageRoleFilter: true },
		);

		const container = new Container();
		container.addChild(selector);
		tui.addChild(container);

		// Wait for selector to load models
		await terminal.waitForRender();

		// Check that image models are in the rendered output when filtering for image role
		const output = terminal.getViewportAnsi();

		// Image-only model should be visible in image role selection
		expect(output).toContain("gpt-image-2.6-flare");

		// Text-only model should NOT be visible in image role selection
		expect(output).not.toContain("gpt-4o");
	} finally {
		tui.dispose();
		terminal.dispose();
	}
});
