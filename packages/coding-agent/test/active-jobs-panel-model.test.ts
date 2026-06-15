import { describe, expect, test } from "bun:test";
import {
	buildCollapsedRows,
	buildExpandedWindow,
	COMPLETED_MONITOR_VISIBLE_MS,
	clampScrollOffset,
	FAILED_MONITOR_VISIBLE_MS,
	filterVisibleJobs,
	hasVisibleJobs,
	isMonitorVisible,
	resolveCollapsedCap,
} from "../src/modes/components/active-jobs-panel-model";
import type { CronJobView, JobsSnapshot, MonitorJobView } from "../src/modes/jobs-observer";

const NOW = 10_000_000;

function mon(over: Partial<MonitorJobView> = {}): MonitorJobView {
	return { id: "m", label: "tail server.log", status: "running", startTime: NOW - 5_000, ...over };
}

function cron(over: Partial<CronJobView> = {}): CronJobView {
	return {
		id: "c",
		humanSchedule: "every 5m",
		cronExpression: "*/5 * * * *",
		prompt: "review the deploy queue",
		recurring: true,
		nextFireAt: NOW + 120_000,
		createdAt: NOW - 1_000,
		...over,
	};
}

function snap(over: Partial<JobsSnapshot> = {}): JobsSnapshot {
	return {
		monitors: [],
		crons: [],
		activeMonitorCount: 0,
		activeCronCount: 0,
		worstState: "none",
		failedUnacknowledged: false,
		...over,
	};
}

describe("active-jobs-panel-model: TTL", () => {
	test("running and paused monitors are always visible", () => {
		expect(isMonitorVisible(mon({ status: "running" }), NOW)).toBe(true);
		expect(isMonitorVisible(mon({ status: "paused" }), NOW)).toBe(true);
	});

	test("completed monitor visible just under TTL, gone at TTL", () => {
		const justUnder = mon({ status: "completed", endTime: NOW - (COMPLETED_MONITOR_VISIBLE_MS - 1) });
		const atTtl = mon({ status: "completed", endTime: NOW - COMPLETED_MONITOR_VISIBLE_MS });
		expect(isMonitorVisible(justUnder, NOW)).toBe(true);
		expect(isMonitorVisible(atTtl, NOW)).toBe(false);
	});

	test("failed monitor lingers longer than completed", () => {
		const failedJustUnder = mon({ status: "failed", endTime: NOW - (FAILED_MONITOR_VISIBLE_MS - 1) });
		const failedAtTtl = mon({ status: "failed", endTime: NOW - FAILED_MONITOR_VISIBLE_MS });
		expect(isMonitorVisible(failedJustUnder, NOW)).toBe(true);
		expect(isMonitorVisible(failedAtTtl, NOW)).toBe(false);
		// at the completed TTL a failed monitor is still visible (longer window)
		expect(isMonitorVisible(mon({ status: "failed", endTime: NOW - COMPLETED_MONITOR_VISIBLE_MS }), NOW)).toBe(true);
	});

	test("terminal monitor without endTime is kept visible", () => {
		expect(isMonitorVisible(mon({ status: "completed", endTime: undefined }), NOW)).toBe(true);
	});

	test("crons are always included; hasVisibleJobs reflects filtered set", () => {
		const expired = mon({ id: "old", status: "completed", endTime: NOW - 10 * 60_000 });
		expect(hasVisibleJobs(snap({ monitors: [expired] }), NOW)).toBe(false);
		expect(hasVisibleJobs(snap({ monitors: [expired], crons: [cron()] }), NOW)).toBe(true);
		const filtered = filterVisibleJobs(snap({ monitors: [expired], crons: [cron()] }), NOW);
		expect(filtered.monitors).toHaveLength(0);
		expect(filtered.crons).toHaveLength(1);
	});
});

