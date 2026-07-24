import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";

import { Agent } from "@gajae-code/agent-core";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { CustomEditor } from "@gajae-code/coding-agent/modes/components/custom-editor";
import { getEditorTheme, initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import { CURSOR_MARKER, ScrollViewport, type ScrollViewportSource, Text } from "@gajae-code/tui";
import { TempDir } from "@gajae-code/utils";
import { KeybindingsManager } from "../src/config/keybindings";
import { ModelRegistry } from "../src/config/model-registry";
import { allocateComposerLayout } from "../src/modes/composer-layout";
import { InteractiveMode } from "../src/modes/interactive-mode";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

class MutableSource implements ScrollViewportSource {
	constructor(public rows: string[]) {}

	getRowCount(_width: number): number {
		return this.rows.length;
	}

	renderRows(_width: number, startRow: number, endRow: number): string[] {
		return this.rows.slice(startRow, endRow);
	}
}

const numberedRows = (count: number): string[] => Array.from({ length: count }, (_value, index) => `row-${index}`);

beforeAll(() => {
	initTheme();
});
describe("composer layout allocation", () => {
	it("caps the bordered editor and allocates transcript and autocomplete deterministically", () => {
		expect(
			allocateComposerLayout({
				terminalRows: 40,
				editorRows: 30,
				statusRows: 1,
				widgetRowsAbove: 1,
				widgetRowsBelow: 0,
				autocompleteRows: 6,
			}),
		).toEqual({
			transcriptRows: 14,
			editorMaxRows: 18,
			statusRows: 1,
			widgetRowsAbove: 1,
			widgetRowsBelow: 0,
			autocompleteRows: 6,
		});
	});

	it("keeps one cursor-bearing editor content row on tiny terminals", () => {
		expect(
			allocateComposerLayout({
				terminalRows: 2,
				editorRows: 1,
				statusRows: 1,
				widgetRowsAbove: 1,
				widgetRowsBelow: 0,
				autocompleteRows: 8,
			}),
		).toMatchObject({ transcriptRows: 0, editorMaxRows: 3, autocompleteRows: 0 });
	});
});

describe("sticky transcript viewport behavior", () => {
	it("renders top, middle, and tail windows and pads short content", () => {
		const source = new MutableSource(numberedRows(8));
		const viewport = new ScrollViewport(source, { height: 3, followTail: false });

		expect(viewport.render(40)).toEqual(["row-0", "row-1", "row-2"]);
		viewport.setOffset(3);
		expect(viewport.render(40)).toEqual(["row-3", "row-4", "row-5"]);
		viewport.scrollToTail();
		expect(viewport.render(40)).toEqual(["row-5", "row-6", "row-7"]);

		source.rows = ["only"];
		expect(viewport.render(40)).toEqual(["", "", "only"]);
	});

	it("holds a paused streaming window, tracks unseen rows, and returns to tail", () => {
		const source = new MutableSource(numberedRows(6));
		const viewport = new ScrollViewport(source, { height: 3 });
		expect(viewport.render(40)).toEqual(["row-3", "row-4", "row-5"]);

		viewport.scrollBy(-2);
		source.rows.push("row-6", "row-7");
		expect(viewport.render(40)).toEqual(["row-1", "row-2", "row-3"]);
		expect(viewport.getState()).toMatchObject({ followTail: false, unseenRows: 2 });

		viewport.setHeight(2);
		expect(viewport.render(40)).toEqual(["row-1", "row-2"]);
		expect(viewport.getState().unseenRows).toBe(2);

		viewport.scrollToTail();
		expect(viewport.render(40)).toEqual(["row-6", "row-7"]);
		expect(viewport.getState()).toMatchObject({ followTail: true, unseenRows: 0 });
	});

	it("does not disturb editor focus or typing while the transcript moves", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.focused = true;
		editor.setText("draft stays here");
		const viewport = new ScrollViewport(new MutableSource(numberedRows(20)), { height: 4 });

		viewport.render(40);
		viewport.scrollBy(-3);
		viewport.render(40);

		expect(editor.getText()).toBe("draft stays here");
		expect(editor.focused).toBe(true);
		expect(editor.render(40).join("\n")).toContain(CURSOR_MARKER);
	});

	it("internally scrolls a long draft while keeping the cursor visible", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.focused = true;
		editor.setMaxHeight(5);
		editor.setText(numberedRows(30).join("\n"));

		const rendered = editor.render(40);
		expect(rendered.length).toBeLessThanOrEqual(5);
		expect(rendered.join("\n")).toContain(CURSOR_MARKER);
	});
});

