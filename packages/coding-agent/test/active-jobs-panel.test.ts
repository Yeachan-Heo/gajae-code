import { describe, expect, test } from "bun:test";
import type { AsyncJobOutputSlice, AsyncJobOutputTailOptions } from "../src/async";
import { ActiveJobsPanelComponent, type ActiveJobsPanelController } from "../src/modes/components/active-jobs-panel";
import { COMPLETED_MONITOR_VISIBLE_MS } from "../src/modes/components/active-jobs-panel-model";
import type { CronJobView, JobsSnapshot, MonitorJobView } from "../src/modes/jobs-observer";

const NOW = 5_000_000;

function mon(over: Partial<MonitorJobView> = {}): MonitorJobView {
	return { id: "m", label: "tail server.log", status: "running", startTime: NOW - 4_000, ...over };
}

function cron(over: Partial<CronJobView> = {}): CronJobView {
	return {
		id: "c",
		humanSchedule: "every 5m",
		cronExpression: "*/5 * * * *",
		prompt: "review deploy queue",
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

function makeController(snapshot: JobsSnapshot, tail = "tail line one\ntail line two\n"): ActiveJobsPanelController {
	return {
		getSnapshot: () => snapshot,
		getMonitorOutputTail: (id: string, _options: AsyncJobOutputTailOptions): AsyncJobOutputSlice | undefined => ({
			jobId: id,
			status: "running",
			text: tail,
			startOffset: 0,
			nextOffset: tail.length,
			truncated: false,
		}),
	};
}

function makePanel(snapshot: JobsSnapshot, tail?: string) {
	const controller = makeController(snapshot, tail);
	let renders = 0;
	const panel = new ActiveJobsPanelComponent(controller, { requestRender: () => renders++, now: () => NOW });
	panel.setSnapshot(snapshot);
	return {
		panel,
		get renders() {
			return renders;
		},
	};
}

describe("ActiveJobsPanelComponent", () => {
	test("renders nothing when no jobs are visible", () => {
		const { panel } = makePanel(snap());
		expect(panel.isVisible()).toBe(false);
		expect(panel.render(80)).toEqual([]);
		panel.dispose();
	});

	test("auto-shows a collapsed panel when a monitor or cron exists", () => {
		const { panel } = makePanel(snap({ monitors: [mon({ id: "m", label: "tail app.log" })] }));
		expect(panel.isVisible()).toBe(true);
		const lines = panel.render(80);
		expect(lines[0]).toContain("Active jobs (1)");
		expect(lines.join("\n")).toContain("tail app.log");
		expect(lines.join("\n")).toContain("running");
		panel.dispose();
	});

	test("collapsed panel caps at 4 rows and shows +N more", () => {
		const monitors = Array.from({ length: 6 }, (_, i) => mon({ id: `m${i}`, startTime: NOW - i }));
		const { panel } = makePanel(snap({ monitors }));
		const lines = panel.render(120);
		const jobRows = lines.filter(l => l.includes("monitor ·"));
		expect(jobRows).toHaveLength(4);
		expect(lines.join("\n")).toContain("+2 more");
		panel.dispose();
	});

	test("expands to show live monitor tail, collapses from the top", () => {
		const { panel } = makePanel(snap({ monitors: [mon({ id: "m", label: "tail x" })] }));
		expect(panel.isExpanded()).toBe(false);
		panel.onExpandUp();
		expect(panel.isExpanded()).toBe(true);
		const expanded = panel.render(80).join("\n");
		expect(expanded).toContain("expanded");
		expect(expanded).toContain("tail line two");
		// from the top, ctrl+down collapses
		panel.onCollapseDown();
		expect(panel.isExpanded()).toBe(false);
		panel.dispose();
	});

	test("expand is a no-op when nothing is visible", () => {
		const { panel } = makePanel(snap());
		panel.onExpandUp();
		expect(panel.isExpanded()).toBe(false);
		expect(panel.render(80)).toEqual([]);
		panel.dispose();
	});

	test("a completed monitor past its TTL is filtered out", () => {
		const expired = mon({ id: "done", status: "completed", endTime: NOW - COMPLETED_MONITOR_VISIBLE_MS });
		const { panel } = makePanel(snap({ monitors: [expired] }));
		expect(panel.isVisible()).toBe(false);
		expect(panel.render(80)).toEqual([]);
		panel.dispose();
	});

	test("setSnapshot to empty hides and resets expansion", () => {
		const { panel } = makePanel(snap({ crons: [cron()] }));
		panel.onExpandUp();
		expect(panel.isExpanded()).toBe(true);
		panel.setSnapshot(snap());
		expect(panel.isVisible()).toBe(false);
		expect(panel.isExpanded()).toBe(false);
		panel.dispose();
	});
});
