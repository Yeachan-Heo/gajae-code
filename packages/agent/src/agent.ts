/** Agent class that uses the agent-loop directly.
 * No transport abstraction - calls streamSimple via the loop.
 */
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type CursorExecHandlers,
	type CursorToolResultHandler,
	type Effort,
	getBundledModel,
	type ImageContent,
	type Message,
	type Model,
	type ProviderSessionState,
	type ServiceTier,
	type SimpleStreamOptions,
	streamSimple,
	type TextContent,
	type ThinkingBudgets,
	type ToolChoice,
	type ToolResultMessage,
} from "@gajae-code/ai";
import { agentLoop, agentLoopContinue } from "./agent-loop";
import type { AppendOnlyContextManager } from "./append-only-context";
import type { HarmonyAuditEvent } from "./harmony-leak";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentState,
	AgentTool,
	AgentToolContext,
	StreamFn,
	ToolCallContext,
} from "./types";

/**
 * Default convertToLlm: Keep only LLM-compatible messages, convert attachments.
 */
function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
	return messages.filter((m): m is Message => m.role === "user" || m.role === "assistant" || m.role === "toolResult");
}

function refreshToolChoiceForActiveTools(
	toolChoice: ToolChoice | undefined,
	tools: AgentContext["tools"] = [],
): ToolChoice | undefined {
	if (!toolChoice || typeof toolChoice === "string") {
		return toolChoice;
	}

	const toolName =
		toolChoice.type === "tool"
			? toolChoice.name
			: "function" in toolChoice
				? toolChoice.function.name
				: toolChoice.name;

	return tools.some(tool => tool.name === toolName) ? toolChoice : undefined;
}

export class AgentBusyError extends Error {
	constructor(
		message: string = "Agent is already processing. Use steer() or followUp() to queue messages, or wait for completion.",
	) {
		super(message);
		this.name = "AgentBusyError";
	}
}
export interface AgentOptions {
	initialState?: Partial<AgentState>;

	/**
	 * Converts AgentMessage[] to LLM-compatible Message[] before each LLM call.
	 * Default filters to user/assistant/toolResult and converts attachments.
	 */
	convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;

	/**
	 * Optional transform applied to context before convertToLlm.
	 * Use for context pruning, injecting external context, etc.
	 */
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;

	/**
	 * Steering mode: "all" = send all steering messages at once, "one-at-a-time" = one per turn
	 */
	steeringMode?: "all" | "one-at-a-time";

	/**
	 * Follow-up mode: "all" = send all follow-up messages at once, "one-at-a-time" = one per turn
	 */
	followUpMode?: "all" | "one-at-a-time";

	/**
	 * When to interrupt tool execution for steering messages.
	 * - "immediate": check after each tool call (default)
	 * - "wait": defer steering until the current turn completes
	 */
	interruptMode?: "immediate" | "wait";

	/**
	 * API format for Kimi Code provider: "openai" or "anthropic" (default: "anthropic")
	 */
	kimiApiFormat?: "openai" | "anthropic";

	/** Hint that websocket transport should be preferred when supported by the provider implementation. */
	preferWebsockets?: boolean;

	/**
	 * Custom stream function (for proxy backends, etc.). Default uses streamSimple.
	 */
	streamFn?: StreamFn;

	/**
	 * Optional session identifier forwarded to LLM providers.
	 * Used by providers that support session-based caching (e.g., OpenAI code provider).
	 */
	sessionId?: string;
	/** Provider-facing cache/session affinity identifier. */
	providerSessionId?: string;
	/**
	 * Shared provider state map for session-scoped transport/session caches.
	 */
	providerSessionState?: Map<string, ProviderSessionState>;

	/**
	 * Resolves an API key dynamically for each LLM call.
	 * Useful for expiring tokens (e.g., GitHub Copilot OAuth).
	 */
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	getAuthCredentialType?: (provider: string) => "api_key" | "oauth" | undefined;

	/**
	 * Inspect or replace provider payloads before they are sent.
	 */
	onPayload?: SimpleStreamOptions["onPayload"];
	/**
	 * Inspect provider response metadata after headers arrive and before streaming body consumption.
	 */
	onResponse?: SimpleStreamOptions["onResponse"];
	/**
	 * Inspect raw Server-Sent Events from HTTP streaming providers.
	 */
	onSseEvent?: SimpleStreamOptions["onSseEvent"];
	/**
	 * Inspect assistant streaming events before they are emitted to subscribers.
	 * Use this when abort decisions must happen before buffered events continue flowing.
	 */
	onAssistantMessageEvent?: (message: AssistantMessage, event: AssistantMessageEvent) => void;

	/**
	 * Called when GPT-5 Harmony protocol leakage is detected and mitigated.
	 */
	onHarmonyLeak?: (event: HarmonyAuditEvent) => void | Promise<void>;
	/**
	 * Custom token budgets for thinking levels (token-based providers only).
	 */
	thinkingBudgets?: ThinkingBudgets;

	/**
	 * Sampling temperature for LLM calls. `undefined` uses provider default.
	 */
	temperature?: number;

	/** Additional sampling controls for providers that support them. */
	topP?: number;
	topK?: number;
	minP?: number;
	presencePenalty?: number;
	repetitionPenalty?: number;
	serviceTier?: ServiceTier;
	/**
	 * If true, request that the underlying provider omit reasoning/thinking summaries
	 * from the response. The model still reasons internally; only the human-readable
	 * summary stream is suppressed. Useful when the UI hides thinking blocks anyway.
	 */
	hideThinkingSummary?: boolean;

