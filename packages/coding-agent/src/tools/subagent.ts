import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@gajae-code/agent-core";
import { prompt } from "@gajae-code/utils";
import * as z from "zod/v4";
import { type AsyncJob, AsyncJobManager, type SubagentRecord } from "../async";
import subagentDescription from "../prompts/tools/subagent.md" with { type: "text" };
import type { AgentSource } from "../task/types";
import { Ellipsis, truncateToWidth } from "../tui";
import type { ToolSession } from "./index";
import { replaceTabs } from "./render-utils";
import { ToolError } from "./tool-errors";

const DEFAULT_AWAIT_TIMEOUT_MS = 30_000;
const MAX_AWAIT_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_LIST_LIMIT = 10;
const MAX_LIST_LIMIT = 50;
const TEXT_PREVIEW_WIDTH = 12_000;

const subagentSchema = z.object({
	action: z
		.enum(["list", "inspect", "await", "cancel", "pause", "resume", "steer"])
		.describe("subagent control action"),
	ids: z.array(z.string()).optional().describe("subagent ids or backing job ids"),
	message: z.string().optional().describe("message to deliver when resuming or steering a subagent"),
	pause: z.boolean().optional().describe("pause after steering a currently running subagent"),
	timeout_ms: z.number().min(0).max(MAX_AWAIT_TIMEOUT_MS).optional().describe("await timeout in milliseconds"),
	limit: z.number().min(1).max(MAX_LIST_LIMIT).optional().describe("maximum subagents to return"),
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
	guidance?: string;
}

export interface SubagentToolDetails {
	subagents: SubagentSnapshot[];
}

export class SubagentTool implements AgentTool<typeof subagentSchema, SubagentToolDetails> {
	readonly name = "subagent";
	readonly label = "Subagent";
	readonly summary = "Manage detached task subagents";
	readonly description: string;
	readonly parameters = subagentSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";

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
		const manager = AsyncJobManager.instance();
		if (!manager) {
			return {
				content: [{ type: "text", text: "No subagent manager is available in this session." }],
				details: { subagents: [] },
			};
		}

		const ownerId = this.session.getAgentId?.() ?? undefined;
		const ownerFilter = ownerId ? { ownerId } : undefined;
		const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(params.limit ?? DEFAULT_LIST_LIMIT)));

		if (params.action === "list") {
			const records = this.#listSubagentRecords(manager, ownerFilter, limit);
			return this.#buildRecordResult(manager, records, { title: "Subagents" });
		}

		if (params.action === "inspect") {
			const records = params.ids?.length
				? this.#visibleRecordsByIds(manager, params.ids, ownerFilter)
				: this.#runningRecords(manager, ownerFilter);
			return this.#buildRecordResult(manager, records, {
				title: "Subagent inspection",
				notFoundIds: this.#notFoundRecordIds(manager, params.ids ?? [], ownerFilter),
			});
		}

		if (params.action === "cancel") {
			const ids = params.ids ?? [];
			if (ids.length === 0) {
				throw new ToolError("`cancel` requires at least one subagent id.");
			}
			const snapshots: SubagentSnapshot[] = [];
			for (const id of ids) {
				const record = this.#findVisibleRecord(manager, id, ownerFilter);
				if (!record) {
					snapshots.push(this.#missingSnapshot(id, "not_found", "No visible detached subagent matches this id."));
					continue;
				}
				const cancelled = manager.cancelSubagent(record.subagentId, ownerFilter);
				if (!cancelled && record.currentJobId) manager.cancel(record.currentJobId, ownerFilter);
				const updated = this.#findVisibleRecord(manager, id, ownerFilter) ?? record;
				snapshots.push(this.#recordSnapshot(manager, updated));
			}
			return this.#buildSnapshotResult(snapshots, "Subagent cancellation");
		}

		if (params.action === "pause") {
			const ids = params.ids ?? [];
			if (ids.length === 0) {
				throw new ToolError("`pause` requires at least one subagent id.");
			}
			const snapshots: SubagentSnapshot[] = [];
			for (const id of ids) {
				const record = this.#findVisibleRecord(manager, id, ownerFilter);
				if (!record) {
					snapshots.push(this.#missingSnapshot(id, "not_found", "No visible detached subagent matches this id."));
					continue;
				}
				const result = manager.pauseSubagent(record.subagentId, ownerFilter);
				if (!result.ok && result.reason === "not_found") {
					snapshots.push(this.#missingSnapshot(id, "not_found", "No visible detached subagent matches this id."));
					continue;
				}
				snapshots.push(
					this.#recordSnapshot(manager, manager.getSubagentRecord(record.subagentId, ownerFilter) ?? record),
				);
			}
			return this.#buildSnapshotResult(snapshots, "Subagent pause");
		}

		if (params.action === "resume") {
			const ids = params.ids ?? [];
			if (ids.length === 0) {
				throw new ToolError("`resume` requires at least one subagent id.");
			}
			const snapshots: SubagentSnapshot[] = [];
			for (const id of ids) {
				const record = this.#findVisibleRecord(manager, id, ownerFilter);
				if (!record) {
					snapshots.push(this.#missingSnapshot(id, "not_found", "No visible detached subagent matches this id."));
					continue;
				}
				if (record.status === "running") {
					snapshots.push(this.#recordSnapshot(manager, record));
					continue;
				}
				if (params.message === undefined && isTerminalStatus(record.status)) {
					snapshots.push({
						...this.#recordSnapshot(manager, record),
						guidance:
							"This subagent is terminal. Provide `message` to start a follow-up resume run from its saved context.",
					});
					continue;
				}
				const result = manager.resumeSubagent(record.subagentId, ownerFilter, params.message);
				if (!result.ok && result.reason === "context_unavailable") throw new ToolError("context unavailable");
				if (!result.ok && result.reason === "not_found") {
					snapshots.push(this.#missingSnapshot(id, "not_found", "No visible detached subagent matches this id."));
					continue;
				}
				snapshots.push(
					this.#recordSnapshot(manager, manager.getSubagentRecord(record.subagentId, ownerFilter) ?? record),
				);
			}
			return this.#buildSnapshotResult(snapshots, "Subagent resume");
		}

		if (params.action === "steer") {
			const ids = params.ids ?? [];
			const message = params.message;
			if (ids.length === 0) {
				throw new ToolError("`steer` requires at least one subagent id.");
			}
			if (message === undefined || message.trim() === "") {
				throw new ToolError("`steer` requires a non-empty message.");
			}
			const snapshots: SubagentSnapshot[] = [];
			for (const id of ids) {
				const record = this.#findVisibleRecord(manager, id, ownerFilter);
				if (!record) {
					snapshots.push(this.#missingSnapshot(id, "not_found", "No visible detached subagent matches this id."));
					continue;
				}
				if (!record.sessionFile) throw new ToolError(`Subagent ${record.subagentId} has no session file.`);
				if (record.status === "running") {
					const handle = manager.getLiveHandle(record.subagentId);
					if (!handle) throw new ToolError(`Subagent ${record.subagentId} has no live handle.`);
					await handle.injectMessage(message, "steer");
					if (params.pause === true) manager.pauseSubagent(record.subagentId, ownerFilter);
				} else {
					const result = manager.resumeSubagent(record.subagentId, ownerFilter, message);
					if (!result.ok && result.reason === "context_unavailable") throw new ToolError("context unavailable");
					if (!result.ok && result.reason === "not_found") {
						snapshots.push(
							this.#missingSnapshot(id, "not_found", "No visible detached subagent matches this id."),
						);
						continue;
					}
				}
				snapshots.push(
					this.#recordSnapshot(manager, manager.getSubagentRecord(record.subagentId, ownerFilter) ?? record),
				);
			}
			return this.#buildSnapshotResult(snapshots, "Subagent steer");
		}

		return this.#awaitSubagents(manager, params, ownerFilter, signal, onUpdate);
	}

	async #awaitSubagents(
		manager: AsyncJobManager,
		params: SubagentParams,
		ownerFilter: { ownerId: string } | undefined,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<SubagentToolDetails> | undefined,
	): Promise<AgentToolResult<SubagentToolDetails>> {
		const records = params.ids?.length
			? this.#visibleRecordsByIds(manager, params.ids, ownerFilter)
			: this.#runningRecords(manager, ownerFilter);
		const notFoundIds = this.#notFoundRecordIds(manager, params.ids ?? [], ownerFilter);
		if (records.length === 0) {
			const missing = notFoundIds.map(id =>
				this.#missingSnapshot(id, "not_found", "No visible detached subagent matches this id."),
			);
			return this.#buildSnapshotResult(missing, "Subagent await");
		}

		const runningJobs = records
			.filter(record => record.status === "running" && record.currentJobId)
			.map(record => manager.getJob(record.currentJobId!))
			.filter((job): job is AsyncJob => job !== undefined);
		if (runningJobs.length === 0) {
			return this.#buildRecordResult(manager, records, { title: "Subagent await", notFoundIds });
		}

		const timeoutMs = Math.min(
			MAX_AWAIT_TIMEOUT_MS,
			Math.max(0, Math.floor(params.timeout_ms ?? DEFAULT_AWAIT_TIMEOUT_MS)),
		);
		const watchedJobIds = runningJobs.map(job => job.id);
		manager.watchJobs(watchedJobIds);
		const progressTimer = onUpdate
			? setInterval(() => {
					onUpdate(this.#progressResult(manager, records));
				}, 500)
			: undefined;
		onUpdate?.(this.#progressResult(manager, records));

		let timedOut = false;
		try {
			const completionPromise = Promise.all(runningJobs.map(job => job.promise));
			const timeoutPromise = Bun.sleep(timeoutMs).then(() => {
				timedOut = true;
			});
			if (signal) {
				const { promise: abortPromise, resolve: abortResolve } = Promise.withResolvers<void>();
				const onAbort = () => abortResolve();
				signal.addEventListener("abort", onAbort, { once: true });
				try {
					await Promise.race([completionPromise, timeoutPromise, abortPromise]);
				} finally {
					signal.removeEventListener("abort", onAbort);
				}
			} else {
				await Promise.race([completionPromise, timeoutPromise]);
			}
		} finally {
			manager.unwatchJobs(watchedJobIds);
			if (progressTimer) clearInterval(progressTimer);
		}

		return this.#buildRecordResult(manager, records, { title: "Subagent await", notFoundIds, timedOut });
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
			.find(job => isSubagentJob(job) && job.metadata?.subagent?.id === id);
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

	#progressResult(manager: AsyncJobManager, records: SubagentRecord[]): AgentToolResult<SubagentToolDetails> {
		return {
			content: [{ type: "text", text: "" }],
			details: { subagents: this.#recordSnapshots(manager, records) },
		};
	}

	#buildRecordResult(
		manager: AsyncJobManager,
		records: SubagentRecord[],
		options: { title: string; notFoundIds?: string[]; timedOut?: boolean },
	): AgentToolResult<SubagentToolDetails> {
		const snapshots = this.#recordSnapshots(manager, records, options.timedOut);
		for (const id of options.notFoundIds ?? []) {
			snapshots.push(this.#missingSnapshot(id, "not_found", "No visible detached subagent matches this id."));
		}
		manager.acknowledgeDeliveries(
			snapshots
				.filter(
					s =>
						s.status !== "running" && s.status !== "paused" && s.status !== "queued" && s.status !== "not_found",
				)
				.map(s => s.jobId),
		);
		return this.#buildSnapshotResult(snapshots, options.title);
	}

	#buildSnapshotResult(snapshots: SubagentSnapshot[], title: string): AgentToolResult<SubagentToolDetails> {
		const lines = [`## ${title} (${snapshots.length})`, ""];
		for (const snapshot of snapshots) {
			lines.push(`### ${snapshot.id} — ${snapshot.status}`);
			if (snapshot.jobId !== snapshot.id) lines.push(`Job: ${snapshot.jobId}`);
			if (snapshot.agent) lines.push(`Agent: ${snapshot.agent} (${snapshot.agentSource})`);
			if (snapshot.description) lines.push(`Description: ${snapshot.description}`);
			if (snapshot.assignment) lines.push("Assignment:", "```", snapshot.assignment, "```");
			if (snapshot.resultText) lines.push("Result:", "```", snapshot.resultText, "```");
			if (snapshot.errorText) lines.push("Error:", "```", snapshot.errorText, "```");
			if (snapshot.guidance) lines.push(`Guidance: ${snapshot.guidance}`);
			lines.push("");
		}
		return {
			content: [{ type: "text", text: lines.join("\n").trimEnd() }],
			details: { subagents: snapshots },
		};
	}

	#recordSnapshots(manager: AsyncJobManager, records: SubagentRecord[], timedOut = false): SubagentSnapshot[] {
		return records.map(record => this.#recordSnapshot(manager, record, timedOut));
	}

	#recordSnapshot(manager: AsyncJobManager, record: SubagentRecord, timedOut = false): SubagentSnapshot {
		const job = record.currentJobId ? manager.getJob(record.currentJobId) : undefined;
		if (job) {
			return {
				...this.#snapshot(job, timedOut),
				id: record.subagentId,
				jobId: record.currentJobId ?? job.id,
				status: record.status,
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
		};
	}

	#snapshot(job: AsyncJob, timedOut = false): SubagentSnapshot {
		const subagent = job.metadata?.subagent;
		const runningTimeoutGuidance =
			timedOut && job.status === "running"
				? "Still running after the await timeout; timeout only bounded this wait and is not a failure. Inspect progress, continue independent work, and never cancel just because an await timed out; cancel only if the subagent has actually failed, gone off-track, or become unrecoverably wrong."
				: undefined;
		return {
			id: subagent?.id ?? job.id,
			jobId: job.id,
			status: job.status,
			label: sanitizeText(job.label),
			agent: subagent?.agent ?? "unknown",
			agentSource: subagent?.agentSource ?? "bundled",
			durationMs: Math.max(0, Date.now() - job.startTime),
			...(subagent?.description ? { description: sanitizeText(subagent.description) } : {}),
			...(subagent?.assignment ? { assignment: sanitizeText(subagent.assignment) } : {}),
			...(job.resultText ? { resultText: sanitizeText(job.resultText) } : {}),
			...(job.errorText ? { errorText: sanitizeText(job.errorText) } : {}),
			...(runningTimeoutGuidance ? { guidance: runningTimeoutGuidance } : {}),
		};
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

function isTerminalStatus(status: SubagentStatus): boolean {
	return status === "completed" || status === "failed" || status === "cancelled";
}

function isSubagentJob(job: AsyncJob): boolean {
	return job.type === "task" && job.metadata?.subagent !== undefined;
}

function sanitizeText(text: string): string {
	return truncateToWidth(replaceTabs(text), TEXT_PREVIEW_WIDTH, Ellipsis.Unicode);
}
