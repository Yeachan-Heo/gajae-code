import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@gajae-code/agent-core";
import type { Component } from "@gajae-code/tui";
import { Text } from "@gajae-code/tui";
import { prompt } from "@gajae-code/utils";
import * as z from "zod/v4";
import { type AsyncJob, AsyncJobManager, isBackgroundJobSupportEnabled } from "../async";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import jobDescription from "../prompts/tools/job.md" with { type: "text" };
import { Ellipsis, Hasher, type RenderCache, renderStatusLine, renderTreeList, truncateToWidth } from "../tui";
import type { ToolSession } from "./index";
import {
	formatBadge,
	formatDuration,
	formatEmptyMessage,
	formatStatusIcon,
	getPreviewLines,
	PREVIEW_LIMITS,
	replaceTabs,
	type ToolUIColor,
	type ToolUIStatus,
} from "./render-utils";
import { ToolError } from "./tool-errors";

const jobSchema = z.object({
	poll: z.array(z.string()).optional().describe("job ids to wait for"),
	cancel: z.array(z.string()).optional().describe("job ids to cancel"),
	list: z.boolean().optional().describe("snapshot all jobs"),
});

type JobParams = z.infer<typeof jobSchema>;

const WAIT_DURATION_MS: Record<string, number> = {
	"5s": 5_000,
	"10s": 10_000,
	"30s": 30_000,
	"1m": 60_000,
	"5m": 5 * 60_000,
};

function parseWaitDurationMs(value: string | undefined): number {
	return (value ? WAIT_DURATION_MS[value] : undefined) ?? WAIT_DURATION_MS["30s"];
}

interface JobSnapshot {
	id: string;
	type: "bash" | "task";
	status: "running" | "completed" | "failed" | "cancelled";
	label: string;
	durationMs: number;
	resultText?: string;
	errorText?: string;
}

type CancelStatus = "cancelled" | "not_found" | "already_completed" | "already_cancelled";

interface CancelOutcome {
	id: string;
	status: CancelStatus;
	message: string;
}

export interface JobToolDetails {
	jobs: JobSnapshot[];
	cancelled?: { id: string; status: CancelStatus }[];
}

