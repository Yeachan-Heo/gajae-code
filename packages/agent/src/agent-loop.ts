/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	classifyFallbackTrigger,
	EventStream,
	isContextOverflow,
	isZodSchema,
	streamSimple,
	type ToolResultMessage,
	type TSchema,
	transportFailureFacts,
	validateToolArguments,
	zodToWireSchema,
} from "@gajae-code/ai";
import { sanitizeText } from "@gajae-code/utils";
import {
	createHarmonyAuditEvent,
	detectHarmonyLeakInAssistantMessage,
	extractHarmonyRemoved,
	type HarmonyDetection,
	type HarmonyRecoveredToolCall,
	isHarmonyLeakMitigationTarget,
	recoverHarmonyToolCall,
	shouldMitigateHarmonyLeak,
	signalListLabel,
} from "./harmony-leak";
import { type AgentRunCoverage, type AgentRunSummary, ToolCallBlockedError } from "./run-collector";
import {
	type AgentTelemetry,
	failChatSpan,
	finishChatSpan,
	finishExecuteToolSpan,
	finishInvokeAgentSpan,
	fireOnRunEnd,
	PiGenAIAttr,
	recordSkippedTool,
	resolveTelemetry,
	runInActiveSpan,
	type Span,
	startChatSpan,
	startExecuteToolSpan,
	startInvokeAgentSpan,
} from "./telemetry";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolResult,
	ManagedAttemptOutcome,
	StreamFn,
} from "./types";

/** Sentinel returned by the abort race in `streamAssistantResponse`. */
/**
 * Defensive caps for a provisional managed attempt. These are intentionally
 * well above ordinary streamed responses; they only bound memory when an
 * upstream emits an unbounded event stream before the attempt can commit.
 */
export const MANAGED_ATTEMPT_MAX_STAGED_EVENTS = 10_000;
export const MANAGED_ATTEMPT_MAX_STAGED_BYTES = 16 * 1024 * 1024;

class ManagedAttemptBufferOverflowError extends Error {
	readonly status = 503;

	constructor() {
		super("Managed fallback attempt exceeded the provisional event buffer limit");
		this.name = "ManagedAttemptBufferOverflowError";
	}
}

const managedAttemptTextEncoder = new TextEncoder();

const ABORTED: unique symbol = Symbol("agent-loop-aborted");
/**
 * Detect empty "successful" responses that indicate a proxy-level context
 * overflow (e.g. LiteLLM returning `content: []`, `stopReason: "stop"`, and a
 * fabricated near-zero usage). We delegate to {@link isContextOverflow} which
 * has the threshold constant, so the detection logic stays in one place.
 */
function isEmptyResponseOverflow(message: AssistantMessage): boolean {
	return isContextOverflow(message);
}

/** Managed fallback owns retry policy; only typed transport facts may discard an attempt. */
function managedTransportFailure(failure: unknown) {
	if (failure && typeof failure === "object" && "transportFailure" in failure) {
		const facts = (failure as { transportFailure?: unknown }).transportFailure;
		if (facts && typeof facts === "object") return transportFailureFacts(facts);
	}
	return transportFailureFacts(failure);
}

function managedRetryableFailure(failure: unknown): boolean {
	const facts = managedTransportFailure(failure);
	if (!facts) return false;
	const trigger = classifyFallbackTrigger(facts);
	return (
		trigger.class === "rate_limit" ||
		trigger.class === "quota" ||
		trigger.class === "auth" ||
		trigger.class === "server"
	);
}

function managedFailureOutcome(message: AssistantMessage): ManagedAttemptOutcome {
	return {
		type: "retryable_discarded",
		failure: { message, transportFailure: managedTransportFailure(message) },
	};
}

function managedFailureMessage(error: unknown, config: AgentLoopConfig): AssistantMessage {
	const details = error as { message?: unknown; errorStatus?: unknown; status?: unknown };
	const status =
		typeof details.errorStatus === "number"
			? details.errorStatus
			: typeof details.status === "number"
				? details.status
				: undefined;
	const transportFailure =
		managedTransportFailure(error) ?? (status === undefined ? undefined : { kind: "transport" as const, status });
	return {
		role: "assistant",
		content: [],
		api: config.model.api,
		provider: config.model.provider,
		model: config.model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: typeof details.message === "string" ? details.message : String(error),
		errorStatus: status,
		...(transportFailure ? { transportFailure } : {}),
		timestamp: Date.now(),
	};
}

class HarmonyLeakInterruption extends Error {
	constructor(
		readonly detection: HarmonyDetection,
		readonly removed: string,
		readonly recovered?: HarmonyRecoveredToolCall,
	) {
		super(`Detected GPT-5 Harmony protocol leakage (${signalListLabel(detection.signals)})`);
		this.name = "HarmonyLeakInterruption";
	}
}

/**
 * Normalize a value coming back from `tool.execute()` (or its streaming partial-update callback)
 * into a structurally valid {@link AgentToolResult}.
 *
 * The tool interface is typed, but third-party tools (MCP, extensions, user-authored AgentTools)
 * can violate the contract at runtime. Persisting a malformed result corrupts the session file
 * (missing `content` array → crash on reload). We coerce at the single boundary where untyped
 * results enter the agent loop, so every downstream consumer can rely on the type.
 */
function coerceToolResult(raw: unknown): { result: AgentToolResult<any>; malformed: boolean } {
	const rawObj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
	const rawContent = rawObj?.content;
	const details = rawObj && "details" in rawObj ? rawObj.details : {};
	// Tools may flag a non-throwing failure on the result itself (e.g. an
	// aggregator that catches per-entry errors and synthesizes a combined
	// result). Preserve the flag so agent-loop can surface it on the wire.
	const explicitError = Boolean(rawObj && "isError" in rawObj && rawObj.isError);

	if (!Array.isArray(rawContent)) {
		return {
			result: {
				content: [{ type: "text", text: "Tool returned an invalid result: missing content array." }],
				details,
				isError: true,
			},
			malformed: true,
		};
	}

	const content: AgentToolResult["content"] = [];
	for (const block of rawContent) {
		if (!block || typeof block !== "object" || !("type" in block)) continue;
		if (block.type === "text" && typeof (block as { text?: unknown }).text === "string") {
			content.push({ type: "text", text: sanitizeText((block as { text: string }).text) });
		} else if (
			block.type === "image" &&
			typeof (block as { data?: unknown }).data === "string" &&
			typeof (block as { mimeType?: unknown }).mimeType === "string"
		) {
			content.push(block as { type: "image"; data: string; mimeType: string });
		}
	}
	return { result: { content, details, ...(explicitError ? { isError: true } : {}) }, malformed: false };
}

