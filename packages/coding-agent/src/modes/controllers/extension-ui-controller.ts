import { ThinkingLevel } from "@gajae-code/agent-core";
import {
	type Component,
	Container,
	type OverlayHandle,
	replaceTabs,
	Spacer,
	Text,
	type TUI,
	wrapTextWithAnsi,
} from "@gajae-code/tui";
import { logger } from "@gajae-code/utils";
import { KeybindingsManager } from "../../config/keybindings";
import type {
	CompactOptions,
	ExtensionActions,
	ExtensionCommandContextActions,
	ExtensionContextActions,
	ExtensionError,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionUiComponent,
	ExtensionWidgetContent,
	ExtensionWidgetOptions,
	SendUserMessageHandler,
	TerminalInputHandler,
} from "../../extensibility/extensions";
import { createExtensionSettings } from "../../extensibility/extensions";
import { runExtensionSetModel } from "../../extensibility/extensions/compact-handler";
import { getSessionSlashCommands } from "../../extensibility/extensions/get-commands-handler";
import { HookEditorComponent } from "../../modes/components/hook-editor";
import { HookInputComponent } from "../../modes/components/hook-input";
import { HookSelectorComponent } from "../../modes/components/hook-selector";
import { getAvailableThemesWithPaths, getThemeByName, setTheme, type Theme, theme } from "../../modes/theme/theme";
import type { InteractiveModeContext } from "../../modes/types";
import {
	parseSyntheticModelId,
	resolveSyntheticModelSelection,
	SYNTHETIC_PROVIDER_ID,
	syntheticNamespaceCollision,
} from "../../sdk/model-profile-model";
import { bashBackgroundControlError } from "../../session/fold-coordinator";
import { createReadonlySessionManager } from "../../session/session-manager";
import { parseThinkingLevel } from "../../thinking";
import type { TodoPhase } from "../../tools/todo-write";
import { setSessionTerminalTitle, setTerminalTitle } from "../../utils/title-generator";
import { emitHostStatus } from "../utils/host-status";
import { applyInjectedUserSubmission, extensionUserMessageContentError } from "../utils/injected-user-submission";
import { classifyHookSelectorBellEvent, ringTerminalBell } from "../utils/terminal-bell";

const MAX_WIDGET_LINES = 10;
const HOOK_SELECTOR_CHROME_ROWS = 7;
const HOOK_SELECTOR_OUTLINE_ROWS = 2;
const HOOK_SELECTOR_INLINE_EDITOR_ROWS = 2;
const HOOK_SELECTOR_INLINE_AUTOCOMPLETE_ROWS = 6;
const HOOK_SELECTOR_INLINE_INPUT_ROWS = 1 + HOOK_SELECTOR_INLINE_EDITOR_ROWS + HOOK_SELECTOR_INLINE_AUTOCOMPLETE_ROWS;
const HOOK_SELECTOR_INLINE_COMPACT_EDITOR_ROWS = 1;
const HOOK_SELECTOR_INLINE_COMPACT_AUTOCOMPLETE_MAX_VISIBLE = 3;
const HOOK_SELECTOR_INLINE_COMPACT_AUTOCOMPLETE_ROWS = 4;
const HOOK_SELECTOR_INLINE_COMPACT_INPUT_ROWS =
	1 + HOOK_SELECTOR_INLINE_COMPACT_EDITOR_ROWS + HOOK_SELECTOR_INLINE_COMPACT_AUTOCOMPLETE_ROWS;
const HOOK_SELECTOR_INLINE_COMPACT_CHROME_ROWS = 2;

const EXTENSION_ACTION_MUTATIONS: ReadonlySet<PropertyKey> = new Set([
	"sendMessage",
	"sendUserMessage",
	"appendEntry",
	"setLabel",
	"setActiveTools",
	"setModel",
	"setThinkingLevel",
	"setThinkingVisibility",
	"cycleThinkingLevel",
	"setThinkingLevelForControl",
	"setThinkingVisibilityForControl",
	"setModelTemporaryForControl",
	"setSessionName",
]);
const EXTENSION_CONTEXT_MUTATIONS: ReadonlySet<PropertyKey> = new Set([
	"abort",
	"abortPromptAndWait",
	"shutdown",
	"compact",
	"clearContext",
	"cycleModel",
	"setModelProfile",
	"cycleThinkingLevel",
	"setQueueMode",
	"invokeSkill",
	"setPlanMode",
	"operateGoal",
	"setSdkPermissionProvider",
	"setSdkClientBridge",
	"sdkControl",
]);
const EXTENSION_COMMAND_MUTATIONS: ReadonlySet<PropertyKey> = new Set([
	"reload",
	"newSession",
	"branch",
	"navigateTree",
	"compact",
	"switchSession",
]);

const BROKER_LIFECYCLE_OPERATIONS = new Set([
	"session.new",
	"session.fork",
	"session.resume",
	"session.close",
	"session.switch",
	"session.branch",
	"session.handoff",
	"session.delete",
]);

function prohibitBrokerLifecycleOperation(operation: string): never {
	throw Object.assign(new Error(`${operation} is available only through the Broker lifecycle service.`), {
		code: "operation_prohibited",
	});
}

export class ExtensionUiController {
	#extensionTerminalInputUnsubscribers = new Set<() => void>();
	#extensionErrorUnsubscribe?: () => void;
	#hookWidgetsAbove = new Map<string, ExtensionUiComponent>();
	#hookWidgetsBelow = new Map<string, ExtensionUiComponent>();
	#activeHookCustomComponent?: Component & { dispose?(): void };
	#activeHookCustomOverlay?: OverlayHandle;
	#activeHookCustomCancel?: () => void;

	#hookSelectorResizeHandler?: () => void;
	constructor(private ctx: InteractiveModeContext) {}

