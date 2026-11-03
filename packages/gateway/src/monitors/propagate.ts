import {
	CATCH_ALL_EVENT_ORIGIN,
	type ChatMessagePayload,
	eventTypeOrigin,
	isSilentOutput,
	type MonitorEventOperatorResult,
	type MonitorEventRecord,
	type MonitorRecord,
	monitorSessionOrigin,
	type OriginRef,
	originKey,
	type ProtocolFailureReason,
} from "@gajae-gateway/protocol";
import { envelopeErrorCode, GjcCliError, type StatusReport } from "@gajae-gateway/subsession";
import type { GjcModelSelection, GjcServiceTier } from "../config";
import type { DeliveryService } from "../delivery/delivery";
import type { MemoryClosureQueue } from "../memory/closure";
import { oversizedMemoryFiles } from "../memory/debloat";
import { sanitizeDiagnostic, sanitizeDiagnosticDetail } from "../orchestrator/rebind";
import {
	isSessionBusy,
	LastAssistantUnreadableError,
	type SessionPort,
	SessionRequestTimeoutError,
	SessionTerminalError,
	sessionRequestStep,
	type WorkerOutputResult,
} from "../orchestrator/session-port";
import { RelayClosedError, RelayHelloError, RelayRefusedError } from "../orchestrator/tail-runner";
import { BrokerAuthorityError, type Store } from "../store";
import {
	MONITOR_EVENT_MAX_DISPATCH_ATTEMPTS,
	MONITOR_EVENT_MAX_OPEN_AGE_MS,
	MONITOR_EVENT_RETRY_BACKOFF_MS,
	type MonitorEventDbRow,
	RECONCILABLE_STAGES,
	TERMINAL_STAGES,
} from "../store/groups/monitors";
import type { WriteTx } from "../store/tx";
import {
	type AuthoringFailureClass,
	buildMonitorCompactionDigest,
	type CompactionPort,
	classifyAuthoringFailure,
	classifyExecutorFailure,
	classifyProtocolFailure,
	decideSessionRoll,
	type ExecutorFailureReason,
	isAsideTimeoutFailure,
	isAuthoredEchoSuspected,
	isOrphanedExecutorFailure,
	MONITOR_BUSY_FAILURE_ROLL_THRESHOLD,
	MONITOR_CONTEXT_FAILURE_ROLL_THRESHOLD,
	MONITOR_DIGEST_MAX_NOTES,
	MONITOR_PRIOR_RUN_BUSY_FAILURE_ROLL_THRESHOLD,
	MONITOR_PROTOCOL_FAILURE_ROLL_THRESHOLD,
	type MonitorDigestNote,
	type NativeCompactionStatus,
	type SessionRollReason,
	unavailableCompactionPort,
} from "./compaction";
import { readMonitorProcedure } from "./procedure";
import type { MonitorRegistry } from "./registry";

/** Candidate notes read per digest slot, so skipped echo/silent notes do not starve the digest. */
const DIGEST_NOTE_SCAN_FACTOR = 4;

export const MONITOR_REPORT_MESSAGE_ID_PREFIX = "monitor-report:";

/** Product-level semantics for the seeded maintenance events (generic, persona-independent). */
const MAINTENANCE_GUIDANCE: Record<string, string | undefined> = {
	"memory.canonicalize":
		"For memory.canonicalize events: read the memory tree's daily/ captures, append the durable facts into their canonical axis files (people/ projects/ decisions/ events/ tasks/ channels/ ops/ reflections/ plus any axis registered in the corpus's axes.json), keep every original byte (never delete or summarize-replace, move stray root files into an axis directory with their raw content preserved), and make new files reachable from MEMORY.md. ops/ holds repeatable operating rules, runtime/session/tool procedure, principles distilled from failure, and state the next executor picks up; it is routable, so write into ops/rules/, ops/distillations/ or ops/handoffs/ and never one growing file, and never put raw transcript, secrets or dated small talk there. reflections/ holds what you learned about your own behaviour as dated append-only entries named reflections/YYYY-MM-DD.md (several entries per day are fine, per-subject files are not); each entry records source/time, the observed failure or drift, the invariant learned, why it matters, the concrete next action, and its promotion target - an operating invariant promotes to ops/rules, a cross-incident learning to ops/distillations, and a project or person correction to that axis. ops constrains what to do before acting; decisions/ records what was chosen at a point in time and why. Metadata for the graph: give each canonical file YAML frontmatter with `aliases:` (Korean AND romanized name pairs - a matcher that only knows one script misses the other) and `tags:` (a few stable topic labels; tags power retrieval boosts and Obsidian tag groups). The mechanical crosslinking itself is deterministic: run `gajaeway memory autolink` at the end of your pass - it wraps the first mention of every aliased canonical file in a relative link without touching any other byte. You may still hand-link where judgment is needed, and you may append `근거:`/`관련:` evidence lines at the END of a file when you personally know the causal source (never fabricate causality from date coincidence; existing wording stays untouched). The gateway commits; you only write files.",
	"memory.audit":
		"For memory.audit events: run the memory validator (gajaeway memory audit) and put a one-line pass report or the failure diagnostics plus your repair attempt into the note.",
	"memory.debloat":
		"For memory.debloat events: the payload lists every memory file larger than thresholdBytes in oversized (path, bytes); when oversized is empty the note is [SILENT]. Otherwise split each listed file into a routable structure under the same axis: a directory whose index.md holds only one-line pointers to topic- or date-sliced children, each under the threshold; an index.md that is itself listed is split the same way into sub-directories with their own index.md, so indexes nest instead of growing flat; preserve every original byte (move, never summarize-replace or delete), repoint every link to the moved content and keep it reachable from MEMORY.md, never hand-edit generated surfaces, then run the memory validator (gajaeway memory audit) and report each split file with its new layout plus the audit result.",
};

/** First line of every monitor authoring prompt: execute before reporting. */
export const MONITOR_AUTHORING_HEADER =
	"Monitor events fired. Do the work they call for now, using your tools, before you reply.";
/** The report rule that precedes the JSON response contract. */
export const MONITOR_AUTHORING_REPORT_RULE =
	"Report only after the work is done. Each note states what you actually did and found: commands run, files changed, commits, links, results. A note that restates the task instead of reporting results is rejected and not delivered.";

/**
 * The authoring turn prompt. Execution comes first and the JSON report last:
 * when the response format led ("Author monitor events ... Respond ONLY with
 * JSON"), sessions answered the format without doing the work and restated
 * the instruction as the note (#369). The event array stays the final
 * segment of the prompt.
 */
export function buildMonitorAuthoringPrompt(input: {
	readonly guidance?: string;
	readonly procedure?: string;
	readonly digest?: string;
	readonly events: readonly { readonly eventId: string; readonly eventType: string; readonly payload: unknown }[];
}): string {
	const lines = [MONITOR_AUTHORING_HEADER];
	if (input.guidance) lines.push(`Task: ${input.guidance}`);
	if (input.procedure) lines.push(input.procedure);
	if (input.digest) lines.push(input.digest);
	lines.push(
		MONITOR_AUTHORING_REPORT_RULE,
		`Respond ONLY with a JSON array containing exactly one {"eventId","note"} entry per event: ${JSON.stringify(input.events)}`,
	);
	return lines.join("\n");
}

/** Stable, public-safe dispatch failure codes. */
type DispatchFailureCode =
	| "session_bind_failed"
	| "authoring_turn_failed"
	// The runtime still had a turn running on the authoring session after the
	// bounded busy wait. Nothing was sent; the event is replayed as-is.
	| "session_busy"
	// Context-class authoring failure: empty response, context-length rejection
	// or a zero-token completion. Distinct from `authoring_response_invalid`
	// because only this class is evidence that compaction did not happen.
	| "authoring_context_exhausted"
	| "authoring_response_invalid"
	// Executor-class: the aside collection worker hit its 300s cap. Its own code
	// so it can never be read as, or aggregated with, context exhaustion.
	| "aside_timeout"
	// Executor-class: the child process died on the wrapper's timeout while the
	// external daemon's work kept running, so the next tick stacks a duplicate.
	// Its own code because the operator action is "reclaim the external
	// executor", not anything to do with this session.
	| "orphaned_executor"
	// Executor-class: a worker timeout, external tool failure or lock skip that
	// is neither the aside worker nor an orphaned external run.
	| "executor_failed"
	| "delivery_prepare_failed"
	// The gateway stopped while this attempt's authoring turn was still in
	// flight (#225). Recoverable: the lease is released at once so the next boot
	// re-dispatches instead of waiting for the lease to expire, and the failure
	// row names the session whose host may have outlived the gateway.
	| "gateway_shutdown"
	| "session_host_unavailable"
	// The runtime accepted the prompt but no agent run ever started (`phase=submission`
	// with an agent-runtime cause), or gjc returned its exact prior-run-busy terminal
	// failure. Nothing was sent and the event replays cleanly on the fresh session.
	| "session_submission_wedged"
	| "authoring_result_unreadable"
	| "broker_authority_refused"
	| "event_type_invalid"
	| "monitor_invalid"
	| "internal_error";

/**
 * Failures that say nothing about the dispatch path, so the #179 retry backoff
 * does not apply: `session_busy` and the classified prior-run-busy terminal
 * failure sent nothing (and the roll moves the next attempt to a fresh session),
 * while `gateway_shutdown` was this process's own stop (#225: the next boot
 * re-dispatches at once). All still consume the dispatch budget.
 */
const BACKOFF_EXEMPT_FAILURES: ReadonlySet<string> = new Set<DispatchFailureCode>([
	"session_busy",
	"gateway_shutdown",
	"session_host_unavailable",
	"session_submission_wedged",
]);

/**
 * How long shutdown waits for in-flight authoring turns before marking them
 * interrupted. The monitor and persona drains run concurrently; together with
 * the 5s connection settle this keeps an ordered stop inside a 40s
 * `TimeoutStopSec` (#225).
 */
export const MONITOR_SHUTDOWN_DRAIN_MS = 10_000;

/** A live dispatch claim, so a bounded shutdown can fail and release exactly what this process holds. */
interface LiveClaim {
	readonly leaseId: string;
	readonly batchId: string;
	readonly origin: string;
	readonly attempt: number;
	readonly phase: () => string;
	readonly sessionId: () => string | undefined;
}

interface AuthoringTurnPointer {
	readonly sessionId: string;
	readonly opRef: string;
	readonly eventIds: readonly string[];
}

type ExhaustedTurnDisposition =
	| { readonly kind: "terminal"; readonly raw: string | undefined }
	// `running`: the runtime positively reports the turn accepted or in flight; it
	// holds until there is termination evidence. `unresolved`: nothing proves the
	// turn is running or readable, so the hold is bounded by its age (#702).
	| { readonly kind: "hold"; readonly reason: "running" | "unresolved" }
	| { readonly kind: "resume"; readonly turn: AuthoringTurnPointer }
	| { readonly kind: "monitor_invalid"; readonly raw: string };

/**
 * The saved authoring turn's own result (`turn.result` by clientRef) is not
 * readable. Never inferred from the session's latest assistant message, which a
 * later turn in the same session may already have replaced (#702).
 */
class AuthoringResultUnavailableError extends Error {
	readonly code: Exclude<WorkerOutputResult, { status: "proven" }>["code"];
	constructor(code: Exclude<WorkerOutputResult, { status: "proven" }>["code"]) {
		super(`authoring turn result unavailable (${code})`);
		this.name = "AuthoringResultUnavailableError";
		this.code = code;
	}
}

export interface MonitorDispatchFailure {
	readonly eventId: string;
	readonly code: DispatchFailureCode;
}

/**
 * Observable safety-net state for one monitor session origin (issue #68).
 *
 * `turns` is recorded but never a roll trigger — it exists so an operator can
 * see how long a session has been alive next to the failure evidence.
 */
export interface MonitorSessionSafetyState {
	/** Authoring turns taken in the current epoch. OBSERVATIONAL ONLY. */
	turns: number;
	/**
	 * Consecutive context-class authoring failures attributable to the CURRENT
	 * session, with no answered turn since. Reset by any non-empty answer and by
	 * a roll. This is the only counter the roll decision reads.
	 */
	contextFailures: number;
	/**
	 * Context-class failures that were NOT counted because they came from a
	 * stale or replayed event, or from a dead epoch (diagnostic). A dead
	 * session's failures must never roll its successor.
	 */
	staleContextFailures: number;
	/** Executor-class failures in this epoch — timeouts, tools, locks (diagnostic). */
	executorFailures: number;
	/**
	 * Executor-class failures that left external work running behind a dead
	 * child (diagnostic). Never part of the context streak: the session is fine,
	 * the external executor is not.
	 */
	orphanedExecutorFailures: number;
	/**
	 * Coded reason of the last executor-class failure. Survives a roll on
	 * purpose: an unreclaimed external executor is not fixed by rolling a
	 * session, so the signal must not be wiped by one.
	 */
	lastExecutorReason: ExecutorFailureReason | undefined;
	/** Protocol-class failures in this epoch — malformed or off-contract answers (diagnostic). */
	protocolFailures: number;
	/**
	 * Coded reason of the last protocol-class failure. The offending answer text
	 * is never logged (it can carry secrets), so this coded rule name is the only
	 * diagnosis an operator gets — without it, an off-contract session is
	 * indistinguishable from any other invalid answer (measured: jip-gajae
	 * `sns-threads`, 19 identical failures in one day).
	 */
	lastProtocolReason: ProtocolFailureReason | undefined;
	/**
	 * Consecutive `session_busy` dispatch failures in this epoch: the runtime
	 * never went idle for a whole bounded busy wait. Reset by any other outcome.
	 * A streak is a stalled session, and the only remedy is a new one (#263).
	 */
	busyFailures: number;
	/**
	 * Session id captured when a busy roll was armed: the host to end at the
	 * roll boundary. Taken from the bind, not the sessions row, because a
	 * session that never finished a turn has no row yet.
	 */
	stalledSessionId: string | undefined;
	/** Consecutive exact `sdk_prompt_terminal_failed` prior-run-busy failures in this epoch. */
	priorRunBusyFailures: number;
	/** Result of the last native-compaction attempt, or undefined if never attempted. */
	nativeCompaction: NativeCompactionStatus | undefined;
	/** Armed roll: consumed at the next dispatch boundary. */
	pendingRoll: SessionRollReason | undefined;
	/** Reason of the last roll actually performed. */
	lastRoll: SessionRollReason | undefined;
}

