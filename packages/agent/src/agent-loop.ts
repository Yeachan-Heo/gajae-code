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
	EMPTY_RESPONSE_PROVIDER_CODE,
	EventStream,
	isProviderSafetyStopAuthenticated,
	isZodSchema,
	streamSimple,
	type ToolChoice,
	type ToolResultMessage,
	type TSchema,
	transportFailureFacts,
	type UserMessage,
	validateToolArguments,
	zodToWireSchema,
} from "@gajae-code/ai";
import {
	COMPOSER_BASH_POLICY_RECOVERY_PROMPT,
	isCurrentComposerBashPolicyBlockedError,
} from "@gajae-code/ai/providers/composer-discipline";
import {
	isInvalidPromptError,
	isReasoningContentReplayError,
	neutralizeReservedControlTokens,
	stripUnusableReasoningItems,
} from "@gajae-code/ai/utils";
import { isCursorExecResolved } from "@gajae-code/ai/utils/block-symbols";
import {
	attachUnicodeEscapeEvidence,
	type UnicodeEscapeEvidence,
	unicodeEscapePathTag,
	unicodeEscapeScalarTag,
	verifyUnicodeEscapeEvidence,
} from "@gajae-code/ai/utils/json-parse";
import { $credentialEnv, sanitizeText } from "@gajae-code/utils";
import * as logger from "@gajae-code/utils/logger";
import { revokeProviderSafetyStop } from "../../ai/src/adapter-internals/provider-safety-stop";
import type { AttemptScope } from "./attempt-scope";
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
import escapedNonAsciiRecoveryPrompt from "./prompts/escaped-nonascii-recovery.md" with { type: "text" };
import repeatedToolFailureRecoveryPrompt from "./prompts/repeated-tool-failure-recovery.md" with { type: "text" };
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
import {
	activeToolForCallName,
	bindDispatchedToolIdentity,
	markNonDispatchedToolEvent,
} from "./tool-dispatch-identity";
import {
	type AgentContext,
	type AgentEvent,
	type AgentLoopConfig,
	type AgentMessage,
	type AgentTool,
	type AgentToolContext,
	type AgentToolResult,
	type ManagedAttemptOutcome,
	type StandaloneRunOwnership,
	type StreamFn,
	toolFailureEnvelope,
} from "./types";

// Capture the intrinsic before any tool/hook can replace `Reflect.apply`. Calling this
// local binding performs no user-controlled property lookup between publishing a dispatch
// start and entering the selected execute function.
const intrinsicReflectApply = Reflect.apply;

/** Sentinel returned by the abort race in `streamAssistantResponse`. */
/**
 * Defensive caps for a provisional managed attempt. These are intentionally
 * well above ordinary streamed responses; they only bound memory when an
 * upstream emits an unbounded event stream before the attempt can commit.
 */
export const MANAGED_ATTEMPT_MAX_STAGED_EVENTS = 10_000;
export const MANAGED_ATTEMPT_MAX_STAGED_BYTES = 16 * 1024 * 1024;

/**
 * Hard ceilings for the operator overrides. The caps exist to bound memory, so
 * an override may raise them only within a range that still leaves the guard
 * meaningful — near-`MAX_SAFE_INTEGER` values would trade a typed, bounded
 * `local_buffer_overflow` for a process OOM, which is strictly harder to
 * diagnose. Above-ceiling overrides clamp to the ceiling with a warning
 * instead of being honored.
 *
 * The ceilings are derived from a survivable PEAK-RSS budget, not from the
 * counted-bytes number: peak resident memory holds the live payload, its
 * detached snapshot, and the retained batch simultaneously, so it is a
 * multiple of the counted bytes. Sizing itself is walk-based (no JSON string
 * or UTF-8 copy is materialized to measure), which is why the factor below
 * covers the live value plus one detached copy plus batch retention with
 * headroom. The bytes ceiling is the peak budget divided by that multiplier,
 * so an override at the ceiling still fits an ordinary host. The events
 * ceiling is the object-count equivalent for the same budget at a
 * conservative per-item floor.
 */
export const MANAGED_STAGED_PEAK_RSS_BUDGET_BYTES = 4 * 1024 * 1024 * 1024;
export const MANAGED_STAGED_PEAK_RSS_FACTOR = 4;
export const MANAGED_ATTEMPT_STAGED_EVENTS_CEILING = 2_000_000;
export const MANAGED_ATTEMPT_STAGED_BYTES_CEILING = Math.floor(
	MANAGED_STAGED_PEAK_RSS_BUDGET_BYTES / MANAGED_STAGED_PEAK_RSS_FACTOR,
);

/**
 * Warn once per distinct (knob, requested value) per process. The caps are
 * re-read for every managed transaction — every streaming turn — so an
 * unmemoized warning would re-log the same oversized operator value once per
 * turn for the life of the process, embedding the full requested string in
 * every record (log amplification). A bounded digest is logged instead of
 * the raw value for the same reason.
 */
const clampedCapWarnings = new Set<string>();

function warnClampedStagedCap(
	name: "GJC_FALLBACK_MAX_STAGED_EVENTS" | "GJC_FALLBACK_MAX_STAGED_BYTES",
	requested: number | string,
	ceiling: number,
): void {
	// A parsed number is already bounded; only the raw decimal string (which
	// the beyond-safe-integer path can supply at arbitrary length) is reduced
	// to a length-and-prefix digest before it is embedded in a log record.
	const requestedPayload =
		typeof requested === "number" ? requested : `${requested.length} digits (starts ${requested.slice(0, 8)})`;
	const key = `${name}:${String(requestedPayload)}`;
	if (clampedCapWarnings.has(key)) return;
	clampedCapWarnings.add(key);
	logger.warn(`${name} clamped to ${ceiling}: the provisional staging guard must stay bounded`, {
		requested: requestedPayload,
		ceiling,
	});
}

function clampedStagedCap(
	name: "GJC_FALLBACK_MAX_STAGED_EVENTS" | "GJC_FALLBACK_MAX_STAGED_BYTES",
	fallback: number,
	ceiling: number,
): number {
	// Resolve from TRUSTED environment sources only ($credentialEnv excludes the
	// caller's cwd/.env overlay): these knobs ARE a defensive resource guard, so
	// a repository-controlled .env must not be able to weaken (or tighten into
	// failure) the staging bound. Values must be positive integers (digits only
	// after the trusted resolver's surrounding-whitespace normalization);
	// anything else falls back to the default. Any digits-only positive
	// decimal that is at or below the ceiling is honored verbatim, and any
	// digits-only positive decimal above the ceiling — including ones beyond
	// Number.MAX_SAFE_INTEGER, which a numeric parse would misclassify — clamps
	// to the ceiling with a warning, exactly as documented.
	const raw = $credentialEnv(name)?.trim();
	if (raw === undefined) return fallback;
	const parsed = parsePositiveEnvInt(raw);
	if (parsed !== undefined) {
		if (parsed <= ceiling) return parsed;
		warnClampedStagedCap(name, parsed, ceiling);
		return ceiling;
	}
	if (isPositiveDecimalDigits(raw) && decimalAtLeast(raw, ceiling + 1)) {
		warnClampedStagedCap(name, raw, ceiling);
		return ceiling;
	}
	return fallback;
}

