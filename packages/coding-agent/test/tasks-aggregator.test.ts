import { describe, expect, test } from "bun:test";
import {
	mapAsyncJobStatus,
	mapCronStatus,
	mapSessionStatus,
	mapSubagentStatus,
	TasksAggregator,
} from "../src/modes/tasks-aggregator";

const noop = () => () => {};

describe("TasksAggregator status contract", () => {
	test("maps every source status to the unified lifecycle", () => {
		expect(
			Object.fromEntries(
				["running", "paused", "completed", "failed", "cancelled"].map(s => [s, mapAsyncJobStatus(s as never)]),
			),
		).toEqual({
			running: "running",
			paused: "waiting",
			completed: "done",
			failed: "failed",
			cancelled: "cancelled",
		});
		expect(
			Object.fromEntries(["active", "completed", "failed", "aborted"].map(s => [s, mapSessionStatus(s as never)])),
		).toEqual({
			active: "running",
			completed: "done",
			failed: "failed",
			aborted: "cancelled",
		});
		expect(
			Object.fromEntries(
				["running", "queued", "paused", "completed", "failed", "cancelled"].map(s => [
					s,
					mapSubagentStatus(s as never),
				]),
			),
		).toEqual({
			running: "running",
			queued: "waiting",
			paused: "waiting",
			completed: "done",
			failed: "failed",
			cancelled: "cancelled",
		});
		expect(mapCronStatus({ firing: false })).toBe("waiting");
		expect(mapCronStatus({ firing: true })).toBe("running");
	});

	test("uses the canonical record lifecycle with live registry metadata", () => {
		const manager = {
			onChange: noop,
			getAllJobs: () => [],
			getSubagentRecords: () => [{ subagentId: "a", status: "queued", resumable: true }],
		};
		const observer = {
			onChange: noop,
			getSnapshot: () => ({ monitors: [], crons: [], failedUnacknowledged: false }),
			acknowledgeFailures: () => {},
			getMonitorOutput: () => "",
		};
		const sessions = {
			onChange: noop,
			getSessions: () => [{ id: "a", kind: "subagent", label: "Live", status: "active", lastUpdate: 1 }],
		};
		const aggregator = new TasksAggregator(manager as never, observer as never, sessions as never);
		expect(aggregator.getSnapshot().rows).toEqual([
			{ id: "subagent:a", kind: "subagent", label: "Live", status: "waiting", startedAt: 1, resumable: true },
		]);
		aggregator.dispose();
	});

	test("bounds terminal history without hiding active tasks", () => {
		const manager = {
			onChange: noop,
			getAllJobs: () => [
				{ id: "running", type: "bash", label: "running", status: "running", startTime: 1_000 },
				...Array.from({ length: 101 }, (_, index) => ({
					id: `done-${index}`,
					type: "bash",
					label: `done ${index}`,
					status: "completed" as const,
					startTime: index,
				})),
			],
			getSubagentRecords: () => [],
		};
		const observer = {
			onChange: noop,
			getSnapshot: () => ({ monitors: [], crons: [], failedUnacknowledged: false }),
			acknowledgeFailures: () => {},
			getMonitorOutput: () => "",
		};
		const sessions = { onChange: noop, getSessions: () => [] };
		const aggregator = new TasksAggregator(manager as never, observer as never, sessions as never);
		expect(aggregator.getSnapshot().rows).toHaveLength(101);
		expect(aggregator.getSnapshot().rows.map(row => row.id)).toContain("bash:running");
		aggregator.dispose();
	});
});
