import { afterEach, describe, expect, it, type Mock, vi } from "bun:test";
import { Agent, type AgentMessage } from "@gajae-code/agent-core";
import {
	type AssistantMessage,
	type Context,
	type CustomStreamSimpleFn,
	type Message,
	registerCustomApi,
	type SimpleStreamOptions,
	type UserMessage,
	unregisterCustomApis,
} from "@gajae-code/ai";
import { createMockModel, type MockModel, registerMockApi } from "@gajae-code/ai/providers/mock";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { BTW_STREAM_IDLE_TIMEOUT_MS } from "@gajae-code/coding-agent/session/btw-contract";
import { convertToLlm } from "@gajae-code/coding-agent/session/messages";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";

registerMockApi();
const CONTROLLED_BTW_API = "controlled-btw-test";
const CONTROLLED_BTW_SOURCE = "agent-session-btw-test";

interface ControlledStreamCall {
	stream: AssistantMessageEventStream;
	message: AssistantMessage;
	options: SimpleStreamOptions | undefined;
}

function createControlledStreamModel(): {
	model: MockModel;
	mainStarted: Promise<ControlledStreamCall>;
	sideStarted: Promise<ControlledStreamCall>;
} {
	const model = createMockModel();
	const mainStarted = Promise.withResolvers<ControlledStreamCall>();
	const sideStarted = Promise.withResolvers<ControlledStreamCall>();
	const streamFn: CustomStreamSimpleFn = (_model, context: Context, options?: SimpleStreamOptions) => {
		model.calls.push({ context, options });
		const stream = new AssistantMessageEventStream();
		const message: AssistantMessage = {
			role: "assistant",
			content: [],
			api: CONTROLLED_BTW_API,
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
		const call = { stream, message, options };
		stream.push({ type: "start", partial: message });
		if (options?.sessionId?.includes(":btw:")) sideStarted.resolve(call);
		else mainStarted.resolve(call);
		options?.signal?.addEventListener(
			"abort",
			() => {
				message.stopReason = "aborted";
				stream.push({
					type: "error",
					reason: "aborted",
					error: { ...message, errorMessage: "Controlled stream aborted" },
				});
			},
			{ once: true },
		);
		return stream;
	};

	Object.defineProperty(model, "api", { value: CONTROLLED_BTW_API });
	model.stream = streamFn;
	registerCustomApi(CONTROLLED_BTW_API, streamFn, CONTROLLED_BTW_SOURCE);
	return { model, mainStarted: mainStarted.promise, sideStarted: sideStarted.promise };
}

function emitControlledText(call: ControlledStreamCall, text: string): void {
	call.message.content.push({ type: "text", text });
	call.stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: call.message });
}

function finishControlledStream(call: ControlledStreamCall): void {
	call.stream.push({ type: "done", reason: "stop", message: call.message });
}

function completeControlledStream(call: ControlledStreamCall, text: string): void {
	emitControlledText(call, text);
	finishControlledStream(call);
}
async function drainSyntheticStart(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

const sessions: AgentSession[] = [];

afterEach(async () => {
	vi.useRealTimers();
	unregisterCustomApis(CONTROLLED_BTW_SOURCE);
	for (const session of sessions.splice(0)) await session.dispose();
});

interface HarnessOptions {
	model?: MockModel;
	getApiKey?: () => Promise<string>;
	convert?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<Message[]>;
	onPayload?: () => void;
	onResponse?: () => void;
	onSseEvent?: () => void;
	providerSessionId?: string;
	providerCacheSessionId?: string;
}

function userMessage(text: string): UserMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

function createHarness(options: HarnessOptions = {}): {
	session: AgentSession;
	model: MockModel;
	committed: UserMessage;
	live: AgentMessage;
	getApiKey: Mock<(model: unknown, sessionId: string) => Promise<string>>;
	sessionManager: SessionManager;
} {
	const model = options.model ?? createMockModel({ handler: () => ({ content: ["side answer"] }) });
	const committed = userMessage("committed current user");
	const live: AgentMessage = {
		role: "assistant",
		content: [{ type: "text", text: "uncommitted live assistant" }],
		api: "mock",
		provider: "mock",
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
	const sessionManager = SessionManager.inMemory();
	sessionManager.appendMessage(committed);
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["system"], messages: [committed, live], tools: [] },
		streamFn: model.stream,
		convertToLlm,
	});
	const getApiKey = vi.fn(async (_model: unknown, _sessionId: string) =>
		options.getApiKey ? options.getApiKey() : "test-key",
	);
	const session = new AgentSession({
		agent,
		sessionManager,
		settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": true }),
		modelRegistry: { getApiKey, getAvailable: () => [model] } as never,
		convertToLlm: options.convert ?? (async messages => convertToLlm(messages)),
		onPayload: options.onPayload,
		onResponse: options.onResponse,
		onSseEvent: options.onSseEvent,
		providerSessionId: options.providerSessionId,
		providerCacheSessionId: options.providerCacheSessionId,
	});
	sessions.push(session);
	return { session, model, committed, live, getApiKey, sessionManager };
}

