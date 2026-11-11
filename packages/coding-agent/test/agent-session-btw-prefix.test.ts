import { afterEach, describe, expect, it, vi } from "bun:test";
import { gunzipSync } from "node:zlib";
import { Agent, type AgentTool } from "@gajae-code/agent-core";
import {
	type AssistantMessageEvent,
	Effort,
	type Model,
	type ProviderDispatch,
	type SimpleStreamOptions,
	streamSimple,
} from "@gajae-code/ai";
import { getBundledModel } from "@gajae-code/ai/models";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import type { BtwTextExchange } from "@gajae-code/coding-agent/session/btw-contract";
import { BTW_PREFIX_TTL_SAFETY_MARGIN_MS } from "@gajae-code/coding-agent/session/btw-prefix-ledger";
import { convertToLlm } from "@gajae-code/coding-agent/session/messages";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { z } from "zod";

const MAIN_KEY = "sk-ant-api03-main-prefix-test-key";
const OTHER_KEY = "sk-ant-api03-rotated-prefix-test-key";
const MAIN_ANSWER = "main final answer";
const SIDE_INSTRUCTION = "btw prefix instruction";

type AnthropicBody = Record<string, unknown> & { messages: Array<Record<string, unknown>> };

interface CapturedRequest {
	url: string;
	headers: Record<string, string>;
	body: AnthropicBody;
}

type Responder = (request: CapturedRequest, signal: AbortSignal | null | undefined) => Response;

const encoder = new TextEncoder();

/**
 * Real catalog entry: the ledger only replays thinking for sonnet 4.6+, and the provider's effort/thinking
 * mapping needs the catalog's thinking metadata.
 */
function anthropicModel(overrides: Partial<Model<"anthropic-messages">> = {}): Model<"anthropic-messages"> {
	const base = getBundledModel("anthropic", "claude-sonnet-4-6") as Model<"anthropic-messages">;
	return { ...base, ...overrides };
}

type SseEvent = Record<string, unknown>;

const USAGE = { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 40 };

function messageStart(id: string): SseEvent {
	return { type: "message_start", message: { id, usage: { ...USAGE, output_tokens: 0 } } };
}

function textEvents(text: string): SseEvent[] {
	return [
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
		{ type: "content_block_stop", index: 0 },
	];
}

function toolEvents(index: number): SseEvent[] {
	return [
		{
			type: "content_block_start",
			index,
			content_block: { type: "tool_use", id: "toolu_side_1", name: "lookup", input: {} },
		},
		{ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: "{}" } },
		{ type: "content_block_stop", index },
	];
}

function terminalEvents(stopReason: "end_turn" | "tool_use"): SseEvent[] {
	return [
		{ type: "message_delta", delta: { stop_reason: stopReason }, usage: { ...USAGE, output_tokens: 3 } },
		{ type: "message_stop" },
	];
}

function sseChunk(events: SseEvent[]): string {
	return events.map(event => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

function sseResponse(events: SseEvent[]): Response {
	return new Response(sseChunk(events), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function answer(text: string, id = "msg_text"): Responder {
	return () => sseResponse([messageStart(id), ...textEvents(text), ...terminalEvents("end_turn")]);
}

const MAIN_THINKING = "main reasoning text";
const MAIN_SIGNATURE = "sig-main-final-thinking";

function thinkingEvents(): SseEvent[] {
	return [
		{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: MAIN_THINKING } },
		{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: MAIN_SIGNATURE } },
		{ type: "content_block_stop", index: 0 },
	];
}

/** Final main answer F = signed thinking block followed by the text block. */
function thinkingThenAnswer(text: string): Responder {
	return () =>
		sseResponse([
			messageStart("msg_main_thinking"),
			...thinkingEvents(),
			...textEvents(text).map(event => (typeof event.index === "number" ? { ...event, index: 1 } : event)),
			...terminalEvents("end_turn"),
		]);
}

function invalidThinkingSignature(): Responder {
	return () =>
		new Response(
			JSON.stringify({
				type: "error",
				error: {
					type: "invalid_request_error",
					message: "messages.1.content.0: Invalid `signature` in `thinking` block",
				},
			}),
			{ status: 400, headers: { "content-type": "application/json" } },
		);
}

function textThenTool(text: string): Responder {
	return () =>
		sseResponse([
			messageStart("msg_text_tool"),
			...textEvents(text),
			...toolEvents(1),
			...terminalEvents("tool_use"),
		]);
}

function toolOnly(): Responder {
	return () => sseResponse([messageStart("msg_tool_only"), ...toolEvents(0), ...terminalEvents("tool_use")]);
}

interface HeldResponse {
	responder: Responder;
	push(events: SseEvent[]): void;
}

/** A response whose body stays open until the test pushes events; aborting the request errors the body. */
function held(): HeldResponse {
	let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	let closed = false;
	const body = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
		},
		cancel() {
			closed = true;
		},
	});
	return {
		responder: (_request, signal) => {
			signal?.addEventListener(
				"abort",
				() => {
					if (closed) return;
					closed = true;
					try {
						controller?.error(signal.reason ?? new Error("aborted"));
					} catch {}
				},
				{ once: true },
			);
			return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
		},
		push: events => {
			if (closed) return;
			controller?.enqueue(encoder.encode(sseChunk(events)));
			if (events.some(event => event.type === "message_stop")) {
				closed = true;
				controller?.close();
			}
		},
	};
}

