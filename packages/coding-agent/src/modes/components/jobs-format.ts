/**
 * Shared, pure formatting/ordering helpers for the background-jobs surfaces
 * (the alt+j manage overlay and the passive ActiveJobsPanel).
 *
 * Kept free of UI/Component and store dependencies so both surfaces share one
 * source of truth for job references, text previews, relative/runtime time, and
 * newest-first ordering — preventing label/format drift between the two views.
 */
import type { CronJobView, MonitorJobView } from "../jobs-observer";

export type JobRefKind = "monitor" | "cron";

export interface JobRef {
	kind: JobRefKind;
	id: string;
}

/** Default max visible columns for a one-line prompt/label preview. */
export const PROMPT_PREVIEW_MAX = 60;

/**
 * Collapse whitespace and clip to `max` visible columns, appending an ellipsis
 * when clipped. Pure and width-bounded so callers can pre-truncate untrusted
 * text before building wrapping Text nodes.
 */
export function previewText(text: string, max = PROMPT_PREVIEW_MAX): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	if (max <= 0) return "";
	return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** Compact relative time, e.g. "in 5m", "2m ago", "now", "—" when unknown. */
export function formatRelative(targetMs: number | undefined, nowMs = Date.now()): string {
	if (targetMs === undefined) return "—";
	const deltaMs = targetMs - nowMs;
	const abs = Math.abs(deltaMs);
	const mins = Math.round(abs / 60_000);
	if (mins < 1) return "now";
	const unit = mins >= 60 ? `${Math.round(mins / 60)}h` : `${mins}m`;
	return deltaMs >= 0 ? `in ${unit}` : `${unit} ago`;
}

/**
 * Compact elapsed runtime for a job, frozen once it stops running. While the job
 * is active (`endTime` undefined) this counts against `nowMs`; after it stops it
 * returns the fixed `endTime - startTime` span. Mirrors `jobElapsedMs` so a
 * terminal job's runtime label does not keep growing.
 */
export function formatRuntime(startTime: number, endTime?: number, nowMs = Date.now()): string {
	const elapsedMs = Math.max(0, (endTime ?? nowMs) - startTime);
	const secs = Math.floor(elapsedMs / 1000);
	if (secs < 60) return `${secs}s`;
	const mins = Math.floor(secs / 60);
	if (mins < 60) return `${mins}m`;
	const hours = Math.floor(mins / 60);
	const remMins = mins % 60;
	return remMins > 0 ? `${hours}h${remMins}m` : `${hours}h`;
}

/** Parse a `${kind}:${id}` list item value back into a job reference. */
export function parseJobRef(value: string): JobRef | null {
	const sep = value.indexOf(":");
	if (sep === -1) return null;
	const kind = value.slice(0, sep);
	const id = value.slice(sep + 1);
	if ((kind === "monitor" || kind === "cron") && id.length > 0) {
		return { kind, id };
	}
	return null;
}

/** Stable serialization of a job reference (inverse of `parseJobRef`). */
export function formatJobRef(ref: JobRef): string {
	return `${ref.kind}:${ref.id}`;
}

/** Comparator: monitors newest-first by descending `startTime`. */
export function compareMonitorsNewestFirst(a: MonitorJobView, b: MonitorJobView): number {
	return b.startTime - a.startTime;
}

/** Comparator: crons newest-first by descending `createdAt`. */
export function compareCronsNewestFirst(a: CronJobView, b: CronJobView): number {
	return b.createdAt - a.createdAt;
}