function parsePositiveEnvInt(raw: string): number | undefined {
	if (!raw || !/^\d+$/.test(raw)) return undefined;
	const parsed = Number(raw);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** True when the value is a digits-only positive decimal string (no sign). */
function isPositiveDecimalDigits(raw: string): boolean {
	return raw.length > 0 && /^\d+$/.test(raw) && raw.replace(/^0+/, "") !== "";
}

/**
 * Lexical comparison of a digits-only decimal against a numeric threshold,
 * valid past Number.MAX_SAFE_INTEGER: compare stripped-leading-zero digit
 * length first, then digit by digit.
 */
function decimalAtLeast(raw: string, threshold: number): boolean {
	const digits = raw.replace(/^0+/, "");
	const thresholdDigits = String(threshold).replace(/^0+/, "");
	if (digits.length !== thresholdDigits.length) return digits.length > thresholdDigits.length;
	return digits >= thresholdDigits;
}

/**
 * Max events staged by a provisional managed-attempt transaction before it is
 * rejected. Configurable via `GJC_FALLBACK_MAX_STAGED_EVENTS` (default
 * `MANAGED_ATTEMPT_MAX_STAGED_EVENTS`, ceiling
 * `MANAGED_ATTEMPT_STAGED_EVENTS_CEILING`). Read once per transaction so
 * operators can raise the cap without a rebuild and tests can exercise the
 * knob in-process. Values must be positive integers after the trusted
 * resolver ignores surrounding whitespace; invalid or
 * non-positive values fall back to the default, and values above the ceiling
 * clamp to it with a warning.
 *
 * @internal
 */
export function managedAttemptMaxStagedEvents(): number {
	return clampedStagedCap(
		"GJC_FALLBACK_MAX_STAGED_EVENTS",
		MANAGED_ATTEMPT_MAX_STAGED_EVENTS,
		MANAGED_ATTEMPT_STAGED_EVENTS_CEILING,
	);
}

/**
 * Max bytes staged by a provisional managed-attempt transaction before it is
 * rejected. Configurable via `GJC_FALLBACK_MAX_STAGED_BYTES` (default
 * `MANAGED_ATTEMPT_MAX_STAGED_BYTES`, ceiling
 * `MANAGED_ATTEMPT_STAGED_BYTES_CEILING`). Read once per transaction; values
 * must be positive integers after the trusted resolver ignores surrounding
 * whitespace, anything else falls back to the
 * default, and values above the ceiling clamp to it with a warning.
 *
 * @internal
 */
export function managedAttemptMaxStagedBytes(): number {
	return clampedStagedCap(
		"GJC_FALLBACK_MAX_STAGED_BYTES",
		MANAGED_ATTEMPT_MAX_STAGED_BYTES,
		MANAGED_ATTEMPT_STAGED_BYTES_CEILING,
	);
}

/**
 * Closed set of local-failure sites. A bounded diagnostic may name only these
 * literals: the log is shape-only, so no caller-supplied or provider-derived
 * string may ever reach it.
 */
const MANAGED_LOCAL_FAILURE_STAGES = [
	"shell.role",
	"shell.content",
	"event.snapshot",
	"event.contentIndex",
	"event.delta",
	"event.content",
	"event.toolcall",
	"event.done.reason",
	"event.error.reason",
	"event.unknownType",
	"staging.losslessSnapshot",
	"staging.measure",
	"staging.sanitize",
	"staging.preMeasure",
	"staging.overflow",
	"overflow.preMeasure",
	"overflow.staged",
] as const;
type ManagedLocalFailureStage = (typeof MANAGED_LOCAL_FAILURE_STAGES)[number];
const MANAGED_LOCAL_FAILURE_STAGE_SET: ReadonlySet<string> = new Set(MANAGED_LOCAL_FAILURE_STAGES);

/**
 * Local staging failure: the provisional buffer limit was exceeded. Carries
 * NO transport facts or status by design — only original typed provider
 * transport facts may authorize provider fallback, so local buffer machinery
 * must never masquerade as provider evidence or consume the fallback chain.
 * The typed `local_buffer_overflow` kind lets session retry policy surface it
 * immediately without any retry: re-streaming the same request reproduces the
 * same oversized response, so an automatic re-issue only burns tokens.
 */
class ManagedAttemptBufferOverflowError extends Error {
	readonly errorKind = "local_buffer_overflow" as const;
	/**
	 * Shape-only overflow diagnostics: the rejecting stage, which cap was
	 * exceeded, the staged counters at rejection, the incoming event's size
	 * (so a single oversized event explains itself), and the limits. Every
	 * field is synthesized locally (closed stage/cap vocabulary, numeric
	 * counters, numeric limits), so no provider or prompt text can reach a
	 * downstream surface through this object.
	 *
	 * `exceeded` names the cap that tripped: `events`, `bytes`, or `both`.
	 * The staged counters alone cannot say which — after #4610's compaction
	 * they describe the retained batch, which is at or below both caps; the
	 * projected values (`stagedBytes + incomingEventBytes`,
	 * `stagedEventCount + 1`) are what crossed a limit.
	 *
	 * The `.message` keeps its stable prefix (session retry policy
	 * prefix-classifies on it) and appends the same shape, because the thrown
	 * error itself — not the `managedFailureMessage` wrapper — is what surfaces
	 * on the non-retryable local exit path and issue reports (#4618). Parent
	 * task receipts consume the structured shape, never this string.
	 */
	constructor(
		readonly stage: ManagedLocalFailureStage,
		readonly overflow: {
			stage: ManagedLocalFailureStage;
			exceeded: "events" | "bytes" | "both";
			stagedEventCount: number;
			stagedBytes: number;
			incomingEventBytes: number;
			maxStagedEvents: number;
			maxStagedBytes: number;
		},
	) {
		super(managedBufferOverflowMessage(overflow));
		this.name = "ManagedAttemptBufferOverflowError";
	}
}

/**
 * Stable, prefix-anchored, shape-only message for a provisional staging-buffer
 * overflow. The leading sentence is load-bearing (the session prefix-classifies
 * legacy messages on it); the parenthetical names the stage, the exceeded cap,
 * the projected counters, and the limits so the failure reads as the local,
 * reproducible staging condition it is — not a provider or context-window
 * problem.
 */
function managedBufferOverflowMessage(overflow: ManagedAttemptBufferOverflowError["overflow"]): string {
	return (
		"Managed fallback attempt exceeded the provisional event buffer limit " +
		`(stage=${overflow.stage}; exceeded=${overflow.exceeded}; staged ${overflow.stagedEventCount}/${
			overflow.maxStagedEvents
		} events, ${overflow.stagedBytes} staged bytes + ${overflow.incomingEventBytes} incoming = ` +
		`${overflow.stagedBytes + overflow.incomingEventBytes}/${overflow.maxStagedBytes} projected bytes; local staging ` +
		"buffer limit, not a provider or context-window failure; re-issuing the same request will reproduce it)"
	);
}

/**
 * Local snapshot-machinery failure. Deliberately carries no transport facts
 * or status, so managed fallback classification never treats it as a provider
 * retry trigger — it never burns the fallback chain, advances models, or
 * mutates credentials. The typed `local_snapshot_failure` kind lets session
 * policy surface the producer-boundary diagnostic immediately instead of
 * amplifying one deterministic local defect across identical retries.
 */
class ManagedAttemptSnapshotError extends Error {
	readonly errorKind = "local_snapshot_failure" as const;
	constructor(readonly stage: ManagedLocalFailureStage) {
		super(
			"Managed fallback attempt could not produce a serializable event snapshot (local snapshot bug, not a provider failure)",
		);
		this.name = "ManagedAttemptSnapshotError";
	}
}

const managedAttemptTextEncoder = new TextEncoder();

const ABORTED: unique symbol = Symbol("agent-loop-aborted");
interface StandaloneOwnershipState {
	continuationAvailable: boolean;
	continuationClaimed: boolean;
	terminal: boolean;
}

const standaloneOwnershipStates = new WeakMap<StandaloneRunOwnership, StandaloneOwnershipState>();

/**
 * Terminal bound for argument-validation loops: how many CONSECUTIVE turns may
 * consist entirely of malformed tool calls before the run stops.
 *
 * The one-shot tools-free recovery turn fires first; this is the deterministic
 * backstop for a model that keeps emitting unusable calls after it. Counted per
 * turn rather than per argument signature so a model rotating invalid shapes is
 * bounded too.
 */
const MAX_CONSECUTIVE_MALFORMED_TURNS = 5;

/**
 * How many times a single turn may be re-requested because its tool arguments
 * arrived as `\uXXXX` escapes instead of literal UTF-8.
 *
 * The defect is a wire-format accident that resampling clears, so a small
 * budget recovers the overwhelming majority of turns; past it the terminal
 * per-call rejection takes over rather than spending the run on retries.
 */
export const ESCAPED_NONASCII_RECOVERY_PROMPT = escapedNonAsciiRecoveryPrompt;

const MAX_ESCAPED_NONASCII_RESAMPLES = 2;

/** Whether any tool call in the turn carried `\uXXXX`-escaped arguments. */
interface EscapedToolCallMetadata {
	guarded: boolean;
	malformed: boolean;
	evidence: UnicodeEscapeEvidence | undefined;
	incompleteArguments: boolean;
	incompleteArgumentsReason: unknown;
}

const acceptedToolCallMetadata = new WeakMap<object, EscapedToolCallMetadata>();

function escapedToolCallMetadata(
	block: Extract<AssistantMessage["content"][number], { type: "toolCall" }>,
): EscapedToolCallMetadata {
	const guardRead = managedOwnPropertyRead(block, "escapedNonAsciiArguments");
	const evidenceRead = managedOwnPropertyRead(block, "escapedUnicodeArgumentEvidence");
	const incompleteRead = managedPropertyRead(block, "incompleteArguments");
	const incompleteReasonRead = managedPropertyRead(block, "incompleteArgumentsReason");
	const inheritedGuard = managedInheritedProperty(block, "escapedNonAsciiArguments");
	const inheritedEvidence = managedInheritedProperty(block, "escapedUnicodeArgumentEvidence");
	let evidence: UnicodeEscapeEvidence | undefined;
	try {
		evidence = managedUnicodeEscapeEvidence(evidenceRead.value);
	} catch {
		evidence = undefined;
	}
	const malformedMetadata =
		!guardRead.ok ||
		!evidenceRead.ok ||
		!incompleteRead.ok ||
		!incompleteReasonRead.ok ||
		inheritedGuard ||
		inheritedEvidence ||
		(typeof incompleteRead.value === "string" && SANITIZER_SENTINELS.has(incompleteRead.value)) ||
		(typeof incompleteReasonRead.value === "string" && SANITIZER_SENTINELS.has(incompleteReasonRead.value)) ||
		(evidenceRead.present && (evidenceRead.value === undefined || evidence === undefined || evidence.malformed));
	const incomplete = incompleteRead.ok && incompleteRead.value === true;
	return {
		guarded:
			malformedMetadata ||
			(guardRead.present && guardRead.value === true) ||
			(evidenceRead.present && evidenceRead.value !== undefined),
		malformed: malformedMetadata || incomplete,
		evidence,
		incompleteArguments: incomplete,
		incompleteArgumentsReason:
			!incompleteReasonRead.ok || malformedMetadata ? "malformed" : incompleteReasonRead.value,
	};
}

function hasEscapedNonAsciiToolCall(message: AssistantMessage): boolean {
	return message.content.some(block => block.type === "toolCall" && escapedToolCallMetadata(block).guarded);
}

const ESCAPED_NONASCII_DIAGNOSTIC_TOOL_CALL_COUNT_MAX = 8;

/** Bounded count of the turn's escaped tool calls; tool names are never logged. */
function escapedNonAsciiToolCallShape(message: AssistantMessage): {
	escapedToolCallCount: number;
	escapedToolCallCountCapped: boolean;
} {
	const count = message.content.filter(
		block => block.type === "toolCall" && escapedToolCallMetadata(block).guarded,
	).length;
	return {
		escapedToolCallCount: Math.min(count, ESCAPED_NONASCII_DIAGNOSTIC_TOOL_CALL_COUNT_MAX),
		escapedToolCallCountCapped: count > ESCAPED_NONASCII_DIAGNOSTIC_TOOL_CALL_COUNT_MAX,
	};
}

/** Remove transient raw-evidence metadata before any message can become durable. */
function stripToolCallEvidence<T extends { escapedUnicodeArgumentEvidence?: unknown }>(toolCall: T): T {
	try {
		if (nodeUtilTypes.isProxy(toolCall)) {
			const sanitized = Object.create(null) as T;
			for (const key of [
				"type",
				"id",
				"name",
				"arguments",
				"thoughtSignature",
				"intent",
				"customWireName",
				"escapedNonAsciiArguments",
				"incompleteArguments",
				"incompleteArgumentsReason",
			]) {
				const read = managedPropertyRead(toolCall, key);
				if (read.ok && read.value !== undefined)
					Object.defineProperty(sanitized, key, { value: read.value, enumerable: true });
			}
			return sanitized;
		}
		const descriptor = Object.getOwnPropertyDescriptor(toolCall, "escapedUnicodeArgumentEvidence");
		if (!descriptor) return toolCall;
		if (descriptor.configurable && Reflect.deleteProperty(toolCall, "escapedUnicodeArgumentEvidence"))
			return toolCall;
		const sanitized = Object.create(null) as T;
		for (const key of Reflect.ownKeys(toolCall)) {
			if (key === "escapedUnicodeArgumentEvidence") continue;
			const own = Object.getOwnPropertyDescriptor(toolCall, key);
			if (!own?.enumerable || !("value" in own)) continue;
			try {
				Object.defineProperty(sanitized, key, own);
			} catch {
				// Skip hostile descriptors; required fields are already captured in the record.
			}
		}
		return sanitized;
	} catch {
		return Object.create(null) as T;
	}
}

function stripUnicodeEscapeEvidence(message: AssistantMessage): void {
	for (let index = 0; index < message.content.length; index += 1) {
		const block = message.content[index];
		if (block?.type === "toolCall") message.content[index] = stripToolCallEvidence(block);
	}
}

/**
 * Display-safe handling for tools that opt specific argument fields into it:
 * every non-ASCII character of the decoded arguments must live inside one of
 * the declared display-field paths, and the raw escape evidence must
 * corroborate each escaped scalar against the decoded display text. A
 * mistyped nibble here can only change what the user reads on screen, never
 * what executes or persists, so the call degrades to a single warning instead
 * of the fail-closed rejection that load-bearing fields keep.
 */

/** Structural type for tools that opt specific argument fields into display-safe handling. */
type DisplaySafeEscapedTool = AgentTool<TSchema> & {
	/** Argument fields (dotted paths into the arguments object) that render to the user as display text. */
	displaySafeEscapedArgFields?: readonly string[];
};

/** Whether the tool declared any display-only argument fields at all. */
function isDisplaySafeEscapedTool(tool: AgentTool<TSchema> | undefined): boolean {
	return ((tool as DisplaySafeEscapedTool | undefined)?.displaySafeEscapedArgFields?.length ?? 0) > 0;
}

/**
 * Walk the decoded arguments and decide whether the escaped payload is
 * display-safe: every non-ASCII character must live inside one of the tool's
 * declared display-field paths (dotted, array-index-free: `questions.question`
 * matches every question in the `questions` array). Any non-ASCII outside the
 * display fields — ids, metadata, persisted records, or an object key — keeps
 * the fail-closed rejection.
 */
function isDisplaySafeEscapedArguments(tool: AgentTool<TSchema> | undefined, args: Record<string, unknown>): boolean {
	const fields = (tool as DisplaySafeEscapedTool | undefined)?.displaySafeEscapedArgFields;
	if (!fields || fields.length === 0) return false;
	const prefixes = fields.map(field => field.split("."));
	const isDisplayPath = (path: readonly string[]): boolean =>
		prefixes.some(field => field.length <= path.length && field.every((segment, index) => path[index] === segment));
	const path: string[] = [];
	const walk = (node: unknown): boolean => {
		if (typeof node === "string") {
			for (const ch of node) {
				const cp = ch.codePointAt(0);
				if (cp === undefined || cp < 0x80) continue;
				// Outside the display fields no non-ASCII is tolerated at all;
				// inside them any decoded character is display text.
				if (!isDisplayPath(path)) return false;
			}
			return true;
		}
		if (Array.isArray(node)) return node.every(item => walk(item));
		if (typeof node === "object" && node !== null) {
			for (const [key, value] of Object.entries(node)) {
				// Field names are structural identifiers; the display fields have
				// fixed ASCII names, so a non-ASCII key is never exempted.
				for (const ch of key) {
					const cp = ch.codePointAt(0);
					if (cp !== undefined && cp >= 0x80) return false;
				}
				path.push(key);
				const valid = walk(value);
				path.pop();
				if (!valid) return false;
			}
		}
		return true;
	};
	return walk(args);
}

/**
 * Validate the original raw escape positions, not just the decoded values.
 * Missing, malformed, overflowed, key-position, ASCII-landing, or
 * path-mismatched evidence fails closed. Process-keyed scalar/path tags keep
 * argument text out of the carried metadata while still binding every escape
 * to a decoded non-ASCII character inside a declared display field.
 */
function isDisplaySafeRawEscapeEvidence(
	tool: AgentTool<TSchema> | undefined,
	args: Record<string, unknown>,
	evidence: UnicodeEscapeEvidence | undefined,
): boolean {
	const fields = (tool as DisplaySafeEscapedTool | undefined)?.displaySafeEscapedArgFields;
	if (
		!fields ||
		fields.length === 0 ||
		!evidence ||
		!verifyUnicodeEscapeEvidence(evidence) ||
		evidence.malformed ||
		evidence.truncated
	)
		return false;
	if (evidence.positions.length === 0 || evidence.positions.length > 32) return false;

	const allowedValues = new Map<string, { offsets: Map<number, string>; matched: Set<number> }>();
	const valueOrdinals = new Map<string, number>();
	const prefixes = fields.map(field => field.split("."));
	const isDisplayPath = (path: readonly string[]): boolean =>
		prefixes.some(field => field.length <= path.length && field.every((segment, index) => path[index] === segment));
	const path: string[] = [];
	const walk = (node: unknown): void => {
		if (typeof node === "string") {
			if (!isDisplayPath(path)) return;
			const pathTag = unicodeEscapePathTag(path);
			const valueOrdinal = valueOrdinals.get(pathTag) ?? 0;
			valueOrdinals.set(pathTag, valueOrdinal + 1);
			const offsets = new Map<number, string>();
			for (let offset = 0; offset < node.length; ) {
				const codePoint = node.codePointAt(offset);
				if (codePoint !== undefined && codePoint >= 0x80) offsets.set(offset, unicodeEscapeScalarTag(codePoint));
				offset += codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
			}
			allowedValues.set(`${pathTag}:${valueOrdinal}`, { offsets, matched: new Set() });
			return;
		}
		if (Array.isArray(node)) {
			for (const item of node) walk(item);
			return;
		}
		if (typeof node === "object" && node !== null) {
			for (const [key, value] of Object.entries(node)) {
				path.push(key);
				walk(value);
				path.pop();
			}
		}
	};
	walk(args);

	let previousOffset = -1;
	for (const position of evidence.positions) {
		if (
			position.location !== "value" ||
			!/^[0-9a-f]{64}$/.test(position.scalarTag) ||
			!Number.isSafeInteger(position.offset) ||
			position.offset <= previousOffset ||
			!/^[0-9a-f]{64}$/.test(position.pathTag) ||
			!Number.isSafeInteger(position.valueOrdinal) ||
			position.valueOrdinal < 0 ||
			!Number.isSafeInteger(position.valueOffset) ||
			position.valueOffset < 0
		) {
			return false;
		}
		previousOffset = position.offset;
		const value = allowedValues.get(`${position.pathTag}:${position.valueOrdinal}`);
		// Each escape must corroborate an actual decoded non-ASCII character at
		// that exact offset inside a declared display string: an ASCII landing
		// (a possible one-nibble mutation of a non-ASCII escape), a load-bearing
		// field, or a shifted position all fail closed.
		if (
			!value ||
			value.offsets.get(position.valueOffset) !== position.scalarTag ||
			value.matched.has(position.valueOffset)
		)
			return false;
		value.matched.add(position.valueOffset);
	}
	return true;
}
/**
 * Whether every escaped tool call in the turn lands entirely on declared
 * display-safe fields of its registered tool. Only then does the turn skip
 * the resample/discard chain: a single load-bearing escaped call keeps the
 * whole turn fail-closed.
 */
function allEscapedToolCallsDisplaySafe(
	message: AssistantMessage,
	tools: readonly AgentTool<TSchema>[] | undefined,
): boolean {
	let sawEscapedCall = false;
	for (const block of message.content) {
		if (block.type !== "toolCall") continue;
		const metadata = escapedToolCallMetadata(block);
		if (!metadata.guarded) continue;
		if (metadata.malformed) return false;
		sawEscapedCall = true;
		const tool = tools?.find(candidate => candidate.name === block.name);
		const args = block.arguments as Record<string, unknown>;
		if (!isDisplaySafeEscapedArguments(tool, args) || !isDisplaySafeRawEscapeEvidence(tool, args, metadata.evidence))
			return false;
	}
	return sawEscapedCall;
}
/** Remove only the exact assistant response committed by its streaming attempt. */
function removeCommittedAssistantMessage(messages: AgentMessage[], message: AssistantMessage): boolean {
	const index = messages.lastIndexOf(message);
	if (index < 0) return false;
	messages.splice(index, 1);
	return true;
}

function isComposerBashPolicyBlockedToolResult(result: ToolResultMessage): boolean {
	return (
		result.isError &&
		result.toolName === "bash" &&
		result.content.some(content => content.type === "text" && isCurrentComposerBashPolicyBlockedError(content.text))
	);
}

function managedContextOverflow(message: AssistantMessage, config: AgentLoopConfig): boolean {
	const transportFailure = managedTransportFailure(message);
	// Managed empty-stop responses may be repaired by the managed shell below; only
	// typed/error overflows are discardable before that normalization boundary.
	if (config.fallbackManaged && message.stopReason !== "error") return false;
	return classifyContextOverflow(message, transportFailure, config.model.contextWindow);
}

/** Managed fallback owns retry policy; only attached typed transport facts may discard an attempt. */
function managedPropertyRead(value: unknown, key: string): { ok: boolean; value: unknown } {
	if (!value || typeof value !== "object") return { ok: true, value: undefined };
	try {
		return { ok: true, value: Reflect.get(value, key) };
	} catch {
		return { ok: false, value: undefined };
	}
}

function managedProperty(value: unknown, key: string): unknown {
	return managedPropertyRead(value, key).value;
}

function managedOwnPropertyRead(value: unknown, key: string): { present: boolean; ok: boolean; value: unknown } {
	if (!value || typeof value !== "object") return { present: false, ok: true, value: undefined };
	try {
		if (!Object.hasOwn(value, key)) return { present: false, ok: true, value: undefined };
		return { present: true, ok: true, value: Reflect.get(value, key) };
	} catch {
		return { present: true, ok: false, value: undefined };
	}
}

function managedInheritedProperty(value: unknown, key: string): boolean {
	if (!value || typeof value !== "object") return false;
	try {
		return !Object.hasOwn(value, key) && key in value;
	} catch {
		return true;
	}
}

function managedTransportFailure(failure: unknown) {
	const facts = managedProperty(failure, "transportFailure");
	return facts && typeof facts === "object" ? transportFailureFacts(facts) : undefined;
}

// AI owns provider-originated authority. The agent loop owns authority for
// the rebuilt message objects it creates; this second WeakSet is deliberately
// module-private so a public AI consumer cannot transfer authority to an
// arbitrary destination. A destination is marked only while this managed
// runtime is rebuilding a source that AI authenticated.
const managedProviderSafetyStops = new WeakSet<object>();

function isManagedProviderSafetyStopAuthenticated(value: unknown): boolean {
	return (
		isProviderSafetyStopAuthenticated(value) ||
		(typeof value === "object" && value !== null && managedProviderSafetyStops.has(value))
	);
}

function managedRetryableFailure(failure: unknown): boolean {
	const facts = managedTransportFailure(failure);
	if (!facts) return false;
	// A typed provider safety stop is terminal evidence ahead of any transport
	// class, but only with adapter-minted provenance: unauthenticated labels
	// are stripped at the stream exit (`sanitizeProviderSafetyStopProvenance`)
	// and must fall through to ordinary transport classification so the chain
	// can still advance (#4777).
	if (
		managedProperty(failure, "stopReason") === "error" &&
		managedProperty(failure, "errorKind") === "provider_safety_stop" &&
		isManagedProviderSafetyStopAuthenticated(failure)
	) {
		return false;
	}
	const trigger = classifyFallbackTrigger(facts);
	// A plain `forbidden` is terminal: retrying it just re-sends a request the
	// caller is not authorized to make, and the credential-mutating consumers
	// downstream would block healthy credentials on the way.
	if (trigger.class === "auth") return trigger.authDisposition !== "forbidden";
	return trigger.class === "rate_limit" || trigger.class === "quota" || trigger.class === "server";
}

function promoteTypedEmptyResponseStop(message: AssistantMessage): void {
	if (
		message.stopReason !== "stop" ||
		message.content.length !== 0 ||
		message.usage.input !== 0 ||
		message.usage.output !== 0 ||
		message.usage.cacheRead !== 0 ||
		message.usage.cacheWrite !== 0 ||
		message.usage.totalTokens !== 0 ||
		managedTransportFailure(message)?.providerCode?.toLowerCase() !== EMPTY_RESPONSE_PROVIDER_CODE
	) {
		return;
	}
	message.stopReason = "error";
	message.errorMessage = "Provider returned an empty response with zero token usage";
}
/**
 * Terminal safety-stop authority is provenance-bound, not data-bound: a
 * provider or custom stream payload that self-labels
 * `errorKind: "provider_safety_stop"` without the adapter-minted mark must not
 * terminalize the failure, because terminal treatment suppresses the user's
 * configured fallback chain (#4777 review follow-up). Strip the unauthenticated
 * field from the live final message at the single stream-exit point, before
 * the managed snapshot shell clones it and before any retry/discard policy
 * reads it, so a forged label degrades to an ordinary (fallback-eligible)
 * error everywhere downstream — loop gates, session policy, and persistence.
 *
 * The label is stripped regardless of stopReason: the field is reserved for
 * adapter-minted terminal stops, and downstream consumers (session compaction
 * checks among them) read it without re-checking the error state, so a forged
 * label on a nominally successful response must not survive either. A frozen
 * or Proxy-trapped final message is rebuilt as a plain mutable copy instead of
 * letting the strip abort the run.
 */

function sanitizeProviderSafetyStopProvenance(
	message: AssistantMessage,
	model: AgentLoopConfig["model"],
): AssistantMessage {
	const errorKindRead = managedPropertyRead(message, "errorKind");
	if (
		errorKindRead.ok &&
		(errorKindRead.value !== "provider_safety_stop" || isManagedProviderSafetyStopAuthenticated(message))
	) {
		return message;
	}
	const detached = managedAttemptSnapshotDetailed(message).snapshot;
	if (isManagedPlainRecord(detached)) {
		const rebuilt = { ...detached } as AssistantMessage;
		delete rebuilt.errorKind;
		if (!Array.isArray(rebuilt.content)) {
			const repaired = managedAssistantShell(message, model);
			delete repaired.errorKind;
			return repaired;
		}
		restoreTransientUnicodeEscapeEvidence(rebuilt.content, message);
		return rebuilt;
	}
	const rebuilt = managedAssistantShell(message, model);
	delete rebuilt.errorKind;
	return rebuilt;
}

/**
 * Expire residual terminal safety-stop authority before a dispatch exposes
 * committed history to a stream. Once a stop has been adjudicated, its
 * committed assistant message may be handed unchanged to a later — possibly
 * custom — stream through `convertToLlm`; a live mark would let that stream
 * re-use the authenticated object (or a mutation of it) to forge a terminal
 * failure and suppress the fallback chain (#4777 review follow-up).
 */
function expireProviderSafetyStopAuthority(messages: AgentMessage[]): void {
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		revokeProviderSafetyStop(message);
		managedProviderSafetyStops.delete(message);
	}
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
/**
 * Strip Responses-API `reasoning` items whose `encrypted_content` a proxy
 * emptied, in-place across the outgoing history's `providerPayload`. DeepSeek in
 * thinking mode rejects replay of reasoning whose encrypted blob was stripped,
 * so dropping those items lets the model re-reason instead of re-triggering a
 * deterministic 400 ("reasoning_content ... must be passed back to the API").
 * Only the opaque Responses history payload is mutated; durable message content
 * and ordering are preserved. Returns whether any item was actually removed —
 * the circuit breaker uses this to decide between a single repaired resend
 * (removed) and immediate fail-fast (unchanged).
 */
function repairReasoningContentReplayHistory(messages: AgentMessage[]): boolean {
	let removed = 0;
	for (const message of messages) {
		const payload = (message as { providerPayload?: { type?: string; items?: Array<Record<string, unknown>> } })
			.providerPayload;
		if (payload?.type !== "openaiResponsesHistory" || !Array.isArray(payload.items)) continue;
		const { result, removed: count } = stripUnusableReasoningItems(payload.items);
		if (count > 0) {
			payload.items = result;
			removed += count;
		}
	}
	return removed > 0;
}

function managedFailureOutcome(message: AssistantMessage, scope?: AttemptScope): ManagedAttemptOutcome {
	return {
		type: "retryable_discarded",
		failure: { message, transportFailure: managedTransportFailure(message) },
		scope,
	};
}

function managedContextOverflowOutcome(message: AssistantMessage, scope?: AttemptScope): ManagedAttemptOutcome {
	return { type: "context_overflow_discarded", message, scope };
}

function managedFailureMessage(error: unknown, config: AgentLoopConfig): AssistantMessage {
	const errorMessage = managedProperty(error, "message");
	const transportFailure = managedTransportFailure(error);
	// One identity-checked source for BOTH local-diagnostic fields: a foreign
	// error that self-labels `errorKind` gets neither (#4618).
	const localDiagnostic = managedLocalErrorDiagnostic(error);
	let fallbackMessage = "Managed fallback attempt failed";
	if (typeof errorMessage === "string") fallbackMessage = errorMessage;
	else {
		try {
			fallbackMessage = String(error);
		} catch {
			// Keep the stable local message for hostile wrappers.
		}
	}
	// The overflow error's own message already carries the stable prefix plus
	// the shape-only stage/counters/limits diagnostic, so nothing needs to be
	// appended here; the prefix keeps the legacy prefix-classification stable.
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
		...(localDiagnostic ?? {}),
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
	emitAgentStart = true,
	initialScope?: AttemptScope,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();

	(async () => {
		const newMessages: AgentMessage[] = [...prompts];
		const currentContext: AgentContext = {
			...context,
			messages: [...context.messages, ...prompts],
		};
		// Allocate before constructing the provisional transaction so every first turn
		// has one stable scope for lifecycle events, transform hooks, and transport.
		const scope = initialScope ?? config.initialScope ?? config.attemptMinter?.mint("main");
		const transaction = config.fallbackManaged
			? new ManagedAttemptTransaction(stream, config.onAssistantMessageEvent, config.model, scope)
			: undefined;
		const attemptStream = transaction ?? stream;
		try {
			prepareResourceOwnership(config, false);
			if (emitAgentStart) stream.push({ type: "agent_start", ...(scope ? { scope } : {}) });
			attemptStream.push({ type: "turn_start", ...(scope ? { scope } : {}) });
			for (const prompt of prompts) {
				stream.push({ type: "message_start", message: prompt, scope });
				stream.push({ type: "message_end", message: prompt, scope });
			}
			await runLoop(currentContext, newMessages, config, signal, stream, streamFn, transaction, scope);
		} catch (err) {
			sealStandaloneOnError(config);
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
	emitAgentStart = true,
	initialScope?: AttemptScope,
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
		// Allocate before constructing the provisional transaction so every first turn
		// has one stable scope for lifecycle events, transform hooks, and transport.
		const scope = initialScope ?? config.initialScope ?? config.attemptMinter?.mint("main");
		const transaction = config.fallbackManaged
			? new ManagedAttemptTransaction(stream, config.onAssistantMessageEvent, config.model, scope)
			: undefined;
		const attemptStream = transaction ?? stream;
		try {
			prepareResourceOwnership(config, true);
			if (emitAgentStart) stream.push({ type: "agent_start", ...(scope ? { scope } : {}) });
			attemptStream.push({ type: "turn_start", ...(scope ? { scope } : {}) });
			await runLoop(currentContext, newMessages, config, signal, stream, streamFn, transaction, scope);
		} catch (err) {
			sealStandaloneOnError(config);
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

function prepareResourceOwnership(config: AgentLoopConfig, continuation: boolean): void {
	if (!config.resourceLedger || !config.resourceRunId) return;
	if (config.resourceSealOwner === "caller") {
		const existing = config.resourceLedger.lookupDomain(config.resourceRunId);
		if (config.resourceCancellationDomain && existing && config.resourceCancellationDomain !== existing) {
			config.resourceLedger.quarantine(config.resourceRunId);
			throw new Error("Prompt resource cancellation domain is unavailable");
		}
		const domain = config.resourceCancellationDomain ?? existing ?? config.resourceLedger.open(config.resourceRunId);
		if (!domain) throw new Error("Prompt resource cancellation domain is unavailable");
		config.resourceCancellationDomain = domain;
		return;
	}

	const existing = config.resourceLedger.lookupDomain(config.resourceRunId);
	const supplied = config.standaloneRunOwnership;
	if (supplied) {
		if (!continuation && existing) {
			config.resourceLedger.quarantine(config.resourceRunId);
			throw new Error("Standalone prompt continuation ownership is unavailable");
		}
		const state = standaloneOwnershipStates.get(supplied);
		if (
			!state ||
			supplied.resourceRunId !== config.resourceRunId ||
			supplied.domain !== existing ||
			(config.resourceCancellationDomain !== undefined && config.resourceCancellationDomain !== existing)
		) {
			if (existing) config.resourceLedger.quarantine(config.resourceRunId);
			throw new Error("Standalone prompt ownership is unavailable");
		}
		if (continuation && (!state.continuationClaimed || state.terminal)) {
			config.resourceLedger.quarantine(config.resourceRunId);
			throw new Error("Standalone prompt continuation ownership is unavailable");
		}
		if (continuation) {
			state.continuationClaimed = false;
			state.continuationAvailable = false;
		}
		config.resourceCancellationDomain = existing;
		return;
	}
	if (existing) {
		config.resourceLedger.quarantine(config.resourceRunId);
		throw new Error("Standalone prompt continuation ownership is unavailable");
	}

	const domain = config.resourceLedger.open(config.resourceRunId);
	if (!domain) throw new Error("Prompt resource cancellation domain is unavailable");
	config.resourceCancellationDomain = domain;
	const state: StandaloneOwnershipState = {
		continuationAvailable: false,
		continuationClaimed: false,
		terminal: false,
	};
	const ownership: StandaloneRunOwnership = {
		resourceRunId: config.resourceRunId,
		domain,
		claimContinuation: () => {
			if (domain.signal.aborted) {
				state.terminal = true;
				return { ok: false, reason: "quarantined" };
			}
			if (state.terminal) return { ok: false, reason: "terminal" };
			if (!state.continuationAvailable || state.continuationClaimed) return { ok: false, reason: "already_claimed" };
			state.continuationClaimed = true;
			return { ok: true, ownership };
		},
		abandon: reason => {
			if (state.terminal) return;
			state.terminal = true;
			config.resourceLedger?.quarantine(config.resourceRunId!);
			void reason;
		},
	};
	standaloneOwnershipStates.set(ownership, state);
	config.standaloneRunOwnership = ownership;
}

function sealStandaloneOnError(config: AgentLoopConfig): void {
	const standalone = config.standaloneRunOwnership
		? standaloneOwnershipStates.get(config.standaloneRunOwnership)
		: undefined;
	if (standalone) standalone.terminal = true;
	if (config.resourceSealOwner !== "caller" && config.resourceLedger && config.resourceRunId) {
		config.resourceLedger.seal(config.resourceRunId);
	}
}

function publishAgentEnd(
	stream: EventStream<AgentEvent, AgentMessage[]>,
	config: AgentLoopConfig,
	event: Extract<AgentEvent, { type: "agent_end" }>,
	scope?: AttemptScope,
): void {
	// Aborted maintenance yields no continuation, so it is terminal for standalone
	// ownership and resource sealing. The event itself keeps its `maintenance`
	// stopReason so AgentSession can still report the aborted maintenance
	// settlement to its consumers.
	const publishedEvent = scope ? { ...event, scope } : event;
	const maintenanceContinues =
		publishedEvent.stopReason === "maintenance" && publishedEvent.maintenanceOutcome !== "aborted";
	stream.push(publishedEvent);
	const standalone = config.standaloneRunOwnership
		? standaloneOwnershipStates.get(config.standaloneRunOwnership)
		: undefined;
	if (maintenanceContinues) {
		if (standalone) {
			standalone.continuationAvailable = true;
			standalone.continuationClaimed = false;
		}
		return;
	}
	if (standalone) standalone.terminal = true;
	if (config.resourceSealOwner !== "caller" && config.resourceLedger && config.resourceRunId) {
		config.resourceLedger.seal(config.resourceRunId);
	}
}
/**
 * Structured, shape-only overflow diagnostic carried on the terminal
 * `AssistantMessage` of a managed run that died of a staging-buffer overflow.
 * Every field is closed-vocabulary or numeric, so parent surfaces can render a
 * trustworthy summary WITHOUT trusting the free-form `errorMessage` string
 * (which a foreign, self-labeled error can still fill with arbitrary text).
 */
export interface ManagedBufferOverflowDiagnostic {
	stage: ManagedLocalFailureStage | "unknown";
	exceeded: "events" | "bytes" | "both";
	stagedEventCount: number;
	stagedBytes: number;
	incomingEventBytes: number;
	maxStagedEvents: number;
	maxStagedBytes: number;
}

/**
 * The complete set of local-diagnostic authority fields a terminal
 * `AssistantMessage` may carry. Produced only by
 * {@link managedLocalErrorDiagnostic}, so `errorKind` and `bufferOverflow`
 * always travel together from one identity check.
 */
export interface ManagedLocalErrorDiagnostic {
	errorKind: "local_snapshot_failure" | "local_buffer_overflow";
	bufferOverflow?: ManagedBufferOverflowDiagnostic;
}

/**
 * Single identity-checked source of local-failure authority. Returns
 * `undefined` unless the error is genuinely `instanceof` one of this module's
 * private local-failure classes — a foreign error that merely sets
 * `errorKind: "local_buffer_overflow"` fails the identity check and receives
 * NEITHER the kind nor the structured shape, so a provider or custom-stream
 * failure can never be reported to the parent as a local staging-buffer
 * overflow (#4618).
 *
 * Every producer of a terminal assistant message (`managedFailureMessage` and
 * the `Agent` run catch) MUST derive both fields from this function instead of
 * reading `errorKind`/`errorMessage` off the thrown value.
 */
export function managedLocalErrorDiagnostic(error: unknown): ManagedLocalErrorDiagnostic | undefined {
	if (error instanceof ManagedAttemptBufferOverflowError) {
		const overflow = error.overflow;
		return {
			errorKind: "local_buffer_overflow",
			bufferOverflow: {
				stage: MANAGED_LOCAL_FAILURE_STAGE_SET.has(overflow.stage) ? overflow.stage : "unknown",
				exceeded: overflow.exceeded === "events" || overflow.exceeded === "bytes" ? overflow.exceeded : "both",
				stagedEventCount: overflow.stagedEventCount,
				stagedBytes: overflow.stagedBytes,
				incomingEventBytes: overflow.incomingEventBytes,
				maxStagedEvents: overflow.maxStagedEvents,
				maxStagedBytes: overflow.maxStagedBytes,
			},
		};
	}
	if (error instanceof ManagedAttemptSnapshotError) return { errorKind: "local_snapshot_failure" };
	return undefined;
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
 * The sanitizer's closed set of placeholder strings. A degraded snapshot can
 * never distinguish these from provider-sent strings by value alone, so
 * downstream shape checks treat a sentinel-valued field as "original value was
 * non-cloneable", never as benign provider variance.
 */
const SANITIZER_SENTINELS: ReadonlySet<string> = new Set([
	"[unserializable]",
	"[accessor]",
	"[truncated]",
	"[Circular]",
]);
/**
 * Bounded diagnostic for a degraded primitive at the shared managed-snapshot
 * boundary. Every provider/custom stream that still forwards a malformed
 * primitive increment degrades here (to "" / []), so the degradation stays
 * observable. The caller supplies a run-scoped set so repeated malformed
 * increments emit at most one payload-free warning per field name, naming
 * only the field and the received typeof — never the payload.
 */
function warnManagedDegradedPrimitive(
	field: string,
	received: unknown,
	diagnostics: Set<string> = new Set<string>(),
): void {
	if (diagnostics.has(field)) return;
	diagnostics.add(field);
	logger.warn("agent: managed snapshot degraded a non-string primitive to an empty value", {
		field,
		receivedType: received === null ? "null" : typeof received,
	});
}

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
 *
 * `structuredClone` success is not sufficient: it can erase a custom
 * prototype `toJSON()` while retaining an own bigint field. The live value is
 * JSON-safe, but the detached clone is not. Validate and measure the DETACHED
 * value with the exact serialization operation used by staging; sanitize the
 * detached clone when that validation fails so every accepted snapshot is
 * both isolated and JSON-serializable.
 */
/**
 * Sentinel thrown from inside a size walk the moment the projected size
 * crosses the budget. Returning a substituted value (e.g. "") would not
 * abort a `JSON.stringify` walk (review finding at 2efaf269cd); throwing is
 * the only way to terminate a traversal, and the walk-based oracles below
 * rely on the same mechanism to stop before doing unbounded work.
 */
const MANAGED_SIZE_SENTINEL = Symbol("gjc.managed-staging-size-exceeded");

/**
 * Walk `value`'s JSON surface — exactly the surface `JSON.stringify` sees,
 * including `toJSON` dispatch — and return the exact UTF-8 byte length of
 * its serialization WITHOUT materializing the JSON string or its UTF-8
 * encoding. Every serialized token is charged: quotes, escapes, separators,
 * delimiters, nulls, array holes, and keys.
 *
 * A LONE surrogate (an unpaired UTF-16 unit; `codePointAt` yields the unit
 * itself only when it is unpaired) is charged as the six-byte `\udXXX`
 * escape `JSON.stringify` emits for it, not as its 3-byte UTF-8 encoding —
 * the previous BMP charge undercounted surrogate-heavy strings by ~2x
 * (exact-head 078e22c0 finding 2).
 *
 * Returns the byte count, `undefined` when the value cannot be serialized
 * (cyclic or JSON-hostile), or throws {@link MANAGED_SIZE_SENTINEL} once
 * the projected count crosses `limit`.
 */
/**
 * Charge a string's exact serialized UTF-8 byte length: opening/closing
 * quotes, per-code-point escaping, and lone-surrogate six-byte escapes.
 * Printable-ASCII strings without `"` or `\` — the dominant case for
 * streamed text, thinking, and tool-argument content — encode one byte per
 * UTF-16 unit with no escapes, so they take a single native scan instead of
 * a per-code-point JS loop. This keeps the walk-based oracles at native
 * `JSON.stringify` cost for ordinary payloads instead of paying the slow
 * path on every streaming delta.
 */
const MANAGED_PLAIN_ASCII = /[^\x20-\x21\x23-\x5b\x5d-\x7e]/;
function managedChargeStringBytes(text: string, add: (bytes: number) => void): void {
	add(1);
	if (!MANAGED_PLAIN_ASCII.test(text)) {
		add(text.length);
		add(1);
		return;
	}
	for (let index = 0; index < text.length; ) {
		const codePoint = text.codePointAt(index);
		if (codePoint === undefined) throw new Error("missing string code point");
		if (codePoint === 0x22 || codePoint === 0x5c) add(2);
		else if (
			codePoint === 0x08 ||
			codePoint === 0x09 ||
			codePoint === 0x0a ||
			codePoint === 0x0c ||
			codePoint === 0x0d
		)
			add(2);
		else if (codePoint <= 0x1f) add(6);
		else if (codePoint >= 0xd800 && codePoint <= 0xdfff) add(6);
		else if (codePoint <= 0x7f) add(1);
		else if (codePoint <= 0x7ff) add(2);
		else if (codePoint <= 0xffff) add(3);
		else add(4);
		index += codePoint > 0xffff ? 2 : 1;
	}
	add(1);
}

function managedJsonByteLengthWithin(value: unknown, limit: number): number | undefined {
	let seen = 0;
	const add = (bytes: number): void => {
		seen += bytes;
		if (seen > limit) throw MANAGED_SIZE_SENTINEL;
	};
	const addString = (text: string): void => managedChargeStringBytes(text, add);
	const seenObjects = new WeakSet<object>();
	const prepare = (input: unknown, key: string): { omitted: boolean; value?: unknown } => {
		if ((typeof input !== "object" || input === null) && typeof input !== "function") {
			return { omitted: false, value: input };
		}
		try {
			const toJSON = (input as { toJSON?: unknown }).toJSON;
			const value = typeof toJSON === "function" ? toJSON.call(input, key) : input;
			return {
				omitted: value === undefined || typeof value === "function" || typeof value === "symbol",
				value,
			};
		} catch {
			throw new Error("JSON toJSON failed");
		}
	};
	const walkPrepared = (input: unknown, inArray: boolean): boolean => {
		if (input === null) {
			add(4);
			return true;
		}
		if (input === undefined || typeof input === "function" || typeof input === "symbol") {
			if (inArray) add(4);
			return inArray;
		}
		if (typeof input === "string") {
			addString(input);
			return true;
		}
		if (typeof input === "boolean") {
			add(input ? 4 : 5);
			return true;
		}
		if (typeof input === "number") {
			const encoded = JSON.stringify(input);
			if (encoded === undefined) throw new Error("JSON number failed");
			add(managedAttemptTextEncoder.encode(encoded).byteLength);
			return true;
		}
		if (typeof input === "bigint") throw new Error("JSON bigint failed");
		if (typeof input !== "object") throw new Error("JSON value failed");
		if (seenObjects.has(input)) throw new Error("JSON cycle detected");
		seenObjects.add(input);
		try {
			if (Array.isArray(input)) {
				add(1);
				for (let index = 0; index < input.length; index++) {
					if (index > 0) add(1);
					const prepared = prepare(input[index], String(index));
					if (prepared.omitted) add(4);
					else walkPrepared(prepared.value, true);
				}
				add(1);
				return true;
			}
			add(1);
			let emitted = 0;
			const record = input as Record<string, unknown>;
			for (const property of Object.keys(input)) {
				const prepared = prepare(record[property], property);
				// `JSON.stringify` omits undefined-valued record properties
				// entirely (key, colon, and separator); charging them would
				// overestimate and falsely reject healthy payloads.
				if (prepared.omitted || prepared.value === undefined) continue;
				if (emitted > 0) add(1);
				emitted++;
				addString(property);
				add(1);
				walkPrepared(prepared.value, false);
			}
			add(1);
			return true;
		} finally {
			seenObjects.delete(input);
		}
	};
	try {
		const prepared = prepare(value, "");
		if (prepared.omitted) return undefined;
		walkPrepared(prepared.value, false);
		return seen;
	} catch (error) {
		if (error === MANAGED_SIZE_SENTINEL) throw error;
		return undefined;
	}
}

/**
 * Pre-allocation size guard: reports whether serializing `value` as JSON
 * would exceed `limit` bytes WITHOUT materializing the full JSON string or
 * cloning the value. Walks the JSON surface directly and charges every
 * token, including quotes, escapes, separators, delimiters, nulls, and
 * array holes. Strings are charged by code point, so a large string never
 * needs a second full-size escaped copy just to measure it.
 *
 * Returns "over" when the limit would be exceeded, "under" when it
 * definitely is not, and "unknown" when the value cannot be serialized at
 * all (cyclic or JSON-hostile), which callers treat exactly like the
 * existing `undefined` measurement results.
 */
function managedSnapshotExceedsBytes(value: unknown, limit: number): "over" | "under" | "unknown" {
	try {
		const bytes = managedJsonByteLengthWithin(value, limit);
		return bytes === undefined ? "unknown" : "under";
	} catch (error) {
		if (error === MANAGED_SIZE_SENTINEL) return "over";
		return "unknown";
	}
}

/**
 * Per-node minimum charge for the structuredClone preflight. Cloning
 * duplicates the object GRAPH — per-node headers, Map/Set entries, buffer
 * contents — while immutable strings are only ever referenced, so a graph
 * of millions of tiny nodes is cheap in counted JSON bytes yet allocates a
 * large duplicate. Charging a per-node floor (a conservative minimum object
 * size, far above the few JSON bytes such nodes serialize to) keeps the
 * preflight an allocation bound, not just a serialization bound.
 */
const MANAGED_CLONE_NODE_OVERHEAD_BYTES = 64;

/** Widest JSON literal any element of this typed-array kind can produce. */
function managedTypedArrayJsonDigits(view: unknown): number {
	if (view instanceof Uint8Array || view instanceof Int8Array || view instanceof Uint8ClampedArray) return 4;
	if (view instanceof Uint16Array || view instanceof Int16Array) return 6;
	if (view instanceof Uint32Array || view instanceof Int32Array || view instanceof Float32Array) return 11;
	return 24;
}

/**
 * Preflight the CLONE-VISIBLE surface — the graph `structuredClone` would
 * actually duplicate — against `limit` WITHOUT cloning. The JSON-surface
 * walk dispatches `toJSON`, so a live class can serialize compactly while
 * `structuredClone` (which drops the prototype serializer) would copy a
 * large own payload; this walk never dispatches `toJSON` and charges the
 * clone-visible graph instead. It also charges clone-only allocations the
 * JSON walk cannot see — Map/Set entries, ArrayBuffer/TypedArray bytes,
 * bigint magnitudes — plus the per-node header floor.
 *
 * Reads go through own-property descriptors only, so hostile accessors are
 * never invoked: an accessor's cloned size cannot be known without invoking
 * it, and a value `structuredClone` cannot duplicate at all (functions,
 * symbols) fails the clone anyway. Both surface as `"degrade"`, which
 * callers divert to the bounded sanitizer walk.
 *
 * Returns `"over"` when the clone-visible surface exceeds `limit`,
 * `"degrade"` when the surface cannot be bounded by walking it, and
 * `"under"` when the clone allocation is bounded.
 */
function managedCloneSurfaceExceedsBudget(value: unknown, limit: number): "over" | "under" | "degrade" {
	let seen = 0;
	const add = (bytes: number): void => {
		seen += bytes;
		if (seen > limit) throw MANAGED_SIZE_SENTINEL;
	};
	const addString = (text: string): void => managedChargeStringBytes(text, add);
	const readOwnValue = (input: object, key: string): { accessor: boolean; value?: unknown } => {
		const descriptor = Object.getOwnPropertyDescriptor(input, key);
		if (descriptor === undefined) return { accessor: false, value: undefined };
		if (!("value" in descriptor)) return { accessor: true };
		return { accessor: false, value: descriptor.value };
	};
	const seenObjects = new WeakSet<object>();
	const walk = (input: unknown): void => {
		if (input === null) {
			add(4);
			return;
		}
		if (typeof input === "function" || typeof input === "symbol") {
			// structuredClone cannot duplicate these; degrade to the bounded
			// sanitizer instead of discovering the failure by cloning.
			throw new Error("clone surface uncloneable");
		}
		if (typeof input === "undefined") return;
		if (typeof input === "string") {
			addString(input);
			return;
		}
		if (typeof input === "number") {
			add(managedAttemptTextEncoder.encode(JSON.stringify(input)).byteLength);
			return;
		}
		if (typeof input === "boolean") {
			add(input ? 4 : 5);
			return;
		}
		if (typeof input === "bigint") {
			add(MANAGED_CLONE_NODE_OVERHEAD_BYTES + input.toString().length);
			return;
		}
		if (typeof input !== "object") return;
		// Refuse proxies by internal-slot brand BEFORE any reflective operation:
		// `Object.keys`/`getOwnPropertyDescriptor` on a live proxy would dispatch
		// its `ownKeys`/descriptor traps, and on a revoked proxy would throw —
		// either way the walk must not run payload-controlled code. The bounded
		// sanitizer collapses proxies to a placeholder without dispatching traps.
		if (nodeUtilTypes.isProxy(input)) throw new Error("clone surface proxy");
		if (seenObjects.has(input)) throw new Error("clone surface cycle");
		seenObjects.add(input);
		try {
			add(MANAGED_CLONE_NODE_OVERHEAD_BYTES);
			if (nodeUtilTypes.isDate(input)) {
				add(32);
				return;
			}
			if (nodeUtilTypes.isRegExp(input)) {
				add(2 + (input as RegExp).source.length);
				return;
			}
			if (nodeUtilTypes.isMap(input)) {
				for (const [entryKey, entryValue] of Map.prototype.entries.call(input as Map<unknown, unknown>)) {
					add(MANAGED_CLONE_NODE_OVERHEAD_BYTES);
					walk(entryKey);
					walk(entryValue);
				}
				return;
			}
			if (nodeUtilTypes.isSet(input)) {
				for (const element of Set.prototype.values.call(input as Set<unknown>)) {
					add(MANAGED_CLONE_NODE_OVERHEAD_BYTES);
					walk(element);
				}
				return;
			}
			if (nodeUtilTypes.isArrayBuffer(input)) {
				add((input as ArrayBuffer).byteLength);
				return;
			}
			if (nodeUtilTypes.isTypedArray(input)) {
				const view = input as unknown as Uint8Array;
				add(view.byteLength + view.length * managedTypedArrayJsonDigits(view));
				return;
			}
			if (nodeUtilTypes.isDataView(input)) {
				add((input as DataView).byteLength);
				return;
			}
			if (Array.isArray(input)) {
				add(2);
				for (let index = 0; index < input.length; index++) {
					if (index > 0) add(1);
					const read = readOwnValue(input, String(index));
					if (read.accessor) throw new Error("clone surface accessor");
					if (!Object.hasOwn(input, String(index)))
						add(4); // array hole
					else walk(read.value);
				}
				// Non-index own enumerable keys are cloned (allocation) even
				// though JSON.stringify omits them from arrays; charge their
				// graph so the preflight stays an allocation bound.
				for (const key of Object.keys(input)) {
					if (String(Number(key)) === key && Number(key) >= 0) continue;
					const read = readOwnValue(input, key);
					if (read.accessor) throw new Error("clone surface accessor");
					addString(key);
					walk(read.value);
				}
				return;
			}
			add(2);
			let emitted = 0;
			for (const key of Object.keys(input)) {
				const read = readOwnValue(input, key);
				if (read.accessor) throw new Error("clone surface accessor");
				if (emitted > 0) add(1);
				emitted++;
				addString(key);
				add(1);
				walk(read.value);
			}
			return;
		} finally {
			seenObjects.delete(input);
		}
	};
	try {
		walk(value);
		return "under";
	} catch (error) {
		if (error === MANAGED_SIZE_SENTINEL) return "over";
		return "degrade";
	}
}

/**
 * Ceiling for unbounded standalone snapshot sizing (the shell paths outside
 * a transaction). Shared by the transaction-cap default so a standalone
 * snapshot is never larger than the default transaction budget.
 */
function currentStagedBytesCap(): number {
	return managedAttemptMaxStagedBytes();
}

/**
 * Exact serialized size of a staged snapshot, computed by walking the JSON
 * surface. Replaces the previous `JSON.stringify` + `TextEncoder.encode`
 * measurement, which materialized a full copy of the serialized value — and
 * a second copy of its UTF-8 encoding — BEFORE the cap check could reject
 * it: the budget-sized transient allocation the memory guard exists to
 * prevent (exact-head 078e22c0 finding 1). Returns `undefined` when the
 * value cannot be serialized, matching the previous measurement's failure
 * mode so callers keep their sanitize fallbacks.
 *
 * @internal
 */
export function managedSnapshotJsonByteLength(value: unknown): number | undefined {
	return managedJsonByteLengthWithin(value, Number.POSITIVE_INFINITY);
}

function managedAttemptSnapshotDetailed<T>(
	value: T,
	byteLimit?: number,
): {
	snapshot: T;
	jsonBytes?: number;
	sanitized: boolean;
} {
	// Preflight the CLONE-VISIBLE surface so the structuredClone allocation
	// itself is bounded: a live class can serialize compactly through a
	// prototype `toJSON()` that structuredClone drops, so a JSON-surface
	// precheck alone cannot bound what the clone would duplicate — the clone
	// allocated the over-cap duplicate before the typed overflow could run
	// (exact-head 078e22c0 finding 1). Degrade through the bounded sanitizer
	// walk, which never clones, never dispatches accessors, and is
	// node-budgeted, instead of allocating the duplicate.
	if (managedCloneSurfaceExceedsBudget(value, byteLimit ?? currentStagedBytesCap()) !== "under") {
		const bounded = sanitizedDetachedClone(value);
		return { snapshot: bounded, jsonBytes: managedSnapshotJsonByteLength(bounded), sanitized: true };
	}
	try {
		const snapshot = structuredClone(value);
		const jsonBytes = managedSnapshotJsonByteLength(snapshot);
		if (jsonBytes !== undefined) return { snapshot, jsonBytes, sanitized: false };
		const sanitized = sanitizedDetachedClone(snapshot);
		return { snapshot: sanitized, jsonBytes: managedSnapshotJsonByteLength(sanitized), sanitized: true };
	} catch {
		const snapshot = sanitizedDetachedClone(value);
		return { snapshot, jsonBytes: managedSnapshotJsonByteLength(snapshot), sanitized: true };
	}
}

function managedAttemptSnapshot<T>(value: T): T {
	return managedAttemptSnapshotDetailed(value).snapshot;
}

const LOSSLESS_SNAPSHOT_KEYS = [
	"role",
	"content",
	"api",
	"provider",
	"model",
	"responseId",
	"usage",
	"stopReason",
	"errorMessage",
	"errorKind",
	"errorStatus",
	"transportFailure",
	"disabledFeatures",
	"bufferOverflow",
	"providerPayload",
	"timestamp",
	"duration",
	"ttft",
	"type",
	"contentIndex",
	"delta",
	"partial",
	"toolCall",
	"reason",
	"message",
	"error",
] as const;

/**
 * Detach unmanaged provider metadata without normalizing the cloneable parts.
 * A failed subtree is removed at its own property boundary; siblings retain
 * their exact structured-clone representation. The bounded recursive path is
 * used only after cloning the complete value fails.
 *
 * The `structuredClone` allocation is preflighted against the staged-bytes
 * cap: a live payload class can serialize compactly through a prototype
 * `toJSON()` the clone drops, so the JSON-surface budget alone does not
 * bound what the clone duplicates. An over-budget clone surface collapses to
 * the bounded sanitizer instead of allocating the duplicate — ordinary
 * sessions never see this, because their transaction flushes and streams the
 * live event through before reaching this clone.
 */
function losslessDetachedClone<T>(value: T): T {
	if (managedCloneSurfaceExceedsBudget(value, currentStagedBytesCap()) === "over") {
		return sanitizedDetachedClone(value);
	}
	try {
		const snapshot = structuredClone(value);
		// `structuredClone()` preserves own bigint fields while removing a
		// payload class's prototype `toJSON()`. The live event may therefore
		// serialize successfully while its detached clone cannot be staged.
		// Lossless staging still preserves every JSON-safe clone verbatim; only
		// the non-serializable detached form is sanitized.
		return managedSnapshotJsonByteLength(snapshot) !== undefined ? snapshot : sanitizedDetachedClone(snapshot);
	} catch {
		// The managed sanitizer is explicitly bounded and total. Use it only to
		// identify which top-level assistant metadata surfaces are cloneable; the
		// cloneable surfaces themselves still come from structuredClone and remain
		// lossless. This avoids recursive/unbounded traversal of hostile provider
		// metadata while stripping only the failed top-level surface.
		if (!isManagedPlainRecord(value)) return sanitizedDetachedClone(value);
		const output: Record<string, unknown> = {};
		let remaining = MANAGED_SNAPSHOT_MAX_NODES;
		for (const key of LOSSLESS_SNAPSHOT_KEYS) {
			if (remaining-- <= 0) break;
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor || !("value" in descriptor)) continue;
			try {
				output[key] = structuredClone(descriptor.value);
			} catch {
				if (key === "transportFailure" && isManagedPlainRecord(descriptor.value)) {
					const transport: Record<string, unknown> = {};
					for (const transportKey of [
						"kind",
						"status",
						"code",
						"providerCode",
						"openaiErrorCode",
						"anthropicErrorType",
						"retryAfterMs",
						"headers",
					] as const) {
						const transportDescriptor = Object.getOwnPropertyDescriptor(descriptor.value, transportKey);
						if (!transportDescriptor || !("value" in transportDescriptor)) continue;
						try {
							transport[transportKey] = structuredClone(transportDescriptor.value);
						} catch {
							// Strip only this non-cloneable transport fact.
						}
					}
					output[key] = transport;
				}
			}
		}
		return managedSnapshotJsonByteLength(output) !== undefined ? (output as T) : sanitizedDetachedClone(output as T);
	}
}

/**
 * Recover the required assistant-message shell when a managed snapshot degrades
 * at its root (notably for Proxy-wrapped provider messages). Only known fields
 * are read, and executable content is retained only when it has its complete
 * discriminant shape.
 */
function managedAssistantShell(
	value: unknown,
	model: AgentLoopConfig["model"],
	degradedFieldDiagnostics: Set<string> = new Set<string>(),
	transferSafetyStopAuthority = false,
): AssistantMessage {
	const detailed = managedAttemptSnapshotDetailed(value);
	const snapshotRecord = isManagedPlainRecord(detailed.snapshot) ? detailed.snapshot : undefined;
	// Two benign root degradations are repaired by reading through the
	// original object — the provider's own view — with every read guarded so
	// a hostile trap can only degrade to undefined, never escape
	// (`managedProperty` is exactly that guarded read):
	// - a root that could not be snapshotted into a plain record is a live
	//   Proxy (the sanitizer collapses proxies to a placeholder);
	// - a plain-record snapshot that lost `role: "assistant"` came from a
	//   payload class whose fields live on its prototype: `structuredClone`
	//   copies only own enumerable properties, so the caller's live
	//   `message.role === "assistant"` check passes while the detached
	//   snapshot retains none of the message identity.
	const source =
		snapshotRecord !== undefined &&
		managedProperty(snapshotRecord, "role") === "assistant" &&
		(managedProperty(snapshotRecord, "content") !== undefined || managedProperty(value, "content") === undefined)
			? snapshotRecord
			: value;
	if (managedProperty(source, "role") !== "assistant") throw new ManagedAttemptSnapshotError("shell.role");
	const rawContent = managedAttemptSnapshot(managedProperty(source, "content"));
	// Providers may deliver `content` as a string, missing value, or a primitive
	// scalar — all benign variance that degrades to an empty content array
	// (an empty, side-effect-free assistant turn). A plain-object `content`
	// is NOT degraded: it can carry array-like toolCall payloads
	// (`{0:{type:"toolCall"}}`) and silently dropping them would lose
	// executable content behind a successful empty turn. Only sentinel
	// strings produced by the sanitizer itself (`[unserializable]` etc.)
	// also stay fail-closed for the same reason, plus any plain object.
	const rawArray = Array.isArray(rawContent) ? rawContent : undefined;
	if (rawArray === undefined) {
		if (typeof rawContent === "string" && SANITIZER_SENTINELS.has(rawContent)) {
			throw new ManagedAttemptSnapshotError("shell.content");
		}
		if (rawContent !== null && typeof rawContent === "object") {
			throw new ManagedAttemptSnapshotError("shell.content");
		}
		if (rawArray === undefined && rawContent !== undefined && !SANITIZER_SENTINELS.has(rawContent as string)) {
			warnManagedDegradedPrimitive("shell.content", rawContent, degradedFieldDiagnostics);
		}
	}
	const content = rawArray === undefined ? [] : rawArray.flatMap(managedContentBlock);
	restoreTransientUnicodeEscapeEvidence(content, value);
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
	// `provider_safety_stop` is the one provider-owned diagnostic that must cross
	// this managed snapshot boundary: AgentSession uses it to keep the terminal
	// stop terminal and to render the manual model-switch hint. Read only the
	// closed literal, and only on an errored assistant turn; local diagnostic
	// kinds remain runtime-owned and are never copied from provider data.
	const errorKind =
		stopReason === "error" && managedProperty(source, "errorKind") === "provider_safety_stop"
			? ("provider_safety_stop" as const)
			: undefined;
	const safeMetadata: Record<string, unknown> = {};
	if (isManagedPlainRecord(detailed.snapshot)) {
		for (const key of Object.keys(detailed.snapshot)) {
			const metadata = managedProperty(detailed.snapshot, key);
			if (metadata !== undefined) safeMetadata[key] = metadata;
		}
	}
	delete safeMetadata.errorMessage;
	delete safeMetadata.errorStatus;
	delete safeMetadata.transportFailure;
	// Local diagnostic authority fields are never foreign-provider-settable.
	// `provider_safety_stop` was read explicitly above; all other errorKind values
	// are stripped here so a provider/stream payload cannot self-label a local
	// runtime failure in the executor's parent-facing summary (#4618).
	delete safeMetadata.errorKind;
	delete safeMetadata.bufferOverflow;
	const rebuilt: AssistantMessage = {
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
		...(errorKind ? { errorKind } : {}),
		...(typeof errorStatus === "number" && Number.isFinite(errorStatus) ? { errorStatus } : {}),
	};
	// The closed-literal copy above is fed by the stream-exit provenance
	// sanitize, so an unauthenticated label never reaches here. Mark the
	// runtime-owned destination only when this source is already authenticated;
	// no public AI API can perform this transfer (#4777 review).
	if (transferSafetyStopAuthority && errorKind && isManagedProviderSafetyStopAuthenticated(value)) {
		managedProviderSafetyStops.add(rebuilt);
		revokeProviderSafetyStop(value);
		if (typeof value === "object" && value !== null) managedProviderSafetyStops.delete(value);
	}
	return rebuilt;
}

function managedContentBlock(block: unknown): AssistantMessage["content"] {
	const normalized = managedAssistantContent(block);
	return normalized ? [normalized] : [];
}

function managedUnicodeEscapeEvidence(value: unknown): UnicodeEscapeEvidence | undefined {
	if (!isManagedPlainRecord(value)) return undefined;
	const envelopeReads = Object.fromEntries(
		["positions", "totalPositions", "truncated", "malformed", "integrity"].map(key => [
			key,
			managedOwnPropertyRead(value, key),
		]),
	) as Record<string, { present: boolean; ok: boolean; value: unknown }>;
	if (Object.values(envelopeReads).some(read => !read.present || !read.ok)) return undefined;
	const positionsValue = envelopeReads.positions!.value;
	const totalPositions = envelopeReads.totalPositions!.value;
	const truncated = envelopeReads.truncated!.value;
	const malformed = envelopeReads.malformed!.value;
	const integrity = envelopeReads.integrity!.value;
	if (!Array.isArray(positionsValue) || positionsValue.length > 32) return undefined;
	if (
		typeof totalPositions !== "number" ||
		!Number.isSafeInteger(totalPositions) ||
		totalPositions < positionsValue.length ||
		typeof truncated !== "boolean" ||
		typeof malformed !== "boolean" ||
		typeof integrity !== "string" ||
		!/^[0-9a-f]{64}$/.test(integrity)
	)
		return undefined;
	const positions: UnicodeEscapeEvidence["positions"][number][] = [];
	for (const positionValue of positionsValue) {
		if (!isManagedPlainRecord(positionValue)) return undefined;
		const positionReads = Object.fromEntries(
			["offset", "scalarTag", "pathTag", "location", "valueOrdinal", "valueOffset"].map(key => [
				key,
				managedOwnPropertyRead(positionValue, key),
			]),
		) as Record<string, { present: boolean; ok: boolean; value: unknown }>;
		if (Object.values(positionReads).some(read => !read.present || !read.ok)) return undefined;
		const offset = positionReads.offset!.value;
		const scalarTag = positionReads.scalarTag!.value;
		const pathTag = positionReads.pathTag!.value;
		const location = positionReads.location!.value;
		const valueOrdinal = positionReads.valueOrdinal!.value;
		const valueOffset = positionReads.valueOffset!.value;
		if (
			typeof offset !== "number" ||
			!Number.isSafeInteger(offset) ||
			offset < 0 ||
			typeof scalarTag !== "string" ||
			!/^[0-9a-f]{64}$/.test(scalarTag) ||
			typeof pathTag !== "string" ||
			!/^[0-9a-f]{64}$/.test(pathTag) ||
			(location !== "key" && location !== "value") ||
			typeof valueOrdinal !== "number" ||
			!Number.isSafeInteger(valueOrdinal) ||
			valueOrdinal < 0 ||
			typeof valueOffset !== "number" ||
			!Number.isSafeInteger(valueOffset) ||
			valueOffset < 0
		) {
			return undefined;
		}
		positions.push({ offset, scalarTag, pathTag, location, valueOrdinal, valueOffset });
	}
	const evidence = { positions, totalPositions, truncated, malformed, integrity };
	return verifyUnicodeEscapeEvidence(evidence) ? evidence : undefined;
}

function restoreTransientUnicodeEscapeEvidence(content: AssistantMessage["content"], liveMessage: unknown): void {
	const liveContent = managedProperty(liveMessage, "content");
	if (!Array.isArray(liveContent)) return;
	for (const destination of content) {
		if (!destination || typeof destination !== "object" || destination.type !== "toolCall") continue;
		const matches = liveContent.filter(
			candidate =>
				isManagedPlainRecord(candidate) &&
				managedProperty(candidate, "type") === "toolCall" &&
				managedProperty(candidate, "id") === destination.id &&
				managedProperty(candidate, "name") === destination.name,
		);
		const evidenceReads = matches.map(candidate =>
			managedOwnPropertyRead(candidate, "escapedUnicodeArgumentEvidence"),
		);
		const inheritedEvidence = matches.map(candidate =>
			managedInheritedProperty(candidate, "escapedUnicodeArgumentEvidence"),
		);
		const guardReads = matches.map(candidate => managedOwnPropertyRead(candidate, "escapedNonAsciiArguments"));
		const inheritedGuards = matches.map(candidate => managedInheritedProperty(candidate, "escapedNonAsciiArguments"));
		if (matches.length !== 1) {
			if (
				evidenceReads.some(read => read.present) ||
				inheritedEvidence.some(Boolean) ||
				guardReads.some(read => read.present) ||
				inheritedGuards.some(Boolean)
			) {
				destination.incompleteArguments = true;
				destination.incompleteArgumentsReason = "malformed";
			}
			continue;
		}
		const guardRead = guardReads[0]!;
		if (!guardRead.ok || inheritedGuards[0]) {
			destination.incompleteArguments = true;
			destination.incompleteArgumentsReason = "malformed";
		}
		if (guardRead.ok && guardRead.present && guardRead.value === true) destination.escapedNonAsciiArguments = true;
		const evidenceRead = evidenceReads[0]!;
		if (!evidenceRead.present || !evidenceRead.ok || evidenceRead.value === undefined || inheritedEvidence[0]) {
			if (evidenceRead.present || inheritedEvidence[0]) {
				destination.incompleteArguments = true;
				destination.incompleteArgumentsReason = "malformed";
			}
			continue;
		}
		const rawEvidence = evidenceRead.value;
		let evidence: UnicodeEscapeEvidence | undefined;
		try {
			evidence = managedUnicodeEscapeEvidence(rawEvidence);
		} catch {
			evidence = undefined;
		}
		if (evidence && !evidence.malformed) attachUnicodeEscapeEvidence(destination, evidence);
		else {
			destination.incompleteArguments = true;
			destination.incompleteArgumentsReason = "malformed";
		}
	}
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
	const incompleteArgumentsRead = managedPropertyRead(value, "incompleteArguments");
	const incompleteArgumentsReasonRead = managedPropertyRead(value, "incompleteArgumentsReason");
	const escapedGuardRead = managedOwnPropertyRead(value, "escapedNonAsciiArguments");
	const evidenceRead = managedOwnPropertyRead(value, "escapedUnicodeArgumentEvidence");
	const inheritedGuard = managedInheritedProperty(value, "escapedNonAsciiArguments");
	const inheritedEvidence = managedInheritedProperty(value, "escapedUnicodeArgumentEvidence");
	const inheritedIncompleteArguments = managedInheritedProperty(value, "incompleteArguments");
	const inheritedIncompleteArgumentsReason = managedInheritedProperty(value, "incompleteArgumentsReason");
	const incompleteArguments = incompleteArgumentsRead.value;
	const incompleteArgumentsReason = incompleteArgumentsReasonRead.value;
	const incompleteMetadataSentinel =
		(typeof incompleteArguments === "string" && SANITIZER_SENTINELS.has(incompleteArguments)) ||
		(typeof incompleteArgumentsReason === "string" && SANITIZER_SENTINELS.has(incompleteArgumentsReason));
	const incompleteMetadataMalformed =
		!incompleteArgumentsRead.ok ||
		!incompleteArgumentsReasonRead.ok ||
		inheritedIncompleteArguments ||
		inheritedIncompleteArgumentsReason ||
		incompleteMetadataSentinel;
	const escapedNonAsciiArguments = escapedGuardRead.value;
	const rawEscapedUnicodeArgumentEvidence = evidenceRead.value;
	let escapedUnicodeArgumentEvidence: UnicodeEscapeEvidence | undefined;
	try {
		escapedUnicodeArgumentEvidence = managedUnicodeEscapeEvidence(rawEscapedUnicodeArgumentEvidence);
	} catch {
		escapedUnicodeArgumentEvidence = undefined;
	}
	const invalidEscapedUnicodeEvidence =
		(evidenceRead.present &&
			(!evidenceRead.ok ||
				rawEscapedUnicodeArgumentEvidence === undefined ||
				escapedUnicodeArgumentEvidence === undefined ||
				escapedUnicodeArgumentEvidence.malformed)) ||
		!escapedGuardRead.ok ||
		inheritedGuard ||
		inheritedEvidence ||
		incompleteMetadataMalformed;
	const escapedArgumentsGuarded =
		invalidEscapedUnicodeEvidence ||
		(escapedGuardRead.present && escapedGuardRead.ok && escapedNonAsciiArguments === true) ||
		(evidenceRead.present && evidenceRead.ok && escapedUnicodeArgumentEvidence !== undefined);
	return {
		type,
		id,
		name,
		arguments: argumentsValue,
		...(typeof thoughtSignature === "string" ? { thoughtSignature } : {}),
		...(typeof intent === "string" ? { intent } : {}),
		...(typeof customWireName === "string" ? { customWireName } : {}),
		...(invalidEscapedUnicodeEvidence
			? { incompleteArguments: true }
			: typeof incompleteArguments === "boolean"
				? { incompleteArguments }
				: {}),
		...(invalidEscapedUnicodeEvidence
			? { incompleteArgumentsReason: "malformed" as const }
			: typeof incompleteArgumentsReason === "string"
				? {
						incompleteArgumentsReason: incompleteArgumentsReason as
							| "truncated"
							| "malformed"
							| "conflicting"
							| "ambiguous",
					}
				: {}),
		...(escapedArgumentsGuarded
			? { escapedNonAsciiArguments: true }
			: typeof escapedNonAsciiArguments === "boolean"
				? { escapedNonAsciiArguments }
				: {}),
		...(escapedUnicodeArgumentEvidence ? { escapedUnicodeArgumentEvidence } : {}),
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

export function managedAssistantEventSnapshot(
	event: AssistantMessageEvent,
	message: AssistantMessage,
	degradedFieldDiagnostics: Set<string> = new Set<string>(),
): AssistantMessageEvent {
	const directType = managedProperty(event, "type");
	if (
		directType === "text_delta" ||
		directType === "thinking_delta" ||
		directType === "reasoning_summary_delta" ||
		directType === "toolcall_delta"
	) {
		// Delta events are snapshotted field-by-field so unrelated event metadata
		// cannot erase provenance. The delta is read once, detached once, then the
		// same captured value is both validated and emitted.
		const contentIndex = managedAttemptSnapshot(managedProperty(event, "contentIndex"));
		if (!Number.isInteger(contentIndex) || (contentIndex as number) < 0) {
			throw new ManagedAttemptSnapshotError("event.contentIndex");
		}
		const deltaSnapshot = managedAttemptSnapshotDetailed(managedProperty(event, "delta"));
		const delta = deltaSnapshot.snapshot;
		if (directType === "toolcall_delta" && (deltaSnapshot.sanitized || typeof delta !== "string")) {
			throw new ManagedAttemptSnapshotError("event.delta");
		}
		if (deltaSnapshot.sanitized && typeof delta === "string" && SANITIZER_SENTINELS.has(delta)) {
			throw new ManagedAttemptSnapshotError("event.delta");
		}
		if (delta !== undefined && delta !== null && typeof delta === "object") {
			throw new ManagedAttemptSnapshotError("event.delta");
		}
		if (typeof delta !== "string") {
			warnManagedDegradedPrimitive("event.delta", delta, degradedFieldDiagnostics);
		}
		return {
			type: directType,
			contentIndex: contentIndex as number,
			delta: typeof delta === "string" ? delta : "",
			partial: message,
		};
	}
	const eventSnapshot = managedAttemptSnapshotDetailed(event);
	const detached = eventSnapshot.snapshot;
	const record = isManagedPlainRecord(detached) ? detached : undefined;
	// Root repair, mirroring the shell: two benign degradations are re-read
	// through the original event with guarded reads (`managedProperty`) —
	// - a proxy root (structuredClone rejects proxies; the sanitizer collapses
	//   them to a placeholder) whose gets are readable, and
	// - a payload class whose event fields live on prototype getters
	//   (`structuredClone` copies only own enumerable properties).
	// A hostile trap or throwing getter can only degrade a field to undefined,
	// which keeps the named fail-fast diagnostics below; a root that is
	// neither snapshottable nor readable as an event keeps the dedicated root
	// diagnostic.
	const source: unknown = record !== undefined && typeof managedProperty(record, "type") === "string" ? record : event;
	const type = managedProperty(source, "type");
	if (record === undefined && typeof type !== "string") throw new ManagedAttemptSnapshotError("event.snapshot");
	const contentIndex = managedProperty(source, "contentIndex");
	const indexed = () => {
		if (!Number.isInteger(contentIndex) || (contentIndex as number) < 0) {
			throw new ManagedAttemptSnapshotError("event.contentIndex");
		}
		return contentIndex as number;
	};
	if (type === "start") return { type, partial: message };
	if (
		type === "text_start" ||
		type === "thinking_start" ||
		type === "reasoning_summary_start" ||
		type === "toolcall_start"
	)
		return { type, contentIndex: indexed(), partial: message };
	if (type === "text_end" || type === "thinking_end" || type === "reasoning_summary_end") {
		const contentSnapshot = managedAttemptSnapshotDetailed(managedProperty(source, "content"));
		const content = contentSnapshot.snapshot;
		if (contentSnapshot.sanitized && typeof content === "string" && SANITIZER_SENTINELS.has(content)) {
			throw new ManagedAttemptSnapshotError("event.content");
		}
		if (content !== undefined && content !== null && typeof content === "object") {
			throw new ManagedAttemptSnapshotError("event.content");
		}
		if (typeof content !== "string") {
			warnManagedDegradedPrimitive("event.content", content, degradedFieldDiagnostics);
		}
		const safeContent = typeof content === "string" ? content : "";
		return { type, contentIndex: indexed(), content: safeContent, partial: message };
	}
	if (type === "toolcall_end") {
		const toolCall = managedAssistantContent(managedAttemptSnapshot(managedProperty(source, "toolCall")));
		if (toolCall?.type !== "toolCall") throw new ManagedAttemptSnapshotError("event.toolcall");
		return { type, contentIndex: indexed(), toolCall, partial: message };
	}
	if (type === "done") {
		const reason = managedProperty(source, "reason");
		// Degrade out-of-vocabulary done reasons to "stop", matching the closed
		// StopReason vocabulary already normalized by managedAssistantShell.
		const normalized = reason === "stop" || reason === "length" || reason === "toolUse" ? reason : "stop";
		return { type, reason: normalized, message };
	}
	if (type === "error") {
		const reason = managedProperty(source, "reason");
		const normalized = reason === "aborted" || reason === "error" ? reason : "error";
		return { type, reason: normalized, error: message };
	}
	// An unknown string event type degrades to a terminal done/stop; a
	// non-string type is malformed provider output that must fail fast.
	if (typeof type === "string") return { type: "done", reason: "stop", message } as AssistantMessageEvent;
	throw new ManagedAttemptSnapshotError("event.unknownType");
}

function isManagedPlainRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) && !nodeUtilTypes.isProxy(value);
}

/**
 * Emit ONE bounded, shape-only diagnostic for a local managed-attempt failure
 * (snapshot machinery or staging buffer). Names only the envelope shape — the
 * failure stage, model identity, snapshot mode, staged counters, and (for
 * content stages only) the content block count — never raw text, thinking,
 * tool arguments, or any provider payload content. Emitted only for the
 * module-private local error identities, so a foreign error cannot self-label
 * into the log. Scoped to this stream invocation: not latched across
 * invocations, matching the #4443 precedent.
 */
function warnManagedSnapshotFailure(
	error: unknown,
	config: AgentLoopConfig,
	transaction: ManagedAttemptTransaction | undefined,
): void {
	// Identity, never self-labeling: only the module-private local error classes
	// may produce this diagnostic. A foreign error that sets a matching
	// `errorKind` (and could smuggle provider or prompt text in `stage`) is
	// ignored here, so nothing outside this module can reach the log.
	if (!(error instanceof ManagedAttemptSnapshotError) && !(error instanceof ManagedAttemptBufferOverflowError)) {
		return;
	}
	// Defense in depth: even an in-module regression cannot widen the log past
	// the closed stage vocabulary.
	const stage = MANAGED_LOCAL_FAILURE_STAGE_SET.has(error.stage) ? error.stage : "unknown";
	const diagnostic: Record<string, unknown> = {
		stage,
		errorKind: error.errorKind,
		model: config.model.id,
		provider: config.model.provider,
		snapshotMode: transaction?.snapshotMode ?? "none",
	};
	const staged = transaction?.stagedShape() ?? { stagedEventCount: 0, stagedBytes: 0, contentBlockCount: 0 };
	diagnostic.stagedEventCount = staged.stagedEventCount;
	diagnostic.stagedBytes = staged.stagedBytes;
	if (stage === "shell.content") {
		diagnostic.contentBlockCount = staged.contentBlockCount;
	}
	logger.warn("agent: managed fallback attempt rejected a local snapshot", diagnostic);
}

/**
 * Holds provisional assistant output above the public event stream. Managed
 * fallback keeps the whole attempt atomic; non-managed escaped-argument
 * detection uses lossless snapshots until visible output or the staging cap
 * commits the transaction.
 */
type ManagedAttemptBatchItem =
	| { type: "event"; event: AgentEvent; bytes?: number }
	| { type: "assistant_event"; message: AssistantMessage; event: AssistantMessageEvent; bytes?: number };

/**
 * Streaming increments whose complete value is re-published by the block's own
 * `*_end` frame and by the terminal `message_end` / `done` frames. Those
 * terminal frames are never reclaimed, so dropping the increments loses no
 * content — only the intermediate frames that carried it on the way there.
 */
const MANAGED_SUPERSEDED_DELTA_EVENT_TYPES: ReadonlySet<string> = new Set([
	"text_delta",
	"thinking_delta",
	"reasoning_summary_delta",
	"toolcall_delta",
]);

function isSupersededStreamingDelta(item: ManagedAttemptBatchItem): boolean {
	if (item.type === "assistant_event") return MANAGED_SUPERSEDED_DELTA_EVENT_TYPES.has(item.event.type);
	if (item.event.type !== "message_update") return false;
	return MANAGED_SUPERSEDED_DELTA_EVENT_TYPES.has(item.event.assistantMessageEvent.type);
}

class ManagedAttemptTransaction {
	#batch: ManagedAttemptBatchItem[] = [];
	#stagedEventCount = 0;
	#stagedBytes = 0;
	/** Caps for this transaction, read once from the operator env knobs. */
	readonly #maxStagedEvents = managedAttemptMaxStagedEvents();
	readonly #maxStagedBytes = managedAttemptMaxStagedBytes();
	/** Shape snapshot retained across discard() for bounded failure diagnostics. */
	#lastStagedShape: { stagedEventCount: number; stagedBytes: number; contentBlockCount: number } | undefined;
	#discarded = false;
	#committed = false;
	#degradedFieldDiagnostics = new Set<string>();

	constructor(
		private readonly stream: EventStream<AgentEvent, AgentMessage[]>,
		private readonly onAssistantMessageEvent:
			| ((message: AssistantMessage, event: AssistantMessageEvent) => void)
			| undefined,
		private readonly model: AgentLoopConfig["model"],
		readonly scope?: AttemptScope,
		readonly snapshotMode: "managed" | "lossless" = "managed",
	) {}

	push(event: AgentEvent): void {
		if (this.#committed) {
			if (event.type === "message_end" || event.type === "turn_end") {
				this.#batch.push({ type: "event", event });
				return;
			}
			this.stream.push(event);
			return;
		}
		this.#stage(event);
	}

	end(messages: AgentMessage[]): void {
		this.stream.end(messages);
	}

	stageAssistantMessageEvent(message: AssistantMessage, event: AssistantMessageEvent): void {
		if (this.#committed) {
			// Already published: nothing is retained, so the live pair can go
			// straight to the consumer without a staging measurement. One
			// snapshot serves as BOTH the callback message and the event's
			// `partial`, preserving the paired-snapshot identity the direct
			// callbacks were built on and avoiding a second full clone of the
			// growing message.
			const committedPartial = this.#assistantSnapshot(message);
			this.onAssistantMessageEvent?.(committedPartial, this.#assistantEventSnapshot(event, committedPartial));
			return;
		}
		// Every retained batch item must be charged against the caps BEFORE it
		// is retained, including the assistant message/event pair: an uncharged
		// snapshot would let actual retention exceed the caps while the counters
		// still read under them. Two-phase guard so the allocation that could
		// OOM never happens ahead of the check:
		//   1. INCREMENTAL pre-check on the LIVE pair — a replacer walk that
		//      stops as soon as the projected size crosses the cap, without
		//      materializing the full JSON string or its UTF-8 encoding (review:
		//      "size incrementally so serialization can stop before
		//      materializing the whole value"). Only if the walk completes under
		//      the cap is any snapshot taken.
		//   2. EXACT accounting of the retained detached pair — a live class can
		//      serialize compactly through a prototype `toJSON()` that
		//      `structuredClone` drops, so the live measurement may undercount
		//      what the retained snapshot actually holds (same convention as
		//      `#stage`).
		const liveBudget = this.#maxStagedBytes - this.#stagedBytes;
		const liveExcess = managedSnapshotExceedsBytes([message, event], liveBudget);
		if (liveExcess === "over") {
			this.#compactSupersededFrames();
			if (managedSnapshotExceedsBytes([message, event], this.#maxStagedBytes - this.#stagedBytes) === "over") {
				if (this.snapshotMode === "lossless") {
					this.flush();
					// One snapshot for the whole callback pair (see the committed
					// branch above): the callback message and `event.partial`
					// must be the same object.
					const flushedPartial = this.#assistantSnapshot(message);
					this.onAssistantMessageEvent?.(flushedPartial, this.#assistantEventSnapshot(event, flushedPartial));
					return;
				}
				// Report the POST-compaction remaining budget + 1 (a valid lower
				// bound for the live pair's size, and arithmetically consistent
				// with the post-compaction retained shape #overflowShape reports).
				this.discard();
				throw new ManagedAttemptBufferOverflowError(
					"overflow.staged",
					this.#overflowShape("overflow.staged", this.#maxStagedBytes - this.#stagedBytes + 1),
				);
			}
		}
		const partial = this.#assistantSnapshot(message);
		const snapshotEvent = this.#assistantEventSnapshot(event, partial);
		// Walk-based exact measure (no JSON string or UTF-8 copy materialized).
		const retainedBytes = managedSnapshotJsonByteLength([partial, snapshotEvent]);
		if (retainedBytes === undefined) {
			// Fail CLOSED, exactly like the #stage twin on the same condition: an
			// unmeasurable retained pair must not be retained uncharged (a 0-byte
			// charge plus the skipped byte-cap gate would let actual retention
			// exceed the caps while the counters still read under them). The
			// snapshot forms are JSON-safe by construction, so this is only
			// reachable if that construction regresses; it carries no transport
			// facts and never burns the fallback chain. Lossless mode cannot
			// fail the attempt: flush what is staged and publish the live pair.
			if (this.snapshotMode === "lossless") {
				this.flush();
				this.onAssistantMessageEvent?.(partial, snapshotEvent);
				return;
			}
			this.discard();
			throw new ManagedAttemptSnapshotError("staging.measure");
		}
		if (this.#wouldOverflow(retainedBytes)) {
			this.#compactSupersededFrames();
			if (this.#wouldOverflow(retainedBytes)) {
				if (this.snapshotMode === "lossless") {
					this.flush();
					this.onAssistantMessageEvent?.(partial, snapshotEvent);
					return;
				}
				this.discard();
				throw new ManagedAttemptBufferOverflowError(
					"overflow.staged",
					this.#overflowShape("overflow.staged", retainedBytes),
				);
			}
		}
		// Each frame's exact accounted size is retained so compaction can debit
		// exactly what it reclaims instead of re-measuring the whole batch.
		this.#batch.push({
			type: "assistant_event",
			message: partial,
			event: snapshotEvent,
			bytes: retainedBytes,
		});
		this.#stagedEventCount += 1;
		this.#stagedBytes += retainedBytes;
	}

	flush(): void {
		if (this.#discarded) return;
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

	flushNonTerminal(): void {
		if (this.#discarded || this.#committed) return;
		const retained: ManagedAttemptBatchItem[] = [];
		for (const item of this.#batch) {
			if (this.#isTerminalItem(item)) {
				retained.push(item);
			} else if (item.type === "assistant_event") {
				this.onAssistantMessageEvent?.(item.message, item.event);
			} else {
				this.stream.push(item.event);
			}
		}
		this.#batch = retained;
	}

	commitCallbacksAndUpdates(): void {
		if (this.#discarded || this.#committed) return;
		for (const item of this.#batch) {
			if (item.type === "assistant_event") {
				this.onAssistantMessageEvent?.(item.message, item.event);
			} else if (item.event.type !== "message_end" && item.event.type !== "turn_end") {
				this.stream.push(item.event);
			}
		}
		this.#batch = this.#batch.filter(
			item => item.type === "event" && (item.event.type === "message_end" || item.event.type === "turn_end"),
		);
		this.#committed = true;
	}

	replacePendingAssistantMessage(message: AssistantMessage): void {
		this.#batch = this.#batch.map(item => {
			if (item.type === "assistant_event") {
				return { ...item, message, event: this.#assistantEventSnapshot(item.event, message) };
			}
			if (item.event.type === "message_end") return { ...item, event: { ...item.event, message } };
			if (item.event.type === "turn_end") return { ...item, event: { ...item.event, message } };
			return item;
		});
	}

	get committed(): boolean {
		return this.#committed;
	}

	acceptedAssistantSnapshot(message: AssistantMessage): AssistantMessage {
		const sourceContent = Array.isArray(message.content) ? message.content : [];
		const sourceMetadata = sourceContent.map(block =>
			block?.type === "toolCall" ? escapedToolCallMetadata(block) : undefined,
		);
		const snapshot = this.#assistantSnapshot(message);
		if (snapshot.role !== "assistant") return snapshot;
		if (!Array.isArray(snapshot.content)) snapshot.content = [];
		for (let index = 0; index < sourceContent.length; index += 1) {
			const sourceBlock = sourceContent[index];
			if (sourceBlock?.type !== "toolCall") continue;
			const metadata = sourceMetadata[index];
			let snapshotBlock = snapshot.content[index];
			if (snapshotBlock?.type !== "toolCall") {
				const normalized = managedAssistantContent(sourceBlock);
				if (normalized?.type !== "toolCall") continue;
				snapshotBlock = normalized;
				snapshot.content[index] = snapshotBlock;
			}
			if (metadata) {
				if (metadata.malformed) {
					const marked = {
						...snapshotBlock,
						incompleteArguments: true,
						incompleteArgumentsReason: "malformed" as const,
					};
					snapshot.content[index] = marked;
					acceptedToolCallMetadata.set(marked, metadata);
				} else {
					acceptedToolCallMetadata.set(snapshotBlock, metadata);
				}
			}
		}
		return snapshot;
	}

	discard(): void {
		if (!this.#discarded) {
			this.#lastStagedShape = {
				stagedEventCount: this.#stagedEventCount,
				stagedBytes: this.#stagedBytes,
				contentBlockCount: this.#stagedContentBlockCount(),
			};
		}
		this.#batch = [];
		this.#stagedBytes = 0;
		this.#stagedEventCount = 0;
		this.#discarded = true;
	}

	/**
	 * Shape-only view of what was staged when the attempt failed; never carries
	 * content. Reports the retained pre-discard shape when the failing path
	 * discarded the batch, and the live counters when it threw before discard.
	 */
	stagedShape(): { stagedEventCount: number; stagedBytes: number; contentBlockCount: number } {
		return (
			this.#lastStagedShape ?? {
				stagedEventCount: this.#stagedEventCount,
				stagedBytes: this.#stagedBytes,
				contentBlockCount: this.#stagedContentBlockCount(),
			}
		);
	}

	#stagedContentBlockCount(): number {
		for (let i = this.#batch.length - 1; i >= 0; i--) {
			const item = this.#batch[i];
			const message =
				item.type === "assistant_event"
					? item.message
					: "message" in item.event
						? (item.event.message as unknown)
						: undefined;
			const content = managedProperty(message, "content");
			if (Array.isArray(content)) return content.length;
		}
		return 0;
	}
	#wouldOverflow(bytes: number): boolean {
		return this.#stagedEventCount + 1 > this.#maxStagedEvents || this.#stagedBytes + bytes > this.#maxStagedBytes;
	}
	/**
	 * Shape snapshot for a buffer-overflow diagnostic: the rejecting stage,
	 * which cap tripped, the retained staged counters (post-#4610-compaction),
	 * the incoming event's own size, and the limits. Must be called AFTER
	 * `discard()` so the staged counters report the retained batch shape — the
	 * volume that still could not fit after superseded-delta compaction, not
	 * zeroes. `exceeded` is derived from the projected values, not the
	 * retained ones, because the retained batch is by definition within both
	 * caps; `incomingEventBytes` lets the parent render why a single event
	 * alone blew a cap.
	 */
	#overflowShape(
		stage: ManagedLocalFailureStage,
		incomingEventBytes: number,
	): ManagedAttemptBufferOverflowError["overflow"] {
		const staged = this.stagedShape();
		// Derive from the transaction's effective (operator-configurable) caps,
		// not the module constants: the diagnostic must name the limits that
		// actually tripped, which can differ from the defaults when an override
		// is active.
		const eventsExceeded = staged.stagedEventCount + 1 > this.#maxStagedEvents;
		const bytesExceeded = staged.stagedBytes + incomingEventBytes > this.#maxStagedBytes;
		return {
			stage,
			exceeded: eventsExceeded && bytesExceeded ? "both" : eventsExceeded ? "events" : "bytes",
			stagedEventCount: staged.stagedEventCount,
			stagedBytes: staged.stagedBytes,
			incomingEventBytes,
			maxStagedEvents: this.#maxStagedEvents,
			maxStagedBytes: this.#maxStagedBytes,
		};
	}

	/**
	 * Reclaim staged frames that later staged frames already supersede.
	 *
	 * Every staged streaming frame carries the WHOLE accumulated partial (once as
	 * `message`, once as `assistantMessageEvent.partial`), so a turn that streams
	 * N increments stages ~N * length bytes: quadratic in the response length. A
	 * reasoning-heavy turn of a few thousand tokens therefore used to exhaust the
	 * provisional cap and kill the whole run, even though the attempt itself was
	 * healthy and the cap exists only to bound memory.
	 *
	 * Each `*_delta` increment is re-published in full by its block's `*_end`
	 * frame and by the terminal `message_end` / `done` frames, and those are
	 * retained, so dropping the increments reclaims the growth without inventing
	 * or losing content. Nothing is published here: the batch stays
	 * all-or-nothing, so a discarded attempt remains unobservable and the
	 * fallback chain is still untouched.
	 *
	 * Returns whether anything was reclaimed, so the caller can re-test the cap
	 * and keep failing fast on a single payload that cannot fit on its own.
	 */
	#compactSupersededFrames(): boolean {
		if (this.#batch.length === 0) return false;
		const retained: ManagedAttemptBatchItem[] = [];
		let reclaimedBytes = 0;
		let reclaimedEvents = 0;
		for (const item of this.#batch) {
			if (!isSupersededStreamingDelta(item)) {
				retained.push(item);
				continue;
			}
			reclaimedBytes += item.bytes ?? 0;
			reclaimedEvents += 1;
		}
		if (retained.length === this.#batch.length) return false;
		this.#batch = retained;
		this.#stagedBytes -= reclaimedBytes;
		this.#stagedEventCount -= reclaimedEvents;
		return true;
	}

	#stage(event: AgentEvent): void {
		if (this.snapshotMode === "lossless") {
			const snapshot = this.#repairAssistantEvent(event);
			const rawExcess = managedSnapshotExceedsBytes(snapshot, this.#maxStagedBytes - this.#stagedBytes);
			if (rawExcess === "over") {
				this.flush();
				this.push(event);
				return;
			}
			// Walk-based exact measure: no full JSON string or UTF-8 encoding is
			// materialized just to size the candidate (exact-head 078e22c0
			// finding 1 applies to the lossless exact measure too).
			const rawBytes = managedSnapshotJsonByteLength(snapshot);
			if (rawBytes !== undefined && this.#wouldOverflow(rawBytes)) {
				this.flush();
				this.push(event);
				return;
			}
			// Bound the structuredClone allocation inside the snapshot forms the
			// same way the managed path does: a compact `toJSON()` surface can hide
			// an over-budget clone-visible payload. Ordinary sessions flush and
			// stream the LIVE event through rather than degrading it — the
			// documented lossless contract — instead of staging a sanitized copy.
			if (managedCloneSurfaceExceedsBudget(event, this.#maxStagedBytes - this.#stagedBytes) === "over") {
				this.flush();
				this.push(event);
				return;
			}
			let detached: AgentEvent;
			try {
				detached = this.#losslessAgentEventSnapshot(snapshot);
			} catch {
				this.discard();
				throw new ManagedAttemptSnapshotError("staging.losslessSnapshot");
			}
			const detachedBytes = managedSnapshotJsonByteLength(detached);
			if (detachedBytes === undefined) {
				this.discard();
				throw new ManagedAttemptSnapshotError("staging.measure");
			}
			if (this.#wouldOverflow(detachedBytes)) {
				this.flush();
				this.push(detached);
				return;
			}
			this.#batch.push({ type: "event", event: detached, bytes: detachedBytes });
			this.#stagedEventCount++;
			this.#stagedBytes += detachedBytes;
			return;
		}
		// Walk the raw event FIRST so an oversized payload is rejected before the
		// managed snapshot duplicates it. Both oracles run against the REMAINING
		// budget: the JSON-surface walk bounds the serialized charge, and the
		// clone-surface walk bounds the structuredClone ALLOCATION — a live class
		// can serialize compactly through `toJSON()` while carrying a large own
		// payload the clone would duplicate (exact-head 078e22c0 finding 1).
		// Cyclic/JSON-hostile events fall through to the sanitized detached form
		// below, which is the cycle-safe estimator.
		const preflightOver = (): boolean => {
			const remaining = this.#maxStagedBytes - this.#stagedBytes;
			return (
				managedSnapshotExceedsBytes(event, remaining) === "over" ||
				managedCloneSurfaceExceedsBudget(event, remaining) === "over"
			);
		};
		if (preflightOver()) {
			// A long turn reaches the cap through accumulated streaming increments,
			// not through one oversized payload. Reclaim the superseded increments
			// first; only a batch that still cannot fit is a real local overflow.
			// The overflow shape snapshots the retained POST-COMPACTION batch (the
			// volume that still cannot fit even after reclamation), because #4610
			// made the pre-compaction shape describe deltas it already reclaimed.
			this.#compactSupersededFrames();
			if (preflightOver()) {
				// Report the incoming event's real size (a bounded walk — the
				// sentinel caps the count at twice the cap, so a hostile shared
				// DAG cannot turn the diagnostic itself into unbounded work).
				// The previous form passed `remaining + 1` evaluated AFTER
				// discard() zeroed the counters, which fabricated the constant
				// `maxStagedBytes + 1` and mislabeled every mixed overflow as a
				// single-event blowout.
				const remainingBytes = this.#maxStagedBytes - this.#stagedBytes;
				const incomingBytes = (() => {
					try {
						// Bounded walk: the sentinel caps even this diagnostic's
						// work at twice the cap. The remaining budget + 1 is the
						// honest floor either way — the event demonstrably does
						// not fit in what remains (that is why it is rejected),
						// including when only the clone-visible surface tripped
						// while the compact JSON surface reads small.
						return Math.max(
							managedJsonByteLengthWithin(event, this.#maxStagedBytes * 2) ?? 0,
							remainingBytes + 1,
						);
					} catch {
						// Unserializable or beyond twice the cap: the floor alone
						// still arithmetically explains the rejection.
						return remainingBytes + 1;
					}
				})();
				this.discard();
				throw new ManagedAttemptBufferOverflowError(
					"overflow.preMeasure",
					this.#overflowShape("overflow.preMeasure", incomingBytes),
				);
			}
		}
		const repaired = this.#repairAssistantEvent(event);
		const detailed = managedAttemptSnapshotDetailed(repaired, this.#maxStagedBytes - this.#stagedBytes);
		const snapshot = detailed.snapshot;
		// Always account the exact detached value. A live custom class can use
		// prototype `toJSON()` to serialize compactly while structuredClone
		// removes that serializer and exposes a larger or JSON-hostile own value.
		// Reusing the live pre-measure would therefore accept an unserializable
		// snapshot or undercount the retained bytes.
		const bytes = detailed.jsonBytes;
		if (bytes === undefined) {
			// The sanitizer's output is total (detached, JSON-safe), so this is
			// unreachable unless the sanitizer itself regresses. Fail as a
			// dedicated local error: it carries no transport facts, so it is
			// non-retryable and can never be misattributed to the provider.
			this.discard();
			throw new ManagedAttemptSnapshotError("staging.sanitize");
		}
		if (this.#wouldOverflow(bytes)) {
			// Same ordering as the pre-measure path: compact first, then fail only
			// if the retained post-compaction batch still cannot fit — and report
			// that retained shape, not the pre-compaction one.
			this.#compactSupersededFrames();
			if (this.#wouldOverflow(bytes)) {
				this.discard();
				throw new ManagedAttemptBufferOverflowError(
					"overflow.staged",
					this.#overflowShape("overflow.staged", bytes),
				);
			}
		}
		// Retain each frame's accounted size so compaction can debit exactly what
		// it reclaims instead of re-measuring the whole batch.
		this.#batch.push({ type: "event", event: snapshot, bytes });
		this.#stagedEventCount += 1;

		this.#stagedBytes += bytes;
	}

	#repairAssistantEvent(event: AgentEvent): AgentEvent {
		if (this.snapshotMode === "lossless") return event;
		if (event.type === "message_start" || event.type === "message_end" || event.type === "turn_end") {
			return event.message.role === "assistant"
				? { ...event, message: managedAssistantShell(event.message, this.model, this.#degradedFieldDiagnostics) }
				: event;
		}
		if (event.type === "message_update") {
			const message = managedAssistantShell(event.message, this.model, this.#degradedFieldDiagnostics);
			return {
				...event,
				message,
				assistantMessageEvent: managedAssistantEventSnapshot(
					event.assistantMessageEvent,
					message,
					this.#degradedFieldDiagnostics,
				),
			};
		}
		if (event.type === "agent_end") {
			return {
				...event,
				messages: event.messages.map(message =>
					message.role === "assistant"
						? managedAssistantShell(message, this.model, this.#degradedFieldDiagnostics)
						: message,
				),
			};
		}
		return event;
	}

	#losslessSnapshot<T>(value: T): T {
		const snapshot = losslessDetachedClone(value);
		if (
			isManagedPlainRecord(snapshot) &&
			managedProperty(snapshot, "role") === "assistant" &&
			Array.isArray(managedProperty(snapshot, "content"))
		) {
			restoreTransientUnicodeEscapeEvidence(
				managedProperty(snapshot, "content") as AssistantMessage["content"],
				value,
			);
		}
		return snapshot;
	}

	#losslessAgentEventSnapshot(event: AgentEvent): AgentEvent {
		switch (event.type) {
			case "message_start":
			case "message_end":
				return { ...event, message: this.#losslessSnapshot(event.message) };
			case "message_update": {
				const message = this.#losslessSnapshot(event.message);
				if (message.role !== "assistant") return { ...event, message };
				const assistantMessageEvent = this.#assistantEventSnapshot(event.assistantMessageEvent, message);
				return { ...event, message, assistantMessageEvent };
			}
			case "turn_end":
				return {
					...event,
					message: this.#losslessSnapshot(event.message),
					toolResults: this.#losslessSnapshot(event.toolResults),
				};
			default:
				return this.#losslessSnapshot(event);
		}
	}

	#assistantSnapshot(message: AssistantMessage): AssistantMessage {
		return this.snapshotMode === "lossless"
			? this.#losslessSnapshot(message)
			: managedAssistantShell(message, this.model, this.#degradedFieldDiagnostics);
	}

	#assistantEventSnapshot(event: AssistantMessageEvent, message: AssistantMessage): AssistantMessageEvent {
		if (this.snapshotMode === "managed") {
			return managedAssistantEventSnapshot(event, message, this.#degradedFieldDiagnostics);
		}
		const snapshot = this.#losslessSnapshot(event);
		if (snapshot.type === "done") return { ...snapshot, message };
		if (snapshot.type === "error") return { ...snapshot, error: message };
		if (snapshot.type === "toolChoiceIncapability") return snapshot;
		return { ...snapshot, partial: message };
	}

	#isTerminalItem(item: ManagedAttemptBatchItem): boolean {
		if (item.type === "assistant_event") return item.event.type === "done" || item.event.type === "error";
		return item.event.type === "message_end" || item.event.type === "turn_end";
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
	scope?: AttemptScope,
): Extract<AgentEvent, { type: "agent_end" }> {
	const base = { type: "agent_end" as const, messages, stopReason, ...(scope ? { scope } : {}) };
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
		if (isZodSchema(parameters)) {
			// Zod instances must never cross the provider boundary as-is: any
			// downstream JSON round-trip (append-only stable-prefix cloning, fork
			// seed snapshots) reduces a live ZodObject to a bare `{def, type}`
			// object with no `properties`/`required`, so providers advertise a
			// tool with no parameters and the model omits required arguments
			// (issue #4837: subagent-only bash "command: expected string,
			// received undefined"). Intent injection forced the conversion on
			// operator-facing sessions; canonical sub-sessions run it too.
			const wired = zodToWireSchema(parameters);
			parameters =
				injectIntent && intentMode !== "omit"
					? (injectIntentIntoSchema(wired, intentMode) as TSchema)
					: (wired as TSchema);
		} else if (injectIntent && intentMode !== "omit") {
			parameters = injectIntentIntoSchema(parameters, intentMode) as TSchema;
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
	initialScope?: AttemptScope,
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
				initialScope,
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
	initialScope?: AttemptScope,
): Promise<void> {
	let firstTurn = true;
	let lastAttemptScope: AttemptScope | undefined;
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
	// Fires at most one repaired resend per run for the reasoning-content replay
	// breaker below (DeepSeek "reasoning_content ... must be passed back").
	let reasoningContentRepairAttempted = false;
	// Consecutive resamples spent on the current turn because its tool arguments
	// arrived `\uXXXX`-escaped. Reset once a turn gets past the check, so every
	// turn is judged on its own wire bytes.
	let escapedNonAsciiResampleAttempt = 0;
	// A queue-backed dynamic tool choice belongs to the logical turn, not to one
	// wire attempt. Capture it once and replay it across escaped-argument
	// resamples; reset only after a response is accepted for normal processing.
	let escapedNonAsciiToolChoiceCaptured = false;
	let escapedNonAsciiToolChoice: ToolChoice | undefined;
	let previousMalformedToolSignatures = new Set<string>();
	type SyntheticRecoveryKind = "malformed-tool-call" | "composer-bash-policy" | "provider" | "escaped-nonascii";
	let pendingRecovery:
		| {
				kind: SyntheticRecoveryKind;
				inserted: boolean;
				syntheticMessage?: UserMessage;
		  }
		| undefined = config.transientRecoveryMessage
		? { kind: "escaped-nonascii", inserted: true, syntheticMessage: config.transientRecoveryMessage }
		: undefined;
	let malformedToolRecoveryAttempted = false;
	let composerBashPolicyRecoveryAttempted = false;
	// Deterministic terminal circuit breaker for argument-validation loops.
	//
	// Counts CONSECUTIVE turns whose tool calls were all malformed, regardless of
	// whether the arguments repeat. Signature-based "repeated" detection alone is
	// not a bound: a model that rotates invalid argument shapes never trips it, so
	// the loop could run forever. Any turn that produces a non-malformed batch
	// resets the counter, so healthy runs are unaffected.
	let consecutiveMalformedTurns = 0;

	// Outer loop: continues when queued follow-up messages arrive after agent would stop
	while (true) {
		let hasMoreToolCalls = true;

		// Inner loop: process tool calls and steering messages
		while (hasMoreToolCalls || pendingMessages.length > 0) {
			const scope =
				initialScope ?? (firstTurn ? config.initialScope : undefined) ?? config.attemptMinter?.mint("main");
			initialScope = undefined;
			const managedTransaction =
				initialTransaction ??
				(config.fallbackManaged
					? new ManagedAttemptTransaction(stream, config.onAssistantMessageEvent, config.model, scope)
					: undefined);
			const escapedToolTransaction = config.fallbackManaged
				? undefined
				: new ManagedAttemptTransaction(stream, config.onAssistantMessageEvent, config.model, scope, "lossless");
			const transaction = managedTransaction ?? escapedToolTransaction;
			initialTransaction = undefined;
			const attemptScope = transaction?.scope ?? scope;
			lastAttemptScope = attemptScope;
			const attemptStream = transaction ?? stream;
			if (!firstTurn) {
				attemptStream.push({ type: "turn_start", ...(attemptScope ? { scope: attemptScope } : {}) });
			} else {
				firstTurn = false;
			}

			// Commit queued user input outside the provisional assistant transaction so a
			// discarded managed attempt cannot lose it before its retry continuation.
			if (pendingMessages.length > 0) {
				for (const message of pendingMessages) {
					stream.push({ type: "message_start", message, scope: attemptScope });
					stream.push({ type: "message_end", message, scope: attemptScope });
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
				const maintenanceResult = await config.maintainContext(currentContext, lifecycle);
				const maintenance =
					typeof maintenanceResult === "string" ? { outcome: maintenanceResult } : maintenanceResult;
				// A callback can settle after its loop has been cancelled. Never let a
				// stale "not-needed" fall through to streamAssistantResponse, which
				// invokes the provider before it observes the aborted signal.
				const outcome = loopSignal.aborted ? "aborted" : maintenance.outcome;
				if (maintenance.releaseCurrentContext) {
					currentContext.messages.length = 0;
					newMessages.length = 0;
					convertedContextCache.delete(config);
				}

				if (outcome !== "not-needed") {
					publishAgentEnd(
						stream,
						config,
						{
							type: "agent_end",
							messages: newMessages,
							stopReason: "maintenance",
							maintenanceOutcome: outcome,
						},
						attemptScope,
					);
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
			const attemptTransaction = managedTransaction;
			const recoveryAttempt = pendingRecovery;
			const wasMalformedToolRecoveryAttempt = recoveryAttempt?.kind === "malformed-tool-call";
			// An escaped-non-ASCII steering resample is a re-request of the SAME
			// logical turn, not a diagnostic detour: tools stay enabled and the
			// captured logical-turn tool choice is replayed, so a queue-backed
			// "required" still lands on the accepted attempt.
			const wasEscapedNonAsciiRecoveryAttempt = recoveryAttempt?.kind === "escaped-nonascii";
			try {
				const getLogicalTurnToolChoice = (): ToolChoice | undefined => {
					if (escapedNonAsciiToolChoiceCaptured) return escapedNonAsciiToolChoice;
					escapedNonAsciiToolChoice = config.getToolChoice?.();
					escapedNonAsciiToolChoiceCaptured = true;
					return escapedNonAsciiToolChoice;
				};
				const attemptConfig = attemptTransaction
					? {
							...config,
							onAssistantMessageEvent: (partial: AssistantMessage, event: AssistantMessageEvent) =>
								attemptTransaction.stageAssistantMessageEvent(partial, event),
						}
					: config;
				if (recoveryAttempt && !recoveryAttempt.inserted) {
					const recoveryContent =
						recoveryAttempt.kind === "composer-bash-policy"
							? COMPOSER_BASH_POLICY_RECOVERY_PROMPT
							: recoveryAttempt.kind === "malformed-tool-call"
								? repeatedToolFailureRecoveryPrompt
								: recoveryAttempt.kind === "escaped-nonascii"
									? escapedNonAsciiRecoveryPrompt
									: undefined;
					if (recoveryContent) {
						recoveryAttempt.syntheticMessage = {
							role: "user",
							content: recoveryContent,
							synthetic: true,
							timestamp: Date.now(),
						};
					}
					recoveryAttempt.inserted = true;
				}
				message = await streamAssistantResponse(
					currentContext,
					attemptConfig,
					loopSignal,
					transaction ? (transaction as unknown as EventStream<AgentEvent, AgentMessage[]>) : stream,
					telemetry,
					invokeAgentSpan,
					stepCounter,
					attemptScope,
					streamFn,
					harmonyRetryAttempt,
					recoveryAttempt?.syntheticMessage
						? {
								syntheticMessage: recoveryAttempt.syntheticMessage,
								disableTools: wasMalformedToolRecoveryAttempt,
								forceAutoToolChoice: !wasMalformedToolRecoveryAttempt && !wasEscapedNonAsciiRecoveryAttempt,
							}
						: undefined,
					escapedToolTransaction,
					recoveryAttempt && !wasEscapedNonAsciiRecoveryAttempt
						? undefined
						: { value: getLogicalTurnToolChoice() },
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
					if (config.fallbackManaged) warnManagedSnapshotFailure(err, config, transaction);
					if (config.fallbackManaged && transaction && managedContextOverflow(failureMessage, config)) {
						transaction.discard();
						currentContext.messages.splice(contextMessageCount);
						newMessages.splice(newMessageCount);
						await config.onManagedAttemptOutcome?.(
							managedContextOverflowOutcome(failureMessage, transaction.scope),
						);
						stream.end(newMessages);
						return;
					}
					if (config.fallbackManaged && transaction && managedRetryableFailure(err)) {
						transaction.discard();
						currentContext.messages.splice(contextMessageCount);
						newMessages.splice(newMessageCount);
						await config.onManagedAttemptOutcome?.(managedFailureOutcome(failureMessage, transaction.scope));
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
					if (escapedToolTransaction?.committed) {
						const contaminated = currentContext.messages.at(-1);
						if (contaminated?.role !== "assistant") throw err;
						const sanitized = escapedToolTransaction.acceptedAssistantSnapshot({
							...contaminated,
							content: [],
							stopReason: "aborted",
							providerPayload: undefined,
						});
						escapedToolTransaction.replacePendingAssistantMessage(sanitized);
						escapedToolTransaction.flush();
					}
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
				// The rejected turn was already committed to the context by the
				// streaming path. Repair (and resend) only the history that
				// preceded it: replaying an errored assistant turn re-poisons the
				// request and leaves a second assistant tail behind, which no
				// continuation can resume from.
				const rejectedIndex = currentContext.messages.length - 1;
				const rejectedCommitted =
					rejectedIndex >= 0 && currentContext.messages[rejectedIndex]?.role === "assistant";
				const retained = rejectedCommitted
					? currentContext.messages.slice(0, rejectedIndex)
					: currentContext.messages;
				if (repairInvalidPromptHistory(retained)) {
					if (rejectedCommitted) currentContext.messages.splice(rejectedIndex, 1);
					continue;
				}
			}
			// Session-level reasoning-content replay circuit breaker (bounded,
			// strip-only). DeepSeek V4 (and reasoning-capable siblings on any
			// OpenAI-compatible proxy) reject every follow-up turn with
			// "reasoning_content ... must be passed back to the API" once a prior
			// assistant turn carried reasoning the proxy stripped to an empty
			// `encrypted_content`. Resending the identical history re-triggers the
			// deterministic 400, so naive auto-retry would loop. On the first such
			// rejection of this run, strip the unusable `reasoning` items from the
			// Responses history payload IN PLACE (never dropping text, tool-call, or
			// tool-output items). If that removed anything, resend exactly once so
			// the model re-reasons; if nothing could be stripped, fall through to
			// terminal handling and fail fast. Budget = one repaired resend.
			if (
				!config.fallbackManaged &&
				message.stopReason === "error" &&
				!reasoningContentRepairAttempted &&
				isReasoningContentReplayError(message)
			) {
				reasoningContentRepairAttempted = true;
				// The rejected turn was already committed to the context by the
				// streaming path. Repair (and resend) only the history that
				// preceded it: replaying an errored assistant turn re-triggers the
				// rejection and leaves a second assistant tail behind.
				const rejectedIndex = currentContext.messages.length - 1;
				const rejectedCommitted =
					rejectedIndex >= 0 && currentContext.messages[rejectedIndex]?.role === "assistant";
				const retained = rejectedCommitted
					? currentContext.messages.slice(0, rejectedIndex)
					: currentContext.messages;
				if (repairReasoningContentReplayHistory(retained)) {
					if (rejectedCommitted) currentContext.messages.splice(rejectedIndex, 1);
					continue;
				}
			}

			// Escaped-non-ASCII tool arguments: bounded steered turn resample.
			//
			// Arguments that spell a printable non-ASCII character as `\uXXXX`
			// instead of literal UTF-8 are a wire-format defect. The payload parses
			// cleanly, but one mistyped nibble decodes to a different, equally valid
			// character, so it can never be verified or repaired after the fact.
			// Reporting it as a tool error spends the whole turn and writes the
			// literal escape syntax back into the context the model samples from
			// next. Drop the defective turn and re-request with a transient
			// steering instruction instead: models that escape deterministically
			// (rather than as a sampling accident) reproduce the identical defect
			// on a blind resample, so the retry names the defect without ever
			// committing the escape syntax — or the instruction — to durable
			// history. The per-call rejection in `executeToolCalls` stays as the
			// terminal answer once this budget is spent. Managed fallback reports the discarded attempt through the
			// typed `escaped_arguments_discarded` outcome so the session policy
			// owns a bounded same-model retry; the defect is never treated as
			// provider evidence, so the fallback chain never advances on it.
			//
			// The single bounded exception is the display-safe degrade: when
			// every escaped call in the turn corroborates its escaped scalars
			// against decoded non-ASCII text inside the tool's declared
			// display-only fields, a mistyped nibble can only change what the
			// user reads on screen. That turn skips the resample/discard chain
			// entirely — no managed retry is charged — executes the decoded
			// call, and warns once so the fire rate stays measurable.
			if (
				message.stopReason !== "error" &&
				message.stopReason !== "aborted" &&
				hasEscapedNonAsciiToolCall(message) &&
				allEscapedToolCallsDisplaySafe(message, currentContext.tools)
			) {
				// Display-safe degrade: execute the decoded arguments as-is and warn
				// once (shape-only, never names or payload). The turn is neither
				// resampled nor reported to the managed fallback policy.
				logger.warn("agent: executing a tool-call turn whose display-safe arguments were \\uXXXX-escaped", {
					mode: config.fallbackManaged ? "managed" : "in_loop",
					...escapedNonAsciiToolCallShape(message),
				});
			} else if (
				message.stopReason !== "error" &&
				message.stopReason !== "aborted" &&
				escapedNonAsciiResampleAttempt < MAX_ESCAPED_NONASCII_RESAMPLES &&
				!escapedToolTransaction?.committed &&
				hasEscapedNonAsciiToolCall(message)
			) {
				escapedNonAsciiResampleAttempt++;
				escapedToolTransaction?.discard();
				// The discard is invisible everywhere else: the defective turn never
				// reaches durable history, so nothing downstream can count how often
				// the defect fires or whether steering ever changes the spelling.
				// Shape-only (bounded count + retry state), never names or payload.
				const diagnosticShape = escapedNonAsciiToolCallShape(message);
				logger.debug(
					"agent: discarded a tool-call turn whose arguments were \\uXXXX-escaped",
					config.fallbackManaged
						? {
								mode: "managed",
								steeringAttached: recoveryAttempt?.kind === "escaped-nonascii",
								...diagnosticShape,
							}
						: {
								mode: "in_loop",
								resampleAttempt: escapedNonAsciiResampleAttempt,
								resampleBudget: MAX_ESCAPED_NONASCII_RESAMPLES,
								steeringAttached: recoveryAttempt?.kind === "escaped-nonascii",
								...diagnosticShape,
							},
				);
				stripUnicodeEscapeEvidence(message);
				// The defective turn was already committed to the context by the
				// streaming path. Remove that exact object rather than assuming it is
				// still the tail: callbacks may append user/system history while the
				// response settles, and none of that history belongs to this retry.
				removeCommittedAssistantMessage(currentContext.messages, message);
				// A managed invocation ends the run here and reports the discarded
				// attempt to the session's fallback policy through the typed
				// outcome below; the policy owns the same-model bounded retry and
				// only falls back once it declines. The wire defect is not provider
				// evidence, so the outcome deliberately carries no transport facts
				// and the fallback chain never advances on it. The policy's retry
				// continuation attaches transient steering on every bounded re-issue
				// instead of blindly re-requesting the same defective spelling.
				if (config.fallbackManaged) {
					transaction?.discard();
					currentContext.messages.splice(contextMessageCount);
					newMessages.splice(newMessageCount);
					await config.onManagedAttemptOutcome?.({
						type: "escaped_arguments_discarded",
						message,
						scope: transaction?.scope,
					});
					stream.end(newMessages);
					return;
				}
				// Steer the in-loop retry: name the defect in a transient synthetic
				// message so a deterministic escaper has a reason to change its
				// spelling. Never displace a different pending recovery (e.g. the
				// one-shot malformed-tool-call turn): its mode and one-shot
				// accounting must survive an escaped resample inside it.
				if (!pendingRecovery || pendingRecovery.kind === "escaped-nonascii") {
					pendingRecovery = { kind: "escaped-nonascii", inserted: false };
				}
				continue;
			}
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				stripUnicodeEscapeEvidence(message);
			}
			escapedNonAsciiResampleAttempt = 0;
			escapedNonAsciiToolChoiceCaptured = false;
			escapedNonAsciiToolChoice = undefined;

			const overflow = managedContextOverflow(message, config);
			if (config.fallbackManaged && overflow) {
				stripUnicodeEscapeEvidence(message);
				transaction?.discard();
				currentContext.messages.splice(contextMessageCount);
				newMessages.splice(newMessageCount);
				await config.onManagedAttemptOutcome?.(managedContextOverflowOutcome(message, transaction?.scope));
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
				await config.onManagedAttemptOutcome?.(managedFailureOutcome(message, transaction?.scope));
				stream.end(newMessages);
				return;
			}

			if (config.fallbackManaged && message.stopReason === "aborted") {
				transaction?.discard();
				currentContext.messages.splice(contextMessageCount);
				newMessages.splice(newMessageCount);
				await config.onManagedAttemptOutcome?.({
					type: "run_terminal",
					reason: "cancelled",
					scope: transaction?.scope,
				});
				stream.end(newMessages);
				return;
			}
			if (attemptTransaction) {
				message = managedAssistantShell(message, config.model, new Set<string>(), true);
				const index = currentContext.messages.length - 1;
				if (index >= 0 && currentContext.messages[index]?.role === "assistant") {
					currentContext.messages[index] = message;
				}
				newMessages[newMessages.length - 1] = message;
			}

			// One provider invocation is committed before any tool can run.
			if (escapedToolTransaction) {
				const acceptedMessage = escapedToolTransaction.acceptedAssistantSnapshot(message);
				const contextIndex = currentContext.messages.lastIndexOf(message);
				if (contextIndex >= 0) currentContext.messages[contextIndex] = acceptedMessage;
				const producedIndex = newMessages.lastIndexOf(message);
				if (producedIndex >= 0) newMessages[producedIndex] = acceptedMessage;
				message = acceptedMessage;
				escapedToolTransaction.flushNonTerminal();
				// Tool-call updates are staged so an escaped turn can disappear
				// atomically. Once accepted, drain every published update through the
				// Agent/AgentSession consumers before dispatch: streaming edit guards
				// can then abort the run before any tool execute() is entered.
				if (message.stopReason !== "aborted" && message.stopReason !== "error") {
					if (loopSignal.aborted) message.stopReason = "aborted";
					if (stream.hasActiveConsumer) await stream.waitForConsumerDrain(new AbortController().signal);
					if (loopSignal.aborted) message.stopReason = "aborted";
				}
				if (message.stopReason === "error" || message.stopReason === "aborted") {
					stripUnicodeEscapeEvidence(message);
				}
				escapedToolTransaction.replacePendingAssistantMessage(message);
				escapedToolTransaction.flush();
			} else {
				transaction?.flush();
			}
			if (config.fallbackManaged && message.stopReason !== "error" && message.stopReason !== "aborted") {
				await config.onManagedAttemptAccepted?.();
			}
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				stripUnicodeEscapeEvidence(message);
				// Create placeholder tool results for any tool calls in the aborted message
				// This maintains the tool_use/tool_result pairing that the API requires
				type ToolCallContent = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;
				const toolCalls = message.content.filter(
					(c): c is ToolCallContent => c.type === "toolCall" && !isCursorExecResolved(c),
				);
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
				stream.push({ type: "turn_end", message, toolResults, scope: attemptScope });
				publishAgentEnd(
					stream,
					config,
					buildAgentEndEvent(newMessages, telemetry, stepCounter.count, "completed", attemptScope),
					attemptScope,
				);
				stream.end(newMessages);
				return;
			}

			// Check for tool calls
			type ToolCallContent = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;
			const toolCalls = message.content.filter(
				(c): c is ToolCallContent => c.type === "toolCall" && !isCursorExecResolved(c),
			);
			hasMoreToolCalls = toolCalls.length > 0;

			const toolResults: ToolResultMessage[] = [];
			let repeatedMalformedToolCall = false;
			let sawComposerBashPolicyBlock = false;
			if (hasMoreToolCalls) {
				if (wasMalformedToolRecoveryAttempt) {
					for (const toolCall of toolCalls) {
						const result = createAbortedToolResult(
							toolCall,
							stream,
							"error",
							"Tool calls are disabled during repeated malformed tool-call recovery.",
						);
						currentContext.messages.push(result);
						newMessages.push(result);
						toolResults.push(result);
						recordSkippedTool(telemetry, {
							toolCallId: toolCall.id,
							toolName: toolCall.name,
							status: "skipped",
						});
					}
				} else {
					const executionResult = await executeToolCalls(
						currentContext,
						message,
						loopSignal,
						stream,
						config,
						telemetry,
						invokeAgentSpan,
						attemptScope,
					);

					toolResults.push(...executionResult.toolResults);
					steeringMessagesFromExecution = executionResult.steeringMessages;
					sawComposerBashPolicyBlock = executionResult.toolResults.some(isComposerBashPolicyBlockedToolResult);

					const malformedSignatures = executionResult.malformedToolCallSignatures;
					const allToolCallsMalformed =
						toolResults.length > 0 && malformedSignatures.length === toolResults.length;
					if (allToolCallsMalformed) {
						consecutiveMalformedTurns += 1;
						const uniqueMalformedSignatures = new Set(malformedSignatures);
						repeatedMalformedToolCall =
							uniqueMalformedSignatures.size < malformedSignatures.length ||
							[...uniqueMalformedSignatures].some(signature => previousMalformedToolSignatures.has(signature));
						previousMalformedToolSignatures = uniqueMalformedSignatures;
					} else {
						consecutiveMalformedTurns = 0;
						previousMalformedToolSignatures = new Set();
					}

					for (const result of toolResults) {
						currentContext.messages.push(result);
						newMessages.push(result);
					}
				}
			}

			if (recoveryAttempt) {
				pendingRecovery = undefined;
			}

			stream.push({ type: "turn_end", message, toolResults, scope: attemptScope });

			if (steeringMessagesFromExecution && steeringMessagesFromExecution.length > 0) {
				// Same aborted-run guard as the drain below: the steer interrupt unwound
				// the tools, and a user interrupt that landed during that unwind must not
				// open the steering turn on the aborted signal. Hand the messages back
				// and end the run so the resume path delivers them on a fresh one.
				if (!loopSignal.aborted) {
					pendingMessages = steeringMessagesFromExecution;
					continue;
				}
				config.requeueSteeringMessages?.(steeringMessagesFromExecution);
				break;
			}
			pendingMessages = (await config.getSteeringMessages?.()) || [];
			if (pendingMessages.length > 0) {
				// A user interrupt that lands while a tool is executing aborts this run's
				// signal without ending the loop: the tool unwinds and execution reaches
				// here. Continuing would open a turn on the aborted signal, which the
				// provider rejects before the first token — the steer would be consumed
				// and answered by nothing. Hand it back and end the run so the caller's
				// resume starts a fresh one, which is the path that already works when no
				// tool was in flight.
				if (!loopSignal.aborted) continue;
				config.requeueSteeringMessages?.(pendingMessages);
				break;
			}
			if (config.shouldPause?.()) {
				publishAgentEnd(
					stream,
					config,
					buildAgentEndEvent(newMessages, telemetry, stepCounter.count, "paused", attemptScope),
					attemptScope,
				);
				stream.end(newMessages);
				return;
			}
			if (sawComposerBashPolicyBlock && !composerBashPolicyRecoveryAttempted) {
				pendingRecovery = { kind: "composer-bash-policy", inserted: false };
				composerBashPolicyRecoveryAttempted = true;
			} else if (sawComposerBashPolicyBlock) {
				message.stopReason = "error";
				const recoveryLimitMessage =
					"Composer bash policy blocked repository file I/O again after its one automatic recovery turn. Continue with dedicated repository tools.";
				message.errorMessage = message.errorMessage
					? `${message.errorMessage} | ${recoveryLimitMessage}`
					: recoveryLimitMessage;
				publishAgentEnd(
					stream,
					config,
					buildAgentEndEvent(newMessages, telemetry, stepCounter.count, "completed", attemptScope),
					attemptScope,
				);
				stream.end(newMessages);
				return;
			} else if (repeatedMalformedToolCall && !malformedToolRecoveryAttempted) {
				pendingRecovery = { kind: "malformed-tool-call", inserted: false };
				malformedToolRecoveryAttempted = true;
			} else if (consecutiveMalformedTurns >= MAX_CONSECUTIVE_MALFORMED_TURNS) {
				// Deterministic terminal circuit breaker. The one-shot recovery turn
				// above already had its chance; if the model is still emitting only
				// malformed tool calls after it, the run cannot make progress and must
				// stop rather than burn the provider budget. Terminates on consecutive
				// count, not argument signatures, so rotating invalid shapes are bounded
				// too.
				message.stopReason = "error";
				const breakerMessage = `Stopping after ${consecutiveMalformedTurns} consecutive turns of malformed tool calls; the model did not produce a usable tool call or answer.`;
				message.errorMessage = message.errorMessage
					? `${message.errorMessage} | ${breakerMessage}`
					: breakerMessage;
				publishAgentEnd(
					stream,
					config,
					buildAgentEndEvent(newMessages, telemetry, stepCounter.count, "completed", attemptScope),
					attemptScope,
				);
				stream.end(newMessages);
				return;
			}
		}

		// Agent would stop here. Check for follow-up messages.
		await config.onBeforeYield?.();
		if (config.shouldPause?.()) {
			publishAgentEnd(
				stream,
				config,
				buildAgentEndEvent(newMessages, telemetry, stepCounter.count, "paused", lastAttemptScope),
				lastAttemptScope,
			);
			stream.end(newMessages);
			return;
		}
		// Poll the consume-on-read recovery candidate before follow-ups so a real
		// user message can supersede it without letting the stale recovery resurface
		// after that follow-up turn.
		const syntheticRecoveryMessage = await config.getSyntheticRecoveryMessage?.();
		const followUpMessages = (await config.getFollowUpMessages?.()) || [];
		if (followUpMessages.length > 0) {
			// Set as pending so inner loop processes them
			pendingMessages = followUpMessages;
			continue;
		}
		if (syntheticRecoveryMessage) {
			// Provider-side tool protocols (such as Cursor) can finish their remote
			// turn after a local policy rejection. Continue once without committing
			// the recovery instruction to durable history.
			pendingRecovery = { kind: "provider", inserted: true, syntheticMessage: syntheticRecoveryMessage };
			continue;
		}

		// No more messages, exit
		break;
	}

	publishAgentEnd(
		stream,
		config,
		buildAgentEndEvent(newMessages, telemetry, stepCounter.count, "completed", lastAttemptScope),
		lastAttemptScope,
	);
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
	scope?: AttemptScope,
	streamFn?: StreamFn,
	harmonyRetryAttempt = 0,
	recoveryMode?: {
		syntheticMessage: UserMessage;
		disableTools?: boolean;
		forceAutoToolChoice?: boolean;
	},
	provisionalToolTransaction?: ManagedAttemptTransaction,
	toolChoiceOverride?: { value: ToolChoice | undefined },
): Promise<AssistantMessage> {
	const managedDegradedFieldDiagnostics = new Set<string>();
	// Apply context transform if configured (AgentMessage[] → AgentMessage[])
	let messages = context.messages;
	// Revoke before invoking any caller-controlled transform so it cannot retain
	// a live authenticated object and restore its role for a later custom stream.
	expireProviderSafetyStopAuthority(messages);
	if (messages !== context.messages) expireProviderSafetyStopAuthority(context.messages);
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal, scope);
	}

	// Expire residual terminal safety-stop authority again after the transform:
	// committed history (including a previously adjudicated stop) is handed
	// to the stream through convertToLlm below, and a live mark would let a
	// custom stream re-use the authenticated object to forge a terminal
	// failure (#4777 review follow-up).
	expireProviderSafetyStopAuthority(messages);
	if (messages !== context.messages) expireProviderSafetyStopAuthority(context.messages);

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
	if (recoveryMode) {
		if (config.appendOnlyContext) {
			const syntheticMessages = normalizeMessagesForProvider(
				await config.convertToLlm([recoveryMode.syntheticMessage]),
				config.model,
			);
			llmContext = {
				...llmContext,
				messages: [...llmContext.messages, ...syntheticMessages],
				tools: recoveryMode.disableTools ? [] : llmContext.tools,
			};
		} else {
			llmContext = {
				...llmContext,
				messages: normalizeMessagesForProvider(
					await config.convertToLlm([...messages, recoveryMode.syntheticMessage]),
					config.model,
				),
				tools: recoveryMode.disableTools ? [] : llmContext.tools,
			};
		}
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

	// Synthetic recovery requests choose their tool mode explicitly below and
	// must never consume a queued dynamic choice intended for an ordinary turn.
	// An explicit toolChoiceOverride is the exception: it carries the already-
	// captured logical-turn choice for a steering resample of that same turn,
	// so replaying it never double-consumes the queue.
	const dynamicToolChoice = toolChoiceOverride
		? toolChoiceOverride.value
		: recoveryMode
			? undefined
			: config.getToolChoice?.();
	const dynamicReasoning = config.getReasoning?.();
	const harmonyMitigationEnabled = isHarmonyLeakMitigationTarget(config.model);
	const harmonyAbortController = harmonyMitigationEnabled ? new AbortController() : undefined;
	const requestSignals = [
		...(signal ? [signal] : []),
		...(config.resourceCancellationDomain ? [config.resourceCancellationDomain.signal] : []),
		...(harmonyAbortController ? [harmonyAbortController.signal] : []),
	];
	const requestSignal =
		requestSignals.length === 0
			? undefined
			: requestSignals.length === 1
				? requestSignals[0]
				: AbortSignal.any(requestSignals);
	const effectiveTemperature =
		harmonyRetryAttempt > 0 && config.temperature !== undefined ? config.temperature + 0.05 : config.temperature;
	const effectiveToolChoice = recoveryMode?.disableTools
		? "none"
		: recoveryMode?.forceAutoToolChoice
			? "auto"
			: (dynamicToolChoice ?? config.toolChoice);
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
	const captureOnResponse: AgentLoopConfig["onResponse"] = (response, modelInfo, scope) => {
		capturedHeaders = response.headers;
		return userOnResponse?.(response, modelInfo, scope);
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
			const providerReservation =
				config.resourceLedger && config.resourceRunId
					? config.resourceLedger.reserveProducer(
							config.resourceRunId,
							config.resourceCancellationDomain,
							"provider_factory",
							`${config.model.provider}/${config.model.id}`,
						)
					: undefined;
			if (providerReservation && !providerReservation.ok)
				throw new Error("Prompt resource ownership is unavailable");
			if (requestSignal?.aborted) {
				providerReservation?.ok && providerReservation.lease.closeDiscovery();
				const aborted = emitAbortedAssistantMessage(null, false, context, config, stream, scope);
				await finishChat(aborted);
				return aborted;
			}
			let responsePromise: Promise<Awaited<ReturnType<StreamFn>>>;
			try {
				responsePromise = Promise.resolve(
					streamFunction(config.model, llmContext, {
						...config,
						attemptScope: scope,
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
					}),
				);
			} catch (error) {
				providerReservation?.ok && providerReservation.lease.closeDiscovery();
				throw error;
			}
			const { promise: iteratorSettled, resolve: settleIterator } = Promise.withResolvers<void>();
			let responseResultPromise: Promise<AssistantMessage> | undefined;
			let responseForResult: { result(): Promise<AssistantMessage> } | undefined;
			const getResponseResult = (): Promise<AssistantMessage> =>
				(responseResultPromise ??= Promise.resolve().then(() => responseForResult!.result()));
			const providerLifecycle = responsePromise.then(async response => {
				responseForResult = response;
				await iteratorSettled;
				await Promise.allSettled([getResponseResult()]);
			});
			const closeLateFactoryResponse = (): void => {
				void responsePromise.then(
					response => {
						responseForResult = response;
						try {
							const iterator = response[Symbol.asyncIterator]();
							try {
								const returned = iterator.return?.();
								void Promise.resolve(returned).then(
									() => settleIterator(),
									() => settleIterator(),
								);
							} catch {
								settleIterator();
							}
						} catch {
							settleIterator();
						}
					},
					() => settleIterator(),
				);
			};
			if (providerReservation?.ok) {
				providerReservation.lease.track("provider_iterator", "provider-lifecycle", providerLifecycle);
				void providerLifecycle.then(
					() => providerReservation.lease.closeDiscovery(),
					() => providerReservation.lease.closeDiscovery(),
				);
			}
			let response: Awaited<typeof responsePromise>;
			if (requestSignal) {
				const { promise: factoryAbort, resolve: resolveFactoryAbort } = Promise.withResolvers<typeof ABORTED>();
				const onFactoryAbort = () => resolveFactoryAbort(ABORTED);
				requestSignal.addEventListener("abort", onFactoryAbort, { once: true });
				try {
					const responseOrAbort = await Promise.race([responsePromise, factoryAbort]);
					if (responseOrAbort === ABORTED) {
						const aborted = emitAbortedAssistantMessage(null, false, context, config, stream, scope);
						await finishChat(aborted);
						closeLateFactoryResponse();
						return aborted;
					}
					response = responseOrAbort;
				} finally {
					requestSignal.removeEventListener("abort", onFactoryAbort);
				}
			} else {
				response = await responsePromise;
			}
			responseForResult = response;

			let partialMessage: AssistantMessage | null = null;
			let addedPartial = false;

			const responseIterator = response[Symbol.asyncIterator]();
			let iteratorClosed = false;
			const closeIterator = (): void => {
				if (iteratorClosed) return;
				iteratorClosed = true;

				void Promise.resolve()
					.then(() => responseIterator.return?.())
					.then(
						() => settleIterator(),
						() => settleIterator(),
					);
			};
			const finishResponse = async (): Promise<AssistantMessage> => {
				closeIterator();
				await iteratorSettled;
				return getResponseResult();
			};

			// Set up a single abort race: register the abort listener once for the whole
			// stream and reuse the same race promise for every iterator.next() instead of
			// allocating Promise.withResolvers and add/removeEventListener per event.
			let abortRacePromise: Promise<typeof ABORTED> | undefined;
			let detachAbortListener: (() => void) | undefined;
			if (requestSignal) {
				if (requestSignal.aborted) {
					closeIterator();
					const aborted = emitAbortedAssistantMessage(
						partialMessage,
						addedPartial,
						context,
						config,
						stream,
						scope,
					);
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
							closeIterator();
							const aborted = emitAbortedAssistantMessage(
								partialMessage,
								addedPartial,
								context,
								config,
								stream,
								scope,
							);
							await finishChat(aborted);
							return aborted;
						}
						next = result;
					} else {
						next = await responseIterator.next();
					}
					if (requestSignal?.aborted) {
						const aborted = emitAbortedAssistantMessage(
							partialMessage,
							addedPartial,
							context,
							config,
							stream,
							scope,
						);
						await finishChat(aborted);
						return aborted;
					}
					if (next.done) {
						iteratorClosed = true;
						settleIterator();
						break;
					}

					const event = next.value;

					switch (event.type) {
						case "start":
							partialMessage = config.fallbackManaged
								? managedAssistantShell(event.partial, config.model, managedDegradedFieldDiagnostics)
								: event.partial;
							context.messages.push(partialMessage);
							addedPartial = true;
							if (provisionalToolTransaction) {
								config.onProvisionalAssistantMessageEvent?.(partialMessage, event);
							}
							stream.push({ type: "message_start", message: { ...partialMessage }, scope });
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
									? managedAssistantShell(event.partial, config.model, managedDegradedFieldDiagnostics)
									: event.partial;
								// Normalize through the managed event snapshot instead of a
								// naive `{ ...event }` spread: spreading copies only own
								// enumerable properties, so a payload-class event carrying its
								// fields on prototype getters would lose `type`/`delta` here and
								// deterministically fail the whole run as `event.unknownType`
								// downstream. The snapshot repairs benign class/prototype shapes
								// and keeps the named fail-fast diagnostics for hostile ones.
								const partialEvent = config.fallbackManaged
									? managedAssistantEventSnapshot(event, partialMessage, managedDegradedFieldDiagnostics)
									: event;
								context.messages[context.messages.length - 1] = partialMessage;
								if (provisionalToolTransaction) {
									config.onProvisionalAssistantMessageEvent?.(partialMessage, partialEvent);
									provisionalToolTransaction.stageAssistantMessageEvent(partialMessage, partialEvent);
								} else {
									config.onAssistantMessageEvent?.(partialMessage, partialEvent);
								}
								if (signal?.aborted) continue;
								stream.push({
									type: "message_update",
									assistantMessageEvent: partialEvent,
									message: { ...partialMessage },
									scope,
								});
								// Preserve ordinary text streaming. Once visible text is
								// published, this response can no longer be silently resampled;
								// a later escaped tool call therefore falls through to the
								// existing terminal per-call rejection instead.
								if (event.type === "text_start" || event.type === "text_delta" || event.type === "text_end") {
									provisionalToolTransaction?.commitCallbacksAndUpdates();
								}
							}
							break;

						case "done":
						case "error": {
							const finished = sanitizeProviderSafetyStopProvenance(await finishResponse(), config.model);
							const finalMessage = config.fallbackManaged
								? managedAssistantShell(finished, config.model, managedDegradedFieldDiagnostics, true)
								: finished;
							promoteTypedEmptyResponseStop(finalMessage);
							if (addedPartial) {
								context.messages[context.messages.length - 1] = finalMessage;
							} else {
								context.messages.push(finalMessage);
							}
							if (!addedPartial) {
								stream.push({ type: "message_start", message: { ...finalMessage }, scope });
							}
							stream.push({ type: "message_end", message: finalMessage, scope });
							await finishChat(finalMessage);
							return finalMessage;
						}
					}
				}
			} finally {
				detachAbortListener?.();
				closeIterator();
			}

			const finished = sanitizeProviderSafetyStopProvenance(await finishResponse(), config.model);
			const trailing = config.fallbackManaged
				? managedAssistantShell(finished, config.model, managedDegradedFieldDiagnostics, true)
				: finished;
			await finishChat(trailing);
			return trailing;
		});
	} catch (err) {
		failChatSpan(telemetry, chatSpan, {
			stepNumber: chatStepNumber,
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
	scope?: AttemptScope,
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
		stream.push({ type: "message_start", message: { ...abortedMessage }, scope });
	}
	stream.push({ type: "message_end", message: abortedMessage, scope });
	return abortedMessage;
}

/**
 * Model-visible call names of a tool. Tools emitted via OpenAI's custom-tool
 * path (e.g. `apply_patch` on GPT-5) arrive under their wire-level name, which
 * may differ from the harness-internal `name`, so dispatch and any "is this
 * tool callable" check must consider both.
 */
function toolCallNames(tool: { name: string; customWireName?: string }): string[] {
	return tool.customWireName === undefined || tool.customWireName === tool.name
		? [tool.name]
		: [tool.name, tool.customWireName];
}

/**
 * Wire name of the tool-discovery tool. Sessions that hide discoverable
 * built-ins expose it under exactly that name.
 */
const TOOL_DISCOVERY_NAME = "search_tool_bm25";

/**
 * Active tool a call name dispatches to.
 *
 * The rule itself lives with the dispatch-identity binding so execution and the identity
 * bound onto the emitted event can never diverge.
 */
function findActiveTool<T extends { name: string; customWireName?: string }>(
	tools: ReadonlyArray<T> | undefined,
	callName: string,
): T | undefined {
	return activeToolForCallName(tools, callName);
}

/**
 * Whether tool discovery is callable in this session. A namespaced lookalike
 * proves nothing: `mcp__srv__x_search_tool_bm25` reads equally well as a bridged
 * discovery tool and as that server's own `x_search_tool_bm25`, and the registry
 * cannot tell the two apart. Naming the wrong one sends the model at a tool it
 * never asked for, so only the literal call name counts.
 */
function isToolDiscoveryCallable(tools: ReadonlyArray<{ name: string; customWireName?: string }> | undefined): boolean {
	return (tools ?? []).some(tool => toolCallNames(tool).includes(TOOL_DISCOVERY_NAME));
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
	scope?: AttemptScope,
): Promise<{
	toolResults: ToolResultMessage[];
	steeringMessages?: AgentMessage[];
	malformedToolCallSignatures: string[];
}> {
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
	const toolCalls = assistantMessage.content.filter(
		(c): c is ToolCallContent => c.type === "toolCall" && !isCursorExecResolved(c),
	);
	const emittedToolResults: ToolResultMessage[] = [];
	const toolCallInfos = toolCalls.map(call => ({ id: call.id, name: call.name }));
	const batchId = `${assistantMessage.timestamp ?? Date.now()}_${toolCalls[0]?.id ?? "batch"}`;
	const shouldInterruptImmediately = interruptMode !== "wait";
	const steeringAbortController = new AbortController();
	const toolSignals = [
		...(signal ? [signal] : []),
		...(config.resourceCancellationDomain ? [config.resourceCancellationDomain.signal] : []),
		steeringAbortController.signal,
	];
	const toolSignal = toolSignals.length === 1 ? toolSignals[0] : AbortSignal.any(toolSignals);
	const interruptState = { triggered: false };
	let steeringMessages: AgentMessage[] | undefined;
	let steeringCheck: Promise<void> | null = null;

	const records = toolCalls.map(toolCall => {
		const metadata = acceptedToolCallMetadata.get(toolCall) ?? escapedToolCallMetadata(toolCall);
		return {
			toolCall: stripToolCallEvidence(toolCall),
			metadata,
			tool: findActiveTool(tools, toolCall.name),
			args: toolCall.arguments as Record<string, unknown>,
			eventFields: undefined as { toolCallId: string; toolName: string; intent: string | undefined } | undefined,
			started: false,
			result: undefined as AgentToolResult<any> | undefined,
			isError: false,
			skipped: false,
			toolResultMessage: undefined as ToolResultMessage | undefined,
			resultEmitted: false,
			argumentValidationFailed: false,
		};
	});
	const checkSteering = async (): Promise<void> => {
		// Never consume steering once the run's own signal is aborted: an aborted
		// run cannot deliver it (the loop hands drained steering back and ends), and
		// a tool task still unwinding can otherwise dequeue steering the drain just
		// requeued — orphaning it in an execution result nobody reads.
		if (!shouldInterruptImmediately || !getSteeringMessages || interruptState.triggered || signal?.aborted) {
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
		record.toolCall = stripToolCallEvidence(record.toolCall);
		const { toolCall } = record;
		const eventFields =
			record.eventFields ?? ({ toolCallId: toolCall.id, toolName: toolCall.name, intent: toolCall.intent } as const);
		// A call that was skipped or aborted before dispatch still owes the stream a
		// start/end PAIR, because every consumer downstream is built around results
		// arriving in pairs. Both halves are marked as what they are — pairing only — so a
		// consumer that publishes "this tool is running" can leave them out while relays,
		// history, and result handling keep seeing the same events they always did.
		const dispatched = record.started;
		if (!dispatched) {
			// No dispatch provenance is bound here. `record.tool` is the object this call
			// WOULD have run, and binding it would let a consumer resolve a canonical
			// built-in label for a tool whose `execute` was never entered.
			const startEvent: AgentEvent = {
				type: "tool_execution_start",
				toolCallId: eventFields.toolCallId,
				toolName: eventFields.toolName,
				args: record.args,
				intent: eventFields.intent,
				scope,
			};
			markNonDispatchedToolEvent(startEvent);
			stream.push(startEvent);
		}
		const endEvent: AgentEvent = {
			type: "tool_execution_end",
			toolCallId: eventFields.toolCallId,
			toolName: eventFields.toolName,
			result,
			isError,
			scope,
		};
		if (!dispatched) markNonDispatchedToolEvent(endEvent);
		stream.push(endEvent);

		const toolResultMessage: ToolResultMessage = {
			role: "toolResult",
			toolCallId: eventFields.toolCallId,
			toolName: eventFields.toolName,
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

		stream.push({ type: "message_start", message: toolResultMessage, scope });
		stream.push({ type: "message_end", message: toolResultMessage, scope });
	};
	const isInvalidEscapedRecord = (record: (typeof records)[number]): boolean => {
		const metadata = record.metadata;
		if (metadata.malformed) return true;
		if (!metadata.guarded) return false;
		return !(
			isDisplaySafeEscapedArguments(record.tool, record.args) &&
			isDisplaySafeRawEscapeEvidence(record.tool, record.args, metadata.evidence)
		);
	};
	const hasInvalidEscapedCall = records.some(isInvalidEscapedRecord);
	if (hasInvalidEscapedCall) {
		for (const record of records) {
			if (isInvalidEscapedRecord(record)) continue;
			record.skipped = true;
			record.toolCall = stripToolCallEvidence(record.toolCall);
			emitToolResult(record, createSkippedToolResult(), true);
		}
	}

	/**
	 * Prepare every value needed to publish and invoke one dispatch before claiming that it
	 * started. Once this returns, the path from a successful start publication to intrinsic
	 * invocation contains only trusted local bindings and values.
	 */
	const prepareToolDispatch = (
		record: (typeof records)[number],
		startArgs: Record<string, unknown>,
		executionArgs: Record<string, unknown>,
		executionSignal: AbortSignal | undefined,
		effectiveArgs: Record<string, unknown>,
		toolContext: AgentToolContext | undefined,
	): { startEvent: AgentEvent; invocationArguments: Parameters<AgentTool["execute"]> } => {
		const eventFields = {
			toolCallId: record.toolCall.id,
			toolName: record.toolCall.name,
			intent: record.toolCall.intent,
		};
		const startEvent: AgentEvent = {
			type: "tool_execution_start",
			toolCallId: eventFields.toolCallId,
			toolName: eventFields.toolName,
			args: startArgs,
			intent: eventFields.intent,
			scope,
		};
		// Retain the exact values the start/end/result pair must share. No later event in
		// this dispatch needs to re-read a stateful ToolCall property.
		record.eventFields = eventFields;
		bindDispatchedToolIdentity(startEvent, record.tool);
		const onUpdate: NonNullable<Parameters<AgentTool["execute"]>[3]> = partialResult => {
			stream.push({
				type: "tool_execution_update",
				toolCallId: eventFields.toolCallId,
				toolName: eventFields.toolName,
				args: effectiveArgs,
				partialResult: coerceToolResult(partialResult).result,
				scope,
			});
		};
		const invocationArguments = [
			eventFields.toolCallId,
			executionArgs,
			executionSignal,
			onUpdate,
			toolContext,
		] as Parameters<AgentTool["execute"]>;
		return { startEvent, invocationArguments };
	};

	/** Mark dispatch only after the fully prepared start was successfully published. */
	const publishToolDispatch = (record: (typeof records)[number], startEvent: AgentEvent): void => {
		stream.push(startEvent);
		record.started = true;
	};

	const runTool = async (record: (typeof records)[number], index: number): Promise<void> => {
		if (record.skipped || interruptState.triggered) {
			// Skip both span emission and the collector orphan record here. The
			// scheduler-task finalizer emits the skipped result and collector record;
			// the tail sweep below remains a defensive fallback for unexpected throws.
			record.skipped = true;
			return;
		}

		record.toolCall = stripToolCallEvidence(record.toolCall);
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
				const metadata = record.metadata;
				const escapedUnicodeArgumentEvidence = metadata.evidence;
				const escapedArgumentsGuarded = metadata.guarded;
				if (escapedArgumentsGuarded) record.toolCall = stripToolCallEvidence(record.toolCall);
				const incompleteArguments = metadata.malformed || metadata.incompleteArguments;
				if (incompleteArguments) {
					record.argumentValidationFailed = true;
					// The provider flagged this call's arguments as unsafe to execute.
					// The typed reason selects accurate recovery guidance; callers that
					// only read the boolean still get a safe, actionable rejection.
					const reason = metadata.incompleteArgumentsReason;
					const detail =
						reason === "malformed"
							? `The terminal arguments for tool call "${toolCall.name}" did not decode to a valid JSON object. The arguments cannot be executed. Re-issue the call with valid, complete arguments.`
							: reason === "conflicting"
								? `The streamed and terminal arguments for tool call "${toolCall.name}" disagree. The arguments cannot be executed safely. Re-issue the call with consistent arguments.`
								: reason === "ambiguous"
									? `The identity of tool call "${toolCall.name}" was ambiguous on the wire (duplicate call id or id/call_id collision), so its arguments cannot be safely attributed. Re-issue the call.`
									: `Tool call "${toolCall.name}" was cut off before its arguments finished streaming (the response hit its output token limit). The partial arguments cannot be executed. Re-issue the call with complete arguments, splitting the work into smaller steps if needed.`;
					throw new Error(detail);
				}
				const displaySafeEscapedArguments =
					escapedArgumentsGuarded &&
					isDisplaySafeEscapedArguments(tool, argsForExecution) &&
					isDisplaySafeRawEscapeEvidence(tool, argsForExecution, escapedUnicodeArgumentEvidence);
				if (escapedArgumentsGuarded && !displaySafeEscapedArguments) {
					record.argumentValidationFailed = true;
					// The arguments decoded cleanly, but they were spelled as `\uXXXX`
					// escapes rather than literal characters. Hand-written hex is where models
					// mistype digits, and every mistyped nibble decodes to a different but
					// equally valid character — the payload is unverifiable and cannot be
					// repaired after parsing, so it is rejected rather than executed on
					// silently corrupted text. The one bounded exception is a tool that
					// declared display-only argument fields (see
					// isDisplaySafeEscapedArguments): user-facing display text whose
					// escaped scalars all corroborate decoded non-ASCII characters
					// inside those fields. Missing, malformed, or ASCII-position
					// evidence rejects.
					//
					// Terminal for this call: the resample budget is already spent, so
					// log it (shape-only) to make the fire rate measurable without
					// scraping session transcripts.
					logger.debug("agent: rejected a tool call whose arguments were \\uXXXX-escaped", {
						mode: "in_loop",
						toolRegistered: tool !== undefined,
						displaySafeFieldsDeclared: isDisplaySafeEscapedTool(tool),
					});
					throw new Error(
						`Tool call "${toolCall.name}" spelled printable text as \\uXXXX escapes instead of literal UTF-8 characters. ` +
							`Escaped text cannot be verified — a single wrong hex digit silently becomes a different character — ` +
							`so the call was not executed. Re-issue it writing every printable character literally.`,
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
					// The call name is echoed verbatim and no other tool is named or
					// dispatched to: `mcp__<server>__<x>_<base>` reads equally well as a
					// stale bridge instance segment in front of `base` and as that
					// server's own two-segment `<x>_<base>`, and the registry only ever
					// proves the live name, never the one the model sent. Running or
					// naming that guess hits a tool the model never asked for, which is
					// worse than the dead end it would replace.
					const base = `Tool ${toolCall.name} not found`;
					throw new Error(
						isToolDiscoveryCallable(tools)
							? `${base}. If you are unsure whether this tool exists or how to use it, call \`${TOOL_DISCOVERY_NAME}\` to discover and activate the matching tool, then retry.`
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
						record.argumentValidationFailed = true;
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

				const baseToolContext = getToolContext
					? getToolContext({
							batchId,
							index,
							total: toolCalls.length,
							toolCalls: toolCallInfos,
						})
					: undefined;
				const toolContext = scope
					? (Object.assign(baseToolContext ?? {}, { attemptScope: scope }) as AgentToolContext)
					: baseToolContext;
				const executionArgs = transformToolCallArguments
					? transformToolCallArguments(effectiveArgs, toolCall.name)
					: effectiveArgs;
				const executionSignal = tool.nonAbortable ? undefined : toolSignal;
				const execute = tool.execute;
				if (typeof execute !== "function")
					throw new Error(`Tool ${toolCall.name} has no executable implementation`);
				const { startEvent, invocationArguments } = prepareToolDispatch(
					record,
					argsForExecution,
					executionArgs,
					executionSignal,
					effectiveArgs,
					toolContext,
				);
				// Preparation is complete. A successful publication is the only transition
				// that marks this record dispatched; intrinsic invocation then consumes locals.
				publishToolDispatch(record, startEvent);
				const execution = intrinsicReflectApply(execute, tool, invocationArguments);
				const rawResult = await execution;
				const coerced = coerceToolResult(rawResult);
				result = coerced.result;
				if (coerced.malformed || result.isError) isError = true;
			} catch (e) {
				caughtError = e;
				result = {
					content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
					details: toolFailureEnvelope(record.argumentValidationFailed ? "argument_validation" : "execution"),
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
		const reservation =
			config.resourceLedger && config.resourceRunId
				? config.resourceLedger.reserveProducer(
						config.resourceRunId,
						config.resourceCancellationDomain,
						"tool",
						`${record.toolCall.name}:${record.toolCall.id}`,
					)
				: undefined;
		if (reservation && !reservation.ok) {
			record.skipped = true;
			recordSkippedTool(telemetry, {
				toolCallId: record.toolCall.id,
				toolName: record.toolCall.name,
				status: "skipped",
			});
			emitToolResult(record, createSkippedToolResult(), true);
			continue;
		}
		const task = start
			.then(() => runTool(record, index))
			.finally(() => {
				if (!record.toolResultMessage) {
					record.skipped = true;
					recordSkippedTool(telemetry, {
						toolCallId: record.toolCall.id,
						toolName: record.toolCall.name,
						status: "skipped",
					});
					emitToolResult(record, createSkippedToolResult(), true);
				}
			});
		if (reservation?.ok) {
			reservation.lease.track("tool", `${record.toolCall.name}:${record.toolCall.id}`, task);
			void task.then(
				() => reservation.lease.closeDiscovery(),
				() => reservation.lease.closeDiscovery(),
			);
		}
		tasks.push(task);
		if (concurrency === "exclusive") {
			lastExclusive = task;
			sharedTasks = [];
		} else {
			sharedTasks.push(task);
		}
	}

	const allTasks = Promise.allSettled(tasks);
	if (!signal) {
		await allTasks;
	} else {
		const abortPromise = Promise.withResolvers<boolean>();
		const onAbort = () => abortPromise.resolve(true);
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			const aborted = signal.aborted || (await Promise.race([allTasks.then(() => false), abortPromise.promise]));
			if (aborted) {
				for (const record of records) {
					if (record.toolResultMessage) continue;
					record.skipped = true;
					emitToolResult(record, createAbortedToolExecutionResult(), true);
				}
			}
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	}

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

	const malformedToolCallSignatures = records.flatMap(record =>
		record.argumentValidationFailed && record.toolResultMessage?.isError
			? [`${record.toolCall.name}:${JSON.stringify(record.toolCall.arguments)}`]
			: [],
	);
	return { toolResults: emittedToolResults, steeringMessages, malformedToolCallSignatures };
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
	toolCall = stripToolCallEvidence(toolCall);
	const message = reason === "aborted" ? "Tool execution was aborted" : "Tool execution failed due to an error";
	const result: AgentToolResult<any> = {
		content: [{ type: "text", text: errorMessage ? `${message}: ${errorMessage}` : `${message}.` }],
		details: {},
	};

	// Nothing was dispatched for this call: the turn errored or was aborted before any
	// `Tool.execute` could be entered, and this pair exists only so the stream keeps
	// delivering results in start/end PAIRS. Both halves say so, and neither binds the
	// tool the call would have run, so a consumer that publishes "this tool is running"
	// can leave them out while relays, history, and result handling see what they always
	// did.
	const startEvent: AgentEvent = {
		type: "tool_execution_start",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		args: toolCall.arguments,
		intent: toolCall.intent,
	};
	markNonDispatchedToolEvent(startEvent);
	stream.push(startEvent);
	const endEvent: AgentEvent = {
		type: "tool_execution_end",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		result,
		isError: true,
	};
	markNonDispatchedToolEvent(endEvent);
	stream.push(endEvent);

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
function createAbortedToolExecutionResult(): AgentToolResult<any> {
	return {
		content: [{ type: "text", text: "Tool execution was aborted." }],
		details: {},
	};
}
