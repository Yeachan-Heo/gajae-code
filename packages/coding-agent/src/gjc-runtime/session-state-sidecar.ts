import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, verify } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AssistantMessage } from "@gajae-code/ai/core";
import {
	exactReplacePath,
	exactUnlinkDirect,
	type NativeExactFileIdentity,
	renameNoReplacePath,
} from "@gajae-code/natives";
import { normalizePathForComparison, postmortem } from "@gajae-code/utils";
import { withFileLock } from "../config/file-lock";
import {
	ensureCoordinatorDirectory,
	syncCoordinatorDirectory,
	syncCoordinatorFile,
	writeCoordinatorAtomic,
} from "../coordinator-mcp/durability";
import { reduceTerminalReceiptState } from "../sdk/receipt-state";
import { TOOL_CATALOG } from "../tools/tool-catalog.generated";
import { sessionRoot, sessionRuntimeDir } from "./session-layout";
import { SessionStateLockUnavailableError, withSessionStateFileLock } from "./session-state-lock";
import {
	isValidOwnerIntent,
	lifecyclePaths,
	type ObserveTerminalRequest,
	type OwnerIntent,
	type OwnerVerdict,
	observeOwnerTerminal,
	type TerminalSignal,
} from "./tmux-owner-isolation";

/** Managed tmux owner provenance propagated only to the launched child process. */
export const GJC_TMUX_OWNER_GENERATION_ENV = "GJC_TMUX_OWNER_GENERATION";
export const GJC_TMUX_OWNER_STATE_DIR_ENV = "GJC_TMUX_OWNER_STATE_DIR";
export const GJC_TMUX_OWNER_SERVER_KEY_ENV = "GJC_TMUX_OWNER_SERVER_KEY";
export const GJC_COORDINATOR_SESSION_STATE_FILE_ENV = "GJC_COORDINATOR_SESSION_STATE_FILE";
export const GJC_COORDINATOR_SESSION_ID_ENV = "GJC_COORDINATOR_SESSION_ID";
export const GJC_COORDINATOR_SESSION_BRANCH_ENV = "GJC_COORDINATOR_SESSION_BRANCH";
export const GJC_COORDINATOR_SESSION_LAUNCH_ID_ENV = "GJC_COORDINATOR_SESSION_LAUNCH_ID";
export const GJC_COORDINATOR_SESSION_READINESS_FILE_ENV = "GJC_COORDINATOR_SESSION_READINESS_FILE";
export const GJC_COORDINATOR_SIDECAR_SIGNING_KEY_ENV = "GJC_COORDINATOR_SIDECAR_SIGNING_KEY";
export const GJC_COORDINATOR_SIDECAR_BOOTSTRAP_URL_ENV = "GJC_COORDINATOR_SIDECAR_BOOTSTRAP_URL";
export const GJC_COORDINATOR_SIDECAR_KEY_ID_ENV = "GJC_COORDINATOR_SIDECAR_KEY_ID";
/** Explicitly binds this launch to Coordinator-minted sidecar signing authority. */
export const GJC_COORDINATOR_SIDECAR_SIGNATURE_REQUIRED_ENV = "GJC_COORDINATOR_SIDECAR_SIGNATURE_REQUIRED";

/**
 * Capture the bootstrap secret before runtime initialization can evaluate tools or spawn
 * children. The process environment is deliberately scrubbed synchronously even when the
 * key is malformed, so a rejected launch cannot leak it to descendants.
 */
const coordinatorSidecarSigningBootstrapUrl = process.env[GJC_COORDINATOR_SIDECAR_BOOTSTRAP_URL_ENV]?.trim();
const coordinatorSidecarSigningKeyBootstrap = await (async (): Promise<string | undefined> => {
	if (!coordinatorSidecarSigningBootstrapUrl) return process.env[GJC_COORDINATOR_SIDECAR_SIGNING_KEY_ENV];
	try {
		const response = await fetch(coordinatorSidecarSigningBootstrapUrl);
		if (!response.ok) return undefined;
		return (await response.text()).trim() || undefined;
	} catch {
		return undefined;
	}
})();
const coordinatorSidecarSigningKey = (() => {
	const encoded = coordinatorSidecarSigningKeyBootstrap;
	delete process.env[GJC_COORDINATOR_SIDECAR_SIGNING_KEY_ENV];
	delete process.env[GJC_COORDINATOR_SIDECAR_BOOTSTRAP_URL_ENV];
	if (!encoded) return null;
	try {
		return createPrivateKey({ key: Buffer.from(encoded, "base64"), format: "der", type: "pkcs8" });
	} catch {
		return null;
	}
})();

export function coordinatorSidecarSigningBootstrapEnv(): Record<string, string> {
	const keyId = process.env[GJC_COORDINATOR_SIDECAR_KEY_ID_ENV]?.trim();
	return coordinatorSidecarSigningKeyBootstrap && keyId && coordinatorSidecarSigningKey
		? {
				[GJC_COORDINATOR_SIDECAR_SIGNATURE_REQUIRED_ENV]: "true",
				[GJC_COORDINATOR_SIDECAR_SIGNING_KEY_ENV]: coordinatorSidecarSigningKeyBootstrap,
				[GJC_COORDINATOR_SIDECAR_KEY_ID_ENV]: keyId,
			}
		: {};
}

export function canonicalCoordinatorSidecarPayload(value: Record<string, unknown>): string {
	const canonicalize = (entry: unknown): unknown => {
		if (Array.isArray(entry)) return entry.map(canonicalize);
		if (entry && typeof entry === "object")
			return Object.fromEntries(
				Object.keys(entry)
					.sort()
					.map(key => [key, canonicalize((entry as Record<string, unknown>)[key])]),
			);
		return entry;
	};
	return JSON.stringify(canonicalize(value));
}

function finalizeSidecarPayload(payload: Record<string, unknown>, keyId: string | null): Record<string, unknown> {
	const unsigned = { ...payload };
	delete unsigned.sidecar_key_id;
	delete unsigned.sidecar_signature;
	if (!keyId) return unsigned;
	if (!coordinatorSidecarSigningKey) throw new PreviousRuntimeStateReadError();
	Object.assign(unsigned, { sidecar_key_id: keyId });
	const signedPayload = unsigned;
	return {
		...signedPayload,
		sidecar_signature: sign(
			null,
			Buffer.from(canonicalCoordinatorSidecarPayload(unsigned)),
			coordinatorSidecarSigningKey,
		).toString("base64"),
	};
}

export type RuntimeInputReadyMarker = Readonly<{
	schema_version: 1;
	session_id: string;
	launch_id: string;
	state: "ready_for_input";
	event: "interactive_input_ready";
	source: "gjc_interactive_runtime";
	ready_for_input: true;
	created_at: string;
}>;

const GJC_SESSION_PROMPT_ACCEPTED_JSON_ENV = "GJC_SESSION_PROMPT_ACCEPTED_JSON";
const GJC_SESSION_WORKTREE_BASELINE_DIRTY_ENV = "GJC_SESSION_WORKTREE_BASELINE_DIRTY";

export type RuntimeState = "ready_for_input" | "running" | "needs_user_input" | "completed" | "errored";

type FinalResponseSource = "agent_end" | "launch_error";
const MAX_PUBLIC_ERROR_MESSAGE_LENGTH = 2000;
const HEARTBEAT_MS = 1000;

/**
 * Bound on the PUBLIC tool-activity list persisted in the coordinator-shared state file.
 * The list is a "what is running right now" snapshot, not a log: an unbounded public list
 * would let a fan-out turn grow the payload every coordinator reader must parse.
 *
 * Only the public projection is capped. The private `in_flight` table is exact current
 * state — capping it would silently drop a live correlation and make `active_tool_count`
 * a lie — so it holds every currently in-flight call and is emptied by their own ends.
 */
const MAX_ACTIVE_TOOL_ENTRIES = 8;
/** Recorded whenever the caller could not prove a canonical public label for a tool. */
export const UNPROVEN_TOOL_LABEL = "custom";
/**
 * The closed vocabulary a persisted or published tool label may draw from: `custom`, or
 * the canonical name of a built-in tool descriptor.
 *
 * A pattern test is not a safety property — `cat`, `curl`, or any other token-shaped
 * string passes one — so an arbitrary label is never accepted merely because it looks
 * safe. Platform-excluded descriptors are included so a snapshot written on one host
 * stays readable on another; the writer still only ever produces labels for the tools it
 * actually resolved.
 */
const RUNTIME_TOOL_LABELS: ReadonlySet<string> = new Set([UNPROVEN_TOOL_LABEL, ...Object.keys(TOOL_CATALOG)]);

const stateFileWriteChains = new Map<string, Promise<void>>();

/** Test-only counters for runtime sidecar hot-path assertions. */
export const __sessionStateSidecarPerfCounters = {
	persistFromEventCalls: 0,
	reset(): void {
		this.persistFromEventCalls = 0;
	},
};

/** Test-only barriers for deterministic rescope transaction race coverage. */
export const __sessionStateSidecarTestHooks: {
	afterRescopeLocksAcquired?: () => void | Promise<void>;
	beforeRescopeJournalWrite?: (cwd: string) => void | Promise<void>;
	beforePersistFromEvent?: (eventType: string, cwd: string) => void | Promise<void>;
	beforeRescopePublish?: () => void | Promise<void>;
} = {};

interface RuntimeStateEvent {
	type: string;
	messages?: unknown[];
	toolCallId?: unknown;
	isError?: unknown;
}

export type RuntimeToolActivityPhase = "started" | "finished";
/**
 * A finished call's outcome. `cancelled` is the only honest answer for a call that was
 * still in flight when the session settled: it neither succeeded nor failed, and nothing
 * observed its end.
 */
export type RuntimeToolActivityOutcome = "success" | "failure" | "cancelled";
const RUNTIME_TOOL_ACTIVITY_OUTCOMES: readonly RuntimeToolActivityOutcome[] = ["success", "failure", "cancelled"];
/** Full SHA-256 hex: a prefix would let distinct calls collide into one correlation slot. */
const TOOL_CALL_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/**
 * What a session is doing right now, split into a bounded public projection and the
 * minimum private state needed to keep that projection exact.
 *
 * Deliberately carries no tool arguments, results, command text, paths, output, prompt or
 * model text, environment values, or credentials — only a proven public tool label, a
 * phase, and timing.
 */
export interface RuntimeToolActivity {
	seq: number;
	last_activity_at: string;
	tool: string;
	phase: RuntimeToolActivityPhase;
	outcome: RuntimeToolActivityOutcome | null;
	elapsed_ms: number | null;
	/** Exact number of in-flight calls; derived with `active_tools`, so it can never be smaller. */
	active_tool_count: number;
	/** Public projection of the newest in-flight calls, capped at `MAX_ACTIVE_TOOL_ENTRIES`. */
	active_tools: Array<{ tool: string; started_at: string }>;
	/**
	 * Private exact correlation state. Each digest is one-way over the session id and the
	 * tool call id, so no raw call id is persisted, and the whole field is stripped by
	 * `publicRuntimeToolActivity` before any coordinator reader sees the snapshot.
	 */
	in_flight: Array<{ digest: string; tool: string; started_at: string }>;
}

/**
 * Collapses anything the caller could not prove into `custom`.
 *
 * Public safety comes from the caller's proof plus this closed vocabulary, never from a
 * syntax check: a label that merely looks like a token is still model-influenced text.
 */
export function safeRuntimeToolLabel(value: unknown): string {
	return typeof value === "string" && RUNTIME_TOOL_LABELS.has(value) ? value : UNPROVEN_TOOL_LABEL;
}

/**
 * Whether a label read back from disk is already one this writer could have produced.
 * Persisted text is never normalized into `custom`: silently rewriting arbitrary disk
 * content into a valid-looking label would publish a value nothing ever proved.
 */
function isSafeRuntimeToolLabel(value: unknown): value is string {
	return typeof value === "string" && RUNTIME_TOOL_LABELS.has(value);
}

/** Exact own-key sets. An unknown key means the row was written by something else. */
const RUNTIME_TOOL_ACTIVITY_KEYS: readonly string[] = [
	"seq",
	"last_activity_at",
	"tool",
	"phase",
	"outcome",
	"elapsed_ms",
	"active_tool_count",
	"active_tools",
	"in_flight",
];
const IN_FLIGHT_TOOL_CALL_KEYS: readonly string[] = ["digest", "tool", "started_at"];
const ACTIVE_TOOL_KEYS: readonly string[] = ["tool", "started_at"];

/**
 * An object read back from disk must carry EXACTLY the keys this writer emits.
 *
 * Tolerating extra keys would let a hand-edited or foreign writer smuggle `args`,
 * `result`, `raw_id`, or a credential through every projection: the validator would
 * ignore them and the reader would still see them in the file. Unknown keys make the
 * whole activity malformed instead.
 */
