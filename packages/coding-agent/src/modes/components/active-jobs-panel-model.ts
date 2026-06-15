/**
 * Pure model for the passive ActiveJobsPanel.
 *
 * No UI/Component/store dependencies: every function is a deterministic
 * transform over a `JobsSnapshot` plus an explicit `nowMs`, so terminal-TTL
 * filtering, collapsed-row capping, and expanded-window scrolling are all
 * unit-testable (including with fake timers). The component is a thin shell over
 * these helpers; it owns timers, polling, and rendering only.
 */
import type { CronJobView, JobsSnapshot, MonitorJobView } from "../jobs-observer";
import {
	compareCronsNewestFirst,
	compareMonitorsNewestFirst,
	formatRelative,
	formatRuntime,
	previewText,
} from "./jobs-format";

/** Max job rows shown in the collapsed panel before "+N more". */
export const COLLAPSED_JOB_ROW_CAP = 4;
/** How long a completed monitor row lingers after `endTime` before it drops. */
export const COMPLETED_MONITOR_VISIBLE_MS = 30_000;
/** How long a failed monitor row lingers after `endTime` (longer, so failures are noticed). */
export const FAILED_MONITOR_VISIBLE_MS = 300_000;
/** Max visible columns for a one-line prompt/label preview. */
export const PROMPT_PREVIEW_MAX = 60;
/** Poll cadence for expanded live monitor tails. */
export const TAIL_POLL_MS = 1_000;
/** Byte cap for each expanded monitor tail read. */
export const TAIL_MAX_BYTES = 8_192;
/** Line cap rendered per expanded monitor tail. */
export const TAIL_MAX_LINES_PER_MONITOR = 3;

export interface PanelRow {
	kind: "monitor" | "cron";
	id: string;
	text: string;
}

export interface CollapsedView {
	rows: PanelRow[];
	/** Count of visible jobs not shown because of the row cap (>= 0). */
	overflow: number;
	/** Total visible jobs (monitors + crons) after TTL filtering. */
	totalVisible: number;
}

export interface ExpandedRow {
	kind: "monitor" | "monitor-tail" | "cron";
	/** Job id (for tail rows, the owning monitor id). */
	id: string;
	text: string;
}

export interface ExpandedWindow {
	totalRows: number;
	visibleRows: ExpandedRow[];
	canScrollUp: boolean;
	canScrollDown: boolean;
	/** Monitor ids whose header is in the visible window (poll only these). */
	visibleMonitorTailIds: string[];
	/** The scrollOffset after clamping to [0, max(0, totalRows - heightBudget)]. */
	scrollOffset: number;
}

export interface FilteredJobs {
	monitors: MonitorJobView[];
	crons: CronJobView[];
}

/**
 * Whether a monitor row should currently be shown. Running/paused monitors are
 * always visible; terminal monitors linger for a status-dependent TTL measured
 * from `endTime`. A terminal monitor missing `endTime` is kept visible (we never
 * hide work we cannot prove has expired).
 */
export function isMonitorVisible(monitor: MonitorJobView, nowMs: number): boolean {
	if (monitor.status === "running" || monitor.status === "paused") return true;
	if (monitor.endTime === undefined) return true;
	const ttl = monitor.status === "failed" ? FAILED_MONITOR_VISIBLE_MS : COMPLETED_MONITOR_VISIBLE_MS;
	return nowMs - monitor.endTime < ttl;
}

/** Apply terminal TTL filtering to monitors; crons are always included. */
export function filterVisibleJobs(snapshot: JobsSnapshot, nowMs: number): FilteredJobs {
	return {
		monitors: snapshot.monitors.filter(m => isMonitorVisible(m, nowMs)).sort(compareMonitorsNewestFirst),
		crons: [...snapshot.crons].sort(compareCronsNewestFirst),
	};
}

/** True when at least one monitor or cron is currently visible (auto-show trigger). */
export function hasVisibleJobs(snapshot: JobsSnapshot, nowMs: number): boolean {
	const { monitors, crons } = filterVisibleJobs(snapshot, nowMs);
	return monitors.length > 0 || crons.length > 0;
}

