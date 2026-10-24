import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import type { Goal } from "@gajae-code/coding-agent/goals/state";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { ResolveTool } from "@gajae-code/coding-agent/tools/resolve";
import { TempDir } from "@gajae-code/utils";
import { InteractiveMode } from "../src/modes/interactive-mode";

function goal(id: string, objective: string): Goal {
	return {
		id,
		objective,
		status: "active",
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: 1,
		updatedAt: 1,
	};
}

describe("interactive controllers follow a committed session switch", () => {
	const sessions: AgentSession[] = [];
	const modes: InteractiveMode[] = [];
	const authStorages: AuthStorage[] = [];
	const tempDirs: TempDir[] = [];

	beforeAll(async () => {
		initTheme();
		await Settings.init({ inMemory: true });
	});

	afterEach(async () => {
		for (const mode of modes.splice(0)) mode.stop();
		for (const session of sessions.splice(0)) await session.dispose();
		for (const authStorage of authStorages.splice(0)) authStorage.close();
		for (const tempDir of tempDirs.splice(0)) tempDir.removeSync();
	});

	afterAll(() => resetSettingsForTest());

	async function createSession(
		globalSettings?: Parameters<typeof Settings.isolated>[0],
		options?: { emptyTools?: boolean },
	): Promise<{ session: AgentSession; mode: InteractiveMode; tempDir: TempDir }> {
		const tempDir = TempDir.createSync("switch-mode-controllers-");
		tempDirs.push(tempDir);
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("missing bundled model");
		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: createMockModel({ responses: [{ content: ["Done"] }] }).stream,
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({ "compaction.enabled": false, ...globalSettings }),
			modelRegistry: new ModelRegistry(authStorage),
			explicitEmptyToolSelection: options?.emptyTools !== false,
		});
		sessions.push(session);
		const mode = new InteractiveMode(session, "test");
		modes.push(mode);
		return { session, mode, tempDir };
	}

	async function persistOtherSession(
		tempDir: TempDir,
		mode: { mode: "plan"; planFilePath: string } | { mode: "plan_paused" } | { mode: "goal"; goal: Goal },
	): Promise<string> {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		try {
			manager.appendMessage({ role: "user", content: "other session", timestamp: 1 });
			if (mode.mode === "plan") manager.appendModeChange("plan", { planFilePath: mode.planFilePath });
			if (mode.mode === "plan_paused") manager.appendModeChange("plan_paused");
			if (mode.mode === "goal") manager.appendModeChange("goal", { goal: mode.goal });
			await manager.ensureOnDisk();
			await manager.flush();
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("expected other session file");
			return sessionFile;
		} finally {
			await manager.close();
		}
	}

	async function activateGoal(mode: InteractiveMode): Promise<void> {
		await mode.goalModeController.enter({ objective: "predecessor objective", silent: true });
		expect(mode.goalModeController.enabled).toBe(true);
	}

	it("does not activate a saved plan when the tool selection is empty", async () => {
		const { session, mode, tempDir } = await createSession();
		await activateGoal(mode);
		const other = await persistOtherSession(tempDir, { mode: "plan", planFilePath: "successor-plan.md" });

		expect(await session.switchSession(other)).toBe(true);
		expect(mode.planModeController.enabled).toBe(false);
		expect(mode.planModeController.paused).toBe(false);
		expect(session.getPlanModeState()).toBeUndefined();
		expect(session.peekStandingResolveHandler()).toBeUndefined();
		expect(mode.goalModeController.enabled).toBe(false);
	});

	it("rehydrates a saved plan and accepts approval through resolve", async () => {
		const { session, mode, tempDir } = await createSession(undefined, { emptyTools: false });
		const planFilePath = "successor-plan.md";
		fs.writeFileSync(path.join(tempDir.path(), planFilePath), "# Ship the release\n\nDo the work.\n");
		const other = await persistOtherSession(tempDir, { mode: "plan", planFilePath });

		expect(await session.switchSession(other)).toBe(true);
		expect(mode.planModeController.enabled).toBe(true);
		expect(mode.planModeController.planFilePath).toBe(planFilePath);
		expect(session.peekStandingResolveHandler()).toBeDefined();
		const tool = new ResolveTool(session as unknown as ToolSession);
		const result = await tool.execute("plan-approval", { action: "apply", reason: "ready" });
		expect(result.content).toEqual([{ type: "text", text: "Plan ready for approval." }]);
		await mode.goalModeController.enter({ objective: "must stay blocked", silent: true });
		expect(mode.goalModeController.enabled).toBe(false);
	});

	it("reconciles controllers when cleanup fails after the successor commits", async () => {
		const { session, mode, tempDir } = await createSession(undefined, { emptyTools: false });
		await activateGoal(mode);
		fs.writeFileSync(path.join(tempDir.path(), "cleanup-plan.md"), "# Cleanup plan\n\nStill there.\n");
		const other = await persistOtherSession(tempDir, { mode: "plan", planFilePath: "cleanup-plan.md" });
		const unregister = session.registerToolSessionTransitionCleanup(() => {
			throw new Error("switch cleanup boom");
		});
		try {
			await expect(session.switchSession(other)).rejects.toThrow("Tool session transition cleanup failed");
			expect(mode.planModeController.enabled).toBe(true);
			expect(mode.planModeController.planFilePath).toBe("cleanup-plan.md");
			expect(session.peekStandingResolveHandler()).toBeDefined();
			expect(mode.goalModeController.enabled).toBe(false);
			await mode.goalModeController.enter({ objective: "must stay blocked", silent: true });
			expect(mode.goalModeController.enabled).toBe(false);
		} finally {
			unregister();
		}
	});

	it("keeps the previous controllers when switch fails before commit", async () => {
		const { session, mode, tempDir } = await createSession();
		await activateGoal(mode);
		const other = await persistOtherSession(tempDir, { mode: "plan", planFilePath: "not-committed.md" });

		await expect(
			session.switchSession(other, {
				onTransitionMutationStarted() {
					throw new Error("before commit");
				},
			}),
		).rejects.toThrow("before commit");
		expect(mode.goalModeController.enabled).toBe(true);
		expect(mode.planModeController.enabled).toBe(false);
		expect(session.getGoalModeState()?.goal.objective).toBe("predecessor objective");
	});

	it("does not arm the goal controller when goal mode is disabled", async () => {
		const { session, mode, tempDir } = await createSession({ "goal.enabled": false });
		mode.goalModeController.setEnabledForCompatibility(true);
		session.setGoalModeState({ enabled: true, mode: "active", goal: goal("pred", "PREDECESSOR-GOAL-OBJECTIVE") });
		const other = await persistOtherSession(tempDir, {
			mode: "goal",
			goal: goal("succ", "SUCCESSOR-GOAL-OBJECTIVE"),
		});

		expect(await session.switchSession(other)).toBe(true);
		expect(session.getGoalModeState()).toBeUndefined();
		expect(mode.goalModeController.enabled).toBe(false);
		expect(mode.goalModeController.paused).toBe(false);
		expect(mode.planModeController.enabled).toBe(false);
	});

	it("does not activate plan mode when plan mode is disabled", async () => {
		const { session, mode, tempDir } = await createSession({ "plan.enabled": false }, { emptyTools: false });
		const other = await persistOtherSession(tempDir, { mode: "plan", planFilePath: "disabled-plan.md" });

		expect(await session.switchSession(other)).toBe(true);
		expect(session.getPlanModeState()).toBeUndefined();
		expect(mode.planModeController.enabled).toBe(false);
		expect(mode.planModeController.paused).toBe(false);
		expect(session.peekStandingResolveHandler()).toBeUndefined();
	});

	it("pauses the plan controller for a saved paused plan", async () => {
		const { session, mode, tempDir } = await createSession(undefined, { emptyTools: false });
		await activateGoal(mode);
		const other = await persistOtherSession(tempDir, { mode: "plan_paused" });

		expect(await session.switchSession(other)).toBe(true);
		expect(mode.planModeController.enabled).toBe(false);
		expect(mode.planModeController.paused).toBe(true);
		expect(mode.goalModeController.enabled).toBe(false);
		await mode.goalModeController.enter({ objective: "must stay blocked", silent: true });
		expect(mode.goalModeController.enabled).toBe(false);
	});

	it("keeps controllers when switchSession reloads the same file", async () => {
		const { session, mode } = await createSession();
		await activateGoal(mode);
		const sessionFile = session.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("expected session file");
		await session.sessionManager.flush();

		expect(await session.switchSession(sessionFile)).toBe(true);
		expect(mode.goalModeController.enabled).toBe(true);
		expect(mode.planModeController.enabled).toBe(false);
	});
});
