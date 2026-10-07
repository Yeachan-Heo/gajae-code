import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent, type AgentEvent, type AgentOptions, type AgentTool } from "@gajae-code/agent-core";
import * as compactionModule from "@gajae-code/agent-core/compaction";
import { type AssistantMessage, getBundledModel, type Model, type ToolCall } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { ExtensionRunner } from "@gajae-code/coding-agent/extensibility/extensions/runner";
import type { Extension } from "@gajae-code/coding-agent/extensibility/extensions/types";
import { AgentSession, type AgentSessionEvent } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";

import { TempDir } from "@gajae-code/utils";
import { z } from "zod";

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
function typedFirstEventTimeoutStream(model: Model): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const message: AssistantMessage = {
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
			errorMessage: "Error: Provider stream timed out while waiting for the first event",
			transportFailure: { kind: "transport", providerCode: "stream_first_event_timeout" },
			timestamp: Date.now(),
		};
		stream.push({ type: "start", partial: message });
		stream.push({ type: "error", reason: "error", error: message });
	});
	return stream;
}
function typedStatuslessOverloadStream(model: Model): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const message: AssistantMessage = {
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
			errorMessage: "server_is_overloaded: Please try again later.",
			transportFailure: {
				kind: "transport",
				providerCode: "server_is_overloaded",
				openaiErrorCode: "server_is_overloaded",
			},
			timestamp: Date.now(),
		};
		stream.push({ type: "start", partial: message });
		stream.push({ type: "error", reason: "error", error: message });
	});
	return stream;
}
function typedStatuslessOverloadWithTextStream(model: Model): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const partial: AssistantMessage = {
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
			stopReason: "stop",
			timestamp: Date.now(),
		};
		const message: AssistantMessage = {
			...partial,
			content: [{ type: "text", text: "already streamed" }],
			stopReason: "error",
			errorMessage: "server_is_overloaded: Our servers are currently overloaded. Please try again later.",
			transportFailure: {
				kind: "transport",
				providerCode: "server_is_overloaded",
				openaiErrorCode: "server_is_overloaded",
			},
		};
		stream.push({ type: "start", partial });
		stream.push({ type: "text_start", contentIndex: 0, partial: message });
		stream.push({ type: "text_delta", contentIndex: 0, delta: "already streamed", partial: message });
		stream.push({ type: "error", reason: "error", error: message });
	});
	return stream;
}
function collapsedSnapshotStream(model: Model): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const message: AssistantMessage = {
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
			stopReason: "stop",
			timestamp: Date.now(),
		};
		const collapsed = new Proxy(message, {
			get() {
				throw new Error("collapsed root");
			},
		});
		stream.push({ type: "start", partial: collapsed });
	});
	return stream;
}
function localErrorEventStream(
	model: Model,
	content: AssistantMessage["content"],
	errorMessage: string,
): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const message: AssistantMessage = {
			role: "assistant",
			content,
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
			timestamp: Date.now(),
		};
		stream.push({ type: "start", partial: message });
		stream.push({ type: "error", reason: "error", error: message });
	});
	return stream;
}
function oversizedEventStream(model: Model): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const message: AssistantMessage = {
			role: "assistant",
			// One byte over MANAGED_ATTEMPT_MAX_STAGED_BYTES so the provisional
			// staging buffer rejects the event with a local overflow.
			content: [{ type: "text", text: "x".repeat(16 * 1024 * 1024 + 1) }],
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
			stopReason: "stop",
			timestamp: Date.now(),
		};
		stream.push({ type: "start", partial: message });
	});
	return stream;
}

function zeroTokenEmptyStopStream(model: Model, typed = true, teardown = false): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const message: AssistantMessage = {
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
			stopReason: "stop",
			...(typed ? { transportFailure: { kind: "transport" as const, providerCode: "empty_response" } } : {}),
			timestamp: Date.now(),
		};
		stream.push({ type: "start", partial: message });
		if (teardown) stream.end(message);
		else stream.push({ type: "done", reason: "stop", message });
	});
	return stream;
}
function toolUseStream(model: Model, toolCall: ToolCall): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const message: AssistantMessage = {
			role: "assistant",
			content: [toolCall],
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
			stopReason: "toolUse",
			timestamp: Date.now(),
		};
		stream.push({ type: "start", partial: message });
		stream.push({ type: "done", reason: "toolUse", message });
	});
	return stream;
}

