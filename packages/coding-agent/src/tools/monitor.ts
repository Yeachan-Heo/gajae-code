import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@gajae-code/agent-core";
import { logger, prompt } from "@gajae-code/utils";
import * as z from "zod/v4";
import { AsyncJobManager, isBackgroundJobSupportEnabled } from "../async";
import monitorDescription from "../prompts/tools/monitor.md" with { type: "text" };
import { BashTool } from "./bash";
import type { ToolSession } from "./index";
import { ToolError } from "./tool-errors";

const monitorKindEnum = z.enum(["log", "poll", "watch", "other"]);

const monitorSchema = z.object({
	command: z
		.string()
		.describe(
			"Shell command to run as a background monitor. Each stdout line is delivered as a separate task-notification event.",
		),
	kind: monitorKindEnum.describe(
		"Category of monitor. 'log' tails a log file, 'poll' polls a status endpoint, 'watch' watches a directory, 'other' for arbitrary streams.",
	),
	description: z
		.string()
		.describe("Short human-readable description of what is being monitored. Appears in task listings."),
	timeout: z
		.number()
		.min(1)
		.optional()
		.describe(
			"Optional maximum wall-clock seconds the monitor may run before automatic shutdown. Omit for indefinite (subject to session lifetime).",
		),
	persistent: z
		.boolean()
		.optional()
		.describe(
			"Whether to keep the monitor running past the originating turn. Persistent monitors survive until session end or explicit kill via the background-task stop tool.",
		),
});

export type MonitorParams = z.infer<typeof monitorSchema>;

export interface MonitorToolDetails {
	taskId: string;
	kind: z.infer<typeof monitorKindEnum>;
	description: string;
	command: string;
	persistent: boolean;
}

const MONITOR_LABEL_MAX = 120;
const MAX_PENDING_MONITOR_NOTIFICATIONS = 3;

function buildMonitorLabel(params: MonitorParams): string {
	const base = `[monitor:${params.kind}] ${params.description}`;
	if (base.length <= MONITOR_LABEL_MAX) return base;
	return `${base.slice(0, MONITOR_LABEL_MAX - 3)}...`;
}

export class MonitorTool implements AgentTool<typeof monitorSchema, MonitorToolDetails> {
	readonly name = "monitor";
	readonly label = "Monitor";
	readonly summary = "Start a background monitor that streams stdout lines as task notifications";
	readonly description: string;
	readonly parameters = monitorSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(monitorDescription);
	}

	static createIf(session: ToolSession): MonitorTool | null {
		if (!isBackgroundJobSupportEnabled(session.settings)) return null;
		return new MonitorTool(session);
	}

	async execute(
		_toolCallId: string,
		params: MonitorParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<MonitorToolDetails>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<MonitorToolDetails>> {
		const manager = AsyncJobManager.instance();
		if (!manager) {
			throw new ToolError("Async execution is disabled; the monitor tool is unavailable in this session.");
		}

		const persistent = params.persistent ?? false;
		const label = buildMonitorLabel(params);
		const ownerId = this.session.getAgentId?.() ?? undefined;
		const bash = new BashTool(this.session);
		let deliveredFirstLine = false;
		const controller = { closed: false };
		let currentJobId = "";
		let sequence = 0;
		let latestLine: string | undefined;
		let coalescedCount = 0;
		let flushScheduled = false;
		// Count of notification *sends* (not live queue depth): once it exceeds the
		// cap, each new send first purges older queued notifications for this task,
		// keeping the queue bounded and latest-biased.
		let pendingNotifications = 0;
		const isMonitorMessage = (message: { customType?: string; details?: unknown }) =>
			message.customType === "task-notification" &&
			(message.details as { taskId?: string } | undefined)?.taskId === currentJobId;
		const flushLatest = () => {
			if (!persistent || latestLine === undefined) return;
			const line = latestLine;
			const count = coalescedCount;
			latestLine = undefined;
			coalescedCount = 0;
			flushScheduled = false;
			sendNotification(line, currentJobId, count);
		};
		const closeMonitor = (mode: "purge" | "flush") => {
			// "flush" (natural process exit): deliver the newest pending line so the
			// final state is never lost, then stop. "purge" (explicit cancel / registry
			// eviction): drop the queued backlog. Non-persistent monitors keep their one
			// notification, so they never purge.
			if (mode === "flush") {
				flushLatest();
				controller.closed = true;
				return;
			}
			controller.closed = true;
			if (!persistent) return;
			return this.session.purgeQueuedCustomMessages?.(isMonitorMessage);
		};
		const sendNotification = (line: string, jobId: string, count: number) => {
			if (controller.closed) return;
			const notificationId = `${jobId}:${sequence}`;
			const suffix = count > 0 ? `\n(+${count} earlier lines)` : "";
			const content = `<task-notification>\nMonitor task ${jobId} (${params.kind}: ${params.description}) emitted latest state:\n${line}${suffix}\n</task-notification>`;
			const details = {
				taskId: jobId,
				kind: params.kind,
				description: params.description,
				monitor: true,
				notificationId,
				sequence,
				coalescedCount: count,
			};
			pendingNotifications += 1;
			if (pendingNotifications > MAX_PENDING_MONITOR_NOTIFICATIONS) {
				this.session.purgeQueuedCustomMessages?.(
					m =>
						m.customType === "task-notification" &&
						(m.details as { taskId?: string; notificationId?: string } | undefined)?.taskId === jobId &&
						(m.details as { notificationId?: string } | undefined)?.notificationId !== notificationId,
				);
				pendingNotifications = MAX_PENDING_MONITOR_NOTIFICATIONS;
			}
			const sendPromise = this.session.sendCustomMessage?.(
				{ customType: "task-notification", content, display: false, attribution: "agent", details },
				{ triggerTurn: true, deliverAs: "followUp" },
			);
			if (sendPromise) {
				void sendPromise.catch(error => {
					logger.warn("Monitor task-notification delivery failed", {
						error: error instanceof Error ? error.message : String(error),
					});
				});
			} else {
				this.session.steer?.({ customType: "task-notification", content, details });
			}
		};
		const schedulePersistentNotification = (line: string) => {
			latestLine = line;
			sequence += 1;
			coalescedCount += flushScheduled ? 1 : 0;
			if (flushScheduled) return;
			flushScheduled = true;
			queueMicrotask(flushLatest);
		};
		const monitorJob = await bash.startMonitorJob(
			{ command: params.command, timeout: params.timeout },
			{
				ownerId,
				label,
				ctx: context,
				shouldAcceptRawLine: () => !controller.closed,
				lifecycle: {
					onCancel: () => closeMonitor("purge"),
					onTerminal: () => closeMonitor("flush"),
					onEvict: () => closeMonitor("purge"),
					onTombstonePurge: () => closeMonitor("purge"),
				},
				onRawLine: (line, jobId) => {
					if (controller.closed) return;
					currentJobId = jobId;
					if (!persistent && deliveredFirstLine) return;
					deliveredFirstLine = true;
					if (persistent) {
						schedulePersistentNotification(line);
						return;
					}
					sendNotification(line, jobId, 0);
					manager.cancel(jobId, ownerId ? { ownerId } : undefined);
				},
			},
		);
		currentJobId = monitorJob.jobId;

		const startedText = `Monitor started · task ${monitorJob.jobId} · persistent: ${persistent}`;

		return {
			content: [{ type: "text", text: startedText }],
			details: {
				taskId: monitorJob.jobId,
				kind: params.kind,
				description: params.description,
				command: params.command,
				persistent,
			},
		};
	}
}
