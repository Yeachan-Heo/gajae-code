import { logger } from "@gajae-code/utils";
import {
	lookupOwnedRegistration,
	registerOwnedRegistration,
	resolveToolLineage,
	retireOwnedRegistrationForDeadLetter,
	unregisterOwnedRegistration,
} from "../session/terminal-abort";
import type { AgentProgress, AgentSource, LocalErrorSummary } from "../task/types";

const DELIVERY_RETRY_BASE_MS = 500;
const DELIVERY_RETRY_MAX_MS = 30_000;
const DELIVERY_RETRY_JITTER_MS = 200;
const DEFAULT_RETENTION_MS = 5 * 60 * 1000;
const DEFAULT_MAX_RUNNING_JOBS = 15;
const MONITOR_TOMBSTONE_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_DELIVERY_QUEUE = 100;
const DELIVERY_MAX_TEXT_BYTES = 64 * 1024;
const DELIVERY_PREVIEW_HEAD_BYTES = 32 * 1024;
const DELIVERY_PREVIEW_TAIL_BYTES = 32 * 1024;
const DELIVERY_MAX_ATTEMPTS = 3;
const MAX_DEAD_LETTERED_DELIVERIES = 50;
const MAX_EVICTED_DEAD_LETTERS = 64;

export interface AsyncJob {
	id: string;
	readonly generation: string;
	type: "bash" | "task";
	status: "running" | "completed" | "failed" | "cancelled" | "paused";
	startTime: number;

	/**
	 * Wall-clock ms when the job left the `running` state (completed, failed,
	 * cancelled, or paused). Undefined while running. Frozen on the first
	 * terminal/pause transition so elapsed-time renderers stop counting once a
	 * job is no longer active instead of growing forever against `Date.now()`.
	 */
	endTime?: number;
	label: string;
	abortController: AbortController;
	promise: Promise<void>;
	resultText?: string;
	errorText?: string;
	/** Safe, bounded cause when session setup failed before the LLM began work. */
	setupFailureSummary?: string;
	/** Safe, bounded summary of a terminal local (non-provider) failure kind. */
	localErrorSummary?: LocalErrorSummary;
	metadata?: AsyncJobMetadata;
	/**
	 * Registry id of the agent that registered the job (e.g. "0-Main",
	 * "3-AuthLoader"). Used by scoped cancel/list APIs so a subagent's teardown
	 * does not cancel its parent's jobs. Undefined for callers that don't
	 * supply an id (e.g. legacy tests, SDK consumers without an agent context).
	 */
	ownerId?: string;
}

/**
 * Elapsed wall-clock ms for a job, frozen once it stops running. While the job
 * is active (`endTime` undefined) this counts against `now`; after it stops it
 * returns the fixed `endTime - startTime` span so status renderers do not keep
 * incrementing a completed job's timer.
 */
export function jobElapsedMs(job: Pick<AsyncJob, "startTime" | "endTime">, now: number = Date.now()): number {
	return Math.max(0, (job.endTime ?? now) - job.startTime);
}

export interface AsyncJobMetadata {
	/** Set once a foreground wait has been folded, so surfacing can show folded work. */
	backgrounded?: boolean;
	subagent?: {
		id: string;
		agent: string;
		agentSource: AgentSource;
		description?: string;
		assignment?: string;
		duplicateIdentity?: string;
		duplicateDisposition?: "warned" | "superseded";
	};
	/** True when this bash job was started by the `monitor` tool (vs plain async bash). */
	monitor?: boolean;
}

/**
 * Typed outcome a subagent task run may produce. A `paused` outcome is
 * non-terminal and non-delivering: the run suspended at a safe boundary and the
 * subagent can be resumed from its persisted sessionFile. `completed` always
 * wins a race with a late pause because the run returns it once it has actually
 * finished. A `failed` outcome retains a safe setup diagnostic for receipt rendering.
 */
export type SubagentRunOutcome =
	| { kind: "completed"; text: string }
	| { kind: "failed"; text: string; setupFailureSummary?: string; localErrorSummary?: LocalErrorSummary }
	| { kind: "paused"; note?: string };

/** Canonical lifecycle of a subagent across pause/resume cycles. */
export type SubagentLifecycle = "running" | "paused" | "queued" | "completed" | "failed" | "cancelled";

/** Maximum time allowed to prove owned subagents have stopped before replacement. */
export const OWNER_SUBAGENT_SHUTDOWN_TIMEOUT_MS = 5_000;

export class OwnerSubagentShutdownError extends Error {
	readonly code = "owner_shutdown_in_progress";

	constructor() {
		super("Cannot start subagent while owner shutdown is in progress.");
		this.name = "OwnerSubagentShutdownError";
	}
}

export interface OwnerSubagentShutdownTarget {
	subagentId: string;
	jobId: string | null;
	source: "record" | "metadata_job";
}

export interface OwnerSubagentShutdownLease {
	ownerId: string;
	id: string;
	targets: readonly OwnerSubagentShutdownTarget[];
}

export interface OwnerSubagentShutdownProof {
	ownerId: string;
	leaseId: string;
	confirmed: boolean;
	reason: "confirmed" | "deadline_exceeded" | "missing_terminal_evidence" | "lease_lost";
	targets: readonly OwnerSubagentShutdownTarget[];
	terminalIds: readonly string[];
	unresolvedIds: readonly string[];
}

interface OwnerSubagentShutdownLeaseState {
	lease: OwnerSubagentShutdownLease;
	backingJobIds: ReadonlyMap<string, readonly string[]>;
	phase: "active" | "proving" | "proved";
	proof?: OwnerSubagentShutdownProof;
}

/**
 * Live, executor-owned control handle for a RUNNING subagent. Registered when a
 * subagent run starts and removed on pause/terminal so a paused subagent retains
 * no live `AgentSession` reference (leak-free).
 */
export interface SubagentLiveHandle {
	/** Request a cooperative safe-boundary pause (never aborts the in-flight tool). */
	requestPause(): void;
	/** Inject a steering message into the live session. */
	injectMessage(
		content: string,
		deliverAs: "steer" | "followUp" | "nextTurn",
		opts?: { fromAgentId?: string },
	): Promise<void>;
}

/**
 * Canonical, stable-id-keyed record for a subagent. Survives `AsyncJob`
 * eviction so resume stays addressable by subagent id, and is the single source
 * of truth for control-plane status and identity.
 */
export interface SubagentRecord {
	subagentId: string;
	ownerId?: string;
	/** Current live/last AsyncJob id; null while queued with no active job. */
	currentJobId: string | null;
	historicalJobIds: string[];
	status: SubagentLifecycle;
	sessionFile: string | null;
	/**
	 * Explicit veto, not a complete availability result. False always denies;
	 * true still requires an owner-compatible descriptor or non-blank session
	 * file, followed by a separately available runner (`no_runner` otherwise).
	 */
	resumable: boolean;
	queued?: { ownerId?: string; seq: number; message?: string; resumeToolCallId?: string; createdAt: number };
	/** Last queued-resume seq for a CANCELLED queued resume (rec.queued is
	 *  cleared on cancel): retained on the record so owned settlement's second
	 *  proof can still see the generation as provably cancelled, without a
	 *  separate FIFO-capped evidence set that could evict an in-flight
	 *  settlement's generation (review thread P2). */
	terminalQueuedSeq?: number;
	/** Resolved model the subagent was asked to use, e.g. "openai-codex/gpt-5.5". */
	requestedModel?: string;
	/** Model actually used after auth fallback (#985); equals requestedModel when no fallback. */
	effectiveModel?: string;
	/** True when the requested model lacked credentials and the subagent fell back to the parent model. */
	modelFellBack?: boolean;
	/** True when the effective subagent provider is in fast mode. */
	fastMode?: boolean;
	duplicateIdentity?: string;
	duplicateDisposition?: "warned" | "superseded";
	terminalGeneration?: string;
	/** Generation of currentJobId, preventing stale ID reuse from mutating this record. */
	currentJobGeneration?: string;
}

/** Lightweight, manager-owned resume payload. The async layer treats `data` as opaque. */
export interface ResumeDescriptor {
	subagentId: string;
	ownerId?: string;
	data: unknown;
}

/**
 * In-memory resume runner bound to the session that originally launched a
 * subagent. Never serialized: process restart drops it so resume fails closed.
 */
export type ResumeRunner = (
	subagentId: string,
	message?: string,
	descriptor?: ResumeDescriptor,
	resumeToolCallId?: string,
) => string | undefined;

function sessionFileFromResumeDescriptorData(data: unknown): string | null {
	if (typeof data !== "object" || data === null) return null;
	const sessionFile = (data as { sessionFile?: unknown }).sessionFile;
	return typeof sessionFile === "string" && sessionFile.trim().length > 0 ? sessionFile : null;
}

/**
 * Derive retained context from an already owner-compatible descriptor or a
 * legacy session file. A descriptor is sufficient even when `sessionFile` is
 * null because the descriptor is the payload the resume runner consumes.
 */
function hasRetainedResumeContext(input: {
	resumable: boolean;
	sessionFile: string | null;
	descriptor: ResumeDescriptor | undefined;
}): boolean {
	if (!input.resumable) return false;
	return (
		input.descriptor !== undefined || (typeof input.sessionFile === "string" && input.sessionFile.trim().length > 0)
	);
}

/** A pending resume awaiting a free concurrency slot. */
interface ResumeQueueEntry {
	subagentId: string;
	ownerId?: string;
	seq: number;
	message?: string;
	createdAt: number;
}

export interface AsyncJobManagerOptions {
	onJobComplete: (jobId: string, text: string, job?: AsyncJob) => void | Promise<void>;
	maxRunningJobs?: number;
	retentionMs?: number;
}

export interface AsyncJobAdmission {
	readonly manager: AsyncJobManager;
}

export interface AsyncJobDisposeDiagnostics {
	stuckJobIds: string[];
	deliveriesDrained: boolean;
}

interface AsyncJobDelivery {
	jobId: string;
	generation: string;
	job: AsyncJob;
	text: string;
	originalBytes?: number;
	truncated?: boolean;
	attempt: number;
	nextAttemptAt: number;
	lastError?: string;
	ownerId?: string;
	promise?: Promise<void>;
}

interface DeadLetteredDelivery {
	jobId: string;
	generation: string;
	attempt: number;
	lastError?: string;
}

/**
 * A retry-cap delivery failure recorded AFTER its job record was evicted.
 *
 * The ordinary dead-letter map is pruned by record existence
 * ({@link AsyncJobManager.prototype constructor}'s `#pruneEvictedDeadLetters`),
 * so a failure in that window would otherwise leave no visible terminal state
 * and breach the no-silent-starvation contract. Scalar-only by design: nothing
 * here retains an `AsyncJob`.
 */
interface EvictedDeadLetteredDelivery {
	jobId: string;
	generation: string;
	ownerId?: string;
	attempt: number;
	lastError?: string;
	recordedAt: number;
}

/** Per-job public delivery classification. Exactly one value per terminal job. */
export type JobDeliveryState = "pending" | "delivered" | "failed-visible";

/** One job as projected by {@link AsyncJobManager.getJobsSnapshot}. */
export interface AsyncJobSnapshotEntry {
	id: string;
	kind: string;
	label: string;
	status: AsyncJob["status"];
	generation: string;
	backgrounded: boolean;
	deliveryState: JobDeliveryState;
}

/** Scalar delivery-failure evidence that may outlive its AsyncJob record. */
export interface DeadLetteredJobSnapshotEntry {
	jobId: string;
	generation: string;
	ownerId?: string;
	attempt: number;
	lastError?: string;
	recordedAt: number;
}

/**
 * One atomic projection of job + delivery state.
 *
 * Computed in a single synchronous pass with no interleaved awaits so it cannot
 * tear, and consumed verbatim: a UI that re-derives delivery classification from
 * separate getters can disagree with this and produce a job that is in no public
 * state at all.
 */
export interface AsyncJobsSnapshot {
	jobs: AsyncJobSnapshotEntry[];
	deadLettered: DeadLetteredJobSnapshotEntry[];
}

export interface AsyncJobDeliveryState {
	queued: number;
	delivering: boolean;
	nextRetryAt?: number;
	pendingJobIds: string[];
	deadLettered: number;
}

export interface AsyncJobLifecycleCleanup {
	onCancel?: (job: AsyncJob) => void;
	onTerminal?: (job: AsyncJob) => void;
	onEvict?: (job: AsyncJob) => void;
	/**
	 * Idempotent residual cleanup invoked by a post-eviction tombstone purge
	 * (e.g. a late `job cancel` after the job left the registry). Kept distinct
	 * from the at-most-once lifecycle phases so a tombstone purge never has to
	 * re-invoke a phase hook. Must be safe to call repeatedly.
	 */
	onTombstonePurge?: (job: AsyncJob) => void;
}

export interface MonitorTombstone {
	jobId: string;
	ownerId?: string;
	status: AsyncJob["status"];
	expiresAt: number;
	purge: () => unknown;
}

export interface AsyncJobRegisterOptions {
	id?: string;
	/** Registry id of the agent that owns this job; used to scope cancelAll. */
	ownerId?: string;
	/** Structured metadata for tool-specific control surfaces. */
	metadata?: AsyncJobMetadata;
	onProgress?: (text: string, details?: Record<string, unknown>) => void | Promise<void>;
	lifecycle?: AsyncJobLifecycleCleanup;
	/** Reserved capacity consumed atomically by this registration. */
	admissionToken?: AsyncJobAdmission;
}

/**
 * Filter applied to job query/cancel APIs. With `ownerId`, results are
 * restricted to jobs registered by that agent (registry id from
 * `AgentRegistry`, e.g. "0-Main", "3-AuthLoader").
 */
export interface AsyncJobFilter {
	ownerId?: string;
}

export type AsyncJobWaitCondition = "all_terminal" | "any_terminal";
export type AsyncJobWaitOutcome = "completed" | "timed_out_wait" | "interrupted";

export interface AsyncJobWaitTarget {
	targetId: string;
	jobId: string | null;
	subagentId?: string;
	generation: string;
	ownerId?: string;
	initialStatus: AsyncJob["status"] | "queued" | "not_found";
}

export interface AsyncJobWaitResult {
	outcome: AsyncJobWaitOutcome;
	condition: AsyncJobWaitCondition;
	terminalJobIds: string[];
	pendingJobIds: string[];
}

export interface AsyncJobWaitHandle {
	readonly token: string;
	readonly result: Promise<AsyncJobWaitResult>;
	acknowledge(targetIds?: readonly string[]): { acknowledged: boolean; jobIds: string[] };
	close(): void;
}

export interface AsyncJobWatchHandle {
	close(): number;
}

