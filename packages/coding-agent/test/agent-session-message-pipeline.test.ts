import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent, type AgentMessage } from "@gajae-code/agent-core";
import type { Message, Model, SimpleStreamOptions } from "@gajae-code/ai";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { __sessionStateSidecarPerfCounters } from "@gajae-code/coding-agent/gjc-runtime/session-state-sidecar";
import {
	__agentSessionPerfCounters,
	AgentSession,
	type AgentSessionEvent,
} from "@gajae-code/coding-agent/session/agent-session";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { createAssistantMessage } from "./helpers/agent-session-setup";

function eventDelta(event: AgentSessionEvent): string {
	if (event.type !== "message_update") return "";
	const ame = event.assistantMessageEvent as { delta?: string };
	return ame.delta ?? "";
}

function createAgent(): Agent {
	return new Agent({
		initialState: {
			systemPrompt: ["system prompt"],
			messages: [],
			tools: [],
		},
	});
}

describe("AgentSession message pipeline", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		__agentSessionPerfCounters.reset();
		__sessionStateSidecarPerfCounters.reset();
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
	});

	it("applies transformContext before convertToLlm", async () => {
		const inputMessages: AgentMessage[] = [{ role: "user", content: "hello", timestamp: Date.now() }];
		const transformedMessages: AgentMessage[] = [
			...inputMessages,
			{ role: "user", content: "injected context", timestamp: Date.now() },
		];
		const convertedMessages: Message[] = [
			{
				role: "user",
				content: [{ type: "text", text: "converted" }],
				attribution: "user",
				timestamp: Date.now(),
			},
		];
		const transformContext = vi.fn(async (messages: AgentMessage[], signal?: AbortSignal) => {
			expect(signal).toBe(abortController.signal);
			return [...messages, ...transformedMessages.slice(messages.length)];
		});
		const convertToLlm = vi.fn(async (_messages: AgentMessage[]) => {
			return convertedMessages;
		});
		const abortController = new AbortController();
		const session = new AgentSession({
			agent: createAgent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
			transformContext,
			convertToLlm,
		});
		sessions.push(session);

		const result = await session.convertMessagesToLlm(inputMessages, abortController.signal);

		expect(transformContext).toHaveBeenCalledWith(inputMessages, abortController.signal);
		expect(convertToLlm).toHaveBeenCalledWith(transformedMessages);
		expect(result).toEqual(convertedMessages);
	});

	it("composes session payload hooks into direct side-request options", async () => {
		const sessionOnPayload = vi.fn(async (payload: unknown) => ({
			...(payload as Record<string, unknown>),
			session: true,
		}));
		const requestOnPayload = vi.fn(async () => undefined);
		const session = new AgentSession({
			agent: createAgent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
			onPayload: sessionOnPayload,
		});
		sessions.push(session);
		const options: SimpleStreamOptions = {
			apiKey: "key",
			onPayload: requestOnPayload,
		};

		const prepared = session.prepareSimpleStreamOptions(options);
		const result = await prepared.onPayload?.({ original: true });

		expect(sessionOnPayload).toHaveBeenCalledWith({ original: true }, undefined);
		expect(requestOnPayload).toHaveBeenCalledWith({ original: true, session: true }, undefined);
		expect(result).toEqual({ original: true, session: true });
	});

	it("records raw SSE diagnostics into the session buffer before request hooks", async () => {
		const requestOnSseEvent = vi.fn();
		const session = new AgentSession({
			agent: createAgent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
			onSseEvent: requestOnSseEvent,
		});
		sessions.push(session);

		const prepared = session.prepareSimpleStreamOptions({});
		prepared.onSseEvent?.({ event: "message", data: "{}", raw: ["event: message", "data: {}"] });

		expect(session.rawSseDebugBuffer.snapshot().totalEvents).toBe(1);
		expect(requestOnSseEvent).toHaveBeenCalledWith(
			{ event: "message", data: "{}", raw: ["event: message", "data: {}"] },
			undefined,
		);
	});

	it("emits message_update to session listeners before slow extension handlers finish", async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		const extensionEmit = vi.fn(async (event: { type: string }) => {
			if (event.type === "message_update") {
				await promise;
			}
		});
		const session = new AgentSession({
			agent: createAgent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
			extensionRunner: {
				emit: extensionEmit,
				hasHandlers: (eventType: string) => eventType === "message_update",
			} as never,
		});
		sessions.push(session);

		const events: AgentSessionEvent[] = [];
		session.subscribe(event => {
			events.push(event);
		});

		const assistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_1",
					name: "edit",
					arguments: {},
					partialJson: '{"file":"preview.txt","steps":[{"kbd":["ggdGi"],"insert":"rep',
				},
			],
			api: "test",
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		} as const;

		session.agent.emitExternalEvent({
			type: "message_update",
			message: assistantMessage as never,
			assistantMessageEvent: {
				type: "toolcall_delta",
				contentIndex: 0,
				delta: "rep",
			},
		} as never);

		await Bun.sleep(0);

		expect(events.some(event => event.type === "message_update")).toBe(true);
		expect(extensionEmit).toHaveBeenCalledTimes(1);

		resolve();
		await Bun.sleep(0);
	});

	it("caches listener snapshots and preserves mutation-during-emit safety", async () => {
		const session = new AgentSession({
			agent: createAgent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
		});
		sessions.push(session);

		const calls: string[] = [];
		let unsubscribeSecond: (() => void) | undefined;
		let mutated = false;
		const first = vi.fn(() => {
			calls.push("first");
			if (!mutated) {
				mutated = true;
				unsubscribeSecond?.();
				session.subscribe(() => calls.push("third"));
			}
		});
		const second = vi.fn(() => calls.push("second"));
		session.subscribe(first);
		unsubscribeSecond = session.subscribe(second);
		__agentSessionPerfCounters.reset();

		for (let i = 0; i < 20; i++) {
			session.agent.emitExternalEvent({
				type: "message_update",
				message: createAssistantMessage(`chunk ${i}`) as never,
				assistantMessageEvent: { type: "text_delta", delta: `${i}` },
			} as never);
		}

		expect(first).toHaveBeenCalledTimes(20);
		expect(second).toHaveBeenCalledTimes(1);
		expect(calls.slice(0, 2)).toEqual(["first", "second"]);
		expect(calls).toContain("third");
		expect(__agentSessionPerfCounters.listenerSnapshotRebuilds).toBe(2);
	});

	it("skips sidecar and extension queueing for message_update when no extension handles streaming", async () => {
		const extensionEmit = vi.fn(async () => {});
		const session = new AgentSession({
			agent: createAgent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
			extensionRunner: {
				emit: extensionEmit,
				hasHandlers: () => false,
			} as never,
		});
		sessions.push(session);
		__agentSessionPerfCounters.reset();
		__sessionStateSidecarPerfCounters.reset();

		session.agent.emitExternalEvent({
			type: "message_update",
			message: createAssistantMessage("chunk") as never,
			assistantMessageEvent: { type: "text_delta", delta: "chunk" },
		} as never);
		await Bun.sleep(0);

		expect(extensionEmit).not.toHaveBeenCalled();
		expect(__agentSessionPerfCounters.messageUpdateExtensionQueues).toBe(0);
		expect(__sessionStateSidecarPerfCounters.persistFromEventCalls).toBe(0);
	});

	it("queues message_update for extensions that handle streaming", async () => {
		const extensionEmit = vi.fn(async () => {});
		const session = new AgentSession({
			agent: createAgent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
			extensionRunner: {
				emit: extensionEmit,
				hasHandlers: (eventType: string) => eventType === "message_update",
			} as never,
		});
		sessions.push(session);
		__agentSessionPerfCounters.reset();
		__sessionStateSidecarPerfCounters.reset();

		session.agent.emitExternalEvent({
			type: "message_update",
			message: createAssistantMessage("chunk") as never,
			assistantMessageEvent: { type: "text_delta", delta: "chunk" },
		} as never);
		await Bun.sleep(0);

		expect(extensionEmit).toHaveBeenCalledTimes(1);
		expect(__agentSessionPerfCounters.messageUpdateExtensionQueues).toBe(1);
		expect(__sessionStateSidecarPerfCounters.persistFromEventCalls).toBe(0);
	});

	it("red-team: listener snapshot rebuilds only on subscription mutations, not emits", async () => {
		const session = new AgentSession({
			agent: createAgent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
		});
		sessions.push(session);

		const calls: string[] = [];
		const unsubscribes = [
			session.subscribe(event => calls.push(`a:${event.type}`)),
			session.subscribe(event => calls.push(`b:${event.type}`)),
			session.subscribe(event => calls.push(`c:${event.type}`)),
		];
		__agentSessionPerfCounters.reset();

		for (let i = 0; i < 100; i++) {
			session.agent.emitExternalEvent({
				type: "message_update",
				message: createAssistantMessage(`chunk ${i}`) as never,
				assistantMessageEvent: { type: "text_delta", delta: `${i}` },
			} as never);
		}

		expect(calls).toHaveLength(300);
		expect(__agentSessionPerfCounters.listenerSnapshotRebuilds).toBe(0);
		unsubscribes[1]?.();
		expect(__agentSessionPerfCounters.listenerSnapshotRebuilds).toBe(1);
		for (let i = 0; i < 10; i++) {
			session.agent.emitExternalEvent({
				type: "message_update",
				message: createAssistantMessage(`after ${i}`) as never,
				assistantMessageEvent: { type: "text_delta", delta: `${i}` },
			} as never);
		}
		expect(__agentSessionPerfCounters.listenerSnapshotRebuilds).toBe(1);
		unsubscribes[0]?.();
		unsubscribes[2]?.();
		expect(__agentSessionPerfCounters.listenerSnapshotRebuilds).toBe(3);
	});

	it("red-team: unsubscribe during emit uses the pre-change snapshot exactly once", async () => {
		const session = new AgentSession({
			agent: createAgent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
		});
		sessions.push(session);

		const calls: string[] = [];
		let unsubscribeFirst: (() => void) | undefined;
		let unsubscribeSecond: (() => void) | undefined;
		const first = vi.fn((event: AgentSessionEvent) => {
			calls.push(`first:${event.type}`);
			unsubscribeSecond?.();
			unsubscribeFirst?.();
		});
		const second = vi.fn((event: AgentSessionEvent) => calls.push(`second:${event.type}`));
		unsubscribeFirst = session.subscribe(first);
		unsubscribeSecond = session.subscribe(second);

		session.agent.emitExternalEvent({
			type: "message_update",
			message: createAssistantMessage("current") as never,
			assistantMessageEvent: { type: "text_delta", delta: "current" },
		} as never);
		session.agent.emitExternalEvent({
			type: "message_update",
			message: createAssistantMessage("later") as never,
			assistantMessageEvent: { type: "text_delta", delta: "later" },
		} as never);

		expect(calls).toEqual(["first:message_update", "second:message_update"]);
		expect(first).toHaveBeenCalledTimes(1);
		expect(second).toHaveBeenCalledTimes(1);
	});

	it("red-team: subscribe during emit only affects subsequent events", async () => {
		const session = new AgentSession({
			agent: createAgent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
		});
		sessions.push(session);

		const calls: string[] = [];
		let subscribed = false;
		const late = vi.fn((event: AgentSessionEvent) => calls.push(`late:${event.type}`));
		const first = vi.fn((event: AgentSessionEvent) => {
			calls.push(`first:${event.type}`);
			if (!subscribed) {
				subscribed = true;
				session.subscribe(late);
			}
		});
		session.subscribe(first);

		session.agent.emitExternalEvent({
			type: "message_update",
			message: createAssistantMessage("current") as never,
			assistantMessageEvent: { type: "text_delta", delta: "current" },
		} as never);
		session.agent.emitExternalEvent({
			type: "message_update",
			message: createAssistantMessage("later") as never,
			assistantMessageEvent: { type: "text_delta", delta: "later" },
		} as never);

		expect(calls).toEqual(["first:message_update", "first:message_update", "late:message_update"]);
		expect(first).toHaveBeenCalledTimes(2);
		expect(late).toHaveBeenCalledTimes(1);
	});

	it("red-team: re-entrant emits do not corrupt listener snapshots", async () => {
		const session = new AgentSession({
			agent: createAgent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
		});
		sessions.push(session);

		const calls: string[] = [];
		let nested = false;
		const first = vi.fn((event: AgentSessionEvent) => {
			calls.push(`first:${event.type}:${eventDelta(event)}`);
			if (!nested && event.type === "message_update" && eventDelta(event) === "outer") {
				nested = true;
				session.agent.emitExternalEvent({
					type: "message_update",
					message: createAssistantMessage("nested") as never,
					assistantMessageEvent: { type: "text_delta", delta: "nested" },
				} as never);
			}
		});
		const second = vi.fn((event: AgentSessionEvent) => calls.push(`second:${event.type}:${eventDelta(event)}`));
		session.subscribe(first);
		session.subscribe(second);
		__agentSessionPerfCounters.reset();

		session.agent.emitExternalEvent({
			type: "message_update",
			message: createAssistantMessage("outer") as never,
			assistantMessageEvent: { type: "text_delta", delta: "outer" },
		} as never);

		expect(calls).toEqual([
			"first:message_update:outer",
			"first:message_update:nested",
			"second:message_update:nested",
			"second:message_update:outer",
		]);
		expect(first).toHaveBeenCalledTimes(2);
		expect(second).toHaveBeenCalledTimes(2);
		expect(__agentSessionPerfCounters.listenerSnapshotRebuilds).toBe(0);
	});

	it("red-team: sidecar skips message_update but persists state-mapped events", async () => {
		const session = new AgentSession({
			agent: createAgent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
		});
		sessions.push(session);
		__sessionStateSidecarPerfCounters.reset();

		session.agent.emitExternalEvent({
			type: "message_update",
			message: createAssistantMessage("chunk") as never,
			assistantMessageEvent: { type: "text_delta", delta: "chunk" },
		} as never);
		await Bun.sleep(0);
		expect(__sessionStateSidecarPerfCounters.persistFromEventCalls).toBe(0);

		session.agent.emitExternalEvent({ type: "agent_start", prompt: "hello" } as never);
		await Bun.sleep(0);
		expect(__sessionStateSidecarPerfCounters.persistFromEventCalls).toBe(1);
	});

	it("red-team: extension gate preserves message_update and non-message_update ordering", async () => {
		const noHandlerEmit = vi.fn(async () => {});
		const noHandlerSession = new AgentSession({
			agent: createAgent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
			extensionRunner: {
				emit: noHandlerEmit,
				hasHandlers: () => false,
			} as never,
		});
		sessions.push(noHandlerSession);

		noHandlerSession.agent.emitExternalEvent({
			type: "message_update",
			message: createAssistantMessage("skipped") as never,
			assistantMessageEvent: { type: "text_delta", delta: "skipped" },
		} as never);
		noHandlerSession.agent.emitExternalEvent({ type: "agent_start", prompt: "hello" } as never);
		await Bun.sleep(0);
		expect(noHandlerEmit.mock.calls.map(call => ((call as unknown[])[0] as { type: string }).type)).toEqual([
			"agent_start",
		]);

		const extensionCalls: string[] = [];
		const session = new AgentSession({
			agent: createAgent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
			extensionRunner: {
				emit: vi.fn(async (event: { type: string; assistantMessageEvent?: { delta?: string } }) => {
					extensionCalls.push(
						event.type === "message_update" ? `message_update:${event.assistantMessageEvent?.delta}` : event.type,
					);
				}),
				hasHandlers: (eventType: string) => eventType === "message_update",
			} as never,
		});
		sessions.push(session);

		session.agent.emitExternalEvent({ type: "agent_start", prompt: "hello" } as never);
		session.agent.emitExternalEvent({
			type: "message_update",
			message: createAssistantMessage("one") as never,
			assistantMessageEvent: { type: "text_delta", delta: "one" },
		} as never);
		session.agent.emitExternalEvent({
			type: "message_update",
			message: createAssistantMessage("two") as never,
			assistantMessageEvent: { type: "text_delta", delta: "two" },
		} as never);
		await Bun.sleep(0);
		await Bun.sleep(0);

		expect(extensionCalls).toEqual(["agent_start", "message_update:one", "message_update:two"]);
	});

	it("red-team: subscribers see identical ordering through interleaved message and tool events", async () => {
		const session = new AgentSession({
			agent: createAgent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
		});
		sessions.push(session);

		const seen = [[], [], []] as string[][];
		for (const bucket of seen) {
			session.subscribe(event => {
				if (event.type === "message_update") {
					bucket.push(`message_update:${eventDelta(event)}`);
				} else if (event.type === "tool_execution_start") {
					bucket.push(`tool_execution_start:${event.toolCallId}`);
				} else if (event.type === "tool_execution_update") {
					bucket.push(`tool_execution_update:${event.toolCallId}`);
				} else if (event.type === "tool_execution_end") {
					bucket.push(`tool_execution_end:${event.toolCallId}`);
				}
			});
		}

		session.agent.emitExternalEvent({
			type: "message_update",
			message: createAssistantMessage("one") as never,
			assistantMessageEvent: { type: "text_delta", delta: "one" },
		} as never);
		session.agent.emitExternalEvent({
			type: "tool_execution_start",
			toolCallId: "tool-1",
			toolName: "edit",
			args: {},
			intent: "edit",
		} as never);
		session.agent.emitExternalEvent({
			type: "message_update",
			message: createAssistantMessage("two") as never,
			assistantMessageEvent: { type: "text_delta", delta: "two" },
		} as never);
		session.agent.emitExternalEvent({
			type: "tool_execution_update",
			toolCallId: "tool-1",
			toolName: "edit",
			args: {},
			partialResult: "half",
		} as never);
		session.agent.emitExternalEvent({
			type: "message_update",
			message: createAssistantMessage("three") as never,
			assistantMessageEvent: { type: "text_delta", delta: "three" },
		} as never);
		session.agent.emitExternalEvent({
			type: "tool_execution_end",
			toolCallId: "tool-1",
			toolName: "edit",
			args: {},
			result: "done",
			isError: false,
		} as never);

		const expected = [
			"message_update:one",
			"tool_execution_start:tool-1",
			"message_update:two",
			"tool_execution_update:tool-1",
			"message_update:three",
			"tool_execution_end:tool-1",
		];
		expect(seen).toEqual([expected, expected, expected]);
	});

	it("flushes queued background exchanges during prompt teardown without waiting for polling timers", async () => {
		const model: Model = {
			id: "background-flush-model",
			name: "background-flush-model",
			provider: "mock",
			api: "mock",
			baseUrl: "mock://",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 32_768,
		};
		const started = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["system prompt"],
				messages: [],
				tools: [],
			},
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				void (async () => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					started.resolve();
					await finish.promise;
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") });
				})();
				return stream;
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: { getApiKey: async () => "test-key" } as never,
		});
		sessions.push(session);

		const promptPromise = session.prompt("hello");
		await started.promise;
		expect(session.isStreaming).toBe(true);

		await session.respondAsBackground({ from: "0-Main", message: "ping", awaitReply: false });
		// Only the background IRC exchange is deferred here; other injected custom
		// messages (e.g. volatile-project-context) are unrelated to this assertion.
		const ircBefore = agent.state.messages
			.filter(message => message.role === "custom")
			.filter(message => String(message.customType).startsWith("irc:"));
		expect(ircBefore).toHaveLength(0);

		finish.resolve();
		await promptPromise;

		const customMessages = agent.state.messages
			.filter(message => message.role === "custom")
			.filter(message => String(message.customType).startsWith("irc:"));
		expect(customMessages).toHaveLength(1);
		expect(customMessages[0]?.customType).toBe("irc:incoming");
		expect(customMessages[0]?.content).toContain("ping");
		expect(agent.state.messages.at(-1)).toBe(customMessages[0]);
	});
});
