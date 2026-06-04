import { describe, expect, test } from "bun:test";
import { JobsOverlayComponent, type JobsOverlayController } from "../src/modes/components/jobs-overlay";
import {
	buildConfirmItems,
	buildJobDetailItems,
	buildJobsListItems,
	formatRelative,
	parseJobRef,
} from "../src/modes/components/jobs-overlay-model";
import type { JobsSnapshot } from "../src/modes/jobs-observer";

function snapshot(over: Partial<JobsSnapshot> = {}): JobsSnapshot {
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

function makeOverlayController(over: Partial<JobsSnapshot> = {}) {
	const calls: string[] = [];
	const controller: JobsOverlayController = {
		acknowledgeFailures: () => calls.push("ack"),
		getSnapshot: () => snapshot(over),
		getMonitorOutput: () => "line one\nlast line\n",
		cancelMonitor: id => {
			calls.push(`cancel:${id}`);
			return true;
		},
		deleteCron: id => {
			calls.push(`delete:${id}`);
			return true;
		},
	};
	let closed = 0;
	let renders = 0;
	const overlay = new JobsOverlayComponent(controller, {
		close: () => {
			closed += 1;
		},
		requestRender: () => {
			renders += 1;
		},
	});
	return {
		overlay,
		calls,
		get closed() {
			return closed;
		},
		get renders() {
			return renders;
		},
	};
}

describe("jobs overlay model", () => {
	test("AC8 list is grouped Monitors-then-Crons preserving newest-first order", () => {
		const items = buildJobsListItems(
			snapshot({
				monitors: [
					{ id: "m2", label: "tail b", status: "running", startTime: 2 },
					{ id: "m1", label: "tail a", status: "failed", startTime: 1 },
				],
				crons: [
					{
						id: "c2",
						humanSchedule: "every 5m",
						cronExpression: "*/5 * * * *",
						prompt: "p2",
						recurring: true,
						createdAt: 2,
					},
					{
						id: "c1",
						humanSchedule: "at 09:00",
						cronExpression: "0 9 * * *",
						prompt: "p1",
						recurring: false,
						createdAt: 1,
					},
				],
			}),
		);
		expect(items.map(i => i.value)).toEqual(["monitor:m2", "monitor:m1", "cron:c2", "cron:c1"]);
		// failed monitor carries a failed hint
		expect(items.find(i => i.value === "monitor:m1")?.hint).toBe("failed");
	});

	test("parseJobRef parses monitor/cron refs and rejects non-refs", () => {
		expect(parseJobRef("monitor:abc")).toEqual({ kind: "monitor", id: "abc" });
		expect(parseJobRef("cron:x")).toEqual({ kind: "cron", id: "x" });
		expect(parseJobRef("noop")).toBeNull();
		expect(parseJobRef("back")).toBeNull();
		expect(parseJobRef("other:1")).toBeNull();
	});

	test("AC9 monitor detail shows status + last output line and a cancel action", () => {
		const snap = snapshot({
			monitors: [{ id: "m1", label: "tail server.log", status: "running", startTime: Date.now() }],
		});
		const items = buildJobDetailItems(snap, { kind: "monitor", id: "m1" }, "line one\nlast line\n");
		const labels = items.map(i => i.label);
		expect(labels).toContain("Status");
		expect(items.find(i => i.label === "Output")?.description).toBe("last line");
		expect(items.some(i => i.value === "action:cancel")).toBe(true);
		expect(items.at(-1)?.value).toBe("back");
	});

	test("AC10 cron detail shows schedule/recurring/next-fire/prompt and a delete action", () => {
		const snap = snapshot({
			crons: [
				{
					id: "c1",
					humanSchedule: "every 5m",
					cronExpression: "*/5 * * * *",
					prompt: "review the PR queue",
					recurring: true,
					nextFireAt: Date.now() + 300_000,
					createdAt: Date.now(),
				},
			],
		});
		const items = buildJobDetailItems(snap, { kind: "cron", id: "c1" });
		const labels = items.map(i => i.label);
		expect(labels).toContain("Schedule");
		expect(labels).toContain("Recurring");
		expect(labels).toContain("Next fire");
		expect(labels).toContain("Prompt");
		expect(items.some(i => i.value === "action:delete")).toBe(true);
	});

	test("detail for a missing job degrades to a back row", () => {
		const items = buildJobDetailItems(snapshot(), { kind: "monitor", id: "ghost" });
		expect(items).toHaveLength(1);
		expect(items[0]?.value).toBe("back");
	});

	test("AC11/AC12 confirm items put the safe (No) option first", () => {
		const items = buildConfirmItems("delete this cron");
		expect(items[0]?.value).toBe("no");
		expect(items[1]?.value).toBe("yes");
		expect(items[1]?.label).toContain("delete this cron");
	});

	test("JobsOverlayComponent closes detail on Escape instead of reopening a stale list", () => {
		const harness = makeOverlayController({
			monitors: [{ id: "m1", label: "tail server.log", status: "running", startTime: Date.now() }],
		});

		harness.overlay.handleInput("\n");
		expect(harness.overlay.render(100).join("\n")).toContain("Cancel this monitor");
		harness.overlay.handleInput("\x1b");

		expect(harness.closed).toBe(1);
		expect(harness.calls).toEqual(["ack"]);
	});

	test("JobsOverlayComponent confirm accepts y and returns to list", () => {
		const harness = makeOverlayController({
			monitors: [{ id: "m1", label: "tail server.log", status: "running", startTime: Date.now() }],
		});

		harness.overlay.handleInput("\n");
		harness.overlay.handleInput("\u001b[B");
		harness.overlay.handleInput("\u001b[B");
		harness.overlay.handleInput("\u001b[B");
		harness.overlay.handleInput("\u001b[B");
		harness.overlay.handleInput("\n");
		expect(harness.overlay.render(100).join("\n")).toContain("Yes, cancel this monitor");
		harness.overlay.handleInput("y");

		expect(harness.calls).toEqual(["ack", "cancel:m1"]);
		expect(harness.overlay.render(100).join("\n")).toContain("monitor · tail server.log");
	});

	test("JobsOverlayComponent confirm rejects n and Escape", () => {
		for (const key of ["n", "\x1b"]) {
			const harness = makeOverlayController({
				crons: [
					{
						id: "c1",
						humanSchedule: "every 5m",
						cronExpression: "*/5 * * * *",
						prompt: "poll deploys",
						recurring: true,
						createdAt: Date.now(),
					},
				],
			});

			harness.overlay.handleInput("\n");
			harness.overlay.handleInput("\u001b[B");
			harness.overlay.handleInput("\u001b[B");
			harness.overlay.handleInput("\u001b[B");
			harness.overlay.handleInput("\u001b[B");
			harness.overlay.handleInput("\n");
			harness.overlay.handleInput(key);

			expect(harness.calls).toEqual(["ack"]);
			expect(harness.overlay.render(100).join("\n")).toContain("Delete this cron");
		}
	});

	test("formatRelative renders future/past/unknown", () => {
		const now = 1_000_000;
		expect(formatRelative(now + 300_000, now)).toBe("in 5m");
		expect(formatRelative(now - 120_000, now)).toBe("2m ago");
		expect(formatRelative(undefined, now)).toBe("—");
	});
});