/**
 * Routes `return()` of every provider-stream iterator opened while installed through `onClose` when that
 * stream ended with a tool call, i.e. the tool-only prefix (C) attempt. Install it after the main turn so
 * only side-request iterators are affected; the returned function restores the inherited iterator.
 */
function interceptToolOnlyIteratorClose(onClose: () => Promise<void>): () => void {
	const proto = AssistantMessageEventStream.prototype;
	const base = proto[Symbol.asyncIterator];
	Object.defineProperty(proto, Symbol.asyncIterator, {
		configurable: true,
		writable: true,
		value(this: AssistantMessageEventStream): AsyncIterator<AssistantMessageEvent> {
			const iterator = base.call(this);
			return {
				next: () => iterator.next(),
				return: async () => {
					await iterator.return?.();
					const message = await this.result();
					if (message.content.some(block => block.type === "toolCall")) await onClose();
					return { done: true as const, value: undefined };
				},
			};
		},
	});
	const installed = Object.getOwnPropertyDescriptor(proto, Symbol.asyncIterator)?.value;
	const restore = () => {
		// A late finally of a timed-out test must not remove a later test's interceptor.
		if (Object.getOwnPropertyDescriptor(proto, Symbol.asyncIterator)?.value === installed) {
			Reflect.deleteProperty(proto, Symbol.asyncIterator);
		}
	};
	fixtureCleanup.push(restore);
	return restore;
}

function decodeBody(body: RequestInit["body"]): AnthropicBody {
	let bytes: Uint8Array;
	if (typeof body === "string") bytes = encoder.encode(body);
	else if (body instanceof Uint8Array) bytes = body;
	else throw new Error("unexpected request body type");
	const raw = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
	return JSON.parse(new TextDecoder().decode(raw)) as AnthropicBody;
}

const sessions: AgentSession[] = [];

/** Fixture undo steps that must run even when a test times out before its own finally. */
const fixtureCleanup: Array<() => void> = [];

afterEach(async () => {
	for (const cleanup of fixtureCleanup.splice(0)) cleanup();
	vi.restoreAllMocks();
	for (const session of sessions.splice(0)) await session.dispose();
});

interface HarnessOptions {
	model?: Model<"anthropic-messages">;
	/** Reasoning level injected into every main request. */
	reasoning?: Effort;
	toolChoice?: SimpleStreamOptions["toolChoice"];
	/** `short` sends the default 5m cache control; unset keeps the provider default (long, 1h). */
	cacheRetention?: "short";
	/** Explicit main `max_tokens`, so budget arithmetic does not depend on provider defaults. */
	maxTokens?: number;
	/** Caller-supplied dispatch hook on the main request (observe, mutate its copy, or veto). */
	callerDispatch?: (dispatch: ProviderDispatch) => void;
}

