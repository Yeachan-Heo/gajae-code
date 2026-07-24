import { describe, expect, it } from "bun:test";
import type { SlashCommand } from "@gajae-code/tui";
import { Editor } from "@gajae-code/tui/components/editor";
import { defaultEditorTheme } from "../../tui/test/test-themes";
import { KeybindingsManager as AppKeybindingsManager } from "../src/config/keybindings";
import { createPromptActionAutocompleteProvider } from "../src/modes/prompt-action-autocomplete";

describe("prompt action autocomplete", () => {
	function createNoopProvider(commands: SlashCommand[] = []) {
		return createPromptActionAutocompleteProvider({
			commands,
			basePath: "/tmp",
			keybindings: AppKeybindingsManager.inMemory(),
			copyCurrentLine: () => {},
			copyPrompt: () => {},
			pasteImage: () => {},
			newSession: () => {},
			showHelp: () => {},
			scrollTmuxToPreviousUserInput: () => {},
			undo: () => {},
			moveCursorToMessageEnd: () => {},
			moveCursorToMessageStart: () => {},
			moveCursorToLineStart: () => {},
			moveCursorToLineEnd: () => {},
		});
	}

	it("shows prompt actions with configured shortcut hints", async () => {
		const keybindings = AppKeybindingsManager.inMemory({
			"app.clipboard.copyLine": "ctrl+shift+l",
			"app.clipboard.copyPrompt": ["alt+shift+c", "ctrl+shift+c"],
			"app.clipboard.pasteImage": "ctrl+i",
			"app.session.new": "ctrl+n",
			"tui.editor.cursorLineStart": ["home", "f6"],
			"tui.editor.cursorLineEnd": "f7",
			"tui.editor.undo": "f8",
		});
		const provider = createPromptActionAutocompleteProvider({
			commands: [],
			basePath: "/tmp",
			keybindings,
			copyCurrentLine: () => {},
			copyPrompt: () => {},
			pasteImage: () => {},
			newSession: () => {},
			showHelp: () => {},
			scrollTmuxToPreviousUserInput: () => {},
			undo: () => {},
			moveCursorToMessageEnd: () => {},
			moveCursorToMessageStart: () => {},
			moveCursorToLineStart: () => {},
			moveCursorToLineEnd: () => {},
		});

		const suggestions = await provider.getSuggestions(["#"], 0, 1);
		expect(suggestions).not.toBeNull();
		expect(suggestions?.prefix).toBe("#");
		expect(suggestions?.items.map(item => item.label)).toEqual([
			"Start new session",
			"Open command help",
			"Copy current line",
			"Copy whole prompt",
			"Paste image from clipboard",
			"Scroll to previous user input",
			"Undo",
			"Move cursor to end of message",
			"Move cursor to beginning of message",
			"Move cursor to beginning of line",
			"Move cursor to end of line",
		]);
		expect(suggestions?.items.find(item => item.label === "Copy current line")?.description).toBe(
			keybindings.getDisplayString("app.clipboard.copyLine"),
		);
		expect(suggestions?.items.find(item => item.label === "Copy whole prompt")?.description).toBe(
			keybindings.getDisplayString("app.clipboard.copyPrompt"),
		);
		expect(suggestions?.items.find(item => item.label === "Paste image from clipboard")?.description).toBe(
			keybindings.getDisplayString("app.clipboard.pasteImage"),
		);
		expect(suggestions?.items.find(item => item.label === "Move cursor to beginning of line")?.description).toBe(
			keybindings.getDisplayString("tui.editor.cursorLineStart"),
		);
		expect(suggestions?.items.find(item => item.label === "Move cursor to end of line")?.description).toBe(
			keybindings.getDisplayString("tui.editor.cursorLineEnd"),
		);
		expect(suggestions?.items.find(item => item.label === "Undo")?.description).toBe(
			keybindings.getDisplayString("tui.editor.undo"),
		);
		expect(suggestions?.items.find(item => item.label === "Start new session")?.description).toBe(
			keybindings.getDisplayString("app.session.new"),
		);
		expect(suggestions?.items.find(item => item.label === "Open command help")?.description).toBe("/help");
	});
	it("uses the injected non-host display context for editor shortcut hints", async () => {
		const injectedPlatform: NodeJS.Platform = process.platform === "darwin" ? "linux" : "darwin";
		const keybindings = AppKeybindingsManager.inMemory({
			"tui.editor.cursorLineStart": "ctrl+a",
			"tui.editor.cursorLineEnd": "ctrl+e",
			"tui.editor.undo": "ctrl+-",
		});
		keybindings.setDisplayContext({ platform: injectedPlatform });
		const provider = createPromptActionAutocompleteProvider({
			commands: [],
			basePath: "/tmp",
			keybindings,
			copyCurrentLine: () => {},
			copyPrompt: () => {},
			pasteImage: () => {},
			newSession: () => {},
			showHelp: () => {},
			scrollTmuxToPreviousUserInput: () => {},
			undo: () => {},
			moveCursorToMessageEnd: () => {},
			moveCursorToMessageStart: () => {},
			moveCursorToLineStart: () => {},
			moveCursorToLineEnd: () => {},
		});

		const suggestions = await provider.getSuggestions(["#"], 0, 1);
		const expectedPrefix = injectedPlatform === "darwin" ? "⌃" : "Ctrl+";

		expect(suggestions?.items.find(item => item.label === "Move cursor to beginning of line")?.description).toBe(
			`${expectedPrefix}A`,
		);
		expect(suggestions?.items.find(item => item.label === "Move cursor to end of line")?.description).toBe(
			`${expectedPrefix}E`,
		);
		expect(suggestions?.items.find(item => item.label === "Undo")?.description).toBe(`${expectedPrefix}-`);
	});
	it("leaves unbound app shortcut descriptions empty", async () => {
		const provider = createPromptActionAutocompleteProvider({
			commands: [],
			basePath: "/tmp",
			keybindings: AppKeybindingsManager.inMemory({ "app.session.new": [] }),
			copyCurrentLine: () => {},
			copyPrompt: () => {},
			pasteImage: () => {},
			newSession: () => {},
			showHelp: () => {},
			scrollTmuxToPreviousUserInput: () => {},
			undo: () => {},
			moveCursorToMessageEnd: () => {},
			moveCursorToMessageStart: () => {},
			moveCursorToLineStart: () => {},
			moveCursorToLineEnd: () => {},
		});

		const suggestions = await provider.getSuggestions(["#"], 0, 1);

		expect(suggestions?.items.find(item => item.label === "Start new session")?.description).toBe("");
	});

	it("orders top-level slash commands by beginner-first priorities and keeps provider internals low", async () => {
		const provider = createNoopProvider([
			{ name: "grok-build-usage", description: "Advanced provider diagnostics" },
			{ name: "settings", description: "Open settings and preferences", priority: 40 },
			{
				name: "session",
				description: "Show session info or delete the current session transcript/artifacts",
				priority: 88,
			},
			{ name: "resume", description: "Resume a previous session", priority: 92 },
			{ name: "new", description: "Start a new session", priority: 96 },
			{ name: "help", description: "Learn commands and beginner workflows", priority: 100 },
		]);

		const suggestions = await provider.getSuggestions(["/"], 0, 1);

		expect(suggestions?.items.map(item => item.value)).toEqual([
			"help",
			"new",
			"resume",
			"session",
			"settings",
			"grok-build-usage",
		]);
		expect(suggestions?.items.find(item => item.value === "session")?.description).toBe(
			"Show session info or delete the current session transcript/artifacts",
		);
	});

	it("offers slash command names from inline prompt text", async () => {
		const provider = createNoopProvider([{ name: "help", description: "Learn commands and beginner workflows" }]);
		const line = "please /he";
		const suggestions = await provider.getSuggestions([line], 0, line.length);

		expect(suggestions?.prefix).toBe("/he");
		expect(suggestions?.items.map(item => item.value)).toContain("help");
	});

	it("offers slash command names from adjacent inline prompt text", async () => {
		const provider = createNoopProvider([{ name: "help", description: "Learn commands and beginner workflows" }]);
		const line = "please/hel";
		const suggestions = await provider.getSuggestions([line], 0, line.length);

		expect(suggestions?.prefix).toBe("/hel");
		expect(suggestions?.items.map(item => item.value)).toContain("help");
	});

	it("preserves root path suggestions for bare absolute inline slash", async () => {
		const provider = createNoopProvider([{ name: "model", description: "Switch model" }]);
		const line = "open /";
		const suggestions = await provider.getSuggestions([line], 0, line.length);

		expect(suggestions?.prefix).toBe("/");
		expect(suggestions?.items.some(item => item.value.startsWith("/"))).toBe(true);
		expect(suggestions?.items.map(item => item.value)).not.toContain("model");
	});

	it("opens the composer autocomplete list from an adjacent inline slash", async () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setAutocompleteProvider(
			createNoopProvider([{ name: "help", description: "Learn commands and beginner workflows" }]),
		);

		editor.handleInput("please/");
		await Bun.sleep(0);

		expect(editor.isShowingAutocomplete()).toBe(true);
	});

	it("applies adjacent inline slash command completion without replacing prompt text", async () => {
		const provider = createNoopProvider([{ name: "help", description: "Learn commands and beginner workflows" }]);
		const line = "please/hel";
		const suggestions = await provider.getSuggestions([line], 0, line.length);
		const item = suggestions?.items.find(entry => entry.value === "help");
		expect(item).toBeDefined();
		if (!item || !suggestions) {
			throw new Error("expected help suggestion");
		}

		const applied = provider.applyCompletion([line], 0, line.length, item, suggestions.prefix);
		expect(applied.lines[0]).toBe("please/help ");
		expect(applied.cursorCol).toBe("please/help ".length);
	});

	it("passes the typed trigger to undo and leaves text removal to the editor", async () => {
		let undoCalls = 0;
		let undoPrefix = "";
		const provider = createPromptActionAutocompleteProvider({
			commands: [],
			basePath: "/tmp",
			keybindings: AppKeybindingsManager.inMemory(),
			copyCurrentLine: () => {},
			copyPrompt: () => {},
			pasteImage: () => {},
			newSession: () => {},
			showHelp: () => {},
			scrollTmuxToPreviousUserInput: () => {},
			undo: prefix => {
				undoCalls += 1;
				undoPrefix = prefix;
			},
			moveCursorToMessageEnd: () => {},
			moveCursorToMessageStart: () => {},
			moveCursorToLineStart: () => {},
			moveCursorToLineEnd: () => {},
		});

		const suggestions = await provider.getSuggestions(["hello #undo"], 0, 11);
		const item = suggestions?.items.find(entry => entry.label === "Undo");
		expect(item).toBeDefined();
		if (!item || !suggestions) {
			throw new Error("expected undo suggestion");
		}

		const result = provider.applyCompletion(["hello #undo"], 0, 11, item, suggestions.prefix);
		expect(result.lines).toEqual(["hello #undo"]);
		expect(result.cursorLine).toBe(0);
		expect(result.cursorCol).toBe(11);
		result.onApplied?.();
		expect(undoCalls).toBe(1);
		expect(undoPrefix).toBe("#undo");
	});

	it("runs image paste from the prompt action menu", async () => {
		let pasteCalls = 0;
		const provider = createPromptActionAutocompleteProvider({
			commands: [],
			basePath: "/tmp",
			keybindings: AppKeybindingsManager.inMemory({
				"app.clipboard.pasteImage": "ctrl+i",
			}),
			copyCurrentLine: () => {},
			copyPrompt: () => {},
			pasteImage: () => {
				pasteCalls += 1;
			},
			newSession: () => {},
			showHelp: () => {},
			scrollTmuxToPreviousUserInput: () => {},
			undo: () => {},
			moveCursorToMessageEnd: () => {},
			moveCursorToMessageStart: () => {},
			moveCursorToLineStart: () => {},
			moveCursorToLineEnd: () => {},
		});

		const suggestions = await provider.getSuggestions(["please #paste-image"], 0, 19);
		const item = suggestions?.items.find(entry => entry.label === "Paste image from clipboard");
		expect(item).toBeDefined();
		if (!item || !suggestions) {
			throw new Error("expected paste image suggestion");
		}

		const result = provider.applyCompletion(["please #paste-image"], 0, 19, item, suggestions.prefix);
		expect(result.lines).toEqual(["please "]);
		expect(result.cursorLine).toBe(0);
		expect(result.cursorCol).toBe(7);
		result.onApplied?.();
		expect(pasteCalls).toBe(1);
	});

	it("runs new session from the prompt action menu", async () => {
		let newSessionCalls = 0;
		const provider = createPromptActionAutocompleteProvider({
			commands: [],
			basePath: "/tmp",
			keybindings: AppKeybindingsManager.inMemory(),
			copyCurrentLine: () => {},
			copyPrompt: () => {},
			pasteImage: () => {},
			newSession: () => {
				newSessionCalls += 1;
			},
			showHelp: () => {},
			scrollTmuxToPreviousUserInput: () => {},
			undo: () => {},
			moveCursorToMessageEnd: () => {},
			moveCursorToMessageStart: () => {},
			moveCursorToLineStart: () => {},
			moveCursorToLineEnd: () => {},
		});

		const suggestions = await provider.getSuggestions(["#new"], 0, 4);
		const item = suggestions?.items.find(entry => entry.label === "Start new session");
		expect(item).toBeDefined();
		if (!item || !suggestions) {
			throw new Error("expected new session suggestion");
		}

		const result = provider.applyCompletion(["#new"], 0, 4, item, suggestions.prefix);
		expect(result.lines).toEqual([""]);
		result.onApplied?.();
		expect(newSessionCalls).toBe(1);
	});

	it("runs tmux previous-user-input scroll from the prompt action menu", async () => {
		let scrollCalls = 0;
		const provider = createPromptActionAutocompleteProvider({
			commands: [],
			basePath: "/tmp",
			keybindings: AppKeybindingsManager.inMemory(),
			copyCurrentLine: () => {},
			copyPrompt: () => {},
			pasteImage: () => {},
			newSession: () => {},
			showHelp: () => {},
			scrollTmuxToPreviousUserInput: () => {
				scrollCalls += 1;
			},
			undo: () => {},
			moveCursorToMessageEnd: () => {},
			moveCursorToMessageStart: () => {},
			moveCursorToLineStart: () => {},
			moveCursorToLineEnd: () => {},
		});

		const suggestions = await provider.getSuggestions(["please #prev"], 0, 12);
		const item = suggestions?.items.find(entry => entry.label === "Scroll to previous user input");
		expect(item).toBeDefined();
		if (!item || !suggestions) {
			throw new Error("expected tmux previous-user-input suggestion");
		}

		const result = provider.applyCompletion(["please #prev"], 0, 12, item, suggestions.prefix);
		expect(result.lines).toEqual(["please "]);
		expect(result.cursorLine).toBe(0);
		expect(result.cursorCol).toBe(7);
		result.onApplied?.();
		expect(scrollCalls).toBe(1);
	});

	it("falls back to normal typing for literal hashtags with no matching action", async () => {
		const provider = createPromptActionAutocompleteProvider({
			commands: [],
			basePath: "/tmp",
			keybindings: AppKeybindingsManager.inMemory(),
			copyCurrentLine: () => {},
			copyPrompt: () => {},
			pasteImage: () => {},
			newSession: () => {},
			showHelp: () => {},
			scrollTmuxToPreviousUserInput: () => {},
			undo: () => {},
			moveCursorToMessageEnd: () => {},
			moveCursorToMessageStart: () => {},
			moveCursorToLineStart: () => {},
			moveCursorToLineEnd: () => {},
		});

		const suggestions = await provider.getSuggestions(["release #v1"], 0, 11);
		expect(suggestions).toBeNull();
	});

	it("delegates trySyncSlashCompletion to CombinedAutocompleteProvider", () => {
		const provider = createPromptActionAutocompleteProvider({
			commands: [{ name: "model", description: "Switch AI model" }],
			basePath: "/tmp",
			keybindings: AppKeybindingsManager.inMemory(),
			copyCurrentLine: () => {},
			copyPrompt: () => {},
			pasteImage: () => {},
			newSession: () => {},
			showHelp: () => {},
			scrollTmuxToPreviousUserInput: () => {},
			undo: () => {},
			moveCursorToMessageEnd: () => {},
			moveCursorToMessageStart: () => {},
			moveCursorToLineStart: () => {},
			moveCursorToLineEnd: () => {},
		});

		const result = provider.trySyncSlashCompletion("/mo");
		expect(result).not.toBeNull();
		expect(result!.items.map(i => i.value)).toContain("model");
	});

	it("returns null from trySyncSlashCompletion for non-slash text", () => {
		const provider = createPromptActionAutocompleteProvider({
			commands: [{ name: "model", description: "Switch AI model" }],
			basePath: "/tmp",
			keybindings: AppKeybindingsManager.inMemory(),
			copyCurrentLine: () => {},
			copyPrompt: () => {},
			pasteImage: () => {},
			newSession: () => {},
			showHelp: () => {},
			scrollTmuxToPreviousUserInput: () => {},
			undo: () => {},
			moveCursorToMessageEnd: () => {},
			moveCursorToMessageStart: () => {},
			moveCursorToLineStart: () => {},
			moveCursorToLineEnd: () => {},
		});

		expect(provider.trySyncSlashCompletion("hello")).toBeNull();
	});
});
