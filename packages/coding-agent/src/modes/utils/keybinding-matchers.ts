import { getKeybindings, matchesKey } from "@gajae-code/tui";

/**
 * Match the coding-agent interrupt key.
 *
 * Interactive mode installs a keybinding manager that exposes `app.interrupt`
 * globally, but some isolated component tests still run with only TUI
 * keybindings registered. In that case, fall back to raw Escape matching.
 */
export function matchesAppInterrupt(data: string): boolean {
	const keybindings = getKeybindings();
	const interruptKeys = keybindings.getKeys("app.interrupt");
	if (interruptKeys.length > 0) {
		return keybindings.matches(data, "app.interrupt");
	}
	return matchesKey(data, "escape") || matchesKey(data, "esc");
}

export function matchesAppClear(data: string): boolean {
	return getKeybindings().matches(data, "app.clear");
}

export function matchesSelectCancel(data: string): boolean {
	return getKeybindings().matches(data, "tui.select.cancel");
}

export function matchesAppExternalEditor(data: string): boolean {
	const keybindings = getKeybindings();
	const externalEditorKeys = keybindings.getKeys("app.editor.external");
	if (externalEditorKeys.length > 0) {
		return keybindings.matches(data, "app.editor.external");
	}
	return matchesKey(data, "ctrl+g");
}
