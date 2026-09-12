import { expect, test } from "bun:test";
import { getBundledModel, type Model } from "@gajae-code/ai";
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
		expect(transcript.renders).toBe(openingRenders + (renderScope ? 0 : 1));
		capture();

		terminal.clearWriteLog();
		models = [{ ...models[0], name: "Model Beta" }];
		catalogChanged();
		await terminal.waitForRender();
		expect(terminal.getViewport().join("\n")).toContain("Model Beta");
		expect(transcript.renders).toBe(openingRenders + (renderScope ? 0 : 2));
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
