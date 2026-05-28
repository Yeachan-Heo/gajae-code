import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Agent } from "@gajae-code/agent-core";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import { TempDir } from "@gajae-code/utils";
import { ModelRegistry } from "../src/config/model-registry";
import { CustomEditor } from "../src/modes/components/custom-editor";
import { InteractiveMode } from "../src/modes/interactive-mode";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

class TestModalEditor extends CustomEditor {}

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

	it("renders the default composer as a closed square input box", () => {
		const lines = mode.editor.render(48).map(line => stripVTControlCharacters(line));

		expect(lines[0]).toStartWith("┌");
		expect(lines[0]).toEndWith("┐");
		expect(lines.at(-1)).toStartWith("└");
		expect(lines.at(-1)).toEndWith("┘");
		expect(lines.some(line => line.startsWith("│") && line.includes(">") && line.endsWith("│"))).toBe(true);
		expect(lines.join("\n")).toContain("Type your message...");
		expect(lines.join("\n")).not.toContain("›");
	});

	it("keeps closed square composer chrome for one-line, multiline, and narrow prompts", () => {
		for (const [width, text] of [
			[48, "Ask gjc to improve the composer"],
			[48, "first line\nsecond line"],
			[28, "narrow terminal composer"],
		] as const) {
			mode.editor.setText(text);
			const lines = mode.editor.render(width).map(line => stripVTControlCharacters(line));

			expect(lines[0]).toStartWith("┌");
			expect(lines[0]).toEndWith("┐");
			expect(lines.at(-1)).toStartWith("└");
			expect(lines.at(-1)).toEndWith("┘");
			expect(lines.some(line => line.startsWith("│") && line.includes(">") && line.endsWith("│"))).toBe(true);
			expect(lines.join("\n")).not.toContain("Type your message...");
		}
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
