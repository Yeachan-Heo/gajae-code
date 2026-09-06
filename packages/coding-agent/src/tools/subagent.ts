import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@gajae-code/agent-core";
import { formatDuration, logger, prompt } from "@gajae-code/utils";
import * as z from "zod/v4";
import { type AsyncJob, AsyncJobManager, jobElapsedMs, type SubagentRecord } from "../async";
import subagentDescription from "../prompts/tools/subagent.md" with { type: "text" };
import type { AgentProgress, AgentSource, LocalErrorSummary } from "../task/types";
import { Ellipsis, truncateToWidth } from "../tui";
import type { ToolSession } from "./index";
import { replaceTabs } from "./render-utils";
import { ToolError } from "./tool-errors";

const DEFAULT_AWAIT_TIMEOUT_MS = 30_000;
const MAX_AWAIT_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_AWAIT_HEARTBEAT_MS = 60_000;
/**
 * Bounded cadence for await liveness: even when the rendered-state signature is
 * stable (a running subagent emitting no new progress), the await panel re-emits
 * so a healthy wait never looks like a hung session (issue #4465). Derived from
 * `heartbeat_ms` so callers keep one knob, floor-bounded so a small heartbeat
 * cannot turn liveness into transcript spam, and injected for tests.
 */
const AWAIT_LIVENESS_MULTIPLIER = 30;
const AWAIT_LIVENESS_MIN_INTERVAL_MS = 15_000;
const DEFAULT_LIST_LIMIT = 10;
const MAX_LIST_LIMIT = 50;
const RECEIPT_PREVIEW_WIDTH = 280;
const PREVIEW_WIDTH = 2_000;
const FULL_PREVIEW_WIDTH = 12_000;
const RECEIPT_PREVIEW_BYTES = 1_024;
const PREVIEW_BYTES = 8_192;
const FULL_PREVIEW_BYTES = 49_152;

const STEER_QUEUED_GUIDANCE =
	"The steer message is queued for the subagent's next steering boundary and has not necessarily taken effect yet.";

const subagentSchema = z.object({
	action: z
		.enum(["list", "inspect", "await", "cancel", "pause", "resume", "steer"])
		.describe("subagent control action"),
	ids: z.array(z.string()).optional().describe("subagent ids or backing job ids"),
	id: z.string().optional().describe("single subagent id or backing job id for resume/steer"),
	message: z.string().optional().describe("message to deliver when resuming or steering a subagent"),
	pause: z.boolean().optional().describe("pause after steering a currently running subagent"),
	condition: z
		.enum(["all_terminal", "any_terminal"])
		.optional()
		.describe("terminal wait condition; defaults to all_terminal"),
	heartbeat_ms: z
		.number()
		.refine(value => value === 0 || (Number.isInteger(value) && value >= 100 && value <= MAX_AWAIT_HEARTBEAT_MS))
		.optional()
		.describe(`heartbeat interval in milliseconds (100-${MAX_AWAIT_HEARTBEAT_MS}); 0 disables`),
	timeout_ms: z.number().min(0).max(MAX_AWAIT_TIMEOUT_MS).optional().describe("await timeout in milliseconds"),
	limit: z.number().min(1).max(MAX_LIST_LIMIT).optional().describe("maximum subagents to return"),
	verbosity: z
		.enum(["receipt", "preview", "full"])
		.optional()
		.describe(
			"output verbosity: receipt (default, <=280-char receipt preview), preview (<=2000 chars), or full (<=12000 chars; requires explicit ids)",
		),
});

type SubagentParams = z.infer<typeof subagentSchema>;
type SubagentStatus =
	| "running"
	| "paused"
	| "queued"
	| "completed"
	| "failed"
	| "cancelled"
	| "not_found"
	| "already_completed";

export interface SubagentSnapshot {
	id: string;
	jobId: string;
	status: SubagentStatus;
	label: string;
	agent: string;
	agentSource: AgentSource;
	description?: string;
	assignment?: string;
	durationMs: number;
	resultText?: string;
	errorText?: string;
	/** Safe setup failure cause retained from the executor launch path. */
	setupFailureSummary?: string;
	/** Safe, bounded summary of a terminal local (non-provider) failure (e.g. local_buffer_overflow). */
	localErrorSummary?: LocalErrorSummary;
	resultPreview?: string;
	outputRef?: string;
	truncated?: boolean;
	guidance?: string;
	steerMessage?: string;
	steerState?: "queued" | "resume_queued" | "resume_started";
	steerPauseRequested?: boolean;
	/** Bounded live progress approved for the await panel and public tool details. */
	progress?: SubagentLiveProgress;
	/** True when a live in-session progress producer exists for this subagent. */
	liveProgressAvailable?: boolean;
	/** Model the subagent actually runs on (after any auth fallback). */
	effectiveModel?: string;
	/** Model originally requested via role/preset mapping; differs from effective on fallback. */
	requestedModel?: string;
	/** True when the requested model lacked credentials and fell back to the parent model. */
	modelFellBack?: boolean;
	/** True when the effective subagent provider is in fast mode. */
	fastMode?: boolean;
}

/**
 * Public await-panel progress. This is deliberately not `AgentProgress`: raw
 * progress contains model deltas, tool arguments, arbitrary output, and nested
 * task payloads that must never enter tool-result, ACP, or telemetry envelopes.
 */
export interface SubagentLiveProgress {
	id: string;
	status: AgentProgress["status"];
	currentTool?: string;
	recentTool?: string;
	recentOutputSummary?: { lineCount: number };
	fastMode?: boolean;
	retryState?: {
		attempt: number;
		maxAttempts: number;
		unbounded?: boolean;
		kind: NonNullable<AgentProgress["retryState"]>["kind"];
		provider?: string;
		lastProviderProgressAtMs?: number;
		delayMs: number;
		startedAtMs: number;
	};
	retryFailure?: { attempt: number };
}

