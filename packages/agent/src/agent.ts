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
	type UserMessage,
} from "@gajae-code/ai";
import {
	CURSOR_COMPOSER_BASH_POLICY_RECOVERY_PROMPT,
	isCurrentComposerBashPolicyBlockedError,
} from "@gajae-code/ai/providers/composer-discipline";
import { extractHttpStatusFromError } from "@gajae-code/utils";
import { agentLoop, agentLoopContinue, managedLocalErrorDiagnostic } from "./agent-loop";
import type { AppendOnlyContextManager } from "./append-only-context";
import type { AttemptRunHandle, AttemptScope } from "./attempt-scope";
import { createAttemptScopeAuthority } from "./attempt-scope";
import type { HarmonyAuditEvent } from "./harmony-leak";
import { assertImagePlaceholdersHavePayload } from "./image-placeholder-guard";
import { createRunResourceLedger } from "./run-resource-ledger";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentMetadataResolverContext,
	AgentState,
	AgentTool,
	AgentToolContext,
	ManagedAttemptContinuation,
	ManagedAttemptContinuationOwnership,
	ManagedAttemptDecision,
	ManagedAttemptOutcome,
	ManagedLogicalRunId,
	RunCancellationDomain,
	RunCancellationDomainBridge,
	RunResourceLedger,
	RunTerminalRequest,
	StreamFn,
	ToolCallContext,
} from "./types";
import { isContinuingMidRunMaintenanceOutcome, setAgentTerminalOwnerContext } from "./types";

/**
 * Closed runtime allowlist of failure-classifier codes. The public diagnostic
 * contract promises a STABLE runtime classifier independent of provider-specific
 * detail, so an unknown or provider-supplied code maps to the nearest runtime
 * class instead of being forwarded verbatim (exact-head review P1/P2).
 */
const RUNTIME_FAILURE_CODES = new Set([
	"agent_failed",
	"aborted",
	"local_snapshot_failure",
	"provider_down",
	"provider_unavailable",
	"provider_rejected",
	"provider_http_402",
	"provider_http_429",
	"upstream_stream_interrupted",
	"argument_validation",
	"execution",
	"local_buffer_overflow",
	"escaped_arguments_discarded",
	"prompt_failed",
	"prompt_deadline_exceeded",
	"skill_runtime",
	"io_error",
]);

/** Provider-safe classifier subset: generic transport/validation classes a
 * provider error may legitimately carry. Lifecycle classifiers ("aborted",
 * "prompt_deadline_exceeded", local staging kinds) are runtime-owned and can
 * never be asserted by a provider-supplied string (exact-head review P1). */
const PROVIDER_ACCEPTABLE_FAILURE_CODES = new Set([
	"provider_down",
	"provider_unavailable",
	"upstream_stream_interrupted",
	"argument_validation",
	"execution",
]);

function sanitizeAgentFailure(error: unknown, runtimeClassifiedCode?: string): { code: string; message: string } {
	let code = "agent_failed";
	try {
		if (runtimeClassifiedCode !== undefined) {
			// Runtime-authenticated classification: only the runtime itself may
			// assert lifecycle classifiers; untrusted provider strings map to the
			// generic failure class below.
			if (RUNTIME_FAILURE_CODES.has(runtimeClassifiedCode)) code = runtimeClassifiedCode;
		} else {
			const candidate = error as { code?: unknown } | undefined;
			if (
				typeof candidate?.code === "string" &&
				candidate.code.length <= 64 &&
				PROVIDER_ACCEPTABLE_FAILURE_CODES.has(candidate.code)
			)
				code = candidate.code;
		}
	} catch {
		// Untrusted provider errors may expose throwing accessors.
	}
	return { code, message: "Agent run failed." };
}

/** Only runtime-authenticated built-in constructors may contribute a name. */
const TRUSTED_ERROR_CONSTRUCTORS = new Map<object, string>([
	[Error, "Error"],
	[TypeError, "TypeError"],
	[RangeError, "RangeError"],
	[SyntaxError, "SyntaxError"],
	[ReferenceError, "ReferenceError"],
	[URIError, "URIError"],
	[EvalError, "EvalError"],
	[AggregateError, "AggregateError"],
]);

function safeErrorName(error: unknown): string | undefined {
	try {
		if (!(error instanceof Error)) return undefined;
		return TRUSTED_ERROR_CONSTRUCTORS.get(error.constructor);
	} catch {
		return undefined;
	}
}

/** Guarded HTTP-status extraction for untrusted provider errors: a throwing
 * getter must never escape the failure handler and suppress terminalization
 * (exact-head review P1). */
function safeErrorStatus(error: unknown): number | undefined {
	try {
		return (
			extractHttpStatusFromError({ status: (error as { errorStatus?: unknown } | undefined)?.errorStatus }) ??
			extractHttpStatusFromError(error) ??
			extractHttpStatusFromError((error as { transportFailure?: unknown } | undefined)?.transportFailure)
		);
	} catch {
		return undefined;
	}
}

function providerFailureCode(error: unknown): string | undefined {
	const status = safeErrorStatus(error);
	if (status === undefined) return undefined;
	if (status === 402 || status === 429) return `provider_http_${status}`;
	return "provider_rejected";
}

function assertUserImagePlaceholdersHavePayload(messages: readonly AgentMessage[]): void {
	for (const message of messages) {
		if (!("role" in message) || message.role !== "user") continue;
		const content = message.content;
		if (typeof content === "string") {
			assertImagePlaceholdersHavePayload(content, undefined);
			continue;
		}
		if (!Array.isArray(content)) continue;
		const text = content
			.filter(part => part.type === "text")
			.map(part => part.text)
			.join("\n");
		assertImagePlaceholdersHavePayload(text, content);
	}
}

const CURSOR_NATIVE_REPOSITORY_RECOVERY_TOOL_NAMES = new Set(["read", "grep", "search", "find", "write", "delete"]);

function isCursorComposerBashPolicyBlockedResult(message: ToolResultMessage): boolean {
	return (
		message.isError &&
		message.toolName === "bash" &&
		message.content.some(content => content.type === "text" && isCurrentComposerBashPolicyBlockedError(content.text))
	);
}

function isSuccessfulCursorNativeRepositoryToolResult(message: ToolResultMessage): boolean {
	return message.isError !== true && CURSOR_NATIVE_REPOSITORY_RECOVERY_TOOL_NAMES.has(message.toolName);
}

/**
 * Whether persisted history ends at a point where a new model turn can resume.
 * Assistant-ended histories require an in-memory queued message and are handled
 * separately by `Agent.continue()`.
 */
export function canContinuePersistedHistory(messages: readonly AgentMessage[]): boolean {
	const lastMessage = messages.at(-1);
	return lastMessage !== undefined && lastMessage.role !== "assistant";
}

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

