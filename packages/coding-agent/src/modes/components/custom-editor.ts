import { Editor, type KeyId, matchesKey, parseKittySequence } from "@gajae-code/tui";
import { BracketedPasteHandler } from "@gajae-code/tui/bracketed-paste";
import { type AppKeybinding, KEYBINDINGS } from "../../config/keybindings";

type ConfigurableEditorAction = Extract<
	AppKeybinding,
	| "app.interrupt"
	| "app.clear"
	| "app.exit"
	| "app.suspend"
	| "app.thinking.cycle"
	| "app.commandPalette.open"
	| "app.model.cycleForward"
	| "app.model.cycleBackward"
	| "app.model.select"
	| "app.model.selectTemporary"
	| "app.tools.expand"
	| "app.thinking.toggle"
	| "app.editor.external"
	| "app.history.search"
	| "app.message.dequeue"
	| "app.message.followUp"
	| "app.message.queue"
	| "app.clipboard.pasteImage"
	| "app.clipboard.copyPrompt"
>;

// Editor-configurable app actions. Defaults are derived from the central
// KEYBINDINGS registry so there is a single source of truth (e.g. the
// platform-aware app.clipboard.pasteImage default is not duplicated here).
const CONFIGURABLE_EDITOR_ACTIONS = [
	"app.interrupt",
	"app.clear",
	"app.exit",
	"app.suspend",
	"app.thinking.cycle",
	"app.commandPalette.open",
	"app.model.cycleForward",
	"app.model.cycleBackward",
	"app.model.select",
	"app.model.selectTemporary",
	"app.tools.expand",
	"app.thinking.toggle",
	"app.editor.external",
	"app.history.search",
	"app.message.followUp",
	"app.message.queue",
	"app.message.dequeue",
	"app.clipboard.pasteImage",
	"app.clipboard.copyPrompt",
] as const satisfies readonly ConfigurableEditorAction[];

const DEFAULT_ACTION_KEYS = Object.fromEntries(
	CONFIGURABLE_EDITOR_ACTIONS.map(action => {
		const defaultKeys = KEYBINDINGS[action].defaultKeys;
		return [action, Array.isArray(defaultKeys) ? [...defaultKeys] : [defaultKeys]];
	}),
) as Record<ConfigurableEditorAction, KeyId[]>;

const PASTE_DECISION_TIMEOUT_MS = 5_000;
const PENDING_PASTE_INPUT_MAX = 64;
const PENDING_PASTE_INPUT_MAX_BYTES = 256 * 1024;

type PastePendingClearReason = "timeout" | "queue-limit";

export interface PasteTextContext {
	readonly signal: AbortSignal;
	/** Run one synchronous composer mutation only while this paste transaction is current. */
	commit(commit: () => boolean): boolean;
}