async function drainToProvider(model: MockModel, callCount = 1): Promise<void> {
	for (let i = 0; i < 10 && model.calls.length < callCount; i++) await Promise.resolve();
}

describe("AgentSession /btw isolation", () => {
	it("clones committed context synchronously and sends isolated provider options", async () => {
		const onPayload = vi.fn();
		const onResponse = vi.fn();
		const onSseEvent = vi.fn();
		let providerContext: Context | undefined;
		const model = createMockModel({
			handler: context => {
				providerContext = structuredClone(context);
				return { content: ["answer"], responseHeaders: { "x-request-id": "side" } };
			},
		});
		const harness = createHarness({ model, onPayload, onResponse, onSseEvent });
		const mainMessagesBefore = structuredClone(harness.session.agent.state.messages);
		const providerStateBefore = harness.session.providerSessionState;
		harness.sessionManager.appendMessage({
			role: "custom",
			customType: "private-custom",
			content: "PRIVATE_CUSTOM_SENTINEL",
			display: true,
			timestamp: 1,
		});
		harness.sessionManager.appendMessage({
			...(harness.live as AssistantMessage),
			content: [
				{ type: "thinking", thinking: "PRIVATE_THINKING_SENTINEL" },
				{ type: "text", text: "visible assistant text" },
				{ type: "toolCall", id: "private-tool", name: "read", arguments: { secret: "PRIVATE_TOOL_SENTINEL" } },
			],
			providerPayload: { private: "PRIVATE_PROVIDER_SENTINEL" } as never,
		});
		const committedEntriesBefore = structuredClone(harness.sessionManager.getEntries());

		const turn = harness.session.runEphemeralTurn({
			purpose: "btw",
			turn: {
				question: "virtual btw prompt",
				scope: harness.session.createBtwConversationScope("btw test instruction"),
			},
		});
		(harness.committed.content[0] as { type: "text"; text: string }).text = "mutated after invocation";
		await turn;

		expect(model.calls).toHaveLength(1);
		const call = model.calls[0];
		const payload = JSON.stringify(providerContext?.messages);
		expect(payload).toContain("committed current user");
		expect(payload).toContain("virtual btw prompt");
		expect(payload).not.toContain("mutated after invocation");
		(harness.committed.content[0] as { type: "text"; text: string }).text = "committed current user";
		expect(payload).not.toContain("uncommitted live assistant");
		expect(payload).toContain("visible assistant text");
		expect(payload).not.toContain("PRIVATE_CUSTOM_SENTINEL");
		expect(payload).not.toContain("PRIVATE_THINKING_SENTINEL");
		expect(payload).not.toContain("PRIVATE_TOOL_SENTINEL");
		expect(payload).not.toContain("PRIVATE_PROVIDER_SENTINEL");
		expect(call?.context.tools).toEqual([]);
		expect(call?.options?.toolChoice).toBe("none");
		expect(call?.options?.requestMaxRetries).toBe(0);
		expect(call?.options?.streamMaxRetries).toBe(0);
		expect(call?.options?.streamFirstEventTimeoutMs).toBe(0);
		expect(harness.getApiKey.mock.calls[0]?.[1]).toBe(
			harness.session.agent.providerSessionId ?? harness.session.agent.sessionId ?? harness.session.sessionId,
		);
		expect(call?.options?.sessionId).toContain(":btw:");
		expect(call?.options?.sessionId).not.toBe(harness.session.sessionId);
		expect(call?.options?.metadata).toBeUndefined();
		expect(call?.options?.onPayload).toBeUndefined();
		expect(call?.options?.onResponse).toBeUndefined();
		expect(call?.options?.onSseEvent).toBeUndefined();
		expect(onPayload).not.toHaveBeenCalled();
		expect(onResponse).not.toHaveBeenCalled();
		expect(onSseEvent).not.toHaveBeenCalled();
		expect(harness.session.rawSseDebugBuffer.snapshot().totalEvents).toBe(0);
		expect(harness.sessionManager.getEntries()).toEqual(committedEntriesBefore);
		expect(harness.session.agent.state.messages).toEqual(mainMessagesBefore);
		// Option A creates no request-local provider map, so cleanup cases are inapplicable until Option B;
		// the evidence-backed invariant is that the main map remains reference-identical and untouched.
		expect(harness.session.providerSessionState).toBe(providerStateBefore);
		expect(harness.session.providerSessionState.size).toBe(0);
	});

	it("keeps the synchronously captured system prompt across credential delay", async () => {
		const key = Promise.withResolvers<string>();
		const harness = createHarness({ getApiKey: () => key.promise });

		const turn = harness.session.runEphemeralTurn({
			purpose: "btw",
			turn: {
				question: "snapshot prompt",
				scope: harness.session.createBtwConversationScope("btw test instruction"),
			},
		});
		harness.session.agent.setSystemPrompt(["mutated system"]);
		key.resolve("test-key");
		await turn;

		expect(harness.model.calls[0]?.context.systemPrompt).toEqual(["system", "btw test instruction"]);
	});

	it("keeps the model and provider generation frozen for the open side-chat scope", async () => {
		const original = createMockModel({ id: "scope-model", handler: () => ({ content: ["scope answer"] }) });
		const replacement = createMockModel({ id: "replacement-model", handler: () => ({ content: ["wrong answer"] }) });
		const harness = createHarness({ model: original });
		const scope = harness.session.createBtwConversationScope("btw test instruction");
		harness.session.agent.setModel(replacement);

		await harness.session.runEphemeralTurn({ purpose: "btw", turn: { question: "frozen", scope } });

		expect(original.calls).toHaveLength(1);
		expect(replacement.calls).toHaveLength(0);
	});

	it("uses the main provider cache identity for credentials and account metadata", async () => {
		const harness = createHarness({
			providerSessionId: "logical-provider-session",
			providerCacheSessionId: "main-cache-affinity",
		});

		await harness.session.runEphemeralTurn({
			purpose: "btw",
			turn: {
				question: "affinity check",
				scope: harness.session.createBtwConversationScope("btw test instruction"),
			},
		});

		expect(harness.getApiKey.mock.calls[0]?.[1]).toBe("main-cache-affinity");
		expect(harness.model.calls[0]?.options?.metadata).toBeUndefined();
		expect(harness.model.calls[0]?.options?.sessionId).toStartWith("main-cache-affinity:btw:");
	});

	it("reaches a unique side provider event while the main provider request remains active and unchanged", async () => {
		const mainRelease = Promise.withResolvers<void>();
		const mainStarted = Promise.withResolvers<AbortSignal | undefined>();
		const sideFirstEvent = Promise.withResolvers<string>();
		const model = createMockModel({
			handler: async (_context, options) => {
				if (options?.sessionId?.includes(":btw:")) return { content: ["side while main runs"] };
				mainStarted.resolve(options?.signal);
				await mainRelease.promise;
				return { content: ["main complete"] };
			},
		});
		const harness = createHarness({ model });
		const providerStateBefore = harness.session.providerSessionState;
		const mainTurn = harness.session.prompt("main request");
		const mainSignal = await mainStarted.promise;
		const mainMessagesBefore = structuredClone(harness.session.agent.state.messages);
		const committedEntriesBefore = structuredClone(harness.sessionManager.getEntries());

		try {
			const sideTurn = harness.session.runEphemeralTurn({
				purpose: "btw",
				turn: {
					question: "side request",
					scope: harness.session.createBtwConversationScope("btw test instruction"),
				},
				onTextDelta: delta => sideFirstEvent.resolve(delta),
			});

			expect(await sideFirstEvent.promise).toBe("side while main runs");
			const mainCall = model.calls.find(call => !call.options?.sessionId?.includes(":btw:"));
			const sideCall = model.calls.find(call => call.options?.sessionId?.includes(":btw:"));
			expect(model.calls).toHaveLength(2);
			expect(mainSignal).toBeInstanceOf(AbortSignal);
			expect(mainCall?.options?.sessionId).toBe(harness.session.sessionId);
			expect(mainCall?.options?.signal).toBe(mainSignal);
			expect(mainSignal?.aborted).toBe(false);
			expect(sideCall?.options?.signal?.aborted).toBe(false);
			expect(sideCall?.options?.sessionId).not.toBe(mainCall?.options?.sessionId);
			expect(sideCall?.options?.sessionId).toContain(":btw:");
			await sideTurn;

			expect(mainSignal?.aborted).toBe(false);
			expect(harness.sessionManager.getEntries()).toEqual(committedEntriesBefore);
			expect(harness.session.agent.state.messages).toEqual(mainMessagesBefore);
			expect(harness.session.providerSessionState).toBe(providerStateBefore);
			expect(harness.session.providerSessionState.size).toBe(0);
		} finally {
			mainRelease.resolve();
			await mainTurn;
		}
	});

	it("does not retry or schedule provider retry delay for a retryable side error", async () => {
		const model = createMockModel({
			handler: () => ({ throw: "503 service unavailable: overloaded_error retry-after-ms=5000" }),
		});
		const harness = createHarness({ model });

		await expect(
			harness.session.runEphemeralTurn({
				purpose: "btw",
				turn: { question: "fail once", scope: harness.session.createBtwConversationScope("btw test instruction") },
			}),
		).rejects.toThrow("503 service unavailable");
		expect(model.calls).toHaveLength(1);
		expect(model.calls[0]?.options?.requestMaxRetries).toBe(0);
		expect(model.calls[0]?.options?.streamMaxRetries).toBe(0);
		expect(model.calls[0]?.options?.streamFirstEventTimeoutMs).toBe(0);
	});

	it("keeps the side idle deadline armed across synthetic start and aborts only the side", async () => {
		const controlled = createControlledStreamModel();
		const harness = createHarness({ model: controlled.model });
		const mainAbort = vi.spyOn(harness.session.agent, "abort");
		const mainTurn = harness.session.prompt("main request");
		const mainCall = await controlled.mainStarted;
		vi.useFakeTimers();
		let mainSettled = false;
		void mainTurn.then(
			() => {
				mainSettled = true;
			},
			() => {
				mainSettled = true;
			},
		);
		const sideTurn = harness.session.runEphemeralTurn({
			purpose: "btw",
			turn: { question: "deadline", scope: harness.session.createBtwConversationScope("btw test instruction") },
		});
		const sideCall = await controlled.sideStarted;
		await drainSyntheticStart();

		try {
			vi.advanceTimersByTime(BTW_STREAM_IDLE_TIMEOUT_MS - 1);
			expect(sideCall.options?.signal?.aborted).toBe(false);
			expect(mainCall.options?.signal?.aborted).toBe(false);
			expect(mainSettled).toBe(false);

			vi.advanceTimersByTime(1);
			expect(sideCall.options?.signal?.aborted).toBe(true);
			await expect(sideTurn).rejects.toThrow("idle for 30 seconds");

			expect(sideCall.options?.signal?.aborted).toBe(true);
			expect(mainCall.options?.signal?.aborted).toBe(false);
			expect(mainSettled).toBe(false);
			expect(mainAbort).not.toHaveBeenCalled();
		} finally {
			if (!sideCall.options?.signal?.aborted) {
				completeControlledStream(sideCall, "late side completion");
				await sideTurn;
			}
			completeControlledStream(mainCall, "main complete");
			await mainTurn;
		}
	});

	it("clears the side deadline on the first non-start provider event", async () => {
		vi.useFakeTimers();
		const controlled = createControlledStreamModel();
		const harness = createHarness({ model: controlled.model });
		const providerProgress = Promise.withResolvers<string>();
		const sideTurn = harness.session.runEphemeralTurn({
			purpose: "btw",
			turn: { question: "established", scope: harness.session.createBtwConversationScope("btw test instruction") },
			onTextDelta: providerProgress.resolve,
		});
		const sideCall = await controlled.sideStarted;

		vi.advanceTimersByTime(14_999);
		emitControlledText(sideCall, "side complete");
		expect(await providerProgress.promise).toBe("side complete");
		vi.advanceTimersByTime(15_001);
		expect(sideCall.options?.signal?.aborted).toBe(false);

		finishControlledStream(sideCall);
		await expect(sideTurn).resolves.toMatchObject({ replyText: "side complete" });
		expect(sideCall.options?.signal?.aborted).toBe(false);
	});

	it("aborts a replaced side request without aborting its replacement or the main agent", async () => {
		const model = createMockModel({
			responses: [{ content: ["stale"], delayMs: 60_000 }, { content: ["replacement"] }],
		});
		const harness = createHarness({ model });
		const providerStateBefore = harness.session.providerSessionState;
		const committedEntriesBefore = structuredClone(harness.sessionManager.getEntries());
		const mainAbort = vi.spyOn(harness.session.agent, "abort");
		const staleController = new AbortController();
		const staleTurn = harness.session.runEphemeralTurn({
			purpose: "btw",
			turn: { question: "stale", scope: harness.session.createBtwConversationScope("btw test instruction") },
			signal: staleController.signal,
		});
		await drainToProvider(model);

		staleController.abort(new Error("replaced"));
		const replacementTurn = harness.session.runEphemeralTurn({
			purpose: "btw",
			turn: { question: "replacement", scope: harness.session.createBtwConversationScope("btw test instruction") },
		});
		await expect(staleTurn).rejects.toThrow();
		await expect(replacementTurn).resolves.toMatchObject({ replyText: "replacement" });

		expect(model.calls).toHaveLength(2);
		expect(model.calls[0]?.options?.signal?.aborted).toBe(true);
		expect(model.calls[1]?.options?.signal?.aborted).toBe(false);
		expect(model.calls[1]?.options?.sessionId).not.toBe(model.calls[0]?.options?.sessionId);
		expect(mainAbort).not.toHaveBeenCalled();
		expect(harness.sessionManager.getEntries()).toEqual(committedEntriesBefore);
		expect(harness.session.providerSessionState).toBe(providerStateBefore);
	});

	it("stops before setup when already cancelled", async () => {
		const harness = createHarness();
		const controller = new AbortController();
		controller.abort(new Error("replaced before setup"));

		await expect(
			harness.session.runEphemeralTurn({
				purpose: "btw",
				turn: { question: "cancelled", scope: harness.session.createBtwConversationScope("btw test instruction") },
				signal: controller.signal,
			}),
		).rejects.toThrow("replaced before setup");
		expect(harness.getApiKey).not.toHaveBeenCalled();
		expect(harness.model.calls).toHaveLength(0);
	});

	it("checks cancellation after credential lookup", async () => {
		const key = Promise.withResolvers<string>();
		const harness = createHarness({ getApiKey: () => key.promise });
		const controller = new AbortController();
		const turn = harness.session.runEphemeralTurn({
			purpose: "btw",
			turn: {
				question: "cancel during credentials",
				scope: harness.session.createBtwConversationScope("btw test instruction"),
			},
			signal: controller.signal,
		});
		controller.abort(new Error("replaced during credentials"));

		await expect(turn).rejects.toThrow("replaced during credentials");
		expect(harness.model.calls).toHaveLength(0);
	});

	it("checks cancellation after message conversion", async () => {
		const conversion = Promise.withResolvers<Message[]>();
		const harness = createHarness({ convert: async () => conversion.promise });
		const controller = new AbortController();
		const turn = harness.session.runEphemeralTurn({
			purpose: "btw",
			turn: { question: "cancelled", scope: harness.session.createBtwConversationScope("btw test instruction") },
			signal: controller.signal,
		});
		await Promise.resolve();
		controller.abort(new Error("replaced during conversion"));
		conversion.resolve([]);

		await expect(turn).rejects.toThrow("replaced during conversion");
		expect(harness.model.calls).toHaveLength(0);
	});
});
