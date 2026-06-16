import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@gajae-code/agent-core";
import { prompt } from "@gajae-code/utils";
import * as z from "zod/v4";
import { type AsyncJob, AsyncJobManager, jobElapsedMs, type SubagentRecord } from "../async";
import subagentDescription from "../prompts/tools/subagent.md" with { type: "text" };
import type { AgentProgress, AgentSource, TaskToolDetails } from "../task/types";
import { Ellipsis, truncateToWidth } from "../tui";
import type { ToolSession } from "./index";
import { replaceTabs } from "./render-utils";
import { ToolError } from "./tool-errors";

const DEFAULT_AWAIT_TIMEOUT_MS = 30_000;
const MAX_AWAIT_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_LIST_LIMIT = 10;
const MAX_LIST_LIMIT = 50;
const RECEIPT_PREVIEW_WIDTH = 280;
const PREVIEW_WIDTH = 2_000;
const FULL_PREVIEW_WIDTH = 12_000;

const subagentSchema = z.object({
	action: z
		.enum(["list", "inspect", "await", "cancel", "pause", "resume", "steer"])
		.describe("subagent control action"),
	ids: z.array(z.string()).optional().describe("subagent ids or backing job ids"),
	id: z.string().optional().describe("single subagent id or backing job id for resume/steer"),
	message: z.string().optional().describe("message to deliver when resuming or steering a subagent"),
	pause: z.boolean().optional().describe("pause after steering a currently running subagent"),
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
	resultPreview?: string;
	outputRef?: string;
	truncated?: boolean;
	guidance?: string;
	/** Live streaming progress for the awaited subagent (await panel only; UI detail). */
	progress?: AgentProgress;
	/** True when a live in-session progress producer exists for this subagent. */
	liveProgressAvailable?: boolean;
	/** Model the subagent actually runs on (after any auth fallback). */
	effectiveModel?: string;
	/** Model originally requested via role/preset mapping; differs from effective on fallback. */
	requestedModel?: string;
	/** True when the requested model lacked credentials and fell back to the parent model. */
	modelFellBack?: boolean;
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
				const result = manager.resumeSubagent(record.subagentId, ownerFilter, params.message);
				if (!result.ok && result.reason === "context_unavailable") throw new ToolError("context unavailable");
				if (!result.ok && result.reason === "not_found") {
					missing.push(this.#missingSnapshot(id, "not_found", "No visible detached subagent matches this id."));
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
			const record = this.#findVisibleRecord(manager, id, ownerFilter);
			const verifiedOutputIds = await this.#verifiedOutputIds(record ? [record] : []);
			if (!record) {
				missing.push(this.#missingSnapshot(id, "not_found", "No visible detached subagent matches this id."));
			} else {
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
						missing.push(this.#missingSnapshot(id, "not_found", "No visible detached subagent matches this id."));
					} else {
						records.push(manager.getSubagentRecord(record.subagentId, ownerFilter) ?? record);
					}
				}
				if (record.status === "running")
					records.push(manager.getSubagentRecord(record.subagentId, ownerFilter) ?? record);
			}
			return this.#buildSnapshotResult(
				[
					...records.map(record => this.#recordSnapshot(manager, record, false, verbosity, verifiedOutputIds)),
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
				`\`${action}\` accepts exactly one target because \`message\` is delivered to one subagent.`,
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
			return await this.#buildRecordResult(manager, records, {
				title: "Subagent await",
				notFoundIds,
				verbosity: params.verbosity ?? "receipt",
			});
		}

		const timeoutMs = Math.min(
			MAX_AWAIT_TIMEOUT_MS,
			Math.max(0, Math.floor(params.timeout_ms ?? DEFAULT_AWAIT_TIMEOUT_MS)),
		);
		const watchedJobIds = runningJobs.map(job => job.id);
		manager.watchJobs(watchedJobIds);
		let lastEmittedSignature: string | undefined;
		const emitIfChanged = (force: boolean): void => {
			if (!onUpdate) return;
			const result = this.#progressResult(manager, records, true);
			const signature = subagentAwaitRenderedStateSignature(result.details?.subagents ?? []);
			if (!force && signature === lastEmittedSignature) return;
			lastEmittedSignature = signature;
			onUpdate(result);
		};
		const progressTimer = onUpdate ? setInterval(() => emitIfChanged(false), 500) : undefined;
		// Initial emission so the panel appears immediately; later idle ticks are
		// gated on a value-based rendered-state signature so unchanged progress no
		// longer rebuilds the renderer component or mutates transcript lines above
		// the viewport (the source of the await-panel repaint storms).
		emitIfChanged(true);

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

		return await this.#buildRecordResult(manager, records, {
			title: "Subagent await",
			notFoundIds,
			timedOut,
			verbosity: params.verbosity ?? "receipt",
			attachLiveProgress: true,
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

	#progressResult(
		manager: AsyncJobManager,
		records: SubagentRecord[],
		attachLiveProgress = false,
	): AgentToolResult<SubagentToolDetails> {
		return {
			content: [{ type: "text", text: "" }],
			details: {
				subagents: this.#recordSnapshots(manager, records, false, "receipt", new Set(), attachLiveProgress),
			},
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
			if (snapshot.effectiveModel) {
				lines.push(
					snapshot.modelFellBack && snapshot.requestedModel
						? `Model: ${snapshot.effectiveModel} (requested ${snapshot.requestedModel}, fell back — no credentials)`
						: `Model: ${snapshot.effectiveModel}`,
				);
			}
			if (snapshot.description) lines.push(`Description: ${snapshot.description}`);
			if (snapshot.outputRef) lines.push(`Output: ${snapshot.outputRef}`);
			if (snapshot.assignment) lines.push("Assignment:", "```", snapshot.assignment, "```");
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
			details: { subagents: snapshots },
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
		// Only surface progress when a live producer exists; stale/retained progress
		// for a record with no live producer must degrade to a static snapshot (AC5).
		if (!liveProgressAvailable) return { liveProgressAvailable: false };
		const progress = manager.getSubagentProgress(record.subagentId);
		return {
			liveProgressAvailable: true,
			...(progress ? { progress } : {}),
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

function isTerminalStatus(status: SubagentStatus): boolean {
	return status === "completed" || status === "failed" || status === "cancelled";
}

function isSubagentJob(job: AsyncJob): boolean {
	return job.type === "task" && job.metadata?.subagent !== undefined;
}

function sanitizeText(text: string, width: number): string {
	return truncateToWidth(replaceTabs(text), width, Ellipsis.Unicode);
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
	const preview = truncateToWidth(normalized, width, Ellipsis.Unicode);
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
export function subagentAwaitRenderedStateSignature(subagents: readonly SubagentSnapshot[]): string {
	return JSON.stringify(subagents.map(canonicalizeSnapshotForSignature));
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
		liveProgressAvailable: snapshot.liveProgressAvailable ?? null,
		effectiveModel: snapshot.effectiveModel ?? null,
		requestedModel: snapshot.requestedModel ?? null,
		modelFellBack: snapshot.modelFellBack ?? false,
		// durationMs intentionally excluded (time-derived; would defeat idle gating).
		progress: snapshot.progress ? canonicalizeProgressForSignature(snapshot.progress) : null,
	};
}

function canonicalizeProgressForSignature(progress: AgentProgress): unknown {
	return {
		id: progress.id,
		agent: progress.agent,
		agentSource: progress.agentSource,
		status: progress.status,
		task: progress.task,
		assignment: progress.assignment ?? null,
		description: progress.description ?? null,
		lastIntent: progress.lastIntent ?? null,
		currentTool: progress.currentTool ?? null,
		currentToolArgs: progress.currentToolArgs ?? null,
		// currentToolStartMs intentionally excluded (only drives elapsed rendering).
		recentTools: progress.recentTools.map(tool => ({ tool: tool.tool, args: tool.args })),
		recentOutput: progress.recentOutput,
		toolCount: progress.toolCount,
		tokens: progress.tokens,
		contextTokens: progress.contextTokens ?? null,
		contextWindow: progress.contextWindow ?? null,
		cost: progress.cost,
		modelOverride: progress.modelOverride ?? null,
		modelSubstitutionWarning: progress.modelSubstitutionWarning ?? null,
		// durationMs intentionally excluded (time-derived).
		extractedToolData: progress.extractedToolData
			? canonicalizeExtractedToolDataForSignature(progress.extractedToolData)
			: null,
		retryState: progress.retryState
			? {
					attempt: progress.retryState.attempt,
					maxAttempts: progress.retryState.maxAttempts,
					unbounded: progress.retryState.unbounded ?? false,
					delayMs: progress.retryState.delayMs,
					errorMessage: progress.retryState.errorMessage,
					// startedAtMs intentionally excluded (drives countdown only).
				}
			: null,
		retryFailure: progress.retryFailure ?? null,
		inflightTaskDetails: progress.inflightTaskDetails
			? canonicalizeTaskDetailsForSignature(progress.inflightTaskDetails)
			: null,
	};
}

/**
 * Nested `task` data (`extractedToolData.task` and `inflightTaskDetails`) is the
 * one place the await signature reaches into a live, ticking structure: nested
 * `AgentProgress` carries the same time-derived fields excluded above, and
 * `TaskToolDetails` adds `totalDurationMs` / per-result `durationMs`. Signing it
 * wholesale would defeat idle gating whenever an awaited subagent is itself inside
 * a live `task` call, so these helpers canonicalize the rendered, non-time subset
 * recursively (mutually recursive with `canonicalizeProgressForSignature`).
 */
function canonicalizeExtractedToolDataForSignature(data: Record<string, unknown[]>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(data)) {
		// Only the `task` key holds time-ticking `TaskToolDetails`; other handler
		// data (yield/report_finding/generic) is stable and passes through as-is.
		out[key] = key === "task" ? (data[key] as TaskToolDetails[]).map(canonicalizeTaskDetailsForSignature) : data[key];
	}
	return out;
}

function canonicalizeTaskDetailsForSignature(details: TaskToolDetails): unknown {
	// `extractedToolData` is an untyped boundary (`Record<string, unknown[]>`), so
	// guard each field instead of trusting the `TaskToolDetails` cast.
	return {
		// totalDurationMs intentionally excluded (time-derived).
		results: Array.isArray(details.results) ? details.results.map(canonicalizeTaskResultForSignature) : null,
		progress: Array.isArray(details.progress) ? details.progress.map(canonicalizeProgressForSignature) : null,
		async: details.async
			? { state: details.async.state, jobId: details.async.jobId, type: details.async.type }
			: null,
	};
}

function canonicalizeTaskResultForSignature(result: TaskToolDetails["results"][number]): unknown {
	// Completed results do not tick, but drop `durationMs` so the only time-derived
	// field in the receipt can never reintroduce idle churn.
	const { durationMs: _durationMs, ...rest } = result;
	return rest;
}