describe("active-jobs-panel-model: collapsed", () => {
	test("caps rows at 4 and reports overflow, monitors before crons", () => {
		const monitors = [0, 1, 2].map(i => mon({ id: `m${i}`, startTime: NOW - i }));
		const crons = [0, 1, 2].map(i => cron({ id: `c${i}`, createdAt: NOW - i }));
		const view = buildCollapsedRows(snap({ monitors, crons }), NOW);
		expect(view.totalVisible).toBe(6);
		expect(view.rows).toHaveLength(4);
		expect(view.overflow).toBe(2);
		expect(view.rows.slice(0, 3).every(r => r.kind === "monitor")).toBe(true);
		expect(view.rows[3]?.kind).toBe("cron");
	});

	test("monitor/cron row text carries the expected fields", () => {
		const view = buildCollapsedRows(
			snap({
				monitors: [mon({ id: "m", label: "tail app.log", status: "running", startTime: NOW - 65_000 })],
				crons: [cron({ id: "c", humanSchedule: "every 5m", nextFireAt: NOW + 120_000, prompt: "poll deploys" })],
			}),
			NOW,
		);
		const monitorRow = view.rows.find(r => r.kind === "monitor");
		expect(monitorRow?.text).toContain("tail app.log");
		expect(monitorRow?.text).toContain("running");
		expect(monitorRow?.text).toContain("1m"); // 65s runtime
		const cronRow = view.rows.find(r => r.kind === "cron");
		expect(cronRow?.text).toContain("every 5m");
		expect(cronRow?.text).toContain("in 2m");
		expect(cronRow?.text).toContain("poll deploys");
	});

	test("width budget truncates long rows", () => {
		const view = buildCollapsedRows(snap({ monitors: [mon({ id: "m", label: "x".repeat(200) })] }), NOW, {
			width: 30,
		});
		expect(view.rows[0]?.text.length).toBeLessThanOrEqual(30);
		expect(view.rows[0]?.text.endsWith("…")).toBe(true);
	});

	test("resolveCollapsedCap degrades with available rows", () => {
		expect(resolveCollapsedCap(10)).toBe(4);
		expect(resolveCollapsedCap(2)).toBe(2);
		expect(resolveCollapsedCap(0)).toBe(0);
	});
});

describe("active-jobs-panel-model: expanded window", () => {
	test("clampScrollOffset stays within range", () => {
		expect(clampScrollOffset(-5, 20, 10)).toBe(0);
		expect(clampScrollOffset(100, 20, 10)).toBe(10);
		expect(clampScrollOffset(3, 20, 10)).toBe(3);
	});

	test("interleaves tail rows and reports visible monitor ids", () => {
		const monitors = [mon({ id: "m0", startTime: NOW })];
		const win = buildExpandedWindow(snap({ monitors }), NOW, 0, 10, { m0: ["out line a", "out line b"] });
		expect(win.totalRows).toBe(3); // header + 2 tail lines
		expect(win.visibleRows[0]?.kind).toBe("monitor");
		expect(win.visibleRows[1]?.kind).toBe("monitor-tail");
		expect(win.visibleRows[1]?.text).toContain("out line a");
		expect(win.visibleMonitorTailIds).toEqual(["m0"]);
	});

	test("65 jobs are all reachable by scrolling", () => {
		const monitors = Array.from({ length: 15 }, (_, i) =>
			mon({ id: `m${i}`, status: "running", startTime: NOW - i }),
		);
		const crons = Array.from({ length: 50 }, (_, i) => cron({ id: `c${i}`, createdAt: NOW - i }));
		const snapshot = snap({ monitors, crons });
		const height = 10;
		const first = buildExpandedWindow(snapshot, NOW, 0, height);
		expect(first.totalRows).toBe(65);

		const seen = new Set<string>();
		for (let offset = 0; offset <= first.totalRows; offset += height) {
			const win = buildExpandedWindow(snapshot, NOW, offset, height);
			for (const row of win.visibleRows) seen.add(`${row.kind}:${row.id}`);
		}
		// newest monitor (m0) and oldest cron (c49) both reachable; all 65 ids seen
		expect(seen.has("monitor:m0")).toBe(true);
		expect(seen.has("cron:c49")).toBe(true);
		expect(seen.size).toBe(65);

		const top = buildExpandedWindow(snapshot, NOW, 0, height);
		expect(top.canScrollUp).toBe(false);
		expect(top.canScrollDown).toBe(true);
		const bottom = buildExpandedWindow(snapshot, NOW, 999, height);
		expect(bottom.canScrollDown).toBe(false);
		expect(bottom.canScrollUp).toBe(true);
	});
});