function monitorRowText(monitor: MonitorJobView, nowMs: number, width?: number): string {
	const runtime = formatRuntime(monitor.startTime, monitor.endTime, nowMs);
	const text = `monitor · ${monitor.label} · ${monitor.status} · ${runtime}`;
	return width !== undefined ? previewText(text, width) : text.replace(/\s+/g, " ").trim();
}

function cronRowText(cron: CronJobView, nowMs: number, width?: number): string {
	const next = formatRelative(cron.nextFireAt, nowMs);
	const prompt = previewText(cron.prompt, PROMPT_PREVIEW_MAX);
	const text = `cron · ${cron.humanSchedule} · next ${next} · ${prompt}`;
	return width !== undefined ? previewText(text, width) : text.replace(/\s+/g, " ").trim();
}

/** Clamp the collapsed cap to the rows actually available (min 1 while any room). */
export function resolveCollapsedCap(availableRows: number): number {
	if (availableRows <= 0) return 0;
	return Math.min(COLLAPSED_JOB_ROW_CAP, Math.floor(availableRows));
}

/**
 * Build the collapsed panel rows: visible monitors (newest-first) then visible
 * crons (newest-first), capped at `cap` total rows with the remainder reported
 * as `overflow`.
 */
export function buildCollapsedRows(
	snapshot: JobsSnapshot,
	nowMs: number,
	opts: { cap?: number; width?: number } = {},
): CollapsedView {
	const cap = opts.cap ?? COLLAPSED_JOB_ROW_CAP;
	const { monitors, crons } = filterVisibleJobs(snapshot, nowMs);
	const all: PanelRow[] = [
		...monitors.map(m => ({ kind: "monitor" as const, id: m.id, text: monitorRowText(m, nowMs, opts.width) })),
		...crons.map(c => ({ kind: "cron" as const, id: c.id, text: cronRowText(c, nowMs, opts.width) })),
	];
	const totalVisible = all.length;
	const shown = cap <= 0 ? [] : all.slice(0, cap);
	return { rows: shown, overflow: Math.max(0, totalVisible - shown.length), totalVisible };
}

/** Clamp a scroll offset to a valid window start for the given totals. */
export function clampScrollOffset(scrollOffset: number, totalRows: number, heightBudget: number): number {
	const maxOffset = Math.max(0, totalRows - Math.max(0, heightBudget));
	return Math.min(Math.max(0, Math.floor(scrollOffset)), maxOffset);
}

/**
 * Build the expanded, windowed view over a flattened row model:
 *   [monitor header, ...its tail lines, monitor header, ..., cron, cron, ...]
 * Every monitor header and cron row is always present, so repeated scrolling
 * reaches every job. Tail rows appear only for monitors with lines in
 * `tailByMonitorId` (the component fills these for visible monitors over time).
 */
export function buildExpandedWindow(
	snapshot: JobsSnapshot,
	nowMs: number,
	scrollOffset: number,
	heightBudget: number,
	tailByMonitorId: Record<string, string[]> = {},
	width?: number,
): ExpandedWindow {
	const { monitors, crons } = filterVisibleJobs(snapshot, nowMs);
	const flat: ExpandedRow[] = [];
	for (const m of monitors) {
		flat.push({ kind: "monitor", id: m.id, text: monitorRowText(m, nowMs, width) });
		const lines = (tailByMonitorId[m.id] ?? []).slice(-TAIL_MAX_LINES_PER_MONITOR);
		for (const line of lines) {
			const rendered = `    ${line}`;
			flat.push({
				kind: "monitor-tail",
				id: m.id,
				text: width !== undefined ? previewText(rendered, width) : rendered,
			});
		}
	}
	for (const c of crons) {
		flat.push({ kind: "cron", id: c.id, text: cronRowText(c, nowMs, width) });
	}

	const totalRows = flat.length;
	const budget = Math.max(0, Math.floor(heightBudget));
	const offset = clampScrollOffset(scrollOffset, totalRows, budget);
	const end = offset + budget;
	const visibleRows = flat.slice(offset, end);
	const visibleMonitorTailIds: string[] = [];
	flat.forEach((row, index) => {
		if (row.kind === "monitor" && index >= offset && index < end) visibleMonitorTailIds.push(row.id);
	});

	return {
		totalRows,
		visibleRows,
		canScrollUp: offset > 0,
		canScrollDown: end < totalRows,
		visibleMonitorTailIds,
		scrollOffset: offset,
	};
}
