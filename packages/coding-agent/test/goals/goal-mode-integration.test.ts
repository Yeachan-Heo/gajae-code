import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import type { ExtensionRunner } from "@gajae-code/coding-agent/extensibility/extensions";
import { GoalTool } from "@gajae-code/coding-agent/goals/tools/goal-tool";
import { InteractiveMode } from "@gajae-code/coding-agent/modes/interactive-mode";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import {
	FileSessionStorage,
	type SessionStorageWriter,
	type SessionStorageWriterOpenOptions,
} from "@gajae-code/coding-agent/session/session-storage";
import { createTools, type Tool, type ToolSession } from "@gajae-code/coding-agent/tools";
import { logger, TempDir } from "@gajae-code/utils";

class AppendFailureStorage extends FileSessionStorage {
	syncWrites = 0;
	failFromOrdinal = Infinity;

	override openWriter(filePath: string, options?: SessionStorageWriterOpenOptions): SessionStorageWriter {
		const writer = super.openWriter(filePath, options);
		return {
			writeLine: line => writer.writeLine(line),
			writeLineSync: line => {
				this.syncWrites++;
				if (this.syncWrites >= this.failFromOrdinal) {
					throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
				}
				writer.writeLineSync(line);
			},
			flush: () => writer.flush(),
			fsync: () => writer.fsync(),
			close: () => writer.close(),
			closeSync: () => writer.closeSync(),
			getError: () => writer.getError(),
			getCloseState: () => writer.getCloseState(),
			getCloseError: () => writer.getCloseError(),
		};
	}
}

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
	storage: AppendFailureStorage;
	session: AgentSession;
	mode: InteractiveMode;
	toolSession: ToolSession;
	cleanup: () => Promise<void>;
};

async function createGoalHarness(
	options: { extensionRunner?: ExtensionRunner; storage?: AppendFailureStorage } = {},
): Promise<GoalHarness> {
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

	const storage = options.storage ?? new AppendFailureStorage();
	const session = new AgentSession({
		agent: new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: initialTools,
				messages: [],
			},
		}),
		sessionManager: SessionManager.create(tempDir.path(), tempDir.path(), storage),
		settings,
		modelRegistry,
		toolRegistry,
		rebuildSystemPrompt: async () => ({ systemPrompt: ["Test"] }),
		extensionRunner: options.extensionRunner,
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
		storage,
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

async function prepareExitingGoal(harness: GoalHarness): Promise<number> {
	await harness.mode.init();
	harness.mode.ui.stop();
	await harness.session.sessionManager.ensureOnDisk();
	harness.session.sessionManager.appendCustomEntry("test-hot-path", { marker: "hot writer" });
	await harness.mode.goalModeController.handleCommand("Ship the release");
	await new GoalTool(harness.toolSession).execute("complete-goal", { op: "complete" });
	expect(harness.session.getGoalModeState()?.mode).toBe("exiting");
	expect(harness.storage.syncWrites).toBeGreaterThan(0);
	expect(harness.session.sessionManager.isManagedDestination()).toBe(false);
	return harness.storage.syncWrites;
}

let containmentLogs: string[] = [];

async function triggerPersistenceFailure(harness: GoalHarness): Promise<number> {
	const base = await prepareExitingGoal(harness);
	// Capture (not merely mute) the containment log so a bare `.catch(() => {})`
	// that swallows the failure silently can be distinguished from real handling.
	containmentLogs = [];
	const errorSpy = vi.spyOn(logger, "error").mockImplementation((message: unknown) => {
		containmentLogs.push(String(message));
	});
	harness.storage.failFromOrdinal = base + 1;
	harness.session.agent.emitExternalEvent({ type: "agent_end", messages: [] } as never);
	for (let index = 0; index < 20; index++) await Promise.resolve();
	// The `unhandledRejection` hook fires on a macrotask, so a microtask-only drain
	// would let an escaped rejection slip past the collector assertion.
	await new Promise(resolve => setTimeout(resolve, 0));
	errorSpy.mockRestore();
	return base;
}