export class MonitorPropagator {
	readonly #database: Store;
	readonly #registry: MonitorRegistry;
	readonly #sessionPort: SessionPort;
	readonly #memory: MemoryClosureQueue;
	readonly #delivery: DeliveryService;
	readonly #emit: (event: MonitorEventRecord) => void;
	readonly #ownerTarget: { readonly origin: OriginRef } | undefined;
	readonly #deliver: ((payload: ChatMessagePayload) => void) | undefined;
	readonly #notifyInbound: ((originKey: string) => Promise<void>) | undefined;
	readonly #onReadinessFailure:
		| ((input: {
				readonly code: string;
				readonly detail: string;
				readonly originKey: string;
				readonly at: number;
		  }) => void)
		| undefined;
	readonly #onReadinessSuccess: ((input: { readonly originKey: string; readonly at: number }) => void) | undefined;
	readonly #now: () => number;
	readonly #acquireLease: (eventId: string, owner: string, leaseId: string, ttlMs: number, now: number) => boolean;
	readonly #fencedUpdate: (eventId: string, leaseId: string, batchId: string, now: number) => boolean;
	#batches = new Map<string, { eventIds: string[]; timer: ReturnType<typeof setTimeout> }>();
	/** Event ids this process is dispatching right now, so reconcile never double-runs them. */
	#inFlight = new Set<string>();
	/** Re-entrancy guard: only one reconcile sweep may run at a time in this process. */
	#reconciling = false;
	/** In-flight dispatch promises per event, for awaitable submission. */
	#inFlightPromises = new Map<string, Promise<void>>();
	/** Lease/batch identity per event this process is authoring right now. */
	#claims = new Map<string, LiveClaim>();
	#closing = false;
	/** Per-origin serialization lives in SessionPort, shared with all SDK callers. */
	readonly #repo: string;
	readonly #memoryDebloat: { readonly root: string; readonly thresholdBytes: number } | undefined;
	readonly #model: GjcModelSelection | undefined;
	readonly #serviceTier: GjcServiceTier | undefined;
	readonly #appliedModels = new Map<string, string>();
	readonly #appliedServiceTiers = new Map<string, GjcServiceTier>();
	/**
	 * Per-session-origin safety-net state (issue #68). Process-local on purpose:
	 * it is evidence about the CURRENT live session, and a restart mints a fresh
	 * bind anyway, so persisting it would only carry a stale verdict forward.
	 */
	readonly #safety = new Map<string, MonitorSessionSafetyState>();
	/** THE ONE seam that asks for native compaction. */
	readonly #compaction: CompactionPort;
	/** Consecutive context-class authoring failures required before a roll. */
	readonly #contextFailureRollThreshold: number;
	/** Consecutive protocol-class (off-contract) failures required before a roll. */
	readonly #protocolFailureRollThreshold: number;
	constructor(options: {
		database: Store;
		registry: MonitorRegistry;
		sessionPort: SessionPort;
		memory: MemoryClosureQueue;
		delivery: DeliveryService;
		emit: (event: MonitorEventRecord) => void;
		/** Default recipient for monitors without their own channel target. */
		ownerTarget?: { readonly origin: OriginRef };
		/** Broadcasts a prepared chat.message to live adapter connections. */
		deliver?: (payload: ChatMessagePayload) => void;
		/** Wakes the persona actor after a durable monitor report is enqueued. */
		notifyInbound?: (originKey: string) => Promise<void>;
		/** Reports a monitor dispatch failure to process-local functional readiness. */
		onReadinessFailure?: (input: {
			readonly code: string;
			readonly detail: string;
			readonly originKey: string;
			readonly at: number;
		}) => void;
		/** Reports successful monitor dispatches that require no adapter delivery. */
		onReadinessSuccess?: (input: { readonly originKey: string; readonly at: number }) => void;
		/** Workspace used for broker-session creation and all SDK queries. */
		repo?: string;
		/** Memory corpus scanned for `memory.debloat` events, and the byte size a file must exceed. */
		memoryDebloat?: { readonly root: string; readonly thresholdBytes: number };
		/** Model/preset and request tier applied to dedicated monitor authoring sessions. */
		model?: GjcModelSelection;
		serviceTier?: GjcServiceTier;
		/** Injectable clock for deterministic lease expiry/renewal in tests. */
		now?: () => number;
		/**
		 * Injectable lease-acquire (test/ops seam): defaults to the durable DB
		 * claim. Tests may wrap it to force deterministic claim outcomes while
		 * keeping the production dispatch path identical.
		 */
		acquireLease?: (eventId: string, owner: string, leaseId: string, ttlMs: number, now: number) => boolean;
		/** Injectable fenced-batching seam (tests): defaults to the durable fenced update. */
		fencedUpdate?: (eventId: string, leaseId: string, batchId: string, now: number) => boolean;
		/** Native-compaction seam. Defaults to the honest `unavailable` port. */
		compaction?: CompactionPort;
		/**
		 * Consecutive context-class authoring failures required before the
		 * safety net rolls a session. Config-supplied
		 * (`monitorContextFailureRollThreshold`); defaults to
		 * MONITOR_CONTEXT_FAILURE_ROLL_THRESHOLD.
		 */
		contextFailureRollThreshold?: number;
		/**
		 * Consecutive protocol-class failures required before the safety net rolls
		 * a session that keeps answering off contract. Defaults to
		 * MONITOR_PROTOCOL_FAILURE_ROLL_THRESHOLD.
		 */
		protocolFailureRollThreshold?: number;
	}) {
		this.#database = options.database;
		this.#model = options.model;
		this.#serviceTier = options.serviceTier;
		this.#registry = options.registry;
		this.#sessionPort = options.sessionPort;
		this.#memory = options.memory;
		this.#delivery = options.delivery;
		this.#emit = options.emit;
		this.#ownerTarget = options.ownerTarget;
		this.#deliver = options.deliver;
		this.#notifyInbound = options.notifyInbound;
		this.#onReadinessFailure = options.onReadinessFailure;
		this.#onReadinessSuccess = options.onReadinessSuccess;
		this.#now = options.now ?? (() => Date.now());
		this.#acquireLease =
			options.acquireLease ??
			((eventId, owner, leaseId, ttlMs, at) =>
				this.#database.transaction((tx) =>
					this.#database.monitors.eventAcquireLease(tx, eventId, owner, leaseId, ttlMs, at),
				));
		this.#fencedUpdate =
			options.fencedUpdate ??
			((eventId, lease, batch, at) =>
				this.#database.transaction((tx) =>
					this.#database.monitors.eventFencedUpdate(tx, eventId, lease, "batched", batch, at),
				));
		this.#compaction = options.compaction ?? unavailableCompactionPort;
		this.#contextFailureRollThreshold = options.contextFailureRollThreshold ?? MONITOR_CONTEXT_FAILURE_ROLL_THRESHOLD;
		this.#protocolFailureRollThreshold =
			options.protocolFailureRollThreshold ?? MONITOR_PROTOCOL_FAILURE_ROLL_THRESHOLD;
		this.#repo = options.repo ?? process.cwd();
		this.#memoryDebloat = options.memoryDebloat;
	}

	/**
	 * Event payload as the authoring turn sees it. A `memory.debloat` event is
	 * scanned at dispatch, not at fire, so the list reflects the corpus the turn
	 * will actually edit and the cron tick never blocks on a tree walk.
	 */
	async #authoringPayload(row: { readonly event_type: string; readonly payload_json: string }): Promise<unknown> {
		const payload = JSON.parse(row.payload_json);
		if (row.event_type !== "memory.debloat" || !this.#memoryDebloat) return payload;
		const { root, thresholdBytes } = this.#memoryDebloat;
		return { ...payload, thresholdBytes, oversized: await oversizedMemoryFiles(root, thresholdBytes) };
	}
	/** Cancels pending burst timers so no new dispatch starts during shutdown. */
	dispose(): void {
		this.#closing = true;
		for (const batch of this.#batches.values()) clearTimeout(batch.timer);
		this.#batches.clear();
	}
	/**
	 * Waits for live dispatch and reconcile writers before the database closes,
	 * for at most `timeoutMs`. An authoring turn can legitimately run for many
	 * minutes, and a stop that waits for it is SIGKILLed by the service manager
	 * with nothing recorded (#225). Past the deadline every claim this process
	 * still holds is failed as `gateway_shutdown` and its lease released, so the
	 * event is recoverable state for the next boot's reconcile and the stale
	 * attempt's later writes are fenced out.
	 */
	async drain(timeoutMs = MONITOR_SHUTDOWN_DRAIN_MS): Promise<void> {
		this.dispose();
		const deadline = this.#now() + Math.max(0, timeoutMs);
		while (this.#reconciling || this.#inFlightPromises.size > 0) {
			const remaining = deadline - this.#now();
			if (remaining <= 0) {
				this.#interruptClaims();
				return;
			}
			const active = [...new Set(this.#inFlightPromises.values())];
			await Promise.race([Promise.all(active), Bun.sleep(Math.min(remaining, 50))]);
		}
	}
	#interruptClaims(): void {
		const now = this.#now();
		const stoppedAt = new Date(now).toISOString();
		for (const [eventId, claim] of this.#claims) {
			const sessionId = claim.sessionId();
			const evidence = JSON.stringify({
				phase: claim.phase(),
				sessionId: sessionId ?? null,
				origin: claim.origin,
				attempt: claim.attempt,
				stoppedAt,
			});
			this.#database.transaction((tx) => {
				this.#database.monitors.eventFencedFail(
					tx,
					eventId,
					claim.leaseId,
					claim.batchId,
					"gateway_shutdown",
					`dispatch interrupted by gateway shutdown (gateway_shutdown): the authoring turn was still in flight when the gateway stopped at ${stoppedAt}; its session host may outlive this process ${evidence}`,
					now,
				);
				this.#database.monitors.eventReleaseLease(tx, eventId, claim.leaseId);
			});
			console.error(`monitor dispatch interrupted by shutdown: event ${eventId} session=${sessionId ?? "unbound"}`);
		}
		this.#claims.clear();
	}
	submit(monitorId: string, eventType: string, payload: unknown): string {
		if (this.#closing) throw new Error("monitor propagator is closing");
		const monitor = this.#registry.get(monitorId);
		if (!monitor?.enabled) throw new Error("unknown or disabled monitor");
		if (typeof eventType !== "string" || !eventType) throw new Error("event type is required");
		const eventId = crypto.randomUUID();
		const firedAt = new Date().toISOString();
		const skippedBy = this.#database.transaction((tx) =>
			this.#database.monitors.eventCreate(tx, {
				eventId,
				monitorId,
				eventType,
				payloadJson: JSON.stringify(payload ?? null),
				firedAt,
				overlap: monitor.overlap,
			}),
		);
		if (skippedBy) {
			this.#noteSkipped({ eventId, monitorId, eventType, firedAt }, skippedBy);
			return eventId;
		}
		this.#emit({ eventId, monitorId, eventType, firedAt, stage: "admitted" });
		const key = `${monitorId}\u0000${eventType}`;
		if (monitor.burstPolicy === "serialize") {
			void this.#dispatch([eventId]);
			return eventId;
		}
		const previous = this.#batches.get(key);
		if (previous) {
			if (monitor.burstPolicy === "drop") previous.eventIds.splice(0, previous.eventIds.length, eventId);
			else if (monitor.burstPolicy === "dedupe") {
				const seen = previous.eventIds.some(
					(id) => this.#database.monitors.eventGet(id)?.payload_json === JSON.stringify(payload ?? null),
				);
				if (!seen) previous.eventIds.push(eventId);
				else this.#database.transaction((tx) => this.#database.monitors.eventUpdate(tx, eventId, "batched", "deduped"));
			} else previous.eventIds.push(eventId);
			return eventId;
		}
		const batch = {
			eventIds: [eventId],
			timer: setTimeout(() => {
				this.#batches.delete(key);
				void this.#dispatch(batch.eventIds);
			}, 250),
		};
		this.#batches.set(key, batch);
		return eventId;
	}
	/**
	 * Awaitable submission (bounded test/ops seam): performs the SAME admission
	 * and burst/dispatch semantics as submit(), but resolves when THIS event's
	 * dispatch chain has fully settled — the exact original promise, never a
	 * second dispatch.
	 */
	async submitAwaitable(monitorId: string, eventType: string, payload: unknown): Promise<string> {
		const monitor = this.#registry.get(monitorId);
		if (!monitor?.enabled) throw new Error("unknown or disabled monitor");
		// Honest contract: this seam is only exact for `serialize` monitors, whose
		// dispatch starts immediately — the returned promise is the event's real
		// in-flight chain. For burst policies (coalesce/dedupe/drop) the dispatch
		// is deferred by the burst window, so no in-flight promise exists yet;
		// fail loudly instead of pretending to be awaitable.
		if (monitor.burstPolicy !== "serialize") {
			throw new Error("submitAwaitable only supports burstPolicy 'serialize'");
		}
		const eventId = this.submit(monitorId, eventType, payload);
		const inflight = this.#inFlightPromises.get(eventId);
		if (!inflight) throw new Error("dispatch promise missing for serialize event");
		await inflight;
		return eventId;
	}
	/**
	 * Cron slot admission (red-team blockers 2+3): the slot claim and the event
	 * row are created in ONE transaction, and the event's `fired_at` IS the
	 * exact scheduled slot timestamp — the durable record carries the scheduled
	 * identity, not just the payload. Returns the eventId, or null when the
	 * slot was already claimed (duplicate tick / restart catch-up overlap).
	 */
	submitSlot(monitorId: string, eventType: string, payload: unknown, slotAt: Date): string | null {
		const monitor = this.#registry.get(monitorId);
		if (!monitor?.enabled) throw new Error("unknown or disabled monitor");
		// Round-4 blocker 4: a monitor must never backfill slots scheduled before
		// it existed — catch-up admission is clamped to monitor.createdAt.
		if (slotAt.getTime() < Date.parse(monitor.createdAt)) return null;
		const eventId = crypto.randomUUID();
		const claim = this.#database.transaction((tx) =>
			this.#database.monitors.slotClaimWithEvent(tx, {
				monitorId,
				slotAt: slotAt.toISOString(),
				eventId,
				eventType,
				payloadJson: JSON.stringify(payload ?? null),
				overlap: monitor.overlap,
			}),
		);
		if (!claim.admitted) return null;
		if (claim.skippedBy) {
			this.#noteSkipped({ eventId, monitorId, eventType, firedAt: slotAt.toISOString() }, claim.skippedBy);
			return eventId;
		}
		this.#emit({ eventId, monitorId, eventType, firedAt: slotAt.toISOString(), stage: "admitted" });
		const key = `${monitorId}\u0000${eventType}`;
		if (monitor.burstPolicy === "serialize") {
			void this.#dispatch([eventId]);
			return eventId;
		}
		const previous = this.#batches.get(key);
		if (previous) {
			if (monitor.burstPolicy === "drop") previous.eventIds.splice(0, previous.eventIds.length, eventId);
			else previous.eventIds.push(eventId);
			return eventId;
		}
		const batch = {
			eventIds: [eventId],
			timer: setTimeout(() => {
				this.#batches.delete(key);
				void this.#dispatch(batch.eventIds);
			}, 250),
		};
		this.#batches.set(key, batch);
		return eventId;
	}
	/**
	 * Overlap policy `skip` (issue #83): the fire lost its slot to a predecessor
	 * that still owes an authoring turn. It is recorded terminal `skipped` and
	 * never dispatched. It is a scheduling outcome, not a dispatch failure, so it
	 * writes no monitor_failures row.
	 */
	#noteSkipped(
		event: { eventId: string; monitorId: string; eventType: string; firedAt: string },
		skippedBy: string,
	): void {
		this.#emit({ ...event, stage: "skipped" });
		console.error(
			`monitor event skipped (overlap=skip): event ${event.eventId} of monitor ${event.monitorId}; event ${skippedBy} is still in flight`,
		);
	}
	/**
	 * Recovery sweep. Oldest-first, at-most-one concurrent sweep per process:
	 * - `batched` rows not in this process's in-flight set are orphans of a dead
	 *   dispatch and are reclaimed exactly like `admitted`/`dispatched`/`failed`
	 *   (the fix for issue #29's stranded canonicalize events).
	 * - events with an authored output but no memory intent get their memory
	 *   closure re-enqueued (a crash between authoring and enqueue).
	 * - terminal rows are skipped.
	 * The reclaim budget (MONITOR_EVENT_MAX_DISPATCH_ATTEMPTS) bounds retries:
	 * an event that keeps failing lands on `failed_no_retry` — operator-visible,
	 * never an infinite dispatch loop. `failed` rows are reclaimed on the
	 * MONITOR_EVENT_RETRY_BACKOFF_MS schedule, so the budget spans hours rather
	 * than five consecutive sweeps (#179); BACKOFF_EXEMPT_FAILURES retry at once.
	 */
	async reconcile(): Promise<void> {
		this.reapStale();
		if (this.#reconciling) {
			// Yield once so a caller racing the first sweep observes its claimed work
			// rather than an artificial pre-bind microtask gap in the shared port.
			await Bun.sleep(0);
			return;
		}
		this.#reconciling = true;
		try {
			// Legacy split-state repair: a crash between ledger confirm and batch
			// settlement (pre-atomic path) can leave confirmed deliveries with
			// authored events. Repair them deterministically on startup.
			// Driven from the stranded `authored` rows, so the pass costs the size of
			// the stranded set rather than the whole delivery history.
			for (const delivery of this.#database.outbox.terminalForTurns(this.#database.monitors.authoredBatchIds())) {
				// Events stranded `authored` behind a delivery that expired before #94
				// settle terminally with evidence.
				if (delivery.state === "expired") {
					this.#database.transaction((tx) => {
						const current = this.#database.outbox.get(delivery.delivery_id);
						if (current?.state !== "expired") return;
						this.#database.monitors.eventsFailExpiredDelivery(
							tx,
							current.turnId,
							current.deliveryId,
							current.attempts,
							"expired_before_settlement",
						);
					});
					continue;
				}
				const batch = this.#database.monitors.eventsByBatch(delivery.turn_id);
				if (!batch.some((row) => row.stage === "authored")) continue;
				this.#database.transaction((tx) => {
					for (const row of batch)
						if (row.stage === "authored") this.#database.monitors.eventUpdate(tx, row.event_id, "delivered");
				});
			}
			await this.#recoverUnresolvedTurns();
			// Replay oldest-first: recovery must re-author events in the order they fired.
			const resumedAuthoringEvents = new Set<string>();
			for (const candidate of this.#database.monitors.eventsOpen()) {
				if (resumedAuthoringEvents.has(candidate.event_id)) continue;
				const row = this.#database.monitors.eventGet(candidate.event_id);
				if (!row) continue;
				// A closing propagator starts no new dispatch: the rows stay recoverable
				// for the next boot's sweep instead of being claimed by a dying process.
				if (this.#closing) break;
				if ((TERMINAL_STAGES as readonly string[]).includes(row.stage)) continue;
				const output = this.#database.monitors.authoredOutput(row.event_id);
				const hasMemory = this.#database.memory.coversEvent(row.event_id);
				// A silent note is never delivered, so `authored` would wait forever for a
				// confirmation that cannot come (#94): settle it as authored_no_delivery.
				if (output && !hasMemory)
					this.#author(row.event_id, output, row.stage === "authored_no_delivery" || isSilentOutput(output), row);
				else if (output && row.stage === "authored" && isSilentOutput(output))
					this.#database.transaction((tx) =>
						this.#database.monitors.eventUpdate(tx, row.event_id, "authored_no_delivery"),
					);
				else if (!output && this.#recoverable(row)) {
					// Red-team blocker 1: a live dispatch lease owned by ANOTHER attempt
					// means the authoring turn may still complete elsewhere; a new
					// process must not re-author concurrently. Only unclaimed events
					// are reclaimed here (the dispatcher acquires its own lease).
					if (this.#database.monitors.eventLiveLeaseOwner(row.event_id, this.#now())) continue;
					if (row.dispatch_attempts >= MONITOR_EVENT_MAX_DISPATCH_ATTEMPTS) {
						// Exhausting dispatch attempts does not settle the turn they may have started.
						const disposition = await this.#exhaustedTurnDisposition(row);
						if (disposition.kind === "hold") {
							// Bound the unresolved hold (#702). The authoring-turn pointer exempts this
							// event from supersession and from the stale reaper, and overlap=skip counts
							// it in flight, so a status nobody can resolve (unknown, a throwing read, a
							// pointer that no longer matches, an unreadable result) would silence the
							// monitor forever. Past MONITOR_EVENT_MAX_OPEN_AGE_MS it is given up: settled
							// failed_no_retry with evidence, never redispatched or resent. The pointer is
							// kept: #recoverUnresolvedTurns reopens the whole batch once that operation's
							// own result becomes readable. A turn the runtime reports accepted or in
							// flight is never aged out: it keeps its overlap protection until it ends.
							if (
								disposition.reason === "unresolved" &&
								this.#now() - Date.parse(row.updated_at) > MONITOR_EVENT_MAX_OPEN_AGE_MS
							) {
								const settled = this.#database.transaction((tx) => {
									const current = this.#database.monitors.eventGet(row.event_id);
									if (
										!current ||
										(TERMINAL_STAGES as readonly string[]).includes(current.stage) ||
										current.dispatch_attempts !== row.dispatch_attempts ||
										current.updated_at !== row.updated_at ||
										this.#database.monitors.authoredOutput(row.event_id) !== undefined ||
										this.#database.core.metaGet(authoringTurnKey(row.event_id)) === undefined ||
										this.#database.monitors.eventLiveLeaseOwner(row.event_id, this.#now())
									)
										return undefined;
									if (
										!this.#database.monitors.eventTerminalFail(
											tx,
											row.event_id,
											AUTHORING_TURN_UNRESOLVED,
											`authoring turn unresolved after ${Math.round((this.#now() - Date.parse(row.updated_at)) / 1000)}s; pointer kept, the batch reopens if its own result becomes readable (#702)`,
										)
									)
										return undefined;
									return current;
								});
								if (settled) this.#emitStage(settled, "failed_no_retry");
							}
							continue;
						}
						if (disposition.kind === "resume") {
							for (const eventId of disposition.turn.eventIds) resumedAuthoringEvents.add(eventId);
							await this.#dispatch([...disposition.turn.eventIds], disposition.turn);
							continue;
						}
						if (disposition.kind === "monitor_invalid") {
							const failedRow = this.#database.transaction((tx) => {
								const current = this.#database.monitors.eventGet(row.event_id);
								if (
									!current ||
									this.#database.core.metaGet(authoringTurnKey(row.event_id)) !== disposition.raw ||
									current.dispatch_attempts !== row.dispatch_attempts ||
									current.dispatch_attempts < MONITOR_EVENT_MAX_DISPATCH_ATTEMPTS ||
									(TERMINAL_STAGES as readonly string[]).includes(current.stage) ||
									this.#database.monitors.authoredOutput(row.event_id) !== undefined ||
									this.#database.monitors.eventLiveLeaseOwner(row.event_id, this.#now())
								)
									return undefined;
								if (
									!this.#database.monitors.eventTerminalFail(
										tx,
										row.event_id,
										"monitor_invalid",
										"dispatch setup failed (monitor_invalid)",
									)
								)
									return undefined;
								return current;
							});
							if (failedRow) this.#emitStage(failedRow, "failed_no_retry");
							continue;
						}
						const expectedRaw = disposition.kind === "terminal" ? disposition.raw : undefined;
						const failedRow = this.#database.transaction((tx) => {
							const current = this.#database.monitors.eventGet(row.event_id);
							if (
								!current ||
								this.#database.core.metaGet(authoringTurnKey(row.event_id)) !== expectedRaw ||
								current.dispatch_attempts !== row.dispatch_attempts ||
								current.dispatch_attempts < MONITOR_EVENT_MAX_DISPATCH_ATTEMPTS ||
								(TERMINAL_STAGES as readonly string[]).includes(current.stage) ||
								this.#database.monitors.authoredOutput(row.event_id) !== undefined ||
								this.#database.monitors.eventLiveLeaseOwner(row.event_id, this.#now())
							)
								return undefined;
							this.#database.monitors.eventUpdate(tx, row.event_id, "failed_no_retry", null);
							this.#forgetAuthoringTurn(tx, [row.event_id], expectedRaw);
							return current;
						});
						if (failedRow) this.#emitStage(failedRow, "failed_no_retry");
						continue;
					}
					if (
						row.stage === "failed" &&
						this.#now() - Date.parse(row.updated_at) < (MONITOR_EVENT_RETRY_BACKOFF_MS[row.dispatch_attempts] ?? 0) &&
						!BACKOFF_EXEMPT_FAILURES.has(this.#database.monitors.failure(row.event_id)?.code ?? "")
					)
						continue;
					const eventIds = this.#savedBatch(row, resumedAuthoringEvents) ?? [row.event_id];
					for (const eventId of eventIds) resumedAuthoringEvents.add(eventId);
					this.#database.transaction((tx) => {
						for (const eventId of eventIds) this.#database.monitors.eventIncrementAttempts(tx, eventId);
					});
					await this.#dispatch(eventIds);
				}
			}
		} finally {
			this.#reconciling = false;
		}
	}

	/** End one recoverable event without discarding its saved authoring-turn pointer. */
	settle(eventId: string): MonitorEventOperatorResult {
		const result = this.#database.transaction((tx) =>
			this.#database.monitors.eventOperatorSettle(tx, eventId, this.#now()),
		);
		if (!result.settled) return { eventId, done: false, reason: result.reason };
		const row = this.#database.monitors.eventGet(eventId);
		if (row) this.#emitStage(row, "failed_no_retry");
		return { eventId, done: true, previousStage: result.previousStage };
	}

	/**
	 * Reset a failed event's reclaim budget and immediately run reconciliation.
	 * Batch-aware: the other failed events of its saved authoring turn are reset
	 * with it, so the retry can harvest that turn's result instead of authoring a
	 * lone event afresh.
	 */
	retry(eventId: string): MonitorEventOperatorResult {
		const { result, siblings } = this.#database.transaction((tx) => {
			const result = this.#database.monitors.eventOperatorRetry(tx, eventId, this.#now());
			const siblings: string[] = [];
			if (!result.retried) return { result, siblings };
			const raw = this.#database.core.metaGet(authoringTurnKey(eventId));
			const turn = raw === undefined ? undefined : parseAuthoringTurnPointer(raw);
			for (const sibling of turn?.eventIds ?? []) {
				if (sibling === eventId || this.#database.core.metaGet(authoringTurnKey(sibling)) !== raw) continue;
				if (this.#database.monitors.eventOperatorRetry(tx, sibling, this.#now()).retried) siblings.push(sibling);
			}
			return { result, siblings };
		});
		if (!result.retried) return { eventId, done: false, reason: result.reason };
		for (const id of [eventId, ...siblings]) {
			const row = this.#database.monitors.eventGet(id);
			if (row) this.#emitStage(row, "failed");
		}
		void this.reconcile().catch(() => console.error(`monitor retry reconcile failed: event ${eventId}`));
		return { eventId, done: true, previousStage: result.previousStage };
	}

	/** Reap stale open events while retaining any #508 authoring-turn pointer for recovery. */
	reapStale(): number {
		const now = this.#now();
		const cutoff = new Date(now - MONITOR_EVENT_MAX_OPEN_AGE_MS).toISOString();
		const rows = this.#database.transaction((tx) => this.#database.monitors.eventReapStale(tx, cutoff, now));
		for (const row of rows) this.#emitStage(row, "failed_no_retry");
		return rows.length;
	}

	/**
	 * Only an explicitly failed operation, or one whose own result is definitively
	 * unreadable, can be discarded; a completed operation whose result is readable
	 * is resumed under its original op-ref.
	 */
	async #exhaustedTurnDisposition(row: MonitorEventDbRow): Promise<ExhaustedTurnDisposition> {
		const raw = this.#database.core.metaGet(authoringTurnKey(row.event_id));
		if (raw === undefined) return { kind: "terminal", raw };
		const turn = parseAuthoringTurnPointer(raw);
		if (!turn?.eventIds.includes(row.event_id)) return { kind: "hold", reason: "unresolved" };
		const monitor = this.#registry.get(row.monitor_id);
		// The per-event pointer owns the original session/op-ref. Do not infer the
		// session from row.event_type (including catch-all) or the current binding.
		let report: StatusReport;
		try {
			report = await this.#sessionPort.status({ sessionId: turn.sessionId, repo: this.#repo, opRef: turn.opRef });
		} catch {
			// An unreadable status is not proof that the turn stopped running.
			return { kind: "hold", reason: "unresolved" };
		}
		const state = report.status?.status;
		if (state === "failed") return { kind: "terminal", raw };
		if (state === "accepted" || state === "in_flight") return { kind: "hold", reason: "running" };
		if (state !== "terminal_ok") return { kind: "hold", reason: "unresolved" };
		// The turn has ended. If the monitor is gone, the events are now unrecoverable.
		if (!monitor) return { kind: "monitor_invalid", raw };
		const related: MonitorEventDbRow[] = [];
		for (const eventId of turn.eventIds) {
			const current = this.#database.monitors.eventGet(eventId);
			if (
				!current ||
				current.monitor_id !== row.monitor_id ||
				current.event_type !== row.event_type ||
				(TERMINAL_STAGES as readonly string[]).includes(current.stage) ||
				this.#database.core.metaGet(authoringTurnKey(eventId)) !== raw ||
				this.#database.monitors.eventLiveLeaseOwner(eventId, this.#now())
			)
				return { kind: "hold", reason: "unresolved" };
			related.push(current);
		}
		// Resume only on the operation's own result. A pending or transport-failed
		// read is an unresolved hold (age-bounded); a definitively unreadable one is
		// terminal: retrying could only resend the prompt.
		const output = await this.#readAuthoringResult(turn, related, report);
		if (output.status === "unavailable") return { kind: "terminal", raw };
		if (output.status === "absent") return { kind: "hold", reason: "unresolved" };
		return { kind: "resume", turn };
	}

	/**
	 * The saved operation's own original output (`turn.result` by clientRef), never
	 * the session's latest assistant message. The floor is the operation's reported
	 * start, else the earliest fire of its events: the prompt cannot predate either.
	 */
	async #readAuthoringResult(
		turn: AuthoringTurnPointer,
		rows: readonly MonitorEventDbRow[],
		report: StatusReport,
	): Promise<WorkerOutputResult> {
		const startedAt = report.status.startedAt;
		const notBeforeMs =
			typeof startedAt === "number" && Number.isFinite(startedAt)
				? startedAt
				: Math.min(...rows.map((row) => Date.parse(row.fired_at)));
		try {
			return await this.#sessionPort.fetchWorkerOutput({
				sessionId: turn.sessionId,
				repo: this.#repo,
				opRef: turn.opRef,
				notBeforeMs,
				terminalIdentity: report.status,
			});
		} catch {
			return { status: "absent", code: "transport_error" };
		}
	}

	/**
	 * Late-result recovery for batches given up as `authoring_turn_unresolved`
	 * (#702). Giving up only released the overlap blocker; the pointer stays. Once
	 * the original operation is terminal_ok AND its own result is readable, every
	 * event of that batch is reopened together with its exhausted budget kept, so
	 * the exhausted-turn path resumes the saved session/op-ref and harvests that
	 * result; it can never send a fresh prompt. A failed or definitively
	 * unreadable operation's pointer is dropped: there is nothing left to recover.
	 */
	async #recoverUnresolvedTurns(): Promise<void> {
		const visited = new Set<string>();
		for (const candidate of this.#database.monitors.eventsGivenUp(AUTHORING_TURN_UNRESOLVED)) {
			if (this.#closing) return;
			if (visited.has(candidate.event_id)) continue;
			const raw = this.#database.core.metaGet(authoringTurnKey(candidate.event_id));
			const turn = raw === undefined ? undefined : parseAuthoringTurnPointer(raw);
			if (!raw || !turn?.eventIds.includes(candidate.event_id)) continue;
			for (const eventId of turn.eventIds) visited.add(eventId);
			const members = this.#database.monitors.eventsByIds([...turn.eventIds]);
			const reopenable = (rows: readonly MonitorEventDbRow[]) =>
				rows.length === turn.eventIds.length &&
				rows.every(
					(row) =>
						row.stage === "failed_no_retry" &&
						row.dispatch_attempts >= MONITOR_EVENT_MAX_DISPATCH_ATTEMPTS &&
						row.monitor_id === candidate.monitor_id &&
						row.event_type === candidate.event_type &&
						this.#database.monitors.failure(row.event_id)?.code === AUTHORING_TURN_UNRESOLVED &&
						this.#database.core.metaGet(authoringTurnKey(row.event_id)) === raw &&
						this.#database.monitors.authoredOutput(row.event_id) === undefined &&
						!this.#database.monitors.eventLiveLeaseOwner(row.event_id, this.#now()),
				);
			if (!reopenable(members)) continue;
			let report: StatusReport;
			try {
				report = await this.#sessionPort.status({ sessionId: turn.sessionId, repo: this.#repo, opRef: turn.opRef });
			} catch {
				continue;
			}
			const state = report.status?.status;
			if (state === "failed") {
				this.#database.transaction((tx) => this.#forgetAuthoringTurn(tx, turn.eventIds, raw));
				continue;
			}
			if (state !== "terminal_ok") continue;
			const output = await this.#readAuthoringResult(turn, members, report);
			if (output.status === "unavailable") {
				this.#database.transaction((tx) => this.#forgetAuthoringTurn(tx, turn.eventIds, raw));
				continue;
			}
			if (output.status !== "proven") continue;
			const reopened = this.#database.transaction((tx) => {
				const current = this.#database.monitors.eventsByIds([...turn.eventIds]);
				if (!reopenable(current)) return [];
				for (const row of current)
					if (!this.#database.monitors.eventReopenGivenUp(tx, row.event_id, this.#now()))
						throw new Error(`monitor late-result reopen raced for event ${row.event_id}`);
				return current;
			});
			for (const row of reopened) this.#emitStage(row, "failed");
			if (reopened.length)
				console.error(
					`monitor late authoring result readable: reopened events ${reopened.map((row) => row.event_id).join(",")} for op ${turn.opRef}`,
				);
		}
	}

	/**
	 * The other events of `row`'s saved authoring turn when the whole batch can be
	 * dispatched again together, so a reused op-ref still matches its batch. A
	 * lone event of a coalesced batch would otherwise forget the shared pointer
	 * and author afresh.
	 */
	#savedBatch(row: MonitorEventDbRow, skip: ReadonlySet<string>): string[] | undefined {
		const raw = this.#database.core.metaGet(authoringTurnKey(row.event_id));
		const turn = raw === undefined ? undefined : parseAuthoringTurnPointer(raw);
		if (!turn || turn.eventIds.length < 2 || !turn.eventIds.includes(row.event_id)) return undefined;
		const rows = this.#database.monitors.eventsByIds([...turn.eventIds]);
		if (
			rows.length !== turn.eventIds.length ||
			!rows.every(
				(member) =>
					!skip.has(member.event_id) &&
					member.monitor_id === row.monitor_id &&
					member.event_type === row.event_type &&
					this.#recoverable(member) &&
					member.dispatch_attempts < MONITOR_EVENT_MAX_DISPATCH_ATTEMPTS &&
					this.#database.core.metaGet(authoringTurnKey(member.event_id)) === raw &&
					this.#database.monitors.authoredOutput(member.event_id) === undefined &&
					!this.#database.monitors.eventLiveLeaseOwner(member.event_id, this.#now()),
			)
		)
			return undefined;
		return rows.map((member) => member.event_id);
	}

	/**
	 * `batched` is a live stage: a dispatch that is still awaiting its authoring turn sits there
	 * for minutes. It is also where an event is stranded forever if the process dies mid-dispatch,
	 * and reconcile used to skip it, so a restart during canonicalization silently killed that run
	 * (observed: two `memory.canonicalize` events stuck at `batched`, one for six hours).
	 * The in-flight set tells the two apart exactly — anything batched that this process is not
	 * currently dispatching is an orphan, including every batched row after a restart.
	 */
	#recoverable(row: { stage: string; event_id: string }): boolean {
		if ((TERMINAL_STAGES as readonly string[]).includes(row.stage)) return false;
		if (!RECONCILABLE_STAGES.includes(row.stage as never) && row.stage !== "authored_no_delivery") return false;
		if (row.stage === "authored_no_delivery") return false;
		if (row.stage === "batched") return !this.#inFlight.has(row.event_id);
		return ["admitted", "dispatched", "failed"].includes(row.stage);
	}
	async #dispatch(eventIds: string[], resumeTurn?: AuthoringTurnPointer): Promise<void> {
		for (const id of eventIds) this.#inFlight.add(id);
		// Track the exact in-flight promise per event so awaitable submission can
		// await the ORIGINAL chain (no second dispatch, no double authoring).
		const promise = this.#dispatchBatch(eventIds, resumeTurn).finally(() => {
			for (const id of eventIds) {
				this.#inFlight.delete(id);
				if (this.#inFlightPromises.get(id) === promise) this.#inFlightPromises.delete(id);
			}
		});
		for (const id of eventIds) this.#inFlightPromises.set(id, promise);
		await promise;
	}
	async #dispatchBatch(eventIds: string[], resumeTurn?: AuthoringTurnPointer): Promise<void> {
		if (
			resumeTurn &&
			(resumeTurn.eventIds.length !== eventIds.length || !resumeTurn.eventIds.every((id) => eventIds.includes(id)))
		)
			return;
		const savedTurnMatches = () =>
			!resumeTurn ||
			resumeTurn.eventIds.every((eventId) => {
				const raw = this.#database.core.metaGet(authoringTurnKey(eventId));
				const saved = raw === undefined ? undefined : parseAuthoringTurnPointer(raw);
				return saved !== undefined && sameAuthoringTurn(saved, resumeTurn);
			});
		const resumeRowsSafe = (candidateRows: readonly MonitorEventDbRow[]) => {
			if (!resumeTurn) return true;
			const first = candidateRows[0];
			return (
				candidateRows.length === eventIds.length &&
				first !== undefined &&
				candidateRows.every(
					(row) =>
						row.monitor_id === first.monitor_id &&
						row.event_type === first.event_type &&
						!(TERMINAL_STAGES as readonly string[]).includes(row.stage) &&
						this.#database.monitors.authoredOutput(row.event_id) === undefined,
				)
			);
		};
		if (!savedTurnMatches()) return;
		const rows = this.#database.monitors.eventsByIds(eventIds);
		if (!rows.length || !resumeRowsSafe(rows)) return;
		const monitor = this.#registry.get(rows[0]?.monitor_id);
		if (!monitor) {
			if (resumeTurn) return;
			let transitionedFailure = false;
			for (const row of rows) {
				const failed = this.#database.transaction((tx) =>
					this.#database.monitors.eventTerminalFail(
						tx,
						row.event_id,
						"monitor_invalid",
						"dispatch setup failed (monitor_invalid)",
					),
				);
				if (failed) {
					transitionedFailure = true;
					this.#emitStage(row, "failed_no_retry");
				}
			}
			if (transitionedFailure)
				this.#recordReadinessFailure({
					code: "monitor_invalid",
					detail: "monitor dispatch failed during setup",
					originKey: monitorReadinessOriginKey(rows[0]?.monitor_id ?? "unknown"),
					at: this.#now(),
				});
			console.error(
				`monitor dispatch rejected missing or invalid monitor: events ${rows.map((row) => row.event_id).join(",")}`,
			);
			return;
		}
		const batchId = crypto.randomUUID();
		// Red-team blocker 1: acquire a durable lease per event BEFORE claiming the
		// batch. The lease survives this process (owner token + expiry), so a new
		// gateway process whose reconcile sees the stranded `batched` rows will NOT
		// re-author while this attempt is live. Events whose lease is held by a
		// live claim from another attempt are skipped here.
		const now = this.#now;
		const owner = `gateway:${process.pid}`;
		const leaseId = crypto.randomUUID();
		const leaseTtlMs = 10 * 60_000;
		const leased: typeof rows = [];
		for (const row of rows) {
			// The atomic claim is the ONLY gate: acquireLease fails when a live
			// lease exists (check-to-claim race impossible inside one statement).
			if (this.#acquireLease(row.event_id, owner, leaseId, leaseTtlMs, now())) {
				leased.push(row);
			}
		}
		if (!leased.length || (resumeTurn && leased.length !== rows.length)) {
			for (const row of leased)
				this.#database.transaction((tx) => this.#database.monitors.eventReleaseLease(tx, row.event_id, leaseId));
			return;
		}
		const currentRows = this.#database.monitors.eventsByIds(eventIds);
		if (resumeTurn && (!savedTurnMatches() || !resumeRowsSafe(currentRows))) {
			for (const row of leased)
				this.#database.transaction((tx) => this.#database.monitors.eventReleaseLease(tx, row.event_id, leaseId));
			return;
		}
		// Fence the initial stage claim: only rows we still own transition.
		const claimed: typeof leased = [];
		for (const row of leased) {
			if (this.#fencedUpdate(row.event_id, leaseId, batchId, now())) claimed.push(row);
		}
		if (!claimed.length || (resumeTurn && claimed.length !== leased.length)) {
			// Ownership changed during the claim: release every acquired lease and
			// let a later sweep reclaim any rows already moved to `batched`.
			for (const row of leased)
				this.#database.transaction((tx) => this.#database.monitors.eventReleaseLease(tx, row.event_id, leaseId));
			return;
		}
		for (const row of claimed) this.#emitStage(row, "batched");
		const claimedEventType = claimed[0]?.event_type;
		let sessionOrigin: OriginRef;
		let sessionOriginKey: string;
		try {
			if (!claimedEventType) throw new Error("missing event type");
			originKey(eventTypeOrigin(claimedEventType));
			// The session is owned by THIS monitor (#177): monitors that declare the
			// same event type must not share history, instruction, or failure domain.
			sessionOrigin = monitorOriginForEvent(monitor, claimedEventType);
			sessionOriginKey = originKey(sessionOrigin);
		} catch {
			const transitionedFailure = this.#database.transaction((tx) => {
				let transitioned = false;
				for (const row of claimed) {
					const failed = this.#database.monitors.eventFencedFail(
						tx,
						row.event_id,
						leaseId,
						batchId,
						"event_type_invalid",
						"dispatch setup failed (event_type_invalid)",
						now(),
						true,
					);
					if (failed) {
						transitioned = true;
						this.#emitStage(row, "failed_no_retry");
					}
				}
				for (const row of leased) this.#database.monitors.eventReleaseLease(tx, row.event_id, leaseId);
				return transitioned;
			});
			if (transitionedFailure)
				this.#recordReadinessFailure({
					code: "event_type_invalid",
					detail: "monitor dispatch failed during event setup",
					originKey: monitorReadinessOriginKey(monitor.monitorId),
					at: now(),
				});
			console.error(
				`monitor dispatch rejected invalid event type: events ${claimed.map((row) => row.event_id).join(",")}`,
			);
			return;
		}
		// Heartbeat: renew the lease while the authoring turn is in flight so long
		// turns (observed 14m+ canonicalizations) never expire mid-flight, while a
		// dead owner's lease still times out (bounded expiry = TTL after the last
		// heartbeat).
		const stopHeartbeat = this.#startLeaseHeartbeat(
			claimed.map((row) => row.event_id),
			leaseId,
			leaseTtlMs,
		);
		// Bound outside the try so the failure handler can ask the compaction port
		// to act on the very session that failed, and can tell whether that
		// session is still the live one.
		let boundSessionId: string | undefined;
		let boundSessionEpoch: number | undefined;
		let dispatchPhase = "bind";
		let dispatchOperation: string | undefined;
		let dispatchOperationArgs: Record<string, unknown> | undefined;
		// Registered before the per-origin queue: an event still waiting for its
		// turn is just as interrupted by a shutdown as one mid-request.
		for (const row of claimed)
			this.#claims.set(row.event_id, {
				leaseId,
				batchId,
				origin: sessionOriginKey,
				attempt: row.dispatch_attempts + 1,
				phase: () => dispatchPhase,
				sessionId: () => boundSessionId,
			});
		// One generic port owns all same-origin authoring serialization; monitor
		// leases remain active while a prior call is awaiting a terminal receipt.
		await this.#sessionPort.runExclusive(sessionOriginKey, async () => {
			// A replayed batch: reconcile bumps dispatch_attempts before re-dispatching
			// a stranded or failed event, so a non-zero count means these events are
			// not this session's own fresh work. Their context failure says nothing
			// about the CURRENT session and must not feed its streak — the payload is
			// old, and the failure may well have been produced against a session that
			// no longer exists.
			const replayedBatch = claimed.some((row) => row.dispatch_attempts > 0);
			let protocolResponseByteLength: number | undefined;
			let protocolResponseEntryCount: number | null = null;
			let protocolValidationActive = false;
			let readinessFailure: { readonly code: string; readonly detail: string } | undefined;
			const flushReadinessFailure = () => {
				if (!readinessFailure) return;
				this.#recordReadinessFailure({
					...readinessFailure,
					originKey: sessionOriginKey,
					at: this.#now(),
				});
				readinessFailure = undefined;
			};
			try {
				// A completed saved turn must be harvested before a pending roll changes
				// its session ID. Fresh dispatches still roll at this boundary (#68).
				const digest = resumeTurn
					? undefined
					: this.#rollSessionIfArmed(sessionOriginKey, JSON.stringify(sessionOrigin), monitor);
				const effectiveModel = (monitor.model as GjcModelSelection | undefined) ?? this.#model;
				const effectiveServiceTier = (monitor.serviceTier as GjcServiceTier | undefined) ?? this.#serviceTier;
				let sessionId: string;
				if (resumeTurn) {
					sessionId = resumeTurn.sessionId;
					const current = this.#database.bindings.getSessionRecord(sessionOriginKey);
					boundSessionEpoch = current?.sessionId === sessionId ? current.epoch : undefined;
					dispatchOperation = "request";
					dispatchOperationArgs = { opRef: resumeTurn.opRef };
					dispatchPhase = "procedure";
				} else {
					const boundEpoch = this.#database.bindings.getSessionRecord(sessionOriginKey)?.epoch ?? 0;
					dispatchOperation = "bind";
					dispatchOperationArgs = {
						epoch: boundEpoch,
						hasModel: effectiveModel !== undefined,
					};
					const binding = await this.#sessionPort.bind({
						originKey: sessionOriginKey,
						epoch: boundEpoch,
						repo: this.#repo,
						...(effectiveModel ? { model: effectiveModel } : {}),
					});
					sessionId = binding.sessionId;
					boundSessionId = sessionId;
					boundSessionEpoch = binding.epoch;
					dispatchPhase = "configure";
					const modelKey = effectiveModel
						? typeof effectiveModel === "string"
							? effectiveModel
							: `preset:${effectiveModel.preset}`
						: undefined;
					if (effectiveModel && !binding.startupModelApplied && this.#appliedModels.get(sessionId) !== modelKey) {
						dispatchOperation = "setModel";
						dispatchOperationArgs = {
							model: modelKey,
						};
						await this.#sessionPort.setModel({ sessionId, repo: this.#repo, selection: effectiveModel });
						this.#appliedModels.set(sessionId, modelKey!);
					} else if (effectiveModel && binding.startupModelApplied) {
						this.#appliedModels.set(sessionId, modelKey!);
					}
					if (effectiveServiceTier && this.#appliedServiceTiers.get(sessionId) !== effectiveServiceTier) {
						dispatchOperation = "setServiceTier";
						dispatchOperationArgs = {
							tier: effectiveServiceTier,
						};
						await this.#sessionPort.setServiceTier({ sessionId, repo: this.#repo, tier: effectiveServiceTier });
						this.#appliedServiceTiers.set(sessionId, effectiveServiceTier);
					}
				}
				boundSessionId = sessionId;
				// Guidance order: the monitor's own instruction first (it is what the
				// owner actually asked this monitor to do), then any built-in
				// maintenance semantics for the claimed event types. Without either,
				// the authoring turn only gets the receipt-note contract.
				const maintenance = claimed
					.map((row) => MAINTENANCE_GUIDANCE[row.event_type])
					.filter((entry, index, all) => entry && all.indexOf(entry) === index);
				const guidance = [monitor.instruction?.trim() || undefined, ...maintenance].filter(Boolean).join(" ");
				// Issue #82: the session is long-lived, so declared procedure files are
				// re-read at every firing and travel with this prompt, and the version
				// each event was authored under is recorded on the event row.
				dispatchPhase = "procedure";
				const procedure = await readMonitorProcedure(this.#repo, monitor.procedureFiles ?? []);
				if (procedure.versions.length) {
					const versionsJson = JSON.stringify(procedure.versions);
					this.#database.transaction((tx) => {
						for (const row of claimed)
							this.#database.monitors.eventFencedSetProcedure(tx, row.event_id, leaseId, versionsJson, now());
					});
				}
				const prompt = buildMonitorAuthoringPrompt({
					guidance,
					procedure: procedure.prompt,
					digest,
					events: await Promise.all(
						claimed.map(async (row) => ({
							eventId: row.event_id,
							eventType: row.event_type,
							payload: await this.#authoringPayload(row),
						})),
					),
				});
				// #187: a request-phase failure does not mean the prompt was refused —
				// the turn it started may still be running. Reuse its op-ref on retry.
				const authoringEventIds = resumeTurn?.eventIds ?? claimed.map((row) => row.event_id);
				const reusedOpRef = resumeTurn?.opRef ?? (await this.#reusableAuthoringTurn(authoringEventIds, sessionId));
				const opRef = reusedOpRef ?? `gw-m-${batchId.replaceAll("-", "")}`;
				const pendingTurn = JSON.stringify({ sessionId, opRef, eventIds: authoringEventIds });
				this.#database.transaction((tx) => {
					for (const row of claimed) {
						const priorRaw = this.#database.core.metaGet(authoringTurnKey(row.event_id));
						const prior = priorRaw === undefined ? undefined : parseAuthoringTurnPointer(priorRaw);
						if (prior && (prior.sessionId !== sessionId || prior.opRef !== opRef))
							this.#forgetAuthoringTurn(tx, [row.event_id], priorRaw);
						this.#database.core.metaSet(authoringTurnKey(row.event_id), pendingTurn);
					}
				});
				dispatchPhase = "request";
				dispatchOperation = "request";
				dispatchOperationArgs = {
					opRef,
				};
				const requestInput = { sessionId, repo: this.#repo, originKey: sessionOriginKey, text: prompt, opRef };
				const response =
					reusedOpRef === undefined
						? (await this.#sessionPort.request(requestInput)).assistant.text
						: await this.#harvestAuthoringTurn(
								requestInput,
								{ sessionId, opRef, eventIds: authoringEventIds },
								claimed,
								pendingTurn,
							);
				protocolResponseByteLength = Buffer.byteLength(response, "utf8");
				dispatchPhase = "validate";
				// The authoring turn is now part of the session transcript whatever its
				// content, so it is counted here rather than after the response is
				// validated. The count is OBSERVATIONAL: it is reported, and it never
				// rolls a session on its own — native gjc compaction owns keeping the
				// context bounded while the session is answering.
				if (boundSessionEpoch !== undefined) {
					const turns = this.#database.transaction((tx) =>
						this.#database.bindings.incrementTurnCount(tx, sessionOriginKey, JSON.stringify(sessionOrigin)),
					);
					const safety = this.#safetyState(sessionOriginKey);
					safety.turns = turns;
					if (this.#database.bindings.getSessionRecord(sessionOriginKey)?.epoch === boundSessionEpoch)
						safety.priorRunBusyFailures = 0;
				}
				// A non-empty answer is proof the session still has usable context, so
				// it clears the context-failure streak. A malformed answer is still an
				// answer: it must not arm the safety net.
				if (!response.trim()) throw new Error("authoring response is empty");
				if (boundSessionEpoch !== undefined) {
					const safety = this.#safetyState(sessionOriginKey);
					safety.contextFailures = 0;
					// The runtime accepted and finished a turn, so it is not stalled.
					safety.busyFailures = 0;
				}
				// Lease fencing: after an await, this attempt may no longer own the
				// claim (expired + stolen). Every write below is conditional on the
				// live lease; a stale attempt's completion becomes a no-op.
				// Atomic fencing: each stage write carries its live-lease check in the
				// same UPDATE, so a lease stolen between check and write cannot be
				// exploited (TOCTOU-free). `fenced` = rows whose write landed.
				const fenced = claimed.filter((row) =>
					this.#database.transaction((tx) =>
						this.#database.monitors.eventFencedUpdate(tx, row.event_id, leaseId, "dispatched", batchId),
					),
				);
				if (!fenced.length) return;
				// Retire the authoring-turn pointer only after confirming we own the lease through
				// the fenced update. Do not delete it before the fenced check: if the lease expires
				// between deletion and the fenced write, the pointer is lost and the event will be
				// re-authored on restart instead of recovering its saved result (#743).
				this.#database.transaction((tx) => {
					this.#forgetAuthoringTurn(
						tx,
						fenced.map((row) => row.event_id),
						pendingTurn,
					);
				});
				protocolValidationActive = true;
				for (const row of fenced) this.#emitStage(row, "dispatched");
				const authored = parseAuthoredArray(response) as Array<{ eventId?: unknown; note?: unknown }>;
				protocolResponseEntryCount = authored.length;
				if (!Array.isArray(authored)) throw new Error("authoring response is not an array");
				// Strict response contract: exactly one valid entry per claimed event —
				// a partial/missing/duplicate/extra response is a structured failure.
				// Omitted events must stay recoverable (dispatched/failed), never
				// silently delivered alongside their batch.
				const claimedIds = new Set(claimed.map((row) => row.event_id));
				const seenIds = new Set<string>();
				for (const entry of authored) {
					if (typeof entry.eventId !== "string" || typeof entry.note !== "string") {
						throw new Error("authoring response entry missing eventId or note");
					}
					if (!claimedIds.has(entry.eventId)) {
						throw new Error(`authoring response contains unknown event ${entry.eventId}`);
					}
					if (seenIds.has(entry.eventId)) {
						throw new Error(`authoring response duplicates event ${entry.eventId}`);
					}
					seenIds.add(entry.eventId);
				}
				for (const id of claimedIds) {
					if (!seenIds.has(id)) throw new Error(`authoring response omits event ${id}`);
				}
				protocolValidationActive = false;
				for (const entry of authored)
					if (
						typeof entry.eventId === "string" &&
						fenced.some((row) => row.event_id === entry.eventId) &&
						typeof entry.note === "string"
					) {
						const row = this.#database.monitors.eventGet(entry.eventId);
						if (!row) continue;
						const intentId = `monitor-event-intent:${entry.eventId}`;
						const reportable = Boolean(monitor.reportTo && this.#isReportableResult(monitor, row, entry.note));
						const authoredOk = this.#database.transaction((tx) => {
							const authored = this.#database.monitors.authorFenced(
								tx,
								entry.eventId as string,
								leaseId,
								entry.note as string,
							);
							if (!authored) return false;
							if (!this.#database.memory.get(intentId))
								this.#database.memory.createIntent(tx, {
									id: intentId,
									kind: "monitor-event",
									payloadJson: JSON.stringify({
										kind: "monitor-event",
										identity: `monitor-event:${entry.eventId}`,
										originRefJson: JSON.stringify(eventTypeOrigin(row.event_type)),
										userText: `Monitor event ${entry.eventId}: ${row.event_type}`,
										replyText: entry.note,
									}),
								});
							if (reportable) this.#enqueueMonitorReport(tx, monitor, row, entry.note as string);
							return true;
						});
						if (!authoredOk) continue;
						// Wake the closure queue so the atomically admitted intent is
						// processed in the same run (no restart needed).
						this.#memory.enqueueExistingId(intentId);
						if (reportable && monitor.reportTo) this.#notifyMonitorReport(monitor.reportTo);
						this.#emit({
							eventId: entry.eventId,
							monitorId: monitor.monitorId,
							eventType: row.event_type,
							firedAt: row.fired_at,
							stage: "authored",
						});
					}
				dispatchPhase = "delivery";
				// A monitor without its own channel target reports to the configured owner
				// target when one exists: a personal agent's maintenance and event notes go
				// to the owner by default rather than vanishing into the logs. With no
				// target at all the event settles terminally as `authored_no_delivery`
				// instead of pretending a delivery is still pending (issue #29 defect 3).
				const target = monitor.channelTarget ?? this.#ownerTarget;
				if (!target) {
					let noDeliveryRecorded = false;
					for (const row of fenced) {
						if (this.#database.monitors.authoredOutput(row.event_id) === undefined) continue;
						const updated = this.#database.transaction((tx) =>
							this.#database.monitors.eventFencedUpdate(tx, row.event_id, leaseId, "authored_no_delivery", batchId),
						);
						if (updated) {
							noDeliveryRecorded = true;
							this.#emitStage(row, "authored_no_delivery");
						}
					}
					if (noDeliveryRecorded) this.#recordReadinessSuccess(sessionOriginKey);
					return;
				}
				// Fenced delivery admission: the ledger insert is conditional on every
				// fenced event still holding its lease (same transaction). A stale
				// attempt therefore cannot emit a second delivery.
				const deliveryId = crypto.randomUUID();
				// Evaluate silence PER NOTE BEFORE joining: a silent note in a batch
				// must not leak, and a real note must not be swallowed by a neighbour's marker.
				const nonSilentEntries = authored
					.filter(
						(entry): entry is { eventId: string; note: string } =>
							typeof entry.eventId === "string" &&
							typeof entry.note === "string" &&
							fenced.some((row) => row.event_id === entry.eventId),
					)
					.filter((entry) => !isSilentOutput(entry.note));
				const silentEntries = authored
					.filter(
						(entry): entry is { eventId: string; note: string } =>
							typeof entry.eventId === "string" &&
							typeof entry.note === "string" &&
							fenced.some((row) => row.event_id === entry.eventId),
					)
					.filter((entry) => isSilentOutput(entry.note));
				// Mark all silent notes as authored_no_delivery
				let noDeliveryRecorded = false;
				for (const entry of silentEntries) {
					if (this.#database.monitors.authoredOutput(entry.eventId) === undefined) continue;
					const updated = this.#database.transaction((tx) =>
						this.#database.monitors.eventFencedUpdate(tx, entry.eventId, leaseId, "authored_no_delivery", batchId),
					);
					if (updated) noDeliveryRecorded = true;
				}
				const validDeliveryEntries: typeof nonSilentEntries = [];
				for (const entry of nonSilentEntries) {
					const eventRow = fenced.find((row) => row.event_id === entry.eventId);
					const isEcho = eventRow ? this.#isContractEcho(monitor, eventRow, entry.note) : false;
					if (!isEcho) {
						validDeliveryEntries.push(entry);
						continue;
					}
					const updated = this.#database.transaction((tx) =>
						this.#database.monitors.eventFencedContractUnmet(
							tx,
							entry.eventId,
							leaseId,
							batchId,
							"authored_echo_suspected",
							"delivery suppressed: note echoes the monitor contract without new evidence",
							this.#now(),
						),
					);
					if (updated) {
						readinessFailure ??= {
							code: "authored_echo_suspected",
							detail: "monitor authoring result echoed its contract",
						};
						if (eventRow) this.#emitStage(eventRow, "contract_unmet");
					}
				}
				// Deliver only non-silent notes that contain information beyond the contract.
				const deliveryText = validDeliveryEntries.map((entry) => entry.note).join("\n");
				if (deliveryText.length > 0) {
					const origin = target.origin;
					// Typed mentions (issue #180) are added here, in code: the author is
					// never asked to remember who to ping, and the recipient list never
					// has to be recovered from the event type or the instruction prose.
					const mentions = (monitor.channelTarget?.mentionUserIds ?? []).map((id) => `<@${id}>`).join(" ");
					const payload: ChatMessagePayload = {
						turnId: batchId,
						origin,
						role: "assistant",
						text: mentions ? `${mentions} ${deliveryText}` : deliveryText,
						final: true,
						deliveryId,
					};
					const preparedAt = this.#now();
					const admitted = this.#database.transaction((tx) => {
						for (const { event_id: eventId } of fenced) {
							this.#database.core.assertNotQuarantined("monitor", eventId);
							if (this.#database.monitors.eventLiveLeaseOwner(eventId, preparedAt) !== leaseId) return false;
						}
						return this.#database.outbox.enqueue(
							tx,
							{
								deliveryId,
								turnId: batchId,
								originKey: originKey(origin),
								payloadJson: JSON.stringify(payload),
							},
							preparedAt,
						);
					});
					if (!admitted) return;
					this.#delivery.markInflight(deliveryId);
					// Push to live adapters NOW: without this the note sat in the ledger
					// until the next adapter reconnect flushed redeliveries (live finding:
					// owner-DM canonicalize note stuck inflight for minutes).
					this.#deliver?.(payload);
				} else if (noDeliveryRecorded && !readinessFailure) this.#recordReadinessSuccess(sessionOriginKey);
			} catch (error) {
				// Public-safe structured evidence only: a stable phase code and event ids.
				// The raw error body can carry secrets and is never persisted or logged.
				const failureClass =
					error instanceof LastAssistantUnreadableError ||
					error instanceof AuthoringResultUnavailableError ||
					sessionRequestStep(error) === "last_assistant"
						? "executor"
						: classifyAuthoringFailure(error);
				const protocolFailure =
					protocolValidationActive && failureClass === "protocol" && protocolResponseByteLength !== undefined
						? {
								protocolFailure: {
									reason: classifyProtocolFailure(error),
									responseByteLength: protocolResponseByteLength,
									responseEntryCount: protocolResponseEntryCount,
								},
							}
						: undefined;
				const code: DispatchFailureCode = failureCode(error, failureClass, dispatchPhase);
				let transitionedFailure = false;
				this.#database.transaction((tx) => {
					for (const row of leased) {
						const failed = this.#database.monitors.eventFencedFail(
							tx,
							row.event_id,
							leaseId,
							batchId,
							code,
							`dispatch phase failed (${code}): ${failureDetail(error)} ${JSON.stringify({ phase: dispatchPhase, operation: dispatchOperation, operation_args: dispatchOperationArgs, sessionId: boundSessionId ?? null, origin: sessionOriginKey, attempt: row.dispatch_attempts + 1 })}`,
							now(),
							false,
							protocolFailure,
						);
						if (failed) {
							transitionedFailure = true;
							this.#emitStage(row, "failed");
						}
					}
				});
				if (transitionedFailure) readinessFailure = { code, detail: `monitor dispatch failed during ${dispatchPhase}` };
				flushReadinessFailure();
				console.error(`monitor dispatch failed (${code}): events ${claimed.map((row) => row.event_id).join(",")}`);
				await this.#recordAuthoringFailure({
					sessionOriginKey,
					failureClass,
					// Passed for PURE classification only (executor sub-kind). The message
					// is never logged or persisted from here.
					error,
					sessionId: boundSessionId,
					boundEpoch: boundSessionEpoch,
					replayed: replayedBatch,
					monitor,
				});
			} finally {
				flushReadinessFailure();
				stopHeartbeat();
				for (const row of claimed) this.#claims.delete(row.event_id);
				// Release the leases this attempt holds. Lease-guarded: if this attempt
				// expired and another process stole the claim, this release is a no-op,
				// and a stale attempt's completion can never overwrite the newer claim.
				this.#database.transaction((tx) => {
					for (const row of leased) this.#database.monitors.eventReleaseLease(tx, row.event_id, leaseId);
				});
			}
		});
	}
	/**
	 * The result of a saved authoring turn this dispatch reuses (#187, #702). A
	 * turn still running is awaited under its own clientRef (a duplicate send is
	 * refused and observed, never a second prompt); the answer is then read from
	 * that operation's own `turn.result`, never from the session's latest assistant
	 * message, which a later turn may have replaced. A pending or unreachable result
	 * keeps the pointer for a later attempt; a definitively unreadable one drops it.
	 */
	async #harvestAuthoringTurn(
		requestInput: Parameters<SessionPort["request"]>[0],
		turn: AuthoringTurnPointer,
		rows: readonly MonitorEventDbRow[],
		pendingTurn: string,
	): Promise<string> {
		const readStatus = async () => {
			try {
				return await this.#sessionPort.status({ sessionId: turn.sessionId, repo: this.#repo, opRef: turn.opRef });
			} catch {
				// An unreadable status says nothing about the operation: the pointer stays.
				throw new AuthoringResultUnavailableError("transport_error");
			}
		};
		let report = await readStatus();
		if (report.status.status === "accepted" || report.status.status === "in_flight") {
			await this.#sessionPort.request(requestInput);
			report = await readStatus();
		}
		if (report.status.status !== "terminal_ok") throw new SessionTerminalError(report);
		const output = await this.#readAuthoringResult(turn, rows, report);
		if (output.status === "proven") return output.text;
		if (output.status === "unavailable")
			this.#database.transaction((tx) =>
				this.#forgetAuthoringTurn(
					tx,
					rows.map((row) => row.event_id),
					pendingTurn,
				),
			);
		throw new AuthoringResultUnavailableError(output.code);
	}
	/**
	 * The op-ref of a previous attempt's authoring turn for exactly these events
	 * on this session, when that turn is still running or finished successfully.
	 * A failed, unknown or unreadable prior turn is forgotten so the retry sends
	 * a fresh prompt.
	 */
	async #reusableAuthoringTurn(eventIds: readonly string[], sessionId: string): Promise<string | undefined> {
		const raw = this.#database.core.metaGet(authoringTurnKey(eventIds[0] ?? ""));
		if (raw === undefined) return undefined;
		const prior = parseAuthoringTurnPointer(raw);
		if (!prior) return undefined;
		const forget = () => {
			this.#database.transaction((tx) => this.#forgetAuthoringTurn(tx, eventIds, raw));
		};
		if (
			prior.sessionId !== sessionId ||
			prior.eventIds.length !== eventIds.length ||
			!eventIds.every((id) => prior.eventIds.includes(id))
		) {
			forget();
			return undefined;
		}
		try {
			const report = await this.#sessionPort.status({ sessionId, repo: this.#repo, opRef: prior.opRef });
			const state = report.status.status;
			if (state === "accepted" || state === "in_flight" || state === "terminal_ok") return prior.opRef;
		} catch {
			// Unreadable status is not evidence of a live turn.
		}
		forget();
		return undefined;
	}
	/** Abandon only captured pointers; sibling owners and replacement pointers remain authoritative. */
	#forgetAuthoringTurn(tx: WriteTx, eventIds: readonly string[], raw: string | undefined): void {
		if (raw === undefined) return;
		const prior = parseAuthoringTurnPointer(raw);
		if (!prior) return;
		const authority = this.#database.bindings.brokerAuthority();
		const ownedRepo = this.#database.bindings.workLaneRepoBySessionId(prior.sessionId);
		let owner: ReturnType<Store["bindings"]["assertOwnedSession"]> | undefined;
		if (authority && ownedRepo) {
			try {
				owner = this.#database.bindings.assertOwnedSession(prior.sessionId, ownedRepo, authority);
			} catch (error) {
				if (!(error instanceof BrokerAuthorityError)) throw error;
			}
		}
		let forgotten = false;
		for (const eventId of eventIds) {
			if (!prior.eventIds.includes(eventId) || this.#database.core.metaGet(authoringTurnKey(eventId)) !== raw) continue;
			this.#database.core.metaDelete(authoringTurnKey(eventId));
			forgotten = true;
		}
		if (forgotten && owner)
			this.#database.bindings.abandonBrokerPromptBusyRefusal(tx, {
				sessionId: prior.sessionId,
				opRef: prior.opRef,
				originKey: owner.originKey,
				epoch: owner.epoch,
				repo: owner.repo,
			});
	}
	/** Read-only safety-net evidence for one session origin (ops/tests). */
	sessionSafetyState(sessionOriginKey: string): MonitorSessionSafetyState {
		return { ...this.#safetyState(sessionOriginKey) };
	}
	#safetyState(sessionOriginKey: string): MonitorSessionSafetyState {
		const existing = this.#safety.get(sessionOriginKey);
		if (existing) return existing;
		const fresh: MonitorSessionSafetyState = {
			turns: 0,
			contextFailures: 0,
			staleContextFailures: 0,
			orphanedExecutorFailures: 0,
			lastExecutorReason: undefined,
			executorFailures: 0,
			protocolFailures: 0,
			lastProtocolReason: undefined,
			busyFailures: 0,
			stalledSessionId: undefined,
			priorRunBusyFailures: 0,
			nativeCompaction: undefined,
			pendingRoll: undefined,
			lastRoll: undefined,
		};
		this.#safety.set(sessionOriginKey, fresh);
		return fresh;
	}
	/**
	 * THE ONE monitor-session failure classifier and native-compaction request
	 * point (issue #68).
	 *
	 * It keeps independent evidence separate:
	 * - only context-class failures of the CURRENT session's own fresh work feed
	 *   the context streak and can request native compaction;
	 * - `session_busy` and the exact prior-run-busy terminal failure use bounded
	 *   stuck-session streaks, while positive host/submission evidence can arm a
	 *   roll directly. None of these is context evidence;
	 * - other executor-class failures (aside worker timeout, orphaned external
	 *   run, tool failure, lock skip) and protocol-class failures are recorded
	 *   without a context roll. The executor sub-kind is named for the operator
	 *   (`lastExecutorReason`), and orphaned work is counted separately because
	 *   its remedy is reclaiming an external daemon job, not touching this session.
	 * - a replayed batch (reconcile revived it) carries an old payload and may
	 *   have failed against a session that is already gone.
	 * - a bound epoch that is no longer current means the failure belongs to a
	 *   dead session; its record must never roll the successor.
	 *
	 * When it does count, native compaction is requested first and the safety net
	 * arms only if that did not succeed AND the streak has reached
	 * `contextFailureRollThreshold` consecutive failures.
	 */
	async #recordAuthoringFailure(input: {
		sessionOriginKey: string;
		failureClass: AuthoringFailureClass;
		/** Inspected by pure classifiers only; never logged, never persisted. */
		error: unknown;
		sessionId: string | undefined;
		boundEpoch: number | undefined;
		replayed: boolean;
		monitor: MonitorRecord;
	}): Promise<void> {
		const { sessionOriginKey, failureClass, error, sessionId, boundEpoch, replayed, monitor } = input;
		const state = this.#safetyState(sessionOriginKey);
		const currentEpoch =
			boundEpoch !== undefined &&
			boundEpoch === (this.#database.bindings.getSessionRecord(sessionOriginKey)?.epoch ?? 0);
		const liveBinding = !replayed && currentEpoch;
		const priorRunBusyFailure = isPriorRunBusyTerminalFailure(error);
		if (currentEpoch && !priorRunBusyFailure) state.priorRunBusyFailures = 0;
		if (isSessionBusy(error)) {
			// A busy refusal is not evidence about context or contract: the prompt
			// was never accepted. It IS evidence that the session is wedged on a turn
			// it will not finish once it has outlasted a whole bounded wait twice.
			// Before this the busy bit was filed as `executor_failed`-class noise with
			// no remedy, the slot burned its reclaim budget into `failed_no_retry`,
			// and the next slot aimed at the same dead session (#263: 24/24 slots
			// lost on one event type while every other type delivered).
			state.busyFailures += 1;
			console.error(
				`monitor session busy for ${sessionOriginKey} (monitor ${monitor.monitorId}): busy_failures=${state.busyFailures}/${MONITOR_BUSY_FAILURE_ROLL_THRESHOLD} replayed=${replayed} context_failures=${state.contextFailures} (unchanged)`,
			);
			// Replayed events still count: a busy refusal says nothing about the
			// payload, only about the session that refused it. The epoch check
			// still applies so a dead session's refusals never roll its successor.
			if (currentEpoch && !state.pendingRoll && state.busyFailures >= MONITOR_BUSY_FAILURE_ROLL_THRESHOLD) {
				state.pendingRoll = "session_busy_stalled";
				state.stalledSessionId = sessionId;
				console.error(
					`monitor session safety net armed for ${sessionOriginKey} (monitor ${monitor.monitorId}): reason=session_busy_stalled busy_failures=${state.busyFailures}/${MONITOR_BUSY_FAILURE_ROLL_THRESHOLD} session=${sessionId ?? "none"} turns=${state.turns}`,
				);
			}
			return;
		}
		if (priorRunBusyFailure) {
			// Count only failures on the current epoch. A stale session's terminal
			// result must not roll (or contribute to the streak of) its successor.
			if (!currentEpoch) return;
			state.busyFailures = 0;
			state.priorRunBusyFailures = Math.min(
				MONITOR_PRIOR_RUN_BUSY_FAILURE_ROLL_THRESHOLD,
				state.priorRunBusyFailures + 1,
			);
			console.error(
				`monitor prior run still busy for ${sessionOriginKey} (monitor ${monitor.monitorId}): prior_run_busy_failures=${state.priorRunBusyFailures}/${MONITOR_PRIOR_RUN_BUSY_FAILURE_ROLL_THRESHOLD} replayed=${replayed} context_failures=${state.contextFailures} (unchanged)`,
			);
			if (!state.pendingRoll && state.priorRunBusyFailures >= MONITOR_PRIOR_RUN_BUSY_FAILURE_ROLL_THRESHOLD) {
				state.pendingRoll = "session_prior_run_busy_stalled";
				state.stalledSessionId = sessionId;
				console.error(
					`monitor session safety net armed for ${sessionOriginKey} (monitor ${monitor.monitorId}): reason=session_prior_run_busy_stalled prior_run_busy_failures=${state.priorRunBusyFailures}/${MONITOR_PRIOR_RUN_BUSY_FAILURE_ROLL_THRESHOLD} session=${sessionId ?? "none"} turns=${state.turns}`,
				);
			}
			return;
		}
		if (isSessionHostUnavailable(error)) {
			state.busyFailures = 0;
			if (currentEpoch && !state.pendingRoll) {
				state.pendingRoll = "session_host_unavailable";
				console.error(
					`monitor session safety net armed for ${sessionOriginKey} (monitor ${monitor.monitorId}): reason=session_host_unavailable session=${sessionId ?? "none"} turns=${state.turns}`,
				);
			}
			return;
		}
		if (isWedgedSubmissionError(error)) {
			// Positive pre-start evidence: the runtime took the prompt but no run ever
			// began, and the rate-limiting cause is the session itself (a prior run or
			// its pre-prompt compaction still holding the agent), so every later prompt
			// fails identically. Before this the shape fell through to the executor
			// branch below — a counter with no remedy — and one wedged session lost
			// every slot forever: memory.canonicalize, 9 consecutive slots from
			// 2026-10-13T21:30Z, `Timed out waiting for prior agent run to finish
			// before prompting.` (the persona path already resets this shape: see
			// `isWedgedSubmission` in orchestrator/persona-session.ts).
			state.busyFailures = 0;
			if (currentEpoch && !state.pendingRoll) {
				state.pendingRoll = "session_submission_wedged";
				state.stalledSessionId = sessionId;
				console.error(
					`monitor session safety net armed for ${sessionOriginKey} (monitor ${monitor.monitorId}): reason=session_submission_wedged session=${sessionId ?? "none"} turns=${state.turns}`,
				);
			}
			return;
		}
		// Any other outcome means the runtime accepted a prompt: not stalled.
		state.busyFailures = 0;
		if (failureClass === "executor") {
			state.executorFailures += 1;
			const reason = classifyExecutorFailure(error);
			state.lastExecutorReason = reason;
			if (reason === "executor_orphaned_external_work") {
				state.orphanedExecutorFailures += 1;
				// Name it and stop. The session answered nothing wrong; an external
				// daemon job outlived its child process and the next tick will stack
				// another one. Rolling the session would hide that, not fix it.
				console.error(
					`monitor executor orphaned for ${sessionOriginKey} (monitor ${monitor.monitorId}): reason=${reason} orphaned_failures=${state.orphanedExecutorFailures} context_failures=${state.contextFailures} (unchanged) — external executor work was not reclaimed; the session is left untouched.`,
				);
			}
			return;
		}
		if (failureClass === "protocol") {
			state.protocolFailures += 1;
			const protocolReason = classifyProtocolFailure(error);
			state.lastProtocolReason = protocolReason;
			// The answer itself may never be logged, so name the violated rule and
			// the streak instead: that is the whole diagnosis an operator gets.
			console.error(
				`monitor answer off contract for ${sessionOriginKey} (monitor ${monitor.monitorId}): reason=${protocolReason} protocol_failures=${state.protocolFailures}/${this.#protocolFailureRollThreshold} context_failures=${state.contextFailures} (unchanged)`,
			);
			// A protocol failure says nothing about context size, so it never feeds
			// the context streak and never requests compaction. It does get its own
			// remedy: an epoch's worth of identical off-contract answers is a session
			// that cannot follow its own contract any more, and before this the
			// gateway retried it forever with no remediation at all (measured:
			// jip-gajae `sns-threads`, 19/19 ticks in one day).
			if (liveBinding && state.protocolFailures >= this.#protocolFailureRollThreshold) {
				state.pendingRoll = "protocol_failures_off_contract";
				console.warn(
					`monitor session safety net armed for ${sessionOriginKey} (monitor ${monitor.monitorId}): reason=protocol_failures_off_contract protocol_failures=${state.protocolFailures}/${this.#protocolFailureRollThreshold} last_reason=${protocolReason} turns=${state.turns}`,
				);
			}
			return;
		}
		if (!liveBinding) {
			state.staleContextFailures += 1;
			console.info(
				`monitor context failure not counted for ${sessionOriginKey} (monitor ${monitor.monitorId}): replayed=${replayed} current_epoch=${currentEpoch}`,
			);
			return;
		}
		state.contextFailures += 1;
		const status = sessionId ? await this.#requestNativeCompaction(sessionId) : "unavailable";
		state.nativeCompaction = status;
		const reason = decideSessionRoll({
			consecutiveContextFailures: state.contextFailures,
			threshold: this.#contextFailureRollThreshold,
			nativeCompaction: status,
		});
		if (!reason) return;
		// Arm, do not roll here: the roll must happen at the dispatch boundary
		// where no batch is in flight.
		state.pendingRoll = reason;
		console.warn(
			`monitor session safety net armed for ${sessionOriginKey} (monitor ${monitor.monitorId}): reason=${reason} context_failures=${state.contextFailures}/${this.#contextFailureRollThreshold} native_compaction=${status} turns=${state.turns}`,
		);
	}
	/**
	 * Asks the runtime to compact this session natively — the first line of
	 * defence, and the ONLY place the gateway requests it. A port that throws did
	 * not compact, so it reports `failed`; the thrown message never escapes.
	 */
	async #requestNativeCompaction(sessionId: string): Promise<NativeCompactionStatus> {
		try {
			return (await this.#compaction.run(sessionId)).status;
		} catch {
			return "failed";
		}
	}
	/**
	 * THE ONE monitor-session roll choke point (issue #68). LAST RESORT: it fires
	 * only for a roll armed by `#recordAuthoringFailure`, never on turn count.
	 *
	 * Returns the digest to inject into this turn's prompt, or undefined when no
	 * roll was armed. The digest is pure text assembly — a roll costs no model
	 * turn.
	 */
	#rollSessionIfArmed(sessionOriginKey: string, originRefJson: string, monitor: MonitorRecord): string | undefined {
		const state = this.#safetyState(sessionOriginKey);
		const reason = state.pendingRoll;
		if (!reason) return undefined;
		// Build the digest BEFORE the roll: it reads durable authored notes, which
		// the roll does not touch, but reading first keeps the ordering obvious.
		const digest = buildMonitorCompactionDigest({
			monitorName: monitor.name,
			instruction: monitor.instruction,
			notes: this.#recentAuthoredNotes(monitor),
		});
		// bumpEpoch is the existing rotation primitive: epoch + 1 and turn_count 0.
		// The next broker-backed SessionPort bind mints a fresh session and
		// idempotency key for this monitor origin.
		const stalledSessionId =
			reason === "session_busy_stalled" ||
			reason === "session_prior_run_busy_stalled" ||
			reason === "session_submission_wedged"
				? state.stalledSessionId
				: undefined;
		state.stalledSessionId = undefined;
		this.#database.transaction((tx) => this.#database.bindings.rotateEpoch(tx, sessionOriginKey, originRefJson));
		// A stalled session is still holding its wedged turn; nothing will prompt
		// it again now that the origin is bound to a new epoch, so end its host
		// rather than leave it occupying the runtime forever. Best-effort: the
		// roll already happened, and a refused kill only costs one idle host.
		if (stalledSessionId && this.#sessionPort.terminateHost) {
			void this.#sessionPort.terminateHost({ sessionId: stalledSessionId, repo: this.#repo }).then(
				(result) =>
					console.error(
						`monitor stalled session host for ${sessionOriginKey}: session=${stalledSessionId} outcome=${result.outcome}`,
					),
				() =>
					console.error(
						`monitor stalled session host for ${sessionOriginKey}: session=${stalledSessionId} outcome=error`,
					),
			);
		}
		state.pendingRoll = undefined;
		state.lastRoll = reason;
		// The new epoch starts with a clean slate: the previous session's failure
		// evidence is about a session that no longer exists.
		state.contextFailures = 0;
		state.executorFailures = 0;
		state.orphanedExecutorFailures = 0;
		state.protocolFailures = 0;
		state.busyFailures = 0;
		state.priorRunBusyFailures = 0;
		state.turns = 0;
		console.info(
			`monitor session rolled for ${sessionOriginKey} (monitor ${monitor.monitorId}): reason=${reason} native_compaction=${state.nativeCompaction ?? "not_attempted"} digest=${digest.length}B.`,
		);
		return digest;
	}
	/**
	 * Newest authored notes for one monitor, newest first; the digest builder
	 * applies the note cap. Silent markers and contract restatements are skipped: the no-target
	 * path never classifies echoes, and an echo in the digest is exactly the
	 * example a fresh session would copy (#369).
	 */
	#recentAuthoredNotes(monitor: MonitorRecord): MonitorDigestNote[] {
		const notes: MonitorDigestNote[] = [];
		for (const row of this.#database.monitors.recentAuthoredNotes(
			monitor.monitorId,
			MONITOR_DIGEST_MAX_NOTES * DIGEST_NOTE_SCAN_FACTOR,
		)) {
			if (isSilentOutput(row.note) || this.#isContractEcho(monitor, row, row.note)) continue;
			notes.push({ eventType: row.event_type, firedAt: row.fired_at, note: row.note });
		}
		return notes;
	}
	/**
	 * Renews every held lease on an interval (TTL/3) so the claim stays live for
	 * the duration of a long authoring turn without extending unboundedly after
	 * owner death. Returns a stop function.
	 */
	#startLeaseHeartbeat(eventIds: string[], leaseId: string, ttlMs: number): () => void {
		const timer = setInterval(
			() => {
				for (const eventId of eventIds)
					this.#database.transaction((tx) =>
						this.#database.monitors.eventRenewLease(tx, eventId, leaseId, ttlMs, this.#now()),
					);
			},
			Math.max(1000, Math.floor(ttlMs / 3)),
		);
		timer.unref?.();
		return () => clearInterval(timer);
	}
	#author(
		eventId: string,
		note: string,
		noDelivery = false,
		row?: Pick<MonitorEventDbRow, "event_id" | "monitor_id" | "event_type" | "payload_json" | "fired_at">,
	): void {
		const eventRow = row ?? this.#database.monitors.eventGet(eventId);
		if (!eventRow) return;
		const monitor = this.#registry.get(eventRow.monitor_id);
		const reportable = Boolean(monitor?.reportTo && this.#isReportableResult(monitor, eventRow, note));
		const intentId = `monitor-event-intent:${eventId}`;
		const authored = this.#database.transaction((tx) => {
			const updated = this.#database.monitors.authorFenced(tx, eventId, "", note, noDelivery);
			if (!updated) return false;
			if (!this.#database.memory.get(intentId))
				this.#database.memory.createIntent(tx, {
					id: intentId,
					kind: "monitor-event",
					payloadJson: JSON.stringify({
						kind: "monitor-event",
						identity: `monitor-event:${eventId}`,
						originRefJson: JSON.stringify(eventTypeOrigin(eventRow.event_type)),
						userText: `Monitor event ${eventId}: ${eventRow.event_type}`,
						replyText: note,
					}),
				});
			if (reportable && monitor) this.#enqueueMonitorReport(tx, monitor, eventRow, note);
			return true;
		});
		if (!authored) return;
		// Wake the closure queue for the intent admitted above.
		this.#memory.enqueueExistingId(intentId);
		if (reportable && monitor?.reportTo) this.#notifyMonitorReport(monitor.reportTo);
		this.#emitStage(eventRow, noDelivery ? "authored_no_delivery" : "authored");
	}
	#recordReadinessSuccess(originKey: string): void {
		try {
			this.#onReadinessSuccess?.({ originKey, at: this.#now() });
		} catch {
			console.error("monitor readiness observer failed");
		}
	}
	#recordReadinessFailure(input: {
		readonly code: string;
		readonly detail: string;
		readonly originKey: string;
		readonly at: number;
	}): void {
		try {
			this.#onReadinessFailure?.(input);
		} catch {
			console.error("monitor readiness observer failed");
		}
	}
	#isReportableResult(
		monitor: MonitorRecord,
		event: Pick<MonitorEventDbRow, "event_id" | "event_type" | "payload_json" | "fired_at">,
		note: string,
	): boolean {
		if (isSilentOutput(note)) return false;
		if (!monitor.channelTarget && !this.#ownerTarget) return true;
		return !this.#isContractEcho(monitor, event, note);
	}
	#isContractEcho(
		monitor: MonitorRecord,
		event: Pick<MonitorEventDbRow, "event_id" | "event_type" | "payload_json" | "fired_at">,
		note: string,
	): boolean {
		return isAuthoredEchoSuspected(monitor.instruction, note, {
			eventId: event.event_id,
			eventType: event.event_type,
			payload: event.payload_json,
			firedAt: event.fired_at,
		});
	}
	#enqueueMonitorReport(
		tx: WriteTx,
		monitor: MonitorRecord,
		event: { readonly event_id: string; readonly event_type: string },
		note: string,
	): void {
		const target = monitor.reportTo;
		if (!target) return;
		this.#database.inbox.enqueue(tx, {
			messageId: `${MONITOR_REPORT_MESSAGE_ID_PREFIX}${event.event_id}`,
			originKey: originKey(target),
			originRefJson: JSON.stringify(target),
			body: `Monitor ${JSON.stringify(monitor.name)} result for ${event.event_type} (${event.event_id}):\n\n${note}`,
			source: "lane_report",
		});
	}
	#notifyMonitorReport(target: OriginRef): void {
		if (!this.#notifyInbound) return;
		const key = originKey(target);
		try {
			void this.#notifyInbound(key).catch(() => {
				console.error(`monitor report notify failed origin=${key}`);
			});
		} catch {
			console.error(`monitor report notify failed origin=${key}`);
		}
	}
	#emitStage(row: { event_id: string; monitor_id: string; event_type: string; fired_at: string }, stage: string): void {
		this.#emit({
			eventId: row.event_id,
			monitorId: row.monitor_id,
			eventType: row.event_type,
			firedAt: row.fired_at,
			stage,
		});
	}
}

