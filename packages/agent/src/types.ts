import type {
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Effort,
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	Static,
	streamSimple,
	TextContent,
	Tool,
	ToolChoice,
	ToolResultMessage,
	TransportFailureFacts,
	TSchema,
	UserMessage,
} from "@gajae-code/ai";
import type { AppendOnlyContextManager } from "./append-only-context";
import type { AttemptMinter, AttemptRunHandle, AttemptScope } from "./attempt-scope";
import type { HarmonyAuditEvent } from "./harmony-leak";
import type { AgentRunCoverage, AgentRunSummary } from "./run-collector";
import type { AgentTelemetryConfig } from "./telemetry";

/** Stream function - can return sync or Promise for async config lookup */
export type StreamFn = (
	...args: Parameters<typeof streamSimple>
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

/**
 * Request context supplied to provider-aware metadata resolvers.
 *
 * The model is the exact model selected for the concrete request (including
 * fallback and ephemeral requests), while `transport` distinguishes the
 * built-in stream path from a caller-supplied stream function. Metadata that
 * carries provider identity must use both values to fail closed when routing
 * is not the canonical provider path.
 */
export interface AgentMetadataResolverContext {
	provider: string;
	model?: Model;
	transport?: "default" | "custom";
}

/** Stable identifier for a managed logical run, shared by all of its retry attempts. */
export type ManagedLogicalRunId = number;
/** A resource owned by a prompt run until its promise settles. */
export type RunResourceKind = "provider_factory" | "provider_iterator" | "tool" | "post_prompt";

export interface RunResourceEntry {
	id: string;
	kind: RunResourceKind;
	label: string;
	registeredAt: number;
}

export type RunSettlementReason = "unknown_run" | "run_not_sealed" | "resources_pending" | "quarantined";
export type RunSettlementProof =
	| { status: "settled" }
	| { status: "unfenced"; reason: RunSettlementReason; pending: RunResourceEntry[] };

export interface RunCancellationDomain {
	readonly resourceRunId: string;
	readonly signal: AbortSignal;
}

export interface RunCancellationDomainBridge {
	open(
		resourceRunId: string,
	):
		| { ok: true; domain: RunCancellationDomain; created: boolean }
		| { ok: false; reason: "duplicate_identity" | "quarantined" };
	lookup(resourceRunId: string): RunCancellationDomain | undefined;
	abort(
		resourceRunId: string,
		reason?: unknown,
	): { ok: true; newlyAborted: boolean } | { ok: false; reason: "unknown_run" | "quarantined" };
	release(resourceRunId: string, disposition: "settled" | "quarantined"): void;
}

export type ReserveProducerResult =
	| { ok: true; lease: RunResourceProducerLease }
	| { ok: false; reason: "unknown_run" | "sealed" | "quarantined" | "domain_mismatch" };
export type ClaimProducerResult =
	| { ok: true; lease: RunResourceProducerLease }
	| { ok: false; reason: "already_claimed" | "handle_mismatch" | "domain_mismatch" | "closed" | "quarantined" };
export type ForkProducerResult =
	| { ok: true; lease: RunResourceProducerLease }
	| { ok: false; reason: "parent_closed" | "quarantined" | "domain_mismatch" };

export interface RunResourceProducerLease {
	readonly resourceRunId: string;
	readonly domain: RunCancellationDomain;
	readonly signal: AbortSignal;
	track(kind: RunResourceKind, label: string, settled: PromiseLike<unknown>): boolean;
	fork(expectedDomain: RunCancellationDomain, kind: RunResourceKind, label: string): ForkProducerResult;
	closeDiscovery(): void;
}

export interface AgentTerminalOwnerContext {
	readonly resourceRunId: string;
	readonly domain: RunCancellationDomain;
}

const terminalOwnerContexts = new WeakMap<object, AgentTerminalOwnerContext>();

export function setAgentTerminalOwnerContext(event: object, context: AgentTerminalOwnerContext): void {
	terminalOwnerContexts.set(event, context);
}

export function getAgentTerminalOwnerContext(event: object): AgentTerminalOwnerContext | undefined {
	return terminalOwnerContexts.get(event);
}
export interface StandaloneRunOwnership {
	readonly resourceRunId: string;
	readonly domain: RunCancellationDomain;
	claimContinuation():
		| { ok: true; ownership: StandaloneRunOwnership }
		| { ok: false; reason: "already_claimed" | "terminal" | "quarantined" };
	abandon(reason: "cancelled" | "error"): void;
}

export interface RunResourceLedger {
	/** Bind the bridge once, before any logical run may be opened. */
	bindCancellationDomainBridge(bridge: RunCancellationDomainBridge): void;
	/** Bind the unforgeable AgentSession claim key once, before terminal publication. */
	bindAgentSessionClaimKey(key: object): void;
	/** Reserve a run handle before publishing its `agent_start` event. */
	open(resourceRunId: string): RunCancellationDomain | undefined;
	lookupDomain(resourceRunId: string): RunCancellationDomain | undefined;
	reserveProducer(
		resourceRunId: string,
		expectedDomain: RunCancellationDomain | undefined,
		kind: RunResourceKind,
		label: string,
	): ReserveProducerResult;
	claimProducer(
		resourceRunId: string,
		expectedDomain: RunCancellationDomain | undefined,
		ownerKey: object,
	): ClaimProducerResult;
	track(resourceRunId: string, kind: RunResourceKind, label: string, settled: PromiseLike<unknown>): void;
	pending(resourceRunId: string): RunResourceEntry[];
	/** Seal a run after terminal event publication; only sealed empty runs settle. */
	seal(resourceRunId: string): void;
	waitForSettlement(resourceRunId: string, options: { graceMs: number }): Promise<RunSettlementProof>;
	/** Terminally detach a run; its bounded tombstone remains unfenced forever. */
	quarantine(resourceRunId: string): RunResourceEntry[];
}

/** Terminal completion requested for a logical run. */
export interface RunTerminalRequest {
	stopReason: "cancelled" | "error" | "exhausted";
	messages?: AgentMessage[];
}

/**
 * Ownership token supplied when Agent invokes a retry continuation.
 *
 * A continuation MUST verify `isCurrent()` immediately before starting a
 * follow-up invocation and abandon the retry when it returns false. The token
 * becomes invalid when its originating run is force-aborted or superseded.
 * Coding-agent retry continuations must accept this argument and must not call
 * `agent.continue()` after ownership has been lost.
 */
export interface ManagedAttemptContinuationOwnership {
	/** Per-attempt run-loop id; use only for attempt-local ownership checks. */
	readonly runId: number;
	/** Stable managed logical-run id; use for all terminal completion requests. */
	readonly logicalRunId: ManagedLogicalRunId;
	readonly generation: number;
	readonly domain: RunCancellationDomain;
	readonly lease: RunResourceProducerLease;
	/** Immutable per-attempt handle used by terminalizers and continuations. */
	readonly handle: AttemptRunHandle;
	isCurrent(): boolean;
}

/** Runs after a discarded attempt is idle, only while its ownership token remains current. */
export type ManagedAttemptContinuation = (ownership: ManagedAttemptContinuationOwnership) => void | Promise<void>;

/** Decision returned by managed fallback policy for one provisional attempt. */
export type ManagedAttemptDecision =
	| { type: "retry"; continuation: ManagedAttemptContinuation }
	| { type: "maintenance"; continuation: ManagedAttemptContinuation }
	| { type: "terminal"; terminal: RunTerminalRequest };

/** Structured result for one managed upstream invocation. */
export type ManagedAttemptOutcome =
	| {
			type: "retryable_discarded";
			failure: {
				message: AssistantMessage;
				/** Exact provider transport facts, including retry headers, for fallback policy. */
				transportFailure?: TransportFailureFacts;
			};
			scope?: AttemptScope;
	  }
	| {
			type: "escaped_arguments_discarded";
			/** The defective assistant turn; already removed from usable history by the loop. */
			message: AssistantMessage;
			scope?: AttemptScope;
	  }
	| { type: "context_overflow_discarded"; message: AssistantMessage; scope?: AttemptScope }
	| { type: "run_terminal"; reason: "cancelled" | "error" | "exhausted"; scope?: AttemptScope };

export type ManagedAttemptOutcomeHandler = (
	outcome: ManagedAttemptOutcome,
) => ManagedAttemptDecision | Promise<ManagedAttemptDecision>;

/**
 * Outcome of a cooperative mid-run context-maintenance checkpoint (see
 * {@link AgentLoopConfig.maintainContext}). Any value other than "not-needed"
 * means the checkpoint mutated (or attempted to mutate) durable context, so the
 * loop ends the current run without the lossy `agent_end` finalization and the
 * maintenance owner resumes the run on the rewritten context.
 */
export type MidRunMaintenanceOutcome = "not-needed" | "pruned" | "compacted" | "promoted" | "failed" | "aborted";

export interface ContextMaintenanceResult {
	outcome: MidRunMaintenanceOutcome;
	releaseCurrentContext?: boolean;
}

/**
 * Configuration for the agent loop.
 */
export interface AgentLoopConfig extends SimpleStreamOptions {
	model: Model;
	/**
	 * Supplies a fresh opaque token at each concrete managed transport invocation.
	 * The callback runs at the stream boundary so controller accounting matches
	 * upstream request count, including multi-step tool turns.
	 */
	nextFallbackAttempt?: (model: Model) => SimpleStreamOptions["fallbackAttempt"];
	/** Called after a managed upstream request is accepted and committed. */
	onManagedAttemptAccepted?: () => void | Promise<void>;

	/** Receives a managed invocation outcome without publishing provisional lifecycle events. */
	onManagedAttemptOutcome?: ManagedAttemptOutcomeHandler;
	/** Per-attempt scope allocator for direct loop callers. */
	attemptMinter?: AttemptMinter;
	/** Scope allocated by the owning Agent for the first attempt in this loop. */
	initialScope?: AttemptScope;

	/**
	 * When to interrupt tool execution for steering messages.
	 * - "immediate" = check after each tool call (default)
	 * - "wait" = defer steering until the current turn completes
	 */
	interruptMode?: "immediate" | "wait";

	/**
	 * Optional session identifier forwarded to LLM providers.
	 * Used by providers that support session-based caching (e.g., OpenAI code provider).
	 */
	sessionId?: string;
	/**
	 * Optional provider-facing cache/session affinity identifier. When set, this
	 * is forwarded to providers as StreamOptions.sessionId while `sessionId`
	 * remains the logical agent conversation id for telemetry/metadata.
	 */
	providerSessionId?: string;

	/**
	 * Optional resolver called per LLM request to produce request metadata.
	 * When set, the agent loop evaluates it **after** `getApiKey` resolves the
	 * session-sticky credential, ensuring the metadata's `account_uuid` reflects
	 * the credential actually used for the request (not the credential that was
	 * current when `AgentLoopConfig` was first constructed). Overrides the static
	 * `metadata` field when present.
	 */
	metadataResolver?: (context: AgentMetadataResolverContext) => Record<string, unknown> | undefined;

	/**
	 * Converts AgentMessage[] to LLM-compatible Message[] before each LLM call.
	 *
	 * Each AgentMessage must be converted to a UserMessage, AssistantMessage, or ToolResultMessage
	 * that the LLM can understand. AgentMessages that cannot be converted (e.g., UI-only notifications,
	 * status messages) should be filtered out.
	 *
	 * @example
	 * ```typescript
	 * convertToLlm: (messages) => messages.flatMap(m => {
	 *   if (m.role === "custom") {
	 *     // Convert custom message to user message
	 *     return [{ role: "user", content: m.content, timestamp: m.timestamp }];
	 *   }
	 *   if (m.role === "notification") {
	 *     // Filter out UI-only messages
	 *     return [];
	 *   }
	 *   // Pass through standard LLM messages
	 *   return [m];
	 * })
	 * ```
	 */
	convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;

	/**
	 * Optional transform applied to the context before `convertToLlm`.
	 *
	 * Use this for operations that work at the AgentMessage level:
	 * - Context window management (pruning old messages)
	 * - Injecting context from external sources
	 *
	 * @example
	 * ```typescript
	 * transformContext: async (messages) => {
	 *   if (estimateTokens(messages) > MAX_TOKENS) {
	 *     return pruneOldMessages(messages);
	 *   }
	 *   return messages;
	 * }
	 * ```
	 */
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal, scope?: AttemptScope) => Promise<AgentMessage[]>;

	/**
	 * Resolves an API key dynamically for each LLM call.
	 *
	 * Useful for short-lived OAuth tokens (e.g., GitHub Copilot) that may expire
	 * during long-running tool execution phases.
	 */
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;

	/** Returns the credential type selected by the most recent getApiKey call for this session/provider. */
	getAuthCredentialType?: (provider: string) => "api_key" | "oauth" | undefined;

	/**
	 * Returns steering messages to inject into the conversation mid-run.
	 *
	 * Called after each tool execution to check for user interruptions unless interruptMode is "wait".
	 * If messages are returned, remaining tool calls are skipped and
	 * these messages are added to the context before the next LLM call.
	 */
	getSteeringMessages?: () => Promise<AgentMessage[]>;

	/**
	 * Returns steering messages that were dequeued for this run but cannot be
	 * delivered by it, so the next run can pick them up.
	 *
	 * A user interrupt that lands while a tool is executing aborts the run's
	 * signal without ending the loop: the loop still unwinds the tool and reaches
	 * its steering drain. Continuing there would start a turn on an already
	 * aborted signal, which the provider call rejects before the first token, so
	 * the loop hands the messages back instead and ends the run.
	 */
	requeueSteeringMessages?: (messages: AgentMessage[]) => void;

	/**
	 * Returns follow-up messages to process after the agent would otherwise stop.
	 *
	 * Called when the agent has no more tool calls and no steering messages.
	 * If messages are returned, they're added to the context and the agent
	 * continues with another turn.
	 */
	getFollowUpMessages?: () => Promise<AgentMessage[]>;
	/**
	 * Invoked with the follow-up messages the loop dequeues for the next turn
	 * (right after {@link getFollowUpMessages}). The consumer may use this to
	 * attach per-turn state (e.g., a fresh owned-completion lineage) at actual
	 * resume admission rather than when the message was merely queued.
	 */
	/**
	 * Invoked when follow-up messages are consumed. `startsOwnRun` is true only
	 * when the batch owns a new agent run; maintenance and in-run consumption
	 * report false so callers attach to the existing lifecycle.
	 */
	onFollowUpConsumed?: (messages: AgentMessage[], promotion?: { startsOwnRun: boolean }) => void;
	/**
	 * Invoked with the steering messages the loop dequeues mid-run for the
	 * CURRENT turn (right after getSteeringMessages). `promotion.startsOwnRun`
	 * is false for in-run consumption and true when the batch starts a new run.
	 */
	/** Invoked when steering is consumed; see `startsOwnRun` on the promotion disposition. */
	onSteeringConsumed?: (messages: AgentMessage[], promotion?: { startsOwnRun: boolean }) => void;
	/**
	 * One-shot transient recovery instruction attached to the first assistant
	 * request of this loop invocation. Sent only to the provider (never committed
	 * to durable agent message history) so a caller-owned retry of a discarded
	 * attempt can name the defect it is retrying around.
	 */
	transientRecoveryMessage?: UserMessage;
	/**
	 * Supplies one bounded synthetic recovery instruction before the loop would
	 * otherwise yield. Unlike a follow-up, it is sent only to the provider and
	 * is not committed to durable agent message history.
	 */
	getSyntheticRecoveryMessage?: () => Promise<UserMessage | undefined>;
	/**
	 * Cooperative pause checkpoint evaluated at safe loop boundaries.
	 *
	 * Called after completed tool execution has been emitted and before the loop
	 * polls steering/follow-up queues or schedules another assistant response.
	 * Returning true ends the current loop with `agent_end.stopReason === "paused"`
	 * without aborting any in-flight model or tool work.
	 */
	shouldPause?: () => boolean;
	/**
	 * Hook fired right before the loop would exit.
	 *
	 * Called when the agent has no more tool calls and no steering messages,
	 * immediately before polling follow-up messages.
	 */
	onBeforeYield?: () => Promise<void> | void;

	/**
	 * Provides tool execution context, resolved per tool call.
	 * Use for late-bound UI or session state access.
	 */
	getToolContext?: (toolCall?: ToolCallContext) => AgentToolContext | undefined;

	/**
	 * Refreshes prompt/tool context from live session state before each model call.
	 * Use this when tool availability or the system prompt can change mid-turn.
	 */
	syncContextBeforeModelCall?: (context: AgentContext) => void | Promise<void>;

	/**
	 * Cooperative mid-run context-maintenance checkpoint.
	 *
	 * Invoked at the top of every loop iteration AFTER pending tool-result /
	 * steering messages have been materialized into durable context and BEFORE
	 * {@link syncContextBeforeModelCall} and the model call. This is the only
	 * boundary where the full unsent context (tool results + dequeued steering)
	 * is already durable, so a long uninterrupted tool loop can be bounded here
	 * before it grows past the provider window.
	 *
	 * The callback owns the maintenance decision (prune / compact / promote) and
	 * receives the minimal cancellation-aware lifecycle: `signal` is the
	 * non-optional loop signal, and `awaitEventDrain(invocationSignal)` waits for
	 * prior event consumer bodies with loop and invocation cancellation composed.
	 * Any outcome other than "not-needed" ends the current run with
	 * `agent_end.stopReason === "maintenance"` (NOT the lossy pause / completed
	 * finalization); the callback's continuation owner resumes the run on the
	 * rewritten context.
	 */
	maintainContext?: (
		context: AgentContext,
		lifecycle: {
			signal: AbortSignal;
			awaitEventDrain: (invocationSignal: AbortSignal) => Promise<void>;
		},
	) =>
		| Promise<ContextMaintenanceResult | MidRunMaintenanceOutcome>
		| ContextMaintenanceResult
		| MidRunMaintenanceOutcome;

	/**
	 * Optional transform applied to tool call arguments before execution.
	 * Use for deobfuscating secrets or rewriting arguments.
	 */
	transformToolCallArguments?: (args: Record<string, unknown>, toolName: string) => Record<string, unknown>;

	/**
	 * Enable intent tracing for tool calls.
	 * When enabled, the harness injects a `string` field into tool schemas sent to the model,
	 * then strips from arguments before executing tools.
	 */
	intentTracing?: boolean;
	/**
	 * Append-only context mode — stabilizes system prompt + tool spec bytes
	 * across turns so provider prefix caches hit at maximum rate.
	 *
	 * When set, the loop reads messages from the append-only log (stable
	 * byte prefix) and caches system prompt + tools. Tools exclude per-turn
	 * `_i` intent fields.
	 */
	appendOnlyContext?: AppendOnlyContextManager;

	/**
	 * Inspect assistant streaming events before they are published to the outer agent event stream.
	 * Callers may abort synchronously to stop consuming buffered provider events.
	 */
	onAssistantMessageEvent?: (message: AssistantMessage, event: AssistantMessageEvent) => void;
	/** Observe unmanaged provisional assistant deltas before public publication. */
	onProvisionalAssistantMessageEvent?: (message: AssistantMessage, event: AssistantMessageEvent) => void;
	/** True when the host consumes provisional assistant events for live safety checks. */
	hasProvisionalAssistantMessageEventConsumer?: boolean;

	/** Called for non-content tool-choice incapability stream events. */
	onToolChoiceIncapability?: (event: Extract<AssistantMessageEvent, { type: "toolChoiceIncapability" }>) => void;

	/**
	 * Called when GPT-5 Harmony protocol leakage is detected and mitigated.
	 */
	onHarmonyLeak?: (event: HarmonyAuditEvent) => void | Promise<void>;

	/**
	 * Dynamic tool choice override, resolved per LLM call.
	 * When set and returns a value, overrides the static `toolChoice`.
	 */
	getToolChoice?: () => ToolChoice | undefined;

	/**
	 * Dynamic reasoning effort override, resolved per LLM call.
	 * When set and returns a value, overrides the static `reasoning` captured
	 * at run-loop start. Use this so mid-run thinking-level changes apply on
	 * the next model call instead of waiting for the next prompt.
	 */
	getReasoning?: () => Effort | undefined;

	/**
	 * Called after a tool call has been validated and is about to execute.
	 *
	 * Return `{ block: true }` to prevent execution. The loop emits an error tool
	 * result instead (using `reason` as the error text, or a default if omitted).
	 *
	 * Mutating `context.args` in place changes the arguments passed to `tool.execute`
	 * — the loop does **not** re-validate after this hook runs.
	 *
	 * The hook receives the tool abort signal (`signal`) and is responsible for
	 * honoring it. Throwing surfaces as a tool-error result and does not abort the
	 * rest of the batch.
	 */
	beforeToolCall?: (
		context: BeforeToolCallContext,
		signal?: AbortSignal,
	) => Promise<BeforeToolCallResult | undefined> | BeforeToolCallResult | undefined;

	/**
	 * Called after a tool finishes executing, before `tool_execution_end` and the
	 * tool-result message are emitted.
	 *
	 * Return an `AfterToolCallResult` to override individual fields of the executed
	 * tool result. Omitted fields keep their original values; there is no deep merge.
	 *
	 * Throwing surfaces as a tool-error result and does not abort the rest of the batch.
	 */
	afterToolCall?: (
		context: AfterToolCallContext,
		signal?: AbortSignal,
	) => Promise<AfterToolCallResult | undefined> | AfterToolCallResult | undefined;
	/**
	 * Opt-in OpenTelemetry instrumentation. Passing `{}` enables the loop's
	 * GenAI-semantic-convention spans (`invoke_agent`, `chat`, `execute_tool`)
	 * using the global tracer provider. Leaving this field undefined disables
	 * the instrumentation entirely — the loop performs zero tracer lookups.
	 *
	 * See {@link AgentTelemetryConfig} for the full surface (hooks, content
	 * capture, cost estimator, agent identity).
	 */
	telemetry?: AgentTelemetryConfig;
	/**
	 * Optional prompt-run resource ownership ledger. Provider and scheduler-level tool
	 * work is tracked until its owned lifecycle promise settles.
	 */
	resourceLedger?: RunResourceLedger;
	/** Stable resource ownership identifier for this prompt run. */
	resourceRunId?: string;
	/** Immutable logical cancellation domain bound by the resource ledger. */
	resourceCancellationDomain?: RunCancellationDomain;
	/** Agent passes caller ownership; direct loop callers retain loop-owned sealing. */
	resourceSealOwner?: "caller" | "loop";
	/** Opaque ownership required to resume a standalone maintenance lifecycle. */
	standaloneRunOwnership?: StandaloneRunOwnership;
}