function hasExactOwnKeys(value: object, keys: readonly string[]): boolean {
	const own = Object.keys(value);
	return own.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

/** A timestamp is accepted only in the exact canonical form this writer emits. */
function isCanonicalIsoTimestamp(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0) return false;
	const parsed = new Date(value);
	return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

export function toolActivityPhaseForEvent(event: RuntimeStateEvent): RuntimeToolActivityPhase | null {
	if (event.type === "tool_execution_start") return "started";
	if (event.type === "tool_execution_end") return "finished";
	return null;
}

/**
 * Length-delimited UTF-16 code units of one identity field.
 *
 * JavaScript strings are UTF-16 code-unit sequences, and a call id may legitimately be
 * any of them. Hashing the default UTF-8 encoding would map every distinct LONE
 * SURROGATE to the same replacement character, so two different call ids would produce
 * one digest and collide into a single in-flight correlation slot. Every code unit is
 * hashed exactly, big-endian, behind its own uint32 length so no concatenation of two
 * fields can be reinterpreted as a different pair.
 */
function utf16IdentityField(value: string): Uint8Array {
	const bytes = new Uint8Array(4 + value.length * 2);
	const view = new DataView(bytes.buffer);
	view.setUint32(0, value.length, false);
	for (let index = 0; index < value.length; index++) view.setUint16(4 + index * 2, value.charCodeAt(index), false);
	return bytes;
}

function toolCallDigest(sessionId: string, toolCallId: unknown): string | null {
	// An all-whitespace id carries no correlation, but a non-empty one is hashed over its
	// exact code units: trimming first would collapse ` a` and `a ` into one in-flight slot.
	if (typeof toolCallId !== "string" || toolCallId.trim().length === 0) return null;
	return createHash("sha256")
		.update(utf16IdentityField(sessionId))
		.update(utf16IdentityField(toolCallId))
		.digest("hex");
}

function validInFlightToolCall(value: unknown): value is RuntimeToolActivity["in_flight"][number] {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	if (!hasExactOwnKeys(value, IN_FLIGHT_TOOL_CALL_KEYS)) return false;
	const entry = value as Record<string, unknown>;
	return (
		typeof entry.digest === "string" &&
		TOOL_CALL_DIGEST_PATTERN.test(entry.digest) &&
		isSafeRuntimeToolLabel(entry.tool) &&
		isCanonicalIsoTimestamp(entry.started_at)
	);
}

function validPublicActiveTool(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	if (!hasExactOwnKeys(value, ACTIVE_TOOL_KEYS)) return false;
	const entry = value as Record<string, unknown>;
	return isSafeRuntimeToolLabel(entry.tool) && isCanonicalIsoTimestamp(entry.started_at);
}

/** The count and the capped list are always derived together, so they cannot contradict. */
function projectedActiveTools(
	inFlight: RuntimeToolActivity["in_flight"],
): Pick<RuntimeToolActivity, "active_tool_count" | "active_tools"> {
	return {
		active_tool_count: inFlight.length,
		// Newest wins on overflow: the snapshot answers "what is running now".
		active_tools: inFlight
			.slice(-MAX_ACTIVE_TOOL_ENTRIES)
			.map(entry => ({ tool: entry.tool, started_at: entry.started_at })),
	};
}

export type RuntimeToolActivityReadout =
	| { kind: "absent" }
	| { kind: "malformed" }
	| { kind: "valid"; activity: RuntimeToolActivity };

/**
 * Re-validates an activity snapshot read back from disk.
 *
 * `absent` and `malformed` are deliberately distinct outcomes: an absent snapshot may be
 * seeded from sequence 1, while a malformed one must never be replaced by a lower
 * sequence. The public counters are re-derived from the private in-flight table rather
 * than trusted from disk, so a hand-edited file cannot publish a contradiction.
 */
export function classifyRuntimeToolActivity(value: unknown): RuntimeToolActivityReadout {
	if (value === undefined) return { kind: "absent" };
	if (!value || typeof value !== "object" || Array.isArray(value)) return { kind: "malformed" };
	if (!hasExactOwnKeys(value, RUNTIME_TOOL_ACTIVITY_KEYS)) return { kind: "malformed" };
	const activity = value as Record<string, unknown>;
	if (typeof activity.seq !== "number" || !Number.isSafeInteger(activity.seq) || activity.seq < 1)
		return { kind: "malformed" };
	if (!isCanonicalIsoTimestamp(activity.last_activity_at)) return { kind: "malformed" };
	if (!isSafeRuntimeToolLabel(activity.tool)) return { kind: "malformed" };
	if (activity.phase !== "started" && activity.phase !== "finished") return { kind: "malformed" };
	// A started call has not finished, so it can carry neither an outcome nor a duration.
	// A finished one must name an allowlisted outcome, and only a matched success/failure
	// may carry a duration: an unmatched or cancelled call has no measured interval.
	if (activity.phase === "started") {
		if (activity.outcome !== null || activity.elapsed_ms !== null) return { kind: "malformed" };
	} else {
		if (!RUNTIME_TOOL_ACTIVITY_OUTCOMES.includes(activity.outcome as RuntimeToolActivityOutcome))
			return { kind: "malformed" };
		if (activity.elapsed_ms !== null) {
			if (activity.outcome === "cancelled") return { kind: "malformed" };
			// A duration is milliseconds of wall clock. Beyond the safe-integer range it is
			// no longer an exact value, so it can never be one this writer measured.
			if (
				typeof activity.elapsed_ms !== "number" ||
				!Number.isSafeInteger(activity.elapsed_ms) ||
				activity.elapsed_ms < 0
			)
				return { kind: "malformed" };
		}
	}
	// One invalid private row makes the whole snapshot malformed. Filtering rows and
	// continuing would publish an exact-looking count derived from a file that was
	// already corrupt.
	if (!Array.isArray(activity.in_flight) || !activity.in_flight.every(validInFlightToolCall))
		return { kind: "malformed" };
	// The public rows are validated in their own right, not merely re-derived: an extra
	// key on a public row is exactly what a coordinator reader would receive.
	if (!Array.isArray(activity.active_tools) || !activity.active_tools.every(validPublicActiveTool))
		return { kind: "malformed" };
	const inFlight = (activity.in_flight as RuntimeToolActivity["in_flight"]).map(entry => ({
		digest: entry.digest,
		tool: entry.tool,
		started_at: entry.started_at,
	}));
	if (new Set(inFlight.map(entry => entry.digest)).size !== inFlight.length) return { kind: "malformed" };
	// A cancelled outcome is terminal settlement: it is only ever written together with an
	// emptied in-flight set, so a cancelled snapshot that still claims live calls was not
	// produced here.
	if (activity.outcome === "cancelled" && inFlight.length > 0) return { kind: "malformed" };
	// The persisted public counters must already equal the projection of the private set;
	// repairing a contradiction here would republish a hand-edited file as authoritative.
	const projected = projectedActiveTools(inFlight);
	if (
		activity.active_tool_count !== projected.active_tool_count ||
		JSON.stringify(activity.active_tools) !== JSON.stringify(projected.active_tools)
	)
		return { kind: "malformed" };
	return {
		kind: "valid",
		activity: {
			seq: activity.seq,
			last_activity_at: activity.last_activity_at,
			tool: activity.tool,
			phase: activity.phase,
			outcome: (activity.outcome as RuntimeToolActivityOutcome | null) ?? null,
			elapsed_ms: activity.elapsed_ms as number | null,
			...projected,
			in_flight: inFlight,
		},
	};
}

export function normalizedRuntimeToolActivity(value: unknown): RuntimeToolActivity | null {
	const readout = classifyRuntimeToolActivity(value);
	return readout.kind === "valid" ? readout.activity : null;
}

/** The lifecycle states that are authority that nothing can still be running. */
const TERMINAL_LIFECYCLE_STATES: ReadonlySet<string> = new Set(["completed", "errored"]);

/**
 * Whether an individually valid snapshot is consistent with the lifecycle state it would
 * be published NEXT TO.
 *
 * The two fields are written by different authorities — the runtime sidecar annotates
 * activity, the Coordinator writes lifecycle — so each can be valid while the pair is a
 * contradiction: a settled session that still claims a tool is starting, or a live one
 * whose calls were cancelled by a terminal it never reached. Publishing either would tell
 * a coordinator reader something no writer ever observed.
 *
 * A terminal snapshot may still describe the call that just ended, and the terminal
 * `cancelled` shape is exactly how settlement reports orphaned calls, so both stay
 * publishable.
 */
function activityMatchesLifecycle(activity: RuntimeToolActivity, lifecycleState: unknown): boolean {
	if (typeof lifecycleState === "string" && TERMINAL_LIFECYCLE_STATES.has(lifecycleState)) {
		if (activity.phase === "started") return false;
		return activity.in_flight.length === 0 && activity.active_tool_count === 0;
	}
	return activity.outcome !== "cancelled";
}

/**
 * The only activity shape a coordinator reader may see: the private correlation digests
 * are dropped here, so no projection can leak them, and a snapshot that contradicts the
 * lifecycle state it accompanies is withheld entirely.
 *
 * Withheld, never repaired: the bytes on disk are preserved exactly as written — a
 * malformed or contradictory snapshot is evidence — while every public projection shows
 * nothing rather than a reconciled guess.
 */
export function publicRuntimeToolActivity(value: unknown, lifecycleState: unknown): Record<string, unknown> | null {
	const activity = normalizedRuntimeToolActivity(value);
	if (!activity || !activityMatchesLifecycle(activity, lifecycleState)) return null;
	return {
		seq: activity.seq,
		last_activity_at: activity.last_activity_at,
		tool: activity.tool,
		phase: activity.phase,
		outcome: activity.outcome,
		elapsed_ms: activity.elapsed_ms,
		active_tool_count: activity.active_tool_count,
		active_tools: activity.active_tools,
	};
}

/**
 * What the caller observed at the exact moment the agent event was dispatched.
 *
 * Both the timestamp and the label are captured at that synchronous boundary, never
 * re-derived here: a later lookup would see a tool registry that may already have been
 * replaced, and a later clock reading would fold subscriber and lock latency into the
 * measured interval.
 */
export interface CoordinatorToolObservation {
	/** Canonical public label proven at the observation boundary; anything else is `custom`. */
	label: string;
	/** Wall clock captured when the agent event was observed, before any queueing or lock wait. */
	observedAt: string;
}

interface RuntimeToolObservation {
	phase: RuntimeToolActivityPhase;
	/** Canonical public label proven by the caller; anything else records `custom`. */
	label: string | undefined;
	/** One-way correlation digest, or null when the event carried no usable call id. */
	digest: string | null;
	isError: boolean;
	/** Wall clock captured when the event was observed, before any queueing or lock wait. */
	observedAt: string;
}

function nextInFlightToolCalls(
	previous: RuntimeToolActivity["in_flight"],
	observation: RuntimeToolObservation,
	tool: string,
): RuntimeToolActivity["in_flight"] {
	// An event without a usable call id cannot be correlated, so it must neither add nor
	// remove exact accounting state.
	if (observation.digest === null) return previous;
	if (observation.phase === "started") {
		// A valid start is idempotent by digest, and a repeat keeps the first observation.
		if (previous.some(entry => entry.digest === observation.digest)) return previous;
		// Never capped: every live correlation is kept so the count stays exact.
		return [...previous, { digest: observation.digest, tool, started_at: observation.observedAt }];
	}
	// Only a confirmed active call is closed; a duplicate or unmatched end changes nothing.
	const index = previous.findIndex(entry => entry.digest === observation.digest);
	if (index < 0) return previous;
	return previous.filter((_entry, position) => position !== index);
}

/** Sequence is monotonic; at the safe-integer ceiling it stops rather than wrapping. */
function nextRuntimeToolActivitySeq(previous: number): number {
	return Number.isSafeInteger(previous + 1) ? previous + 1 : previous;
}

/**
 * Milliseconds between two observed events, or `null` when there is no exact answer.
 *
 * The reader accepts only a non-negative safe integer, because past that a millisecond
 * count is no longer an exact value and so cannot be one anything measured. The writer
 * therefore has to reach the same verdict on the same rule, or it can persist a number its
 * own validator calls malformed — and a malformed snapshot fences out every later activity
 * write on that session.
 *
 * Two canonical timestamps really can be that far apart: the representable `Date` range
 * spans 1.728e16 ms, nearly twice `MAX_SAFE_INTEGER`. Saturating at the ceiling would
 * publish a duration nothing observed, so an unmeasurable interval is reported as exactly
 * that — the outcome still stands, only the interval is absent.
 */
function measuredElapsedMs(startedAtMs: number, observedAtMs: number): number | null {
	if (!Number.isFinite(startedAtMs) || !Number.isFinite(observedAtMs)) return null;
	const elapsed = Math.round(observedAtMs - startedAtMs);
	return Number.isSafeInteger(elapsed) && elapsed >= 0 ? elapsed : null;
}

function nextRuntimeToolActivity(
	previous: RuntimeToolActivity | null,
	observation: RuntimeToolObservation,
): RuntimeToolActivity {
	const priorInFlight = previous?.in_flight ?? [];
	const match =
		observation.phase === "finished" && observation.digest !== null
			? priorInFlight.find(entry => entry.digest === observation.digest)
			: undefined;
	// A matched end reports the label its own START proved. Re-labelling from the end
	// event would read a registry that may have been replaced mid-call, so one call could
	// open as `bash` and close as something else. An unmatched end proved nothing.
	const tool = match ? match.tool : safeRuntimeToolLabel(observation.label);
	const startedAtMs = match ? Date.parse(match.started_at) : Number.NaN;
	const inFlight = nextInFlightToolCalls(priorInFlight, observation, tool);
	return {
		seq: nextRuntimeToolActivitySeq(previous?.seq ?? 0),
		last_activity_at: observation.observedAt,
		tool,
		phase: observation.phase,
		outcome: observation.phase === "started" ? null : observation.isError ? "failure" : "success",
		// Both ends are event observation times, so lock contention cannot compress a real
		// interval into near zero.
		elapsed_ms: measuredElapsedMs(startedAtMs, Date.parse(observation.observedAt)),
		...projectedActiveTools(inFlight),
		in_flight: inFlight,
	};
}

/**
 * Settle the activity snapshot a terminal lifecycle transition inherits.
 *
 * A settled session cannot still be running a tool, and later tool events are fenced out,
 * so an unmatched start would otherwise leave a nonzero `active_tool_count` forever. The
 * orphans are represented honestly — finished, `cancelled`, no elapsed interval — rather
 * than claimed as a success or a failure nothing observed.
 *
 * The same helper serves the runtime `agent_end`/postmortem path and the Coordinator's
 * canonical terminal repair so the two writers cannot settle differently.
 *
 * Two shapes need settling, not one. An orphaned in-flight call is the obvious case. The
 * other is a `phase: started` snapshot with NOTHING correlated — a start whose call id was
 * missing or blank never entered the in-flight table, so no end can ever close it — and
 * leaving it would write the prohibited terminal+started pair, a settled session that
 * still claims a tool is starting. An already-finished snapshot with nothing in flight is
 * returned unchanged: a normal terminal transition is not an activity event.
 */
export function terminallySettledRuntimeToolActivity(value: unknown, observedAt: string): RuntimeToolActivityReadout {
	const readout = classifyRuntimeToolActivity(value);
	if (readout.kind !== "valid") return readout;
	const previous = readout.activity;
	if (previous.in_flight.length === 0 && previous.phase !== "started") return readout;
	const previousMs = Date.parse(previous.last_activity_at);
	const observedMs = Date.parse(observedAt);
	// Terminal authority wins even at the sequence ceiling, where seq stays put; the
	// last-observation timestamp never moves backwards.
	const lastActivityAt =
		isCanonicalIsoTimestamp(observedAt) && (!Number.isFinite(previousMs) || observedMs >= previousMs)
			? observedAt
			: previous.last_activity_at;
	return {
		kind: "valid",
		activity: {
			seq: nextRuntimeToolActivitySeq(previous.seq),
			last_activity_at: lastActivityAt,
			tool: previous.tool,
			phase: "finished",
			outcome: "cancelled",
			elapsed_ms: null,
			...projectedActiveTools([]),
			in_flight: [],
		},
	};
}

export interface OwnerTerminalContext {
	generation: string;
	stateDir: string;
	socketKey: string;
	scope?: string | null;
	ownerPid?: number | null;
	ownerName?: string | null;
	operatorDispatchId?: string | null;
	operatorIntentId?: string | null;
}

export interface RuntimeStateContext {
	sessionId: string;
	cwd: string;
	sessionFile?: string | null;
	/** Optional platform seam for deterministic cross-platform path identity checks. */
	platform?: NodeJS.Platform;
	branch?: string | null;
	/** Public-safe owner metadata used to persist the canonical terminal verdict. */
	ownerTerminal?: OwnerTerminalContext | null;
	/** Internal fail-closed marker set only when managed owner metadata is malformed or missing. */
	ownerTerminalMetadataInvalid?: boolean;
	/**
	 * The session file as it was BEFORE a committed rescope, used only by
	 * {@link relocateCoordinatorRuntimeStateForRescope} to authenticate the predecessor
	 * payload against its old identity. Absent outside a move.
	 */
	previousSessionFile?: string | null;
}

interface RuntimeStateIdentity {
	sessionId: string;
	cwd: string;
	workdir: string;
	sessionFile: string | null;
	platform: NodeJS.Platform;
	sidecarKeyId: string | null;
}

interface RuntimeStateSidecarPayload {
	schema_version?: unknown;
	session_id?: unknown;
	state?: unknown;
	ready_for_input?: unknown;
	cwd?: unknown;
	workdir?: unknown;
	session_file?: unknown;
	final_response?: { source?: unknown };
	sidecar_key_id?: unknown;
	sidecar_signature?: unknown;
}

export type TerminalRuntimeStateStatus =
	| { terminal: true; state: "completed" | "errored" }
	| {
			terminal: false;
			reason:
				| "missing_state_file"
				| "invalid_json"
				| "invalid_state_marker"
				| "session_id_mismatch"
				| "cwd_mismatch"
				| "session_file_mismatch"
				| "non_terminal_state";
	  };

function runtimeReadinessMarkerConflict(): Error {
	const error = new Error("runtime_readiness_marker_conflict");
	Object.assign(error, { code: "runtime_readiness_marker_conflict" });
	return error;
}

function isRuntimeInputReadyMarker(value: unknown): value is RuntimeInputReadyMarker {
	if (!value || typeof value !== "object") return false;
	const marker = value as Record<string, unknown>;
	return (
		marker.schema_version === 1 &&
		typeof marker.session_id === "string" &&
		typeof marker.launch_id === "string" &&
		marker.state === "ready_for_input" &&
		marker.event === "interactive_input_ready" &&
		marker.source === "gjc_interactive_runtime" &&
		marker.ready_for_input === true &&
		typeof marker.created_at === "string" &&
		marker.created_at.length > 0 &&
		Number.isFinite(Date.parse(marker.created_at))
	);
}

function immutableRuntimeInputReadyMarker(marker: RuntimeInputReadyMarker): RuntimeInputReadyMarker {
	return Object.freeze({ ...marker });
}

async function readRuntimeInputReadyMarker(readinessFile: string): Promise<RuntimeInputReadyMarker | null> {
	let text: string;
	try {
		text = await Bun.file(readinessFile).text();
	} catch (error) {
		const code = (error as { code?: unknown }).code;
		if (code === "ENOENT" || code === "ENOTDIR") return null;
		throw runtimeReadinessMarkerConflict();
	}
	try {
		const marker = JSON.parse(text) as unknown;
		if (!isRuntimeInputReadyMarker(marker)) throw runtimeReadinessMarkerConflict();
		return immutableRuntimeInputReadyMarker(marker);
	} catch (error) {
		if ((error as { code?: unknown }).code === "runtime_readiness_marker_conflict") throw error;
		throw runtimeReadinessMarkerConflict();
	}
}

export async function persistCoordinatorRuntimeInputReady(): Promise<RuntimeInputReadyMarker | null> {
	const stateFile = process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV]?.trim();
	const sessionId = process.env[GJC_COORDINATOR_SESSION_ID_ENV]?.trim();
	const launchId = process.env[GJC_COORDINATOR_SESSION_LAUNCH_ID_ENV]?.trim();
	const readinessFile = process.env[GJC_COORDINATOR_SESSION_READINESS_FILE_ENV]?.trim();
	if (!stateFile || !sessionId || !launchId || !readinessFile) return null;

	const expected = { sessionId, launchId };
	const existing = await readRuntimeInputReadyMarker(readinessFile);
	if (existing) {
		if (existing.session_id !== expected.sessionId || existing.launch_id !== expected.launchId) {
			throw runtimeReadinessMarkerConflict();
		}
		await syncCoordinatorDirectory(path.dirname(readinessFile));
		return existing;
	}

	const marker = immutableRuntimeInputReadyMarker({
		schema_version: 1,
		session_id: expected.sessionId,
		launch_id: expected.launchId,
		state: "ready_for_input",
		event: "interactive_input_ready",
		source: "gjc_interactive_runtime",
		ready_for_input: true,
		created_at: new Date().toISOString(),
	});
	const tempFile = path.join(
		path.dirname(readinessFile),
		`.${path.basename(readinessFile)}.${process.pid}.${randomUUID()}.tmp`,
	);
	let result: RuntimeInputReadyMarker | null = null;
	let primaryError: unknown;
	try {
		await ensureCoordinatorDirectory(path.dirname(readinessFile));
		const handle = await fs.open(tempFile, "wx", 0o600);
		let writeError: unknown;
		try {
			await handle.writeFile(`${JSON.stringify(marker)}\n`);
			await syncCoordinatorFile(handle);
		} catch (error) {
			writeError = error;
		}
		try {
			await handle.close();
		} catch (closeError) {
			if (writeError) throw new AggregateError([writeError, closeError], "readiness write and close failed");
			throw closeError;
		}
		if (writeError) throw writeError;
		try {
			await fs.link(tempFile, readinessFile);
		} catch (error) {
			if ((error as { code?: unknown }).code !== "EEXIST") throw error;
			const raced = await readRuntimeInputReadyMarker(readinessFile);
			if (raced && raced.session_id === expected.sessionId && raced.launch_id === expected.launchId) {
				await syncCoordinatorDirectory(path.dirname(readinessFile));
				result = raced;
			} else {
				throw runtimeReadinessMarkerConflict();
			}
		}
		if (result === null) {
			await syncCoordinatorDirectory(path.dirname(readinessFile));
			result = marker;
		}
	} catch (error) {
		primaryError = error;
	}
	let cleanupError: unknown;
	try {
		await fs.rm(tempFile, { force: true });
	} catch (error) {
		cleanupError = error;
	}
	let cleanupBarrierError: unknown;
	if (!cleanupError) {
		try {
			await syncCoordinatorDirectory(path.dirname(readinessFile));
		} catch (error) {
			cleanupBarrierError = error;
		}
	}
	const failures = [primaryError, cleanupError, cleanupBarrierError].filter(
		(error): error is unknown => error !== undefined,
	);
	if (failures.length > 1) throw new AggregateError(failures, "readiness publication and cleanup failed");
	if (failures.length === 1) throw failures[0];
	return result;
}