export class JobTool implements AgentTool<typeof jobSchema, JobToolDetails> {
	readonly name = "job";
	readonly label = "Job";
	readonly summary = "Manage long-running background jobs (async bash/python)";
	readonly description: string;
	readonly parameters = jobSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(jobDescription);
	}

	static createIf(session: ToolSession): JobTool | null {
		if (!isBackgroundJobSupportEnabled(session.settings)) return null;
		return new JobTool(session);
	}

	async execute(
		_toolCallId: string,
		params: JobParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<JobToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<JobToolDetails>> {
		const manager = AsyncJobManager.instance();
		if (!manager) {
			return {
				content: [{ type: "text", text: "Async execution is disabled; no background jobs are available." }],
				details: { jobs: [] },
			};
		}

		// Scope every visible operation to the calling agent. Tests / SDK
		// consumers without an agent id see everything (legacy behavior).
		const ownerId = this.session.getAgentId?.() ?? undefined;
		const ownerFilter = ownerId ? { ownerId } : undefined;

		// `list` is a read-only snapshot mode. Replaces the legacy `jobs://` URL.
		if (params.list) {
			if (params.cancel?.length || params.poll?.length) {
				throw new ToolError("`list` cannot be combined with `poll` or `cancel`.");
			}
			return this.#buildResult(manager, manager.getAllJobs(ownerFilter), []);
		}

		const cancelIds = params.cancel ?? [];
		const cancelOutcomes: CancelOutcome[] = [];
		for (const id of cancelIds) {
			const existing = manager.getJob(id);
			if (!existing || (ownerId && existing.ownerId !== ownerId)) {
				const tombstone = manager.purgeMonitorTombstone(id, ownerFilter);
				cancelOutcomes.push(
					tombstone.found
						? {
								id,
								status: tombstone.status === "cancelled" ? "already_cancelled" : "already_completed",
								message: `Monitor job ${id} already gone; purged queued notifications.`,
							}
						: { id, status: "not_found", message: `Background job not found: ${id}` },
				);
				continue;
			}
			if (existing.status !== "running") {
				if (existing.metadata?.monitor) manager.purgeMonitorTombstone(id, ownerFilter);
				cancelOutcomes.push({
					id,
					status: "already_completed",
					message: `Background job ${id} is already ${existing.status}.`,
				});
				continue;
			}
			const cancelled = manager.cancel(id, ownerFilter);
			cancelOutcomes.push(
				cancelled
					? { id, status: "cancelled", message: `Cancelled background job ${id}.` }
					: { id, status: "already_completed", message: `Background job ${id} is already completed.` },
			);
		}

		const requestedPollIds = params.poll;
		// If only `cancel` was provided (no `poll`), don't wait \u2014 return immediately.
		const shouldPoll = requestedPollIds !== undefined || cancelIds.length === 0;

		if (!shouldPoll) {
			const cancelledJobs = this.#visibleJobs(manager, cancelIds, ownerId);
			return this.#buildResult(manager, cancelledJobs, cancelOutcomes);
		}

		// Resolve which jobs to watch.
		// - If `poll` was passed explicitly, watch exactly those (filtered to existing).
		// - If `poll` was omitted (and so was `cancel`), default to all running jobs.
		const jobsToWatch = requestedPollIds
			? this.#visibleJobs(manager, requestedPollIds, ownerId)
			: manager.getRunningJobs(ownerFilter);

		if (jobsToWatch.length === 0) {
			if (cancelOutcomes.length > 0) {
				const cancelledJobs = this.#visibleJobs(manager, cancelIds, ownerId);
				return this.#buildResult(manager, cancelledJobs, cancelOutcomes);
			}
			const message = requestedPollIds?.length
				? `No matching jobs found for IDs: ${requestedPollIds.join(", ")}`
				: "No running background jobs to wait for.";
			return {
				content: [{ type: "text", text: message }],
				details: { jobs: [] },
			};
		}

		// If all watched jobs are already done, build immediate result.
		const runningJobs = jobsToWatch.filter(j => j.status === "running");
		if (runningJobs.length === 0) {
			const cancelledJobs = cancelIds.map(id => manager.getJob(id)).filter(j => j != null);
			return this.#buildResult(manager, [...cancelledJobs, ...jobsToWatch], cancelOutcomes);
		}

		// Wait until at least one running job finishes, the wait duration elapses, or the call is aborted.
		const racePromises: Promise<unknown>[] = runningJobs.map(j => j.promise);
		const waitMs = parseWaitDurationMs(this.session.settings.get("async.pollWaitDuration"));
		const { promise: timeoutPromise, resolve: timeoutResolve } = Promise.withResolvers<void>();
		const timeoutHandle = setTimeout(() => timeoutResolve(), waitMs);
		racePromises.push(timeoutPromise);

		const watchedJobIds = runningJobs.map(job => job.id);
		manager.watchJobs(watchedJobIds);

		const cancelledJobs = this.#visibleJobs(manager, cancelIds, ownerId);
		const allTrackedJobs = [...cancelledJobs, ...jobsToWatch];

		const PROGRESS_INTERVAL_MS = 500;
		const emitProgress = () => {
			if (!onUpdate) return;
			const snapshot = this.#snapshotJobs(allTrackedJobs);
			onUpdate({
				content: [{ type: "text", text: "" }],
				details: {
					jobs: snapshot,
					...(cancelOutcomes.length
						? { cancelled: cancelOutcomes.map(({ id, status }) => ({ id, status })) }
						: {}),
				},
			});
		};
		const progressTimer = onUpdate ? setInterval(emitProgress, PROGRESS_INTERVAL_MS) : undefined;
		emitProgress();

		try {
			if (signal) {
				const { promise: abortPromise, resolve: abortResolve } = Promise.withResolvers<void>();
				const onAbort = () => abortResolve();
				signal.addEventListener("abort", onAbort, { once: true });
				racePromises.push(abortPromise);
				try {
					await Promise.race(racePromises);
				} finally {
					signal.removeEventListener("abort", onAbort);
				}
			} else {
				await Promise.race(racePromises);
			}
		} finally {
			manager.unwatchJobs(watchedJobIds);
			clearTimeout(timeoutHandle);
			if (progressTimer) clearInterval(progressTimer);
		}

		return this.#buildResult(manager, allTrackedJobs, cancelOutcomes);
	}

	/**
	 * Resolve a list of job ids to job records visible to the calling agent.
	 * Drops missing ids and ids owned by other agents, so cross-agent inspection
	 * via the `job` tool is impossible.
	 */
	#visibleJobs(manager: AsyncJobManager, ids: string[], ownerId: string | undefined): AsyncJob[] {
		const out: AsyncJob[] = [];
		for (const id of ids) {
			const job = manager.getJob(id);
			if (!job) continue;
			if (ownerId && job.ownerId !== ownerId) continue;
			out.push(job);
		}
		return out;
	}

	#snapshotJobs(
		jobs: {
			id: string;
			type: "bash" | "task";
			status: string;
			label: string;
			startTime: number;
			resultText?: string;
			errorText?: string;
		}[],
	): JobSnapshot[] {
		const now = Date.now();
		return jobs.map(j => {
			const current = AsyncJobManager.instance()?.getJob(j.id);
			const latest = current ?? j;
			return {
				id: latest.id,
				type: latest.type,
				status: latest.status as JobSnapshot["status"],
				label: latest.label,
				durationMs: Math.max(0, now - latest.startTime),
				...(latest.resultText ? { resultText: latest.resultText } : {}),
				...(latest.errorText ? { errorText: latest.errorText } : {}),
			};
		});
	}

	#buildResult(
		manager: AsyncJobManager,
		jobs: {
			id: string;
			type: "bash" | "task";
			status: string;
			label: string;
			startTime: number;
			resultText?: string;
			errorText?: string;
		}[],
		cancelOutcomes: CancelOutcome[],
	): AgentToolResult<JobToolDetails> {
		// Deduplicate by id (cancelled jobs may also appear in the watched set).
		const seen = new Set<string>();
		const uniqueJobs = jobs.filter(j => {
			if (seen.has(j.id)) return false;
			seen.add(j.id);
			return true;
		});
		const jobResults = this.#snapshotJobs(uniqueJobs);

		manager.acknowledgeDeliveries(jobResults.filter(j => j.status !== "running").map(j => j.id));

		const completed = jobResults.filter(j => j.status !== "running");
		const running = jobResults.filter(j => j.status === "running");

		const lines: string[] = [];

		if (cancelOutcomes.length > 0) {
			lines.push(`## Cancelled (${cancelOutcomes.length})\n`);
			for (const o of cancelOutcomes) lines.push(`- ${o.message}`);
			lines.push("");
		}

		if (completed.length > 0) {
			lines.push(`## Completed (${completed.length})\n`);
			for (const j of completed) {
				lines.push(`### ${j.id} [${j.type}] — ${j.status}`);
				lines.push(`Label: ${j.label}`);
				if (j.resultText) {
					lines.push("```", j.resultText, "```");
				}
				if (j.errorText) {
					lines.push(`Error: ${j.errorText}`);
				}
				lines.push("");
			}
		}

		if (running.length > 0) {
			lines.push(`## Still Running (${running.length})\n`);
			for (const j of running) {
				lines.push(`- \`${j.id}\` [${j.type}] — ${j.label}`);
			}
		}

		return {
			content: [{ type: "text", text: lines.join("\n").trimEnd() }],
			details: {
				jobs: jobResults,
				...(cancelOutcomes.length ? { cancelled: cancelOutcomes.map(({ id, status }) => ({ id, status })) } : {}),
			},
		};
	}
}