/**
 * Batch/sequencing metadata for the tool call currently being processed.
 */
export interface ToolCallContext {
	batchId: string;
	index: number;
	total: number;
	toolCalls: Array<{ id: string; name: string }>;
}

/** A single tool-call content block emitted by an assistant message. */
export type AgentToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

/**
 * Result returned from `beforeToolCall`.
 *
 * Set `block: true` to prevent the tool from executing. The loop emits an error tool
 * result instead, using `reason` as the error text (or a default if omitted).
 *
 * Mutating the `args` reference passed in `BeforeToolCallContext` is supported and
 * survives into execution — the loop does **not** re-validate after this hook runs.
 */
export interface BeforeToolCallResult {
	block?: boolean;
	reason?: string;
}

/**
 * Partial override returned from `afterToolCall`.
 *
 * Merge semantics are field-by-field; omitted fields keep the executed values.
 * No deep merge is performed.
 */
export interface AfterToolCallResult {
	/** If provided, replaces the tool result content array in full. */
	content?: (TextContent | ImageContent)[];
	/** If provided, replaces the tool result details payload in full. */
	details?: unknown;
	/** If provided, replaces the error flag carried with the tool result. */
	isError?: boolean;
}

/** Context passed to `beforeToolCall`. */
export interface BeforeToolCallContext {
	/** The assistant message that requested the tool call. */
	assistantMessage: AssistantMessage;
	/** The raw tool call block from `assistantMessage.content`. */
	toolCall: AgentToolCall;
	/**
	 * Validated tool arguments. The same reference is forwarded to `tool.execute`
	 * (after any `transformToolCallArguments` pass), so in-place mutations stick.
	 */
	args: Record<string, unknown>;
	/** Current agent context at the time the tool call is prepared. */
	context: AgentContext;
}

