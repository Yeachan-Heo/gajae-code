import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentOptions } from "@gajae-code/agent-core";
import { type AssistantMessage, getBundledModel, type Model } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";

function selector(model: Model): string {
	return `${model.provider}/${model.id}`;
}

function failingStream(model: Model): AssistantMessageEventStream {
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

function typedOpaqueOverflowStream(model: Model): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const message: AssistantMessage & {
			transportFailure: { kind: "transport"; status: number; openaiErrorCode: string };
		} = {
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
			errorMessage: "",
			errorStatus: 400,
			timestamp: Date.now(),
			transportFailure: { kind: "transport", status: 400, openaiErrorCode: "context_length_exceeded" },
		};
		stream.push({ type: "start", partial: message });
		stream.push({ type: "error", reason: "error", error: message });
	});
	return stream;
}

describe("AgentSession managed fallback cancellation completion", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@fallback-cancel-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		authStorage.setRuntimeApiKey("openai", "test-key");
	});
	afterEach(async () => {
		await session?.dispose();
		authStorage.close();
		tempDir.removeSync();
	});

	function createSession(streamFn: AgentOptions["streamFn"]): void {
		const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!primary || !fallback) throw new Error("Expected bundled test models");
		const agent = new Agent({
			getApiKey: provider => `${provider}-key`,
			initialState: { model: primary, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn,
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"fallback.maxAttempts": 3,
			"retry.baseDelayMs": 50,
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

	it("clears streaming state and emits one cancelled completion when aborted during an attempt", async () => {
		const pending = new AssistantMessageEventStream();
		const streamEntered = Promise.withResolvers<void>();
		createSession(() => {
			streamEntered.resolve();
			return pending;
		});
		const requestTerminalSpy = vi.spyOn(session!.agent, "requestRunTerminal");
		const events: AgentSessionEvent[] = [];
		session!.subscribe(event => events.push(event));
		const run = session!.prompt("abort active attempt");
		await streamEntered.promise;
		expect(session!.agent.activeRunId).toBeDefined();
		await session!.abort();
		await run;
		await session!.waitForIdle();
		expect(session!.isStreaming).toBe(false);
		expect(requestTerminalSpy).toHaveBeenCalled();
		expect(events.filter(event => event.type === "agent_end")).toHaveLength(1);
		expect(
			events.some(
				event =>
					event.type === "message_end" &&
					event.message.role === "assistant" &&
					event.message.stopReason !== "aborted" &&
					event.message.stopReason !== "error",
			),
		).toBe(false);
		expect(events.find(event => event.type === "agent_end")).toMatchObject({ stopReason: "cancelled" });
		requestTerminalSpy.mockRestore();
	});

	it("waitForIdle flushes an accepted agent_end deferred by a subscriber abort", async () => {
		createSession((model, context, options) =>
			createMockModel({ responses: [{ content: ["accepted"] }] }).stream(model, context, options),
		);
		const events: AgentSessionEvent[] = [];
		const messageEnd = Promise.withResolvers<void>();
		let abort: Promise<void> | undefined;
		session!.subscribe(event => {
			events.push(event);
			if (event.type === "message_end" && event.message.role === "assistant") {
				abort ??= session!.abort();
				messageEnd.resolve();
			}
		});

		const run = session!.prompt("accept then abort");
		await messageEnd.promise;
		await session!.waitForIdle();
		await abort;
		await run;
		await session!.waitForIdle();

		const agentEnds = events.filter(event => event.type === "agent_end");
		expect(events.some(event => event.type === "message_end" && event.message.role === "assistant")).toBe(true);
		expect(agentEnds).toHaveLength(1);
		expect(agentEnds[0]).not.toMatchObject({ stopReason: "cancelled" });
		expect(events.some(event => event.type === "agent_end" && event.stopReason === "cancelled")).toBe(false);
	});

	it("preserves an accepted retry completion when a subscriber aborts after message_end", async () => {
		let attempts = 0;
		const accepted = createMockModel({ responses: [{ content: ["accepted retry output"] }] });
		createSession((model, context, options) => {
			attempts += 1;
			return attempts === 1 ? failingStream(model) : accepted.stream(model, context, options);
		});
		const events: AgentSessionEvent[] = [];
		let abort: Promise<void> | undefined;
		session!.subscribe(event => {
			events.push(event);
			if (event.type === "message_end" && event.message.role === "assistant") {
				abort ??= session!.abort();
			}
		});

		await session!.prompt("retry then accept and abort");
		await abort;
		await session!.waitForIdle();

		const agentEnds = events.filter(event => event.type === "agent_end");
		expect(attempts).toBe(2);
		expect(agentEnds).toHaveLength(1);
		expect(agentEnds[0]).not.toMatchObject({ stopReason: "cancelled" });
		expect(events.some(event => event.type === "agent_end" && event.stopReason === "cancelled")).toBe(false);
		expect(session!.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "accepted retry output" }],
		});
		expect(session!.isStreaming).toBe(false);
	});

	it("clears streaming state and emits one cancelled completion when aborted during backoff", async () => {
		const backoff = Promise.withResolvers<void>();
		createSession(model => failingStream(model));
		const events: AgentSessionEvent[] = [];
		session!.subscribe(event => {
			events.push(event);
			if (event.type === "auto_retry_start") backoff.resolve();
		});
		const run = session!.prompt("abort fallback backoff");
		await backoff.promise;
		await session!.abort();
		await run;
		await session!.waitForIdle();
		expect(session!.isStreaming).toBe(false);
		expect(events.filter(event => event.type === "agent_end")).toHaveLength(1);
		expect(events.find(event => event.type === "agent_end")).toMatchObject({ stopReason: "cancelled" });
	});

	it("fences managed fallback retry preparation when disposal wins before allocation", async () => {
		const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primary) throw new Error("Expected bundled primary model");
		const calls: string[] = [];
		authStorage.removeRuntimeApiKey("anthropic");
		await authStorage.set("anthropic", { type: "api_key", key: "stored-key" });
		createSession(model => {
			calls.push(selector(model));
			return failingStream(model);
		});
		const markStarted = Promise.withResolvers<void>();
		const releaseMark = Promise.withResolvers<void>();
		const markUsageLimitReached = vi.spyOn(authStorage, "markUsageLimitReached").mockImplementation(async () => {
			markStarted.resolve();
			await releaseMark.promise;
			return { state: "not-marked", remainingCredentialIds: [] };
		});
		const events: AgentSessionEvent[] = [];
		session!.subscribe(event => events.push(event));

		const run = session!.prompt("dispose during managed credential preparation");
		await markStarted.promise;
		const dispose = session!.dispose();
		releaseMark.resolve();
		await dispose;
		await run;

		expect(calls).toEqual([selector(primary)]);
		expect(events.filter(event => event.type === "auto_retry_start")).toHaveLength(0);
		expect(session!.isRetrying).toBe(false);
		expect(session!.isStreaming).toBe(false);
		markUsageLimitReached.mockRestore();
	});

	it("cancels a hidden next-turn continuation waiting behind startup", async () => {
		const calls: string[] = [];
		createSession((model, context, options) => {
			calls.push(selector(model));
			return createMockModel({ responses: [{ content: ["must not run"] }] }).stream(model, context, options);
		});
		const startupBarrier = Promise.withResolvers<void>();
		session!.extendStartupTurnBarrier(startupBarrier.promise);
		session!.queueDeferredMessageForTests(
			{
				role: "custom",
				customType: "test-hidden-disposal",
				content: [{ type: "text", text: "hidden successor" }],
				display: false,
				details: {},
				timestamp: Date.now(),
			},
			true,
		);
		await Bun.sleep(10);

		await session!.dispose();

		expect(calls).toHaveLength(0);
		expect(session!.getPendingNextTurnMessagesForTests()).toHaveLength(0);
	});

	it("cancels an ordinary prompt waiting behind startup during disposal", async () => {
		const calls: string[] = [];
		createSession((model, context, options) => {
			calls.push(selector(model));
			return createMockModel({ responses: [{ content: ["must not run"] }] }).stream(model, context, options);
		});
		const startupBarrier = Promise.withResolvers<void>();
		session!.extendStartupTurnBarrier(startupBarrier.promise);
		const prompt = session!.prompt("ordinary prompt behind startup");
		await Bun.sleep(10);

		const dispose = session!.dispose();
		await expect(prompt).rejects.toMatchObject({ code: "busy" });
		await dispose;

		expect(calls).toHaveLength(0);
	});

	it("abandons the overflow-maintenance handoff before any continuation provider call", async () => {
		const calls: string[] = [];
		createSession((model, _context, _options) => {
			calls.push(selector(model));
			return typedOpaqueOverflowStream(model);
		});
		session!.settings.set("compaction.enabled", true);
		const compactionStarted = Promise.withResolvers<void>();
		const events: AgentSessionEvent[] = [];
		let abort: Promise<void> | undefined;
		session!.subscribe(event => {
			events.push(event);
			if (event.type === "auto_compaction_start" && event.reason === "overflow") {
				compactionStarted.resolve();
				abort ??= session!.abort();
			}
		});

		const run = session!.prompt("abort overflow maintenance");
		await compactionStarted.promise;
		await abort;
		await run;
		await session!.waitForIdle();

		expect(calls).toHaveLength(1);
		expect(session!.isStreaming).toBe(false);
		expect(session!.isRetrying).toBe(false);
		expect(events.filter(event => event.type === "agent_end")).toEqual([
			expect.objectContaining({ stopReason: "cancelled" }),
		]);
		expect(events.filter(event => event.type === "model_fallback_switched")).toHaveLength(0);
	});
});
