import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type AgentMessage, ThinkingLevel } from "@gajae-code/agent-core";
import { type AutocompleteProvider, getKeybindings, matchesKey, type SlashCommand } from "@gajae-code/tui";
import { $pickenv, logger, sanitizeText } from "@gajae-code/utils";
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
	type SubmittedUserInput,
	stopInteractiveActivityIndicator,
} from "../../modes/types";
import type { AgentSessionEvent, QueuedMessageEditEntry } from "../../session/agent-session";
import { SKILL_PROMPT_MESSAGE_TYPE, type SkillPromptDetails } from "../../session/messages";
import { getUserMessageViewportAnchorIds } from "../../session/session-manager";
import { executeBuiltinSlashCommand } from "../../slash-commands/builtin-registry";
import { copyToClipboard, pasteFromClipboard, readImageFromClipboard } from "../../utils/clipboard";
import { getEditorCommand, openInEditor } from "../../utils/external-editor";
import { ensureSupportedImageInput, ImageInputTooLargeError } from "../../utils/image-loading";
import { resizeImage } from "../../utils/image-resize";
import { loadPastedImageBatch, PastedImageBatchError } from "../../utils/pasted-image-loading";
import {
	decodePastedPathCandidate,
	formatPastedImageReference,
	locatePastedImageReferenceAroundCursor,
	parsePastedImagePaths,
} from "../../utils/pasted-image-path";
import { generateSessionTitle, setSessionTerminalTitle } from "../../utils/title-generator";
import { ActionRegistry, APP_ACTION_METADATA } from "../action-registry";
import { CommandPalette, type CommandPaletteAction, type CommandPaletteEntry } from "../components/command-palette";
import type { PasteTextContext } from "../components/custom-editor";
import { QueuePaneComponent } from "../components/queue-pane";
import { type QueuedMessageMoveDirection, QueuedMessageSelectorComponent } from "../components/queued-message-selector";
import { matchesAppInterrupt } from "../utils/keybinding-matchers";

const QUEUE_SELECTOR_NAVIGATION_ACTIONS = [
	"tui.select.up",
	"tui.select.down",
	"tui.select.pageUp",
	"tui.select.pageDown",
] as const;

/**
 * Navigation actions that already carry a registry callback and an availability
 * predicate but shipped with no curated command-palette entry and no key
 * dispatch, leaving them unreachable from the palette. They opt into
 * availability gating so an unavailable id is not listed, and each gets a remap
 * dispatch loop while keeping `defaultKeys: []` -- inert at defaults, but a user
 * binding now dispatches instead of only being rendered by the selector.
 */
export const AVAILABILITY_GATED_NAV_PALETTE_ACTIONS = [
	"app.session.dashboard",
	"app.transcript.browse",
	"app.transcript.prevTurn",
	"app.transcript.nextTurn",
	"app.queue.togglePane",
	"app.message.sendNow",
] as const satisfies readonly AppKeybinding[];

interface Expandable {
	setExpanded(expanded: boolean): void;
	setManuallyExpanded?(expanded: boolean): void;
}

export const INTERACTIVE_ABORT_CLEANUP_TIMEOUT_MS = 5_000;
export const BACKGROUND_FOLD_DOUBLE_PRESS_MS = 750;

const DRAFT_CLEAR_DOUBLE_ESCAPE_WINDOW_MS = 800;
const EMPTY_EDITOR_DOUBLE_ESCAPE_WINDOW_MS = 500;
const IMAGE_PLACEHOLDER_PATTERN = /\[image ([1-9]\d*)\]/g;
const ITERM_PET_DRAG_PATH_PATTERN = /^\/var\/folders\/[^/]+\/[^/]+\/T\/iTerm2\.[A-Za-z0-9]+\.gajae-pet\.(?:png|gif)$/;
const IMAGE_PLACEHOLDER_PRESENT_PATTERN = /\[image [1-9]\d*\]/;

function isItermPetDragPaste(text: string): boolean {
	return ITERM_PET_DRAG_PATH_PATTERN.test(decodePastedPathCandidate(text) ?? "");
}

interface InputControllerDependencies {
	loadPastedImageBatch?: typeof loadPastedImageBatch;
}

function isExpandable(obj: unknown): obj is Expandable {
	return typeof obj === "object" && obj !== null && "setExpanded" in obj && typeof obj.setExpanded === "function";
}

