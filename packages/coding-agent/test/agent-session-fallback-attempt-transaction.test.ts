import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent, type AgentOptions } from "@gajae-code/agent-core";
import * as compactionModule from "@gajae-code/agent-core/compaction";
import { type AssistantMessage, getBundledModel, type Model } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";

import { TempDir } from "@gajae-code/utils";

function assistantLifecycleEvents(events: AgentSessionEvent[]): AgentSessionEvent[] {
	return events.filter(
		event =>
			(event.type === "message_start" || event.type === "message_update" || event.type === "message_end") &&
			"message" in event &&
			event.message.role === "assistant",
	);
}

function selector(model: Model): string {
	return `${model.provider}/${model.id}`;
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
	let timer: NodeJS.Timeout;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`TIMEOUT: ${label}`)), 5_000);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

function failedStream(model: Model): AssistantMessageEventStream {
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

function otherTransportFailureStream(model: Model, errorMessage: string): AssistantMessageEventStream {
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
			errorMessage,
			errorStatus: 418,
			timestamp: Date.now(),
			transportFailure: { kind: "transport", status: 418 },
		};
		stream.push({ type: "start", partial: message });
		stream.push({ type: "error", reason: "error", error: message });
	});
	return stream;
}

function typedOverflowStream(model: Model): AssistantMessageEventStream {
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
describe("AgentSession managed fallback attempt transaction", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@fallback-transaction-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		authStorage.setRuntimeApiKey("openai", "test-key");
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage.close();
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	function createSession(
		streamFn: AgentOptions["streamFn"],
		maxAttempts = 3,
	): { agent: Agent; primary: Model; fallback: Model } {
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
		return { agent, primary, fallback };
	}

	it("discards failed managed attempts and publishes the accepted lifecycle once in order", async () => {
		const calls: string[] = [];
		let firstRunId: number | undefined;
		const { agent } = createSession((model, context, options) => {
			calls.push(selector(model));
			if (calls.length === 1) firstRunId = agent.activeRunId;
			if (calls.length === 2) expect(agent.activeRunId).not.toBe(firstRunId);
			return calls.length < 3
				? failedStream(model)
				: createMockModel({ responses: [{ content: ["accepted"] }] }).stream(model, context, options);
		});
		const events: AgentSessionEvent[] = [];
		session!.subscribe(event => events.push(event));

		await session!.prompt("retry twice then accept");
		await session!.waitForIdle();

		expect(calls).toHaveLength(3);
		expect(events.filter(event => event.type === "agent_end")).toHaveLength(1);
		expect(assistantLifecycleEvents(events).filter(event => event.type === "message_start")).toHaveLength(1);
		expect(assistantLifecycleEvents(events).filter(event => event.type === "message_end")).toHaveLength(1);
		expect(events.filter(event => event.type === "turn_end")).toHaveLength(1);
		const lifecycle = assistantLifecycleEvents(events)
			.map(event => event.type)
			.concat(
				events.filter(event => event.type === "turn_end" || event.type === "agent_end").map(event => event.type),
			);
		expect(lifecycle.slice(-3)).toEqual(["message_end", "turn_end", "agent_end"]);
		expect(session!.messages.filter(message => message.role === "assistant")).toHaveLength(1);
	});

	it("emits exhausted completion exactly once through the agent finalizer", async () => {
		const { agent, primary, fallback } = createSession(model => failedStream(model), 3);
		const terminalSpy = vi.spyOn(agent, "requestRunTerminal");
		const events: AgentSessionEvent[] = [];
		session!.subscribe(event => events.push(event));

		await session!.prompt("exhaust chain");
		await session!.waitForIdle();

		const agentEnds = events.filter(event => event.type === "agent_end");
		const assistantLifecycle = assistantLifecycleEvents(events);
		expect(terminalSpy).toHaveBeenCalledTimes(1);
		expect(agentEnds).toHaveLength(1);
		expect(assistantLifecycle.map(event => event.type)).toEqual(["message_start", "message_end"]);
		expect(
			[...assistantLifecycle, ...agentEnds]
				.sort((left, right) => events.indexOf(left) - events.indexOf(right))
				.map(event => event.type),
		).toEqual(["message_start", "message_end", "agent_end"]);
		const terminal = terminalSpy.mock.calls[0]![1].messages![0] as AssistantMessage;
		expect(terminal).toMatchObject({ role: "assistant", stopReason: "error" });
		expect(terminal.errorMessage).toContain(selector(primary));
		expect(terminal.errorMessage).toContain(selector(fallback));
		expect(session!.messages).toContainEqual(
			expect.objectContaining({ role: "assistant", errorMessage: terminal.errorMessage }),
		);
	});

	it("bounds typed-other managed failures without promoting quota or transient prose", async () => {
		const errorMessage = "rate limit exceeded; retry after the transient timeout";
		const calls: string[] = [];
		createSession(model => {
			calls.push(selector(model));
			return otherTransportFailureStream(model, errorMessage);
		}, 1);
		const events: AgentSessionEvent[] = [];
		session!.subscribe(event => events.push(event));

		await session!.prompt("do not classify opaque transport prose");
		await session!.waitForIdle();

		expect(calls).toHaveLength(2);
		expect(events).toContainEqual(expect.objectContaining({ type: "model_fallback_switched", reason: "unknown" }));
	});

	it("routes typed managed context overflow to compaction without consuming fallback attempts", async () => {
		const calls: string[] = [];
		let attempts = 0;
		const { primary, fallback } = createSession(model => {
			calls.push(selector(model));
			return attempts++ === 0
				? typedOverflowStream(model)
				: createMockModel({ responses: [{ content: ["Recovered after compaction"] }] }).stream(model, {
						systemPrompt: [],
						messages: [],
						tools: [],
					});
		}, 1);
		session!.settings.set("compaction.enabled", true);
		session!.settings.set("compaction.autoContinue", false);
		const events: AgentSessionEvent[] = [];
		session!.subscribe(event => events.push(event));

		await session!.prompt("Route typed context overflow to compaction");
		await session!.waitForIdle();

		expect(calls).toContain(selector(primary));
		expect(calls).not.toContain(selector(fallback));
		expect(events).toContainEqual(expect.objectContaining({ type: "auto_compaction_start", reason: "overflow" }));
		expect(events.filter(event => event.type === "model_fallback_switched")).toHaveLength(0);
	});

	it("terminalizes failed managed overflow maintenance and releases the next prompt", async () => {
		let attempts = 0;
		const { agent, primary } = createSession((model, context, options) => {
			attempts += 1;
			return attempts === 1
				? typedOverflowStream(model)
				: createMockModel({ responses: [{ content: ["Independent next prompt"] }] }).stream(
						model,
						context,
						options,
					);
		}, 1);
		session!.settings.set("compaction.enabled", true);
		session!.settings.set("compaction.autoContinue", false);
		for (let index = 0; index < 4; index++) {
			const user = { role: "user" as const, content: `seed ${index}`, timestamp: Date.now() + index * 2 };
			const assistant: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: `seed response ${index}` }],
				api: primary.api,
				provider: primary.provider,
				model: primary.id,
				usage: {
					input: 30_000,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 30_001,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now() + index * 2 + 1,
			};
			agent.appendMessage(user);
			session!.sessionManager.appendMessage(user);
			agent.appendMessage(assistant);
			session!.sessionManager.appendMessage(assistant);
		}
		const prepareSpy = vi.spyOn(compactionModule, "prepareCompaction").mockImplementation(() => {
			throw new Error("request_too_large");
		});
		const events: AgentSessionEvent[] = [];
		session!.subscribe(event => events.push(event));

		await session!.prompt("Overflow whose maintenance fails", { skipCompactionCheck: true });
		await session!.waitForIdle();

		expect(prepareSpy).toHaveBeenCalled();
		expect(events.filter(event => event.type === "agent_end")).toHaveLength(1);
		expect(agent.activeRunId).toBeUndefined();
		expect(agent.currentManagedLogicalRunId).toBeUndefined();
		expect(attempts).toBe(1);
		prepareSpy.mockRestore();

		await session!.prompt("Independent next prompt", { skipCompactionCheck: true });
		await session!.waitForIdle();

		expect(attempts).toBe(2);
		expect(events.filter(event => event.type === "agent_end")).toHaveLength(2);
		expect(session!.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "Independent next prompt" }],
		});
	});

	it("finalizes exhausted when every fallback tail entry is unavailable during resolution", async () => {
		const { agent, primary } = createSession(model => failedStream(model), 1);
		session!.setConfiguredModelChain("default", [selector(primary), "unknown/unavailable-tail"], "test");
		const terminalSpy = vi.spyOn(agent, "requestRunTerminal");
		const events: AgentSessionEvent[] = [];
		session!.subscribe(event => events.push(event));

		await session!.prompt("exhaust unavailable tail");
		await session!.waitForIdle();

		expect(terminalSpy).toHaveBeenCalledTimes(1);
		expect(events.filter(event => event.type === "agent_end")).toHaveLength(1);
		expect(terminalSpy.mock.calls[0]![1]).toMatchObject({ stopReason: "exhausted" });
		const terminal = terminalSpy.mock.calls[0]![1].messages![0] as AssistantMessage;
		expect(terminal.errorMessage).toContain(selector(primary));
		expect(terminal.errorMessage).toContain("unknown/unavailable-tail (unknown_model)");
	});

	it("preserves exhausted completion when a subscriber aborts after unavailable-tail diagnostics", async () => {
		const { agent, primary, fallback } = createSession(model => failedStream(model), 3);
		session!.setConfiguredModelChain(
			"default",
			[selector(primary), selector(fallback), "unknown/unavailable-tail"],
			"test",
		);
		const terminalSpy = vi.spyOn(agent, "requestRunTerminal");
		const events: AgentSessionEvent[] = [];
		let abort: Promise<void> | undefined;
		session!.subscribe(event => {
			events.push(event);
			if (event.type === "message_end" && event.message.role === "assistant") {
				abort ??= session!.abort();
			}
		});

		await session!.prompt("retry twice then exhaust unavailable tail");
		await abort;
		await session!.waitForIdle();

		const agentEnds = events.filter(event => event.type === "agent_end");
		expect(agentEnds).toHaveLength(1);
		expect(terminalSpy).toHaveBeenCalledTimes(2);
		expect(terminalSpy.mock.calls).toEqual([
			[terminalSpy.mock.calls[0]![0], expect.objectContaining({ stopReason: "exhausted" })],
			[terminalSpy.mock.calls[0]![0], expect.objectContaining({ stopReason: "cancelled" })],
		]);
		expect(agentEnds[0]).toMatchObject({
			messages: [
				expect.objectContaining({
					role: "assistant",
					stopReason: "error",
					errorMessage: expect.stringContaining("unknown/unavailable-tail (unknown_model)"),
				}),
			],
		});
		expect(agentEnds).not.toContainEqual(expect.objectContaining({ stopReason: "cancelled" }));
	});
	it("settles a rejected managed continuation without duplicate terminal events", async () => {
		const { agent } = createSession(model => failedStream(model));
		vi.spyOn(agent, "continue").mockRejectedValueOnce(new Error("managed continuation rejected"));
		const events: AgentSessionEvent[] = [];
		session!.subscribe(event => events.push(event));

		await withTimeout(session!.prompt("reject managed continuation"), "prompt");
		await withTimeout(session!.waitForIdle(), "waitForIdle");

		expect(session!.isRetrying).toBe(false);
		expect(session!.isStreaming).toBe(false);
		const retryEnds = events.filter(
			(event): event is Extract<AgentSessionEvent, { type: "auto_retry_end" }> => event.type === "auto_retry_end",
		);
		expect(retryEnds).toEqual([
			expect.objectContaining({ success: false, attempt: 1, finalError: "managed continuation rejected" }),
		]);
		expect(events.filter(event => event.type === "agent_end")).toHaveLength(1);
	});
});
