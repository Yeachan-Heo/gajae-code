import type { Keybinding } from "@gajae-code/tui";
import type { AppKeybinding, KeybindingsManager } from "../../config/keybindings";

export interface HotkeysMarkdownBindings {
	keybindings: Pick<KeybindingsManager, "formatAccessibleKeyHint" | "getAccessibleDisplayString">;
}

function key(bindings: HotkeysMarkdownBindings, action: Keybinding): string {
	return bindings.keybindings.getAccessibleDisplayString(action) || "Disabled";
}

function appKey(bindings: HotkeysMarkdownBindings, action: AppKeybinding): string {
	return key(bindings, action);
}

export function formatHotkeyMarkdownCode(label: string, escapeTablePipes = true): string {
	const escaped = escapeTablePipes ? label.replace(/\|/g, "\\|") : label;
	let longestBacktickRun = 0;
	for (const match of escaped.matchAll(/`+/g)) {
		longestBacktickRun = Math.max(longestBacktickRun, match[0].length);
	}
	const fence = "`".repeat(longestBacktickRun + 1);
	const padding = escaped.startsWith("`") || escaped.endsWith("`") ? " " : "";
	return `${fence}${padding}${escaped}${padding}${fence}`;
}

export function buildHotkeysMarkdown(bindings: HotkeysMarkdownBindings): string {
	const displayKey = (action: Keybinding): string => formatHotkeyMarkdownCode(key(bindings, action));
	const displayAppKey = (action: AppKeybinding): string => formatHotkeyMarkdownCode(appKey(bindings, action));
	const displayKeys = (...labels: string[]): string => formatHotkeyMarkdownCode(labels.join("/"));
	const formatFixedKey = (key: string): string => bindings.keybindings.formatAccessibleKeyHint(key);
	const displayKeyWithFixed = (action: Keybinding, fixedKey: string): string => {
		const configured = key(bindings, action);
		const fixed = formatFixedKey(fixedKey);
		const labels = configured.split("/");
		if (!labels.includes(fixed)) labels.push(fixed);
		return displayKeys(...labels);
	};

	return [
		"**Navigation**",
		"| Key | Action |",
		"|-----|--------|",
		`| ${displayKeys(key(bindings, "tui.editor.cursorUp"), key(bindings, "tui.editor.cursorDown"))} | Move cursor / browse history (Up when empty) |`,
		`| ${displayKeys(key(bindings, "tui.editor.cursorWordLeft"), key(bindings, "tui.editor.cursorWordRight"))} | Move by word |`,
		`| ${displayKeyWithFixed("tui.editor.cursorLineStart", "ctrl+a")} | Start of line |`,
		`| ${displayKeyWithFixed("tui.editor.cursorLineEnd", "ctrl+e")} | End of line |`,
		"",
		"**Editing**",
		"| Key | Action |",
		"|-----|--------|",
		`| ${displayKey("tui.input.submit")} | Send / queue while busy |`,
		`| ${displayAppKey("app.message.queue")} | Queue message for next turn |`,
		`| ${displayAppKey("app.message.dequeue")} | Select queued message to edit |`,
		`| ${displayKeys(key(bindings, "tui.input.newLine"), formatFixedKey("ctrl+j"))} | New line |`,
		`| ${displayKeys(formatFixedKey("ctrl+w"), formatFixedKey("alt+backspace"))} | Delete word backwards |`,
		`| ${displayKeys(formatFixedKey("ctrl+u"))} | Delete to start of line |`,
		`| ${displayKeys(formatFixedKey("ctrl+k"))} | Delete to end of line |`,
		`| ${displayAppKey("app.clipboard.copyLine")} | Copy current line |`,
		`| ${displayAppKey("app.clipboard.copyPrompt")} | Copy whole prompt |`,
		"",
		"**Other**",
		"| Key | Action |",
		"|-----|--------|",
		`| ${displayKey("tui.input.tab")} | Path completion / accept autocomplete |`,
		`| ${displayAppKey("app.interrupt")} | Cancel autocomplete / interrupt active work |`,
		`| ${displayAppKey("app.clear")} | Clear editor (first) / exit (second) |`,
		`| ${displayAppKey("app.exit")} | Exit (when editor is empty) |`,
		`| ${displayAppKey("app.suspend")} | Suspend to background |`,
		`| ${displayAppKey("app.commandPalette.open")} | Open command palette |`,
		`| ${displayAppKey("app.session.new")} | Start a fresh session |`,
		`| ${displayAppKey("app.thinking.cycle")} | Cycle thinking level |`,
		`| ${displayAppKey("app.model.cycleForward")} | Cycle configured model roles |`,
		`| ${displayAppKey("app.model.cycleBackward")} | Cycle configured model roles temporarily |`,
		`| ${displayAppKey("app.model.selectTemporary")} | Select model (temporary) |`,
		`| ${displayAppKey("app.model.select")} | Select default model |`,
		`| ${displayAppKey("app.plan.toggle")} | Toggle plan mode |`,
		`| ${displayAppKey("app.history.search")} | Search prompt history |`,
		`| ${displayAppKey("app.tools.expand")} | Toggle tool output expansion |`,
		`| ${displayAppKey("app.tool.backgroundFold")} twice | Fold supported foreground bash into a background job |`,
		`| ${displayAppKey("app.thinking.toggle")} | Toggle thinking block visibility |`,
		`| ${displayAppKey("app.editor.external")} | Edit message in external editor |`,
		`| ${displayAppKey("app.clipboard.pasteImage")} | Paste image from clipboard |`,
		`| ${displayAppKey("app.stt.toggle")} | Toggle speech-to-text recording |`,
		`| ${displayAppKey("app.irc.sidebar.toggle")} | Toggle IRC sidebar |`,
		"| `?` | Show help / shortcuts |",
		"| `#` | Prompt actions (command-palette style actions) |",
		"| `/` | Slash commands (try `/help` or `/new`) |",
		"| `!` | Run bash command |",
		"| `!!` | Run bash command (excluded from context) |",
		"| `$` | Run Python in shared kernel |",
		"| `$$` | Run Python (excluded from context) |",
	].join("\n");
}
