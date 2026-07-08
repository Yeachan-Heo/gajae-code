import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Agent } from "@gajae-code/agent-core";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { initTheme, theme } from "@gajae-code/coding-agent/modes/theme/theme";
import { CURSOR_MARKER, Text, visibleWidth } from "@gajae-code/tui";
import { TempDir } from "@gajae-code/utils";
import { ModelRegistry } from "../src/config/model-registry";
import { CustomEditor } from "../src/modes/components/custom-editor";
import { InteractiveMode } from "../src/modes/interactive-mode";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

class TestModalEditor extends CustomEditor {}
function stripRenderControls(line: string): string {
	return stripVTControlCharacters(line.replaceAll(CURSOR_MARKER, ""));
}

function forceTerminalSize(mode: InteractiveMode, columns: number, rows: number): void {
	Object.defineProperty(mode.ui.terminal, "columns", { configurable: true, get: () => columns });
	Object.defineProperty(mode.ui.terminal, "rows", { configurable: true, get: () => rows });
}

describe("InteractiveMode.setEditorComponent", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-editor-component-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		}

		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
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

	it("renders the default composer as a closed rounded input box", () => {
		const lines = mode.editor.render(48).map(stripRenderControls);

		expect(lines.every(line => visibleWidth(line) === 48)).toBe(true);
		expect(lines.every(line => line.endsWith(" "))).toBe(true);
		expect(lines[0].trimEnd()).toStartWith("╭");
		expect(lines[0].trimEnd()).toEndWith("╮");
		expect(lines.at(-1)!.trimEnd()).toStartWith("╰");
		expect(lines.at(-1)!.trimEnd()).toEndWith("╯");
		expect(lines.some(line => line.startsWith("│") && line.includes(">") && line.trimEnd().endsWith("│"))).toBe(true);
		expect(lines.join("\n")).toContain("Type your message...");
		expect(lines.join("\n")).not.toContain("›");
	});

	function expectedNewlineShortcutHint(): string {
		const shortcut = process.platform === "win32" ? "Alt+Enter/Ctrl+J" : "Shift+Enter/Ctrl+J";
		return `${shortcut}: New line`;
	}

	it("keeps the composer right border inside a trailing gutter for CJK input", () => {
		mode.editor.focused = true;
		mode.editor.setText("이전 커밋들");

		const lines = mode.editor.render(48).map(stripRenderControls);
		const promptLine = lines.find(line => line.includes("이전 커밋들"));

		expect(promptLine).toBeDefined();
		expect(lines.every(line => visibleWidth(line) === 48)).toBe(true);
		expect(lines.every(line => line.endsWith(" "))).toBe(true);
		expect(promptLine!.trimEnd()).toEndWith("│");
		expect(promptLine!).toContain("이전 커밋들");
	});

	function expectedQueueShortcutHint(): string {
		const shortcut = process.platform === "win32" ? "Alt+Q" : "Alt+Enter";
		return `${shortcut}: Queue`;
	}

	it("shows busy steering and queueing hints only while work is active", () => {
		let rendered = mode.editor.render(160).map(stripRenderControls).join("\n");
		expect(rendered).toContain("Type your message...");
		expect(rendered).toContain(expectedNewlineShortcutHint());
		expect(rendered).toContain("Ctrl+C: Clear");
		expect(rendered).toContain("Ctrl+R: Search history");
		expect(rendered).toContain("Shift+Tab: Reasoning");
		expect(rendered).not.toContain("Enter: Steer");
		expect(rendered).not.toContain(expectedQueueShortcutHint());

		(session.agent as unknown as { state: { isStreaming: boolean } }).state.isStreaming = true;
		mode.updateEditorChrome();

		rendered = mode.editor.render(160).map(stripRenderControls).join("\n");
		expect(rendered).toContain("Type your message...");
		expect(rendered).toContain("Enter: Steer");
		expect(rendered).toContain(expectedQueueShortcutHint());

		(session.agent as unknown as { state: { isStreaming: boolean } }).state.isStreaming = false;
		mode.updateEditorChrome();

		rendered = mode.editor.render(160).map(stripRenderControls).join("\n");
		expect(rendered).toContain("Type your message...");
		expect(rendered).not.toContain("Enter: Steer");
		expect(rendered).not.toContain(expectedQueueShortcutHint());
	});

	it("renders the composer directly below the status line without hook widgets", async () => {
		vi.spyOn(mode.ui, "start").mockImplementation(() => {});

		await mode.init();

		const assertComposerFollowsStatusLine = () => {
			const rendered = mode.ui.render(48).map(stripRenderControls);
			const composerContentIndex = rendered.findIndex(line => line.includes("Type your message..."));
			const composerIndex = composerContentIndex - 1;
			const statusRows = mode.statusLine.render(48).map(stripRenderControls);

			expect(composerIndex).toBeGreaterThan(0);
			expect(rendered.slice(composerIndex - statusRows.length, composerIndex)).toEqual(statusRows);
		};

		assertComposerFollowsStatusLine();

		mode.setHookWidget("test", ["temporary widget"]);
		mode.setHookWidget("test", undefined);

		assertComposerFollowsStatusLine();
	});

	it("keeps the welcome splash viewport-bound when /new shows a notification", async () => {
		const width = 100;
		const rows = 28;
		vi.spyOn(mode.ui, "start").mockImplementation(() => {});
		forceTerminalSize(mode, width, rows);

		await mode.init();

		mode.chatContainer.clear();
		mode.chatContainer.addChild(
			new Text(`${theme.fg("accent", `${theme.status.success} New session started`)}`, 1, 0),
		);

		const rendered = mode.ui.render(width).map(stripRenderControls);
		const renderedText = rendered.join("\n");
		const noticeIndex = rendered.findIndex(line => line.includes("New session started"));
		expect(rendered.length).toBeLessThanOrEqual(rows);
		expect(renderedText).toContain("GJC Forge");
		expect(noticeIndex).toBeGreaterThan(0);
		expect(rendered[noticeIndex - 1]?.trim()).not.toBe("");
		expect(renderedText).toContain("New session started");
	});

	it("keeps closed rounded composer chrome for one-line, multiline, and narrow prompts", () => {
		for (const [width, text] of [
			[48, "Ask gjc to improve the composer"],
			[48, "first line\nsecond line"],
			[28, "narrow terminal composer"],
		] as const) {
			mode.editor.setText(text);
			const lines = mode.editor.render(width).map(stripRenderControls);

			expect(lines.every(line => visibleWidth(line) === width)).toBe(true);
			expect(lines.every(line => line.endsWith(" "))).toBe(true);
			expect(lines[0].trimEnd()).toStartWith("╭");
			expect(lines[0].trimEnd()).toEndWith("╮");
			expect(lines.at(-1)!.trimEnd()).toStartWith("╰");
			expect(lines.at(-1)!.trimEnd()).toEndWith("╯");
			expect(lines.some(line => line.startsWith("│") && line.includes(">") && line.trimEnd().endsWith("│"))).toBe(
				true,
			);
			expect(lines.join("\n")).not.toContain("Type your message...");
		}
	});

	it("keeps the default prompt prefix while reflecting shell modes in border color", () => {
		mode.editor.setText("!!pwd");
		mode.isBashMode = true;
		mode.isBashNoContext = true;

		mode.updateEditorChrome();

		expect(mode.editor.borderColor("x")).toBe(theme.fg("warning", "x"));
		let lines = mode.editor.render(48).map(stripRenderControls);
		expect(
			lines.some(
				line =>
					line.startsWith("│") &&
					line.includes("shell no-context") &&
					line.includes(">") &&
					line.includes("!!pwd"),
			),
		).toBe(true);

		mode.isBashNoContext = false;
		mode.updateEditorChrome();

		expect(mode.editor.borderColor("x")).toBe(theme.getBashModeBorderColor()("x"));
		lines = mode.editor.render(48).map(stripRenderControls);
		expect(lines.some(line => line.startsWith("│") && line.includes("shell") && line.includes("!!pwd"))).toBe(true);

		mode.isBashMode = false;
		mode.updateEditorChrome();

		lines = mode.editor.render(48).map(stripRenderControls);
		expect(lines.some(line => line.startsWith("│") && line.includes(">") && line.includes("!!pwd"))).toBe(true);
		expect(lines.join("\n")).not.toContain("shell");
	});

	it("replaces the editor and rebinds interactive handlers", () => {
		mode.editor.setText("draft prompt");
		const previousEditor = mode.editor;
		const refreshSpy = vi.spyOn(mode, "refreshSlashCommandState").mockResolvedValue();

		mode.setEditorComponent((_tui, editorTheme) => new TestModalEditor(editorTheme));

		expect(mode.editor).toBeInstanceOf(TestModalEditor);
		expect(mode.editor).not.toBe(previousEditor);
		expect(mode.editor.getText()).toBe("draft prompt");
		expect(mode.editor.onSubmit).toBeDefined();
		expect(mode.editor.onEscape).toBeDefined();
		expect(refreshSpy).toHaveBeenCalled();
	});
});
