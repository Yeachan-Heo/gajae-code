/**
 * Passive, read-only inline panel that visualizes active monitor/cron jobs
 * directly below the input. It auto-surfaces whenever the filtered snapshot has
 * any visible job and hides otherwise; it never offers destructive actions
 * (those stay in the alt+j / `/monitors` manage overlay) and never acknowledges
 * failures.
 *
 * Rendering and visibility derive entirely from the pure model in
 * `active-jobs-panel-model`. The component owns only side effects: a
 * minute-boundary label refresh while visible and a bounded live-tail poll while
 * expanded (visible monitor rows only).
 */
import { Container } from "@gajae-code/tui";
import type { AsyncJobOutputSlice, AsyncJobOutputTailOptions } from "../../async";
import { EMPTY_JOBS_SNAPSHOT, type JobsSnapshot } from "../jobs-observer";
import {
	buildCollapsedRows,
	buildExpandedWindow,
	COLLAPSED_JOB_ROW_CAP,
	COMPLETED_MONITOR_VISIBLE_MS,
	clampScrollOffset,
	FAILED_MONITOR_VISIBLE_MS,
	filterVisibleJobs,
	hasVisibleJobs,
	TAIL_MAX_BYTES,
	TAIL_MAX_LINES_PER_MONITOR,
	TAIL_POLL_MS,
} from "./active-jobs-panel-model";

/** Read-only data access the panel needs (a `JobsObserver` subset). */
export interface ActiveJobsPanelController {
	getSnapshot(): JobsSnapshot;
	getMonitorOutputTail(id: string, options: AsyncJobOutputTailOptions): AsyncJobOutputSlice | undefined;
}

export interface ActiveJobsPanelCallbacks {
	requestRender(): void;
	/** Injectable clock for deterministic tests; defaults to Date.now. */
	now?(): number;
}

/** Default max rows the expanded panel may occupy (interactive-mode tightens this from terminal height). */
const DEFAULT_MAX_ROWS = 10;
const MS_PER_MINUTE = 60_000;

export class ActiveJobsPanelComponent extends Container {
	readonly #controller: ActiveJobsPanelController;
	readonly #requestRender: () => void;
	readonly #now: () => number;

	#snapshot: JobsSnapshot = EMPTY_JOBS_SNAPSHOT;
	#expanded = false;
	#scrollOffset = 0;
	#maxRows = DEFAULT_MAX_ROWS;
	#disposed = false;
	/** Cached last-N tail lines per monitor id (only for visible expanded rows). */
	readonly #tailLines = new Map<string, string[]>();
	#visibleMonitorIds: string[] = [];
	#labelTimer: ReturnType<typeof setTimeout> | undefined;
	#tailTimer: ReturnType<typeof setInterval> | undefined;

	constructor(controller: ActiveJobsPanelController, callbacks: ActiveJobsPanelCallbacks) {
		super();
		this.#controller = controller;
		this.#requestRender = callbacks.requestRender;
		this.#now = callbacks.now ?? Date.now;
		this.#snapshot = controller.getSnapshot();
		this.#syncTimers();
	}

	/** Update the data snapshot; collapses + clears tails when nothing is visible. */
	setSnapshot(snapshot: JobsSnapshot): void {
		this.#snapshot = snapshot;
		if (!this.isVisible()) {
			this.#expanded = false;
			this.#scrollOffset = 0;
			this.#tailLines.clear();
			this.#visibleMonitorIds = [];
		}
		this.#syncTimers();
		this.#requestRender();
	}

	/** Tighten the max panel height (interactive-mode feeds this from terminal rows). */
	setMaxRows(rows: number): void {
		this.#maxRows = Math.max(1, Math.floor(rows));
	}

