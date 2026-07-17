import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type AgentMessage, ThinkingLevel } from "@gajae-code/agent-core";
import { type AutocompleteProvider, matchesKey, type SlashCommand } from "@gajae-code/tui";
import { $env, sanitizeText } from "@gajae-code/utils";
import { type AppKeybinding, KEYBINDINGS } from "../../config/keybindings";
import { isSettingsInitialized, settings } from "../../config/settings";
import { resolveSubskillActivationForSkillInvocation } from "../../extensibility/gjc-plugins";
import { buildSkillPromptMessage, parseSkillInvocations } from "../../extensibility/skills";
import { expandEmoticons } from "../../modes/emoji-autocomplete";
import { createPromptActionAutocompleteProvider } from "../../modes/prompt-action-autocomplete";
import { theme } from "../../modes/theme/theme";
import { scrollTmuxToPreviousUserInput as scrollTmuxPaneToPreviousUserInput } from "../../modes/tmux-scroll";
import {
	type ComposerSubmissionOptions,
	canApplyComposerSubmission,
	type InteractiveModeContext,
} from "../../modes/types";
import type { AgentSessionEvent, QueuedMessageEditEntry } from "../../session/agent-session";
import { SKILL_PROMPT_MESSAGE_TYPE, type SkillPromptDetails } from "../../session/messages";
import { executeBuiltinSlashCommand } from "../../slash-commands/builtin-registry";
import { copyToClipboard, readImageFromClipboard } from "../../utils/clipboard";
import { getEditorCommand, openInEditor } from "../../utils/external-editor";
import { ensureSupportedImageInput, ImageInputTooLargeError, loadImageInput } from "../../utils/image-loading";
import { resizeImage } from "../../utils/image-resize";
import { formatPastedImageReference, resolvePastedImagePath } from "../../utils/pasted-image-path";
import { generateSessionTitle, setSessionTerminalTitle } from "../../utils/title-generator";
import type { CommandPaletteAction } from "../components/command-palette";
import { type QueuedMessageMoveDirection, QueuedMessageSelectorComponent } from "../components/queued-message-selector";

interface Expandable {
	setExpanded(expanded: boolean): void;
	setManuallyExpanded?(expanded: boolean): void;
}

const INTERACTIVE_ABORT_CLEANUP_TIMEOUT_MS = 5_000;
const DRAFT_CLEAR_DOUBLE_ESCAPE_WINDOW_MS = 800;
const EMPTY_EDITOR_DOUBLE_ESCAPE_WINDOW_MS = 500;
const IMAGE_PLACEHOLDER_PATTERN = /\[image ([1-9]\d*)\]/g;
const IMAGE_PLACEHOLDER_PRESENT_PATTERN = /\[image [1-9]\d*\]/;

function isExpandable(obj: unknown): obj is Expandable {
	return typeof obj === "object" && obj !== null && "setExpanded" in obj && typeof obj.setExpanded === "function";
}

export class InputController {
	constructor(private ctx: InteractiveModeContext) {}

	#lastBackgroundFoldKeyTime = 0;
	#slashCommands: SlashCommand[] = [];

	/** Set after a first Esc silently consumes a queued steer. Kept until the
	 *  queued steer is either cancelled by a second Esc or drained by continuation,
	 *  so abort cleanup going idle cannot turn the second Esc into an idle action. */
	#steerConsumePending = false;
	#commandPaletteActions = new Map<AppKeybinding, CommandPaletteAction>();
	#paletteCommandInFlight = false;

