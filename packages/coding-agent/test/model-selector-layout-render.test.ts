import { expect, test } from "bun:test";
import { getBundledModel, type Model } from "@gajae-code/ai";
import type { ModelProfileDefinition } from "@gajae-code/coding-agent/config/model-profiles";
import type { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { ModelSelectorComponent } from "@gajae-code/coding-agent/modes/components/model-selector";
import { getThemeByName, setThemeInstance, theme } from "@gajae-code/coding-agent/modes/theme/theme";
import { type Component, Container, Text, TUI, type ViewportAnchorRender } from "@gajae-code/tui";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

class CountingTranscript extends Container {
	renders = 0;
	override renderWithViewportAnchors(width: number): ViewportAnchorRender {
		this.renders++;
		return super.renderWithViewportAnchors(width);
	}
}
type Capture = { viewport: string; scrollback: string[]; writes: string[] };

class MutableLine implements Component {
	text = "初期の履歴";
	invalidate(): void {}
	render(): string[] {
		return [this.text];
	}
}

async function replay(renderScope?: "layout"): Promise<Capture[]> {
	const terminal = new VirtualTerminal(100, 40);
	const tui = new TUI(terminal, false, { widthSettleMs: 0 });
	const transcript = new CountingTranscript();
	transcript.addChild(
		new Text(Array.from({ length: 2_000 }, (_, i) => `履歴 ${i}: 漢字 transcript`).join("\n"), 0, 0),
	);
	const liveLine = new MutableLine();
	transcript.addChild(liveLine);
	const composer = new Container();
	const editor = new Text("composer", 0, 0);
	composer.addChild(editor);
	tui.addChild(transcript);
	tui.addChild(composer);
	tui.setViewportAnchorComponent(transcript);
	tui.setViewportOutputSource({ identity: "session:selector-layout", revision: 0n });
	const loaded = Promise.withResolvers<void>();
	let catalogChanged: () => void = () => {};
	let models: Model[] = [{ ...getBundledModel("openai", "gpt-4o"), name: "Model Alpha" }];
	const registry = {
		refresh: () => loaded.promise,
		getError: () => undefined,
		getAvailable: () => models,
		getAll: () => models,
		getModelProfiles: () => new Map(),
		getCanonicalModelSelections: () => [],
		getDiscoverableProviders: () => [],
		hasConfiguredProviderAuth: () => false,
		onCatalogChanged: (callback: () => void) => {
			catalogChanged = callback;
			return () => {
				catalogChanged = () => {};
			};
		},
	} as unknown as ModelRegistry;
	const captures: Capture[] = [];
	const capture = () =>
		captures.push({
			viewport: terminal.getViewportAnsi(),
			scrollback: terminal.getScrollBuffer(),
			writes: terminal.getWriteLog(),
		});
	try {
		tui.start();
		await terminal.waitForRender();
		composer.detachChild(editor);
		const selector = new ModelSelectorComponent(
			tui,
			models[0],
			Settings.isolated(),
			registry,
			[],
			() => {},
			() => {},
			{
				temporaryOnly: true,
				renderScope,
			},
		);
		composer.addChild(selector);
		tui.setFocus(selector);
		tui.requestRender();
		await terminal.waitForRender();
		const openingRenders = transcript.renders;
		terminal.clearWriteLog();
		loaded.resolve();
		await terminal.waitForRender();
		expect(terminal.getViewport().join("\n")).toContain("Model Alpha");
		expect(transcript.renders).toBe(openingRenders + (renderScope === "layout" ? 0 : 1));
		capture();

		terminal.clearWriteLog();
		models = [{ ...models[0], name: "Model Beta" }];
		catalogChanged();
		await terminal.waitForRender();
		expect(terminal.getViewport().join("\n")).toContain("Model Beta");
		expect(transcript.renders).toBe(openingRenders + (renderScope === "layout" ? 0 : 2));
		capture();

		// A full request must win even without a semantic revision update.
		terminal.clearWriteLog();
		const beforeMutation = transcript.renders;
		liveLine.text = "追加された履歴";
		catalogChanged();
		tui.requestRender(false, "streaming-mutation");
		await terminal.waitForRender();
		expect(transcript.renders).toBe(beforeMutation + 1);
		expect(terminal.getScrollBuffer().join("\n")).toContain("追加された履歴");
		capture();

		terminal.clearWriteLog();
		const beforeResize = transcript.renders;
		terminal.resize(60, 40);
		catalogChanged();
		await terminal.waitForRender();
		expect(transcript.renders).toBeGreaterThan(beforeResize);
		capture();
		return captures;
	} finally {
		loaded.resolve();
		tui.stop();
		tui.dispose();
		terminal.reset();
	}
}

async function replayPresetLanding(renderScope?: "layout"): Promise<Capture[]> {
	const terminal = new VirtualTerminal(100, 40);
	const tui = new TUI(terminal, false, { widthSettleMs: 0 });
	const transcript = new CountingTranscript();
	transcript.addChild(
		new Text(Array.from({ length: 2_000 }, (_, i) => `履歴 ${i}: 漢字 transcript`).join("\n"), 0, 0),
	);
	const statusLine = new Text("Pinned session status", 0, 0);
	const composer = new Container();
	tui.addChild(transcript);
	tui.addChild(statusLine);
	tui.addChild(composer);
	tui.setViewportAnchorComponent(transcript);
	tui.setBottomPinnedComponent(statusLine);
	tui.setViewportOutputSource({ identity: "session:preset-layout", revision: 0n });
	const loaded = Promise.withResolvers<void>();
	let auth = Promise.withResolvers<string | undefined>();
	let catalogChanged: () => void = () => {};
	let authChanged: () => void = () => {};
	const model = getBundledModel("openai", "gpt-4o");
	const profile: ModelProfileDefinition = {
		name: "custom-alpha",
		displayName: "Profile Alpha",
		providerGroup: "Alpha presets",
		requiredProviders: ["openai"],
		modelMapping: { default: "openai/gpt-4o" },
		source: "user",
	};
	const profiles = new Map([[profile.name, profile]]);
	const registry = {
		refreshStatic: () => loaded.promise,
		getError: () => undefined,
		getAvailable: () => [model],
		getAll: () => [model],
		getModelProfiles: () => profiles,
		getModelProfile: (name: string) => profiles.get(name),
		getAvailableModelProfileNames: () => [...profiles.keys()],
		getCanonicalModels: () => [],
		getCanonicalModelSelections: () => [],
		resolveCanonicalModel: () => undefined,
		getDiscoverableProviders: () => [],
		hasConfiguredProviderAuth: () => false,
		getApiKeyForProvider: () => auth.promise,
		onCatalogChanged: (callback: () => void) => {
			catalogChanged = callback;
			return () => {
				catalogChanged = () => {};
			};
		},
		authStorage: {
			onGenerationChanged: (callback: () => void) => {
				authChanged = callback;
				return () => {
					authChanged = () => {};
				};
			},
		},
	} as unknown as ModelRegistry;
	const captures: Capture[] = [];
	try {
		tui.start();
		await terminal.waitForRender();
		// Omit temporaryOnly and all other view overrides: production opens presets.
		const selector = new ModelSelectorComponent(
			tui,
			model,
			Settings.isolated(),
			registry,
			[],
			() => {},
			() => {},
			{ renderScope },
		);
		composer.addChild(selector);
		tui.setFocus(selector);
		tui.requestRender();
		await terminal.waitForRender();
		const openingRenders = transcript.renders;
		const openingHeight = selector.render(100).length;
		const capture = (frame: number) => {
			const viewport = terminal.getViewport().join("\n");
			expect(viewport).toContain("Model presets");
			expect(viewport).toContain("Alpha presets");
			expect(viewport).toContain("Pinned session status");
			expect(transcript.renders).toBe(openingRenders + (renderScope === "layout" ? 0 : frame));
			captures.push({
				viewport: terminal.getViewportAnsi(),
				scrollback: terminal.getScrollBuffer(),
				writes: terminal.getWriteLog(),
			});
		};
		terminal.clearWriteLog();
		profiles.set("custom-beta", {
			...profile,
			name: "custom-beta",
			displayName: "Profile Beta",
			providerGroup: "Beta presets",
		});
		loaded.resolve();
		await terminal.waitForRender();
		expect(selector.render(100).length).toBeGreaterThan(openingHeight);
		expect(terminal.getViewport().join("\n")).toContain("Beta presets");
		capture(1);

		terminal.clearWriteLog();
		auth.resolve("test-key");
		await terminal.waitForRender();
		expect(terminal.getViewport().find(line => line.includes("Alpha presets"))).toContain("✓");
		capture(2);

		terminal.clearWriteLog();
		auth = Promise.withResolvers<string | undefined>();
		authChanged();
		auth.resolve(undefined);
		await terminal.waitForRender();
		expect(terminal.getViewport().find(line => line.includes("Alpha presets"))).toContain("✗");
		capture(3);

		terminal.clearWriteLog();
		profiles.delete("custom-beta");
		catalogChanged();
		await terminal.waitForRender();
		expect(selector.render(100).length).toBe(openingHeight);
		expect(terminal.getViewport().join("\n")).not.toContain("Beta presets");
		capture(4);
		return captures;
	} finally {
		loaded.resolve();
		auth.resolve(undefined);
		tui.stop();
		tui.dispose();
		terminal.reset();
	}
}

test("default preset landing reuses history across catalog and auth refreshes with identical pinned terminal output", async () => {
	const previousTheme = theme;
	const testTheme = await getThemeByName("red-claw");
	if (!testTheme) throw new Error("Missing test theme");
	setThemeInstance(testTheme);
	try {
		const full = await replayPresetLanding();
		const layout = await replayPresetLanding("layout");
		expect(layout).toEqual(full);
		if (Bun.env.GJC_MODEL_SELECTOR_RENDER_REPORT) {
			await Bun.write(
				`${Bun.env.GJC_MODEL_SELECTOR_RENDER_REPORT}.presets.json`,
				JSON.stringify(
					{
						scenarios: ["static-catalog-growth", "auth-available", "auth-revoked", "catalog-shrink"],
						full,
						layout,
					},
					null,
					2,
				),
			);
		}
	} finally {
		setThemeInstance(previousTheme);
	}
});

test("composer model refreshes reuse the transcript with identical terminal output and conservative invalidation", async () => {
	const previousTheme = theme;
	const testTheme = await getThemeByName("red-claw");
	if (!testTheme) throw new Error("Missing test theme");
	setThemeInstance(testTheme);
	try {
		const full = await replay();
		const layout = await replay("layout");
		expect(layout).toEqual(full);
		if (Bun.env.GJC_MODEL_SELECTOR_RENDER_REPORT) {
			await Bun.write(
				Bun.env.GJC_MODEL_SELECTOR_RENDER_REPORT,
				JSON.stringify(
					{
						capturedAt: new Date().toISOString(),
						source: "VirtualTerminal replay; full vs layout; 2000 history rows plus mutable tail",
						widths: [100, 60],
						rows: 40,
						scenarios: ["catalog-loaded", "catalog-changed", "coalesced-full-mutation", "resize"],
						full,
						layout,
					},
					null,
					2,
				),
			);
		}
	} finally {
		setThemeInstance(previousTheme);
	}
});