function toSubagentLiveProgress(progress: AgentProgress): SubagentLiveProgress {
	return {
		id: progress.id,
		status: progress.status,
		...(progress.currentTool ? { currentTool: progress.currentTool } : {}),
		...(progress.currentTool === undefined && progress.recentTools[0]
			? { recentTool: progress.recentTools[0].tool }
			: {}),
		...(progress.recentOutput.length > 0
			? { recentOutputSummary: { lineCount: Math.min(progress.recentOutput.length, 6) } }
			: {}),
		...(progress.fastMode ? { fastMode: true } : {}),
		...(progress.retryState
			? {
					retryState: {
						attempt: progress.retryState.attempt,
						maxAttempts: progress.retryState.maxAttempts,
						...(progress.retryState.unbounded ? { unbounded: true } : {}),
						kind: progress.retryState.kind,
						...(progress.retryState.provider ? { provider: progress.retryState.provider } : {}),
						...(progress.retryState.lastProviderProgressAtMs !== undefined
							? { lastProviderProgressAtMs: progress.retryState.lastProviderProgressAtMs }
							: {}),
						delayMs: progress.retryState.delayMs,
						startedAtMs: progress.retryState.startedAtMs,
					},
				}
			: {}),
		...(progress.retryFailure ? { retryFailure: { attempt: progress.retryFailure.attempt } } : {}),
	};
}

export type SubagentAwaitOutcome = "completed" | "timed_out" | "interrupted";

const AWAIT_INTERRUPTED_GUIDANCE =
	"Await interrupted; this subagent continues. Inspect its current state or cancel it only when necessary.";

export interface SubagentToolDetails {
	subagents: SubagentSnapshot[];
	/** Await outcome for a live await receipt; omitted when no wait was started. */
	awaitOutcome?: SubagentAwaitOutcome;
	waitOutcome?: "completed" | "timed_out_wait" | "interrupted";
	condition?: "all_terminal" | "any_terminal";
	heartbeatMs?: number;
	terminalIds?: string[];
	acknowledgedTerminalIds?: string[];
	/** True only when the parent await was interrupted; the child was not cancelled. */
	interrupted?: true;
}

export class SubagentTool implements AgentTool<typeof subagentSchema, SubagentToolDetails> {
	readonly name = "subagent";
	readonly label = "Subagent";
	readonly summary = "Manage detached task subagents";
	readonly description: string;
	readonly parameters = subagentSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	/**
	 * Injected monotonic clock for await-liveness tests. Production callers leave
	 * this undefined and the await falls back to `Date.now`; tests substitute a
	 * virtual clock so a 15s+ liveness interval is exercised without any real
	 * multi-minute sleep (#4465).
	 */
	#livenessNowMs?: () => number;