	#registerCommandPaletteAction(action: AppKeybinding, handler: () => void | Promise<void>): void {
		this.#commandPaletteActions.set(action, {
			id: action,
			label: KEYBINDINGS[action].description,
			handler,
		});
	}

	#globalInterruptUnsubscribe: (() => void) | undefined;
	#draftClearEscapeText: string | undefined;

	#resetEscapeGestures(): void {
		this.ctx.lastEscapeTime = 0;
		this.ctx.lastComposerClearEscapeTime = 0;
		this.#draftClearEscapeText = undefined;
	}

	#armDraftClearEscape(text: string, now: number): void {
		this.ctx.lastEscapeTime = 0;
		this.ctx.lastComposerClearEscapeTime = now;
		this.#draftClearEscapeText = text;
		this.ctx.showStatus("press Esc again to clear");
	}

	#resetDraftClearEscape(): void {
		this.ctx.lastComposerClearEscapeTime = 0;
		this.#draftClearEscapeText = undefined;
	}

	#resetEmptyEditorEscape(): void {
		this.ctx.lastEscapeTime = 0;
	}

	#matchesInterruptKey(data: string): boolean {
		return this.ctx.keybindings.getKeys("app.interrupt").some(key => matchesKey(data, key));
	}

	#hasHookDialog(): boolean {
		return Boolean(this.ctx.hookSelector || this.ctx.hookInput || this.ctx.hookEditor);
	}

	#isRetryBackoffActive(): boolean {
		return Boolean(
			this.ctx.retryLoader ||
				this.ctx.retryEscapeHandler ||
				(this.ctx.session.isRetrying && !this.ctx.session.isStreaming),
		);
	}

	#handleCancellableWorkEscape(options: {
		loading?: boolean;
		processes?: boolean;
		modes?: boolean;
		maintenance?: boolean;
		retry?: boolean;
		streaming?: boolean;
	}): boolean {
		if (options.loading && this.ctx.loadingAnimation) {
			if (this.ctx.cancelPendingSubmission()) {
				return true;
			}
			this.restoreQueuedMessagesToEditor({ abort: true });
			return true;
		}
		if (options.processes && this.ctx.session.isBashRunning) {
			this.ctx.session.abortBash();
			return true;
		}
		if (options.modes && this.ctx.isBashMode) {
			this.ctx.editor.setText("");
			this.ctx.isBashMode = false;
			this.ctx.isBashNoContext = false;
			this.ctx.updateEditorBorderColor();
			return true;
		}
		if (options.processes && this.ctx.session.isEvalRunning) {
			this.ctx.session.abortEval();
			return true;
		}
		if (options.modes && this.ctx.isPythonMode) {
			this.ctx.editor.setText("");
			this.ctx.isPythonMode = false;
			this.ctx.updateEditorBorderColor();
			return true;
		}
		if (
			options.maintenance &&
			(this.ctx.session.isCompacting || this.ctx.autoCompactionLoader || this.ctx.autoCompactionEscapeHandler)
		) {
			this.ctx.session.abortCompaction();
			return true;
		}
		if (options.maintenance && this.ctx.session.isGeneratingHandoff) {
			this.ctx.session.abortHandoff();
			return true;
		}
		if (options.retry) {
			if (this.#isRetryBackoffActive()) {
				if (this.ctx.retryEscapePrimed) {
					this.ctx.session.abortRetry();
				} else {
					this.ctx.retryEscapePrimed = true;
					this.ctx.session.retryNow();
				}
				return true;
			}
			this.ctx.retryEscapePrimed = false;
		}
		if (options.streaming && this.ctx.session.isStreaming) {
			if (this.ctx.session.hasQueuedSteering && !this.#steerConsumePending) {
				// First Esc with a queued steer: silently consume it and
				// auto-continue via steer-on-interrupt instead of stalling on
				// "Operation aborted".
				this.#steerConsumePending = true;
				void this.#abortInteractive({ silent: true });
			} else {
				void this.#abortInteractive();
			}
			return true;
		}
		return false;
	}

	#installGlobalInterruptListener(): void {
		if (typeof this.ctx.ui.addInputListener !== "function") {
			return;
		}
		this.#globalInterruptUnsubscribe?.();
		this.#globalInterruptUnsubscribe = this.ctx.ui.addInputListener(data => {
			if (!this.#matchesInterruptKey(data)) {
				return undefined;
			}
			if (this.ctx.hasActiveBtw() && this.ctx.handleBtwEscape()) {
				this.#resetEscapeGestures();
				return { consume: true };
			}
			const hookDialogActive = this.#hasHookDialog();
			if (this.ctx.hookSelector?.hasActiveInlineInput?.() === true) {
				// Inline ask/custom-input editors use Esc to return to the option list.
				// Let the focused selector see the key instead of converting a typo
				// into a full workflow/session abort while the agent is streaming.
				this.#resetEscapeGestures();
				return undefined;
			}
			if (
				this.#handleCancellableWorkEscape({
					loading: hookDialogActive,
					processes: hookDialogActive,
					modes: false,
					maintenance: true,
					retry: true,
					streaming: hookDialogActive,
				})
			) {
				this.#resetEscapeGestures();
				return { consume: true };
			}
			return undefined;
		});
	}

	#abortInteractive(options?: { silent?: boolean }): Promise<void> {
		return this.ctx.session.abort({
			timeoutMs: INTERACTIVE_ABORT_CLEANUP_TIMEOUT_MS,
			cause: "user_interrupt",
			silent: options?.silent,
		});
	}
	#clearComposer(): void {
		const text = this.ctx.editor.getText();
		if (text.trim()) {
			this.ctx.editor.addToHistory(text);
		}
		this.ctx.clearEditor();
	}

	setupKeyHandlers(): void {
		this.ctx.editor.setActionKeys("app.interrupt", this.ctx.keybindings.getKeys("app.interrupt"));
		this.ctx.editor.shouldBypassAutocompleteOnEscape = () => {
			const bypassAutocomplete = Boolean(
				this.ctx.loadingAnimation ||
					this.ctx.hasActiveBtw() ||
					(this.#steerConsumePending && this.ctx.session.hasQueuedSteering) ||
					this.ctx.session.isStreaming ||
					this.ctx.session.isCompacting ||
					this.ctx.session.isGeneratingHandoff ||
					this.ctx.session.isRetrying ||
					this.ctx.session.isBashRunning ||
					this.ctx.session.isEvalRunning ||
					this.ctx.autoCompactionLoader ||
					this.ctx.retryLoader ||
					this.ctx.autoCompactionEscapeHandler ||
					this.ctx.retryEscapeHandler,
			);
			if (!bypassAutocomplete) this.#resetEscapeGestures();
			return bypassAutocomplete;
		};
		this.#installGlobalInterruptListener();

		// An open btw panel must stay dismissable with Esc even while another
		// controller (auto-compaction, auto-retry, manual compaction, etc.) has
		// temporarily replaced editor.onEscape. This priority hook is never
		// swapped out, so it always wins for the interrupt key.
		this.ctx.editor.onInterruptPriority = () => {
			if (!this.ctx.hasActiveBtw()) return false;
			const consumed = this.ctx.handleBtwEscape();
			if (consumed) this.#resetEscapeGestures();
			return consumed;
		};
		this.ctx.editor.onEscape = () => {
			if (this.ctx.hasActiveBtw() && this.ctx.handleBtwEscape()) {
				this.#resetEscapeGestures();
				return;
			}
			if (this.#steerConsumePending) {
				this.#resetEscapeGestures();
				if (this.ctx.session.hasQueuedSteering) {
					// Second Esc before the scheduled steer continuation drains the
					// queue: restore/drop the queued steer and perform a real abort,
					// even if abort cleanup already made the session look idle.
					this.#steerConsumePending = false;
					this.restoreQueuedMessagesToEditor({ abort: true });
					return;
				}
				this.#steerConsumePending = false;
			}
			if (this.#handleCancellableWorkEscape({ maintenance: true, retry: true })) {
				this.#resetEscapeGestures();
				return;
			}
			if (
				this.#handleCancellableWorkEscape({
					loading: true,
					processes: true,
					modes: true,
					maintenance: true,
					retry: true,
					streaming: true,
				})
			) {
				this.#resetEscapeGestures();
				return;
			}

			const text = this.ctx.editor.getText();
			if (!this.ctx.isBashMode && !this.ctx.isPythonMode && text.trim()) {
				this.#resetEmptyEditorEscape();
				const now = Date.now();
				if (
					now - this.ctx.lastComposerClearEscapeTime < DRAFT_CLEAR_DOUBLE_ESCAPE_WINDOW_MS &&
					this.#draftClearEscapeText === text
				) {
					this.#clearComposer();
					this.#resetDraftClearEscape();
				} else {
					this.#armDraftClearEscape(text, now);
				}
				return;
			}

			if (!text.trim()) {
				this.#resetDraftClearEscape();
				// Double-interrupt with empty editor triggers /tree, /branch, or nothing based on setting
				const action = settings.get("doubleEscapeAction");
				if (action === "none") {
					this.#resetEmptyEditorEscape();
					return;
				}

				const now = Date.now();
				if (now - this.ctx.lastEscapeTime < EMPTY_EDITOR_DOUBLE_ESCAPE_WINDOW_MS) {
					if (action === "tree") {
						this.ctx.showTreeSelector();
					} else {
						this.ctx.showUserMessageSelector();
					}
					this.#resetEmptyEditorEscape();
				} else {
					this.ctx.lastEscapeTime = now;
				}
			}
		};

		const clear = () => this.handleCtrlC();
		this.ctx.editor.setActionKeys("app.clear", this.ctx.keybindings.getKeys("app.clear"));
		this.ctx.editor.onClear = clear;
		this.#registerCommandPaletteAction("app.clear", clear);
		const exit = () => this.handleCtrlD();
		this.ctx.editor.setActionKeys("app.exit", this.ctx.keybindings.getKeys("app.exit"));
		this.ctx.editor.onExit = exit;
		this.#registerCommandPaletteAction("app.exit", exit);
		const suspend = () => this.handleCtrlZ();
		this.ctx.editor.setActionKeys("app.suspend", this.ctx.keybindings.getKeys("app.suspend"));
		this.ctx.editor.onSuspend = suspend;
		this.#registerCommandPaletteAction("app.suspend", suspend);
		const cycleThinking = () => this.cycleThinkingLevel();
		this.ctx.editor.setActionKeys("app.thinking.cycle", this.ctx.keybindings.getKeys("app.thinking.cycle"));
		this.ctx.editor.onCycleThinkingLevel = cycleThinking;
		this.#registerCommandPaletteAction("app.thinking.cycle", cycleThinking);
		this.ctx.editor.setActionKeys("app.commandPalette.open", this.ctx.keybindings.getKeys("app.commandPalette.open"));
		this.ctx.editor.onOpenCommandPalette = () => this.openCommandPalette();
		const cycleModelForward = () => this.cycleRoleModel();
		this.ctx.editor.setActionKeys("app.model.cycleForward", this.ctx.keybindings.getKeys("app.model.cycleForward"));
		this.ctx.editor.onCycleModelForward = cycleModelForward;
		this.#registerCommandPaletteAction("app.model.cycleForward", cycleModelForward);
		const cycleModelBackward = () => this.cycleRoleModel({ temporary: true });
		this.ctx.editor.setActionKeys("app.model.cycleBackward", this.ctx.keybindings.getKeys("app.model.cycleBackward"));
		this.ctx.editor.onCycleModelBackward = cycleModelBackward;
		this.#registerCommandPaletteAction("app.model.cycleBackward", cycleModelBackward);
		const selectTemporaryModel = () => this.ctx.showModelSelector({ temporaryOnly: true });
		this.ctx.editor.setActionKeys(
			"app.model.selectTemporary",
			this.ctx.keybindings.getKeys("app.model.selectTemporary"),
		);
		this.ctx.editor.onSelectModelTemporary = selectTemporaryModel;
		this.#registerCommandPaletteAction("app.model.selectTemporary", selectTemporaryModel);

		// Global debug handler on TUI (works regardless of focus)
		this.ctx.ui.onDebug = () => this.ctx.showDebugSelector();
		const selectModel = () => this.ctx.showModelSelector();
		this.ctx.editor.setActionKeys("app.model.select", this.ctx.keybindings.getKeys("app.model.select"));
		this.ctx.editor.onSelectModel = selectModel;
		this.#registerCommandPaletteAction("app.model.select", selectModel);
		const searchHistory = () => this.ctx.showHistorySearch();
		this.ctx.editor.setActionKeys("app.history.search", this.ctx.keybindings.getKeys("app.history.search"));
		this.ctx.editor.onHistorySearch = searchHistory;
		this.#registerCommandPaletteAction("app.history.search", searchHistory);
		const toggleThinking = () => this.ctx.toggleThinkingBlockVisibility();
		this.ctx.editor.setActionKeys("app.thinking.toggle", this.ctx.keybindings.getKeys("app.thinking.toggle"));
		this.ctx.editor.onToggleThinking = toggleThinking;
		this.#registerCommandPaletteAction("app.thinking.toggle", toggleThinking);
		const externalEditor = () => this.openExternalEditor();
		this.ctx.editor.setActionKeys("app.editor.external", this.ctx.keybindings.getKeys("app.editor.external"));
		this.ctx.editor.onExternalEditor = externalEditor;
		this.#registerCommandPaletteAction("app.editor.external", externalEditor);
		this.ctx.editor.onShowHotkeys = () => this.ctx.handleHotkeysCommand();
		const pasteImage = () => this.handleImagePaste();
		const pasteImageFromPalette = async () => {
			await this.handleImagePaste();
		};
		this.ctx.editor.setActionKeys(
			"app.clipboard.pasteImage",
			this.ctx.keybindings.getKeys("app.clipboard.pasteImage"),
		);
		this.ctx.editor.onPasteImage = pasteImage;
		this.#registerCommandPaletteAction("app.clipboard.pasteImage", pasteImageFromPalette);
		const copyPrompt = () => this.handleCopyPrompt();
		this.ctx.editor.setActionKeys(
			"app.clipboard.copyPrompt",
			this.ctx.keybindings.getKeys("app.clipboard.copyPrompt"),
		);
		this.ctx.editor.onCopyPrompt = copyPrompt;
		this.#registerCommandPaletteAction("app.clipboard.copyPrompt", copyPrompt);
		this.ctx.editor.onPasteText = text => this.handleTextPaste(text);
		this.ctx.editor.onPastePendingInputCleared = (reason, droppedInputCount) => {
			const reasonText = reason === "timeout" ? "timed out" : "exceeded the input queue limit";
			this.ctx.showWarning(
				`Paste handling ${reasonText}; discarded ${droppedInputCount} buffered input event${droppedInputCount === 1 ? "" : "s"}.`,
			);
		};
		const expandTools = () => this.toggleToolOutputExpansion();
		this.ctx.editor.setActionKeys("app.tools.expand", this.ctx.keybindings.getKeys("app.tools.expand"));
		this.ctx.editor.onExpandTools = expandTools;
		this.#registerCommandPaletteAction("app.tools.expand", expandTools);
		const dequeue = () => this.handleDequeue();
		this.ctx.editor.setActionKeys("app.message.dequeue", this.ctx.keybindings.getKeys("app.message.dequeue"));
		this.ctx.editor.onDequeue = dequeue;
		this.#registerCommandPaletteAction("app.message.dequeue", dequeue);
		const queue = () => this.handleQueueSubmit();
		this.ctx.editor.setActionKeys("app.message.queue", this.ctx.keybindings.getKeys("app.message.queue"));
		this.ctx.editor.onQueue = queue;
		this.#registerCommandPaletteAction("app.message.queue", queue);

		this.ctx.editor.onViewportPageScroll = direction => this.ctx.ui.scrollViewportPages(direction);
		this.ctx.editor.onViewportFollowLive = () => {
			this.ctx.ui.followLiveViewport();
		};

		this.ctx.editor.clearCustomKeyHandlers();
		// Wire up extension shortcuts
		this.registerExtensionShortcuts();

		for (const key of this.ctx.keybindings.getKeys("app.irc.sidebar.toggle")) {
			this.ctx.editor.setCustomKeyHandler(key, () => {
				this.ctx.toggleIrcSidebar();
				return true;
			});
		}

		const togglePlanMode = () => this.ctx.handlePlanModeCommand();
		this.#registerCommandPaletteAction("app.plan.toggle", togglePlanMode);
		for (const key of this.ctx.keybindings.getKeys("app.plan.toggle")) {
			this.ctx.editor.setCustomKeyHandler(key, () => {
				void togglePlanMode();
				return true;
			});
		}
		const newSession = async () => {
			await this.ctx.handleClearCommand();
		};
		this.#registerCommandPaletteAction("app.session.new", newSession);
		for (const key of this.ctx.keybindings.getKeys("app.session.new")) {
			this.ctx.editor.setCustomKeyHandler(key, () => {
				void newSession();
				return true;
			});
		}
		const showTree = () => {
			this.ctx.showTreeSelector();
			return undefined;
		};
		this.#registerCommandPaletteAction("app.session.tree", showTree);
		for (const key of this.ctx.keybindings.getKeys("app.session.tree")) {
			this.ctx.editor.setCustomKeyHandler(key, showTree);
		}
		const forkSession = () => {
			this.ctx.showUserMessageSelector();
			return undefined;
		};
		this.#registerCommandPaletteAction("app.session.fork", forkSession);
		for (const key of this.ctx.keybindings.getKeys("app.session.fork")) {
			this.ctx.editor.setCustomKeyHandler(key, forkSession);
		}
		const resumeSession = () => {
			this.ctx.showSessionSelector();
			return undefined;
		};
		this.#registerCommandPaletteAction("app.session.resume", resumeSession);
		for (const key of this.ctx.keybindings.getKeys("app.session.resume")) {
			this.ctx.editor.setCustomKeyHandler(key, resumeSession);
		}
		for (const key of this.ctx.keybindings.getKeys("app.message.followUp")) {
			this.ctx.editor.setCustomKeyHandler(key, () => {
				if (!this.#isFollowUpShortcutActive()) return false;
				void this.handleFollowUp();
				return true;
			});
		}
		for (const key of this.ctx.keybindings.getKeys("app.stt.toggle")) {
			this.ctx.editor.setCustomKeyHandler(key, () => void this.ctx.handleSTTToggle());
		}
		for (const key of this.ctx.keybindings.getKeys("app.clipboard.copyLine")) {
			this.ctx.editor.setCustomKeyHandler(key, () => {
				this.handleCopyCurrentLine();
			});
		}
		for (const key of this.ctx.keybindings.getKeys("app.session.observe")) {
			this.ctx.editor.setCustomKeyHandler(key, () => {
				this.ctx.showSessionObserver();
			});
		}
		for (const key of this.ctx.keybindings.getKeys("app.jobs.open")) {
			this.ctx.editor.setCustomKeyHandler(key, () => {
				this.ctx.showJobsOverlay();
			});
		}
		for (const key of this.ctx.keybindings.getKeys("app.tool.backgroundFold")) {
			this.ctx.editor.setCustomKeyHandler(key, () => this.handleForegroundToolBackgroundFold());
		}

		this.ctx.editor.onChange = (text: string) => {
			this.#resetEscapeGestures();
			const wasBashMode = this.ctx.isBashMode;
			const wasBashNoContext = this.ctx.isBashNoContext;
			const wasPythonMode = this.ctx.isPythonMode;
			const trimmed = text.trimStart();
			this.ctx.isBashMode = trimmed.startsWith("!");
			this.ctx.isBashNoContext = trimmed.startsWith("!!");
			this.ctx.isPythonMode = trimmed.startsWith("$") && !trimmed.startsWith("${");
			this.#clearPendingImagesIfPlaceholdersRemoved(text);
			if (
				wasBashMode !== this.ctx.isBashMode ||
				wasBashNoContext !== this.ctx.isBashNoContext ||
				wasPythonMode !== this.ctx.isPythonMode
			) {
				this.ctx.updateEditorBorderColor();
			}
		};
	}

	setupEditorSubmitHandler(): void {
		this.ctx.editor.onSubmit = text => this.submitText(text, { ownsComposer: true, editor: this.ctx.editor });
	}

	async submitText(text: string, composer: ComposerSubmissionOptions): Promise<void> {
		text = text.trim();
		if ((!isSettingsInitialized() || settings.get("emojiAutocomplete")) && text) text = expandEmoticons(text);

		// Empty submit while streaming with queued messages: flush queues immediately
		if (!text && this.ctx.session.isStreaming && this.ctx.session.queuedMessageCount > 0) {
			// Abort current stream and let queued messages be processed
			await this.#abortInteractive();
			return;
		}

		if (!text) return;

		// Continue shortcuts: "." or "c" sends empty message (agent continues, no visible message)
		if (text === "." || text === "c") {
			if (this.ctx.onInputCallback) {
				this.ctx.editor.setText("");
				this.ctx.pendingImages = [];
				this.ctx.onInputCallback({ text: "", cancelled: false, started: true });
			}
			return;
		}

		const runner = this.ctx.session.extensionRunner;
		const pendingImages = this.ctx.pendingImages;
		let inputImages = this.#visiblePendingImagesForText(text);

		if (runner?.hasHandlers("input")) {
			const result = await runner.emitInput(text, inputImages, "interactive");
			if (result?.handled) {
				if (this.#canModifyComposer(composer)) {
					this.ctx.editor.setText("");
				}
				this.#clearPendingImagesIfOwnedBy(pendingImages, composer);
				return;
			}
			if (result?.text !== undefined) {
				text = result.text.trim();
			}
			if (result?.images !== undefined) {
				inputImages = result.images;
			}
		}

		if (!text) return;

		// Handle built-in slash commands
		const slashResult = await executeBuiltinSlashCommand(text, {
			ctx: this.ctx,
			handleBackgroundCommand: () => this.handleBackgroundCommand(),
			composer,
		});
		if (slashResult === true) {
			return;
		}
		if (typeof slashResult === "string") {
			// Command handled but returned remaining text to use as prompt
			text = slashResult;
		}

		// Handle skill commands (/skill:name [args]). While streaming, Enter
		// honors `busyPromptMode`: "steer" interrupts the active turn, "queue"
		// runs after it completes (matches the free-text Enter semantics applied
		// a few lines below at the streaming branch). Explicit queue shortcuts
		// route through `handleFollowUp` and dispatch as `followUp`.
		if (await this.#invokeSkillCommand(text, this.#busyStreamingBehavior(), composer)) {
			return;
		}

		// Handle bash command (! for normal, !! for excluded from context)
		if (text.startsWith("!")) {
			const isExcluded = text.startsWith("!!");
			const command = isExcluded ? text.slice(2).trim() : text.slice(1).trim();
			if (command) {
				if (this.ctx.session.isBashRunning) {
					this.ctx.showWarning("A bash command is already running. Press Esc to cancel it first.");
					if (this.#canModifyComposer(composer)) {
						this.ctx.editor.setText(text);
					}
					return;
				}
				if (this.#canModifyComposer(composer)) {
					this.ctx.editor.addToHistory(text);
				}
				await this.ctx.handleBashCommand(command, isExcluded);
				this.ctx.isBashMode = false;
				this.ctx.isBashNoContext = false;
				this.ctx.updateEditorBorderColor();
				return;
			}
		}

		// Handle python command ($ for normal, $$ for excluded from context)
		if (text.startsWith("$")) {
			const isExcluded = text.startsWith("$$");
			const code = isExcluded ? text.slice(2).trim() : text.slice(1).trim();
			if (code) {
				if (this.ctx.session.isEvalRunning) {
					this.ctx.showWarning("A Python execution is already running. Press Esc to cancel it first.");
					if (this.#canModifyComposer(composer)) {
						this.ctx.editor.setText(text);
					}
					return;
				}
				if (this.#canModifyComposer(composer)) {
					this.ctx.editor.addToHistory(text);
				}
				await this.ctx.handlePythonCommand(code, isExcluded);
				this.ctx.isPythonMode = false;
				this.ctx.updateEditorBorderColor();
				return;
			}
		}

		// Queue input during compaction
		if (this.ctx.session.isCompacting) {
			if ((inputImages?.length ?? 0) > 0) {
				this.ctx.showStatus("Compaction in progress. Retry after it completes to send images.");
				return;
			}
			this.ctx.queueCompactionMessage(text, "steer", composer);
			return;
		}

		// If streaming, use prompt() with the busy-prompt behavior the user
		// selected: "steer" interrupts the active turn, "queue" defers the
		// prompt to run after the active turn completes (in submission order).
		// This handles extension commands (execute immediately), prompt template expansion, and queueing
		if (this.ctx.session.isStreaming) {
			if (this.#canModifyComposer(composer)) {
				this.ctx.editor.addToHistory(text);
				this.ctx.editor.setText("");
			}
			const images = inputImages && inputImages.length > 0 ? [...inputImages] : undefined;
			this.#clearPendingImagesIfOwnedBy(pendingImages, composer);
			// Record the signature so the queued message's eventual delivery
			// (a user-role `message_start` event) leaves any draft the user has
			// typed since queuing intact. Same protection as #783, applied to
			// the streaming/queue path.
			const streamingBehavior = this.#busyStreamingBehavior();
			const promptOptions =
				streamingBehavior === "followUp"
					? { streamingBehavior, images, followUpQueuePolicy: "sequential" as const }
					: { streamingBehavior, images };
			await this.ctx.withLocalSubmission(text, () => this.ctx.session.prompt(text, promptOptions), {
				imageCount: images?.length ?? 0,
			});
			this.ctx.updatePendingMessagesDisplay();
			this.ctx.ui.requestRender();
			return;
		}

		// Normal message submission
		// First, move any pending bash components to chat
		this.ctx.flushPendingBashComponents();

		// Generate session title on first message
		const hasUserMessages = this.ctx.session.messages.some((m: AgentMessage) => m.role === "user");
		if (!hasUserMessages && !this.ctx.sessionManager.getSessionName() && !$env.PI_NO_TITLE) {
			const registry = this.ctx.session.modelRegistry;
			generateSessionTitle(
				text,
				registry,
				this.ctx.settings,
				this.ctx.session.sessionId,
				this.ctx.session.model,
				provider => this.ctx.session.agent.metadataForProvider(provider),
			)
				.then(async title => {
					if (title) {
						const applied = await this.ctx.sessionManager.setSessionName(title, "auto");
						if (applied) {
							setSessionTerminalTitle(
								this.ctx.sessionManager.getSessionName()!,
								this.ctx.sessionManager.getCwd(),
							);
							this.ctx.updateEditorBorderColor();
						}
					}
				})
				.catch(() => {});
		}

		if (this.ctx.onInputCallback) {
			// Include any pending images from clipboard paste
			const images = inputImages && inputImages.length > 0 ? [...inputImages] : undefined;
			this.#clearPendingImagesIfOwnedBy(pendingImages, composer);

			// Render user message immediately, then let session events catch up
			const submission = this.ctx.startPendingSubmission({ text, images }, composer);

			this.ctx.onInputCallback(submission);
		}
		if (this.#canModifyComposer(composer)) {
			this.ctx.editor.addToHistory(text);
		}
	}

	handleCtrlC(): void {
		const now = Date.now();
		if (now - this.ctx.lastSigintTime < 500) {
			void this.ctx.shutdown();
		} else {
			this.ctx.clearEditor();
			this.ctx.lastSigintTime = now;
		}
	}

	handleCtrlD(): void {
		// Editor text (if any) is snapshotted at the start of shutdown() and
		// persisted as a draft for the next resume. Empty text is also fine —
		// shutdown clears any stale sidecar in that case.
		void this.ctx.shutdown();
	}

	handleCtrlZ(): void {
		// Set up handler to restore TUI when resumed
		process.once("SIGCONT", () => {
			this.ctx.ui.start();
			this.ctx.ui.requestRender(true);
		});

		// Stop the TUI (restore terminal to normal mode)
		this.ctx.ui.stop();

		// Send SIGTSTP to process group (pid=0 means all processes in group)
		process.kill(0, "SIGTSTP");
	}

	handleDequeue(): void {
		const entries = this.#getEditableQueuedMessages();
		if (entries.length === 0) {
			this.ctx.updatePendingMessagesDisplay();
			this.ctx.showStatus("No queued messages to restore");
			return;
		}
		if (entries.length === 1) {
			const restored = this.#restoreQueuedMessageToEditor(entries[0]);
			this.ctx.showStatus(
				restored === 0 ? "Queued message is no longer available" : "Restored queued message to editor",
			);
			return;
		}
		this.#showQueuedMessageSelector(entries, this.#newestQueuedMessageIndex(entries));
	}

	#compactionQueuedMessageId(index: number): string {
		return `compaction:${index}`;
	}

	#getEditableQueuedMessages(): QueuedMessageEditEntry[] {
		const compactionEntries = this.ctx.compactionQueuedMessages.map((entry, index): QueuedMessageEditEntry => {
			const label = entry.mode === "steer" ? "Steer" : "Queued";
			return {
				id: this.#compactionQueuedMessageId(index),
				text: entry.text,
				mode: entry.mode,
				label,
			};
		});
		return [...compactionEntries, ...this.ctx.session.getQueuedMessageEntries()];
	}

	#queuedMessageStableSequence(entry: QueuedMessageEditEntry): number | undefined {
		const [mode, sequenceText] = entry.id.split(":");
		if ((mode !== "steer" && mode !== "followUp") || sequenceText === undefined) return undefined;
		const sequence = Number(sequenceText);
		return Number.isInteger(sequence) ? sequence : undefined;
	}

	#newestQueuedMessageIndex(entries: QueuedMessageEditEntry[]): number {
		let selectedIndex = entries.length - 1;
		let newestSequence = Number.NEGATIVE_INFINITY;
		for (let index = 0; index < entries.length; index += 1) {
			const sequence = this.#queuedMessageStableSequence(entries[index]);
			if (sequence !== undefined && sequence > newestSequence) {
				newestSequence = sequence;
				selectedIndex = index;
			}
		}
		return Math.max(0, selectedIndex);
	}

	#restoreEditorFocus(): void {
		this.ctx.editorContainer.clear();
		this.ctx.editorContainer.addChild(this.ctx.editor);
		this.ctx.ui.setFocus(this.ctx.editor);
	}

	#showQueuedMessageSelector(entries: QueuedMessageEditEntry[], selectedIndex = 0): void {
		const selector = new QueuedMessageSelectorComponent(
			entries,
			entry => {
				const restored = this.#restoreQueuedMessageToEditor(entry);
				this.#restoreEditorFocus();
				this.ctx.showStatus(
					restored === 0 ? "Queued message is no longer available" : "Restored queued message to editor",
				);
				this.ctx.ui.requestRender();
			},
			(entry, index) => {
				const deleted = this.#deleteQueuedMessage(entry);
				const nextEntries = this.#getEditableQueuedMessages();
				if (nextEntries.length === 0) {
					this.#restoreEditorFocus();
					this.ctx.showStatus(deleted ? "Deleted queued message" : "Queued message is no longer available");
					this.ctx.ui.requestRender();
					return;
				}
				this.ctx.showStatus(deleted ? "Deleted queued message" : "Queued message is no longer available");
				this.#showQueuedMessageSelector(nextEntries, Math.min(index, nextEntries.length - 1));
			},
			(entry, index, direction) => {
				const moved = this.#moveQueuedMessage(entry, direction);
				const nextEntries = this.#getEditableQueuedMessages();
				if (nextEntries.length === 0) {
					this.#restoreEditorFocus();
					this.ctx.showStatus("Queued message is no longer available");
					this.ctx.ui.requestRender();
					return;
				}
				const nextIndex = direction === "up" ? index - 1 : index + 1;
				const selectedNextIndex = moved ? nextIndex : index;
				this.ctx.showStatus(moved ? "Moved queued message" : "Queued message cannot move further");
				this.#showQueuedMessageSelector(
					nextEntries,
					Math.max(0, Math.min(selectedNextIndex, nextEntries.length - 1)),
				);
			},
			() => {
				this.#restoreEditorFocus();
				this.ctx.ui.requestRender();
			},
			{ selectedIndex },
		);
		this.ctx.editorContainer.clear();
		this.ctx.editorContainer.addChild(selector);
		this.ctx.ui.setFocus(selector);
		this.ctx.ui.requestRender();
	}

	#removeQueuedMessageForEditing(id: string): string | undefined {
		const compactionPrefix = "compaction:";
		if (id.startsWith(compactionPrefix)) {
			const index = Number(id.slice(compactionPrefix.length));
			if (!Number.isInteger(index)) return undefined;
			const [entry] = this.ctx.compactionQueuedMessages.splice(index, 1);
			return entry?.text;
		}
		return this.ctx.session.removeQueuedMessageForEditing(id);
	}
	#parseCompactionQueuedMessageId(id: string): number | undefined {
		const compactionPrefix = "compaction:";
		if (!id.startsWith(compactionPrefix)) return undefined;
		const index = Number(id.slice(compactionPrefix.length));
		return Number.isInteger(index) ? index : undefined;
	}

	#moveCompactionQueuedMessage(index: number, direction: QueuedMessageMoveDirection): boolean {
		const targetIndex = direction === "up" ? index - 1 : index + 1;
		if (index < 0 || index >= this.ctx.compactionQueuedMessages.length) return false;
		if (targetIndex < 0 || targetIndex >= this.ctx.compactionQueuedMessages.length) return false;
		const current = this.ctx.compactionQueuedMessages[index];
		const target = this.ctx.compactionQueuedMessages[targetIndex];
		if (!current || !target) return false;
		this.ctx.compactionQueuedMessages[index] = target;
		this.ctx.compactionQueuedMessages[targetIndex] = current;
		this.ctx.updatePendingMessagesDisplay();
		return true;
	}

	#moveQueuedMessage(entry: QueuedMessageEditEntry, direction: QueuedMessageMoveDirection): boolean {
		const compactionIndex = this.#parseCompactionQueuedMessageId(entry.id);
		if (compactionIndex !== undefined) {
			return this.#moveCompactionQueuedMessage(compactionIndex, direction);
		}
		const moved = this.ctx.session.moveQueuedMessageForEditing(entry.id, direction);
		if (moved) {
			this.ctx.updatePendingMessagesDisplay();
		}
		return moved;
	}

	#deleteQueuedMessage(entry: QueuedMessageEditEntry): boolean {
		const queuedText = this.#removeQueuedMessageForEditing(entry.id);
		this.ctx.updatePendingMessagesDisplay();
		if (!queuedText) return false;
		this.ctx.locallySubmittedUserSignatures.delete(`${queuedText}\u00000`);
		return true;
	}

	#restoreQueuedMessageToEditor(entry: QueuedMessageEditEntry | undefined): number {
		if (!entry) {
			this.ctx.updatePendingMessagesDisplay();
			return 0;
		}
		const queuedText = this.#removeQueuedMessageForEditing(entry.id);
		if (!queuedText) {
			this.ctx.updatePendingMessagesDisplay();
			return 0;
		}

		this.ctx.locallySubmittedUserSignatures.delete(`${queuedText}\u00000`);
		this.ctx.editor.setText(queuedText);
		this.ctx.updatePendingMessagesDisplay();
		return 1;
	}

	/**
	 * Resolve how a prompt submitted while the agent is busy should be delivered.
	 * Driven by the `busyPromptMode` setting and kept distinct from the
	 * follow-up keybinding: "steer" interrupts the active turn, "queue" defers
	 * the prompt to the follow-up queue so it runs after the active turn
	 * completes (in submission order). Only consulted while streaming.
	 */
	#busyStreamingBehavior(): "steer" | "followUp" {
		return this.ctx.settings.get("busyPromptMode") === "steer" ? "steer" : "followUp";
	}

	#isFollowUpShortcutActive(): boolean {
		return (
			this.ctx.session.isStreaming ||
			this.ctx.session.isCompacting ||
			this.ctx.session.isBashRunning ||
			this.ctx.session.isEvalRunning
		);
	}

	/**
	 * Dispatch skill slash invocation(s) (`/skill:<name>`) through custom messages
	 * using the supplied `streamingBehavior`. Returns true if the text contains a
	 * recognised canonical skill command or command chain and was dispatched. A
	 * failure to load a skill file is surfaced via `showError` but still returns
	 * true — the editor was already cleared on the success path, so falling
	 * through to plain-text handling at that point would double-submit. Returns
	 * false when the text has no registered canonical skill invocation, so the
	 * caller can fall through to plain-text handling (this branch
	 * leaves the editor state untouched). `streamingBehavior` is only consulted
	 * while the agent is streaming; the idle path of `promptCustomMessage`
	 * ignores it.
	 */
	async #invokeSkillCommand(
		text: string,
		streamingBehavior: "steer" | "followUp",
		options?: ComposerSubmissionOptions,
	): Promise<boolean> {
		const invocations = parseSkillInvocations(text, this.ctx.skillCommands ?? new Map());
		if (invocations.length === 0) return false;
		if (!options || this.#canModifyComposer(options)) {
			this.ctx.editor.addToHistory(text);
			this.ctx.editor.setText("");
		}
		try {
			for (let index = 0; index < invocations.length; index += 1) {
				const invocation = invocations[index];
				if (!invocation) continue;
				const activationResult = await resolveSubskillActivationForSkillInvocation({
					cwd: this.ctx.sessionManager.getCwd(),
					sessionId: this.ctx.session.sessionId,
					skillName: invocation.skill.name,
					args: invocation.args,
				});
				const built = await buildSkillPromptMessage(invocation.skill, activationResult.cleanedArgs, {
					subskillActivation: activationResult.activation,
					subskillActivationSet: activationResult.activeSubskillsToPersist,
					cwd: this.ctx.sessionManager.getCwd(),
					sessionId: this.ctx.session.sessionId,
				});
				const details: SkillPromptDetails = built.details;
				const displayText = `/${invocation.commandName}${activationResult.cleanedArgs ? ` ${activationResult.cleanedArgs}` : ""}`;
				// When the agent is streaming, register a compact slash-form text as
				// the pending-display twin BEFORE dispatching the CustomMessage. The
				// returned tag is embedded in details so AgentSession.#handleAgentEvent
				// can remove the matching display entry when the agent consumes this
				// message (mirrors the user-message dequeue path).
				if (this.ctx.session.isStreaming) {
					const tag = this.ctx.session.enqueueCustomMessageDisplay(displayText, streamingBehavior);
					details.__pendingDisplayTag = tag;
				}
				const isLast = index === invocations.length - 1;
				if (!this.ctx.session.isStreaming && !isLast) {
					await this.ctx.session.sendCustomMessage({
						customType: SKILL_PROMPT_MESSAGE_TYPE,
						content: built.message,
						display: true,
						details,
						attribution: "user",
					});
					continue;
				}
				await this.ctx.session.promptCustomMessage(
					{
						customType: SKILL_PROMPT_MESSAGE_TYPE,
						content: built.message,
						display: true,
						details,
						attribution: "user",
					},
					streamingBehavior === "followUp"
						? { streamingBehavior, followUpQueuePolicy: "sequential" }
						: { streamingBehavior },
				);
			}
			if (this.ctx.session.isStreaming) {
				this.ctx.updatePendingMessagesDisplay();
				this.ctx.ui.requestRender();
			}
		} catch (err) {
			this.ctx.showError(`Failed to load skill: ${err instanceof Error ? err.message : String(err)}`);
		}
		return true;
	}

	/** Send editor text as a follow-up message (queued behind current stream). */
	async handleFollowUp(): Promise<void> {
		const text = this.ctx.editor.getText().trim();
		if (!text) return;

		// Compaction first: while compacting, queue free text and `/skill:*`
		// commands in the compaction-local queue. `flushCompactionQueue`
		// replays skill entries through the custom-message skill path after
		// compaction finishes so they are not degraded into plain prompts.
		if (this.ctx.session.isCompacting) {
			if (this.ctx.pendingImages.length > 0) {
				this.ctx.showStatus("Compaction in progress. Retry after it completes to send images.");
				return;
			}
			this.ctx.queueCompactionMessage(text, "followUp");
			return;
		}

		// Skill commands invoke through the custom-message path regardless of
		// which keybinding submitted them. Enter routes them as `steer`;
		// explicit queue shortcuts route them as `followUp`.
		if (await this.#invokeSkillCommand(text, "followUp")) {
			return;
		}

		if (this.ctx.session.isStreaming) {
			this.ctx.editor.addToHistory(text);
			this.ctx.editor.setText("");
			await this.ctx.withLocalSubmission(text, () =>
				this.ctx.session.prompt(text, {
					streamingBehavior: "followUp",
					followUpQueuePolicy: "sequential",
				}),
			);
			this.ctx.updatePendingMessagesDisplay();
			this.ctx.ui.requestRender();
			return;
		}

		// Not streaming — just submit normally
		this.ctx.editor.addToHistory(text);
		this.ctx.editor.setText("");
		await this.ctx.withLocalSubmission(text, () => this.ctx.session.prompt(text));
	}

	/** Send editor text explicitly as a queued next-turn message. */
	async handleQueueSubmit(): Promise<void> {
		return this.handleFollowUp();
	}

	restoreLatestQueuedMessageToEditor(): number {
		const compactionQueued = this.ctx.compactionQueuedMessages.pop();
		const queuedText = compactionQueued?.text ?? this.ctx.session.popLastQueuedMessage();
		if (!queuedText) {
			this.ctx.updatePendingMessagesDisplay();
			return 0;
		}

		this.ctx.locallySubmittedUserSignatures.delete(`${queuedText}\u00000`);
		this.ctx.editor.setText(queuedText);
		this.ctx.updatePendingMessagesDisplay();
		return 1;
	}

	restoreQueuedMessagesToEditor(options?: { abort?: boolean; currentText?: string }): number {
		this.ctx.locallySubmittedUserSignatures.clear();
		const { steering, followUp } = this.ctx.session.clearQueue();
		const compactionQueued = (this.ctx.compactionQueuedMessages ?? []).map(entry => entry.text);
		this.ctx.compactionQueuedMessages = [];
		const allQueued = [...steering, ...followUp, ...compactionQueued];
		if (allQueued.length === 0) {
			this.ctx.updatePendingMessagesDisplay();
			if (options?.abort) {
				void this.#abortInteractive();
			}
			return 0;
		}
		const queuedText = allQueued.join("\n\n");
		const currentText = options?.currentText ?? this.ctx.editor.getText();
		const combinedText = [queuedText, currentText].filter(t => t.trim()).join("\n\n");
		this.ctx.editor.setText(combinedText);
		this.ctx.updatePendingMessagesDisplay();
		if (options?.abort) {
			void this.#abortInteractive();
		}
		return allQueued.length;
	}

	handleBackgroundCommand(): void {
		if (this.ctx.isBackgrounded) {
			this.ctx.showStatus("Background mode already enabled");
			return;
		}
		if (!this.ctx.session.isStreaming && this.ctx.session.queuedMessageCount === 0) {
			this.ctx.showWarning("Agent is idle; nothing to background");
			return;
		}
		if (this.ctx.hasActiveBtw()) {
			this.ctx.handleBtwEscape();
		}

		this.ctx.isBackgrounded = true;
		const backgroundUiContext = this.ctx.createBackgroundUiContext();

		// Background mode disables interactive UI so tools like ask fail fast.
		this.ctx.setToolUIContext(backgroundUiContext, false);
		this.ctx.initializeHookRunner(backgroundUiContext, false);

		if (this.ctx.loadingAnimation) {
			this.ctx.loadingAnimation.stop();
			this.ctx.loadingAnimation = undefined;
		}
		if (this.ctx.autoCompactionLoader) {
			this.ctx.autoCompactionLoader.stop();
			this.ctx.autoCompactionLoader = undefined;
		}
		if (this.ctx.retryLoader) {
			this.ctx.retryLoader.stop();
			this.ctx.retryLoader = undefined;
		}
		if (this.ctx.retryCountdownTimer) {
			clearInterval(this.ctx.retryCountdownTimer);
			this.ctx.retryCountdownTimer = undefined;
		}
		if (this.ctx.retryEscapeHandler) {
			this.ctx.editor.onEscape = this.ctx.retryEscapeHandler;
			this.ctx.retryEscapeHandler = undefined;
		}
		this.ctx.retryEscapePrimed = false;
		this.ctx.statusContainer.clear();
		this.ctx.statusLine.dispose();

		if (this.ctx.unsubscribe) {
			this.ctx.unsubscribe();
		}
		this.ctx.unsubscribe = this.ctx.session.subscribe(async (event: AgentSessionEvent) => {
			await this.ctx.handleBackgroundEvent(event);
		});

		// Backgrounding keeps the current process to preserve in-flight agent state.
		if (this.ctx.isInitialized) {
			this.ctx.ui.stop();
			this.ctx.isInitialized = false;
		}

		process.stdout.write("Background mode enabled. Run `bg` to continue in background.\n");

		if (process.platform === "win32" || !process.stdout.isTTY) {
			process.stdout.write("Backgrounding requires POSIX job control; continuing in foreground.\n");
			return;
		}

		process.kill(0, "SIGTSTP");
	}

	handleForegroundToolBackgroundFold(): boolean {
		if (!this.ctx.session.hasForegroundBashBackgroundRequestHandler?.()) {
			this.#lastBackgroundFoldKeyTime = 0;
			return false;
		}

		const now = Date.now();
		if (now - this.#lastBackgroundFoldKeyTime > 750) {
			this.#lastBackgroundFoldKeyTime = now;
			this.ctx.showStatus("Press Ctrl+B again to fold supported foreground bash into a background job");
			return true;
		}
		this.#lastBackgroundFoldKeyTime = 0;

		if (!this.ctx.session.requestForegroundBashBackground?.()) {
			this.ctx.showWarning(
				"No supported foreground tool can be folded. Use managed async bash/auto-background; raw Ctrl+Z/bg is not supported inside the TUI.",
			);
			return true;
		}

		this.ctx.showStatus("Folding foreground bash into a quiet background job…");
		return true;
	}

	handleTextPaste(text: string): boolean | Promise<boolean> {
		const imagePath = resolvePastedImagePath(text, { cwd: this.ctx.sessionManager.getCwd() });
		return imagePath ? this.#attachPastedImagePath(imagePath) : false;
	}

	/**
	 * Returns `false` on every failure path so the editor replays the original
	 * bracketed paste — the raw path text must never be lost when attachment
	 * is impossible (unsupported content, oversized image, load error).
	 */
	async #attachPastedImagePath(imagePath: string): Promise<boolean> {
		try {
			const image = await loadImageInput({
				path: imagePath,
				cwd: this.ctx.sessionManager.getCwd(),
				autoResize: this.ctx.settings.get("images.autoResize"),
			});
			if (!image) {
				this.ctx.showStatus("Unsupported pasted image file");
				return false;
			}

			this.ctx.pendingImages = [
				...this.ctx.pendingImages,
				{
					type: "image",
					data: image.data,
					mimeType: image.mimeType,
				},
			];
			this.ctx.editor.insertText(`${formatPastedImageReference(this.#nextImagePlaceholder(), image.resolvedPath)} `);
			this.ctx.showStatus(`Attached image: ${path.basename(image.resolvedPath)}`, { dim: true });
			this.ctx.ui.requestRender();
			return true;
		} catch (error) {
			if (error instanceof ImageInputTooLargeError) {
				this.ctx.showStatus(error.message);
				return false;
			}
			this.ctx.showStatus("Failed to attach pasted image");
			return false;
		}
	}

	#nextImagePlaceholder(): string {
		return `[image ${this.ctx.pendingImages.length}]`;
	}

	#visiblePendingImagesForText(text: string): InteractiveModeContext["pendingImages"] | undefined {
		if (this.ctx.pendingImages.length === 0) {
			return undefined;
		}

		const images: InteractiveModeContext["pendingImages"] = [];
		const seenImageIndexes = new Set<number>();
		for (const match of text.matchAll(IMAGE_PLACEHOLDER_PATTERN)) {
			const placeholderNumberText = match[1];
			if (!placeholderNumberText) continue;
			const placeholderNumber = Number.parseInt(placeholderNumberText, 10);
			const imageIndex = placeholderNumber - 1;
			if (imageIndex < 0 || imageIndex >= this.ctx.pendingImages.length || seenImageIndexes.has(imageIndex)) {
				continue;
			}
			const image = this.ctx.pendingImages[imageIndex];
			if (!image) continue;
			images.push(image);
			seenImageIndexes.add(imageIndex);
		}

		return images.length > 0 ? images : undefined;
	}

	#canModifyComposer(options: ComposerSubmissionOptions): boolean {
		return canApplyComposerSubmission(options, this.ctx.editor);
	}

	#clearPendingImagesIfOwnedBy(
		pendingImages: InteractiveModeContext["pendingImages"],
		options: ComposerSubmissionOptions,
	): void {
		if (this.#canModifyComposer(options) && this.ctx.pendingImages === pendingImages) {
			this.ctx.pendingImages = [];
		}
	}

	#clearPendingImagesIfPlaceholdersRemoved(text: string): void {
		if (this.ctx.pendingImages.length === 0 || IMAGE_PLACEHOLDER_PRESENT_PATTERN.test(text)) {
			return;
		}
		// Editor submit resets the composer and emits onChange("") before onSubmit(result).
		// Defer the empty-buffer clear so the submit handler can still resolve image
		// placeholders against pendingImages, while manual clears still drop stale images.
		if (text.length === 0) {
			const pendingImages = this.ctx.pendingImages;
			const pendingImageCount = pendingImages.length;
			queueMicrotask(() => {
				if (
					this.ctx.pendingImages === pendingImages &&
					pendingImages.length === pendingImageCount &&
					this.ctx.editor.getText().length === 0
				) {
					this.ctx.pendingImages = [];
				}
			});
			return;
		}
		this.ctx.pendingImages = [];
	}

	async handleImagePaste(): Promise<boolean> {
		try {
			const image = await readImageFromClipboard();
			if (image) {
				const base64Data = image.data.toBase64();
				let imageData = await ensureSupportedImageInput({
					type: "image",
					data: base64Data,
					mimeType: image.mimeType,
				});
				if (!imageData) {
					this.ctx.showStatus(`Unsupported clipboard image format: ${image.mimeType}`);
					return false;
				}
				if (this.ctx.settings.get("images.autoResize")) {
					try {
						const resized = await resizeImage({
							type: "image",
							data: imageData.data,
							mimeType: imageData.mimeType,
						});
						imageData = { type: "image", data: resized.data, mimeType: resized.mimeType };
					} catch {
						// Keep the normalized image when resize fails.
					}
				}

				this.ctx.pendingImages = [
					...this.ctx.pendingImages,
					{
						type: "image",
						data: imageData.data,
						mimeType: imageData.mimeType,
					},
				];
				this.ctx.editor.insertText(`${this.#nextImagePlaceholder()} `);
				this.ctx.ui.requestRender();
				return true;
			}
			this.ctx.showStatus(
				"No image in clipboard. Use #paste-image, paste a copied image, or attach an image file with @path/to/image.png.",
			);
			return false;
		} catch {
			this.ctx.showStatus("Failed to read clipboard");
			return false;
		}
	}

	createAutocompleteProvider(commands: SlashCommand[], basePath: string): AutocompleteProvider {
		this.#slashCommands = commands;
		return createPromptActionAutocompleteProvider({
			commands,
			basePath,
			keybindings: this.ctx.keybindings,
			copyCurrentLine: () => this.handleCopyCurrentLine(),
			copyPrompt: () => this.handleCopyPrompt(),
			pasteImage: () => void this.handleImagePaste(),
			newSession: () => void this.ctx.handleClearCommand(),
			showHelp: () => this.ctx.handleHelpCommand(),
			scrollTmuxToPreviousUserInput: () => this.scrollTmuxToPreviousUserInput(),
			undo: prefix => this.ctx.editor.undoPastTransientText(prefix),
			moveCursorToMessageEnd: () => this.ctx.editor.moveToMessageEnd(),
			moveCursorToMessageStart: () => this.ctx.editor.moveToMessageStart(),
			moveCursorToLineStart: () => this.ctx.editor.moveToLineStart(),
			moveCursorToLineEnd: () => this.ctx.editor.moveToLineEnd(),
		});
	}

	/** Copy the current editor line to the system clipboard. */
	handleCopyCurrentLine(): void {
		const { line } = this.ctx.editor.getCursor();
		const text = this.ctx.editor.getLines()[line] || "";
		if (!text) {
			this.ctx.showStatus("Nothing to copy");
			return;
		}
		try {
			copyToClipboard(text);
			const sanitized = sanitizeText(text);
			const preview = sanitized.length > 30 ? `${sanitized.slice(0, 30)}...` : sanitized;
			this.ctx.showStatus(`Copied line: ${preview}`);
		} catch {
			this.ctx.showWarning("Failed to copy to clipboard");
		}
	}

	/** Copy current prompt text to system clipboard. */
	handleCopyPrompt(): void {
		const text = this.ctx.editor.getText();
		if (!text) {
			this.ctx.showStatus("Nothing to copy");
			return;
		}
		try {
			copyToClipboard(text);
			const sanitized = sanitizeText(text);
			const preview = sanitized.length > 30 ? `${sanitized.slice(0, 30)}...` : sanitized;
			this.ctx.showStatus(`Copied: ${preview}`);
		} catch {
			this.ctx.showWarning("Failed to copy to clipboard");
		}
	}

	openCommandPalette(): void {
		if (this.#paletteCommandInFlight) {
			this.ctx.showStatus("A palette command is still running.");
			return;
		}

		this.ctx.showCommandPalette(this.#slashCommands, [...this.#commandPaletteActions.values()], async name => {
			if (this.#paletteCommandInFlight) {
				this.ctx.showStatus("A palette command is still running.");
				return;
			}

			if (this.ctx.editor.getText() || this.ctx.pendingImages.length > 0) {
				this.ctx.showStatus("Send or clear the draft before running a palette command.");
				return;
			}

			this.#paletteCommandInFlight = true;
			try {
				await this.submitText(`/${name}`, { ownsComposer: false, editor: this.ctx.editor });
			} finally {
				this.#paletteCommandInFlight = false;
			}
		});
	}

	cycleThinkingLevel(): void {
		const newLevel = this.ctx.session.cycleThinkingLevel();
		if (newLevel === undefined) {
			this.ctx.showStatus("Current model does not support thinking");
		} else {
			this.ctx.statusLine.invalidate();
			this.ctx.updateEditorBorderColor();
		}
	}

	async cycleRoleModel(options?: { temporary?: boolean }): Promise<void> {
		try {
			const cycleOrder = settings.get("cycleOrder");
			const result = await this.ctx.session.cycleRoleModels(cycleOrder, options);
			if (!result) {
				this.ctx.showStatus("Only one role model available");
				return;
			}

			this.ctx.statusLine.invalidate();
			this.ctx.updateEditorBorderColor();
			const roleLabel = result.role === "default" ? "default" : result.role;
			const roleLabelStyled = theme.bold(theme.fg("accent", roleLabel));
			const thinkingStr =
				result.model.thinking && result.thinkingLevel !== ThinkingLevel.Off
					? ` (thinking: ${result.thinkingLevel})`
					: "";
			const tempLabel = options?.temporary ? " (temporary)" : "";
			const cycleSeparator = theme.fg("dim", " > ");
			const cycleLabel = cycleOrder
				.map(role => {
					if (role === result.role) {
						return theme.bold(theme.fg("accent", role));
					}
					return theme.fg("muted", role);
				})
				.join(cycleSeparator);
			const orderLabel = ` (cycle: ${cycleLabel})`;
			this.ctx.showStatus(
				`Switched to ${roleLabelStyled}: ${result.model.name || result.model.id}${thinkingStr}${tempLabel}${orderLabel}`,
				{ dim: false },
			);
		} catch (error) {
			this.ctx.showError(error instanceof Error ? error.message : String(error));
		}
	}

	toggleToolOutputExpansion(): void {
		this.setToolsExpanded(!this.ctx.toolOutputExpanded);
	}

	scrollTmuxToPreviousUserInput(): void {
		const result = scrollTmuxPaneToPreviousUserInput();
		if (result.ok) return;

		if (result.reason === "not_inside_tmux") {
			this.ctx.showWarning("Previous-input scroll works only inside tmux.");
			return;
		}

		const detail = result.error ? `: ${result.error}` : ".";
		this.ctx.showWarning(`Failed to scroll tmux to previous user input${detail}`);
	}

	setToolsExpanded(expanded: boolean): void {
		this.ctx.toolOutputExpanded = expanded;
		for (const child of this.ctx.chatContainer.children) {
			if (isExpandable(child)) {
				// Callable guard: setManuallyExpanded is optional on the exported
				// contract, and hostile/legacy children may expose it as a
				// non-function property or an unstable getter. Read once, then
				// invoke only a real function; everything else falls back to the
				// automatic path.
				const setManuallyExpanded = child.setManuallyExpanded;
				if (typeof setManuallyExpanded === "function") {
					setManuallyExpanded.call(child, expanded);
				} else {
					child.setExpanded(expanded);
				}
			}
		}
		this.ctx.ui.requestRender();
	}

	toggleThinkingBlockVisibility(): void {
		this.ctx.hideThinkingBlock = !this.ctx.hideThinkingBlock;
		settings.set("hideThinkingBlock", this.ctx.hideThinkingBlock);
		this.ctx.session.agent.hideThinkingSummary = this.ctx.hideThinkingBlock;

		// Rebuild chat from session messages
		// Detach the live streaming component before the disposing clear() so the
		// component we re-add below is not torn down (detach != dispose).
		if (this.ctx.streamingComponent) {
			this.ctx.chatContainer.detachChild(this.ctx.streamingComponent);
		}
		this.ctx.rebuildChatFromMessages("reconcile-same-transcript");

		// If streaming, re-add the streaming component with updated visibility and re-render
		if (this.ctx.streamingComponent && this.ctx.streamingMessage) {
			this.ctx.streamingComponent.setHideThinkingBlock(this.ctx.hideThinkingBlock);
			this.ctx.streamingComponent.updateContent(this.ctx.streamingMessage, { streaming: true });
			this.ctx.chatContainer.addChild(this.ctx.streamingComponent);
		}

		this.ctx.showStatus(`Thinking blocks: ${this.ctx.hideThinkingBlock ? "hidden" : "visible"}`);
	}

	#getEditorTerminalPath(): string | null {
		if (process.platform === "win32") {
			return null;
		}
		return "/dev/tty";
	}

	async #openEditorTerminalHandle(): Promise<fs.FileHandle | null> {
		const terminalPath = this.#getEditorTerminalPath();
		if (!terminalPath) {
			return null;
		}
		try {
			return await fs.open(terminalPath, "r+");
		} catch {
			return null;
		}
	}

	async openExternalEditor(): Promise<void> {
		const editorCmd = getEditorCommand();
		if (!editorCmd) {
			this.ctx.showWarning("No editor configured. Set $VISUAL or $EDITOR environment variable.");
			return;
		}

		const currentText = this.ctx.editor.getExpandedText?.() ?? this.ctx.editor.getText();

		let ttyHandle: fs.FileHandle | null = null;
		try {
			ttyHandle = await this.#openEditorTerminalHandle();
			this.ctx.ui.stop();

			const stdio: [number | "inherit", number | "inherit", number | "inherit"] = ttyHandle
				? [ttyHandle.fd, ttyHandle.fd, ttyHandle.fd]
				: ["inherit", "inherit", "inherit"];

			const result = await openInEditor(editorCmd, currentText, { extension: ".gjc.md", stdio });
			if (result !== null) {
				this.ctx.editor.setText(result);
			}
		} catch (error) {
			this.ctx.showWarning(
				`Failed to open external editor: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			if (ttyHandle) {
				await ttyHandle.close();
			}

			this.ctx.ui.start();
			this.ctx.ui.requestRender();
		}
	}

	registerExtensionShortcuts(): void {
		const runner = this.ctx.session.extensionRunner;
		if (!runner) return;

		const shortcuts = runner.getShortcuts();
		for (const [keyId, shortcut] of shortcuts) {
			this.ctx.editor.setCustomKeyHandler(keyId, () => {
				const ctx = runner.createCommandContext();
				try {
					shortcut.handler(ctx);
				} catch (err) {
					runner.emitError({
						extensionPath: shortcut.extensionPath,
						event: "shortcut",
						error: err instanceof Error ? err.message : String(err),
						stack: err instanceof Error ? err.stack : undefined,
					});
				}
			});
		}
	}
}
