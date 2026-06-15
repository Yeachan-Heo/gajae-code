/**
 * Pure model helpers for the jobs overlay.
 *
 * Kept free of UI/Component dependencies so the grouping/ordering and
 * detail-formatting logic is unit-testable. The selector controller wires these
 * SelectItem lists into nested SelectLists (list -> detail -> confirm).
 *
 * Shared job reference / preview / relative-time helpers live in `jobs-format`
 * so the passive ActiveJobsPanel and this overlay cannot drift apart; they are
 * re-exported here for backward compatibility with existing imports.
 */
import type { SelectItem } from "@gajae-code/tui";
import type { JobsSnapshot } from "../jobs-observer";
import {
	formatRelative,
	type JobRef,
	type JobRefKind,
	PROMPT_PREVIEW_MAX,
	parseJobRef,
	previewText,
} from "./jobs-format";

export { formatRelative, type JobRef, type JobRefKind, parseJobRef };

const preview = previewText;

/**
 * Build the grouped jobs list: monitors first (newest-first), then crons
 * (newest-first). The snapshot arrays are already sorted newest-first.
 */
export function buildJobsListItems(snapshot: JobsSnapshot): SelectItem[] {
	const items: SelectItem[] = [];
	for (const monitor of snapshot.monitors) {
		items.push({
			value: `monitor:${monitor.id}`,
			label: `monitor · ${preview(monitor.label, 40)}`,
			description: monitor.status,
			hint: monitor.status === "failed" ? "failed" : undefined,
		});
	}
	for (const cron of snapshot.crons) {
		items.push({
			value: `cron:${cron.id}`,
			label: `cron · ${cron.humanSchedule}`,
			description: preview(cron.prompt),
		});
	}
	return items;
}

/**
 * Build the detail-level items for a job: read-only info rows (value "noop"),
 * then the destructive action, then a back row. `output` is the bounded monitor
 * output tail (ignored for cron jobs).
 */
export function buildJobDetailItems(snapshot: JobsSnapshot, ref: JobRef, output = ""): SelectItem[] {
	if (ref.kind === "monitor") {
		const monitor = snapshot.monitors.find(m => m.id === ref.id);
		if (!monitor) return [{ value: "back", label: "Back (job no longer present)" }];
		const lastOutput = output.trim().split("\n").filter(Boolean).slice(-1)[0] ?? "(no output captured)";
		return [
			{ value: "noop", label: "Status", description: monitor.status },
			{ value: "noop", label: "Label", description: preview(monitor.label) },
			{ value: "noop", label: "Started", description: formatRelative(monitor.startTime) },
			{ value: "noop", label: "Output", description: preview(lastOutput, 80) },
			{ value: "action:cancel", label: "Cancel this monitor", hint: "stops the running job" },
			{ value: "back", label: "Back" },
		];
	}
	const cron = snapshot.crons.find(c => c.id === ref.id);
	if (!cron) return [{ value: "back", label: "Back (job no longer present)" }];
	return [
		{ value: "noop", label: "Schedule", description: `${cron.humanSchedule} (${cron.cronExpression})` },
		{ value: "noop", label: "Recurring", description: cron.recurring ? "yes" : "no" },
		{ value: "noop", label: "Next fire", description: formatRelative(cron.nextFireAt) },
		{ value: "noop", label: "Prompt", description: preview(cron.prompt, 80) },
		{ value: "action:delete", label: "Delete this cron", hint: "removes the schedule" },
		{ value: "back", label: "Back" },
	];
}

/** Yes/No confirm items for a destructive action. */
export function buildConfirmItems(actionLabel: string): SelectItem[] {
	return [
		{ value: "no", label: `No, keep it` },
		{ value: "yes", label: `Yes, ${actionLabel}` },
	];
}

export { PROMPT_PREVIEW_MAX };
