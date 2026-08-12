import { beforeAll, describe, expect, test } from "bun:test";
import { TasksPaneComponent } from "../src/modes/components/tasks-pane";
import type { TaskRow, TasksSnapshot } from "../src/modes/tasks-aggregator";
import { initTheme } from "../src/modes/theme/theme";

beforeAll(async () => {
	await initTheme();
});

function makeAggregator(
	rows: TaskRow[],
	failedUnacknowledged = false,
	overflowCount = 0,
	attentionStatus?: TasksSnapshot["attentionStatus"],
) {
	let failed = failedUnacknowledged;
	const snapshot = (): TasksSnapshot => ({
		rows,
		worstState: failed ? "failed" : (rows[0]?.status ?? "none"),
		failedUnacknowledged: failed,
		overflowCount,
		attentionStatus,
	});
	return {
		getSnapshot: snapshot,
		acknowledgeFailures: () => {
			failed = false;
		},
	} as unknown as import("../src/modes/tasks-aggregator").TasksAggregator;
}

function row(kind: TaskRow["kind"], id: string, label = id): TaskRow {
	return { kind, id, label, status: "failed", startedAt: 1 };
}

describe("TasksPane attention and reveal UX", () => {
	test("routes Enter through the owner callback and closes only when accepted", () => {
		const routes: unknown[] = [];
		let closed = 0;
		const pane = new TasksPaneComponent(makeAggregator([row("bash", "bash:bg_1")]), {
			close: () => {
				closed++;
			},
			requestRender: () => {},
			reveal: route => {
				routes.push(route);
				return true;
			},
		});
		pane.getFocus().handleInput("\n");
		expect(routes).toEqual([{ kind: "jobs", taskId: "bg_1", sourceKind: "bash" }]);
		expect(closed).toBe(1);
		pane.dispose();
	});

	test("rejects object-shaped reveal receipts and keeps the pane open", () => {
		for (const receipt of [{ ok: true }, { accepted: true }]) {
			let closed = 0;
			const pane = new TasksPaneComponent(makeAggregator([row("bash", "bash:bg_1")]), {
				close: () => {
					closed++;
				},
				requestRender: () => {},
				reveal: () => receipt,
			});
			pane.getFocus().handleInput("\n");
			expect(closed).toBe(0);
			expect(pane.render(32).join("\n")).toContain("Task reveal unavailable");
			pane.dispose();
		}
	});

	test("keeps the pane open for stale or failed owner reveals", () => {
		let closed = 0;
		const pane = new TasksPaneComponent(makeAggregator([row("cron", "cron:cron_1")]), {
			close: () => {
				closed++;
			},
			requestRender: () => {},
			reveal: () => false,
		});
		pane.getFocus().handleInput("\n");
		expect(closed).toBe(0);
		expect(pane.render(32).join("\n")).toContain("Task reveal unavailable");
		pane.dispose();
	});

	test("does not acknowledge on open and commits only after explicit awaited acknowledgement", async () => {
		let calls = 0;
		let resolve: ((value: unknown) => void) | undefined;
		const pane = new TasksPaneComponent(makeAggregator([row("bash", "bash:bg_1")], true), {
			close: () => {},
			requestRender: () => {},
			acknowledgeFailures: () => {
				calls++;
				return new Promise<unknown>(resolver => {
					resolve = resolver;
				});
			},
		});
		expect(calls).toBe(0);
		expect(pane.render(80).join("\n")).toContain("press a");
		pane.handleInput("a");
		expect(calls).toBe(1);
		expect(pane.render(80).join("\n")).toContain("Acknowledgement pending");
		resolve?.({ kind: "committed" });
		await Promise.resolve();
		expect(pane.render(80).join("\n")).toContain("Failures acknowledged");
		pane.dispose();
	});

	test("keeps an alert on acknowledgement failure and ignores late completion after disposal", async () => {
		let reject: ((error?: unknown) => void) | undefined;
		const pane = new TasksPaneComponent(makeAggregator([], true), {
			close: () => {},
			requestRender: () => {},
			acknowledgeFailures: () =>
				new Promise<unknown>((_resolve, resolver) => {
					reject = resolver;
				}),
		});
		pane.handleInput("a");
		pane.dispose();
		reject?.(new Error("must not surface"));
		await Promise.resolve();
		expect(() => pane.render(20)).not.toThrow();
	});

	test("keeps empty panes safe and renders bounded CJK labels", () => {
		const pane = new TasksPaneComponent(makeAggregator([row("subagent", "subagent:worker", "研究者".repeat(80))]), {
			close: () => {},
			requestRender: () => {},
		});
		const lines = pane.render(12);
		expect(lines.join("\n")).toContain("Failed");
		expect(lines.every(line => Bun.stringWidth(Bun.stripANSI(line)) <= 12)).toBe(true);
		pane.dispose();

		const empty = new TasksPaneComponent(makeAggregator([]), { close: () => {}, requestRender: () => {} });
		expect(empty.render(12).join("\n")).toContain("No tasks");
		empty.dispose();
	});
	test("renders bounded overflow as a safe status without a failure alert", () => {
		const pane = new TasksPaneComponent(
			makeAggregator([row("subagent", "subagent:overflow", "研究者".repeat(80))], false, 1, "overflow"),
			{
				close: () => {},
				requestRender: () => {},
			},
		);
		const lines = pane.render(12);
		expect(lines.join("\n")).toContain("+1 more");
		expect(lines.join("\n")).toContain("tasks");
		expect(lines.join("\n")).not.toContain("Failures need acknowledgement");
		expect(lines.every(line => Bun.stringWidth(Bun.stripANSI(line)) <= 12)).toBe(true);
		pane.dispose();
	});
});