function extensionRunnerForHandler(
	cwd: string,
	sessionManager: SessionManager,
	modelRegistry: ModelRegistry,
	eventType: "context" | "message_end",
	onHandler?: () => void | Promise<void>,
): ExtensionRunner {
	const extension: Extension = {
		path: "test-extension",
		resolvedPath: "test-extension",
		handlers: new Map([[eventType, [async () => onHandler?.()]]]) as Extension["handlers"],
		tools: new Map(),
		messageRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
	return new ExtensionRunner(
		[extension],
		{ flagValues: new Map(), pendingProviderRegistrations: [] } as never,
		cwd,
		sessionManager,
		modelRegistry,
	);
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
		options: {
			tools?: AgentTool[];
			handler?: "context" | "message_end";
			onHandler?: () => void | Promise<void>;
			settings?: Record<string, unknown>;
			singleModelChain?: boolean;
		} = {},
	): { agent: Agent; primary: Model; fallback: Model } {
		const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!primary || !fallback) throw new Error("Expected bundled test models");
		const sessionManager = SessionManager.inMemory();
		const modelRegistry = new ModelRegistry(authStorage);
		const extensionRunner = options.handler
			? extensionRunnerForHandler(tempDir.path(), sessionManager, modelRegistry, options.handler, options.onHandler)
			: undefined;
		const agent = new Agent({
			getApiKey: provider => `${provider}-key`,
			initialState: { model: primary, systemPrompt: ["test"], tools: options.tools ?? [], messages: [] },
			transformContext:
				options.handler === "context"
					? (messages, _signal, scope) => extensionRunner!.emitContext(messages, scope)
					: undefined,
			streamFn,
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"fallback.maxAttempts": maxAttempts,
			"retry.baseDelayMs": 1,
			...options.settings,
		});
		settings.setModelRole("default", selector(primary));
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			extensionRunner,
		});
		session.setConfiguredModelChain(
			"default",
			options.singleModelChain ? [selector(primary)] : [selector(primary), selector(fallback)],
			"test",
		);
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

	it("discards a zero-token empty stop and accepts the fallback response", async () => {
		const calls: string[] = [];
		createSession((model, context, options) => {
			calls.push(selector(model));
			return calls.length === 1
				? zeroTokenEmptyStopStream(model)
				: createMockModel({ responses: [{ content: ["accepted"] }] }).stream(model, context, options);
		});
		const events: AgentSessionEvent[] = [];
		session!.subscribe(event => events.push(event));

		await session!.prompt("recover from empty response");
		await session!.waitForIdle();

		expect(calls).toHaveLength(2);
		expect(assistantLifecycleEvents(events).filter(event => event.type === "message_start")).toHaveLength(1);
		expect(session!.messages.filter(message => message.role === "assistant")).toEqual([
			expect.objectContaining({ content: [expect.objectContaining({ type: "text", text: "accepted" })] }),
		]);
	});

	it.each([false, true])("falls back after a clean untyped zero-token empty stop (teardown=%s)", async teardown => {
		const calls: string[] = [];
		const { agent, primary, fallback } = createSession((model, context, options) => {
			calls.push(selector(model));
			return calls.length === 1
				? zeroTokenEmptyStopStream(model, false, teardown)
				: createMockModel({ responses: [{ content: ["accepted"] }] }).stream(model, context, options);
		}, 1);
		const events: AgentSessionEvent[] = [];
		session!.subscribe(event => events.push(event));

		await session!.prompt("recover from an untyped empty response");
		await session!.waitForIdle();

		expect(calls).toEqual([selector(primary), selector(fallback)]);
		expect(session!.model).toEqual(fallback);
		expect(events.filter(event => event.type === "model_fallback_switched")).toHaveLength(1);
		const lifecycle = assistantLifecycleEvents(events);
		expect(lifecycle.filter(event => event.type === "message_start")).toHaveLength(1);
		expect(lifecycle.filter(event => event.type === "message_end")).toHaveLength(1);
		expect(events.filter(event => event.type === "turn_end")).toHaveLength(1);
		expect(events.filter(event => event.type === "agent_end")).toHaveLength(1);
		expect(
			events
				.filter(
					event =>
						event.type === "turn_end" ||
						event.type === "agent_end" ||
						(event.type === "message_end" && event.message.role === "assistant"),
				)
				.map(event => event.type),
		).toEqual(["message_end", "turn_end", "agent_end"]);
		expect(session!.messages.filter(message => message.role === "assistant")).toEqual([
			expect.objectContaining({
				stopReason: "stop",
				content: [expect.objectContaining({ type: "text", text: "accepted" })],
			}),
		]);
		expect(agent.activeRunId).toBeUndefined();
		expect(agent.currentManagedLogicalRunId).toBeUndefined();
	});

	it.each([
		"throw",
		"teardown",
		"timeout",
	] as const)("settles a %s failure after local empty fallback", async failure => {
		const calls: string[] = [];
		const { agent, primary, fallback } = createSession(model => {
			calls.push(selector(model));
			if (calls.length === 1) return zeroTokenEmptyStopStream(model, false);
			if (failure === "throw") throw new Error("fallback stream failed");
			if (failure === "timeout") return typedFirstEventTimeoutStream(model);
			return zeroTokenEmptyStopStream(model, false, true);
		}, 1);
		const events: AgentSessionEvent[] = [];
		session!.subscribe(event => events.push(event));

		await withTimeout(session!.prompt("settle failed local empty fallback"), "prompt");
		await withTimeout(session!.waitForIdle(), "waitForIdle");

		expect(calls).toEqual([selector(primary), selector(fallback)]);
		expect(events.filter(event => event.type === "model_fallback_switched")).toHaveLength(1);
		expect(events.filter(event => event.type === "agent_end")).toHaveLength(1);
		expect(session!.messages.filter(message => message.role === "assistant")).toEqual([
			expect.objectContaining({ stopReason: "error" }),
		]);
		expect(session!.isStreaming).toBe(false);
		expect(session!.isRetrying).toBe(false);
		expect(agent.activeRunId).toBeUndefined();
		expect(agent.currentManagedLogicalRunId).toBeUndefined();
	});

	it.each([
		false,
		true,
	])("cancels local empty fallback without accepting a late acknowledgement (late=%s)", async late => {
		const calls: string[] = [];
		const pending = new AssistantMessageEventStream();
		const entered = Promise.withResolvers<void>();
		const { agent, primary, fallback } = createSession(model => {
			calls.push(selector(model));
			if (calls.length === 1) return zeroTokenEmptyStopStream(model, false);
			entered.resolve();
			return pending;
		}, 1);
		const events: AgentSessionEvent[] = [];
		session!.subscribe(event => events.push(event));
		const run = session!.prompt("cancel after local empty fallback selection");
		await withTimeout(entered.promise, "fallback entered");
		await session!.abort();
		if (late) {
			const accepted = createMockModel({ responses: [{ content: ["late accepted"] }] }).stream(fallback, {
				systemPrompt: [],
				messages: [],
				tools: [],
			});
			for await (const event of accepted) pending.push(event);
		}
		await withTimeout(run, "prompt");
		await withTimeout(session!.waitForIdle(), "waitForIdle");

		expect(calls).toEqual([selector(primary), selector(fallback)]);
		expect(events.filter(event => event.type === "agent_end")).toEqual([
			expect.objectContaining({ stopReason: "cancelled" }),
		]);
		expect(
			session!.messages.filter(message => message.role === "assistant" && message.stopReason === "stop"),
		).toHaveLength(0);
		expect(session!.isStreaming).toBe(false);
		expect(session!.isRetrying).toBe(false);
		expect(agent.activeRunId).toBeUndefined();
		expect(agent.currentManagedLogicalRunId).toBeUndefined();
	});

	it("disposes a pending local empty fallback once and rejects late stream output", async () => {
		const calls: string[] = [];
		const pending = new AssistantMessageEventStream();
		const entered = Promise.withResolvers<void>();
		const { agent, primary, fallback } = createSession(model => {
			calls.push(selector(model));
			if (calls.length === 1) return zeroTokenEmptyStopStream(model, false);
			entered.resolve();
			return pending;
		}, 1);
		const events: AgentSessionEvent[] = [];
		session!.subscribe(event => events.push(event));
		const run = session!.prompt("dispose during local empty fallback");
		const terminals: AgentEvent[] = [];
		agent.subscribe(event => {
			if (event.type === "agent_end") terminals.push(event);
		});
		await withTimeout(entered.promise, "fallback entered");
		await session!.dispose();
		const disposedEventCount = events.length;

		const late = createMockModel({ responses: [{ content: ["late accepted"] }] }).stream(fallback, {
			systemPrompt: [],
			messages: [],
			tools: [],
		});
		for await (const event of late) pending.push(event);
		await withTimeout(run, "disposed prompt");

		expect(calls).toEqual([selector(primary), selector(fallback)]);
		// Disposal disconnects the session bridge before cancelling the agent.
		expect(events).toHaveLength(disposedEventCount);
		expect(terminals).toEqual([expect.objectContaining({ stopReason: "cancelled" })]);
		expect(
			session!.messages.filter(message => message.role === "assistant" && message.stopReason === "stop"),
		).toHaveLength(0);
		expect(agent.activeRunId).toBeUndefined();
		expect(agent.currentManagedLogicalRunId).toBeUndefined();
		session = undefined;
	});

	it("does not replay a typed empty response after a managed context handler participates", async () => {
		const calls: string[] = [];
		let handlerCalls = 0;
		createSession(
			(model, _context, _options) => {
				calls.push(selector(model));
				return zeroTokenEmptyStopStream(model);
			},
			3,
			{
				handler: "context",
				onHandler: () => {
					handlerCalls++;
				},
			},
		);

		await session!.prompt("do not replay an extension-observable empty response");
		await session!.waitForIdle();

		expect(handlerCalls).toBe(1);
		expect(calls).toHaveLength(1);
		expect(session!.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "error" });
	});

	it("does not replay an untyped promoted empty response after a managed context handler participates", async () => {
		const calls: string[] = [];
		let handlerCalls = 0;
		createSession(
			(model, _context, _options) => {
				calls.push(selector(model));
				return zeroTokenEmptyStopStream(model, false);
			},
			3,
			{
				handler: "context",
				onHandler: () => {
					handlerCalls++;
				},
			},
		);

		await session!.prompt("do not replay an untyped extension-observable empty response");
		await session!.waitForIdle();

		expect(handlerCalls).toBe(1);
		expect(calls).toHaveLength(1);
		expect(session!.messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "error",
			errorKind: "local_empty_response",
		});
	});

	it("does not replay a promoted untyped empty stop after message_end emits a custom message", async () => {
		let providerCalls = 0;
		let messageEndCalls = 0;
		createSession(
			model => {
				providerCalls++;
				return zeroTokenEmptyStopStream(model, false);
			},
			3,
			{
				handler: "message_end",
				onHandler: async () => {
					messageEndCalls++;
					if (messageEndCalls > 1) return;
					await session!.sendCustomMessage({
						customType: "empty-response-hook",
						content: "observed empty response",
						display: true,
					});
				},
			},
		);
		const events: AgentSessionEvent[] = [];
		session!.subscribe(event => events.push(event));

		await session!.prompt("do not repeat the executed message_end hook");
		await session!.waitForIdle();

		expect(messageEndCalls).toBeGreaterThan(0);
		expect(providerCalls).toBe(1);
		expect(events.filter(event => event.type === "auto_retry_start")).toHaveLength(0);
		expect(events.filter(event => event.type === "model_fallback_switched")).toHaveLength(0);
		const terminal = session!.messages.findLast(message => message.role === "assistant");
		expect(terminal).toMatchObject({ stopReason: "error" });
		if (terminal?.role !== "assistant") throw new Error("Expected terminal assistant message");
		expect(terminal.transportFailure).toBeUndefined();
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
		// PR #3257 clears managed ownership before terminal observers run, so a
		// subscriber abort at message_end no longer sees a live logical-run owner
		// and must not issue a second requestRunTerminal(cancelled). Exhausted
		// completion remains the sole terminalization.
		expect(terminalSpy).toHaveBeenCalledTimes(1);
		expect(terminalSpy.mock.calls[0]).toEqual([
			terminalSpy.mock.calls[0]![0],
			expect.objectContaining({ stopReason: "exhausted" }),
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
	it("admits a clean managed timeout successor after a committed tool attempt", async () => {
		const toolCall: ToolCall = { type: "toolCall", id: "counted-tool", name: "counted", arguments: {} };
		const tool: AgentTool = {
			name: "counted",
			label: "Counted",
			description: "Records a committed tool attempt",
			parameters: z.object({}),
			execute: async () => ({ content: [{ type: "text", text: "counted" }] }),
		};
		const calls: string[] = [];
		let streamCalls = 0;
		const { agent, primary, fallback } = createSession(
			(model, context, options) => {
				calls.push(selector(model));
				streamCalls++;
				if (streamCalls === 1) {
					const stream = new AssistantMessageEventStream();
					queueMicrotask(() => {
						const message: AssistantMessage = {
							role: "assistant",
							content: [toolCall],
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
							stopReason: "toolUse",
							timestamp: Date.now(),
						};
						stream.push({ type: "start", partial: message });
						stream.push({ type: "done", reason: "toolUse", message });
					});
					return stream;
				}
				if (streamCalls === 2) return typedFirstEventTimeoutStream(model);
				return createMockModel({ responses: [{ content: ["fallback accepted"] }] }).stream(model, context, options);
			},
			1,
			{ tools: [tool] },
		);
		const continueSpy = vi.spyOn(agent, "continue");
		const scopes: Array<{ attemptId: string; generation: number }> = [];
		agent.subscribe(event => {
			const scope = (event as { scope?: { attemptId: string; generation: number } }).scope;
			if (scope) scopes.push(scope);
		});
		const events: AgentSessionEvent[] = [];
		session!.subscribe(event => events.push(event));

		await session!.prompt("commit tool then admit clean managed timeout successor");
		await session!.waitForIdle();

		expect(calls).toEqual([selector(primary), selector(primary), selector(fallback)]);
		const scopeGenerations = [
			...new Map(scopes.map(scope => [`${scope.attemptId}:${scope.generation}`, scope])).values(),
		];
		expect(scopeGenerations).toHaveLength(2);
		expect(scopeGenerations[1]!.generation).toBeGreaterThan(scopeGenerations[0]!.generation);
		expect(continueSpy).toHaveBeenCalledTimes(1);
		expect(events.filter(event => event.type === "agent_end")).toHaveLength(1);
		expect(session!.messages.filter(message => message.role === "assistant")).toHaveLength(2);
		expect(session!.messages.filter(message => message.role === "toolResult")).toHaveLength(1);
		expect(session!.messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "fallback accepted" }],
		});
	});
	it("admits a clean typed overload successor after a committed tool attempt", async () => {
		const toolCall: ToolCall = { type: "toolCall", id: "overload-tool", name: "counted", arguments: {} };
		const tool: AgentTool = {
			name: "counted",
			label: "Counted",
			description: "Records a committed tool attempt",
			parameters: z.object({}),
			execute: async () => ({ content: [{ type: "text", text: "counted" }] }),
		};
		let streamCalls = 0;
		createSession(
			(model, context, options) => {
				streamCalls++;
				if (streamCalls === 1) return toolUseStream(model, toolCall);
				if (streamCalls === 2) return typedStatuslessOverloadStream(model);
				return createMockModel({ responses: [{ content: ["overload recovered"] }] }).stream(
					model,
					context,
					options,
				);
			},
			1,
			{ tools: [tool] },
		);

		await session!.prompt("commit tool then admit clean typed overload successor");
		await session!.waitForIdle();

		expect(streamCalls).toBe(3);
		expect(session!.messages.filter(message => message.role === "toolResult")).toHaveLength(1);
		expect(session!.messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "overload recovered" }],
		});
	});
	it("commits observable typed statusless overload output without replaying or re-running context hooks", async () => {
		let streamCalls = 0;
		let handlerCalls = 0;
		const { primary } = createSession(
			model => {
				streamCalls++;
				return typedStatuslessOverloadWithTextStream(model);
			},
			1,
			{
				handler: "context",
				onHandler: () => {
					handlerCalls++;
				},
			},
		);
		const events: AgentSessionEvent[] = [];
		session!.subscribe(event => events.push(event));

		await session!.prompt("commit observable typed overload output");
		await session!.waitForIdle();

		expect(streamCalls).toBe(1);
		expect(handlerCalls).toBe(1);
		expect(events.filter(event => event.type === "model_fallback_switched")).toHaveLength(0);
		expect(events.filter(event => event.type === "auto_retry_start")).toHaveLength(0);
		expect(session!.model).toEqual(primary);
		expect(session!.messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "error",
			content: [{ type: "text", text: "already streamed" }],
		});
	});

	it("rejects a context-handler execution in a managed timeout successor without publishing duplicate content", async () => {
		const toolCall: ToolCall = { type: "toolCall", id: "prior-tool", name: "counted", arguments: {} };
		const tool: AgentTool = {
			name: "counted",
			label: "Counted",
			description: "Commits a predecessor attempt",
			parameters: z.object({}),
			execute: async () => ({ content: [{ type: "text", text: "counted" }] }),
		};
		const calls: string[] = [];
		let streamCalls = 0;
		const { primary } = createSession(
			model => {
				calls.push(selector(model));
				return ++streamCalls === 1 ? toolUseStream(model, toolCall) : typedFirstEventTimeoutStream(model);
			},
			1,
			{ tools: [tool], handler: "context" },
		);
		const events: AgentSessionEvent[] = [];
		session!.subscribe(event => events.push(event));

		await session!.prompt("reject extension-executed managed timeout successor");
		await session!.waitForIdle();

		expect(calls).toEqual([selector(primary), selector(primary)]);
		expect(events.filter(event => event.type === "agent_end")).toHaveLength(1);
		expect(session!.messages.filter(message => message.role === "assistant")).toHaveLength(2);
		expect(session!.messages.filter(message => message.role === "toolResult")).toHaveLength(1);
		expect(session!.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "error" });
	});
	it("rejects a same-scope message_end handler before direct retry admission", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled test model");
		const sessionManager = SessionManager.inMemory();
		const modelRegistry = new ModelRegistry(authStorage);
		let messageEndHandlers = 0;
		const extensionRunner = extensionRunnerForHandler(
			tempDir.path(),
			sessionManager,
			modelRegistry,
			"message_end",
			() => {
				messageEndHandlers++;
			},
		);
		let calls = 0;
		const agent = new Agent({
			getApiKey: provider => `${provider}-key`,
			initialState: { model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: requestedModel => {
				calls++;
				return typedFirstEventTimeoutStream(requestedModel);
			},
		});
		const settings = Settings.isolated({ "compaction.enabled": false });
		settings.setModelRole("default", selector(model));
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry, extensionRunner });
		const events: AgentSessionEvent[] = [];
		session.subscribe(event => events.push(event));

		await session.prompt("message_end vetoes its own typed timeout");
		await session.waitForIdle();

		expect(calls).toBe(1);
		expect(messageEndHandlers).toBeGreaterThan(0);
		expect(events.filter(event => event.type === "agent_end")).toHaveLength(1);
		expect(session.messages).toHaveLength(2);
		expect(session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "error" });
	});
	it("surfaces a typed local snapshot failure without a same-model retry", async () => {
		let calls = 0;
		createSession(model => {
			calls += 1;
			return collapsedSnapshotStream(model);
		});
		const events: AgentSessionEvent[] = [];
		session!.subscribe(event => events.push(event));

		await withTimeout(session!.prompt("trigger the local snapshot failure"), "prompt");
		await withTimeout(session!.waitForIdle(), "waitForIdle");

		expect(calls).toBe(1);
		expect(session!.isRetrying).toBe(false);
		expect(events.filter(event => event.type === "auto_retry_start")).toHaveLength(0);
		// A local machinery failure must never advance the provider fallback chain.
		expect(events.filter(event => event.type === "model_fallback_switched")).toHaveLength(0);
		expect(session!.messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "error",
			errorKind: "local_snapshot_failure",
			errorMessage: "Agent run failed.",
		});
	});
	it("honors retry.enabled=false for local snapshot failures on a managed chain", async () => {
		let calls = 0;
		createSession(
			model => {
				calls += 1;
				return collapsedSnapshotStream(model);
			},
			3,
			{ settings: { "retry.enabled": false } },
		);
		const events: AgentSessionEvent[] = [];
		session!.subscribe(event => events.push(event));

		await withTimeout(session!.prompt("disabled retry must surface immediately"), "prompt");
		await withTimeout(session!.waitForIdle(), "waitForIdle");

		expect(calls).toBe(1);
		expect(session!.isRetrying).toBe(false);
		expect(events.filter(event => event.type === "auto_retry_start")).toHaveLength(0);
		expect(events.filter(event => event.type === "model_fallback_switched")).toHaveLength(0);
		expect(session!.messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "error",
			errorKind: "local_snapshot_failure",
			errorMessage: "Agent run failed.",
		});
		// The local failure must not leave the provider fallback budget charged.
		expect(session!.getDefaultFallbackRuntimeState().controller).toMatchObject({
			activeIndex: 0,
			attemptsUsed: 0,
			totalAttemptsUsed: 0,
			tried: [],
		});
	});
	it("does not retry a snapshot failure that carries visible content", async () => {
		let calls = 0;
		createSession(model => {
			calls += 1;
			return localErrorEventStream(
				model,
				[{ type: "text", text: "partial output" }],
				"Managed fallback attempt could not produce a serializable event snapshot (local snapshot bug, not a provider failure)",
			);
		});
		const events: AgentSessionEvent[] = [];
		session!.subscribe(event => events.push(event));

		await withTimeout(session!.prompt("content-bearing snapshot failure"), "prompt");
		await withTimeout(session!.waitForIdle(), "waitForIdle");

		expect(calls).toBe(1);
		expect(session!.isRetrying).toBe(false);
		expect(events.filter(event => event.type === "auto_retry_start")).toHaveLength(0);
		expect(session!.messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "error",
			errorMessage: expect.stringContaining("local snapshot bug"),
		});
		expect(session!.getDefaultFallbackRuntimeState().controller).toMatchObject({
			activeIndex: 0,
			attemptsUsed: 0,
			totalAttemptsUsed: 0,
			tried: [],
		});
	});
	it("surfaces a prefix-classified snapshot failure once on a single-model session", async () => {
		let calls = 0;
		createSession(
			model => {
				calls += 1;
				return localErrorEventStream(
					model,
					[],
					"Managed fallback attempt could not produce a serializable event snapshot (local snapshot bug, not a provider failure)",
				);
			},
			3,
			{ singleModelChain: true },
		);
		const events: AgentSessionEvent[] = [];
		session!.subscribe(event => events.push(event));

		await withTimeout(session!.prompt("single-model snapshot failure"), "prompt");
		await withTimeout(session!.waitForIdle(), "waitForIdle");

		expect(calls).toBe(1);
		expect(session!.isRetrying).toBe(false);
		expect(events.filter(event => event.type === "auto_retry_start")).toHaveLength(0);
		expect(events.filter(event => event.type === "model_fallback_switched")).toHaveLength(0);
		expect(session!.messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "error",
			errorMessage: expect.stringContaining("local snapshot bug"),
		});
	});
	it("surfaces one local diagnostic without deterministic snapshot-failure retries", async () => {
		let calls = 0;
		createSession(model => {
			calls += 1;
			return collapsedSnapshotStream(model);
		});
		const events: AgentSessionEvent[] = [];
		session!.subscribe(event => events.push(event));

		await withTimeout(session!.prompt("trigger persistent local snapshot failures"), "prompt");
		await withTimeout(session!.waitForIdle(), "waitForIdle");

		expect(calls).toBe(1);
		expect(session!.isRetrying).toBe(false);
		expect(events.filter(event => event.type === "auto_retry_start")).toHaveLength(0);
		expect(events.filter(event => event.type === "model_fallback_switched")).toHaveLength(0);
		expect(session!.messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "error",
			errorKind: "local_snapshot_failure",
			errorMessage: "Agent run failed.",
		});
		// The one local failure must discharge its provisional provider charge.
		expect(session!.getDefaultFallbackRuntimeState().controller).toMatchObject({
			activeIndex: 0,
			attemptsUsed: 0,
			totalAttemptsUsed: 0,
			tried: [],
		});
	});
	it("surfaces a typed buffer overflow immediately without retry or provider fallback", async () => {
		let calls = 0;
		createSession((model, context, options) => {
			calls += 1;
			if (calls === 1) return oversizedEventStream(model);
			return createMockModel({ responses: [{ content: ["healthy after overflow"] }] }).stream(
				model,
				context,
				options,
			);
		});
		const events: AgentSessionEvent[] = [];
		session!.subscribe(event => events.push(event));

		await withTimeout(session!.prompt("trigger the buffer overflow"), "prompt");
		await withTimeout(session!.waitForIdle(), "waitForIdle");

		expect(calls).toBe(1);
		expect(session!.isRetrying).toBe(false);
		expect(events.filter(event => event.type === "auto_retry_start")).toHaveLength(0);
		expect(events.filter(event => event.type === "model_fallback_switched")).toHaveLength(0);
		expect(session!.messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "error",
			errorKind: "local_buffer_overflow",
			errorMessage: "Agent run failed.",
			bufferOverflow: {
				stage: "overflow.preMeasure",
				exceeded: "bytes",
			},
		});
		// A local staging failure must not leave the provider fallback budget charged.
		expect(session!.getDefaultFallbackRuntimeState().controller).toMatchObject({
			activeIndex: 0,
			attemptsUsed: 0,
			totalAttemptsUsed: 0,
			tried: [],
		});

		await withTimeout(session!.prompt("fresh prompt after overflow"), "prompt");
		await withTimeout(session!.waitForIdle(), "waitForIdle");

		expect(calls).toBe(2);
		expect(session!.messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "healthy after overflow" }],
		});
	});
	it("surfaces a prefix-classified buffer overflow without retry", async () => {
		let calls = 0;
		createSession(model => {
			calls += 1;
			return localErrorEventStream(
				model,
				[],
				"Managed fallback attempt exceeded the provisional event buffer limit",
			);
		});
		const events: AgentSessionEvent[] = [];
		session!.subscribe(event => events.push(event));

		await withTimeout(session!.prompt("prefix-classified buffer overflow"), "prompt");
		await withTimeout(session!.waitForIdle(), "waitForIdle");

		expect(calls).toBe(1);
		expect(session!.isRetrying).toBe(false);
		expect(events.filter(event => event.type === "auto_retry_start")).toHaveLength(0);
		expect(events.filter(event => event.type === "model_fallback_switched")).toHaveLength(0);
		expect(session!.messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "error",
			errorMessage: expect.stringContaining("provisional event buffer limit"),
		});
		expect(session!.getDefaultFallbackRuntimeState().controller).toMatchObject({
			activeIndex: 0,
			attemptsUsed: 0,
			totalAttemptsUsed: 0,
			tried: [],
		});
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