/**
 * Start an agent loop with a new prompt message.
 * The prompt is added to the context and events are emitted for it.
 */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
	emitManagedAgentStart = true,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();

	(async () => {
		const newMessages: AgentMessage[] = [...prompts];
		const currentContext: AgentContext = {
			...context,
			messages: [...context.messages, ...prompts],
		};
		const transaction = config.fallbackManaged
			? new ManagedAttemptTransaction(stream, config.onAssistantMessageEvent)
			: undefined;
		const attemptStream = transaction ?? stream;
		if (!config.fallbackManaged || emitManagedAgentStart) stream.push({ type: "agent_start" });
		attemptStream.push({ type: "turn_start" });
		for (const prompt of prompts) {
			stream.push({ type: "message_start", message: prompt });
			stream.push({ type: "message_end", message: prompt });
		}

		try {
			await runLoop(currentContext, newMessages, config, signal, stream, streamFn, transaction);
		} catch (err) {
			stream.fail(err);
		}
	})();

	return stream;
}

/**
 * Continue an agent loop from the current context without adding a new message.
 * Used for retries - context already has user message or tool results.
 *
 * **Important:** The last message in context must convert to a `user` or `toolResult` message
 * via `convertToLlm`. If it doesn't, the LLM provider will reject the request.
 * This cannot be validated here since `convertToLlm` is only called once per turn.
 */
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
	emitManagedAgentStart = true,
): EventStream<AgentEvent, AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const stream = createAgentStream();

	(async () => {
		const newMessages: AgentMessage[] = [];
		const currentContext: AgentContext = { ...context };
		const transaction = config.fallbackManaged
			? new ManagedAttemptTransaction(stream, config.onAssistantMessageEvent)
			: undefined;
		const attemptStream = transaction ?? stream;
		if (!config.fallbackManaged || emitManagedAgentStart) stream.push({ type: "agent_start" });
		attemptStream.push({ type: "turn_start" });

		try {
			await runLoop(currentContext, newMessages, config, signal, stream, streamFn, transaction);
		} catch (err) {
			stream.fail(err);
		}
	})();

	return stream;
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

/** Capture an event-time value because providers commonly mutate partial messages in place. */
function managedAttemptSnapshot<T>(value: T): T {
	return structuredClone(value);
}

/**
 * Holds managed-attempt assistant output above the public event stream. A
 * cancelled provider attempt is therefore unobservable to sessions and their
 * side-effect consumers. Non-managed streams bypass this object entirely.
 */
class ManagedAttemptTransaction {
	#batch: Array<
		| { type: "event"; event: AgentEvent }
		| { type: "assistant_event"; message: AssistantMessage; event: AssistantMessageEvent }
	> = [];
	#stagedEventCount = 0;
	#stagedBytes = 0;
	#discarded = false;
	#committed = false;

	constructor(
		private readonly stream: EventStream<AgentEvent, AgentMessage[]>,
		private readonly onAssistantMessageEvent?: (message: AssistantMessage, event: AssistantMessageEvent) => void,
	) {}

	push(event: AgentEvent): void {
		if (this.#committed) {
			this.stream.push(event);
			return;
		}
		this.#stage(event);
	}

	end(messages: AgentMessage[]): void {
		this.stream.end(messages);
	}

	stageAssistantMessageEvent(message: AssistantMessage, event: AssistantMessageEvent): void {
		this.#batch.push({
			type: "assistant_event",
			message: managedAttemptSnapshot(message),
			event: managedAttemptSnapshot(event),
		});
	}

	flush(): void {
		if (this.#discarded || this.#committed) return;
		for (const item of this.#batch) {
			if (item.type === "assistant_event") {
				this.onAssistantMessageEvent?.(item.message, item.event);
			} else {
				this.stream.push(item.event);
			}
		}
		this.#batch = [];
		this.#stagedBytes = 0;
		this.#stagedEventCount = 0;
		this.#committed = true;
	}

	discard(): void {
		this.#batch = [];
		this.#stagedBytes = 0;
		this.#stagedEventCount = 0;
		this.#discarded = true;
	}

	#stage(event: AgentEvent): void {
		let bytes: number;
		try {
			bytes = managedAttemptTextEncoder.encode(JSON.stringify(event)).byteLength;
		} catch {
			bytes = MANAGED_ATTEMPT_MAX_STAGED_BYTES + 1;
		}
		if (
			this.#stagedEventCount + 1 > MANAGED_ATTEMPT_MAX_STAGED_EVENTS ||
			this.#stagedBytes + bytes > MANAGED_ATTEMPT_MAX_STAGED_BYTES
		) {
			this.discard();
			throw new ManagedAttemptBufferOverflowError();
		}
		this.#batch.push({ type: "event", event: managedAttemptSnapshot(event) });
		this.#stagedEventCount += 1;

		this.#stagedBytes += bytes;
	}
}

/**
 * Build the `agent_end` event payload. When telemetry is enabled, snapshots
 * the run collector so consumers receive {@link AgentRunSummary} +
 * {@link AgentRunCoverage} alongside the messages without parsing OTEL spans.
 * When telemetry is unset, returns the bare event for backwards compatibility.
 */
function buildAgentEndEvent(
	messages: AgentMessage[],
	telemetry: AgentTelemetry | undefined,
	stepCount: number,
	stopReason: "completed" | "paused" = "completed",
): Extract<AgentEvent, { type: "agent_end" }> {
	const base = { type: "agent_end" as const, messages, stopReason };
	if (!telemetry) return base;
	const snapshot = telemetry.collector.snapshot({ stepCount });
	if (telemetry.collector.markRunEnded()) {
		fireOnRunEnd(telemetry, snapshot.summary, snapshot.coverage);
	}
	return { ...base, telemetry: snapshot.summary, coverage: snapshot.coverage };
}

/**
 * Detailed-result handle returned by {@link agentLoopDetailed}. Adds the
 * run-level telemetry/coverage rollup to the existing `AgentMessage[]`
 * payload without changing the resolved type of `stream.result()`.
 */
export interface AgentLoopDetailedResult {
	readonly messages: AgentMessage[];
	readonly telemetry: AgentRunSummary | undefined;
	readonly coverage: AgentRunCoverage | undefined;
}

/**
 * Convenience wrapper over {@link agentLoop} that exposes the run-level
 * summary + coverage alongside the messages. The returned `stream` is the
 * same `EventStream` callers already consume; `detailed()` awaits the
 * stream's `agent_end` event and returns the additive fields.
 *
 * Existing `stream.result()` semantics are preserved — it still resolves to
 * `AgentMessage[]`. Use {@link agentLoopDetailed} when you need the rollup;
 * use {@link agentLoop} when you do not.
 */
export function agentLoopDetailed(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): {
	readonly stream: EventStream<AgentEvent, AgentMessage[]>;
	readonly detailed: () => Promise<AgentLoopDetailedResult>;
} {
	const capture = createDetailedCapture(config);
	const stream = agentLoop(prompts, context, capture.config, signal, streamFn);
	return { stream, detailed: () => capture.detailed(stream) };
}

/**
 * Like {@link agentLoopDetailed} but built on top of
 * {@link agentLoopContinue}.
 */
export function agentLoopContinueDetailed(
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): {
	readonly stream: EventStream<AgentEvent, AgentMessage[]>;
	readonly detailed: () => Promise<AgentLoopDetailedResult>;
} {
	const capture = createDetailedCapture(config);
	const stream = agentLoopContinue(context, capture.config, signal, streamFn);
	return { stream, detailed: () => capture.detailed(stream) };
}

