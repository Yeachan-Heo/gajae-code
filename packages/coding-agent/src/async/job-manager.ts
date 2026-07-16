import { logger } from "@gajae-code/utils";
import type { AgentProgress, AgentSource } from "../task/types";

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

export interface AsyncJob {
	id: string;
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
	subagent?: {
		id: string;
		agent: string;
		agentSource: AgentSource;
		description?: string;
		assignment?: string;
	};
	/** True when this bash job was started by the `monitor` tool (vs plain async bash). */
	monitor?: boolean;
}

/**
 * Typed outcome a subagent task run may produce. A `paused` outcome is
 * non-terminal and non-delivering: the run suspended at a safe boundary and the
 * subagent can be resumed from its persisted sessionFile. `completed` always
 * wins a race with a late pause because the run returns it once it has actually
 * finished.
 */
export type SubagentRunOutcome = { kind: "completed"; text: string } | { kind: "paused"; note?: string };

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
	/** False for ephemeral sessions (no persistent artifacts dir). */
	resumable: boolean;
	queued?: { ownerId?: string; seq: number; message?: string; createdAt: number };
	/** Resolved model the subagent was asked to use, e.g. "openai-codex/gpt-5.5". */
	requestedModel?: string;
	/** Model actually used after auth fallback (#985); equals requestedModel when no fallback. */
	effectiveModel?: string;
	/** True when the requested model lacked credentials and the subagent fell back to the parent model. */
	modelFellBack?: boolean;
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
export type ResumeRunner = (subagentId: string, message?: string, descriptor?: ResumeDescriptor) => string | undefined;