function createHarness(options: HarnessOptions = {}) {
	const model = options.model ?? anthropicModel();
	const queue: Responder[] = [];
	const requests: CapturedRequest[] = [];
	const lookupRuns = vi.fn();
	const lookupTool: AgentTool<z.ZodObject<Record<string, never>>> = {
		name: "lookup",
		label: "Lookup",
		description: "Looks something up",
		parameters: z.object({}),
		execute: async () => {
			lookupRuns();
			return { content: [{ type: "text", text: "looked up" }] };
		},
	};
	vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
		const request: CapturedRequest = {
			url: input instanceof Request ? input.url : String(input),
			headers: Object.fromEntries(new Headers(init?.headers)),
			body: decodeBody(init?.body),
		};
		requests.push(request);
		const responder = queue.shift();
		if (!responder) throw new Error("unexpected provider request");
		return responder(request, init?.signal);
	}) as typeof fetch);

	let session: AgentSession | undefined;
	const sideKey = { current: MAIN_KEY };
	const onPayload = vi.fn();
	const onResponse = vi.fn();
	const agent = new Agent({
		getApiKey: () => MAIN_KEY,
		initialState: {
			model,
			systemPrompt: ["main system prompt"],
			messages: [],
			tools: [lookupTool as AgentTool<never>],
		},
		// Same seam the SDK streamFn uses: the session observes the exact dispatch and terminal result.
		streamFn: async (streamModel, context, streamOptions) => {
			if (!session) throw new Error("session not initialized");
			const mainOptions = {
				...streamOptions,
				...(options.reasoning ? { reasoning: options.reasoning } : {}),
				...(options.toolChoice !== undefined ? { toolChoice: options.toolChoice } : {}),
				...(options.cacheRetention ? { cacheRetention: options.cacheRetention } : {}),
				...(options.maxTokens ? { maxTokens: options.maxTokens } : {}),
				...(options.callerDispatch ? { onProviderDispatch: options.callerDispatch } : {}),
			};
			return await session.observeMainProviderStream(streamModel, context, mainOptions, providerOptions =>
				streamSimple(streamModel, context, providerOptions),
			);
		},
		convertToLlm,
	});
	const sessionManager = SessionManager.inMemory();
	const getApiKey = vi.fn(async (_model: unknown, _sessionId: string) => sideKey.current);
	session = new AgentSession({
		agent,
		sessionManager,
		settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
		modelRegistry: {
			authStorage: undefined,
			getApiKey,
			getAvailable: () => [model],
			getAuthStorageOwner: () => ({}),
			withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
		} as never,
		convertToLlm: async messages => convertToLlm(messages),
		onPayload,
		onResponse,
	});
	sessions.push(session);
	const ready = session;
	return {
		session: ready,
		agent,
		queue,
		requests,
		lookupRuns,
		sessionManager,
		sideKey,
		getApiKey,
		onPayload,
		onResponse,
		async runMain(responder: Responder = answer(MAIN_ANSWER, "msg_main")): Promise<void> {
			queue.push(responder);
			await ready.prompt("main question");
			await ready.waitForIdle();
		},
		async runSide(
			question: string,
			extra: {
				signal?: AbortSignal;
				onTextDelta?: (delta: string) => void;
				contextExchanges?: readonly BtwTextExchange[];
			} = {},
			scope = ready.createBtwConversationScope(SIDE_INSTRUCTION),
		) {
			return await ready.runEphemeralTurn({ purpose: "btw", turn: { question, scope }, ...extra });
		},
	};
}

/** The projected (A) request sends no tools (absent or empty); a prefix (C) request carries main's tools. */
function hasTools(request: CapturedRequest): boolean {
	return Array.isArray(request.body.tools) && request.body.tools.length > 0;
}

function suffixText(request: CapturedRequest): string {
	const last = request.body.messages[request.body.messages.length - 1] as {
		content: string | Array<{ text: string }>;
	};
	return typeof last.content === "string" ? last.content : last.content.map(block => block.text).join("");
}