/**
 * Wire an `onRunEnd` telemetry hook onto `config` so the detailed helper can
 * capture the run summary without consuming the event stream. Preserves any
 * existing `onRunEnd` the caller had set.
 */
function createDetailedCapture(config: AgentLoopConfig): {
	readonly config: AgentLoopConfig;
	readonly detailed: (stream: EventStream<AgentEvent, AgentMessage[]>) => Promise<AgentLoopDetailedResult>;
} {
	let captured: { summary: AgentRunSummary; coverage: AgentRunCoverage } | undefined;
	const userHook = config.telemetry?.onRunEnd;
	const wired: AgentLoopConfig = {
		...config,
		telemetry: {
			...(config.telemetry ?? {}),
			onRunEnd: (summary, coverage) => {
				captured = { summary, coverage };
				userHook?.(summary, coverage);
			},
		},
	};
	return {
		config: wired,
		detailed: async stream => {
			const messages = await stream.result();
			return {
				messages,
				telemetry: captured?.summary,
				coverage: captured?.coverage,
			};
		},
	};
}

export function normalizeMessagesForProvider(
	messages: Context["messages"],
	model: AgentLoopConfig["model"],
): Context["messages"] {
	if (model.provider !== "cerebras") {
		return messages;
	}

	let changed = false;
	const normalized = messages.map(message => {
		if (message.role !== "assistant" || !Array.isArray(message.content)) {
			return message;
		}

		const filtered = message.content.filter(block => block.type !== "thinking");
		if (filtered.length === message.content.length) {
			return message;
		}

		changed = true;
		return { ...message, content: filtered };
	});

	return changed ? normalized : messages;
}

interface ConvertedContextCacheEntry {
	messageHashes: string[];
	modelKey: string;
	toolKey: string;
	intentTracing: boolean;
	convertToLlm: AgentLoopConfig["convertToLlm"];
	transformContext: AgentLoopConfig["transformContext"];
	llmMessages: Context["messages"];
	normalizedMessages: Context["messages"];
}

const convertedContextCache = new WeakMap<AgentLoopConfig, ConvertedContextCacheEntry>();

function stableCacheString(value: unknown): string | undefined {
	try {
		return JSON.stringify(value, (_key, item) =>
			typeof item === "function" ? `[Function:${item.name || "anonymous"}]` : item,
		);
	} catch {
		return undefined;
	}
}

/**
 * Hash a message by full content serialization.
 *
 * Deliberately NOT memoized by object identity: callers mutate messages in
 * place (compaction rewrites, obfuscation, abort markers) and the cache's
 * correctness contract requires detecting those mutations. The per-turn
 * serialization cost is the price of that contract; the win is skipping
 * convertToLlm + normalize on stable contexts, which dominates for
 * image-heavy histories.
 */
function hashMessageContent(message: AgentMessage): string | undefined {
	return stableCacheString(message);
}

function buildConvertedContextCacheKeys(
	messages: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
): Pick<ConvertedContextCacheEntry, "messageHashes" | "modelKey" | "toolKey" | "intentTracing"> | undefined {
	const intentTracing = !!config.intentTracing;
	const messageHashes = messages.map(hashMessageContent);
	const modelKey = stableCacheString(config.model);
	const toolKey = stableCacheString(normalizeTools(context.tools, intentTracing) ?? []);
	if (messageHashes.some(hash => hash === undefined) || modelKey === undefined || toolKey === undefined) {
		return undefined;
	}
	return {
		messageHashes: messageHashes as string[],
		modelKey,
		toolKey,
		intentTracing,
	};
}

function findStablePrefixLength(previous: string[], next: string[]): number {
	const max = Math.min(previous.length, next.length);
	let index = 0;
	while (index < max && previous[index] === next[index]) index++;
	return index;
}

async function convertAndNormalizeMessages(
	messages: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
): Promise<Context["messages"]> {
	const keys = buildConvertedContextCacheKeys(messages, context, config);
	if (!keys) {
		return normalizeMessagesForProvider(await config.convertToLlm(messages), config.model);
	}
	const previous = convertedContextCache.get(config);
	const canReuse =
		previous &&
		previous.convertToLlm === config.convertToLlm &&
		previous.transformContext === config.transformContext &&
		previous.modelKey === keys.modelKey &&
		previous.toolKey === keys.toolKey &&
		previous.intentTracing === keys.intentTracing;

	if (canReuse) {
		const stablePrefixLength = findStablePrefixLength(previous.messageHashes, keys.messageHashes);
		if (stablePrefixLength === keys.messageHashes.length && stablePrefixLength === previous.messageHashes.length) {
			return previous.normalizedMessages;
		}
		// Append-only fast path: convert only the new suffix and concatenate.
		// CONTRACT: `convertToLlm` must be per-message (each output message
		// derived solely from its input message). The bundled converters
		// satisfy this — they map/filter message-by-message. A converter that
		// merges adjacent messages or pairs across the suffix boundary would
		// diverge from a full rebuild; such converters must not be combined
		// with appendOnlyContext. Covered by the suffix-equivalence test in
		// agent-loop-context-cache.test.ts.
		if (
			config.appendOnlyContext &&
			stablePrefixLength === previous.messageHashes.length &&
			keys.messageHashes.length > previous.messageHashes.length
		) {
			const suffix = messages.slice(stablePrefixLength);
			const convertedSuffix = await config.convertToLlm(suffix);
			const llmMessages = [...previous.llmMessages, ...convertedSuffix];
			const normalizedMessages = normalizeMessagesForProvider(llmMessages, config.model);
			convertedContextCache.set(config, {
				...keys,
				convertToLlm: config.convertToLlm,
				transformContext: config.transformContext,
				llmMessages,
				normalizedMessages,
			});
			return normalizedMessages;
		}
	}

	const llmMessages = await config.convertToLlm(messages);
	const normalizedMessages = normalizeMessagesForProvider(llmMessages, config.model);
	convertedContextCache.set(config, {
		...keys,
		convertToLlm: config.convertToLlm,
		transformContext: config.transformContext,
		llmMessages,
		normalizedMessages,
	});
	return normalizedMessages;
}

export const INTENT_FIELD = "_i";

function injectIntentIntoSchema(schema: unknown, mode: "require" | "optional" = "optional"): unknown {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
	const schemaRecord = schema as Record<string, unknown>;
	const propertiesValue = schemaRecord.properties;
	const properties =
		propertiesValue && typeof propertiesValue === "object" && !Array.isArray(propertiesValue)
			? (propertiesValue as Record<string, unknown>)
			: {};
	const requiredValue = schemaRecord.required;
	const required = Array.isArray(requiredValue)
		? requiredValue.filter((item): item is string => typeof item === "string")
		: [];
	if (INTENT_FIELD in properties) {
		const { [INTENT_FIELD]: intentProp, ...rest } = properties;
		const needsReorder = Object.keys(properties)[0] !== INTENT_FIELD;
		const needsRequired = mode === "require" && !required.includes(INTENT_FIELD);
		if (!needsReorder && !needsRequired) return schema;
		return {
			...schemaRecord,
			...(needsReorder ? { properties: { [INTENT_FIELD]: intentProp, ...rest } } : {}),
			...(needsRequired ? { required: [...required, INTENT_FIELD] } : {}),
		};
	}
	return {
		...schemaRecord,
		properties: {
			[INTENT_FIELD]: {
				type: "string",
			},
			...properties,
		},
		...(mode === "require" ? { required: [...required, INTENT_FIELD] } : {}),
	};
}