	/** Test-only seam: substitute the liveness clock. Returns a restore function. */
	withLivenessClock(nowMs: () => number): () => void {
		const prior = this.#livenessNowMs;
		this.#livenessNowMs = nowMs;
		return () => {
			this.#livenessNowMs = prior;
		};
	}

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(subagentDescription);
	}

	async execute(
		_toolCallId: string,
		params: SubagentParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<SubagentToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<SubagentToolDetails>> {
		// The session's ENDPOINT-owned manager first: concurrent top-level
		// sessions register their manager under their endpoint (sdk/session.ts),
		// so list/pause/resume/message/cancel/await must inspect THIS session's
		// manager — the process-global instance belongs to the last-created
		// session, where this session's subagent records and jobs are absent
		// or belong to a same-id subagent of another session (review thread P1).
		const manager =
			this.session.getAsyncJobManager?.() ??
			AsyncJobManager.forEndpoint(
				this.session.getAsyncEndpointId?.() ?? this.session.getSessionId?.() ?? undefined,
			) ??
			AsyncJobManager.instance();
		if (!manager) {
			return {
				content: [{ type: "text", text: "No subagent manager is available in this session." }],
				details: { subagents: [] },
			};
		}

		const ownerId = this.session.getAgentId?.() ?? undefined;
		const ownerFilter = ownerId ? { ownerId } : undefined;
		const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(params.limit ?? DEFAULT_LIST_LIMIT)));
		const verbosity = params.verbosity ?? "receipt";
		if (verbosity === "full" && (params.action === "list" || !params.ids?.length)) {
			throw new ToolError(
				"`verbosity=full` cannot be used with `list` and requires explicit `ids` so broad inspection cannot inline retained subagent output.",
			);
		}

		if (params.action === "list") {
			const records = this.#listSubagentRecords(manager, ownerFilter, limit);
			return await this.#buildRecordResult(manager, records, { title: "Subagents", verbosity });
		}

		if (params.action === "inspect") {
			const records = params.ids?.length
				? this.#visibleRecordsByIds(manager, params.ids, ownerFilter)
				: this.#runningRecords(manager, ownerFilter);
			return await this.#buildRecordResult(manager, records, {
				title: "Subagent inspection",
				notFoundIds: this.#notFoundRecordIds(manager, params.ids ?? [], ownerFilter),
				verbosity,
			});
		}

		if (params.action === "cancel") {
			const ids = params.ids ?? [];
			if (ids.length === 0) {
				throw new ToolError("`cancel` requires at least one subagent id.");
			}
			const records: SubagentRecord[] = [];
			const missing: SubagentSnapshot[] = [];
			for (const id of ids) {
				const record = this.#findVisibleRecord(manager, id, ownerFilter);
				if (!record) {
					missing.push(this.#missingSnapshot(id, "not_found", "No visible detached subagent matches this id."));
					continue;
				}
				const cancelled = manager.cancelSubagent(record.subagentId, ownerFilter);
				if (!cancelled && record.currentJobId) manager.cancel(record.currentJobId, ownerFilter);
				records.push(this.#findVisibleRecord(manager, id, ownerFilter) ?? record);
			}
			const verifiedOutputIds = await this.#verifiedOutputIds(records);
			return this.#buildSnapshotResult(
				[
					...records.map(record => this.#recordSnapshot(manager, record, false, verbosity, verifiedOutputIds)),
					...missing,
				],
				"Subagent cancellation",
			);
		}

		if (params.action === "pause") {
			const ids = params.ids ?? [];
			if (ids.length === 0) {
				throw new ToolError("`pause` requires at least one subagent id.");
			}
			const records: SubagentRecord[] = [];
			const missing: SubagentSnapshot[] = [];
			for (const id of ids) {
				const record = this.#findVisibleRecord(manager, id, ownerFilter);
				if (!record) {
					missing.push(this.#missingSnapshot(id, "not_found", "No visible detached subagent matches this id."));
					continue;
				}
				const result = manager.pauseSubagent(record.subagentId, ownerFilter);
				if (!result.ok && result.reason === "not_found") {
					missing.push(this.#missingSnapshot(id, "not_found", "No visible detached subagent matches this id."));
					continue;
				}
				records.push(manager.getSubagentRecord(record.subagentId, ownerFilter) ?? record);
			}
			const verifiedOutputIds = await this.#verifiedOutputIds(records);
			return this.#buildSnapshotResult(
				[
					...records.map(record => this.#recordSnapshot(manager, record, false, verbosity, verifiedOutputIds)),
					...missing,
				],
				"Subagent pause",
			);
		}

		if (params.action === "resume") {
			const id = this.#singleTargetId(params, "resume");
			const records: SubagentRecord[] = [];
			const missing: SubagentSnapshot[] = [];
			const terminalGuidanceIds = new Set<string>();
			const record = this.#findVisibleRecord(manager, id, ownerFilter);
			const verifiedOutputIds = await this.#verifiedOutputIds(record ? [record] : []);
			if (!record) {
				missing.push(this.#missingSnapshot(id, "not_found", "No visible detached subagent matches this id."));
			} else if (record.status === "running") {
				records.push(record);
			} else if (params.message === undefined && isTerminalStatus(record.status)) {
				records.push(record);
				terminalGuidanceIds.add(record.subagentId);
			} else {
				const result = manager.resumeSubagent(record.subagentId, ownerFilter, params.message, _toolCallId);
				if (!result.ok && result.reason === "context_unavailable") throw new ToolError("context unavailable");
				if (!result.ok && result.reason === "not_found") {
					missing.push(this.#missingSnapshot(id, "not_found", "No visible detached subagent matches this id."));
				} else if (!result.ok) {
					throw new ToolError(`Failed to resume subagent ${record.subagentId}: ${result.reason ?? "unknown"}.`);
				} else {
					records.push(manager.getSubagentRecord(record.subagentId, ownerFilter) ?? record);
				}
			}

			return this.#buildSnapshotResult(
				[
					...records.map(record => {
						const snapshot = this.#recordSnapshot(manager, record, false, verbosity, verifiedOutputIds);
						return terminalGuidanceIds.has(record.subagentId)
							? {
									...snapshot,
									guidance:
										"This subagent is terminal. Provide `message` to start a follow-up resume run from its saved context.",
								}
							: snapshot;
					}),
					...missing,
				],
				"Subagent resume",
			);
		}

		if (params.action === "steer") {
			const id = this.#singleTargetId(params, "steer");
			const message = params.message;
			if (message === undefined || message.trim() === "") {
				throw new ToolError("`steer` requires a non-empty message.");
			}
			const records: SubagentRecord[] = [];
			const missing: SubagentSnapshot[] = [];
			const steerStates = new Map<string, NonNullable<SubagentSnapshot["steerState"]>>();
			const record = this.#findVisibleRecord(manager, id, ownerFilter);
			const verifiedOutputIds = await this.#verifiedOutputIds(record ? [record] : []);
			if (!record) {
				missing.push(this.#missingSnapshot(id, "not_found", "No visible detached subagent matches this id."));
			} else {
				if (record.status === "running") {
					const handle = manager.getLiveHandle(record.subagentId);
					if (!handle) throw new ToolError(`Subagent ${record.subagentId} has no live handle.`);
					const fromAgentId = this.session.getAgentId?.() ?? undefined;
					await handle.injectMessage(message, "steer", { fromAgentId });
					if (params.pause === true) manager.pauseSubagent(record.subagentId, ownerFilter);
					records.push(manager.getSubagentRecord(record.subagentId, ownerFilter) ?? record);
					steerStates.set(record.subagentId, "queued");
				} else {
					const result = manager.resumeSubagent(record.subagentId, ownerFilter, message, _toolCallId);
					if (!result.ok && result.reason === "not_found") {
						missing.push(this.#missingSnapshot(id, "not_found", "No visible detached subagent matches this id."));
					} else if (!result.ok) {
						throw new ToolError(`Failed to resume subagent ${record.subagentId}: ${result.reason ?? "unknown"}.`);
					} else {
						const snapshotRecord = manager.getSubagentRecord(record.subagentId, ownerFilter) ?? record;
						records.push(snapshotRecord);
						steerStates.set(
							snapshotRecord.subagentId,
							result.queued === true || result.status === "queued" ? "resume_queued" : "resume_started",
						);
					}
				}
			}
			return this.#buildSnapshotResult(
				[
					...records.map(record => {
						const snapshot = this.#recordSnapshot(manager, record, false, verbosity, verifiedOutputIds);
						return {
							...snapshot,
							steerMessage: message,
							steerState: steerStates.get(record.subagentId) ?? "queued",
							steerPauseRequested: params.pause === true,
							guidance: snapshot.guidance
								? `${snapshot.guidance} ${STEER_QUEUED_GUIDANCE}`
								: STEER_QUEUED_GUIDANCE,
						};
					}),
					...missing,
				],
				"Subagent steer",
			);
		}

		return this.#awaitSubagents(manager, params, ownerFilter, signal, onUpdate);
	}

	#singleTargetId(params: SubagentParams, action: "resume" | "steer"): string {
		const id = params.id?.trim();
		const ids = (params.ids ?? []).map(value => value.trim()).filter(value => value.length > 0);
		if (id && ids.length > 0) {
			if (ids.length === 1 && ids[0] === id) return id;
			throw new ToolError(
				`\`${action}\` accepts exactly one target; provide \`id\` or a single-item \`ids\`, not both.`,
			);
		}
		if (id) return id;
		if (ids.length === 1) return ids[0]!;
		if (ids.length > 1) {
			throw new ToolError(
				`\`${action}\` accepts exactly one target because \`message\` can be queued for only one subagent.`,
			);
		}
		throw new ToolError(`\`${action}\` requires a single subagent id via \`id\`.`);
	}

	async #awaitSubagents(
		manager: AsyncJobManager,
		params: SubagentParams,
		ownerFilter: { ownerId: string } | undefined,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<SubagentToolDetails> | undefined,
	): Promise<AgentToolResult<SubagentToolDetails>> {
		const ids = params.ids
			?.map(id => id.trim())
			.filter(Boolean)
			.filter((id, index, all) => all.indexOf(id) === index);
		const records = ids?.length
			? this.#visibleRecordsByIds(manager, ids, ownerFilter)
			: this.#runningRecords(manager, ownerFilter);
		const notFoundIds = (ids ?? []).filter(id => !this.#findVisibleRecord(manager, id, ownerFilter));
		if (records.length === 0)
			return this.#buildSnapshotResult(
				notFoundIds.map(id =>
					this.#missingSnapshot(id, "not_found", "No visible detached subagent matches this id."),
				),
				"Subagent await",
			);
		const targets = records
			.map(record => manager.resolveSubagentWaitTarget(record.subagentId, ownerFilter))
			.filter((target): target is NonNullable<typeof target> => target !== undefined);
		if (targets.length === 0) return this.#buildSnapshotResult([], "Subagent await");
		const condition = params.condition ?? "all_terminal";
		const handle = manager.subscribeTerminalWait(targets, condition);
		const timeoutMs = Math.min(
			MAX_AWAIT_TIMEOUT_MS,
			Math.max(0, Math.floor(params.timeout_ms ?? DEFAULT_AWAIT_TIMEOUT_MS)),
		);
		const targetsAlreadyTerminal = targets.every(
			target =>
				target.initialStatus === "completed" ||
				target.initialStatus === "failed" ||
				target.initialStatus === "cancelled",
		);
		if (targetsAlreadyTerminal) {
			const waitResult = await handle.result;
			handle.acknowledge(waitResult.terminalJobIds);
			handle.close();
			const terminalJobIds = waitResult.terminalJobIds;
			return await this.#buildRecordResult(manager, records, {
				title: "Subagent await",
				verbosity: params.verbosity ?? "receipt",
				waitOutcome: "completed",
				condition,
				terminalIds: terminalJobIds,
			});
		}
		const watchedJobIds = targets.map(target => target.jobId).filter((jobId): jobId is string => jobId !== null);
		const watchHandle = manager.watchJobGenerations(watchedJobIds);
		const heartbeatMs = params.heartbeat_ms === undefined ? 500 : params.heartbeat_ms;
		// Liveness interval: force a re-emit even when the rendered-state signature
		// is stable so a healthy wait never looks like a hung session (#4465). The
		// `#livenessNowMs` clock is injected for deterministic tests; `Date.now`
		// is the production fallback. The interval is floor-bounded so a caller who
		// sets a tiny `heartbeat_ms` cannot turn liveness into transcript spam.
		const livenessIntervalMs = Math.max(AWAIT_LIVENESS_MIN_INTERVAL_MS, heartbeatMs * AWAIT_LIVENESS_MULTIPLIER);
		const nowMs = this.#livenessNowMs ?? Date.now;
		let lastEmitMs = nowMs();
		let lastEmittedSignature: string | undefined;
		let streamingDisabled = false;
		let stopProgressTimer = (): void => {};
		const disableStreaming = (error: unknown): void => {
			if (streamingDisabled) return;
			streamingDisabled = true;
			stopProgressTimer();
			try {
				logger.warn("Subagent await progress update failed; streaming disabled for this wait", {
					error: safeThrownValue(error),
				});
			} catch {
				// Diagnostics must never turn a recoverable progress-channel failure
				// into an await or process-lifecycle failure.
			}
		};
		const emitIfChanged = (force: boolean): void => {
			if (!onUpdate || streamingDisabled) return;
			try {
				const result = this.#progressResult(manager, records, true);
				const signature = subagentAwaitRenderedStateSignature(result.details?.subagents ?? []);
				const t = nowMs();
				const livenessDue = force || t - lastEmitMs >= livenessIntervalMs;
				if (!livenessDue && signature === lastEmittedSignature) return;
				lastEmittedSignature = signature;
				lastEmitMs = t;
				// A TypeScript void-return callback may still be implemented by an
				// async function. Observe its runtime result so a rejected promise or
				// thenable cannot become an unhandled rejection outside this span.
				const updateResult = (onUpdate as (update: AgentToolResult<SubagentToolDetails>) => unknown)(result);
				if (isPromiseLike(updateResult)) void Promise.resolve(updateResult).catch(disableStreaming);
			} catch (error) {
				// The liveness timer fires outside this function's promise chain, so a
				// throwing progress consumer would otherwise escape `setInterval` as an
				// uncaught exception, leave the wait's cleanup unreached, and let the
				// interval keep firing and rethrowing for the rest of the await. Retire
				// the streaming channel instead and keep waiting: losing progress output
				// is recoverable, losing the timer and the watch registration is not.
				disableStreaming(error);
			}
		};
		// The initial emission and the timer own process-lifetime resources together
		// with the watch registration and the terminal-wait handle, so they all live
		// inside one guarded span rather than straddling it.
		let progressTimer: Timer | undefined;
		let waitOutcome: "completed" | "timed_out_wait" | "interrupted";
		let onAbort: (() => void) | undefined;
		let terminalJobIds: string[] | undefined;
		const steeringWaitAbort = new AbortController();
		try {
			progressTimer = onUpdate && heartbeatMs > 0 ? setInterval(() => emitIfChanged(false), heartbeatMs) : undefined;
			stopProgressTimer = () => {
				if (progressTimer) clearInterval(progressTimer);
				progressTimer = undefined;
			};
			emitIfChanged(true);
			const abortPromise = new Promise<"interrupted">(resolve => {
				onAbort = () => resolve("interrupted");
				if (signal?.aborted) onAbort();
				else signal?.addEventListener("abort", onAbort, { once: true });
			});
			// A busy user message must not sit behind this observation window: end
			// the wait as interrupted so the parent's tool boundary handles the
			// steer next, while the awaited children keep running.
			const steeringArrival = this.session.waitForUserSteering
				? [this.session.waitForUserSteering(steeringWaitAbort.signal).then(() => "interrupted" as const)]
				: [];
			waitOutcome =
				targetsAlreadyTerminal && !signal?.aborted
					? "completed"
					: await Promise.race([
							handle.result.then(() => "completed" as const),
							Bun.sleep(timeoutMs).then(() => "timed_out_wait" as const),
							abortPromise,
							...steeringArrival,
						]);
			if (waitOutcome === "completed") {
				terminalJobIds = (await handle.result).terminalJobIds;
				handle.acknowledge(terminalJobIds);
			}
		} finally {
			steeringWaitAbort.abort();
			if (signal && onAbort) signal.removeEventListener("abort", onAbort);
			stopProgressTimer();
			watchHandle.close();
			handle.close();
		}
		const awaitOutcome: SubagentAwaitOutcome =
			waitOutcome === "completed" ? "completed" : waitOutcome === "timed_out_wait" ? "timed_out" : "interrupted";
		const finalRecords = this.#visibleRecordsByIds(
			manager,
			records.map(record => record.subagentId),
			ownerFilter,
		);
		return await this.#buildRecordResult(manager, finalRecords, {
			title: waitOutcome === "interrupted" ? "Subagent await interrupted" : "Subagent await",
			notFoundIds,
			timedOut: waitOutcome === "timed_out_wait",
			verbosity: params.verbosity ?? "receipt",
			attachLiveProgress: true,
			awaitOutcome,
			waitOutcome,
			condition,
			terminalIds: terminalJobIds,
		});
	}

	#mergedRecords(
		manager: AsyncJobManager,
		ownerFilter: { ownerId: string } | undefined,
		limit: number,
	): SubagentRecord[] {
		const merged = [...manager.getSubagentRecords(ownerFilter)];
		const known = new Set(merged.map(record => record.subagentId));
		const jobs = [...manager.getRunningJobs(ownerFilter), ...manager.getRecentJobs(limit, ownerFilter)].filter(
			isSubagentJob,
		);
		for (const job of jobs) {
			const subagentId = job.metadata?.subagent?.id ?? job.id;
			if (known.has(subagentId)) continue;
			known.add(subagentId);
			merged.push(this.#jobToRecord(job));
		}
		merged.sort((a, b) => {
			const aJob = a.currentJobId ? manager.getJob(a.currentJobId) : undefined;
			const bJob = b.currentJobId ? manager.getJob(b.currentJobId) : undefined;
			return (bJob?.startTime ?? 0) - (aJob?.startTime ?? 0);
		});
		return merged.slice(0, limit);
	}

	#listSubagentRecords(
		manager: AsyncJobManager,
		ownerFilter: { ownerId: string } | undefined,
		limit: number,
	): SubagentRecord[] {
		return this.#mergedRecords(manager, ownerFilter, limit);
	}

	#runningRecords(manager: AsyncJobManager, ownerFilter: { ownerId: string } | undefined): SubagentRecord[] {
		return this.#mergedRecords(manager, ownerFilter, MAX_LIST_LIMIT).filter(record => record.status === "running");
	}

	/** Synthesize a record from a subagent job that has no registered SubagentRecord (backward compat). */
	#jobToRecord(job: AsyncJob): SubagentRecord {
		return {
			subagentId: job.metadata?.subagent?.id ?? job.id,
			ownerId: job.ownerId,
			currentJobId: job.id,
			historicalJobIds: [],
			status: job.status,
			sessionFile: null,
			resumable: false,
		};
	}

	#findSubagentJob(manager: AsyncJobManager, id: string, ownerId: string | undefined): AsyncJob | undefined {
		const direct = manager.getJob(id);
		if (direct && isSubagentJob(direct) && (!ownerId || direct.ownerId === ownerId)) return direct;
		return manager
			.getAllJobs(ownerId ? { ownerId } : undefined)
			.filter(job => isSubagentJob(job) && job.metadata?.subagent?.id === id)
			.sort((a, b) => b.startTime - a.startTime)[0];
	}

	#visibleRecordsByIds(
		manager: AsyncJobManager,
		ids: string[],
		ownerFilter: { ownerId: string } | undefined,
	): SubagentRecord[] {
		const records: SubagentRecord[] = [];
		const seen = new Set<string>();
		for (const id of ids) {
			const record = this.#findVisibleRecord(manager, id, ownerFilter);
			if (!record || seen.has(record.subagentId)) continue;
			seen.add(record.subagentId);
			records.push(record);
		}
		return records;
	}

	#findVisibleRecord(
		manager: AsyncJobManager,
		id: string,
		ownerFilter: { ownerId: string } | undefined,
	): SubagentRecord | undefined {
		const trimmedId = id.trim();
		if (!trimmedId) return undefined;
		const direct = manager.getSubagentRecord(trimmedId, ownerFilter);
		if (direct) return direct;
		const byJobId = manager.getSubagentRecords(ownerFilter).find(record => record.currentJobId === trimmedId);
		if (byJobId) return byJobId;
		const job = this.#findSubagentJob(manager, trimmedId, ownerFilter?.ownerId);
		return job ? this.#jobToRecord(job) : undefined;
	}

	#notFoundRecordIds(manager: AsyncJobManager, ids: string[], ownerFilter: { ownerId: string } | undefined): string[] {
		return ids.filter(id => !this.#findVisibleRecord(manager, id, ownerFilter));
	}

	#progressResult(
		manager: AsyncJobManager,
		records: SubagentRecord[],
		attachLiveProgress = false,
	): AgentToolResult<SubagentToolDetails> {
		const subagents = this.#recordSnapshots(manager, records, false, "receipt", new Set(), attachLiveProgress);
		return {
			content: [{ type: "text", text: awaitProgressSummary(subagents) }],
			details: { subagents },
		};
	}

	async #buildRecordResult(
		manager: AsyncJobManager,
		records: SubagentRecord[],
		options: {
			title: string;
			notFoundIds?: string[];
			timedOut?: boolean;
			verbosity?: SubagentParams["verbosity"];
			attachLiveProgress?: boolean;
			awaitOutcome?: SubagentAwaitOutcome;
			waitOutcome?: "completed" | "timed_out_wait" | "interrupted";
			condition?: "all_terminal" | "any_terminal";
			terminalIds?: string[];
		},
	): Promise<AgentToolResult<SubagentToolDetails>> {
		const verifiedOutputIds = await this.#verifiedOutputIds(records);
		const snapshots = this.#recordSnapshots(
			manager,
			records,
			options.timedOut,
			options.verbosity ?? "receipt",
			verifiedOutputIds,
			options.attachLiveProgress ?? false,
		);
		for (const id of options.notFoundIds ?? []) {
			snapshots.push(this.#missingSnapshot(id, "not_found", "No visible detached subagent matches this id."));
		}
		if (options.awaitOutcome === "interrupted") {
			for (const snapshot of snapshots) {
				if (snapshot.status === "running" || snapshot.status === "paused" || snapshot.status === "queued")
					snapshot.guidance = AWAIT_INTERRUPTED_GUIDANCE;
			}
		}
		const details: SubagentToolDetails = {
			subagents: snapshots,
			...(options.awaitOutcome !== undefined ? { awaitOutcome: options.awaitOutcome } : {}),
			...(options.waitOutcome !== undefined ? { waitOutcome: options.waitOutcome } : {}),
			...(options.condition !== undefined ? { condition: options.condition } : {}),
			...(options.terminalIds !== undefined ? { terminalIds: options.terminalIds } : {}),
		};
		if (options.awaitOutcome === "interrupted") details.interrupted = true;
		return this.#buildSnapshotResult(snapshots, options.title, options.awaitOutcome, details);
	}

	#buildSnapshotResult(
		snapshots: SubagentSnapshot[],
		title: string,
		awaitOutcome?: SubagentAwaitOutcome,
		extraDetails?: SubagentToolDetails,
	): AgentToolResult<SubagentToolDetails> {
		const lines = [`## ${title} (${snapshots.length})`, ""];
		for (const snapshot of snapshots) {
			lines.push(`### ${snapshot.id} — ${snapshot.status}`);
			if (snapshot.jobId !== snapshot.id) lines.push(`Job: ${snapshot.jobId}`);
			if (snapshot.agent) lines.push(`Agent: ${snapshot.agent} (${snapshot.agentSource})`);
			if (snapshot.effectiveModel) {
				lines.push(
					snapshot.modelFellBack && snapshot.requestedModel
						? `Model: ${snapshot.effectiveModel} (requested ${snapshot.requestedModel}, fell back — no credentials)`
						: `Model: ${snapshot.effectiveModel}`,
				);
			}
			if (snapshot.description) lines.push(`Description: ${snapshot.description}`);
			if (snapshot.outputRef) lines.push(`Output: ${snapshot.outputRef}`);
			if (snapshot.setupFailureSummary) lines.push(`Setup failure: ${snapshot.setupFailureSummary}`);
			if (snapshot.localErrorSummary) {
				const local = snapshot.localErrorSummary;
				lines.push(`Local failure (${local.kind}): ${local.summary}`);
				// Guidance is kind-conditional: an overflow is a local staging
				// limit that reproduces on re-issue; a snapshot failure is a
				// serialization defect, which re-issuing does NOT reproduce.
				if (local.kind === "local_buffer_overflow") {
					lines.push(
						"This is a local gjc staging-buffer limit, not a provider or context-window failure; the same request reproduces it.",
					);
				} else if (local.kind === "local_snapshot_failure") {
					lines.push(
						"This is a local gjc event-serialization defect, not a provider failure; re-issuing is safe to retry.",
					);
				}
			}
			if (snapshot.assignment) lines.push("Assignment:", "```", snapshot.assignment, "```");
			if (snapshot.steerMessage) {
				lines.push(`Steer (${snapshot.steerState ?? "queued"}):`, "```", snapshot.steerMessage, "```");
				lines.push(STEER_QUEUED_GUIDANCE);
			}
			if (snapshot.resultPreview) {
				lines.push(snapshot.errorText ? "Error preview:" : "Result preview:", "```", snapshot.resultPreview, "```");
				if (snapshot.truncated)
					lines.push("Preview truncated; use the output ref or explicit ids with `verbosity=full` for more.");
			}
			if (snapshot.guidance) lines.push(`Guidance: ${snapshot.guidance}`);
			lines.push("");
		}
		return {
			content: [{ type: "text", text: lines.join("\n").trimEnd() }],
			details: extraDetails ?? {
				subagents: snapshots,
				...(awaitOutcome ? { awaitOutcome } : {}),
				...(awaitOutcome === "interrupted" ? { interrupted: true } : {}),
			},
		};
	}

	#recordSnapshots(
		manager: AsyncJobManager,
		records: SubagentRecord[],
		timedOut = false,
		verbosity: SubagentParams["verbosity"] = "receipt",
		verifiedOutputIds: ReadonlySet<string>,
		attachLiveProgress = false,
	): SubagentSnapshot[] {
		return records.map(record =>
			this.#recordSnapshot(manager, record, timedOut, verbosity, verifiedOutputIds, attachLiveProgress),
		);
	}

	#liveProgressFields(
		manager: AsyncJobManager,
		record: SubagentRecord,
		attachLiveProgress: boolean,
	): Pick<SubagentSnapshot, "progress" | "liveProgressAvailable"> {
		if (!attachLiveProgress) return {};
		const liveProgressAvailable = manager.hasLiveSubagent(record.subagentId);
		if (!liveProgressAvailable) return { liveProgressAvailable: false };
		const progress = manager.getSubagentProgress(record.subagentId);
		return {
			liveProgressAvailable: true,
			...(progress ? { progress: toSubagentLiveProgress(progress) } : {}),
		};
	}

	#recordSnapshot(
		manager: AsyncJobManager,
		record: SubagentRecord,
		timedOut = false,
		verbosity: SubagentParams["verbosity"] = "receipt",
		verifiedOutputIds: ReadonlySet<string>,
		attachLiveProgress = false,
	): SubagentSnapshot {
		const liveFields = this.#liveProgressFields(manager, record, attachLiveProgress);
		const job = record.currentJobId ? manager.getJob(record.currentJobId) : undefined;
		if (job) {
			return {
				...this.#snapshot(job, timedOut, verbosity, verifiedOutputIds, record),
				id: record.subagentId,
				jobId: record.currentJobId ?? job.id,
				status: record.status,
				...liveFields,
			};
		}
		return {
			id: record.subagentId,
			jobId: record.currentJobId ?? record.subagentId,
			status: record.status,
			label: "subagent",
			agent: "unknown",
			agentSource: "bundled",
			durationMs: 0,
			...(verifiedOutputIds.has(record.subagentId) ? { outputRef: `agent://${record.subagentId}` } : {}),
			...liveFields,
			...this.#modelFields(record),
		};
	}

	#modelFields(record?: SubagentRecord): Partial<SubagentSnapshot> {
		if (!record) return {};
		const fields: Partial<SubagentSnapshot> = {};
		if (record.effectiveModel) fields.effectiveModel = record.effectiveModel;
		if (record.requestedModel) fields.requestedModel = record.requestedModel;
		if (record.modelFellBack) fields.modelFellBack = true;
		if (record.fastMode) fields.fastMode = true;
		return fields;
	}

	#snapshot(
		job: AsyncJob,
		timedOut = false,
		verbosity: SubagentParams["verbosity"] = "receipt",
		verifiedOutputIds: ReadonlySet<string>,
		record?: SubagentRecord,
	): SubagentSnapshot {
		const subagent = job.metadata?.subagent;
		const runningTimeoutGuidance =
			timedOut && job.status === "running"
				? "Still running after the await timeout; timeout only bounded this wait and is not a failure. Inspect progress, continue independent work, and never cancel just because an await timed out; cancel only if the subagent has actually failed, gone off-track, or become unrecoverably wrong."
				: undefined;
		const output = previewJobOutput(job, verbosity);
		const outputRef = record && verifiedOutputIds.has(record.subagentId) ? `agent://${record.subagentId}` : undefined;
		return {
			id: subagent?.id ?? job.id,
			jobId: job.id,
			status: job.status,
			label: sanitizeText(job.label, RECEIPT_PREVIEW_WIDTH),
			agent: subagent?.agent ?? "unknown",
			agentSource: subagent?.agentSource ?? "bundled",
			durationMs: jobElapsedMs(job),
			...(subagent?.description ? { description: sanitizeText(subagent.description, RECEIPT_PREVIEW_WIDTH) } : {}),
			...(verbosity === "full" && subagent?.assignment
				? { assignment: sanitizeText(subagent.assignment, FULL_PREVIEW_WIDTH) }
				: {}),
			...(output
				? {
						...(output.type === "error" ? { errorText: output.preview } : { resultText: output.preview }),
						resultPreview: output.preview,
						truncated: output.truncated,
					}
				: {}),
			...(job.setupFailureSummary
				? { setupFailureSummary: sanitizeText(job.setupFailureSummary, RECEIPT_PREVIEW_WIDTH) }
				: {}),
			...(job.localErrorSummary
				? {
						localErrorSummary: {
							kind: job.localErrorSummary.kind,
							summary: sanitizeText(job.localErrorSummary.summary, RECEIPT_PREVIEW_WIDTH),
						},
					}
				: {}),
			...(outputRef ? { outputRef } : {}),
			...(runningTimeoutGuidance ? { guidance: runningTimeoutGuidance } : {}),
			...this.#modelFields(record),
		};
	}

	async #verifiedOutputIds(records: SubagentRecord[]): Promise<Set<string>> {
		const ids = new Set(records.map(record => record.subagentId));
		const dirs = this.#artifactDirsForRecords(records);
		const verified = new Set<string>();
		await Promise.all(
			[...ids].map(async id => {
				for (const dir of dirs) {
					if (await Bun.file(path.join(dir, `${id}.md.meta.json`)).exists()) {
						verified.add(id);
						return;
					}
				}
			}),
		);
		return verified;
	}

	#artifactDirsForRecords(records: SubagentRecord[]): string[] {
		const dirs: string[] = [];
		for (const record of records) {
			if (!record.sessionFile) continue;
			const dir = path.dirname(record.sessionFile);
			if (!dirs.includes(dir)) dirs.push(dir);
		}
		const sessionDir = this.session.getArtifactsDir?.();
		if (sessionDir && !dirs.includes(sessionDir)) dirs.push(sessionDir);
		return dirs;
	}

	#missingSnapshot(id: string, status: "not_found", guidance: string): SubagentSnapshot {
		return {
			id,
			jobId: id,
			status,
			label: "missing",
			agent: "unknown",
			agentSource: "bundled",
			durationMs: 0,
			guidance,
		};
	}
}