/** Context passed to `afterToolCall`. */
export interface AfterToolCallContext {
	/** The assistant message that requested the tool call. */
	assistantMessage: AssistantMessage;
	/** The raw tool call block from `assistantMessage.content`. */
	toolCall: AgentToolCall;
	/** Validated tool arguments used for execution (post `beforeToolCall` mutations). */
	args: Record<string, unknown>;
	/** The executed tool result before any `afterToolCall` overrides are applied. */
	result: AgentToolResult<any>;
	/** Whether the executed tool result is currently treated as an error. */
	isError: boolean;
	/** Current agent context at the time the tool call is finalized. */
	context: AgentContext;
}

/**
 * Extensible interface for custom app messages.
 * Apps can extend via declaration merging:
 *
 * @example
 * ```typescript
 * declare module "@gajae-code/agent" {
 *   interface CustomAgentMessages {
 *     artifact: ArtifactMessage;
 *     notification: NotificationMessage;
 *   }
 * }
 * ```
 */
export interface CustomAgentMessages {
	// Empty by default - apps extend via declaration merging
}

/**
 * AgentMessage: Union of LLM messages + custom messages.
 * This abstraction allows apps to add custom message types while maintaining
 * type safety and compatibility with the base LLM messages.
 */
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

/**
 * Agent state containing all configuration and conversation data.
 */