interface TerminalEvent {
	generation: string;
	jobId: string | null;
	subagentId?: string;
	ownerId?: string;
	status: "completed" | "failed" | "cancelled";
	createdAt: number;
}

interface TerminalWaitState {
	token: string;
	targets: AsyncJobWaitTarget[];
	condition: AsyncJobWaitCondition;
	resolve: (result: AsyncJobWaitResult) => void;
	settled: boolean;
	acknowledged: boolean;
	terminalGenerations: Set<string>;
}

function sliceTextFromUtf8ByteOffset(text: string, offsetBytes: number): string {
	if (offsetBytes <= 0) return text;
	let consumedBytes = 0;
	let codeUnitIndex = 0;
	for (const char of text) {
		const charBytes = Buffer.byteLength(char, "utf8");
		if (consumedBytes + charBytes > offsetBytes) break;
		consumedBytes += charBytes;
		codeUnitIndex += char.length;
	}
	return text.slice(codeUnitIndex);
}

function sliceTextAfterUtf8ByteOffset(text: string, offsetBytes: number): string {
	if (offsetBytes <= 0) return text;
	let consumedBytes = 0;
	let codeUnitIndex = 0;
	for (const char of text) {
		const charBytes = Buffer.byteLength(char, "utf8");
		consumedBytes += charBytes;
		codeUnitIndex += char.length;
		if (consumedBytes >= offsetBytes) break;
	}
	return text.slice(codeUnitIndex);
}

function sliceTextToUtf8ByteLength(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	let consumedBytes = 0;
	let codeUnitIndex = 0;
	for (const char of text) {
		const charBytes = Buffer.byteLength(char, "utf8");
		if (consumedBytes + charBytes > maxBytes) break;
		consumedBytes += charBytes;
		codeUnitIndex += char.length;
	}
	return text.slice(0, codeUnitIndex);
}

/**
 * A slice of process-stream output for a background job, as recorded by
 * `appendOutput` / read by `readOutputSince`.
 *
 * The cursor model is monotonic UTF-8 byte offsets. `nextOffset` is the offset
 * to pass to the next read to receive only fresh bytes; `startOffset` is the
 * first byte the manager still retains for this job. When the requested offset
 * is older than `startOffset`, the manager returns the retained tail and sets
 * `truncated: true`.
 */
export interface AsyncJobOutputSlice {
	jobId: string;
	status: AsyncJob["status"];
	text: string;
	startOffset: number;
	nextOffset: number;
	truncated: boolean;
}

/** Internal: a single chunk of captured stdout/stderr keyed by its byte range. */
interface AsyncJobOutputChunk {
	startByte: number;
	endByte: number;
	text: string;
}

interface AsyncJobOutputState {
	chunks: AsyncJobOutputChunk[];
	startOffset: number;
	nextOffset: number;
	retainedBytes: number;
}

/** Default retention cap for per-job captured output. ~512 KiB matches the
 *  bash tail-buffer order of magnitude without dominating session memory. */
export const DEFAULT_JOB_OUTPUT_RETENTION_BYTES = 512 * 1024;

export class AsyncJobManager {
	static #instance: AsyncJobManager | undefined;

	/** Process-global instance shared by internal URL protocol handlers and tools. */
	static instance(): AsyncJobManager | undefined {
		return AsyncJobManager.#instance;
	}

	static readonly #byEndpoint = new Map<string, AsyncJobManager>();

	/** Register a manager for a top-level session endpoint so concurrent
	 *  sessions' owned work can be settled in the ABORTING endpoint's manager
	 *  instead of the last-created process-global instance (review thread P1).
	 *  Returns TRUE when the mapping was installed (or already held by this
	 *  manager); returns FALSE when the endpoint id is already held by a
	 *  FOREIGN live manager — a second top-level session constructed or
	 *  resumed under that endpoint must then fail construction instead of
	 *  silently replacing the first manager, which would make the first
	 *  session's tools resolve the second manager and let same-id jobs be
	 *  queried, registered, or cancelled across sessions (review thread P1). */
	static registerForEndpoint(endpointId: string, manager: AsyncJobManager): boolean {
		const holder = AsyncJobManager.#byEndpoint.get(endpointId);
		if (holder !== undefined && holder !== manager) return false;
		AsyncJobManager.#byEndpoint.set(endpointId, manager);
		return true;
	}

	static forEndpoint(endpointId: string | undefined): AsyncJobManager | undefined {
		if (endpointId === undefined) return undefined;
		return AsyncJobManager.#byEndpoint.get(endpointId);
	}

	static unregisterForEndpoint(endpointId: string): void {
		AsyncJobManager.#byEndpoint.delete(endpointId);
	}

	/** Reverse lookup: the endpoint this manager is registered under, if any
	 *  (review thread P1 — endpoint-scoped lineage resolution). */
	static endpointIdOf(manager: AsyncJobManager | undefined): string | undefined {
		if (!manager) return undefined;
		for (const [endpointId, candidate] of AsyncJobManager.#byEndpoint) {
			if (candidate === manager) return endpointId;
		}
		return undefined;
	}

	/** Re-register a manager under a successor endpoint id after a committed
	 *  session-identity transition (newSession / switchSession / handoff).
	 *  Lineage bindings made after the transition use the successor id, so the
	 *  process-global endpoint registry must follow — otherwise
	 *  `endpointIdOf()` keeps resolving the predecessor and a queued subagent
	 *  resume can neither resolve its lineage nor register its owned tuple
	 *  (review thread P1). Returns TRUE when the mapping was moved (or no move
	 *  was needed); returns FALSE when the successor endpoint is owned by a
	 *  FOREIGN live manager — the transition must then abort or roll back
	 *  BEFORE retiring predecessor state, because leaving this manager under
	 *  the predecessor while tools resolve the successor to the foreign
	 *  manager sends jobs to the wrong session and owned aborts lose their
	 *  causal set (review thread P1). */
	static rekeyForEndpoint(
		predecessorEndpointId: string,
		successorEndpointId: string,
		manager: AsyncJobManager | undefined,
	): boolean {
		if (!manager || predecessorEndpointId === successorEndpointId) return true;
		if (AsyncJobManager.#byEndpoint.get(predecessorEndpointId) !== manager) return true;
		const successorOwner = AsyncJobManager.#byEndpoint.get(successorEndpointId);
		if (successorOwner !== undefined && successorOwner !== manager) return false;
		AsyncJobManager.#byEndpoint.delete(predecessorEndpointId);
		AsyncJobManager.#byEndpoint.set(successorEndpointId, manager);
		return true;
	}

	/** Remove every endpoint registration owned by the manager. Disposal-safe:
	 *  covers registrations whose key drifted from the session's current id
	 *  (provider session ids, mid-transition teardown) and stale predecessor
	 *  keys, so teardown cannot leave a dead manager behind. */
	static unregisterManager(manager: AsyncJobManager | undefined): void {
		if (!manager) return;
		for (const [endpointId, candidate] of [...AsyncJobManager.#byEndpoint]) {
			if (candidate === manager) AsyncJobManager.#byEndpoint.delete(endpointId);
		}
	}

	/** Install or clear the process-global instance. */
	static setInstance(value: AsyncJobManager | undefined): void {
		AsyncJobManager.#instance = value;
	}

	/** Reset the process-global instance. Test-only. */
	static resetForTests(): void {
		AsyncJobManager.#instance = undefined;
		AsyncJobManager.#byEndpoint.clear();
	}

	readonly #jobs = new Map<string, AsyncJob>();
	readonly #deliveries: AsyncJobDelivery[] = [];
	readonly #inFlightDeliveries: AsyncJobDelivery[] = [];
	readonly #suppressedDeliveries = new Set<string>();
	readonly #deliveryAckOwners = new Map<string, string>();
	readonly #watchedJobs = new Map<string, number>();
	readonly #watchedGenerations = new Map<string, number>();
	readonly #evictionTimers = new Map<string, NodeJS.Timeout>();
	readonly #outputState = new Map<string, AsyncJobOutputState>();
	readonly #ownerCleanups = new Map<string, Set<() => void>>();
	readonly #lifecycles = new Map<string, AsyncJobLifecycleCleanup>();
	readonly #lifecyclePhases = new Map<string, Set<"cancel" | "terminal" | "evict">>();
	readonly #monitorTombstones = new Map<string, MonitorTombstone>();
	readonly #outputRetentionBytes = DEFAULT_JOB_OUTPUT_RETENTION_BYTES;
	readonly #onJobComplete: AsyncJobManagerOptions["onJobComplete"];
	readonly #maxRunningJobs: number;
	#pendingAdmissions = 0;
	readonly #admissions = new WeakMap<AsyncJobAdmission, boolean>();
	readonly #retentionMs: number;
	#deliveryLoop: Promise<void> | undefined;
	#disposed = false;
	readonly #subagentRecords = new Map<string, SubagentRecord>();
	readonly #terminalEvents = new Map<string, TerminalEvent>();
	readonly #waitGenerationAliases = new Map<string, string>();
	readonly #terminalWaits = new Map<string, TerminalWaitState>();
	#waitSeq = 0;
	readonly #publishedTerminalGenerations = new Set<string>();
	readonly #settledJobIds = new Set<string>();
	#jobGenerationSeq = 0;
	readonly #liveHandles = new Map<string, SubagentLiveHandle>();
	readonly #subagentProgress = new Map<string, AgentProgress>();
	readonly #resumeQueue: ResumeQueueEntry[] = [];
	#resumeSeq = 0;
	#resumeRunner?: ResumeRunner;
	readonly #resumeDescriptors = new Map<string, ResumeDescriptor>();
	/**
	 * Per-descriptor in-memory resume runners, keyed by subagentId, captured at
	 * registerResumeDescriptor time so each resume executes under the authority of
	 * the session that originally launched that subagent. Fixes #2303's global
	 * last-writer-wins slot. In-memory only: a process restart drops these and
	 * resume fails closed with reason "no_runner".
	 */
	readonly #descriptorResumeRunners = new Map<string, ResumeRunner>();
	readonly #deadLetteredDeliveries = new Map<string, DeadLetteredDelivery>();
	readonly #deadLetteredDeliveryOwners = new Map<string, string | undefined>();
	/** Retry-cap failures whose job record was already evicted, keyed by the unique generation. */
	readonly #evictedDeadLetters = new Map<string, EvictedDeadLetteredDelivery>();
	/** Generations settled by failNow, so the runner's later terminal path is a no-op. */
	readonly #externallySettled = new Set<string>();
	/** Closed before #disposed so owner cleanups can settle work but cannot register more. */
	#registrationClosed = false;
	readonly #ownerSubagentShutdownLeases = new Map<string, OwnerSubagentShutdownLeaseState>();
	#ownerSubagentShutdownSeq = 0;
	#lastDisposeDiagnostics: AsyncJobDisposeDiagnostics = { stuckJobIds: [], deliveriesDrained: true };
	/**
	 * Change listeners notified on any mutation that can alter the live job set
	 * (register, terminal/eviction transitions, dispose). Used by the status-line
	 * jobs widget / overlay to refresh event-driven without polling.
	 */
	readonly #changeListeners = new Set<() => void>();

	#pruneTerminalEvents(): void {
		const cutoff = Date.now() - Math.max(this.#retentionMs, 300_000);
		for (const [generation, event] of this.#terminalEvents) {
			if (event.createdAt >= cutoff) continue;
			this.#terminalEvents.delete(generation);
			this.#publishedTerminalGenerations.delete(generation);
			this.#deliveryAckOwners.delete(generation);
		}
	}

	#eventForTarget(target: AsyncJobWaitTarget): TerminalEvent | undefined {
		this.#pruneTerminalEvents();
		const aliasedGeneration = this.#waitGenerationAliases.get(target.generation);
		if (aliasedGeneration) return this.#terminalEvents.get(aliasedGeneration);
		const job = target.jobId ? this.#jobs.get(target.jobId) : undefined;
		if (job) {
			if (job.generation !== target.generation) return undefined;
			if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
				return {
					generation: job.generation,
					jobId: job.id,
					subagentId: target.subagentId,
					ownerId: job.ownerId,
					status: job.status,
					createdAt: job.endTime ?? Date.now(),
				};
			}
			return undefined;
		}
		return this.#terminalEvents.get(target.generation);
	}

	#resultForWait(state: TerminalWaitState, outcome: AsyncJobWaitOutcome): AsyncJobWaitResult {
		const terminalJobIds: string[] = [];
		const pendingJobIds: string[] = [];
		for (const target of state.targets) {
			if (this.#eventForTarget(target)) terminalJobIds.push(target.targetId);
			else pendingJobIds.push(target.targetId);
		}
		return { outcome, condition: state.condition, terminalJobIds, pendingJobIds };
	}

