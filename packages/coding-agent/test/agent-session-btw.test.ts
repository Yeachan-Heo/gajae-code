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
const controlledFixtureCleanup: Array<() => void> = [];

interface ControlledStreamCall {
	stream: AssistantMessageEventStream;
	message: AssistantMessage;
	options: SimpleStreamOptions | undefined;
}

function createControlledStreamModel(
	controls: { ignoreAbort?: boolean; onIteratorReturn?: () => Promise<void> } = {},
): {
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
		if (controls.onIteratorReturn) {
			const createIterator = stream[Symbol.asyncIterator].bind(stream);
			stream[Symbol.asyncIterator] = () => {
				const iterator = createIterator();
				return {
					next: () => iterator.next(),
					return: async () => {
						try {
							await controls.onIteratorReturn?.();
						} finally {
							await iterator.return?.();
						}
						return { done: true as const, value: undefined };
					},
				};
			};
		}
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
		controlledFixtureCleanup.push(() => stream.end(message));
		stream.push({ type: "start", partial: message });
		if (options?.sessionId?.includes(":btw:")) sideStarted.resolve(call);
		else mainStarted.resolve(call);
		options?.signal?.addEventListener(
			"abort",
			() => {
				if (controls.ignoreAbort) return;
				message.stopReason = "aborted";
				stream.push({
					type: "error",
					reason: "aborted",
					error: { ...message, errorMessage: "Controlled stream aborted" },
				});
				stream.end(message);
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
	call.stream.end(call.message);
}

function completeControlledStream(call: ControlledStreamCall, text: string): void {
	emitControlledText(call, text);
	finishControlledStream(call);
}
async function drainSyntheticStart(): Promise<void> {
	// Include the queued async-generator yield, abort race, and cleanup reactions.
	for (let i = 0; i < 50; i++) await Promise.resolve();
}

const sessions: AgentSession[] = [];

afterEach(async () => {
	vi.useRealTimers();
	// Release fixture-owned readers/barriers even when an assertion failed before
	// the normal release. Session disposal must join them, not release them for us.
	for (const cleanup of controlledFixtureCleanup.splice(0)) cleanup();
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
	credentialSessionId?: string;
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
		modelRegistry: {
			authStorage: undefined,
			getApiKey,
			getAvailable: () => [model],
			getAuthStorageOwner: () => ({}),
			withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
		} as never,
		convertToLlm: options.convert ?? (async messages => convertToLlm(messages)),
		onPayload: options.onPayload,
		onResponse: options.onResponse,
		onSseEvent: options.onSseEvent,
		providerSessionId: options.providerSessionId,
		providerCacheSessionId: options.providerCacheSessionId,
		credentialSessionId: options.credentialSessionId,
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
		expect(harness.getApiKey.mock.calls[0]?.[1]).toBe(harness.session.credentialSessionId);
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
		controlledFixtureCleanup.push(() => key.resolve("test-key"));
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

	it("uses credential identity independently from the main provider cache identity", async () => {
		const harness = createHarness({
			providerSessionId: "logical-provider-session",
			providerCacheSessionId: "main-cache-affinity",
			credentialSessionId: "credential-pool",
		});

		await harness.session.runEphemeralTurn({
			purpose: "btw",
			turn: {
				question: "affinity check",
				scope: harness.session.createBtwConversationScope("btw test instruction"),
			},
		});

		expect(harness.getApiKey.mock.calls[0]?.[1]).toBe("credential-pool");
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
		controlledFixtureCleanup.push(() => key.resolve("test-key"));
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
		key.resolve("late-key");

		await expect(turn).rejects.toThrow("replaced during credentials");
		expect(harness.model.calls).toHaveLength(0);
	});

	it("rejects foreign and copied scope authority before credential lookup", async () => {
		const issuer = createHarness();
		const other = createHarness();
		const scope = issuer.session.createBtwConversationScope("btw test instruction");

		await expect(
			other.session.runEphemeralTurn({ purpose: "btw", turn: { question: "foreign", scope } }),
		).rejects.toThrow("another session or a retired generation");
		await expect(
			issuer.session.runEphemeralTurn({ purpose: "btw", turn: { question: "copied", scope: { ...scope } } }),
		).rejects.toThrow("another session or a retired generation");
		expect(issuer.getApiKey).not.toHaveBeenCalled();
		expect(other.getApiKey).not.toHaveBeenCalled();
		expect(issuer.model.calls).toHaveLength(0);
		expect(other.model.calls).toHaveLength(0);
	});

	it("rejects scopes from a retired history generation even when session identity is unchanged", async () => {
		const harness = createHarness();
		const scope = harness.session.createBtwConversationScope("btw test instruction");
		const sessionId = harness.session.sessionId;
		await harness.session.clearContext();
		expect(harness.session.sessionId).toBe(sessionId);

		await expect(
			harness.session.runEphemeralTurn({ purpose: "btw", turn: { question: "stale", scope } }),
		).rejects.toThrow("another session or a retired generation");
		expect(harness.getApiKey).not.toHaveBeenCalled();
		await expect(
			harness.session.runEphemeralTurn({
				purpose: "btw",
				turn: { question: "fresh", scope: harness.session.createBtwConversationScope("btw test instruction") },
			}),
		).resolves.toMatchObject({ replyText: "side answer" });
	});

	it("closes side ingress during transitions and disposal", async () => {
		const harness = createHarness();
		const scope = harness.session.createBtwConversationScope("btw test instruction");
		const transition = harness.session.clearContext();
		expect(() => harness.session.createBtwConversationScope("busy")).toThrow("in progress");
		await expect(
			harness.session.runEphemeralTurn({ purpose: "btw", turn: { question: "busy", scope } }),
		).rejects.toMatchObject({ code: "busy" });
		await transition;
		const freshScope = harness.session.createBtwConversationScope("btw test instruction");
		const disposal = harness.session.dispose();
		expect(() => harness.session.createBtwConversationScope("disposed")).toThrow("admission");
		await expect(
			harness.session.runEphemeralTurn({ purpose: "btw", turn: { question: "closed", scope: freshScope } }),
		).rejects.toMatchObject({ code: "busy" });
		await disposal;
		expect(harness.getApiKey).not.toHaveBeenCalled();
		expect(harness.model.calls).toHaveLength(0);
	});

	it("admits before reentrant disposal from credential lookup and joins the real preflight", async () => {
		const key = Promise.withResolvers<string>();
		controlledFixtureCleanup.push(() => key.resolve("test-key"));
		let disposal: Promise<void> | undefined;
		const harness = createHarness({
			getApiKey: () => {
				disposal = harness.session.dispose();
				return key.promise;
			},
		});
		const onTextDelta = vi.fn();
		const turn = harness.session.runEphemeralTurn({
			purpose: "btw",
			turn: {
				question: "dispose in preflight",
				scope: harness.session.createBtwConversationScope("btw test instruction"),
			},
			onTextDelta,
		});
		let disposed = false;
		void disposal?.then(() => {
			disposed = true;
		});
		await drainSyntheticStart();
		expect(disposal).toBeDefined();
		expect(disposed).toBe(false);
		expect(harness.model.calls).toHaveLength(0);

		key.resolve("late-key");
		await expect(turn).rejects.toThrow();
		await disposal;
		expect(disposed).toBe(true);
		expect(harness.model.calls).toHaveLength(0);
		expect(onTextDelta).not.toHaveBeenCalled();
	});

	it("retires and joins credential preflight without starting a late provider", async () => {
		const key = Promise.withResolvers<string>();
		controlledFixtureCleanup.push(() => key.resolve("test-key"));
		const harness = createHarness({ getApiKey: () => key.promise });
		const onTextDelta = vi.fn();
		const turn = harness.session.runEphemeralTurn({
			purpose: "btw",
			turn: {
				question: "retire in preflight",
				scope: harness.session.createBtwConversationScope("btw test instruction"),
			},
			onTextDelta,
		});
		const transition = harness.session.clearContext();
		let retired = false;
		void transition.then(() => {
			retired = true;
		});
		await drainSyntheticStart();
		expect(retired).toBe(false);
		key.resolve("late-key");
		await expect(turn).rejects.toThrow("retired");
		await transition;
		expect(retired).toBe(true);
		expect(harness.model.calls).toHaveLength(0);
		expect(onTextDelta).not.toHaveBeenCalled();
	});

	it("fences active side callbacks at retirement before joining an abort-ignoring provider", async () => {
		const controlled = createControlledStreamModel({ ignoreAbort: true });
		const harness = createHarness({ model: controlled.model });
		const onTextDelta = vi.fn();
		const turn = harness.session.runEphemeralTurn({
			purpose: "btw",
			turn: {
				question: "retire active stream",
				scope: harness.session.createBtwConversationScope("btw test instruction"),
			},
			onTextDelta,
		});
		const rejected = turn.then(
			() => {
				throw new Error("Retired side turn unexpectedly completed");
			},
			error => {
				expect(error).toBeInstanceOf(Error);
				expect(error.message).toContain("retired");
			},
		);
		void rejected.catch(() => {});
		const call = await controlled.sideStarted;
		await drainSyntheticStart();
		const transition = harness.session.clearContext();
		try {
			expect(call.options?.signal?.aborted).toBe(true);
			// Release provider work independently of iterator cleanup. Waiting for
			// cleanup before this release would make the fixture own a deadlock.
			completeControlledStream(call, "late retired bytes");
			await rejected;
			await transition;
		} finally {
			call.stream.end(call.message);
			await Promise.allSettled([turn, transition]);
		}
		expect(onTextDelta).not.toHaveBeenCalled();
		expect(JSON.stringify(harness.sessionManager.getEntries())).not.toContain("late retired bytes");
	});

	for (const transitionKind of ["clear", "tree"] as const) {
		for (const cleanupOutcome of ["deadline", "rejection"] as const) {
			it(`preserves the predecessor on ${transitionKind} when BTW cleanup reaches ${cleanupOutcome}`, async () => {
				const release = Promise.withResolvers<void>();
				controlledFixtureCleanup.push(() => release.resolve());
				const onIteratorReturn = vi.fn(async () => {
					await release.promise;
					if (cleanupOutcome === "rejection") throw new Error("precommit iterator cleanup failed");
				});
				const controlled = createControlledStreamModel({
					ignoreAbort: cleanupOutcome === "deadline",
					onIteratorReturn,
				});
				const harness = createHarness({ model: controlled.model });
				const targetId = harness.sessionManager.getLeafId()!;
				harness.sessionManager.appendMessage(userMessage("predecessor leaf"));
				const sessionId = harness.session.sessionId;
				const sessionFile = harness.session.sessionFile;
				const agentSessionId = harness.session.agent.sessionId;
				const leafId = harness.sessionManager.getLeafId();
				const entries = structuredClone(harness.sessionManager.getEntries());
				const messages = structuredClone(harness.session.agent.state.messages);
				const providerState = harness.session.providerSessionState;
				const scope = harness.session.createBtwConversationScope("btw test instruction");
				const onTextDelta = vi.fn();
				const listener = vi.fn();
				const unsubscribe = harness.session.subscribe(listener);
				const turn = harness.session.runEphemeralTurn({
					purpose: "btw",
					turn: { question: "hold precommit cleanup", scope },
					onTextDelta,
				});
				const turnRejected = turn.then(
					() => {
						throw new Error("BTW turn completed despite incomplete cleanup");
					},
					error => {
						expect(error).toMatchObject({ code: "unknown_effect" });
					},
				);
				void turnRejected.catch(() => {});
				const call = await controlled.sideStarted;
				let transition: Promise<unknown> | undefined;
				try {
					await drainSyntheticStart();
					vi.useFakeTimers();
					transition =
						transitionKind === "clear" ? harness.session.clearContext() : harness.session.navigateTree(targetId);
					let transitionSettled = false;
					void transition.then(
						() => {
							transitionSettled = true;
						},
						() => {
							transitionSettled = true;
						},
					);
					const transitionRejected = transition.then(
						() => {
							throw new Error("History transition completed despite incomplete cleanup");
						},
						error => {
							expect(error).toMatchObject({ code: "unknown_effect" });
						},
					);
					void transitionRejected.catch(() => {});
					expect(call.options?.signal?.aborted).toBe(true);
					await drainSyntheticStart();
					expect(onIteratorReturn).toHaveBeenCalledTimes(1);
					expect(transitionSettled).toBe(false);
					expect(harness.sessionManager.getLeafId()).toBe(leafId);
					expect(harness.session.agent.state.messages).toEqual(messages);
					if (cleanupOutcome === "deadline") vi.advanceTimersByTime(5_000);
					else release.resolve();
					await transitionRejected;
					await turnRejected;

					expect(harness.session.sessionManager).toBe(harness.sessionManager);
					expect(harness.session.sessionId).toBe(sessionId);
					expect(harness.session.sessionFile).toBe(sessionFile);
					expect(harness.session.agent.sessionId).toBe(agentSessionId);
					expect(harness.sessionManager.getLeafId()).toBe(leafId);
					expect(harness.sessionManager.getEntries()).toEqual(entries);
					expect(harness.session.agent.state.messages).toEqual(messages);
					expect(harness.session.providerSessionState).toBe(providerState);
					// A failed precommit released admission without retiring valid scopes.
					expect(harness.session.createBtwConversationScope("lease released").messages).toEqual(scope.messages);
					harness.getApiKey.mockImplementationOnce(async () => {
						throw new Error("existing scope reached credentials");
					});
					await expect(
						harness.session.runEphemeralTurn({
							purpose: "btw",
							turn: { question: "existing scope", scope },
						}),
					).rejects.toThrow("existing scope reached credentials");
					// Exercise the restored public event bridge without opening another provider.
					const event = { type: "message_start" as const, message: userMessage("predecessor bridge probe") };
					harness.session.agent.emitExternalEvent(event);
					await drainSyntheticStart();
					expect(listener).toHaveBeenCalledWith(event);
					if (cleanupOutcome === "deadline") {
						let idle = false;
						const idleWait = harness.session.waitForIdle().then(() => {
							idle = true;
						});
						void idleWait.catch(() => {});
						await drainSyntheticStart();
						expect(idle).toBe(false);
						release.resolve();
						completeControlledStream(call, "late precommit bytes");
						await idleWait;
						expect(idle).toBe(true);
					} else {
						await expect(harness.session.waitForIdle()).rejects.toMatchObject({ code: "unknown_effect" });
					}
					expect(onTextDelta).not.toHaveBeenCalled();
					expect(harness.sessionManager.getLeafId()).toBe(leafId);
					expect(harness.sessionManager.getEntries()).toEqual(entries);
					expect(harness.session.agent.state.messages).toEqual(messages);
				} finally {
					release.resolve();
					call.stream.end(call.message);
					await Promise.allSettled([turn, transition]);
					unsubscribe();
					vi.useRealTimers();
					sessions.splice(sessions.indexOf(harness.session), 1);
					await Promise.allSettled([harness.session.dispose(), harness.session.awaitDisposeCompletion()]);
				}
			});
		}
	}

	it("preserves the generated handoff document and cleanup error authority before predecessor mutation", async () => {
		const release = Promise.withResolvers<void>();
		controlledFixtureCleanup.push(() => release.resolve());
		const cleanupFailure = new Error("handoff iterator cleanup refused");
		const onIteratorReturn = vi.fn(async () => {
			await release.promise;
			throw cleanupFailure;
		});
		const controlled = createControlledStreamModel({ onIteratorReturn });
		const harness = createHarness({ model: controlled.model });
		harness.sessionManager.appendMessage(userMessage("second committed handoff input"));
		const sessionId = harness.session.sessionId;
		const sessionFile = harness.session.sessionFile;
		const agentSessionId = harness.session.agent.sessionId;
		const leafId = harness.sessionManager.getLeafId();
		const entries = structuredClone(harness.sessionManager.getEntries());
		const messages = structuredClone(harness.session.agent.state.messages);
		const providerState = harness.session.providerSessionState;
		const turn = harness.session.runEphemeralTurn({
			purpose: "btw",
			turn: {
				question: "hold handoff retirement",
				scope: harness.session.createBtwConversationScope("btw test instruction"),
			},
		});
		const turnFailure = turn.then(
			() => {
				throw new Error("BTW turn completed despite refused cleanup");
			},
			(error: unknown) => error,
		);
		void turnFailure.catch(() => {});
		const sideCall = await controlled.sideStarted;
		let handoff: Promise<unknown> | undefined;
		let handoffFailure: Promise<unknown> | undefined;
		let generatedCall: ControlledStreamCall | undefined;
		try {
			await drainSyntheticStart();
			handoff = harness.session.handoff();
			handoffFailure = handoff.then(
				() => {
					throw new Error("Handoff committed despite refused cleanup");
				},
				(error: unknown) => error,
			);
			void handoffFailure.catch(() => {});
			let settled = false;
			void handoff.then(
				() => {
					settled = true;
				},
				() => {
					settled = true;
				},
			);
			generatedCall = await controlled.mainStarted;
			const handoffText = "## Goal\nKeep the generated document available for copy/retry.";
			completeControlledStream(generatedCall, handoffText);
			await drainSyntheticStart();
			expect(onIteratorReturn).toHaveBeenCalledTimes(1);
			expect(settled).toBe(false);
			expect(harness.sessionManager.getLeafId()).toBe(leafId);
			expect(harness.session.agent.state.messages).toEqual(messages);
			release.resolve();

			const error = await handoffFailure;
			const originalTurnError = await turnFailure;
			expect(error).toMatchObject({
				name: "BtwTurnCleanupError",
				code: "unknown_effect",
				handoffDocument: handoffText,
			});
			if (!(error instanceof Error) || !(originalTurnError instanceof Error)) {
				throw new Error("Expected original cleanup Error instances");
			}
			// No plain Error replacement: preserve the cleanup class and original
			// retained failure objects through the document decoration and outer catch.
			expect(error.constructor).toBe(originalTurnError.constructor);
			expect(originalTurnError.cause).toBe(cleanupFailure);
			if (!(error.cause instanceof AggregateError)) throw new Error("Expected retained cleanup failure aggregate");
			expect(error.cause.errors).toContain(originalTurnError);
			expect(harness.session.sessionManager).toBe(harness.sessionManager);
			expect(harness.session.sessionId).toBe(sessionId);
			expect(harness.session.sessionFile).toBe(sessionFile);
			expect(harness.session.agent.sessionId).toBe(agentSessionId);
			expect(harness.sessionManager.getLeafId()).toBe(leafId);
			expect(harness.sessionManager.getEntries()).toEqual(entries);
			expect(harness.session.agent.state.messages).toEqual(messages);
			expect(harness.session.providerSessionState).toBe(providerState);
			expect(harness.session.isGeneratingHandoff).toBe(false);
			expect(harness.session.createBtwConversationScope("handoff lease released").credentialSessionId).toBe(
				harness.session.credentialSessionId,
			);
		} finally {
			release.resolve();
			harness.session.abortHandoff();
			sideCall.stream.end(sideCall.message);
			generatedCall?.stream.end(generatedCall.message);
			await Promise.allSettled([turn, turnFailure, handoff, handoffFailure]);
			sessions.splice(sessions.indexOf(harness.session), 1);
			await Promise.allSettled([harness.session.dispose(), harness.session.awaitDisposeCompletion()]);
		}
	});

	it("joins held iterator return before a completed turn or idle can settle", async () => {
		const release = Promise.withResolvers<void>();
		controlledFixtureCleanup.push(() => release.resolve());
		const onIteratorReturn = vi.fn(async () => await release.promise);
		const controlled = createControlledStreamModel({ onIteratorReturn });
		const harness = createHarness({ model: controlled.model });
		const turn = harness.session.runEphemeralTurn({
			purpose: "btw",
			turn: { question: "hold cleanup", scope: harness.session.createBtwConversationScope("btw test instruction") },
		});
		const call = await controlled.sideStarted;
		completeControlledStream(call, "complete but not closed");
		await drainSyntheticStart();
		expect(onIteratorReturn).toHaveBeenCalledTimes(1);
		let completed = false;
		let idle = false;
		void turn.then(
			() => {
				completed = true;
			},
			() => {},
		);
		const idleWait = harness.session.waitForIdle().then(() => {
			idle = true;
		});
		await drainSyntheticStart();
		expect(completed).toBe(false);
		expect(idle).toBe(false);
		release.resolve();
		await expect(turn).resolves.toMatchObject({ replyText: "complete but not closed" });
		await idleWait;
		expect(idle).toBe(true);
	});

	it("keeps retained disposal incomplete until aborted iterator cleanup actually closes", async () => {
		const release = Promise.withResolvers<void>();
		controlledFixtureCleanup.push(() => release.resolve());
		const onIteratorReturn = vi.fn(async () => await release.promise);
		const controlled = createControlledStreamModel({ onIteratorReturn });
		const harness = createHarness({ model: controlled.model });
		const onTextDelta = vi.fn();
		const turn = harness.session.runEphemeralTurn({
			purpose: "btw",
			turn: {
				question: "dispose while running",
				scope: harness.session.createBtwConversationScope("btw test instruction"),
			},
			onTextDelta,
		});
		const rejected = turn.then(
			() => {
				throw new Error("Disposed side turn unexpectedly completed");
			},
			error => {
				expect(error).toBeInstanceOf(Error);
			},
		);
		void rejected.catch(() => {});
		const call = await controlled.sideStarted;
		harness.session.setDisposeTimeoutForTests(10);
		vi.useFakeTimers();
		const disposal = harness.session.dispose();
		void disposal.catch(() => {});
		const incomplete = disposal.then(
			() => {
				throw new Error("Disposal completed before held iterator cleanup");
			},
			(error: unknown) => {
				expect(error).toMatchObject({ name: "SessionDisposalIncompleteError" });
			},
		);
		void incomplete.catch(() => {});
		await drainSyntheticStart();
		expect(onIteratorReturn).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(10);
		await incomplete;
		let disposed = false;
		const completion = harness.session.awaitDisposeCompletion().then(() => {
			disposed = true;
		});
		await drainSyntheticStart();
		expect(disposed).toBe(false);
		expect(call.options?.signal?.aborted).toBe(true);
		release.resolve();
		await rejected;
		await completion;
		expect(disposed).toBe(true);
		expect(onTextDelta).not.toHaveBeenCalled();
	});

	it("joins actual teardown on the first awaitDisposeCompletion call before dispose", async () => {
		const release = Promise.withResolvers<void>();
		controlledFixtureCleanup.push(() => release.resolve());
		const onIteratorReturn = vi.fn(async () => await release.promise);
		const controlled = createControlledStreamModel({ onIteratorReturn });
		const harness = createHarness({ model: controlled.model });
		const onTextDelta = vi.fn();
		const turn = harness.session.runEphemeralTurn({
			purpose: "btw",
			turn: {
				question: "first completion wait owns cleanup",
				scope: harness.session.createBtwConversationScope("btw test instruction"),
			},
			onTextDelta,
		});
		const rejected = turn.then(
			() => {
				throw new Error("Disposed BTW turn unexpectedly completed");
			},
			error => {
				expect(error).toBeInstanceOf(Error);
			},
		);
		void rejected.catch(() => {});
		const call = await controlled.sideStarted;
		let completion: Promise<void> | undefined;
		try {
			await drainSyntheticStart();
			harness.session.setDisposeTimeoutForTests(10);
			vi.useFakeTimers();
			completion = harness.session.awaitDisposeCompletion();
			let settled = false;
			void completion.then(
				() => {
					settled = true;
				},
				() => {
					settled = true;
				},
			);
			expect(harness.session.awaitDisposeCompletion()).toBe(completion);
			const disposal = harness.session.dispose();
			void disposal.catch(() => {});
			const incomplete = disposal.then(
				() => {
					throw new Error("Disposal completed before held iterator cleanup");
				},
				error => {
					expect(error).toMatchObject({ name: "SessionDisposalIncompleteError" });
				},
			);
			void incomplete.catch(() => {});
			await drainSyntheticStart();
			expect(onIteratorReturn).toHaveBeenCalledTimes(1);
			vi.advanceTimersByTime(10);
			await incomplete;
			await drainSyntheticStart();
			expect(settled).toBe(false);
			expect(harness.session.awaitDisposeCompletion()).toBe(completion);
			expect(call.options?.signal?.aborted).toBe(true);
			release.resolve();
			await rejected;
			await completion;
			expect(settled).toBe(true);
			expect(onTextDelta).not.toHaveBeenCalled();
		} finally {
			release.resolve();
			call.stream.end(call.message);
			await Promise.allSettled([turn, completion, harness.session.awaitDisposeCompletion()]);
		}
	});

	it("reports bounded cleanup uncertainty and retains an abort-ignoring iterator until late settlement", async () => {
		const onIteratorReturn = vi.fn(async () => {});
		const controlled = createControlledStreamModel({ ignoreAbort: true, onIteratorReturn });
		const harness = createHarness({ model: controlled.model });
		const onTextDelta = vi.fn();
		const controller = new AbortController();
		const turn = harness.session.runEphemeralTurn({
			purpose: "btw",
			turn: {
				question: "ignore cancellation",
				scope: harness.session.createBtwConversationScope("btw test instruction"),
			},
			signal: controller.signal,
			onTextDelta,
		});
		const rejected = turn.then(
			() => {
				throw new Error("Uncertain side turn unexpectedly completed");
			},
			error => {
				expect(error).toMatchObject({ code: "unknown_effect" });
			},
		);
		void rejected.catch(() => {});
		const call = await controlled.sideStarted;
		await drainSyntheticStart();
		vi.useFakeTimers();
		controller.abort(new Error("cancel side"));
		await drainSyntheticStart();
		expect(onIteratorReturn).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(5_000);
		await rejected;
		let idle = false;
		const idleWait = harness.session.waitForIdle().then(() => {
			idle = true;
		});
		await drainSyntheticStart();
		expect(idle).toBe(false);
		completeControlledStream(call, "late private bytes");
		await idleWait;
		expect(onTextDelta).not.toHaveBeenCalled();
		expect(idle).toBe(true);
	});

	it("surfaces rejected iterator cleanup to the turn, idle, and disposal", async () => {
		const controlled = createControlledStreamModel({
			onIteratorReturn: async () => {
				throw new Error("iterator cleanup failed");
			},
		});
		const harness = createHarness({ model: controlled.model });
		const turn = harness.session.runEphemeralTurn({
			purpose: "btw",
			turn: {
				question: "cleanup failure",
				scope: harness.session.createBtwConversationScope("btw test instruction"),
			},
		});
		const call = await controlled.sideStarted;
		completeControlledStream(call, "not certified");
		await expect(turn).rejects.toMatchObject({ code: "unknown_effect" });
		await expect(harness.session.waitForIdle()).rejects.toMatchObject({ code: "unknown_effect" });
		sessions.splice(sessions.indexOf(harness.session), 1);
		await expect(harness.session.dispose()).rejects.toThrow("/btw turns");
	});

	it("keeps private canonical side input out of the main session conversion pipeline", async () => {
		const convert = vi.fn(async (): Promise<Message[]> => {
			throw new Error("Main conversion must not inspect private side input");
		});
		let providerMessages = "";
		const model = createMockModel({
			responses: [
				context => {
					providerMessages = JSON.stringify(context.messages);
					return { content: ["done"] };
				},
			],
		});
		const harness = createHarness({ convert, model });
		await harness.session.runEphemeralTurn({
			purpose: "btw",
			turn: {
				question: "private question",
				scope: harness.session.createBtwConversationScope("btw test instruction"),
			},
		});
		expect(convert).not.toHaveBeenCalled();
		expect(harness.model.calls).toHaveLength(1);
		expect(providerMessages).toContain("private question");
	});
});