	/**
	 * Maximum delay in milliseconds to wait for a retry when the server requests a long wait.
	 * If the server's requested delay exceeds this value, the request fails immediately,
	 * allowing higher-level retry logic to handle it with user visibility.
	 * Default: 60000 (60 seconds). Set to 0 to disable the cap.
	 */
	maxRetryDelayMs?: number;

	/**
	 * Provides tool execution context, resolved per tool call.
	 * Use for late-bound UI or session state access.
	 */
	getToolContext?: (toolCall?: ToolCallContext) => AgentToolContext | undefined;

	/**
	 * Optional transform applied to tool call arguments before execution.
	 * Use for deobfuscating secrets or rewriting arguments.
	 */
	transformToolCallArguments?: (args: Record<string, unknown>, toolName: string) => Record<string, unknown>;

	/** Enable intent tracing schema injection/stripping in the harness. */
	intentTracing?: boolean;
	/** Dynamic tool choice override, resolved per LLM call. */
	getToolChoice?: () => ToolChoice | undefined;

	/**
	 * Cursor exec handlers for local tool execution.
	 */
	cursorExecHandlers?: CursorExecHandlers;

	/**
	 * Cursor tool result callback for exec tool responses.
	 */
	cursorOnToolResult?: CursorToolResultHandler;

	/**
	 * Called after a tool call has been validated and is about to execute.
	 * See {@link AgentLoopConfig.beforeToolCall} for full semantics.
	 */
	beforeToolCall?: AgentLoopConfig["beforeToolCall"];

	/**
	 * Called after a tool finishes executing, before `tool_execution_end` and the tool-result
	 * message are emitted. See {@link AgentLoopConfig.afterToolCall} for full semantics.
	 */
	afterToolCall?: AgentLoopConfig["afterToolCall"];

	/**
	 * Opt-in OpenTelemetry instrumentation. Passing `{}` enables the loop's
	 * GenAI-semantic-convention spans using the global tracer provider. See
	 * {@link AgentLoopConfig.telemetry} for the full surface.
	 */
	telemetry?: AgentLoopConfig["telemetry"];
	/**
	 * Immutable context mode — stabilizes system prompt + tool spec bytes
	 * across turns so DeepSeek/Anthropic prefix caches hit at maximum rate.
	 */
	appendOnlyContext?: AppendOnlyContextManager;
}

export interface AgentPromptOptions {
	toolChoice?: ToolChoice;
}

/** Buffered Cursor tool result with text position at time of call */
interface CursorToolResultEntry {
	toolResult: ToolResultMessage;
	textLengthAtCall: number;
}