	#maybeResolveWait(state: TerminalWaitState): void {
		if (state.settled) return;
		const terminalCount = state.targets.filter(target => this.#eventForTarget(target)).length;
		if (state.condition === "all_terminal" ? terminalCount !== state.targets.length : terminalCount === 0) return;
		state.settled = true;
		this.#terminalWaits.delete(state.token);
		state.resolve(this.#resultForWait(state, "completed"));
	}

	#publishQueuedTerminal(subagentId: string, generation: string, status: "completed" | "failed" | "cancelled"): void {
		if (this.#publishedTerminalGenerations.has(generation)) return;
		this.#publishedTerminalGenerations.add(generation);
		const record = this.#subagentRecords.get(subagentId);
		if (record) {
			record.currentJobId = null;
			record.terminalGeneration = generation;
			record.status = status;
			record.queued = undefined;
		}
		this.#terminalEvents.set(generation, {
			generation,
			jobId: null,
			subagentId,
			ownerId: record?.ownerId,
			status,
			createdAt: Date.now(),
		});
		for (const state of this.#terminalWaits.values()) {
			if (
				state.targets.some(
					target =>
						target.generation === generation || this.#waitGenerationAliases.get(target.generation) === generation,
				)
			)
				this.#maybeResolveWait(state);
		}
	}

	#publishTerminal(job: AsyncJob): void {
		if (job.status !== "completed" && job.status !== "failed" && job.status !== "cancelled") return;
		if (this.#publishedTerminalGenerations.has(job.generation)) return;
		this.#publishedTerminalGenerations.add(job.generation);
		const record = Array.from(this.#subagentRecords.values()).find(
			item => item.currentJobId === job.id && item.currentJobGeneration === job.generation,
		);
		if (record) record.terminalGeneration = job.generation;
		this.#terminalEvents.set(job.generation, {
			generation: job.generation,
			jobId: job.id,
			subagentId: record?.subagentId,
			ownerId: job.ownerId,
			status: job.status,
			createdAt: Date.now(),
		});
		for (const state of this.#terminalWaits.values()) {
			if (
				state.targets.some(
					target =>
						target.generation === job.generation ||
						target.jobId === job.id ||
						this.#waitGenerationAliases.get(target.generation) === job.generation,
				)
			)
				this.#maybeResolveWait(state);
		}
	}

	resolveSubagentWaitTarget(id: string, filter?: AsyncJobFilter): AsyncJobWaitTarget | undefined {
		const targetId = id.trim();
		if (!targetId) return undefined;
		this.#pruneTerminalEvents();
		const record = this.getSubagentRecord(targetId, filter);
		if (record) {
			if (filter?.ownerId && record.ownerId !== filter.ownerId) return undefined;
			if (record.status === "queued" && record.queued?.seq !== undefined) {
				return {
					targetId,
					jobId: null,
					subagentId: record.subagentId,
					generation: `queued:${record.subagentId}:${record.queued.seq}`,
					ownerId: record.ownerId,
					initialStatus: "queued",
				};
			}
			if (record.terminalGeneration && this.#terminalEvents.has(record.terminalGeneration)) {
				const generation = record.terminalGeneration;
				const event = this.#terminalEvents.get(generation);
				const current = record.currentJobId ? this.#jobs.get(record.currentJobId) : undefined;
				if (!current || current.generation !== record.currentJobGeneration || current.generation !== generation) {
					return {
						targetId,
						jobId: event?.jobId ?? null,
						subagentId: record.subagentId,
						generation,
						ownerId: record.ownerId,
						initialStatus: record.status,
					};
				}
			}
			if (record.currentJobId) {
				const job = this.#jobs.get(record.currentJobId);
				if (job && record.currentJobGeneration === job.generation)
					return {
						targetId,
						jobId: record.currentJobId,
						subagentId: record.subagentId,
						generation: job.generation,
						ownerId: record.ownerId,
						initialStatus: job.status,
					};
			}
			if (record.terminalGeneration && this.#terminalEvents.has(record.terminalGeneration)) {
				const generation = record.terminalGeneration;
				return {
					targetId,
					jobId: generation.startsWith("queued:") ? null : generation,
					subagentId: record.subagentId,
					generation,
					ownerId: record.ownerId,
					initialStatus: record.status,
				};
			}
			return undefined;
		}
		const job = this.#jobs.get(targetId);
		if (job && (!filter?.ownerId || job.ownerId === filter.ownerId))
			return {
				targetId,
				jobId: job.id,
				subagentId: job.metadata?.subagent?.id,
				generation: job.generation,
				ownerId: job.ownerId,
				initialStatus: job.status,
			};
		const metadataJobs = Array.from(this.#jobs.values()).filter(
			candidate =>
				candidate.metadata?.subagent?.id === targetId && (!filter?.ownerId || candidate.ownerId === filter.ownerId),
		);
		const metadataJob = metadataJobs.sort((a, b) => b.startTime - a.startTime)[0];
		if (metadataJob)
			return {
				targetId,
				jobId: metadataJob.id,
				subagentId: metadataJob.metadata?.subagent?.id,
				generation: metadataJob.generation,
				ownerId: metadataJob.ownerId,
				initialStatus: metadataJob.status,
			};
		const event = this.#terminalEvents.get(targetId);
		if (event && (!filter?.ownerId || event.ownerId === filter.ownerId))
			return {
				targetId,
				jobId: event.jobId,
				subagentId: event.subagentId,
				generation: event.generation,
				ownerId: event.ownerId,
				initialStatus: event.status,
			};
		return undefined;
	}

	subscribeTerminalWait(
		targets: readonly AsyncJobWaitTarget[],
		condition: AsyncJobWaitCondition = "all_terminal",
	): AsyncJobWaitHandle {
		const deduped: AsyncJobWaitTarget[] = [];
		const seen = new Set<string>();
		for (const target of targets) {
			if (seen.has(target.generation)) continue;
			seen.add(target.generation);
			deduped.push(target);
		}
		let resolve!: (result: AsyncJobWaitResult) => void;
		const result = new Promise<AsyncJobWaitResult>(resolver => {
			resolve = resolver;
		});
		const state: TerminalWaitState = {
			token: `wait_${++this.#waitSeq}`,
			targets: deduped,
			condition,
			resolve,
			settled: false,
			acknowledged: false,
			terminalGenerations: new Set(),
		};
		const handle: AsyncJobWaitHandle = {
			token: state.token,
			result,
			acknowledge: (targetIds?: readonly string[]) => {
				if (state.acknowledged) return { acknowledged: false, jobIds: [] };
				state.acknowledged = true;
				const allowed = targetIds ? new Set(targetIds) : undefined;
				const ids: string[] = [];
				for (const target of deduped) {
					if (allowed && !allowed.has(target.targetId)) continue;
					const event = this.#eventForTarget(target);
					if (!event) continue;
					ids.push(event.jobId ?? event.generation);
					const owner = this.#deliveryAckOwners.get(event.generation);
					if (owner && owner !== state.token) continue;
					this.#deliveryAckOwners.set(event.generation, state.token);
					this.#suppressedDeliveries.add(event.generation);
				}
				this.#deliveries.splice(
					0,
					this.#deliveries.length,
					...this.#deliveries.filter(
						delivery => !this.#isDeliveryAcknowledged(delivery.jobId, delivery.generation),
					),
				);
				return { acknowledged: ids.length > 0, jobIds: ids };
			},
			close: () => {
				if (state.settled) return;
				state.settled = true;
				this.#terminalWaits.delete(state.token);
				resolve(this.#resultForWait(state, "interrupted"));
			},
		};
		this.#terminalWaits.set(state.token, state);
		this.#maybeResolveWait(state);
		return handle;
	}

	#filterJobs(jobs: Iterable<AsyncJob>, filter?: AsyncJobFilter): AsyncJob[] {
		const ownerId = filter?.ownerId;
		if (!ownerId) return Array.from(jobs);
		const out: AsyncJob[] = [];
		for (const job of jobs) {
			if (job.ownerId === ownerId) out.push(job);
		}
		return out;
	}

	constructor(options: AsyncJobManagerOptions) {
		this.#onJobComplete = options.onJobComplete;
		this.#maxRunningJobs = Math.max(1, Math.floor(options.maxRunningJobs ?? DEFAULT_MAX_RUNNING_JOBS));
		this.#retentionMs = Math.max(0, Math.floor(options.retentionMs ?? DEFAULT_RETENTION_MS));
	}

	/**
	 * Subscribe to live-job-set change events. Returns an unsubscribe function.
	 * Listener errors are isolated so one bad subscriber cannot break others.
	 */
	onChange(cb: () => void): () => void {
		this.#changeListeners.add(cb);
		return () => {
			this.#changeListeners.delete(cb);
		};
	}

	#notifyChange(): void {
		for (const cb of this.#changeListeners) {
			try {
				cb();
			} catch (error) {
				logger.warn("Async job change listener failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	register(
		type: "bash" | "task",
		label: string,
		run: (ctx: {
			jobId: string;
			signal: AbortSignal;
			reportProgress: (text: string, details?: Record<string, unknown>) => Promise<void>;
		}) => Promise<string | SubagentRunOutcome>,
		options?: AsyncJobRegisterOptions,
	): string {
		if (this.#disposed) {
			throw new Error("Async job manager is disposed");
		}
		if (options?.ownerId && this.#isOwnerSubagentShutdownFenced(options.ownerId)) {
			throw new OwnerSubagentShutdownError();
		}
		if (this.#registrationClosed) throw new Error("Async job manager is shutting down");
		const admissionToken = options?.admissionToken;
		if (admissionToken) {
			if (!this.#consumeAdmission(admissionToken)) throw new Error("Invalid or expired job admission token");
		} else if (!this.hasCapacity()) {
			throw new Error(
				`Background job limit reached (${this.#maxRunningJobs}). Wait for running jobs to finish or cancel one.`,
			);
		}

		this.#expireMonitorTombstones();
		const id = this.#resolveJobId(options?.id);
		this.#settledJobIds.delete(id);
		const abortController = new AbortController();
		const startTime = Date.now();

		const job: AsyncJob = {
			id,
			generation: `job:${++this.#jobGenerationSeq}`,
			type,
			status: "running",
			startTime,
			label,
			abortController,
			promise: Promise.resolve(),
			ownerId: options?.ownerId,
			metadata: options?.metadata,
		};
		if (options?.lifecycle) this.#lifecycles.set(id, options.lifecycle);

		const reportProgress = async (text: string, details?: Record<string, unknown>): Promise<void> => {
			if (!options?.onProgress) return;
			try {
				await options.onProgress(text, details);
			} catch (error) {
				logger.warn("Async job progress callback failed", {
					jobId: id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		};
		job.promise = (async () => {
			try {
				const result = await run({ jobId: id, signal: abortController.signal, reportProgress });
				const outcome: SubagentRunOutcome =
					typeof result === "string" ? { kind: "completed", text: result } : result;

				// failNow already published a terminal state AND enqueued its delivery
				// for this generation; re-running the terminal path here would publish
				// twice and deliver twice.
				if (this.#externallySettled.has(job.generation)) {
					this.#drainResumeQueue();
					return;
				}
				if (job.status === "cancelled") {
					job.resultText = outcome.kind === "paused" ? outcome.note : outcome.text;
					this.#markRecordTerminal(id, "cancelled", job.generation);
					this.#publishTerminal(job);
					this.#runLifecycle(id, "terminal", job);
					this.#scheduleEviction(id);
					this.#drainResumeQueue();
					// The run has now actually unwound: retire the owned tuple so a
					// later scope:"owned" abort of the same turn does not report
					// stopped/stopped_owned while this job is still executing
					// (review thread P1).
					this.#retireCancelledJobOwned(id, job.generation);
					return;
				}
				if (outcome.kind === "paused") {
					// Sole canonical writer of the running -> paused transition. No
					// delivery and no eviction scheduling: a paused subagent stays
					// listed and resumable from its retained resume context.
					job.status = "paused";
					this.#freezeEndTime(job);
					if (outcome.note) job.resultText = outcome.note;
					this.#markRecordPaused(id, job.generation);
					this.#notifyChange();
					this.#drainResumeQueue();
					return;
				}
				if (outcome.kind === "failed") {
					job.status = "failed";
					job.setupFailureSummary = outcome.setupFailureSummary;
					job.localErrorSummary = outcome.localErrorSummary;
					this.#freezeEndTime(job);
					job.errorText = outcome.text;
					this.#markRecordTerminal(id, "failed", job.generation);
					this.#publishTerminal(job);
					this.#enqueueDelivery(id, outcome.text);
					this.#runLifecycle(id, "terminal", job);
					this.#scheduleEviction(id);
					this.#drainResumeQueue();
					return;
				}

				job.status = "completed";
				this.#freezeEndTime(job);
				job.resultText = outcome.text;
				this.#markRecordTerminal(id, "completed", job.generation);
				this.#publishTerminal(job);
				this.#enqueueDelivery(id, outcome.text);
				this.#runLifecycle(id, "terminal", job);
				this.#scheduleEviction(id);
				this.#drainResumeQueue();
			} catch (error) {
				if (this.#externallySettled.has(job.generation)) {
					this.#drainResumeQueue();
					return;
				}
				if (job.status === "cancelled") {
					job.errorText = error instanceof Error ? error.message : String(error);
					this.#markRecordTerminal(id, "cancelled", job.generation);
					this.#publishTerminal(job);
					this.#runLifecycle(id, "terminal", job);
					this.#scheduleEviction(id);
					this.#drainResumeQueue();
					this.#retireCancelledJobOwned(id, job.generation);
					return;
				}
				const errorText = error instanceof Error ? error.message : String(error);
				job.status = "failed";
				this.#freezeEndTime(job);
				job.errorText = errorText;
				this.#markRecordTerminal(id, "failed", job.generation);
				this.#publishTerminal(job);
				this.#enqueueDelivery(id, errorText);
				this.#runLifecycle(id, "terminal", job);
				this.#scheduleEviction(id);
				this.#drainResumeQueue();
			}
		})().finally(() => {
			this.#externallySettled.delete(job.generation);
			this.#settledJobIds.add(id);
		});

		this.#jobs.set(id, job);
		this.#notifyChange();
		return id;
	}

	/**
	 * Cancel a single job by id. When `filter.ownerId` is set and does not
	 * match the job's owner, the call is treated as not-found (returns false)
	 * so cross-agent cancellation is rejected at the manager level.
	 */
	cancel(id: string, filter?: AsyncJobFilter): boolean {
		if (id.startsWith("queued:")) {
			// A queued resume (no real job yet): owned settlement cancels it by
			// removing the queued subagent record and publishing the terminal
			// (review thread P1).
			const colon = id.lastIndexOf(":");
			const subagentId = colon > "queued:".length ? id.slice("queued:".length, colon) : undefined;
			if (!subagentId) return false;
			const rec = this.getSubagentRecord(subagentId);
			if (rec?.status !== "queued") return false;
			return this.cancelSubagent(subagentId, filter);
		}
		const job = this.#jobs.get(id);
		if (!job) return false;
		if (filter?.ownerId && job.ownerId !== filter.ownerId) return false;
		if (job.status === "paused") {
			// Paused jobs have no running promise to abort; transition directly.
			// The session file is kept, so the record stays resumable by id.
			job.status = "cancelled";
			this.#markRecordTerminal(id, "cancelled", job.generation);
			this.#freezeEndTime(job);
			this.#publishTerminal(job);
			this.#runLifecycle(id, "cancel");
			this.#scheduleEviction(id);
			this.#drainResumeQueue();
			// A PAUSED job's run has already unwound (it returned "paused"), so
			// its owned tuple is retired here; a RUNNING job's tuple is retired
			// from the settlement path once the run actually unwinds below.
			this.#retireCancelledJobOwned(id, job.generation);
			return true;
		}
		if (job.status !== "running") return false;
		job.status = "cancelled";
		this.#freezeEndTime(job);
		this.#markRecordTerminal(id, "cancelled", job.generation);
		this.#publishTerminal(job);
		this.#runLifecycle(id, "cancel");
		job.abortController.abort();
		this.#notifyChange();
		return true;
	}

	/**
	 * Freeze the wall-clock instant a job stopped running. Idempotent: the
	 * first stop (completed/failed/cancelled/paused) wins so elapsed-time
	 * renderers report a stable duration instead of counting against
	 * `Date.now()` forever. A resumed subagent registers a brand-new job with
	 * its own `startTime`, so a paused job's frozen `endTime` is never reused.
	 */
	#freezeEndTime(job: AsyncJob): void {
		job.endTime ??= Date.now();
	}

	#runLifecycle(jobId: string, phase: "cancel" | "terminal" | "evict", jobOverride?: AsyncJob): void {
		const lifecycle = this.#lifecycles.get(jobId);
		const job = jobOverride ?? this.#jobs.get(jobId);
		if (!lifecycle || !job) return;
		const fired = this.#lifecyclePhases.get(jobId) ?? new Set<"cancel" | "terminal" | "evict">();
		if (fired.has(phase)) return;
		fired.add(phase);
		this.#lifecyclePhases.set(jobId, fired);
		try {
			if (phase === "cancel") lifecycle.onCancel?.(job);
			else if (phase === "terminal") lifecycle.onTerminal?.(job);
			else lifecycle.onEvict?.(job);
		} catch (error) {
			logger.warn("Async job lifecycle cleanup failed", {
				jobId,
				phase,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	#expireMonitorTombstones(): void {
		const now = Date.now();
		for (const [jobId, tombstone] of this.#monitorTombstones) {
			if (tombstone.expiresAt <= now) this.#monitorTombstones.delete(jobId);
		}
	}

	#recordMonitorTombstone(jobId: string): void {
		const job = this.#jobs.get(jobId);
		if (!job?.metadata?.monitor) return;
		const lifecycle = this.#lifecycles.get(jobId);
		this.#monitorTombstones.set(jobId, {
			jobId,
			ownerId: job.ownerId,
			status: job.status,
			expiresAt: Date.now() + MONITOR_TOMBSTONE_TTL_MS,
			purge: () => (lifecycle?.onTombstonePurge ?? lifecycle?.onEvict)?.(job),
		});
	}

	getMonitorTombstone(jobId: string, filter?: AsyncJobFilter): MonitorTombstone | undefined {
		this.#expireMonitorTombstones();
		const tombstone = this.#monitorTombstones.get(jobId);
		if (!tombstone) return undefined;
		if (filter?.ownerId && tombstone.ownerId !== filter.ownerId) return undefined;
		return tombstone;
	}

	purgeMonitorTombstone(jobId: string, filter?: AsyncJobFilter): { found: boolean; status?: AsyncJob["status"] } {
		const tombstone = this.getMonitorTombstone(jobId, filter);
		if (!tombstone) return { found: false };
		this.#monitorTombstones.delete(jobId);
		try {
			tombstone.purge();
		} catch (error) {
			logger.warn("Monitor tombstone purge failed", {
				jobId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		return { found: true, status: tombstone.status };
	}

	// ── Subagent control plane (pause / resume / steer support) ──────────

	/** Register or replace the canonical record for a subagent. */
	registerSubagentRecord(record: SubagentRecord): void {
		const currentJob = record.currentJobId ? this.#jobs.get(record.currentJobId) : undefined;
		if (currentJob && record.currentJobGeneration === undefined) record.currentJobGeneration = currentJob.generation;
		this.#subagentRecords.set(record.subagentId, record);
		this.#notifyChange();
	}

	/**
	 * Patch model/runtime metadata onto an existing subagent record (best-effort; no-op if
	 * unknown). Every field is optional and omitting one preserves its current value, so a
	 * narrow patch like `{ fastMode: true }` cannot erase model identity recorded earlier.
	 * A field therefore cannot be cleared back to `undefined` through this method.
	 */
	updateSubagentModel(
		subagentId: string,
		model: { requestedModel?: string; effectiveModel?: string; modelFellBack?: boolean; fastMode?: boolean },
	): void {
		const record = this.#subagentRecords.get(subagentId);
		if (!record) return;
		record.requestedModel = model.requestedModel ?? record.requestedModel;
		record.effectiveModel = model.effectiveModel ?? record.effectiveModel;
		record.modelFellBack = model.modelFellBack ?? record.modelFellBack;
		record.fastMode = model.fastMode ?? record.fastMode;
	}

	#recordFromResumeDescriptor(subagentId: string, filter?: AsyncJobFilter): SubagentRecord | undefined {
		const descriptor = this.getResumeDescriptor(subagentId, filter);
		if (!descriptor) return undefined;
		const sessionFile = sessionFileFromResumeDescriptorData(descriptor.data);
		const record: SubagentRecord = {
			subagentId: descriptor.subagentId,
			ownerId: descriptor.ownerId,
			currentJobId: null,
			historicalJobIds: [],
			status: "completed",
			sessionFile,
			// The synthesized record copies this descriptor's owner, so the
			// descriptor is owner-compatible with the record by construction.
			resumable: hasRetainedResumeContext({ resumable: true, sessionFile, descriptor }),
		};
		this.#subagentRecords.set(record.subagentId, record);
		return record;
	}

	getSubagentRecord(subagentId: string, filter?: AsyncJobFilter): SubagentRecord | undefined {
		const trimmed = subagentId.trim();
		const rec = this.#subagentRecords.get(trimmed);
		if (rec) {
			if (filter?.ownerId && rec.ownerId !== filter.ownerId) return undefined;
			return rec;
		}
		return this.#recordFromResumeDescriptor(trimmed, filter);
	}

	getSubagentRecords(filter?: AsyncJobFilter): SubagentRecord[] {
		const ownerId = filter?.ownerId;
		const out: SubagentRecord[] = [];
		for (const rec of this.#subagentRecords.values()) {
			if (ownerId && rec.ownerId !== ownerId) continue;
			out.push(rec);
		}
		return out;
	}

	registerLiveHandle(subagentId: string, handle: SubagentLiveHandle): void {
		this.#liveHandles.set(subagentId, handle);
	}

	getLiveHandle(subagentId: string): SubagentLiveHandle | undefined {
		return this.#liveHandles.get(subagentId);
	}

	removeLiveHandle(subagentId: string): void {
		this.#liveHandles.delete(subagentId);
	}

	/**
	 * Retain the latest live `AgentProgress` for a subagent (deep-cloned so later
	 * mutation of the live object cannot corrupt retained state). Read by the
	 * `subagent` await panel; cleared on terminal/cancel/purge/dispose.
	 *
	 * Ignored for ids without a canonical `SubagentRecord` (e.g. foreground/inline
	 * task runs that share the executor path) so the map only holds detached
	 * subagent progress and never accumulates untracked foreground task state.
	 */
	recordSubagentProgress(subagentId: string, progress: AgentProgress): void {
		if (!this.#subagentRecords.has(subagentId)) return;
		this.#subagentProgress.set(subagentId, structuredClone(progress));
	}

	getSubagentProgress(subagentId: string): AgentProgress | undefined {
		return this.#subagentProgress.get(subagentId);
	}

	/**
	 * True only when a live, in-session progress producer exists for this id: a
	 * canonical registered record with a live handle or an in-memory running job.
	 * False for `SubagentTool` backward-compat job synthesis and resumed-from-disk
	 * records, which have no live producer to stream from.
	 */
	hasLiveSubagent(subagentId: string, filter?: AsyncJobFilter): boolean {
		const rec = this.getSubagentRecord(subagentId, filter);
		if (!rec) return false;
		if (this.#liveHandles.has(rec.subagentId)) return true;
		const job = rec.currentJobId ? this.#jobs.get(rec.currentJobId) : undefined;
		return job?.status === "running";
	}

	/** Install the TaskTool-owned resume runner. Returns the new job id, or undefined on failure. */
	setResumeRunner(runner: ResumeRunner): void {
		this.#resumeRunner = runner;
	}

	registerResumeDescriptor(descriptor: ResumeDescriptor, runner?: ResumeRunner): void {
		this.#resumeDescriptors.set(descriptor.subagentId, descriptor);
		if (runner) this.#descriptorResumeRunners.set(descriptor.subagentId, runner);
	}

	/**
	 * Resolve a descriptor only when `ownerId` matches the record by strict
	 * equality. Two undefined owners match; a distinguishably foreign descriptor
	 * is treated as absent for eligibility, runner selection, and execution.
	 */
	#descriptorForRecord(rec: SubagentRecord): ResumeDescriptor | undefined {
		const descriptor = this.#resumeDescriptors.get(rec.subagentId);
		return descriptor !== undefined && descriptor.ownerId === rec.ownerId ? descriptor : undefined;
	}

	/**
	 * Resolve the resume runner for a record and its already owner-compatible
	 * descriptor. Per-descriptor authority is unavailable when the descriptor is foreign.
	 */
	#resolveResumeRunner(rec: SubagentRecord, descriptor: ResumeDescriptor | undefined): ResumeRunner | undefined {
		return (
			(descriptor !== undefined ? this.#descriptorResumeRunners.get(rec.subagentId) : undefined) ??
			this.#resumeRunner
		);
	}

	getResumeDescriptor(subagentId: string, filter?: AsyncJobFilter): ResumeDescriptor | undefined {
		const descriptor = this.#resumeDescriptors.get(subagentId.trim());
		if (!descriptor) return undefined;
		if (filter?.ownerId && descriptor.ownerId !== filter.ownerId) return undefined;
		return descriptor;
	}

	#isOwnerSubagentShutdownFenced(ownerId: string | undefined): boolean {
		return ownerId !== undefined && this.#ownerSubagentShutdownLeases.has(ownerId);
	}

	#isTerminalSubagentStatus(status: SubagentLifecycle): boolean {
		return status === "completed" || status === "failed" || status === "cancelled";
	}

	beginOwnerSubagentShutdown(ownerId: string): OwnerSubagentShutdownLease | undefined {
		if (!ownerId || this.#ownerSubagentShutdownLeases.has(ownerId)) return undefined;
		const targets = new Map<string, OwnerSubagentShutdownTarget>();
		const backingJobIds = new Map<string, Set<string>>();
		const addBackingJob = (subagentId: string, jobId: string | null): void => {
			if (!jobId) return;
			const ids = backingJobIds.get(subagentId) ?? new Set<string>();
			ids.add(jobId);
			backingJobIds.set(subagentId, ids);
		};
		for (const record of this.#subagentRecords.values()) {
			if (record.ownerId !== ownerId || this.#isTerminalSubagentStatus(record.status)) continue;
			targets.set(record.subagentId, {
				subagentId: record.subagentId,
				jobId: record.status === "queued" ? null : record.currentJobId,
				source: "record",
			});
			if (record.status !== "queued") addBackingJob(record.subagentId, record.currentJobId);
		}
		for (const job of this.#jobs.values()) {
			const subagentId = job.metadata?.subagent?.id;
			if (
				job.ownerId !== ownerId ||
				!subagentId ||
				(job.status !== "running" && job.status !== "paused" && job.status !== "cancelled")
			) {
				continue;
			}
			if (job.status === "cancelled" && this.#settledJobIds.has(job.id) && !this.#subagentRecords.has(subagentId))
				continue;
			if (!targets.has(subagentId)) {
				targets.set(subagentId, { subagentId, jobId: job.id, source: "metadata_job" });
			}
			addBackingJob(subagentId, job.id);
		}
		const lease: OwnerSubagentShutdownLease = {
			ownerId,
			id: `owner_shutdown_${++this.#ownerSubagentShutdownSeq}`,
			targets: Array.from(targets.values()),
		};
		this.#ownerSubagentShutdownLeases.set(ownerId, {
			lease,
			backingJobIds: new Map<string, readonly string[]>(
				Array.from(backingJobIds, ([subagentId, jobIds]): [string, readonly string[]] => [
					subagentId,
					Array.from(jobIds),
				]),
			),
			phase: "active",
		});
		return lease;
	}

	runOwnerProducerCleanups(filter?: AsyncJobFilter): void {
		this.#runOwnerProducerCleanups(filter, false);
	}

	runOwnerProducerCleanupsStrict(filter?: AsyncJobFilter): void {
		this.#runOwnerProducerCleanups(filter, true);
	}

	#runOwnerProducerCleanups(filter: AsyncJobFilter | undefined, strict: boolean): void {
		const ownerId = filter?.ownerId;
		const targets: Array<[string, Set<() => void>]> = [];
		if (ownerId) {
			const bag = this.#ownerCleanups.get(ownerId);
			if (bag) targets.push([ownerId, bag]);
		} else {
			for (const entry of this.#ownerCleanups.entries()) targets.push(entry);
		}
		const errors: unknown[] = [];
		for (const [id, bag] of targets) {
			const callbacks = Array.from(bag);
			bag.clear();
			this.#ownerCleanups.delete(id);
			for (const cleanup of callbacks) {
				try {
					cleanup();
				} catch (error) {
					errors.push(error);
					if (strict) {
						let retryBag = this.#ownerCleanups.get(id);
						if (!retryBag) {
							retryBag = new Set();
							this.#ownerCleanups.set(id, retryBag);
						}
						retryBag.add(cleanup);
					}
					logger.warn("Async job owner cleanup failed", {
						ownerId: id,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
		}
		if (strict && errors.length > 0) throw new AggregateError(errors, "Async job owner cleanup failed");
	}

	async cancelAndProveOwnerSubagents(
		lease: OwnerSubagentShutdownLease,
		options?: { timeoutMs?: number },
	): Promise<OwnerSubagentShutdownProof> {
		const state = this.#ownerSubagentShutdownLeases.get(lease.ownerId);
		if (!state || state.lease.id !== lease.id) {
			return this.#ownerSubagentShutdownProof(
				lease,
				"lease_lost",
				lease.targets.map(target => target.subagentId),
			);
		}
		if (state.phase === "proved" && state.proof?.confirmed) return state.proof;
		state.phase = "proving";
		const settled = new Set<string>();
		const promises: Promise<void>[] = [];
		for (const target of lease.targets) {
			const backingJobs = (state.backingJobIds.get(target.subagentId) ?? []).map(jobId => ({
				jobId,
				job: this.#jobs.get(jobId),
			}));
			if (target.source === "record") this.cancelSubagent(target.subagentId, { ownerId: lease.ownerId });
			for (const { jobId, job } of backingJobs) {
				this.cancel(jobId, { ownerId: lease.ownerId });
				if (!job || job.ownerId !== lease.ownerId) continue;
				promises.push(
					job.promise.then(
						() => {
							settled.add(jobId);
						},
						() => {
							settled.add(jobId);
						},
					),
				);
			}
		}
		const timeoutMs = Math.max(0, options?.timeoutMs ?? OWNER_SUBAGENT_SHUTDOWN_TIMEOUT_MS);
		let deadlineExceeded = false;
		await Promise.race([
			Promise.allSettled(promises),
			Bun.sleep(timeoutMs).then(() => {
				deadlineExceeded = true;
			}),
		]);
		const current = this.#ownerSubagentShutdownLeases.get(lease.ownerId);
		if (!current || current.lease.id !== lease.id || current.phase !== "proving") {
			return this.#ownerSubagentShutdownProof(
				lease,
				"lease_lost",
				lease.targets.map(target => target.subagentId),
			);
		}
		const unresolvedIds = lease.targets
			.filter(target => !this.#hasTerminalShutdownEvidence(target, lease.ownerId, current.backingJobIds, settled))
			.map(target => target.subagentId);
		const reason =
			unresolvedIds.length === 0
				? "confirmed"
				: deadlineExceeded
					? "deadline_exceeded"
					: "missing_terminal_evidence";
		const proof = this.#ownerSubagentShutdownProof(lease, reason, unresolvedIds);
		current.phase = "proved";
		current.proof = proof;
		return proof;
	}

	#hasTerminalShutdownEvidence(
		target: OwnerSubagentShutdownTarget,
		ownerId: string,
		backingJobIds: ReadonlyMap<string, readonly string[]>,
		settled: ReadonlySet<string>,
	): boolean {
		const record = this.#subagentRecords.get(target.subagentId);
		if (!record || record.ownerId !== ownerId || !this.#isTerminalSubagentStatus(record.status)) return false;
		return (backingJobIds.get(target.subagentId) ?? []).every(jobId => {
			if (!settled.has(jobId)) return false;
			const job = this.#jobs.get(jobId);
			return job === undefined || job.ownerId === ownerId;
		});
	}

	#ownerSubagentShutdownProof(
		lease: OwnerSubagentShutdownLease,
		reason: OwnerSubagentShutdownProof["reason"],
		unresolvedIds: readonly string[],
	): OwnerSubagentShutdownProof {
		const unresolved = new Set(unresolvedIds);
		return {
			ownerId: lease.ownerId,
			leaseId: lease.id,
			confirmed: reason === "confirmed",
			reason,
			targets: lease.targets,
			terminalIds: lease.targets
				.filter(target => !unresolved.has(target.subagentId))
				.map(target => target.subagentId),
			unresolvedIds: [...unresolvedIds],
		};
	}

	finishOwnerSubagentShutdown(lease: OwnerSubagentShutdownLease, outcome: "commit" | "release"): void {
		const state = this.#ownerSubagentShutdownLeases.get(lease.ownerId);
		if (!state || state.lease.id !== lease.id) return;
		if (outcome === "commit" && state.proof?.confirmed) {
			const pendingJobIds = this.getDeliveryState({ ownerId: lease.ownerId }).pendingJobIds;
			this.acknowledgeDeliveries(pendingJobIds);
			this.#purgeOwnerSubagentState(lease.ownerId);
		}
		this.#ownerSubagentShutdownLeases.delete(lease.ownerId);
		if (outcome === "release") this.#ensureDeliveryLoop();
	}

	#recordByJobId(jobId: string, expectedGeneration?: string): SubagentRecord | undefined {
		for (const rec of this.#subagentRecords.values()) {
			if (rec.currentJobId !== jobId) continue;
			if (expectedGeneration !== undefined && rec.currentJobGeneration !== expectedGeneration) continue;
			return rec;
		}
		return undefined;
	}

	#markRecordPaused(jobId: string, generation?: string): void {
		const rec = this.#recordByJobId(jobId, generation);
		if (rec) {
			rec.status = "paused";
			this.#liveHandles.delete(rec.subagentId);
			this.#subagentProgress.delete(rec.subagentId);
		}
	}

	#purgeTerminalSubagentStateForJob(jobId: string, generation?: string): void {
		const rec = this.#recordByJobId(jobId, generation);
		if (!rec) return;
		if (rec.status === "paused" || rec.status === "queued") return;
		this.#liveHandles.delete(rec.subagentId);
		this.#subagentProgress.delete(rec.subagentId);
	}

	#markRecordTerminal(jobId: string, status: "completed" | "failed" | "cancelled", generation?: string): void {
		const rec = this.#recordByJobId(jobId, generation);
		if (!rec) return;
		rec.status = status;
		this.#liveHandles.delete(rec.subagentId);
		this.#subagentProgress.delete(rec.subagentId);
	}

	/** Request a graceful safe-boundary pause of a running subagent. */
	pauseSubagent(
		subagentId: string,
		filter?: AsyncJobFilter,
	): { ok: boolean; status?: SubagentLifecycle; reason?: string } {
		const rec = this.getSubagentRecord(subagentId, filter);
		if (!rec) return { ok: false, reason: "not_found" };
		if (rec.status !== "running") return { ok: false, status: rec.status, reason: "not_running" };
		const handle = this.#liveHandles.get(rec.subagentId);
		if (!handle) return { ok: false, status: rec.status, reason: "no_live_handle" };
		handle.requestPause();
		return { ok: true, status: rec.status };
	}

	/**
	 * Resume a non-running subagent from retained context: an owner-compatible
	 * descriptor or a legacy session file. Workflow routing keeps `not_found`,
	 * `context_unavailable`, `no_runner`, and `resume_failed` distinct.
	 */
	resumeSubagent(
		subagentId: string,
		filter?: AsyncJobFilter,
		message?: string,
		resumeToolCallId?: string,
	): { ok: boolean; status?: SubagentLifecycle; jobId?: string; queued?: boolean; reason?: string } {
		const rec = this.getSubagentRecord(subagentId, filter);
		if (!rec) return { ok: false, reason: "not_found" };
		if (this.#isOwnerSubagentShutdownFenced(rec.ownerId)) {
			return { ok: false, status: rec.status, reason: "owner_shutdown_in_progress" };
		}
		if (rec.status === "running") return { ok: false, status: "running", reason: "already_running" };
		if (rec.status === "queued") {
			if (message !== undefined && rec.queued) {
				rec.queued.message = message;
				const queued = this.#resumeQueue.find(entry => entry.subagentId === rec.subagentId);
				if (queued) queued.message = message;
				return { ok: true, queued: true, status: "queued" };
			}
			return { ok: false, status: "queued", reason: "already_queued" };
		}
		const descriptor = this.#descriptorForRecord(rec);
		if (!hasRetainedResumeContext({ resumable: rec.resumable, sessionFile: rec.sessionFile, descriptor })) {
			return { ok: false, reason: "context_unavailable" };
		}
		if (!this.#resolveResumeRunner(rec, descriptor)) return { ok: false, reason: "no_runner" };
		if (this.getRunningJobs().length >= this.#maxRunningJobs) {
			const seq = ++this.#resumeSeq;
			rec.status = "queued";
			rec.queued = {
				ownerId: rec.ownerId,
				seq,
				message,
				...(resumeToolCallId ? { resumeToolCallId } : {}),
				createdAt: Date.now(),
			};
			this.#resumeQueue.push({
				subagentId: rec.subagentId,
				ownerId: rec.ownerId,
				seq,
				message,
				...(resumeToolCallId ? { resumeToolCallId } : {}),
				createdAt: rec.queued.createdAt,
			});
			// Register the QUEUED generation as owned work of the resume request's
			// turn: no real job exists until #startResume drains it, so without a
			// registration a scope:"owned" abort of the requesting turn would see
			// an empty causal set, report stopped_owned, and then the queue would
			// drain and launch the resumed subagent anyway (review thread P1).
			if (resumeToolCallId) {
				const lineage = resolveToolLineage(resumeToolCallId, AsyncJobManager.endpointIdOf(this));
				if (lineage) {
					const queuedGeneration = `queued:${rec.subagentId}:${seq}`;
					registerOwnedRegistration({
						...(lineage.endpointId ? { endpointId: lineage.endpointId } : {}),
						lineageIdHash: lineage.lineageIdHash,
						promptAttemptEpoch: lineage.promptAttemptEpoch,
						endpointGeneration: lineage.endpointGeneration,
						jobId: queuedGeneration,
						jobGeneration: queuedGeneration,
					});
				}
			}
			this.#notifyChange();
			return { ok: true, queued: true, status: "queued" };
		}
		return this.#startResume(rec, message, descriptor, resumeToolCallId);
	}

	/** Retire the owned registration of a job that settles WITHOUT a delivery
	 *  (explicit cancellation): the cancelled-job completion path deliberately
	 *  enqueues no delivery, so the tuple would otherwise persist until
	 *  eviction — an owned abort of the same turn then reports owned_unsettled
	 *  with no work remaining, and repeated cancellations exhaust the bounded
	 *  ownership registries (review thread P2). */
	#retireCancelledJobOwned(jobId: string, jobGeneration: string): void {
		const registration = lookupOwnedRegistration(jobId, jobGeneration, AsyncJobManager.endpointIdOf(this));
		if (registration) unregisterOwnedRegistration(registration);
	}

	#retireQueuedOwned(rec: SubagentRecord): void {
		const seq = rec.queued?.seq ?? rec.terminalQueuedSeq;
		if (seq === undefined) return;
		const queuedGeneration = `queued:${rec.subagentId}:${seq}`;
		// Resolve the registration with the resume lineage's ENDPOINT identity:
		// task ids are session-scoped and each manager's resume sequence starts
		// locally, so concurrent sessions can both register an identical
		// queued:<subagent>:<seq> generation — an endpoint-less lookup could
		// retrieve and unregister the OTHER session's tuple (review thread P1).
		const endpointId = rec.queued?.resumeToolCallId
			? (resolveToolLineage(rec.queued.resumeToolCallId, AsyncJobManager.endpointIdOf(this))?.endpointId ??
				// Fall back to the manager's own registered endpoint when the
				// binding itself predates endpoint keying or is not found.
				AsyncJobManager.endpointIdOf(this))
			: AsyncJobManager.endpointIdOf(this);
		const registration = lookupOwnedRegistration(queuedGeneration, queuedGeneration, endpointId);
		if (registration) unregisterOwnedRegistration(registration);
	}

	#startResume(
		rec: SubagentRecord,
		message: string | undefined,
		descriptor: ResumeDescriptor | undefined,
		resumeToolCallId?: string,
	): { ok: boolean; status?: SubagentLifecycle; jobId?: string; reason?: string } {
		if (this.#isOwnerSubagentShutdownFenced(rec.ownerId)) {
			return { ok: false, status: rec.status, reason: "owner_shutdown_in_progress" };
		}
		const prevJobId = rec.currentJobId;
		const queuedGeneration = rec.queued?.seq !== undefined ? `queued:${rec.subagentId}:${rec.queued.seq}` : undefined;
		// Clear any retained progress from the previous run so a resumed subagent
		// never renders the prior run's tool/output as live before it emits again.
		this.#subagentProgress.delete(rec.subagentId);
		const runner = this.#resolveResumeRunner(rec, descriptor);
		const newJobId = runner?.(rec.subagentId, message, descriptor, resumeToolCallId);
		if (!newJobId) {
			// The queued resume FAILED to start: retire its owned registration
			// so the tuple does not accumulate indefinitely (review thread P2).
			this.#retireQueuedOwned(rec);
			return { ok: false, reason: "resume_failed" };
		}
		if (prevJobId && prevJobId !== newJobId) rec.historicalJobIds.push(prevJobId);
		rec.terminalGeneration = undefined;
		rec.currentJobId = newJobId;
		rec.currentJobGeneration = this.#jobs.get(newJobId)?.generation;
		rec.status = this.#jobs.get(newJobId)?.status ?? "running";
		rec.queued = undefined;
		if (queuedGeneration) {
			this.#waitGenerationAliases.set(queuedGeneration, this.#jobs.get(newJobId)?.generation ?? newJobId);
			// The queued resume's owned registration is superseded by the real
			// job's registration (bound by the task tool): remove it so the
			// causal set has exactly one tuple per job. The EXACT stored tuple
			// is looked up first — unregisterOwnedRegistration now verifies the
			// full five-tuple before deleting (review thread P1). The lookup is
			// ENDPOINT-qualified via the resume lineage: concurrent sessions
			// mint the same queued:<subagent>:<seq> generation, and the
			// remaining endpoint-less fallback scan could retrieve and
			// unregister the OTHER session's tuple (review thread P1).
			const resumeEndpoint = resumeToolCallId
				? (resolveToolLineage(resumeToolCallId, AsyncJobManager.endpointIdOf(this))?.endpointId ??
					// The binding may have been evicted (8192-cap FIFO): fall back
					// to the manager's own endpoint so the lookup never degrades
					// into the cross-endpoint scan (review thread P2).
					AsyncJobManager.endpointIdOf(this))
				: undefined;
			const queuedReg = lookupOwnedRegistration(queuedGeneration, queuedGeneration, resumeEndpoint);
			if (queuedReg) unregisterOwnedRegistration(queuedReg);
		}
		this.#notifyChange();
		return { ok: true, status: rec.status, jobId: newJobId };
	}

	/** Drain queued resumes while preserving fenced owners and allowing foreign progress. */
	#drainResumeQueue(): void {
		if (this.#resumeQueue.length === 0) return;
		this.#resumeQueue.sort((a, b) => a.seq - b.seq);
		let index = 0;
		while (index < this.#resumeQueue.length && this.getRunningJobs().length < this.#maxRunningJobs) {
			const entry = this.#resumeQueue[index];
			const rec = this.#subagentRecords.get(entry.subagentId);
			if (rec?.status !== "queued") {
				this.#resumeQueue.splice(index, 1);
				continue;
			}
			if (this.#isOwnerSubagentShutdownFenced(entry.ownerId)) {
				index += 1;
				continue;
			}
			try {
				const result = this.#startResume(
					rec,
					entry.message,
					this.#descriptorForRecord(rec),
					rec.queued?.resumeToolCallId,
				);
				if (!result.ok) {
					if (result.reason === "owner_shutdown_in_progress") {
						index += 1;
						continue;
					}
					const queuedSeq = rec.queued?.seq;
					if (queuedSeq !== undefined) {
						this.#retireQueuedOwned(rec);
						this.#publishQueuedTerminal(rec.subagentId, `queued:${rec.subagentId}:${queuedSeq}`, "failed");
					}
				}
				this.#resumeQueue.splice(index, 1);
			} catch (error) {
				if (error instanceof OwnerSubagentShutdownError) {
					index += 1;
					continue;
				}
				const queuedSeq = rec.queued?.seq;
				if (queuedSeq !== undefined) {
					this.#retireQueuedOwned(rec);
					this.#publishQueuedTerminal(rec.subagentId, `queued:${rec.subagentId}:${queuedSeq}`, "failed");
				}
				this.#resumeQueue.splice(index, 1);
			}
		}
	}

	/** Cancel a subagent by stable id across running/paused/queued states (keeps the session file). */
	cancelSubagent(subagentId: string, filter?: AsyncJobFilter): boolean {
		const rec = this.getSubagentRecord(subagentId, filter);
		if (!rec) return false;
		if (rec.status === "running" && rec.currentJobId) return this.cancel(rec.currentJobId, filter);
		if (rec.status === "paused") {
			const currentJobId = rec.currentJobId;
			const job = currentJobId ? this.#jobs.get(currentJobId) : undefined;
			const shouldScheduleEviction = job?.status === "paused";
			if (shouldScheduleEviction) job.status = "cancelled";
			if (shouldScheduleEviction && job) this.#publishTerminal(job);
			rec.status = "cancelled";
			this.#liveHandles.delete(rec.subagentId);
			this.#subagentProgress.delete(rec.subagentId);
			if (shouldScheduleEviction && currentJobId) this.#scheduleEviction(currentJobId);
			else this.#notifyChange();
			this.#drainResumeQueue();
			// A paused run has already unwound (it returned "paused") and this
			// direct branch never reaches cancel(), so retire the owned tuple
			// here — the cancellation emits no completion delivery, and without
			// this the tuple survives job eviction and a later scope:"owned"
			// abort of the attempt reports owned_unsettled with no work left
			// (review thread P2).
			if (shouldScheduleEviction && currentJobId && job) this.#retireCancelledJobOwned(currentJobId, job.generation);
			return true;
		}
		if (rec.status === "queued") {
			const idx = this.#resumeQueue.findIndex(e => e.subagentId === rec.subagentId);
			const queuedSeq = rec.queued?.seq;
			if (idx !== -1) this.#resumeQueue.splice(idx, 1);
			rec.status = "cancelled";
			if (queuedSeq !== undefined) {
				this.#publishQueuedTerminal(rec.subagentId, `queued:${rec.subagentId}:${queuedSeq}`, "cancelled");
				// rec.queued is cleared below; retain terminal evidence ON THE
				// RECORD so owned settlement can prove the queued generation was
				// cancelled even when an in-flight settlement outlives any
				// bounded evidence set (review thread P2). The owned tuple is
				// retired at this terminal state too.
				rec.terminalQueuedSeq = queuedSeq;
				this.#retireQueuedOwned(rec);
			}
			rec.queued = undefined;
			this.#subagentProgress.delete(rec.subagentId);
			this.#notifyChange();
			return true;
		}
		return false;
	}

	#purgeOwnerSubagentState(ownerId?: string): void {
		for (let i = this.#resumeQueue.length - 1; i >= 0; i--) {
			if (!ownerId || this.#resumeQueue[i].ownerId === ownerId) this.#resumeQueue.splice(i, 1);
		}
		for (const [sid, rec] of this.#subagentRecords) {
			if (!ownerId || rec.ownerId === ownerId) {
				// Retire the queued resume's owned registration BEFORE deleting the
				// record: the purge removes the resume-queue entry and record with
				// no start, cancellation, or delivery boundary, so the registration
				// would otherwise leak into the global ownership registries and
				// eventually make later owned aborts fail closed (review thread
				// P2). #retireQueuedOwned is a no-op for non-queued records.
				this.#retireQueuedOwned(rec);
				this.#liveHandles.delete(sid);
				this.#resumeDescriptors.delete(sid);
				this.#descriptorResumeRunners.delete(sid);
				this.#subagentRecords.delete(sid);
				this.#subagentProgress.delete(sid);
			}
		}
	}

	getJob(id: string): AsyncJob | undefined {
		if (id.startsWith("queued:")) {
			const colon = id.lastIndexOf(":");
			const subagentId = colon > "queued:".length ? id.slice("queued:".length, colon) : undefined;
			if (!subagentId) return undefined;
			const rec = this.getSubagentRecord(subagentId);
			if (!rec) return undefined;
			const liveSeq = rec.queued?.seq;
			const terminalSeq = rec.terminalQueuedSeq;
			// A failed queued resume publishes its terminalGeneration (the
			// queued id) via #publishQueuedTerminal — that is retained
			// failed-generation evidence for the settlement proof.
			const terminalQueuedId = terminalSeq !== undefined ? `queued:${subagentId}:${terminalSeq}` : undefined;
			const publishedQueuedId = rec.terminalGeneration?.startsWith("queued:") ? rec.terminalGeneration : undefined;
			if (liveSeq === undefined && terminalQueuedId === undefined && publishedQueuedId === undefined)
				return undefined;
			const resolvedQueuedId =
				liveSeq !== undefined ? `queued:${subagentId}:${liveSeq}` : (terminalQueuedId ?? publishedQueuedId);
			if (resolvedQueuedId === undefined || id !== resolvedQueuedId) return undefined;
			if (liveSeq === undefined) {
				// The queued resume reached a TERMINAL state (cancelled or
				// failed, rec.queued cleared): the generation is provably
				// terminal so owned settlement's second proof succeeds
				// (review thread P2).
				return {
					id,
					generation: id,
					type: "task",
					status: rec.status === "failed" ? "failed" : "cancelled",
					startTime: Date.now(),
					label: `terminal queued resume ${subagentId}`,
					abortController: new AbortController(),
					promise: Promise.resolve(),
				};
			}
			if (id !== `queued:${subagentId}:${liveSeq}`) return undefined;
			return {
				id,
				generation: id,
				type: "task",
				// A still-queued resume is NOT quiescent ("paused" fails the owned
				// settlement's second proof); once cancelled it is terminal.
				status: rec.status === "cancelled" ? "cancelled" : "paused",
				startTime: rec.queued?.createdAt ?? Date.now(),
				label: `queued resume ${subagentId}`,
				abortController: new AbortController(),
				promise: Promise.resolve(),
			};
		}
		return this.#jobs.get(id);
	}

	/**
	 * The EXECUTION promise of the job record whose generation matches the
	 * captured generation, or undefined when the record is gone or rebound.
	 * The promise settles only when the job's function actually unwinds — the
	 * eagerly-updated cancel status is not proof of quiescence (review P1).
	 */
	getJobPromise(id: string, generation: string): Promise<void> | undefined {
		const job = this.#jobs.get(id);
		if (!job || job.generation !== generation) return undefined;
		return job.promise;
	}

	getRunningJobs(filter?: AsyncJobFilter): AsyncJob[] {
		return this.#filterJobs(this.#jobs.values(), filter).filter(job => job.status === "running");
	}

	/** Whether a new running job can be admitted without starting side effects. */
	hasCapacity(filter?: AsyncJobFilter): boolean {
		return this.getRunningJobs(filter).length + this.#pendingAdmissions < this.#maxRunningJobs;
	}

	reserveCapacity(): AsyncJobAdmission {
		if (this.#disposed || this.#registrationClosed || !this.hasCapacity()) {
			throw new Error(
				`Background job limit reached (${this.#maxRunningJobs}). Wait for running jobs to finish or cancel one.`,
			);
		}
		const token: AsyncJobAdmission = { manager: this };
		this.#admissions.set(token, true);
		this.#pendingAdmissions += 1;
		return token;
	}

	releaseCapacity(token: AsyncJobAdmission): void {
		if (!this.#consumeAdmission(token)) return;
		this.#notifyChange();
	}

	getRecentJobs(limit = 10, filter?: AsyncJobFilter): AsyncJob[] {
		return this.#filterJobs(this.#jobs.values(), filter)
			.filter(job => job.status !== "running")
			.sort((a, b) => b.startTime - a.startTime)
			.slice(0, limit);
	}

	getAllJobs(filter?: AsyncJobFilter): AsyncJob[] {
		return this.#filterJobs(this.#jobs.values(), filter);
	}

	/**
	 * Append a sanitized process-stream chunk for a background job. Called from
	 * the unthrottled bash-executor capture hook (`onRawChunk`) so monitor sees
	 * every chunk even when preview/progress callbacks are throttled.
	 *
	 * Offsets are in UTF-8 bytes. Storing chunk metadata avoids unsafe byte
	 * slicing across multibyte characters at read time. The retention window is
	 * a per-job rolling cap (`DEFAULT_JOB_OUTPUT_RETENTION_BYTES`); when it
	 * overflows, oldest whole chunks are evicted and `startOffset` advances —
	 * subsequent reads from a stale offset get `truncated: true`.
	 */
	appendOutput(jobId: string, chunk: string): void {
		if (this.#disposed) return;
		if (!chunk) return;
		if (!this.#jobs.has(jobId)) return;

		const state = this.#outputState.get(jobId) ?? {
			chunks: [],
			startOffset: 0,
			nextOffset: 0,
			retainedBytes: 0,
		};

		const byteLength = Buffer.byteLength(chunk, "utf8");
		if (byteLength === 0) return;

		const retainedChunk =
			byteLength > this.#outputRetentionBytes
				? sliceTextAfterUtf8ByteOffset(chunk, byteLength - this.#outputRetentionBytes)
				: chunk;
		const retainedByteLength = Buffer.byteLength(retainedChunk, "utf8");
		const skippedBytes = byteLength - retainedByteLength;
		const startByte = state.nextOffset + skippedBytes;
		const endByte = startByte + retainedByteLength;
		state.chunks.push({ startByte, endByte, text: retainedChunk });
		state.retainedBytes += retainedByteLength;
		state.nextOffset = endByte;
		if (skippedBytes > 0) state.startOffset = Math.max(state.startOffset, startByte);

		while (state.retainedBytes > this.#outputRetentionBytes && state.chunks.length > 0) {
			const dropped = state.chunks.shift();
			if (!dropped) break;
			const droppedBytes = dropped.endByte - dropped.startByte;
			state.retainedBytes -= droppedBytes;
			state.startOffset = dropped.endByte;
		}

		this.#outputState.set(jobId, state);
	}

	/**
	 * Read fresh process-stream output for a job since `offset` (in UTF-8
	 * bytes). Returns `undefined` when the job does not exist or when an
	 * `ownerId` filter is set and the job belongs to a different owner — this
	 * mirrors the manager-level "not found" pattern used by `cancel`.
	 *
	 * - `offset < startOffset` returns the retained tail with `truncated: true`.
	 * - `offset > nextOffset` clamps to `nextOffset` and returns an empty text
	 *   slice with `truncated: false`.
	 * - Assembled text slices the leading retained chunk at a UTF-8 codepoint
	 *   boundary when needed, so multibyte characters cannot be split.
	 */
	readOutputSince(jobId: string, offset: number, filter?: AsyncJobFilter): AsyncJobOutputSlice | undefined {
		const job = this.#jobs.get(jobId);
		if (!job) return undefined;
		if (filter?.ownerId && job.ownerId !== filter.ownerId) return undefined;

		const state = this.#outputState.get(jobId);
		if (!state) {
			return {
				jobId,
				status: job.status,
				text: "",
				startOffset: 0,
				nextOffset: 0,
				truncated: false,
			};
		}

		const requestedOffset = Math.max(0, Math.floor(offset));
		if (requestedOffset >= state.nextOffset) {
			return {
				jobId,
				status: job.status,
				text: "",
				startOffset: state.startOffset,
				nextOffset: state.nextOffset,
				truncated: false,
			};
		}

		const truncated = requestedOffset < state.startOffset;
		const effectiveOffset = truncated ? state.startOffset : requestedOffset;
		const parts: string[] = [];
		for (const chunk of state.chunks) {
			if (chunk.endByte <= effectiveOffset) continue;
			if (effectiveOffset > chunk.startByte) {
				parts.push(sliceTextFromUtf8ByteOffset(chunk.text, effectiveOffset - chunk.startByte));
				continue;
			}
			parts.push(chunk.text);
		}

		return {
			jobId,
			status: job.status,
			text: parts.join(""),
			startOffset: state.startOffset,
			nextOffset: state.nextOffset,
			truncated,
		};
	}

	/**
	 * Register an owner-scoped cleanup callback. Returns an unregister function.
	 *
	 * Used by Cron* tools to clear session-scoped timers when the owning agent
	 * is torn down. Invoked by `runOwnerCleanups({ ownerId })` before
	 * `cancelAll({ ownerId })` so timers cannot register new jobs during
	 * teardown.
	 */
	registerOwnerCleanup(ownerId: string, cleanup: () => void): () => void {
		if (!ownerId) {
			throw new Error("registerOwnerCleanup requires a non-empty ownerId");
		}
		let bag = this.#ownerCleanups.get(ownerId);
		if (!bag) {
			bag = new Set();
			this.#ownerCleanups.set(ownerId, bag);
		}
		bag.add(cleanup);
		return () => {
			const current = this.#ownerCleanups.get(ownerId);
			if (!current) return;
			current.delete(cleanup);
			if (current.size === 0) this.#ownerCleanups.delete(ownerId);
		};
	}

	/** Run producer cleanups, then perform the legacy destructive subagent purge. */
	runOwnerCleanups(filter?: AsyncJobFilter): void {
		this.runOwnerProducerCleanups(filter);
		this.#purgeOwnerSubagentState(filter?.ownerId);
	}

	getDeliveryState(filter?: AsyncJobFilter): AsyncJobDeliveryState {
		this.#expireMonitorTombstones();
		this.#pruneEvictedDeadLetters();
		const deliveries = this.#filterDeliveries(filter);
		const inFlightDeliveries = this.#filterInFlightDeliveries(filter);
		const ownerId = filter?.ownerId;
		const evictedDeadLettered = ownerId
			? Array.from(this.#evictedDeadLetters.values()).filter(entry => entry.ownerId === ownerId).length
			: this.#evictedDeadLetters.size;
		const deadLettered =
			(ownerId
				? Array.from(this.#deadLetteredDeliveries.keys()).filter(
						jobId => this.#deadLetteredDeliveryOwners.get(jobId) === ownerId,
					).length
				: this.#deadLetteredDeliveries.size) + evictedDeadLettered;
		const nextRetryAt = deliveries.reduce<number | undefined>((next, delivery) => {
			if (next === undefined) return delivery.nextAttemptAt;
			return Math.min(next, delivery.nextAttemptAt);
		}, undefined);

		return {
			queued: deliveries.length + inFlightDeliveries.length,
			delivering: inFlightDeliveries.length > 0 || (this.#deliveryLoop !== undefined && deliveries.length > 0),
			nextRetryAt,
			pendingJobIds: deliveries.concat(inFlightDeliveries).map(delivery => delivery.jobId),
			deadLettered,
		};
	}

	/**
	 * One synchronous pass over jobs plus delivery state.
	 *
	 * Every returned job carries exactly one {@link JobDeliveryState}, and
	 * dead-lettered evidence is included even when its record is already gone, so
	 * no terminal job can end up invisible to the UI.
	 */
	getJobsSnapshot(filter?: AsyncJobFilter): AsyncJobsSnapshot {
		this.#expireMonitorTombstones();
		this.#pruneEvictedDeadLetters();

		const pending = new Set<string>();
		for (const delivery of this.#deliveries) pending.add(`${delivery.jobId}:${delivery.generation}`);
		for (const delivery of this.#inFlightDeliveries) pending.add(`${delivery.jobId}:${delivery.generation}`);

		const failedVisible = new Set<string>();
		for (const entry of this.#deadLetteredDeliveries.values()) {
			failedVisible.add(`${entry.jobId}:${entry.generation}`);
		}
		for (const entry of this.#evictedDeadLetters.values()) {
			failedVisible.add(`${entry.jobId}:${entry.generation}`);
		}

		const jobs = this.#filterJobs(this.#jobs.values(), filter).map<AsyncJobSnapshotEntry>(job => {
			const key = `${job.id}:${job.generation}`;
			const deliveryState: JobDeliveryState = failedVisible.has(key)
				? "failed-visible"
				: pending.has(key) || job.status === "running" || job.status === "paused"
					? "pending"
					: "delivered";
			return {
				id: job.id,
				kind: job.type,
				label: job.label,
				status: job.status,
				generation: job.generation,
				backgrounded: job.metadata?.backgrounded === true,
				deliveryState,
			};
		});

		const ownerId = filter?.ownerId;
		const deadLettered: DeadLetteredJobSnapshotEntry[] = [];
		for (const entry of this.#deadLetteredDeliveries.values()) {
			const entryOwner = this.#deadLetteredDeliveryOwners.get(entry.jobId);
			if (ownerId && entryOwner !== ownerId) continue;
			deadLettered.push({
				jobId: entry.jobId,
				generation: entry.generation,
				ownerId: entryOwner,
				attempt: entry.attempt,
				lastError: entry.lastError,
				recordedAt: Date.now(),
			});
		}
		for (const entry of this.#evictedDeadLetters.values()) {
			if (ownerId && entry.ownerId !== ownerId) continue;
			deadLettered.push({ ...entry });
		}

		return { jobs, deadLettered };
	}

	hasPendingDeliveries(filter?: AsyncJobFilter): boolean {
		return this.getDeliveryState(filter).queued > 0;
	}

	watchJobGenerations(jobIds: string[]): AsyncJobWatchHandle {
		const uniqueJobIds = Array.from(new Set(jobIds.map(id => id.trim()).filter(id => id.length > 0)));
		const generations: string[] = [];
		for (const jobId of uniqueJobIds) {
			const generation = this.#jobs.get(jobId)?.generation;
			if (!generation) continue;
			generations.push(generation);
			this.#watchedGenerations.set(generation, (this.#watchedGenerations.get(generation) ?? 0) + 1);
		}
		let closed = false;
		return {
			close: () => {
				if (closed) return 0;
				closed = true;
				let removed = 0;
				for (const generation of generations) {
					const watchers = this.#watchedGenerations.get(generation) ?? 0;
					if (watchers === 1) {
						this.#watchedGenerations.delete(generation);
						removed += 1;
					} else if (watchers > 1) this.#watchedGenerations.set(generation, watchers - 1);
				}
				if (removed > 0) this.#ensureDeliveryLoop();
				return removed;
			},
		};
	}

	watchJobs(jobIds: string[]): number {
		const uniqueJobIds = Array.from(new Set(jobIds.map(id => id.trim()).filter(id => id.length > 0)));
		for (const jobId of uniqueJobIds) {
			this.#watchedJobs.set(jobId, (this.#watchedJobs.get(jobId) ?? 0) + 1);
		}
		return uniqueJobIds.length;
	}

	unwatchJobs(jobIds: string[]): number {
		const uniqueJobIds = Array.from(new Set(jobIds.map(id => id.trim()).filter(id => id.length > 0)));
		let removed = 0;
		for (const jobId of uniqueJobIds) {
			const watchers = this.#watchedJobs.get(jobId) ?? 0;
			if (watchers === 1) {
				this.#watchedJobs.delete(jobId);
				removed += 1;
			} else if (watchers > 1) this.#watchedJobs.set(jobId, watchers - 1);
		}
		if (removed > 0) this.#ensureDeliveryLoop();
		return removed;
	}

	acknowledgeDeliveries(jobIds: string[]): number {
		const uniqueJobIds = Array.from(new Set(jobIds.map(id => id.trim()).filter(id => id.length > 0)));
		if (uniqueJobIds.length === 0) return 0;
		for (const jobId of uniqueJobIds) {
			const currentJob = this.#jobs.get(jobId);
			if (currentJob) this.#suppressedDeliveries.add(currentJob.generation);
			for (const delivery of [...this.#deliveries, ...this.#inFlightDeliveries]) {
				if (delivery.jobId === jobId) this.#suppressedDeliveries.add(delivery.generation);
			}
		}
		const before = this.#deliveries.length;
		this.#deliveries.splice(
			0,
			this.#deliveries.length,
			...this.#deliveries.filter(delivery => !this.#isDeliveryAcknowledged(delivery.jobId, delivery.generation)),
		);
		this.#notifyChange();
		return before - this.#deliveries.length;
	}

	/**
	 * Cancel running jobs. With `filter.ownerId` set, cancels only jobs the
	 * matching agent registered; with no filter, cancels every running job
	 * (used by `dispose()` to nuke the manager's state).
	 */
	/**
	 * Synchronously fail a running job AND enqueue its delivery, exactly once.
	 *
	 * An externally owned wait -- an ACP client terminal, say -- can fail while its
	 * owner is being torn down. `cancel()` is the wrong tool there: it marks the job
	 * cancelled, and the cancelled path deliberately enqueues NO delivery, so the
	 * failure would never become visible to anyone. This is the single transition
	 * that both fails the job and delivers that failure in one synchronous block, so
	 * it cannot lose the race against disposal.
	 */
	failNow(jobId: string, generation: string, errorText: string, options?: { abort?: boolean }): boolean {
		const job = this.#jobs.get(jobId);
		if (!job || job.generation !== generation) return false;
		if (job.status !== "running") return false;
		if (this.#externallySettled.has(generation)) return false;
		this.#externallySettled.add(generation);
		if (options?.abort !== false) job.abortController.abort();
		job.status = "failed";
		this.#freezeEndTime(job);
		job.errorText = errorText;
		this.#markRecordTerminal(jobId, "failed", generation);
		this.#publishTerminal(job);
		this.#enqueueDelivery(jobId, errorText);
		this.#runLifecycle(jobId, "terminal", job);
		this.#scheduleEviction(jobId);
		this.#drainResumeQueue();
		this.#notifyChange();
		return true;
	}

	cancelAll(filter?: AsyncJobFilter): void {
		for (const job of this.getRunningJobs(filter)) {
			if (this.cancel(job.id, filter)) this.#scheduleEviction(job.id);
		}
	}

	async waitForOwnerInFlightDeliveries(ownerId: string, options?: { timeoutMs?: number }): Promise<boolean> {
		const inFlight = this.#inFlightDeliveries
			.filter(delivery => delivery.ownerId === ownerId)
			.map(delivery => delivery.promise)
			.filter((promise): promise is Promise<void> => promise !== undefined);
		if (inFlight.length === 0) return true;
		const timeoutMs = Math.max(0, options?.timeoutMs ?? OWNER_SUBAGENT_SHUTDOWN_TIMEOUT_MS);
		let timedOut = false;
		await Promise.race([
			Promise.allSettled(inFlight),
			Bun.sleep(timeoutMs).then(() => {
				timedOut = true;
			}),
		]);
		return !timedOut;
	}
	async cancelAndSettleOwnerJobs(ownerId: string, options?: { timeoutMs?: number }): Promise<boolean> {
		const jobs = this.getAllJobs({ ownerId });
		for (const job of jobs) this.cancel(job.id, { ownerId });
		const timeoutMs = Math.max(0, options?.timeoutMs ?? OWNER_SUBAGENT_SHUTDOWN_TIMEOUT_MS);
		let timedOut = false;
		await Promise.race([
			Promise.allSettled(jobs.map(job => job.promise)),
			Bun.sleep(timeoutMs).then(() => {
				timedOut = true;
			}),
		]);
		const inFlight = this.#inFlightDeliveries
			.filter(delivery => delivery.ownerId === ownerId)
			.map(delivery => delivery.promise)
			.filter((promise): promise is Promise<void> => promise !== undefined);
		if (inFlight.length === 0) return !timedOut;
		let deliveryTimedOut = false;
		await Promise.race([
			Promise.allSettled(inFlight),
			Bun.sleep(timeoutMs).then(() => {
				deliveryTimedOut = true;
			}),
		]);
		return !timedOut && !deliveryTimedOut;
	}

	getLastDisposeDiagnostics(): AsyncJobDisposeDiagnostics {
		return { ...this.#lastDisposeDiagnostics, stuckJobIds: [...this.#lastDisposeDiagnostics.stuckJobIds] };
	}

	async #waitForAllWithDeadline(timeoutMs: number): Promise<{ completed: boolean; stuckJobIds: string[] }> {
		const jobs = Array.from(this.#jobs.values());
		if (jobs.length === 0) return { completed: true, stuckJobIds: [] };
		let timedOut = false;
		await Promise.race([
			Promise.allSettled(jobs.map(job => job.promise)),
			Bun.sleep(Math.max(0, timeoutMs)).then(() => {
				timedOut = true;
			}),
		]);
		if (!timedOut) return { completed: true, stuckJobIds: [] };
		return {
			completed: false,
			stuckJobIds: Array.from(this.#jobs.values())
				.filter(job => job.status === "running" || job.status === "cancelled")
				.map(job => job.id),
		};
	}

	/**
	 * Mark a running job as backgrounded (folded out of its foreground call).
	 * Read by getJobsSnapshot so folded work stays visible; safe to call twice.
	 */
	markBackgrounded(jobId: string, generation: string): boolean {
		const job = this.#jobs.get(jobId);
		if (!job || job.generation !== generation) return false;
		job.metadata = { ...job.metadata, backgrounded: true };
		this.#notifyChange();
		return true;
	}

	async waitForAll(): Promise<void> {
		await Promise.all(Array.from(this.#jobs.values()).map(job => job.promise));
	}

	async drainDeliveries(options?: { timeoutMs?: number; filter?: AsyncJobFilter }): Promise<boolean> {
		const timeoutMs = options?.timeoutMs;
		const filter = options?.filter;
		const hasDeadline = timeoutMs !== undefined;
		const deadline = hasDeadline ? Date.now() + Math.max(timeoutMs, 0) : Number.POSITIVE_INFINITY;

		while (this.hasPendingDeliveries(filter)) {
			if (filter?.ownerId) {
				const delivered = await this.#deliverNextFiltered(filter, deadline);
				if (delivered) continue;
				return false;
			}
			const inFlightDeliveries = this.#filterInFlightDeliveries();
			if (inFlightDeliveries.length > 0 && this.#filterDeliveries().length === 0) {
				const delivered = await this.#waitForDeliveryPromise(inFlightDeliveries[0]?.promise, deadline);
				if (delivered) continue;
				return false;
			}

			this.#ensureDeliveryLoop();
			const loop = this.#deliveryLoop;
			if (!loop) {
				continue;
			}

			if (!hasDeadline) {
				await loop;
				continue;
			}

			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) {
				return false;
			}

			await Promise.race([loop, Bun.sleep(remainingMs)]);
			if (Date.now() >= deadline && this.hasPendingDeliveries(filter)) {
				return false;
			}
		}

		return true;
	}

	async dispose(options?: { timeoutMs?: number }): Promise<boolean> {
		// Close registration FIRST, then run owner cleanups, and only then mark the
		// manager disposed. Setting #disposed before the cleanups made
		// #ensureDeliveryLoop a no-op, so a failure an owner cleanup settled through
		// failNow could never be drained -- it sat in the queue and vanished. Closing
		// registration keeps the original protection (cleanups cannot register fresh
		// work) without disabling delivery. Errors in cleanups are logged, never
		// escalated.
		this.#registrationClosed = true;
		this.#clearEvictionTimers();
		this.runOwnerCleanups();
		this.#disposed = true;
		this.cancelAll();
		for (const tombstone of this.#monitorTombstones.values()) {
			try {
				tombstone.purge();
			} catch (error) {
				logger.warn("Monitor tombstone purge failed during dispose", {
					jobId: tombstone.jobId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		this.#monitorTombstones.clear();
		const timeoutMs = options?.timeoutMs ?? 3_000;
		const waitResult = await this.#waitForAllWithDeadline(timeoutMs);
		const drained = waitResult.completed ? await this.drainDeliveries({ timeoutMs }) : false;
		this.#lastDisposeDiagnostics = { stuckJobIds: waitResult.stuckJobIds, deliveriesDrained: drained };
		if (waitResult.stuckJobIds.length > 0) {
			logger.warn("Async job manager dispose timed out waiting for jobs", { stuckJobIds: waitResult.stuckJobIds });
		}
		this.#clearEvictionTimers();
		this.#jobs.clear();
		this.#deliveries.length = 0;
		this.#inFlightDeliveries.length = 0;
		this.#deadLetteredDeliveries.clear();
		this.#evictedDeadLetters.clear();
		this.#externallySettled.clear();
		this.#deadLetteredDeliveryOwners.clear();
		this.#suppressedDeliveries.clear();
		this.#deliveryAckOwners.clear();
		this.#waitGenerationAliases.clear();
		this.#watchedJobs.clear();
		this.#watchedGenerations.clear();
		this.#outputState.clear();
		this.#ownerCleanups.clear();
		this.#subagentRecords.clear();
		this.#liveHandles.clear();
		this.#subagentProgress.clear();
		this.#resumeDescriptors.clear();
		this.#descriptorResumeRunners.clear();
		this.#resumeQueue.length = 0;
		this.#ownerSubagentShutdownLeases.clear();
		this.#notifyChange();
		this.#changeListeners.clear();
		return drained && waitResult.completed;
	}

	#resolveJobId(preferredId?: string): string {
		preferredId = preferredId?.trim();
		if (!preferredId) {
			let candidate = 1;
			while (true) {
				const id = `bg_${candidate}`;
				// Never recycle an id that still has a queued or in-flight delivery: the
				// recycled record would give the pending old delivery a mismatched
				// generation and #deliverDelivery would silently discard it before
				// onJobComplete ever ran.
				if (!this.#jobs.has(id) && !this.#hasPendingDeliveryForJobId(id)) {
					return id;
				}
				candidate += 1;
			}
		}

		const base = preferredId.trim();
		if (!this.#jobs.has(base) && !this.#hasDeliveryCollisionForJobId(base)) return base;

		let suffix = 2;
		let candidate = `${base}-${suffix}`;
		while (this.#jobs.has(candidate) || this.#hasDeliveryCollisionForJobId(candidate)) {
			suffix += 1;
			candidate = `${base}-${suffix}`;
		}
		return candidate;
	}

	#consumeAdmission(token: AsyncJobAdmission): boolean {
		if (token.manager !== this || this.#admissions.get(token) !== true) return false;
		this.#admissions.set(token, false);
		this.#pendingAdmissions -= 1;
		return true;
	}

	#scheduleEviction(jobId: string): void {
		if (this.#disposed) return;
		this.#notifyChange();
		if (this.#retentionMs <= 0) {
			this.#evictJob(jobId);
			return;
		}
		const existing = this.#evictionTimers.get(jobId);
		if (existing) {
			clearTimeout(existing);
		}
		const timer = setTimeout(() => {
			this.#evictionTimers.delete(jobId);
			this.#evictJob(jobId);
			this.#notifyChange();
		}, this.#retentionMs);
		timer.unref();
		this.#evictionTimers.set(jobId, timer);
	}

	#evictJob(jobId: string): void {
		this.#expireMonitorTombstones();
		this.#recordMonitorTombstone(jobId);
		this.#runLifecycle(jobId, "evict");
		this.#purgeTerminalSubagentStateForJob(jobId);
		const job = this.#jobs.get(jobId);
		this.#jobs.delete(jobId);
		this.#settledJobIds.delete(jobId);
		this.#lifecycles.delete(jobId);
		this.#lifecyclePhases.delete(jobId);
		this.#deadLetteredDeliveries.delete(jobId);
		this.#deadLetteredDeliveryOwners.delete(jobId);
		this.#suppressedDeliveries.delete(jobId);
		if (job) this.#publishedTerminalGenerations.delete(job.generation);
		this.#outputState.delete(jobId);
	}

	#clearEvictionTimers(): void {
		for (const timer of this.#evictionTimers.values()) {
			clearTimeout(timer);
		}
		this.#evictionTimers.clear();
	}

	#filterDeliveries(filter?: AsyncJobFilter): AsyncJobDelivery[] {
		const ownerId = filter?.ownerId;
		if (!ownerId)
			return this.#deliveries.filter(delivery => !this.isDeliverySuppressed(delivery.jobId, delivery.generation));
		return this.#deliveries.filter(
			delivery => delivery.ownerId === ownerId && !this.isDeliverySuppressed(delivery.jobId, delivery.generation),
		);
	}

	#filterInFlightDeliveries(filter?: AsyncJobFilter): AsyncJobDelivery[] {
		const ownerId = filter?.ownerId;
		if (!ownerId)
			return this.#inFlightDeliveries.filter(
				delivery => !this.isDeliverySuppressed(delivery.jobId, delivery.generation),
			);
		return this.#inFlightDeliveries.filter(
			delivery => delivery.ownerId === ownerId && !this.isDeliverySuppressed(delivery.jobId, delivery.generation),
		);
	}

	#isDeliveryFenced(delivery: AsyncJobDelivery): boolean {
		return Boolean(delivery.ownerId && this.#isOwnerSubagentShutdownFenced(delivery.ownerId));
	}

	#hasDeliverable(): boolean {
		return this.#deliveries.some(
			delivery =>
				!this.isDeliverySuppressed(delivery.jobId, delivery.generation) && !this.#isDeliveryFenced(delivery),
		);
	}

	async #deliverNextFiltered(filter: AsyncJobFilter, deadline: number): Promise<boolean> {
		while (true) {
			let selected: AsyncJobDelivery | undefined;
			for (const delivery of this.#deliveries) {
				if (delivery.ownerId !== filter.ownerId) continue;
				if (this.isDeliverySuppressed(delivery.jobId, delivery.generation) || this.#isDeliveryFenced(delivery))
					continue;
				if (!selected || delivery.nextAttemptAt < selected.nextAttemptAt) {
					selected = delivery;
				}
			}

			if (!selected) {
				const inFlight = this.#filterInFlightDeliveries(filter);
				if (inFlight.length === 0) return this.#filterDeliveries(filter).length === 0;
				return this.#waitForDeliveryPromise(inFlight[0]?.promise, deadline);
			}

			const now = Date.now();
			if (selected.nextAttemptAt > now) {
				if (selected.nextAttemptAt > deadline) return false;
				await Bun.sleep(selected.nextAttemptAt - now);
				continue;
			}

			const index = this.#deliveries.indexOf(selected);
			if (index === -1) continue;
			this.#deliveries.splice(index, 1);
			if (this.isDeliverySuppressed(selected.jobId, selected.generation)) continue;

			return this.#waitForDeliveryPromise(this.#deliverDelivery(selected), deadline);
		}
	}

	#isDeliveryAcknowledged(jobId: string, generation?: string): boolean {
		return (
			(generation !== undefined && this.#suppressedDeliveries.has(generation)) ||
			this.#suppressedDeliveries.has(jobId)
		);
	}

	isDeliverySuppressed(jobId: string, generation?: string): boolean {
		const watchedGeneration = generation ?? this.#jobs.get(jobId)?.generation;
		return (
			this.#isDeliveryAcknowledged(jobId, generation) ||
			(this.#watchedJobs.get(jobId) ?? 0) > 0 ||
			(watchedGeneration !== undefined && (this.#watchedGenerations.get(watchedGeneration) ?? 0) > 0)
		);
	}

	#pruneEvictedDeadLetters(): void {
		for (const jobId of this.#deadLetteredDeliveries.keys()) {
			if (this.#jobs.has(jobId)) continue;
			this.#deadLetteredDeliveries.delete(jobId);
			this.#deadLetteredDeliveryOwners.delete(jobId);
		}
	}

	/** Whether any queued or in-flight delivery still targets `jobId`. */
	#hasPendingDeliveryForJobId(jobId: string): boolean {
		return (
			this.#deliveries.some(delivery => delivery.jobId === jobId) ||
			this.#inFlightDeliveries.some(delivery => delivery.jobId === jobId)
		);
	}

	/** Whether a retained delivery generation already claims `jobId`. */
	#hasDeliveryCollisionForJobId(jobId: string): boolean {
		if (this.#hasPendingDeliveryForJobId(jobId)) return true;
		if (this.#suppressedDeliveries.has(jobId)) return true;
		if (this.#deadLetteredDeliveries.has(jobId)) return true;
		for (const entry of this.#evictedDeadLetters.values()) {
			if (entry.jobId === jobId) return true;
		}
		// Acknowledged deliveries are removed from #deliveries, so resolve their
		// job id through the retained terminal event while the suppressed generation
		// remains observable.
		for (const event of this.#terminalEvents.values()) {
			if (event.jobId === jobId && this.#suppressedDeliveries.has(event.generation)) return true;
		}
		return false;
	}

	/**
	 * Record a retry-cap failure whose job record is already gone.
	 *
	 * Ordering mirrors {@link AsyncJobManager.prototype} `#recordDeadLetter`:
	 * insert, retire the exact owned tuple, then trim. Retiring before the trim
	 * means a later trimmed entry can never strand registry authority.
	 */
	#recordEvictedDeadLetter(delivery: AsyncJobDelivery): void {
		this.#evictedDeadLetters.delete(delivery.generation);
		this.#evictedDeadLetters.set(delivery.generation, {
			jobId: delivery.jobId,
			generation: delivery.generation,
			ownerId: delivery.ownerId,
			attempt: delivery.attempt,
			lastError: delivery.lastError,
			recordedAt: Date.now(),
		});
		retireOwnedRegistrationForDeadLetter(AsyncJobManager.endpointIdOf(this), delivery.jobId, delivery.generation);
		while (this.#evictedDeadLetters.size > MAX_EVICTED_DEAD_LETTERS) {
			const oldestGeneration = this.#evictedDeadLetters.keys().next().value;
			if (oldestGeneration === undefined) return;
			this.#evictedDeadLetters.delete(oldestGeneration);
		}
	}

	#recordDeadLetter(delivery: AsyncJobDelivery): void {
		this.#pruneEvictedDeadLetters();
		const currentJob = this.#jobs.get(delivery.jobId);
		if (!currentJob || currentJob.generation !== delivery.generation) return;
		this.#deadLetteredDeliveries.delete(delivery.jobId);
		this.#deadLetteredDeliveryOwners.delete(delivery.jobId);
		this.#deadLetteredDeliveries.set(delivery.jobId, {
			jobId: delivery.jobId,
			generation: delivery.generation,
			attempt: delivery.attempt,
			lastError: delivery.lastError,
		});
		this.#deadLetteredDeliveryOwners.set(delivery.jobId, delivery.ownerId);
		// The dead-lettered delivery never injects a message and has no later
		// consumption boundary: retire the exact owned registration so the
		// terminal tuple does not occupy the global registries until a future
		// job-record eviction makes it invisible to settlement scans (review
		// thread P2).
		retireOwnedRegistrationForDeadLetter(AsyncJobManager.endpointIdOf(this), delivery.jobId, delivery.generation);
		while (this.#deadLetteredDeliveries.size > MAX_DEAD_LETTERED_DELIVERIES) {
			const oldestJobId = this.#deadLetteredDeliveries.keys().next().value;
			if (oldestJobId === undefined) return;
			this.#deadLetteredDeliveries.delete(oldestJobId);
			this.#deadLetteredDeliveryOwners.delete(oldestJobId);
		}
		this.#notifyChange();
	}

	#enqueueDelivery(jobId: string, text: string): void {
		const job = this.#jobs.get(jobId);
		if (!job || this.#isDeliveryAcknowledged(jobId, job.generation)) return;
		const deliveryText = this.#boundedDeliveryText(text);
		this.#deliveries.push({
			jobId,
			generation: job.generation,
			job,
			text: deliveryText.text,
			originalBytes: deliveryText.originalBytes,
			truncated: deliveryText.truncated,
			attempt: 0,
			nextAttemptAt: Date.now(),
			ownerId: job.ownerId,
		});
		while (this.#deliveries.length > DEFAULT_MAX_DELIVERY_QUEUE) {
			const dropped = this.#deliveries.shift();
			if (dropped) this.#recordDeadLetter(dropped);
		}
		this.#notifyChange();
		this.#ensureDeliveryLoop();
	}

	#boundedDeliveryText(text: string): { text: string; originalBytes?: number; truncated?: boolean } {
		const bytes = Buffer.byteLength(text, "utf8");
		if (bytes <= DELIVERY_MAX_TEXT_BYTES) return { text };
		const head = sliceTextToUtf8ByteLength(text, DELIVERY_PREVIEW_HEAD_BYTES);
		const tailStart = Math.max(0, bytes - DELIVERY_PREVIEW_TAIL_BYTES);
		const tail = sliceTextAfterUtf8ByteOffset(text, tailStart);
		return {
			text: `${head}\n\n[async delivery output truncated from ${bytes} bytes]\n\n${tail}`,
			originalBytes: bytes,
			truncated: true,
		};
	}

	#ensureDeliveryLoop(): void {
		if (this.#disposed) return;
		if (this.#deliveryLoop) {
			return;
		}

		this.#deliveryLoop = this.#runDeliveryLoop()
			.catch(error => {
				logger.error("Async job delivery loop crashed", { error: String(error) });
			})
			.finally(() => {
				this.#deliveryLoop = undefined;
				if (!this.#disposed && this.#hasDeliverable()) {
					this.#ensureDeliveryLoop();
				}
			});
	}

	async #runDeliveryLoop(): Promise<void> {
		while (this.#deliveries.length > 0) {
			const delivery = this.#deliveries.find(
				candidate =>
					!this.isDeliverySuppressed(candidate.jobId, candidate.generation) && !this.#isDeliveryFenced(candidate),
			);
			if (!delivery) return;
			const waitMs = delivery.nextAttemptAt - Date.now();
			if (waitMs > 0) {
				await Bun.sleep(waitMs);
			}
			const index = this.#deliveries.indexOf(delivery);
			if (index === -1) continue;
			if (this.isDeliverySuppressed(delivery.jobId, delivery.generation) || this.#isDeliveryFenced(delivery))
				continue;

			this.#deliveries.splice(index, 1);
			this.#notifyChange();
			await this.#deliverDelivery(delivery);
		}
	}

	#deliverDelivery(delivery: AsyncJobDelivery): Promise<void> {
		const promise = (async () => {
			this.#inFlightDeliveries.push(delivery);
			this.#notifyChange();
			try {
				const currentJob = this.#jobs.get(delivery.jobId);
				if (currentJob && currentJob.generation !== delivery.generation) return;
				if (this.#isDeliveryAcknowledged(delivery.jobId, delivery.generation)) return;
				await this.#onJobComplete(delivery.jobId, delivery.text, delivery.job);
			} catch (error) {
				delivery.attempt += 1;
				delivery.lastError = error instanceof Error ? error.message : String(error);
				if (delivery.attempt >= DELIVERY_MAX_ATTEMPTS) {
					// The retry cap is the only route that may outlive its record here:
					// #recordDeadLetter is pruned by record existence, so an
					// already-evicted job's cap failure would leave no visible terminal
					// state at all. The queue-overflow drop path keeps its existing
					// behavior and is deliberately unchanged.
					if (this.#jobs.has(delivery.jobId)) this.#recordDeadLetter(delivery);
					else this.#recordEvictedDeadLetter(delivery);
					logger.warn("Async job completion delivery reached retry cap", {
						jobId: delivery.jobId,
						attempt: delivery.attempt,
						error: delivery.lastError,
					});
				} else {
					delivery.nextAttemptAt = Date.now() + this.#getRetryDelay(delivery.attempt);
					const currentJob = this.#jobs.get(delivery.jobId);
					// An evicted record must not end retry eligibility: dispatch already
					// uses the retained delivery.job when #jobs no longer holds the record,
					// so only a PRESENT superseding generation discards.
					if (
						(currentJob === undefined || currentJob.generation === delivery.generation) &&
						!this.#isDeliveryAcknowledged(delivery.jobId, delivery.generation)
					) {
						this.#deliveries.push(delivery);
						this.#notifyChange();
					}
					logger.warn("Async job completion delivery failed", {
						jobId: delivery.jobId,
						attempt: delivery.attempt,
						nextRetryAt: delivery.nextAttemptAt,
						error: delivery.lastError,
					});
				}
			} finally {
				const index = this.#inFlightDeliveries.indexOf(delivery);
				if (index !== -1) this.#inFlightDeliveries.splice(index, 1);
				this.#notifyChange();
				if (!this.#disposed && this.#hasDeliverable()) this.#ensureDeliveryLoop();
			}
		})();
		delivery.promise = promise;
		return promise;
	}

	async #waitForDeliveryPromise(promise: Promise<void> | undefined, deadline: number): Promise<boolean> {
		if (!promise) return true;
		if (deadline === Number.POSITIVE_INFINITY) {
			await promise;
			return true;
		}
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) return false;
		let timedOut = false;
		await Promise.race([
			promise,
			Bun.sleep(remainingMs).then(() => {
				timedOut = true;
			}),
		]);
		return !timedOut;
	}

	#getRetryDelay(attempt: number): number {
		const exp = Math.min(Math.max(attempt - 1, 0), 8);
		const backoffMs = DELIVERY_RETRY_BASE_MS * 2 ** exp;
		const jitterMs = Math.floor(Math.random() * DELIVERY_RETRY_JITTER_MS);
		return Math.min(DELIVERY_RETRY_MAX_MS, backoffMs + jitterMs);
	}
}
