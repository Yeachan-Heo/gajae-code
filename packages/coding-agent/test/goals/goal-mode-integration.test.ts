import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { GoalTool } from "@gajae-code/coding-agent/goals/tools/goal-tool";
import { InteractiveMode } from "@gajae-code/coding-agent/modes/interactive-mode";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { createTools, type Tool, type ToolSession } from "@gajae-code/coding-agent/tools";
import { TempDir } from "@gajae-code/utils";

function createToolSession(cwd: string, settings: Settings, overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings,
		...overrides,
	};
}

type GoalHarness = {
	tempDir: TempDir;
	authStorage: AuthStorage;
	settings: Settings;
	session: AgentSession;
	mode: InteractiveMode;
	toolSession: ToolSession;
	cleanup: () => Promise<void>;
};

async function createGoalHarness(): Promise<GoalHarness> {
	resetSettingsForTest();
	const tempDir = TempDir.createSync("@pi-goal-mode-");
	await Settings.init({ inMemory: true, cwd: tempDir.path() });
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
	const modelRegistry = new ModelRegistry(authStorage);
	const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
	if (!model) {
		throw new Error("Expected claude-sonnet-4-5 to exist in registry");
	}

	const settings = Settings.isolated({
		"compaction.enabled": false,
		"goal.enabled": true,
		"plan.enabled": true,
	});
	const bootstrapToolSession = createToolSession(tempDir.path(), settings);
	const initialTools = await createTools(bootstrapToolSession, ["read"]);
	const toolRegistry = new Map<string, Tool>(initialTools.map(tool => [tool.name, tool] as const));

	const session = new AgentSession({
		agent: new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: initialTools,
				messages: [],
			},
		}),
		sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
		settings,
		modelRegistry,
		toolRegistry,
		rebuildSystemPrompt: async () => ({ systemPrompt: ["Test"] }),
	});
	const mode = new InteractiveMode(session, "test");
	const toolSession = createToolSession(tempDir.path(), settings, {
		getGoalModeState: () => session.getGoalModeState(),
		getGoalRuntime: () => session.goalRuntime,
	});
	toolRegistry.set("goal", new GoalTool(toolSession) as unknown as Tool);

	return {
		tempDir,
		authStorage,
		settings,
		session,
		mode,
		toolSession,
		cleanup: async () => {
			mode.stop();
			await session.dispose();
			authStorage.close();
			tempDir.removeSync();
			resetSettingsForTest();
		},
	};
}

async function toolNamesFor(harness: GoalHarness): Promise<string[]> {
	return (await createTools(harness.toolSession, harness.session.getActiveToolNames())).map(tool => tool.name);
}