export function normalizeTools(tools: AgentContext["tools"], injectIntent: boolean): Context["tools"] {
	injectIntent = injectIntent && Bun.env.PI_NO_INTENT !== "1";
	return tools?.map(t => {
		const intentMode = resolveIntentMode(t.intent);
		let parameters: TSchema = t.parameters;
		if (injectIntent && intentMode !== "omit") {
			if (isZodSchema(parameters)) {
				const wired = zodToWireSchema(parameters);
				parameters = injectIntentIntoSchema(wired, intentMode) as TSchema;
			} else {
				parameters = injectIntentIntoSchema(parameters, intentMode) as TSchema;
			}
		}
		const description = t.description ?? "";
		return { ...t, parameters, description };
	});
}

function resolveIntentMode(intent: AgentTool["intent"]): "require" | "optional" | "omit" {
	if (typeof intent === "function") return "omit";
	if (intent === "optional" || intent === "omit") return intent;
	return intent === "require" ? "require" : "optional";
}

function extractIntent(args: Record<string, unknown>): { intent?: string; strippedArgs: Record<string, unknown> } {
	const { [INTENT_FIELD]: intent, ...strippedArgs } = args;
	if (typeof intent !== "string") {
		return { strippedArgs };
	}
	const trimmed = intent.trim();
	return { intent: trimmed.length > 0 ? trimmed : undefined, strippedArgs };
}

/**
 * Main loop logic shared by agentLoop and agentLoopContinue.
 */