export class InputController {
	readonly actionRegistry: ActionRegistry<void>;
	readonly #loadPastedImageBatch: typeof loadPastedImageBatch;
	#deferredSubmission?: {
		text: string;
		images?: InteractiveModeContext["pendingImages"];
		composer: ComposerSubmissionOptions;
	};
	#imagePlaceholderDeletionUndo?: {
		beforeText: string;
		afterText: string;
		pendingImages: InteractiveModeContext["pendingImages"];
	};

	constructor(
		private ctx: InteractiveModeContext,
		dependencies: InputControllerDependencies = {},
	) {
		this.#loadPastedImageBatch = dependencies.loadPastedImageBatch ?? loadPastedImageBatch;
		this.actionRegistry = new ActionRegistry({
			context: undefined,
			showError: actionId => this.ctx.showError(actionId),
		});
		this.#registerActions();
		this.#installOAuthCopyListener();
	}

	#registerActions(): void {
		const callbacks: Partial<Record<(typeof APP_ACTION_METADATA)[number]["id"], () => void | Promise<void>>> = {
			"app.interrupt": () => this.ctx.editor.onEscape?.(),
			"app.clear": () => this.handleCtrlC(),
			"app.exit": () => this.handleCtrlD(),
			"app.suspend": () => this.handleCtrlZ(),
			"app.thinking.cycle": () => this.cycleThinkingLevel(),
			"app.thinking.toggle": () => this.toggleThinkingBlockVisibility(),
			"app.commandPalette.open": () => this.openCommandPalette(),
			"app.model.cycleForward": () => this.cycleRoleModel(),
			"app.model.cycleBackward": () => this.cycleRoleModel({ temporary: true }),
			"app.model.select": () => this.ctx.showModelSelector(),
			"app.model.selectTemporary": () => this.ctx.showModelSelector({ temporaryOnly: true }),
			"app.tools.expand": () => this.toggleToolOutputExpansion(),
			"app.tool.backgroundFold": () => {
				this.handleForegroundToolBackgroundFold();
			},
			"app.editor.external": () => this.openExternalEditor(),
			"app.message.followUp": () => this.handleFollowUp(),
			"app.message.queue": () => this.handleQueueSubmit(),
			"app.message.dequeue": () => this.handleDequeue(),
			"app.clipboard.pasteImage": async () => {
				await this.handleImagePaste();
			},
			"app.clipboard.pasteText": async () => {
				await this.handlePasteText();
			},
			"app.clipboard.copyLine": () => this.handleCopyCurrentLine(),
			"app.clipboard.copyPrompt": () => this.handleCopyPrompt(),
			"app.clipboard.copyOAuthUrl": () => this.ctx.copyOAuthUrl(),
			"app.session.new": async () => {
				await this.ctx.handleClearCommand();
			},
			"app.session.tree": () => this.ctx.showTreeSelector(),
			"app.session.fork": () => this.ctx.showUserMessageSelector(),
			"app.session.resume": () => this.ctx.showSessionSelector(),
			"app.session.observe": async () => {
				await this.ctx.showSessionObserver();
			},
			"app.session.dashboard": () => this.ctx.showSessionsDashboard(),
			"app.transcript.browse": () => this.ctx.showTranscriptViewer(),
			"app.jobs.open": () => this.ctx.showJobsOverlay(),
			"app.plan.toggle": () => this.ctx.planModeController.handleCommand(),
			"app.mode.cycle": () => this.ctx.planModeController.handleCommand(),
			"app.history.search": () => this.ctx.showHistorySearch(),
			"app.stt.toggle": () => this.ctx.handleSTTToggle(),
			"app.irc.sidebar.toggle": () => this.ctx.toggleIrcSidebar(),
			"app.transcript.prevTurn": () => this.#jumpTranscriptTurn(-1),
			"app.transcript.nextTurn": () => this.#jumpTranscriptTurn(1),
			"app.tasks.toggle": () => this.ctx.showTasksPane(),
			"app.todo.toggle": () => this.ctx.toggleTodoExpansion(),
			"app.queue.togglePane": () => this.toggleQueuePane(),
			"app.message.sendNow": () => this.sendNow(),
		};
		for (const metadata of APP_ACTION_METADATA) {
			const callback = callbacks[metadata.id];
			this.actionRegistry.register({
				...metadata,
				availability: () => Boolean(callback) && this.#isActionAvailable(metadata.id),
				execute: async () => {
					if (!callback) throw new Error(`Unavailable action executed: ${metadata.id}`);
					await callback();
				},
			});
		}
	}

	#isActionAvailable(id: (typeof APP_ACTION_METADATA)[number]["id"]): boolean {
		switch (id) {
			case "app.suspend":
				return process.platform !== "win32";
			case "app.thinking.cycle":
			case "app.thinking.toggle":
				return Boolean(this.ctx.session.model?.reasoning);
			case "app.commandPalette.open":
				return true;
			case "app.model.cycleForward":
			case "app.model.cycleBackward":
				return this.ctx.session.getRoleModelCycleCandidateCount() > 1;
			case "app.tools.expand":
				return this.ctx.chatContainer.children.some(isExpandable);
			case "app.tool.backgroundFold":
				return Boolean(this.ctx.session.hasForegroundBashBackgroundRequestHandler?.());
			case "app.editor.external":
				return Boolean(getEditorCommand());
			case "app.message.followUp":
				return (
					this.ctx.session.isStreaming ||
					this.ctx.session.isCompacting ||
					this.ctx.session.isBashRunning ||
					this.ctx.session.isEvalRunning
				);
			case "app.message.queue":
				return (
					this.ctx.editor.getText().trim().length > 0 &&
					(this.ctx.session.isStreaming ||
						this.ctx.session.isCompacting ||
						this.ctx.session.isBashRunning ||
						this.ctx.session.isEvalRunning)
				);
			case "app.message.dequeue":
				return (
					this.ctx.session.getQueuedMessageEntries().length > 0 || this.ctx.compactionQueuedMessages.length > 0
				);
			case "app.clipboard.copyPrompt":
				return this.ctx.editor.getText().length > 0;
			case "app.clipboard.copyOAuthUrl":
				return this.ctx.hasOAuthUrlForCopy();
			case "app.session.tree":
			case "app.session.fork":
				return this.ctx.session.messages.length > 0;
			case "app.plan.toggle":
				return this.ctx.planModeController.enabled && !this.ctx.goalModeController.enabled;
			case "app.history.search":
				return this.ctx.settings.get("history.enabled") !== false;
			case "app.stt.toggle":
				return Boolean(this.ctx.settings.get("stt.enabled"));
			case "app.transcript.browse":
				return this.ctx.session.messages.length > 0;
			case "app.transcript.prevTurn":
			case "app.transcript.nextTurn":
				return getUserMessageViewportAnchorIds(this.ctx.session.messages).length > 0;
			case "app.mode.cycle":
				return (
					Boolean(this.ctx.settings.get("plan.enabled")) &&
					!this.ctx.goalModeController.enabled &&
					!this.ctx.goalModeController.paused
				);
			case "app.todo.toggle":
				return this.ctx.todoPhases.some(phase => phase.tasks.length > 0);
			case "app.queue.togglePane":
				return true;
			case "app.message.sendNow":
				// `sendNow()` falls back to `getQueuedMessageEntries()[0]`, which returns
				// only visible steering/follow-up entries, so advertising the action for
				// hidden next-turn context enabled a keybinding whose only outcome is
				// "No visible queued message to send".
				return (
					this.ctx.session.isStreaming &&
					(this.ctx.editor.getText().trim().length > 0 || this.ctx.session.drainableQueuedMessageCount > 0)
				);
			default:
				return true;
		}
	}

	#executeAction(id: (typeof APP_ACTION_METADATA)[number]["id"]): void {
		void this.actionRegistry.executeFresh(id);
	}

	#transcriptTurnAnchorIds: readonly string[] = [];
	#transcriptTurnPosition = 0;

	#syncTranscriptTurnPosition(): readonly string[] {
		const anchorIds = getUserMessageViewportAnchorIds(this.ctx.session.messages);
		if (
			anchorIds.length !== this.#transcriptTurnAnchorIds.length ||
			anchorIds.some(id => !this.#transcriptTurnAnchorIds.includes(id))
		) {
			const hadAnchors = this.#transcriptTurnAnchorIds.length > 0;
			const currentAnchorId = this.#transcriptTurnAnchorIds[this.#transcriptTurnPosition];
			const retainedAnchorIds = this.#transcriptTurnAnchorIds.filter(id => anchorIds.includes(id));
			this.#transcriptTurnAnchorIds = [
				...retainedAnchorIds,
				...anchorIds.filter(id => !retainedAnchorIds.includes(id)),
			];
			const currentPosition = currentAnchorId ? this.#transcriptTurnAnchorIds.indexOf(currentAnchorId) : -1;
			this.#transcriptTurnPosition =
				currentPosition >= 0
					? currentPosition
					: currentAnchorId || hadAnchors
						? Math.min(this.#transcriptTurnPosition, this.#transcriptTurnAnchorIds.length)
						: this.#transcriptTurnAnchorIds.length;
		}
		return this.#transcriptTurnAnchorIds;
	}

	#jumpTranscriptTurn(direction: -1 | 1): void {
		const anchorIds = this.#syncTranscriptTurnPosition();
		const targetPosition = this.#transcriptTurnPosition + direction;
		if (targetPosition < 0 || targetPosition >= anchorIds.length) return;
		if (this.ctx.ui.revealViewportAnchor(anchorIds[targetPosition], "top")) {
			this.#transcriptTurnPosition = targetPosition;
		}
	}

	#lastBackgroundFoldKeyTime = 0;
	#slashCommands: SlashCommand[] = [];

	/** Set after a first Esc silently consumes a queued steer. Kept until the
	 *  queued steer is either cancelled by a second Esc or drained by continuation,
	 *  so abort cleanup going idle cannot turn the second Esc into an idle action. */
	#steerConsumePending = false;
	#commandPaletteActions = new Map<AppKeybinding, CommandPaletteAction>();
	/** Opt-in subset of `#commandPaletteActions` whose listing is filtered by the
	 *  action registry's availability predicate. Deliberately a sibling set rather
	 *  than a blanket filter over every curated entry: filtering all of them would
	 *  change visible palette contents for pre-existing thinking, model-cycle,
	 *  editor, copy, queue, and session actions, which is a separate reviewed
	 *  migration and not this change. */
	readonly #availabilityGatedPaletteActions = new Set<AppKeybinding>();
	#paletteCommandInFlight = false;

	#registerCommandPaletteAction(
		action: AppKeybinding,
		handler: () => void | Promise<void>,
		availabilityGated = false,
	): void {
		this.#commandPaletteActions.set(action, {
			id: action,
			label: KEYBINDINGS[action].description,
			handler,
		});
		if (availabilityGated) this.#availabilityGatedPaletteActions.add(action);
	}

	#globalInterruptUnsubscribe: (() => void) | undefined;
	#oauthCopyUnsubscribe: (() => void) | undefined;
	#draftClearEscapeText: string | undefined;

	#resetEscapeGestures(): void {
		this.ctx.lastEscapeTime = 0;
		this.ctx.lastComposerClearEscapeTime = 0;
		this.#draftClearEscapeText = undefined;
	}

	#installOAuthCopyListener(): void {
		if (typeof this.ctx.ui?.addInputListener !== "function") return;
		this.#oauthCopyUnsubscribe?.();
		this.#oauthCopyUnsubscribe = this.ctx.ui.addInputListener(data => {
			if (this.ctx.hasOAuthUrlForCopy?.() !== true) return;
			// Focused overlays own cancellation. In particular, a user remap of
			// copyOAuthUrl to Ctrl+C/Escape must not steal the wizard's interrupt.
			if (data === "\x03" || matchesAppInterrupt(data)) return;
			if (this.ctx.keybindings.getKeys("app.clipboard.copyOAuthUrl").some(key => matchesKey(data, key))) {
				this.#executeAction("app.clipboard.copyOAuthUrl");
				return { consume: true };
			}
		});
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

	#matchesClearKey(data: string): boolean {
		return this.ctx.keybindings.getKeys("app.clear").some(key => matchesKey(data, key));
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

	#handlePendingSteerInterrupt(): boolean {
		if (!this.#steerConsumePending) return false;
		this.#resetEscapeGestures();
		if (!this.ctx.session.hasQueuedSteering) {
			this.#steerConsumePending = false;
			return false;
		}

		this.#steerConsumePending = false;
		this.restoreQueuedMessagesToEditor({ abort: true });
		return true;
	}

	#handleCancellableWorkEscape(options: {
		loading?: boolean;
		processes?: boolean;
		modes?: boolean;
		maintenance?: boolean;
		retry?: "escape" | "clear";
		streaming?: boolean;
	}): boolean {
		if (options.loading && this.ctx.loadingAnimation) {
			if (this.ctx.cancelPendingSubmission()) {
				return true;
			}
			if (options.processes && this.ctx.session.isBashRunning) {
				this.ctx.session.abortBash();
				return true;
			}
			if (options.processes && this.ctx.session.isEvalRunning) {
				this.ctx.session.abortEval();
				return true;
			}
			// A queued steer on a live stream is owned by the steering branch below,
			// which silently consumes it and auto-continues. This branch counts the same
			// queue as cancellable work, and a streaming turn always has the indicator
			// mounted, so without this hand-off it short-circuited first and turned the
			// documented steer-on-interrupt into a loud abort that dumped the steer back
			// into the composer. `cancelPendingSubmission()` above still wins: a
			// submission that has not started yet is cancelled before the stream owns
			// the key, and one that has started returns false there by design.
			if (
				options.streaming === true &&
				this.ctx.session.isStreaming &&
				this.ctx.session.hasQueuedSteering &&
				!this.ctx.session.isBashRunning &&
				!this.ctx.session.isEvalRunning &&
				!this.#steerConsumePending
			) {
				this.#steerConsumePending = true;
				void this.#abortInteractive({ silent: true });
				return true;
			}
			// Only count queues this handler can actually drain. The aggregate
			// `queuedMessageCount` also counts hidden next-turn context, which
			// `restoreQueuedMessagesToEditor()` never returns and which survives turn
			// completion by design, so gating on the aggregate left a permanently
			// nonzero count that made every press a no-op abort — the #4741 lockout.
			const hasCancellableWork =
				this.ctx.hasPendingSubmission() ||
				this.ctx.session.drainableQueuedMessageCount > 0 ||
				(this.ctx.compactionQueuedMessages?.length ?? 0) > 0 ||
				this.ctx.session.isStreaming ||
				this.ctx.session.isCompacting;
			if (hasCancellableWork) {
				this.restoreQueuedMessagesToEditor({ abort: true });
				return true;
			}
			// The loader outlived its turn and no submission is pending (a started
			// submission still inside prompt preflight stays cancellable above, so
			// Esc aborts it instead of letting it start later), so nothing is
			// cancellable even though the busy indicator is still mounted (#4741).
			// Stop the stale indicator so completed work clears the busy state and
			// keep evaluating the remaining states; when none match, the key falls
			// through to idle semantics instead of a no-op abort that swallows it.
			stopInteractiveActivityIndicator(this.ctx, { foregroundSettled: true });
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
				if (options.retry === "clear" || this.ctx.retryEscapePrimed) {
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
			const isInterruptKey = this.#matchesInterruptKey(data);
			const isClearKey = this.#matchesClearKey(data);
			if (!isInterruptKey && !isClearKey) {
				return undefined;
			}
			if (isClearKey && !isInterruptKey && this.ctx.hasActiveBtw() && this.ctx.handleBtwEscape()) {
				this.#resetEscapeGestures();
				return { consume: true };
			}
			if (isClearKey && !isInterruptKey && this.ctx.hookSelector?.hasActiveInlineInput?.() === true) {
				this.#resetEscapeGestures();
				return undefined;
			}
			if (isClearKey && !isInterruptKey) {
				if (this.#handlePendingSteerInterrupt()) return { consume: true };
				if (
					this.#handleCancellableWorkEscape({
						loading: true,
						processes: true,
						modes: true,
						maintenance: true,
						retry: "clear",
						streaming: true,
					})
				) {
					this.#resetEscapeGestures();
					return { consume: true };
				}
				// A stale loader was stopped and nothing else consumed the clear key:
				// release it to the editor so the idle clear path still runs (#4741).
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
					retry: "escape",
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
		this.#installOAuthCopyListener();

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
			if (this.#handlePendingSteerInterrupt()) return;
			if (this.#handleCancellableWorkEscape({ maintenance: true, retry: "escape" })) {
				this.#resetEscapeGestures();
				return;
			}
			if (
				this.#handleCancellableWorkEscape({
					loading: true,
					processes: true,
					modes: true,
					maintenance: true,
					retry: "escape",
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
		this.ctx.editor.onClear = () => this.#executeAction("app.clear");
		this.#registerCommandPaletteAction("app.clear", clear);
		const exit = () => this.handleCtrlD();
		this.ctx.editor.setActionKeys("app.exit", this.ctx.keybindings.getKeys("app.exit"));
		this.ctx.editor.onExit = () => this.#executeAction("app.exit");
		this.#registerCommandPaletteAction("app.exit", exit);
		const suspend = () => this.handleCtrlZ();
		this.ctx.editor.setActionKeys("app.suspend", this.ctx.keybindings.getKeys("app.suspend"));
		this.ctx.editor.onSuspend = () => this.#executeAction("app.suspend");
		this.#registerCommandPaletteAction("app.suspend", suspend);
		const cycleThinking = () => this.cycleThinkingLevel();
		this.ctx.editor.setActionKeys("app.thinking.cycle", this.ctx.keybindings.getKeys("app.thinking.cycle"));
		this.ctx.editor.onCycleThinkingLevel = () => this.#executeAction("app.thinking.cycle");
		this.#registerCommandPaletteAction("app.thinking.cycle", cycleThinking);
		this.ctx.editor.setActionKeys("app.commandPalette.open", this.ctx.keybindings.getKeys("app.commandPalette.open"));
		this.ctx.editor.onOpenCommandPalette = () => this.#executeAction("app.commandPalette.open");
		const cycleModelForward = () => this.cycleRoleModel();
		this.ctx.editor.setActionKeys("app.model.cycleForward", this.ctx.keybindings.getKeys("app.model.cycleForward"));
		this.ctx.editor.onCycleModelForward = () => this.#executeAction("app.model.cycleForward");
		this.#registerCommandPaletteAction("app.model.cycleForward", cycleModelForward);
		const cycleModelBackward = () => this.cycleRoleModel({ temporary: true });
		this.ctx.editor.setActionKeys("app.model.cycleBackward", this.ctx.keybindings.getKeys("app.model.cycleBackward"));
		this.ctx.editor.onCycleModelBackward = () => this.#executeAction("app.model.cycleBackward");
		this.#registerCommandPaletteAction("app.model.cycleBackward", cycleModelBackward);
		const selectTemporaryModel = () => this.ctx.showModelSelector({ temporaryOnly: true });
		this.ctx.editor.setActionKeys(
			"app.model.selectTemporary",
			this.ctx.keybindings.getKeys("app.model.selectTemporary"),
		);
		this.ctx.editor.onSelectModelTemporary = () => this.#executeAction("app.model.selectTemporary");
		this.#registerCommandPaletteAction("app.model.selectTemporary", selectTemporaryModel);

		// Global debug handler on TUI (works regardless of focus)
		this.ctx.ui.onDebug = () => this.ctx.showDebugSelector();
		const selectModel = () => this.ctx.showModelSelector();
		this.ctx.editor.setActionKeys("app.model.select", this.ctx.keybindings.getKeys("app.model.select"));
		this.ctx.editor.onSelectModel = () => this.#executeAction("app.model.select");
		this.#registerCommandPaletteAction("app.model.select", selectModel);
		const searchHistory = () => this.ctx.showHistorySearch();
		this.ctx.editor.setActionKeys("app.history.search", this.ctx.keybindings.getKeys("app.history.search"));
		this.ctx.editor.onHistorySearch = () => this.#executeAction("app.history.search");
		this.#registerCommandPaletteAction("app.history.search", searchHistory);
		const toggleThinking = () => this.ctx.toggleThinkingBlockVisibility();
		this.ctx.editor.setActionKeys("app.thinking.toggle", this.ctx.keybindings.getKeys("app.thinking.toggle"));
		this.ctx.editor.onToggleThinking = () => this.#executeAction("app.thinking.toggle");
		this.#registerCommandPaletteAction("app.thinking.toggle", toggleThinking);
		const externalEditor = () => this.openExternalEditor();
		this.ctx.editor.setActionKeys("app.editor.external", this.ctx.keybindings.getKeys("app.editor.external"));
		this.ctx.editor.onExternalEditor = () => this.#executeAction("app.editor.external");
		this.#registerCommandPaletteAction("app.editor.external", externalEditor);
		this.ctx.editor.onShowHotkeys = () => this.ctx.handleHotkeysCommand();
		const pasteImageFromPalette = async () => {
			await this.handleImagePaste();
		};
		this.ctx.editor.setActionKeys(
			"app.clipboard.pasteImage",
			this.ctx.keybindings.getKeys("app.clipboard.pasteImage"),
		);
		this.ctx.editor.onPasteImage = () => this.actionRegistry.execute("app.clipboard.pasteImage");
		this.#registerCommandPaletteAction("app.clipboard.pasteImage", pasteImageFromPalette);
		const pasteTextFromPalette = async () => {
			await this.handlePasteText();
		};
		this.#registerCommandPaletteAction("app.clipboard.pasteText", pasteTextFromPalette);
		const copyPrompt = () => this.handleCopyPrompt();
		this.ctx.editor.setActionKeys(
			"app.clipboard.copyPrompt",
			this.ctx.keybindings.getKeys("app.clipboard.copyPrompt"),
		);
		this.ctx.editor.onCopyPrompt = () => this.#executeAction("app.clipboard.copyPrompt");
		this.#registerCommandPaletteAction("app.clipboard.copyPrompt", copyPrompt);
		this.#registerCommandPaletteAction("app.clipboard.copyOAuthUrl", () => this.ctx.copyOAuthUrl(), true);
		this.ctx.editor.onPasteText = (text, context) => this.handleTextPaste(text, context);
		this.ctx.editor.onPastePendingInputCleared = (reason, restoredInputCount) => {
			const reasonText = reason === "timeout" ? "timed out" : "exceeded the input queue limit";
			this.ctx.showWarning(
				`Paste handling ${reasonText}; restored the original paste and ${restoredInputCount} buffered input event${restoredInputCount === 1 ? "" : "s"}.`,
			);
		};
		const expandTools = () => this.toggleToolOutputExpansion();
		this.ctx.editor.setActionKeys("app.tools.expand", this.ctx.keybindings.getKeys("app.tools.expand"));
		this.ctx.editor.onExpandTools = () => this.#executeAction("app.tools.expand");
		this.#registerCommandPaletteAction("app.tools.expand", expandTools);
		const dequeue = () => this.handleDequeue();
		this.ctx.editor.setActionKeys("app.message.dequeue", this.ctx.keybindings.getKeys("app.message.dequeue"));
		this.ctx.editor.onDequeue = () => this.#executeAction("app.message.dequeue");
		this.#registerCommandPaletteAction("app.message.dequeue", dequeue);
		const queue = () => this.#executeAction("app.message.queue");
		this.ctx.editor.setActionKeys("app.message.queue", this.ctx.keybindings.getKeys("app.message.queue"));
		this.ctx.editor.onQueue = () => this.#executeAction("app.message.queue");
		this.#registerCommandPaletteAction("app.message.queue", queue, true);

		this.ctx.editor.onViewportPageScroll = direction => this.ctx.ui.scrollViewportPages(direction);
		this.ctx.editor.onViewportFollowLive = () => {
			this.ctx.ui.followLiveViewport();
		};

		this.ctx.editor.clearCustomKeyHandlers();
		for (const key of new Set([
			...this.ctx.keybindings.getKeys("tui.editor.deleteCharBackward"),
			"shift+backspace" as const,
		])) {
			this.ctx.editor.setCustomKeyHandler(key, () => this.#deleteImagePlaceholderBeforeCursor());
		}
		// Wire up extension shortcuts
		this.registerExtensionShortcuts();

		for (const key of this.ctx.keybindings.getKeys("app.irc.sidebar.toggle")) {
			this.ctx.editor.setCustomKeyHandler(key, () => {
				this.#executeAction("app.irc.sidebar.toggle");
				return true;
			});
		}

		const togglePlanMode = () => this.ctx.planModeController.handleCommand();
		this.#registerCommandPaletteAction("app.plan.toggle", togglePlanMode);
		for (const key of this.ctx.keybindings.getKeys("app.plan.toggle")) {
			this.ctx.editor.setCustomKeyHandler(key, () => {
				this.#executeAction("app.plan.toggle");
				return true;
			});
		}
		const newSession = async () => {
			await this.ctx.handleClearCommand();
		};
		this.#registerCommandPaletteAction("app.session.new", newSession);
		for (const key of this.ctx.keybindings.getKeys("app.session.new")) {
			this.ctx.editor.setCustomKeyHandler(key, () => {
				this.#executeAction("app.session.new");
				return true;
			});
		}
		const showTree = () => {
			this.ctx.showTreeSelector();
			return undefined;
		};
		this.#registerCommandPaletteAction("app.session.tree", showTree);
		for (const key of this.ctx.keybindings.getKeys("app.session.tree")) {
			this.ctx.editor.setCustomKeyHandler(key, () => {
				this.#executeAction("app.session.tree");
				return true;
			});
		}
		const forkSession = () => {
			this.ctx.showUserMessageSelector();
			return undefined;
		};
		this.#registerCommandPaletteAction("app.session.fork", forkSession);
		for (const key of this.ctx.keybindings.getKeys("app.session.fork")) {
			this.ctx.editor.setCustomKeyHandler(key, () => {
				this.#executeAction("app.session.fork");
				return true;
			});
		}
		const resumeSession = () => {
			this.ctx.showSessionSelector();
			return undefined;
		};
		this.#registerCommandPaletteAction("app.session.resume", resumeSession);
		for (const key of this.ctx.keybindings.getKeys("app.session.resume")) {
			this.ctx.editor.setCustomKeyHandler(key, () => {
				this.#executeAction("app.session.resume");
				return true;
			});
		}
		// Six navigation actions that shipped with a registry callback and an
		// availability predicate but no curated palette entry and no key dispatch.
		// The palette handler routes through `#executeAction` so the registry's
		// availability check is enforced on selection as well as on listing, and
		// `defaultKeys` stays `[]` per the settled no-new-defaults boundary.
		for (const id of AVAILABILITY_GATED_NAV_PALETTE_ACTIONS) {
			this.#registerCommandPaletteAction(id, () => this.#executeAction(id), true);
			for (const key of this.ctx.keybindings.getKeys(id)) {
				this.ctx.editor.setCustomKeyHandler(key, () => {
					if (!this.actionRegistry.isAvailable(id)) return false;
					this.#executeAction(id);
					return true;
				});
			}
		}
		for (const key of this.ctx.keybindings.getKeys("app.message.followUp")) {
			this.ctx.editor.setCustomKeyHandler(key, () => {
				if (!this.actionRegistry.isAvailable("app.message.followUp")) return false;
				this.#executeAction("app.message.followUp");
				return true;
			});
		}
		for (const key of this.ctx.keybindings.getKeys("app.stt.toggle")) {
			this.ctx.editor.setCustomKeyHandler(key, () => {
				this.#executeAction("app.stt.toggle");
				return true;
			});
		}
		for (const key of this.ctx.keybindings.getKeys("app.clipboard.copyLine")) {
			this.ctx.editor.setCustomKeyHandler(key, () => {
				this.#executeAction("app.clipboard.copyLine");
			});
		}
		for (const key of this.ctx.keybindings.getKeys("app.session.observe")) {
			this.ctx.editor.setCustomKeyHandler(key, () => {
				this.#executeAction("app.session.observe");
			});
		}
		for (const key of this.ctx.keybindings.getKeys("app.jobs.open")) {
			this.ctx.editor.setCustomKeyHandler(key, () => {
				this.#executeAction("app.jobs.open");
			});
		}
		for (const key of this.ctx.keybindings.getKeys("app.tasks.toggle")) {
			this.ctx.editor.setCustomKeyHandler(key, () => {
				this.#executeAction("app.tasks.toggle");
				return true;
			});
		}
		// The todo HUD renders a `+N more` row but had no way to expand it:
		// `toggleTodoExpansion()` had no caller anywhere in src/. The palette entry
		// opts into availability gating so it is not offered with an empty model.
		this.#registerCommandPaletteAction("app.todo.toggle", () => this.#executeAction("app.todo.toggle"), true);
		for (const key of this.ctx.keybindings.getKeys("app.todo.toggle")) {
			this.ctx.editor.setCustomKeyHandler(key, () => {
				if (!this.actionRegistry.isAvailable("app.todo.toggle")) return false;
				this.#executeAction("app.todo.toggle");
				return true;
			});
		}
		for (const key of this.ctx.keybindings.getKeys("app.tool.backgroundFold")) {
			this.ctx.editor.setCustomKeyHandler(key, () => {
				if (!this.actionRegistry.isAvailable("app.tool.backgroundFold")) return false;
				this.#executeAction("app.tool.backgroundFold");
				return true;
			});
		}

		// Tab on an empty composer accepts the pending ghost-text prompt suggestion.
		this.ctx.editor.onTab = (text: string) => this.ctx.promptSuggestion?.tryAcceptOnTab(text) === true;

		this.ctx.editor.onUndo = text => this.#restorePendingImagesAfterPlaceholderUndo(text);
		this.ctx.editor.onChange = (text: string) => {
			this.#resetEscapeGestures();
			this.ctx.promptSuggestion?.notifyEditorChanged(text);
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
		this.#imagePlaceholderDeletionUndo = undefined;
		text = text.trim();
		const submittedBashMode = this.ctx.isBashMode;
		const submittedBashNoContext = this.ctx.isBashNoContext;
		if ((!isSettingsInitialized() || settings.get("emojiAutocomplete")) && text) text = expandEmoticons(text);
		if (this.ctx.hasActiveBtw()) {
			if (!text) return;
			if (!text.startsWith("/")) {
				const result = await this.ctx.handleBtwFollowUp(text);
				if (result === "accepted" && this.#canModifyComposer(composer)) {
					this.ctx.editor.setText("");
					this.ctx.pendingImages = [];
				}
				return;
			}
		}

		if (/^\/btw(?:\s|$)/.test(text)) {
			const slashResult = await executeBuiltinSlashCommand(text, {
				ctx: this.ctx,
				handleBackgroundCommand: () => this.handleBackgroundCommand(),
				composer,
			});
			if (slashResult === true) {
				this.ctx.pendingImages = [];
				return;
			}
		}

		// Empty submit while streaming with queued messages: flush queues immediately.
		// Only drainable queues justify the abort — aborting for hidden next-turn
		// context would kill the live turn without flushing anything, since that
		// context is not delivered by the resume path this abort relies on.
		if (!text && this.ctx.session.isStreaming && this.ctx.session.drainableQueuedMessageCount > 0) {
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
				const handledText = result.text === undefined ? "" : sanitizeText(result.text).trim();
				if (handledText) {
					this.ctx.addMessageToChat({
						role: "custom",
						customType: "extension-input-result",
						content: handledText,
						display: true,
						timestamp: Date.now(),
					});
					this.ctx.ui.requestRender();
				}
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
		const hasExplicitShellPrefix = text.startsWith("!");
		const hasExplicitNoContextPrefix = text.startsWith("!!");
		const shellMode = submittedBashMode || hasExplicitShellPrefix;
		if (shellMode) {
			const isExcluded = hasExplicitNoContextPrefix || (!hasExplicitShellPrefix && submittedBashNoContext);
			const command = hasExplicitNoContextPrefix
				? text.slice(2).trim()
				: hasExplicitShellPrefix
					? text.slice(1).trim()
					: text.trim();
			const historyText = hasExplicitShellPrefix ? text : `${isExcluded ? "!!" : "!"}${text}`;
			if (command) {
				if (this.ctx.session.isBashRunning) {
					this.ctx.showWarning("A bash command is already running. Press Esc to cancel it first.");
					if (this.#canModifyComposer(composer)) {
						const isBashMode = hasExplicitShellPrefix || submittedBashMode;
						const isBashNoContext = hasExplicitShellPrefix ? hasExplicitNoContextPrefix : submittedBashNoContext;
						this.ctx.editor.setText(text);
						this.ctx.isBashMode = isBashMode;
						this.ctx.isBashNoContext = isBashNoContext;
						this.ctx.updateEditorBorderColor();
					}
					return;
				}
				if (this.#canModifyComposer(composer)) {
					this.ctx.editor.addToHistory(historyText);
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
					: { streamingBehavior, images, steerQueuePolicy: "sequential" as const };
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
		if (!hasUserMessages && !this.ctx.sessionManager.getSessionName() && !$pickenv("GJC_NO_TITLE", "PI_NO_TITLE")) {
			const registry = this.ctx.session.modelRegistry;
			generateSessionTitle(
				text,
				registry,
				this.ctx.settings,
				this.ctx.session.credentialSessionId,
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
		} else if (!this.#deferredSubmission) {
			const images = inputImages && inputImages.length > 0 ? [...inputImages] : undefined;
			this.#deferredSubmission = { text, images, composer };
			if (this.#canModifyComposer(composer)) {
				this.ctx.editor.setText("");
				this.#clearPendingImagesIfOwnedBy(pendingImages, composer);
				this.ctx.editor.addToHistory(text);
			}
			return;
		} else {
			this.ctx.showStatus("Your previous message is waiting to be sent. Keep this draft and send it again shortly.");
			return;
		}
		if (this.#canModifyComposer(composer)) {
			this.ctx.editor.addToHistory(text);
		}
	}

	takeDeferredSubmission(): SubmittedUserInput | undefined {
		const deferredSubmission = this.#deferredSubmission;
		if (!deferredSubmission) return undefined;
		this.#deferredSubmission = undefined;
		return this.ctx.startPendingSubmission(
			{ text: deferredSubmission.text, images: deferredSubmission.images },
			{ ownsComposer: false, editor: deferredSubmission.composer.editor },
		);
	}

	takeDeferredSubmissionForShutdown(): { text: string; images?: InteractiveModeContext["pendingImages"] } | undefined {
		const deferredSubmission = this.#deferredSubmission;
		if (!deferredSubmission) return undefined;
		this.#deferredSubmission = undefined;
		return {
			text: deferredSubmission.text,
			images: deferredSubmission.images,
		};
	}

	discardDeferredSubmission(): void {
		this.#deferredSubmission = undefined;
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

	#queuePaneOverlay: ReturnType<typeof this.ctx.ui.showOverlay> | undefined;

	toggleQueuePane(): void {
		if (this.#queuePaneOverlay) {
			this.#queuePaneOverlay.hide();
			this.#queuePaneOverlay = undefined;
			this.ctx.ui.setFocus(this.ctx.editor);
			this.ctx.ui.requestRender(true);
			return;
		}
		this.#showQueuePane();
	}

	#showQueuePane(selectedIndex = 0): void {
		const entries = this.ctx.session.getQueuedMessageEntries();
		if (entries.length === 0) {
			this.ctx.showStatus("No queued messages");
			return;
		}
		const close = () => {
			this.#queuePaneOverlay?.hide();
			this.#queuePaneOverlay = undefined;
			this.ctx.ui.setFocus(this.ctx.editor);
			this.ctx.ui.requestRender(true);
		};
		const refresh = (nextIndex: number) => {
			this.#queuePaneOverlay?.hide();
			this.#queuePaneOverlay = undefined;
			this.#showQueuePane(nextIndex);
		};
		const pane = new QueuePaneComponent(entries, {
			selectedIndex,
			formatKeyHint: key => this.ctx.keybindings.formatKeyHint(key),
			formatSelectAction: action => this.ctx.keybindings.getDisplayString(action),
			matchesSelectAction: (keyData, action) =>
				this.ctx.keybindings.getKeys(action).some(key => matchesKey(keyData, key)),
			resolveSelectNavigation: keyData =>
				QUEUE_SELECTOR_NAVIGATION_ACTIONS.find(action =>
					this.ctx.keybindings.getKeys(action).some(key => matchesKey(keyData, key)),
				),
			onSelect: entry => {
				const restored = this.#restoreQueuedMessageToEditor(entry);
				close();
				this.ctx.showStatus(
					restored === 0 ? "Queued message is no longer available" : "Restored queued message to editor",
				);
			},
			onDelete: (entry, index) => {
				const deleted = this.ctx.session.removeQueuedMessageForEditing(entry.id) !== undefined;
				const remaining = this.ctx.session.getQueuedMessageEntries();
				this.ctx.updatePendingMessagesDisplay();
				if (remaining.length === 0) {
					close();
					this.ctx.showStatus(deleted ? "Deleted queued message" : "Queued message is no longer available");
					return;
				}
				this.ctx.showStatus(deleted ? "Deleted queued message" : "Queued message is no longer available");
				refresh(Math.min(index, remaining.length - 1));
			},
			onMove: (entry, index, direction) => {
				const moved = this.ctx.session.moveQueuedMessageForEditing(entry.id, direction);
				this.ctx.updatePendingMessagesDisplay();
				this.ctx.showStatus(moved ? "Moved queued message" : "Queued message cannot move further");
				refresh(Math.max(0, Math.min(index + (direction === "up" ? -1 : 1), entries.length - 1)));
			},
			onClose: close,
		});
		this.#queuePaneOverlay = this.ctx.ui.showOverlay(pane, {
			anchor: "bottom-center",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
		});
		this.ctx.ui.setFocus(pane);
		this.ctx.ui.requestRender();
	}

	async sendNow(): Promise<void> {
		const composerText = this.ctx.editor.getText().trim();
		let text = composerText;
		let queuedEntryId: string | undefined;
		if (!text) {
			if (this.ctx.session.isCompacting) {
				this.ctx.showWarning("Cannot send immediately while compaction is in progress");
				return;
			}
			const entry = this.ctx.session.getQueuedMessageEntries()[0];
			if (!entry) {
				this.ctx.showStatus("No visible queued message to send");
				return;
			}
			text = entry.text;
			queuedEntryId = entry.id;
		}
		const outcome = await this.ctx.session.cancelAndSubmit(text, { queuedEntryId });
		if (outcome.kind === "submitted") {
			if (composerText) this.ctx.clearEditor();
			this.ctx.updatePendingMessagesDisplay();
			return;
		}
		if (outcome.kind === "rolled_back") {
			this.ctx.showWarning(
				outcome.outcome.kind === "timeout"
					? "Send was cancelled after forced recovery; queued messages were restored"
					: "Send failed; queued messages were restored",
			);
			return;
		}
		if (outcome.reason === "compaction") {
			this.ctx.showWarning("Cannot send immediately while compaction is in progress");
		} else {
			this.ctx.showStatus("Send already in progress");
		}
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
			{
				selectedIndex,
				formatKeyHint: key => this.ctx.keybindings.formatKeyHint(key),
				formatSelectAction: action => this.ctx.keybindings.getDisplayString(action),
				matchesSelectAction: (keyData, action) =>
					this.ctx.keybindings.getKeys(action).some(key => matchesKey(keyData, key)),
				resolveSelectNavigation: keyData =>
					QUEUE_SELECTOR_NAVIGATION_ACTIONS.find(action =>
						this.ctx.keybindings.getKeys(action).some(key => matchesKey(keyData, key)),
					),
			},
		);
		// The composer is reusable across overlays; detach it before clearing so
		// clear() disposes only the transient selector, not the editor's
		// tab-width listener (disposal is terminal).
		this.ctx.editorContainer.detachChild(this.ctx.editor);
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
					agentDir: this.ctx.session.getSessionAgentDir?.() ?? this.ctx.settings.getAgentDir?.(),
					sessionId: this.ctx.session.sessionId,
					skillName: invocation.skill.name,
					args: invocation.args,
				});
			const built = await buildSkillPromptMessage(invocation.skill, activationResult.cleanedArgs, {
				subskillActivation: activationResult.activation,
				subskillActivationSet: activationResult.activeSubskillsToPersist,
				cwd: this.ctx.sessionManager.getCwd(),
				agentDir: this.ctx.session.getSessionAgentDir?.() ?? this.ctx.settings.getAgentDir?.(),
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
						: { streamingBehavior, steerQueuePolicy: "sequential" },
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
		// While /btw is open, plain text stays in the side chat. Slash-origin
		// input keeps normal dispatch so commands remain available.
		if (this.ctx.hasActiveBtw() && !text.startsWith("/")) {
			if ((await this.ctx.handleBtwFollowUp(text)) === "accepted") {
				this.ctx.editor.setText("");
			}
			return;
		}

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

		// Foreground bash/eval owns the process fence. Queue all prompt text,
		// including slash skill input, until the process settles instead of
		// expanding a skill and starting a competing model turn.
		if (this.ctx.session.isBashRunning || this.ctx.session.isEvalRunning) {
			this.ctx.editor.addToHistory(text);
			this.ctx.editor.setText("");
			await this.ctx.withLocalSubmission(text, () =>
				this.ctx.session.followUp(text, undefined, {
					followUpQueuePolicy: "sequential",
				}),
			);
			this.ctx.updatePendingMessagesDisplay();
			this.ctx.ui.requestRender();
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
		if (now - this.#lastBackgroundFoldKeyTime > BACKGROUND_FOLD_DOUBLE_PRESS_MS) {
			this.#lastBackgroundFoldKeyTime = now;
			const foldKeys = getKeybindings().getKeys("app.tool.backgroundFold");
			this.ctx.showStatus(
				`Press ${foldKeys.join(" / ")} again to fold supported foreground bash into a background job`,
			);
			return true;
		}
		this.#lastBackgroundFoldKeyTime = 0;

		try {
			const request = this.ctx.session.requestForegroundBashBackground?.() ?? Promise.resolve(false);
			void request
				.then(backgrounded => {
					if (backgrounded) {
						this.ctx.showStatus("Folding foreground bash into a quiet background job…");
						return;
					}
					this.ctx.showWarning(
						"No supported foreground tool can be folded. Use managed async bash/auto-background; raw Ctrl+Z/bg is not supported inside the TUI.",
					);
				})
				.catch(() => {
					this.ctx.showWarning(
						"No supported foreground tool can be folded. Use managed async bash/auto-background; raw Ctrl+Z/bg is not supported inside the TUI.",
					);
				});
		} catch {
			this.ctx.showWarning(
				"No supported foreground tool can be folded. Use managed async bash/auto-background; raw Ctrl+Z/bg is not supported inside the TUI.",
			);
		}
		return true;
	}

	handleTextPaste(text: string, context: PasteTextContext): boolean | Promise<boolean> {
		if (isItermPetDragPaste(text)) {
			this.ctx.showStatus("Ignored dragged Gajae Pet image.", { dim: true });
			return true;
		}
		if (this.ctx.isBashMode || this.ctx.isPythonMode) return false;
		const parsed = parsePastedImagePaths(text, { cwd: this.ctx.sessionManager.getCwd() });
		if (!parsed) return false;
		if (parsed.kind === "too-many") {
			this.ctx.showStatus(`Cannot attach more than ${parsed.maxCandidates} pasted images.`);
			return false;
		}
		return this.#attachPastedImagePaths(parsed.paths, parsed.requiresConfirmation, context);
	}

	/** Return false on every failure so CustomEditor restores the exact paste. */
	async #attachPastedImagePaths(
		imagePaths: readonly string[],
		requiresConfirmation: boolean,
		context: PasteTextContext,
	): Promise<boolean> {
		const signal = context.signal;
		const editor = this.ctx.editor;
		const editorText = editor.getText();
		const pendingImages = this.ctx.pendingImages;
		const pendingImageCount = pendingImages.length;
		try {
			if (requiresConfirmation) {
				const selection = await this.ctx.showHookSelector(
					`Attach ${imagePaths.length} pasted images?\nOnly attach files you intend to send to the model.`,
					["Attach images", "Paste paths literally"],
					{ signal, helpText: "Enter: choose · Esc: paste paths literally" },
				);
				signal.throwIfAborted();
				if (selection !== "Attach images") return false;
			}

			const loaded = await this.#loadPastedImageBatch({
				paths: imagePaths,
				autoResize: this.ctx.settings.get("images.autoResize"),
				sourcePolicy: requiresConfirmation ? "confirmed" : "automatic-temp",
				signal,
			});
			signal.throwIfAborted();
			return context.commit(() => {
				if (
					this.ctx.editor !== editor ||
					editor.getText() !== editorText ||
					this.ctx.pendingImages !== pendingImages ||
					pendingImages.length !== pendingImageCount
				) {
					return false;
				}

				const firstImageNumber = pendingImages.length + 1;
				const references = loaded.sourcePaths.map((sourcePath, index) =>
					formatPastedImageReference(`[image ${firstImageNumber + index}]`, sourcePath),
				);
				try {
					editor.insertText(`${references.join(" ")} `);
					this.ctx.pendingImages = [...pendingImages, ...loaded.images];
				} catch (error) {
					try {
						editor.setText(editorText);
					} catch {
						// Preserve the original mutation error when rollback itself fails.
					} finally {
						this.ctx.pendingImages = pendingImages;
					}
					throw error;
				}

				try {
					this.ctx.showStatus(
						loaded.images.length === 1
							? `Attached image: ${path.basename(loaded.sourcePaths[0] ?? "")}`
							: `Attached ${loaded.images.length} images`,
						{ dim: true },
					);
					this.ctx.ui.requestRender();
				} catch (error) {
					logger.warn("Pasted images attached but status rendering failed", { error: String(error) });
				}
				return true;
			});
		} catch (error) {
			if (signal.aborted) return false;
			if (error instanceof ImageInputTooLargeError || error instanceof PastedImageBatchError) {
				this.ctx.showStatus(error.message);
				return false;
			}
			this.ctx.showStatus(
				imagePaths.length === 1 ? "Failed to attach pasted image" : "Failed to attach pasted images",
			);
			return false;
		}
	}

	#deleteImagePlaceholderBeforeCursor(): boolean {
		if (this.ctx.pendingImages.length === 0) return false;

		const { line, col } = this.ctx.editor.getCursor();
		const currentLine = this.ctx.editor.getLines()[line] ?? "";
		const range = locatePastedImageReferenceAroundCursor(currentLine, col);
		if (!range) return false;
		const placeholderNumberText = String(range.imageIndex);

		const imageIndex = Number.parseInt(placeholderNumberText, 10) - 1;
		if (imageIndex < 0 || imageIndex >= this.ctx.pendingImages.length) return false;

		const beforeText = this.ctx.editor.getText();
		const pendingImages = this.ctx.pendingImages;
		const deleted = this.ctx.editor.deleteTextRangeAroundCursor(range.startCol, range.endCol);
		if (deleted) {
			this.#imagePlaceholderDeletionUndo = {
				beforeText,
				afterText: this.ctx.editor.getText(),
				pendingImages,
			};
		}
		return deleted;
	}

	#restorePendingImagesAfterPlaceholderUndo(text: string): void {
		const deletion = this.#imagePlaceholderDeletionUndo;
		if (!deletion) return;

		if (text === deletion.beforeText) {
			if (this.ctx.pendingImages.length === 0) {
				this.ctx.pendingImages = deletion.pendingImages;
			}
			this.#imagePlaceholderDeletionUndo = undefined;
		} else if (text !== deletion.afterText) {
			this.#imagePlaceholderDeletionUndo = undefined;
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
		// Editor clears its internal buffer before invoking onSubmit and emits
		// onChange("") afterward; defer the empty-buffer clear for that callback.
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
	/**
	 * Explicit "Paste text from configured clipboard" action (P3-b v1). Only
	 * meaningful when `clipboard.transport` is `ssh` — reads via `pbpaste` on
	 * the configured host and inserts the result at the cursor. No default
	 * key (command palette only), so it never collides with the platform
	 * image-paste binding. Explicit ssh failures are surfaced verbatim and
	 * never fall back to native/OSC52 or leave stale text inserted.
	 */
	async handlePasteText(): Promise<boolean> {
		try {
			const text = await pasteFromClipboard();
			if (text === null) {
				this.ctx.showStatus(
					"Paste text from clipboard requires --clipboard-transport ssh (or clipboard.transport: ssh in config).",
				);
				return false;
			}
			this.ctx.editor.insertText(text);
			this.ctx.ui.requestRender();
			return true;
		} catch (error) {
			this.ctx.showError(
				`Failed to paste from clipboard: ${error instanceof Error ? error.message : String(error)}`,
			);
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
			pasteText: () => void this.handlePasteText(),
			newSession: () => void this.ctx.handleClearCommand(),
			showHelp: () => this.ctx.handleHelpCommand(),
			scrollTmuxToPreviousUserInput: () => this.scrollTmuxToPreviousUserInput(),
			undo: prefix => this.ctx.editor.undoPastTransientText(prefix),
			moveCursorToMessageEnd: () => this.ctx.editor.moveToMessageEnd(),
			moveCursorToMessageStart: () => this.ctx.editor.moveToMessageStart(),
			moveCursorToLineStart: () => this.ctx.editor.moveToLineStart(),
			moveCursorToLineEnd: () => this.ctx.editor.moveToLineEnd(),
			getPromptSuggestion: () => this.ctx.promptSuggestion?.current ?? null,
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
		copyToClipboard(text).then(
			() => {
				const sanitized = sanitizeText(text);
				const preview = sanitized.length > 30 ? `${sanitized.slice(0, 30)}...` : sanitized;
				this.ctx.showStatus(`Copied line: ${preview}`);
			},
			() => this.ctx.showWarning("Failed to copy to clipboard"),
		);
	}

	/** Copy current prompt text to system clipboard. */
	handleCopyPrompt(): void {
		const text = this.ctx.editor.getText();
		if (!text) {
			this.ctx.showStatus("Nothing to copy");
			return;
		}
		copyToClipboard(text).then(
			() => {
				const sanitized = sanitizeText(text);
				const preview = sanitized.length > 30 ? `${sanitized.slice(0, 30)}...` : sanitized;
				this.ctx.showStatus(`Copied: ${preview}`);
			},
			() => this.ctx.showWarning("Failed to copy to clipboard"),
		);
	}

	async #dispatchPaletteSlashCommand(name: string, restoreComposer: () => void): Promise<void> {
		if (this.#paletteCommandInFlight) {
			this.ctx.showStatus("A palette command is still running.");
			return;
		}

		if (this.ctx.editor.getText() || this.ctx.pendingImages.length > 0) {
			this.ctx.showStatus("Send or clear the draft before running a palette command.");
			return;
		}

		restoreComposer();
		this.#paletteCommandInFlight = true;
		try {
			await this.submitText(`/${name}`, { ownsComposer: false, editor: this.ctx.editor });
		} finally {
			this.#paletteCommandInFlight = false;
		}
	}

	openCommandPalette(): void {
		if (this.ctx.isTranscriptViewerOpen?.()) return;
		if (this.#paletteCommandInFlight) {
			this.ctx.showStatus("A palette command is still running.");
			return;
		}

		const actions = [...this.#commandPaletteActions.entries()]
			.filter(([id]) => !this.#availabilityGatedPaletteActions.has(id) || this.actionRegistry.isAvailable(id))
			.map(([id, action]) =>
				this.#availabilityGatedPaletteActions.has(id)
					? {
							...action,
							handler: async () => {
								await this.actionRegistry.executeFresh(id);
							},
						}
					: action,
			);
		const slashCommands = [...(this.ctx.getSlashCommands?.() ?? this.#slashCommands)];
		if (!this.ctx.showCommandPalette) {
			let overlayHandle: ReturnType<typeof this.ctx.ui.showOverlay> | undefined;
			const close = () => {
				overlayHandle?.hide();
				this.ctx.ui.setFocus(this.ctx.editor);
				this.ctx.ui.requestRender(true);
			};
			const entries: CommandPaletteEntry[] = [
				...this.actionRegistry
					.all()
					.filter(action => this.actionRegistry.isAvailable(action.id))
					.map(action => ({
						id: `action:${action.id}`,
						label: action.title,
						description: action.category,
						keybinding: action.bindingId
							? this.ctx.keybindings.getKeys(action.bindingId).join(", ") || undefined
							: undefined,
						handler: () => this.actionRegistry.executeFresh(action.id),
					})),
				...slashCommands.map(command => ({
					id: `slash:/${command.name}`,
					label: `/${command.name}`,
					description: command.description,
				})),
			];
			const palette = new CommandPalette(
				entries,
				entry => {
					if (entry.handler) {
						close();
						void entry.handler();
					} else {
						const command = entry.id.slice("slash:/".length);
						void this.#dispatchPaletteSlashCommand(command, close);
					}
				},
				close,
			);
			overlayHandle = this.ctx.ui.showOverlay(palette, {
				anchor: "bottom-center",
				width: "100%",
				maxHeight: "100%",
				margin: 0,
			});
			this.ctx.ui.setFocus(palette);
			this.ctx.ui.requestRender();
			return;
		}
		this.ctx.showCommandPalette(slashCommands, actions, name =>
			this.#dispatchPaletteSlashCommand(name, () => {
				this.ctx.ui.setFocus?.(this.ctx.editor);
				this.ctx.ui.requestRender(true);
			}),
		);
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
		if (!settings.canWriteDurableConfig()) {
			this.ctx.showError(
				"Cannot change settings while config.yml has invalid YAML syntax. Repair config.yml and reload settings.",
			);
			return;
		}
		const hideThinkingBlock = !this.ctx.hideThinkingBlock;
		try {
			settings.set("hideThinkingBlock", hideThinkingBlock);
		} catch (error) {
			if (!settings.canWriteDurableConfig()) {
				this.ctx.showError(error instanceof Error ? error.message : String(error));
				return;
			}
			throw error;
		}
		this.ctx.hideThinkingBlock = hideThinkingBlock;
		this.ctx.session.setThinkingVisibility(hideThinkingBlock ? "hidden" : "visible");

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
