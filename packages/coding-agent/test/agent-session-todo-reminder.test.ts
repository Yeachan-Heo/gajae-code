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
	let events: AgentSessionEvent[];
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
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));

		mock = createMockModel({ handler: () => ({ content: ["Final report delivered."] }) });

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
		await session.dispose();
		authStorage?.close();
		authStorage = undefined;
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
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

		expect(reminderEvents()).toHaveLength(1);
		const reminders = injectedReminders();
		expect(reminders).toHaveLength(1);
		expect(reminderText(reminders[0])).toContain("You stopped with 2 incomplete todo item(s)");
		expect(reminderText(reminders[0])).toContain("(Reminder 1/2)");

		// The reminder reopened the turn: it lands between the two assistant messages.
		expect(mock.calls).toHaveLength(2);
		const messages = session.agent.state.messages;
		const assistantIndices = messages
			.map((message, index) => (message.role === "assistant" ? index : -1))
			.filter(index => index >= 0);
		const reminderIndex = messages.findIndex(isInjectedReminder);
		expect(assistantIndices).toHaveLength(2);
		expect(reminderIndex).toBeGreaterThan(assistantIndices[0]!);
		expect(reminderIndex).toBeLessThan(assistantIndices[1]!);
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
});