async function runLoop(
	currentContext: AgentContext,
	newMessages: AgentMessage[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	streamFn?: StreamFn,
	initialTransaction?: ManagedAttemptTransaction,
): Promise<void> {
	const telemetry = resolveTelemetry(config.telemetry, config.sessionId);
	const invokeAgentSpan = startInvokeAgentSpan(telemetry, config.model);
	const stepCounter = { count: 0 };
	let caughtError: unknown;
	try {
		await runInActiveSpan(invokeAgentSpan, () =>
			runLoopBody(
				currentContext,
				newMessages,
				config,
				signal,
				stream,
				telemetry,
				invokeAgentSpan,
				stepCounter,
				streamFn,
				initialTransaction,
			),
		);
	} catch (err) {
		caughtError = err;
		throw err;
	} finally {
		finishInvokeAgentSpan(telemetry, invokeAgentSpan, {
			stepCount: stepCounter.count,
			errorObject: caughtError,
		});
	}
}

interface StepCounter {
	count: number;
}

async function runLoopBody(
	currentContext: AgentContext,
	newMessages: AgentMessage[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	telemetry: AgentTelemetry | undefined,
	invokeAgentSpan: Span | undefined,
	stepCounter: StepCounter,
	streamFn?: StreamFn,
	initialTransaction?: ManagedAttemptTransaction,
): Promise<void> {
	let firstTurn = true;
	// Check for steering messages at start (user may have typed while waiting)
	let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];
	let harmonyRetryAttempt = 0;
	let harmonyTruncateResumeCount = 0;

	// Outer loop: continues when queued follow-up messages arrive after agent would stop
	while (true) {
		let hasMoreToolCalls = true;

		// Inner loop: process tool calls and steering messages
		while (hasMoreToolCalls || pendingMessages.length > 0) {
			const transaction =
				initialTransaction ??
				(config.fallbackManaged
					? new ManagedAttemptTransaction(stream, config.onAssistantMessageEvent)
					: undefined);
			initialTransaction = undefined;
			const attemptStream = transaction ?? stream;
			if (!firstTurn) {
				attemptStream.push({ type: "turn_start" });
			} else {
				firstTurn = false;
			}

			// Commit queued user input outside the provisional assistant transaction so a
			// discarded managed attempt cannot lose it before its retry continuation.
			if (pendingMessages.length > 0) {
				for (const message of pendingMessages) {
					stream.push({ type: "message_start", message });
					stream.push({ type: "message_end", message });
					currentContext.messages.push(message);
					newMessages.push(message);
				}
				pendingMessages = [];
			}

			// Refresh prompt/tool context from live state before each model call
			if (config.syncContextBeforeModelCall) {
				await config.syncContextBeforeModelCall(currentContext);
			}

			const contextMessageCount = currentContext.messages.length;
			const newMessageCount = newMessages.length;

			// Stream assistant response
			let recovered: HarmonyRecoveredToolCall | undefined;
			let message: AssistantMessage;
			const attemptTransaction = transaction;
			try {
				const attemptConfig = attemptTransaction
					? {
							...config,
							onAssistantMessageEvent: (partial: AssistantMessage, event: AssistantMessageEvent) =>
								attemptTransaction.stageAssistantMessageEvent(partial, event),
						}
					: config;
				message = await streamAssistantResponse(
					currentContext,
					attemptConfig,
					signal,
					attemptTransaction ? (attemptTransaction as unknown as EventStream<AgentEvent, AgentMessage[]>) : stream,
					telemetry,
					invokeAgentSpan,
					stepCounter,
					streamFn,
					harmonyRetryAttempt,
				);
				const detection = detectHarmonyLeakInAssistantMessage(message);
				if (detection && shouldMitigateHarmonyLeak(config.model, detection)) {
					const rec = recoverHarmonyToolCall(message, detection);
					const removed = rec ? rec.removed : extractHarmonyRemoved(message, detection);
					throw new HarmonyLeakInterruption(detection, removed, rec);
				}
				harmonyRetryAttempt = 0;
				harmonyTruncateResumeCount = 0;
			} catch (err) {
				if (!(err instanceof HarmonyLeakInterruption)) {
					if (config.fallbackManaged && transaction && managedRetryableFailure(err)) {
						transaction.discard();
						currentContext.messages.splice(contextMessageCount);
						newMessages.splice(newMessageCount);
						await config.onManagedAttemptOutcome?.(managedFailureOutcome(managedFailureMessage(err, config)));
						stream.end(newMessages);
						return;
					}
					throw err;
				}
				if (config.fallbackManaged) {
					await emitHarmonyAudit(config, err, "escalated", harmonyRetryAttempt);
					throw err;
				}
				if (err.recovered) {
					if (harmonyTruncateResumeCount >= 2) {
						await emitHarmonyAudit(config, err, "escalated", harmonyRetryAttempt);
						throw new Error(
							`GPT-5 Harmony leak recurred after truncate-and-resume recovery (${signalListLabel(err.detection.signals)}).`,
						);
					}
					harmonyTruncateResumeCount++;
					recovered = err.recovered;
					message = recovered.message;
					// Replace the contaminated assistant message committed during
					// streaming with the recovered (truncated) one so the retry
					// sees clean history.
					{
						const idx = currentContext.messages.length - 1;
						if (idx >= 0 && currentContext.messages[idx]?.role === "assistant") {
							currentContext.messages[idx] = recovered.message;
						}
					}
					await emitHarmonyAudit(config, err, "truncate_resume", harmonyRetryAttempt);
				} else {
					if (harmonyRetryAttempt >= 2) {
						await emitHarmonyAudit(config, err, "escalated", harmonyRetryAttempt);
						throw new Error(
							`GPT-5 Harmony leak persisted after ${harmonyRetryAttempt} retries (${signalListLabel(err.detection.signals)}).`,
						);
					}
					await emitHarmonyAudit(config, err, "abort_retry", harmonyRetryAttempt);
					harmonyRetryAttempt++;
					// Drop the contaminated assistant message committed during
					// streaming so the retry does not replay the model's own leak
					// back to it as history.
					{
						const idx = currentContext.messages.length - 1;
						if (idx >= 0 && currentContext.messages[idx]?.role === "assistant") {
							currentContext.messages.splice(idx, 1);
						}
					}
					continue;
				}
			}
			newMessages.push(message);
			let steeringMessagesFromExecution: AgentMessage[] | undefined;

			// Detect empty "successful" responses (stopReason "stop" + empty content).
			// Some proxies (e.g. LiteLLM) return this when the upstream model's context
			// window is exceeded, fabricating a near-zero usage instead of surfacing an
			// error. Without this guard the agent loop treats the empty response as a
			// natural turn completion and stops, leaving the user with a frozen session.
			// Promote it to an error so the overflow/compaction recovery path can fire.
			if (message.stopReason === "stop" && message.content.length === 0 && isEmptyResponseOverflow(message)) {
				message.stopReason = "error";
				message.errorMessage = message.errorMessage
					? `${message.errorMessage} | Provider returned an empty response with anomalously low token usage (possible context overflow via proxy)`
					: "Provider returned an empty response with anomalously low token usage (possible context overflow via proxy)";
			}

			if (config.fallbackManaged && message.stopReason === "error" && managedRetryableFailure(message)) {
				transaction?.discard();
				currentContext.messages.splice(contextMessageCount);
				newMessages.splice(newMessageCount);
				await config.onManagedAttemptOutcome?.(managedFailureOutcome(message));
				stream.end(newMessages);
				return;
			}

			if (config.fallbackManaged && message.stopReason === "aborted") {
				transaction?.discard();
				currentContext.messages.splice(contextMessageCount);
				newMessages.splice(newMessageCount);
				await config.onManagedAttemptOutcome?.({ type: "run_terminal", reason: "cancelled" });
				stream.end(newMessages);
				return;
			}

			// One provider invocation is committed before any tool can run.
			transaction?.flush();
			if (config.fallbackManaged && message.stopReason !== "error" && message.stopReason !== "aborted") {
				await config.onManagedAttemptAccepted?.();
			}

			if (message.stopReason === "error" || message.stopReason === "aborted") {
				// Create placeholder tool results for any tool calls in the aborted message
				// This maintains the tool_use/tool_result pairing that the API requires
				type ToolCallContent = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;
				const toolCalls = message.content.filter((c): c is ToolCallContent => c.type === "toolCall");
				const toolResults: ToolResultMessage[] = [];
				for (const toolCall of toolCalls) {
					const result = createAbortedToolResult(toolCall, stream, message.stopReason, message.errorMessage);
					currentContext.messages.push(result);
					newMessages.push(result);
					toolResults.push(result);
					// The placeholder result above keeps the API's tool_use/tool_result
					// pairing intact, but no execute_tool span is started for these
					// calls. Mirror the run-collector entry directly so the run
					// summary's tool counters and `coverage.toolsInvoked` reflect
					// what the user actually saw on the wire.
					recordSkippedTool(telemetry, {
						toolCallId: toolCall.id,
						toolName: toolCall.name,
						status: message.stopReason === "aborted" ? "aborted" : "error",
					});
				}
				stream.push({ type: "turn_end", message, toolResults });
				stream.push(buildAgentEndEvent(newMessages, telemetry, stepCounter.count));
				stream.end(newMessages);
				return;
			}

			// Check for tool calls
			const toolCalls = message.content.filter(c => c.type === "toolCall");
			hasMoreToolCalls = toolCalls.length > 0;

			const toolResults: ToolResultMessage[] = [];
			if (hasMoreToolCalls) {
				const executionResult = await executeToolCalls(
					currentContext,
					message,
					signal,
					stream,
					config,
					telemetry,
					invokeAgentSpan,
				);

				toolResults.push(...executionResult.toolResults);
				steeringMessagesFromExecution = executionResult.steeringMessages;

				for (const result of toolResults) {
					currentContext.messages.push(result);
					newMessages.push(result);
				}
			}

			stream.push({ type: "turn_end", message, toolResults });

			if (steeringMessagesFromExecution && steeringMessagesFromExecution.length > 0) {
				pendingMessages = steeringMessagesFromExecution;
				continue;
			}
			pendingMessages = (await config.getSteeringMessages?.()) || [];
			if (pendingMessages.length > 0) continue;
			if (config.shouldPause?.()) {
				stream.push(buildAgentEndEvent(newMessages, telemetry, stepCounter.count, "paused"));
				stream.end(newMessages);
				return;
			}
		}

		// Agent would stop here. Check for follow-up messages.
		await config.onBeforeYield?.();
		if (config.shouldPause?.()) {
			stream.push(buildAgentEndEvent(newMessages, telemetry, stepCounter.count, "paused"));
			stream.end(newMessages);
			return;
		}
		const followUpMessages = (await config.getFollowUpMessages?.()) || [];
		if (followUpMessages.length > 0) {
			// Set as pending so inner loop processes them
			pendingMessages = followUpMessages;
			continue;
		}

		// No more messages, exit
		break;
	}

	stream.push(buildAgentEndEvent(newMessages, telemetry, stepCounter.count));
	stream.end(newMessages);
}

async function emitHarmonyAudit(
	config: AgentLoopConfig,
	interruption: HarmonyLeakInterruption,
	action: "truncate_resume" | "abort_retry" | "escalated",
	retryN: number,
): Promise<void> {
	await config.onHarmonyLeak?.(
		createHarmonyAuditEvent({
			action,
			detection: interruption.detection,
			model: config.model,
			retryN,
			removed: interruption.removed,
		}),
	);
}

/**
 * Stream an assistant response from the LLM.
 * This is where AgentMessage[] gets transformed to Message[] for the LLM.
 */
async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	telemetry: AgentTelemetry | undefined,
	invokeAgentSpan: Span | undefined,
	stepCounter: StepCounter,
	streamFn?: StreamFn,
	harmonyRetryAttempt = 0,
): Promise<AssistantMessage> {
	// Apply context transform if configured (AgentMessage[] → AgentMessage[])
	let messages = context.messages;
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal);
	}

	// Convert to LLM-compatible messages (AgentMessage[] → Message[]) and normalize at the LLM boundary.
	// Cache hits are keyed by provider-visible content hashes, never message object identity.
	const normalizedMessages = await convertAndNormalizeMessages(messages, context, config);

	// Build LLM context — append-only mode caches system prompt + tools
	// AND keeps an append-only message log so prior-turn bytes are stable.
	let llmContext: Context;
	if (config.appendOnlyContext) {
		config.appendOnlyContext.syncMessages(normalizedMessages);
		llmContext = config.appendOnlyContext.build(context, { intentTracing: !!config.intentTracing });
	} else {
		llmContext = {
			systemPrompt: context.systemPrompt,
			messages: normalizedMessages,
			tools: normalizeTools(context.tools, !!config.intentTracing),
		};
	}

	const streamFunction = streamFn || streamSimple;

	// Resolve API key (important for expiring tokens) — do this before resolving
	// metadata so that the session-sticky credential recorded by getApiKey is
	// visible to metadataResolver (e.g. for the correct account_uuid in metadata.user_id).
	const resolvedApiKey =
		(config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;

	// Re-resolve metadata after credential selection so the per-request value
	// reflects the credential actually used, not the snapshot from AgentLoopConfig construction.
	const authCredentialType = config.getAuthCredentialType?.(config.model.provider);

	const resolvedMetadata = config.metadataResolver ? config.metadataResolver(config.model.provider) : config.metadata;

	const dynamicToolChoice = config.getToolChoice?.();
	const dynamicReasoning = config.getReasoning?.();
	const harmonyMitigationEnabled = isHarmonyLeakMitigationTarget(config.model);
	const harmonyAbortController = harmonyMitigationEnabled ? new AbortController() : undefined;
	const requestSignal = harmonyAbortController
		? signal
			? AbortSignal.any([signal, harmonyAbortController.signal])
			: harmonyAbortController.signal
		: signal;
	const effectiveTemperature =
		harmonyRetryAttempt > 0 && config.temperature !== undefined ? config.temperature + 0.05 : config.temperature;
	const effectiveToolChoice = dynamicToolChoice ?? config.toolChoice;
	const effectiveReasoning = dynamicReasoning ?? config.reasoning;

	const chatStepNumber = stepCounter.count;
	stepCounter.count += 1;
	const chatSpan = startChatSpan(telemetry, config.model, {
		parent: invokeAgentSpan,
		stepNumber: chatStepNumber,
		request: {
			maxTokens: config.maxTokens,
			temperature: effectiveTemperature,
			topP: config.topP,
			topK: config.topK,
			presencePenalty: config.presencePenalty,
			serviceTier: config.serviceTier,
			reasoningEffort: typeof effectiveReasoning === "string" ? effectiveReasoning : undefined,
			toolChoice: effectiveToolChoice,
			tools: llmContext.tools,
			systemPrompt: llmContext.systemPrompt,
			messages: llmContext.messages,
		},
	});

	// Wrap the user-supplied onResponse so we always observe response headers
	// for telemetry (`ChatUsageEvent.headers`, gateway auto-detection) without
	// stealing them from the configured hook.
	let capturedHeaders: Readonly<Record<string, string>> | undefined;
	const userOnResponse = config.onResponse;
	const captureOnResponse: AgentLoopConfig["onResponse"] = (response, modelInfo) => {
		capturedHeaders = response.headers;
		return userOnResponse?.(response, modelInfo);
	};

	const finishChat = async (message: AssistantMessage): Promise<void> => {
		await finishChatSpan(telemetry, chatSpan, message, {
			stepNumber: chatStepNumber,
			serviceTier: config.serviceTier,
			responseHeaders: capturedHeaders,
			baseUrl: config.model.baseUrl,
		});
	};

	try {
		return await runInActiveSpan(chatSpan, async () => {
			const fallbackAttempt = config.fallbackManaged ? config.nextFallbackAttempt?.(config.model) : undefined;
			const response = await streamFunction(config.model, llmContext, {
				...config,
				fallbackAttempt,
				apiKey: resolvedApiKey,
				authCredentialType,
				metadata: resolvedMetadata,
				sessionId: config.providerSessionId ?? config.sessionId,
				toolChoice: effectiveToolChoice,
				reasoning: effectiveReasoning,
				temperature: effectiveTemperature,
				signal: requestSignal,
				onResponse: captureOnResponse,
			});

			let partialMessage: AssistantMessage | null = null;
			let addedPartial = false;

			const responseIterator = response[Symbol.asyncIterator]();

			// Set up a single abort race: register the abort listener once for the whole
			// stream and reuse the same race promise for every iterator.next() instead of
			// allocating Promise.withResolvers and add/removeEventListener per event.
			let abortRacePromise: Promise<typeof ABORTED> | undefined;
			let detachAbortListener: (() => void) | undefined;
			if (requestSignal) {
				if (requestSignal.aborted) {
					const aborted = emitAbortedAssistantMessage(partialMessage, addedPartial, context, config, stream);
					await finishChat(aborted);
					return aborted;
				}
				const { promise, resolve } = Promise.withResolvers<typeof ABORTED>();
				const onAbort = () => resolve(ABORTED);
				requestSignal.addEventListener("abort", onAbort, { once: true });
				abortRacePromise = promise;
				detachAbortListener = () => requestSignal.removeEventListener("abort", onAbort);
			}

			try {
				while (true) {
					let next: IteratorResult<AssistantMessageEvent>;
					if (abortRacePromise) {
						const result = await Promise.race([responseIterator.next(), abortRacePromise]);
						if (result === ABORTED) {
							responseIterator.return?.()?.catch(() => {});
							const aborted = emitAbortedAssistantMessage(partialMessage, addedPartial, context, config, stream);
							await finishChat(aborted);
							return aborted;
						}
						next = result;
					} else {
						next = await responseIterator.next();
					}
					if (requestSignal?.aborted) {
						const aborted = emitAbortedAssistantMessage(partialMessage, addedPartial, context, config, stream);
						await finishChat(aborted);
						return aborted;
					}
					if (next.done) break;

					const event = next.value;

					switch (event.type) {
						case "start":
							partialMessage = event.partial;
							context.messages.push(partialMessage);
							addedPartial = true;
							stream.push({ type: "message_start", message: { ...partialMessage } });
							break;

						case "toolChoiceIncapability":
							config.onToolChoiceIncapability?.(event);
							break;

						case "text_start":
						case "text_delta":
						case "text_end":
						case "thinking_start":
						case "thinking_delta":
						case "thinking_end":
						case "toolcall_start":
						case "toolcall_delta":
						case "toolcall_end":
							if (partialMessage) {
								partialMessage = event.partial;
								context.messages[context.messages.length - 1] = partialMessage;
								config.onAssistantMessageEvent?.(partialMessage, event);
								if (signal?.aborted) {
									continue;
								}
								stream.push({
									type: "message_update",
									assistantMessageEvent: event,
									message: { ...partialMessage },
								});
							}
							break;

						case "done":
						case "error": {
							const finalMessage = await response.result();
							if (addedPartial) {
								context.messages[context.messages.length - 1] = finalMessage;
							} else {
								context.messages.push(finalMessage);
							}
							if (!addedPartial) {
								stream.push({ type: "message_start", message: { ...finalMessage } });
							}
							stream.push({ type: "message_end", message: finalMessage });
							await finishChat(finalMessage);
							return finalMessage;
						}
					}
				}
			} finally {
				detachAbortListener?.();
			}

			const trailing = await response.result();
			await finishChat(trailing);
			return trailing;
		});
	} catch (err) {
		failChatSpan(telemetry, chatSpan, {
			errorObject: err,
			responseHeaders: capturedHeaders,
			baseUrl: config.model.baseUrl,
		});
		throw err;
	}
}