function failureCode(error: unknown, failureClass: AuthoringFailureClass, phase: string): DispatchFailureCode {
	const step = phase === "request" ? sessionRequestStep(error) : undefined;
	if (
		error instanceof LastAssistantUnreadableError ||
		error instanceof AuthoringResultUnavailableError ||
		step === "last_assistant"
	)
		return "authoring_result_unreadable";
	if (isSessionHostUnavailable(error)) return "session_host_unavailable";
	if (isWedgedSubmissionError(error) || isPriorRunBusyTerminalFailure(error)) return "session_submission_wedged";
	if (error instanceof BrokerAuthorityError) return "broker_authority_refused";
	if (error instanceof SessionTerminalError || error instanceof SessionRequestTimeoutError)
		return "authoring_turn_failed";
	// Context exhaustion outranks the phase codes: it is the one class the safety
	// net acts on, and an operator must be able to see it in the event row.
	if (failureClass === "context") return "authoring_context_exhausted";
	// A malformed or off-contract body is a response-contract failure, not a
	// mystery internal error.
	if (failureClass === "protocol") return "authoring_response_invalid";
	// Executor class from here down, most specific first. An orphaned external
	// run outranks the aside timeout: the same message usually looks like a
	// timeout, but "external work is still running" is the actionable part. Both
	// get their own code so neither can ever be aggregated with context
	// exhaustion.
	if (isOrphanedExecutorFailure(error)) return "orphaned_executor";
	if (isAsideTimeoutFailure(error)) return "aside_timeout";
	// The session port waited for the runtime to go idle and it never did.
	// Nothing was sent, so the event replays cleanly on the next reconcile.
	if (isSessionBusy(error)) return "session_busy";
	// Some SDK prompt-terminal failures arrive wrapped in an ordinary Error,
	// losing the top-level GjcCliError class while preserving the terminal code
	// in `cause`. Keep these on the authoring-failure path instead of collapsing
	// them into an opaque internal_error.
	if (phase === "request" && hasSdkPromptTerminalFailure(error)) return "authoring_turn_failed";
	// A structured SDK refusal is classified by the phase it interrupted: the
	// sanitized message no longer carries the verb name, and "internal_error"
	// hid every configure/request refusal (live: 169 rows in one day, all
	// GjcCliError exitCode 0 at #dispatchBatch, none actionable).
	if (error instanceof GjcCliError) {
		if (phase === "bind" || phase === "configure") return "session_bind_failed";
		if (phase === "request") return "authoring_turn_failed";
	}
	const message = error instanceof Error ? error.message : String(error);
	if (message.includes("session send") || message.includes("SessionPort")) return "authoring_turn_failed";
	if (message.includes("session bind")) return "session_bind_failed";
	if (/timeout|timed out|tool failed|external tool|lock/i.test(message)) return "executor_failed";
	if (step !== undefined) return "authoring_turn_failed";
	return "internal_error";
}