export interface AgentState {
	systemPrompt: string[];
	model: Model | undefined;
	thinkingLevel?: Effort;
	tools: AgentTool<any>[];
	messages: AgentMessage[]; // Can include attachments + custom message types
	isStreaming: boolean;
	streamMessage: AgentMessage | null;
	pendingToolCalls: Set<string>;
	error?: string;
}

export interface AgentToolResult<T = any, _TInput = unknown> {
	// Content blocks supporting text and images
	content: (TextContent | ImageContent)[];
	// Details to be displayed in a UI or logged
	details?: T;
	// Marks a non-throwing failure (e.g. an aggregator catching per-entry errors).
	// agent-loop honors this and surfaces it as a tool error on the wire.
	isError?: boolean;
}

// Callback for streaming tool execution updates
export type AgentToolUpdateCallback<T = any, TInput = unknown> = (partialResult: AgentToolResult<T, TInput>) => void;

/** Options passed to renderResult */
export interface RenderResultOptions {
	/** Whether the result view is expanded */
	expanded: boolean;
	/** Whether this is a partial/streaming result */
	isPartial: boolean;
	/** Current spinner frame index for animated elements (optional) */
	spinnerFrame?: number;
}

/**
 * Context passed to tool execution.
 * Apps can extend via declaration merging.
 */