// =============================================================================
// TUI Renderer
// =============================================================================

interface JobRenderArgs {
	poll?: string[];
	cancel?: string[];
}

const COLLAPSED_LIST_LIMIT = PREVIEW_LIMITS.COLLAPSED_ITEMS;
const LABEL_MAX_WIDTH = 60;
const PREVIEW_LINES_COLLAPSED = 1;
const PREVIEW_LINES_EXPANDED = 4;
const LABEL_LINES_COLLAPSED = 1;
const LABEL_LINES_EXPANDED = 3;
const PREVIEW_LINE_WIDTH = 80;

function statusToIcon(status: JobSnapshot["status"]): ToolUIStatus {
	switch (status) {
		case "completed":
			return "success";
		case "failed":
			return "error";
		case "cancelled":
			return "aborted";
		case "running":
			return "running";
	}
}

function statusToColor(status: JobSnapshot["status"]): ToolUIColor {
	switch (status) {
		case "completed":
			return "success";
		case "failed":
			return "error";
		case "cancelled":
			return "warning";
		case "running":
			return "accent";
	}
}

function describeTarget(args: JobRenderArgs | undefined): string {
	const poll = args?.poll ?? [];
	const cancel = args?.cancel ?? [];
	const parts: string[] = [];
	if (cancel.length > 0) {
		parts.push(cancel.length === 1 ? `cancel ${cancel[0]}` : `cancel ${cancel.length} jobs`);
	}
	if (poll.length > 0) {
		parts.push(poll.length === 1 ? `poll ${poll[0]}` : `poll ${poll.length} jobs`);
	}
	if (parts.length === 0) return "all running jobs";
	return parts.join(", ");
}