function sameResolvedPath(left: string, right: string, platform: NodeJS.Platform = process.platform): boolean {
	return normalizePathForComparison(left, platform) === normalizePathForComparison(right, platform);
}

function normalizedIdentity(
	context: Pick<RuntimeStateContext, "sessionId" | "cwd" | "sessionFile" | "platform">,
): RuntimeStateIdentity {
	const explicitStateFile = process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV]?.trim();
	const sessionId = explicitStateFile
		? process.env[GJC_COORDINATOR_SESSION_ID_ENV]?.trim() || context.sessionId.trim()
		: context.sessionId.trim();
	const cwd = context.cwd.trim();
	const platform = context.platform ?? process.platform;
	const pathApi = platform === "win32" ? path.win32 : path;
	const sidecarSignatureRequired = process.env[GJC_COORDINATOR_SIDECAR_SIGNATURE_REQUIRED_ENV]?.trim() === "true";
	const sidecarKeyId = sidecarSignatureRequired
		? process.env[GJC_COORDINATOR_SIDECAR_KEY_ID_ENV]?.trim() || null
		: null;
	if (
		!sessionId ||
		!cwd ||
		(sidecarSignatureRequired &&
			(!sidecarKeyId || !/^[a-f0-9]{64}$/.test(sidecarKeyId) || !coordinatorSidecarSigningKey))
	)
		throw new PreviousRuntimeStateReadError();
	return {
		sessionId,
		cwd: pathApi.resolve(cwd),
		workdir: pathApi.resolve(cwd),
		sessionFile: context.sessionFile == null ? null : pathApi.resolve(context.sessionFile),
		platform,
		sidecarKeyId,
	};
}

async function serializeStateFileWrite<T>(stateFile: string, operation: () => Promise<T>): Promise<T> {
	const prior = stateFileWriteChains.get(stateFile) ?? Promise.resolve();
	const current = prior.catch(() => {}).then(operation);
	const settled = current.then(
		() => undefined,
		() => undefined,
	);
	stateFileWriteChains.set(stateFile, settled);
	try {
		return await current;
	} finally {
		if (stateFileWriteChains.get(stateFile) === settled) stateFileWriteChains.delete(stateFile);
	}
}

function validRuntimeStateMarker(value: unknown): value is RuntimeStateSidecarPayload {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const payload = value as RuntimeStateSidecarPayload;
	return (
		payload.schema_version === 1 &&
		typeof payload.session_id === "string" &&
		payload.session_id.trim().length > 0 &&
		payload.session_id === payload.session_id.trim() &&
		(payload.state === "ready_for_input" ||
			payload.state === "running" ||
			payload.state === "needs_user_input" ||
			payload.state === "completed" ||
			payload.state === "errored") &&
		typeof payload.cwd === "string" &&
		payload.cwd.trim().length > 0 &&
		typeof payload.workdir === "string" &&
		payload.workdir.trim().length > 0 &&
		Object.hasOwn(payload, "session_file") &&
		(payload.session_file === null ||
			(typeof payload.session_file === "string" && payload.session_file.trim().length > 0))
	);
}

export async function readTerminalRuntimeStateMarker(input: {
	stateFile?: string | null;
	sessionId?: string | null;
	cwd?: string | null;
	sessionFile?: string | null;
	platform?: NodeJS.Platform;
}): Promise<TerminalRuntimeStateStatus> {
	const platform = input.platform ?? process.platform;
	const pathApi = platform === "win32" ? path.win32 : path;
	const stateFile = input.stateFile?.trim();
	const sessionId = input.sessionId?.trim();
	const cwd = input.cwd?.trim();
	if (!stateFile || !sessionId || !cwd || input.sessionId !== sessionId)
		return { terminal: false, reason: "missing_state_file" };
	let value: unknown;
	try {
		value = JSON.parse(await Bun.file(stateFile).text());
	} catch (error) {
		const code = (error as { code?: unknown }).code;
		return {
			terminal: false,
			reason: code === "ENOENT" ? "missing_state_file" : "invalid_json",
		};
	}
	if (!validRuntimeStateMarker(value)) return { terminal: false, reason: "invalid_state_marker" };
	const payload = value;
	if (payload.session_id !== sessionId) return { terminal: false, reason: "session_id_mismatch" };
	if (
		!sameResolvedPath(payload.cwd as string, cwd, platform) ||
		!sameResolvedPath(payload.workdir as string, cwd, platform)
	)
		return { terminal: false, reason: "cwd_mismatch" };
	const sessionFile = input.sessionFile == null ? null : pathApi.resolve(input.sessionFile);
	if (
		payload.session_file !== sessionFile &&
		!(
			typeof payload.session_file === "string" &&
			typeof sessionFile === "string" &&
			sameResolvedPath(payload.session_file, sessionFile, platform)
		)
	)
		return { terminal: false, reason: "session_file_mismatch" };
	if (payload.state === "completed" || payload.state === "errored") return { terminal: true, state: payload.state };
	return { terminal: false, reason: "non_terminal_state" };
}

function lastAssistant(messages: unknown[] | undefined): AssistantMessage | undefined {
	if (!messages) return undefined;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message && typeof message === "object" && (message as { role?: unknown }).role === "assistant") {
			return message as AssistantMessage;
		}
	}
	return undefined;
}

function assistantText(assistant: AssistantMessage | undefined): string | null {
	if (!assistant) return null;
	const text = assistant.content
		.filter(part => part.type === "text")
		.map(part => part.text)
		.join("\n")
		.trim();
	return text.length > 0 ? text : null;
}

function finalResponseForEvent(event: RuntimeStateEvent): {
	text: string | null;
	format: "markdown";
	source: FinalResponseSource;
	artifact_path: null;
	truncated: false;
} | null {
	if (event.type !== "agent_end") return null;
	return {
		text: assistantText(lastAssistant(event.messages)),
		format: "markdown",
		source: "agent_end",
		artifact_path: null,
		truncated: false,
	};
}

export function stateForEvent(event: RuntimeStateEvent): RuntimeState | null {
	if (event.type === "agent_start" || event.type === "turn_start") return "running";
	if (event.type === "agent_end") {
		const assistant = lastAssistant(event.messages);
		return assistant?.stopReason === "error" ? "errored" : "completed";
	}
	if (event.type === "notice") return null;
	return null;
}

/** True for every event the coordinator-shared file records: lifecycle state or tool activity. */
export function eventAffectsCoordinatorRuntimeState(event: RuntimeStateEvent): boolean {
	return stateForEvent(event) !== null || toolActivityPhaseForEvent(event) !== null;
}

class PreviousRuntimeStateReadError extends Error {
	constructor(cause?: unknown) {
		const lockDetail = cause instanceof SessionStateLockUnavailableError ? ` ${cause.message}` : "";
		super(`Existing runtime state marker is invalid or unreadable; refusing to overwrite.${lockDetail}`);
		this.name = "PreviousRuntimeStateReadError";
		if (cause !== undefined) this.cause = cause;
	}
}

/**
 * A readable, well-formed marker recorded against a different workspace path.
 *
 * Separate from {@link PreviousRuntimeStateReadError} because the two demand different
 * operator responses: an unreadable marker points at file damage, while a foreign marker
 * points at the same session directory being reachable from two checkouts.
 */
class ForeignRuntimeStateError extends Error {
	readonly recordedCwd: string;
	readonly currentCwd: string;
	constructor(previous: Record<string, unknown>, input: RuntimeStateIdentity) {
		const recorded = typeof previous.cwd === "string" ? previous.cwd : "<unknown>";
		super(
			`Existing runtime state marker belongs to a different workspace; refusing to overwrite. ` +
				`recorded cwd ${recorded}, current cwd ${input.cwd}. ` +
				`A live or in-flight marker is never adopted; delete it only if no session is running there.`,
		);
		this.name = "ForeignRuntimeStateError";
		this.recordedCwd = recorded;
		this.currentCwd = input.cwd;
	}
}