const PRIOR_RUN_BUSY_TERMINAL_REASON = "Timed out waiting for prior agent run to finish before prompting.";

function findSdkPromptTerminalFailure(
	error: unknown,
	matches: (fields: Record<string, unknown>) => boolean = () => true,
): Record<string, unknown> | undefined {
	const visit = (value: unknown, depth: number, seen: Set<object>): Record<string, unknown> | undefined => {
		if (depth > 4 || value === null || typeof value !== "object" || seen.has(value)) return undefined;
		seen.add(value);
		const fields = value as Record<string, unknown>;
		if (fields.code === "sdk_prompt_terminal_failed" && matches(fields)) return fields;
		for (const key of ["cause", "details", "error", "detail", "status"]) {
			const found = visit(fields[key], depth + 1, seen);
			if (found) return found;
		}
		return undefined;
	};
	return visit(error, 0, new Set());
}

function hasSdkPromptTerminalFailure(error: unknown): boolean {
	return findSdkPromptTerminalFailure(error) !== undefined;
}

/** Exact gjc terminal reason that means a previous agent run still owns the prompt queue. */
function isPriorRunBusyTerminalFailure(error: unknown): boolean {
	return (
		findSdkPromptTerminalFailure(error, (terminalFailure) =>
			[terminalFailure.reason, terminalFailure.message].some(
				(value) => typeof value === "string" && value.includes(PRIOR_RUN_BUSY_TERMINAL_REASON),
			),
		) !== undefined
	);
}