export const jobToolRenderer = {
	inline: true,

	renderCall(args: JobRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const text = renderStatusLine({ icon: "pending", title: "Job", description: describeTarget(args) }, uiTheme);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: JobToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: JobRenderArgs,
	): Component {
		const jobs = result.details?.jobs ?? [];

		if (jobs.length === 0) {
			const fallback = result.content?.find(c => c.type === "text")?.text || "No jobs to process";
			const header = renderStatusLine({ icon: "warning", title: "Job", description: describeTarget(args) }, uiTheme);
			return new Text([header, formatEmptyMessage(fallback, uiTheme)].join("\n"), 0, 0);
		}

		const counts = { completed: 0, failed: 0, cancelled: 0, running: 0 };
		for (const job of jobs) counts[job.status]++;

		const meta: string[] = [];
		if (counts.completed > 0) meta.push(uiTheme.fg("success", `${counts.completed} done`));
		if (counts.failed > 0) meta.push(uiTheme.fg("error", `${counts.failed} failed`));
		if (counts.cancelled > 0) meta.push(uiTheme.fg("warning", `${counts.cancelled} cancelled`));
		if (counts.running > 0) meta.push(uiTheme.fg("accent", `${counts.running} running`));

		const headerIcon: ToolUIStatus = counts.failed > 0 ? "warning" : counts.running > 0 ? "info" : "success";
		const description =
			counts.running > 0
				? `waiting on ${counts.running} of ${jobs.length}`
				: `${jobs.length} ${jobs.length === 1 ? "job" : "jobs"} settled`;

		const header = renderStatusLine(
			{
				icon: headerIcon,
				spinnerFrame: counts.running > 0 ? options.spinnerFrame : undefined,
				title: "Job",
				description,
				meta,
			},
			uiTheme,
		);

		// Sort: running first (so user sees what's still pending), then failed, then completed/cancelled.
		const statusOrder: Record<JobSnapshot["status"], number> = {
			running: 0,
			failed: 1,
			cancelled: 2,
			completed: 3,
		};
		const sortedJobs = [...jobs].sort((a, b) => {
			const diff = statusOrder[a.status] - statusOrder[b.status];
			if (diff !== 0) return diff;
			return b.durationMs - a.durationMs;
		});

		let cached: RenderCache | undefined;
		return {
			render(width: number): string[] {
				const expanded = options.expanded;
				const spinnerFrame = options.spinnerFrame ?? 0;
				const key = new Hasher().bool(expanded).u32(width).u32(spinnerFrame).digest();
				if (cached?.key === key) return cached.lines;

				const itemLines = renderTreeList<JobSnapshot>(
					{
						items: sortedJobs,
						expanded,
						maxCollapsed: COLLAPSED_LIST_LIMIT,
						itemType: "job",
						renderItem: job => {
							const lines: string[] = [];
							const icon = formatStatusIcon(
								statusToIcon(job.status),
								uiTheme,
								job.status === "running" ? options.spinnerFrame : undefined,
							);
							const typeBadge = formatBadge(job.type, statusToColor(job.status), uiTheme);
							const idText = uiTheme.fg("muted", job.id);
							const rawLabelLines = (job.label || "(no label)").split(/\r?\n/);
							const maxLabelLines = expanded ? LABEL_LINES_EXPANDED : LABEL_LINES_COLLAPSED;
							const visibleLabelLines = rawLabelLines
								.slice(0, maxLabelLines)
								.map(l => truncateToWidth(replaceTabs(l), LABEL_MAX_WIDTH, Ellipsis.Unicode));
							if (rawLabelLines.length > maxLabelLines && visibleLabelLines.length > 0) {
								const last = visibleLabelLines[visibleLabelLines.length - 1]!;
								visibleLabelLines[visibleLabelLines.length - 1] = `${last} …`;
							}
							const durationText = uiTheme.fg("dim", formatDuration(job.durationMs));
							const headLabel = uiTheme.fg("toolOutput", visibleLabelLines[0] ?? "");
							lines.push(`${icon} ${idText} ${typeBadge} ${headLabel} ${durationText}`);
							for (let i = 1; i < visibleLabelLines.length; i++) {
								lines.push(`  ${uiTheme.fg("toolOutput", visibleLabelLines[i]!)}`);
							}

							const preview = job.errorText?.trim() || job.resultText?.trim();
							if (preview) {
								const maxLines = expanded ? PREVIEW_LINES_EXPANDED : PREVIEW_LINES_COLLAPSED;
								const previewLines = getPreviewLines(preview, maxLines, PREVIEW_LINE_WIDTH, Ellipsis.Unicode);
								const tone = job.errorText ? "error" : "dim";
								for (const pl of previewLines) {
									lines.push(`  ${uiTheme.fg(tone, pl)}`);
								}
							}
							return lines;
						},
					},
					uiTheme,
				);

				const all = [header, ...itemLines].map(l => truncateToWidth(l, width, Ellipsis.Unicode));
				cached = { key, lines: all };
				return all;
			},
			invalidate() {
				cached = undefined;
			},
		};
	},

	mergeCallAndResult: true,
};
