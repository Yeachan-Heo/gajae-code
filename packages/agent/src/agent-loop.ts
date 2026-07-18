/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */

import { types as nodeUtilTypes } from "node:util";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	classifyContextOverflow,
	classifyFallbackTrigger,
	EventStream,
	isZodSchema,
	streamSimple,
	type ToolResultMessage,
	type TSchema,
	transportFailureFacts,
	validateToolArguments,
	zodToWireSchema,
} from "@gajae-code/ai";
import { isInvalidPromptError, neutralizeReservedControlTokens } from "@gajae-code/ai/utils";
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

/**
 * Local staging failure: the provisional buffer limit was exceeded. Carries
 * NO transport facts or status by design — only original typed provider
 * transport facts may authorize provider fallback, so local buffer machinery
 * must never masquerade as provider evidence or consume the fallback chain.
 * It is therefore non-retryable and surfaces as an explicit local error.
 */
class ManagedAttemptBufferOverflowError extends Error {
	constructor() {
		super("Managed fallback attempt exceeded the provisional event buffer limit");
		this.name = "ManagedAttemptBufferOverflowError";
	}
}

/**
 * Local snapshot-machinery failure. Deliberately carries no transport facts
 * or status, so managed fallback classification never treats it as a provider
 * retry trigger — it fails fast instead of burning the fallback chain.
 */
class ManagedAttemptSnapshotError extends Error {
	constructor() {
		super(
			"Managed fallback attempt could not produce a serializable event snapshot (local snapshot bug, not a provider failure)",
		);
		this.name = "ManagedAttemptSnapshotError";
	}
}

const managedAttemptTextEncoder = new TextEncoder();

const ABORTED: unique symbol = Symbol("agent-loop-aborted");
function managedContextOverflow(message: AssistantMessage, config: AgentLoopConfig): boolean {
	const transportFailure = managedTransportFailure(message);
	// Managed empty-stop responses may be repaired by the managed shell below; only
	// typed/error overflows are discardable before that normalization boundary.
	if (config.fallbackManaged && message.stopReason !== "error") return false;
	return classifyContextOverflow(message, transportFailure, config.model.contextWindow);
}

/** Managed fallback owns retry policy; only attached typed transport facts may discard an attempt. */
function managedProperty(value: unknown, key: string): unknown {
	if (!value || typeof value !== "object") return undefined;
	try {
		return Reflect.get(value, key);
	} catch {
		return undefined;
	}
}