function emitAbortedAssistantMessage(
	partialMessage: AssistantMessage | null,
	addedPartial: boolean,
	context: AgentContext,
	config: AgentLoopConfig,
	stream: EventStream<AgentEvent, AgentMessage[]>,
): AssistantMessage {
	const errorMessage = "Request was aborted";
	const now = Date.now();
	const abortedMessage: AssistantMessage = {
		role: "assistant",
		content: partialMessage ? structuredClone(partialMessage.content) : [],
		api: config.model.api,
		provider: config.model.provider,
		model: config.model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "aborted",
		errorMessage,
		timestamp: now,
	};
	if (addedPartial) {
		context.messages.pop();
	} else {
		stream.push({ type: "message_start", message: { ...abortedMessage } });
	}
	stream.push({ type: "message_end", message: abortedMessage });
	return abortedMessage;
}

/**
 * Match a tool against the model-visible call name. Tools emitted via OpenAI's
 * custom-tool path (e.g. `apply_patch` on GPT-5) arrive under their wire-level
 * name, which may differ from the harness-internal `name`, so dispatch and any
 * "is this tool callable" check must consider both. Internal `name` takes
 * precedence when a caller needs a single match.
 */
function toolMatchesCallName(tool: { name: string; customWireName?: string }, callName: string): boolean {
	return tool.name === callName || (tool.customWireName !== undefined && tool.customWireName === callName);
}