/**
 * A terminal failure at the submission phase whose cause is the agent runtime
 * itself: the runtime took the prompt but never got it into an agent
 * (`phase=submission`, category `agent_runtime`, provenance `agent_failed`).
 * Mirrors `isWedgedSubmission` in orchestrator/persona-session.ts, whose comment
 * records the measured shape: `Timed out waiting for prior agent run to finish
 * before prompting.` repeats on every later prompt to that session.
 *
 * Like a relay hello failure, this is positive pre-send evidence (nothing
 * started, nothing ran), so it is the one class of turn failure that justifies
 * rolling the session. Provider, transport and cancellation failures stay on
 * their session.
 */
function isWedgedSubmissionError(error: unknown): boolean {
	if (!(error instanceof SessionTerminalError)) return false;
	const status = error.status.status;
	const outcome = status.outcome;
	if (outcome?.phase !== "submission" || outcome.provenance !== "agent_failed" || outcome.category !== "agent_runtime")
		return false;
	return ![status.error?.code, outcome.code, outcome.providerCode].includes("aborted");
}

/** Only positive evidence that the prompt was not sent can justify rolling a session. */
function isSessionHostUnavailable(error: unknown): boolean {
	if (error instanceof RelayHelloError) return true;
	const step = sessionRequestStep(error);
	if (error instanceof RelayRefusedError) return step === "attach" && error.code === "session_unavailable";
	return error instanceof RelayClosedError && step === "attach";
}

