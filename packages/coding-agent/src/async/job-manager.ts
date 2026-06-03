import { logger } from "@gajae-code/utils";
import type { AgentSource } from "../task/types";

const DELIVERY_RETRY_BASE_MS = 500;
const DELIVERY_RETRY_MAX_MS = 30_000;
const DELIVERY_RETRY_JITTER_MS = 200;
const DEFAULT_RETENTION_MS = 5 * 60 * 1000;
const DEFAULT_MAX_RUNNING_JOBS = 15;

export interface AsyncJob {
	id: string;
	type: "bash" | "task";
	status: "running" | "completed" | "failed" | "cancelled" | "paused";
	startTime: number;
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

export interface AsyncJobMetadata {
	subagent?: {
		id: string;
		agent: string;
		agentSource: AgentSource;
		description?: string;
		assignment?: string;
	};
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

/**
 * Live, executor-owned control handle for a RUNNING subagent. Registered when a
 * subagent run starts and removed on pause/terminal so a paused subagent retains
 * no live `AgentSession` reference (leak-free).
 */
export interface SubagentLiveHandle {
	/** Request a cooperative safe-boundary pause (never aborts the in-flight tool). */
	requestPause(): void;
	/** Inject a steering message into the live session. */
	injectMessage(content: string, deliverAs: "steer" | "followUp" | "nextTurn"): Promise<void>;
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
}

/** Lightweight, manager-owned resume payload. The async layer treats `data` as opaque. */
export interface ResumeDescriptor {
	subagentId: string;
	ownerId?: string;
	data: unknown;
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

interface AsyncJobDelivery {
	jobId: string;
	text: string;
	attempt: number;
	nextAttemptAt: number;
	lastError?: string;
	ownerId?: string;
	promise?: Promise<void>;
}

export interface AsyncJobDeliveryState {
	queued: number;
	delivering: boolean;
	nextRetryAt?: number;
	pendingJobIds: string[];
}

export interface AsyncJobRegisterOptions {
	id?: string;
	/** Registry id of the agent that owns this job; used to scope cancelAll. */
	ownerId?: string;
	/** Structured metadata for tool-specific control surfaces. */
	metadata?: AsyncJobMetadata;
	onProgress?: (text: string, details?: Record<string, unknown>) => void | Promise<void>;
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
	readonly #outputRetentionBytes = DEFAULT_JOB_OUTPUT_RETENTION_BYTES;
	readonly #onJobComplete: AsyncJobManagerOptions["onJobComplete"];
	readonly #maxRunningJobs: number;
	readonly #retentionMs: number;
	#deliveryLoop: Promise<void> | undefined;
	#disposed = false;
	readonly #subagentRecords = new Map<string, SubagentRecord>();
	readonly #liveHandles = new Map<string, SubagentLiveHandle>();
	readonly #resumeQueue: ResumeQueueEntry[] = [];
	#resumeSeq = 0;
	#resumeRunner?: (subagentId: string, message?: string, descriptor?: ResumeDescriptor) => string | undefined;
	readonly #resumeDescriptors = new Map<string, ResumeDescriptor>();

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
		const runningCount = this.getRunningJobs().length;
		if (runningCount >= this.#maxRunningJobs) {
			throw new Error(
				`Background job limit reached (${this.#maxRunningJobs}). Wait for running jobs to finish or cancel one.`,
			);
		}

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
					if (outcome.note) job.resultText = outcome.note;
					this.#markRecordPaused(id);
					this.#drainResumeQueue();
					return;
				}
				job.status = "completed";
				job.resultText = outcome.text;
				this.#enqueueDelivery(id, outcome.text);
				this.#scheduleEviction(id);
				this.#markRecordTerminal(id, "completed");
				this.#drainResumeQueue();
			} catch (error) {
				if (job.status === "cancelled") {
					job.errorText = error instanceof Error ? error.message : String(error);
					this.#scheduleEviction(id);
					this.#markRecordTerminal(id, "cancelled");
					this.#drainResumeQueue();
					return;
				}
				const errorText = error instanceof Error ? error.message : String(error);
				job.status = "failed";
				job.errorText = errorText;
				this.#enqueueDelivery(id, errorText);
				this.#scheduleEviction(id);
				this.#markRecordTerminal(id, "failed");
				this.#drainResumeQueue();
			}
		})();

		this.#jobs.set(id, job);
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
			// Paused jobs have no running promise to abort; transition directly.
			// The session file is kept, so the record stays resumable by id.
			job.status = "cancelled";
			this.#markRecordTerminal(id, "cancelled");
			this.#scheduleEviction(id);
			this.#drainResumeQueue();
			return true;
		}
		if (job.status !== "running") return false;
		job.status = "cancelled";
		job.abortController.abort();
		this.#scheduleEviction(id);
		return true;
	}

	// ── Subagent control plane (pause / resume / steer support) ──────────

	/** Register or replace the canonical record for a subagent. */
	registerSubagentRecord(record: SubagentRecord): void {
		this.#subagentRecords.set(record.subagentId, record);
	}

	getSubagentRecord(subagentId: string, filter?: AsyncJobFilter): SubagentRecord | undefined {
		const rec = this.#subagentRecords.get(subagentId.trim());
		if (!rec) return undefined;
		if (filter?.ownerId && rec.ownerId !== filter.ownerId) return undefined;
		return rec;
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

	/** Install the TaskTool-owned resume runner. Returns the new job id, or undefined on failure. */
	setResumeRunner(
		runner: (subagentId: string, message?: string, descriptor?: ResumeDescriptor) => string | undefined,
	): void {
		this.#resumeRunner = runner;
	}

	registerResumeDescriptor(descriptor: ResumeDescriptor): void {
		this.#resumeDescriptors.set(descriptor.subagentId, descriptor);
	}

	getResumeDescriptor(subagentId: string, filter?: AsyncJobFilter): ResumeDescriptor | undefined {
		const descriptor = this.#resumeDescriptors.get(subagentId.trim());
		if (!descriptor) return undefined;
		if (filter?.ownerId && descriptor.ownerId !== filter.ownerId) return undefined;
		return descriptor;
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
		}
	}

	#markRecordTerminal(jobId: string, status: "completed" | "failed" | "cancelled"): void {
		const rec = this.#recordByJobId(jobId);
		if (!rec) return;
		rec.status = status;
		this.#liveHandles.delete(rec.subagentId);
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
		if (!this.#resumeRunner) return { ok: false, reason: "no_runner" };
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
		const prevJobId = rec.currentJobId;
		const newJobId = this.#resumeRunner?.(rec.subagentId, message, this.#resumeDescriptors.get(rec.subagentId));
		if (!newJobId) return { ok: false, reason: "resume_failed" };
		if (prevJobId && prevJobId !== newJobId) rec.historicalJobIds.push(prevJobId);
		rec.currentJobId = newJobId;
		rec.status = this.#jobs.get(newJobId)?.status ?? "running";
		rec.queued = undefined;
		return { ok: true, status: rec.status, jobId: newJobId };
	}

	/** Drain queued resumes (FIFO by seq) while concurrency slots are available. */
	#drainResumeQueue(): void {
		if (this.#resumeQueue.length === 0) return;
		this.#resumeQueue.sort((a, b) => a.seq - b.seq);
		while (this.#resumeQueue.length > 0 && this.getRunningJobs().length < this.#maxRunningJobs) {
			const entry = this.#resumeQueue.shift();
			if (!entry) return;
			const rec = this.#subagentRecords.get(entry.subagentId);
			if (rec?.status !== "queued") continue;
			this.#startResume(rec, entry.message);
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
			this.#drainResumeQueue();
			return true;
		}
		if (rec.status === "queued") {
			const idx = this.#resumeQueue.findIndex(e => e.subagentId === rec.subagentId);
			if (idx !== -1) this.#resumeQueue.splice(idx, 1);
			rec.status = "cancelled";
			rec.queued = undefined;
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
				this.#subagentRecords.delete(sid);
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

	/**
	 * Run and clear every registered cleanup for the given filter. Idempotent
	 * and error-isolated: a throwing cleanup does not prevent siblings from
	 * running and never escalates to the caller.
	 */
	runOwnerCleanups(filter?: AsyncJobFilter): void {
		const ownerId = filter?.ownerId;
		const targets: Array<[string, Set<() => void>]> = [];
		if (ownerId) {
			const bag = this.#ownerCleanups.get(ownerId);
			if (bag) targets.push([ownerId, bag]);
		} else {
			for (const entry of this.#ownerCleanups.entries()) targets.push(entry);
		}
		for (const [id, bag] of targets) {
			const callbacks = Array.from(bag);
			bag.clear();
			this.#ownerCleanups.delete(id);
			for (const cleanup of callbacks) {
				try {
					cleanup();
				} catch (error) {
					logger.warn("Async job owner cleanup failed", {
						ownerId: id,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
		}
		this.#purgeOwnerSubagentState(ownerId);
	}

	getDeliveryState(filter?: AsyncJobFilter): AsyncJobDeliveryState {
		const deliveries = this.#filterDeliveries(filter);
		const inFlightDeliveries = this.#filterInFlightDeliveries(filter);
		const nextRetryAt = deliveries.reduce<number | undefined>((next, delivery) => {
			if (next === undefined) return delivery.nextAttemptAt;
			return Math.min(next, delivery.nextAttemptAt);
		}, undefined);

		return {
			queued: deliveries.length + inFlightDeliveries.length,
			delivering: inFlightDeliveries.length > 0 || (this.#deliveryLoop !== undefined && deliveries.length > 0),
			nextRetryAt,
			pendingJobIds: deliveries.concat(inFlightDeliveries).map(delivery => delivery.jobId),
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
			...this.#deliveries.filter(delivery => !this.isDeliverySuppressed(delivery.jobId)),
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
			job.status = "cancelled";
			job.abortController.abort();
			this.#scheduleEviction(job.id);
		}
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
		await this.waitForAll();
		const drained = await this.drainDeliveries({ timeoutMs: options?.timeoutMs ?? 3_000 });
		this.#clearEvictionTimers();
		this.#jobs.clear();
		this.#deliveries.length = 0;
		this.#inFlightDeliveries.length = 0;
		this.#suppressedDeliveries.clear();
		this.#watchedJobs.clear();
		this.#outputState.clear();
		this.#ownerCleanups.clear();
		this.#subagentRecords.clear();
		this.#liveHandles.clear();
		this.#resumeDescriptors.clear();
		this.#resumeQueue.length = 0;
		return drained;
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
		if (this.#retentionMs <= 0) {
			this.#jobs.delete(jobId);
			this.#suppressedDeliveries.delete(jobId);
			this.#watchedJobs.delete(jobId);
			this.#outputState.delete(jobId);
			return;
		}
		const existing = this.#evictionTimers.get(jobId);
		if (existing) {
			clearTimeout(existing);
		}
		const timer = setTimeout(() => {
			this.#evictionTimers.delete(jobId);
			this.#jobs.delete(jobId);
			this.#suppressedDeliveries.delete(jobId);
			this.#watchedJobs.delete(jobId);
			this.#outputState.delete(jobId);
		}, this.#retentionMs);
		timer.unref();
		this.#evictionTimers.set(jobId, timer);
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

	async #deliverNextFiltered(filter: AsyncJobFilter, deadline: number): Promise<boolean> {
		while (true) {
			let selected: AsyncJobDelivery | undefined;
			for (const delivery of this.#deliveries) {
				if (delivery.ownerId !== filter.ownerId) continue;
				if (this.isDeliverySuppressed(delivery.jobId)) continue;
				if (!selected || delivery.nextAttemptAt < selected.nextAttemptAt) {
					selected = delivery;
				}
			}

			if (!selected) {
				const inFlight = this.#filterInFlightDeliveries(filter);
				if (inFlight.length === 0) return true;
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

	isDeliverySuppressed(jobId: string): boolean {
		return this.#suppressedDeliveries.has(jobId) || this.#watchedJobs.has(jobId);
	}

	#enqueueDelivery(jobId: string, text: string): void {
		// Skip delivery if already acknowledged
		if (this.isDeliverySuppressed(jobId)) {
			return;
		}
		this.#deliveries.push({
			jobId,
			text,
			attempt: 0,
			nextAttemptAt: Date.now(),
			ownerId: this.#jobs.get(jobId)?.ownerId,
		});
		this.#ensureDeliveryLoop();
	}

	#ensureDeliveryLoop(): void {
		if (this.#deliveryLoop) {
			return;
		}

		this.#deliveryLoop = this.#runDeliveryLoop()
			.catch(error => {
				logger.error("Async job delivery loop crashed", { error: String(error) });
			})
			.finally(() => {
				this.#deliveryLoop = undefined;
				if (this.#deliveries.length > 0) {
					this.#ensureDeliveryLoop();
				}
			});
	}

	async #runDeliveryLoop(): Promise<void> {
		while (this.#deliveries.length > 0) {
			const delivery = this.#deliveries[0];
			if (this.isDeliverySuppressed(delivery.jobId)) {
				this.#deliveries.shift();
				continue;
			}
			const waitMs = delivery.nextAttemptAt - Date.now();
			if (waitMs > 0) {
				await Bun.sleep(waitMs);
			}
			if (this.#deliveries[0] !== delivery) {
				continue;
			}
			if (this.isDeliverySuppressed(delivery.jobId)) {
				this.#deliveries.shift();
				continue;
			}

			this.#deliveries.shift();
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
				delivery.nextAttemptAt = Date.now() + this.#getRetryDelay(delivery.attempt);
				if (!this.isDeliverySuppressed(delivery.jobId)) {
					this.#deliveries.push(delivery);
				}
				logger.warn("Async job completion delivery failed", {
					jobId: delivery.jobId,
					attempt: delivery.attempt,
					nextRetryAt: delivery.nextAttemptAt,
					error: delivery.lastError,
				});
			} finally {
				const index = this.#inFlightDeliveries.indexOf(delivery);
				if (index !== -1) this.#inFlightDeliveries.splice(index, 1);
				if (this.#deliveries.length > 0) this.#ensureDeliveryLoop();
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
