import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent, type AgentMessage, type AgentOptions } from "@gajae-code/agent-core";
import type { AssistantMessage, Model, ToolResultMessage } from "@gajae-code/ai";
import { getBundledModel } from "@gajae-code/ai/models";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";

function testModel() {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled Anthropic test model");
	return model;
}

function assistantTail(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "completed" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 0,
	};
}

function toolResultTail(): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "read",
		content: [{ type: "text", text: "result" }],
		isError: false,
		timestamp: 0,
	};
}

async function createSession(messages: AgentMessage[]): Promise<AgentSession> {
	const agent = new Agent({ initialState: { model: testModel(), systemPrompt: ["Test"], tools: [], messages } });
	const authStorage = await AuthStorage.create(":memory:");
	return new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: new ModelRegistry(authStorage),
	});
}

describe("AgentSession startup continuation", () => {
	it("rejects empty and terminal assistant persisted tails without calling Agent.continue", async () => {
		const terminalTails: AgentMessage[][] = [[], [assistantTail()]];
		for (const messages of terminalTails) {
			const session = await createSession(messages);
			try {
				const continueSpy = vi.spyOn(session.agent, "continue");

				await expect(session.continuePersistedHistory()).rejects.toThrow(
					"Cannot continue from persisted message history",
				);
				expect(continueSpy).not.toHaveBeenCalled();
			} finally {
				await session.dispose();
			}
		}
	});

	it("delegates and awaits Agent.continue exactly once for user and tool-result tails", async () => {
		const resumableTails: AgentMessage[][] = [
			[{ role: "user", content: "resume", timestamp: 0 }],
			[{ role: "user", content: "resume", timestamp: 0 }, toolResultTail()],
		];
		for (const messages of resumableTails) {
			const session = await createSession(messages);
			try {
				const completion = Promise.withResolvers<void>();
				const continueSpy = vi.spyOn(session.agent, "continue").mockImplementation(() => completion.promise);
				const continuation = session.continuePersistedHistory();

				for (let attempt = 0; attempt < 100 && continueSpy.mock.calls.length === 0; attempt += 1)
					await Bun.sleep(1);
				expect(continueSpy).toHaveBeenCalledTimes(1);
				let settled = false;
				void continuation.then(() => {
					settled = true;
				});
				await Promise.resolve();
				expect(settled).toBe(false);
				completion.resolve();
				await continuation;
			} finally {
				await session.dispose();
			}
		}
	});

	it("propagates Agent.continue rejection", async () => {
		const session = await createSession([{ role: "user", content: "resume", timestamp: 0 }]);
		const expected = new Error("continuation failed");
		const continueSpy = vi.spyOn(session.agent, "continue").mockRejectedValue(expected);

		await expect(session.continuePersistedHistory()).rejects.toBe(expected);
		expect(continueSpy).toHaveBeenCalledTimes(1);
		await session.dispose();
	});
});

function selector(model: Model): string {
	return `${model.provider}/${model.id}`;
}

function retryableFailure(model: Model): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const message: AssistantMessage & { transportFailure: { kind: "transport"; status: number } } = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: "rate limit exceeded",
			errorStatus: 429,
			timestamp: Date.now(),
			transportFailure: { kind: "transport", status: 429 },
		};
		stream.push({ type: "start", partial: message });
		stream.push({ type: "error", reason: "error", error: message });
	});
	return stream;
}