	#clearActiveHookCustom(): void {
		const component = this.#activeHookCustomComponent;
		const overlay = this.#activeHookCustomOverlay;
		this.#activeHookCustomComponent = undefined;
		this.#activeHookCustomOverlay = undefined;
		component?.dispose?.();
		overlay?.hide();
	}

	captureSessionUiCleanup(): () => void {
		const terminalInputUnsubscribers = [...this.#extensionTerminalInputUnsubscribers];
		const widgetsAbove = [...this.#hookWidgetsAbove.entries()];
		const widgetsBelow = [...this.#hookWidgetsBelow.entries()];
		const activeHookCustomComponent = this.#activeHookCustomComponent;
		const activeHookCustomOverlay = this.#activeHookCustomOverlay;
		return () => {
			for (const unsubscribe of terminalInputUnsubscribers) {
				unsubscribe();
				this.#extensionTerminalInputUnsubscribers.delete(unsubscribe);
			}
			let widgetsChanged = false;
			for (const [key, widget] of widgetsAbove) {
				if (this.#hookWidgetsAbove.get(key) !== widget) continue;
				this.#hookWidgetsAbove.delete(key);
				widget.dispose?.();
				widgetsChanged = true;
			}
			for (const [key, widget] of widgetsBelow) {
				if (this.#hookWidgetsBelow.get(key) !== widget) continue;
				this.#hookWidgetsBelow.delete(key);
				widget.dispose?.();
				widgetsChanged = true;
			}
			if (
				this.#activeHookCustomComponent === activeHookCustomComponent &&
				this.#activeHookCustomOverlay === activeHookCustomOverlay
			) {
				this.#clearActiveHookCustom();
			}
			if (widgetsChanged) this.#rebuildHookWidgets();
		};
	}

	#sdkControl = async (operation: string, input: Record<string, unknown>): Promise<unknown> => {
		const session = this.ctx.session;
		const withSdkControlMutation = <T>(body: () => Promise<T>): Promise<T> =>
			typeof session.withSdkControlMutation === "function" ? session.withSdkControlMutation(body) : body();
		switch (operation) {
			case "model.set": {
				const selector = typeof input.id === "string" ? input.id : "";
				const rawThinkingLevel = typeof input.thinkingLevel === "string" ? input.thinkingLevel : undefined;
				const hasThinkingLevel = rawThinkingLevel !== undefined;
				const thinkingLevel = rawThinkingLevel === undefined ? undefined : parseThinkingLevel(rawThinkingLevel);
				if (parseSyntheticModelId(selector) !== undefined) {
					if (
						syntheticNamespaceCollision(
							session.modelRegistry.getAll?.() ?? [],
							session.modelRegistry.getConfiguredProviderIds?.() ?? [],
						)
					)
						throw Object.assign(
							new Error(
								`The ${SYNTHETIC_PROVIDER_ID} namespace is reserved; synthetic preset selection is disabled while a provider of the same name is configured.`,
							),
							{ code: "invalid_input" },
						);
					// An absent thinking level is allowed (matches the generic
					// model.set and the SDK contract); a supplied-but-unparseable or
					// non-"off" value is rejected, and the override is passed only
					// when the caller supplied it.
					if (
						hasThinkingLevel &&
						(thinkingLevel === undefined ||
							thinkingLevel === ThinkingLevel.Inherit ||
							thinkingLevel !== ThinkingLevel.Off)
					)
						throw Object.assign(new Error('model.set thinkingLevel for a synthetic profile must be "off".'), {
							code: "invalid_input",
						});
					const resolved = resolveSyntheticModelSelection(
						selector,
						session.modelRegistry.getModelProfiles(),
						session.modelRegistry.getError?.(),
					);
					await session.setDefaultModelProfileForControl(resolved.canonicalName, {
						persistDefault: false,
						...(hasThinkingLevel ? { thinkingLevelOverride: ThinkingLevel.Off } : {}),
					});
					return {
						provider: SYNTHETIC_PROVIDER_ID,
						modelId: resolved.canonicalName,
						thinkingLevel: session.thinkingLevel,
					};
				}
				const slashIndex = selector.indexOf("/");
				const model =
					slashIndex > 0
						? session.modelRegistry.find(selector.slice(0, slashIndex), selector.slice(slashIndex + 1))
						: undefined;
				if (!model || !thinkingLevel || thinkingLevel === ThinkingLevel.Inherit)
					throw Object.assign(new Error("model.set requires a valid model id and concrete thinkingLevel."), {
						code: "invalid_input",
					});
				// Internal host hooks (never public SDK fields): the bus surface runs
				// its Q13 config-shadow capture/reconcile inside this selection
				// admission so a concurrent config.patch cannot race the snapshot.
				return await session.setDefaultModelSelection(model, thinkingLevel, {
					...(typeof input.onBeforeMutation === "function"
						? { onBeforeMutation: input.onBeforeMutation as () => void }
						: {}),
					...(typeof input.onAfterMutation === "function"
						? { onAfterMutation: input.onAfterMutation as () => void }
						: {}),
				});
			}
			case "todo.replace": {
				const phases = input.items;
				if (
					!Array.isArray(phases) ||
					!phases.every(phase => {
						if (!phase || typeof phase !== "object") return false;
						const candidate = phase as { name?: unknown; tasks?: unknown };
						return (
							typeof candidate.name === "string" &&
							Array.isArray(candidate.tasks) &&
							candidate.tasks.every(task => {
								if (!task || typeof task !== "object") return false;
								const item = task as { content?: unknown; status?: unknown };
								return (
									typeof item.content === "string" &&
									["pending", "in_progress", "completed", "abandoned"].includes(String(item.status))
								);
							})
						);
					})
				)
					throw Object.assign(new Error("todo.replace requires TodoPhase items."), { code: "invalid_input" });
				return await withSdkControlMutation(async () => {
					session.setTodoPhases(phases as TodoPhase[]);
					return { replaced: session.getTodoPhases() };
				});
			}
			case "permission_mode.set": {
				const requested = input.mode;
				const mode =
					requested === "allow" || requested === "always-allow"
						? "allow"
						: requested === "deny" || requested === "always-deny"
							? "deny"
							: requested === "prompt"
								? "prompt"
								: undefined;
				if (!mode)
					throw Object.assign(new Error("permission_mode.set requires prompt, allow, or deny."), {
						code: "invalid_input",
					});
				return await withSdkControlMutation(async () => {
					session.setSdkPermissionMode(mode);
					return { changed: true, mode: session.sdkPermissionMode };
				});
			}
			case "bash.execute": {
				if (typeof input.cmd !== "string" || input.cmd.trim() === "")
					throw Object.assign(new Error("bash.execute requires a command."), { code: "invalid_input" });
				const result = await session.executeBash(input.cmd, undefined, { excludeFromContext: true });
				return {
					exitCode: result.exitCode,
					cancelled: result.cancelled,
					output: result.output,
					truncated: result.truncated,
				};
			}
			case "bash.abort":
				if (!session.isBashRunning) return { aborted: false };
				session.abortBash();
				return { aborted: true };
			case "retry.last":
				return await withSdkControlMutation(async () => {
					if (!(await session.retry()))
						throw Object.assign(new Error("There is no failed or interrupted turn to retry."), {
							code: "nothing_to_retry",
						});
					return { retried: true };
				});
			case "retry.now":
				return await withSdkControlMutation(async () => {
					if (!session.isRetrying)
						throw Object.assign(new Error("No retry backoff is pending."), { code: "retry_not_pending" });
					session.retryNow();
					return { retried: true, immediate: true };
				});
			case "bash.background": {
				const outcome = await session.requestForegroundBashBackgroundOutcome("sdk_control");
				if (outcome.status !== "folded") throw bashBackgroundControlError(outcome);
				return { backgrounded: true, jobId: outcome.jobId };
			}
			case "compaction.auto.set":
				return await withSdkControlMutation(async () => {
					session.setAutoCompactionEnabled(input.on === true);
					return { changed: true };
				});
			case "retry.auto.set":
				return await withSdkControlMutation(async () => {
					session.setAutoRetryEnabled(input.on === true);
					return { changed: true };
				});
			case "retry.abort":
				return await withSdkControlMutation(async () => {
					session.abortRetry();
					return { aborted: true };
				});
			case "session.rename":
				return await withSdkControlMutation(async () => ({
					renamed: await session.setSessionName(String(input.name), "user"),
				}));
			case "session.export_html":
				try {
					return { path: await session.exportToHtml(typeof input.path === "string" ? input.path : undefined) };
				} catch (error) {
					throw Object.assign(
						new Error(
							error instanceof Error ? error.message : "Session export is unavailable for the current state.",
						),
						{ code: "invalid_request" },
					);
				}
			case "runtime.reload":
				await session.reload();
				return { reloaded: true };
			case "service_tier.set":
				return await withSdkControlMutation(async () => {
					session.setServiceTier(input.tier as never);
					return { changed: true };
				});
			case "queue.message.remove": {
				return await withSdkControlMutation(async () => {
					const removed = session.removeQueuedMessageForEditing(String(input.id));
					if (removed === undefined)
						throw Object.assign(new Error("Queued message was not found."), { code: "resource_gone" });
					return { removed };
				});
			}
			case "queue.message.move": {
				return await withSdkControlMutation(async () => {
					const id = String(input.id);
					const moved =
						input.before !== undefined
							? session.moveQueuedMessageForEditing(id, "up")
							: session.moveQueuedMessageForEditing(id, "down");
					if (!moved) throw Object.assign(new Error("Queue position is invalid."), { code: "invalid_position" });
					return { moved };
				});
			}
			case "queue.message.update": {
				const id = String(input.id);
				const updated = await withSdkControlMutation(async () => {
					const old = session.removeQueuedMessageForEditing(id);
					const patch = input.patch as { text?: unknown };
					if (old === undefined || typeof patch?.text !== "string")
						throw Object.assign(new Error("Queued message update is invalid."), { code: "invalid_message" });
					await session.sendUserMessage(patch.text, {
						deliverAs: id.startsWith("steer:") ? "steer" : "followUp",
						allowSdkControlMutationReentry: true,
					});
					return true;
				});
				if (!updated)
					throw Object.assign(new Error("Queued message update is invalid."), { code: "invalid_message" });
				return { updated: true };
			}
			case "extension.set_enabled": {
				return await withSdkControlMutation(async () => {
					const id = String(input.id);
					const disabled = [...(session.settings.get("disabledExtensions") ?? [])];
					const on = input.on === true;
					const next = on ? disabled.filter(value => value !== id) : [...new Set([...disabled, id])];
					if (!session.settings.canWriteDurableConfig()) {
						throw Object.assign(
							new Error(
								"Cannot change settings while config.yml has invalid YAML syntax. Repair config.yml and reload settings.",
							),
							{ code: "invalid_request" },
						);
					}
					try {
						session.settings.set("disabledExtensions", next);
					} catch (error) {
						if (!session.settings.canWriteDurableConfig()) {
							throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), {
								code: "invalid_request",
							});
						}
						throw error;
					}
					return { changed: true, enabled: on };
				});
			}
			case "session.cwd.move": {
				const rescopeSessionCwd = session.rescopeSessionCwd;
				if (typeof rescopeSessionCwd !== "function") {
					throw Object.assign(new Error("session.cwd.move is unavailable without an installed session seam."), {
						code: "unavailable",
					});
				}
				try {
					await rescopeSessionCwd.call(session, String(input.path), { scope: "any" });
				} catch (error) {
					if (
						error instanceof Error &&
						error.message ===
							"This session cannot rescope its working directory; only top-level unrestrained sessions can move."
					) {
						Object.assign(error, { code: "unavailable" });
					}
					throw error;
				}
				return { moved: true, cwd: session.sessionManager.getCwd() };
			}
			default:
				if (BROKER_LIFECYCLE_OPERATIONS.has(operation)) prohibitBrokerLifecycleOperation(operation);
				throw Object.assign(new Error(`${operation} has no AgentSession implementation.`), { code: "unavailable" });
		}
	};

	/** Re-mount the pet-aware composer after a transient hook UI closes. */
	#restoreComposerEditor(): void {
		this.ctx.restoreComposer();
	}
	#removeHookSelectorResizeHandler(): void {
		if (!this.#hookSelectorResizeHandler) return;
		process.stdout.removeListener("resize", this.#hookSelectorResizeHandler);
		this.#hookSelectorResizeHandler = undefined;
	}

	#isStopped(): boolean {
		return this.ctx.isStopped?.() === true;
	}

	#assertActive(): void {
		if (this.#isStopped()) throw Object.assign(new Error("Interactive mode stopped"), { code: "cancelled" });
	}

	#guardMutations<T extends object>(target: T, mutationNames: ReadonlySet<PropertyKey>): T {
		return new Proxy(target, {
			get: (current, property, receiver) => {
				const member = Reflect.get(current, property, receiver) as unknown;
				if (!mutationNames.has(property) || typeof member !== "function") return member;
				return (...args: unknown[]) => {
					this.#assertActive();
					return Reflect.apply(member, current, args);
				};
			},
		});
	}

	/**
	 * Initialize the hook system with TUI-based UI context.
	 */
	async initHooksAndCustomTools(): Promise<void> {
		// Create and set hook & tool UI context
		const uiContext: ExtensionUIContext = {
			select: (title, options, dialogOptions) => this.showHookSelector(title, options, dialogOptions),
			confirm: (title, message, _dialogOptions) => this.showHookConfirm(title, message),
			input: (title, placeholder, dialogOptions) => this.showHookInput(title, placeholder, dialogOptions),
			notify: (message, type) => this.showHookNotify(message, type),
			onTerminalInput: handler => this.addExtensionTerminalInputListener(handler),
			setStatus: (key, text) => this.setHookStatus(key, text),
			setWorkingMessage: message => {
				if (!this.#isStopped()) this.ctx.setWorkingMessage(message);
			},
			setWidget: (key, content, options) => this.setHookWidget(key, content, options),
			setTitle: title => {
				if (!this.#isStopped()) setTerminalTitle(title);
			},
			custom: (factory, options) => this.showHookCustom(factory, options),
			setEditorText: text => {
				if (!this.#isStopped()) this.ctx.editor.setText(text);
			},
			pasteToEditor: text => {
				if (!this.#isStopped()) this.ctx.editor.handleInput(`\x1b[200~${text}\x1b[201~`);
			},
			getEditorText: () => this.ctx.editor.getText(),
			editor: (title, prefill, dialogOptions, editorOptions) =>
				this.showHookEditor(title, prefill, dialogOptions, editorOptions),
			get theme() {
				return theme;
			},
			getAllThemes: async () => (await getAvailableThemesWithPaths()).map(t => ({ name: t.name, path: t.path })),
			getTheme: name => getThemeByName(name),
			setTheme: async themeArg => {
				if (this.#isStopped()) return { success: false, error: "Interactive mode stopped" };
				if (typeof themeArg === "string") {
					return await setTheme(themeArg, true, { shouldApply: () => !this.#isStopped() });
				}
				// Theme object passed directly - not supported in current implementation
				return Promise.resolve({ success: false, error: "Direct theme object not supported" });
			},
			setFooter: () => {},
			setHeader: () => {},
			setEditorComponent: factory => {
				if (!this.#isStopped()) this.ctx.setEditorComponent(factory);
			},
			getToolsExpanded: () => this.ctx.toolOutputExpanded,
			setToolsExpanded: expanded => {
				if (!this.#isStopped()) this.ctx.setToolsExpanded(expanded);
			},
		};
		this.ctx.setToolUIContext(uiContext, true);

		const extensionRunner = this.ctx.session.extensionRunner;
		if (!extensionRunner) {
			return; // No hooks loaded
		}

		const actions: ExtensionActions = {
			sendMessage: (message, options) => {
				const wasStreaming = this.ctx.session.isStreaming;
				this.ctx.session
					// The extension seam is the trusted runtime boundary: extension
					// producers are external to the turn's model/tool runtime, so
					// nextTurn messages are classified "external" here (survive a
					// terminal abort) instead of letting the extension label its
					// own origin — caller-controlled origin defeats source-based
					// continuation fencing (review thread P2).
					.sendCustomMessage(message, { ...options, origin: "external" })
					.then(() => {
						if (!this.#isStopped()) this.#applyCustomMessageDisplay(wasStreaming, message.display);
					})
					.catch((err: unknown) => {
						if (this.#isStopped()) return;
						this.ctx.showError(
							`Extension sendMessage failed: ${err instanceof Error ? err.message : String(err)}`,
						);
					});
			},
			sendUserMessage: this.#sendExtensionUserMessage,
			appendEntry: (customType, data) => {
				this.ctx.sessionManager.appendCustomEntry(customType, data);
			},
			setLabel: (targetId, label) => {
				this.ctx.sessionManager.appendLabelChange(targetId, label);
			},
			getActiveTools: () => this.ctx.session.getActiveToolNames(),
			getAllTools: () => this.ctx.session.getAllToolNames(),
			resolveTool: name => {
				const tool = this.ctx.session.getToolByName(name);
				return tool ? { safeSummary: tool.safeSummary, safeSummaryFields: tool.safeSummaryFields } : undefined;
			},
			setActiveTools: toolNames => this.ctx.session.setActiveToolsByName(toolNames),
			setModel: model => runExtensionSetModel(this.ctx.session, model),
			getThinkingLevel: () => this.ctx.session.thinkingLevel,
			setThinkingLevel: (level, persist) => this.ctx.session.setThinkingLevel(level, persist),
			getThinkingVisibility: () => this.ctx.session.getThinkingVisibility(),
			setThinkingVisibility: (visibility, persist) => this.ctx.session.setThinkingVisibility(visibility, persist),
			cycleThinkingLevel: () => this.ctx.session.cycleThinkingLevel(),
			setThinkingLevelForControl: (level, persist) => this.ctx.session.setThinkingLevelForControl(level, persist),
			setThinkingVisibilityForControl: (visibility, persist) =>
				this.ctx.session.setThinkingVisibilityForControl(visibility, persist),
			setModelTemporaryForControl: (model, expectedSessionId, thinkingLevel) =>
				this.ctx.session.setModelTemporaryForControl(model, expectedSessionId, thinkingLevel),
			fetchUsageReportsForControl: () => this.ctx.session.fetchUsageReportsForControl(),
			getThinkingScopeForControl: () => this.ctx.session.getThinkingScopeForControl(),
			getCommands: () => getSessionSlashCommands(this.ctx.session),
			getSessionName: () => this.ctx.sessionManager.getSessionName(),
			setSessionName: name => this.#updateSessionName(name),
		};
		const contextActions: ExtensionContextActions = {
			getModel: () => this.ctx.session.model,
			getCredentialSessionId: () => this.ctx.session.credentialSessionId,
			isIdle: () => !this.ctx.session.isStreaming,
			getActivePromptHandle: () => this.ctx.session.activePromptHandle,
			abort: () => this.ctx.session.abort(),
			abortPromptAndWait: (handle, options) => this.ctx.session.abortPromptAndWait(handle, options),
			hasPendingMessages: () => this.ctx.session.queuedMessageCount > 0,
			getPendingMessageCounts: () => this.ctx.session.pendingMessageCounts,
			getTranscript: () => this.ctx.session.getTranscript(),
			getTranscriptBody: entryId => this.ctx.session.getTranscriptBody(entryId),
			getGoalState: () => this.ctx.session.getGoalModeState(),
			getTodoState: () => this.ctx.session.getTodoPhases(),
			getQueuedMessages: () => this.ctx.session.getQueuedMessageEntries(),
			getActiveTools: () => this.ctx.session.getActiveToolNames(),
			getAllTools: () => this.ctx.session.getAllToolNames(),
			resolveTool: name => {
				const tool = this.ctx.session.getToolByName(name);
				return tool ? { safeSummary: tool.safeSummary, safeSummaryFields: tool.safeSummaryFields } : undefined;
			},

			shutdown: () => {
				// Defer the actual teardown to the main loop, which calls
				// `checkShutdownRequested()` at idle boundaries so any queued
				// steering / follow-up messages drain first (see issue #1020).
				this.ctx.shutdownRequested = true;
			},
			getContextUsage: () => this.ctx.session.getContextUsage(),
			compact: instructionsOrOptions => this.#compactSession(instructionsOrOptions),
			getSystemPrompt: () => this.ctx.session.systemPrompt,
			clearContext: () => this.ctx.session.clearContext(),
			cycleModel: () => this.ctx.session.cycleModel(),
			setModelProfile: name => this.ctx.session.activateModelProfileForControl(name),
			setDefaultModelProfile: (name, options) => this.ctx.session.setDefaultModelProfileForControl(name, options),
			getActiveModelProfile: () => this.ctx.session.getActiveModelProfile(),
			withSdkControlMutation: (body, options) => this.ctx.session.withSdkControlMutation(body, options),
			cycleThinkingLevel: () => this.ctx.session.cycleThinkingLevel(),
			setQueueMode: (kind, mode) => {
				if (kind === "steering" && (mode === "all" || mode === "one-at-a-time")) {
					this.ctx.session.setSteeringMode(mode);
					return true;
				}
				if (kind === "follow_up" && (mode === "all" || mode === "one-at-a-time")) {
					this.ctx.session.setFollowUpMode(mode);
					return true;
				}
				if (kind === "tool_interrupt" && (mode === "abort_tools" || mode === "finish_tools")) {
					this.ctx.session.setToolInterruptPolicy(mode);
					return true;
				}
				return false;
			},
			invokeSkill: (name, args, options) => this.ctx.session.invokeSkill(name, args, options),
			setPlanMode: on => this.ctx.session.setSdkPlanMode(on),
			operateGoal: (op, objective) => this.ctx.session.operateGoal(op, objective),
			getSkillState: () =>
				this.ctx.session.skills.map(skill => ({ name: skill.name, description: skill.description })),
			getConfigItems: () => this.ctx.session.getSdkConfigItems(),
			getBranchCandidates: () => this.ctx.sessionManager.getTree(),
			getExtensions: () => this.ctx.session.extensionRunner?.getExtensionPaths() ?? [],
			setSdkPermissionProvider: provider => this.ctx.session.setSdkPermissionProvider(provider),
			setSdkClientBridge: bridge => this.ctx.session.setClientBridge(bridge),
			sdkControl: this.#sdkControl,
		};
		const commandActions: ExtensionCommandContextActions = {
			getContextUsage: () => this.ctx.session.getContextUsage(),
			waitForIdle: () => this.ctx.session.agent.waitForIdle(),
			newSession: async () => prohibitBrokerLifecycleOperation("session.new"),
			branch: async () => prohibitBrokerLifecycleOperation("session.branch"),
			navigateTree: async (targetId, navOptions) => {
				const result = await this.ctx.session.navigateTree(targetId, { summarize: navOptions?.summarize });
				return { cancelled: result.cancelled };
			},
			switchSession: async () => prohibitBrokerLifecycleOperation("session.switch"),
			reload: async () => {
				const previousSessionId = this.ctx.sessionManager.getSessionId();
				await this.ctx.session.reload();
				if (this.#isStopped()) return;
				const sessionIdentityChanged = previousSessionId !== this.ctx.sessionManager.getSessionId();
				if (sessionIdentityChanged) this.ctx.resetIrcSidebarSession();
				this.ctx.rebuildInitialMessages(sessionIdentityChanged ? "replace-identity" : "reconcile-same-transcript");
				await this.ctx.reloadTodos();
				if (this.#isStopped()) return;
				this.ctx.showStatus("Reloaded session");
			},
			compact: async instructionsOrOptions => this.#handleInteractiveCompact(instructionsOrOptions),
		};

		extensionRunner.initialize(
			this.#guardMutations(actions, EXTENSION_ACTION_MUTATIONS),
			this.#guardMutations(contextActions, EXTENSION_CONTEXT_MUTATIONS),
			this.#guardMutations(commandActions, EXTENSION_COMMAND_MUTATIONS),
			uiContext,
		);

		// Subscribe to extension errors
		this.#extensionErrorUnsubscribe?.();
		this.#extensionErrorUnsubscribe = extensionRunner.onError((error: ExtensionError) => {
			if (!this.#isStopped()) this.showExtensionError(error.extensionPath, error.error);
		});

		// Emit session_start event
		await extensionRunner.emit({
			type: "session_start",
		});
	}

	setHookWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void {
		if (this.#isStopped()) return;
		const placement = options?.placement ?? "aboveEditor";
		this.#removeHookWidget(this.#hookWidgetsAbove, key);
		this.#removeHookWidget(this.#hookWidgetsBelow, key);

		if (content === undefined) {
			this.#rebuildHookWidgets();
			return;
		}

		const target = placement === "belowEditor" ? this.#hookWidgetsBelow : this.#hookWidgetsAbove;
		target.set(key, this.#createHookWidget(content));
		this.#rebuildHookWidgets();
	}

	#removeHookWidget(widgets: Map<string, ExtensionUiComponent>, key: string): void {
		const existing = widgets.get(key);
		existing?.dispose?.();
		widgets.delete(key);
	}

	#createHookWidget(content: ExtensionWidgetContent): ExtensionUiComponent {
		if (Array.isArray(content)) {
			const container = new Container();
			for (const line of content.slice(0, MAX_WIDGET_LINES)) {
				container.addChild(new Text(line, 1, 0));
			}
			if (content.length > MAX_WIDGET_LINES) {
				container.addChild(new Text(theme.fg("muted", "... (widget truncated)"), 1, 0));
			}
			return container;
		}
		if (content === undefined) {
			throw new Error("Widget content missing");
		}
		return content(this.ctx.ui, theme);
	}

	#rebuildHookWidgets(): void {
		this.#renderHookWidgetContainer(this.ctx.hookWidgetContainerAbove, this.#hookWidgetsAbove, true);
		this.#renderHookWidgetContainer(this.ctx.hookWidgetContainerBelow, this.#hookWidgetsBelow, false);
		this.ctx.ui.requestRender();
	}

	#renderHookWidgetContainer(
		container: Container,
		widgets: Map<string, ExtensionUiComponent>,
		leadingSpacer: boolean,
	): void {
		// Detach (not dispose): hook widgets are persistent instances owned by the
		// #hookWidgets* maps and re-added on every rebuild. Disposal happens only on
		// explicit removal (#removeHookWidget) or clearHookWidgets(), so a rebuild must
		// not tear down a still-live widget (e.g. an extension CancellableLoader timer).
		container.detachAll();

		if (widgets.size === 0) {
			return;
		}

		if (leadingSpacer) {
			container.addChild(new Spacer(1));
		}
		for (const widget of widgets.values()) {
			container.addChild(widget);
		}
	}

	initializeHookRunner(uiContext: ExtensionUIContext, _hasUI: boolean): void {
		const extensionRunner = this.ctx.session.extensionRunner;
		if (!extensionRunner) {
			return;
		}

		const actions: ExtensionActions = {
			sendMessage: (message, options) => {
				const wasStreaming = this.ctx.session.isStreaming;
				this.ctx.session
					// Trusted seam: extension producers are external to the turn
					// runtime, so classify nextTurn messages "external" here
					// instead of accepting a caller-supplied origin (review P2).
					.sendCustomMessage(message, { ...options, origin: "external" })
					.then(() => this.#applyCustomMessageDisplay(wasStreaming, message.display))
					.catch((err: unknown) => {
						const errorText = `Extension sendMessage failed: ${err instanceof Error ? err.message : String(err)}`;
						if (this.ctx.isBackgrounded) {
							logger.error(errorText);
							return;
						}
						this.ctx.showError(errorText);
					});
			},
			sendUserMessage: this.#sendExtensionUserMessage,
			appendEntry: (customType, data) => {
				this.ctx.sessionManager.appendCustomEntry(customType, data);
			},
			setLabel: (targetId, label) => {
				this.ctx.sessionManager.appendLabelChange(targetId, label);
			},
			getActiveTools: () => this.ctx.session.getActiveToolNames(),
			getAllTools: () => this.ctx.session.getAllToolNames(),
			resolveTool: name => {
				const tool = this.ctx.session.getToolByName(name);
				return tool ? { safeSummary: tool.safeSummary, safeSummaryFields: tool.safeSummaryFields } : undefined;
			},
			setActiveTools: toolNames => this.ctx.session.setActiveToolsByName(toolNames),
			setModel: model => runExtensionSetModel(this.ctx.session, model),
			getThinkingLevel: () => this.ctx.session.thinkingLevel,
			setThinkingLevel: (level, persist) => this.ctx.session.setThinkingLevel(level, persist),
			getThinkingVisibility: () => this.ctx.session.getThinkingVisibility(),
			setThinkingVisibility: (visibility, persist) => this.ctx.session.setThinkingVisibility(visibility, persist),
			cycleThinkingLevel: () => this.ctx.session.cycleThinkingLevel(),
			setThinkingLevelForControl: (level, persist) => this.ctx.session.setThinkingLevelForControl(level, persist),
			setThinkingVisibilityForControl: (visibility, persist) =>
				this.ctx.session.setThinkingVisibilityForControl(visibility, persist),
			setModelTemporaryForControl: (model, expectedSessionId, thinkingLevel) =>
				this.ctx.session.setModelTemporaryForControl(model, expectedSessionId, thinkingLevel),
			fetchUsageReportsForControl: () => this.ctx.session.fetchUsageReportsForControl(),
			getThinkingScopeForControl: () => this.ctx.session.getThinkingScopeForControl(),
			getCommands: () => getSessionSlashCommands(this.ctx.session),
			getSessionName: () => this.ctx.sessionManager.getSessionName(),
			setSessionName: name => this.#updateSessionName(name),
		};
		const contextActions: ExtensionContextActions = {
			getModel: () => this.ctx.session.model,
			getCredentialSessionId: () => this.ctx.session.credentialSessionId,
			isIdle: () => !this.ctx.session.isStreaming,
			getActivePromptHandle: () => this.ctx.session.activePromptHandle,
			abort: () => this.ctx.session.abort(),
			abortPromptAndWait: (handle, options) => this.ctx.session.abortPromptAndWait(handle, options),
			hasPendingMessages: () => this.ctx.session.queuedMessageCount > 0,
			getPendingMessageCounts: () => this.ctx.session.pendingMessageCounts,
			getTranscript: () => this.ctx.session.getTranscript(),
			getTranscriptBody: entryId => this.ctx.session.getTranscriptBody(entryId),
			getGoalState: () => this.ctx.session.getGoalModeState(),
			getTodoState: () => this.ctx.session.getTodoPhases(),
			getQueuedMessages: () => this.ctx.session.getQueuedMessageEntries(),
			getActiveTools: () => this.ctx.session.getActiveToolNames(),
			getAllTools: () => this.ctx.session.getAllToolNames(),
			resolveTool: name => {
				const tool = this.ctx.session.getToolByName(name);
				return tool ? { safeSummary: tool.safeSummary, safeSummaryFields: tool.safeSummaryFields } : undefined;
			},

			shutdown: () => {
				// Defer the actual teardown to the main loop, which calls
				// `checkShutdownRequested()` at idle boundaries so any queued
				// steering / follow-up messages drain first (see issue #1020).
				this.ctx.shutdownRequested = true;
			},
			getContextUsage: () => this.ctx.session.getContextUsage(),
			compact: instructionsOrOptions => this.#compactSession(instructionsOrOptions),
			getSystemPrompt: () => this.ctx.session.systemPrompt,
			clearContext: () => this.ctx.session.clearContext(),
			cycleModel: () => this.ctx.session.cycleModel(),
			setModelProfile: name => this.ctx.session.activateModelProfileForControl(name),
			setDefaultModelProfile: (name, options) => this.ctx.session.setDefaultModelProfileForControl(name, options),
			getActiveModelProfile: () => this.ctx.session.getActiveModelProfile(),
			withSdkControlMutation: (body, options) => this.ctx.session.withSdkControlMutation(body, options),
			cycleThinkingLevel: () => this.ctx.session.cycleThinkingLevel(),
			setQueueMode: (kind, mode) => {
				if (kind === "steering" && (mode === "all" || mode === "one-at-a-time")) {
					this.ctx.session.setSteeringMode(mode);
					return true;
				}
				if (kind === "follow_up" && (mode === "all" || mode === "one-at-a-time")) {
					this.ctx.session.setFollowUpMode(mode);
					return true;
				}
				if (kind === "tool_interrupt" && (mode === "abort_tools" || mode === "finish_tools")) {
					this.ctx.session.setToolInterruptPolicy(mode);
					return true;
				}
				return false;
			},
			getSkillState: () =>
				this.ctx.session.skills.map(skill => ({ name: skill.name, description: skill.description })),
			getConfigItems: () => this.ctx.session.getSdkConfigItems(),
			getBranchCandidates: () => this.ctx.sessionManager.getTree(),
			getExtensions: () => this.ctx.session.extensionRunner?.getExtensionPaths() ?? [],
			setSdkPermissionProvider: provider => this.ctx.session.setSdkPermissionProvider(provider),
			setSdkClientBridge: bridge => this.ctx.session.setClientBridge(bridge),
			sdkControl: this.#sdkControl,
		};
		const commandActions: ExtensionCommandContextActions = {
			getContextUsage: () => this.ctx.session.getContextUsage(),
			waitForIdle: () => this.ctx.session.agent.waitForIdle(),
			newSession: async () => prohibitBrokerLifecycleOperation("session.new"),
			branch: async () => prohibitBrokerLifecycleOperation("session.branch"),
			navigateTree: async (targetId, navOptions) => {
				const result = await this.ctx.session.navigateTree(targetId, { summarize: navOptions?.summarize });
				return { cancelled: result.cancelled };
			},
			switchSession: async () => prohibitBrokerLifecycleOperation("session.switch"),
			reload: async () => {
				if (this.ctx.isBackgrounded) {
					return;
				}
				const previousSessionId = this.ctx.sessionManager.getSessionId();
				await this.ctx.session.reload();
				if (this.#isStopped()) return;
				const sessionIdentityChanged = previousSessionId !== this.ctx.sessionManager.getSessionId();
				if (sessionIdentityChanged) this.ctx.resetIrcSidebarSession();
				this.ctx.rebuildInitialMessages(sessionIdentityChanged ? "replace-identity" : "reconcile-same-transcript");
				await this.ctx.reloadTodos();
				if (this.#isStopped()) return;
				this.ctx.showStatus("Reloaded session");
			},
			compact: async instructionsOrOptions => this.#handleInteractiveCompact(instructionsOrOptions),
		};

		extensionRunner.initialize(
			this.#guardMutations(actions, EXTENSION_ACTION_MUTATIONS),
			this.#guardMutations(contextActions, EXTENSION_CONTEXT_MUTATIONS),
			this.#guardMutations(commandActions, EXTENSION_COMMAND_MUTATIONS),
			uiContext,
		);
	}

	createBackgroundUiContext(): ExtensionUIContext {
		return {
			select: async (_title: string, _options: string[], _dialogOptions) => undefined,
			confirm: async (_title: string, _message: string, _dialogOptions) => false,
			input: async (_title: string, _placeholder?: string, _dialogOptions?: unknown) => undefined,
			notify: () => {},
			onTerminalInput: () => () => {},
			setStatus: () => {},
			setWorkingMessage: () => {},
			setWidget: () => {},
			setTitle: () => {},
			custom: async () => undefined as never,
			setEditorText: () => {},
			pasteToEditor: () => {},
			getEditorText: () => "",
			editor: async () => undefined,
			get theme() {
				return theme;
			},
			getAllThemes: () => Promise.resolve([]),
			getTheme: () => Promise.resolve(undefined),
			setTheme: () => Promise.resolve({ success: false, error: "Background mode" }),
			setFooter: () => {},
			setHeader: () => {},
			setEditorComponent: () => {},
			getToolsExpanded: () => false,
			setToolsExpanded: () => {},
		};
	}

	/**
	 * Emit session event to all extension tools.
	 */
	async emitCustomToolSessionEvent(
		reason: "start" | "switch" | "branch" | "tree" | "shutdown",
		previousSessionFile?: string,
	): Promise<void> {
		const event = { reason, previousSessionFile };
		const uiContext = this.ctx.session.extensionRunner?.getUIContext();
		if (!uiContext) {
			return;
		}
		for (const registeredTool of this.ctx.session.extensionRunner?.getAllRegisteredTools() ?? []) {
			if (registeredTool.definition.onSession) {
				try {
					await registeredTool.definition.onSession(event, {
						ui: uiContext,
						getContextUsage: () => this.ctx.session.getContextUsage(),
						compact: instructionsOrOptions => this.#compactSession(instructionsOrOptions),
						hasUI: !this.ctx.isBackgrounded,
						cwd: this.ctx.sessionManager.getCwd(),
						settings: this.ctx.session.settings ? createExtensionSettings(this.ctx.session.settings) : undefined,
						sessionManager: createReadonlySessionManager(this.ctx.session.sessionManager),
						modelRegistry: this.ctx.session.modelRegistry,
						model: this.ctx.session.model,
						getActivePromptHandle: () => this.ctx.session.activePromptHandle,
						isIdle: () => !this.ctx.session.isStreaming,
						hasPendingMessages: () => this.ctx.session.queuedMessageCount > 0,
						getPendingMessageCounts: () => this.ctx.session.pendingMessageCounts,
						getTranscript: () => this.ctx.session.getTranscript(),
						getTranscriptBody: entryId => this.ctx.session.getTranscriptBody(entryId),
						getGoalState: () => this.ctx.session.getGoalModeState(),
						getTodoState: () => this.ctx.session.getTodoPhases(),
						getQueuedMessages: () => this.ctx.session.getQueuedMessageEntries(),
						getActiveTools: () => this.ctx.session.getActiveToolNames(),
						getAllTools: () => this.ctx.session.getAllToolNames(),
						resolveTool: name => {
							const tool = this.ctx.session.getToolByName(name);
							return tool
								? { safeSummary: tool.safeSummary, safeSummaryFields: tool.safeSummaryFields }
								: undefined;
						},
						hasQueuedMessages: () => this.ctx.session.queuedMessageCount > 0,
						abort: () => {
							this.ctx.session.abort();
						},
						shutdown: () => {
							// Signal shutdown request
						},
						getSystemPrompt: () => [...this.ctx.session.systemPrompt],
						cycleModel: () => this.ctx.session.cycleModel(),
						cycleThinkingLevel: () => this.ctx.session.cycleThinkingLevel(),
						setQueueMode: (kind, mode) => {
							if (kind === "steering" && (mode === "all" || mode === "one-at-a-time")) {
								this.ctx.session.setSteeringMode(mode);
								return true;
							}
							if (kind === "follow_up" && (mode === "all" || mode === "one-at-a-time")) {
								this.ctx.session.setFollowUpMode(mode);
								return true;
							}
							if (kind === "tool_interrupt" && (mode === "abort_tools" || mode === "finish_tools")) {
								this.ctx.session.setToolInterruptPolicy(mode);
								return true;
							}
							return false;
						},
						getSkillState: () =>
							this.ctx.session.skills.map(skill => ({ name: skill.name, description: skill.description })),
						getConfigItems: () => ({
							steeringMode: this.ctx.session.steeringMode,
							followUpMode: this.ctx.session.followUpMode,
							toolInterruptPolicy: this.ctx.session.toolInterruptPolicy,
						}),
						getBranchCandidates: () => this.ctx.sessionManager.getTree(),
						getExtensions: () => this.ctx.session.extensionRunner?.getExtensionPaths() ?? [],
						getArtifact: () => undefined,
						getJobs: () => undefined,
						sdkBindings: () => [
							"cycleModel",
							"cycleThinkingLevel",
							"setQueueMode",
							"getSkillState",
							"getConfigItems",
							"getBranchCandidates",
							"getExtensions",
						],
						clearContext: () => this.ctx.session.clearContext(),
					});
				} catch (err) {
					this.showToolError(registeredTool.definition.name, err instanceof Error ? err.message : String(err));
				}
			}
		}
	}

	/**
	 * Show a tool error in the chat.
	 */
	showToolError(toolName: string, error: string): void {
		if (this.ctx.isBackgrounded) {
			logger.error(`Tool "${toolName}" error: ${error}`);
			return;
		}
		const errorText = new Text(theme.fg("error", `Tool "${toolName}" error: ${error}`), 1, 0);
		this.ctx.chatContainer.addChild(errorText);
		this.ctx.ui.requestRender();
	}

	/**
	 * Set hook status text in the footer.
	 */
	setHookStatus(key: string, text: string | undefined): void {
		if (this.#isStopped() || this.ctx.isBackgrounded) {
			return;
		}
		this.ctx.statusLine.setHookStatus(key, text);
		this.ctx.ui.requestRender();
	}

	/**
	 * Show a selector for hooks.
	 */
	showHookSelector(
		title: string,
		options: string[],
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		if (this.#isStopped()) return Promise.resolve(undefined);
		const { promise, finish, attachAbort } = this.#createHookDialogState(
			() => this.hideHookSelector(),
			dialogOptions?.signal,
		);
		const requestedTitleRows = dialogOptions?.scrollTitleRows;
		const listChromeRows = dialogOptions?.outline === true ? HOOK_SELECTOR_OUTLINE_ROWS : 0;
		// Reserve rows for the inline custom-input editor so opening it doesn't
		// push the scrollable title past the viewport into terminal scrollback.
		const hasInlineInput =
			dialogOptions?.customInput !== undefined || dialogOptions?.clarificationInput !== undefined;
		const inlineInputRows = hasInlineInput ? HOOK_SELECTOR_INLINE_INPUT_ROWS : 0;
		const helpText = dialogOptions?.helpText ?? "up/down navigate  enter select  esc cancel";
		const inlineInputHelpText =
			requestedTitleRows === undefined
				? "enter submit  esc back to options  ctrl+g external editor"
				: "enter submit  esc back to options  ctrl+g external editor  PgUp/PgDn: question · Wheel: transcript";
		const computeBudget = (): {
			maxVisible: number;
			scrollTitleRows: number | undefined;
			inlineEditorMaxHeight: number | undefined;
			inlineAutocompleteMaxVisible: number | undefined;
			compactInlineInput: boolean;
		} => {
			const baseMaxVisible = Math.max(4, Math.min(15, this.ctx.ui.terminal.rows - 12));
			const scrollOptionRows = Math.max(1, Math.min(baseMaxVisible, options.length));
			const helpWidth = Math.max(1, this.ctx.ui.terminal.columns - 2);
			const helpTextRows = Math.max(
				wrapTextWithAnsi(replaceTabs(helpText), helpWidth).length,
				hasInlineInput ? wrapTextWithAnsi(replaceTabs(inlineInputHelpText), helpWidth).length : 0,
				1,
			);
			const baseChromeRows = HOOK_SELECTOR_CHROME_ROWS - 1 + helpTextRows;
			const compactInlineInput =
				requestedTitleRows !== undefined &&
				hasInlineInput &&
				this.ctx.ui.terminal.rows < baseChromeRows + listChromeRows + inlineInputRows + 2;
			const chromeRows = baseChromeRows - (compactInlineInput ? HOOK_SELECTOR_INLINE_COMPACT_CHROME_ROWS : 0);
			const effectiveInlineInputRows = compactInlineInput
				? HOOK_SELECTOR_INLINE_COMPACT_INPUT_ROWS
				: inlineInputRows;
			const maxVisible =
				requestedTitleRows === undefined
					? baseMaxVisible
					: Math.max(
							1,
							Math.min(
								15,
								scrollOptionRows,
								this.ctx.ui.terminal.rows - listChromeRows - effectiveInlineInputRows - chromeRows - 1,
							),
						);
			const availableTitleRows =
				this.ctx.ui.terminal.rows - maxVisible - listChromeRows - effectiveInlineInputRows - chromeRows;
			const scrollTitleRows =
				requestedTitleRows === undefined
					? undefined
					: Math.max(1, Math.min(requestedTitleRows, availableTitleRows));
			return {
				maxVisible,
				scrollTitleRows,
				inlineEditorMaxHeight:
					requestedTitleRows !== undefined && hasInlineInput
						? compactInlineInput
							? HOOK_SELECTOR_INLINE_COMPACT_EDITOR_ROWS
							: HOOK_SELECTOR_INLINE_EDITOR_ROWS
						: undefined,
				inlineAutocompleteMaxVisible: compactInlineInput
					? HOOK_SELECTOR_INLINE_COMPACT_AUTOCOMPLETE_MAX_VISIBLE
					: undefined,
				compactInlineInput,
			};
		};
		const { maxVisible, scrollTitleRows, inlineEditorMaxHeight, inlineAutocompleteMaxVisible, compactInlineInput } =
			computeBudget();

		ringTerminalBell(classifyHookSelectorBellEvent(title));
		emitHostStatus("attention");

		this.ctx.hookSelector = new HookSelectorComponent(
			title,
			options,
			option => {
				this.hideHookSelector();
				finish(option);
			},
			() => {
				this.hideHookSelector();
				finish(undefined);
			},
			{
				onLeft: dialogOptions?.onLeft
					? () => {
							this.hideHookSelector();
							dialogOptions.onLeft?.();
							finish(undefined);
						}
					: undefined,
				onRight: dialogOptions?.onRight
					? () => {
							this.hideHookSelector();
							dialogOptions.onRight?.();
							finish(undefined);
						}
					: undefined,
				onExternalEditor: dialogOptions?.onExternalEditor,
				helpText: dialogOptions?.helpText,
				initialIndex: dialogOptions?.initialIndex,
				timeout: dialogOptions?.timeout,
				onTimeout: dialogOptions?.onTimeout,
				tui: this.ctx.ui,
				autocompleteProvider:
					dialogOptions?.customInput || dialogOptions?.clarificationInput
						? this.ctx.editor.getAutocompleteProvider()
						: undefined,
				outline: dialogOptions?.outline,
				wrapFocused: dialogOptions?.wrapFocused,
				scrollTitleRows,
				maxVisible,
				inlineEditorMaxHeight,
				inlineAutocompleteMaxVisible,
				compactInlineInput,
				customInput: dialogOptions?.customInput
					? {
							optionLabel: dialogOptions.customInput.optionLabel,
							allowEmpty: (dialogOptions.customInput as { allowEmpty?: boolean }).allowEmpty,
							onSubmit: text => {
								const optionLabel = dialogOptions.customInput?.optionLabel;
								this.hideHookSelector();
								dialogOptions.customInput?.onSubmit(text);
								finish(optionLabel);
							},
						}
					: undefined,
				clarificationInput: dialogOptions?.clarificationInput
					? {
							optionLabel: dialogOptions.clarificationInput.optionLabel,
							allowEmpty: dialogOptions.clarificationInput.allowEmpty,
							onSubmit: text => {
								const optionLabel = dialogOptions.clarificationInput?.optionLabel;
								this.hideHookSelector();
								dialogOptions.clarificationInput?.onSubmit(text);
								finish(optionLabel);
							},
						}
					: undefined,
			},
		);
		// Detach (not dispose) the reusable editor before mounting the transient hook UI, so the
		// disposing clear() only tears down a prior transient — the editor is re-added intact on close.
		this.ctx.editorContainer.detachChild(this.ctx.editor);
		this.ctx.editorContainer.clear();
		this.ctx.editorContainer.addChild(this.ctx.hookSelector);
		this.ctx.ui.setFocus(this.ctx.hookSelector);
		this.ctx.ui.requestRender();
		if (requestedTitleRows !== undefined) {
			this.#removeHookSelectorResizeHandler();
			const resizeHandler = () => {
				const selector = this.ctx.hookSelector;
				const nextBudget = computeBudget();
				if (!selector || nextBudget.scrollTitleRows === undefined) return;
				selector.setLayoutBudget(
					nextBudget.maxVisible,
					nextBudget.scrollTitleRows,
					nextBudget.inlineEditorMaxHeight,
					nextBudget.inlineAutocompleteMaxVisible,
					nextBudget.compactInlineInput,
				);
				this.ctx.ui.requestRender();
			};
			this.#hookSelectorResizeHandler = resizeHandler;
			process.stdout.on("resize", resizeHandler);
		}
		attachAbort();
		return promise;
	}

	/**
	 * Hide the hook selector.
	 */
	hideHookSelector(): void {
		this.#removeHookSelectorResizeHandler();
		this.ctx.hookSelector?.dispose();
		this.ctx.hookSelector = undefined;
		if (this.#isStopped()) return;
		this.#restoreComposerEditor();
		this.ctx.ui.setFocus(this.ctx.editor);
		this.ctx.ui.requestRender();
	}

	/**
	 * Show a confirmation dialog for hooks.
	 */
	async showHookConfirm(title: string, message: string): Promise<boolean> {
		const result = await this.showHookSelector(`${title}\n${message}`, ["Yes", "No"]);
		return result === "Yes";
	}

	/**
	 * Show a text input for hooks.
	 */
	showHookInput(
		title: string,
		placeholder?: string,
		dialogOptions?: ExtensionUIDialogOptions,
		inputOptions?: { readonly initialValue?: string },
	): Promise<string | undefined> {
		if (this.#isStopped()) return Promise.resolve(undefined);
		const { promise, finish, attachAbort } = this.#createHookDialogState(
			() => this.hideHookInput(),
			dialogOptions?.signal,
		);
		this.ctx.hookInput = new HookInputComponent(
			title,
			placeholder,
			value => {
				this.hideHookInput();
				finish(value);
			},
			() => {
				this.hideHookInput();
				finish(undefined);
			},
			{
				initialValue: inputOptions?.initialValue,
				timeout: dialogOptions?.timeout,
				onTimeout: dialogOptions?.onTimeout,
				tui: this.ctx.ui,
			},
		);
		// Detach (not dispose) the reusable editor before mounting the transient hook UI, so the
		// disposing clear() only tears down a prior transient — the editor is re-added intact on close.
		this.ctx.editorContainer.detachChild(this.ctx.editor);
		this.ctx.editorContainer.clear();
		this.ctx.editorContainer.addChild(this.ctx.hookInput);
		this.ctx.ui.setFocus(this.ctx.hookInput);
		this.ctx.ui.requestRender();
		attachAbort();
		return promise;
	}

	/**
	 * Hide the hook input.
	 */
	hideHookInput(): void {
		this.ctx.hookInput?.dispose();
		this.ctx.hookInput = undefined;
		if (this.#isStopped()) return;
		this.#restoreComposerEditor();
		this.ctx.ui.setFocus(this.ctx.editor);
		this.ctx.ui.requestRender();
	}

	/**
	 * Show a multi-line editor for hooks (with Ctrl+G support).
	 */
	showHookEditor(
		title: string,
		prefill?: string,
		dialogOptions?: ExtensionUIDialogOptions,
		editorOptions?: { promptStyle?: boolean },
	): Promise<string | undefined> {
		if (this.#isStopped()) return Promise.resolve(undefined);
		const { promise, finish, attachAbort } = this.#createHookDialogState(
			() => this.hideHookEditor(),
			dialogOptions?.signal,
		);
		this.ctx.hookEditor = new HookEditorComponent(
			this.ctx.ui,
			title,
			prefill,
			value => {
				this.hideHookEditor();
				finish(value);
			},
			() => {
				this.hideHookEditor();
				finish(undefined);
			},
			editorOptions,
		);

		// Detach (not dispose) the reusable editor before mounting the transient hook UI, so the
		// disposing clear() only tears down a prior transient — the editor is re-added intact on close.
		this.ctx.editorContainer.detachChild(this.ctx.editor);
		this.ctx.editorContainer.clear();
		this.ctx.editorContainer.addChild(this.ctx.hookEditor);
		this.ctx.ui.setFocus(this.ctx.hookEditor);
		this.ctx.ui.requestRender();
		attachAbort();
		return promise;
	}

	/**
	 * Hide the hook editor.
	 */
	hideHookEditor(): void {
		if (this.#isStopped()) {
			this.ctx.hookEditor?.dispose();
			this.ctx.hookEditor = undefined;
			return;
		}
		this.#restoreComposerEditor();
		this.ctx.hookEditor = undefined;
		this.ctx.ui.setFocus(this.ctx.editor);
		this.ctx.ui.requestRender();
	}

	/**
	 * Show a notification for hooks.
	 */
	showHookNotify(message: string, type?: "info" | "warning" | "error"): void {
		if (this.#isStopped()) return;
		if (type === "error") {
			this.ctx.showError(message);
		} else if (type === "warning") {
			this.ctx.showWarning(message);
		} else {
			this.ctx.showStatus(message);
		}
	}

	/**
	 * Show a custom component with keyboard focus.
	 */
	async showHookCustom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: { overlay?: boolean },
	): Promise<T> {
		if (this.#isStopped()) return undefined as T;
		const savedText = this.ctx.editor.getText();
		const keybindings = KeybindingsManager.inMemory();

		const { promise, resolve } = Promise.withResolvers<T>();
		let component: (Component & { dispose?(): void }) | undefined;
		let closed = false;

		const close = (result: T) => {
			if (closed) return;
			closed = true;
			this.#activeHookCustomCancel = undefined;
			this.#clearActiveHookCustom();
			if (this.#isStopped()) {
				resolve(result);
				return;
			}
			if (!options?.overlay) {
				this.#restoreComposerEditor();
				this.ctx.editor.setText(savedText);
			}
			this.ctx.ui.setFocus(this.ctx.editor);
			this.ctx.ui.requestRender();
			resolve(result);
		};

		this.#activeHookCustomCancel?.();
		this.#clearActiveHookCustom();
		this.#activeHookCustomCancel = () => close(undefined as T);
		Promise.try(() => factory(this.ctx.ui, theme, keybindings, close)).then(c => {
			if (closed || this.#isStopped()) {
				c.dispose?.();
				if (!closed) {
					closed = true;
					resolve(undefined as T);
				}
				return;
			}
			component = c;
			this.#activeHookCustomComponent = c;
			if (options?.overlay) {
				this.#activeHookCustomOverlay = this.ctx.ui.showOverlay(component, {
					anchor: "bottom-center",
					width: "100%",
					maxHeight: "100%",
					margin: 0,
				});
				return;
			}
			// Detach (not dispose) the reusable editor before mounting the transient hook UI, so the
			// disposing clear() only tears down a prior transient — the editor is re-added intact on close.
			this.ctx.editorContainer.detachChild(this.ctx.editor);
			this.ctx.editorContainer.clear();
			this.ctx.editorContainer.addChild(component);
			this.ctx.ui.setFocus(component);
			this.ctx.ui.requestRender();
		});
		return promise;
	}

	/**
	 * Show an extension error in the UI.
	 */
	addExtensionTerminalInputListener(handler: TerminalInputHandler): () => void {
		if (this.#isStopped()) return () => {};
		const unsubscribe = this.ctx.ui.addInputListener(handler);
		this.#extensionTerminalInputUnsubscribers.add(unsubscribe);
		return () => {
			unsubscribe();
			this.#extensionTerminalInputUnsubscribers.delete(unsubscribe);
		};
	}

	clearHookWidgets(): void {
		this.#clearActiveHookCustom();
		for (const widget of this.#hookWidgetsAbove.values()) {
			widget.dispose?.();
		}
		for (const widget of this.#hookWidgetsBelow.values()) {
			widget.dispose?.();
		}
		this.#hookWidgetsAbove.clear();
		this.#hookWidgetsBelow.clear();
		this.#rebuildHookWidgets();
	}

	clearExtensionTerminalInputListeners(): void {
		for (const unsubscribe of this.#extensionTerminalInputUnsubscribers) {
			unsubscribe();
		}
		this.#extensionTerminalInputUnsubscribers.clear();
	}

	dispose(): void {
		this.#removeHookSelectorResizeHandler();
		this.#extensionErrorUnsubscribe?.();
		this.#extensionErrorUnsubscribe = undefined;
		this.#activeHookCustomCancel?.();
		this.#activeHookCustomCancel = undefined;
		this.clearExtensionTerminalInputListeners();
		this.clearHookWidgets();
	}

	showExtensionError(extensionPath: string, error: string): void {
		if (this.#isStopped()) return;
		const errorText = new Text(theme.fg("error", `Extension "${extensionPath}" error: ${error}`), 1, 0);
		this.ctx.chatContainer.addChild(errorText);
		this.ctx.ui.requestRender();
	}
	async #handleInteractiveCompact(instructionsOrOptions: string | CompactOptions | undefined): Promise<void> {
		if (this.ctx.isBackgrounded) {
			await this.#compactSession(instructionsOrOptions);
			return;
		}
		await this.ctx.executeCompaction(instructionsOrOptions, false);
	}

	async #compactSession(instructionsOrOptions: string | CompactOptions | undefined): Promise<void> {
		const instructions = typeof instructionsOrOptions === "string" ? instructionsOrOptions : undefined;
		const options =
			instructionsOrOptions && typeof instructionsOrOptions === "object" ? instructionsOrOptions : undefined;
		await this.ctx.session.compact(instructions, options);
	}

	async #updateSessionName(name: string): Promise<void> {
		const session = this.ctx.session;
		const identityAdmission = session.captureSessionIdentityForMode();
		const assertCurrentIdentity = (): void => {
			if (!session.isSessionIdentityCurrentForMode(identityAdmission)) {
				throw new Error("Session changed while renaming session");
			}
		};
		await session.withSdkControlMutation(async () => {
			assertCurrentIdentity();
			await this.ctx.sessionManager.setSessionName(name, "user");
			assertCurrentIdentity();
			setSessionTerminalTitle(this.ctx.sessionManager.getSessionName(), this.ctx.sessionManager.getCwd());
		});
	}

	#sendExtensionUserMessage: SendUserMessageHandler = (content, options) => {
		if (this.#isStopped()) return Promise.resolve();
		// Validate at the owning boundary BEFORE session delivery and UI bookkeeping:
		// applyInjectedUserSubmission → normalizeInjectedUserContent iterates content
		// and dereferences part.type synchronously. Absent/null content (the
		// container) OR null/undefined/non-object array elements throw an untyped
		// TypeError synchronously — before the send.catch handler below is attached,
		// leaving the typed invalid_input rejection from AgentSession unobserved
		// (unhandled rejection) and crashing the resident process. Reject as a typed
		// nonfatal control error so callers can surface it without losing session
		// continuity.
		const invalidContentError = extensionUserMessageContentError(content);
		if (invalidContentError) return Promise.reject(invalidContentError);
		// Compute queued BEFORE send: prompt() may flip session.isStreaming synchronously.
		const queued = Boolean(options?.deliverAs) || this.ctx.session.isStreaming;
		// Call send first so the busy/queued path finds the session queue populated
		// (queueSteer/queueFollowUp push synchronously) before refreshing pending display.
		const send = this.ctx.session.sendUserMessage(content, options);
		applyInjectedUserSubmission(this.ctx, { content, queued });
		void send.catch((err: unknown) => {
			if (this.#isStopped()) return;
			this.ctx.showError(`Extension sendUserMessage failed: ${err instanceof Error ? err.message : String(err)}`);
		});
		return send;
	};

	#applyCustomMessageDisplay(wasStreaming: boolean, shouldDisplay: boolean | undefined): void {
		// For non-streaming cases with display=true, update UI
		// (streaming cases update via message_end event)
		if (!this.ctx.isBackgrounded && !wasStreaming && shouldDisplay) {
			this.ctx.rebuildChatFromMessages("reconcile-same-transcript");
		}
	}

	#createHookDialogState(
		hide: () => void,
		signal: AbortSignal | undefined,
	): {
		promise: Promise<string | undefined>;
		finish: (value: string | undefined) => void;
		attachAbort: () => void;
	} {
		const { promise, resolve } = Promise.withResolvers<string | undefined>();
		let settled = false;
		let unregisterStop: (() => void) | undefined;
		const finish = (value: string | undefined) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			unregisterStop?.();
			resolve(value);
		};
		const onAbort = () => {
			hide();
			finish(undefined);
		};
		const attachAbort = () => {
			unregisterStop = this.ctx.onStop?.(onAbort);
			if (settled) unregisterStop?.();
			if (!signal) return;
			if (signal.aborted) {
				onAbort();
			} else {
				signal.addEventListener("abort", onAbort, { once: true });
			}
		};
		return { promise, finish, attachAbort };
	}
}
