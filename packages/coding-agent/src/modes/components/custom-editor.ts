import { Editor, type KeyId, matchesKey, parseKittySequence } from "@gajae-code/tui";
import { BracketedPasteHandler } from "@gajae-code/tui/bracketed-paste";
import type { AppKeybinding } from "../../config/keybindings";

type ConfigurableEditorAction = Extract<
	AppKeybinding,
	| "app.interrupt"
	| "app.clear"
	| "app.exit"
	| "app.suspend"
	| "app.thinking.cycle"
	| "app.model.cycleForward"
	| "app.model.cycleBackward"
	| "app.model.select"
	| "app.model.selectTemporary"
	| "app.tools.expand"
	| "app.thinking.toggle"
	| "app.editor.external"
	| "app.history.search"
	| "app.message.dequeue"
	| "app.clipboard.pasteImage"
	| "app.clipboard.copyPrompt"
>;

const DEFAULT_ACTION_KEYS: Record<ConfigurableEditorAction, KeyId[]> = {
	"app.interrupt": ["escape"],
	"app.clear": ["ctrl+c"],
	"app.exit": ["ctrl+d"],
	"app.suspend": ["ctrl+z"],
	"app.thinking.cycle": ["shift+tab"],
	"app.model.cycleForward": ["ctrl+p"],
	"app.model.cycleBackward": ["shift+ctrl+p"],
	"app.model.select": ["ctrl+l"],
	"app.model.selectTemporary": ["alt+p"],
	"app.tools.expand": ["ctrl+o"],
	"app.thinking.toggle": ["ctrl+t"],
	"app.editor.external": ["ctrl+g"],
	"app.history.search": ["ctrl+r"],
	"app.message.dequeue": ["alt+up"],
	"app.clipboard.pasteImage": ["ctrl+v"],
	"app.clipboard.copyPrompt": ["alt+shift+c"],
};

const PASTE_DECISION_TIMEOUT_MS = 5_000;
const PENDING_PASTE_INPUT_MAX = 64;

type PastePendingClearReason = "timeout" | "queue-limit";

/**
 * Custom editor that handles configurable app-level shortcuts for coding-agent.
 */
export class CustomEditor extends Editor {
	onEscape?: () => void;
	/**
	 * Optional high-priority interrupt consumer. Invoked when the interrupt key
	 * is pressed, before `onEscape`. Returning `true` consumes the keystroke.
	 * Used so a transient UI (e.g. the btw panel) stays dismissable even while
	 * another controller has temporarily installed its own `onEscape` handler.
	 */
	onInterruptPriority?: () => boolean;
	shouldBypassAutocompleteOnEscape?: () => boolean;
	onClear?: () => void;
	onExit?: () => void;
	onCycleThinkingLevel?: () => void;
	onCycleModelForward?: () => void;
	onCycleModelBackward?: () => void;
	onSelectModel?: () => void;
	onExpandTools?: () => void;
	onToggleThinking?: () => void;
	onExternalEditor?: () => void;
	onHistorySearch?: () => void;
	onSuspend?: () => void;
	onShowHotkeys?: () => void;
	onSelectModelTemporary?: () => void;
	/** Called when the configured copy-prompt shortcut is pressed. */
	onCopyPrompt?: () => void;
	/** Called when the configured image-paste shortcut is pressed. */
	onPasteImage?: () => Promise<boolean>;
	/** Called before bracketed paste content is inserted. Return true to consume it. */
	onPasteText?: (text: string) => boolean | Promise<boolean>;
	/** Called when async paste handling drops queued input instead of replaying it. */
	onPastePendingInputCleared?: (reason: PastePendingClearReason, droppedInputCount: number) => void;
	/** Called when the configured dequeue shortcut is pressed. */
	onDequeue?: () => void;
	/** Called when Caps Lock is pressed. */
	onCapsLock?: () => void;

