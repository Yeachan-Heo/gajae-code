import { describe, expect, test } from "bun:test";
import type { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { projectGoal, projectTodos } from "../src/session-state";

/** Only the two accessors the projection reads; anything else would be invented state. */
function fakeSession(options: { todos?: () => unknown; goal?: () => unknown }): AgentSession {
	return {
		getTodoPhases: options.todos ?? (() => []),
		getGoalModeState: options.goal ?? (() => undefined),
	} as unknown as AgentSession;
}

describe("desktop session state projection", () => {
	test("omits todo and goal fields when the session has neither", () => {
		expect(projectTodos(undefined)).toEqual({});
		expect(projectGoal(undefined)).toEqual({});
		expect(projectTodos(fakeSession({}))).toEqual({});
		expect(projectGoal(fakeSession({}))).toEqual({});
	});

	test("projects the live todo list with recognised statuses only", () => {
		const projection = projectTodos(
			fakeSession({
				todos: () => [
					{
						name: "Foundation",
						tasks: [
							{ content: "Read the host", status: "completed" },
							{ content: "Project todos", status: "in_progress" },
							{ content: "Unknown status", status: "blocked" },
							{ content: "", status: "pending" },
						],
					},
					{ name: "Empty", tasks: [] },
				],
			}),
		);
		expect(projection.todos).toEqual([
			{
				name: "Foundation",
				tasks: [
					{ content: "Read the host", status: "completed" },
					{ content: "Project todos", status: "in_progress" },
					{ content: "Unknown status", status: "pending" },
				],
			},
		]);
	});

	test("bounds a pathological todo list instead of growing the frame", () => {
		const phases = Array.from({ length: 40 }, (_, phase) => ({
			name: `phase-${phase}`,
			tasks: Array.from({ length: 10 }, () => ({ content: "x".repeat(500), status: "pending" })),
		}));
		const projection = projectTodos(fakeSession({ todos: () => phases }));
		const tasks = projection.todos?.flatMap(phase => phase.tasks) ?? [];
		expect(projection.todos!.length).toBeLessThanOrEqual(24);
		expect(tasks.length).toBeLessThanOrEqual(120);
		expect(tasks.every(task => task.content.length <= 300)).toBe(true);
	});

	test("survives a malformed todo or goal payload without throwing", () => {
		expect(projectTodos(fakeSession({ todos: () => "nope" }))).toEqual({});
		expect(projectTodos(fakeSession({ todos: () => [null, 3, { tasks: "x" }] }))).toEqual({});
		expect(
			projectTodos(
				fakeSession({
					todos: () => {
						throw new Error("boom");
					},
				}),
			),
		).toEqual({});
		expect(
			projectGoal(
				fakeSession({
					goal: () => {
						throw new Error("boom");
					},
				}),
			),
		).toEqual({});
	});

	test("projects goal state without inventing a status or usage the SDK did not report", () => {
		expect(
			projectGoal(
				fakeSession({
					goal: () => ({
						enabled: true,
						mode: "active",
						goal: { objective: "Ship it", status: "active", tokensUsed: 42 },
					}),
				}),
			),
		).toEqual({ goal: { objective: "Ship it", status: "active", tokensUsed: 42 } });
		expect(
			projectGoal(
				fakeSession({
					goal: () => ({
						enabled: true,
						mode: "exiting",
						goal: { objective: "Paused work", status: "paused", timeUsedSeconds: -5 },
					}),
				}),
			),
		).toEqual({ goal: { objective: "Paused work", status: "paused" } });
		// An unrecognised status would make the strip offer operations for a state nobody reported.
		expect(projectGoal(fakeSession({ goal: () => ({ goal: { objective: "Unknown", status: "blocked" } }) }))).toEqual(
			{},
		);
		expect(projectGoal(fakeSession({ goal: () => ({ goal: { objective: "", status: "active" } }) }))).toEqual({});
	});
});