export interface AgentToolContext {
	/** Per-attempt scope used to attribute tool lifecycle and extension delivery. */
	attemptScope?: AttemptScope;
}

export type AgentToolExecFn<TParameters extends TSchema = TSchema, TDetails = any, TTheme = unknown> = (
	this: AgentTool<TParameters, TDetails, TTheme>,
	toolCallId: string,
	params: Static<TParameters>,
	signal?: AbortSignal,
	onUpdate?: AgentToolUpdateCallback<TDetails, TParameters>,
	context?: AgentToolContext,
) => Promise<AgentToolResult<TDetails, TParameters>>;

// AgentTool extends Tool but adds the execute function
export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any, TTheme = unknown>
	extends Tool<TParameters> {
	// A human-readable label for the tool to be displayed in UI
	label: string;
	/** If true, tool is excluded unless explicitly listed in --tools or agent's tools field */
	hidden?: boolean;
	/** If true, tool can stage a pending action that requires explicit resolution via the resolve tool. */
	deferrable?: boolean;
	/** Built-in tool loading behavior. "essential" loads initially; "discoverable" can be activated by tool search. */
	loadMode?: "essential" | "discoverable";
	/** Short one-line summary used for tool discovery indexes. */
	summary?: string;
	/** If true, tool execution ignores abort signals (runs to completion) */
	nonAbortable?: boolean;
	/**
	 * Concurrency mode for tool scheduling when multiple calls are in one turn.
	 * - "shared": can run alongside other shared tools (default)
	 * - "exclusive": runs alone; other tools wait until it finishes
	 */
	concurrency?: "shared" | "exclusive";
	/** If true, argument validation errors are non-fatal: raw args are passed to execute() instead of returning an error to the LLM. */
	lenientArgValidation?: boolean;
	/**
	 * Controls how the INTENT_FIELD (`_i`) is handled for this tool.
	 * - `"require"` (default): `_i` is injected and required in the parameter schema.
	 * - `"optional"`: `_i` is injected as an optional/nullable field.
	 * - `"omit"`: `_i` is NOT injected. Use for tools where intent is obvious (yield, resolve, todo_write, …).
	 * - function: `_i` is NOT injected; intent is derived dynamically from (potentially partial / streaming) args.
	 */
	intent?: "omit" | "optional" | "require" | ((args: Partial<Static<TParameters>>) => string | undefined);
	/**
	 * Argument fields (dotted paths into the arguments object) that render to
	 * the user as pure display text — question wording and option labels, never
	 * ids, metadata, or persisted records. When every `\uXXXX`-escaped scalar in
	 * a tool call corroborates a decoded non-ASCII character inside these
	 * fields, the agent loop degrades to a single warning and executes the
	 * decoded call instead of discarding the turn: a mistyped hex digit there
	 * can only change what the user reads, never what executes or persists.
	 * Every other field of these arguments — and every field of every other
	 * tool — keeps the fail-closed rejection for unverified `\uXXXX` payloads.
	 */
	displaySafeEscapedArgFields?: readonly string[];

	/** The main execution callback for this tool. */
	execute: AgentToolExecFn<TParameters, TDetails, TTheme>;

	/** Optional custom rendering for tool call display (returns UI component) */
	renderCall?: (args: Static<TParameters>, options: RenderResultOptions, theme: TTheme) => unknown;

	/** Optional custom rendering for tool result display (returns UI component) */
	renderResult?: (
		result: AgentToolResult<TDetails, TParameters>,
		options: RenderResultOptions,
		theme: TTheme,
	) => unknown;
}