/**
 * Human-readable line for streamed `await` progress.
 *
 * Consumers that render structured content (ACP) previously received an empty
 * text block here, which made `extractStructuredText` fail and the mapper fall
 * back to serializing the whole result object as the human-readable content. A
 * real sentence keeps the elapsed time legible there and in any log that only
 * shows tool text.
 */
function awaitProgressSummary(subagents: readonly SubagentSnapshot[]): string {
	const waiting = subagents.filter(snapshot => !isTerminalStatus(snapshot.status));
	if (waiting.length === 0) return "";
	// Accumulate rather than spreading into Math.max: explicit `ids` are not
	// capped by MAX_LIST_LIMIT, so a large await would hit the argument limit.
	let longestMs = 0;
	for (const snapshot of waiting) if (snapshot.durationMs > longestMs) longestMs = snapshot.durationMs;
	return `Awaiting ${waiting.length} subagent(s) for ${formatDuration(longestMs)}: ${waiting
		.map(snapshot => snapshot.id)
		.join(", ")}`;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	if ((typeof value !== "object" || value === null) && typeof value !== "function") return false;
	return typeof (value as { then?: unknown }).then === "function";
}

function safeThrownValue(error: unknown): string {
	try {
		if (error instanceof Error) return error.message;
		return String(error);
	} catch {
		return "[unprintable thrown value]";
	}
}