/**
 * A foreign marker is adoptable only when every one of these holds:
 *
 * - it already reached a terminal state and is explicitly not live, so no owner can still
 *   be writing to it (`live` must be `false` rather than merely absent: an older or
 *   truncated marker that omits the field says nothing about whether its owner runs);
 * - the marker file itself lives inside the current workspace, which is what distinguishes
 *   a session directory that travelled here with its repository from one that still
 *   belongs to a different workspace on this machine.
 *
 * The second condition is the load-bearing one. Terminal-and-not-live alone would let a
 * finished `C:\...` session be adopted by a `D:\...` workspace, and those are unrelated
 * working trees that must never inherit each other's runtime identity.
 */
function isAdoptableForeignRuntimeState(
	previous: Record<string, unknown>,
	input: RuntimeStateIdentity,
	stateFile: string | null,
): boolean {
	if (previous.live !== false) return false;
	if (previous.state !== "completed" && previous.state !== "errored") return false;
	if (!stateFile) return false;
	return pathIsInside(stateFile, input.cwd, input.platform);
}

/** True when `candidate` resolves to `root` itself or something beneath it. */
function pathIsInside(candidate: string, root: string, platform: NodeJS.Platform = process.platform): boolean {
	if (sameResolvedPath(candidate, root, platform)) return true;
	const normalizedRoot = normalizePathForComparison(root, platform);
	const normalizedCandidate = normalizePathForComparison(candidate, platform);
	if (!normalizedRoot || !normalizedCandidate) return false;
	const separator = platform === "win32" ? "\\" : "/";
	const prefix = normalizedRoot.endsWith(separator) ? normalizedRoot : `${normalizedRoot}${separator}`;
	return normalizedCandidate.startsWith(prefix);
}

class RuntimeToolActivityRefusedError extends Error {
	constructor(reason: string) {
		super(`Refusing to overwrite the coordinator tool-activity snapshot: ${reason}.`);
		this.name = "RuntimeToolActivityRefusedError";
	}
}

function isAbsentStateFileError(error: unknown): boolean {
	return (error as { code?: unknown }).code === "ENOENT";
}

function parsePreviousPayload(raw: string): Record<string, unknown> {
	const payload: unknown = JSON.parse(raw);
	if (!validPreviousRuntimeStatePayload(payload)) throw new PreviousRuntimeStateReadError();
	return payload;
}

function validPreviousRuntimeStatePayload(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const payload = value as Record<string, unknown>;
	if (
		payload.schema_version !== 1 ||
		typeof payload.session_id !== "string" ||
		payload.session_id.trim().length === 0 ||
		(payload.state !== "booting" &&
			payload.state !== "ready_for_input" &&
			payload.state !== "running" &&
			payload.state !== "needs_user_input" &&
			payload.state !== "completed" &&
			payload.state !== "errored" &&
			payload.state !== "stale" &&
			payload.state !== "unknown")
	)
		return false;
	// Coordinator-seeded payloads (#2549) carry session_id and state but not the
	// runtime identity fields cwd/workdir/session_file. Accept their absence; when
	// present, validate them as before.
	if (typeof payload.cwd !== "undefined") {
		if (typeof payload.cwd !== "string" || payload.cwd.trim().length === 0) return false;
	}
	if (typeof payload.workdir !== "undefined") {
		if (typeof payload.workdir !== "string" || payload.workdir.trim().length === 0) return false;
	}
	if (Object.hasOwn(payload, "session_file")) {
		if (payload.session_file !== null && typeof payload.session_file !== "string") return false;
	}
	if (payload.ready_for_input !== undefined && typeof payload.ready_for_input !== "boolean") return false;
	if (payload.live !== undefined && payload.live !== null && typeof payload.live !== "boolean") return false;
	if (payload.reason !== undefined && payload.reason !== null && typeof payload.reason !== "string") return false;
	if (
		payload.updated_at !== undefined &&
		(typeof payload.updated_at !== "string" || !Number.isFinite(Date.parse(payload.updated_at)))
	)
		return false;
	if (payload.ready_for_input !== undefined) {
		const expectedReady = payload.state === "ready_for_input";
		if (payload.ready_for_input !== expectedReady) return false;
	}
	if (payload.live !== undefined && payload.live !== null && payload.live !== (payload.state === "running"))
		return false;
	return true;
}

function readPreviousPayload(stateFile: string): Record<string, unknown> {
	let raw: string;
	try {
		raw = fsSync.readFileSync(stateFile, "utf8");
	} catch (error) {
		if (isAbsentStateFileError(error)) return {};
		throw new PreviousRuntimeStateReadError();
	}
	try {
		return parsePreviousPayload(raw);
	} catch (error) {
		if (error instanceof PreviousRuntimeStateReadError) throw error;
		throw new PreviousRuntimeStateReadError();
	}
}

type RelocationPayloadObservation = {
	payload: Record<string, unknown>;
	identity: NativeExactFileIdentity | null;
};

function sameRelocationFileIdentity(left: fsSync.BigIntStats, right: fsSync.BigIntStats): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.nlink === right.nlink &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs &&
		left.isFile() &&
		right.isFile() &&
		!left.isSymbolicLink() &&
		!right.isSymbolicLink()
	);
}

/** Read relocation authority from one no-follow, identity-revalidated regular file. */
function readRegularFileForRelocation(stateFile: string): { raw: string; identity: NativeExactFileIdentity } | null {
	let before: fsSync.BigIntStats;
	try {
		before = fsSync.lstatSync(stateFile, { bigint: true });
	} catch (error) {
		if (isAbsentStateFileError(error)) return null;
		throw new PreviousRuntimeStateReadError(error);
	}
	if (!before.isFile() || before.isSymbolicLink()) throw new PreviousRuntimeStateReadError();
	const flags = fsSync.constants.O_RDONLY | (process.platform === "win32" ? 0 : (fsSync.constants.O_NOFOLLOW ?? 0));
	let descriptor: number | undefined;
	try {
		descriptor = fsSync.openSync(stateFile, flags);
		const opened = fsSync.fstatSync(descriptor, { bigint: true });
		if (!sameRelocationFileIdentity(before, opened)) throw new PreviousRuntimeStateReadError();
		const raw = fsSync.readFileSync(descriptor, "utf8");
		const after = fsSync.lstatSync(stateFile, { bigint: true });
		const finalOpened = fsSync.fstatSync(descriptor, { bigint: true });
		const parent = fsSync.lstatSync(path.dirname(stateFile), { bigint: true });
		if (!sameRelocationFileIdentity(opened, finalOpened) || !sameRelocationFileIdentity(opened, after))
			throw new PreviousRuntimeStateReadError();
		if (!parent.isDirectory() || parent.isSymbolicLink()) throw new PreviousRuntimeStateReadError();
		return {
			raw,
			identity: {
				dev: opened.dev,
				ino: opened.ino,
				nlink: opened.nlink,
				parentDev: parent.dev,
				parentIno: parent.ino,
				size: opened.size,
				mtimeNs: opened.mtimeNs,
				sha256: createHash("sha256").update(raw).digest("hex"),
				quarantineName: `.gjc-delete-runtime-state-${randomUUID()}.json`,
			},
		};
	} catch (error) {
		if (error instanceof PreviousRuntimeStateReadError) throw error;
		throw new PreviousRuntimeStateReadError(error);
	} finally {
		if (descriptor !== undefined) fsSync.closeSync(descriptor);
	}
}

function readPreviousPayloadForRelocation(stateFile: string): RelocationPayloadObservation {
	const observed = readRegularFileForRelocation(stateFile);
	return observed
		? { payload: parsePreviousPayload(observed.raw), identity: observed.identity }
		: { payload: {}, identity: null };
}

/**
 * Reads the authoritative bytes on disk, every time, inside the state-file lock.
 *
 * There is deliberately no metadata (mtime+size) cache here: another process holding the
 * same lock can rewrite this file to a same-size terminal payload within one filesystem
 * timestamp tick, and a cache hit would then let a late tool event overwrite a settled
 * session back into a running-looking one. The file is small and the read happens once
 * per lock acquisition.
 */
async function readPreviousPayloadForEvent(stateFile: string): Promise<Record<string, unknown>> {
	let stat: fsSync.Stats;
	try {
		stat = await fs.stat(stateFile);
	} catch (error) {
		if (isAbsentStateFileError(error)) return {};
		throw new PreviousRuntimeStateReadError();
	}
	if (!stat.isFile()) throw new PreviousRuntimeStateReadError();
	try {
		return parsePreviousPayload(await fs.readFile(stateFile, "utf8"));
	} catch (error) {
		if (error instanceof PreviousRuntimeStateReadError) throw error;
		throw new PreviousRuntimeStateReadError();
	}
}

function withoutUpdatedAt(payload: Record<string, unknown>): Record<string, unknown> {
	const { updated_at: _updatedAt, ...rest } = payload;
	return rest;
}

function shouldSkipRuntimeStateWrite(
	previous: Record<string, unknown>,
	payload: Record<string, unknown>,
	nowMs: number,
): boolean {
	if (payload.state === "completed" || payload.state === "errored") return false;
	if (previous.state !== payload.state) return false;
	if (previous.state !== "running" || payload.state !== "running") return false;
	if (JSON.stringify(withoutUpdatedAt(previous)) !== JSON.stringify(withoutUpdatedAt(payload))) return false;
	const previousUpdatedAt = typeof previous.updated_at === "string" ? Date.parse(previous.updated_at) : NaN;
	if (!Number.isFinite(previousUpdatedAt)) return false;
	return nowMs - previousUpdatedAt < HEARTBEAT_MS;
}

function shouldPreserveTerminalPayload(previous: RuntimeStateSidecarPayload, input: RuntimeStateIdentity): boolean {
	if (!validRuntimeStateMarker(previous)) return false;
	if (previous.state !== "completed" && previous.state !== "errored") return false;
	const source = previous.final_response?.source;
	if (source !== "agent_end" && source !== "launch_error") return false;
	return (
		previous.session_id === input.sessionId &&
		sameResolvedPath(previous.cwd as string, input.cwd, input.platform) &&
		sameResolvedPath(previous.workdir as string, input.cwd, input.platform) &&
		(previous.session_file === input.sessionFile ||
			(typeof previous.session_file === "string" &&
				typeof input.sessionFile === "string" &&
				sameResolvedPath(previous.session_file, input.sessionFile, input.platform)))
	);
}

function assertPreviousRuntimeStateIdentity(
	previous: Record<string, unknown>,
	input: RuntimeStateIdentity,
	stateFile: string | null = null,
): void {
	if (Object.keys(previous).length === 0) return;
	if (previous.session_id !== input.sessionId) throw new PreviousRuntimeStateReadError();
	// Signed coordinator mode never trusts an unsigned predecessor. The sole exception
	// is the narrow, coordinator-authenticated bootstrap seed: it has no runtime identity
	// fields, is explicitly sourced by the coordinator, and carries the turn fence.
	const coordinatorSeed =
		previous.source === "coordinator" &&
		typeof previous.current_turn_id === "string" &&
		previous.current_turn_id.trim().length > 0 &&
		previous.cwd === undefined &&
		previous.workdir === undefined &&
		previous.session_file === undefined &&
		previous.sidecar_key_id === undefined &&
		previous.sidecar_signature === undefined;
	if (input.sidecarKeyId !== null) {
		if (coordinatorSeed) return;
		if (
			previous.sidecar_key_id !== input.sidecarKeyId ||
			typeof previous.sidecar_signature !== "string" ||
			!coordinatorSidecarSigningKey
		)
			throw new PreviousRuntimeStateReadError();
		const { sidecar_signature: signature, ...unsigned } = previous;
		if (
			!verify(
				null,
				Buffer.from(canonicalCoordinatorSidecarPayload(unsigned)),
				createPublicKey(coordinatorSidecarSigningKey),
				Buffer.from(signature, "base64"),
			)
		)
			throw new PreviousRuntimeStateReadError();
	}
	if (coordinatorSeed) return;
	// If the previous payload has runtime identity fields, verify them fully.
	if (typeof previous.cwd === "string" && typeof previous.workdir === "string") {
		const pathsMatch =
			sameResolvedPath(previous.cwd, input.cwd, input.platform) &&
			sameResolvedPath(previous.workdir, input.cwd, input.platform) &&
			(previous.session_file === input.sessionFile ||
				(typeof previous.session_file === "string" &&
					typeof input.sessionFile === "string" &&
					sameResolvedPath(previous.session_file, input.sessionFile, input.platform)));
		if (!pathsMatch) {
			// A marker whose recorded workspace differs from the current one is readable and
			// well-formed; it simply belongs to another checkout. Reporting that as a read
			// failure sends operators hunting for file corruption that does not exist.
			//
			// A session directory committed to version control reaches a second machine this
			// way, so the mismatch is ordinary rather than exceptional. When the recorded
			// marker is already terminal and not live, nothing can still be writing to it and
			// adopting it is safe; anything else still refuses, because a live or in-flight
			// marker from another workspace may have a running owner behind it.
			if (!isAdoptableForeignRuntimeState(previous, input, stateFile))
				throw new ForeignRuntimeStateError(previous, input);
		}
	}
}

/** Relocation never accepts the coordinator bootstrap exception or partial identity rows. */
function assertRelocationRuntimeStateIdentity(previous: Record<string, unknown>, input: RuntimeStateIdentity): void {
	assertPreviousRuntimeStateIdentity(previous, input);
	if (
		typeof previous.cwd !== "string" ||
		typeof previous.workdir !== "string" ||
		!sameResolvedPath(previous.cwd, input.cwd, input.platform) ||
		!sameResolvedPath(previous.workdir, input.cwd, input.platform) ||
		(previous.session_file !== input.sessionFile &&
			!(
				typeof previous.session_file === "string" &&
				typeof input.sessionFile === "string" &&
				sameResolvedPath(previous.session_file, input.sessionFile, input.platform)
			))
	)
		throw new PreviousRuntimeStateReadError();
}

function runtimeStateFileForContext(context: RuntimeStateContext): string | null {
	const explicit = process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV]?.trim();
	if (explicit) return explicit;
	if (!context.sessionId.trim()) return null;
	return path.join(sessionRuntimeDir(context.cwd, context.sessionId), "runtime-state.json");
}
function branchForContext(context: RuntimeStateContext): string | null {
	return context.branch ?? (process.env[GJC_COORDINATOR_SESSION_BRANCH_ENV]?.trim() || null);
}

