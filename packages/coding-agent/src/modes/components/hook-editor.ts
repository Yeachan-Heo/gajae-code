/**
 * Multi-line editor component for hooks and ask custom input.
 * Supports Ctrl+G for external editor.
 *
 * Two modes:
 * - Default (hook): Enter inserts newline, Ctrl+Enter submits, bordered popup
 * - Prompt-style (ask): Enter submits, Shift+Enter inserts newline, legacy ask chrome
 */
import { Container, Editor, matchesKey, Spacer, Text, type TUI } from "@gajae-code/tui";
import { getEditorTheme, theme } from "../../modes/theme/theme";
import { matchesAppExternalEditor, matchesAppInterrupt } from "../../modes/utils/keybinding-matchers";
import { getEditorCommand, openInEditor } from "../../utils/external-editor";
import { DynamicBorder } from "./dynamic-border";

export interface HookEditorOptions {
	/** When true, use prompt-style keybindings with the legacy ask prompt chrome. */
	promptStyle?: boolean;
}

function isWindowsRawLfNewlineInput(keyData: string): boolean {
	return process.platform === "win32" && keyData === "\n";
}

export class HookEditorComponent extends Container {
	#editor: Editor;
	#onSubmitCallback: (value: string) => void;
	#onCancelCallback: () => void;
	#tui: TUI;
	#promptStyle: boolean;

	constructor(
		tui: TUI,
		title: string,
		prefill: string | undefined,
		onSubmit: (value: string) => void,
		onCancel: () => void,
		options?: HookEditorOptions,
	) {
		super();

		this.#tui = tui;
		this.#onSubmitCallback = onSubmit;
		this.#onCancelCallback = onCancel;
		this.#promptStyle = options?.promptStyle ?? false;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		// Title
		this.addChild(new Text(theme.fg("accent", title), 1, 0));
		this.addChild(new Spacer(1));

		// Editor
		this.#editor = new Editor(getEditorTheme());
		if (this.#promptStyle) {
			this.#editor.setBorderVisible(false);
			this.#editor.setPromptGutter("> ");
			this.#editor.disableSubmit = true;
		}
		if (prefill) {
			this.#editor.setText(prefill);
		}
		this.addChild(this.#editor);

		this.addChild(new Spacer(1));

		// Hint
		const hint = this.#promptStyle
			? "enter submit  shift+enter/ctrl+j newline  esc cancel  ctrl+g external editor"
			: "ctrl+enter submit  esc cancel  ctrl+g external editor";
		this.addChild(new Text(theme.fg("dim", hint), 1, 0));

		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	handleInput(keyData: string): void {
		if (this.#promptStyle) {
			this.#handlePromptStyleInput(keyData);
		} else {
			this.#handleHookStyleInput(keyData);
		}
	}

	/** Prompt-style: raw Enter submits; Editor owns newline-producing sequences. */
	#handlePromptStyleInput(keyData: string): void {
		// Prompt-style keeps Escape as an explicit cancel key and also honors app.interrupt remaps.
		if (matchesKey(keyData, "escape") || matchesKey(keyData, "esc") || matchesAppInterrupt(keyData)) {
			this.#onCancelCallback();
			return;
		}

		// Ctrl+G for external editor
		if (matchesAppExternalEditor(keyData)) {
			void this.#openExternalEditor();
			return;
		}

		// Submit on plain Enter encodings. On Windows, raw LF is reserved for terminal
		// newline mappings (Shift+Enter/Ctrl+J/Ctrl+Enter); plain Enter reports CR.
		if (!isWindowsRawLfNewlineInput(keyData) && (matchesKey(keyData, "enter") || matchesKey(keyData, "return"))) {
			this.#onSubmitCallback(this.#editor.getText());
			return;
		}

		// Let Editor handle modified newline-producing variants (Shift+Enter, Ctrl+Enter, Alt+Enter, etc.)
		this.#editor.handleInput(keyData);
	}

	/** Hook-style: Enter=newline, Ctrl+Enter=submit (original behavior) */
	#handleHookStyleInput(keyData: string): void {
		// Ctrl+Enter to submit. Use key matching so lock-key and keypad Enter variants work.
		if (matchesKey(keyData, "ctrl+enter")) {
			this.#onSubmitCallback(this.#editor.getText());
			return;
		}

		// Plain Enter inserts a new line in hook editor
		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			this.#editor.handleInput("\n");
			return;
		}

		// Escape to cancel
		if (matchesAppInterrupt(keyData)) {
			this.#onCancelCallback();
			return;
		}

		// Ctrl+G for external editor
		if (matchesAppExternalEditor(keyData)) {
			void this.#openExternalEditor();
			return;
		}

		// Forward to editor
		this.#editor.handleInput(keyData);
	}

	async #openExternalEditor(): Promise<void> {
		const editorCmd = getEditorCommand();
		if (!editorCmd) return;

		const currentText = this.#editor.getExpandedText();
		try {
			this.#tui.stop();
			const result = await openInEditor(editorCmd, currentText);
			if (result !== null) {
				this.#editor.setText(result);
			}
		} finally {
			this.#tui.start();
			this.#tui.requestRender(true);
		}
	}
}
