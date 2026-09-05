import { INTENT_FIELD } from "@gajae-code/agent-core";
import { calculatePromptTokens } from "@gajae-code/agent-core/compaction/compaction";
import type { AssistantMessage, ImageContent } from "@gajae-code/ai/core";
import { parseRateLimitReason } from "@gajae-code/ai/core";
import { type Component, Loader, TERMINAL, Text } from "@gajae-code/tui";
import { logger } from "@gajae-code/utils";
import { settings } from "../../config/settings";
import { AssistantMessageComponent } from "../../modes/components/assistant-message";
import {
	ReadToolGroupComponent,
	readArgsHaveTarget,
	readArgsTargetInternalUrl,
} from "../../modes/components/read-tool-group";
import { TodoReminderComponent } from "../../modes/components/todo-reminder";
import { ToolExecutionComponent, type ToolExecutionHandle } from "../../modes/components/tool-execution";
import { TtsrNotificationComponent } from "../../modes/components/ttsr-notification";
import { getSymbolTheme, theme } from "../../modes/theme/theme";
import {
	type InteractiveModeContext,
	stopInteractiveActivityIndicator,
	syncInteractiveActivityIndicator,
	type TodoPhase,
} from "../../modes/types";
import type { PlanApprovalDetails } from "../../plan-mode/approved-plan";
import { completionNotifyDisabledByEnv } from "../../sdk/bus/config";
import { summaryFromMessage } from "../../sdk/bus/helpers";
import type { AgentSessionEvent } from "../../session/agent-session";
import { type CustomMessage, isSilentAbort, readPendingDisplayTag, SILENT_ABORT_MARKER } from "../../session/messages";
import { transferSessionMessageIdentity } from "../../session/session-manager";
import type { ResolveToolDetails } from "../../tools/resolve";
import { computeIrcSplitWidths, getIrcSidebarSemanticToken } from "../components/irc-sidebar";
import type { IrcObservationRecord } from "../irc-observation-ledger";
import { interruptHint } from "../shared";
import { buildAbortDisplayMessage } from "../utils/abort-message";
import { emitHostStatus } from "../utils/host-status";
import { consumeInjectedOptimisticSignature } from "../utils/injected-user-submission";
import { parseIrcMessage } from "../utils/irc-message";
import { ringTerminalBell } from "../utils/terminal-bell";

import { addChatChild, argsWithPartialJson } from "../utils/ui-helpers";

type AgentSessionEventKind = AgentSessionEvent["type"];

/** Test-only performance counters for advisory baseline tests. */
export const __eventControllerPerfCounters = {
	enabled: false,
	messageUpdateContentVisits: 0,
	enable(): void {
		this.enabled = true;
	},
	disable(): void {
		this.enabled = false;
	},
	reset(): void {
		this.messageUpdateContentVisits = 0;
	},
};

const COMPLETION_NOTIFY_COMMAND_TIMEOUT_MS = 10_000;
const TEXTLESS_LENGTH_WARNING =
	'Response ended with stopReason "length" before producing visible text or a tool call. Check the model\'s output and context token limits (maxTokens in models.yml) or lower the reasoning level (/reasoning), then retry.';

function isTextlessLengthStop(message: AssistantMessage | undefined): boolean {
	return (
		message?.stopReason === "length" &&
		!message.content.some(
			block => (block.type === "text" && block.text.trim().length > 0) || block.type === "toolCall",
		)
	);
}

interface CompletionNotifyPayload {
	type: "agent-turn-complete";
	title: string;
	body: string;
	cwd: string;
	sessionId?: string;
	sessionName?: string;
	lastAssistantMessage?: string;
	stopReason?: string;
}

function completionNotifyShellCommand(command: string): string[] {
	if (process.platform === "win32") {
		return ["cmd.exe", "/d", "/s", "/c", command];
	}
	return ["/bin/sh", "-c", command];
}

function cleanNotificationEnvValue(value: string | undefined, max = 4000): string {
	if (!value) return "";
	return value.replaceAll("\0", "").slice(0, max);
}

function buildCompletionNotifyEnv(payload: CompletionNotifyPayload): Record<string, string> {
	return {
		GJC_NOTIFICATION_TYPE: payload.type,
		GJC_NOTIFICATION_TITLE: cleanNotificationEnvValue(payload.title, 500),
		GJC_NOTIFICATION_BODY: cleanNotificationEnvValue(payload.body),
		GJC_NOTIFICATION_CWD: cleanNotificationEnvValue(payload.cwd, 2000),
		GJC_NOTIFICATION_SESSION_ID: cleanNotificationEnvValue(payload.sessionId, 500),
		GJC_NOTIFICATION_SESSION_NAME: cleanNotificationEnvValue(payload.sessionName, 500),
		GJC_NOTIFICATION_LAST_ASSISTANT_MESSAGE: cleanNotificationEnvValue(payload.lastAssistantMessage),
		GJC_NOTIFICATION_STOP_REASON: cleanNotificationEnvValue(payload.stopReason, 100),
		GJC_NOTIFICATION_JSON: cleanNotificationEnvValue(JSON.stringify(payload), 8000),
	};
}

function friendlyRetryReason(errorMessage: string | undefined): string {
	if (!errorMessage) return "";
	switch (parseRateLimitReason(errorMessage)) {
		case "RATE_LIMIT_EXCEEDED":
			return "rate limited";
		case "QUOTA_EXHAUSTED":
			return "usage limit";
		case "MODEL_CAPACITY_EXHAUSTED":
			return "overloaded";
		case "SERVER_ERROR":
			return "server error";
		default:
			return /network|connection|socket|fetch failed|terminated|timeout|timed out|stream/i.test(errorMessage)
				? "connection error"
				: "transient error";
	}
}

type AgentSessionEventHandlers = {
	[E in AgentSessionEventKind]: (event: Extract<AgentSessionEvent, { type: E }>) => Promise<void>;
};

interface AssistantTextPresentation {
	component: AssistantMessageComponent;
	latestMessage: AssistantMessage;
	sessionIdentity: InteractiveModeContext["session"];
	sessionEpoch: number;
	paintEpoch: number;
	cancel: () => void;
}

export class EventController {
	#lastReadGroup: ReadToolGroupComponent | undefined = undefined;
	#lastThinkingCount = 0;
	#renderedCustomMessages = new Set<string>();
	#lastIntent: string | undefined = undefined;
	#backgroundToolCallIds = new Set<string>();
	#readToolCallArgs = new Map<string, Record<string, unknown>>();
	#readToolCallAssistantComponents = new Map<string, AssistantMessageComponent>();
	#lastAssistantComponent: AssistantMessageComponent | undefined = undefined;
	#idleCompactionTimer?: NodeJS.Timeout;
	#ircExpiryTimers = new Map<string, NodeJS.Timeout>();
	#renderedIrcComponents = new Map<string, readonly Component[]>();
	#toolIntentCache = new Map<string, { args: unknown; intent: string | undefined }>();
	#thinkingContentIndices = new Set<number>();
	#handlers: AgentSessionEventHandlers;
	#visibleTranscriptChanged = false;
	#handlingEvent = false;
	#eventQueue: Promise<void> = Promise.resolve();
	#disposed = false;
	#assistantTextSuspended = false;
	#sessionPresentationEpoch = 0;
	#paintEpoch = 0;
	#pendingAssistantText: AssistantTextPresentation | undefined;
	#assistantTextMutationScope: AssistantTextPresentation | undefined;
	#assistantLifetimes = new WeakMap<
		AssistantMessageComponent,
		{ sessionIdentity: InteractiveModeContext["session"]; sessionEpoch: number }
	>();