function basePayload(input: {
	context: RuntimeStateContext;
	previous: Record<string, unknown>;
	state: RuntimeState;
	now: string;
	source: string;
	event: string;
	reason: string | null;
	sessionId: string;
}): Record<string, unknown> {
	const identity = normalizedIdentity(input.context);
	if (identity.sessionId !== input.sessionId) throw new PreviousRuntimeStateReadError();
	// A lifecycle transition says nothing about tool activity, so a valid snapshot is
	// carried forward and a malformed one verbatim: dropping it would silently reset the
	// per-session sequence, and the public projection refuses to publish it either way.
	// A TERMINAL transition is the one exception — it is authority that nothing can still
	// be running, so any orphaned in-flight call is settled here.
	const terminal = input.state === "completed" || input.state === "errored";
	const readout = terminal
		? terminallySettledRuntimeToolActivity(input.previous.activity, input.now)
		: classifyRuntimeToolActivity(input.previous.activity);
	const activity =
		readout.kind === "absent" ? undefined : readout.kind === "valid" ? readout.activity : input.previous.activity;
	const payload = {
		schema_version: 1,
		session_id: identity.sessionId,
		state: input.state,
		ready_for_input: input.state === "ready_for_input",
		updated_at: input.now,
		current_turn_id: typeof input.previous.current_turn_id === "string" ? input.previous.current_turn_id : null,
		last_turn_id: typeof input.previous.last_turn_id === "string" ? input.previous.last_turn_id : null,
		live: input.state === "running",
		reason: input.reason,
		source: input.source,
		event: input.event,
		cwd: identity.cwd,
		workdir: identity.workdir,
		branch: branchForContext(input.context),
		session_file: identity.sessionFile,
		...(activity === undefined ? {} : { activity }),
		...(input.context.ownerTerminal ? { owner_generation: input.context.ownerTerminal.generation } : {}),
	};
	return payload;
}
function booleanFromUnknown(value: unknown): boolean | null {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "true") return true;
		if (normalized === "false") return false;
	}
	return null;
}

function promptAcceptedFromEnv(): boolean {
	const promptAcceptedJson = process.env[GJC_SESSION_PROMPT_ACCEPTED_JSON_ENV]?.trim();
	if (!promptAcceptedJson) return false;
	try {
		return fsSync.statSync(promptAcceptedJson).size > 0;
	} catch {
		return false;
	}
}

function readJsonFileSync(file: string): Record<string, unknown> | null {
	try {
		return JSON.parse(fsSync.readFileSync(file, "utf8")) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function worktreeBaselineDirtyFromEnvOrMarker(): boolean | null {
	const promptAcceptedJson = process.env[GJC_SESSION_PROMPT_ACCEPTED_JSON_ENV]?.trim();
	if (promptAcceptedJson) {
		const promptAccepted = readJsonFileSync(promptAcceptedJson);
		const promptBaseline = booleanFromUnknown(promptAccepted?.worktreeBaselineDirty);
		if (promptBaseline !== null) return promptBaseline;
	}
	const envValue = booleanFromUnknown(process.env[GJC_SESSION_WORKTREE_BASELINE_DIRTY_ENV]);
	if (envValue !== null) return envValue;
	return null;
}

function observedRecoverableWorktreeChanges(cwd: string): boolean {
	if (!cwd.trim()) return false;
	try {
		const proc = Bun.spawnSync(["git", "status", "--porcelain"], { cwd, stdout: "pipe", stderr: "pipe" });
		return proc.exitCode === 0 && proc.stdout.byteLength > 0;
	} catch {
		return false;
	}
}

function publicSafeErrorMessage(message: string): string {
	const normalized = message.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim();
	if (normalized.length <= MAX_PUBLIC_ERROR_MESSAGE_LENGTH) return normalized;
	return `${normalized.slice(0, MAX_PUBLIC_ERROR_MESSAGE_LENGTH)}…`;
}

function errorMessageForPostmortem(reason: postmortem.Reason): string {
	return publicSafeErrorMessage(`GJC process cleanup ran for ${reason}`);
}

function numericProcessExitCode(defaultCode: number | null): number | null {
	return typeof process.exitCode === "number" ? process.exitCode : defaultCode;
}

function postmortemExitDetails(
	reason: postmortem.Reason,
	previous: RuntimeStateSidecarPayload,
	cwd: string,
): {
	state: RuntimeState;
	reason: string;
	exitKind: string;
	exitCode: number | null;
	signal: string | null;
	error?: { code: string; message: string; recoverable: true };
	recovery?: { action: string; reason: string };
	promptAccepted: boolean;
	observedRecoverableWorktreeChanges: boolean;
	worktreeBaselineDirty: boolean | null;
	worktreeChangedSinceBaseline: boolean;
} {
	const promptAccepted = promptAcceptedFromEnv();
	const observedChanges = observedRecoverableWorktreeChanges(typeof previous.cwd === "string" ? previous.cwd : cwd);
	const worktreeBaselineDirty = worktreeBaselineDirtyFromEnvOrMarker();
	const worktreeChangedSinceBaseline = worktreeBaselineDirty === false && observedChanges;
	const previousStateIsTerminal = previous.state === "completed" || previous.state === "errored";
	if (reason === postmortem.Reason.EXIT || reason === postmortem.Reason.MANUAL) {
		const exitCode = numericProcessExitCode(0) ?? 0;
		const exitedBeforeTerminalState = exitCode === 0 && reason === postmortem.Reason.EXIT && !previousStateIsTerminal;
		const state: RuntimeState = exitCode === 0 && !exitedBeforeTerminalState ? "completed" : "errored";
		const exitReason = exitedBeforeTerminalState
			? "process_exit_before_terminal_state"
			: reason === postmortem.Reason.EXIT
				? "process_exit"
				: "manual_cleanup";
		let classifiedReason = exitReason;
		if (exitedBeforeTerminalState) {
			if (!promptAccepted) classifiedReason = "process_exit_before_prompt_acceptance";
			else if (worktreeChangedSinceBaseline)
				classifiedReason = "accepted_prompt_observed_recoverable_worktree_changes";
			else if (observedChanges)
				classifiedReason = "accepted_prompt_dirty_worktree_observed_without_new_change_proof";
			else classifiedReason = "accepted_prompt_no_useful_output";
		}
		return {
			state,
			reason: classifiedReason,
			exitKind: reason,
			exitCode,
			signal: null,
			...(state === "errored"
				? {
						error: {
							code: classifiedReason,
							message: publicSafeErrorMessage(
								exitedBeforeTerminalState
									? "GJC process exited before emitting terminal agent state"
									: `GJC process exited with code ${exitCode}`,
							),
							recoverable: true,
						},
						recovery: {
							action: "recover_or_resume_session",
							reason: exitedBeforeTerminalState
								? "previous runtime state was non-terminal; preserve the worktree and inspect the session before retrying"
								: "process exited with a non-zero status",
						},
					}
				: {}),
			promptAccepted,
			observedRecoverableWorktreeChanges: observedChanges,
			worktreeBaselineDirty,
			worktreeChangedSinceBaseline,
		};
	}
	const signalByReason: Partial<Record<postmortem.Reason, string>> = {
		[postmortem.Reason.SIGINT]: "SIGINT",
		[postmortem.Reason.SIGTERM]: "SIGTERM",
		[postmortem.Reason.SIGHUP]: "SIGHUP",
	};
	return {
		state: "errored",
		reason,
		exitKind: reason,
		exitCode: numericProcessExitCode(null),
		signal: signalByReason[reason] ?? null,
		error: { code: reason, message: errorMessageForPostmortem(reason), recoverable: true },
		recovery: { action: "recover_or_resume_session", reason: "process cleanup ran before terminal agent state" },
		promptAccepted,
		observedRecoverableWorktreeChanges: observedChanges,
		worktreeBaselineDirty,
		worktreeChangedSinceBaseline,
	};
}

async function writeStateFileSync(
	stateFile: string,
	payload: Record<string, unknown>,
	keyId: string | null = process.env[GJC_COORDINATOR_SIDECAR_SIGNATURE_REQUIRED_ENV]?.trim() === "true"
		? process.env[GJC_COORDINATOR_SIDECAR_KEY_ID_ENV]?.trim() || null
		: null,
): Promise<void> {
	await writeStateFile(stateFile, finalizeSidecarPayload(payload, keyId));
}

async function writeStateFileSyncConditional(
	stateFile: string,
	payload: Record<string, unknown>,
	keyId: string | null,
	expectedDestination: NativeExactFileIdentity | null,
): Promise<void> {
	const contents = `${JSON.stringify(finalizeSidecarPayload(payload, keyId))}\n`;
	await writeCoordinatorAtomic(stateFile, contents, {
		rename: async (source, destination) => {
			if (!expectedDestination) {
				const published = renameNoReplacePath(source, destination);
				if (!published.ok) throw new PreviousRuntimeStateReadError();
				return;
			}
			const stat = fsSync.lstatSync(source, { bigint: true });
			const parent = fsSync.lstatSync(path.dirname(source), { bigint: true });
			if (!stat.isFile() || stat.isSymbolicLink() || !parent.isDirectory() || parent.isSymbolicLink())
				throw new PreviousRuntimeStateReadError();
			const replaced = exactReplacePath(
				source,
				destination,
				{
					dev: stat.dev,
					ino: stat.ino,
					nlink: stat.nlink,
					parentDev: parent.dev,
					parentIno: parent.ino,
					size: stat.size,
					mtimeNs: stat.mtimeNs,
					sha256: createHash("sha256").update(contents).digest("hex"),
				},
				expectedDestination,
			);
			if (!replaced.ok) throw new PreviousRuntimeStateReadError();
		},
	});
}

/**
 * The state-file critical section, shared byte-for-byte with the Coordinator MCP writer.
 *
 * The shared implementation writes the base Coordinator's regular-file `<file>.lock`
 * owner JSON, so both writers recognize each other's owners. The base RUNTIME guarded
 * this same path with the generic directory-style lock instead, so a leftover
 * `<file>.lock/` directory is also recognized and reclaimed under its own protocol rather
 * than faulting forever.
 */
async function withStateFileLock<T>(stateFile: string, operation: () => Promise<T>): Promise<T> {
	// Preserve the lock's typed path/reason diagnostics. A transition timeout means the
	// state file was never entered, not that its existing JSON marker was unreadable.
	return await withSessionStateFileLock(stateFile, operation);
}

function coordinatorTransactionLockFile(stateFile: string): string {
	return path.resolve(path.dirname(stateFile), "..", "locks", "mutation.lock");
}

/**
 * The outer namespace-wide transaction lock. It guards no single JSON document of its
 * own, so it stays on the generic directory-style lock rather than the state-file owner
 * protocol.
 */
async function withCoordinatorTransactionLock<T>(stateFile: string, operation: () => Promise<T>): Promise<T> {
	// Namespace-lock failures are contention or filesystem failures, not evidence that
	// runtime-state.json is malformed. Let the original diagnostic reach the caller.
	return await withFileLock(coordinatorTransactionLockFile(stateFile), operation, {
		staleMs: 30_000,
		retries: 12_000,
		retryDelayMs: 5,
	});
}

function orderedDistinctStateFiles(stateFiles: readonly string[], platform: NodeJS.Platform): string[] {
	const byIdentity = new Map<string, string>();
	for (const stateFile of stateFiles) {
		const resolved = path.resolve(stateFile);
		byIdentity.set(normalizePathForComparison(resolved, platform), resolved);
	}
	return [...byIdentity.entries()]
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
		.map(([, stateFile]) => stateFile);
}

function canonicalDirectoryWithExistingAncestor(directory: string): string {
	let current = path.resolve(directory);
	const missing: string[] = [];
	for (;;) {
		try {
			return path.join(fsSync.realpathSync(current), ...missing.reverse());
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new PreviousRuntimeStateReadError(error);
			const parent = path.dirname(current);
			if (parent === current) throw new PreviousRuntimeStateReadError(error);
			missing.push(path.basename(current));
			current = parent;
		}
	}
}

function canonicalStateFilePath(stateFile: string): string {
	return path.join(canonicalDirectoryWithExistingAncestor(path.dirname(stateFile)), path.basename(stateFile));
}

function assertPinnedDirectoryIdentity(cwd: string, expected: { dev: bigint; ino: bigint }): void {
	const stat = fsSync.lstatSync(cwd, { bigint: true });
	if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== expected.dev || stat.ino !== expected.ino)
		throw new PreviousRuntimeStateReadError();
}

function assertNoSymlinkDirectoryComponents(root: string, directory: string): void {
	const relative = path.relative(root, directory);
	if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
		throw new PreviousRuntimeStateReadError();
	let current = root;
	for (const component of relative.split(path.sep)) {
		current = path.join(current, component);
		try {
			const stat = fsSync.lstatSync(current);
			if (!stat.isDirectory() || stat.isSymbolicLink()) throw new PreviousRuntimeStateReadError();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
			throw error;
		}
	}
}

function confinedJournalPath(cwd: string, sessionId: string, platform: NodeJS.Platform): string {
	const canonicalRoot = fsSync.realpathSync(cwd);
	const rawJournalFile = runtimeStateRescopeJournalPath(canonicalRoot, sessionId);
	assertNoSymlinkDirectoryComponents(canonicalRoot, path.dirname(rawJournalFile));
	const journalFile = canonicalStateFilePath(rawJournalFile);
	const pathImpl = platform === "win32" ? path.win32 : path;
	const relative = pathImpl.relative(canonicalRoot, journalFile);
	if (
		relative === "" ||
		relative === ".." ||
		relative.startsWith(`..${pathImpl.sep}`) ||
		pathImpl.isAbsolute(relative)
	)
		throw new PreviousRuntimeStateReadError();
	return journalFile;
}

async function withSerializedStateFiles<T>(stateFiles: readonly string[], operation: () => Promise<T>): Promise<T> {
	const [stateFile, ...remaining] = stateFiles;
	if (!stateFile) return await operation();
	return await serializeStateFileWrite(stateFile, async () => await withSerializedStateFiles(remaining, operation));
}

async function withCoordinatorTransactionLocks<T>(
	stateFiles: readonly string[],
	operation: () => Promise<T>,
): Promise<T> {
	const [stateFile, ...remaining] = stateFiles;
	if (!stateFile) return await operation();
	return await withCoordinatorTransactionLock(
		stateFile,
		async () => await withCoordinatorTransactionLocks(remaining, operation),
	);
}

async function withStateFileLocks<T>(stateFiles: readonly string[], operation: () => Promise<T>): Promise<T> {
	const [stateFile, ...remaining] = stateFiles;
	if (!stateFile) return await operation();
	return await withStateFileLock(stateFile, async () => await withStateFileLocks(remaining, operation));
}

async function writeStateFile(stateFile: string, payload: Record<string, unknown>): Promise<void> {
	await writeCoordinatorAtomic(stateFile, `${JSON.stringify(payload)}\n`);
}

function contextWithManagedOwnerGeneration(context: RuntimeStateContext): RuntimeStateContext {
	if (context.ownerTerminal) return context;
	const ownerTerminal = ownerTerminalContextFromEnvironment();
	if (ownerTerminal === "invalid") throw new PreviousRuntimeStateReadError();
	return ownerTerminal ? { ...context, ownerTerminal } : context;
}

/**
 * Annotates the existing coordinator-shared runtime state with a tool-activity snapshot.
 *
 * Activity is an annotation on a lifecycle state, never a lifecycle state of its own: it
 * refuses to seed a state file, refuses to touch a session that already settled, and leaves
 * `updated_at` alone so the running-heartbeat cadence stays measured from lifecycle writes.
 */
async function persistCoordinatorRuntimeToolActivity(
	event: RuntimeStateEvent,
	context: RuntimeStateContext,
	stateFile: string,
	phase: RuntimeToolActivityPhase,
	label: string | undefined,
	observedAt: string,
): Promise<void> {
	const identity = normalizedIdentity(context);
	await serializeStateFileWrite(
		stateFile,
		async () =>
			await withCoordinatorTransactionLock(
				stateFile,
				async () =>
					await withStateFileLock(stateFile, async () => {
						assertNoRuntimeStateRescopeJournal(context, identity);
						const previous = await readPreviousPayloadForEvent(stateFile);
						if (Object.keys(previous).length === 0) return;
						assertPreviousRuntimeStateIdentity(previous, identity, stateFile);
						// A tool event that lands after the session settled must never
						// resurrect it into a live-looking state.
						if (previous.state === "completed" || previous.state === "errored") return;
						const readout = classifyRuntimeToolActivity(previous.activity);
						// Fail closed rather than replace an unreadable snapshot, or a sequence
						// that can no longer advance, with a lower one.
						if (readout.kind === "malformed")
							throw new RuntimeToolActivityRefusedError("the persisted snapshot is malformed");
						const priorActivity = readout.kind === "valid" ? readout.activity : null;
						if (!Number.isSafeInteger((priorActivity?.seq ?? 0) + 1))
							throw new RuntimeToolActivityRefusedError("its sequence cannot advance safely");
						await writeStateFileSync(
							stateFile,
							{
								...previous,
								activity: nextRuntimeToolActivity(priorActivity, {
									phase,
									label,
									digest: toolCallDigest(identity.sessionId, event.toolCallId),
									isError: event.isError === true,
									observedAt,
								}),
							},
							identity.sidecarKeyId,
						);
					}),
			),
	);
}

export async function persistCoordinatorRuntimeStateFromEvent(
	event: RuntimeStateEvent,
	context: RuntimeStateContext,
	/**
	 * What the caller observed at the synchronous agent-event boundary: the canonical
	 * public label it proved against the ACTIVE tool object, and the wall clock it read
	 * there. Without one, a tool event records `custom` at this writer's own clock — the
	 * sidecar never trusts a model-supplied name.
	 */
	observation?: CoordinatorToolObservation,
): Promise<void> {
	// The caller's observation time wins so that queueing, subscriber latency, and lock
	// contention cannot compress a real elapsed interval into near zero. A value this
	// writer could not have produced is not trusted enough to persist.
	const observedAt =
		observation && isCanonicalIsoTimestamp(observation.observedAt)
			? observation.observedAt
			: new Date().toISOString();
	__sessionStateSidecarPerfCounters.persistFromEventCalls += 1;
	const stateFile = runtimeStateFileForContext(context);
	const state = stateForEvent(event);
	if (!stateFile) return;
	const beforePersistFromEvent = __sessionStateSidecarTestHooks.beforePersistFromEvent;
	if (beforePersistFromEvent) await beforePersistFromEvent(event.type, context.cwd);
	if (!state) {
		const activityPhase = toolActivityPhaseForEvent(event);
		if (!activityPhase) return;
		await persistCoordinatorRuntimeToolActivity(
			event,
			context,
			stateFile,
			activityPhase,
			observation?.label,
			observedAt,
		);
		return;
	}
	context = contextWithManagedOwnerGeneration(context);
	const identity = normalizedIdentity(context);
	await serializeStateFileWrite(
		stateFile,
		async () =>
			await withCoordinatorTransactionLock(
				stateFile,
				async () =>
					await withStateFileLock(stateFile, async () => {
						assertNoRuntimeStateRescopeJournal(context, identity);
						const nowMs = Date.now();
						const now = new Date(nowMs).toISOString();
						const previous = await readPreviousPayloadForEvent(stateFile);
						assertPreviousRuntimeStateIdentity(previous, identity, stateFile);
						const finalResponse = finalResponseForEvent(event);
						const terminalReceipt =
							state === "completed" || state === "errored"
								? reduceTerminalReceiptState({
										execution: state === "errored" ? "failed" : "completed",
										reportable: Boolean(finalResponse?.text?.trim()),
									})
								: null;
						const payload = {
							...basePayload({
								context,
								previous,
								state,
								now,
								source: "agent_session_event",
								event: event.type,
								reason: null,
								sessionId: identity.sessionId,
							}),
							...(terminalReceipt
								? {
										execution_state: terminalReceipt.execution,
										receipt_state: terminalReceipt.receipt,
										ended_at: now,
									}
								: {}),
							...(finalResponse ? { final_response: finalResponse } : {}),
							...(terminalReceipt?.receipt === "missing"
								? {
										error: {
											code: "receipt_missing",
											message: "Agent completed without reportable final response text or artifact path.",
											recoverable: true,
										},
									}
								: state === "errored"
									? {
											error: {
												code: "agent_error",
												message: "GJC agent reported an error",
												recoverable: true,
											},
										}
									: {}),
						};
						if (shouldSkipRuntimeStateWrite(previous, payload, nowMs)) return;
						await writeStateFileSync(stateFile, payload, identity.sidecarKeyId);
					}),
			),
	);
}

export async function persistCoordinatorWorkerIntegrationOutcome(
	context: RuntimeStateContext,
	outcome: {
		kind: "worker_integration" | "terminal_persistence";
		status: "completed" | "failed" | "timed_out";
		correlationId?: string;
		error?: string;
	},
): Promise<void> {
	const stateFile = runtimeStateFileForContext(context);
	if (!stateFile) return;
	const identity = normalizedIdentity(context);
	await serializeStateFileWrite(
		stateFile,
		async () =>
			await withCoordinatorTransactionLock(
				stateFile,
				async () =>
					await withStateFileLock(stateFile, async () => {
						assertNoRuntimeStateRescopeJournal(context, identity);
						const previous = await readPreviousPayloadForEvent(stateFile);
						if (Object.keys(previous).length === 0) return;
						assertPreviousRuntimeStateIdentity(previous, identity, stateFile);
						const now = new Date().toISOString();
						const terminalPersistenceFailed =
							outcome.kind === "terminal_persistence" && outcome.status !== "completed";
						const reconciliation = {
							status: outcome.status,
							...(outcome.correlationId ? { correlation_id: outcome.correlationId } : {}),
							...(outcome.error ? { error: publicSafeErrorMessage(outcome.error) } : {}),
							observed_at: now,
						};
						const failureMessage = publicSafeErrorMessage(
							outcome.error ??
								(outcome.status === "timed_out"
									? "Worker integration timed out after terminal publication."
									: "Worker integration failed after terminal publication."),
						);
						const payload = {
							...previous,
							...(terminalPersistenceFailed
								? {
										state: "errored",
										ready_for_input: false,
										live: false,
										current_turn_id: null,
										execution_state: "failed",
										receipt_state: "absent",
										ended_at: now,
										reason: "terminal_persistence_failed",
										source: "agent_session_reconciliation",
										event: "terminal_persistence",
									}
								: {}),
							updated_at: now,
							[outcome.kind]: reconciliation,
							...(outcome.status !== "completed"
								? {
										error: {
											code: `${outcome.kind}_failed`,
											message: failureMessage,
											recoverable: true,
										},
									}
								: {}),
						};
						await writeStateFileSync(stateFile, payload, identity.sidecarKeyId);
					}),
			),
	);
}

/**
 * The old identity a rescued predecessor payload must authenticate against: the launch-root
 * cwd and the session file as they were BEFORE the move. Signed mode still requires the
 * predecessor's key id and signature; unsigned mode requires an exact cwd/workdir/session
 * file match. Reusing {@link normalizedIdentity} keeps the platform, key-id, and path
 * resolution rules byte-identical with the persist path's fence.
 */
function previousRescopeIdentity(context: RuntimeStateContext, previousCwd: string): RuntimeStateIdentity {
	return normalizedIdentity({
		sessionId: context.sessionId,
		cwd: previousCwd,
		sessionFile: context.previousSessionFile ?? context.sessionFile ?? null,
		platform: context.platform,
	});
}

interface CoordinatorRuntimeStateRescopeJournal {
	schema_version: 1;
	move_id: string;
	session_id: string;
	previous_cwd: string;
	new_cwd: string;
	previous_session_file: string | null;
	new_session_file: string | null;
	old_state_file: string;
	new_state_file: string;
	state_file_mode: "pinned" | "derived";
	source_sha256: string | null;
	phase: "prepared" | "publishing";
	key_id: string | null;
	signature: string | null;
	created_at: string;
}

const RUNTIME_STATE_RESCOPE_MOVE_ID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function runtimeStateRescopeJournalPath(cwd: string, sessionId: string): string {
	return path.join(sessionRuntimeDir(cwd, sessionId), "runtime-state-rescope.json");
}

function sameOptionalResolvedPath(
	left: string | null,
	right: string | null,
	platform: NodeJS.Platform = process.platform,
): boolean {
	return (
		left === right ||
		(typeof left === "string" && typeof right === "string" && sameResolvedPath(left, right, platform))
	);
}

function parseRuntimeStateRescopeJournal(raw: string): CoordinatorRuntimeStateRescopeJournal {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new PreviousRuntimeStateReadError();
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new PreviousRuntimeStateReadError();
	const journal = value as Record<string, unknown>;
	if (
		!hasExactOwnKeys(journal, [
			"schema_version",
			"move_id",
			"session_id",
			"previous_cwd",
			"new_cwd",
			"previous_session_file",
			"new_session_file",
			"old_state_file",
			"new_state_file",
			"state_file_mode",
			"source_sha256",
			"phase",
			"key_id",
			"signature",
			"created_at",
		]) ||
		journal.schema_version !== 1 ||
		typeof journal.move_id !== "string" ||
		!RUNTIME_STATE_RESCOPE_MOVE_ID_PATTERN.test(journal.move_id) ||
		typeof journal.session_id !== "string" ||
		typeof journal.previous_cwd !== "string" ||
		typeof journal.new_cwd !== "string" ||
		(journal.previous_session_file !== null && typeof journal.previous_session_file !== "string") ||
		(journal.new_session_file !== null && typeof journal.new_session_file !== "string") ||
		typeof journal.old_state_file !== "string" ||
		typeof journal.new_state_file !== "string" ||
		(journal.state_file_mode !== "pinned" && journal.state_file_mode !== "derived") ||
		(journal.source_sha256 !== null &&
			(typeof journal.source_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(journal.source_sha256))) ||
		(journal.phase !== "prepared" && journal.phase !== "publishing") ||
		(journal.key_id !== null && typeof journal.key_id !== "string") ||
		(journal.signature !== null && typeof journal.signature !== "string") ||
		!isCanonicalIsoTimestamp(journal.created_at)
	)
		throw new PreviousRuntimeStateReadError();
	return journal as unknown as CoordinatorRuntimeStateRescopeJournal;
}

function rescopeStateFiles(
	sessionId: string,
	previousCwd: string,
	newCwd: string,
): { oldStateFile: string; newStateFile: string; mode: "pinned" | "derived" } {
	const explicit = process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV]?.trim();
	if (explicit) {
		const stateFile = canonicalStateFilePath(explicit);
		return { oldStateFile: stateFile, newStateFile: stateFile, mode: "pinned" };
	}
	return {
		oldStateFile: canonicalStateFilePath(
			path.join(sessionRuntimeDir(fsSync.realpathSync(previousCwd), sessionId), "runtime-state.json"),
		),
		newStateFile: canonicalStateFilePath(
			path.join(sessionRuntimeDir(fsSync.realpathSync(newCwd), sessionId), "runtime-state.json"),
		),
		mode: "derived",
	};
}