	isVisible(): boolean {
		return hasVisibleJobs(this.#snapshot, this.#now());
	}

	isExpanded(): boolean {
		return this.#expanded;
	}

	/** ctrl+up: expand from collapsed, else scroll up one row. */
	onExpandUp(): void {
		if (this.#disposed || !this.isVisible()) return;
		if (!this.#expanded) {
			this.#expanded = true;
			this.#scrollOffset = 0;
			this.#pollVisibleTails();
		} else {
			this.#scrollBy(-1);
		}
		this.#syncTimers();
		this.#requestRender();
	}

	/** ctrl+down: scroll the expanded list down; collapse only once at the bottom. */
	onCollapseDown(): void {
		if (this.#disposed || !this.isVisible() || !this.#expanded) return;
		const budget = this.#expandedHeightBudget();
		const win = buildExpandedWindow(this.#snapshot, this.#now(), this.#scrollOffset, budget, this.#tailRecord());
		this.#scrollOffset = win.scrollOffset;
		if (win.canScrollDown) {
			this.#scrollBy(1);
		} else {
			this.#expanded = false;
		}
		this.#syncTimers();
		this.#requestRender();
	}

	#scrollBy(delta: number): void {
		const budget = this.#expandedHeightBudget();
		const win = buildExpandedWindow(this.#snapshot, this.#now(), this.#scrollOffset, budget, this.#tailRecord());
		this.#scrollOffset = clampScrollOffset(this.#scrollOffset + delta, win.totalRows, budget);
	}

	#expandedHeightBudget(): number {
		// Reserve one row for the header/scroll-indicator line.
		return Math.max(1, this.#maxRows - 1);
	}

	#tailRecord(): Record<string, string[]> {
		return Object.fromEntries(this.#tailLines);
	}

	render(width: number): string[] {
		const now = this.#now();
		if (!hasVisibleJobs(this.#snapshot, now)) return [];
		return this.#expanded ? this.#renderExpanded(width, now) : this.#renderCollapsed(width, now);
	}

	#renderCollapsed(width: number, now: number): string[] {
		const maxRows = Math.max(1, this.#maxRows);
		const full = buildCollapsedRows(this.#snapshot, now, { cap: COLLAPSED_JOB_ROW_CAP, width });
		const header = `Active jobs (${full.totalVisible}) — ctrl+↑ expand`;
		// On a tiny budget the header alone is the one-line summary.
		if (maxRows <= 1) return [header];
		// Reserve the header row; reserve one more for "+N more" only when needed.
		const rowBudget = maxRows - 1;
		let shown = full.rows.slice(0, rowBudget);
		let overflow = full.totalVisible - shown.length;
		if (overflow > 0 && shown.length === rowBudget) {
			shown = full.rows.slice(0, Math.max(0, rowBudget - 1));
			overflow = full.totalVisible - shown.length;
		}
		const lines: string[] = [header, ...shown.map(row => `  ${row.text}`)];
		if (overflow > 0) lines.push(`  +${overflow} more`);
		return lines;
	}

	#renderExpanded(width: number, now: number): string[] {
		const budget = this.#expandedHeightBudget();
		const win = buildExpandedWindow(this.#snapshot, now, this.#scrollOffset, budget, this.#tailRecord(), width);
		this.#visibleMonitorIds = win.visibleMonitorTailIds;
		// Keep internal scroll state aligned with the clamped window after job/tail churn.
		this.#scrollOffset = win.scrollOffset;
		const shownStart = win.totalRows === 0 ? 0 : win.scrollOffset + 1;
		const shownEnd = win.scrollOffset + win.visibleRows.length;
		const indicators = `${win.canScrollUp ? "↑" : " "}${win.canScrollDown ? "↓" : " "}`;
		const lines: string[] = [
			`Active jobs — expanded (${shownStart}-${shownEnd} of ${win.totalRows}) ${indicators} ctrl+↓ collapse`,
		];
		for (const row of win.visibleRows) lines.push(`  ${row.text}`);
		return lines;
	}

	#pollVisibleTails(): void {
		if (this.#disposed) return;
		// Determine which monitors are currently visible by building the window.
		const budget = this.#expandedHeightBudget();
		const win = buildExpandedWindow(this.#snapshot, this.#now(), this.#scrollOffset, budget, this.#tailRecord());
		this.#visibleMonitorIds = win.visibleMonitorTailIds;
		const live = new Set(this.#visibleMonitorIds);
		// Drop caches for monitors no longer in the window.
		for (const id of [...this.#tailLines.keys()]) {
			if (!live.has(id)) this.#tailLines.delete(id);
		}
		for (const id of this.#visibleMonitorIds) {
			const slice = this.#controller.getMonitorOutputTail(id, {
				maxBytes: TAIL_MAX_BYTES,
				maxLines: TAIL_MAX_LINES_PER_MONITOR,
			});
			const text = slice?.text ?? "";
			const lines = text.length === 0 ? [] : text.replace(/\n$/, "").split("\n").slice(-TAIL_MAX_LINES_PER_MONITOR);
			this.#tailLines.set(id, lines);
		}
	}

	#syncTimers(): void {
		const visible = this.isVisible();
		// Minute-boundary label refresh while the panel is shown.
		if (visible && !this.#labelTimer) this.#scheduleLabelRefresh();
		if (!visible && this.#labelTimer) {
			clearTimeout(this.#labelTimer);
			this.#labelTimer = undefined;
		}
		// Live-tail poll only while expanded with at least one visible monitor row.
		const wantTail = visible && this.#expanded;
		if (wantTail && !this.#tailTimer) {
			this.#tailTimer = setInterval(() => {
				if (this.#disposed) return;
				this.#pollVisibleTails();
				this.#requestRender();
			}, TAIL_POLL_MS);
			this.#tailTimer.unref?.();
		}
		if (!wantTail && this.#tailTimer) {
			clearInterval(this.#tailTimer);
			this.#tailTimer = undefined;
		}
	}

	/**
	 * Next refresh delay: the earlier of the next minute label boundary and the
	 * nearest visible terminal-monitor TTL deadline, so completed/failed rows drop
	 * on time even without an upstream observer event.
	 */
	#nextRefreshDelay(now: number): number {
		let delay = MS_PER_MINUTE - (now % MS_PER_MINUTE);
		for (const monitor of filterVisibleJobs(this.#snapshot, now).monitors) {
			if (monitor.status === "running" || monitor.status === "paused" || monitor.endTime === undefined) continue;
			const ttl = monitor.status === "failed" ? FAILED_MONITOR_VISIBLE_MS : COMPLETED_MONITOR_VISIBLE_MS;
			const remaining = monitor.endTime + ttl - now;
			if (remaining > 0 && remaining < delay) delay = remaining;
		}
		return Math.max(1, delay);
	}

	#scheduleLabelRefresh(): void {
		const delay = this.#nextRefreshDelay(this.#now());
		this.#labelTimer = setTimeout(() => {
			this.#labelTimer = undefined;
			if (this.#disposed) return;
			// Always redraw at the boundary: if this deadline expired the last
			// visible job, the render clears the panel. Only keep the timer
			// running while something remains visible.
			this.#requestRender();
			if (this.isVisible()) this.#scheduleLabelRefresh();
		}, delay);
		this.#labelTimer.unref?.();
	}

	dispose(): void {
		this.#disposed = true;
		if (this.#labelTimer) clearTimeout(this.#labelTimer);
		if (this.#tailTimer) clearInterval(this.#tailTimer);
		this.#labelTimer = undefined;
		this.#tailTimer = undefined;
		this.#tailLines.clear();
	}
}