function managedTransportFailure(failure: unknown) {
	const facts = managedProperty(failure, "transportFailure");
	return facts && typeof facts === "object" ? transportFailureFacts(facts) : undefined;
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

/**
 * Neutralize leaked reserved control tokens in-place across the outgoing
 * history so a re-send no longer carries the poison that triggered
 * `Request blocked (code=invalid_prompt)`. Only string text fields are
 * rewritten; no history item is ever dropped or reordered. Returns whether any
 * byte actually changed — the circuit breaker uses this to decide between a
 * single repaired resend (changed) and immediate fail-fast (unchanged).
 */
function repairInvalidPromptHistory(messages: AgentMessage[]): boolean {
	let changed = false;
	const repairString = (value: string): string => {
		const next = neutralizeReservedControlTokens(value);
		if (next !== value) changed = true;
		return next;
	};
	for (const message of messages) {
		const content = (message as { content?: unknown }).content;
		if (typeof content === "string") {
			(message as { content: string }).content = repairString(content);
		} else if (Array.isArray(content)) {
			for (const block of content) {
				if (!block || typeof block !== "object") continue;
				const record = block as Record<string, unknown>;
				for (const key of ["text", "thinking"]) {
					const value = record[key];
					if (typeof value === "string") record[key] = repairString(value);
				}
			}
		}
	}
	return changed;
}

function managedFailureOutcome(message: AssistantMessage): ManagedAttemptOutcome {
	return {
		type: "retryable_discarded",
		failure: { message, transportFailure: managedTransportFailure(message) },
	};
}

function managedContextOverflowOutcome(message: AssistantMessage): ManagedAttemptOutcome {
	return { type: "context_overflow_discarded", message };
}

function managedFailureMessage(error: unknown, config: AgentLoopConfig): AssistantMessage {
	const errorMessage = managedProperty(error, "message");
	const transportFailure = managedTransportFailure(error);
	let fallbackMessage = "Managed fallback attempt failed";
	if (typeof errorMessage === "string") fallbackMessage = errorMessage;
	else {
		try {
			fallbackMessage = String(error);
		} catch {
			// Keep the stable local message for hostile wrappers.
		}
	}
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
		errorMessage: fallbackMessage,
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
			? new ManagedAttemptTransaction(stream, config.onAssistantMessageEvent, config.model)
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
			? new ManagedAttemptTransaction(stream, config.onAssistantMessageEvent, config.model)
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

/**
 * Hard work budget for one degraded snapshot: every visited node AND every
 * enumerated own key is debited against this budget before it is processed
 * (accessor keys and re-visits of shared objects included), and any remainder
 * collapses to the deterministic `"[truncated]"` placeholder. Well above
 * ordinary streamed events; it only bounds hostile graphs.
 */
export const MANAGED_SNAPSHOT_MAX_NODES = 100_000;

/**
 * Cycle-aware deep clone that always returns a detached, JSON-serializable
 * value. Used whenever a detached snapshot cannot be safely obtained or
 * measured: after `structuredClone` fails, and again when a (successfully
 * cloned) snapshot cannot be serialized for byte accounting.
 *
 * Totality rules — the walk must never dispatch through payload-controlled
 * code, throw, or do unbounded work:
 * - proxies (revoked or live) are collapsed to `"[unserializable]"` BEFORE
 *   any reflective operation, so `ownKeys`/descriptor traps are never
 *   dispatched (`util.types.isProxy` identifies proxies without touching
 *   their handlers);
 * - only intrinsics are used on the remaining ordinary objects (no
 *   `input.map`, no `input.getTime()`, no `input.length` reads);
 * - arrays are enumerated through their own present keys, never their
 *   declared length, so a sparse array cannot force a dense allocation
 *   proportional to `length`; sparse/exotic arrays degrade to a null-proto
 *   record of their present indices, and the dense-shape decision verifies
 *   every index against its ordinal;
 * - the walk debits `maxNodes` budget per visited node and per enumerated
 *   key before processing it; anything beyond the budget becomes
 *   `"[truncated]"` (the one linear primitive per visited node is a single
 *   `Object.keys` call on a non-proxy object the process already holds);
 * - property values are read via own-property descriptors, so accessors are
 *   never invoked (a snapshot must not cause observable side effects) and are
 *   replaced with `"[accessor]"`;
 * - functions/symbols and any property that cannot be read safely become
 *   short placeholders, `bigint` becomes its decimal string, and references
 *   back into the current path collapse to `"[Circular]"`;
 * - records are built on a null prototype so a `__proto__` key cannot mutate
 *   the clone's prototype chain.
 *
 * Exported for direct regression coverage of the budget accounting; runtime
 * callers use the default budget via {@link managedAttemptSnapshot}.
 */
export function sanitizedDetachedClone<T>(value: T, maxNodes: number = MANAGED_SNAPSHOT_MAX_NODES): T {
	const path = new Set<object>();
	let budget = maxNodes;
	const takeBudget = (units: number): boolean => {
		if (budget < units) {
			budget = 0;
			return false;
		}
		budget -= units;
		return true;
	};
	const walk = (input: unknown): unknown => {
		if (!takeBudget(1)) return "[truncated]";
		if (typeof input === "bigint") return String(input);
		if (typeof input === "function" || typeof input === "symbol") return "[unserializable]";
		if (input === null || typeof input !== "object") return input;
		if (nodeUtilTypes.isProxy(input)) return "[unserializable]";
		if (path.has(input)) return "[Circular]";
		path.add(input);
		const readOwnValue = (key: string): unknown => {
			try {
				const descriptor = Object.getOwnPropertyDescriptor(input, key);
				return descriptor === undefined
					? "[unserializable]"
					: "value" in descriptor
						? walk(descriptor.value)
						: "[accessor]";
			} catch {
				return "[unserializable]";
			}
		};
		try {
			if (Array.isArray(input)) {
				// Own present keys only: iterating the declared length would
				// densify holes, and `Object.keys` is proportional to the
				// elements that actually exist.
				const keys = Object.keys(input);
				if (!takeBudget(keys.length)) return "[truncated]";
				const indexKeys: string[] = [];
				let hasExtraProps = false;
				for (const key of keys) {
					const index = Number(key);
					if (String(index) === key && index >= 0) indexKeys.push(key);
					else hasExtraProps = true;
				}
				let dense = !hasExtraProps;
				if (dense) {
					for (let ordinal = 0; ordinal < indexKeys.length; ordinal++) {
						if (Number(indexKeys[ordinal]) !== ordinal) {
							dense = false;
							break;
						}
					}
				}
				if (dense) {
					const out: unknown[] = [];
					for (const key of indexKeys) out.push(readOwnValue(key));
					return out;
				}
				const sparse: Record<string, unknown> = Object.create(null);
				for (const key of indexKeys) sparse[key] = readOwnValue(key);
				return sparse;
			}
			let dateTime: number | undefined;
			try {
				// `isDate` checks the [[DateValue]] internal slot without walking
				// the prototype chain — `instanceof Date` would dispatch a proxy
				// prototype's getPrototypeOf trap and do unbudgeted linear work
				// on deep ordinary chains.
				dateTime = nodeUtilTypes.isDate(input) ? Date.prototype.getTime.call(input) : undefined;
			} catch {
				dateTime = undefined;
			}
			if (dateTime !== undefined) return new Date(dateTime);
			const keys = Object.keys(input);
			if (!takeBudget(keys.length)) return "[truncated]";
			const record: Record<string, unknown> = Object.create(null);
			for (const key of keys) record[key] = readOwnValue(key);
			return record;
		} catch {
			// Brand checks / key enumeration on exotic objects can throw;
			// collapse only this node, not its ancestors.
			return "[unserializable]";
		} finally {
			path.delete(input);
		}
	};
	return walk(value) as T;
}

/**
 * Capture an event-time value because providers commonly mutate partial
 * messages in place. The snapshot MUST always be detached from the caller's
 * object graph — replaying a live reference would surface the final mutation
 * instead of the event-time value. It must also never throw: staged payloads
 * can carry non-cloneable objects during provisional assistant streaming
 * (e.g. a live `Headers` inside a provider error's `transportFailure` from a
 * legacy payload), and a thrown `DataCloneError` here would mask the real
 * provider outcome and burn the whole fallback chain.
 */
function managedAttemptSnapshotDetailed<T>(value: T): { snapshot: T; degraded: boolean } {
	try {
		return { snapshot: structuredClone(value), degraded: false };
	} catch {
		return { snapshot: sanitizedDetachedClone(value), degraded: true };
	}
}

function managedAttemptSnapshot<T>(value: T): T {
	return managedAttemptSnapshotDetailed(value).snapshot;
}

/**
 * Recover the required assistant-message shell when a managed snapshot degrades
 * at its root (notably for Proxy-wrapped provider messages). Only known fields
 * are read, and executable content is retained only when it has its complete
 * discriminant shape.
 */
function managedAssistantShell(value: unknown, model: AgentLoopConfig["model"]): AssistantMessage {
	const detailed = managedAttemptSnapshotDetailed(value);
	const source = isManagedPlainRecord(detailed.snapshot) ? detailed.snapshot : value;
	if (managedProperty(source, "role") !== "assistant") throw new ManagedAttemptSnapshotError();
	const rawContent = managedAttemptSnapshot(managedProperty(source, "content"));
	if (!Array.isArray(rawContent)) throw new ManagedAttemptSnapshotError();
	const content = rawContent.flatMap(block => {
		const normalized = managedAssistantContent(block);
		return normalized ? [normalized] : [];
	});
	const usage = managedAssistantUsage(managedAttemptSnapshot(managedProperty(source, "usage")));
	const api = managedProperty(source, "api");
	const provider = managedProperty(source, "provider");
	const messageModel = managedProperty(source, "model");
	const stopReasonValue = managedProperty(source, "stopReason");
	const stopReason =
		stopReasonValue === "stop" ||
		stopReasonValue === "length" ||
		stopReasonValue === "toolUse" ||
		stopReasonValue === "error" ||
		stopReasonValue === "aborted"
			? stopReasonValue
			: "stop";
	const timestamp = managedProperty(source, "timestamp");
	const transportFailure = managedTransportFailure(value);
	const errorMessage = managedProperty(source, "errorMessage");
	const errorStatus = managedProperty(source, "errorStatus");
	const safeMetadata: Record<string, unknown> = isManagedPlainRecord(detailed.snapshot)
		? { ...detailed.snapshot }
		: {};
	delete safeMetadata.errorMessage;
	delete safeMetadata.errorStatus;
	delete safeMetadata.transportFailure;
	return {
		...safeMetadata,
		role: "assistant",
		content,
		api: typeof api === "string" ? (api as AssistantMessage["api"]) : model.api,
		provider: typeof provider === "string" ? (provider as AssistantMessage["provider"]) : model.provider,
		model: typeof messageModel === "string" ? messageModel : model.id,
		usage,
		stopReason,
		timestamp: typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : Date.now(),
		...(transportFailure ? { transportFailure } : {}),
		...(typeof errorMessage === "string" ? { errorMessage } : {}),
		...(typeof errorStatus === "number" && Number.isFinite(errorStatus) ? { errorStatus } : {}),
	};
}

function managedAssistantContent(value: unknown): AssistantMessage["content"][number] | undefined {
	if (!isManagedPlainRecord(value)) return undefined;
	const type = managedProperty(value, "type");
	if (type === "text") {
		const text = managedProperty(value, "text");
		return typeof text === "string" ? { type, text } : undefined;
	}
	if (type === "thinking") {
		const thinking = managedProperty(value, "thinking");
		return typeof thinking === "string" ? { type, thinking } : undefined;
	}
	if (type === "redactedThinking") {
		const data = managedProperty(value, "data");
		return typeof data === "string" ? { type, data } : undefined;
	}
	if (type !== "toolCall") return undefined;
	const id = managedProperty(value, "id");
	const name = managedProperty(value, "name");
	const argumentsValue = managedProperty(value, "arguments");
	if (typeof id !== "string" || typeof name !== "string" || !isManagedPlainRecord(argumentsValue)) return undefined;
	const thoughtSignature = managedProperty(value, "thoughtSignature");
	const intent = managedProperty(value, "intent");
	const customWireName = managedProperty(value, "customWireName");
	const incompleteArguments = managedProperty(value, "incompleteArguments");
	return {
		type,
		id,
		name,
		arguments: argumentsValue,
		...(typeof thoughtSignature === "string" ? { thoughtSignature } : {}),
		...(typeof intent === "string" ? { intent } : {}),
		...(typeof customWireName === "string" ? { customWireName } : {}),
		...(typeof incompleteArguments === "boolean" ? { incompleteArguments } : {}),
	};
}

function managedAssistantUsage(value: unknown): AssistantMessage["usage"] {
	const number = (key: string): number => {
		const candidate = managedProperty(value, key);
		return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : 0;
	};
	const costValue = managedProperty(value, "cost");
	const costNumber = (key: string): number => {
		const candidate = managedProperty(costValue, key);
		return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : 0;
	};
	return {
		input: number("input"),
		output: number("output"),
		cacheRead: number("cacheRead"),
		cacheWrite: number("cacheWrite"),
		totalTokens: number("totalTokens"),
		cost: {
			input: costNumber("input"),
			output: costNumber("output"),
			cacheRead: costNumber("cacheRead"),
			cacheWrite: costNumber("cacheWrite"),
			total: costNumber("total"),
		},
	};
}

function managedAssistantEventSnapshot(event: AssistantMessageEvent, message: AssistantMessage): AssistantMessageEvent {
	const snapshot = managedAttemptSnapshot(event);
	if (!isManagedPlainRecord(snapshot)) throw new ManagedAttemptSnapshotError();
	const type = managedProperty(snapshot, "type");
	const contentIndex = managedProperty(snapshot, "contentIndex");
	const indexed = () => {
		if (!Number.isInteger(contentIndex) || (contentIndex as number) < 0) throw new ManagedAttemptSnapshotError();
		return contentIndex as number;
	};
	if (type === "start") return { type, partial: message };
	if (type === "text_start" || type === "thinking_start" || type === "toolcall_start")
		return { type, contentIndex: indexed(), partial: message };
	if (type === "text_delta" || type === "thinking_delta" || type === "toolcall_delta") {
		const delta = managedProperty(snapshot, "delta");
		if (typeof delta !== "string") throw new ManagedAttemptSnapshotError();
		return { type, contentIndex: indexed(), delta, partial: message };
	}
	if (type === "text_end" || type === "thinking_end") {
		const content = managedProperty(snapshot, "content");
		if (typeof content !== "string") throw new ManagedAttemptSnapshotError();
		return { type, contentIndex: indexed(), content, partial: message };
	}
	if (type === "toolcall_end") {
		const toolCall = managedAssistantContent(managedProperty(snapshot, "toolCall"));
		if (toolCall?.type !== "toolCall") throw new ManagedAttemptSnapshotError();
		return { type, contentIndex: indexed(), toolCall, partial: message };
	}
	if (type === "done") {
		const reason = managedProperty(snapshot, "reason");
		if (reason !== "stop" && reason !== "length" && reason !== "toolUse") throw new ManagedAttemptSnapshotError();
		return { type, reason, message };
	}
	if (type === "error") {
		const reason = managedProperty(snapshot, "reason");
		if (reason !== "aborted" && reason !== "error") throw new ManagedAttemptSnapshotError();
		return { type, reason, error: message };
	}
	throw new ManagedAttemptSnapshotError();
}

function isManagedPlainRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) && !nodeUtilTypes.isProxy(value);
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
		private readonly onAssistantMessageEvent:
			| ((message: AssistantMessage, event: AssistantMessageEvent) => void)
			| undefined,
		private readonly model: AgentLoopConfig["model"],
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
		const partial = managedAssistantShell(message, this.model);
		this.#batch.push({
			type: "assistant_event",
			message: partial,
			event: managedAssistantEventSnapshot(event, partial),
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

	#wouldOverflow(bytes: number): boolean {
		return (
			this.#stagedEventCount + 1 > MANAGED_ATTEMPT_MAX_STAGED_EVENTS ||
			this.#stagedBytes + bytes > MANAGED_ATTEMPT_MAX_STAGED_BYTES
		);
	}

	#stage(event: AgentEvent): void {
		// Measure the raw event FIRST so an oversized payload is rejected
		// before the snapshot duplicates it — the staged-byte cap exists to
		// bound memory, so cloning ahead of the check would defeat it.
		// Cyclic/JSON-hostile events cannot be pre-measured; only those fall
		// through to snapshot-then-measure, where the sanitized detached form
		// is the cycle-safe estimator.
		let bytes: number | undefined;
		try {
			bytes = managedAttemptTextEncoder.encode(JSON.stringify(event)).byteLength;
		} catch {
			bytes = undefined;
		}
		if (bytes !== undefined && this.#wouldOverflow(bytes)) {
			this.discard();
			throw new ManagedAttemptBufferOverflowError();
		}
		const detailed = managedAttemptSnapshotDetailed(this.#repairAssistantEvent(event));
		let snapshot = detailed.snapshot;
		if (bytes === undefined || detailed.degraded) {
			// Account the bytes of what is actually retained: a degraded
			// snapshot replaces non-JSON leaves with placeholders, so the raw
			// pre-measure (which omits e.g. function-valued properties) can
			// undercount the staged form.
			try {
				bytes = managedAttemptTextEncoder.encode(JSON.stringify(snapshot)).byteLength;
			} catch {
				try {
					snapshot = sanitizedDetachedClone(snapshot);
					bytes = managedAttemptTextEncoder.encode(JSON.stringify(snapshot)).byteLength;
				} catch {
					bytes = undefined;
				}
			}
			if (bytes === undefined) {
				// The sanitizer's output is total (detached, JSON-safe), so this
				// is unreachable unless the sanitizer itself regresses. Fail as a
				// dedicated local error: it carries no transport facts, so it is
				// non-retryable and can never be misattributed to the provider.
				this.discard();
				throw new ManagedAttemptSnapshotError();
			}
			if (this.#wouldOverflow(bytes)) {
				this.discard();
				throw new ManagedAttemptBufferOverflowError();
			}
		}
		this.#batch.push({ type: "event", event: snapshot });
		this.#stagedEventCount += 1;

		this.#stagedBytes += bytes;
	}

	#repairAssistantEvent(event: AgentEvent): AgentEvent {
		if (event.type === "message_start" || event.type === "message_end" || event.type === "turn_end") {
			return event.message.role === "assistant"
				? { ...event, message: managedAssistantShell(event.message, this.model) }
				: event;
		}
		if (event.type === "message_update") {
			const message = managedAssistantShell(event.message, this.model);
			return {
				...event,
				message,
				assistantMessageEvent: managedAssistantEventSnapshot(event.assistantMessageEvent, message),
			};
		}
		if (event.type === "agent_end") {
			return {
				...event,
				messages: event.messages.map(message =>
					message.role === "assistant" ? managedAssistantShell(message, this.model) : message,
				),
			};
		}
		return event;
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
	const loopSignal = signal ?? new AbortController().signal;

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
				loopSignal,

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
	loopSignal: AbortSignal,

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
	// Whether at least one assistant response has been produced in THIS run. The
	// mid-run maintenance checkpoint only fires between tool iterations (after a
	// model response); pre-turn maintenance is the pre-prompt check's job, so the
	// first iteration is skipped to avoid duplicating/racing it.
	let modelHasResponded = false;
	let harmonyTruncateResumeCount = 0;
	// Fires at most one repaired resend per run for the poisoned-history
	// `invalid_prompt` circuit breaker below.
	let invalidPromptRepairAttempted = false;

	// Outer loop: continues when queued follow-up messages arrive after agent would stop
	while (true) {
		let hasMoreToolCalls = true;

		// Inner loop: process tool calls and steering messages
		while (hasMoreToolCalls || pendingMessages.length > 0) {
			const transaction =
				initialTransaction ??
				(config.fallbackManaged
					? new ManagedAttemptTransaction(stream, config.onAssistantMessageEvent, config.model)
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

			// Cooperative mid-run context maintenance. Runs after pending
			// tool/steering messages are materialized into durable context and
			// before syncContextBeforeModelCall / the model call — the only
			// boundary where the full unsent context is already durable. A
			// non-"not-needed" outcome means context was (or was attempted to be)
			// rewritten, so end the run WITHOUT the lossy agent_end finalization;
			// the maintenance owner resumes the run on the rewritten context.
			// "not-needed" falls through to the model call.
			if (config.maintainContext && modelHasResponded && !loopSignal.aborted) {
				const lifecycle = {
					signal: loopSignal,
					awaitEventDrain: (invocationSignal: AbortSignal) =>
						stream.waitForConsumerDrain(AbortSignal.any([loopSignal, invocationSignal])),
				};
				const maintenanceOutcome = await config.maintainContext(currentContext, lifecycle);
				// A callback can settle after its loop has been cancelled. Never let a
				// stale "not-needed" fall through to streamAssistantResponse, which
				// invokes the provider before it observes the aborted signal.
				const outcome = loopSignal.aborted ? "aborted" : maintenanceOutcome;

				if (outcome !== "not-needed") {
					stream.push({
						type: "agent_end",
						messages: newMessages,
						stopReason: "maintenance",
						maintenanceOutcome: outcome,
					});
					stream.end(newMessages);
					return;
				}
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
					loopSignal,
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
					const failureMessage = managedFailureMessage(err, config);
					if (config.fallbackManaged && transaction && managedContextOverflow(failureMessage, config)) {
						transaction.discard();
						currentContext.messages.splice(contextMessageCount);
						newMessages.splice(newMessageCount);
						await config.onManagedAttemptOutcome?.(managedContextOverflowOutcome(failureMessage));
						stream.end(newMessages);
						return;
					}
					if (config.fallbackManaged && transaction && managedRetryableFailure(err)) {
						transaction.discard();
						currentContext.messages.splice(contextMessageCount);
						newMessages.splice(newMessageCount);
						await config.onManagedAttemptOutcome?.(managedFailureOutcome(failureMessage));
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
			// Session-level invalid_prompt circuit breaker (bounded, neutralize-only).
			// A poisoned-history rejection (`Request blocked (code=invalid_prompt)`) is
			// a deterministic content fault: re-sending the same history re-triggers it,
			// so naive session auto-retry would burn its whole budget re-poisoning the
			// model. On the first invalid_prompt of this run, neutralize leaked control
			// tokens in history IN PLACE (never dropping items). If that changed the
			// outgoing bytes, resend exactly once with the repaired history; if
			// neutralization cannot change anything (nothing left to repair), fall
			// through to terminal handling and fail fast. Budget = one repaired resend.
			// Runs before the response is committed so the resend is a clean retry;
			// managed fallback owns its own retry policy, so this is scoped to the
			// non-managed session path where uncontrolled auto-retry would recur.
			if (
				!config.fallbackManaged &&
				message.stopReason === "error" &&
				!invalidPromptRepairAttempted &&
				isInvalidPromptError(message)
			) {
				invalidPromptRepairAttempted = true;
				if (repairInvalidPromptHistory(currentContext.messages)) {
					continue;
				}
			}

			const overflow = managedContextOverflow(message, config);
			if (config.fallbackManaged && overflow) {
				transaction?.discard();
				currentContext.messages.splice(contextMessageCount);
				newMessages.splice(newMessageCount);
				await config.onManagedAttemptOutcome?.(managedContextOverflowOutcome(message));
				stream.end(newMessages);
				return;
			}

			newMessages.push(message);
			modelHasResponded = true;
			let steeringMessagesFromExecution: AgentMessage[] | undefined;

			// Preserve the historical public error conversion for unmanaged proxy overflows.
			if (!config.fallbackManaged && message.stopReason === "stop" && message.content.length === 0 && overflow) {
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
			if (attemptTransaction) {
				message = managedAssistantShell(message, config.model);
				const index = currentContext.messages.length - 1;
				if (index >= 0 && currentContext.messages[index]?.role === "assistant") {
					currentContext.messages[index] = message;
				}
				newMessages[newMessages.length - 1] = message;
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
					loopSignal,
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
							partialMessage = config.fallbackManaged
								? managedAssistantShell(event.partial, config.model)
								: event.partial;
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
						case "reasoning_summary_start":
						case "reasoning_summary_delta":
						case "reasoning_summary_end":
						case "toolcall_start":
						case "toolcall_delta":
						case "toolcall_end":
							if (partialMessage) {
								partialMessage = config.fallbackManaged
									? managedAssistantShell(event.partial, config.model)
									: event.partial;
								const partialEvent = config.fallbackManaged ? { ...event, partial: partialMessage } : event;
								context.messages[context.messages.length - 1] = partialMessage;
								config.onAssistantMessageEvent?.(partialMessage, partialEvent);
								if (signal?.aborted) continue;
								stream.push({
									type: "message_update",
									assistantMessageEvent: partialEvent,
									message: { ...partialMessage },
								});
							}
							break;

						case "done":
						case "error": {
							const finalMessage = config.fallbackManaged
								? managedAssistantShell(await response.result(), config.model)
								: await response.result();
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

			const trailing = config.fallbackManaged
				? managedAssistantShell(await response.result(), config.model)
				: await response.result();
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