function isTerminalStatus(status: SubagentStatus): boolean {
	return status === "completed" || status === "failed" || status === "cancelled";
}

function isSubagentJob(job: AsyncJob): boolean {
	return job.type === "task" && job.metadata?.subagent !== undefined;
}

function sanitizeText(text: string, width: number): string {
	return capCodePointsAndBytes(
		truncateToWidth(replaceTabs(text), width, Ellipsis.Unicode),
		width,
		previewByteCap(width),
	);
}

function previewByteCap(width: number): number {
	return width === FULL_PREVIEW_WIDTH
		? FULL_PREVIEW_BYTES
		: width === PREVIEW_WIDTH
			? PREVIEW_BYTES
			: RECEIPT_PREVIEW_BYTES;
}

export function capCodePointsAndBytes(text: string, maxCodePoints: number, maxBytes: number): string {
	const ellipsis = "…";
	const collapsed = text.replace(/…{2,}$/u, ellipsis);
	const codePoints = [...collapsed];
	if (codePoints.length <= maxCodePoints && Buffer.byteLength(collapsed) <= maxBytes) return collapsed;

	const source = collapsed.endsWith(ellipsis) ? collapsed.slice(0, -ellipsis.length) : collapsed;
	const ellipsisBytes = Buffer.byteLength(ellipsis);
	let preview = "";
	let previewBytes = 0;
	let previewCodePoints = 0;
	for (const codePoint of source) {
		const codePointBytes = Buffer.byteLength(codePoint);
		if (previewCodePoints + 1 + 1 > maxCodePoints || previewBytes + codePointBytes + ellipsisBytes > maxBytes) break;
		preview += codePoint;
		previewBytes += codePointBytes;
		previewCodePoints++;
	}
	return `${preview}${ellipsis}`;
}