function journalSignaturePayload(journal: CoordinatorRuntimeStateRescopeJournal): Record<string, unknown> {
	const { signature: _signature, ...unsigned } = journal;
	return unsigned;
}

function verifyRuntimeStateRescopeJournal(journal: CoordinatorRuntimeStateRescopeJournal): void {
	if (journal.key_id === null) {
		if (journal.signature !== null) throw new PreviousRuntimeStateReadError();
		return;
	}
	if (
		journal.signature === null ||
		!coordinatorSidecarSigningKey ||
		!verify(
			null,
			Buffer.from(canonicalCoordinatorSidecarPayload(journalSignaturePayload(journal))),
			createPublicKey(coordinatorSidecarSigningKey),
			Buffer.from(journal.signature, "base64"),
		)
	)
		throw new PreviousRuntimeStateReadError();
}

function assertNoRuntimeStateRescopeJournal(context: RuntimeStateContext, identity: RuntimeStateIdentity): void {
	let canonicalCwd: string;
	try {
		canonicalCwd = fsSync.realpathSync(context.cwd);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	const journalFile = runtimeStateRescopeJournalPath(canonicalCwd, context.sessionId);
	const observed = readRegularFileForRelocation(journalFile);
	if (!observed) return;
	const journal = parseRuntimeStateRescopeJournal(observed.raw);
	verifyRuntimeStateRescopeJournal(journal);
	if (journal.session_id !== context.sessionId || journal.key_id !== identity.sidecarKeyId)
		throw new PreviousRuntimeStateReadError();
	if (
		!sameResolvedPath(journal.previous_cwd, identity.cwd, identity.platform) &&
		!sameResolvedPath(journal.new_cwd, identity.cwd, identity.platform)
	)
		throw new PreviousRuntimeStateReadError();
	throw new PreviousRuntimeStateReadError();
}

export async function prepareCoordinatorRuntimeStateRescope(input: {
	moveId?: string;
	sessionId: string;
	previousCwd: string;
	newCwd: string;
	previousCwdIdentity?: { dev: bigint; ino: bigint };
	newCwdIdentity?: { dev: bigint; ino: bigint };
	previousSessionFile?: string | null;
	newSessionFile?: string | null;
}): Promise<string> {
	const previousStat = fsSync.lstatSync(input.previousCwd, { bigint: true });
	const newStat = fsSync.lstatSync(input.newCwd, { bigint: true });
	const previousCwdIdentity = input.previousCwdIdentity ?? { dev: previousStat.dev, ino: previousStat.ino };
	const newCwdIdentity = input.newCwdIdentity ?? { dev: newStat.dev, ino: newStat.ino };
	assertPinnedDirectoryIdentity(input.previousCwd, previousCwdIdentity);
	assertPinnedDirectoryIdentity(input.newCwd, newCwdIdentity);
	const previousCwd = fsSync.realpathSync(input.previousCwd);
	const newCwd = fsSync.realpathSync(input.newCwd);
	const stateFiles = rescopeStateFiles(input.sessionId, previousCwd, newCwd);
	const moveId = input.moveId ?? randomUUID();
	if (!RUNTIME_STATE_RESCOPE_MOVE_ID_PATTERN.test(moveId)) throw new PreviousRuntimeStateReadError();
	const identity = normalizedIdentity({
		sessionId: input.sessionId,
		cwd: newCwd,
		sessionFile: input.newSessionFile ?? null,
	});
	const previousJournalFile = confinedJournalPath(previousCwd, input.sessionId, identity.platform);
	const newJournalFile = confinedJournalPath(newCwd, input.sessionId, identity.platform);
	const oldIdentity = previousRescopeIdentity(
		{
			sessionId: input.sessionId,
			cwd: newCwd,
			sessionFile: input.newSessionFile ?? null,
			previousSessionFile: input.previousSessionFile ?? null,
		},
		previousCwd,
	);
	return await withSerializedStateFiles([stateFiles.oldStateFile], async () =>
		withCoordinatorTransactionLocks([stateFiles.oldStateFile], async () =>
			withStateFileLocks([stateFiles.oldStateFile], async () => {
				const sourceObservation = readPreviousPayloadForRelocation(stateFiles.oldStateFile);
				if (Object.keys(sourceObservation.payload).length > 0)
					assertRelocationRuntimeStateIdentity(sourceObservation.payload, oldIdentity);
				const journal: CoordinatorRuntimeStateRescopeJournal = {
					schema_version: 1,
					move_id: moveId,
					session_id: input.sessionId,
					previous_cwd: previousCwd,
					new_cwd: newCwd,
					previous_session_file: input.previousSessionFile ? path.resolve(input.previousSessionFile) : null,
					new_session_file: input.newSessionFile ? path.resolve(input.newSessionFile) : null,
					old_state_file: stateFiles.oldStateFile,
					new_state_file: stateFiles.newStateFile,
					state_file_mode: stateFiles.mode,
					source_sha256: sourceObservation.identity?.sha256 ?? null,
					phase: "prepared",
					key_id: identity.sidecarKeyId,
					signature: null,
					created_at: new Date().toISOString(),
				};
				if (journal.key_id !== null) {
					if (!coordinatorSidecarSigningKey) throw new PreviousRuntimeStateReadError();
					journal.signature = sign(
						null,
						Buffer.from(canonicalCoordinatorSidecarPayload(journalSignaturePayload(journal))),
						coordinatorSidecarSigningKey,
					).toString("base64");
				}
				const writeJournal = async (journalFile: string): Promise<void> => {
					await writeCoordinatorAtomic(journalFile, `${JSON.stringify(journal)}\n`, {
						rename: async (source, destination) => {
							const published = renameNoReplacePath(source, destination);
							if (!published.ok) throw new PreviousRuntimeStateReadError();
						},
					});
				};
				await __sessionStateSidecarTestHooks.beforeRescopeJournalWrite?.(previousCwd);
				assertPinnedDirectoryIdentity(input.previousCwd, previousCwdIdentity);
				await writeJournal(previousJournalFile);
				if (confinedJournalPath(previousCwd, input.sessionId, identity.platform) !== previousJournalFile)
					throw new PreviousRuntimeStateReadError();
				assertPinnedDirectoryIdentity(input.previousCwd, previousCwdIdentity);
				await __sessionStateSidecarTestHooks.beforeRescopeJournalWrite?.(newCwd);
				assertPinnedDirectoryIdentity(input.newCwd, newCwdIdentity);
				await writeJournal(newJournalFile);
				if (confinedJournalPath(newCwd, input.sessionId, identity.platform) !== newJournalFile)
					throw new PreviousRuntimeStateReadError();
				assertPinnedDirectoryIdentity(input.previousCwd, previousCwdIdentity);
				assertPinnedDirectoryIdentity(input.newCwd, newCwdIdentity);
				return journal.move_id;
			}),
		),
	);
}

export async function markCoordinatorRuntimeStateRescopePublishing(
	context: RuntimeStateContext,
	previousCwd: string,
	moveId: string,
): Promise<void> {
	const identity = normalizedIdentity(context);
	const journalFiles = orderedDistinctStateFiles(
		[previousCwd, context.cwd].map(cwd =>
			runtimeStateRescopeJournalPath(fsSync.realpathSync(cwd), context.sessionId),
		),
		identity.platform,
	);
	for (const journalFile of journalFiles) {
		const observed = readRegularFileForRelocation(journalFile);
		if (!observed) throw new PreviousRuntimeStateReadError();
		const journal = parseRuntimeStateRescopeJournal(observed.raw);
		verifyRuntimeStateRescopeJournal(journal);
		if (
			journal.move_id !== moveId ||
			journal.session_id !== context.sessionId ||
			journal.key_id !== identity.sidecarKeyId ||
			journal.phase !== "prepared"
		)
			throw new PreviousRuntimeStateReadError();
		journal.phase = "publishing";
		journal.signature = null;
		if (journal.key_id !== null) {
			if (!coordinatorSidecarSigningKey) throw new PreviousRuntimeStateReadError();
			journal.signature = sign(
				null,
				Buffer.from(canonicalCoordinatorSidecarPayload(journalSignaturePayload(journal))),
				coordinatorSidecarSigningKey,
			).toString("base64");
		}
		const contents = `${JSON.stringify(journal)}\n`;
		await writeCoordinatorAtomic(journalFile, contents, {
			rename: async (source, destination) => {
				const sourceStat = fsSync.lstatSync(source, { bigint: true });
				const sourceParent = fsSync.lstatSync(path.dirname(source), { bigint: true });
				const replaced = exactReplacePath(
					source,
					destination,
					{
						dev: sourceStat.dev,
						ino: sourceStat.ino,
						nlink: sourceStat.nlink,
						parentDev: sourceParent.dev,
						parentIno: sourceParent.ino,
						size: sourceStat.size,
						mtimeNs: sourceStat.mtimeNs,
						sha256: createHash("sha256").update(contents).digest("hex"),
					},
					observed.identity,
				);
				if (!replaced.ok) throw new PreviousRuntimeStateReadError();
			},
		});
	}
}

export async function clearCoordinatorRuntimeStateRescope(
	context: RuntimeStateContext,
	expectedMoveId?: string,
	previousCwd?: string,
): Promise<void> {
	const identity = normalizedIdentity(context);
	const candidateCwds = [context.cwd, previousCwd].filter((cwd): cwd is string => typeof cwd === "string");
	const journalFiles = orderedDistinctStateFiles(
		candidateCwds.map(cwd => runtimeStateRescopeJournalPath(fsSync.realpathSync(cwd), context.sessionId)),
		identity.platform,
	);
	for (const journalFile of journalFiles) {
		const observed = readRegularFileForRelocation(journalFile);
		if (!observed) continue;
		const journal = parseRuntimeStateRescopeJournal(observed.raw);
		verifyRuntimeStateRescopeJournal(journal);
		if (expectedMoveId !== undefined && journal.move_id !== expectedMoveId) throw new PreviousRuntimeStateReadError();
		if (journal.session_id !== context.sessionId || journal.key_id !== identity.sidecarKeyId)
			throw new PreviousRuntimeStateReadError();
		const removed = exactUnlinkDirect(journalFile, observed.identity);
		if (!removed.ok && removed.code !== "not_found") throw new PreviousRuntimeStateReadError();
		await syncCoordinatorDirectory(path.dirname(journalFile));
	}
}

/**
 * Cheap synchronous probe for a pending rescope-recovery journal at this cwd. Sessions
 * that never moved (the overwhelming majority) have none, so callers use this to avoid
 * arming a startup-turn barrier for a no-op recovery \u2014 an armed barrier is not free even
 * when it resolves immediately: it flips the session's startup gate from absent to present
 * and reorders barrier-gated post-turn work.
 */
export function hasCoordinatorRuntimeStateRescopeJournal(context: RuntimeStateContext): boolean {
	try {
		return readRegularFileForRelocation(runtimeStateRescopeJournalPath(context.cwd, context.sessionId)) !== null;
	} catch {
		return false;
	}
}

export async function recoverCoordinatorRuntimeStateRescope(context: RuntimeStateContext): Promise<void> {
	const journalFile = runtimeStateRescopeJournalPath(context.cwd, context.sessionId);
	const observed = readRegularFileForRelocation(journalFile);
	if (!observed) return;
	const journal = parseRuntimeStateRescopeJournal(observed.raw);
	verifyRuntimeStateRescopeJournal(journal);
	const current = normalizedIdentity(context);
	const configuredStateFiles = rescopeStateFiles(journal.session_id, journal.previous_cwd, journal.new_cwd);
	if (
		journal.session_id !== context.sessionId ||
		journal.key_id !== current.sidecarKeyId ||
		journal.state_file_mode !== configuredStateFiles.mode ||
		!sameResolvedPath(journal.old_state_file, configuredStateFiles.oldStateFile, current.platform) ||
		!sameResolvedPath(journal.new_state_file, configuredStateFiles.newStateFile, current.platform)
	)
		throw new PreviousRuntimeStateReadError();
	if (
		sameResolvedPath(journal.previous_cwd, current.cwd, current.platform) &&
		sameOptionalResolvedPath(journal.previous_session_file, current.sessionFile, current.platform)
	) {
		if (journal.phase !== "prepared") throw new PreviousRuntimeStateReadError();
		const source = readPreviousPayloadForRelocation(journal.old_state_file);
		if (Object.keys(source.payload).length === 0) {
			if (journal.source_sha256 !== null) throw new PreviousRuntimeStateReadError();
		} else {
			assertRelocationRuntimeStateIdentity(
				source.payload,
				previousRescopeIdentity(
					{ ...context, previousSessionFile: journal.previous_session_file },
					journal.previous_cwd,
				),
			);
			if (source.identity?.sha256 !== journal.source_sha256) throw new PreviousRuntimeStateReadError();
		}
		await clearCoordinatorRuntimeStateRescope(context, journal.move_id, journal.new_cwd);
		return;
	}
	if (
		!sameResolvedPath(journal.new_cwd, current.cwd, current.platform) ||
		!sameOptionalResolvedPath(journal.new_session_file, current.sessionFile, current.platform) ||
		journal.phase !== "publishing"
	)
		throw new PreviousRuntimeStateReadError();
	const completed = await relocateCoordinatorRuntimeStateForRescope(
		{ ...context, previousSessionFile: journal.previous_session_file },
		journal.previous_cwd,
	);
	if (!completed) throw new PreviousRuntimeStateReadError();
	await clearCoordinatorRuntimeStateRescope(context, journal.move_id, journal.previous_cwd);
}

function sameExactFileIdentity(left: NativeExactFileIdentity | null, right: NativeExactFileIdentity | null): boolean {
	return (
		left === right ||
		(left !== null &&
			right !== null &&
			left.dev === right.dev &&
			left.ino === right.ino &&
			left.nlink === right.nlink &&
			left.size === right.size &&
			left.mtimeNs === right.mtimeNs &&
			left.sha256 === right.sha256)
	);
}

/**
 * Repairs the coordinator-shared runtime state after a committed cwd rescope, for every
 * move surface (`move_session`, TUI `/move`, SDK/ACP `session.cwd.move`) through the one
 * shared {@link SessionManager.moveTo} seam.
 *
 * The identity fence in {@link assertPreviousRuntimeStateIdentity} rejects any write whose
 * predecessor payload records a different cwd/workdir than the live session. A rescope
 * changes the session cwd but leaves the predecessor payload pointing at the launch root,
 * so every later persist for the session would be refused as a foreign marker.
 *
 * The predecessor is fully authenticated against its OLD identity before it is trusted:
 * signed mode verifies the predecessor's key id and Ed25519 signature; unsigned mode
 * requires an exact old cwd/workdir/session-file match (the same checks the fence applies).
 * Only a predecessor that passes is rewritten to the new identity and re-signed. When the
 * state file is cwd-derived rather than pinned by
 * {@link GJC_COORDINATOR_SESSION_STATE_FILE_ENV}, the payload is migrated to the new path
 * and the orphaned launch-root file is removed. A payload already self-healed at the new
 * cwd is left untouched.
 *
 * Both the old and new cwd-derived paths are locked (new first, then old) so a concurrent
 * writer at either path serializes behind this repair. Best-effort by contract: the move
 * is already durable, so a failure here is logged by the caller and never resurfaced as a
 * rescope rejection.
 */
export async function relocateCoordinatorRuntimeStateForRescope(
	context: RuntimeStateContext,
	previousCwd: string,
): Promise<boolean> {
	const canonicalNewCwd = fsSync.realpathSync(context.cwd);
	const canonicalPreviousCwd = fsSync.realpathSync(previousCwd);
	context = { ...context, cwd: canonicalNewCwd };
	const rawNewStateFile = runtimeStateFileForContext(context);
	const newStateFile = rawNewStateFile ? canonicalStateFilePath(rawNewStateFile) : null;
	if (!newStateFile) return true;
	const identity = normalizedIdentity(context);
	const oldIdentity = previousRescopeIdentity(context, previousCwd);
	const explicitStateFile = process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV]?.trim();
	// A pinned state file never moves with the cwd; a cwd-derived one lives under the
	// per-session runtime directory rooted at the (now former) cwd.
	const oldStateFile = explicitStateFile
		? newStateFile
		: canonicalStateFilePath(
				path.join(sessionRuntimeDir(canonicalPreviousCwd, identity.sessionId), "runtime-state.json"),
			);
	const samePath = sameResolvedPath(oldStateFile, newStateFile, identity.platform);
	let expectedSourceSha256: string | null | undefined;
	const journalObservation = readRegularFileForRelocation(
		runtimeStateRescopeJournalPath(canonicalNewCwd, context.sessionId),
	);
	if (journalObservation) {
		const journal = parseRuntimeStateRescopeJournal(journalObservation.raw);
		verifyRuntimeStateRescopeJournal(journal);
		if (
			journal.session_id !== context.sessionId ||
			journal.key_id !== identity.sidecarKeyId ||
			!sameResolvedPath(journal.previous_cwd, canonicalPreviousCwd, identity.platform) ||
			!sameResolvedPath(journal.new_cwd, canonicalNewCwd, identity.platform) ||
			!sameResolvedPath(journal.old_state_file, oldStateFile, identity.platform) ||
			!sameResolvedPath(journal.new_state_file, newStateFile, identity.platform)
		)
			throw new PreviousRuntimeStateReadError();
		expectedSourceSha256 = journal.source_sha256;
	}
	const stateFiles = orderedDistinctStateFiles([oldStateFile, newStateFile], identity.platform);
	return await withSerializedStateFiles(
		stateFiles,
		async () =>
			await withCoordinatorTransactionLocks(
				stateFiles,
				async () =>
					await withStateFileLocks(stateFiles, async () => {
						await __sessionStateSidecarTestHooks.afterRescopeLocksAcquired?.();
						const destinationObservation = readPreviousPayloadForRelocation(newStateFile);
						const destination = destinationObservation.payload;
						if (samePath && Object.keys(destination).length > 0) {
							try {
								assertRelocationRuntimeStateIdentity(destination, identity);
								return true;
							} catch {
								// A pinned predecessor still carries the old identity and is migrated below.
							}
						}
						let destinationIsCurrent = false;
						if (!samePath && Object.keys(destination).length > 0) {
							try {
								assertRelocationRuntimeStateIdentity(destination, identity);
							} catch {
								return false;
							}
							destinationIsCurrent = true;
						}
						const sourceObservation = samePath
							? destinationObservation
							: readPreviousPayloadForRelocation(oldStateFile);
						const source = sourceObservation.payload;
						if (Object.keys(source).length === 0) {
							return expectedSourceSha256 === undefined || expectedSourceSha256 === null || destinationIsCurrent;
						}
						if (
							expectedSourceSha256 !== undefined &&
							(expectedSourceSha256 === null || sourceObservation.identity?.sha256 !== expectedSourceSha256)
						)
							return false;
						// Trust the predecessor only if it authenticates against its OLD identity. A payload
						// whose signature, key, or old cwd/session-file does not match is left untouched; the
						// fence, not this repair, remains the authority for a foreign marker.
						try {
							assertRelocationRuntimeStateIdentity(source, oldIdentity);
						} catch {
							return false;
						}
						const publishSource = !destinationIsCurrent;
						if (publishSource) {
							const migrated = {
								...source,
								cwd: identity.cwd,
								workdir: identity.workdir,
								session_file: identity.sessionFile,
								branch: branchForContext(context),
								source: "session_rescope",
								event: "move_session",
								updated_at: new Date().toISOString(),
							};
							await __sessionStateSidecarTestHooks.beforeRescopePublish?.();
							await writeStateFileSyncConditional(
								newStateFile,
								migrated,
								identity.sidecarKeyId,
								destinationObservation.identity,
							);
						}
						if (samePath) return true;
						// Remove the orphan while both path transactions remain held. Re-read and authenticate
						// so an unexpected non-cooperating replacement is never removed as this session's state.
						const orphanObservation = readPreviousPayloadForRelocation(oldStateFile);
						const orphan = orphanObservation.payload;
						if (Object.keys(orphan).length === 0) return true;
						try {
							assertRelocationRuntimeStateIdentity(orphan, oldIdentity);
						} catch {
							return false;
						}
						if (!sameExactFileIdentity(sourceObservation.identity, orphanObservation.identity)) return false;
						if (!orphanObservation.identity) throw new PreviousRuntimeStateReadError();
						const removed = exactUnlinkDirect(oldStateFile, orphanObservation.identity);
						if (!removed.ok && removed.code !== "not_found") throw new PreviousRuntimeStateReadError();
						return true;
					}),
			),
	);
}

