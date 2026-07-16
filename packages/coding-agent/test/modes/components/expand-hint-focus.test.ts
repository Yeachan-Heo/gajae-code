import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Container, Input, setKeybindings, Text, TUI } from "@gajae-code/tui";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal";
import { KeybindingsManager } from "../../../src/config/keybindings";
import { resetSettingsForTest, Settings } from "../../../src/config/settings";
import { BashExecutionComponent } from "../../../src/modes/components/bash-execution";
import { BranchSummaryMessageComponent } from "../../../src/modes/components/branch-summary-message";
import { CompactionSummaryMessageComponent } from "../../../src/modes/components/compaction-summary-message";
import { EvalExecutionComponent } from "../../../src/modes/components/eval-execution";
import { ReadToolGroupComponent } from "../../../src/modes/components/read-tool-group";
import { TtsrNotificationComponent } from "../../../src/modes/components/ttsr-notification";
import { ExtensionUiController } from "../../../src/modes/controllers/extension-ui-controller";
import { initTheme } from "../../../src/modes/theme/theme";
import type { InteractiveModeContext } from "../../../src/modes/types";

const HINT = "Ctrl+O";

type UiFixture = { ui: TUI; editor: Input; terminal: VirtualTerminal };

function createUi(): UiFixture {
	const terminal = new VirtualTerminal();
	const ui = new TUI(terminal);
	const editor = new Input();
	ui.addChild(editor);
	ui.setFocus(editor);
	ui.start();
	return { ui, editor, terminal };
}

function capability({ ui, editor }: UiFixture): () => boolean {
	return () => !ui.hasOverlay() && (ui.focusedComponent === null || ui.focusedComponent === editor);
}

function render(component: { render(width: number): string[] }): string {
	return Bun.stripANSI(component.render(100).join("\n"));
}

function manyLines(): string {
	return Array.from({ length: 25 }, (_value, index) => `output ${index + 1}`).join("\n");
}

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme(false);
	setKeybindings(KeybindingsManager.inMemory({ "app.tools.expand": "ctrl+o" }));
});
afterEach(() => {
	setKeybindings(KeybindingsManager.inMemory());
});

describe("instance-scoped expansion hints", () => {
	it("keeps concurrent TUI hint capabilities isolated", () => {
		const first = createUi();
		const second = createUi();
		const firstComponent = new BashExecutionComponent("echo first", first.ui, false, capability(first));
		const secondComponent = new BashExecutionComponent("echo second", second.ui, false, capability(second));
		firstComponent.setComplete(0, false, { output: manyLines() });
		secondComponent.setComplete(0, false, { output: manyLines() });

		expect(render(firstComponent)).toContain(HINT);
		expect(render(secondComponent)).toContain(HINT);
		const overlay = first.ui.showOverlay(new Text("overlay"));
		expect(render(firstComponent)).not.toContain(HINT);
		expect(render(secondComponent)).toContain(HINT);
		overlay.hide();
		expect(render(firstComponent)).toContain(HINT);
	});

	it("tracks nested, disposed, and callback-hidden overlays through the TUI lifecycle", () => {
		const fixture = createUi();
		const canExpand = capability(fixture);
		const first = fixture.ui.showOverlay(new Text("first"));
		const second = fixture.ui.showOverlay(new Text("second"));
		expect(canExpand()).toBe(false);
		second.hide();
		expect(canExpand()).toBe(false);
		first.hide();
		expect(canExpand()).toBe(true);

		const disposable = new Container();
		const disposableOverlay = fixture.ui.showOverlay(disposable);
		expect(canExpand()).toBe(false);
		disposable.dispose();
		disposableOverlay.hide();
		expect(canExpand()).toBe(true);

		let visible = true;
		fixture.ui.showOverlay(new Text("conditional"), { visible: () => visible });
		expect(canExpand()).toBe(false);
		visible = false;
		fixture.terminal.sendInput("x");
		expect(canExpand()).toBe(true);
	});

	it("uses current overlay state on the first post-overlay frame for every cached hint family", () => {
		const fixture = createUi();
		const canExpand = capability(fixture);
		const components = [
			new BranchSummaryMessageComponent({ summary: "summary" } as never, canExpand),
			new CompactionSummaryMessageComponent({ summary: "summary", tokensBefore: 1234 } as never, canExpand),
			new TtsrNotificationComponent([{ name: "rule", content: "one\ntwo\nthree" } as never], canExpand),
			new BashExecutionComponent("echo output", fixture.ui, false, canExpand),
			new EvalExecutionComponent("print('output')", fixture.ui, false, "python", canExpand),
			new ReadToolGroupComponent({ showContentPreview: true, expandHintCapability: canExpand }),
		];
		(components[3] as BashExecutionComponent).setComplete(0, false, { output: manyLines() });
		(components[4] as EvalExecutionComponent).setComplete(0, false, { output: manyLines() });
		const readGroup = components[5] as ReadToolGroupComponent;
		readGroup.updateArgs({ path: "/tmp/example.ts" }, "read");
		readGroup.updateResult({ content: [{ type: "text", text: "one\ntwo\nthree\nfour" }] }, false, "read");

		for (const component of components) expect(render(component)).toContain(HINT);
		const overlay = fixture.ui.showOverlay(new Text("overlay"));
		for (const component of components) expect(render(component)).not.toContain(HINT);
		overlay.hide();
		for (const component of components) expect(render(component)).toContain(HINT);
	});

	it("suppresses hints for the real extension custom-overlay path", async () => {
		const fixture = createUi();
		const component = new BashExecutionComponent("echo output", fixture.ui, false, capability(fixture));
		component.setComplete(0, false, { output: manyLines() });
		let close: ((result: undefined) => void) | undefined;
		(fixture.editor as unknown as { getText: () => string }).getText = () => fixture.editor.getValue();
		const controller = new ExtensionUiController({
			ui: fixture.ui,
			editor: fixture.editor,
			editorContainer: new Container(),
			isBackgrounded: false,
		} as unknown as InteractiveModeContext);

		const result = controller.showHookCustom<undefined>(
			(_ui, _theme, _keybindings, done) => {
				close = done;
				return new Text("extension overlay");
			},
			{ overlay: true },
		);
		await Promise.resolve();
		expect(fixture.ui.hasOverlay()).toBe(true);
		expect(render(component)).not.toContain(HINT);
		close?.(undefined);
		await result;
		expect(fixture.ui.hasOverlay()).toBe(false);
		expect(render(component)).toContain(HINT);
	});
});