export class Agent {
	#state: AgentState = {
		systemPrompt: [],
		model: getBundledModel("google", "gemini-2.5-flash-lite-preview-06-17"),
		thinkingLevel: undefined,
		tools: [],
		messages: [],
		isStreaming: false,
		streamMessage: null,
		pendingToolCalls: new Set<string>(),
		error: undefined,
	};

	#listeners = new Set<(e: AgentEvent) => void>();
	#abortController?: AbortController;
	#convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	#transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
	#steeringQueue: AgentMessage[] = [];
	#followUpQueue: AgentMessage[] = [];
	#steeringMode: "all" | "one-at-a-time";
	#followUpMode: "all" | "one-at-a-time";
	#interruptMode: "immediate" | "wait";
	#sessionId?: string;
	#providerSessionId?: string;
	#metadata?: Record<string, unknown>;
	#metadataResolver?: (provider: string) => Record<string, unknown> | undefined;
	#providerSessionState?: Map<string, ProviderSessionState>;
	#thinkingBudgets?: ThinkingBudgets;
	#temperature?: number;
	#topP?: number;
	#topK?: number;
	#minP?: number;
	#presencePenalty?: number;
	#repetitionPenalty?: number;
	#serviceTier?: ServiceTier;
	#hideThinkingSummary?: boolean;
	#maxRetryDelayMs?: number;
	#getToolContext?: (toolCall?: ToolCallContext) => AgentToolContext | undefined;
	#cursorExecHandlers?: CursorExecHandlers;
	#cursorOnToolResult?: CursorToolResultHandler;
	#runningPrompt?: Promise<void>;
	#resolveRunningPrompt?: () => void;
	#runSequence = 0;
	#activeRunId?: number;
	#kimiApiFormat?: "openai" | "anthropic";
	#preferWebsockets?: boolean;
	#transformToolCallArguments?: (args: Record<string, unknown>, toolName: string) => Record<string, unknown>;
	#intentTracing: boolean;
	#getToolChoice?: () => ToolChoice | undefined;
	#onPayload?: SimpleStreamOptions["onPayload"];
	#onResponse?: SimpleStreamOptions["onResponse"];
	#onSseEvent?: SimpleStreamOptions["onSseEvent"];
	#onAssistantMessageEvent?: (message: AssistantMessage, event: AssistantMessageEvent) => void;
	#onHarmonyLeak?: (event: HarmonyAuditEvent) => void | Promise<void>;
	#onBeforeYield?: () => Promise<void> | void;
	#telemetry?: AgentLoopConfig["telemetry"];
	#appendOnlyContext?: AppendOnlyContextManager;

	/** Buffered Cursor tool results with text length at time of call (for correct ordering) */
	#cursorToolResultBuffer: CursorToolResultEntry[] = [];

	streamFn: StreamFn;
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	getAuthCredentialType?: (provider: string) => "api_key" | "oauth" | undefined;
	/**
	 * Hook invoked after tool arguments are validated and before execution.
	 * Reassign at any time to swap the implementation (e.g. on extension reload).
	 */
	beforeToolCall?: AgentLoopConfig["beforeToolCall"];
	/**
	 * Hook invoked after tool execution and before `tool_execution_end` / tool-result
	 * message emission. Reassign at any time to swap the implementation.
	 */
	afterToolCall?: AgentLoopConfig["afterToolCall"];

	constructor(opts: AgentOptions = {}) {
		this.#state = { ...this.#state, ...opts.initialState };
		this.#convertToLlm = opts.convertToLlm || defaultConvertToLlm;
		this.#transformContext = opts.transformContext;
		this.#steeringMode = opts.steeringMode || "one-at-a-time";
		this.#followUpMode = opts.followUpMode || "one-at-a-time";
		this.#interruptMode = opts.interruptMode || "immediate";
		this.streamFn = opts.streamFn || streamSimple;
		this.#sessionId = opts.sessionId;
		this.#providerSessionId = opts.providerSessionId;
		this.#providerSessionState = opts.providerSessionState;
		this.#thinkingBudgets = opts.thinkingBudgets;
		this.#temperature = opts.temperature;
		this.#topP = opts.topP;
		this.#topK = opts.topK;
		this.#minP = opts.minP;
		this.#presencePenalty = opts.presencePenalty;
		this.#repetitionPenalty = opts.repetitionPenalty;
		this.#serviceTier = opts.serviceTier;
		this.#hideThinkingSummary = opts.hideThinkingSummary;
		this.#maxRetryDelayMs = opts.maxRetryDelayMs;
		this.getApiKey = opts.getApiKey;
		this.getAuthCredentialType = opts.getAuthCredentialType;
		this.#onPayload = opts.onPayload;
		this.#onResponse = opts.onResponse;
		this.#onSseEvent = opts.onSseEvent;
		this.#getToolContext = opts.getToolContext;
		this.#cursorExecHandlers = opts.cursorExecHandlers;
		this.#cursorOnToolResult = opts.cursorOnToolResult;
		this.#kimiApiFormat = opts.kimiApiFormat;
		this.#preferWebsockets = opts.preferWebsockets;
		this.#transformToolCallArguments = opts.transformToolCallArguments;
		this.#intentTracing = opts.intentTracing === true;
		this.#getToolChoice = opts.getToolChoice;
		this.#onAssistantMessageEvent = opts.onAssistantMessageEvent;
		this.#onHarmonyLeak = opts.onHarmonyLeak;
		this.beforeToolCall = opts.beforeToolCall;
		this.afterToolCall = opts.afterToolCall;
		this.#telemetry = opts.telemetry;
		this.#appendOnlyContext = opts.appendOnlyContext;
	}

	/**
	 * Get the current session ID used for provider caching.
	 */
	get sessionId(): string | undefined {
		return this.#sessionId;
	}

	/**
	 * Set the session ID for provider caching.
	 * Call this when switching sessions (new session, branch, resume).
	 */
	set sessionId(value: string | undefined) {
		this.#sessionId = value;
	}

	get providerSessionId(): string | undefined {
		return this.#providerSessionId;
	}

	set providerSessionId(value: string | undefined) {
		this.#providerSessionId = value;
	}

	/**
	 * Static metadata forwarded to every API request when no resolver is installed
	 * (e.g. `metadata.user_id` for Anthropic session attribution). Setting this
	 * clears any installed resolver.
	 *
	 * For live/provider-aware metadata (e.g. Anthropic OAuth `account_uuid` that
	 * must reflect the credential selected per-request), use
	 * {@link setMetadataResolver} and read via {@link metadataForProvider}.
	 */
	get metadata(): Record<string, unknown> | undefined {
		return this.#metadata;
	}

	set metadata(value: Record<string, unknown> | undefined) {
		this.#metadata = value;
		this.#metadataResolver = undefined;
	}

	/**
	 * Resolve request metadata for the given provider at call time. When a
	 * resolver is installed via {@link setMetadataResolver}, it is invoked with
	 * the provider string so the result can be scoped (e.g. `account_uuid` is
	 * only included for `"anthropic"` requests). Falls back to the static
	 * {@link metadata} value when no resolver is set.
	 */
	metadataForProvider(provider: string): Record<string, unknown> | undefined {
		if (this.#metadataResolver) return this.#metadataResolver(provider);
		return this.#metadata;
	}

	/**
	 * Install a function that resolves request metadata at call time. The
	 * resolver receives the target provider string and can gate provider-specific
	 * fields (e.g. `account_uuid` only for `"anthropic"`). Invoked per LLM
	 * request by `agent-loop` after `getApiKey` selects the session-sticky
	 * credential. Pass `undefined` to clear and revert to the static
	 * {@link metadata} value.
	 */
	setMetadataResolver(resolver: ((provider: string) => Record<string, unknown> | undefined) | undefined): void {
		this.#metadataResolver = resolver;
	}

	/**
	 * Read the active OpenTelemetry configuration. Returns `undefined` when
	 * instrumentation is disabled. Callers spawning child runs (e.g. subagent
	 * dispatch) forward this to the child's loop so its spans appear under the
	 * parent's active context with the subagent's own identity stamped.
	 */
	get telemetry(): AgentLoopConfig["telemetry"] | undefined {
		return this.#telemetry;
	}

	/**
	 * Replace the active OpenTelemetry configuration. Pass `undefined` to
	 * disable instrumentation. Applies to the *next* `agentLoop` invocation —
	 * in-flight loops keep the configuration they started with.
	 */
	setTelemetry(telemetry: AgentLoopConfig["telemetry"] | undefined): void {
		this.#telemetry = telemetry;
	}

	/**
	 * Get provider-scoped mutable session state store.
	 */
	get providerSessionState(): Map<string, ProviderSessionState> | undefined {
		return this.#providerSessionState;
	}

	/**
	 * Set provider-scoped mutable session state store.
	 */
	set providerSessionState(value: Map<string, ProviderSessionState> | undefined) {
		this.#providerSessionState = value;
	}

	/**
	 * Get the current thinking budgets.
	 */
	get thinkingBudgets(): ThinkingBudgets | undefined {
		return this.#thinkingBudgets;
	}

	/**
	 * Set custom thinking budgets for token-based providers.
	 */
	set thinkingBudgets(value: ThinkingBudgets | undefined) {
		this.#thinkingBudgets = value;
	}

	/**
	 * Get the current sampling temperature.
	 */
	get temperature(): number | undefined {
		return this.#temperature;
	}

	/**
	 * Set sampling temperature for LLM calls. `undefined` uses provider default.
	 */
	set temperature(value: number | undefined) {
		this.#temperature = value;
	}

	get topP(): number | undefined {
		return this.#topP;
	}

	set topP(value: number | undefined) {
		this.#topP = value;
	}

	get topK(): number | undefined {
		return this.#topK;
	}

	set topK(value: number | undefined) {
		this.#topK = value;
	}

	get minP(): number | undefined {
		return this.#minP;
	}

	set minP(value: number | undefined) {
		this.#minP = value;
	}

	get presencePenalty(): number | undefined {
		return this.#presencePenalty;
	}

	set presencePenalty(value: number | undefined) {
		this.#presencePenalty = value;
	}

	get repetitionPenalty(): number | undefined {
		return this.#repetitionPenalty;
	}

	set repetitionPenalty(value: number | undefined) {
		this.#repetitionPenalty = value;
	}

	get serviceTier(): ServiceTier | undefined {
		return this.#serviceTier;
	}

	set serviceTier(value: ServiceTier | undefined) {
		this.#serviceTier = value;
	}

	get hideThinkingSummary(): boolean | undefined {
		return this.#hideThinkingSummary;
	}

	set hideThinkingSummary(value: boolean | undefined) {
		this.#hideThinkingSummary = value;
	}

	/**
	 * Get the current max retry delay in milliseconds.
	 */
	get maxRetryDelayMs(): number | undefined {
		return this.#maxRetryDelayMs;
	}

	/**
	 * Set the maximum delay to wait for server-requested retries.
	 * Set to 0 to disable the cap.
	 */
	set maxRetryDelayMs(value: number | undefined) {
		this.#maxRetryDelayMs = value;
	}

	get state(): AgentState {
		return this.#state;
	}

	get appendOnlyContext(): AppendOnlyContextManager | undefined {
		return this.#appendOnlyContext;
	}

	setAppendOnlyContext(manager?: AppendOnlyContextManager): void {
		this.#appendOnlyContext = manager;
	}

	subscribe(fn: (e: AgentEvent) => void): () => void {
		this.#listeners.add(fn);
		return () => this.#listeners.delete(fn);
	}

	setProviderResponseInterceptor(fn: SimpleStreamOptions["onResponse"] | undefined): void {
		this.#onResponse = fn;
	}

	setRawSseEventInterceptor(fn: SimpleStreamOptions["onSseEvent"] | undefined): void {
		this.#onSseEvent = fn;
	}

	setAssistantMessageEventInterceptor(
		fn: ((message: AssistantMessage, event: AssistantMessageEvent) => void) | undefined,
	): void {
		this.#onAssistantMessageEvent = fn;
	}

	setOnBeforeYield(fn: (() => Promise<void> | void) | undefined): void {
		this.#onBeforeYield = fn;
	}

	emitExternalEvent(event: AgentEvent) {
		switch (event.type) {
			case "message_start":
			case "message_update":
				this.#state.streamMessage = event.message;
				break;
			case "message_end":
				this.#state.streamMessage = null;
				this.appendMessage(event.message);
				break;
			case "tool_execution_start": {
				const pending = new Set(this.#state.pendingToolCalls);
				pending.add(event.toolCallId);
				this.#state.pendingToolCalls = pending;
				break;
			}
			case "tool_execution_end": {
				const pending = new Set(this.#state.pendingToolCalls);
				pending.delete(event.toolCallId);
				this.#state.pendingToolCalls = pending;
				break;
			}
		}

		this.#emit(event);
	}

	createExternalEventEmitterForCurrentRun(): ((event: AgentEvent) => void) | undefined {
		const runId = this.#activeRunId;
		if (runId === undefined) return undefined;
		return (event: AgentEvent) => {
			if (this.#activeRunId !== runId) return;
			this.emitExternalEvent(event);
		};
	}

	#assertActiveRun(runId: number): void {
		if (this.#activeRunId !== runId) {
			throw new Error("Ignoring Cursor exec callback from an inactive agent run.");
		}
	}

	#cursorExecHandlersForRun(runId: number): CursorExecHandlers | undefined {
		const source = this.#cursorExecHandlers;
		if (!source) return undefined;

		const guarded: CursorExecHandlers = {};
		const read = source.read;
		if (read) {
			guarded.read = async args => {
				this.#assertActiveRun(runId);
				const result = await read(args);
				this.#assertActiveRun(runId);
				return result;
			};
		}
		const ls = source.ls;
		if (ls) {
			guarded.ls = async args => {
				this.#assertActiveRun(runId);
				const result = await ls(args);
				this.#assertActiveRun(runId);
				return result;
			};
		}
		const grep = source.grep;
		if (grep) {
			guarded.grep = async args => {
				this.#assertActiveRun(runId);
				const result = await grep(args);
				this.#assertActiveRun(runId);
				return result;
			};
		}
		const write = source.write;
		if (write) {
			guarded.write = async args => {
				this.#assertActiveRun(runId);
				const result = await write(args);
				this.#assertActiveRun(runId);
				return result;
			};
		}
		const deleteHandler = source.delete;
		if (deleteHandler) {
			guarded.delete = async args => {
				this.#assertActiveRun(runId);
				const result = await deleteHandler(args);
				this.#assertActiveRun(runId);
				return result;
			};
		}
		const shell = source.shell;
		if (shell) {
			guarded.shell = async args => {
				this.#assertActiveRun(runId);
				const result = await shell(args);
				this.#assertActiveRun(runId);
				return result;
			};
		}
		const shellStream = source.shellStream;
		if (shellStream) {
			guarded.shellStream = async (args, callbacks) => {
				this.#assertActiveRun(runId);
				const result = await shellStream(args, callbacks);
				this.#assertActiveRun(runId);
				return result;
			};
		}
		const diagnostics = source.diagnostics;
		if (diagnostics) {
			guarded.diagnostics = async args => {
				this.#assertActiveRun(runId);
				const result = await diagnostics(args);
				this.#assertActiveRun(runId);
				return result;
			};
		}
		const mcp = source.mcp;
		if (mcp) {
			guarded.mcp = async call => {
				this.#assertActiveRun(runId);
				const result = await mcp(call);
				this.#assertActiveRun(runId);
				return result;
			};
		}
		const onToolResult = source.onToolResult;
		if (onToolResult) {
			guarded.onToolResult = async message => {
				this.#assertActiveRun(runId);
				const result = await onToolResult(message);
				this.#assertActiveRun(runId);
				return result;
			};
		}
		return guarded;
	}

	// State mutators
	setSystemPrompt(v: string[]) {
		this.#state.systemPrompt = v;
	}

	setModel(m: Model) {
		this.#state.model = m;
	}

	setThinkingLevel(l: Effort | undefined) {
		this.#state.thinkingLevel = l;
	}

	setSteeringMode(mode: "all" | "one-at-a-time") {
		this.#steeringMode = mode;
	}

	getSteeringMode(): "all" | "one-at-a-time" {
		return this.#steeringMode;
	}

	setFollowUpMode(mode: "all" | "one-at-a-time") {
		this.#followUpMode = mode;
	}

	getFollowUpMode(): "all" | "one-at-a-time" {
		return this.#followUpMode;
	}

	setInterruptMode(mode: "immediate" | "wait") {
		this.#interruptMode = mode;
	}

	getInterruptMode(): "immediate" | "wait" {
		return this.#interruptMode;
	}

	setTools(t: AgentTool<any>[]) {
		this.#state.tools = t;
	}

	replaceMessages(ms: AgentMessage[]) {
		this.#state.messages = ms.slice();
	}

	appendMessage(m: AgentMessage) {
		this.#state.messages = [...this.#state.messages, m];
	}

	popMessage(): AgentMessage | undefined {
		const messages = this.#state.messages.slice(0, -1);
		const removed = this.#state.messages.at(-1);
		this.#state.messages = messages;

		if (removed && this.#state.streamMessage === removed) {
			this.#state.streamMessage = null;
		}

		return removed;
	}

	/**
	 * Queue a steering message to interrupt the agent mid-run.
	 * Delivered after current tool execution, skips remaining tools.
	 */
	steer(m: AgentMessage) {
		this.#steeringQueue.push(m);
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 * Delivered only when agent has no more tool calls or steering messages.
	 */
	followUp(m: AgentMessage) {
		this.#followUpQueue.push(m);
	}

	clearSteeringQueue() {
		this.#steeringQueue = [];
	}

	clearFollowUpQueue() {
		this.#followUpQueue = [];
	}

	clearAllQueues() {
		this.#steeringQueue = [];
		this.#followUpQueue = [];
	}

	hasQueuedMessages(): boolean {
		return this.#steeringQueue.length > 0 || this.#followUpQueue.length > 0;
	}

	#dequeueSteeringMessages(): AgentMessage[] {
		if (this.#steeringMode === "one-at-a-time") {
			if (this.#steeringQueue.length > 0) {
				const first = this.#steeringQueue[0];
				this.#steeringQueue = this.#steeringQueue.slice(1);
				return [first];
			}
			return [];
		}
		const steering = this.#steeringQueue.slice();
		this.#steeringQueue = [];
		return steering;
	}

	#dequeueFollowUpMessages(): AgentMessage[] {
		if (this.#followUpMode === "one-at-a-time") {
			if (this.#followUpQueue.length > 0) {
				const first = this.#followUpQueue[0];
				this.#followUpQueue = this.#followUpQueue.slice(1);
				return [first];
			}
			return [];
		}
		const followUp = this.#followUpQueue.slice();
		this.#followUpQueue = [];
		return followUp;
	}

	/**
	 * Remove and return the last steering message from the queue (LIFO).
	 * Used by dequeue keybinding.
	 */
	popLastSteer(): AgentMessage | undefined {
		return this.#steeringQueue.pop();
	}

	/**
	 * Remove and return the last follow-up message from the queue (LIFO).
	 * Used by dequeue keybinding.
	 */
	popLastFollowUp(): AgentMessage | undefined {
		return this.#followUpQueue.pop();
	}

	clearMessages() {
		this.#state.messages = [];
	}

	abort() {
		this.#abortController?.abort();
	}

	/**
	 * Force the current run out of the busy/streaming state when cooperative abort
	 * did not drain. The abandoned provider/tool stream may still settle later, so
	 * #runLoop guards every state mutation with a run id.
	 */
	forceAbort(reason = "Force aborted"): boolean {
		const hadActiveRun = this.#runningPrompt !== undefined || this.#state.isStreaming;
		if (!hadActiveRun) return false;

		this.#abortController?.abort(reason);
		this.#activeRunId = undefined;
		this.#state.isStreaming = false;
		this.#state.streamMessage = null;
		this.#state.pendingToolCalls = new Set<string>();
		this.#abortController = undefined;
		this.#cursorToolResultBuffer = [];

		const resolve = this.#resolveRunningPrompt;
		this.#runningPrompt = undefined;
		this.#resolveRunningPrompt = undefined;
		resolve?.();

		this.#emit({ type: "agent_end", messages: [] });
		return true;
	}

	waitForIdle(): Promise<void> {
		return this.#runningPrompt ?? Promise.resolve();
	}

	reset() {
		this.#state.messages = [];
		this.#state.isStreaming = false;
		this.#state.streamMessage = null;
		this.#state.pendingToolCalls = new Set<string>();
		this.#state.error = undefined;
		this.#steeringQueue = [];
		this.#followUpQueue = [];
	}

	/** Send a prompt with an AgentMessage */
	async prompt(message: AgentMessage | AgentMessage[], options?: AgentPromptOptions): Promise<void>;
	async prompt(input: string, options?: AgentPromptOptions): Promise<void>;
	async prompt(input: string, images?: ImageContent[], options?: AgentPromptOptions): Promise<void>;
	async prompt(
		input: string | AgentMessage | AgentMessage[],
		imagesOrOptions?: ImageContent[] | AgentPromptOptions,
		options?: AgentPromptOptions,
	) {
		if (this.#state.isStreaming) {
			throw new AgentBusyError();
		}

		const model = this.#state.model;
		if (!model) throw new Error("No model configured");

		let msgs: AgentMessage[];
		let promptOptions: AgentPromptOptions | undefined;
		let images: ImageContent[] | undefined;

		if (Array.isArray(input)) {
			msgs = input;
			promptOptions = imagesOrOptions as AgentPromptOptions | undefined;
		} else if (typeof input === "string") {
			if (Array.isArray(imagesOrOptions)) {
				images = imagesOrOptions;
				promptOptions = options;
			} else {
				promptOptions = imagesOrOptions;
			}
			const content: Array<TextContent | ImageContent> = [{ type: "text", text: input }];
			if (images && images.length > 0) {
				content.push(...images);
			}
			msgs = [
				{
					role: "user",
					content,
					timestamp: Date.now(),
				},
			];
		} else {
			msgs = [input];
			promptOptions = imagesOrOptions as AgentPromptOptions | undefined;
		}

		await this.#runLoop(msgs, promptOptions);
	}

	/**
	 * Continue from current context (used for retries and resuming queued messages).
	 */
	async continue() {
		if (this.#state.isStreaming) {
			throw new AgentBusyError();
		}

		const messages = this.#state.messages;
		if (messages.length === 0) {
			throw new Error("No messages to continue from");
		}
		if (messages[messages.length - 1].role === "assistant") {
			const queuedSteering = this.#dequeueSteeringMessages();
			if (queuedSteering.length > 0) {
				await this.#runLoop(queuedSteering, { skipInitialSteeringPoll: true });
				return;
			}

			const queuedFollowUp = this.#dequeueFollowUpMessages();
			if (queuedFollowUp.length > 0) {
				await this.#runLoop(queuedFollowUp);
				return;
			}

			throw new Error("Cannot continue from message role: assistant");
		}

		await this.#runLoop(undefined);
	}

	/**
	 * Run the agent loop.
	 * If messages are provided, starts a new conversation turn with those messages.
	 * Otherwise, continues from existing context.
	 */
	async #runLoop(messages?: AgentMessage[], options?: AgentPromptOptions & { skipInitialSteeringPoll?: boolean }) {
		const model = this.#state.model;
		if (!model) throw new Error("No model configured");

		let skipInitialSteeringPoll = options?.skipInitialSteeringPoll === true;

		const { promise, resolve } = Promise.withResolvers<void>();
		this.#runningPrompt = promise;
		this.#resolveRunningPrompt = resolve;

		const runId = ++this.#runSequence;
		this.#activeRunId = runId;
		const abortController = new AbortController();
		this.#abortController = abortController;
		this.#state.isStreaming = true;
		this.#state.streamMessage = null;
		this.#state.error = undefined;

		// Clear Cursor tool result buffer at start of each run
		this.#cursorToolResultBuffer = [];

		const reasoning = this.#state.thinkingLevel;

		const context: AgentContext = {
			systemPrompt: this.#state.systemPrompt,
			messages: this.#state.messages.slice(),
			tools: this.#state.tools,
		};

		const cursorOnToolResult =
			this.#cursorExecHandlers || this.#cursorOnToolResult
				? async (message: ToolResultMessage) => {
						let finalMessage = message;
						if (this.#activeRunId !== runId) {
							return finalMessage;
						}
						if (this.#cursorOnToolResult) {
							try {
								const updated = await this.#cursorOnToolResult(message);
								if (this.#activeRunId !== runId) {
									return finalMessage;
								}
								if (updated) {
									finalMessage = updated;
								}
							} catch {}
						}
						// Buffer tool result with current text length for correct ordering later.
						// Cursor executes tools server-side during streaming, so the assistant message
						// already incorporates results. We buffer here and emit in correct order
						// when the assistant message ends.
						const textLength = this.#getAssistantTextLength(this.#state.streamMessage);
						this.#cursorToolResultBuffer.push({ toolResult: finalMessage, textLengthAtCall: textLength });
						return finalMessage;
					}
				: undefined;

		const getToolChoice = () =>
			this.#getToolChoice?.() ?? refreshToolChoiceForActiveTools(options?.toolChoice, this.#state.tools);
		const cursorExecHandlers = this.#cursorExecHandlersForRun(runId);

		const config: AgentLoopConfig = {
			model,
			reasoning,
			temperature: this.#temperature,
			topP: this.#topP,
			topK: this.#topK,
			minP: this.#minP,
			presencePenalty: this.#presencePenalty,
			repetitionPenalty: this.#repetitionPenalty,
			serviceTier: this.#serviceTier,
			hideThinkingSummary: this.#hideThinkingSummary,
			interruptMode: this.#interruptMode,
			sessionId: this.#sessionId,
			providerSessionId: this.#providerSessionId,
			metadata: this.#metadataResolver ? undefined : this.#metadata,
			metadataResolver: this.#metadataResolver,
			providerSessionState: this.#providerSessionState,
			thinkingBudgets: this.#thinkingBudgets,
			maxRetryDelayMs: this.#maxRetryDelayMs,
			kimiApiFormat: this.#kimiApiFormat,
			preferWebsockets: this.#preferWebsockets,
			convertToLlm: this.#convertToLlm,
			transformContext: this.#transformContext,
			onPayload: this.#onPayload,
			onResponse: this.#onResponse,
			onSseEvent: this.#onSseEvent,
			signal: abortController.signal,
			getApiKey: this.getApiKey,
			getAuthCredentialType: this.getAuthCredentialType,
			getToolContext: this.#getToolContext,
			syncContextBeforeModelCall: async context => {
				if (this.#listeners.size > 0) {
					await Bun.sleep(0);
				}
				context.systemPrompt = this.#state.systemPrompt;
				context.tools = this.#state.tools;
			},
			cursorExecHandlers,
			cursorOnToolResult,
			transformToolCallArguments: this.#transformToolCallArguments,
			intentTracing: this.#intentTracing,
			appendOnlyContext: this.#appendOnlyContext,
			beforeToolCall: this.beforeToolCall
				? async (ctx, signal) => {
						if (this.#activeRunId !== runId) return undefined;
						const result = await this.beforeToolCall?.(ctx, signal);
						if (this.#activeRunId !== runId) return undefined;
						return result;
					}
				: undefined,
			afterToolCall: this.afterToolCall
				? async (ctx, signal) => {
						if (this.#activeRunId !== runId) return undefined;
						const result = await this.afterToolCall?.(ctx, signal);
						if (this.#activeRunId !== runId) return undefined;
						return result;
					}
				: undefined,
			onAssistantMessageEvent: this.#onAssistantMessageEvent
				? (message, event) => {
						if (this.#activeRunId !== runId) return;
						this.#onAssistantMessageEvent?.(message, event);
					}
				: undefined,
			onHarmonyLeak: this.#onHarmonyLeak,
			getToolChoice,
			getReasoning: () => this.#state.thinkingLevel,
			getSteeringMessages: async () => {
				if (this.#activeRunId !== runId) {
					return [];
				}
				if (skipInitialSteeringPoll) {
					skipInitialSteeringPoll = false;
					return [];
				}
				const queued = this.#dequeueSteeringMessages();
				if (this.#activeRunId !== runId) {
					this.#steeringQueue = [...queued, ...this.#steeringQueue];
					return [];
				}
				return queued;
			},
			getFollowUpMessages: async () => {
				if (this.#activeRunId !== runId) {
					return [];
				}
				const queued = this.#dequeueFollowUpMessages();
				if (this.#activeRunId !== runId) {
					this.#followUpQueue = [...queued, ...this.#followUpQueue];
					return [];
				}
				return queued;
			},
			onBeforeYield: async () => {
				if (this.#activeRunId !== runId) return;
				await this.#onBeforeYield?.();
			},
			telemetry: this.#telemetry,
		};

		let partial: AgentMessage | null = null;

		try {
			const stream = messages
				? agentLoop(messages, context, config, abortController.signal, this.streamFn)
				: agentLoopContinue(context, config, abortController.signal, this.streamFn);

			for await (const event of stream) {
				if (this.#activeRunId !== runId) {
					break;
				}

				// Update internal state based on events
				switch (event.type) {
					case "message_start":
						partial = event.message;
						this.#state.streamMessage = event.message;
						break;

					case "message_update":
						partial = event.message;
						this.#state.streamMessage = event.message;
						break;

					case "message_end":
						partial = null;
						// Check if this is an assistant message with buffered Cursor tool results.
						// If so, split the message to emit tool results at the correct position.
						if (event.message.role === "assistant" && this.#cursorToolResultBuffer.length > 0) {
							this.#emitCursorSplitAssistantMessage(event.message as AssistantMessage);
							continue; // Skip default emit - split method handles everything
						}
						this.#state.streamMessage = null;
						this.appendMessage(event.message);
						break;

					case "tool_execution_start": {
						const s = new Set(this.#state.pendingToolCalls);
						s.add(event.toolCallId);
						this.#state.pendingToolCalls = s;
						break;
					}

					case "tool_execution_end": {
						const s = new Set(this.#state.pendingToolCalls);
						s.delete(event.toolCallId);
						this.#state.pendingToolCalls = s;
						break;
					}

					case "turn_end":
						if (event.message.role === "assistant" && (event.message as any).errorMessage) {
							this.#state.error = (event.message as any).errorMessage;
						}
						break;

					case "agent_end":
						this.#state.isStreaming = false;
						this.#state.streamMessage = null;
						break;
				}

				// Emit to listeners
				this.#emit(event);
			}

			if (this.#activeRunId !== runId) {
				return;
			}

			// Handle any remaining partial message
			if (partial && partial.role === "assistant" && Array.isArray(partial.content) && partial.content.length > 0) {
				const onlyEmpty = !partial.content.some(
					c =>
						(c.type === "thinking" && c.thinking.trim().length > 0) ||
						(c.type === "text" && c.text.trim().length > 0) ||
						(c.type === "toolCall" && c.name.trim().length > 0),
				);
				if (!onlyEmpty) {
					this.appendMessage(partial);
				} else {
					if (abortController.signal.aborted) {
						throw new Error("Request was aborted");
					}
				}
			}
		} catch (err: any) {
			if (this.#activeRunId !== runId) {
				return;
			}

			const errorMsg: AgentMessage = {
				role: "assistant",
				content: [{ type: "text", text: "" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: abortController.signal.aborted ? "aborted" : "error",
				errorMessage: err?.message || String(err),
				timestamp: Date.now(),
			} as AgentMessage;

			this.appendMessage(errorMsg);
			this.#state.error = err?.message || String(err);
			this.#emit({ type: "agent_end", messages: [errorMsg] });
		} finally {
			if (this.#activeRunId === runId) {
				this.#state.isStreaming = false;
				this.#state.streamMessage = null;
				this.#state.pendingToolCalls = new Set<string>();
				this.#abortController = undefined;
				this.#activeRunId = undefined;
				this.#resolveRunningPrompt?.();
				this.#runningPrompt = undefined;
				this.#resolveRunningPrompt = undefined;
			}
		}
	}

	#emit(e: AgentEvent) {
		for (const listener of this.#listeners) {
			listener(e);
		}
	}

	/** Calculate total text length from an assistant message's content blocks */
	#getAssistantTextLength(message: AgentMessage | null): number {
		if (!message || message.role !== "assistant" || !Array.isArray(message.content)) {
			return 0;
		}
		let length = 0;
		for (const block of message.content) {
			if (block.type === "text") {
				length += (block as TextContent).text.length;
			}
		}
		return length;
	}

	/**
	 * Emit a Cursor assistant message split around tool results.
	 * This fixes the ordering issue where tool results appear after the full explanation.
	 *
	 * Output order: Assistant(preamble) -> ToolResults -> Assistant(continuation)
	 */
	#emitCursorSplitAssistantMessage(assistantMessage: AssistantMessage): void {
		const buffer = this.#cursorToolResultBuffer;
		this.#cursorToolResultBuffer = [];

		if (buffer.length === 0) {
			// No tool results, emit normally
			this.#state.streamMessage = null;
			this.appendMessage(assistantMessage);
			this.#emit({ type: "message_end", message: assistantMessage });
			return;
		}

		// Find the split point: minimum text length at first tool call
		const splitPoint = Math.min(...buffer.map(r => r.textLengthAtCall));

		// Extract text content from assistant message
		const content = assistantMessage.content;
		let fullText = "";
		for (const block of content) {
			if (block.type === "text") {
				fullText += block.text;
			}
		}

		// If no text or split point is 0 or at/past end, don't split
		if (fullText.length === 0 || splitPoint <= 0 || splitPoint >= fullText.length) {
			// Emit assistant message first, then tool results (original behavior but with buffered results)
			this.#state.streamMessage = null;
			this.appendMessage(assistantMessage);
			this.#emit({ type: "message_end", message: assistantMessage });

			// Emit buffered tool results
			for (const { toolResult } of buffer) {
				this.#emit({ type: "message_start", message: toolResult });
				this.appendMessage(toolResult);
				this.#emit({ type: "message_end", message: toolResult });
			}
			return;
		}

		// Split the text
		const preambleText = fullText.slice(0, splitPoint);
		const continuationText = fullText.slice(splitPoint);

		// Create preamble message (text before tools)
		const preambleContent = content.map(block => {
			if (block.type === "text") {
				return { ...block, text: preambleText };
			}
			return block;
		});
		const preambleMessage: AssistantMessage = {
			...assistantMessage,
			content: preambleContent,
		};

		// Emit preamble
		this.#state.streamMessage = null;
		this.appendMessage(preambleMessage);
		this.#emit({ type: "message_end", message: preambleMessage });

		// Emit buffered tool results
		for (const { toolResult } of buffer) {
			this.#emit({ type: "message_start", message: toolResult });
			this.appendMessage(toolResult);
			this.#emit({ type: "message_end", message: toolResult });
		}

		// Emit continuation message (text after tools) if non-empty
		const trimmedContinuation = continuationText.trim();
		if (trimmedContinuation.length > 0) {
			// Create continuation message with only text content (no thinking/toolCalls)
			const continuationContent: TextContent[] = [{ type: "text", text: continuationText }];
			const continuationMessage: AssistantMessage = {
				...assistantMessage,
				content: continuationContent,
				// Zero out usage for continuation since it's part of same response
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
			this.#emit({ type: "message_start", message: continuationMessage });
			this.appendMessage(continuationMessage);
			this.#emit({ type: "message_end", message: continuationMessage });
		}
	}
}
