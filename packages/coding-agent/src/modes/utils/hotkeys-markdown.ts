import type { AppKeybinding, KeybindingsManager } from "../../config/keybindings";

export interface HotkeysMarkdownBindings {
	keybindings: Pick<KeybindingsManager, "getDisplayString">;
}

function appKey(bindings: HotkeysMarkdownBindings, action: AppKeybinding): string {
	return bindings.keybindings.getDisplayString(action) || "Disabled";
}

export function buildHotkeysMarkdown(bindings: HotkeysMarkdownBindings): string {
	return [
		"**Navigation**",
		"| Key | Action |",
		"|-----|--------|",
		"| `Arrow keys` | Move cursor / browse history (Up when empty) |",
		"| `Option+Left/Right` | Move by word |",
		"| `Ctrl+A` / `Home` / `Cmd+Left` | Start of line |",
		"| `Ctrl+E` / `End` / `Cmd+Right` | End of line |",
		"",
		"**Editing**",
		"| Key | Action |",
		"|-----|--------|",
		"| `Enter` | Send / queue while busy |",
		`| \`${appKey(bindings, "app.message.queue")}\` | Queue message for next turn |`,
		"| `Shift+Enter` / `Ctrl+J` | New line |",
		"| `Ctrl+W` / `Option+Backspace` | Delete word backwards |",
		"| `Ctrl+U` | Delete to start of line |",
		"| `Ctrl+K` | Delete to end of line |",
		`| \`${appKey(bindings, "app.clipboard.copyLine")}\` | Copy current line |`,
		`| \`${appKey(bindings, "app.clipboard.copyPrompt")}\` | Copy whole prompt |`,
		"",
		"**Other**",
		"| Key | Action |",
		"|-----|--------|",
		"| `Tab` | Path completion / accept autocomplete |",
		`| \`${appKey(bindings, "app.interrupt")}\` | Cancel autocomplete / interrupt active work |`,
		`| \`${appKey(bindings, "app.clear")}\` | Clear editor (first) / exit (second) |`,
		`| \`${appKey(bindings, "app.exit")}\` | Exit (when editor is empty) |`,
		`| \`${appKey(bindings, "app.suspend")}\` | Suspend to background |`,
		`| \`${appKey(bindings, "app.thinking.cycle")}\` | Cycle thinking level |`,
		`| \`${appKey(bindings, "app.model.cycleForward")}\` | Cycle configured model roles |`,
		`| \`${appKey(bindings, "app.model.cycleBackward")}\` | Cycle configured model roles temporarily |`,
		`| \`${appKey(bindings, "app.model.selectTemporary")}\` | Select model (temporary) |`,
		`| \`${appKey(bindings, "app.model.select")}\` | Select default model |`,
		`| \`${appKey(bindings, "app.plan.toggle")}\` | Toggle plan mode |`,
		`| \`${appKey(bindings, "app.history.search")}\` | Search prompt history |`,
		`| \`${appKey(bindings, "app.tools.expand")}\` | Toggle tool output expansion |`,
		`| \`${appKey(bindings, "app.tool.backgroundFold")}\` twice | Fold supported foreground bash into a background job |`,
		`| \`${appKey(bindings, "app.thinking.toggle")}\` | Toggle thinking block visibility |`,
		`| \`${appKey(bindings, "app.editor.external")}\` | Edit message in external editor |`,
		`| \`${appKey(bindings, "app.clipboard.pasteImage")}\` | Paste image from clipboard |`,
		`| \`${appKey(bindings, "app.stt.toggle")}\` | Toggle speech-to-text recording |`,
		"| `#` | Open prompt actions |",
		"| `/` | Slash commands |",
		"| `!` | Run bash command |",
		"| `!!` | Run bash command (excluded from context) |",
		"| `$` | Run Python in shared kernel |",
		"| `$$` | Run Python (excluded from context) |",
	].join("\n");
}