describe("InteractiveMode transcript integration", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-transcript-viewport-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("provides reachable transcript bindings without replacing editor PageUp/PageDown", () => {
		const keybindings = KeybindingsManager.inMemory();
		expect(keybindings.getKeys("app.transcript.pageUp").join(",")).toBe("alt+pageUp");
		expect(keybindings.getKeys("app.transcript.pageDown").join(",")).toBe("alt+pageDown");
		expect(keybindings.getKeys("app.transcript.tail").join(",")).toBe("alt+end");
		expect(keybindings.getKeys("tui.editor.pageUp").join(",")).toBe("pageUp");
		expect(keybindings.getKeys("tui.editor.pageDown").join(",")).toBe("pageDown");
	});

	it("renders and clears a sanitized unseen-row affordance without changing focus", () => {
		mode.ui.setFocus(mode.editor);
		expect(mode.editor.focused).toBe(true);

		mode.chatContainer.addChild(new Text(numberedRows(40).join("\n")));
		mode.transcriptViewport.render(80);
		mode.transcriptViewport.scrollBy(-3);
		mode.chatContainer.addChild(new Text("new-a\nnew-b"));

		const rendered = mode.transcriptViewport.render(80);
		const unseenRows = mode.transcriptViewport.getState().unseenRows;
		const indicator = stripVTControlCharacters(rendered.at(-1) ?? "");
		const tailShortcut = mode.keybindings.getDisplayString("app.transcript.tail");
		expect(unseenRows).toBeGreaterThan(0);
		expect(tailShortcut).not.toBe("");
		expect(indicator).toContain(`${unseenRows} unseen rows`);
		expect(indicator).toContain(tailShortcut);
		expect(mode.editor.focused).toBe(true);

		const tiny = mode.transcriptViewport.render(4);
		expect(Bun.stringWidth(stripVTControlCharacters(tiny.at(-1) ?? ""))).toBeLessThanOrEqual(4);
		expect(mode.transcriptViewport.getState().unseenRows).toBe(unseenRows);

		mode.transcriptViewport.scrollToTail();
		const returned = mode.transcriptViewport.render(80).map(line => stripVTControlCharacters(line));
		expect(returned.some(line => line.includes("unseen"))).toBe(false);
		expect(mode.transcriptViewport.getState().unseenRows).toBe(0);
	});

	it("reveals an offscreen durable turn through the nested transcript viewport", async () => {
		vi.spyOn(mode.ui, "start").mockImplementation(() => {});
		await mode.init();
		mode.transcriptViewport.setHeight(3);
		for (let index = 0; index < 8; index++) {
			mode.addMessageToChat({ role: "user", content: `durable turn ${index}`, timestamp: index + 1 });
		}
		const transcript = mode.chatContainer.renderWithViewportAnchors(60);
		const target = transcript.anchors.find(anchor => anchor !== null);
		expect(target).not.toBeNull();
		mode.ui.renderWithViewportAnchors(60);

		expect(mode.ui.revealViewportAnchor(target!.id, "top")).toBe(true);
		const revealed = mode.ui.renderWithViewportAnchors(60);
		expect(revealed.anchors.some(anchor => anchor?.id === target!.id)).toBe(true);
		expect(mode.transcriptViewport.getState().followTail).toBe(false);
	});
	it("replaces the editor once, transfers layout and text, and preserves overlay focus", () => {
		mode.editor.setText("preserved draft");
		mode.transcriptViewport.setHeight(7);
		mode.transcriptViewport.render(48);
		const previousEditor = mode.editor;
		const disposeSpy = vi.spyOn(previousEditor, "dispose");
		const overlay = new Text("overlay");
		mode.ui.setFocus(previousEditor);
		const overlayHandle = mode.ui.showOverlay(overlay);

		mode.setEditorComponent((_tui, editorTheme) => new CustomEditor(editorTheme));

		expect(disposeSpy).toHaveBeenCalledTimes(1);
		expect(mode.editor.getText()).toBe("preserved draft");
		expect(mode.editor.getAutocompleteRowBudget()).toBeDefined();
		expect(mode.editor.focused).toBe(false);
		overlayHandle.hide();
		expect(mode.editor.focused).toBe(true);
		expect(previousEditor.focused).toBe(false);
	});
});