function previewJobOutput(
	job: AsyncJob,
	verbosity: SubagentParams["verbosity"] = "receipt",
): { type: "result" | "error"; preview: string; truncated: boolean } | undefined {
	const source = job.errorText
		? { type: "error" as const, text: job.errorText }
		: job.resultText
			? { type: "result" as const, text: job.resultText }
			: undefined;
	if (!source) return undefined;
	const width =
		verbosity === "full" ? FULL_PREVIEW_WIDTH : verbosity === "preview" ? PREVIEW_WIDTH : RECEIPT_PREVIEW_WIDTH;
	const normalized = replaceTabs(source.text);
	const preview = capCodePointsAndBytes(
		truncateToWidth(normalized, width, Ellipsis.Unicode),
		width,
		previewByteCap(width),
	);
	return { type: source.type, preview, truncated: preview !== normalized };
}

/**
 * Canonical, value-based rendered-state signature for the `subagent` await panel.
 *
 * Producer-side await gating compares this signature against the last emitted one
 * and only fires `onUpdate` when the *rendered* state actually changed. Unchanged
 * idle ticks therefore stop rebuilding the renderer component and stop mutating
 * transcript lines above the viewport, which is what triggers TUI full-redraw
 * storms (`tui.ts` `firstChanged < viewportTop`).
 *
 * It is deliberately value-based, never object identity: `AsyncJobManager.record-
 * SubagentProgress` stores a `structuredClone` but `getSubagentProgress` returns
 * the retained object by reference, so identity comparison would be both noisy and
 * unsafe.
 *
 * Time-derived fields are intentionally excluded so the panel does not churn while
 * idle: raw durations (`durationMs`), current-tool elapsed (`currentToolStartMs`),
 * and retry countdowns (`retryState.startedAtMs`) are omitted. Idle duration and
 * countdown ticking is sacrificed by design; every real transition still changes
 * the signature.
 */
