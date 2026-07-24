import { describe, expect, it } from "bun:test";
import { formatAccessibleKeyHint, KeybindingsManager } from "../../../src/config/keybindings";
import { buildHelpMarkdown } from "../../../src/modes/controllers/command-controller";
import { buildHotkeysMarkdown, formatHotkeyMarkdownCode } from "../../../src/modes/utils/hotkeys-markdown";

const formatFixedKey = (key: string): string => formatAccessibleKeyHint(key);

describe("buildHotkeysMarkdown", () => {
	it("emits flush-left markdown and uses the configured temporary selector hint", () => {
		const displayStrings: Record<string, string> = {
			"app.clipboard.copyLine": "⌃⇧L",
			"app.clipboard.copyPrompt": "⌃⇧P",
			"app.message.queue": "⌥↩",
			"app.plan.toggle": "⌥M",
			"app.tools.expand": "⌃O",
			"app.interrupt": "⎋",
			"app.clear": "⌃C",
			"app.exit": "⌃D",
			"app.suspend": "⌃Z",
			"app.session.new": "⌃N",
			"app.thinking.cycle": "⇧⇥",
			"app.commandPalette.open": "⌃P",
			"app.model.cycleForward": "⌥N",
			"app.model.cycleBackward": "⌥⇧N",
			"app.model.selectTemporary": "⌃⇧L",
			"app.model.select": "⌃L",
			"app.history.search": "⌃R",
			"app.thinking.toggle": "⌃T",
			"app.editor.external": "⌃G",
			"app.clipboard.pasteImage": "⌃V",
			"app.stt.toggle": "⌥H",
			"tui.editor.cursorUp": "↑",
			"tui.editor.cursorDown": "↓",
			"tui.editor.cursorWordLeft": "⌥←",
			"tui.editor.cursorWordRight": "⌥→",
			"tui.editor.cursorLineStart": "Home/⌃A",
			"tui.editor.cursorLineEnd": "End/⌃E",
			"tui.input.submit": "↩",
			"tui.input.newLine": "⇧↩",
			"tui.editor.deleteWordBackward": "⌃W/⌥⌫",
			"tui.editor.deleteToLineStart": "⌃U",
			"tui.editor.deleteToLineEnd": "⌃K",
			"tui.input.tab": "⇥",
		};
		const markdown = buildHotkeysMarkdown({
			keybindings: {
				formatAccessibleKeyHint: formatFixedKey,
				getAccessibleDisplayString(action) {
					return displayStrings[action] ?? "Disabled";
				},
			},
		});

		const lines = markdown.split("\n");
		expect(lines[0]).toBe("**Navigation**");
		expect(markdown).toContain("| `⌃⇧P` | Copy whole prompt |");
		expect(markdown).toContain("| `↩` | Send / queue while busy |");
		expect(markdown).toContain("| `⌥↩` | Queue message for next turn |");
		expect(markdown).toContain(`| \`⇧↩/${formatFixedKey("ctrl+j")}\` | New line |`);
		expect(markdown).toContain("| `⌃⇧L` | Select model (temporary) |");
		expect(markdown).toContain("| `⌃L` | Select default model |");
		expect(markdown).toContain("| `⌥M` | Toggle plan mode |");
		expect(markdown).toContain("| `⌃N` | Start a fresh session |");
		expect(markdown).toContain("| `⌃P` | Open command palette |");
		expect(markdown).toContain("| `#` | Prompt actions (command-palette style actions) |");
		for (const line of lines) {
			if (line.length === 0) continue;
			expect(line.startsWith(" ")).toBe(false);
			expect(line.startsWith("\t")).toBe(false);
		}
	});

	it("keeps the editor Ctrl+J newline path visible after remapping or unbinding the configured action", () => {
		const render = (newLine: string): string =>
			buildHotkeysMarkdown({
				keybindings: {
					formatAccessibleKeyHint: formatFixedKey,
					getAccessibleDisplayString(action) {
						return action === "tui.input.newLine" ? newLine : "Ctrl+K";
					},
				},
			});

		expect(render("Alt+Enter")).toContain(`| \`Alt+Enter/${formatFixedKey("ctrl+j")}\` | New line |`);
		expect(render("")).toContain(`| \`Disabled/${formatFixedKey("ctrl+j")}\` | New line |`);
	});
	it("keeps fixed editor line navigation chords after remapping or unbinding without duplicate labels", () => {
		const defaults = KeybindingsManager.inMemory();
		defaults.setDisplayContext({ platform: "darwin" });
		const defaultMarkdown = buildHotkeysMarkdown({ keybindings: defaults });

		expect(defaultMarkdown).toContain("| `Home/⌃A (Control+A)` | Start of line |");
		expect(defaultMarkdown).toContain("| `End/⌃E (Control+E)` | End of line |");
		expect(defaultMarkdown).not.toContain("⌃A (Control+A)/⌃A (Control+A)");
		expect(defaultMarkdown).not.toContain("⌃E (Control+E)/⌃E (Control+E)");

		const customized = KeybindingsManager.inMemory({
			"tui.editor.cursorLineStart": "alt+a",
			"tui.editor.cursorLineEnd": [],
		});
		customized.setDisplayContext({ platform: "darwin" });
		const customizedMarkdown = buildHotkeysMarkdown({ keybindings: customized });

		expect(customizedMarkdown).toContain("| `⌥A (Option+A)/⌃A (Control+A)` | Start of line |");
		expect(customizedMarkdown).toContain("| `Disabled/⌃E (Control+E)` | End of line |");
	});

	it("uses injected Darwin labels while keeping fixed editor delete chords after remapping", () => {
		const keybindings = KeybindingsManager.inMemory({
			"tui.editor.deleteWordBackward": "ctrl+x",
			"tui.editor.deleteToLineStart": "ctrl+y",
			"tui.editor.deleteToLineEnd": "ctrl+z",
		});
		keybindings.setDisplayContext({ platform: "darwin" });

		const markdown = buildHotkeysMarkdown({ keybindings });

		expect(markdown).toContain("| `⇧↩ (Shift+Enter)/⌃J (Control+J)` | New line |");
		expect(markdown).toContain("| `⌃W (Control+W)/⌥⌫ (Option+Backspace)` | Delete word backwards |");
		expect(markdown).toContain("| `⌃U (Control+U)` | Delete to start of line |");
		expect(markdown).toContain("| `⌃K (Control+K)` | Delete to end of line |");
		expect(markdown).not.toContain("| `⌃X (Control+X)` | Delete word backwards |");
		expect(markdown).not.toContain("| `⌃Y (Control+Y)` | Delete to start of line |");
		expect(markdown).not.toContain("| `⌃Z (Control+Z)` | Delete to end of line |");
	});
	it("renders configured and fixed Darwin chords with accessible dual labels", () => {
		const keybindings = KeybindingsManager.inMemory({
			"app.model.select": ["ctrl+l", "shift+tab"],
		});
		keybindings.setDisplayContext({ platform: "darwin" });

		const markdown = buildHotkeysMarkdown({ keybindings });

		expect(markdown).toContain("| `⌃L (Control+L)/⇧⇥ (Shift+Tab)` | Select default model |");
		expect(markdown).toContain("| `⇧↩ (Shift+Enter)/⌃J (Control+J)` | New line |");
		expect(markdown).toContain("| `⌃W (Control+W)/⌥⌫ (Option+Backspace)` | Delete word backwards |");
	});
	it("escapes Markdown metacharacters in dynamic table labels", () => {
		const markdown = buildHotkeysMarkdown({
			keybindings: {
				formatAccessibleKeyHint: formatFixedKey,
				getAccessibleDisplayString(action) {
					if (action === "tui.input.submit") return "Ctrl+|";
					if (action === "app.message.queue") return "`";
					if (action === "app.message.dequeue") return "\\";
					return "Ctrl+K";
				},
			},
		});

		expect(markdown).toContain("| `Ctrl+\\|` | Send / queue while busy |");
		expect(markdown).toContain("| `` ` `` | Queue message for next turn |");
		expect(markdown).toContain("| `\\` | Select queued message to edit |");
		expect(formatHotkeyMarkdownCode("``")).toBe("``` `` ```");
	});

	it("renders the temporary selector row as disabled when no display string is configured", () => {
		const markdown = buildHotkeysMarkdown({
			keybindings: {
				formatAccessibleKeyHint: formatFixedKey,
				getAccessibleDisplayString(action) {
					if (action === "app.model.selectTemporary") {
						return "";
					}
					if (action === "app.model.select") {
						return "Ctrl+L";
					}
					return "Ctrl+K";
				},
			},
		});

		expect(markdown).toContain("| `Disabled` | Select model (temporary) |");
		expect(markdown).toContain("| `Ctrl+L` | Select default model |");
	});
});

