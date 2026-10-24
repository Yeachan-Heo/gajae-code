import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import type { Goal } from "@gajae-code/coding-agent/goals/state";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";

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

function messageText(messages: readonly AgentMessage[]): string {
	return messages
		.map(message => {
			if (message.role === "custom") {
				return typeof message.content === "string" ? message.content : JSON.stringify(message.content);
			}
			if (!("content" in message) || !Array.isArray(message.content)) return "";
			return message.content
				.map(part =>
					typeof part === "object" && part && "text" in part && typeof part.text === "string" ? part.text : "",
				)
				.join("");
		})
		.join("\n");
}

describe("AgentSession switchSession plan and goal mode", () => {
	const sessions: AgentSession[] = [];
	const authStorages: AuthStorage[] = [];
	const tempDirs: TempDir[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		for (const authStorage of authStorages.splice(0)) authStorage.close();
		for (const tempDir of tempDirs.splice(0)) tempDir.removeSync();
	});

	async function createSession(
		globalSettings?: Parameters<typeof Settings.isolated>[0],
	): Promise<{ session: AgentSession; tempDir: TempDir }> {
		const tempDir = TempDir.createSync("switch-mode-");
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
				streamFn: createMockModel({
					responses: [{ content: ["Done"] }, { content: ["Done"] }, { content: ["Done"] }, { content: ["Done"] }],
				}).stream,
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({ "compaction.enabled": false, ...globalSettings }),
			modelRegistry: new ModelRegistry(authStorage),
		});
		sessions.push(session);
		return { session, tempDir };
	}

	async function persistOtherSession(
		tempDir: TempDir,
		mode: { mode: "plan"; planFilePath: string } | { mode: "goal"; goal: Goal } | { mode: "none" },
	): Promise<string> {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		try {
			manager.appendMessage({ role: "user", content: "other session", timestamp: 1 });
			if (mode.mode === "plan") manager.appendModeChange("plan", { planFilePath: mode.planFilePath });
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

	it("refuses to carry plan and goal context into the next session", async () => {
		const { session, tempDir } = await createSession();
		const predecessorPlan = "predecessor-plan.md";
		const predecessorGoal = "PREDECESSOR-GOAL-OBJECTIVE";
		session.setPlanModeState({ enabled: true, planFilePath: predecessorPlan });
		session.setGoalModeState({ enabled: true, mode: "active", goal: goal("pred", predecessorGoal) });
		const other = await persistOtherSession(tempDir, { mode: "none" });

		expect(await session.switchSession(other)).toBe(true);
		expect(session.getPlanModeState()).toBeUndefined();
		expect(session.getGoalModeState()).toBeUndefined();
		expect(session.getSdkConfigItems().mode).toBe("default");

		await session.prompt("hello");
		const text = messageText(session.messages);
		expect(text).not.toContain(predecessorPlan);
		expect(text).not.toContain(predecessorGoal);
		expect(
			session.messages.some(message => message.role === "custom" && message.customType === "plan-mode-context"),
		).toBe(false);
		expect(
			session.messages.some(message => message.role === "custom" && message.customType === "goal-mode-context"),
		).toBe(false);
	});

	it("installs the switched session plan record", async () => {
		const { session, tempDir } = await createSession();
		session.setPlanModeState({ enabled: true, planFilePath: "predecessor-plan.md" });
		session.setGoalModeState({ enabled: true, mode: "active", goal: goal("pred", "PREDECESSOR-GOAL-OBJECTIVE") });
		const successorPlan = "successor-plan.md";
		const other = await persistOtherSession(tempDir, { mode: "plan", planFilePath: successorPlan });

		expect(await session.switchSession(other)).toBe(true);
		expect(session.getPlanModeState()?.planFilePath).toBe(successorPlan);
		expect(session.getPlanModeState()?.enabled).toBe(true);
		expect(session.getGoalModeState()).toBeUndefined();
		expect(session.getSdkConfigItems().mode).toBe("plan");

		await session.prompt("hello");
		const text = messageText(session.messages);
		expect(text).toContain(successorPlan);
		expect(text).not.toContain("predecessor-plan.md");
		expect(text).not.toContain("PREDECESSOR-GOAL-OBJECTIVE");
	});

	it("does not install a saved goal when goal mode is disabled", async () => {
		const { session, tempDir } = await createSession({ "goal.enabled": false });
		const predecessorGoal = "PREDECESSOR-GOAL-OBJECTIVE";
		const successorGoal = "SUCCESSOR-GOAL-OBJECTIVE";
		session.setPlanModeState({ enabled: true, planFilePath: "predecessor-plan.md" });
		session.setGoalModeState({ enabled: true, mode: "active", goal: goal("pred", predecessorGoal) });
		const other = await persistOtherSession(tempDir, { mode: "goal", goal: goal("succ", successorGoal) });

		expect(await session.switchSession(other)).toBe(true);
		expect(session.getGoalModeState()).toBeUndefined();
		expect(session.getPlanModeState()).toBeUndefined();
		expect(session.getSdkConfigItems().mode).toBe("default");

		await session.prompt("hello");
		const text = messageText(session.messages);
		expect(text).not.toContain(successorGoal);
		expect(text).not.toContain(predecessorGoal);
		expect(
			session.messages.some(message => message.role === "custom" && message.customType === "goal-mode-context"),
		).toBe(false);
	});

	it("leaves a saved goal uninstalled when cleanup fails and goal mode is disabled", async () => {
		const { session, tempDir } = await createSession({ "goal.enabled": false });
		session.setGoalModeState({ enabled: true, mode: "active", goal: goal("pred", "PREDECESSOR-GOAL-OBJECTIVE") });
		const other = await persistOtherSession(tempDir, {
			mode: "goal",
			goal: goal("succ", "SUCCESSOR-GOAL-OBJECTIVE"),
		});
		const unregister = session.registerToolSessionTransitionCleanup(() => {
			throw new Error("switch cleanup boom");
		});
		try {
			await expect(session.switchSession(other)).rejects.toThrow("Tool session transition cleanup failed");
			expect(path.resolve(session.sessionFile ?? "")).toBe(path.resolve(other));
			expect(session.getGoalModeState()).toBeUndefined();
			expect(session.getSdkConfigItems().mode).toBe("default");
		} finally {
			unregister();
		}
	});

	it("keeps an in-memory goal when goal mode is disabled and the session is not switched", async () => {
		const { session } = await createSession({ "goal.enabled": false });
		const objective = "CURRENT-GOAL-OBJECTIVE";
		session.setGoalModeState({ enabled: true, mode: "active", goal: goal("current", objective) });

		await session.prompt("hello");
		expect(session.getGoalModeState()?.goal.objective).toBe(objective);
		expect(messageText(session.messages)).toContain(objective);
	});

	it("installs the switched session goal record", async () => {
		const { session, tempDir } = await createSession();
		session.setPlanModeState({ enabled: true, planFilePath: "predecessor-plan.md" });
		session.setGoalModeState({ enabled: true, mode: "active", goal: goal("pred", "PREDECESSOR-GOAL-OBJECTIVE") });
		const successorGoal = "SUCCESSOR-GOAL-OBJECTIVE";
		const other = await persistOtherSession(tempDir, { mode: "goal", goal: goal("succ", successorGoal) });

		expect(await session.switchSession(other)).toBe(true);
		expect(session.getGoalModeState()?.goal.objective).toBe(successorGoal);
		expect(session.getGoalModeState()?.enabled).toBe(true);
		expect(session.getPlanModeState()).toBeUndefined();
		expect(session.getSdkConfigItems().mode).toBe("default");

		await session.prompt("hello");
		const text = messageText(session.messages);
		expect(text).toContain(successorGoal);
		expect(text).not.toContain("PREDECESSOR-GOAL-OBJECTIVE");
		expect(text).not.toContain("predecessor-plan.md");
	});

	it("clears plan and goal when transition cleanup fails after the successor is active", async () => {
		const { session, tempDir } = await createSession();
		session.setPlanModeState({ enabled: true, planFilePath: "predecessor-plan.md" });
		session.setGoalModeState({ enabled: true, mode: "active", goal: goal("pred", "PREDECESSOR-GOAL-OBJECTIVE") });
		const other = await persistOtherSession(tempDir, { mode: "none" });
		const unregister = session.registerToolSessionTransitionCleanup(() => {
			throw new Error("switch cleanup boom");
		});
		try {
			await expect(session.switchSession(other)).rejects.toThrow("Tool session transition cleanup failed");
			expect(path.resolve(session.sessionFile ?? "")).toBe(path.resolve(other));
			expect(session.getPlanModeState()).toBeUndefined();
			expect(session.getGoalModeState()).toBeUndefined();
			expect(session.getSdkConfigItems().mode).toBe("default");
		} finally {
			unregister();
		}
	});

	it("installs the successor plan when transition cleanup fails", async () => {
		const { session, tempDir } = await createSession();
		session.setPlanModeState({ enabled: true, planFilePath: "predecessor-plan.md" });
		session.setGoalModeState({ enabled: true, mode: "active", goal: goal("pred", "PREDECESSOR-GOAL-OBJECTIVE") });
		const successorPlan = "successor-plan.md";
		const other = await persistOtherSession(tempDir, { mode: "plan", planFilePath: successorPlan });
		const unregister = session.registerToolSessionTransitionCleanup(() => {
			throw new Error("switch cleanup boom");
		});
		try {
			await expect(session.switchSession(other)).rejects.toThrow("Tool session transition cleanup failed");
			expect(path.resolve(session.sessionFile ?? "")).toBe(path.resolve(other));
			expect(session.getPlanModeState()?.planFilePath).toBe(successorPlan);
			expect(session.getPlanModeState()?.enabled).toBe(true);
			expect(session.getGoalModeState()).toBeUndefined();
			expect(session.getSdkConfigItems().mode).toBe("plan");
		} finally {
			unregister();
		}
	});

	it("installs the successor goal when transition cleanup fails", async () => {
		const { session, tempDir } = await createSession();
		session.setPlanModeState({ enabled: true, planFilePath: "predecessor-plan.md" });
		session.setGoalModeState({ enabled: true, mode: "active", goal: goal("pred", "PREDECESSOR-GOAL-OBJECTIVE") });
		const successorGoal = "SUCCESSOR-GOAL-OBJECTIVE";
		const other = await persistOtherSession(tempDir, { mode: "goal", goal: goal("succ", successorGoal) });
		const unregister = session.registerToolSessionTransitionCleanup(() => {
			throw new Error("switch cleanup boom");
		});
		try {
			await expect(session.switchSession(other)).rejects.toThrow("Tool session transition cleanup failed");
			expect(path.resolve(session.sessionFile ?? "")).toBe(path.resolve(other));
			expect(session.getGoalModeState()?.goal.objective).toBe(successorGoal);
			expect(session.getGoalModeState()?.enabled).toBe(true);
			expect(session.getPlanModeState()).toBeUndefined();
			expect(session.getSdkConfigItems().mode).toBe("default");
		} finally {
			unregister();
		}
	});

	it("keeps plan and goal when switchSession fails before commit", async () => {
		const { session, tempDir } = await createSession();
		const predecessorFile = session.sessionFile;
		session.setPlanModeState({ enabled: true, planFilePath: "predecessor-plan.md" });
		session.setGoalModeState({ enabled: true, mode: "active", goal: goal("pred", "PREDECESSOR-GOAL-OBJECTIVE") });
		const other = await persistOtherSession(tempDir, { mode: "none" });
		await expect(
			session.switchSession(other, {
				onTransitionMutationStarted() {
					throw new Error("before commit");
				},
			}),
		).rejects.toThrow("before commit");
		expect(session.sessionFile).toBe(predecessorFile);
		expect(session.getPlanModeState()?.planFilePath).toBe("predecessor-plan.md");
		expect(session.getGoalModeState()?.goal.objective).toBe("PREDECESSOR-GOAL-OBJECTIVE");
		expect(session.getSdkConfigItems().mode).toBe("plan");
	});

	it("keeps plan and goal context on the current session", async () => {
		const { session } = await createSession();
		const planFilePath = "current-plan.md";
		const objective = "CURRENT-GOAL-OBJECTIVE";
		session.setPlanModeState({ enabled: true, planFilePath });
		session.setGoalModeState({ enabled: true, mode: "active", goal: goal("current", objective) });

		await session.prompt("hello");
		const text = messageText(session.messages);
		expect(session.getPlanModeState()?.planFilePath).toBe(planFilePath);
		expect(session.getGoalModeState()?.goal.objective).toBe(objective);
		expect(text).toContain(planFilePath);
		expect(text).toContain(objective);
	});

	it("keeps plan mode when switchSession reloads the same session file", async () => {
		const { session } = await createSession();
		const planFilePath = "reloaded-plan.md";
		session.setPlanModeState({ enabled: true, planFilePath });
		const sessionFile = session.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("expected session file");
		await session.sessionManager.flush();

		expect(await session.switchSession(sessionFile)).toBe(true);
		expect(session.getPlanModeState()?.enabled).toBe(true);
		expect(session.getPlanModeState()?.planFilePath).toBe(planFilePath);
		expect(session.getSdkConfigItems().mode).toBe("plan");
	});

	it("keeps an ordinary prompt free of plan and goal context", async () => {
		const { session } = await createSession();
		await session.prompt("hello");
		expect(session.getPlanModeState()).toBeUndefined();
		expect(session.getGoalModeState()).toBeUndefined();
		expect(
			session.messages.some(message => message.role === "custom" && message.customType === "plan-mode-context"),
		).toBe(false);
		expect(
			session.messages.some(message => message.role === "custom" && message.customType === "goal-mode-context"),
		).toBe(false);
	});
});