function sessionFileFromResumeDescriptorData(data: unknown): string | null {
	if (typeof data !== "object" || data === null) return null;
	const sessionFile = (data as { sessionFile?: unknown }).sessionFile;
	return typeof sessionFile === "string" && sessionFile.trim().length > 0 ? sessionFile : null;
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

export interface AsyncJobDisposeDiagnostics {
	stuckJobIds: string[];
	deliveriesDrained: boolean;
}

interface AsyncJobDelivery {
	jobId: string;
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
	attempt: number;
	lastError?: string;
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
}

/**
 * Filter applied to job query/cancel APIs. With `ownerId`, results are
 * restricted to jobs registered by that agent (registry id from
 * `AgentRegistry`, e.g. "0-Main", "3-AuthLoader").
 */
export interface AsyncJobFilter {
	ownerId?: string;
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

	/** Install or clear the process-global instance. */
	static setInstance(value: AsyncJobManager | undefined): void {
		AsyncJobManager.#instance = value;
	}

	/** Reset the process-global instance. Test-only. */
	static resetForTests(): void {
		AsyncJobManager.#instance = undefined;
	}

	readonly #jobs = new Map<string, AsyncJob>();
	readonly #deliveries: AsyncJobDelivery[] = [];
	readonly #inFlightDeliveries: AsyncJobDelivery[] = [];
	readonly #suppressedDeliveries = new Set<string>();
	readonly #watchedJobs = new Set<string>();
	readonly #evictionTimers = new Map<string, NodeJS.Timeout>();
	readonly #outputState = new Map<string, AsyncJobOutputState>();
	readonly #ownerCleanups = new Map<string, Set<() => void>>();
	readonly #lifecycles = new Map<string, AsyncJobLifecycleCleanup>();
	readonly #lifecyclePhases = new Map<string, Set<"cancel" | "terminal" | "evict">>();
	readonly #monitorTombstones = new Map<string, MonitorTombstone>();
	readonly #outputRetentionBytes = DEFAULT_JOB_OUTPUT_RETENTION_BYTES;
	readonly #onJobComplete: AsyncJobManagerOptions["onJobComplete"];
	readonly #maxRunningJobs: number;
	readonly #retentionMs: number;
	#deliveryLoop: Promise<void> | undefined;
	#disposed = false;
	readonly #subagentRecords = new Map<string, SubagentRecord>();
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
	readonly #ownerSubagentShutdownLeases = new Map<string, OwnerSubagentShutdownLeaseState>();
	#ownerSubagentShutdownSeq = 0;
	#lastDisposeDiagnostics: AsyncJobDisposeDiagnostics = { stuckJobIds: [], deliveriesDrained: true };
	/**
	 * Change listeners notified on any mutation that can alter the live job set
	 * (register, terminal/eviction transitions, dispose). Used by the status-line
	 * jobs widget / overlay to refresh event-driven without polling.
	 */
	readonly #changeListeners = new Set<() => void>();

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
		const runningCount = this.getRunningJobs().length;
		if (runningCount >= this.#maxRunningJobs) {
			throw new Error(
				`Background job limit reached (${this.#maxRunningJobs}). Wait for running jobs to finish or cancel one.`,
			);
		}

		this.#expireMonitorTombstones();
		const id = this.#resolveJobId(options?.id);
		this.#suppressedDeliveries.delete(id);
		const abortController = new AbortController();
		const startTime = Date.now();

		const job: AsyncJob = {
			id,
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

				if (job.status === "cancelled") {
					job.resultText = outcome.kind === "completed" ? outcome.text : outcome.note;
					this.#runLifecycle(id, "terminal", job);
					this.#scheduleEviction(id);
					this.#markRecordTerminal(id, "cancelled");
					this.#drainResumeQueue();
					return;
				}
				if (outcome.kind === "paused") {
					// Sole canonical writer of the running -> paused transition. No
					// delivery and no eviction scheduling: a paused subagent stays
					// listed and resumable from its sessionFile.
					job.status = "paused";
					this.#freezeEndTime(job);
					if (outcome.note) job.resultText = outcome.note;
					this.#markRecordPaused(id);
					this.#drainResumeQueue();
					return;
				}

				job.status = "completed";
				this.#freezeEndTime(job);
				job.resultText = outcome.text;
				this.#enqueueDelivery(id, outcome.text);
				this.#runLifecycle(id, "terminal", job);
				this.#scheduleEviction(id);
				this.#markRecordTerminal(id, "completed");
				this.#drainResumeQueue();
			} catch (error) {
				if (job.status === "cancelled") {
					job.errorText = error instanceof Error ? error.message : String(error);
					this.#runLifecycle(id, "terminal", job);
					this.#scheduleEviction(id);
					this.#markRecordTerminal(id, "cancelled");
					this.#drainResumeQueue();
					return;
				}
				this.#runLifecycle(id, "terminal", job);
				const errorText = error instanceof Error ? error.message : String(error);
				job.status = "failed";
				this.#freezeEndTime(job);
				job.errorText = errorText;
				this.#enqueueDelivery(id, errorText);
				this.#scheduleEviction(id);
				this.#markRecordTerminal(id, "failed");
				this.#drainResumeQueue();
			}
		})();

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
		const job = this.#jobs.get(id);
		if (!job) return false;
		if (filter?.ownerId && job.ownerId !== filter.ownerId) return false;
		if (job.status === "paused") {
			this.#runLifecycle(id, "cancel");
			// Paused jobs have no running promise to abort; transition directly.
			// The session file is kept, so the record stays resumable by id.
			job.status = "cancelled";
			this.#markRecordTerminal(id, "cancelled");
			this.#scheduleEviction(id);
			this.#drainResumeQueue();
			return true;
		}
		if (job.status !== "running") return false;
		this.#runLifecycle(id, "cancel");
		job.status = "cancelled";
		this.#freezeEndTime(job);
		job.abortController.abort();
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
		this.#subagentRecords.set(record.subagentId, record);
	}

	/** Patch model metadata onto an existing subagent record (best-effort; no-op if unknown). */
	updateSubagentModel(
		subagentId: string,
		model: { requestedModel?: string; effectiveModel?: string; modelFellBack?: boolean },
	): void {
		const record = this.#subagentRecords.get(subagentId);
		if (!record) return;
		record.requestedModel = model.requestedModel;
		record.effectiveModel = model.effectiveModel;
		record.modelFellBack = model.modelFellBack;
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
			resumable: sessionFile !== null,
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
	 * Resolve the resume runner for a subagent: prefer the per-descriptor runner
	 * captured at registration time (the originating parent's execution authority),
	 * falling back to the process-global runner only for descriptors registered
	 * without one.
	 */
	#resolveResumeRunner(subagentId: string): ResumeRunner | undefined {
		return this.#descriptorResumeRunners.get(subagentId) ?? this.#resumeRunner;
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
		if (state.phase === "proved" && state.proof) return state.proof;
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

	#recordByJobId(jobId: string): SubagentRecord | undefined {
		for (const rec of this.#subagentRecords.values()) {
			if (rec.currentJobId === jobId) return rec;
		}
		return undefined;
	}

	#markRecordPaused(jobId: string): void {
		const rec = this.#recordByJobId(jobId);
		if (rec) {
			rec.status = "paused";
			this.#liveHandles.delete(rec.subagentId);
			this.#subagentProgress.delete(rec.subagentId);
		}
	}

	#purgeTerminalSubagentStateForJob(jobId: string): void {
		const rec = this.#recordByJobId(jobId);
		if (!rec) return;
		if (rec.status === "paused" || rec.status === "queued") return;
		this.#liveHandles.delete(rec.subagentId);
		this.#subagentProgress.delete(rec.subagentId);
	}

	#markRecordTerminal(jobId: string, status: "completed" | "failed" | "cancelled"): void {
		const rec = this.#recordByJobId(jobId);
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

	/** Resume a non-running subagent from its sessionFile, optionally injecting a message first. */
	resumeSubagent(
		subagentId: string,
		filter?: AsyncJobFilter,
		message?: string,
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
		if (!rec.resumable || !rec.sessionFile) return { ok: false, reason: "context_unavailable" };
		if (!this.#resolveResumeRunner(rec.subagentId)) return { ok: false, reason: "no_runner" };
		if (this.getRunningJobs().length >= this.#maxRunningJobs) {
			const seq = ++this.#resumeSeq;
			rec.status = "queued";
			rec.queued = { ownerId: rec.ownerId, seq, message, createdAt: Date.now() };
			this.#resumeQueue.push({
				subagentId: rec.subagentId,
				ownerId: rec.ownerId,
				seq,
				message,
				createdAt: rec.queued.createdAt,
			});
			return { ok: true, queued: true, status: "queued" };
		}
		return this.#startResume(rec, message);
	}

	#startResume(
		rec: SubagentRecord,
		message?: string,
	): { ok: boolean; status?: SubagentLifecycle; jobId?: string; reason?: string } {
		if (this.#isOwnerSubagentShutdownFenced(rec.ownerId)) {
			return { ok: false, status: rec.status, reason: "owner_shutdown_in_progress" };
		}
		const prevJobId = rec.currentJobId;
		// Clear any retained progress from the previous run so a resumed subagent
		// never renders the prior run's tool/output as live before it emits again.
		this.#subagentProgress.delete(rec.subagentId);
		const runner = this.#resolveResumeRunner(rec.subagentId);
		const newJobId = runner?.(rec.subagentId, message, this.#resumeDescriptors.get(rec.subagentId));
		if (!newJobId) return { ok: false, reason: "resume_failed" };
		if (prevJobId && prevJobId !== newJobId) rec.historicalJobIds.push(prevJobId);
		rec.currentJobId = newJobId;
		rec.status = this.#jobs.get(newJobId)?.status ?? "running";
		rec.queued = undefined;
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
				const result = this.#startResume(rec, entry.message);
				if (result.reason === "owner_shutdown_in_progress") {
					index += 1;
					continue;
				}
				this.#resumeQueue.splice(index, 1);
			} catch (error) {
				if (error instanceof OwnerSubagentShutdownError) {
					index += 1;
					continue;
				}
				throw error;
			}
		}
	}

	/** Cancel a subagent by stable id across running/paused/queued states (keeps the session file). */
	cancelSubagent(subagentId: string, filter?: AsyncJobFilter): boolean {
		const rec = this.getSubagentRecord(subagentId, filter);
		if (!rec) return false;
		if (rec.status === "running" && rec.currentJobId) return this.cancel(rec.currentJobId, filter);
		if (rec.status === "paused") {
			if (rec.currentJobId) {
				const job = this.#jobs.get(rec.currentJobId);
				if (job && job.status === "paused") {
					job.status = "cancelled";
					this.#scheduleEviction(rec.currentJobId);
				}
			}
			rec.status = "cancelled";
			this.#liveHandles.delete(rec.subagentId);
			this.#subagentProgress.delete(rec.subagentId);
			this.#drainResumeQueue();
			return true;
		}
		if (rec.status === "queued") {
			const idx = this.#resumeQueue.findIndex(e => e.subagentId === rec.subagentId);
			if (idx !== -1) this.#resumeQueue.splice(idx, 1);
			rec.status = "cancelled";
			rec.queued = undefined;
			this.#subagentProgress.delete(rec.subagentId);
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
				this.#liveHandles.delete(sid);
				this.#resumeDescriptors.delete(sid);
				this.#descriptorResumeRunners.delete(sid);
				this.#subagentRecords.delete(sid);
				this.#subagentProgress.delete(sid);
			}
		}
	}

	getJob(id: string): AsyncJob | undefined {
		return this.#jobs.get(id);
	}

	getRunningJobs(filter?: AsyncJobFilter): AsyncJob[] {
		return this.#filterJobs(this.#jobs.values(), filter).filter(job => job.status === "running");
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

		const startByte = state.nextOffset;
		const endByte = startByte + byteLength;
		state.chunks.push({ startByte, endByte, text: chunk });
		state.retainedBytes += byteLength;
		state.nextOffset = endByte;

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
		const deadLettered = ownerId
			? Array.from(this.#deadLetteredDeliveries.keys()).filter(
					jobId => this.#deadLetteredDeliveryOwners.get(jobId) === ownerId,
				).length
			: this.#deadLetteredDeliveries.size;
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

	hasPendingDeliveries(filter?: AsyncJobFilter): boolean {
		return this.getDeliveryState(filter).queued > 0;
	}

	watchJobs(jobIds: string[]): number {
		const uniqueJobIds = Array.from(new Set(jobIds.map(id => id.trim()).filter(id => id.length > 0)));
		for (const jobId of uniqueJobIds) {
			this.#watchedJobs.add(jobId);
		}
		return uniqueJobIds.length;
	}

	unwatchJobs(jobIds: string[]): number {
		const uniqueJobIds = Array.from(new Set(jobIds.map(id => id.trim()).filter(id => id.length > 0)));
		let removed = 0;
		for (const jobId of uniqueJobIds) {
			if (this.#watchedJobs.delete(jobId)) {
				removed += 1;
			}
		}
		if (removed > 0) this.#ensureDeliveryLoop();
		return removed;
	}

	acknowledgeDeliveries(jobIds: string[]): number {
		const uniqueJobIds = Array.from(new Set(jobIds.map(id => id.trim()).filter(id => id.length > 0)));
		if (uniqueJobIds.length === 0) return 0;

		for (const jobId of uniqueJobIds) {
			this.#suppressedDeliveries.add(jobId);
		}

		const before = this.#deliveries.length;
		this.#deliveries.splice(
			0,
			this.#deliveries.length,
			...this.#deliveries.filter(delivery => !this.#isDeliveryAcknowledged(delivery.jobId)),
		);
		return before - this.#deliveries.length;
	}

	/**
	 * Cancel running jobs. With `filter.ownerId` set, cancels only jobs the
	 * matching agent registered; with no filter, cancels every running job
	 * (used by `dispose()` to nuke the manager's state).
	 */
	cancelAll(filter?: AsyncJobFilter): void {
		for (const job of this.getRunningJobs(filter)) {
			this.#runLifecycle(job.id, "cancel");
			job.status = "cancelled";
			this.#freezeEndTime(job);
			job.abortController.abort();
			this.#scheduleEviction(job.id);
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
		this.#disposed = true;
		this.#clearEvictionTimers();
		// Run-and-clear any remaining owner cleanups before tearing down jobs so
		// late-arriving timers cannot register fresh work against a disposed
		// manager. Errors in cleanup callbacks are logged but never escalated.
		this.runOwnerCleanups();
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
		this.#deadLetteredDeliveryOwners.clear();
		this.#suppressedDeliveries.clear();
		this.#watchedJobs.clear();
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
				if (!this.#jobs.has(id)) {
					return id;
				}
				candidate += 1;
			}
		}

		const base = preferredId.trim();
		if (!this.#jobs.has(base)) return base;

		let suffix = 2;
		let candidate = `${base}-${suffix}`;
		while (this.#jobs.has(candidate)) {
			suffix += 1;
			candidate = `${base}-${suffix}`;
		}
		return candidate;
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
		this.#jobs.delete(jobId);
		this.#lifecycles.delete(jobId);
		this.#lifecyclePhases.delete(jobId);
		this.#deadLetteredDeliveries.delete(jobId);
		this.#deadLetteredDeliveryOwners.delete(jobId);
		this.#suppressedDeliveries.delete(jobId);
		this.#watchedJobs.delete(jobId);
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
		if (!ownerId) return this.#deliveries.filter(delivery => !this.isDeliverySuppressed(delivery.jobId));
		return this.#deliveries.filter(
			delivery => delivery.ownerId === ownerId && !this.isDeliverySuppressed(delivery.jobId),
		);
	}

	#filterInFlightDeliveries(filter?: AsyncJobFilter): AsyncJobDelivery[] {
		const ownerId = filter?.ownerId;
		if (!ownerId) return this.#inFlightDeliveries.filter(delivery => !this.isDeliverySuppressed(delivery.jobId));
		return this.#inFlightDeliveries.filter(
			delivery => delivery.ownerId === ownerId && !this.isDeliverySuppressed(delivery.jobId),
		);
	}

	#isDeliveryFenced(delivery: AsyncJobDelivery): boolean {
		return Boolean(delivery.ownerId && this.#isOwnerSubagentShutdownFenced(delivery.ownerId));
	}

	#hasDeliverable(): boolean {
		return this.#deliveries.some(
			delivery => !this.isDeliverySuppressed(delivery.jobId) && !this.#isDeliveryFenced(delivery),
		);
	}

	async #deliverNextFiltered(filter: AsyncJobFilter, deadline: number): Promise<boolean> {
		while (true) {
			let selected: AsyncJobDelivery | undefined;
			for (const delivery of this.#deliveries) {
				if (delivery.ownerId !== filter.ownerId) continue;
				if (this.isDeliverySuppressed(delivery.jobId) || this.#isDeliveryFenced(delivery)) continue;
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
			if (this.isDeliverySuppressed(selected.jobId)) continue;

			return this.#waitForDeliveryPromise(this.#deliverDelivery(selected), deadline);
		}
	}

	#isDeliveryAcknowledged(jobId: string): boolean {
		return this.#suppressedDeliveries.has(jobId);
	}

	isDeliverySuppressed(jobId: string): boolean {
		return this.#isDeliveryAcknowledged(jobId) || this.#watchedJobs.has(jobId);
	}

	#pruneEvictedDeadLetters(): void {
		for (const jobId of this.#deadLetteredDeliveries.keys()) {
			if (this.#jobs.has(jobId)) continue;
			this.#deadLetteredDeliveries.delete(jobId);
			this.#deadLetteredDeliveryOwners.delete(jobId);
		}
	}

	#recordDeadLetter(delivery: AsyncJobDelivery): void {
		this.#pruneEvictedDeadLetters();
		if (!this.#jobs.has(delivery.jobId)) return;
		this.#deadLetteredDeliveries.delete(delivery.jobId);
		this.#deadLetteredDeliveryOwners.delete(delivery.jobId);
		this.#deadLetteredDeliveries.set(delivery.jobId, {
			jobId: delivery.jobId,
			attempt: delivery.attempt,
			lastError: delivery.lastError,
		});
		this.#deadLetteredDeliveryOwners.set(delivery.jobId, delivery.ownerId);
		while (this.#deadLetteredDeliveries.size > MAX_DEAD_LETTERED_DELIVERIES) {
			const oldestJobId = this.#deadLetteredDeliveries.keys().next().value;
			if (oldestJobId === undefined) return;
			this.#deadLetteredDeliveries.delete(oldestJobId);
			this.#deadLetteredDeliveryOwners.delete(oldestJobId);
		}
	}

	#enqueueDelivery(jobId: string, text: string): void {
		// Skip delivery if already acknowledged
		if (this.#isDeliveryAcknowledged(jobId)) {
			return;
		}
		const deliveryText = this.#boundedDeliveryText(text);
		this.#deliveries.push({
			jobId,
			text: deliveryText.text,
			originalBytes: deliveryText.originalBytes,
			truncated: deliveryText.truncated,
			attempt: 0,
			nextAttemptAt: Date.now(),
			ownerId: this.#jobs.get(jobId)?.ownerId,
		});
		while (this.#deliveries.length > DEFAULT_MAX_DELIVERY_QUEUE) {
			const dropped = this.#deliveries.shift();
			if (dropped) this.#recordDeadLetter(dropped);
		}
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
				candidate => !this.isDeliverySuppressed(candidate.jobId) && !this.#isDeliveryFenced(candidate),
			);
			if (!delivery) return;
			const waitMs = delivery.nextAttemptAt - Date.now();
			if (waitMs > 0) {
				await Bun.sleep(waitMs);
			}
			const index = this.#deliveries.indexOf(delivery);
			if (index === -1) continue;
			if (this.isDeliverySuppressed(delivery.jobId) || this.#isDeliveryFenced(delivery)) continue;

			this.#deliveries.splice(index, 1);
			await this.#deliverDelivery(delivery);
		}
	}

	#deliverDelivery(delivery: AsyncJobDelivery): Promise<void> {
		const promise = (async () => {
			this.#inFlightDeliveries.push(delivery);
			try {
				await this.#onJobComplete(delivery.jobId, delivery.text, this.#jobs.get(delivery.jobId));
			} catch (error) {
				delivery.attempt += 1;
				delivery.lastError = error instanceof Error ? error.message : String(error);
				if (delivery.attempt >= DELIVERY_MAX_ATTEMPTS) {
					this.#recordDeadLetter(delivery);
					logger.warn("Async job completion delivery reached retry cap", {
						jobId: delivery.jobId,
						attempt: delivery.attempt,
						error: delivery.lastError,
					});
				} else {
					delivery.nextAttemptAt = Date.now() + this.#getRetryDelay(delivery.attempt);
					if (!this.#isDeliveryAcknowledged(delivery.jobId)) {
						this.#deliveries.push(delivery);
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