describe("AgentSession startup continuation lifecycle", () => {
	let tempDir: TempDir | undefined;
	let authStorage: AuthStorage | undefined;
	let session: AgentSession | undefined;

	afterEach(async () => {
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		vi.restoreAllMocks();
	});

	async function createManagedSession(streamFn: AgentOptions["streamFn"], maxAttempts = 1): Promise<void> {
		const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!primary || !fallback) throw new Error("Expected bundled fallback test models");
		tempDir = TempDir.createSync("@startup-continue-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey(primary.provider, "primary-key");
		authStorage.setRuntimeApiKey(fallback.provider, "fallback-key");
		const agent = new Agent({
			getApiKey: provider => `${provider}-key`,
			initialState: {
				model: primary,
				systemPrompt: ["Test"],
				tools: [],
				messages: [{ role: "user", content: "resume", timestamp: 0 }],
			},
			streamFn,
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"fallback.maxAttempts": maxAttempts,
			"retry.baseDelayMs": 1,
		});
		settings.setModelRole("default", selector(primary));
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
		});
		session.setConfiguredModelChain("default", [selector(primary), selector(fallback)], "test");
	}

	it("emits one terminal agent_end after a successful managed continuation", async () => {
		const mock = createMockModel({ responses: [{ content: ["continued"] }] });
		await createManagedSession((model, context, options) => mock.stream(model, context, options));
		const events: AgentSessionEvent[] = [];
		session!.subscribe(event => events.push(event));

		await session!.continuePersistedHistory();
		await session!.waitForIdle();

		expect(events.filter(event => event.type === "agent_end")).toHaveLength(1);
		expect(session!.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "continued" }],
		});
		expect(session!.isStreaming).toBe(false);
	});

	it("holds agent_end until a managed retry recovers", async () => {
		let attempts = 0;
		const accepted = createMockModel({ responses: [{ content: ["recovered"] }] });
		await createManagedSession((model, context, options) => {
			attempts += 1;
			return attempts === 1 ? retryableFailure(model) : accepted.stream(model, context, options);
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const order: string[] = [];
		session!.subscribe(event => {
			if (event.type === "auto_retry_start" || event.type === "auto_retry_end" || event.type === "agent_end") {
				order.push(event.type);
			}
		});

		await session!.continuePersistedHistory();
		await session!.waitForIdle();

		expect(attempts).toBe(2);
		expect(order).toEqual(["auto_retry_start", "auto_retry_end", "agent_end"]);
	});

	it("emits one terminal agent_end when the managed fallback chain is exhausted", async () => {
		await createManagedSession(model => retryableFailure(model));
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const events: AgentSessionEvent[] = [];
		session!.subscribe(event => events.push(event));

		await session!.continuePersistedHistory();
		await session!.waitForIdle();

		const agentEnds = events.filter(event => event.type === "agent_end");
		expect(agentEnds).toHaveLength(1);
		expect(session!.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "error" });
		expect(session!.isStreaming).toBe(false);
	});

	it("propagates continuation-start failure without fabricating agent_end", async () => {
		const mock = createMockModel({ responses: [{ content: ["unused"] }] });
		await createManagedSession((model, context, options) => mock.stream(model, context, options));
		const expected = new Error("continuation failed before loop entry");
		vi.spyOn(session!.agent, "continue").mockRejectedValue(expected);
		const events: AgentSessionEvent[] = [];
		session!.subscribe(event => events.push(event));

		await expect(session!.continuePersistedHistory()).rejects.toBe(expected);

		expect(events.filter(event => event.type === "agent_end")).toHaveLength(0);
		expect(session!.isStreaming).toBe(false);
	});

	it("emits one cancelled agent_end when startup continuation is aborted", async () => {
		const pending = new AssistantMessageEventStream();
		await createManagedSession(() => pending);
		const events: AgentSessionEvent[] = [];
		session!.subscribe(event => events.push(event));
		const continuation = session!.continuePersistedHistory();
		for (let index = 0; index < 20 && session!.agent.activeRunId === undefined; index += 1) await Bun.sleep(1);

		await session!.abort();
		await continuation;
		await session!.waitForIdle();

		expect(events.filter(event => event.type === "agent_end")).toHaveLength(1);
		expect(events.find(event => event.type === "agent_end")).toMatchObject({ stopReason: "cancelled" });
		expect(session!.isStreaming).toBe(false);
	});

	it("does not duplicate terminal delivery after the agent event subscription reconnects", async () => {
		const mock = createMockModel({ responses: [{ content: ["continued"] }, { content: ["after reconnect"] }] });
		await createManagedSession((model, context, options) => mock.stream(model, context, options));
		const events: AgentSessionEvent[] = [];
		session!.subscribe(event => events.push(event));

		await session!.continuePersistedHistory();
		expect(await session!.newSession()).toBe(true);
		await session!.prompt("verify reconnect");
		await session!.waitForIdle();

		expect(events.filter(event => event.type === "agent_end")).toHaveLength(2);
		expect(
			events.filter(
				event =>
					event.type === "message_end" &&
					event.message.role === "assistant" &&
					event.message.content.some(part => part.type === "text" && part.text === "after reconnect"),
			),
		).toHaveLength(1);
	});
});
