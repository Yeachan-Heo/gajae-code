import { beforeAll, describe, expect, test } from "bun:test";
import { TasksPaneComponent, type TasksPaneSource } from "../src/modes/components/tasks-pane";
import type { TaskRow, TasksAggregator, TasksSnapshot } from "../src/modes/tasks-aggregator";
import { initTheme } from "../src/modes/theme/theme";

beforeAll(async () => {
	await initTheme(false, "unicode", false, "red-claw", "red-claw");
});

type ProductionAggregatorIsPaneSource = TasksAggregator extends TasksPaneSource ? true : false;
const productionAggregatorIsPaneSource: ProductionAggregatorIsPaneSource = true;

function fixtureSource(): { source: TasksPaneSource; snapshot: TasksSnapshot; acknowledgements: () => number } {
	const task: TaskRow = {
		id: "bash:fixture",
		kind: "bash",
		label: "Fixture failure",
		status: "failed",
		startedAt: 1,
	};
	Object.freeze(task);
	const rows: TaskRow[] = [task];
	Object.freeze(rows);
	let current: TasksSnapshot = { rows, worstState: "failed", failedUnacknowledged: true };
	Object.freeze(current);
	const listeners = new Set<() => void>();
	let acknowledgementCount = 0;
	const source: TasksPaneSource = {
		getSnapshot: () => current,
		onChange: listener => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		acknowledgeFailures: () => {
			acknowledgementCount += 1;
			current = Object.freeze({ ...current, failedUnacknowledged: false });
			for (const listener of listeners) listener();
			return { ok: true, status: "ready", changed: true };
		},
	};
	return { source, snapshot: current, acknowledgements: () => acknowledgementCount };
}

describe("TasksPaneSource structural contract", () => {
	test("production TasksAggregator is assignable without a behavior fork", () => {
		expect(productionAggregatorIsPaneSource).toBe(true);
	});

	test("a frozen source fixture owns lifecycle mutation while the pane only observes it", async () => {
		const fixture = fixtureSource();
		let closed = 0;
		let renders = 0;
		const pane = new TasksPaneComponent(fixture.source, {
			close: () => {
				closed += 1;
			},
			requestRender: () => {
				renders += 1;
			},
		});
		const before = JSON.stringify(fixture.snapshot);
		expect(pane.render(80).join("\n")).toContain("Failed Fixture failure");
		pane.getFocus().handleInput("\n");
		await Promise.resolve();
		expect(closed).toBe(1);
		expect(JSON.stringify(fixture.snapshot)).toBe(before);
		pane.handleInput("a");
		await Promise.resolve();
		expect(fixture.acknowledgements()).toBe(1);
		expect(fixture.source.getSnapshot().failedUnacknowledged).toBe(false);
		expect(renders).toBeGreaterThan(0);
		pane.dispose();
		expect(() => pane.render(80)).not.toThrow();
	});

	test("source change subscription refreshes the real component and detaches on disposal", () => {
		const fixture = fixtureSource();
		let listener: (() => void) | undefined;
		const source: TasksPaneSource = {
			getSnapshot: fixture.source.getSnapshot,
			onChange: callback => {
				listener = callback;
				return () => {
					listener = undefined;
				};
			},
			acknowledgeFailures: fixture.source.acknowledgeFailures,
		};
		const pane = new TasksPaneComponent(source, { close: () => {}, requestRender: () => {} });
		expect(listener).toBeDefined();
		listener?.();
		expect(pane.render(80).join("\n")).toContain("Failed Fixture failure");
		pane.dispose();
		expect(listener).toBeUndefined();
	});
});