interface PendingPasteDecision {
	readonly controller: AbortController;
	readonly pasteContent: string;
	readonly remaining: string;
}

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
	onOpenCommandPalette?: () => void;
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
	onPasteText?: (text: string, context: PasteTextContext) => boolean | Promise<boolean>;
	/** Called when pending paste handling is cancelled after restoring queued input. */
	onPastePendingInputCleared?: (reason: PastePendingClearReason, restoredInputCount: number) => void;
	/** Called when the configured dequeue shortcut is pressed. */
	onDequeue?: () => void;
	/** Called when the configured queue shortcut is pressed. */
	onQueue?: () => void;
	/** Called when Caps Lock is pressed. */
	onCapsLock?: () => void;
	/** Called when PageUp/PageDown should scroll the transcript viewport instead of prompt history. */
	onViewportPageScroll?: (direction: -1 | 1) => void;
	/** Called before regular composer input should return the transcript viewport to the live bottom. */
	onViewportFollowLive?: () => void;

	/** Custom key handlers from extensions and non-built-in app actions. */
	#customKeyHandlers = new Map<KeyId, () => boolean | undefined>();
	#actionKeys = new Map<ConfigurableEditorAction, KeyId[]>(
		Object.entries(DEFAULT_ACTION_KEYS).map(([action, keys]) => [action as ConfigurableEditorAction, [...keys]]),
	);
	#pasteHandler = new BracketedPasteHandler();
	#pasteDecisionPending = false;
	#pasteDecisionToken = 0;
	#pasteDecisionTimeout: NodeJS.Timeout | undefined;
	#pendingPasteDecision: PendingPasteDecision | undefined;
	#pendingPasteInput: string[] = [];
	#pendingPasteInputBytes = 0;

	setActionKeys(action: ConfigurableEditorAction, keys: KeyId[]): void {
		this.#actionKeys.set(action, [...keys]);
	}

	/** Returns whether a built-in editor action consumes this configured key before custom handlers. */
	hasActionKey(key: KeyId): boolean {
		return [...this.#actionKeys.values()].some(keys => keys.includes(key));
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
	setCustomKeyHandler(key: KeyId, handler: () => boolean | undefined): void {
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

	#resetPendingPasteState(abortReason?: Error): string[] {
		this.#clearPasteDecisionTimeout();
		if (abortReason) this.#pendingPasteDecision?.controller.abort(abortReason);
		this.#pasteDecisionPending = false;
		this.#pasteDecisionToken += 1;
		this.#pendingPasteDecision = undefined;
		const queuedInput = this.#pendingPasteInput;
		this.#pendingPasteInput = [];
		this.#pendingPasteInputBytes = 0;
		return queuedInput;
	}

	#pendingPasteEventCount(): number {
		return this.#pendingPasteInput.length + (this.#pendingPasteDecision?.remaining ? 1 : 0);
	}

	#restoreCancelledPaste(reason: PastePendingClearReason, overflowInput?: string): void {
		const decision = this.#pendingPasteDecision;
		const queuedInput = this.#resetPendingPasteState(new Error(`Paste handling cancelled: ${reason}`));
		if (decision) {
			super.handleInput(`\x1b[200~${decision.pasteContent}\x1b[201~`);
			this.#drainPendingPasteInput(decision.remaining, queuedInput);
			if (overflowInput !== undefined) this.handleInput(overflowInput);
		}
		this.onPastePendingInputCleared?.(
			reason,
			queuedInput.length + (decision?.remaining ? 1 : 0) + (overflowInput === undefined ? 0 : 1),
		);
	}

	#startPasteDecisionTimeout(token: number): void {
		this.#clearPasteDecisionTimeout();
		this.#pasteDecisionTimeout = setTimeout(() => {
			if (token !== this.#pasteDecisionToken) return;
			this.#restoreCancelledPaste("timeout");
		}, PASTE_DECISION_TIMEOUT_MS);
		this.#pasteDecisionTimeout.unref?.();
	}

	dispose(): void {
		this.#resetPendingPasteState(new Error("Editor disposed during paste handling"));
		this.#pasteHandler = new BracketedPasteHandler();
		super.dispose();
	}

	#drainPendingPasteInput(initialInput: string | undefined, queuedInput: readonly string[]): void {
		if (initialInput && initialInput.length > 0) {
			this.handleInput(initialInput);
		}
		for (const input of queuedInput) {
			this.handleInput(input);
		}
	}

	#handleBracketedPaste(pasteContent: string, remaining: string): void {
		const remainingBytes = Buffer.byteLength(remaining);
		if (remainingBytes > PENDING_PASTE_INPUT_MAX_BYTES) {
			super.handleInput(`\x1b[200~${pasteContent}\x1b[201~`);
			if (remaining.length > 0) this.handleInput(remaining);
			this.onPastePendingInputCleared?.("queue-limit", 1);
			return;
		}
		const token = this.#pasteDecisionToken + 1;
		const controller = new AbortController();
		this.#pasteDecisionToken = token;
		this.#pasteDecisionPending = true;
		this.#pendingPasteDecision = { controller, pasteContent, remaining };
		this.#pendingPasteInputBytes = remainingBytes;
		let commitUsed = false;

		const applyPasteResult = (handled: boolean | undefined) => {
			if (token !== this.#pasteDecisionToken) return;
			const queuedInput = this.#resetPendingPasteState();
			if (!handled) {
				super.handleInput(`\x1b[200~${pasteContent}\x1b[201~`);
			}
			this.#drainPendingPasteInput(remaining, queuedInput);
		};

		let pasteResult: boolean | Promise<boolean> | undefined;
		try {
			pasteResult = this.onPasteText?.(pasteContent, {
				signal: controller.signal,
				commit: commit => {
					if (
						commitUsed ||
						token !== this.#pasteDecisionToken ||
						!this.#pasteDecisionPending ||
						controller.signal.aborted
					) {
						return false;
					}
					commitUsed = true;
					return commit();
				},
			});
		} catch {
			applyPasteResult(false);
			return;
		}

		if (pasteResult instanceof Promise) {
			this.#startPasteDecisionTimeout(token);
			void pasteResult.then(applyPasteResult, () => applyPasteResult(false));
		} else {
			applyPasteResult(pasteResult);
		}
	}

	handleInput(data: string): void {
		if (this.#pasteDecisionPending) {
			const inputBytes = Buffer.byteLength(data);
			if (
				this.#pendingPasteEventCount() >= PENDING_PASTE_INPUT_MAX ||
				this.#pendingPasteInputBytes + inputBytes > PENDING_PASTE_INPUT_MAX_BYTES
			) {
				this.#restoreCancelledPaste("queue-limit", data);
				return;
			}
			this.#pendingPasteInput.push(data);
			this.#pendingPasteInputBytes += inputBytes;
			return;
		}

		const parsed = parseKittySequence(data);
		if (parsed && (parsed.modifier & 64) !== 0 && this.onCapsLock) {
			// Caps Lock is modifier bit 64
			this.onCapsLock();
			return;
		}

		if (this.onPasteText) {
			const paste =
				data === "\x1b" && !this.#pasteHandler.hasPendingFrame
					? ({ handled: false } as const)
					: this.#pasteHandler.process(data);
			if (paste.handled) {
				if (paste.leading.length > 0) this.handleInput(paste.leading);
				if (paste.pasteContent !== undefined) {
					this.onViewportFollowLive?.();
					this.#handleBracketedPaste(paste.pasteContent, paste.remaining);
				}
				return;
			}
		}
		if (!this.isShowingAutocomplete()) {
			if (matchesKey(data, "pageUp") && this.onViewportPageScroll) {
				this.onViewportPageScroll(-1);
				return;
			}
			if (matchesKey(data, "pageDown") && this.onViewportPageScroll) {
				this.onViewportPageScroll(1);
				return;
			}
		}

		if (!matchesKey(data, "pageUp") && !matchesKey(data, "pageDown")) {
			this.onViewportFollowLive?.();
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

		// Intercept configured command palette shortcut before model cycling (Ctrl+P default).
		if (this.#matchesAction(data, "app.commandPalette.open") && this.onOpenCommandPalette) {
			this.onOpenCommandPalette();
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

		// Intercept configured queue shortcut (send message after current turn)
		if (this.#matchesAction(data, "app.message.queue") && this.onQueue) {
			this.onQueue();
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
				if (handler() !== false) return;
			}
		}

		// Pass to parent for normal handling.
		super.handleInput(data);
	}
}
