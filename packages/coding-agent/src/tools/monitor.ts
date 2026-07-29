import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@gajae-code/agent-core";
import { logger, prompt } from "@gajae-code/utils";
import * as z from "zod/v4";
import { AsyncJobManager, isBackgroundJobSupportEnabled } from "../async";
import monitorDescription from "../prompts/tools/monitor.md" with { type: "text" };
import { truncateTail } from "../session/streaming-output";
import { BashTool } from "./bash";
import type { ToolSession } from "./index";
import { ToolError } from "./tool-errors";

const monitorKindEnum = z.enum(["log", "poll", "watch", "other"]);
const monitorNotifyEnum = z.enum(["on_change", "every_line", "display_only"]);

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
	notify: monitorNotifyEnum
		.optional()
		.describe(
			"How persistent monitors deliver stdout lines. 'on_change' (default when persistent) coalesces within a debounce window and only enqueues when the normalized line changes, without starting a model turn for intermediate updates; process exit still wakes the agent. 'every_line' preserves legacy behavior (same-tick coalesce only, triggerTurn each flush). 'display_only' enqueues intermediate notifications without starting a turn; process exit still wakes the agent.",
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
const MONITOR_NOTIFICATION_LINE_MAX_BYTES = 16 * 1024;
const MONITOR_NOTIFICATION_LINE_MAX_LINES = 20;
/** Debounce window for persistent monitor intermediate flushes (on_change / display_only). */
const PERSISTENT_MONITOR_DEBOUNCE_MS = 2000;

function buildMonitorLabel(params: MonitorParams): string {
	const base = `[monitor:${params.kind}] ${params.description}`;
	if (base.length <= MONITOR_LABEL_MAX) return base;
	return `${base.slice(0, MONITOR_LABEL_MAX - 3)}...`;
}

function formatMonitorNotificationLine(line: string): {
	content: string;
	truncated: boolean;
	totalBytes: number;
	outputBytes: number;
} {
	const truncation = truncateTail(line, {
		maxBytes: MONITOR_NOTIFICATION_LINE_MAX_BYTES,
		maxLines: MONITOR_NOTIFICATION_LINE_MAX_LINES,
	});
	const outputBytes = truncation.outputBytes ?? truncation.totalBytes;
	if (!truncation.truncated) {
		return {
			content: truncation.content,
			truncated: false,
			totalBytes: truncation.totalBytes,
			outputBytes,
		};
	}
	const notice = `[Monitor output truncated: showing last ${outputBytes} of ${truncation.totalBytes} bytes]`;
	return {
		content: `${truncation.content}\n${notice}`,
		truncated: true,
		totalBytes: truncation.totalBytes,
		outputBytes,
	};
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
		// Omitted + persistent → on_change (rate-limited, no intermediate turns). Non-persistent
		// one-shots still wake on their single delivery; notify only shapes persistent delivery.
		const notifyMode = params.notify ?? (persistent ? "on_change" : "every_line");
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
		let debounceTimer: ReturnType<typeof setTimeout> | undefined;
		let lastDeliveredNormalized: string | undefined;
		let lastDeliveredLine: string | undefined;
		// Intermediate display-only deliveries do not start a turn; exit must still wake.
		let needsTerminalWake = false;
		// Count of notification *sends* (not live queue depth): once it exceeds the
		// cap, each new send first purges older queued notifications for this task,
		// keeping the queue bounded and latest-biased.
		let pendingNotifications = 0;
		const isMonitorMessage = (message: { customType?: string; details?: unknown }) =>
			message.customType === "task-notification" &&
			(message.details as { taskId?: string } | undefined)?.taskId === currentJobId;
		const clearDebounceTimer = () => {
			if (debounceTimer === undefined) return;
			clearTimeout(debounceTimer);
			debounceTimer = undefined;
		};
		const sendNotification = (line: string, jobId: string, count: number, triggerTurn: boolean) => {
			if (controller.closed) return;
			const notificationId = `${jobId}:${sequence}`;
			const suffix = count > 0 ? `\n(+${count} earlier lines)` : "";
			const notificationLine = formatMonitorNotificationLine(line);
			const content = `<task-notification>\nMonitor task ${jobId} (${params.kind}: ${params.description}) emitted latest state:\n${notificationLine.content}${suffix}\n</task-notification>`;
			const details = {
				taskId: jobId,
				kind: params.kind,
				description: params.description,
				monitor: true,
				notificationId,
				sequence,
				coalescedCount: count,
				outputTruncated: notificationLine.truncated,
				outputTotalBytes: notificationLine.totalBytes,
				outputBytes: notificationLine.outputBytes,
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
				{ triggerTurn, deliverAs: "followUp" },
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
			if (triggerTurn) {
				needsTerminalWake = false;
			} else {
				needsTerminalWake = true;
			}
		};
		const flushLatest = (terminal: boolean) => {
			clearDebounceTimer();
			flushScheduled = false;
			if (!persistent || latestLine === undefined) return;
			const line = latestLine;
			const count = coalescedCount;
			latestLine = undefined;
			coalescedCount = 0;
			const normalized = line.trim();
			// on_change: skip intermediate enqueue when content is unchanged after normalize/trim.
			// Terminal flush always delivers so process exit still wakes the agent.
			if (
				!terminal &&
				notifyMode === "on_change" &&
				lastDeliveredNormalized !== undefined &&
				normalized === lastDeliveredNormalized
			) {
				return;
			}
			lastDeliveredNormalized = normalized;
			lastDeliveredLine = line;
			// Intermediate: every_line wakes; on_change / display_only are display/queue only.
			// Terminal: always wake (including display_only) so exit/error transitions are prompt.
			const triggerTurn = terminal || notifyMode === "every_line";
			sendNotification(line, currentJobId, count, triggerTurn);
		};
		const closeMonitor = (mode: "purge" | "flush") => {
			// "flush" (natural process exit): deliver the newest pending line so the
			// final state is never lost, then stop. "purge" (explicit cancel / registry
			// eviction): drop the queued backlog. Non-persistent monitors keep their one
			// notification, so they never purge.
			if (mode === "flush") {
				if (latestLine !== undefined) {
					flushLatest(true);
				} else if (needsTerminalWake && lastDeliveredLine !== undefined) {
					// Debounce already delivered display-only intermediate state; still wake on exit.
					clearDebounceTimer();
					flushScheduled = false;
					sequence += 1;
					sendNotification(lastDeliveredLine, currentJobId, 0, true);
				} else {
					clearDebounceTimer();
					flushScheduled = false;
				}
				controller.closed = true;
				return;
			}
			clearDebounceTimer();
			flushScheduled = false;
			latestLine = undefined;
			coalescedCount = 0;
			needsTerminalWake = false;
			controller.closed = true;
			if (!persistent) return;
			return this.session.purgeQueuedCustomMessages?.(isMonitorMessage);
		};
		const schedulePersistentNotification = (line: string) => {
			latestLine = line;
			sequence += 1;
			coalescedCount += flushScheduled ? 1 : 0;
			if (flushScheduled) return;
			flushScheduled = true;
			// every_line: same-tick microtask coalesce only (legacy). Otherwise debounce.
			if (notifyMode === "every_line") {
				queueMicrotask(() => flushLatest(false));
				return;
			}
			debounceTimer = setTimeout(() => {
				debounceTimer = undefined;
				flushLatest(false);
			}, PERSISTENT_MONITOR_DEBOUNCE_MS);
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
					sendNotification(line, jobId, 0, true);
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