/**
 * The authoring turn frequently does real work (posts, files, tool calls) and
 * then answers in prose or a fenced ```json block around the array. A strict
 * JSON.parse of the whole reply marked those events failed even though the
 * side effect had happened (live: sns-x-v7 / sns-threads-v7 "failed_no_retry"
 * while the posts were up). Accept the whole reply as JSON, a fenced block, or
 * the last top-level [...] array in the text; anything else is still invalid.
 */
export function parseAuthoredArray(response: string): unknown {
	const text = response.trim();
	const attempts: string[] = [text];
	const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]?.trim() ?? "");
	attempts.push(...fenced.reverse());
	// Every balanced top-level [...] span in the text, last first (the array
	// usually closes the reply); string contents are skipped so notes with
	// brackets do not split the span.
	const spans: string[] = [];
	for (let start = text.indexOf("["); start >= 0; start = text.indexOf("[", start + 1)) {
		let depth = 0;
		let inString = false;
		for (let i = start; i < text.length; i++) {
			const ch = text[i];
			if (inString) {
				if (ch === "\\") i++;
				else if (ch === '"') inString = false;
				continue;
			}
			if (ch === '"') inString = true;
			else if (ch === "[") depth++;
			else if (ch === "]" && --depth === 0) {
				spans.push(text.slice(start, i + 1));
				break;
			}
		}
	}
	attempts.push(...spans.reverse());
	let parsedNonArray = false;
	for (const candidate of attempts) {
		if (!candidate) continue;
		try {
			const parsed = JSON.parse(candidate) as unknown;
			if (Array.isArray(parsed)) return parsed;
			parsedNonArray = true;
		} catch {
			// Raw parser errors can echo attacker-controlled response text.
		}
	}
	if (parsedNonArray) throw new Error("authoring response is not a JSON array");
	throw new Error("authoring response JSON is unparseable");
}

