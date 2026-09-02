import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@gajae-code/agent-core";
import { logger, prompt } from "@gajae-code/utils";
import * as z from "zod/v4";
import { AsyncJobManager, isBackgroundJobSupportEnabled } from "../async";
import monitorDescription from "../prompts/tools/monitor.md" with { type: "text" };
import { truncateTail } from "../session/streaming-output";
import { lookupOwnedRegistration } from "../session/terminal-abort";
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
const MONITOR_NOTIFICATION_LINE_MAX_BYTES = 16 * 1024;
const MONITOR_NOTIFICATION_LINE_MAX_LINES = 20;
const PERSISTENT_MONITOR_DEBOUNCE_MS = 250;

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
		toolCallId: string,
		params: MonitorParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<MonitorToolDetails>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<MonitorToolDetails>> {
		// The session's ENDPOINT-owned manager first: the monitor job is created
		// in it, its generation is read from it, and non-persistent cancel must
		// stop that exact job — the process-global instance may belong to a
		// different concurrent top-level session (review thread P1).
		const manager =
			this.session.getAsyncJobManager?.() ??
			AsyncJobManager.forEndpoint(this.session.getSessionId?.() ?? undefined) ??
			AsyncJobManager.instance();
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
		let flushTimer: NodeJS.Timeout | undefined;
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
			if (flushTimer) {
				clearTimeout(flushTimer);
				flushTimer = undefined;
			}
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
			const notificationLine = formatMonitorNotificationLine(line);
			const content = `<task-notification>\nMonitor task ${jobId} (${params.kind}: ${params.description}) emitted latest state:\n${notificationLine.content}${suffix}\n</task-notification>`;
			// Route the notification through the SAME owned-completion envelope
			// and fresh-admission path as async results: a scope:"turn" abort
			// that left this monitor running must resume the agent with a FRESH
			// lineage (never the aborted attempt's), and scope:"owned" must drop
			// it. The envelope is built from the tool-call lineage binding and
			// the exact registered tuple; monitors without a registration stay
			// ordinary. The standalone generation is NOT persisted — it lives in
			// the envelope, which INTERNAL_DETAILS_FIELDS strips (review threads
			// P1/P2).
			const generation = manager.getJob(jobId)?.generation;
			// Build the envelope from the RETAINED registration (which carries the
			// complete lineage tuple), not the tool-call binding: the binding map
			// is separately bounded and can evict a long-lived monitor's entry,
			// but the registration keeps the lineage for owned classification
			// (review thread P2).
			// The lookup is ENDPOINT-scoped to THIS monitor's session: concurrent
			// sessions have monitors with the same manager-local job id, and an
			// endpoint-less fallback scan could attach a foreign session's
			// registration (review thread P2).
			const registration = generation
				? lookupOwnedRegistration(jobId, generation, this.session.getSessionId?.() ?? "local")
				: undefined;
			const ownedCompletion = registration
				? {
						lineageIdHash: registration.lineageIdHash,
						promptAttemptEpoch: registration.promptAttemptEpoch,
						registration,
					}
				: undefined;
			const details = {
				taskId: jobId,
				...(ownedCompletion ? { ownedCompletions: [ownedCompletion] } : {}),
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
			void this.session
				.sendCustomMessage?.(
					{ customType: "task-notification", content, display: false, attribution: "agent", details },
					{ triggerTurn: true, deliverAs: "followUp" },
				)
				?.catch(error => {
					logger.warn("Monitor task-notification delivery failed", {
						error: error instanceof Error ? error.message : String(error),
					});
				});
		};
		const schedulePersistentNotification = (line: string) => {
			latestLine = line;
			sequence += 1;
			coalescedCount += flushScheduled ? 1 : 0;
			if (flushScheduled) return;
			flushScheduled = true;
			flushTimer = setTimeout(flushLatest, PERSISTENT_MONITOR_DEBOUNCE_MS);
		};
		const monitorJob = await bash.startMonitorJob(
			{ command: params.command, timeout: params.timeout },
			{
				ownerId,
				label,
				ctx: context,
				toolCallId,
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
