import "./render-goldens-env";
import { expect, test } from "bun:test";
import { Editor, Text, TUI } from "@gajae-code/tui";
import { TERMINAL } from "../src/terminal-capabilities";
import { defaultEditorTheme } from "./test-themes";
import { VirtualTerminal } from "./virtual-terminal";

test("ordinary input does not extract unsupported kitty references from every transcript row", async () => {
	const terminal = new VirtualTerminal(80, 12);
	const tui = new TUI(terminal);
	const editor = new Editor(defaultEditorTheme);
	tui.addChild(new Text("transcript\n".repeat(2000), 0, 0));
	tui.addChild(editor);
	tui.setFocus(editor);
	const capabilities = TERMINAL as { imageProtocol: string | null };
	const original = capabilities.imageProtocol;
	capabilities.imageProtocol = null;
	try {
		tui.start();
		await terminal.waitForRender();
		TUI.resetRenderCountersForTest();
		terminal.sendInput("한글");
		await terminal.waitForRender();
		expect(terminal.getViewport().join("\n")).toContain("한글");
		expect(TUI.getRenderCountersForTest().kittyPlacementReferenceRows).toBe(0);
	} finally {
		tui.stop();
		capabilities.imageProtocol = original;
	}
});