/** Failure code of an exhausted event given up on an unresolvable authoring turn (#702). */
const AUTHORING_TURN_UNRESOLVED = "authoring_turn_unresolved";

/** Durable pointer from an event to the authoring turn its last dispatch started (#187). */
function authoringTurnKey(eventId: string): string {
	return `monitor_authoring_turn:${eventId}`;
}

function parseAuthoringTurnPointer(raw: string): AuthoringTurnPointer | undefined {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	const eventIds = record.eventIds;
	if (
		typeof record.sessionId !== "string" ||
		!record.sessionId ||
		typeof record.opRef !== "string" ||
		!record.opRef ||
		!Array.isArray(eventIds) ||
		eventIds.length === 0 ||
		!eventIds.every((eventId): eventId is string => typeof eventId === "string" && eventId.length > 0) ||
		new Set(eventIds).size !== eventIds.length
	)
		return undefined;
	return { sessionId: record.sessionId, opRef: record.opRef, eventIds };
}

function sameAuthoringTurn(left: AuthoringTurnPointer, right: AuthoringTurnPointer): boolean {
	return (
		left.sessionId === right.sessionId &&
		left.opRef === right.opRef &&
		left.eventIds.length === right.eventIds.length &&
		left.eventIds.every((eventId) => right.eventIds.includes(eventId))
	);
}