function ownerTerminalSignal(reason: postmortem.Reason): TerminalSignal {
	if (reason === postmortem.Reason.SIGTERM) return "SIGTERM";
	if (reason === postmortem.Reason.SIGINT) return "SIGINT";
	if (reason === postmortem.Reason.SIGHUP) return "SIGHUP";
	if (reason === postmortem.Reason.EXIT) return "EXIT";
	if (reason === postmortem.Reason.MANUAL) return "MANUAL";
	return "UNKNOWN";
}

function ownerTerminalPayload(verdict: OwnerVerdict, _owner: OwnerTerminalContext): Record<string, unknown> {
	return {
		generation: verdict.generation,
		socket_key: verdict.server_key,
		signal: verdict.signal,
		result: verdict.result,
		classification: verdict.classification,
		observer: verdict.observer,
		observed_at: verdict.observed_at,
		...(verdict.intent_id ? { intent_id: verdict.intent_id } : {}),
		dedupe_key: verdict.dedupe_key,
	};
}

export function ownerTerminalContextFromEnvironment(): OwnerTerminalContext | "invalid" | null {
	const generation = process.env[GJC_TMUX_OWNER_GENERATION_ENV];
	const stateDir = process.env[GJC_TMUX_OWNER_STATE_DIR_ENV];
	const socketKey = process.env[GJC_TMUX_OWNER_SERVER_KEY_ENV];
	const supplied = [generation, stateDir, socketKey].some(value => value !== undefined);
	const managedLaunch = process.platform === "linux" && process.env.GJC_TMUX_LAUNCHED === "1";
	if (!supplied) return managedLaunch ? "invalid" : null;
	const normalizedGeneration = generation?.trim();
	const normalizedStateDir = stateDir?.trim();
	const normalizedSocketKey = socketKey?.trim();
	if (
		!normalizedGeneration ||
		!normalizedStateDir ||
		!normalizedSocketKey ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(normalizedGeneration) ||
		!path.isAbsolute(normalizedStateDir) ||
		/[\u0000-\u001f\u007f]/.test(normalizedSocketKey)
	) {
		return "invalid";
	}
	return { generation: normalizedGeneration, stateDir: normalizedStateDir, socketKey: normalizedSocketKey };
}