describe("AgentSession /btw provider-prefix reuse", () => {
	it("extends the main provider prefix after the real main wrapper bound its final answer", async () => {
		const harness = createHarness({ reasoning: Effort.Medium });
		await harness.runMain(thinkingThenAnswer(MAIN_ANSWER));
		expect(harness.requests).toHaveLength(1);
		const mainBody = harness.requests[0].body;
		expect(mainBody.thinking).toBeDefined();
		expect((mainBody.thinking as { type: string }).type).not.toBe("disabled");
		const mainMessages = structuredClone(harness.agent.state.messages);
		const entriesBefore = structuredClone(harness.sessionManager.getEntries());
		const providerState = harness.session.providerSessionState;
		const providerStateBefore = JSON.stringify([...providerState]);
		const payloadCallsBefore = harness.onPayload.mock.calls.length;
		const responseCallsBefore = harness.onResponse.mock.calls.length;
		harness.queue.push(answer("side answer", "msg_side"));
		const deltas: string[] = [];

		const result = await harness.runSide("what did you just say?", { onTextDelta: delta => deltas.push(delta) });

		expect(result.replyText).toBe("side answer");
		expect(deltas.join("")).toBe("side answer");
		expect(harness.requests).toHaveLength(2);
		const sideBody = harness.requests[1].body;
		// System, tools, thinking and every other root field replay byte-for-byte; nothing is switched off.
		for (const key of Object.keys(mainBody).filter(key => key !== "messages")) {
			expect(JSON.stringify(sideBody[key])).toBe(JSON.stringify(mainBody[key]));
		}
		expect(Object.keys(sideBody)).toEqual(Object.keys(mainBody));
		expect(sideBody.tool_choice).toBeUndefined();
		expect(sideBody.tools).toBeDefined();
		// Main message prefix, then the final main answer, then the side user suffix.
		expect(sideBody.messages.slice(0, mainBody.messages.length)).toEqual(mainBody.messages);
		const assistant = sideBody.messages[mainBody.messages.length] as { role: string; content: unknown };
		expect(assistant.role).toBe("assistant");
		// The whole final answer F is replayed exactly as the native serializer emits it, signature included.
		expect(assistant.content).toEqual([
			{ type: "thinking", thinking: MAIN_THINKING, signature: MAIN_SIGNATURE },
			{ type: "text", text: MAIN_ANSWER },
		]);
		expect(sideBody.messages).toHaveLength(mainBody.messages.length + 2);
		expect(suffixText(harness.requests[1])).toContain(SIDE_INSTRUCTION);
		expect(suffixText(harness.requests[1])).toContain("what did you just say?");
		expect(JSON.stringify(sideBody.system)).not.toContain(SIDE_INSTRUCTION);
		expect(harness.requests[1].headers["x-api-key"]).toBe(MAIN_KEY);
		// Main state, history, provider state and extension hooks are untouched.
		expect(harness.agent.state.messages).toEqual(mainMessages);
		expect(harness.sessionManager.getEntries()).toEqual(entriesBefore);
		expect(harness.session.providerSessionState).toBe(providerState);
		expect(JSON.stringify([...harness.session.providerSessionState])).toBe(providerStateBefore);
		expect(harness.onPayload.mock.calls).toHaveLength(payloadCallsBefore);
		expect(harness.onResponse.mock.calls).toHaveLength(responseCallsBefore);
		expect(harness.lookupRuns).not.toHaveBeenCalled();
	});

	for (const choice of ["none", "auto"] as const) {
		it(`preserves explicit main tool_choice=${choice} on the real provider wire`, async () => {
			const harness = createHarness({ toolChoice: choice });
			await harness.runMain();
			expect(harness.requests[0].body.tool_choice).toEqual({ type: choice });
			harness.queue.push(answer("choice preserved", "msg_choice"));
			const result = await harness.runSide("what was decided?");
			expect(result.replyText).toBe("choice preserved");
			expect(harness.requests).toHaveLength(2);
			expect(hasTools(harness.requests[1])).toBe(true);
			expect(harness.requests[1].body.tool_choice).toEqual(harness.requests[0].body.tool_choice);
			expect(harness.lookupRuns).not.toHaveBeenCalled();
		});
	}

	it("reuses one scope with earlier side exchanges only in the appended user suffix", async () => {
		const harness = createHarness();
		await harness.runMain();
		const scope = harness.session.createBtwConversationScope(SIDE_INSTRUCTION);
		harness.queue.push(answer("first side answer", "msg_side_1"));
		await harness.runSide("first side question", {}, scope);
		harness.queue.push(answer("second side answer", "msg_side_2"));
		await harness.runSide(
			"second side question",
			{
				contextExchanges: [{ question: "first side question", answer: "first side answer" }],
			},
			scope,
		);
		expect(harness.requests).toHaveLength(3);
		for (const request of harness.requests.slice(1)) {
			expect(hasTools(request)).toBe(true);
			expect(request.body.messages.slice(0, harness.requests[0].body.messages.length)).toEqual(
				harness.requests[0].body.messages,
			);
		}
		const suffix = suffixText(harness.requests[2]);
		expect(suffix).toContain("first side question");
		expect(suffix).toContain("first side answer");
		expect(suffix).toContain("second side question");
		harness.session.releaseBtwConversationScope(scope);
	});

	it("shows only the text of a text-plus-tool_use answer and never runs the tool", async () => {
		const harness = createHarness();
		await harness.runMain();
		harness.queue.push(textThenTool("visible side text"));
		const deltas: string[] = [];

		const result = await harness.runSide("use a tool?", { onTextDelta: delta => deltas.push(delta) });

		expect(harness.requests).toHaveLength(2);
		expect(result.replyText).toBe("visible side text");
		expect(deltas.join("")).toBe("visible side text");
		expect(JSON.stringify(result)).not.toContain("toolu_side_1");
		expect(harness.lookupRuns).not.toHaveBeenCalled();
	});

	it("falls back to the projected request exactly once when the prefix answer is tool-only", async () => {
		const harness = createHarness();
		await harness.runMain();
		harness.queue.push(toolOnly(), answer("projected answer", "msg_a"));
		const deltas: string[] = [];

		const result = await harness.runSide("tool only please", { onTextDelta: delta => deltas.push(delta) });

		expect(harness.requests).toHaveLength(3);
		expect(result.replyText).toBe("projected answer");
		expect(deltas.join("")).toBe("projected answer");
		const fallback = harness.requests[2].body;
		expect(Array.isArray(fallback.tools) ? fallback.tools : []).toHaveLength(0);
		expect(JSON.stringify(fallback.system)).toContain(SIDE_INSTRUCTION);
		expect(harness.lookupRuns).not.toHaveBeenCalled();
	});

	it("joins a held close of the abandoned prefix attempt before the projected answer settles", async () => {
		const harness = createHarness();
		await harness.runMain();
		harness.queue.push(toolOnly(), answer("projected answer", "msg_a"));
		const release = Promise.withResolvers<void>();
		fixtureCleanup.push(() => release.resolve());
		const onClose = vi.fn(async () => await release.promise);
		const restore = interceptToolOnlyIteratorClose(onClose);
		try {
			let settled = false;
			const side = harness.runSide("tool only please").then(result => {
				settled = true;
				return result;
			});
			for (let i = 0; i < 100 && onClose.mock.calls.length === 0; i++) await Bun.sleep(5);
			expect(harness.requests).toHaveLength(3);
			expect(onClose).toHaveBeenCalledTimes(1);
			await Bun.sleep(20);
			// The projected answer is complete, but the turn settles only after every attempt's close joins.
			expect(settled).toBe(false);
			release.resolve();
			expect((await side).replyText).toBe("projected answer");
		} finally {
			release.resolve();
			restore();
		}
	});

	it("reports a failed close of the abandoned prefix attempt as an unknown effect", async () => {
		const harness = createHarness();
		await harness.runMain();
		harness.queue.push(toolOnly(), answer("projected answer", "msg_a"));
		const closeFailure = new Error("prefix iterator close failed");
		const restore = interceptToolOnlyIteratorClose(async () => {
			throw closeFailure;
		});
		try {
			const error = await harness.runSide("tool only please").then(
				() => undefined,
				(failure: unknown) => failure,
			);
			expect(harness.requests).toHaveLength(3);
			expect(error).toMatchObject({ name: "BtwTurnCleanupError" });
			expect(error instanceof Error && error.cause).toBe(closeFailure);
		} finally {
			restore();
			// The retained cleanup failure makes later session transitions fail closed by design.
			const index = sessions.indexOf(harness.session);
			if (index >= 0) sessions.splice(index, 1);
			await Promise.allSettled([harness.session.dispose()]);
		}
	});

	it("keeps the prefix path for the next turn after a caller cancels a prefix attempt", async () => {
		const harness = createHarness();
		await harness.runMain();
		const sideHold = held();
		harness.queue.push(sideHold.responder);
		const scope = harness.session.createBtwConversationScope(SIDE_INSTRUCTION);
		const controller = new AbortController();
		const first = harness.runSide("cancel me", { signal: controller.signal }, scope).then(
			() => undefined,
			(error: unknown) => error,
		);
		for (let i = 0; i < 50 && harness.requests.length < 2; i++) await Bun.sleep(5);
		expect(harness.requests).toHaveLength(2);
		expect(hasTools(harness.requests[1])).toBe(true);
		controller.abort();
		expect(await first).toBeInstanceOf(Error);
		// Cancellation is not a prefix failure: no projected request, and the scope keeps C.
		expect(harness.requests).toHaveLength(2);

		harness.queue.push(answer("second side answer", "msg_second"));
		const second = await harness.runSide("and now?", {}, scope);
		expect(second.replyText).toBe("second side answer");
		expect(harness.requests).toHaveLength(3);
		expect(hasTools(harness.requests[2])).toBe(true);
	});

	it("does not fall back after the prefix attempt already produced text and then failed", async () => {
		const harness = createHarness();
		await harness.runMain();
		harness.queue.push(() =>
			sseResponse([
				messageStart("msg_partial"),
				...textEvents("partial side text"),
				{ type: "error", error: { type: "overloaded_error", message: "overloaded" } },
			]),
		);
		const deltas: string[] = [];

		await expect(
			harness.runSide("partial then error", { onTextDelta: delta => deltas.push(delta) }),
		).rejects.toThrow();

		expect(harness.requests).toHaveLength(2);
		expect(deltas.join("")).toBe("partial side text");
	});

	it("uses the projected path when no prefix was ever captured", async () => {
		const harness = createHarness();
		harness.queue.push(answer("projected only", "msg_a"));

		const result = await harness.runSide("no main yet");

		expect(result.replyText).toBe("projected only");
		expect(harness.requests).toHaveLength(1);
		expect(hasTools(harness.requests[0])).toBe(false);
		expect(JSON.stringify(harness.requests[0].body.system)).toContain(SIDE_INSTRUCTION);
	});

	it("rejects a rotated credential before any network I/O and answers through the projected path", async () => {
		const harness = createHarness();
		await harness.runMain();
		harness.sideKey.current = OTHER_KEY;
		harness.queue.push(answer("projected after credential change", "msg_a"));

		const result = await harness.runSide("who am I talking to?");

		// Main request + the projected request only: the rejected prefix dispatch never reached fetch.
		expect(harness.requests).toHaveLength(2);
		expect(harness.requests[1].headers["x-api-key"]).toBe(OTHER_KEY);
		expect(hasTools(harness.requests[1])).toBe(false);
		expect(result.replyText).toBe("projected after credential change");
	});

	describe("cache TTL", () => {
		const FIVE_MINUTES = 5 * 60 * 1000 - BTW_PREFIX_TTL_SAFETY_MARGIN_MS;
		const ONE_HOUR = 60 * 60 * 1000 - BTW_PREFIX_TTL_SAFETY_MARGIN_MS;

		/** Both clocks are frozen so the boundary is exact; the offsets are applied after the main dispatch. */
		function freezeClocks(): { mono: number; wall: number } {
			const monoBase = performance.now();
			const wallBase = Date.now();
			const offsets = { mono: 0, wall: 0 };
			vi.spyOn(performance, "now").mockImplementation(() => monoBase + offsets.mono);
			vi.spyOn(Date, "now").mockImplementation(() => wallBase + offsets.wall);
			return offsets;
		}

		interface TtlCase {
			name: string;
			cacheRetention?: "short";
			mono: number;
			wall: number;
			expectPrefix: boolean;
		}

		const cases: TtlCase[] = [
			{
				name: "5m: just inside on both clocks",
				cacheRetention: "short",
				mono: FIVE_MINUTES - 1,
				wall: FIVE_MINUTES - 1,
				expectPrefix: true,
			},
			{
				name: "5m: monotonic clock at the boundary",
				cacheRetention: "short",
				mono: FIVE_MINUTES,
				wall: 0,
				expectPrefix: false,
			},
			{
				name: "5m: wall clock at the boundary",
				cacheRetention: "short",
				mono: 0,
				wall: FIVE_MINUTES,
				expectPrefix: false,
			},
			{
				name: "5m: wall clock stepped backwards fails closed",
				cacheRetention: "short",
				mono: 1,
				wall: -1,
				expectPrefix: false,
			},
			{ name: "1h default: 6 minutes is still warm", mono: 6 * 60 * 1000, wall: 6 * 60 * 1000, expectPrefix: true },
			{ name: "1h default: just inside", mono: ONE_HOUR - 1, wall: ONE_HOUR - 1, expectPrefix: true },
			{ name: "1h default: monotonic clock at the boundary", mono: ONE_HOUR, wall: 0, expectPrefix: false },
			{ name: "1h default: wall clock at the boundary", mono: 0, wall: ONE_HOUR, expectPrefix: false },
		];

		for (const ttlCase of cases) {
			it(`${ttlCase.name} (checked when the scope is captured)`, async () => {
				const offsets = freezeClocks();
				const harness = createHarness({ cacheRetention: ttlCase.cacheRetention });
				await harness.runMain();
				const ttl = (harness.requests[0].body.cache_control as { ttl?: string } | undefined)?.ttl;
				expect(ttl).toBe(ttlCase.cacheRetention === "short" ? undefined : "1h");
				offsets.mono = ttlCase.mono;
				offsets.wall = ttlCase.wall;
				harness.queue.push(answer("ttl answer", "msg_ttl"));

				await harness.runSide("ttl question");

				expect(harness.requests).toHaveLength(2);
				expect(hasTools(harness.requests[1])).toBe(ttlCase.expectPrefix);
			});
		}

		it("rejects before any network I/O when the TTL runs out between scope capture and dispatch", async () => {
			const offsets = freezeClocks();
			const harness = createHarness({ cacheRetention: "short" });
			await harness.runMain();
			offsets.mono = FIVE_MINUTES - 1;
			offsets.wall = FIVE_MINUTES - 1;
			const scope = harness.session.createBtwConversationScope(SIDE_INSTRUCTION);
			offsets.mono = FIVE_MINUTES;
			offsets.wall = FIVE_MINUTES;
			harness.queue.push(answer("projected after late ttl", "msg_late"));

			await harness.runSide("expired while queued", {}, scope);

			// Main + projected only: the expired prefix dispatch never reached fetch.
			expect(harness.requests).toHaveLength(2);
			expect(hasTools(harness.requests[1])).toBe(false);
		});
	});

	it("never lets a provider-local thinking repair rewrite the replayed prefix", async () => {
		const harness = createHarness({ reasoning: Effort.Medium });
		await harness.runMain(thinkingThenAnswer(MAIN_ANSWER));
		// The prefix attempt is rejected like a signature failure; the projected request answers afterwards.
		harness.queue.push(invalidThinkingSignature(), answer("projected after 400", "msg_a"));

		const result = await harness.runSide("rejected thinking replay");

		expect(result.replyText).toBe("projected after 400");
		// Main, one prefix attempt, one projected request. A provider repair would add a prefix request with
		// the thinking block stripped (tools still present) before the projected one.
		expect(harness.requests).toHaveLength(3);
		const prefixBody = harness.requests[1].body;
		const replayed = prefixBody.messages[harness.requests[0].body.messages.length] as { content: unknown };
		expect(replayed.content).toEqual([
			{ type: "thinking", thinking: MAIN_THINKING, signature: MAIN_SIGNATURE },
			{ type: "text", text: MAIN_ANSWER },
		]);
		expect(hasTools(harness.requests[2])).toBe(false);
	});

	it("shows the caller's own dispatch hook a detached copy and keeps its veto", async () => {
		const seen: Array<{ apiKey: string | null; method: string }> = [];
		const tampering = createHarness({
			callerDispatch: dispatch => {
				seen.push({ apiKey: dispatch.headers.get("x-api-key"), method: dispatch.method });
				dispatch.headers.set("x-api-key", "tampered");
				dispatch.headers.set("anthropic-version", "tampered");
				if (dispatch.body instanceof Uint8Array) dispatch.body.fill(0);
			},
		});
		await tampering.runMain();
		// The wire request still carries the real frame (the fake fetch decodes it), and C still extends it.
		expect(seen).toEqual([{ apiKey: MAIN_KEY, method: "POST" }]);
		expect(tampering.requests[0].headers["x-api-key"]).toBe(MAIN_KEY);
		tampering.queue.push(answer("prefix after tampering", "msg_side"));
		await tampering.runSide("still the real prefix?");
		expect(tampering.requests).toHaveLength(2);
		expect(hasTools(tampering.requests[1])).toBe(true);
		expect(tampering.requests[1].headers["x-api-key"]).toBe(MAIN_KEY);

		const vetoing = createHarness({
			callerDispatch: () => {
				throw new Error("caller veto");
			},
		});
		await vetoing.session.prompt("vetoed main").catch(() => undefined);
		await vetoing.session.waitForIdle();
		// The veto blocked the main request before any network I/O and left no prefix to reuse.
		expect(vetoing.requests).toHaveLength(0);
		vetoing.queue.push(answer("projected after veto", "msg_a"));
		const result = await vetoing.runSide("anything");
		expect(result.replyText).toBe("projected after veto");
		expect(vetoing.requests).toHaveLength(1);
		expect(hasTools(vetoing.requests[0])).toBe(false);
	});

	it("keeps the prefix for a small side context but falls back when the appended context exceeds the budget", async () => {
		// Floor = main input (50) + explicit max_tokens (1000) + 2048 margin; the appended suffix is charged
		// by its JSON bytes.
		const model = anthropicModel({ contextWindow: 1000 + 50 + 2048 + 3000 });
		const small = createHarness({ model, maxTokens: 1000 });
		await small.runMain();
		expect(small.requests[0].body.max_tokens).toBe(1000);
		small.queue.push(answer("small ok", "msg_small"));
		await small.runSide("hi");
		expect(small.requests).toHaveLength(2);
		expect(hasTools(small.requests[1])).toBe(true);

		const large = createHarness({ model, maxTokens: 1000 });
		await large.runMain();
		large.queue.push(answer("projected large", "msg_large"));
		await large.runSide("x".repeat(8000));
		expect(large.requests).toHaveLength(2);
		expect(hasTools(large.requests[1])).toBe(false);
	});

	it("blocks a stale prefix once the main conversation moves on", async () => {
		const harness = createHarness();
		await harness.runMain();
		const scope = harness.session.createBtwConversationScope(SIDE_INSTRUCTION);
		const secondMain = held();
		harness.queue.push(secondMain.responder);
		const mainTurn = harness.session.prompt("second main question");
		for (let i = 0; i < 50 && harness.requests.length < 2; i++) await Bun.sleep(5);
		expect(harness.requests).toHaveLength(2);
		harness.queue.push(answer("projected while main runs", "msg_a"));

		const result = await harness.runSide("while main is busy", {}, scope);

		expect(result.replyText).toBe("projected while main runs");
		// Main request 1, main request 2, projected side: the prefix dispatch was rejected before fetch.
		expect(harness.requests).toHaveLength(3);
		expect(hasTools(harness.requests[2])).toBe(false);
		expect(harness.agent.state.isStreaming).toBe(true);
		secondMain.push([messageStart("msg_main_2"), ...textEvents("second answer"), ...terminalEvents("end_turn")]);
		await mainTurn;
		await harness.session.waitForIdle();
		expect(harness.agent.state.messages.at(-1)?.role).toBe("assistant");
	});

	it("aborts the side request without aborting the running main request", async () => {
		const harness = createHarness();
		await harness.runMain();
		const mainHold = held();
		harness.queue.push(mainHold.responder);
		const mainTurn = harness.session.prompt("second main question");
		for (let i = 0; i < 50 && harness.requests.length < 2; i++) await Bun.sleep(5);
		const sideHold = held();
		harness.queue.push(sideHold.responder);
		const controller = new AbortController();
		const side = harness.runSide("abort me", { signal: controller.signal });
		const sideOutcome = side.then(
			() => undefined,
			(error: unknown) => error,
		);
		for (let i = 0; i < 50 && harness.requests.length < 3; i++) await Bun.sleep(5);
		expect(harness.requests).toHaveLength(3);

		controller.abort();
		expect(await sideOutcome).toBeInstanceOf(Error);

		expect(harness.agent.state.isStreaming).toBe(true);
		mainHold.push([messageStart("msg_main_2"), ...textEvents("second answer"), ...terminalEvents("end_turn")]);
		await mainTurn;
		await harness.session.waitForIdle();
		expect(harness.agent.state.isStreaming).toBe(false);
	});

	it("cancels an active side request when its session is disposed without a caller signal", async () => {
		const harness = createHarness();
		await harness.runMain();
		const heldSide = held();
		harness.queue.push(heldSide.responder);
		const scope = harness.session.createBtwConversationScope(SIDE_INSTRUCTION);
		const side = harness.runSide("dispose me", {}, scope);
		const outcome = side.then(
			() => undefined,
			(error: unknown) => error,
		);
		for (let i = 0; i < 50 && harness.requests.length < 2; i++) await Bun.sleep(5);
		expect(harness.requests).toHaveLength(2);
		await harness.session.dispose();
		expect(await outcome).toBeInstanceOf(Error);
		await expect(harness.runSide("after dispose", {}, scope)).rejects.toThrow();
		expect(harness.requests).toHaveLength(2);
	});

	it("retires an in-flight prefix request at a session transition", async () => {
		const harness = createHarness();
		await harness.runMain();
		const sideHold = held();
		harness.queue.push(sideHold.responder);
		const side = harness.runSide("retire me");
		const outcome = side.then(
			() => undefined,
			(error: unknown) => error,
		);
		for (let i = 0; i < 50 && harness.requests.length < 2; i++) await Bun.sleep(5);
		expect(harness.requests).toHaveLength(2);
		expect(hasTools(harness.requests[1])).toBe(true);

		await harness.session.clearContext();
		const error = await outcome;
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("retired");
		// Retirement is caller cancellation: no projected request follows it.
		expect(harness.requests).toHaveLength(2);
	});

	it("joins credential lookup on disposal and never dispatches its late result", async () => {
		const harness = createHarness();
		await harness.runMain();
		const credential = Promise.withResolvers<string>();
		harness.getApiKey.mockImplementation(() => credential.promise);
		const side = harness.runSide("pending credential");
		let settled = false;
		const outcome = side.then(
			() => {
				settled = true;
			},
			(error: unknown) => {
				settled = true;
				return error;
			},
		);
		let disposed = false;
		const disposal = harness.session.dispose().then(() => {
			disposed = true;
		});
		await Bun.sleep(20);
		// Disposal owns the real lookup instead of racing past it: neither settles before the lookup does.
		expect(settled).toBe(false);
		expect(disposed).toBe(false);
		credential.resolve(MAIN_KEY);
		await disposal;
		expect(await outcome).toBeInstanceOf(Error);
		expect(harness.requests).toHaveLength(1);
	});

	it("scrubs a released scope after cancelling its prefix request and refuses to reuse it", async () => {
		const harness = createHarness();
		await harness.runMain();
		const sideHold = held();
		harness.queue.push(sideHold.responder);
		const scope = harness.session.createBtwConversationScope(SIDE_INSTRUCTION);
		const controller = new AbortController();
		const side = harness.runSide("late answer", { signal: controller.signal }, scope);
		const sideOutcome = side.then(
			() => undefined,
			(error: unknown) => error,
		);
		for (let i = 0; i < 50 && harness.requests.length < 2; i++) await Bun.sleep(5);
		expect(harness.requests).toHaveLength(2);
		expect(hasTools(harness.requests[1])).toBe(true);

		controller.abort();
		harness.session.releaseBtwConversationScope(scope);
		expect(await sideOutcome).toBeInstanceOf(Error);
		expect(scope.messages).toEqual([]);
		expect(scope.systemPrompt).toEqual([]);
		await expect(harness.runSide("reuse scrubbed scope", {}, scope)).rejects.toThrow("scrubbed");
		expect(harness.requests).toHaveLength(2);
	});
});
