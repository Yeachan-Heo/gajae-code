import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createUltragoalPlan, startNextUltragoalGoal } from "@gajae-code/coding-agent/gjc-runtime/ultragoal-runtime";
import { GoalRuntime } from "@gajae-code/coding-agent/goals/runtime";
import type { Goal, GoalModeState, GoalTokenUsage } from "@gajae-code/coding-agent/goals/state";
import { GoalTool } from "@gajae-code/coding-agent/goals/tools/goal-tool";
import type { ToolSession } from "@gajae-code/coding-agent/tools";

function createUsage(overrides: Partial<GoalTokenUsage> = {}): GoalTokenUsage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		...overrides,
	};
}

function createGoal(overrides: Partial<Goal> = {}): Goal {
	return {
		id: "goal-1",
		objective: "Ship it",
		status: "active",
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

function cloneState(state: GoalModeState | undefined): GoalModeState | undefined {
	return state ? { ...state, goal: { ...state.goal } } : undefined;
}

function createToolSession(overrides: Partial<ToolSession>): ToolSession {
	return overrides as ToolSession;
}

function createRuntimeHarness(initialState?: GoalModeState) {
	let state = cloneState(initialState);
	const persists: string[] = [];
	const runtime = new GoalRuntime({
		getState: () => cloneState(state),
		setState: next => {
			state = cloneState(next);
		},
		getCurrentUsage: () => createUsage(),
		emit: async () => {},
		persist: (mode, _state) => {
			persists.push(mode);
		},
		sendHiddenMessage: async _message => {},
		now: () => 0,
	});
	return {
		runtime,
		getState: () => cloneState(state),
		persists,
	};
}

describe("GoalTool", () => {
	it("routes create/get/complete operations without budget details", async () => {
		const createGoalState: GoalModeState = {
			enabled: true,
			mode: "active",
			goal: createGoal({ objective: "Create route" }),
		};
		const getGoalState: GoalModeState = {
			enabled: true,
			mode: "active",
			goal: createGoal({ objective: "Get route", tokensUsed: 4 }),
		};
		const completedGoal = createGoal({
			objective: "Complete route",
			status: "complete",
			tokensUsed: 7,
			timeUsedSeconds: 3,
		});
		const runtime = {
			createGoal: vi.fn(async () => createGoalState),
			completeGoalFromTool: vi.fn(async () => completedGoal),
		};
		const getGoalModeState = vi.fn(() => getGoalState);
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => runtime as unknown as GoalRuntime,
				getGoalModeState,
			}),
		);

		const created = await tool.execute("call-create", {
			op: "create",
			objective: "  Create route  ",
		});
		expect(runtime.createGoal).toHaveBeenCalledWith({ objective: "Create route" });
		expect(created.details).toMatchObject({ op: "create", goal: createGoalState.goal });
		expect(created.content[0]).toEqual({ type: "text", text: "Goal: Create route\nStatus: active\nTokens used: 0" });

		const fetched = await tool.execute("call-get", { op: "get" });
		expect(getGoalModeState).toHaveBeenCalledTimes(1);
		expect(fetched.details).toMatchObject({ op: "get", goal: getGoalState.goal });
		expect(runtime.completeGoalFromTool).not.toHaveBeenCalled();

		const completed = await tool.execute("call-complete", { op: "complete" });
		expect(runtime.completeGoalFromTool).toHaveBeenCalledTimes(1);
		expect(completed.details).toMatchObject({ op: "complete", goal: completedGoal });
		expect(completed.content[0]).toEqual({
			type: "text",
			text: "Goal: Complete route\nStatus: complete\nTokens used: 7",
		});
		expect(JSON.stringify(completed.details)).not.toContain("Budget");
	});

	it("honors per-session goal operation restrictions", async () => {
		const harness = createRuntimeHarness({
			enabled: true,
			mode: "active",
			goal: createGoal({ objective: "RLM analysis" }),
		});
		const tool = new GoalTool(
			createToolSession({
				goalToolAllowedOps: ["get", "complete"],
				getGoalRuntime: () => harness.runtime,
				getGoalModeState: () => harness.getState(),
			}),
		);

		const fetched = await tool.execute("call-get", { op: "get" });
		expect(fetched.details?.op).toBe("get");
		await expect(tool.execute("call-drop", { op: "drop" })).rejects.toThrow(
			"only allows goal operations: get, complete",
		);
		expect(harness.getState()?.goal.status).toBe("active");
	});

	it("rejects unsupported token_budget before creating or mutating", async () => {
		const harness = createRuntimeHarness();
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => harness.runtime,
				getGoalModeState: () => harness.getState(),
			}),
		);

		await expect(
			tool.execute("call-create", { op: "create", objective: "New goal", token_budget: 10 } as never),
		).rejects.toThrow("token_budget is not supported for goals");
		expect(harness.getState()).toBeUndefined();
	});

	it("rejects create when a goal already exists", async () => {
		const harness = createRuntimeHarness({
			enabled: true,
			mode: "active",
			goal: createGoal({ objective: "Existing" }),
		});
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => harness.runtime,
				getGoalModeState: () => harness.getState(),
			}),
		);

		await expect(tool.execute("call-create", { op: "create", objective: "New goal" })).rejects.toThrow(
			"cannot create a new goal because this session already has a goal",
		);
	});

	it("rejects complete when no goal is active", async () => {
		const harness = createRuntimeHarness();
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => harness.runtime,
				getGoalModeState: () => harness.getState(),
			}),
		);

		await expect(tool.execute("call-complete", { op: "complete" })).rejects.toThrow(
			"cannot complete goal because no goal is active",
		);
	});

	it("rejects op=create when the objective is missing or only whitespace", async () => {
		const harness = createRuntimeHarness();
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => harness.runtime,
				getGoalModeState: () => harness.getState(),
			}),
		);

		await expect(tool.execute("call-empty", { op: "create", objective: "   \t\n" })).rejects.toThrow(
			"objective is required when op=create",
		);
		expect(harness.getState()).toBeUndefined();
	});

	it("rejects op=create when the objective is only the slash command name", async () => {
		const harness = createRuntimeHarness();
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => harness.runtime,
				getGoalModeState: () => harness.getState(),
			}),
		);

		await expect(tool.execute("call-slash", { op: "create", objective: "/goal" })).rejects.toThrow(
			"objective must describe the goal",
		);
		expect(harness.getState()).toBeUndefined();
	});

	it("flips state to exiting and clears enabled when op=complete succeeds (fix #1)", async () => {
		const harness = createRuntimeHarness();
		await harness.runtime.createGoal({ objective: "Ship the release" });
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => harness.runtime,
				getGoalModeState: () => harness.getState(),
			}),
		);

		const result = await tool.execute("call-complete", { op: "complete" });

		expect(result.details).toMatchObject({ op: "complete" });
		const after = harness.getState();
		expect(after?.enabled).toBe(false);
		expect(after?.mode).toBe("exiting");
		expect(after?.reason).toBe("completed");
		expect(after?.goal.status).toBe("complete");
	});

	it("completes a paused goal (enabled=false) — was broken before fix", async () => {
		const harness = createRuntimeHarness({
			enabled: false,
			mode: "active",
			goal: createGoal({ objective: "Paused work", status: "paused" }),
		});
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => harness.runtime,
				getGoalModeState: () => harness.getState(),
			}),
		);

		const result = await tool.execute("call-complete", { op: "complete" });
		expect(result.details?.goal?.status).toBe("complete");
		expect(harness.getState()?.goal.status).toBe("complete");
	});

	it("blocks direct unified goal completion for active ultragoal objectives without verification receipt", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-goal-ultragoal-"));
		try {
			const sessionId = "goal-tool-ultragoal-test";
			const plan = await createUltragoalPlan({ cwd: root, brief: "Ship verified ultragoal", sessionId });
			// Isolate the receipt gate: disable the pre-gate try-harder nudge (covered
			// separately in ultragoal-nudge-guard.test.ts).
			await fs.mkdir(path.join(root, ".gjc"), { recursive: true });
			await fs.writeFile(
				path.join(root, ".gjc", "settings.json"),
				JSON.stringify({ "gjc.ultragoal.nudgeBudget": 0 }),
			);
			await startNextUltragoalGoal({ cwd: root, sessionId });
			const harness = createRuntimeHarness({
				enabled: true,
				mode: "active",
				goal: createGoal({ objective: plan.gjcObjective }),
			});
			const tool = new GoalTool(
				createToolSession({
					cwd: root,
					getSessionId: () => sessionId,
					getGoalRuntime: () => harness.runtime,
					getGoalModeState: () => harness.getState(),
				}),
			);

			await expect(tool.execute("call-complete", { op: "complete" })).rejects.toThrow(
				"Ultragoal aggregate completion requires a fresh final aggregate receipt",
			);
			expect(harness.getState()?.goal.status).toBe("active");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("allows create after previous goal is complete", async () => {
		const harness = createRuntimeHarness({
			enabled: false,
			mode: "exiting",
			reason: "completed",
			goal: createGoal({ status: "complete" }),
		});
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => harness.runtime,
				getGoalModeState: () => harness.getState(),
			}),
		);

		const result = await tool.execute("call-create", {
			op: "create",
			objective: "Next goal",
		});
		expect(result.details?.goal?.objective).toBe("Next goal");
		expect(result.details?.goal?.status).toBe("active");
	});

	it("op=get returns a paused goal even when enabled=false", async () => {
		const harness = createRuntimeHarness({
			enabled: false,
			mode: "active",
			goal: createGoal({ status: "paused" }),
		});
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => harness.runtime,
				getGoalModeState: () => harness.getState(),
			}),
		);

		const result = await tool.execute("call-get", { op: "get" });
		expect(result.details?.goal?.status).toBe("paused");
		expect(result.details?.goal?.objective).toBe("Ship it");
	});

	it("op=resume re-activates a paused goal", async () => {
		const harness = createRuntimeHarness({
			enabled: false,
			mode: "active",
			goal: createGoal({ status: "paused" }),
		});
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => harness.runtime,
				getGoalModeState: () => harness.getState(),
			}),
		);

		const result = await tool.execute("call-resume", { op: "resume" });
		expect(result.details?.op).toBe("resume");
		expect(result.details?.goal?.status).toBe("active");
		expect(harness.getState()?.enabled).toBe(true);
	});
	it("op=pause parks an active goal and stops the continuation loop", async () => {
		const harness = createRuntimeHarness({
			enabled: true,
			mode: "active",
			goal: createGoal({ objective: "Sing the vocal layers" }),
		});
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => harness.runtime,
				getGoalModeState: () => harness.getState(),
			}),
		);

		// continuation is armed while the goal is active
		expect(harness.runtime.buildContinuationPrompt()).toBeTypeOf("string");

		const result = await tool.execute("call-pause", { op: "pause" });
		expect(result.details?.op).toBe("pause");
		expect(result.details?.goal?.status).toBe("paused");
		expect(harness.getState()?.enabled).toBe(false);

		// pausing suppresses the autonomous continuation steer
		expect(harness.runtime.buildContinuationPrompt()).toBeUndefined();
		// an active goal is persisted in the goal_paused mode when parked
		expect(harness.persists).toContain("goal_paused");
	});

	it("a paused goal resumes back to active and re-arms continuation", async () => {
		const harness = createRuntimeHarness({
			enabled: true,
			mode: "active",
			goal: createGoal({ objective: "Sing the vocal layers" }),
		});
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => harness.runtime,
				getGoalModeState: () => harness.getState(),
			}),
		);

		await tool.execute("call-pause", { op: "pause" });
		expect(harness.runtime.buildContinuationPrompt()).toBeUndefined();

		const resumed = await tool.execute("call-resume", { op: "resume" });
		expect(resumed.details?.goal?.status).toBe("active");
		expect(harness.getState()?.enabled).toBe(true);
		expect(harness.runtime.buildContinuationPrompt()).toBeTypeOf("string");
	});
	it("op=pause rejects a completed goal and leaves its lifecycle intact", async () => {
		const harness = createRuntimeHarness({
			enabled: false,
			mode: "exiting",
			reason: "completed",
			goal: createGoal({ objective: "Already done", status: "complete" }),
		});
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => harness.runtime,
				getGoalModeState: () => harness.getState(),
			}),
		);

		await expect(tool.execute("call-pause", { op: "pause" })).rejects.toThrow(/cannot pause/);

		// the completed goal must not be driven into a paused-mode lifecycle
		const state = harness.getState();
		expect(state?.goal.status).toBe("complete");
		expect(state?.mode).toBe("exiting");
		expect(state?.reason).toBe("completed");
		expect(state?.enabled).toBe(false);
		// a rejected pause must never persist in the goal_paused mode
		expect(harness.persists).not.toContain("goal_paused");
	});

	it("op=pause rejects an already-paused goal", async () => {
		const harness = createRuntimeHarness({
			enabled: false,
			mode: "active",
			goal: createGoal({ objective: "Already parked", status: "paused" }),
		});
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => harness.runtime,
				getGoalModeState: () => harness.getState(),
			}),
		);

		await expect(tool.execute("call-pause", { op: "pause" })).rejects.toThrow(/cannot pause/);
		expect(harness.getState()?.goal.status).toBe("paused");
		expect(harness.persists).not.toContain("goal_paused");
	});
	it("op=pause on a dropped/empty goal is a no-op that returns no goal", async () => {
		const harness = createRuntimeHarness();
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => harness.runtime,
				getGoalModeState: () => harness.getState(),
			}),
		);

		const result = await tool.execute("call-pause", { op: "pause" });
		expect(result.details?.goal).toBeNull();
		expect(harness.getState()).toBeUndefined();
		expect(harness.persists).not.toContain("goal_paused");
	});

	it("op=drop clears goal state", async () => {
		const harness = createRuntimeHarness({
			enabled: true,
			mode: "active",
			goal: createGoal({ objective: "Drop me" }),
		});
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => harness.runtime,
				getGoalModeState: () => harness.getState(),
			}),
		);

		const result = await tool.execute("call-drop", { op: "drop" });
		expect(result.details?.op).toBe("drop");
		expect(result.details?.goal?.status).toBe("dropped");
		expect(harness.getState()).toBeUndefined();
	});

	it("exposes the schema describe enumerating all six ops", () => {
		const tool = new GoalTool(createToolSession({}));
		const opDescribe = (tool.parameters as any).shape.op.description;
		expect(opDescribe).toBe(
			"op: get | create | complete | drop | resume | pause — drop clears the active goal without exiting goal mode (tool stays callable for the next create); pause parks an active goal whose remaining work is blocked on human input so the autonomous continuation loop stops until resume",
		);
	});

	it("schema describe contains every op token and the drop-armed semantic", () => {
		const tool = new GoalTool(createToolSession({}));
		const opDescribe = (tool.parameters as any).shape.op.description as string;
		expect(opDescribe).toContain("get");
		expect(opDescribe).toContain("create");
		expect(opDescribe).toContain("complete");
		expect(opDescribe).toContain("drop");
		expect(opDescribe).toContain("resume");
		expect(opDescribe).toContain("pause");
		expect(opDescribe).toContain("without exiting goal mode");
	});
});