	/** Custom key handlers from extensions and non-built-in app actions. */
	#customKeyHandlers = new Map<KeyId, () => void>();
	#actionKeys = new Map<ConfigurableEditorAction, KeyId[]>(
		Object.entries(DEFAULT_ACTION_KEYS).map(([action, keys]) => [action as ConfigurableEditorAction, [...keys]]),
	);
	#pasteHandler = new BracketedPasteHandler();
	#pasteDecisionPending = false;
	#pasteDecisionToken = 0;
	#pasteDecisionTimeout: NodeJS.Timeout | undefined;
	#pendingPasteInput: string[] = [];

	setActionKeys(action: ConfigurableEditorAction, keys: KeyId[]): void {
		this.#actionKeys.set(action, [...keys]);
	}

	#matchesAction(data: string, action: ConfigurableEditorAction): boolean {
		const keys = this.#actionKeys.get(action);
		if (!keys) return false;
		for (const key of keys) {
			if (matchesKey(data, key)) return true;
		}
		return false;
	}

	/**
	 * Register a custom key handler. Extensions use this for shortcuts.
	 */
	setCustomKeyHandler(key: KeyId, handler: () => void): void {
		this.#customKeyHandlers.set(key, handler);
	}

	/**
	 * Remove a custom key handler.
	 */
	removeCustomKeyHandler(key: KeyId): void {
		this.#customKeyHandlers.delete(key);
	}

	/**
	 * Clear all custom key handlers.
	 */
	clearCustomKeyHandlers(): void {
		this.#customKeyHandlers.clear();
	}

	#clearPasteDecisionTimeout(): void {
		if (this.#pasteDecisionTimeout) {
			clearTimeout(this.#pasteDecisionTimeout);
			this.#pasteDecisionTimeout = undefined;
		}
	}

	#clearPendingPasteState(): number {
		this.#clearPasteDecisionTimeout();
		this.#pasteDecisionPending = false;
		this.#pasteDecisionToken += 1;
		const droppedInputCount = this.#pendingPasteInput.length;
		this.#pendingPasteInput = [];
		return droppedInputCount;
	}

	#startPasteDecisionTimeout(token: number): void {
		this.#clearPasteDecisionTimeout();
		this.#pasteDecisionTimeout = setTimeout(() => {
			if (token !== this.#pasteDecisionToken) return;
			const droppedInputCount = this.#clearPendingPasteState();
			this.onPastePendingInputCleared?.("timeout", droppedInputCount);
		}, PASTE_DECISION_TIMEOUT_MS);
		this.#pasteDecisionTimeout.unref?.();
	}

	dispose(): void {
		this.#clearPendingPasteState();
		this.#pasteHandler = new BracketedPasteHandler();
	}

	#drainPendingPasteInput(initialInput?: string): void {
		if (initialInput && initialInput.length > 0) {
			this.handleInput(initialInput);
		}
		while (!this.#pasteDecisionPending) {
			const nextInput = this.#pendingPasteInput.shift();
			if (nextInput === undefined) break;
			this.handleInput(nextInput);
		}
	}

	#handleBracketedPaste(pasteContent: string, remaining: string): void {
		const applyPasteResult = (token: number, handled: boolean | undefined) => {
			if (token !== this.#pasteDecisionToken) return;
			this.#clearPasteDecisionTimeout();
			if (!handled) {
				super.handleInput(`\x1b[200~${pasteContent}\x1b[201~`);
			}
			this.#pasteDecisionPending = false;
			this.#drainPendingPasteInput(remaining);
		};
		const pasteResult = this.onPasteText?.(pasteContent);

		if (pasteResult instanceof Promise) {
			const token = this.#pasteDecisionToken + 1;
			this.#pasteDecisionToken = token;
			this.#pasteDecisionPending = true;
			this.#startPasteDecisionTimeout(token);
			void pasteResult.then(
				handled => applyPasteResult(token, handled),
				() => applyPasteResult(token, false),
			);
		} else {
			applyPasteResult(this.#pasteDecisionToken, pasteResult);
		}
	}

	handleInput(data: string): void {
		if (this.#pasteDecisionPending) {
			this.#pendingPasteInput.push(data);
			if (this.#pendingPasteInput.length > PENDING_PASTE_INPUT_MAX) {
				const droppedInputCount = this.#clearPendingPasteState();
				this.onPastePendingInputCleared?.("queue-limit", droppedInputCount);
			}
			return;
		}

		const parsed = parseKittySequence(data);
		if (parsed && (parsed.modifier & 64) !== 0 && this.onCapsLock) {
			// Caps Lock is modifier bit 64
			this.onCapsLock();
			return;
		}

		if (this.onPasteText) {
			const paste = this.#pasteHandler.process(data);
			if (paste.handled) {
				if (paste.pasteContent !== undefined) {
					this.#handleBracketedPaste(paste.pasteContent, paste.remaining);
				}
				return;
			}
		}
		// Intercept configured image paste (async - fires and handles result)
		if (this.#matchesAction(data, "app.clipboard.pasteImage") && this.onPasteImage) {
			void this.onPasteImage();
			return;
		}

		// Intercept configured external editor shortcut
		if (this.#matchesAction(data, "app.editor.external") && this.onExternalEditor) {
			this.onExternalEditor();
			return;
		}

		// Intercept configured temporary model selector shortcut
		if (this.#matchesAction(data, "app.model.selectTemporary") && this.onSelectModelTemporary) {
			this.onSelectModelTemporary();
			return;
		}

		// Intercept configured suspend shortcut
		if (this.#matchesAction(data, "app.suspend") && this.onSuspend) {
			this.onSuspend();
			return;
		}

		// Intercept configured thinking block visibility toggle
		if (this.#matchesAction(data, "app.thinking.toggle") && this.onToggleThinking) {
			this.onToggleThinking();
			return;
		}

		// Intercept configured model selector shortcut
		if (this.#matchesAction(data, "app.model.select") && this.onSelectModel) {
			this.onSelectModel();
			return;
		}

		// Intercept configured history search shortcut
		if (this.#matchesAction(data, "app.history.search") && this.onHistorySearch) {
			this.onHistorySearch();
			return;
		}

		// Intercept configured tool output expansion shortcut
		if (this.#matchesAction(data, "app.tools.expand") && this.onExpandTools) {
			this.onExpandTools();
			return;
		}

		// Intercept configured backward model cycling (check before forward cycling)
		if (this.#matchesAction(data, "app.model.cycleBackward") && this.onCycleModelBackward) {
			this.onCycleModelBackward();
			return;
		}

		// Intercept configured forward model cycling
		if (this.#matchesAction(data, "app.model.cycleForward") && this.onCycleModelForward) {
			this.onCycleModelForward();
			return;
		}

		// Intercept configured thinking level cycling
		if (this.#matchesAction(data, "app.thinking.cycle") && this.onCycleThinkingLevel) {
			this.onCycleThinkingLevel();
			return;
		}

		// Intercept configured interrupt shortcut.
		// Default behavior keeps autocomplete dismissal, but parent can prioritize global interrupt handling.
		if (this.#matchesAction(data, "app.interrupt")) {
			if (!this.isShowingAutocomplete() || this.shouldBypassAutocompleteOnEscape?.()) {
				// A priority interrupt consumer (e.g. an open btw panel) must win over any
				// transient onEscape handler other controllers install (auto-compaction,
				// auto-retry, manual compaction, etc.) so dismissal stays wired regardless
				// of which handler currently owns onEscape.
				if (this.onInterruptPriority?.()) {
					return;
				}
				if (this.onEscape) {
					this.onEscape();
					return;
				}
			}
		}

		// Intercept configured clear shortcut
		if (this.#matchesAction(data, "app.clear") && this.onClear) {
			this.onClear();
			return;
		}

		// Intercept configured exit shortcut. Always consume the shortcut so it
		// never reaches the parent handler; firing onExit is the controller's
		// chance to snapshot the current text as a draft before shutting down.
		if (this.#matchesAction(data, "app.exit")) {
			this.onExit?.();
			return;
		}

		// Intercept configured dequeue shortcut (restore queued message to editor)
		if (this.#matchesAction(data, "app.message.dequeue") && this.onDequeue) {
			this.onDequeue();
			return;
		}

		// Intercept configured copy-prompt shortcut
		if (this.#matchesAction(data, "app.clipboard.copyPrompt") && this.onCopyPrompt) {
			this.onCopyPrompt();
			return;
		}

		// Intercept ? when editor is empty to show hotkeys
		if (data === "?" && this.getText().length === 0 && this.onShowHotkeys) {
			this.onShowHotkeys();
			return;
		}

		// Check custom key handlers (extensions)
		for (const [keyId, handler] of this.#customKeyHandlers) {
			if (matchesKey(data, keyId)) {
				handler();
				return;
			}
		}

		// Pass to parent for normal handling
		super.handleInput(data);
	}
}