describe("InteractiveMode goal mode integration", () => {
	let harness: GoalHarness;
	let unhandledRejections: unknown[];
	const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		unhandledRejections = [];
		process.on("unhandledRejection", onUnhandledRejection);
		harness = await createGoalHarness();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		// Assert the TEST BODY produced no unhandled rejection. Teardown is scored
		// separately: once `#persistError` is latched, `dispose()` -> `flush()`
		// legitimately rethrows it (fail-closed durability), and that expected
		// teardown rejection must not be confused with an escaped runtime rejection.
		const bodyRejections = [...unhandledRejections];
		harness.storage.failFromOrdinal = Infinity;
		try {
			await harness.cleanup();
		} catch (error) {
			if (!String(error).includes("ENOSPC")) throw error;
		}
		process.off("unhandledRejection", onUnhandledRejection);
		expect(bodyRejections).toEqual([]);
	});

	it("keeps the unified goal tool exposed across inactive, active, and paused states", async () => {
		expect(await toolNamesFor(harness)).toContain("goal");
		expect(await toolNamesFor(harness)).not.toEqual(
			expect.arrayContaining(["get_goal", "create_goal", "update_goal"]),
		);

		await harness.mode.goalModeController.handleCommand("Ship the release");

		expect(harness.mode.goalModeController.enabled).toBe(true);
		expect(harness.session.getGoalModeState()?.enabled).toBe(true);
		expect(await toolNamesFor(harness)).toContain("goal");

		vi.spyOn(harness.mode, "showHookSelector").mockResolvedValue("Pause");
		await harness.mode.goalModeController.handleCommand();

		expect(harness.mode.goalModeController.enabled).toBe(false);
		expect(harness.mode.goalModeController.paused).toBe(true);
		expect(harness.session.getGoalModeState()?.goal.status).toBe("paused");
		expect(await toolNamesFor(harness)).toContain("goal");
		expect(await toolNamesFor(harness)).not.toEqual(
			expect.arrayContaining(["get_goal", "create_goal", "update_goal"]),
		);
	});

	it("replaces the active goal via /goal set", async () => {
		await harness.mode.goalModeController.handleCommand("Ship the release");
		const originalGoal = harness.session.getGoalModeState()?.goal;
		if (!originalGoal) throw new Error("expected active goal");

		await harness.mode.goalModeController.handleCommand("set Replace the objective");

		const state = harness.session.getGoalModeState();
		expect(state?.enabled).toBe(true);
		expect(state?.goal.objective).toBe("Replace the objective");
		expect(state?.goal.status).toBe("active");
		expect(state?.goal.id).not.toBe(originalGoal.id);
		expect(harness.mode.goalModeController.enabled).toBe(true);
		expect(await toolNamesFor(harness)).toContain("goal");
	});

	it("refuses /goal while plan mode is active", async () => {
		const showWarning = vi.spyOn(harness.mode, "showWarning");
		harness.mode.planModeController.setEnabledForCompatibility(true);

		await harness.mode.goalModeController.handleCommand("Ship the release");

		expect(showWarning).toHaveBeenCalledWith("Exit plan mode first.");
		expect(harness.session.getGoalModeState()).toBeUndefined();
	});

	it("refuses /plan while goal mode is active", async () => {
		await harness.mode.goalModeController.handleCommand("Ship the release");
		const showWarning = vi.spyOn(harness.mode, "showWarning");

		await harness.mode.planModeController.handleCommand();

		expect(showWarning).toHaveBeenCalledWith("Exit goal mode first.");
		expect(harness.mode.planModeController.enabled).toBe(false);
	});

	it("refuses /plan after a goal tool creates an active goal", async () => {
		await harness.mode.init();
		harness.mode.ui.stop();
		const goalTool = new GoalTool(harness.toolSession);
		await goalTool.execute("call-create", { op: "create", objective: "Tool-created goal" });
		await harness.session.waitForIdle();
		const showWarning = vi.spyOn(harness.mode, "showWarning");

		await harness.mode.planModeController.handleCommand();

		expect(harness.mode.goalModeController.enabled).toBe(true);
		expect(showWarning).toHaveBeenCalledWith("Exit goal mode first.");
		expect(harness.mode.planModeController.enabled).toBe(false);
	});

	it("rejects a new /goal objective while paused", async () => {
		await harness.mode.goalModeController.handleCommand("Ship the release");
		vi.spyOn(harness.mode, "showHookSelector").mockResolvedValue("Pause");
		await harness.mode.goalModeController.handleCommand();
		const showWarning = vi.spyOn(harness.mode, "showWarning");

		await harness.mode.goalModeController.handleCommand("Replace the objective");

		expect(showWarning).toHaveBeenCalledWith(
			"Resume the current goal first, or drop it before setting a new objective.",
		);
		expect(harness.session.getGoalModeState()?.enabled).toBe(false);
		expect(harness.session.getGoalModeState()?.goal.objective).toBe("Ship the release");
		expect(harness.session.getGoalModeState()?.goal.status).toBe("paused");
	});

	it("resumes the paused goal via the bare /goal menu", async () => {
		await harness.mode.goalModeController.handleCommand("Ship the release");
		const selector = vi.spyOn(harness.mode, "showHookSelector").mockResolvedValueOnce("Pause");
		await harness.mode.goalModeController.handleCommand();
		expect(harness.mode.goalModeController.paused).toBe(true);
		selector.mockResolvedValueOnce("Resume");
		const showStatus = vi.spyOn(harness.mode, "showStatus");

		await harness.mode.goalModeController.handleCommand();

		expect(showStatus).toHaveBeenCalledWith("Goal mode resumed.");
		expect(harness.mode.goalModeController.enabled).toBe(true);
		expect(harness.mode.goalModeController.paused).toBe(false);
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
	}, 15_000);

	it("treats budget as objective text instead of a goal budget command", async () => {
		await harness.mode.goalModeController.handleCommand("budget 123");

		const goal = harness.session.getGoalModeState()?.goal;
		expect(goal?.objective).toBe("budget 123");
		expect("tokenBudget" in (goal ?? {})).toBe(false);
	});

	it("keeps the goal tool in the active set after goal({op:drop})", async () => {
		await harness.mode.goalModeController.handleCommand("objective A");
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
		await harness.mode.goalModeController.handleCommand("objective A");
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
		await harness.mode.goalModeController.handleCommand("objective A");
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
		await harness.mode.goalModeController.handleCommand("objective A");
		expect(harness.session.getActiveToolNames()).toContain("goal");

		// The UI path invokes #confirmAndDropGoal which calls #exitGoalMode
		// directly (not via the goal_updated subscriber), so the mode-side
		// invariant is observable even without mode.init().
		vi.spyOn(harness.mode, "showHookConfirm").mockResolvedValue(true);

		await harness.mode.goalModeController.handleCommand("drop");
		for (let i = 0; i < 100 && harness.mode.goalModeController.enabled; i++) {
			await Bun.sleep(0);
		}

		expect(harness.session.getActiveToolNames()).toContain("goal");
		expect(harness.mode.goalModeController.enabled).toBe(false);
	});

	it("returns completion usage from the goal tool and exits goal mode before the next turn rebuild", async () => {
		await harness.mode.goalModeController.handleCommand("Ship the release");
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
		expect(harness.mode.goalModeController.enabled).toBe(false);
		expect(harness.mode.goalModeController.paused).toBe(false);
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

	it("completes goal state even when a goal_updated extension hook throws", async () => {
		await harness.cleanup();
		const extensionError = new TypeError(
			'The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received undefined',
		);
		const emit = vi.fn(async (event: { type: string }) => {
			if (event.type === "goal_updated") throw extensionError;
		});
		harness = await createGoalHarness({
			extensionRunner: { emit, getRegisteredCommands: () => [] } as unknown as ExtensionRunner,
		});
		await harness.mode.goalModeController.handleCommand("Ship the release");

		const tool = new GoalTool(harness.toolSession);
		const result = await tool.execute("call-complete", { op: "complete" });

		expect(result.details).toMatchObject({ op: "complete" });
		expect(result.details?.goal?.status).toBe("complete");
		expect(harness.session.getGoalModeState()?.goal.status).toBe("complete");
		expect(harness.session.getGoalModeState()?.mode).toBe("exiting");
		expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: "goal_updated" }));
	});

	it("does not loop AgentBusyError when a busy/orphaned session triggers goal continuation", async () => {
		await harness.mode.goalModeController.handleCommand("Ship the release");
		expect(harness.mode.goalModeController.enabled).toBe(true);
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
		await harness.mode.goalModeController.handleCommand("Ship the release");
		expect(harness.mode.goalModeController.enabled).toBe(true);
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
	it("AC1 contains a real synchronous persistence failure from the live goal-event subscriber", async () => {
		const exitCode = process.exitCode;
		const exit = vi.spyOn(process, "exit");
		await triggerPersistenceFailure(harness);

		expect(unhandledRejections).toEqual([]);
		expect(process.exitCode).toBe(exitCode);
		expect(exit).not.toHaveBeenCalled();
		expect(harness.session.sessionManager.getPersistFailure()).toBeDefined();
	});

	it("AC2 renders the persistent, latch-backed persistence notice", async () => {
		await triggerPersistenceFailure(harness);
		const sessionManager = harness.session.sessionManager;
		expect(sessionManager.getPersistFailure()?.error.message).toContain("ENOSPC");
		expect(harness.mode.isPersistenceBlocked).toBe(true);
		// Rejects the named `.catch(() => {})` counterfactual: containment must
		// ACT on the failure (log + render) before any manual chrome refresh, not
		// merely swallow the rejection and leave the latch to be noticed later.
		expect(containmentLogs).toContain("Session persistence failed while handling a goal session event");
		expect(harness.mode.editor.render(1000).join("\n").toLowerCase()).toContain("not saved");

		harness.mode.ui.requestRender();
		harness.mode.showStatus("unrelated");
		expect(harness.mode.isPersistenceBlocked).toBe(true);
		harness.mode.updateEditorChrome();
		const renderedComposer = harness.mode.editor.render(1000).join("\n").toLowerCase();
		expect(renderedComposer).toContain("persistence");
		expect(renderedComposer).toContain("not saved");
		expect(renderedComposer).toContain(sessionManager.getSessionFile()!.toLowerCase());
		expect(renderedComposer).toContain("enospc");
		expect(renderedComposer).toContain("free space");
		expect(renderedComposer).not.toContain("ship the release");
	});

	it("AC3 rejects new work while keeping blocked input cycles inert and inspectable", async () => {
		await triggerPersistenceFailure(harness);
		const sessionManager = harness.session.sessionManager;
		const entriesBefore = sessionManager.getEntries().length;
		const chatRowsBefore = harness.mode.chatContainer.children.length;
		const rejectedSubmission = harness.mode.startPendingSubmission({ text: "next turn" });
		expect(rejectedSubmission.cancelled).toBe(true);
		expect(harness.mode.chatContainer.children.length).toBe(chatRowsBefore);
		expect(sessionManager.getEntries()).toHaveLength(entriesBefore);

		const beforeGetUserInput = vi.spyOn(harness.mode.goalModeController, "beforeGetUserInput");
		const scheduleContinuation = vi.spyOn(harness.mode.goalModeController, "scheduleContinuation");
		const writesBefore = harness.storage.syncWrites;
		const pendingInputs = [];
		for (let index = 0; index < 3; index++) {
			expect(harness.session.getGoalModeState()?.mode).toBe("exiting");
			pendingInputs.push(harness.mode.getUserInput());
			await Promise.resolve();
		}
		expect(beforeGetUserInput).not.toHaveBeenCalled();
		expect(scheduleContinuation).not.toHaveBeenCalled();
		expect(sessionManager.getEntries()).toHaveLength(entriesBefore);
		expect(harness.storage.syncWrites).toBe(writesBefore);
		expect(unhandledRejections).toEqual([]);
		for (const input of pendingInputs) {
			expect(input).toBeInstanceOf(Promise);
			expect(await Promise.race([input.then(() => false), Promise.resolve(true)])).toBe(true);
		}
		await expect(harness.session.prompt("blocked provider turn")).rejects.toMatchObject({
			code: "persistence_blocked",
		});
	});

	it("AC3d refuses every turn entrant that bypasses prompt admission while blocked", async () => {
		await triggerPersistenceFailure(harness);
		const sessionManager = harness.session.sessionManager;
		const entriesBefore = sessionManager.getEntries().length;
		const writesBefore = harness.storage.syncWrites;

		// steer / followUp / sendUserMessage reach the agent through
		// #queueSteer / #queueFollowUp, NOT through #withSessionAdmission, so they
		// need the shared fence. Each must refuse with the same discriminant.
		await expect(harness.session.steer("steer while blocked")).rejects.toMatchObject({
			code: "persistence_blocked",
		});
		await expect(harness.session.followUp("follow up while blocked")).rejects.toMatchObject({
			code: "persistence_blocked",
		});
		await expect(harness.session.sendUserMessage("send while blocked")).rejects.toMatchObject({
			code: "persistence_blocked",
		});

		// No entrant may append, and none may escape as an unhandled rejection.
		expect(sessionManager.getEntries()).toHaveLength(entriesBefore);
		expect(harness.storage.syncWrites).toBe(writesBefore);
		expect(unhandledRejections).toEqual([]);
	});

	it("AC4 preserves the durable completion ordering across first and second append failures", async () => {
		const firstBase = await prepareExitingGoal(harness);
		const firstAppendCustom = vi.spyOn(harness.session.sessionManager, "appendCustomEntry");
		const firstStatus = vi.spyOn(harness.mode, "showStatus");
		const firstEntries = harness.session.sessionManager.getEntries().length;
		harness.storage.failFromOrdinal = firstBase + 1;
		await expect(harness.mode.goalModeController.exit({ reason: "completed" })).rejects.toThrow("ENOSPC");
		expect(firstAppendCustom).not.toHaveBeenCalled();
		expect(harness.storage.syncWrites).toBe(firstBase + 1);
		expect(harness.session.getGoalModeState()?.mode).toBe("exiting");
		expect(firstStatus.mock.calls.flat().join(" ").toLowerCase()).not.toContain("completed");
		expect(harness.session.sessionManager.getEntries()).toHaveLength(firstEntries + 1);

		// The latch is set, so cleanup's flush legitimately rethrows it (fail-closed).
		harness.storage.failFromOrdinal = Infinity;
		try {
			await harness.cleanup();
		} catch (error) {
			if (!String(error).includes("ENOSPC")) throw error;
		}
		harness = await createGoalHarness();
		const secondBase = await prepareExitingGoal(harness);
		const secondStatus = vi.spyOn(harness.mode, "showStatus");
		harness.storage.failFromOrdinal = secondBase + 2;
		await expect(harness.mode.goalModeController.exit({ reason: "completed" })).rejects.toThrow("ENOSPC");
		const modeChange = harness.session.sessionManager
			.getEntries()
			.find(entry => entry.type === "mode_change" && entry.mode === "none");
		expect(modeChange).toBeDefined();
		const sessionFile = harness.session.sessionManager.getSessionFile();
		expect(fs.readFileSync(sessionFile!, "utf8")).toContain('"type":"mode_change"');
		expect(harness.session.getGoalModeState()).toBeUndefined();
		expect(harness.mode.isPersistenceBlocked).toBe(true);
		expect(secondStatus.mock.calls.flat().join(" ").toLowerCase()).not.toContain("completed");
	});

	it("AC5 leaves controller failures visible, quarantines only persistence failures, and rethrows the latch", async () => {
		await prepareExitingGoal(harness);
		const unexpectedControllerFailure = vi.spyOn(logger, "error");
		vi.spyOn(harness.session, "setActiveToolsByName").mockRejectedValue(new Error("programmer error"));
		harness.session.agent.emitExternalEvent({ type: "agent_end", messages: [] } as never);
		for (let index = 0; index < 20; index++) await Promise.resolve();
		expect(unexpectedControllerFailure).toHaveBeenCalledWith(
			"Goal session event handler failed",
			expect.objectContaining({ error: expect.stringContaining("programmer error") }),
		);
		expect(harness.mode.isPersistenceBlocked).toBe(false);
		expect(harness.mode.getPersistenceBlockedNotice()).toBeUndefined();
		harness.mode.updateEditorChrome();
		expect(harness.mode.editor.render(1000).join("\n").toLowerCase()).not.toContain("persistence failed");

		await harness.cleanup();
		harness = await createGoalHarness();
		const base = await prepareExitingGoal(harness);
		harness.storage.failFromOrdinal = base + 1;
		await expect(harness.mode.goalModeController.exit({ reason: "completed" })).rejects.toThrow("ENOSPC");
		const failure = harness.session.sessionManager.getPersistFailure()?.error;
		expect(failure).toBeDefined();
		try {
			harness.session.sessionManager.appendModeChange("goal");
			expect.unreachable("appendModeChange should rethrow the latched persistence error");
		} catch (error) {
			expect(error).toBe(failure);
		}
	});
});