function monitorOriginForEvent(monitor: MonitorRecord, eventType: string): OriginRef {
	return monitorSessionOrigin(
		monitor.monitorId,
		monitor.eventTypes.includes(eventType) ? eventType : CATCH_ALL_EVENT_ORIGIN.conversationId,
	);
}

function monitorReadinessOriginKey(monitorId: string): string {
	return originKey(monitorSessionOrigin(monitorId, CATCH_ALL_EVENT_ORIGIN.conversationId));
}

/** Extract a bounded, sanitized lower-level diagnosis without persisting raw error payloads. */
export function failureDetail(error: unknown): string {
	const object = (value: unknown): Record<string, unknown> =>
		value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
	const fields = object(error);
	const report = object(fields.status);
	const terminal = object(report.status);
	const terminalError = object(terminal.error);
	const allowedClasses = new Set([
		"Error",
		"TypeError",
		"RangeError",
		"AggregateError",
		"TimeoutError",
		"GjcCliError",
		"GjcRuntimeError",
		"SessionTerminalError",
		"SessionRequestTimeoutError",
		"RebindCapExceededError",
		"RelayHelloError",
		"RelayRefusedError",
		"RelayClosedError",
		"RelayRequestTimeoutError",
		"TailCapacityError",
		"TranscriptIncompleteError",
		"OpRefError",
		"OpRefRejectedError",
		"GjcCliUnavailableError",
		"LastAssistantUnreadableError",
		"AuthoringResultUnavailableError",
		"BrokerAuthorityError",
		"ModelNotSelectedError",
	]);
	const allowedCodes = new Set([
		"broker_unavailable",
		"session_not_found",
		"session_closed",
		"session_expired",
		"session_terminal",
		"session_unavailable",
		"operation_not_found",
		"timeout",
		"deadline_exceeded",
		"internal_error",
		"context_length_exceeded",
		"rebind_cap_exceeded",
		"busy",
		"client_ref_conflict",
		"terminal_uncertain",
		"uncertain_after_send",
		"spawn_failed",
		"invalid_request",
		"resource_gone",
		"usage",
		"relay_hello_missing",
		"relay_closed",
		"relay_timeout",
		"cutover_required",
		"authority_mismatch",
		"unowned_session",
		"old_work_open",
		"quarantined",
		"invalid_authority",
		"last_assistant_not_json",
		"last_assistant_no_page",
		"last_assistant_no_items",
		"last_assistant_null_item",
		"last_assistant_non_text_item",
		"model_not_selected",
		"output_pending",
		"transport_error",
		"output_unavailable",
		"invalid_evidence",
		"identity_mismatch",
		"incomplete_body",
	]);
	const rawName = error instanceof Error ? error.constructor.name : typeof error;
	const name = allowedClasses.has(rawName) ? rawName : error instanceof Error ? "Error" : "unknown";
	// An unlisted Error subclass (for example a launcher's policy refusal) is still
	// named, as a bare identifier: without it the row says only `Error` (#702).
	const foreignClass =
		name === "Error" && rawName !== "Error" && /^[A-Z][A-Za-z0-9]{0,63}$/.test(rawName) ? rawName : undefined;
	// Codes and classifiers the SDK itself produced (envelope error code, terminal
	// error code, outcome classifiers) are bounded machine tokens. A top-level
	// `code` on a listed class stays on the explicit allowlist; an unlisted
	// subclass keeps its code only as a sanitized snake_case token. Nested cause
	// codes and their redacted, length-bounded message are surfaced separately.
	const sdkToken = (value: unknown): string | undefined =>
		typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : undefined;
	const nestedCauses = (value: unknown): Record<string, unknown>[] => {
		const found: Record<string, unknown>[] = [];
		const seen = new Set<object>();
		const visit = (candidate: unknown, depth: number, inCause: boolean): void => {
			if (depth > 4 || candidate === null || typeof candidate !== "object" || seen.has(candidate)) return;
			seen.add(candidate);
			const fields = object(candidate);
			if (inCause) found.push(fields);
			for (const key of ["details", "error", "detail", "status", "outcome", "cause"])
				visit(fields[key], depth + 1, inCause || key === "cause");
		};
		visit(value, 0, false);
		return found;
	};
	const causes = nestedCauses(error);
	const safeCode = (value: unknown): string | undefined => {
		const token = sdkToken(value);
		return token !== undefined && sanitizeDiagnostic(token) === token ? token : undefined;
	};
	const causeCode = causes
		.slice()
		.reverse()
		.map((fields) => safeCode(fields.code))
		.find((candidate) => candidate !== undefined);
	const safeMessage = (value: unknown): string | undefined => {
		if (typeof value !== "string") return undefined;
		const cleaned = sanitizeDiagnosticDetail(value, 128);
		if (!cleaned || cleaned === causeCode) return undefined;
		return cleaned;
	};
	// A top-level message is recorded only for classes that build it from fixed
	// text and numbers. Every other message can carry operation ids or remote
	// text (SessionTerminalError, RelayRefusedError, plain Error).
	const messageSourceClasses = new Set(["RelayHelloError", "ModelNotSelectedError"]);
	const message =
		causes
			.slice()
			.reverse()
			.flatMap((fields) => [fields.runtimeMessage, fields.message, fields.reason])
			.map(safeMessage)
			.find((candidate) => candidate !== undefined) ??
		(messageSourceClasses.has(name) && error instanceof Error ? safeMessage(error.message) : undefined);
	const outcomeBody = object(terminal.outcome);
	// #178: a GjcCliError carries the SDK envelope code in `details`, and a
	// terminal status carries it in `error.code` or `outcome.code`. Those are the
	// only facts that tell a deadline kill from a provider refusal.
	const code =
		(typeof fields.code === "string" && allowedCodes.has(fields.code) ? fields.code : undefined) ??
		(foreignClass ? safeCode(fields.code) : undefined) ??
		sdkToken(terminalError.code) ??
		sdkToken(outcomeBody.code) ??
		(error instanceof GjcCliError ? sdkToken(envelopeErrorCode(error.details)) : undefined);
	// A GjcCliError with exit status 0 is a structured `{ok:false}` envelope
	// refusal (or an unparseable success print), not a process failure; recording
	// `exitCode: 0` on a failure row reads as "the CLI succeeded" (#178).
	const transport =
		error instanceof GjcCliError && error.exitCode === 0
			? error.details !== null && typeof error.details === "object"
				? "envelope"
				: "malformed_envelope"
			: undefined;
	const exitCode = transport ? undefined : fields.exitCode;
	const outcome: Record<string, string> = {};
	for (const key of ["kind", "reason", "providerCode", "phase", "category", "provenance"]) {
		const value = sdkToken(outcomeBody[key]);
		if (value) outcome[key] = value;
	}
	// A request-wait timeout says where the operation was when the wait gave up.
	const lastStatus = sdkToken(object(object(fields.lastStatus).status).status);
	const signal = fields.signal;
	const status = terminal.status;
	const outerMessage = error instanceof Error ? error.message : "";
	const cause = /Database has closed|closed database/i.test(outerMessage)
		? "database_closed"
		: /SQLITE_BUSY|database is locked/i.test(outerMessage)
			? "database_busy"
			: /timed out|timeout/i.test(outerMessage)
				? "timeout"
				: undefined;
	const frameNames = ["withTransaction", "#dispatchBatch", "monitorEventFencedFail", "request", "bind"];
	const frame =
		error instanceof Error && error.stack
			? frameNames.find((candidate) => error.stack?.split("\n").some((line) => line.includes(candidate)))
			: undefined;
	const step = sessionRequestStep(error);
	return JSON.stringify({
		class: name,
		...(foreignClass ? { foreignClass } : {}),
		...(step ? { step } : {}),
		...(code ? { code } : {}),
		...(transport ? { transport } : {}),
		...(typeof exitCode === "number" && Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255
			? { exitCode }
			: {}),
		...(typeof signal === "string" && ["SIGTERM", "SIGKILL", "SIGABRT", "SIGSEGV", "SIGINT"].includes(signal)
			? { signal }
			: {}),
		...(typeof status === "string" && ["failed", "cancelled", "completed", "aborted"].includes(status)
			? { terminal: status }
			: {}),
		...(Object.keys(outcome).length ? { outcome } : {}),
		...(lastStatus ? { lastStatus } : {}),
		...(cause ? { cause } : {}),
		...(frame ? { frame } : {}),
		...(causeCode && causeCode !== code ? { causeCode } : {}),
		...(message ? { message } : {}),
	});
}