	constructor(private ctx: InteractiveModeContext) {
		this.#handlers = {
			agent_start: e => this.#handleAgentStart(e),
			agent_failed: async () => {},
			agent_end: e => this.#handleAgentEnd(e),
			turn_start: async () => {},
			turn_end: async () => {},
			message_start: e => this.#handleMessageStart(e),
			message_update: e => this.#handleMessageUpdate(e),
			message_end: e => this.#handleMessageEnd(e),
			tool_execution_start: e => this.#handleToolExecutionStart(e),
			tool_execution_update: e => this.#handleToolExecutionUpdate(e),
			tool_execution_end: e => this.#handleToolExecutionEnd(e),
			auto_compaction_start: e => this.#handleAutoCompactionStart(e),
			auto_compaction_end: e => this.#handleAutoCompactionEnd(e),
			auto_retry_start: e => this.#handleAutoRetryStart(e),
			auto_retry_end: e => this.#handleAutoRetryEnd(e),
			ttsr_triggered: e => this.#handleTtsrTriggered(e),
			todo_reminder: e => this.#handleTodoReminder(e),
			todo_auto_clear: e => this.#handleTodoAutoClear(e),
			irc_message: e => this.#handleIrcMessage(e),
			subagent_steer_message: e => this.#handleSubagentSteerMessage(e),
			notice: e => this.#handleNotice(e),
			model_fallback_switched: e => this.#handleModelFallbackSwitched(e),
			thinking_level_changed: async () => {},
			goal_updated: async () => {},
		} satisfies AgentSessionEventHandlers;
	}

	dispose(): void {
		this.#disposed = true;
		this.resetAssistantTextPresentation();
		this.#cancelIdleCompaction();
		this.#clearRetryCountdown();
		if (this.ctx.retryEscapeHandler) {
			this.ctx.editor.onEscape = this.ctx.retryEscapeHandler;
			this.ctx.retryEscapeHandler = undefined;
		}
		this.ctx.retryEscapePrimed = false;
		if (this.ctx.autoCompactionEscapeHandler) {
			this.ctx.editor.onEscape = this.ctx.autoCompactionEscapeHandler;
			this.ctx.autoCompactionEscapeHandler = undefined;
		}
		if (this.ctx.autoCompactionLoader) {
			this.ctx.autoCompactionLoader.stop();
			this.ctx.autoCompactionLoader = undefined;
		}
		if (this.ctx.retryLoader) {
			this.ctx.retryLoader.stop();
			this.ctx.retryLoader = undefined;
		}
		this.clearIrcExpiryTimers();
	}

	#cancelAssistantTextPresentation(): void {
		const pending = this.#pendingAssistantText;
		this.#pendingAssistantText = undefined;
		pending?.cancel();
	}

	/** Temporary TUI stop discards scheduling, not historical assistant callback lifetimes. */
	suspendAssistantTextPresentation(): void {
		this.#assistantTextSuspended = true;
		this.#paintEpoch += 1;
		this.#cancelAssistantTextPresentation();
	}

	/** Rearm before the first restarted frame, even without a new provider event. */
	resumeAssistantTextPresentation(): void {
		this.#cancelAssistantTextPresentation();
		this.#assistantTextSuspended = false;
		const component = this.ctx.streamingComponent;
		const message = this.ctx.streamingMessage;
		if (component && message && this.#isLiveAssistant(component)) {
			this.#queueAssistantText(component, message);
		}
	}

	/** Session/transcript replacement invalidates callbacks before removing old children. */
	resetAssistantTextPresentation(): void {
		const detachedComponent = this.ctx.streamingComponent;
		const detachedMessage = this.ctx.streamingMessage;
		this.#sessionPresentationEpoch += 1;
		this.#cancelAssistantTextPresentation();
		// Some rebuild callers detach the live component before invoking this reset and
		// reattach it immediately afterward. Advance its ownership epoch here so that
		// reattachment remains eligible without requiring a second controller hook.
		if (
			detachedComponent &&
			detachedMessage?.role === "assistant" &&
			!this.ctx.chatContainer.hasLiveChild(detachedComponent)
		) {
			this.#assistantLifetimes.set(detachedComponent, {
				sessionIdentity: this.ctx.session,
				sessionEpoch: this.#sessionPresentationEpoch,
			});
		}
	}

	/** Rebind a detached live assistant after an in-place transcript rebuild. */
	rebindAssistantTextPresentation(): void {
		const component = this.ctx.streamingComponent;
		if (!component) return;
		this.#assistantLifetimes.set(component, {
			sessionIdentity: this.ctx.session,
			sessionEpoch: this.#sessionPresentationEpoch,
		});
		const message = this.ctx.streamingMessage;
		if (message?.role === "assistant" && !this.#assistantTextSuspended) {
			this.#queueAssistantText(component, message);
		}
	}

	#isLiveAssistant(component: AssistantMessageComponent): boolean {
		const lifetime = this.#assistantLifetimes.get(component);
		return (
			!this.#disposed &&
			!this.ctx.isStopped?.() &&
			lifetime !== undefined &&
			lifetime.sessionIdentity === this.ctx.session &&
			lifetime.sessionEpoch === this.#sessionPresentationEpoch &&
			this.ctx.chatContainer.hasLiveChild(component)
		);
	}

	#isValidAssistantText(record: AssistantTextPresentation): boolean {
		return (
			!this.#assistantTextSuspended &&
			this.#isLiveAssistant(record.component) &&
			record.sessionIdentity === this.ctx.session &&
			record.sessionEpoch === this.#sessionPresentationEpoch &&
			record.paintEpoch === this.#paintEpoch &&
			record.component === this.ctx.streamingComponent
		);
	}

	#queueAssistantText(component: AssistantMessageComponent, latestMessage: AssistantMessage): void {
		if (this.#assistantTextSuspended || !this.#isLiveAssistant(component)) return;
		const pending = this.#pendingAssistantText;
		if (pending && this.#isValidAssistantText(pending)) {
			pending.latestMessage = latestMessage;
			return;
		}
		this.#cancelAssistantTextPresentation();
		const record: AssistantTextPresentation = {
			component,
			latestMessage,
			sessionIdentity: this.ctx.session,
			sessionEpoch: this.#sessionPresentationEpoch,
			paintEpoch: this.#paintEpoch,
			cancel: () => {},
		};
		this.#pendingAssistantText = record;
		record.cancel = this.ctx.ui.enqueueBeforeRender(() => this.#flushAssistantText(record));
	}

	#flushAssistantText(record = this.#pendingAssistantText): void {
		if (!record || this.#pendingAssistantText !== record) return;
		this.#cancelAssistantTextPresentation();
		if (!this.#isValidAssistantText(record)) return;
		const previousScope = this.#assistantTextMutationScope;
		this.#assistantTextMutationScope = record;
		try {
			record.component.updateContent(record.latestMessage, { streaming: true });
		} finally {
			this.#assistantTextMutationScope = previousScope;
		}
	}

	#observeAssistantMutation(component: AssistantMessageComponent): void {
		if (!this.#isLiveAssistant(component)) return;
		const scope = this.#assistantTextMutationScope;
		if (scope?.component === component && this.#isValidAssistantText(scope)) {
			// Only this synchronous projection publishes before frame source selection.
			// An unrelated awaited event retains its own dirty flag and settlement semantics.
			this.ctx.recordVisibleTranscriptMutation?.();
			return;
		}
		this.#observeVisibleTranscriptMutation();
	}

	#recordVisibleTranscriptMutation(): void {
		this.#visibleTranscriptChanged = true;
	}

	#observeVisibleTranscriptMutation(): void {
		if (this.#handlingEvent) {
			this.#recordVisibleTranscriptMutation();
			return;
		}
		this.ctx.recordVisibleTranscriptMutation?.();
	}

	#consumeToolVisibleChange(handle: ToolExecutionHandle): void {
		// Structural third-party renderers may not implement the optional exact-consume
		// capability; preserve revision correctness conservatively until they opt in.
		if (typeof handle.consumeVisibleTranscriptChange !== "function" || handle.consumeVisibleTranscriptChange()) {
			this.#recordVisibleTranscriptMutation();
		}
	}

	#resetReadGroup(): void {
		this.#lastReadGroup = undefined;
	}

	#getReadGroup(): ReadToolGroupComponent {
		if (!this.#lastReadGroup) {
			addChatChild(this.ctx, new Text("", 0, 0));
			const group = new ReadToolGroupComponent({
				showContentPreview: this.ctx.settings.get("read.toolResultPreview"),
			});
			group.setExpanded(this.ctx.toolOutputExpanded);
			addChatChild(this.ctx, group);
			this.#lastReadGroup = group;
		}
		return this.#lastReadGroup;
	}

	#trackReadToolCall(toolCallId: string, args: unknown): void {
		if (!toolCallId) return;
		const normalizedArgs =
			args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
		this.#readToolCallArgs.set(toolCallId, normalizedArgs);
		const assistantComponent = this.ctx.streamingComponent ?? this.#lastAssistantComponent;
		if (assistantComponent) {
			this.#readToolCallAssistantComponents.set(toolCallId, assistantComponent);
		}
	}

	#clearReadToolCall(toolCallId: string): void {
		this.#readToolCallArgs.delete(toolCallId);
		this.#readToolCallAssistantComponents.delete(toolCallId);
	}

	#inlineReadToolImages(
		toolCallId: string,
		result: { content: Array<{ type: string; data?: string; mimeType?: string }> },
	): boolean {
		if (!settings.get("terminal.showImages")) return false;
		const assistantComponent = this.#readToolCallAssistantComponents.get(toolCallId);
		if (!assistantComponent) return false;
		const images: ImageContent[] = result.content
			.filter(
				(content): content is ImageContent =>
					content.type === "image" && typeof content.data === "string" && typeof content.mimeType === "string",
			)
			.map(content => ({ type: "image", data: content.data, mimeType: content.mimeType }));
		if (images.length === 0) return false;
		assistantComponent.setToolResultImages(toolCallId, images);
		return true;
	}
	#updateWorkingMessageFromIntent(intent: unknown): void {
		// Streamed JSON can deliver non-string `_i` (object, number, boolean) before
		// schema validation; `?.` only guards null/undefined, so guard the type too.
		if (typeof intent !== "string") return;
		const trimmed = intent.trim();
		if (!trimmed || trimmed === this.#lastIntent) return;
		this.#lastIntent = trimmed;
		this.ctx.setWorkingMessage(`${trimmed}${interruptHint()}`);
	}

	subscribeToAgent(): void {
		this.ctx.unsubscribe = this.ctx.session.subscribe(async (event: AgentSessionEvent) => {
			await this.handleEvent(event);
		});
	}

	handleEvent(event: AgentSessionEvent): Promise<void> {
		const dispatch = this.#eventQueue.then(() => this.#dispatchEvent(event));
		this.#eventQueue = dispatch.catch(() => {});
		return dispatch;
	}

	async #dispatchEvent(event: AgentSessionEvent): Promise<void> {
		if (this.#disposed) return;
		if (this.ctx.isStopped?.()) return;
		if (!this.ctx.isInitialized) await this.ctx.init();
		if (this.#disposed || this.ctx.isStopped?.()) return;
		this.#visibleTranscriptChanged = false;
		this.#handlingEvent = true;
		try {
			this.ctx.statusLine.invalidate();
			this.ctx.updateEditorTopBorder();
			const run = this.#handlers[event.type] as (e: AgentSessionEvent) => Promise<void>;
			await run(event);
			if (this.ctx.isStopped?.()) return;
			if (this.#visibleTranscriptChanged) this.ctx.recordVisibleTranscriptMutation?.();
			if (this.ctx.isTranscriptViewerOpen?.()) this.ctx.refreshTranscriptViewer?.();
		} finally {
			this.#handlingEvent = false;
		}
	}

	async #handleAgentStart(_event: Extract<AgentSessionEvent, { type: "agent_start" }>): Promise<void> {
		emitHostStatus("working");
		this.ctx.promptSuggestion?.onAgentStart();
		this.#lastIntent = undefined;
		this.#readToolCallArgs.clear();
		this.#readToolCallAssistantComponents.clear();
		this.#lastAssistantComponent = undefined;
		if (this.ctx.retryEscapeHandler) {
			this.ctx.editor.onEscape = this.ctx.retryEscapeHandler;
			this.ctx.retryEscapeHandler = undefined;
		}
		if (this.ctx.retryLoader) {
			this.ctx.retryLoader.stop();
			this.#clearRetryCountdown();
			this.ctx.retryLoader = undefined;
			this.ctx.statusContainer.clear();
		}
		this.ctx.retryEscapePrimed = false;
		this.#cancelIdleCompaction();
		this.ctx.updateEditorBorderColor();
		this.ctx.ensureLoadingAnimation();
		this.ctx.ui.requestRender();
	}

	#observeIrcMessage(message: CustomMessage): void {
		const parsed = parseIrcMessage(message);
		if (!parsed) return;
		const arrival = this.ctx.captureIrcArrivalSnapshot();
		const rightWidth = arrival.panelVisible
			? computeIrcSplitWidths(this.ctx.ui.terminal?.columns ?? 0).rightWidth
			: 0;
		const beforeToken = rightWidth > 0 ? getIrcSidebarSemanticToken(this.ctx.ircLedger, rightWidth) : "";
		const record = this.ctx.ircLedger.observe(parsed, arrival.panelVisible);
		const evictedInlineRemoved = this.#cleanupIrcObservationIds(this.ctx.ircLedger.drainEvictedObservationIds());
		if (!record) return;
		const signature = `irc:${record.observationId}`;
		if (this.#renderedCustomMessages.has(signature)) return;
		this.#renderedCustomMessages.add(signature);
		this.#resetReadGroup();
		const components = this.ctx.addLiveIrcObservationToChat(record, arrival);
		this.#renderedIrcComponents.set(record.observationId, components);
		this.#scheduleIrcExpiry(record, components);
		this.ctx.ui.requestRender();
		const afterToken = rightWidth > 0 ? getIrcSidebarSemanticToken(this.ctx.ircLedger, rightWidth) : "";
		if (components.length > 0 || evictedInlineRemoved || (rightWidth > 0 && beforeToken !== afterToken)) {
			this.#recordVisibleTranscriptMutation();
		}
	}

	#cleanupIrcObservationIds(observationIds: readonly string[]): boolean {
		const removedComponents = new Set<Component>();
		for (const observationId of observationIds) {
			const timer = this.#ircExpiryTimers.get(observationId);
			if (timer) clearTimeout(timer);
			this.#ircExpiryTimers.delete(observationId);
			for (const component of this.#renderedIrcComponents.get(observationId) ?? []) {
				removedComponents.add(component);
			}
			this.#renderedIrcComponents.delete(observationId);
			for (const component of this.ctx.removeRenderedIrcInlineComponents(observationId) ?? []) {
				removedComponents.add(component);
			}
			this.#renderedCustomMessages.delete(`irc:${observationId}`);
		}
		for (const component of removedComponents) this.ctx.chatContainer.removeChild(component);
		return removedComponents.size > 0;
	}

	#cleanupEvictedIrcObservations(): void {
		if (this.#cleanupIrcObservationIds(this.ctx.ircLedger.drainEvictedObservationIds())) {
			this.#recordVisibleTranscriptMutation();
		}
	}

	#cleanupExpiredIrcInlineComponents(observationId: string): boolean {
		const removedComponents = new Set<Component>(this.#renderedIrcComponents.get(observationId));
		this.#renderedIrcComponents.delete(observationId);
		for (const component of this.ctx.removeRenderedIrcInlineComponents(observationId) ?? []) {
			removedComponents.add(component);
		}
		for (const component of removedComponents) this.ctx.chatContainer.removeChild(component);
		return removedComponents.size > 0;
	}

	async #handleMessageStart(event: Extract<AgentSessionEvent, { type: "message_start" }>): Promise<void> {
		if (event.message.role === "hookMessage" || event.message.role === "custom") {
			if (event.message.role === "custom" && parseIrcMessage(event.message)) {
				this.#observeIrcMessage(event.message);
				return;
			}
			const signature = `${event.message.role}:${event.message.customType}:${event.message.timestamp}`;
			if (this.#renderedCustomMessages.has(signature)) {
				return;
			}
			this.#renderedCustomMessages.add(signature);
			this.#resetReadGroup();
			this.ctx.addMessageToChat(event.message);
			if (event.message.display) this.#recordVisibleTranscriptMutation();
			// Tag-keyed pending-bar refresh: when AgentSession.#handleAgentEvent
			// spliced this dequeued custom message out of #steeringMessages /
			// #followUpMessages (it ran before this emit), the array state is
			// already correct — pendingMessagesContainer just needs to be
			// re-rendered to match. Gated on tag presence so non-queued customs
			// (ttsr-injection, irc:*, async-result, hookMessage) skip the
			// rebuild; their dispatch path never registered a pending chip.
			// Mirrors the user-role refresh at the bottom of this function.
			if (event.message.role === "custom" && readPendingDisplayTag(event.message.details)) {
				this.ctx.updatePendingMessagesDisplay();
			}
			this.ctx.ui.requestRender();
		} else if (event.message.role === "user") {
			const textContent = this.ctx.getUserMessageText(event.message);
			const imageCount =
				typeof event.message.content === "string"
					? 0
					: event.message.content.filter(content => content.type === "image").length;
			const signature = `${textContent}\u0000${imageCount}`;

			this.#resetReadGroup();
			const wasSingleOptimistic = this.ctx.optimisticUserMessageSignature === signature;
			const wasInjectedOptimistic = !wasSingleOptimistic && consumeInjectedOptimisticSignature(this.ctx, signature);
			const wasOptimistic = wasSingleOptimistic || wasInjectedOptimistic;
			const wasLocallySubmitted = this.ctx.locallySubmittedUserSignatures.delete(signature) || wasOptimistic;
			if (!wasOptimistic) {
				this.ctx.addMessageToChat(event.message);
			}
			// Only clear the single local slot when IT matched; an injected match is
			// consumed from the counting Map above and must not clobber a coexisting
			// pending local optimistic signature.
			if (wasSingleOptimistic) {
				this.ctx.optimisticUserMessageSignature = undefined;
			}

			// Clear the editor only when the submission did not originate from a
			// local submission (optimistic or queued-while-streaming). Both local
			// paths already cleared the editor at submit time; clearing again here
			// would race with the user typing the next prompt while the previous
			// large redraw lands and erase their in-progress draft (#783).
			if (!event.message.synthetic) {
				if (!wasLocallySubmitted) {
					this.ctx.editor.setText("");
				}
				this.ctx.updatePendingMessagesDisplay();
			}
			this.ctx.ui.requestRender();
			if (!wasOptimistic) this.#recordVisibleTranscriptMutation();
		} else if (event.message.role === "fileMention") {
			this.#resetReadGroup();
			this.ctx.addMessageToChat(event.message);
			this.ctx.ui.requestRender();
			this.#recordVisibleTranscriptMutation();
		} else if (event.message.role === "assistant") {
			this.#cancelAssistantTextPresentation();
			this.#lastThinkingCount = 0;
			this.#resetReadGroup();
			this.#toolIntentCache.clear();
			this.#thinkingContentIndices.clear();
			const component: AssistantMessageComponent = new AssistantMessageComponent(
				undefined,
				this.ctx.hideThinkingBlock,
				() => {
					if (this.#isLiveAssistant(component)) this.ctx.ui.requestRender();
				},
				this.ctx.getAssistantViewportAnchorId?.(event.message),
				() => this.#observeAssistantMutation(component),
				this.ctx.session,
			);
			this.#assistantLifetimes.set(component, {
				sessionIdentity: this.ctx.session,
				sessionEpoch: this.#sessionPresentationEpoch,
			});
			this.ctx.streamingComponent = component;
			this.ctx.streamingMessage = event.message;
			addChatChild(this.ctx, this.ctx.streamingComponent);
			this.ctx.streamingComponent.updateContent(this.ctx.streamingMessage, { streaming: true });
			this.ctx.ui.requestRender();
		}
	}

	async #handleIrcMessage(event: Extract<AgentSessionEvent, { type: "irc_message" }>): Promise<void> {
		this.#observeIrcMessage(event.message);
	}

	clearIrcExpiryTimers(): void {
		for (const timer of this.#ircExpiryTimers.values()) {
			clearTimeout(timer);
		}
		this.#ircExpiryTimers.clear();
	}

	resetIrcObservations(): void {
		this.clearIrcExpiryTimers();
		const observationIds = new Set<string>(this.#renderedIrcComponents.keys());
		for (const observationId of this.ctx.ircLedger.drainEvictedObservationIds()) observationIds.add(observationId);
		this.#cleanupIrcObservationIds([...observationIds]);
		for (const components of this.ctx.resetRenderedIrcInlineComponents()) {
			for (const component of components) this.ctx.chatContainer.removeChild(component);
		}
		this.#renderedIrcComponents.clear();
		for (const signature of this.#renderedCustomMessages) {
			if (signature.startsWith("irc:")) this.#renderedCustomMessages.delete(signature);
		}
	}

	reconcileIrcExpiryTimers(componentsByObservationId: Map<string, readonly Component[]>): void {
		this.clearIrcExpiryTimers();
		this.#renderedIrcComponents.clear();
		const now = Date.now();
		const inlineProjection = this.ctx.ircLedger.getInlineProjection(now);

		this.#cleanupEvictedIrcObservations();
		const projectedObservationIds = new Set(inlineProjection.map(record => record.observationId));
		for (const [observationId, components] of componentsByObservationId) {
			if (!projectedObservationIds.has(observationId)) {
				for (const component of components) {
					this.ctx.chatContainer.removeChild(component);
				}
				componentsByObservationId.delete(observationId);
			}
		}
		for (const record of inlineProjection) {
			const components = componentsByObservationId.get(record.observationId);
			if (!components) continue;
			this.#renderedIrcComponents.set(record.observationId, components);
			// #scheduleIrcExpiry owns the single expiry clock read: a record that
			// crossed its deadline while projection/reconciliation ran above is
			// cleaned up there (old timers were already cleared, so silently
			// skipping the timer would leave the row inline indefinitely).
			if (!this.#scheduleIrcExpiry(record, components)) {
				componentsByObservationId.delete(record.observationId);
			}
		}
	}

	/**
	 * Arms the removal timer for an ephemeral record using a single clock read.
	 * Returns false when the record's deadline has already elapsed — in that
	 * case the rendered components are removed from the chat container and
	 * {@link #renderedIrcComponents} here, and the caller must drop its own
	 * bookkeeping entry. Persistent records always return true (no timer).
	 */
	#scheduleIrcExpiry(record: IrcObservationRecord, components: readonly Component[]): boolean {
		if (record.mode !== "ephemeral" || components.length === 0 || this.#ircExpiryTimers.has(record.observationId)) {
			return true;
		}
		const remainingMs = record.expiresAt! - Date.now();
		if (remainingMs <= 0) {
			if (this.#cleanupExpiredIrcInlineComponents(record.observationId)) this.#observeVisibleTranscriptMutation();
			return false;
		}
		const timer = setTimeout(() => {
			this.#ircExpiryTimers.delete(record.observationId);
			if (this.#cleanupExpiredIrcInlineComponents(record.observationId)) this.#observeVisibleTranscriptMutation();
			this.ctx.ui.requestRender();
		}, remainingMs);
		timer.unref?.();
		this.#ircExpiryTimers.set(record.observationId, timer);
		return true;
	}

	async #handleSubagentSteerMessage(
		event: Extract<AgentSessionEvent, { type: "subagent_steer_message" }>,
	): Promise<void> {
		const details = event.message.details as
			| { observationId?: string; from?: string; to?: string; body?: string; state?: string }
			| undefined;
		const obsId = details?.observationId;
		const signature = obsId
			? `steer:${obsId}`
			: `${event.message.role}:${event.message.customType}:${event.message.timestamp}:${details?.from}:${details?.to}:${details?.state}:${details?.body}`;
		if (this.#renderedCustomMessages.has(signature)) return;
		this.#renderedCustomMessages.add(signature);
		this.#resetReadGroup();
		this.ctx.addMessageToChat(event.message);
		this.ctx.ui.requestRender();
		this.#recordVisibleTranscriptMutation();
	}

	async #handleModelFallbackSwitched(
		event: Extract<AgentSessionEvent, { type: "model_fallback_switched" }>,
	): Promise<void> {
		this.ctx.showStatus(`Fallback model: ${event.from} → ${event.to}`);
		this.ctx.statusLine.invalidate();
		this.ctx.ui.requestRender();
	}

	async #handleNotice(event: Extract<AgentSessionEvent, { type: "notice" }>): Promise<void> {
		const message = event.source ? `${event.source}: ${event.message}` : event.message;
		if (event.level === "error") {
			this.ctx.showError(message);
		} else if (event.level === "warning") {
			this.ctx.showWarning(message);
		} else {
			this.ctx.showStatus(message);
		}
	}

	async #handleMessageUpdate(event: Extract<AgentSessionEvent, { type: "message_update" }>): Promise<void> {
		if (this.ctx.streamingComponent && event.message.role === "assistant") {
			if (this.ctx.streamingMessage?.role === "assistant") {
				transferSessionMessageIdentity([this.ctx.streamingMessage], [event.message]);
			}
			this.ctx.streamingMessage = event.message;
			const contentIndex = event.assistantMessageEvent?.contentIndex;
			if (
				event.assistantMessageEvent?.type === "text_delta" &&
				typeof contentIndex === "number" &&
				Number.isInteger(contentIndex) &&
				contentIndex >= 0 &&
				contentIndex < event.message.content.length &&
				event.message.content[contentIndex]?.type === "text"
			) {
				this.#queueAssistantText(this.ctx.streamingComponent, event.message);
			} else {
				this.#cancelAssistantTextPresentation();
				this.ctx.streamingComponent.updateContent(this.ctx.streamingMessage, { streaming: true });
			}
			const changedContent =
				typeof contentIndex === "number" && contentIndex >= 0
					? this.ctx.streamingMessage.content[contentIndex]
					: undefined;
			const contentsToProcess = changedContent ? [changedContent] : this.ctx.streamingMessage.content;

			if (changedContent?.type === "thinking" && changedContent.thinking.trim()) {
				if (typeof contentIndex === "number") this.#thinkingContentIndices.add(contentIndex);
				const thinkingCount = this.#thinkingContentIndices.size;
				if (thinkingCount > this.#lastThinkingCount) {
					this.#resetReadGroup();
					this.#lastThinkingCount = thinkingCount;
				}
			} else if (!changedContent) {
				const thinkingCount = this.ctx.streamingMessage.content.filter(
					content => content.type === "thinking" && content.thinking.trim(),
				).length;
				if (thinkingCount > this.#lastThinkingCount) {
					this.#resetReadGroup();
					this.#lastThinkingCount = thinkingCount;
				}
			}

			for (const content of contentsToProcess) {
				if (__eventControllerPerfCounters.enabled) __eventControllerPerfCounters.messageUpdateContentVisits += 1;
				if (content.type !== "toolCall") continue;
				if (content.name === "read") {
					if (!readArgsHaveTarget(content.arguments)) continue;
					if (!readArgsTargetInternalUrl(content.arguments)) {
						this.#trackReadToolCall(content.id, content.arguments);
						const component = this.ctx.pendingTools.get(content.id);
						if (component) {
							component.updateArgs(content.arguments, content.id);
							this.#consumeToolVisibleChange(component);
						} else {
							const group = this.#getReadGroup();
							group.updateArgs(content.arguments, content.id);
							this.ctx.pendingTools.set(content.id, group);
							this.#recordVisibleTranscriptMutation();
							group.consumeVisibleTranscriptChange();
						}

						continue;
					}
				}

				const renderArgs = argsWithPartialJson(
					content.arguments,
					"partialJson" in content ? content.partialJson : undefined,
				);
				if (!this.ctx.pendingTools.has(content.id)) {
					this.#resetReadGroup();
					addChatChild(this.ctx, new Text("", 0, 0));
					const tool = this.ctx.session.getToolByName(content.name);
					const component = new ToolExecutionComponent(
						content.name,
						renderArgs,
						{
							showImages: settings.get("terminal.showImages"),
							editFuzzyThreshold: settings.get("edit.fuzzyThreshold"),
							editAllowFuzzy: settings.get("edit.fuzzyMatch"),
							hashlineAutoDropPureInsertDuplicates: settings.get("edit.hashlineAutoDropPureInsertDuplicates"),
							onVisibleTranscriptMutation: () => this.#observeVisibleTranscriptMutation(),
						},
						tool,
						this.ctx.ui,
						this.ctx.sessionManager.getCwd(),
						content.id,
					);
					component.setExpanded(this.ctx.toolOutputExpanded);
					this.ctx.pendingTools.set(content.id, component);
					addChatChild(this.ctx, component);
					this.#recordVisibleTranscriptMutation();
				} else {
					this.ctx.pendingTools.get(content.id)?.updateArgs(renderArgs, content.id);
					this.#consumeToolVisibleChange(this.ctx.pendingTools.get(content.id)!);
				}

				const args = content.arguments;
				if (!args || typeof args !== "object") continue;
				let intent: string | undefined;
				if (INTENT_FIELD in args) {
					intent = String(args[INTENT_FIELD]);
				} else {
					const cached = this.#toolIntentCache.get(content.id);
					if (cached?.args === args) intent = cached.intent;
					else {
						const tool = this.ctx.session.getToolByName(content.name);
						if (typeof tool?.intent === "function") {
							try {
								intent = tool.intent(args as never)?.trim();
							} catch {
								// intent function must never break the UI
							}
						}
						this.#toolIntentCache.set(content.id, { args, intent });
					}
				}
				if (intent) this.#updateWorkingMessageFromIntent(intent);
			}

			this.ctx.ui.requestRender();
		}
	}

	async #handleMessageEnd(event: Extract<AgentSessionEvent, { type: "message_end" }>): Promise<void> {
		if (event.message.role === "user") return;
		if (event.message.role === "assistant") this.#cancelAssistantTextPresentation();
		if (this.ctx.streamingComponent && event.message.role === "assistant") {
			if (this.ctx.streamingMessage?.role === "assistant") {
				transferSessionMessageIdentity([this.ctx.streamingMessage], [event.message]);
			}
			this.ctx.streamingMessage = event.message;
			let errorMessage: string | undefined;
			const aborted = this.ctx.streamingMessage.stopReason === "aborted";
			const silentlyAborted = aborted && isSilentAbort(this.ctx.streamingMessage.errorMessage);
			const ttsrSilenced = aborted && this.ctx.session.isTtsrAbortPending;
			if (aborted && !silentlyAborted && !ttsrSilenced) {
				// Real user-cancel / network / provider abort: surface the standard
				// operator-facing label. AgentSession.#handleAgentEvent already stamped
				// SILENT_ABORT_MARKER for the plan-compact transition before this
				// controller ran, so reaching this branch implies the abort was NOT a
				// silent internal transition.
				const retryAttempt = this.ctx.session.retryAttempt;
				errorMessage = buildAbortDisplayMessage({
					errorMessage: this.ctx.streamingMessage.errorMessage,
					retryAttempt,
				});
				this.ctx.streamingMessage.errorMessage = errorMessage;
			}
			if (silentlyAborted || ttsrSilenced) {
				// Silence the streaming render by downgrading stopReason to "stop" for
				// display only — does NOT mutate the persisted message's stopReason
				// (the marker on errorMessage drives replay-side suppression).
				const msgWithoutAbort = { ...this.ctx.streamingMessage, stopReason: "stop" as const };
				this.ctx.streamingComponent.updateContent(msgWithoutAbort, { streaming: false });
			} else {
				this.ctx.streamingComponent.updateContent(this.ctx.streamingMessage, { streaming: false });
			}

			if (this.ctx.streamingMessage.stopReason !== "aborted" && this.ctx.streamingMessage.stopReason !== "error") {
				for (const [toolCallId, component] of this.ctx.pendingTools.entries()) {
					component.setArgsComplete(toolCallId);
					this.#consumeToolVisibleChange(component);
				}
			}
			this.#lastAssistantComponent = this.ctx.streamingComponent;
			this.#lastAssistantComponent.setUsageInfo(event.message.usage);
			this.ctx.streamingComponent = undefined;
			this.ctx.streamingMessage = undefined;
			this.ctx.statusLine.invalidate();
			this.ctx.updateEditorTopBorder();
		}
		this.ctx.ui.requestRender();
	}

	async #handleToolExecutionStart(event: Extract<AgentSessionEvent, { type: "tool_execution_start" }>): Promise<void> {
		this.#updateWorkingMessageFromIntent(event.intent);
		if (!this.ctx.pendingTools.has(event.toolCallId)) {
			if (event.toolName === "read" && readArgsHaveTarget(event.args) && !readArgsTargetInternalUrl(event.args)) {
				this.#trackReadToolCall(event.toolCallId, event.args);
				const component = this.ctx.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateArgs(event.args, event.toolCallId);
				} else {
					const group = this.#getReadGroup();
					group.updateArgs(event.args, event.toolCallId);
					this.ctx.pendingTools.set(event.toolCallId, group);
				}
				this.ctx.ui.requestRender();
				this.#consumeToolVisibleChange(this.ctx.pendingTools.get(event.toolCallId)!);

				return;
			}

			this.#resetReadGroup();
			const tool = this.ctx.session.getToolByName(event.toolName);
			const component = new ToolExecutionComponent(
				event.toolName,
				event.args,
				{
					showImages: settings.get("terminal.showImages"),
					editFuzzyThreshold: settings.get("edit.fuzzyThreshold"),
					editAllowFuzzy: settings.get("edit.fuzzyMatch"),
					hashlineAutoDropPureInsertDuplicates: settings.get("edit.hashlineAutoDropPureInsertDuplicates"),
					onVisibleTranscriptMutation: () => this.#observeVisibleTranscriptMutation(),
				},
				tool,
				this.ctx.ui,
				this.ctx.sessionManager.getCwd(),
				event.toolCallId,
			);
			component.setExpanded(this.ctx.toolOutputExpanded);
			this.ctx.pendingTools.set(event.toolCallId, component);
			addChatChild(this.ctx, component);
			this.#recordVisibleTranscriptMutation();

			this.ctx.ui.requestRender();
		}
	}

	async #handleToolExecutionUpdate(
		event: Extract<AgentSessionEvent, { type: "tool_execution_update" }>,
	): Promise<void> {
		const component = this.ctx.pendingTools.get(event.toolCallId);
		if (component) {
			const asyncState = (event.partialResult.details as { async?: { state?: string } } | undefined)?.async?.state;
			const isFinalAsyncState = asyncState === "completed" || asyncState === "failed";
			component.updateResult(
				{ ...event.partialResult, isError: asyncState === "failed" },
				!isFinalAsyncState,
				event.toolCallId,
			);
			this.#consumeToolVisibleChange(component);

			if (isFinalAsyncState) {
				this.ctx.pendingTools.delete(event.toolCallId);
				this.#backgroundToolCallIds.delete(event.toolCallId);
			}
			this.ctx.ui.requestRender();
		}
	}

	async #handleToolExecutionEnd(event: Extract<AgentSessionEvent, { type: "tool_execution_end" }>): Promise<void> {
		if (event.toolName === "read") {
			if (this.#inlineReadToolImages(event.toolCallId, event.result)) {
				const component = this.ctx.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.result, isError: event.isError }, false, event.toolCallId);
					this.#consumeToolVisibleChange(component);

					this.ctx.pendingTools.delete(event.toolCallId);
				}
				const asyncState = (event.result.details as { async?: { state?: string } } | undefined)?.async?.state;
				if (asyncState === "running") {
					this.#backgroundToolCallIds.add(event.toolCallId);
				} else {
					this.#backgroundToolCallIds.delete(event.toolCallId);
					this.#clearReadToolCall(event.toolCallId);
				}
				this.ctx.ui.requestRender();
			} else {
				let component = this.ctx.pendingTools.get(event.toolCallId);
				if (!component) {
					const group = this.#getReadGroup();
					const args = this.#readToolCallArgs.get(event.toolCallId);
					if (args) {
						group.updateArgs(args, event.toolCallId);
					}
					component = group;
					this.ctx.pendingTools.set(event.toolCallId, group);
				}
				const asyncState = (event.result.details as { async?: { state?: string } } | undefined)?.async?.state;
				const isBackgroundRunning = asyncState === "running";
				component.updateResult({ ...event.result, isError: event.isError }, isBackgroundRunning, event.toolCallId);
				this.#consumeToolVisibleChange(component);

				if (isBackgroundRunning) {
					this.#backgroundToolCallIds.add(event.toolCallId);
				} else {
					this.ctx.pendingTools.delete(event.toolCallId);
					this.#backgroundToolCallIds.delete(event.toolCallId);
					this.#clearReadToolCall(event.toolCallId);
				}
				this.ctx.ui.requestRender();
			}
		} else {
			const component = this.ctx.pendingTools.get(event.toolCallId);
			if (component) {
				const asyncState = (event.result.details as { async?: { state?: string } } | undefined)?.async?.state;
				const isBackgroundRunning = asyncState === "running";
				component.updateResult({ ...event.result, isError: event.isError }, isBackgroundRunning, event.toolCallId);
				this.#consumeToolVisibleChange(component);

				if (isBackgroundRunning) {
					this.#backgroundToolCallIds.add(event.toolCallId);
				} else {
					this.ctx.pendingTools.delete(event.toolCallId);
					this.#backgroundToolCallIds.delete(event.toolCallId);
				}
				this.ctx.ui.requestRender();
			}
		}
		// Update todo display when todo_write tool completes
		if (event.toolName === "todo_write" && !event.isError) {
			const details = event.result.details as { phases?: TodoPhase[] } | undefined;
			if (details?.phases) {
				this.ctx.setTodos(details.phases);
			}
		} else if (event.toolName === "todo_write" && event.isError) {
			const textContent = event.result.content.find(
				(content: { type: string; text?: string }) => content.type === "text",
			)?.text;
			this.ctx.showWarning(
				`Todo update failed${textContent ? `: ${textContent}` : ". Progress may be stale until todo_write succeeds."}`,
			);
		}
		if (event.toolName === "resolve" && !event.isError) {
			const details = event.result.details as ResolveToolDetails | undefined;
			if (details?.sourceToolName === "plan_approval" && details.action === "apply") {
				const planDetails = details.sourceResultDetails as PlanApprovalDetails | undefined;
				if (planDetails) {
					await this.ctx.planModeController.handleApproval(planDetails);
					if (this.ctx.isStopped?.()) return;
				}
			}
		}
	}

	async #handleAgentEnd(event: Extract<AgentSessionEvent, { type: "agent_end" }>): Promise<void> {
		const orphanComponent = this.ctx.streamingComponent;
		const orphanMessage = this.ctx.streamingMessage?.role === "assistant" ? this.ctx.streamingMessage : undefined;
		if (orphanComponent && orphanMessage) {
			// An agent_end without message_end still owns the in-flight assistant.  Commit
			// its latest partial text as a historical component instead of removing it
			// before a frame can paint it.  A terminal payload, when present, is more
			// authoritative than the last delta but remains on the same live component.
			const authoritativeMessage = [...event.messages]
				.reverse()
				.find((message): message is AssistantMessage => message.role === "assistant");
			const finalMessage =
				authoritativeMessage ??
				(event.stopReason === "cancelled" ? { ...orphanMessage, stopReason: "aborted" as const } : orphanMessage);
			if (finalMessage !== orphanMessage) {
				transferSessionMessageIdentity([orphanMessage], [finalMessage]);
				this.ctx.streamingMessage = finalMessage;
			}
			this.#cancelAssistantTextPresentation();
			const aborted = finalMessage.stopReason === "aborted";
			const silentAbortPending =
				aborted && (this.ctx.session.isSilentAbortPending || this.ctx.session.isPlanCompactAbortPending);
			if (silentAbortPending && !isSilentAbort(finalMessage.errorMessage)) {
				finalMessage.errorMessage = SILENT_ABORT_MARKER;
			}
			const silentlyAborted = aborted && isSilentAbort(finalMessage.errorMessage);
			const ttsrSilenced = aborted && this.ctx.session.isTtsrAbortPending;
			if (aborted && !silentlyAborted && !ttsrSilenced) {
				finalMessage.errorMessage = buildAbortDisplayMessage({
					errorMessage: finalMessage.errorMessage,
					retryAttempt: this.ctx.session.retryAttempt,
				});
			}
			const displayMessage =
				silentlyAborted || ttsrSilenced ? { ...finalMessage, stopReason: "stop" as const } : finalMessage;
			orphanComponent.updateContent(displayMessage, { streaming: false });
			if (finalMessage.stopReason !== "aborted" && finalMessage.stopReason !== "error") {
				for (const [toolCallId, component] of this.ctx.pendingTools.entries()) {
					component.setArgsComplete(toolCallId);
					this.#consumeToolVisibleChange(component);
				}
			}
			this.#lastAssistantComponent = orphanComponent;
			orphanComponent.setUsageInfo(finalMessage.usage);
			this.ctx.streamingComponent = undefined;
			this.ctx.streamingMessage = undefined;
		} else {
			this.#flushAssistantText();
			this.#cancelAssistantTextPresentation();
			if (orphanComponent) {
				this.ctx.chatContainer.removeChild(orphanComponent);
				this.ctx.streamingComponent = undefined;
				this.ctx.streamingMessage = undefined;
			}
		}
		this.ctx.setWorkingMessage(undefined);
		stopInteractiveActivityIndicator(this.ctx, { foregroundSettled: true });
		await this.ctx.planModeController.flushPendingModelSwitch();
		if (this.ctx.isStopped?.()) return;
		for (const toolCallId of Array.from(this.ctx.pendingTools.keys())) {
			if (!this.#backgroundToolCallIds.has(toolCallId)) {
				this.ctx.pendingTools.delete(toolCallId);
			}
		}
		this.#backgroundToolCallIds = new Set(
			Array.from(this.#backgroundToolCallIds).filter(toolCallId => this.ctx.pendingTools.has(toolCallId)),
		);
		this.#readToolCallArgs.clear();
		this.#readToolCallAssistantComponents.clear();
		this.#lastAssistantComponent = undefined;
		this.ctx.updateEditorBorderColor();
		this.ctx.ui.requestRender();
		this.#scheduleIdleCompaction();
		emitHostStatus("finished");
		const lastAssistant = this.ctx.session.getLastAssistantMessage();
		if (
			event.stopReason !== "cancelled" &&
			event.stopReason !== "maintenance" &&
			isTextlessLengthStop(lastAssistant)
		) {
			this.ctx.showWarning(TEXTLESS_LENGTH_WARNING);
		}
		this.sendCompletionNotification();
		this.ctx.promptSuggestion?.onAgentEnd();
	}

	async #handleAutoCompactionStart(
		event: Extract<AgentSessionEvent, { type: "auto_compaction_start" }>,
	): Promise<void> {
		this.#cancelIdleCompaction();
		this.ctx.updateEditorBorderColor();
		this.ctx.autoCompactionEscapeHandler = this.ctx.editor.onEscape;
		this.ctx.editor.onEscape = () => {
			this.ctx.session.abortCompaction();
		};
		stopInteractiveActivityIndicator(this.ctx, { restoreBackground: false, foregroundSettled: true });
		const reasonText =
			event.reason === "overflow" ? "Context overflow detected, " : event.reason === "idle" ? "Idle " : "";
		const actionLabel = event.action === "handoff" ? "Auto-handoff" : "Auto context-full maintenance";
		this.ctx.autoCompactionLoader = new Loader(
			this.ctx.ui,
			spinner => theme.fg("accent", spinner),
			text => theme.fg("muted", text),
			`${reasonText}${actionLabel}… (esc to cancel)`,
			getSymbolTheme().spinnerFrames,
		);
		this.ctx.statusContainer.addChild(this.ctx.autoCompactionLoader);
		this.ctx.ui.requestRender();
	}

	async #handleAutoCompactionEnd(event: Extract<AgentSessionEvent, { type: "auto_compaction_end" }>): Promise<void> {
		this.#cancelIdleCompaction();
		if (this.ctx.autoCompactionEscapeHandler) {
			this.ctx.editor.onEscape = this.ctx.autoCompactionEscapeHandler;
			this.ctx.autoCompactionEscapeHandler = undefined;
		}
		if (this.ctx.autoCompactionLoader) {
			this.ctx.autoCompactionLoader.stop();
			this.ctx.autoCompactionLoader = undefined;
			this.ctx.statusContainer.clear();
		}
		this.ctx.updateEditorBorderColor();
		const isHandoffAction = event.action === "handoff";
		const continuationDisabled = event.continuationSkipReason === "auto_continue_disabled_non_resumable_tail";
		if (event.aborted) {
			this.ctx.showStatus(isHandoffAction ? "Auto-handoff cancelled" : "Auto context-full maintenance cancelled");
		} else if (event.result) {
			this.ctx.rebuildChatFromMessages("reconcile-same-transcript");
			this.ctx.statusLine.invalidate();
			this.ctx.updateEditorTopBorder();
			if (continuationDisabled && !isHandoffAction) {
				this.ctx.showStatus("Context overflow recovery skipped: auto_continue_disabled_non_resumable_tail");
			} else if (event.willRetry && !isHandoffAction) {
				this.ctx.showStatus("Context overflow maintenance completed");
			}
		} else if (
			event.skipped &&
			event.errorMessage?.startsWith("Context overflow recovery skipped: nothing eligible to compact.") &&
			!isHandoffAction
		) {
			this.ctx.showStatus(event.errorMessage);
		} else if (event.errorMessage) {
			this.ctx.showWarning(event.errorMessage);
		} else if (isHandoffAction) {
			// Reset BEFORE rebuild so the new session's transcript is not replayed
			// from the old ledger and then cleared out from under its timers.
			this.ctx.resetIrcSidebarSession();
			this.ctx.rebuildChatFromMessages("replace-identity");
			this.ctx.statusLine.invalidate();
			this.ctx.updateEditorTopBorder();
			await this.ctx.reloadTodos();
			if (this.ctx.isStopped?.()) return;
			this.ctx.showStatus("Auto-handoff completed");
		} else if (event.skipped) {
			// Benign skip: no model selected, no candidate models available, or nothing
			// to compact yet. Not a failure — suppress the warning.
			if (continuationDisabled) {
				this.ctx.showStatus("Context overflow recovery skipped: auto_continue_disabled_non_resumable_tail");
			} else if (event.willRetry && !isHandoffAction) {
				this.ctx.showStatus("Context overflow maintenance skipped");
			}
		} else {
			this.ctx.showWarning("Auto context-full maintenance failed; continuing without maintenance");
		}
		await this.ctx.flushCompactionQueue({ willRetry: event.willRetry });
		if (this.ctx.isStopped?.()) return;
		syncInteractiveActivityIndicator(this.ctx);
		this.ctx.ui.requestRender();
	}

	#clearRetryCountdown(): void {
		if (this.ctx.retryCountdownTimer) {
			clearInterval(this.ctx.retryCountdownTimer);
			this.ctx.retryCountdownTimer = undefined;
		}
	}

	async #handleAutoRetryStart(event: Extract<AgentSessionEvent, { type: "auto_retry_start" }>): Promise<void> {
		// Preserve the ORIGINAL editor Escape handler across repeated retry
		// starts: auto_retry_end only fires at final success/failure, so a
		// second auto_retry_start must not snapshot the prior retry handler.
		if (!this.ctx.retryEscapeHandler) {
			this.ctx.retryEscapeHandler = this.ctx.editor.onEscape;
		}
		this.ctx.retryEscapePrimed = false;
		let escPressed = false;
		this.ctx.editor.onEscape = () => {
			if (!escPressed) {
				// First Esc: skip the backoff and retry immediately.
				escPressed = true;
				this.ctx.session.retryNow();
			} else {
				// Second Esc: cancel the retry entirely.
				this.ctx.session.abortRetry();
			}
		};
		stopInteractiveActivityIndicator(this.ctx, { restoreBackground: false, foregroundSettled: true });
		// Stop any prior retry loader/timer before installing a new one.
		this.ctx.retryLoader?.stop();
		this.#clearRetryCountdown();
		const reason = friendlyRetryReason(event.errorMessage);
		const attemptLabel = event.unbounded ? `attempt ${event.attempt}` : `${event.attempt}/${event.maxAttempts}`;
		const reasonSuffix = reason ? ` — ${reason}` : "";
		const deadline = Date.now() + event.delayMs;
		const buildMessage = () => {
			const remainingSeconds = Math.max(0, Math.round((deadline - Date.now()) / 1000));
			// First Esc retries immediately; a second Esc cancels.
			return `Retrying (${attemptLabel})${reasonSuffix}, next in ${remainingSeconds}s… (esc to retry now)`;
		};
		const retryLoader = new Loader(
			this.ctx.ui,
			spinner => theme.fg("warning", spinner),
			text => theme.fg("muted", text),
			buildMessage(),
			getSymbolTheme().spinnerFrames,
		);
		this.ctx.retryLoader = retryLoader;
		this.ctx.retryCountdownTimer = setInterval(() => {
			retryLoader.setMessage(buildMessage());
		}, 1000);
		this.ctx.statusContainer.addChild(retryLoader);
		this.ctx.ui.requestRender();
	}

	async #handleAutoRetryEnd(event: Extract<AgentSessionEvent, { type: "auto_retry_end" }>): Promise<void> {
		if (this.ctx.retryEscapeHandler) {
			this.ctx.editor.onEscape = this.ctx.retryEscapeHandler;
			this.ctx.retryEscapeHandler = undefined;
		}
		if (this.ctx.retryLoader) {
			this.ctx.retryLoader.stop();
			this.#clearRetryCountdown();
			this.ctx.retryLoader = undefined;
			this.ctx.statusContainer.clear();
		}
		this.ctx.retryEscapePrimed = false;
		if (!event.success) {
			this.ctx.showError(`Retry failed after ${event.attempt} attempts: ${event.finalError || "Unknown error"}`);
		}
		syncInteractiveActivityIndicator(this.ctx);
		this.ctx.ui.requestRender();
	}

	async #handleTtsrTriggered(event: Extract<AgentSessionEvent, { type: "ttsr_triggered" }>): Promise<void> {
		const component = new TtsrNotificationComponent(event.rules);
		component.setExpanded(this.ctx.toolOutputExpanded);
		addChatChild(this.ctx, component);
		this.#recordVisibleTranscriptMutation();

		this.ctx.ui.requestRender();
	}

	async #handleTodoReminder(event: Extract<AgentSessionEvent, { type: "todo_reminder" }>): Promise<void> {
		const component = new TodoReminderComponent(event.todos, event.attempt, event.maxAttempts);
		addChatChild(this.ctx, component);
		this.#recordVisibleTranscriptMutation();
		this.ctx.ui.requestRender();
	}

	async #handleTodoAutoClear(_event: Extract<AgentSessionEvent, { type: "todo_auto_clear" }>): Promise<void> {
		await this.ctx.reloadTodos();
	}

	#cancelIdleCompaction(): void {
		if (this.#idleCompactionTimer) {
			clearTimeout(this.#idleCompactionTimer);
			this.#idleCompactionTimer = undefined;
		}
	}

	#scheduleIdleCompaction(): void {
		this.#cancelIdleCompaction();
		// Don't schedule idle work while context maintenance is already running; the
		// maintenance flow may reset the session before this timer fires.
		if (this.ctx.session.isCompacting) return;

		const idleSettings = settings.getGroup("compaction");
		if (!idleSettings.idleEnabled) return;

		// Only if input is empty
		if (this.ctx.editor.getText().trim()) return;

		const threshold = idleSettings.idleThresholdTokens;
		if (threshold <= 0) return;
		if (this.#currentContextTokens() < threshold) return;

		const timeoutMs = Math.max(60, Math.min(3600, idleSettings.idleTimeoutSeconds)) * 1000;
		this.#idleCompactionTimer = setTimeout(() => {
			this.#idleCompactionTimer = undefined;
			// Re-check conditions before firing. Pruning may have run between arming
			// the timer and now, dropping usage back below the idle threshold.
			if (this.ctx.session.isStreaming) return;
			if (this.ctx.session.isCompacting) return;
			if (this.ctx.editor.getText().trim()) return;
			if (this.#currentContextTokens() < threshold) return;
			void this.ctx.session.runIdleCompaction();
		}, timeoutMs);
		this.#idleCompactionTimer.unref?.();
	}

	#currentContextTokens(): number {
		const lastAssistant = this.ctx.session.agent.state.messages
			.slice()
			.reverse()
			.find((m): m is AssistantMessage => m.role === "assistant" && m.stopReason !== "aborted");
		return lastAssistant?.usage ? calculatePromptTokens(lastAssistant.usage) : 0;
	}

	#runCompletionNotifyCommand(payload: CompletionNotifyPayload): void {
		const command = settings.getGlobal("completion.notifyCommand")?.trim();
		if (!command) return;

		try {
			const proc = Bun.spawn(completionNotifyShellCommand(command), {
				cwd: payload.cwd,
				env: {
					...process.env,
					...buildCompletionNotifyEnv(payload),
				},
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			});
			proc.unref();
			const timer = setTimeout(() => {
				try {
					proc.kill();
				} catch {}
			}, COMPLETION_NOTIFY_COMMAND_TIMEOUT_MS);
			timer.unref?.();
			void proc.exited
				.then(exitCode => {
					clearTimeout(timer);
					if (exitCode !== 0) {
						logger.warn("completion notify command exited non-zero", { exitCode });
					}
				})
				.catch(error => {
					clearTimeout(timer);
					logger.warn("completion notify command failed", { error: String(error) });
				});
		} catch (error) {
			logger.warn("completion notify command failed to start", { error: String(error) });
		}
	}

	sendCompletionNotification(): void {
		// Per-run hard opt-out (env, config-untouched, child-inheritable): GJC_NOTIFY=off.
		if (completionNotifyDisabledByEnv(process.env)) return;
		const isBackgrounded = this.ctx.isBackgrounded !== false;
		const notify = settings.get("completion.notify");
		if (notify === "off") return;

		// Skip when the turn was aborted (e.g. ask cancelled with Ctrl+C) or
		// errored — those are not "Task complete" events. Mirrors the gate
		// already used by #currentContextTokens, #handleMessageEnd, and the
		// retry / TTSR / compaction skip paths across agent-session.ts.
		const last = this.ctx.session.getLastAssistantMessage();
		if (last?.stopReason === "aborted" || last?.stopReason === "error") return;

		const sessionName = this.ctx.sessionManager.getSessionName();
		const textlessLengthStop = isTextlessLengthStop(last);
		const title = textlessLengthStop
			? sessionName
				? `${sessionName}: Output limit reached`
				: "Output limit reached"
			: sessionName
				? `${sessionName}: Complete`
				: "Complete";
		const summary = summaryFromMessage(last, 1000);
		const body = textlessLengthStop ? TEXTLESS_LENGTH_WARNING : (summary ?? "Complete");
		const sessionManager = this.ctx.sessionManager as { getCwd?: () => string; getSessionId?: () => string };
		const payload: CompletionNotifyPayload = {
			type: "agent-turn-complete",
			title,
			body,
			cwd: sessionManager.getCwd?.() ?? settings.getCwd(),
			sessionId: sessionManager.getSessionId?.(),
			sessionName: sessionName || undefined,
			lastAssistantMessage: summary,
			stopReason: last?.stopReason,
		};
		ringTerminalBell("complete");
		if (isBackgrounded) TERMINAL.sendNotification(title);
		this.#runCompletionNotifyCommand(payload);
	}

	async handleBackgroundEvent(event: AgentSessionEvent): Promise<void> {
		if (event.type !== "agent_end") {
			return;
		}
		if (this.ctx.session.queuedMessageCount > 0 || this.ctx.session.isStreaming) {
			return;
		}
		this.sendCompletionNotification();
		await this.ctx.shutdown();
	}
}