// AgentContext is like Context but uses AgentTool
export interface AgentContext {
	systemPrompt: string[];
	messages: AgentMessage[];
	tools?: AgentTool<any>[];
}

/**
 * Sanitized failure diagnostic carried by `agent_failed`: a stable classifier code
 * plus a fixed human-readable message. Never the raw provider error — consumers may
 * not depend on provider-specific detail, request bodies, or raw error objects.
 */
export interface AgentFailureDiagnostic {
	code: string;
	message: string;
}

/**
 * Events emitted by the Agent for UI updates.
 * These events provide fine-grained lifecycle information for messages, turns, and tool executions.
 */
export type AgentEvent =
	// Agent lifecycle
	| { type: "agent_start"; scope?: AttemptScope }
	| { type: "agent_failed"; error: AgentFailureDiagnostic; scope?: AttemptScope }
	| {
			type: "agent_end";
			messages: AgentMessage[];
			/** Indicates whether the loop ended normally, suspended, cancelled, or entered maintenance. */
			stopReason?: "completed" | "paused" | "cancelled" | "maintenance";
			/** Present iff `stopReason === "maintenance"`; the maintenance outcome. */
			maintenanceOutcome?: MidRunMaintenanceOutcome;
			/**
			 * Steering that was admitted into this run but never consumed before it
			 * ended (the loop exited on abort, error, pause, or completion without a
			 * further poll). The Agent clears its queue on every run exit; the owner
			 * decides once here whether to re-route or drop these messages.
			 */
			disownedSteering?: AgentMessage[];
			/** Present iff `AgentTelemetryConfig` was supplied on this run. */
			telemetry?: AgentRunSummary;
			coverage?: AgentRunCoverage;
			scope?: AttemptScope;
	  }
	// Turn lifecycle - a turn is one assistant response + any tool calls/results
	| { type: "turn_start"; scope?: AttemptScope }
	| { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[]; scope?: AttemptScope }
	// Message lifecycle - emitted for user, assistant, and toolResult messages
	| { type: "message_start"; message: AgentMessage; scope?: AttemptScope }
	// Only emitted for assistant messages during streaming
	| {
			type: "message_update";
			message: AgentMessage;
			assistantMessageEvent: AssistantMessageEvent;
			scope?: AttemptScope;
	  }
	| { type: "message_end"; message: AgentMessage; scope?: AttemptScope }
	// Tool execution lifecycle
	| {
			type: "tool_execution_start";
			toolCallId: string;
			toolName: string;
			args: any;
			intent?: string;
			scope?: AttemptScope;
	  }
	| {
			type: "tool_execution_update";
			toolCallId: string;
			toolName: string;
			args: any;
			partialResult: any;
			scope?: AttemptScope;
	  }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			result: any;
			isError?: boolean;
			scope?: AttemptScope;
	  };

/**
 * Why a tool call failed when the loop — not the tool — produced the result.
 *
 * `argument_validation` means the call never dispatched: the arguments were
 * rejected before `execute` ran. `execution` means `execute` threw.
 */
export type ToolFailureKind = "argument_validation" | "execution";

/**
 * The result details the loop attaches when a tool call fails without the tool
 * returning its own details. It carries no tool-owned field, so a consumer that
 * dereferences a tool's own detail shape must recognise it first.
 */
export interface ToolFailureEnvelope {
	failureKind: ToolFailureKind;
}

export function toolFailureEnvelope(kind: ToolFailureKind): ToolFailureEnvelope {
	return { failureKind: kind };
}

/**
 * True only for the loop's own envelope. Tools that report a `failureKind`
 * alongside their own details (`todo_write`, todo persistence) keep those fields,
 * so their renderers still own the result and are left alone.
 */
export function isToolFailureEnvelope(value: unknown): value is ToolFailureEnvelope {
	if (!value || typeof value !== "object") return false;
	const keys = Object.keys(value);
	if (keys.length !== 1 || keys[0] !== "failureKind") return false;
	const kind = (value as ToolFailureEnvelope).failureKind;
	return kind === "argument_validation" || kind === "execution";
}