describe("InteractiveMode goal mode integration", () => {
	let harness: GoalHarness;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		harness = await createGoalHarness();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await harness.cleanup();
	});

	it("keeps the unified goal tool exposed across inactive, active, and paused states", async () => {
		expect(await toolNamesFor(harness)).toContain("goal");
		expect(await toolNamesFor(harness)).not.toEqual(
			expect.arrayContaining(["get_goal", "create_goal", "update_goal"]),
		);

		await harness.mode.handleGoalModeCommand("Ship the release");

		expect(harness.mode.goalModeEnabled).toBe(true);
		expect(harness.session.getGoalModeState()?.enabled).toBe(true);
		expect(await toolNamesFor(harness)).toContain("goal");

		vi.spyOn(harness.mode, "showHookSelector").mockResolvedValue("Pause");
		await harness.mode.handleGoalModeCommand();

		expect(harness.mode.goalModeEnabled).toBe(false);
		expect(harness.mode.goalModePaused).toBe(true);
		expect(harness.session.getGoalModeState()?.goal.status).toBe("paused");
		expect(await toolNamesFor(harness)).toContain("goal");
		expect(await toolNamesFor(harness)).not.toEqual(
			expect.arrayContaining(["get_goal", "create_goal", "update_goal"]),
		);
	});

	it("replaces the active goal via /goal set", async () => {
		await harness.mode.handleGoalModeCommand("Ship the release");
		const originalGoal = harness.session.getGoalModeState()?.goal;
		if (!originalGoal) throw new Error("expected active goal");

		await harness.mode.handleGoalModeCommand("set Replace the objective");

		const state = harness.session.getGoalModeState();
		expect(state?.enabled).toBe(true);
		expect(state?.goal.objective).toBe("Replace the objective");
		expect(state?.goal.status).toBe("active");
		expect(state?.goal.id).not.toBe(originalGoal.id);
		expect(harness.mode.goalModeEnabled).toBe(true);
		expect(await toolNamesFor(harness)).toContain("goal");
	});

	it("refuses /goal while plan mode is active", async () => {
		const showWarning = vi.spyOn(harness.mode, "showWarning");
		harness.mode.planModeEnabled = true;

		await harness.mode.handleGoalModeCommand("Ship the release");

		expect(showWarning).toHaveBeenCalledWith("Exit plan mode first.");
		expect(harness.session.getGoalModeState()).toBeUndefined();
	});

	it("refuses /plan while goal mode is active", async () => {
		await harness.mode.handleGoalModeCommand("Ship the release");
		const showWarning = vi.spyOn(harness.mode, "showWarning");

		await harness.mode.handlePlanModeCommand();

		expect(showWarning).toHaveBeenCalledWith("Exit goal mode first.");
		expect(harness.mode.planModeEnabled).toBe(false);
	});

	it("rejects a new /goal objective while paused", async () => {
		await harness.mode.handleGoalModeCommand("Ship the release");
		vi.spyOn(harness.mode, "showHookSelector").mockResolvedValue("Pause");
		await harness.mode.handleGoalModeCommand();
		const showWarning = vi.spyOn(harness.mode, "showWarning");

		await harness.mode.handleGoalModeCommand("Replace the objective");

		expect(showWarning).toHaveBeenCalledWith(
			"Resume the current goal first, or drop it before setting a new objective.",
		);
		expect(harness.session.getGoalModeState()?.enabled).toBe(false);
		expect(harness.session.getGoalModeState()?.goal.objective).toBe("Ship the release");
		expect(harness.session.getGoalModeState()?.goal.status).toBe("paused");
	});

	it("resumes the paused goal via the bare /goal menu", async () => {
		await harness.mode.handleGoalModeCommand("Ship the release");
		const selector = vi.spyOn(harness.mode, "showHookSelector").mockResolvedValueOnce("Pause");
		await harness.mode.handleGoalModeCommand();
		expect(harness.mode.goalModePaused).toBe(true);
		selector.mockResolvedValueOnce("Resume");
		const showStatus = vi.spyOn(harness.mode, "showStatus");

		await harness.mode.handleGoalModeCommand();

		expect(showStatus).toHaveBeenCalledWith("Goal mode resumed.");
		expect(harness.mode.goalModeEnabled).toBe(true);
		expect(harness.mode.goalModePaused).toBe(false);
		expect(harness.session.getGoalModeState()?.enabled).toBe(true);
		expect(harness.session.getGoalModeState()?.goal.objective).toBe("Ship the release");
		expect(harness.session.getGoalModeState()?.goal.status).toBe("active");
		expect(await toolNamesFor(harness)).toContain("goal");
	});

	it("arms the active goal tool after gjc ultragoal create-goals succeeds", async () => {
		const cliPath = path.resolve(import.meta.dir, "..", "..", "src", "cli.ts");
		const result = await harness.session.executeBash(
			`bun ${JSON.stringify(cliPath)} ultragoal create-goals --brief "Complete ultragoal regression"`,
		);

		expect(result.exitCode).toBe(0);
		expect(harness.session.getGoalModeState()?.goal.objective).toContain(".gjc/ultragoal/goals.json");
		expect(harness.session.getActiveToolNames()).toContain("goal");
	});

	it("treats budget as objective text instead of a goal budget command", async () => {
		await harness.mode.handleGoalModeCommand("budget 123");

		const goal = harness.session.getGoalModeState()?.goal;
		expect(goal?.objective).toBe("budget 123");
		expect("tokenBudget" in (goal ?? {})).toBe(false);
	});

	it("keeps the goal tool in the active set after goal({op:drop})", async () => {
		await harness.mode.handleGoalModeCommand("objective A");
		expect(harness.session.getActiveToolNames()).toContain("goal");

		const goalTool = harness.session.getToolByName("goal");
		if (!goalTool) throw new Error("goal tool not registered");
		await goalTool.execute("call-id", { op: "drop" });

		// Runtime drop wipes host state and emits a goal_updated event. The mode
		// subscriber that handles dropped→#exitGoalMode is wired by mode.init(),
		// which the harness does not call (avoids TUI startup). AC10 below covers
		// the UI-path that bypasses the subscriber via #confirmAndDropGoal.
		// Here we verify the runtime-side invariants: state is cleared and the
		// `goal` tool remains in the raw active set (no side-effect deregistered it).
		expect(harness.session.getGoalModeState()).toBeUndefined();
		expect(harness.session.getActiveToolNames()).toContain("goal");
	});

	it("keeps the goal tool in the active set when goal({op:complete}) flows through getUserInput", async () => {
		await harness.mode.handleGoalModeCommand("objective A");
		expect(harness.session.getActiveToolNames()).toContain("goal");

		const goalTool = harness.session.getToolByName("goal");
		if (!goalTool) throw new Error("goal tool not registered");
		await goalTool.execute("call-id", { op: "complete" });

		// completeGoalFromTool sets state.mode="exiting". The deferred completed-exit
		// runs at the next getUserInput() (interactive-mode.ts:623-625) BEFORE the
		// promise awaits the input callback, so we drain state, then resolve the
		// input callback to release the promise.
		const nextTurn = harness.mode.getUserInput();
		for (let i = 0; i < 100 && harness.session.getGoalModeState() !== undefined; i++) {
			await Bun.sleep(0);
		}
		harness.mode.onInputCallback?.(harness.mode.startPendingSubmission({ text: "next turn" }));
		await nextTurn;

		expect(harness.session.getActiveToolNames()).toContain("goal");
	});

	it("supports create A → drop → create B → get in one session", async () => {
		await harness.mode.handleGoalModeCommand("objective A");
		expect(harness.session.getActiveToolNames()).toContain("goal");

		const goalTool = harness.session.getToolByName("goal");
		if (!goalTool) throw new Error("goal tool not registered");

		await goalTool.execute("call-1", { op: "drop" });
		// Runtime drop wipes host state and emits goal_updated. The session
		// subscriber that would route this to mode is wired by mode.init().
		// For the round-trip we verify what the runtime guarantees: drop clears
		// state, create after dropped succeeds, and the goal tool remains
		// callable throughout (the bug being fixed was a side-effect on the
		// active tool set; in this harness setup the set is only mutated by
		// #enterGoalMode, so seeing "goal" still present is the AC).
		expect(harness.session.getGoalModeState()).toBeUndefined();
		expect(harness.session.getActiveToolNames()).toContain("goal");

		await goalTool.execute("call-2", { op: "create", objective: "objective B" });
		expect(harness.session.getActiveToolNames()).toContain("goal");
		expect(harness.session.getGoalModeState()?.goal.objective).toBe("objective B");

		const getResult = await goalTool.execute("call-3", { op: "get" });
		expect((getResult as any).details?.goal?.objective).toBe("objective B");
	});

	it("keeps the goal tool armed after /goal drop (UI path)", async () => {
		await harness.mode.handleGoalModeCommand("objective A");
		expect(harness.session.getActiveToolNames()).toContain("goal");

		// The UI path invokes #confirmAndDropGoal which calls #exitGoalMode
		// directly (not via the goal_updated subscriber), so the mode-side
		// invariant is observable even without mode.init().
		vi.spyOn(harness.mode, "showHookConfirm").mockResolvedValue(true);

		await harness.mode.handleGoalModeCommand("drop");
		for (let i = 0; i < 100 && harness.mode.goalModeEnabled; i++) {
			await Bun.sleep(0);
		}

		expect(harness.session.getActiveToolNames()).toContain("goal");
		expect(harness.mode.goalModeEnabled).toBe(false);
	});

	it("returns completion usage from the goal tool and exits goal mode before the next turn rebuild", async () => {
		await harness.mode.handleGoalModeCommand("Ship the release");
		const appendCustomEntry = vi.spyOn(harness.session.sessionManager, "appendCustomEntry");
		const goalTool = (await createTools(harness.toolSession, harness.session.getActiveToolNames())).find(
			tool => tool.name === "goal",
		);
		if (!goalTool) {
			throw new Error("Expected goal tool to be active");
		}

		const result = await goalTool.execute("call-1", { op: "complete" });
		const completionText = JSON.stringify(result.content);

		expect(result.details).not.toHaveProperty("completionBudgetReport");
		expect(completionText.toLowerCase()).not.toContain("budget");
		expect(harness.session.getGoalModeState()?.mode).toBe("exiting");
		expect(harness.session.getGoalModeState()?.enabled).toBe(false);
		expect(await toolNamesFor(harness)).toContain("goal");
		expect(await toolNamesFor(harness)).not.toEqual(
			expect.arrayContaining(["get_goal", "create_goal", "update_goal"]),
		);

		const nextTurn = harness.mode.getUserInput();
		for (let i = 0; i < 100 && harness.session.getGoalModeState() !== undefined; i++) {
			await Bun.sleep(0);
		}
		expect(harness.mode.goalModeEnabled).toBe(false);
		expect(harness.mode.goalModePaused).toBe(false);
		expect(harness.session.getGoalModeState()).toBeUndefined();
		expect(await toolNamesFor(harness)).toContain("goal");
		expect(await toolNamesFor(harness)).not.toEqual(
			expect.arrayContaining(["get_goal", "create_goal", "update_goal"]),
		);
		expect(
			appendCustomEntry.mock.calls.some(call => {
				const payload = call[1];
				return typeof payload === "object" && payload !== null && "tokenBudget" in payload;
			}),
		).toBe(false);
		expect(appendCustomEntry).toHaveBeenCalledWith(
			"goal-completed",
			expect.objectContaining({
				objective: "Ship the release",
				tokensUsed: 0,
			}),
		);

		harness.mode.onInputCallback?.(harness.mode.startPendingSubmission({ text: "next turn" }));
		await nextTurn;
	});
	it("does not loop AgentBusyError when a busy/orphaned session triggers goal continuation", async () => {
		await harness.mode.handleGoalModeCommand("Ship the release");
		expect(harness.mode.goalModeEnabled).toBe(true);
		expect(harness.session.goalRuntime.buildContinuationPrompt()).toBeTruthy();

		// Simulate a wedged/orphaned turn: the interactive loop is back at
		// getUserInput() but the session still reports busy (isStreaming stuck true).
		harness.session.agent.state.isStreaming = true;

		const startPending = vi.spyOn(harness.mode, "startPendingSubmission");

		vi.useFakeTimers();
		try {
			// getUserInput() arms the 800ms goal-continuation timer.
			void harness.mode.getUserInput();

			// While the session is busy, the continuation must never fire prompt()
			// (which throws AgentBusyError and spams "Error: Agent is already
			// processing…"). Advancing past several 800ms windows must not produce a
			// single continuation submission.
			for (let i = 0; i < 5; i++) {
				vi.advanceTimersByTime(800);
			}
			const busyCalls = startPending.mock.calls.filter(call => call[0]?.customType === "goal-continuation");
			expect(busyCalls.length).toBe(0);

			// Once the session returns to idle, the re-armed continuation fires.
			harness.session.agent.state.isStreaming = false;
			vi.advanceTimersByTime(800);
			const idleCalls = startPending.mock.calls.filter(call => call[0]?.customType === "goal-continuation");
			expect(idleCalls.length).toBeGreaterThan(0);
		} finally {
			vi.useRealTimers();
		}
	});
	it("does not loop AgentBusyError while compaction is in progress", async () => {
		await harness.mode.handleGoalModeCommand("Ship the release");
		expect(harness.mode.goalModeEnabled).toBe(true);
		expect(harness.session.goalRuntime.buildContinuationPrompt()).toBeTruthy();

		// Compaction keeps the session busy without necessarily setting isStreaming.
		// The continuation timer can fire mid-compaction; prompt() would then throw
		// AgentBusyError and loop the same way the orphan-subagent wedge does.
		let compacting = true;
		Object.defineProperty(harness.session, "isCompacting", {
			configurable: true,
			get: () => compacting,
		});

		const startPending = vi.spyOn(harness.mode, "startPendingSubmission");

		vi.useFakeTimers();
		try {
			void harness.mode.getUserInput();

			for (let i = 0; i < 5; i++) {
				vi.advanceTimersByTime(800);
			}
			const compactingCalls = startPending.mock.calls.filter(call => call[0]?.customType === "goal-continuation");
			expect(compactingCalls.length).toBe(0);

			// Compaction finished: the re-armed continuation fires.
			compacting = false;
			vi.advanceTimersByTime(800);
			const afterCompactionCalls = startPending.mock.calls.filter(
				call => call[0]?.customType === "goal-continuation",
			);
			expect(afterCompactionCalls.length).toBeGreaterThan(0);
		} finally {
			vi.useRealTimers();
		}
	});
});
