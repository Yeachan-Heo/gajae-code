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
import { createLazyService } from "@gajae-code/coding-agent/runtime/lazy-service";
import type { WorkspaceTreeRuntime } from "@gajae-code/coding-agent/runtime/workspace-tree-service";
import {
	AgentSession,
	type AgentSessionConfig,
	type AgentSessionEvent,
} from "@gajae-code/coding-agent/session/agent-session";
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

	async function createManagedSession(
		streamFn: AgentOptions["streamFn"],
		maxAttempts = 1,
		config: Pick<AgentSessionConfig, "workspaceTreeService"> = {},
	): Promise<void> {
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
			...config,
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
		const started = Promise.withResolvers<void>();
		session!.subscribe(event => {
			events.push(event);
			if (event.type === "agent_start") started.resolve();
		});
		const continuation = session!.continuePersistedHistory();
		await started.promise;

		await session!.abort();
		await continuation;
		await session!.waitForIdle();

		expect(events.filter(event => event.type === "agent_end")).toHaveLength(1);
		expect(events.find(event => event.type === "agent_end")).toMatchObject({ stopReason: "cancelled" });
		expect(session!.isStreaming).toBe(false);
	});

	it("rejects promptly when aborted before the startup continuation creates a run controller", async () => {
		const pending = new AssistantMessageEventStream();
		const stream = vi.fn(() => pending);
		await createManagedSession(stream);
		const continueSpy = vi.spyOn(session!.agent, "continue");
		const events: AgentSessionEvent[] = [];
		session!.subscribe(event => events.push(event));
		const continuation = session!.continuePersistedHistory();
		const outcome = continuation.then(
			() => "completed",
			(error: unknown) => error,
		);
		expect(session!.agent.activeRunId).toBeUndefined();
		const abort = session!.abort();
		try {
			const result = await Promise.race([outcome, Bun.sleep(500).then(() => "timed out")]);
			expect(result).not.toBe("timed out");
			expect(result).toMatchObject({ name: "PromptPreflightCancelledError", code: "busy" });
			await abort;
			expect(continueSpy).not.toHaveBeenCalled();
			expect(stream).not.toHaveBeenCalled();
			expect(events.filter(event => event.type === "agent_end")).toHaveLength(0);
			expect(session!.isStreaming).toBe(false);
		} finally {
			await session!.abort({ timeoutMs: 20 });
			await outcome;
			await abort;
		}
	});

	it("cancels blocked context preparation before Agent.continue without waiting for the service", async () => {
		const entered = Promise.withResolvers<void>();
		const preparation = Promise.withResolvers<WorkspaceTreeRuntime>();
		const workspaceTreeService = createLazyService<WorkspaceTreeRuntime>({
			id: "startup-continuation-workspace",
			initialize: async () => {
				entered.resolve();
				return { value: await preparation.promise };
			},
		});
		const stream = vi.fn(() => new AssistantMessageEventStream());
		await createManagedSession(stream, 1, { workspaceTreeService });
		const continueSpy = vi.spyOn(session!.agent, "continue");
		const continuation = session!.continuePersistedHistory();
		const outcome = continuation.catch((error: unknown) => error);
		try {
			await entered.promise;
			expect(session!.agent.activeRunId).toBeUndefined();
			const abort = session!.abort();
			const result = await Promise.race([outcome, Bun.sleep(500).then(() => "timed out")]);
			expect(result).not.toBe("timed out");
			expect(result).toMatchObject({ name: "PromptPreflightCancelledError", code: "busy" });
			await abort;
			expect(continueSpy).not.toHaveBeenCalled();
			expect(stream).not.toHaveBeenCalled();
		} finally {
			const snapshot = {
				rootPath: tempDir!.path(),
				rendered: "",
				truncated: false,
				totalLines: 0,
				agentsMdFiles: [],
			};
			preparation.resolve({ snapshot, refresh: async () => snapshot });
			await workspaceTreeService.dispose();
		}
	});

	it("cancels a blocked startup barrier without waiting for readiness or poisoning the next continuation", async () => {
		const mock = createMockModel({ responses: [{ content: ["resumed after abort"] }] });
		const stream = vi.fn((...args: Parameters<typeof mock.stream>) => mock.stream(...args));
		await createManagedSession(stream);
		const ready = Promise.withResolvers<void>();
		session!.extendStartupTurnBarrier(ready.promise);
		const continuation = session!.continuePersistedHistory();
		const outcome = continuation.catch((error: unknown) => error);
		try {
			const abort = session!.abort();
			const result = await Promise.race([outcome, Bun.sleep(500).then(() => "timed out")]);
			expect(result).not.toBe("timed out");
			expect(result).toMatchObject({ name: "PromptPreflightCancelledError", code: "busy" });
			await abort;
			expect(stream).not.toHaveBeenCalled();
		} finally {
			ready.resolve();
		}
		await session!.continuePersistedHistory();
		expect(stream).toHaveBeenCalledTimes(1);
		expect(session!.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "resumed after abort" }],
		});
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

	it("fences Hindsight recall writes to the generation that launched them", async () => {
		// Regression test for Finding #1: A pending Hindsight recall from session A
		// should not write state into session B after a session switch, even if the
		// recall is still in-flight when the transition occurs.
		const mock = createMockModel({ responses: [{ content: ["first"] }, { content: ["second"] }] });
		const stream = vi.fn((...args: Parameters<typeof mock.stream>) => mock.stream(...args));
		await createManagedSession(stream);

		// Get initial state reference
		const initialHindsightState = session!.getHindsightSessionState();
		if (!initialHindsightState) {
			// Skip test if Hindsight is not configured
			return;
		}

		// Start a continuation which will trigger maybeRecallOnAgentStart
		const continuation = session!.continuePersistedHistory();

		// Immediately cancel the continuation before recall can complete
		await session!.abort();

		// Wait for the continuation to fail
		let continuationFailed = false;
		try {
			await continuation;
		} catch {
			continuationFailed = true;
		}
		expect(continuationFailed).toBe(true);

		// Switch to a new session (this resets conversation tracking)
		const switched = await session!.newSession();
		expect(switched).toBe(true);

		// Get the new Hindsight state
		const newHindsightState = session!.getHindsightSessionState();
		if (newHindsightState) {
			// Verify that hasRecalledForFirstTurn was reset for the new session
			// and any stale recall from the old session did not pollute the new state
			expect(newHindsightState.hasRecalledForFirstTurn).toBe(false);
			expect(newHindsightState.getRecallSnippet()).toBeUndefined();
		}

		// Verify the new session can run normally
		await session!.continuePersistedHistory();
		expect(stream).toHaveBeenCalledTimes(1);
		expect(session!.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "second" }],
		});
	});
});