async function persistInvalidOwnerTerminalMetadata(
	reason: postmortem.Reason,
	context: RuntimeStateContext,
	stateFile: string,
	sessionId: string,
	previous: Record<string, unknown>,
): Promise<void> {
	const now = new Date().toISOString();
	await writeStateFileSync(stateFile, {
		...basePayload({
			context,
			previous,
			state: "errored",
			now,
			source: "process_postmortem",
			event: "owner_terminal",
			reason: "owner_metadata_invalid",
			sessionId,
		}),
		ended_at: now,
		detected_at: now,
		signal: ownerTerminalSignal(reason),
		error: {
			code: "owner_metadata_invalid",
			message: "GJC managed tmux owner metadata was unavailable or invalid",
			recoverable: true,
		},
		recovery: {
			action: "recover_or_resume_session",
			reason: "managed tmux owner provenance could not be validated",
		},
		previous_runtime_state: typeof previous.state === "string" ? previous.state : null,
	});
}

async function operatorDispatchIdForOwner(
	owner: OwnerTerminalContext,
	request: Omit<ObserveTerminalRequest, "operator_dispatch_id" | "operator_intent_id">,
): Promise<Pick<ObserveTerminalRequest, "operator_dispatch_id" | "operator_intent_id"> | undefined> {
	const dispatchId = owner.operatorDispatchId;
	if (!dispatchId) return undefined;
	const intentId = owner.operatorIntentId;
	if (!intentId) return undefined;
	try {
		const intent = JSON.parse(
			await Bun.file(lifecyclePaths(owner.stateDir, request.session_id, owner.generation).intentFile).text(),
		) as unknown;
		if (!isValidOwnerIntent(intent)) return undefined;
		if (
			!isValidOwnerIntent(intent as OwnerIntent, {
				...request,
				operator_dispatch_id: dispatchId,
				...(intentId !== undefined && intentId !== null ? { operator_intent_id: intentId } : {}),
			})
		)
			return undefined;
		return {
			operator_dispatch_id: dispatchId,
			...(intentId !== undefined && intentId !== null ? { operator_intent_id: intentId } : {}),
		};
	} catch {
		return undefined;
	}
}

async function observeOwnerTerminalPostmortem(
	reason: postmortem.Reason,
	owner: OwnerTerminalContext,
	sessionId: string,
): Promise<OwnerVerdict | null> {
	try {
		if (process.env.GJC_MANAGED_OWNER_SUPERVISED === "1" && (!owner.operatorDispatchId || !owner.operatorIntentId))
			return null;
		const now = new Date().toISOString();
		const observation: Omit<ObserveTerminalRequest, "operator_dispatch_id" | "operator_intent_id"> = {
			schema_version: 1,
			op: "observe_terminal",
			session_id: sessionId,
			owner_generation: owner.generation,
			state_dir: owner.stateDir,
			socket_key: owner.socketKey,
			observer: "sidecar",
			observed_at: now,
			signal: ownerTerminalSignal(reason),
			exit_code: numericProcessExitCode(null),
			exit_kind: String(reason),
			reason: "process_postmortem",
		};
		const operatorIdentity = await operatorDispatchIdForOwner(owner, observation);
		return await observeOwnerTerminal({
			...observation,
			...(operatorIdentity ?? {}),
		});
	} catch {
		return null;
	}
}

async function persistCoordinatorRuntimeStateFromOwnerTerminalPostmortem(
	context: RuntimeStateContext,
	stateFile: string,
	sessionId: string,
	previous: Record<string, unknown>,
	verdict: OwnerVerdict | null,
): Promise<void> {
	const owner = context.ownerTerminal;
	if (!owner) return;
	try {
		if (!verdict) {
			if (process.env.GJC_MANAGED_OWNER_SUPERVISED === "1") return;
			throw new Error("owner terminal verdict unavailable");
		}
		const now = new Date().toISOString();
		const expected = verdict.classification === "expected_operator_shutdown";
		const state: RuntimeState = expected ? "completed" : "errored";
		const payload = {
			...basePayload({
				context,
				previous,
				state,
				now,
				source: "process_postmortem",
				event: "owner_terminal",
				reason: verdict.classification,
				sessionId,
			}),
			ended_at: now,
			detected_at: now,
			owner_terminal: ownerTerminalPayload(verdict, owner),
			...(expected
				? {}
				: {
						error: {
							code: verdict.classification,
							message: "GJC owner terminal verdict requires session recovery",
							recoverable: true,
						},
						recovery: {
							action: "recover_or_resume_session",
							reason: "owner terminal verdict was not an expected operator shutdown",
						},
					}),
			previous_runtime_state: typeof previous.state === "string" ? previous.state : null,
		};
		await writeStateFileSync(stateFile, payload);
	} catch {
		const now = new Date().toISOString();
		await writeStateFileSync(stateFile, {
			...basePayload({
				context,
				previous,
				state: "errored",
				now,
				source: "process_postmortem",
				event: "owner_terminal",
				reason: "owner_verdict_unavailable",
				sessionId,
			}),
			ended_at: now,
			detected_at: now,
			error: {
				code: "owner_verdict_unavailable",
				message: "GJC owner terminal verdict was unavailable",
				recoverable: true,
			},
			recovery: {
				action: "recover_or_resume_session",
				reason: "owner terminal could not be authoritatively classified",
			},
			previous_runtime_state: typeof previous.state === "string" ? previous.state : null,
		});
	}
}

export async function persistCoordinatorRuntimeStateFromPostmortem(
	reason: postmortem.Reason,
	context: RuntimeStateContext,
): Promise<void> {
	const stateFile = runtimeStateFileForContext(context);
	if (!stateFile) return;
	const identity = normalizedIdentity(context);
	const ownerSessionRoot = sessionRoot(context.cwd, identity.sessionId);
	const ownerTerminalVerdict = context.ownerTerminal
		? await observeOwnerTerminalPostmortem(reason, context.ownerTerminal, identity.sessionId)
		: null;
	await serializeStateFileWrite(
		stateFile,
		async () =>
			await withCoordinatorTransactionLock(
				stateFile,
				async () =>
					await withStateFileLock(stateFile, async () => {
						assertNoRuntimeStateRescopeJournal(context, identity);
						const previous = readPreviousPayload(stateFile);
						assertPreviousRuntimeStateIdentity(previous, identity, stateFile);
						if (shouldPreserveTerminalPayload(previous as RuntimeStateSidecarPayload, identity)) return;
						// The immutable owner verdict remains in its lifecycle artifact; never replace a
						// complete agent terminal payload merely to mirror that verdict here.
						if (context.ownerTerminalMetadataInvalid) {
							await persistInvalidOwnerTerminalMetadata(
								reason,
								context,
								stateFile,
								identity.sessionId,
								previous,
							);
							return;
						}
						if (context.ownerTerminal) {
							await persistCoordinatorRuntimeStateFromOwnerTerminalPostmortem(
								context,
								stateFile,
								identity.sessionId,
								previous,
								ownerTerminalVerdict,
							);
							return;
						}
						const previousForDetails: RuntimeStateSidecarPayload =
							(previous as RuntimeStateSidecarPayload).state === "completed" ||
							(previous as RuntimeStateSidecarPayload).state === "errored"
								? { ...(previous as RuntimeStateSidecarPayload), state: "running" }
								: (previous as RuntimeStateSidecarPayload);
						const now = new Date().toISOString();
						const details = postmortemExitDetails(reason, previousForDetails, identity.cwd);
						const payload = {
							...basePayload({
								context,
								previous,
								state: details.state,
								now,
								source: "process_postmortem",
								event: "process_exit",
								reason: details.reason,
								sessionId: identity.sessionId,
							}),
							ended_at: now,
							detected_at: now,
							exit_kind: details.exitKind,
							exit_code: details.exitCode,
							signal: details.signal,
							...(details.error ? { error: details.error } : {}),
							...(details.recovery ? { recovery: details.recovery } : {}),
							previous_runtime_state: typeof previous.state === "string" ? previous.state : null,
							prompt_accepted: details.promptAccepted,
							observed_recoverable_worktree_changes: details.observedRecoverableWorktreeChanges,
							worktree_baseline_dirty: details.worktreeBaselineDirty,
							worktree_changed_since_baseline: details.worktreeChangedSinceBaseline,
						};
						await writeStateFileSync(stateFile, payload);
					}),
			),
	).catch(error => {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			try {
				fsSync.lstatSync(ownerSessionRoot);
			} catch (rootError) {
				if ((rootError as NodeJS.ErrnoException).code === "ENOENT") return;
			}
		}
		throw error;
	});
}

export function registerCoordinatorRuntimeStateFinalizer(
	context: RuntimeStateContext,
	resolveContext?: () => RuntimeStateContext,
): () => void {
	if (!runtimeStateFileForContext(context)) return () => {};
	return postmortem.register("coordinator-runtime-state", async reason => {
		const liveContext = resolveContext?.() ?? context;
		const ownerTerminal = ownerTerminalContextFromEnvironment();
		const finalizerContext: RuntimeStateContext =
			ownerTerminal === "invalid"
				? { ...liveContext, ownerTerminalMetadataInvalid: true }
				: ownerTerminal
					? { ...liveContext, ownerTerminal }
					: liveContext;
		await recoverCoordinatorRuntimeStateRescope(finalizerContext);
		await persistCoordinatorRuntimeStateFromPostmortem(reason, finalizerContext);
	});
}
