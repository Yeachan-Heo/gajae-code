import { afterEach, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import {
	Agent,
	type AgentMessage,
	type AgentPromptOptions,
	isNonDispatchedToolEvent,
	markNonDispatchedToolEvent,
} from "@gajae-code/agent-core";
import type { Message, Model, SimpleStreamOptions } from "@gajae-code/ai";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { __sessionStateSidecarPerfCounters } from "@gajae-code/coding-agent/gjc-runtime/session-state-sidecar";
import {
	__agentSessionPerfCounters,
	AgentSession,
	type AgentSessionEvent,
	WorkerIntegrationRequestScheduler,
} from "@gajae-code/coding-agent/session/agent-session";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { createSdkRunCapability } from "../src/sdk/host/sdk-run-capability";
import { createAssistantMessage } from "./helpers/agent-session-setup";

function eventDelta(event: AgentSessionEvent): string {
	if (event.type !== "message_update") return "";
	const ame = event.assistantMessageEvent as { delta?: string };
	return ame.delta ?? "";
}

const testModelRegistry = {
	getApiKey: async () => "test-key",
	getAuthStorageOwner: () => undefined,
	withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
};

function createIsolatedSessionManager(): SessionManager {
	return SessionManager.inMemory(path.join(os.tmpdir(), `gjc-agent-session-pipeline-${Bun.randomUUIDv7()}`));
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
	it("reports a bounded worker integration failure outcome", async () => {
		const scheduler = new WorkerIntegrationRequestScheduler(async () => {
			throw new Error("worker integration failed");
		}, 50);
		scheduler.enqueue();
		expect(await scheduler.flushWithOutcome()).toEqual({
			status: "failed",
			error: "Error: worker integration failed",
		});
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
			modelRegistry: testModelRegistry as never,
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
		const requestOnPayload = vi.fn(async (_payload: unknown) => undefined);
		const session = new AgentSession({
			agent: createAgent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: testModelRegistry as never,
			onPayload: sessionOnPayload,
		});
		sessions.push(session);
		const options: SimpleStreamOptions = {
			apiKey: "key",
			onPayload: requestOnPayload,
		};

		const prepared = session.prepareSimpleStreamOptions(options);
		const result = await prepared.onPayload?.({ original: true });

		expect(sessionOnPayload.mock.calls.length).toBe(1);
		expect(sessionOnPayload.mock.calls[0]?.[0]).toEqual({ original: true });
		expect(requestOnPayload.mock.calls.length).toBe(1);
		expect(requestOnPayload.mock.calls[0]?.[0]).toEqual({ original: true, session: true });
		expect(result).toEqual({ original: true, session: true });
	});

	it("records raw SSE diagnostics into the session buffer before request hooks", async () => {
		const requestOnSseEvent = vi.fn((_event: unknown) => {});
		const session = new AgentSession({
			agent: createAgent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: testModelRegistry as never,
			onSseEvent: requestOnSseEvent,
		});
		sessions.push(session);

		const prepared = session.prepareSimpleStreamOptions({});
		prepared.onSseEvent?.({ event: "message", data: "{}", raw: ["event: message", "data: {}"] });

		expect(session.rawSseDebugBuffer.snapshot().totalEvents).toBe(1);
		expect(requestOnSseEvent.mock.calls.length).toBe(1);
		expect(requestOnSseEvent.mock.calls[0]?.[0]).toEqual({
			event: "message",
			data: "{}",
			raw: ["event: message", "data: {}"],
		});
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
			modelRegistry: testModelRegistry as never,
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

	it("forwards stop reasons and reasoning summaries to extension handlers", async () => {
		const agentEndDelivered = Promise.withResolvers<void>();
		const extensionEmit = vi.fn(
			async (
				_event: {
					type: string;
					messages?: unknown[];
					stopReason?: string;
					contentIndex?: number;
					content?: string;
				},
				_continueWhile?: () => boolean,
				_scope?: unknown,
			) => {},
		);
		const session = new AgentSession({
			agent: createAgent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: testModelRegistry as never,
			extensionRunner: {
				emit: async (...args: Parameters<typeof extensionEmit>) => {
					await extensionEmit(...args);
					if (args[0]?.type === "agent_end") agentEndDelivered.resolve();
				},
				hasHandlers: (eventType: string) => eventType === "reasoning_summary_end" || eventType === "agent_end",
			} as never,
		});
		sessions.push(session);

		session.agent.emitExternalEvent({ type: "agent_end", messages: [], stopReason: "cancelled" } as never);
		session.agent.emitExternalEvent({
			type: "message_update",
			message: createAssistantMessage("summary") as never,
			assistantMessageEvent: {
				type: "reasoning_summary_end",
				contentIndex: 0,
				content: "safe summary",
				partial: createAssistantMessage("summary"),
			},
		} as never);
		await agentEndDelivered.promise;

		const emittedEvents = extensionEmit.mock.calls.map(([event]) => event);
		expect(emittedEvents).toContainEqual({ type: "agent_end", messages: [], stopReason: "cancelled" });
		const reasoningCall = extensionEmit.mock.calls.find(([event]) => event?.type === "reasoning_summary_end");
		expect(reasoningCall?.[0]).toEqual(
			expect.objectContaining({
				type: "reasoning_summary_end",
				contentIndex: 0,
				content: "safe summary",
			}),
		);
		expect(typeof reasoningCall?.[1]).toBe("function");
	});

	it("drains pre-terminal reasoning summaries through slow extension handlers and drops post-terminal updates", async () => {
		const firstStarted = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		const secondDelivered = Promise.withResolvers<void>();
		const delivered: string[] = [];
		const extensionEmit = vi.fn(async (event: { type: string; content?: string }) => {
			if (event.type !== "reasoning_summary_end") return;
			delivered.push(event.content ?? "");
			if (event.content === "first") {
				firstStarted.resolve();
				await releaseFirst.promise;
			} else if (event.content === "second") {
				secondDelivered.resolve();
			}
		});
		const session = new AgentSession({
			agent: createAgent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: testModelRegistry as never,
			extensionRunner: {
				emit: extensionEmit,
				hasHandlers: (eventType: string) => eventType === "reasoning_summary_end",
			} as never,
		});
		sessions.push(session);
		const terminalObserved = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "turn_end") terminalObserved.resolve();
		});

		const emitSummaryEnd = (content: string) =>
			session.agent.emitExternalEvent({
				type: "message_update",
				message: createAssistantMessage(content) as never,
				assistantMessageEvent: {
					type: "reasoning_summary_end",
					contentIndex: 0,
					content,
					partial: createAssistantMessage(content),
				},
			} as never);

		session.agent.emitExternalEvent({ type: "turn_start" });
		emitSummaryEnd("first");
		await firstStarted.promise;
		emitSummaryEnd("second");
		session.agent.emitExternalEvent({
			type: "turn_end",
			message: createAssistantMessage("final"),
			toolResults: [],
		} as never);
		await terminalObserved.promise;
		releaseFirst.resolve();
		await secondDelivered.promise;

		emitSummaryEnd("after-terminal");
		await Promise.resolve();

		expect(delivered).toEqual(["first", "second"]);
	});

	it("caches listener snapshots and preserves mutation-during-emit safety", async () => {
		const session = new AgentSession({
			agent: createAgent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: testModelRegistry as never,
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
			modelRegistry: testModelRegistry as never,
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
			modelRegistry: testModelRegistry as never,
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

	it("stops in-flight message_update dispatch between handlers after the turn changes", async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		let blockedFirstUpdate = true;
		const started: string[] = [];
		const notificationsDelivered: string[] = [];
		const extensionEmit = vi.fn(
			async (event: { type: string; message?: { content?: unknown } }, continueWhile?: () => boolean) => {
				if (event.type !== "message_update") return;
				const content = JSON.stringify(event.message);
				started.push(content);
				if (blockedFirstUpdate) {
					blockedFirstUpdate = false;
					await promise;
				}
				if (continueWhile && !continueWhile()) return;
				notificationsDelivered.push(content);
			},
		);
		const session = new AgentSession({
			agent: createAgent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: testModelRegistry as never,
			extensionRunner: {
				emit: extensionEmit,
				hasHandlers: (eventType: string) => eventType === "message_update",
			} as never,
		});
		sessions.push(session);

		session.agent.emitExternalEvent({ type: "turn_start" });
		await Bun.sleep(0);
		session.agent.emitExternalEvent({
			type: "message_update",
			message: createAssistantMessage("turn-one-started") as never,
			assistantMessageEvent: { type: "text_delta", delta: "turn-one-started" },
		} as never);
		for (let i = 0; i < 20 && started.length === 0; i++) await Bun.sleep(1);
		expect(started).toHaveLength(1);
		expect(started[0]).toContain("turn-one-started");

		session.agent.emitExternalEvent({
			type: "message_update",
			message: createAssistantMessage("turn-one-stale") as never,
			assistantMessageEvent: { type: "text_delta", delta: "turn-one-stale" },
		} as never);
		session.agent.emitExternalEvent({
			type: "turn_end",
			message: createAssistantMessage("turn-one-final"),
			toolResults: [],
		} as never);
		session.agent.emitExternalEvent({ type: "turn_start" });
		await Bun.sleep(10);
		resolve();
		await Bun.sleep(10);

		expect(started).toHaveLength(1);
		expect(notificationsDelivered).toEqual([]);
	});

	it("red-team: listener snapshot rebuilds only on subscription mutations, not emits", async () => {
		const session = new AgentSession({
			agent: createAgent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: testModelRegistry as never,
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
			modelRegistry: testModelRegistry as never,
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
			modelRegistry: testModelRegistry as never,
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
			modelRegistry: testModelRegistry as never,
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
			modelRegistry: testModelRegistry as never,
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
			modelRegistry: testModelRegistry as never,
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
			modelRegistry: testModelRegistry as never,
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

	it("preserves non-dispatched tool provenance through extension event conversion", async () => {
		const emitted: Array<{ type: string } & Record<string, unknown>> = [];
		const session = new AgentSession({
			agent: createAgent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: testModelRegistry as never,
			extensionRunner: {
				emit: vi.fn(async (event: { type: string } & Record<string, unknown>) => {
					emitted.push(event);
				}),
				hasHandlers: (eventType: string) =>
					eventType === "tool_execution_start" || eventType === "tool_execution_end",
			} as never,
		});
		sessions.push(session);

		const sourceStart = {
			type: "tool_execution_start",
			toolCallId: "synthetic-call",
			toolName: "read",
			args: {},
		};
		const sourceEnd = {
			type: "tool_execution_end",
			toolCallId: "synthetic-call",
			toolName: "read",
			result: { content: "not dispatched" },
			isError: true,
		};
		markNonDispatchedToolEvent(sourceStart);
		markNonDispatchedToolEvent(sourceEnd);
		session.agent.emitExternalEvent(sourceStart as never);
		session.agent.emitExternalEvent(sourceEnd as never);
		await Bun.sleep(0);
		await Bun.sleep(0);

		const converted = emitted.filter(
			event => event.type === "tool_execution_start" || event.type === "tool_execution_end",
		);
		expect(converted).toHaveLength(2);
		expect(converted.every(event => isNonDispatchedToolEvent(event))).toBe(true);
	});

	it("red-team: subscribers see identical ordering through interleaved message and tool events", async () => {
		const session = new AgentSession({
			agent: createAgent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: testModelRegistry as never,
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

	it("steers a queued background exchange into the live run instead of the turn's end", async () => {
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
		let providerCalls = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["system prompt"],
				messages: [],
				tools: [],
			},
			streamFn: () => {
				providerCalls++;
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
			sessionManager: createIsolatedSessionManager(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: testModelRegistry as never,
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
		// The exchange belongs to the live run from here: the loop commits steering
		// messages at its next step boundary, so a long goal-mode turn can no longer
		// defer the exchange past the end of the whole turn.
		expect(agent.snapshotSteering().filter(message => message.role === "custom")).toHaveLength(1);

		finish.resolve();
		await promptPromise;

		const customMessages = agent.state.messages
			.filter(message => message.role === "custom")
			.filter(message => String(message.customType).startsWith("irc:"));
		expect(customMessages).toHaveLength(1);
		expect(customMessages[0]?.customType).toBe("irc:incoming");
		expect(customMessages[0]?.content).toContain("ping");
		// The steered exchange opened its own model step, so the provider received it
		// while the turn was still running.
		expect(providerCalls).toBeGreaterThanOrEqual(2);
	});

	it("retries a background exchange queued between tool steps once the run streams again", async () => {
		const model: Model = {
			id: "background-retry-model",
			name: "background-retry-model",
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
		let providerCalls = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["system prompt"],
				messages: [],
				tools: [],
			},
			streamFn: () => {
				providerCalls++;
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
			modelRegistry: testModelRegistry as never,
		});
		sessions.push(session);

		const promptPromise = session.prompt("hello");
		await started.promise;

		// A parent between tool steps is busy with no open stream: the window a
		// subagent's message lands in during a long goal-mode turn. The run's own
		// stream flag is what that window looks like from here, so flip it directly
		// for the duration of the queueing call.
		const runState = agent.state as { isStreaming: boolean };
		runState.isStreaming = false;
		await session.respondAsBackground({ from: "0-Main", message: "between steps", awaitReply: false });
		expect(agent.snapshotSteering()).toHaveLength(0);
		expect(
			agent.state.messages.some(
				message => message.role === "custom" && String(message.customType).startsWith("irc:"),
			),
		).toBe(false);
		runState.isStreaming = true;

		// The next agent event retries the delivery; the loop then commits the exchange
		// at the following step boundary.
		agent.emitExternalEvent({
			type: "tool_execution_start",
			toolCallId: "between-steps",
			toolName: "read",
			args: {},
		} as never);
		expect(agent.snapshotSteering().filter(message => message.role === "custom")).toHaveLength(1);

		finish.resolve();
		await promptPromise;

		const exchanged = agent.state.messages
			.filter(message => message.role === "custom")
			.filter(message => String(message.customType).startsWith("irc:"));
		expect(exchanged).toHaveLength(1);
		expect(exchanged[0]?.content).toContain("between steps");
		expect(providerCalls).toBeGreaterThanOrEqual(2);
	});
	it("settles public agent_end before a slow extension handler finishes", async () => {
		const extensionStarted = Promise.withResolvers<void>();
		const releaseExtension = Promise.withResolvers<void>();
		const session = new AgentSession({
			agent: createAgent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: testModelRegistry as never,
			extensionRunner: {
				emit: async (event: { type: string }) => {
					if (event.type !== "agent_end") return;
					extensionStarted.resolve();
					await releaseExtension.promise;
				},
				hasHandlers: (eventType: string) => eventType === "agent_end",
			} as never,
		});
		sessions.push(session);
		const publicAgentEnd = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "agent_end") publicAgentEnd.resolve();
		});
		const assistant = createAssistantMessage("done");

		session.agent.emitExternalEvent({ type: "message_end", message: assistant });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistant] });
		const idle = session.waitForIdle();
		await extensionStarted.promise;
		await idle;
		await publicAgentEnd.promise;

		releaseExtension.resolve();
	});
	it("publishes accepted agent_end before prompt settlement after a subscriber abort", async () => {
		const model: Model = {
			id: "terminal-settlement-model",
			name: "terminal-settlement-model",
			provider: "mock",
			api: "mock",
			baseUrl: "mock://",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 32_768,
		};
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["system prompt"], messages: [], tools: [] },
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") });
				});
				return stream;
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: createIsolatedSessionManager(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: testModelRegistry as never,
		});
		sessions.push(session);
		const events: AgentSessionEvent[] = [];
		let abort: Promise<void> | undefined;
		session.subscribe(event => {
			events.push(event);
			if (event.type === "message_end" && event.message.role === "assistant") abort ??= session.abort();
		});

		await session.prompt("hello");
		await abort;
		await session.waitForIdle();

		const agentEnds = events.filter(event => event.type === "agent_end");
		expect(agentEnds).toHaveLength(1);
		expect(agentEnds[0]).toMatchObject({ stopReason: "completed" });
		expect(events.at(-1)?.type).toBe("agent_end");
	});
	it("isolates throwing subscribers from terminal settlement and later events", async () => {
		const session = new AgentSession({
			agent: createAgent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: testModelRegistry as never,
		});
		sessions.push(session);
		const agentEnds: AgentSessionEvent[] = [];
		session.subscribe(event => {
			if (event.type === "agent_end") throw new Error("subscriber failed");
		});
		session.subscribe(event => {
			if (event.type === "agent_end") agentEnds.push(event);
		});

		const first = createAssistantMessage("first");
		session.agent.emitExternalEvent({ type: "message_end", message: first });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [first] });
		await session.waitForIdle();

		const second = createAssistantMessage("second");
		session.agent.emitExternalEvent({ type: "message_end", message: second });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [second] });
		await session.waitForIdle();

		expect(agentEnds).toHaveLength(2);
	});
	it("holds prompt settlement until worker integration is durable", async () => {
		const integrationStarted = Promise.withResolvers<void>();
		const sdkIntegrationStarted = Promise.withResolvers<void>();
		const releaseIntegration = Promise.withResolvers<void>();
		let integrationRequests = 0;
		let failIntegration = false;
		let neverSettle = false;
		let integrationAborted = false;
		const model: Model = {
			id: "worker-integration-model",
			name: "worker-integration-model",
			provider: "mock",
			api: "mock",
			baseUrl: "mock://",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 32_768,
		};
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["system prompt"], messages: [], tools: [] },
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") });
				});
				return stream;
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: createIsolatedSessionManager(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: testModelRegistry as never,
			workerIntegrationRequest: signal => {
				integrationRequests++;
				if (failIntegration) throw new Error("worker integration failed");
				integrationStarted.resolve();
				if (neverSettle) {
					sdkIntegrationStarted.resolve();
					return new Promise<void>(resolve => {
						signal.addEventListener("abort", () => {
							integrationAborted = true;
							resolve();
						});
					});
				}
				return releaseIntegration.promise;
			},
			workerIntegrationTimeoutMs: 10,
		});
		sessions.push(session);
		const events: AgentSessionEvent[] = [];
		session.subscribe(event => events.push(event));

		let promptResolved = false;
		const prompt = session.prompt("hello").then(() => {
			promptResolved = true;
		});
		await integrationStarted.promise;
		await Bun.sleep(0);
		expect(promptResolved).toBe(false);
		expect(events.some(event => event.type === "agent_end")).toBe(false);

		releaseIntegration.resolve();
		await prompt;
		expect(events.filter(event => event.type === "agent_end")).toHaveLength(1);
		expect(integrationRequests).toBe(1);

		// SDK/ACP settlement must not wait for post-prompt recovery. A recovery
		// request that ignores its abort signal represents the subagent/tool work
		// seen in the field: the correlated agent_end is still the terminal
		// boundary and must reach the client before that work drains.
		neverSettle = true;
		integrationAborted = false;
		const sdkSubmission = session.sendUserMessage("sdk terminal fast path", {
			sdkRunCapability: createSdkRunCapability("sdk-terminal-fast-path"),
		} as never);
		const secondAgentEnd = Promise.withResolvers<void>();
		const unsubscribe = session.subscribe(event => {
			if (event.type === "agent_end" && events.filter(candidate => candidate.type === "agent_end").length >= 2)
				secondAgentEnd.resolve();
		});
		try {
			await sdkIntegrationStarted.promise;
			// turn_end may start worker reconciliation before the terminal event is
			// published, so worker-start is not a barrier for agent_end delivery.
			await secondAgentEnd.promise;
			expect(events.filter(event => event.type === "agent_end")).toHaveLength(2);
		} finally {
			unsubscribe();
		}
		// Re-enable settlement so cleanup can proceed
		neverSettle = false;
		expect(integrationAborted).toBe(false);
		await sdkSubmission;
		await Bun.sleep(25);
		expect(integrationAborted).toBe(true);

		neverSettle = false;
		failIntegration = true;
		await session.prompt("again");
		await session.waitForIdle();
		expect(events.filter(event => event.type === "agent_end")).toHaveLength(3);
		expect(integrationRequests).toBe(3);

		failIntegration = false;
		await session.prompt("third time");
		await session.waitForIdle();
		expect(events.filter(event => event.type === "agent_end")).toHaveLength(4);
		expect(integrationRequests).toBe(4);

		neverSettle = true;
		await session.prompt("hung integration");
		await session.waitForIdle();
		expect(integrationAborted).toBe(true);
		expect(events.filter(event => event.type === "agent_end")).toHaveLength(5);

		neverSettle = false;
		await session.prompt("available after integration timeout");
		await session.waitForIdle();
		expect(events.filter(event => event.type === "agent_end")).toHaveLength(6);
	});
	it("starts SDK worker reconciliation before slow extension delivery and rejects on dispose", async () => {
		const extensionStarted = Promise.withResolvers<void>();
		const releaseExtension = Promise.withResolvers<void>();
		let workerStarted = false;
		const model: Model = {
			id: "slow-extension-model",
			name: "slow-extension-model",
			provider: "mock",
			api: "mock",
			baseUrl: "mock://",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 32_768,
		};
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["system prompt"], messages: [], tools: [] },
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") });
				});
				return stream;
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: createIsolatedSessionManager(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: testModelRegistry as never,
			workerIntegrationRequest: async () => {
				workerStarted = true;
			},
			extensionRunner: {
				hasHandlers: (eventType: string) => eventType === "agent_end",
				emitBeforeAgentStart: async () => undefined,
				emit: async (event: { type: string }) => {
					if (event.type !== "agent_end") return;
					extensionStarted.resolve();
					await releaseExtension.promise;
				},
			} as never,
		});
		sessions.push(session);
		const events: AgentSessionEvent[] = [];
		session.subscribe(event => events.push(event));

		const prompt = session.sendUserMessage("slow extension", {
			sdkRunCapability: createSdkRunCapability("slow-extension-owner"),
		} as never);
		await extensionStarted.promise;
		expect(workerStarted).toBe(true);
		expect(events.some(event => event.type === "agent_end")).toBe(true);
		const promptOutcome = prompt.then(
			() => ({ kind: "resolved" as const }),
			error => ({ kind: "rejected" as const, error }),
		);
		const disposed = session.dispose();
		try {
			const outcome = await Promise.race([promptOutcome, Bun.sleep(0).then(() => ({ kind: "pending" as const }))]);
			expect(outcome).toMatchObject({ kind: "rejected", error: { code: "cancelled" } });
		} finally {
			releaseExtension.resolve();
		}
		await disposed;
		expect(await promptOutcome).toMatchObject({ kind: "rejected", error: { code: "cancelled" } });
	});

	it("rejects an in-flight SDK terminal when disposal starts during extension delivery", async () => {
		const extensionStarted = Promise.withResolvers<void>();
		const releaseExtension = Promise.withResolvers<void>();
		const model: Model = {
			id: "dispose-slow-extension-model",
			name: "dispose-slow-extension-model",
			provider: "mock",
			api: "mock",
			baseUrl: "mock://",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 32_768,
		};
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["system prompt"], messages: [], tools: [] },
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") });
				});
				return stream;
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: createIsolatedSessionManager(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: testModelRegistry as never,
			extensionRunner: {
				emitBeforeAgentStart: async () => undefined,
				emit: async (event: { type: string }) => {
					if (event.type !== "agent_end") return;
					extensionStarted.resolve();
					await releaseExtension.promise;
				},
				hasHandlers: (eventType: string) => eventType === "agent_end",
			} as never,
		});
		sessions.push(session);

		const prompt = session.sendUserMessage("dispose during terminal delivery", {
			sdkRunCapability: createSdkRunCapability("dispose-slow-extension"),
		} as never);
		await extensionStarted.promise;
		const disposal = session.dispose();
		const promptOutcome = await Promise.race([
			prompt.then(
				() => "resolved",
				error => error,
			),
			Bun.sleep(100).then(() => "timeout"),
		]);
		expect(promptOutcome).not.toBe("timeout");
		expect(promptOutcome).not.toBe("resolved");
		expect(promptOutcome).toMatchObject({ code: "cancelled" });

		releaseExtension.resolve();
		await disposal;
	});

	it("drains deferred agent_end extension delivery before session shutdown", async () => {
		const extensionStarted = Promise.withResolvers<void>();
		const releaseExtension = Promise.withResolvers<void>();
		const extensionEvents: string[] = [];
		const model: Model = {
			id: "shutdown-drain-model",
			name: "shutdown-drain-model",
			provider: "mock",
			api: "mock",
			baseUrl: "mock://",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 32_768,
		};
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["system prompt"], messages: [], tools: [] },
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") });
				});
				return stream;
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: createIsolatedSessionManager(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: testModelRegistry as never,
			extensionRunner: {
				emit: async (event: { type: string }) => {
					extensionEvents.push(event.type);
					if (event.type !== "agent_end") return;
					extensionStarted.resolve();
					await releaseExtension.promise;
				},
				hasHandlers: (eventType: string) => eventType === "agent_end" || eventType === "session_shutdown",
				emitBeforeAgentStart: async () => ({}),
			} as never,
		});
		sessions.push(session);

		const prompt = session.prompt("hello");
		await extensionStarted.promise;
		await prompt;
		let idleResolved = false;
		const idle = session.waitForIdle().then(() => {
			idleResolved = true;
		});
		await Bun.sleep(0);
		expect(idleResolved).toBe(true);
		const disposed = session.dispose();
		await Bun.sleep(0);
		expect(extensionEvents.at(-1)).toBe("agent_end");

		releaseExtension.resolve();
		await disposed;
		await idle;
		expect(extensionEvents.at(-1)).toBe("session_shutdown");
	});

	it("does not publish SDK terminal before continuation decision settles", async () => {
		// Regression test for PR #6668 P1: a real SDK-owned terminal stays pending
		// while post-turn handling is unfinished, even when settlement attempts a flush.

		const model: Model = {
			id: "continuation-decision-guard-model",
			name: "continuation-decision-guard-model",
			provider: "mock",
			api: "mock",
			baseUrl: "mock://",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 32_768,
		};

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["system prompt"], messages: [], tools: [] },
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("test") });
				});
				return stream;
			},
		});

		const isolatedSessionCwd = path.join(os.tmpdir(), `agent-session-sdk-terminal-${Bun.randomUUIDv7()}`);
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(isolatedSessionCwd),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: testModelRegistry as never,
		});
		sessions.push(session);
		const decisionStarted = Promise.withResolvers<void>();
		const releaseDecision = Promise.withResolvers<void>();
		const agentPromptReturned = Promise.withResolvers<void>();
		const releaseAgentPrompt = Promise.withResolvers<void>();
		vi.spyOn(session.goalRuntime, "onAgentEnd").mockImplementation(async () => {
			decisionStarted.resolve();
			await releaseDecision.promise;
		});
		const originalAgentPrompt = agent.prompt.bind(agent);
		vi.spyOn(agent, "prompt").mockImplementation(async (...args) => {
			const [messages, options] = args;
			if (!Array.isArray(messages)) throw new Error("Expected AgentSession to submit an SDK message batch.");
			await originalAgentPrompt(messages, options as AgentPromptOptions | undefined);
			agentPromptReturned.resolve();
			await releaseAgentPrompt.promise;
		});

		const events: AgentSessionEvent[] = [];
		const sdkAgentEnds: Array<AgentSessionEvent & { type: "agent_end" }> = [];
		session.subscribe(event => {
			events.push(event);
			if (event.type === "agent_end") sdkAgentEnds.push(event as never);
		});

		const prompt = session.sendUserMessage("sdk terminal", {
			sdkRunCapability: createSdkRunCapability("continuation-decision-guard"),
		} as never);
		try {
			await decisionStarted.promise;
			session.flushParkedAgentEndForCoordinatorPersistForTests();
			expect(sdkAgentEnds).toHaveLength(0);
			releaseDecision.resolve();
			await agentPromptReturned.promise;
			await session.waitForAgentEndHandlingForTests();
			session.flushParkedAgentEndForCoordinatorPersistForTests();
			expect(sdkAgentEnds).toHaveLength(0);
		} finally {
			releaseDecision.resolve();
			releaseAgentPrompt.resolve();
		}

		await prompt;
		await session.waitForIdle();
		expect(sdkAgentEnds).toHaveLength(1);
	});

	it("does not delay an SDK terminal for a later admitted event handler", async () => {
		const laterEventStarted = Promise.withResolvers<void>();
		const releaseLaterEvent = Promise.withResolvers<void>();
		const terminalPublished = Promise.withResolvers<void>();
		const laterMessage = createAssistantMessage("unrelated external event");
		let laterEventSettled = false;
		const model: Model = {
			id: "later-event-terminal-model",
			name: "later-event-terminal-model",
			provider: "mock",
			api: "mock",
			baseUrl: "mock://",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 32_768,
		};
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["system prompt"], messages: [], tools: [] },
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") });
				});
				return stream;
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: createIsolatedSessionManager(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: testModelRegistry as never,
			extensionRunner: {
				emitBeforeAgentStart: async () => undefined,
				hasHandlers: (eventType: string) => eventType === "message_end",
				emit: async (event: { type: string; message?: unknown }) => {
					if (event.type !== "message_end" || event.message !== laterMessage) return;
					laterEventStarted.resolve();
					await releaseLaterEvent.promise;
					laterEventSettled = true;
				},
			} as never,
		});
		sessions.push(session);
		vi.spyOn(session.goalRuntime, "onAgentEnd").mockImplementation(async () => {
			agent.emitExternalEvent({ type: "message_end", message: laterMessage } as never);
			await laterEventStarted.promise;
		});
		session.subscribe(event => {
			if (event.type === "agent_end") terminalPublished.resolve();
		});

		const prompt = session.sendUserMessage("sdk terminal before unrelated work", {
			sdkRunCapability: createSdkRunCapability("terminal-admission-boundary"),
		} as never);
		try {
			await laterEventStarted.promise;
			const publishedBeforeLaterEvent = await Promise.race([
				terminalPublished.promise.then(() => true),
				Bun.sleep(1_000).then(() => false),
			]);
			expect(publishedBeforeLaterEvent).toBe(true);
			expect(laterEventSettled).toBe(false);
			releaseLaterEvent.resolve();
			await prompt;
			await session.waitForIdle();
		} finally {
			releaseLaterEvent.resolve();
		}
	});

	it("serializes a batched SDK terminal publication through the earlier extension delivery", async () => {
		const firstExtensionStarted = Promise.withResolvers<void>();
		const releaseFirstExtension = Promise.withResolvers<void>();
		const secondExtensionStarted = Promise.withResolvers<void>();
		const releaseSecondExtension = Promise.withResolvers<void>();
		let extensionPublicationCount = 0;
		const model: Model = {
			id: "batched-sdk-terminal-model",
			name: "batched-sdk-terminal-model",
			provider: "mock",
			api: "mock",
			baseUrl: "mock://",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 32_768,
		};
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["system prompt"], messages: [], tools: [] },
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("test") });
				});
				return stream;
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: createIsolatedSessionManager(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: testModelRegistry as never,
			extensionRunner: {
				emitBeforeAgentStart: async () => ({}),
				emit: async (event: { type: string }) => {
					if (event.type !== "agent_end") return;
					extensionPublicationCount++;
					if (extensionPublicationCount === 1) {
						firstExtensionStarted.resolve();
						await releaseFirstExtension.promise;
					} else if (extensionPublicationCount === 2) {
						secondExtensionStarted.resolve();
						await releaseSecondExtension.promise;
					}
				},
				hasHandlers: (eventType: string) => eventType === "agent_end",
			} as never,
		});
		sessions.push(session);
		const agentPromptReturned = Promise.withResolvers<void>();
		const releaseAgentPrompt = Promise.withResolvers<void>();
		const originalAgentPrompt = agent.prompt.bind(agent);
		vi.spyOn(agent, "prompt").mockImplementation(async (...args) => {
			const [messages, options] = args;
			if (!Array.isArray(messages)) throw new Error("Expected AgentSession to submit an SDK message batch.");
			await originalAgentPrompt(messages, options as AgentPromptOptions | undefined);
			// A second terminal can be queued while this SDK prompt's finalizer is
			// still in flight, which reproduces the two-entry flush batch.
			agent.emitExternalEvent({ type: "agent_end", messages: [], stopReason: "stop" } as never);
			agentPromptReturned.resolve();
			await releaseAgentPrompt.promise;
		});

		const sdkAgentEnds: AgentSessionEvent[] = [];
		session.subscribe(event => {
			if (event.type === "agent_end") sdkAgentEnds.push(event);
		});
		const prompt = session.sendUserMessage("sdk terminal batch", {
			sdkRunCapability: createSdkRunCapability("batched-sdk-terminal"),
		} as never);
		try {
			await agentPromptReturned.promise;
			releaseAgentPrompt.resolve();
			await firstExtensionStarted.promise;
			await Bun.sleep(0);
			expect(extensionPublicationCount).toBe(1);
			expect(sdkAgentEnds).toHaveLength(1);
			releaseFirstExtension.resolve();
			await secondExtensionStarted.promise;
			expect(extensionPublicationCount).toBe(2);
		} finally {
			releaseAgentPrompt.resolve();
			releaseFirstExtension.resolve();
			releaseSecondExtension.resolve();
		}
		await prompt;
		await session.waitForIdle();
		expect(extensionPublicationCount).toBe(2);
		expect(sdkAgentEnds).toHaveLength(2);
	});
});