export function subagentAwaitRenderedStateSignature(
	subagents: readonly SubagentSnapshot[],
	receipt?: Pick<SubagentToolDetails, "awaitOutcome" | "interrupted">,
): string {
	return JSON.stringify({
		awaitOutcome: receipt?.awaitOutcome ?? null,
		interrupted: receipt?.interrupted === true,
		subagents: subagents.map(canonicalizeSnapshotForSignature),
	});
}

function canonicalizeSnapshotForSignature(snapshot: SubagentSnapshot): unknown {
	return {
		id: snapshot.id,
		jobId: snapshot.jobId,
		status: snapshot.status,
		label: snapshot.label,
		agent: snapshot.agent,
		agentSource: snapshot.agentSource,
		description: snapshot.description ?? null,
		assignment: snapshot.assignment ?? null,
		resultText: snapshot.resultText ?? null,
		errorText: snapshot.errorText ?? null,
		resultPreview: snapshot.resultPreview ?? null,
		outputRef: snapshot.outputRef ?? null,
		truncated: snapshot.truncated ?? false,
		guidance: snapshot.guidance ?? null,
		steerMessage: snapshot.steerMessage ?? null,
		steerState: snapshot.steerState ?? null,
		steerPauseRequested: snapshot.steerPauseRequested ?? false,
		liveProgressAvailable: snapshot.liveProgressAvailable ?? null,
		effectiveModel: snapshot.effectiveModel ?? null,
		requestedModel: snapshot.requestedModel ?? null,
		modelFellBack: snapshot.modelFellBack ?? false,
		fastMode: snapshot.fastMode ?? false,
		// durationMs intentionally excluded (time-derived; would defeat idle gating).
		progress: snapshot.progress ? canonicalizeProgressForSignature(snapshot.progress) : null,
	};
}

function canonicalizeProgressForSignature(progress: SubagentLiveProgress): unknown {
	return {
		id: progress.id,
		status: progress.status,
		currentTool: progress.currentTool ?? null,
		recentTool: progress.recentTool ?? null,
		recentOutputSummary: progress.recentOutputSummary ?? null,
		fastMode: progress.fastMode ?? false,
		retryFailure: progress.retryFailure ?? null,
		retryState: progress.retryState
			? {
					attempt: progress.retryState.attempt,
					maxAttempts: progress.retryState.maxAttempts,
					unbounded: progress.retryState.unbounded ?? false,
					kind: progress.retryState.kind,
					provider: progress.retryState.provider ?? null,
					delayMs: progress.retryState.delayMs,
				}
			: null,
	};
}