export class ManagedCursorInvariantError extends Error {
	constructor(message: string = "Managed Cursor attempt received a provider-side tool result") {
		super(message);
		this.name = "ManagedCursorInvariantError";
	}
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
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal, scope?: AttemptScope) => Promise<AgentMessage[]>;

	/**
	 * Steering mode: "all" = send all steering messages at once, "one-at-a-time" = one per turn
	 */
	steeringMode?: "all" | "one-at-a-time";

	/**
	 * Follow-up mode: "all" = send all follow-up messages at once, "one-at-a-time" = one per turn
	 */
	followUpMode?: "all" | "one-at-a-time";

	/**
	 * Whether a steering message aborts the tool calls still running in the
	 * current batch.
	 * - "abort_tools": abort the remaining tools and open the steering turn (default)
	 * - "finish_tools": let the batch finish, then open the steering turn
	 *
	 * This never changes WHEN a steer is consumed: the loop picks it up at the
	 * next tool/turn boundary either way.
	 */
	toolInterruptPolicy?: "abort_tools" | "finish_tools";
	/** Cooperative pause checkpoint passed through to AgentLoopConfig.shouldPause. */
	shouldPause?: AgentLoopConfig["shouldPause"];

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
	/** Called for non-content tool-choice incapability stream events. */
	onToolChoiceIncapability?: AgentLoopConfig["onToolChoiceIncapability"];

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
	/** Provider request retry budget. Counts retries, not the initial attempt. */
	requestMaxRetries?: number;
	/** Provider stream replay retry budget. Counts retries, not the initial attempt. */
	streamMaxRetries?: number;
	/** Explicit first-event stream watchdog override in milliseconds. Set to 0 to disable. */
	streamFirstEventTimeoutMs?: number;

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
	/** Invoked with the follow-up messages dequeued for the next turn (reassignable). */
	onFollowUpConsumed?: AgentLoopConfig["onFollowUpConsumed"];
	/** Invoked with the steering messages dequeued mid-run for the current turn (reassignable). */
	onSteeringConsumed?: AgentLoopConfig["onSteeringConsumed"];

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
	/** One-shot transient recovery instruction sent only to the provider for the next assistant request; never committed to durable history. */
	transientRecoveryMessage?: UserMessage;
	toolChoice?: ToolChoice;
	/** Disable transport replay; fallback accounting is owned by the caller. */
	fallbackManaged?: boolean;
	/** Continue a cooperative maintenance checkpoint under its existing logical run and cancellation domain. */
	maintenanceContinuation?: boolean;
	/**
	 * Skip the loop's INITIAL steering poll for this run. Used when the caller
	 * seeds the steering queue at run acceptance but the run's first model call
	 * must answer its own prompt first; the steering is then consumed at the
	 * first turn boundary instead of being merged into the opening call.
	 */
	skipInitialSteeringPoll?: boolean;
	/** Called synchronously after this invocation claims the agent run, before asynchronous provider work. */
	onRunAccepted?: (handle: AttemptRunHandle, acceptance: { consumedQueuedMessages: readonly AgentMessage[] }) => void;
	/** Called once immediately before every managed upstream request. */
	nextFallbackAttempt?: AgentLoopConfig["nextFallbackAttempt"];
	/** Called after a managed upstream request is accepted and committed. */
	onManagedAttemptAccepted?: AgentLoopConfig["onManagedAttemptAccepted"];
	/** Receives a discarded managed attempt without exposing assistant lifecycle events. */
	onManagedAttemptOutcome?: AgentLoopConfig["onManagedAttemptOutcome"];
}

/** Buffered Cursor tool result with text position at time of call */
interface CursorToolResultEntry {
	toolResult: ToolResultMessage;
	textLengthAtCall: number;
}

export type AgentQueueSnapshot = {
	steering: AgentMessage[];
	followUp: AgentMessage[];
};

/**
 * Result of `Agent.steer()`. A steer is admitted only into a live, non-aborted
 * run; otherwise the message is NOT queued and the caller (the session) owns
 * routing it — as a fresh prompt when idle, or after the unwind when aborting.
 */