/**
 * Execute tool calls from an assistant message.
 */
async function executeToolCalls(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	config: AgentLoopConfig,
	telemetry: AgentTelemetry | undefined,
	invokeAgentSpan: Span | undefined,
): Promise<{ toolResults: ToolResultMessage[]; steeringMessages?: AgentMessage[] }> {
	const tools = currentContext.tools;
	const {
		getSteeringMessages,
		interruptMode = "immediate",
		getToolContext,
		transformToolCallArguments,
		intentTracing,
		beforeToolCall,
		afterToolCall,
	} = config;
	type ToolCallContent = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;
	const toolCalls = assistantMessage.content.filter((c): c is ToolCallContent => c.type === "toolCall");
	const emittedToolResults: ToolResultMessage[] = [];
	const toolCallInfos = toolCalls.map(call => ({ id: call.id, name: call.name }));
	const batchId = `${assistantMessage.timestamp ?? Date.now()}_${toolCalls[0]?.id ?? "batch"}`;
	const shouldInterruptImmediately = interruptMode !== "wait";
	const steeringAbortController = new AbortController();
	const toolSignal = signal
		? AbortSignal.any([signal, steeringAbortController.signal])
		: steeringAbortController.signal;
	const interruptState = { triggered: false };
	let steeringMessages: AgentMessage[] | undefined;
	let steeringCheck: Promise<void> | null = null;

	const records = toolCalls.map(toolCall => ({
		toolCall,
		// Tools emitted via OpenAI's custom-tool path (e.g. `apply_patch` on GPT-5)
		// come back under their wire-level name, which may differ from the
		// harness-internal `name`. Match on either, preferring `name` for
		// determinism if both somehow collide.
		tool:
			tools?.find(t => t.name === toolCall.name) ??
			tools?.find(t => t.customWireName !== undefined && t.customWireName === toolCall.name),
		args: toolCall.arguments as Record<string, unknown>,
		started: false,
		result: undefined as AgentToolResult<any> | undefined,
		isError: false,
		skipped: false,
		toolResultMessage: undefined as ToolResultMessage | undefined,
		resultEmitted: false,
	}));

	const checkSteering = async (): Promise<void> => {
		if (!shouldInterruptImmediately || !getSteeringMessages || interruptState.triggered) {
			return;
		}
		if (steeringCheck) {
			await steeringCheck;
			return;
		}
		steeringCheck = (async () => {
			const steering = await getSteeringMessages();
			if (steering.length > 0) {
				steeringMessages = steering;
				interruptState.triggered = true;
				steeringAbortController.abort();
			}
		})().finally(() => {
			steeringCheck = null;
		});
		await steeringCheck;
	};

	const emitToolResult = (record: (typeof records)[number], result: AgentToolResult<any>, isError: boolean): void => {
		if (record.resultEmitted) return;
		const { toolCall } = record;
		if (!record.started) {
			stream.push({
				type: "tool_execution_start",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				args: record.args,
				intent: toolCall.intent,
			});
		}
		stream.push({
			type: "tool_execution_end",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			result,
			isError,
		});

		const toolResultMessage: ToolResultMessage = {
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: result.content,
			details: result.details,
			isError,
			timestamp: Date.now(),
		};
		record.result = result;
		record.isError = isError;
		record.toolResultMessage = toolResultMessage;
		record.resultEmitted = true;
		emittedToolResults.push(toolResultMessage);

		stream.push({ type: "message_start", message: toolResultMessage });
		stream.push({ type: "message_end", message: toolResultMessage });
	};

	const runTool = async (record: (typeof records)[number], index: number): Promise<void> => {
		if (interruptState.triggered) {
			// Skip both span emission and the collector orphan record here. The
			// tail sweep below (after `Promise.allSettled`) is the single path
			// that handles "no result message was produced" — it calls
			// `recordSkippedTool` and `emitToolResult` once per record, so any
			// work we did here would double-count.
			record.skipped = true;
			return;
		}

		const { toolCall, tool } = record;
		let argsForExecution = toolCall.arguments as Record<string, unknown>;
		if (intentTracing) {
			const { intent, strippedArgs } = extractIntent(toolCall.arguments);
			argsForExecution = strippedArgs;
			if (intent) {
				toolCall.intent = intent;
			} else if (typeof tool?.intent === "function") {
				try {
					const derived = tool.intent(strippedArgs as never)?.trim();
					if (derived) {
						toolCall.intent = derived;
					}
				} catch {
					// intent function must never break tool execution
				}
			}
		}
		record.args = argsForExecution;
		record.started = true;
		stream.push({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: argsForExecution,
			intent: toolCall.intent,
		});

		const toolSpan = startExecuteToolSpan(telemetry, {
			tool,
			toolName: toolCall.name,
			toolCallId: toolCall.id,
			args: argsForExecution,
			parent: invokeAgentSpan,
		});
		if (toolSpan && toolCall.intent) {
			toolSpan.setAttribute(PiGenAIAttr.ToolCallIntent, toolCall.intent);
		}

		let result: AgentToolResult<any> = { content: [], details: {} };
		let isError = false;
		let caughtError: unknown;

		await runInActiveSpan(toolSpan, async () => {
			try {
				if (toolCall.incompleteArguments) {
					// The provider flagged this call's argument JSON as truncated
					// (the model hit its output-token limit mid-call). Executing the
					// best-effort partial parse would run the tool on wrong input, so
					// reject with a retryable, actionable error instead.
					throw new Error(
						`Tool call "${toolCall.name}" was cut off before its arguments finished streaming ` +
							`(the response hit its output token limit). The partial arguments cannot be executed. ` +
							`Re-issue the call with complete arguments, splitting the work into smaller steps if needed.`,
					);
				}
				if (!tool) {
					// A discoverable tool that hasn't been activated yet resolves to
					// undefined here. The model often "remembers" such a tool (e.g.
					// `task`) from earlier context and calls it by name without first
					// re-discovering it. Point it at tool discovery so it can activate
					// the tool and retry instead of giving up on the capability. The
					// base wording stays byte-for-byte stable for downstream consumers;
					// the period and hint are appended only when discovery is callable.
					const base = `Tool ${toolCall.name} not found`;
					const hasToolDiscovery = tools?.some(t => toolMatchesCallName(t, "search_tool_bm25")) ?? false;
					throw new Error(
						hasToolDiscovery
							? `${base}. If you are unsure whether this tool exists or how to use it, call \`search_tool_bm25\` to discover and activate the matching tool, then retry.`
							: base,
					);
				}

				let effectiveArgs: Record<string, unknown>;
				try {
					effectiveArgs = validateToolArguments(tool, { ...toolCall, arguments: argsForExecution });
				} catch (validationError) {
					if (tool.lenientArgValidation) {
						effectiveArgs = argsForExecution;
					} else {
						throw validationError;
					}
				}

				if (beforeToolCall) {
					const beforeResult = await beforeToolCall(
						{
							assistantMessage,
							toolCall,
							args: effectiveArgs,
							context: currentContext,
						},
						toolSignal,
					);
					if (beforeResult?.block) {
						throw new ToolCallBlockedError(beforeResult.reason);
					}
				}
				// Reflect post-hook args so emitted tool results / afterToolCall see what actually executed.
				record.args = effectiveArgs;

				const toolContext = getToolContext
					? getToolContext({
							batchId,
							index,
							total: toolCalls.length,
							toolCalls: toolCallInfos,
						})
					: undefined;
				const rawResult = await tool.execute(
					toolCall.id,
					transformToolCallArguments ? transformToolCallArguments(effectiveArgs, toolCall.name) : effectiveArgs,
					tool.nonAbortable ? undefined : toolSignal,
					partialResult => {
						stream.push({
							type: "tool_execution_update",
							toolCallId: toolCall.id,
							toolName: toolCall.name,
							args: effectiveArgs,
							partialResult: coerceToolResult(partialResult).result,
						});
					},
					toolContext,
				);
				const coerced = coerceToolResult(rawResult);
				result = coerced.result;
				if (coerced.malformed || result.isError) isError = true;
			} catch (e) {
				caughtError = e;
				result = {
					content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
					details: {},
				};
				isError = true;
			}

			if (afterToolCall) {
				try {
					const after = await afterToolCall(
						{
							assistantMessage,
							toolCall,
							args: record.args,
							result,
							isError,
							context: currentContext,
						},
						toolSignal,
					);
					if (after) {
						result = {
							content: after.content ?? result.content,
							details: after.details ?? result.details,
							isError: after.isError ?? result.isError,
						};
						isError = after.isError ?? isError;
					}
				} catch (e) {
					caughtError = e;
					result = {
						content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
						details: {},
					};
					isError = true;
				}
			}
		});

		const interrupted = interruptState.triggered;
		if (interrupted) {
			record.skipped = true;
			emitToolResult(record, createSkippedToolResult(), true);
		} else {
			emitToolResult(record, result, isError);
		}

		const firstTextBlock = result.content?.[0];
		const errorMessageForSpan =
			caughtError === undefined && isError && firstTextBlock?.type === "text" ? firstTextBlock.text : undefined;
		const status = interrupted
			? "aborted"
			: caughtError instanceof ToolCallBlockedError
				? "blocked"
				: isError
					? "error"
					: "ok";
		finishExecuteToolSpan(telemetry, toolSpan, {
			result,
			isError,
			status,
			errorMessage: errorMessageForSpan,
			errorObject: caughtError,
			toolCallId: toolCall.id,
			toolName: toolCall.name,
		});

		await checkSteering();
	};

	let lastExclusive: Promise<void> = Promise.resolve();
	let sharedTasks: Promise<void>[] = [];
	const tasks: Promise<void>[] = [];

	for (let index = 0; index < records.length; index++) {
		const record = records[index];
		const concurrency = record.tool?.concurrency ?? "shared";
		const start = concurrency === "exclusive" ? Promise.all([lastExclusive, ...sharedTasks]) : lastExclusive;
		const task = start.then(() => runTool(record, index));
		tasks.push(task);
		if (concurrency === "exclusive") {
			lastExclusive = task;
			sharedTasks = [];
		} else {
			sharedTasks.push(task);
		}
	}

	await Promise.allSettled(tasks);

	for (const record of records) {
		if (!record.toolResultMessage) {
			record.skipped = true;
			recordSkippedTool(telemetry, {
				toolCallId: record.toolCall.id,
				toolName: record.toolCall.name,
				status: "skipped",
			});
			emitToolResult(record, createSkippedToolResult(), true);
		}
	}

	return { toolResults: emittedToolResults, steeringMessages };
}

/**
 * Create a tool result for a tool call that was aborted or errored before execution.
 * Maintains the tool_use/tool_result pairing required by the API.
 */
function createAbortedToolResult(
	toolCall: Extract<AssistantMessage["content"][number], { type: "toolCall" }>,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	reason: "aborted" | "error",
	errorMessage?: string,
): ToolResultMessage {
	const message = reason === "aborted" ? "Tool execution was aborted" : "Tool execution failed due to an error";
	const result: AgentToolResult<any> = {
		content: [{ type: "text", text: errorMessage ? `${message}: ${errorMessage}` : `${message}.` }],
		details: {},
	};

	stream.push({
		type: "tool_execution_start",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		args: toolCall.arguments,
		intent: toolCall.intent,
	});
	stream.push({
		type: "tool_execution_end",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		result,
		isError: true,
	});

	const toolResultMessage: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: result.content,
		details: {},
		isError: true,
		timestamp: Date.now(),
	};

	stream.push({ type: "message_start", message: toolResultMessage });
	stream.push({ type: "message_end", message: toolResultMessage });

	return toolResultMessage;
}

function createSkippedToolResult(): AgentToolResult<any> {
	return {
		content: [{ type: "text", text: "Skipped due to queued user message." }],
		details: {},
	};
}
