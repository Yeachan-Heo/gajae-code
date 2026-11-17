import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@gajae-code/agent-core";
import { type DeveloperMessage, getBundledModel, type TextContent } from "@gajae-code/ai";
import { createMockModel, type MockModelHandle } from "@gajae-code/ai/providers/mock";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import type { TodoPhase } from "@gajae-code/coding-agent/tools/todo-write";
import { Snowflake } from "@gajae-code/utils";

/**
 * Regression coverage for the todo completion reminder reopening a finished turn.
 *
 * `#checkTodoCompletion` runs inside the `agent_end` handler, before the deferred
 * terminal is published. Injecting a developer message plus `#scheduleAgentContinue`
 * parks that terminal behind a continuation hold, so the prompt never settles for a
 * consumer that cannot represent a server-initiated turn.
 */
describe("AgentSession todo completion reminder", () => {
	let session: AgentSession;
	let settings: Settings;
	let tempDir: string;
	let mock: MockModelHandle;
	let authStorage: AuthStorage | undefined;
	let modelRegistry: ModelRegistry | undefined;
	let events: AgentSessionEvent[];
	let beforeResponse: (() => Promise<void>) | undefined;
	/** `mock.calls.length` sampled every time a terminal `agent_end` reaches subscribers. */
	let modelCallsAtAgentEnd: number[];

	const incompletePhases = (): TodoPhase[] => [
		{
			name: "Investigation",
			tasks: [
				{ content: "Trace the settlement path", status: "in_progress" },
				{ content: "Report the mechanism", status: "pending" },
			],
		},
	];

	const completedPhases = (): TodoPhase[] => [
		{ name: "Investigation", tasks: [{ content: "Trace the settlement path", status: "completed" }] },
	];

	const isInjectedReminder = (message: AgentMessage): message is DeveloperMessage =>
		message.role === "developer" &&
		Array.isArray(message.content) &&
		message.content.some(block => block.type === "text" && block.text.includes("incomplete todo item(s)"));

	const injectedReminders = (): DeveloperMessage[] => session.agent.state.messages.filter(isInjectedReminder);

	const reminderText = (message: DeveloperMessage | undefined): string => {
		if (!message) return "";
		if (typeof message.content === "string") return message.content;
		return message.content
			.filter((block): block is TextContent => block.type === "text")
			.map(block => block.text)
			.join("");
	};

	const reminderEvents = (): Extract<AgentSessionEvent, { type: "todo_reminder" }>[] =>
		events.filter((event): event is Extract<AgentSessionEvent, { type: "todo_reminder" }> => {
			return event.type === "todo_reminder";
		});

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-todo-reminder-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Test model not found in registry");
		}

		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));

		beforeResponse = undefined;
		mock = createMockModel({
			handler: async () => {
				const action = beforeResponse;
				beforeResponse = undefined;
				await action?.();
				return { content: ["Final report delivered."] };
			},
		});

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: mock.stream,
		});

		settings = Settings.isolated();
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		events = [];
		modelCallsAtAgentEnd = [];
		session.subscribe(event => {
			events.push(event);
			if (event.type === "agent_end") modelCallsAtAgentEnd.push(mock.calls.length);
		});
	});

	afterEach(async () => {
		const errors: unknown[] = [];
		for (const step of [() => session.dispose(), () => modelRegistry?.dispose(), () => authStorage?.close()]) {
			try {
				await step();
			} catch (error) {
				errors.push(error);
			}
		}
		modelRegistry = undefined;
		authStorage = undefined;
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, "Fixture cleanup failed");
	});

	it("settles a finished turn with incomplete todos instead of reopening it for a deferred-turn client", async () => {
		session.setClientBridge({ capabilities: {}, deferAgentInitiatedTurns: true });
		session.setTodoPhases(incompletePhases());

		await session.prompt("do the long task");

		// The terminal published right after the single turn the user asked for.
		expect(modelCallsAtAgentEnd).toEqual([1]);
		expect(mock.calls).toHaveLength(1);
		expect(session.isStreaming).toBe(false);
		// Nothing reopened the conversation.
		expect(injectedReminders()).toHaveLength(0);
		// The advisory reminder is still produced for notification consumers.
		expect(reminderEvents()).toHaveLength(1);
		expect(reminderEvents()[0]?.todos.map(todo => todo.content)).toEqual([
			"Trace the settlement path",
			"Report the mechanism",
		]);
		expect(reminderEvents()[0]?.attempt).toBe(1);
	});

	it("still injects a visible reminder for an interactive session", async () => {
		settings.set("todo.reminders.max", 2);
		session.setTodoPhases(incompletePhases());

		await session.prompt("do the long task");

		expect(reminderEvents()).toHaveLength(2);
		const reminders = injectedReminders();
		expect(reminders).toHaveLength(2);
		expect(reminderText(reminders[0])).toContain("You stopped with 2 incomplete todo item(s)");
		expect(reminderText(reminders[0])).toContain("(Reminder 1/2)");
		expect(reminderText(reminders[1])).toContain("(Reminder 2/2)");

		// Both configured reminders are visible; the second consumes the final scripted response.
		expect(mock.calls).toHaveLength(2);
		const messages = session.agent.state.messages;
		const assistantIndices = messages
			.map((message, index) => (message.role === "assistant" ? index : -1))
			.filter(index => index >= 0);
		expect(assistantIndices).toHaveLength(2);
		for (const reminder of reminders) {
			const reminderIndex = messages.indexOf(reminder);
			expect(reminderIndex).toBeGreaterThan(assistantIndices[0]!);
		}
	});

	it("injects nothing once the todo.reminders.max budget is exhausted", async () => {
		settings.set("todo.reminders.max", 0);
		session.setTodoPhases(incompletePhases());

		await session.prompt("do the long task");

		expect(reminderEvents()).toHaveLength(0);
		expect(injectedReminders()).toHaveLength(0);
		expect(mock.calls).toHaveLength(1);
		expect(modelCallsAtAgentEnd).toEqual([1]);
	});

	it("leaves a turn with no incomplete todos untouched", async () => {
		session.setTodoPhases(completedPhases());

		await session.prompt("do the short task");

		expect(reminderEvents()).toHaveLength(0);
		expect(injectedReminders()).toHaveLength(0);
		expect(mock.calls).toHaveLength(1);
		expect(modelCallsAtAgentEnd).toEqual([1]);
	});

	it("resets the reminder counter on the next user prompt", async () => {
		settings.set("todo.reminders.max", 1);
		session.setTodoPhases(incompletePhases());

		await session.prompt("first task");
		expect(injectedReminders()).toHaveLength(1);
		expect(mock.calls).toHaveLength(2);

		await session.prompt("second task");

		// A stuck counter would have suppressed the second prompt's reminder.
		expect(injectedReminders()).toHaveLength(2);
		expect(reminderEvents()).toHaveLength(2);
		expect(reminderEvents().map(event => event.attempt)).toEqual([1, 1]);
		expect(mock.calls).toHaveLength(4);
	});

	function setActiveGoal(): void {
		session.setGoalModeState({
			enabled: true,
			mode: "active",
			goal: {
				id: "paused-todo-goal",
				objective: "Wait for the external review",
				status: "active",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: 0,
				updatedAt: 0,
			},
		});
	}

	for (const deferred of [false, true]) {
		it(`settles after a goal pauses during the turn without todo reminders (deferred=${deferred})`, async () => {
			if (deferred) session.setClientBridge({ capabilities: {}, deferAgentInitiatedTurns: true });
			session.setTodoPhases(incompletePhases());
			setActiveGoal();
			beforeResponse = async () => {
				await session.operateGoal("pause");
			};

			await session.prompt("Pause until the external review arrives");

			expect(session.getGoalModeState()?.goal.status).toBe("paused");
			expect(session.getGoalModeState()?.enabled).toBe(false);
			expect(session.getTodoPhases()).toEqual(incompletePhases());
			expect(reminderEvents()).toHaveLength(0);
			expect(injectedReminders()).toHaveLength(0);
			expect(mock.calls).toHaveLength(1);
			expect(modelCallsAtAgentEnd).toEqual([1]);
			expect(session.isStreaming).toBe(false);
		});
	}

	it("restores ordinary todo reminders after the paused goal resumes and completes", async () => {
		settings.set("todo.reminders.max", 1);
		session.setTodoPhases(incompletePhases());
		setActiveGoal();
		await session.operateGoal("pause");
		await session.prompt("Report the external hold");
		expect(reminderEvents()).toHaveLength(0);
		expect(mock.calls).toHaveLength(1);

		await session.operateGoal("resume");
		expect(session.getGoalModeState()?.goal.status).toBe("active");
		beforeResponse = async () => {
			await session.operateGoal("complete");
		};
		await session.prompt("The review arrived; finish the goal");

		expect(session.getGoalModeState()?.goal.status).toBe("complete");
		expect(session.getTodoPhases()).toEqual(incompletePhases());
		expect(reminderEvents().map(event => event.attempt)).toEqual([1]);
		expect(injectedReminders()).toHaveLength(1);
		expect(mock.calls).toHaveLength(3);
	});

	it("allows active-goal continuation after resume and stops reminders on a second pause", async () => {
		session.setTodoPhases(incompletePhases());
		setActiveGoal();
		await session.operateGoal("pause");
		await session.prompt("Report the external hold");
		expect(mock.calls).toHaveLength(1);

		await session.operateGoal("resume");
		beforeResponse = async () => {
			// Let the resumed goal request one ordinary continuation, then pause
			// again during that continuation rather than changing its todos.
			beforeResponse = async () => {
				await session.operateGoal("pause");
			};
		};
		await session.prompt("Continue the resumed goal");

		expect(mock.calls).toHaveLength(3);
		const goalReminders = session.agent.state.messages.filter(
			message =>
				message.role === "developer" &&
				JSON.stringify(message.content).includes("goal is still active and uncleared"),
		);
		expect(goalReminders).toHaveLength(1);
		expect(session.getGoalModeState()?.goal.status).toBe("paused");
		expect(session.getTodoPhases()).toEqual(incompletePhases());
		expect(reminderEvents()).toHaveLength(0);
		expect(injectedReminders()).toHaveLength(0);
		expect(session.isStreaming).toBe(false);
	});

	it("delivers explicit user and cron wakes while keeping a goal paused and todos unfinished", async () => {
		session.setTodoPhases(incompletePhases());
		setActiveGoal();
		await session.operateGoal("pause");

		await session.prompt("Explicit owner question during the hold");
		await session.sendCustomMessage(
			{ customType: "cron-fire", content: "Scheduled external review check", display: false, attribution: "agent" },
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(2);
		expect(modelCallsAtAgentEnd).toEqual([1, 2]);
		expect(JSON.stringify(mock.calls[0]?.context.messages)).toContain("Explicit owner question during the hold");
		expect(
			session.agent.state.messages.some(
				message =>
					message.role === "custom" &&
					message.customType === "cron-fire" &&
					message.content === "Scheduled external review check",
			),
		).toBe(true);
		expect(session.getGoalModeState()?.goal.status).toBe("paused");
		expect(session.getTodoPhases()).toEqual(incompletePhases());
		expect(reminderEvents()).toHaveLength(0);
		expect(injectedReminders()).toHaveLength(0);
	});
});