export type SteerAdmission = { admitted: true; runId: number } | { admitted: false; reason: "idle" | "aborting" };

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
	#contextRevision = 0;
	#attemptAuthority = createAttemptScopeAuthority();
	#runHandles = new Map<number | ManagedLogicalRunId, AttemptRunHandle>();

	#listeners = new Set<(e: AgentEvent) => void>();
	#abortController?: AbortController;
	#convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	#transformContext?: (
		messages: AgentMessage[],
		signal?: AbortSignal,
		scope?: AttemptScope,
	) => Promise<AgentMessage[]>;
	#steeringQueue: AgentMessage[] = [];
	#steeringWaiters = new Set<() => void>();
	#followUpQueue: AgentMessage[] = [];
	#followUpForceOneAtATime = new WeakSet<AgentMessage>();
	#followUpBatches = new WeakMap<AgentMessage, readonly AgentMessage[]>();
	#steeringForceOneAtATime = new WeakSet<AgentMessage>();
	#steeringMode: "all" | "one-at-a-time";
	#followUpMode: "all" | "one-at-a-time";
	#toolInterruptPolicy: "abort_tools" | "finish_tools";
	#sessionId?: string;
	#providerSessionId?: string;
	#metadata?: Record<string, unknown>;
	#metadataResolver?: (context: AgentMetadataResolverContext) => Record<string, unknown> | undefined;
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
	#requestMaxRetries?: number;
	#streamMaxRetries?: number;
	#streamFirstEventTimeoutMs?: number;
	#getToolContext?: (toolCall?: ToolCallContext) => AgentToolContext | undefined;
	#cursorExecHandlers?: CursorExecHandlers;
	#cursorOnToolResult?: CursorToolResultHandler;
	#runningPrompt?: Promise<void>;
	#resolveRunningPrompt?: () => void;
	#runSequence = 0;
	#activeRunId?: number;
	#activeResourceRunId?: string;
	#activeResourceCancellationDomain?: RunCancellationDomain;
	#continuationGeneration = 0;
	#kimiApiFormat?: "openai" | "anthropic";
	#preferWebsockets?: boolean;
	#transformToolCallArguments?: (args: Record<string, unknown>, toolName: string) => Record<string, unknown>;
	#intentTracing: boolean;
	#getToolChoice?: () => ToolChoice | undefined;
	#onPayload?: SimpleStreamOptions["onPayload"];
	#onResponse?: SimpleStreamOptions["onResponse"];
	#onSseEvent?: SimpleStreamOptions["onSseEvent"];
	#onAssistantMessageEvent?: (message: AssistantMessage, event: AssistantMessageEvent) => void;
	#onProvisionalAssistantMessageEvent?: (message: AssistantMessage, event: AssistantMessageEvent) => void;
	#onToolChoiceIncapability?: AgentLoopConfig["onToolChoiceIncapability"];
	#onHarmonyLeak?: (event: HarmonyAuditEvent) => void | Promise<void>;
	#onBeforeYield?: () => Promise<void> | void;
	#shouldPause?: AgentLoopConfig["shouldPause"];
	/** While set and returning true, the run does not DEQUEUE steering (admission is unaffected). */
	#steeringAdmissionFence?: () => boolean;
	#maintainContext?: AgentLoopConfig["maintainContext"];
	#telemetry?: AgentLoopConfig["telemetry"];
	#appendOnlyContext?: AppendOnlyContextManager;
	#mainAttemptScopeObserver?: (scope: AttemptScope) => void;

	get intentTracing(): boolean {
		return this.#intentTracing;
	}

	/** Buffered Cursor tool results with text length at time of call (for correct ordering) */
	#cursorToolResultBuffer: CursorToolResultEntry[] = [];
	#terminalizedLogicalRunIds = new Set<ManagedLogicalRunId>();
	#managedLogicalRunOwner?: ManagedLogicalRunId;
	readonly resourceLedger: RunResourceLedger = createRunResourceLedger();
	bindRunCancellationDomainBridge(bridge: RunCancellationDomainBridge, agentSessionClaimKey?: object): void {
		this.resourceLedger.bindCancellationDomainBridge(bridge);
		if (agentSessionClaimKey) this.resourceLedger.bindAgentSessionClaimKey(agentSessionClaimKey);
	}

	/** Mint a side-attempt scope and its authority unregister function. */
	mintSideAttemptScope(): { scope: AttemptScope; dispose: () => void } {
		return this.#attemptAuthority.mintSide();
	}

	/** Return the Agent-owned attempt scope authority for session record injection. */
	getAttemptScopeAuthority() {
		return this.#attemptAuthority;
	}
	/**
	 * Observe each main-attempt scope synchronously, before any provider or
	 * extension-capable lifecycle work can begin.
	 */
	setMainAttemptScopeObserver(observer: ((scope: AttemptScope) => void) | undefined): void {
		this.#mainAttemptScopeObserver = observer;
	}

	#observeMainAttemptScope(scope: AttemptScope): void {
		this.#mainAttemptScopeObserver?.(scope);
	}

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
	/** Invoked with the follow-up messages dequeued for the next turn. Reassign at any time. */
	onFollowUpConsumed?: AgentLoopConfig["onFollowUpConsumed"];
	/** Invoked with the steering messages dequeued mid-run for the current turn. Reassign at any time. */
	onSteeringConsumed?: AgentLoopConfig["onSteeringConsumed"];

	constructor(opts: AgentOptions = {}) {
		this.#state = { ...this.#state, ...opts.initialState };
		this.#convertToLlm = opts.convertToLlm || defaultConvertToLlm;
		this.#transformContext = opts.transformContext;
		this.#steeringMode = opts.steeringMode || "one-at-a-time";
		this.#followUpMode = opts.followUpMode || "one-at-a-time";
		this.#toolInterruptPolicy = opts.toolInterruptPolicy || "abort_tools";
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
		this.#requestMaxRetries = opts.requestMaxRetries;
		this.#streamMaxRetries = opts.streamMaxRetries;
		this.#streamFirstEventTimeoutMs = opts.streamFirstEventTimeoutMs;
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
		this.#onToolChoiceIncapability = opts.onToolChoiceIncapability;
		this.#onHarmonyLeak = opts.onHarmonyLeak;
		this.#shouldPause = opts.shouldPause;
		this.beforeToolCall = opts.beforeToolCall;
		this.onFollowUpConsumed = opts.onFollowUpConsumed;
		this.onSteeringConsumed = opts.onSteeringConsumed;
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
	 * Whether websocket transport is preferred when the provider implementation
	 * supports it. Read by maintenance one-shot calls (compaction, handoff,
	 * branch summary) so they forward the same transport preference as live turns.
	 */
	get preferWebsockets(): boolean | undefined {
		return this.#preferWebsockets;
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
	metadataForProvider(
		provider: string,
		model?: Model,
		transport?: AgentMetadataResolverContext["transport"],
	): Record<string, unknown> | undefined {
		if (this.#metadataResolver) return this.#metadataResolver({ provider, model, transport });
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
	setMetadataResolver(
		resolver: ((context: AgentMetadataResolverContext) => Record<string, unknown> | undefined) | undefined,
	): void {
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

	get requestMaxRetries(): number | undefined {
		return this.#requestMaxRetries;
	}

	set requestMaxRetries(value: number | undefined) {
		this.#requestMaxRetries = value;
	}

	get streamMaxRetries(): number | undefined {
		return this.#streamMaxRetries;
	}

	set streamMaxRetries(value: number | undefined) {
		this.#streamMaxRetries = value;
	}

	get streamFirstEventTimeoutMs(): number | undefined {
		return this.#streamFirstEventTimeoutMs;
	}

	set streamFirstEventTimeoutMs(value: number | undefined) {
		this.#streamFirstEventTimeoutMs = value;
	}

	get state(): AgentState {
		return this.#state;
	}

	get contextRevision(): number {
		return this.#contextRevision;
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

	setProvisionalAssistantMessageEventInterceptor(
		fn: ((message: AssistantMessage, event: AssistantMessageEvent) => void) | undefined,
	): void {
		this.#onProvisionalAssistantMessageEvent = fn;
	}

	setOnBeforeYield(fn: (() => Promise<void> | void) | undefined): void {
		this.#onBeforeYield = fn;
	}

	setShouldPause(fn: AgentLoopConfig["shouldPause"] | undefined): void {
		this.#shouldPause = fn;
	}

	/** The currently installed cooperative pause checkpoint, if any. */
	get shouldPause(): AgentLoopConfig["shouldPause"] | undefined {
		return this.#shouldPause;
	}

	/**
	 * Fence old-turn steering admission.
	 *
	 * The loop polls steering UPSTREAM of its pause checkpoint (and again on the
	 * immediate-interrupt path), so a cooperative stop alone cannot prevent one
	 * more old-turn model call once a steering message has already been dequeued.
	 * While the fence returns true the poll yields no messages AND does not
	 * dequeue, so the winding-down run cannot consume it. The message is not
	 * retained past the run's terminal either: `agent_end.disownedSteering`
	 * hands it to the owner, which re-routes it onto the next turn.
	 */
	setSteeringAdmissionFence(fn: (() => boolean) | undefined): void {
		this.#steeringAdmissionFence = fn;
	}

	setMaintainContext(fn: AgentLoopConfig["maintainContext"] | undefined): void {
		this.#maintainContext = fn;
	}

	/**
	 * Publish an event produced OUTSIDE the agent loop (a provider that executed the tool
	 * itself, a host bridge, a replay).
	 *
	 * Identity is the PRODUCER's to prove: whoever dispatched the call binds the tool object
	 * it actually ran (see `bindDispatchedToolIdentity`) before handing the event here, and
	 * that binding is never touched from this side. Re-resolving `event.toolName` against the
	 * mutable current tool list would let a mid-run `setTools`, MCP reload, or plain name
	 * collision overwrite a proven object with one that never ran — and would invent an
	 * identity for replays and host bridges that never executed an AgentTool at all. An
	 * unbound external event stays unbound; unproven provenance is `custom`.
	 */
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
		// Bind each handler to `source`: they are methods of a CursorExecHandlers
		// instance that reference private fields via `this`. Extracting them bare
		// (`const read = source.read`) and calling `read(args)` would invoke them with
		// `this === undefined`, throwing "undefined is not an object (this.#optionsForCall)".
		const read = source.read?.bind(source);
		if (read) {
			guarded.read = async (args, signal) => {
				this.#assertActiveRun(runId);
				const result = await read(args, signal);
				this.#assertActiveRun(runId);
				return result;
			};
		}
		const ls = source.ls?.bind(source);
		if (ls) {
			guarded.ls = async (args, signal) => {
				this.#assertActiveRun(runId);
				const result = await ls(args, signal);
				this.#assertActiveRun(runId);
				return result;
			};
		}
		const grep = source.grep?.bind(source);
		if (grep) {
			guarded.grep = async (args, signal) => {
				this.#assertActiveRun(runId);
				const result = await grep(args, signal);
				this.#assertActiveRun(runId);
				return result;
			};
		}
		const write = source.write?.bind(source);
		if (write) {
			guarded.write = async (args, signal, markNonAbortable) => {
				this.#assertActiveRun(runId);
				const result = await write(args, signal, markNonAbortable);
				this.#assertActiveRun(runId);
				return result;
			};
		}
		const deleteHandler = source.delete?.bind(source);
		if (deleteHandler) {
			guarded.delete = async (args, signal) => {
				this.#assertActiveRun(runId);
				const result = await deleteHandler(args, signal);
				this.#assertActiveRun(runId);
				return result;
			};
		}
		const shell = source.shell?.bind(source);
		if (shell) {
			guarded.shell = async (args, signal) => {
				this.#assertActiveRun(runId);
				const result = await shell(args, signal);
				this.#assertActiveRun(runId);
				return result;
			};
		}
		const shellStream = source.shellStream?.bind(source);
		if (shellStream) {
			guarded.shellStream = async (args, callbacks, signal) => {
				this.#assertActiveRun(runId);
				const result = await shellStream(args, callbacks, signal);
				this.#assertActiveRun(runId);
				return result;
			};
		}
		const diagnostics = source.diagnostics?.bind(source);
		if (diagnostics) {
			guarded.diagnostics = async (args, signal) => {
				this.#assertActiveRun(runId);
				const result = await diagnostics(args, signal);
				this.#assertActiveRun(runId);
				return result;
			};
		}
		const mcp = source.mcp?.bind(source);
		if (mcp) {
			guarded.mcp = async (call, signal) => {
				this.#assertActiveRun(runId);
				const result = await mcp(call, signal);
				this.#assertActiveRun(runId);
				return result;
			};
		}
		// Preserve Pi handlers end-to-end (probepark blocker): the production Agent guard previously dropped every pi* handler.
		const piRead = source.piRead?.bind(source);
		if (piRead) {
			guarded.piRead = async call => {
				this.#assertActiveRun(runId);
				const result = await piRead(call);
				this.#assertActiveRun(runId);
				return result;
			};
		}
		const piBash = source.piBash?.bind(source);
		if (piBash) {
			guarded.piBash = async call => {
				this.#assertActiveRun(runId);
				const result = await piBash(call);
				this.#assertActiveRun(runId);
				return result;
			};
		}
		const piEdit = source.piEdit?.bind(source);
		if (piEdit) {
			guarded.piEdit = async call => {
				this.#assertActiveRun(runId);
				const result = await piEdit(call);
				this.#assertActiveRun(runId);
				return result;
			};
		}
		const piWrite = source.piWrite?.bind(source);
		if (piWrite) {
			guarded.piWrite = async call => {
				this.#assertActiveRun(runId);
				const result = await piWrite(call);
				this.#assertActiveRun(runId);
				return result;
			};
		}
		const piGrep = source.piGrep?.bind(source);
		if (piGrep) {
			guarded.piGrep = async call => {
				this.#assertActiveRun(runId);
				const result = await piGrep(call);
				this.#assertActiveRun(runId);
				return result;
			};
		}
		const piFind = source.piFind?.bind(source);
		if (piFind) {
			guarded.piFind = async call => {
				this.#assertActiveRun(runId);
				const result = await piFind(call);
				this.#assertActiveRun(runId);
				return result;
			};
		}
		const piLs = source.piLs?.bind(source);
		if (piLs) {
			guarded.piLs = async call => {
				this.#assertActiveRun(runId);
				const result = await piLs(call);
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
		this.#contextRevision++;
	}

	setModel(m: Model | undefined) {
		this.#state.model = m;
		this.#contextRevision++;
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

	setToolInterruptPolicy(policy: "abort_tools" | "finish_tools") {
		this.#toolInterruptPolicy = policy;
	}

	getToolInterruptPolicy(): "abort_tools" | "finish_tools" {
		return this.#toolInterruptPolicy;
	}

	setTools(t: AgentTool<any>[]) {
		this.#state.tools = t;
		this.#contextRevision++;
	}

	replaceMessages(
		ms: AgentMessage[],
		options?: { historyRewrite?: { reason: string; preserveSeededPrefix?: boolean } },
	) {
		const rewrite = options?.historyRewrite;
		if (rewrite && this.#appendOnlyContext) {
			this.#appendOnlyContext.releaseAfterHistoryRewrite({ preserveSeededPrefix: rewrite.preserveSeededPrefix });
		}
		this.#state.messages = ms.slice();
		this.#contextRevision++;
	}

	appendMessage(m: AgentMessage) {
		// In-place push (not [...messages, m]): appending M messages over a session of
		// N is O(N+M), not O(M*N). Consumers read state.messages fresh; run() snapshots
		// via slice() at the API boundary, so no caller relies on per-append array identity.
		this.#state.messages.push(m);
		this.#contextRevision++;
	}

	popMessage(): AgentMessage | undefined {
		const messages = this.#state.messages.slice(0, -1);
		const removed = this.#state.messages.at(-1);
		this.#state.messages = messages;
		this.#contextRevision++;

		if (removed && this.#state.streamMessage === removed) {
			this.#state.streamMessage = null;
		}

		return removed;
	}

	/**
	 * For callers that mutate committed messages or the system prompt in place
	 * outside Agent-owned mutators.
	 */
	touchContext(): void {
		this.#contextRevision++;
	}

	/**
	 * Queue a steering message to interrupt the agent mid-run.
	 * Delivered after current tool execution, skips remaining tools.
	 *
	 * Enqueue-time admission: the message is pushed only when a run is live and
	 * its signal is not aborted, so a steer can never be orphaned in the queue
	 * waiting for whichever unrelated run polls next.
	 */
	steer(m: AgentMessage, options?: { forceOneAtATime?: boolean }): SteerAdmission {
		assertUserImagePlaceholdersHavePayload([m]);
		const runId = this.#activeRunId;
		if (runId === undefined || !this.#state.isStreaming) return { admitted: false, reason: "idle" };
		if (this.#abortController?.signal.aborted) return { admitted: false, reason: "aborting" };
		if (options?.forceOneAtATime) this.#steeringForceOneAtATime.add(m);
		this.#steeringQueue.push(m);
		for (const notify of [...this.#steeringWaiters]) notify();
		return { admitted: true, runId };
	}

	/**
	 * Resolves when a steering message is admitted AFTER this wait started, or
	 * when `signal` aborts. The queue is not consumed and a message already
	 * queued before the wait does not resolve it. Long observation tools use this
	 * to end their wait early so a busy user message is handled at the next tool
	 * boundary instead of after the full wait window.
	 */
	waitForSteeringArrival(signal: AbortSignal): Promise<void> {
		if (signal.aborted) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		let settled = false;
		const settle = () => {
			if (settled) return;
			settled = true;
			this.#steeringWaiters.delete(settle);
			signal.removeEventListener("abort", settle);
			resolve();
		};
		this.#steeringWaiters.add(settle);
		signal.addEventListener("abort", settle, { once: true });
		return promise;
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 * Delivered only when agent has no more tool calls or steering messages.
	 *
	 * `forceOneAtATime` lets UI composer queues preserve prompt-by-prompt
	 * delivery even when the session-wide follow-up mode is set to `all` for
	 * other integration paths.
	 */
	followUp(m: AgentMessage, options?: { forceOneAtATime?: boolean }) {
		assertUserImagePlaceholdersHavePayload([m]);
		if (options?.forceOneAtATime) {
			this.#followUpForceOneAtATime.add(m);
		}
		this.#followUpQueue.push(m);
	}

	/**
	 * Mark a follow-up message for prompt-by-prompt delivery under `all` mode
	 * without queueing it. Used when a message is restored ahead of the queue
	 * (e.g. steering disowned by an ended run and re-routed as a follow-up).
	 */
	markFollowUpSequential(m: AgentMessage): void {
		this.#followUpForceOneAtATime.add(m);
	}

	/** Preserve one atomic delivery cohort when messages are re-routed into the follow-up queue. */
	markFollowUpBatch(messages: readonly AgentMessage[]): void {
		const first = messages[0];
		if (first && messages.length > 1) this.#followUpBatches.set(first, messages.slice());
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

	hasQueuedSteering(): boolean {
		return this.#steeringQueue.length > 0;
	}

	/**
	 * Snapshot the steering queue without mutating it. Used to preserve queued
	 * steering across maintenance ops (compaction/handoff) that call reset().
	 */
	snapshotSteering(): AgentMessage[] {
		return this.#steeringQueue.slice();
	}

	/**
	 * Restore previously snapshotted steering messages ahead of any newly
	 * queued ones. No-op for an empty snapshot.
	 */
	restoreSteering(messages: AgentMessage[]): void {
		if (messages.length === 0) return;
		this.#steeringQueue = [...messages, ...this.#steeringQueue];
	}

	/** Snapshot the follow-up queue without mutating it. */
	snapshotFollowUp(): AgentMessage[] {
		return this.#followUpQueue.slice();
	}

	/** Restore previously snapshotted follow-up messages ahead of any newly queued ones. */
	restoreFollowUp(messages: AgentMessage[]): void {
		if (messages.length === 0) return;
		this.#followUpQueue = [...messages, ...this.#followUpQueue];
	}

	/** Snapshot both executable queues as one atomic session-level view. */
	snapshotQueues(): AgentQueueSnapshot {
		return {
			steering: this.#steeringQueue.slice(),
			followUp: this.#followUpQueue.slice(),
		};
	}

	/** Replace both executable queues with a prior snapshot. */
	restoreQueues(snapshot: AgentQueueSnapshot): void {
		this.#steeringQueue = snapshot.steering.slice();
		this.#followUpQueue = snapshot.followUp.slice();
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
		// "all" batches within ONE poll only; a per-message sequential mark still
		// delivers that message on its own, mirroring the follow-up override.
		const first = this.#steeringQueue[0];
		if (!first) return [];
		if (this.#steeringForceOneAtATime.has(first)) {
			this.#steeringQueue = this.#steeringQueue.slice(1);
			return [first];
		}
		const forcedIndex = this.#steeringQueue.findIndex(message => this.#steeringForceOneAtATime.has(message));
		const takeCount = forcedIndex === -1 ? this.#steeringQueue.length : forcedIndex;
		const steering = this.#steeringQueue.slice(0, takeCount);
		this.#steeringQueue = this.#steeringQueue.slice(takeCount);
		return steering;
	}

	#dequeueFollowUpMessages(): AgentMessage[] {
		const first = this.#followUpQueue[0];
		if (!first) return [];
		const batch = this.#followUpBatches.get(first);
		if (batch) {
			this.#followUpBatches.delete(first);
			if (batch.every((message, index) => this.#followUpQueue[index] === message)) {
				this.#followUpQueue = this.#followUpQueue.slice(batch.length);
				return [...batch];
			}
		}
		if (this.#followUpMode === "one-at-a-time") {
			this.#followUpQueue = this.#followUpQueue.slice(1);
			return [first];
		}

		if (this.#followUpForceOneAtATime.has(first)) {
			this.#followUpQueue = this.#followUpQueue.slice(1);
			return [first];
		}

		const forcedIndex = this.#followUpQueue.findIndex(message => this.#followUpForceOneAtATime.has(message));
		const takeCount = forcedIndex === -1 ? this.#followUpQueue.length : forcedIndex;
		const followUp = this.#followUpQueue.slice(0, takeCount);
		this.#followUpQueue = this.#followUpQueue.slice(takeCount);
		return followUp;
	}

	/**
	 * Remove and return the last steering message from the queue (LIFO).
	 * Used by dequeue keybinding.
	 */
	popLastSteer(): AgentMessage | undefined {
		return this.#steeringQueue.pop();
	}
	removeSteerAt(index: number): AgentMessage | undefined {
		if (index < 0 || index >= this.#steeringQueue.length) return undefined;
		const [removed] = this.#steeringQueue.splice(index, 1);
		return removed;
	}

	moveSteer(fromIndex: number, toIndex: number): boolean {
		return this.#moveQueuedMessage(this.#steeringQueue, fromIndex, toIndex);
	}

	/**
	 * Remove and return the last follow-up message from the queue (LIFO).
	 * Used by dequeue keybinding.
	 */
	popLastFollowUp(): AgentMessage | undefined {
		return this.#followUpQueue.pop();
	}
	removeFollowUpAt(index: number): AgentMessage | undefined {
		if (index < 0 || index >= this.#followUpQueue.length) return undefined;
		const [removed] = this.#followUpQueue.splice(index, 1);
		return removed;
	}

	moveFollowUp(fromIndex: number, toIndex: number): boolean {
		return this.#moveQueuedMessage(this.#followUpQueue, fromIndex, toIndex);
	}

	#moveQueuedMessage<T>(queue: T[], fromIndex: number, toIndex: number): boolean {
		if (fromIndex < 0 || fromIndex >= queue.length) return false;
		if (toIndex < 0 || toIndex >= queue.length) return false;
		if (fromIndex === toIndex) return true;
		const [item] = queue.splice(fromIndex, 1);
		if (item === undefined) return false;
		queue.splice(toIndex, 0, item);
		return true;
	}

	/**
	 * Remove queued steering/follow-up messages matching `predicate`, preserving
	 * order of the rest. `scope` restricts the removal to one queue.
	 */
	removeQueuedMessages(
		predicate: (message: AgentMessage) => boolean,
		scope: "both" | "steering" | "followUp" = "both",
	): {
		steering: number;
		followUp: number;
		total: number;
	} {
		const beforeSteering = this.#steeringQueue.length;
		const beforeFollowUp = this.#followUpQueue.length;
		if (scope !== "followUp") {
			this.#steeringQueue = this.#steeringQueue.filter(m => !predicate(m));
		}
		if (scope !== "steering") {
			this.#followUpQueue = this.#followUpQueue.filter(m => !predicate(m));
		}
		const steering = beforeSteering - this.#steeringQueue.length;
		const followUp = beforeFollowUp - this.#followUpQueue.length;
		return { steering, followUp, total: steering + followUp };
	}

	clearMessages() {
		this.#state.messages = [];
		this.#contextRevision++;
	}

	abort() {
		this.#abortController?.abort();
	}

	/**
	 * Force the current run out of the busy/streaming state when cooperative abort
	 * did not drain. The abandoned provider/tool stream may still settle later, so
	 * #runLoop guards every state mutation with a run id.
	 */
	forceAbort(reason = "Force aborted", logicalRunId?: ManagedLogicalRunId | number): boolean {
		const targetLogicalRunId = logicalRunId ?? this.#managedLogicalRunOwner ?? this.#activeRunId;
		const handle = targetLogicalRunId !== undefined ? this.#runHandles.get(targetLogicalRunId) : undefined;
		const runId = this.#activeRunId;
		const managedLogicalRunId = this.#managedLogicalRunOwner;
		const activeLogicalRunId = managedLogicalRunId ?? runId;
		if (
			targetLogicalRunId !== undefined &&
			activeLogicalRunId !== undefined &&
			activeLogicalRunId !== targetLogicalRunId
		) {
			throw new Error(`forceAbort: logicalRunId ${targetLogicalRunId} does not match the active run`);
		}
		const activeResourceDomain = this.#activeResourceCancellationDomain;
		const activeResourceRunId = this.#activeResourceRunId;
		const hadActiveRun = runId !== undefined && (this.#runningPrompt !== undefined || this.#state.isStreaming);
		if (!hadActiveRun) return false;

		this.#abortController?.abort(reason);
		this.#continuationGeneration++;
		this.#attemptAuthority.advanceMain();
		this.#state.isStreaming = false;
		this.#state.streamMessage = null;
		this.#state.pendingToolCalls = new Set<string>();
		this.#abortController = undefined;
		this.#cursorToolResultBuffer = [];
		this.#managedLogicalRunOwner = undefined;

		const resolve = this.#resolveRunningPrompt;
		this.#runningPrompt = undefined;
		this.#resolveRunningPrompt = undefined;
		this.#activeRunId = undefined;
		this.#activeResourceRunId = undefined;
		this.#activeResourceCancellationDomain = undefined;
		resolve?.();
		this.#finalizeRun(
			activeLogicalRunId ?? runId!,
			{
				type: "agent_end",
				messages: [],
				stopReason: "cancelled",
				scope: handle?.scope,
			},
			undefined,
			activeResourceDomain,
		);
		if (activeResourceRunId) this.resourceLedger.quarantine(activeResourceRunId);
		return true;
	}

	waitForIdle(): Promise<void> {
		return this.#runningPrompt ?? Promise.resolve();
	}

	/** The active per-attempt run identifier. */
	get activeRunId(): number | undefined {
		return this.#activeRunId;
	}
	/** Stable resource ownership identifier for the active prompt run. */
	get activeResourceRunId(): string | undefined {
		return this.#activeResourceRunId;
	}

	/**
	 * Stable identifier for the active managed logical run, shared by every retry
	 * attempt. Pass this value to requestRunTerminal(); never retain activeRunId
	 * for managed terminal completion.
	 */
	get currentManagedLogicalRunId(): ManagedLogicalRunId | undefined {
		return this.#managedLogicalRunOwner;
	}

	/**
	 * Request terminal completion through the single logical-run keyed finalizer.
	 *
	 * For managed runs, logicalRunId must be currentManagedLogicalRunId from any
	 * attempt in the retry chain. Non-managed runs use their activeRunId. Terminal
	 * requests with messages emit a committed message_start/message_end lifecycle
	 * for each diagnostic before agent_end. Requests without messages (such as
	 * cancellation) emit only agent_end.
	 */
	requestRunTerminal(logicalRunId: ManagedLogicalRunId, request: RunTerminalRequest): boolean {
		if (this.#terminalizedLogicalRunIds.has(logicalRunId)) return false;
		const handle = this.#runHandles.get(logicalRunId);
		if (!handle) throw new Error(`requestRunTerminal: unknown logicalRunId ${logicalRunId} (no attempt handle)`);
		if (this.#managedLogicalRunOwner === logicalRunId) {
			this.#managedLogicalRunOwner = undefined;
		}
		this.#finalizeRun(
			logicalRunId,
			{
				type: "agent_end",
				messages: request.messages ?? [],
				...(request.stopReason === "cancelled" ? { stopReason: "cancelled" as const } : {}),
				scope: handle.scope,
			},
			() => {
				for (const message of request.messages ?? []) {
					this.#emit({ type: "message_start", message });
					this.appendMessage(message);
					this.#emit({ type: "message_end", message });
				}
			},
		);
		return true;
	}

	reset() {
		this.#state.messages = [];
		this.#contextRevision++;
		this.#state.isStreaming = false;
		this.#state.streamMessage = null;
		this.#state.pendingToolCalls = new Set<string>();
		this.#managedLogicalRunOwner = undefined;
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

		assertUserImagePlaceholdersHavePayload(msgs);
		if (this.#managedLogicalRunOwner !== undefined) {
			this.requestRunTerminal(this.#managedLogicalRunOwner, { stopReason: "cancelled" });
			this.#managedLogicalRunOwner = undefined;
		}

		await this.#runLoop(msgs, promptOptions);
	}

	/**
	 * Continue from current context (used for retries and resuming queued messages).
	 */
	async continue(options?: AgentPromptOptions) {
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
				await this.#runLoop(queuedSteering, {
					...options,
					skipInitialSteeringPoll: true,
					consumedQueuedMessages: queuedSteering,
				});
				return;
			}

			const queuedFollowUp = this.#dequeueFollowUpMessages();
			if (queuedFollowUp.length > 0) {
				// Route the DIRECT-dequeue batch through the same consumption hook
				// the in-loop getFollowUpMessages path uses: denied owned-completion
				// envelopes are filtered before they reach the loop, and delivered
				// envelopes settle their registrations — the direct path otherwise
				// bypasses onFollowUpConsumed entirely (review threads P1/P2). A
				// maintenanceContinuation resumes the existing logical run (no new
				// agent_start), so its batch is in-run consumption, not an own-run
				// promotion (#4668 review P1).
				await this.onFollowUpConsumed?.(queuedFollowUp, {
					startsOwnRun: options?.maintenanceContinuation !== true,
				});
				// The hook can filter the WHOLE batch (every entry denied by a
				// scope:"owned" abort): starting an empty provider run would
				// violate the zero-final-call guarantee, so return without
				// running the loop (review thread P1).
				if (queuedFollowUp.length === 0) return;
				await this.#runLoop(queuedFollowUp, { ...options, consumedQueuedMessages: queuedFollowUp });
				return;
			}

			throw new Error("Cannot continue from message role: assistant");
		}

		if (!canContinuePersistedHistory(messages)) {
			throw new Error("No messages to continue from");
		}

		await this.#runLoop(undefined, options);
	}
	/**
	 * Continue by consuming queued steering/follow-up messages without replaying
	 * the current non-assistant tail.
	 */
	async continueQueuedMessages(options?: AgentPromptOptions): Promise<void> {
		if (this.#state.isStreaming) {
			throw new AgentBusyError();
		}
		const queuedSteering = this.#dequeueSteeringMessages();
		if (queuedSteering.length > 0) {
			await this.#runLoop(queuedSteering, {
				...options,
				skipInitialSteeringPoll: true,
				consumedQueuedMessages: queuedSteering,
			});
			return;
		}
		const queuedFollowUp = this.#dequeueFollowUpMessages();
		if (queuedFollowUp.length > 0) {
			// Route the queued-tail batch through the same consumption hook as the
			// in-loop getFollowUpMessages path and the assistant-tail continue()
			// path: denied owned-completion envelopes are filtered before they
			// reach the loop, and delivered envelopes settle their registrations.
			// A terminal abort that leaves a tool/result tail and rearms an
			// authorized owned-completion follow-up reaches this branch, so
			// bypassing the hook would leak every such job's ownership tuple and
			// eventually exhaust the bounded ownership registries (review thread
			// P2). A maintenanceContinuation resumes the existing logical run (no
			// new agent_start), so its batch is in-run consumption, not an own-run
			// promotion (#4668 review P1).
			await this.onFollowUpConsumed?.(queuedFollowUp, {
				startsOwnRun: options?.maintenanceContinuation !== true,
			});
			// The hook can filter the WHOLE batch (every entry denied by a
			// scope:"owned" abort): starting an empty provider run would violate
			// the zero-final-call guarantee, so return without running the loop
			// (review thread P2).
			if (queuedFollowUp.length === 0) return;
			await this.#runLoop(queuedFollowUp, { ...options, consumedQueuedMessages: queuedFollowUp });
			return;
		}
		throw new Error("No queued messages to continue");
	}

	/**
	 * Run the agent loop.
	 * If messages are provided, starts a new conversation turn with those messages.
	 * Otherwise, continues from existing context.
	 */
	async #runLoop(
		messages?: AgentMessage[],
		options?: AgentPromptOptions & {
			skipInitialSteeringPoll?: boolean;
			consumedQueuedMessages?: readonly AgentMessage[];
		},
	) {
		const model = this.#state.model;
		if (!model) throw new Error("No model configured");

		const maintenanceContinuation = options?.maintenanceContinuation === true;
		if (maintenanceContinuation && this.#managedLogicalRunOwner === undefined) {
			throw new Error("Maintenance continuation ownership is unavailable");
		}
		let skipInitialSteeringPoll = options?.skipInitialSteeringPoll === true;

		const { promise, resolve } = Promise.withResolvers<void>();
		this.#runningPrompt = promise;
		this.#resolveRunningPrompt = resolve;

		const runId = ++this.#runSequence;
		const continuationGeneration = ++this.#continuationGeneration;
		this.#activeRunId = runId;
		const abortController = new AbortController();
		this.#abortController = abortController;
		this.#state.isStreaming = true;
		this.#state.streamMessage = null;
		this.#state.error = undefined;

		const fallbackManaged = options?.fallbackManaged === true;
		const managedLogicalRunOwner = fallbackManaged
			? (this.#managedLogicalRunOwner ?? runId)
			: maintenanceContinuation
				? this.#managedLogicalRunOwner
				: undefined;
		const continuesLogicalRun = fallbackManaged || maintenanceContinuation;
		const startsManagedLogicalRun = fallbackManaged && this.#managedLogicalRunOwner === undefined;
		this.#activeResourceRunId = String(managedLogicalRunOwner ?? runId);
		this.#activeResourceCancellationDomain = this.resourceLedger.open(this.#activeResourceRunId);
		if (!this.#activeResourceCancellationDomain) {
			this.#state.isStreaming = false;
			this.#abortController = undefined;
			this.#activeRunId = undefined;
			this.#activeResourceRunId = undefined;
			this.#activeResourceCancellationDomain = undefined;
			this.#runningPrompt = undefined;
			this.#resolveRunningPrompt = undefined;
			resolve();
			throw new Error("Prompt resource cancellation domain is unavailable");
		}
		const logicalRunId = managedLogicalRunOwner ?? runId;
		const scope = this.#attemptAuthority.mintMain();
		this.#observeMainAttemptScope(scope);
		const handle: AttemptRunHandle = { logicalRunId, scope };
		this.#runHandles.set(logicalRunId, handle);
		options?.onRunAccepted?.(handle, {
			consumedQueuedMessages: options.consumedQueuedMessages ?? [],
		});
		if (startsManagedLogicalRun) {
			this.#managedLogicalRunOwner = logicalRunId;
			this.#emit({ type: "agent_start", scope });
		}
		if (fallbackManaged && this.#cursorToolResultBuffer.length > 0) {
			const error = new ManagedCursorInvariantError(
				"Managed Cursor attempt started with buffered provider-side tool results",
			);
			this.#state.isStreaming = false;
			this.#abortController = undefined;
			this.#activeRunId = undefined;
			this.#activeResourceRunId = undefined;
			this.#activeResourceCancellationDomain = undefined;
			this.#runningPrompt = undefined;
			this.#resolveRunningPrompt = undefined;
			resolve();
			this.requestRunTerminal(managedLogicalRunOwner ?? runId, { stopReason: "error" });
			this.#managedLogicalRunOwner = undefined;
			throw error;
		}
		// Each run gets a fresh buffer only after managed stale-state validation.
		this.#cursorToolResultBuffer = [];

		const reasoning = this.#state.thinkingLevel;
		const context: AgentContext = {
			systemPrompt: this.#state.systemPrompt,
			messages: this.#state.messages.slice(),
			tools: this.#state.tools,
		};
		// Cursor can execute native tools inside one remote turn, then return
		// `turnEnded` without another model request. Remember a Composer policy
		// rejection until the loop reaches that safe continuation boundary.
		let cursorComposerBashRecoveryPending = false;
		let cursorComposerBashRecoveryAttempted = false;

		const cursorOnToolResult =
			!fallbackManaged && (this.#cursorExecHandlers || this.#cursorOnToolResult)
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
						if (isCursorComposerBashPolicyBlockedResult(finalMessage)) {
							cursorComposerBashRecoveryPending = true;
						} else if (
							cursorComposerBashRecoveryPending &&
							isSuccessfulCursorNativeRepositoryToolResult(finalMessage)
						) {
							// The same remote turn already replanned through a native tool,
							// so do not create a redundant local continuation afterward.
							cursorComposerBashRecoveryPending = false;
						}
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
		const cursorExecHandlers = fallbackManaged ? undefined : this.#cursorExecHandlersForRun(runId);
		let managedDecision: ManagedAttemptDecision | undefined;
		let managedOutcome: ManagedAttemptOutcome | undefined;
		let maintenanceInterrupted = false;

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
			toolInterruptPolicy: this.#toolInterruptPolicy,
			sessionId: this.#sessionId,
			providerSessionId: this.#providerSessionId,
			metadata: this.#metadataResolver ? undefined : this.#metadata,
			metadataResolver: this.#metadataResolver,
			providerSessionState: this.#providerSessionState,
			thinkingBudgets: this.#thinkingBudgets,
			maxRetryDelayMs: this.#maxRetryDelayMs,
			requestMaxRetries: this.#requestMaxRetries,
			streamMaxRetries: this.#streamMaxRetries,
			streamFirstEventTimeoutMs: this.#streamFirstEventTimeoutMs,
			...(fallbackManaged
				? {
						fallbackManaged: true,
						nextFallbackAttempt: options?.nextFallbackAttempt,
						onManagedAttemptAccepted: options?.onManagedAttemptAccepted,
						onManagedAttemptOutcome: async outcome => {
							managedOutcome = outcome;
							managedDecision = (await options?.onManagedAttemptOutcome?.(outcome)) ?? {
								type: "terminal",
								terminal: { stopReason: outcome.type === "run_terminal" ? outcome.reason : "error" },
							};
							return managedDecision;
						},
					}
				: {}),
			kimiApiFormat: this.#kimiApiFormat,
			preferWebsockets: this.#preferWebsockets,
			convertToLlm: this.#convertToLlm,
			transformContext: this.#transformContext,
			attemptMinter: {
				mint: () => {
					const scope = this.#attemptAuthority.mintMain();
					this.#observeMainAttemptScope(scope);
					return scope;
				},
			},
			initialScope: scope,
			onPayload: this.#onPayload,
			onResponse: this.#onResponse,
			onSseEvent: this.#onSseEvent,
			signal: abortController.signal,
			resourceLedger: this.resourceLedger,
			resourceRunId: this.#activeResourceRunId,
			resourceCancellationDomain: this.#activeResourceCancellationDomain,
			resourceSealOwner: "caller",
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
			...(cursorExecHandlers ? { cursorExecHandlers } : {}),
			...(cursorOnToolResult ? { cursorOnToolResult } : {}),
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
			onAssistantMessageEvent: (message, event) => {
				if (this.#activeRunId !== runId) return;
				this.#onAssistantMessageEvent?.(message, event);
			},
			onProvisionalAssistantMessageEvent: (message, event) => {
				if (this.#activeRunId !== runId) return;
				this.#state.streamMessage = message;
				this.#onProvisionalAssistantMessageEvent?.(message, event);
			},
			hasProvisionalAssistantMessageEventConsumer: this.#onProvisionalAssistantMessageEvent !== undefined,
			onToolChoiceIncapability: this.#onToolChoiceIncapability
				? event => {
						if (this.#activeRunId !== runId) return;
						this.#onToolChoiceIncapability?.(event);
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
				// Fenced: yield nothing and dequeue nothing, so a steer submitted while a
				// fold is being claimed is not consumed by the run being wound down. It
				// is not lost either: the terminal disowns it to the owner.
				if (this.#steeringAdmissionFence?.() === true) {
					return [];
				}
				// An aborted run cannot deliver steering: the loop hands drained
				// messages back and ends. Dequeuing here would fire the in-run
				// consumption hook for a message the run never delivers, so its SDK
				// submission would settle as consumed instead of removed at disown.
				if (abortController.signal.aborted) {
					return [];
				}
				const queued = this.#dequeueSteeringMessages();
				if (this.#activeRunId !== runId) {
					this.#steeringQueue = [...queued, ...this.#steeringQueue];
					return [];
				}
				// Mid-run consumption into the CURRENT turn: the batch never starts
				// its own run (#4668).
				if (queued.length > 0) await this.onSteeringConsumed?.(queued, { startsOwnRun: false });
				return queued;
			},
			requeueSteeringMessages: (messages: AgentMessage[]) => {
				if (messages.length === 0) return;
				this.#steeringQueue = [...messages, ...this.#steeringQueue];
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
				if (queued.length > 0) {
					await this.onFollowUpConsumed?.(queued, { startsOwnRun: false });
				}
				return queued;
			},
			getSyntheticRecoveryMessage: async () => {
				if (
					this.#activeRunId !== runId ||
					!cursorComposerBashRecoveryPending ||
					cursorComposerBashRecoveryAttempted
				) {
					return undefined;
				}
				cursorComposerBashRecoveryPending = false;
				cursorComposerBashRecoveryAttempted = true;
				return {
					role: "user",
					content: CURSOR_COMPOSER_BASH_POLICY_RECOVERY_PROMPT,
					synthetic: true,
					timestamp: Date.now(),
				};
			},
			onBeforeYield: async () => {
				if (this.#activeRunId !== runId) return;
				await this.#onBeforeYield?.();
			},
			shouldPause: () => {
				if (this.#activeRunId !== runId) return false;
				return this.#shouldPause?.() === true;
			},
			maintainContext: this.#maintainContext
				? async (context, lifecycle) => {
						if (this.#activeRunId !== runId) return "not-needed";
						return (await this.#maintainContext?.(context, lifecycle)) ?? "not-needed";
					}
				: undefined,
			transientRecoveryMessage: options?.transientRecoveryMessage,
			telemetry: this.#telemetry,
		};

		let partial: AgentMessage | null = null;

		try {
			const stream = messages
				? agentLoop(messages, context, config, abortController.signal, this.streamFn, !continuesLogicalRun, scope)
				: agentLoopContinue(context, config, abortController.signal, this.streamFn, !continuesLogicalRun, scope);

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
						if (fallbackManaged && this.#cursorToolResultBuffer.length > 0) {
							throw new ManagedCursorInvariantError();
						}
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
						if (fallbackManaged && managedOutcome) {
							continue;
						}
						this.#state.isStreaming = false;
						this.#state.streamMessage = null;
						// A maintenance checkpoint is only non-terminal while a committed rewrite
						// will continue. Failed or aborted maintenance yields none. Because the loop runs with
						// `resourceSealOwner: "caller"` it deliberately leaves sealing to us, so
						// treating it as a checkpoint here would leave the run open forever and make
						// every cancel report `run_not_sealed`.
						if (
							event.stopReason === "maintenance" &&
							isContinuingMidRunMaintenanceOutcome(event.maintenanceOutcome)
						) {
							this.#managedLogicalRunOwner ??= managedLogicalRunOwner ?? runId;
							maintenanceInterrupted = true;
							this.#emit(event);
							continue;
						}
						this.#finalizeRun(managedLogicalRunOwner ?? runId, event);
						continue;
				}

				// Emit to listeners
				this.#emit(event);
			}

			if (this.#activeRunId !== runId) {
				return;
			}
			if (managedOutcome) {
				if (managedDecision?.type === "terminal") {
					this.requestRunTerminal(managedLogicalRunOwner ?? runId, managedDecision.terminal);
				} else if (managedOutcome.type === "run_terminal") {
					this.requestRunTerminal(managedLogicalRunOwner ?? runId, { stopReason: managedOutcome.reason });
				} else if (managedDecision?.type !== "retry" && managedDecision?.type !== "maintenance") {
					this.#finalizeRun(managedLogicalRunOwner ?? runId);
				}
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
			const providerCode = providerFailureCode(err);
			const runtimeFailureCode = abortController.signal.aborted
				? "aborted"
				: (managedLocalErrorDiagnostic(err)?.errorKind ?? providerCode);
			const sanitized = sanitizeAgentFailure(err, runtimeFailureCode);
			const errorName = safeErrorName(err);

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
				errorMessage: sanitized.message,
				errorCode: sanitized.code,
				...(errorName ? { errorName } : {}),
				errorStatus: safeErrorStatus(err),
				// Local-diagnostic authority (`errorKind` + structured
				// `bufferOverflow`) comes from ONE identity check: a foreign error
				// that self-declares a local kind gets neither field, so the parent
				// receipt never misattributes a provider/stream failure to the local
				// staging machinery (#4618).
				...(managedLocalErrorDiagnostic(err) ?? {}),
				timestamp: Date.now(),
			} as AgentMessage;

			// Store the sanitized message only: the raw provider error may carry request
			// bodies, credentials, or tokens (exact-head review P1).
			this.#state.error = sanitizeAgentFailure(err).message;
			this.#emit({
				type: "agent_failed",
				// Runtime-authenticated classifiers only: abort comes from the
				// signal, and a local staging failure comes from the identity-
				// checked managedLocalErrorDiagnostic — a foreign error that
				// self-declares a local kind still maps to agent_failed.
				error: sanitizeAgentFailure(err, runtimeFailureCode),
				scope: handle.scope,
			});
			this.requestRunTerminal(managedLogicalRunOwner ?? runId, {
				stopReason: abortController.signal.aborted ? "cancelled" : "error",
				messages: [errorMsg],
			});
		} finally {
			let continuation: ManagedAttemptContinuation | undefined;
			if (
				managedOutcome?.type !== "run_terminal" &&
				(managedDecision?.type === "retry" || managedDecision?.type === "maintenance")
			) {
				continuation = managedDecision.continuation;
			}
			const domain = this.#activeResourceCancellationDomain;
			const continuationReservation =
				continuation && domain
					? this.resourceLedger.reserveProducer(
							String(managedLogicalRunOwner ?? runId),
							domain,
							"post_prompt",
							"managed-continuation",
						)
					: undefined;
			if (continuation && !continuationReservation?.ok) {
				this.requestRunTerminal(managedLogicalRunOwner ?? runId, { stopReason: "error" });
				continuation = undefined;
			}
			const ownership: ManagedAttemptContinuationOwnership | undefined = continuationReservation?.ok
				? {
						runId,
						logicalRunId: managedLogicalRunOwner ?? runId,
						generation: continuationGeneration,
						domain: continuationReservation.lease.domain,
						lease: continuationReservation.lease,
						handle,
						isCurrent: () =>
							this.#continuationGeneration === continuationGeneration && this.#activeRunId === undefined,
					}
				: undefined;
			if (this.#activeRunId === runId) {
				this.#state.isStreaming = false;
				this.#state.streamMessage = null;
				this.#state.pendingToolCalls = new Set<string>();
				this.#abortController = undefined;
				this.#activeRunId = undefined;
				this.#activeResourceRunId = undefined;
				this.#activeResourceCancellationDomain = undefined;
				this.#resolveRunningPrompt?.();
				this.#runningPrompt = undefined;
				this.#resolveRunningPrompt = undefined;
			}
			if (
				continuesLogicalRun &&
				!continuation &&
				!maintenanceInterrupted &&
				this.#managedLogicalRunOwner === managedLogicalRunOwner
			) {
				this.#managedLogicalRunOwner = undefined;
			}
			if (continuation && ownership?.isCurrent()) {
				try {
					await continuation(ownership);
					if (
						managedDecision?.type === "maintenance" &&
						this.#terminalizedLogicalRunIds.has(managedLogicalRunOwner ?? runId) &&
						this.#managedLogicalRunOwner === managedLogicalRunOwner
					) {
						this.#managedLogicalRunOwner = undefined;
					}
					if (
						managedDecision?.type !== "maintenance" &&
						this.#activeRunId === undefined &&
						this.#managedLogicalRunOwner === managedLogicalRunOwner
					) {
						this.#managedLogicalRunOwner = undefined;
					}
				} catch (err) {
					if (ownership.isCurrent()) {
						this.#state.error = sanitizeAgentFailure(err).message;
						// The documented contract emits the sanitized diagnostic
						// before the error terminal on this path too (exact-head
						// review P2).
						this.#emit({ type: "agent_failed", error: sanitizeAgentFailure(err) });
						this.requestRunTerminal(managedLogicalRunOwner ?? runId, { stopReason: "error" });
						if (this.#managedLogicalRunOwner === managedLogicalRunOwner) this.#managedLogicalRunOwner = undefined;
					}
				} finally {
					ownership.lease.closeDiscovery();
				}
			}
		}
	}

	#emit(e: AgentEvent) {
		for (const listener of this.#listeners) {
			try {
				listener(e);
			} catch (error) {
				// Listener isolation (exact-head review P1): a throwing subscriber
				// must never abort the emitting control path — in particular the
				// failure catch that publishes agent_failed and then MUST reach its
				// agent_end terminal boundary. An observer failure is logged as
				// diagnostic data and never rethrown into the run loop.
				console.warn("[pi-agent] event listener threw; swallowing:", sanitizeAgentFailure(error));
			}
		}
	}

	/** Calculate total text length from an assistant message's content blocks */
	#finalizeRun(
		logicalRunId: ManagedLogicalRunId,
		event?: Extract<AgentEvent, { type: "agent_end" }>,
		beforeEvent?: () => void,
		knownDomain?: RunCancellationDomain,
	): void {
		if (this.#terminalizedLogicalRunIds.has(logicalRunId)) return;
		const handle = this.#runHandles.get(logicalRunId);
		if (!handle && !event?.scope) {
			throw new Error(`finalizeRun: unknown logicalRunId ${logicalRunId} (no attempt handle)`);
		}
		const resourceRunId = String(logicalRunId);
		const boundDomain = this.resourceLedger.lookupDomain(resourceRunId);
		const domain = boundDomain ?? knownDomain;
		const terminalReservation = boundDomain
			? this.resourceLedger.reserveProducer(resourceRunId, boundDomain, "post_prompt", "terminal-publication")
			: undefined;
		this.#terminalizedLogicalRunIds.add(logicalRunId);
		if (this.#terminalizedLogicalRunIds.size > 256) {
			this.#terminalizedLogicalRunIds.delete(this.#terminalizedLogicalRunIds.values().next().value!);
		}
		const terminalEvent: Extract<AgentEvent, { type: "agent_end" }> = event ?? {
			type: "agent_end",
			messages: [],
			scope: handle?.scope,
		};
		if (handle) terminalEvent.scope = handle.scope;
		// The run is over: nothing will poll the steering queue again. Disown
		// whatever it still holds — unconditionally, so no ownership exception can
		// leave an ended run's steering behind for an unrelated run to consume —
		// and hand it to the owner on the terminal event to re-route, hold, or
		// drop exactly once.
		if (this.#steeringQueue.length > 0) {
			terminalEvent.disownedSteering = this.#steeringQueue;
			this.#steeringQueue = [];
		}
		if (domain) {
			setAgentTerminalOwnerContext(terminalEvent, {
				resourceRunId,
				domain,
			});
		}
		try {
			beforeEvent?.();
			this.#emit(terminalEvent);
		} finally {
			try {
				terminalReservation?.ok && terminalReservation.lease.closeDiscovery();
			} finally {
				try {
					this.resourceLedger.seal(resourceRunId);
				} finally {
					this.#runHandles.delete(logicalRunId);
				}
			}
		}
	}

	#getAssistantTextLength(message: AgentMessage | null): number {
		if (message?.role !== "assistant" || !Array.isArray(message.content)) {
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