describe("buildHelpMarkdown", () => {
	it("advertises effective submit and tab bindings for autocomplete confirmation", () => {
		const requestedActions: string[] = [];
		const markdown = buildHelpMarkdown({
			getAccessibleDisplayString(action) {
				requestedActions.push(action);
				if (action === "tui.input.submit") return "Ctrl+Enter";
				if (action === "tui.input.tab") return "";
				if (action === "tui.select.up") return "Ctrl+|";
				if (action === "tui.select.down") return "\\";
				if (action === "app.session.new") return "Alt+`";
				return "Ctrl+M";
			},
		});

		expect(markdown).toContain("then use `Ctrl+|/\\` and `Ctrl+Enter/Disabled`.");
		expect(markdown).toContain("| Start a fresh session | `` Alt+` `` or `/new` |");
		expect(requestedActions).not.toContain("tui.select.confirm");
	});
	it("uses accessible Darwin labels for help shortcuts", () => {
		const keybindings = KeybindingsManager.inMemory({
			"app.session.new": "shift+tab",
			"app.model.select": "ctrl+l",
			"tui.select.up": ["ctrl+l", "shift+tab"],
		});
		keybindings.setDisplayContext({ platform: "darwin" });

		const markdown = buildHelpMarkdown(keybindings);

		expect(markdown).toContain("| Start a fresh session | `⇧⇥ (Shift+Tab)` or `/new` |");
		expect(markdown).toContain("| Select a model | `/model` or `⌃L (Control+L)` |");
		expect(markdown).toContain("then use `⌃L (Control+L)/⇧⇥ (Shift+Tab)/↓ (Down)` and `↩ (Enter)/⇥ (Tab)`.");
	});
});
