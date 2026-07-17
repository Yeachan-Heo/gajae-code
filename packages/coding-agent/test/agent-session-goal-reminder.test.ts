import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import type { AssistantMessage, ToolCall } from "@gajae-code/ai";
import { getBundledModel } from "@gajae-code/ai/models";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import {
	GJC_COORDINATOR_SESSION_ID_ENV,
	GJC_COORDINATOR_SESSION_STATE_FILE_ENV,
} from "@gajae-code/coding-agent/gjc-runtime/session-state-sidecar";
import type { GoalModeState } from "@gajae-code/coding-agent/goals/state";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { logger, TempDir } from "@gajae-code/utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

describe("AgentSession active goal reminders", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-goal-reminder-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");

		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({
				"goal.enabled": true,
				"todo.reminders": true,
				"todo.reminders.max": 3,
			}),
			modelRegistry,
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
	});

	function setActiveGoal(id = "goal-1", objective = "Ship the idle reminder fix"): void {
		session.setGoalModeState({
			enabled: true,
			mode: "active",
			goal: {
				id,
				objective,
				status: "active",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: 0,
				updatedAt: 0,
			},
		});
	}

	async function emitAssistantStop(timestamp: number): Promise<void> {
		const assistantMessage = { ...createAssistantMessage("I stopped."), timestamp };
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });
		await Bun.sleep(50);
		for (let i = 0; i < 20; i++) await Promise.resolve();
		await session.waitForIdle();
	}

	function developerReminderCount(): number {
		return session.agent.state.messages.filter(message => {
			if (message.role !== "developer" || typeof message.content === "string") return false;
			return message.content.some(
				part => part.type === "text" && part.text.includes("goal is still active and uncleared"),
			);
		}).length;
	}

	it("skips turn-start token baseline scan when goal accounting is inactive", async () => {
		const statsSpy = vi.spyOn(session, "getSessionStats");

		session.agent.emitExternalEvent({ type: "turn_start" });
		for (let i = 0; i < 5; i++) await Promise.resolve();

		expect(statsSpy).not.toHaveBeenCalled();
	});

	it("captures turn-start token baseline when a goal is active", async () => {
		setActiveGoal();
		const statsSpy = vi.spyOn(session, "getSessionStats");

		session.agent.emitExternalEvent({ type: "turn_start" });
		for (let i = 0; i < 5; i++) await Promise.resolve();

		expect(statsSpy).toHaveBeenCalled();
		expect(session.goalRuntime.snapshot.turnSnapshot?.activeGoalId).toBe("goal-1");
	});

	it("does not reuse an active-goal baseline after goal mode is disabled", async () => {
		setActiveGoal();
		const statsSpy = vi.spyOn(session, "getSessionStats");

		session.agent.emitExternalEvent({ type: "turn_start" });
		for (let i = 0; i < 5; i++) await Promise.resolve();
		expect(statsSpy).toHaveBeenCalledTimes(1);

		session.setGoalModeState({
			enabled: false,
			mode: "active",
			goal: {
				id: "goal-1",
				objective: "Ship the idle reminder fix",
				status: "active",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: 0,
				updatedAt: 0,
			},
		});
		session.agent.emitExternalEvent({ type: "turn_start" });
		for (let i = 0; i < 5; i++) await Promise.resolve();

		expect(statsSpy).toHaveBeenCalledTimes(1);
	});

	it("continues after an assistant stop when an active goal remains uncleared", async () => {
		setActiveGoal();
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		await emitAssistantStop(100);

		expect(continueSpy).toHaveBeenCalledTimes(1);
		expect(developerReminderCount()).toBe(1);
		const reminder = session.agent.state.messages.find(message => message.role === "developer");
		expect(JSON.stringify(reminder?.content)).toContain("Ship the idle reminder fix");
		expect(JSON.stringify(reminder?.content)).toContain('goal({op:\\"complete\\"})');
	});

	it("does not let an abort without an active goal suppress a later goal reminder", async () => {
		await session.abort();
		setActiveGoal();
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		await emitAssistantStop(125);

		expect(continueSpy).toHaveBeenCalledTimes(1);
		expect(developerReminderCount()).toBe(1);
	});

	it("suppresses only the first reminder after aborting an active goal", async () => {
		setActiveGoal();
		await session.abort();
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		await emitAssistantStop(125);
		expect(continueSpy).not.toHaveBeenCalled();
		expect(developerReminderCount()).toBe(0);

		await emitAssistantStop(126);
		expect(continueSpy).toHaveBeenCalledTimes(1);
		expect(developerReminderCount()).toBe(1);
	});

	it("clears active-goal abort suppression after an inactive reminder evaluation", async () => {
		setActiveGoal();
		await session.abort();
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		session.setGoalModeState(undefined);
		await emitAssistantStop(125);
		setActiveGoal();
		await emitAssistantStop(126);

		expect(continueSpy).toHaveBeenCalledTimes(1);
		expect(developerReminderCount()).toBe(1);
	});

	it("lets a later inactive abort clear suppression from an earlier active-goal abort", async () => {
		setActiveGoal();
		await session.abort();
		session.setGoalModeState(undefined);
		await session.abort();
		setActiveGoal();
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		await emitAssistantStop(125);

		expect(continueSpy).toHaveBeenCalledTimes(1);
		expect(developerReminderCount()).toBe(1);
	});

	it("does not transfer abort suppression to a replacement goal", async () => {
		setActiveGoal("goal-1", "First goal");
		await session.abort();
		setActiveGoal("goal-2", "Replacement goal");
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		await emitAssistantStop(125);

		expect(continueSpy).toHaveBeenCalledTimes(1);
		expect(developerReminderCount()).toBe(1);
		expect(JSON.stringify(session.agent.state.messages.find(message => message.role === "developer"))).toContain(
			"Replacement goal",
		);
	});

	it("clears abort suppression when the aborted goal is paused and re-enabled", async () => {
		setActiveGoal();
		await session.abort();
		await session.goalRuntime.pauseGoal();
		await session.goalRuntime.resumeGoal();
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		await emitAssistantStop(125);

		expect(continueSpy).toHaveBeenCalledTimes(1);
		expect(developerReminderCount()).toBe(1);
	});

	it("continues after a successful yield when an active goal remains uncleared", async () => {
		setActiveGoal();
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		const yieldCall: ToolCall = {
			type: "toolCall",
			id: "call_yield_done",
			name: "yield",
			arguments: { result: { data: { done: true } } },
		};
		const assistantMessage: AssistantMessage = {
			...createAssistantMessage(""),
			content: [yieldCall],
			stopReason: "toolUse",
			timestamp: 150,
		};

		session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
		session.agent.emitExternalEvent({
			type: "tool_execution_end",
			toolCallId: yieldCall.id,
			toolName: "yield",
			result: {
				content: [{ type: "text", text: "Result submitted." }],
				details: { status: "success", data: { done: true } },
			},
			isError: false,
		});
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });
		for (let i = 0; i < 20; i++) await Promise.resolve();
		await session.waitForIdle();

		expect(continueSpy).toHaveBeenCalledTimes(1);
		expect(developerReminderCount()).toBe(1);
		const reminder = session.agent.state.messages.find(message => message.role === "developer");
		expect(JSON.stringify(reminder?.content)).toContain("Ship the idle reminder fix");
		expect(JSON.stringify(reminder?.content)).toContain('goal({op:\\"complete\\"})');
	});

	it("deduplicates the same assistant stop but reminds again on a later uncleared stop", async () => {
		setActiveGoal();
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		await emitAssistantStop(100);
		await emitAssistantStop(100);
		await emitAssistantStop(200);

		expect(continueSpy).toHaveBeenCalledTimes(2);
		expect(developerReminderCount()).toBe(2);
	});

	it("suppresses reminders when the goal is complete, paused, or dropped", async () => {
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		const terminalStates: Array<GoalModeState | undefined> = [
			{
				enabled: false,
				mode: "exiting",
				reason: "completed",
				goal: {
					id: "goal-complete",
					objective: "Done",
					status: "complete",
					tokensUsed: 0,
					timeUsedSeconds: 0,
					createdAt: 0,
					updatedAt: 0,
				},
			},
			{
				enabled: false,
				mode: "active",
				goal: {
					id: "goal-paused",
					objective: "Held",
					status: "paused",
					tokensUsed: 0,
					timeUsedSeconds: 0,
					createdAt: 0,
					updatedAt: 0,
				},
			},
			undefined,
		];

		for (const [index, state] of terminalStates.entries()) {
			session.setGoalModeState(state);
			await emitAssistantStop(300 + index);
		}

		expect(continueSpy).not.toHaveBeenCalled();
		expect(developerReminderCount()).toBe(0);
	});
	it("contains background coordinator state persistence failures without leaking sidecar data", async () => {
		const stateFile = path.join(tempDir.path(), "corrupt-runtime-state.json");
		await Bun.write(stateFile, '{"private_payload":"must-not-reach-logs"}');
		const previousStateFile = process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
		const previousSessionId = process.env[GJC_COORDINATOR_SESSION_ID_ENV];
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = session.sessionId;
		const deliveredEvents: string[] = [];
		session.subscribe(event => deliveredEvents.push(event.type));
		let resolveWarning: (() => void) | undefined;
		const warningLogged = new Promise<void>(resolve => {
			resolveWarning = resolve;
		});
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation((message, metadata) => {
			if (message === "Failed to persist coordinator runtime state" && metadata?.event === "turn_start")
				resolveWarning?.();
		});

		try {
			session.agent.emitExternalEvent({ type: "turn_start" });
			expect(deliveredEvents).toEqual(["turn_start"]);
			await Promise.race([
				warningLogged,
				Bun.sleep(1_000).then(() => {
					throw new Error("Timed out waiting for coordinator runtime-state failure containment");
				}),
			]);
			expect(warnSpy).toHaveBeenCalledWith("Failed to persist coordinator runtime state", { event: "turn_start" });
		} finally {
			if (previousStateFile === undefined) delete process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
			else process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = previousStateFile;
			if (previousSessionId === undefined) delete process.env[GJC_COORDINATOR_SESSION_ID_ENV];
			else process.env[GJC_COORDINATOR_SESSION_ID_ENV] = previousSessionId;
		}
	});
});
