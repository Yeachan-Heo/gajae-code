import { afterEach, describe, expect, it, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import { enrichModelThinking } from "@gajae-code/ai/model-thinking";
import {
	createCodexStreamProgressClassifier,
	getOpenAICodexTransportDetails,
	getOpenAICodexWebSocketDebugStats,
	prewarmOpenAICodexResponses,
	streamOpenAICodexResponses,
} from "@gajae-code/ai/providers/openai-codex-responses";
import type { AssistantMessageEvent, Context, Model, ProviderSessionState, Tool } from "@gajae-code/ai/types";
import { getAgentDir, logger, setAgentDir, TempDir } from "@gajae-code/utils";
import { classifyFallbackTrigger } from "../src/utils/fallback-transport";

const RAW_SENTINEL = "RAW_SENTINEL_DO_NOT_SURFACE";
const SUMMARY_SENTINEL = "SUMMARY_SENTINEL_SAFE_TO_SURFACE";

const originalFetch = global.fetch;
const originalAgentDir = getAgentDir();
const originalWebSocket = global.WebSocket;
const originalCodexWebSocketRetryBudget = Bun.env.PI_CODEX_WEBSOCKET_RETRY_BUDGET;
const originalCodexWebSocketRetryDelayMs = Bun.env.PI_CODEX_WEBSOCKET_RETRY_DELAY_MS;
const originalCodexWebSocketIdleTimeoutMs = Bun.env.PI_CODEX_WEBSOCKET_IDLE_TIMEOUT_MS;
const originalStreamIdleTimeoutMs = Bun.env.GJC_OPENAI_STREAM_IDLE_TIMEOUT_MS;

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete Bun.env[name];
		return;
	}
	Bun.env[name] = value;
}

afterEach(() => {
	global.fetch = originalFetch;
	global.WebSocket = originalWebSocket;
	setAgentDir(originalAgentDir);
	restoreEnv("PI_CODEX_WEBSOCKET_RETRY_BUDGET", originalCodexWebSocketRetryBudget);
	restoreEnv("PI_CODEX_WEBSOCKET_RETRY_DELAY_MS", originalCodexWebSocketRetryDelayMs);
	restoreEnv("PI_CODEX_WEBSOCKET_IDLE_TIMEOUT_MS", originalCodexWebSocketIdleTimeoutMs);
	restoreEnv("GJC_OPENAI_STREAM_IDLE_TIMEOUT_MS", originalStreamIdleTimeoutMs);
	vi.restoreAllMocks();
});

function createCodexTestToken(accountId = "acc_test"): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
		"utf8",
	).toBase64();
	return `aaa.${payload}.bbb`;
}

function createCodexTestModel(baseUrl?: string): Model<"openai-codex-responses"> {
	return {
		id: "gpt-5.3-codex-spark",
		name: "GPT-5.3 Codex Spark",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: baseUrl ?? "",
		reasoning: true,
		preferWebsockets: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 128000,
	};
}

function createCodexTestContext(): Context {
	return {
		systemPrompt: ["You are a helpful assistant."],
		messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
	};
}

function createCompletedCodexSse(text: string): string {
	return `${[
		`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
		`data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}`,
		`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text }] } })}`,
		`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
	].join("\n\n")}\n\n`;
}

function createCodexErrorSse(events: Record<string, unknown>[]): string {
	return `${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
}

function createProductionCodexToolCallEvents(nestedError: boolean): Record<string, unknown>[] {
	const argumentsValue = JSON.stringify({ ops: [{ op: "init", phases: [] }] });
	const error = {
		code: "request_timeout",
		message:
			"stream error: stream disconnected before completion: stream closed before response.completed (code=request_timeout)",
	};
	return [
		{ type: "response.created", response: { id: "resp_production", status: "in_progress" } },
		{
			type: "response.output_item.added",
			item: {
				type: "reasoning",
				id: "rs_production",
				content: [],
				summary: [],
				encrypted_content: "encrypted-reasoning",
			},
		},
		{
			type: "response.output_item.done",
			item: {
				type: "reasoning",
				id: "rs_production",
				content: [],
				summary: [],
				encrypted_content: "encrypted-reasoning",
			},
		},
		{
			type: "response.output_item.added",
			item: {
				type: "function_call",
				id: "fc_production",
				call_id: "call_production",
				name: "todo_write",
				arguments: "",
			},
		},
		{ type: "response.function_call_arguments.delta", item_id: "fc_production", delta: argumentsValue },
		{ type: "response.function_call_arguments.done", item_id: "fc_production", arguments: argumentsValue },
		{
			type: "response.output_item.done",
			item: {
				type: "function_call",
				id: "fc_production",
				call_id: "call_production",
				name: "todo_write",
				arguments: argumentsValue,
			},
		},
		nestedError ? { type: "error", error } : { type: "error", ...error },
	];
}

type CompleteToolTimeoutReplayVariant = {
	argumentsDone: boolean;
	outputItemDone: boolean;
	newItem: "none" | "message" | "reasoning";
	correlateDelta: boolean;
};

function createCompleteToolTimeoutReplayEvents(variant: CompleteToolTimeoutReplayVariant): Record<string, unknown>[] {
	const argumentsValue = JSON.stringify({ ops: [] });
	const functionCall = {
		type: "function_call",
		id: "fc_variant",
		call_id: "call_variant",
		name: "todo_write",
		arguments: "",
	};
	const events: Record<string, unknown>[] = [
		{
			type: "response.output_item.added",
			output_index: 0,
			item: {
				type: "reasoning",
				id: "rs_before_call",
				content: [],
				summary: [],
			},
		},
		{
			type: "response.output_item.done",
			output_index: 0,
			item: {
				type: "reasoning",
				id: "rs_before_call",
				content: [],
				summary: [],
			},
		},
		{
			type: "response.output_item.added",
			output_index: 1,
			item: functionCall,
		},
		{
			type: "response.function_call_arguments.delta",
			...(variant.correlateDelta ? { item_id: "fc_variant", output_index: 1 } : {}),
			delta: argumentsValue,
		},
	];
	if (variant.argumentsDone) {
		events.push({
			type: "response.function_call_arguments.done",
			...(variant.correlateDelta ? { item_id: "fc_variant", output_index: 1 } : {}),
			arguments: argumentsValue,
		});
	}
	if (variant.outputItemDone) {
		events.push({
			type: "response.output_item.done",
			output_index: 1,
			item: {
				...functionCall,
				arguments: argumentsValue,
			},
		});
	}
	if (variant.newItem !== "none") {
		events.push({
			type: "response.output_item.added",
			output_index: 2,
			item:
				variant.newItem === "message"
					? {
							type: "message",
							id: "msg_after_call",
							role: "assistant",
							content: [],
						}
					: {
							type: "reasoning",
							id: "rs_after_call",
							content: [],
							summary: [],
						},
		});
	}
	events.push({
		type: "error",
		code: "request_timeout",
		message: "stream disconnected before completion: stream closed before response.completed (code=request_timeout)",
	});
	return events;
}

function getRequestSignal(input: string | URL | Request, init: RequestInit | undefined): AbortSignal | undefined {
	if (init?.signal) return init.signal;
	if (input instanceof Request) return input.signal;
	return undefined;
}

function createMalformedDeltaCodexSse(signal: AbortSignal | undefined): Response {
	const encoder = new TextEncoder();
	let interval: NodeJS.Timeout | undefined;
	let abortListener: (() => void) | undefined;
	const encode = (event: unknown): Uint8Array => encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(
				encode({
					type: "response.output_item.added",
					item: {
						type: "message",
						id: "msg_stalled",
						role: "assistant",
						status: "in_progress",
						content: [],
					},
				}),
			);
			controller.enqueue(encode({ type: "response.content_part.added", part: { type: "output_text", text: "" } }));
			const malformedDeltas: unknown[] = [42, undefined, ""];
			let malformedDeltaIndex = 0;
			interval = setInterval(() => {
				controller.enqueue(
					encode({
						type: "response.output_text.delta",
						item_id: "msg_stalled",
						output_index: 0,
						delta: malformedDeltas[malformedDeltaIndex++ % malformedDeltas.length],
					}),
				);
			}, 2);
			abortListener = () => {
				if (interval) clearInterval(interval);
				if (abortListener) signal?.removeEventListener("abort", abortListener);
				const reason = signal?.reason;
				controller.error(reason instanceof Error ? reason : new Error("request aborted"));
			};
			if (signal?.aborted) {
				queueMicrotask(() => abortListener?.());
			} else {
				signal?.addEventListener("abort", abortListener, { once: true });
			}
		},
		cancel() {
			if (interval) clearInterval(interval);
			if (abortListener) signal?.removeEventListener("abort", abortListener);
		},
	});
	return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function createTimedCodexSse(
	signal: AbortSignal | undefined,
	events: Record<string, unknown>[],
	intervalMs = 10,
	closeAfterEvents = true,
): Response {
	const encoder = new TextEncoder();
	let stopped = false;
	let abortListener: (() => void) | undefined;
	const encode = (event: Record<string, unknown>): Uint8Array => encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			abortListener = () => {
				stopped = true;
				controller.error(signal?.reason ?? new DOMException("request aborted", "AbortError"));
			};
			if (signal?.aborted) {
				abortListener();
				return;
			}
			signal?.addEventListener("abort", abortListener, { once: true });
			void (async () => {
				for (const event of events) {
					await Bun.sleep(intervalMs);
					if (stopped) return;
					controller.enqueue(encode(event));
				}
				if (closeAfterEvents && !stopped) controller.close();
			})().catch(error => {
				if (!stopped) controller.error(error);
			});
		},
		cancel() {
			stopped = true;
			if (abortListener) signal?.removeEventListener("abort", abortListener);
		},
	});
	return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function createSocketCloseCodexSse(signal: AbortSignal | undefined, events: Record<string, unknown>[]): Response {
	const encoder = new TextEncoder();
	let stopped = false;
	let abortListener: (() => void) | undefined;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			abortListener = () => {
				stopped = true;
				controller.error(signal?.reason ?? new DOMException("request aborted", "AbortError"));
			};
			if (signal?.aborted) {
				abortListener();
				return;
			}
			signal?.addEventListener("abort", abortListener, { once: true });
			void (async () => {
				for (const event of events) {
					await Bun.sleep(1);
					if (stopped) return;
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
				}
				if (stopped) return;
				const error = Object.assign(
					new Error(
						"The socket connection was closed unexpectedly (transport=ECONNRESET url=https://chatgpt.com/backend-api/codex/responses)",
					),
					{ code: "ECONNRESET" },
				);
				controller.error(error);
			})().catch(error => {
				if (!stopped) controller.error(error);
			});
		},
		cancel() {
			stopped = true;
			if (abortListener) signal?.removeEventListener("abort", abortListener);
		},
	});
	return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function encodeWebSocketMessage(value: Record<string, unknown>): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(value));
}

type WsHeaders = Record<string, string>;
type WsEventType = "open" | "message" | "error" | "close";

const DEFAULT_USAGE = {
	input_tokens: 5,
	output_tokens: 3,
	total_tokens: 8,
	input_tokens_details: { cached_tokens: 0 },
};

/**
 * Drop-in mock for the global `WebSocket` used by the OpenAI code backend websocket transport.
 *
 * Production code wires lifecycle handlers via `onopen`/`onmessage`/`onerror`/`onclose`
 * properties; tests drive the connection by calling `emit()`, `scheduleOpen()`,
 * `sendJson()`, or the `emitOpenAI code backendResponse()` convenience.
 */
class MockWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;

	readyState: number = MockWebSocket.CONNECTING;
	binaryType: "blob" | "arraybuffer" | "nodebuffer" = "blob";

	onopen: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onclose: ((event: Event) => void) | null = null;

	constructor(
		public readonly url: string,
		public readonly options?: { headers?: WsHeaders },
	) {}

	send(_data: string): void {}

	close(): void {
		this.readyState = MockWebSocket.CLOSED;
	}

	/** Dispatch an event to the matching `on{type}` handler. */
	emit(type: WsEventType, event: Event): void {
		const handler = (this as unknown as Record<string, unknown>)[`on${type}`];
		if (typeof handler === "function") (handler as (e: Event) => void).call(this, event);
	}

	/** Asynchronously transition to OPEN and emit `open`. */
	scheduleOpen(): void {
		setTimeout(() => {
			this.readyState = MockWebSocket.OPEN;
			this.emit("open", new Event("open"));
		}, 0);
	}

	/** Emit a message frame with arbitrary data. */
	sendMessage(data: unknown): void {
		this.emit("message", { data } as unknown as MessageEvent);
	}

	/** Emit a message frame with stringified-JSON data. */
	sendJson(payload: Record<string, unknown>): void {
		this.sendMessage(JSON.stringify(payload));
	}

	/** Emit the standard OpenAI code backend completed-response sequence. */
	emitCodexResponse(opts: {
		messageId: string;
		responseId: string;
		text: string;
		terminalType?: "response.done" | "response.completed";
		includeCreated?: boolean;
	}): void {
		const { messageId, responseId, text, terminalType = "response.done", includeCreated = false } = opts;
		if (includeCreated) {
			this.sendJson({ type: "response.created", response: { id: responseId } });
		}
		this.sendJson({
			type: "response.output_item.added",
			item: { type: "message", id: messageId, role: "assistant", status: "in_progress", content: [] },
		});
		this.sendJson({ type: "response.content_part.added", part: { type: "output_text", text: "" } });
		this.sendJson({ type: "response.output_text.delta", delta: text });
		this.sendJson({
			type: "response.output_item.done",
			item: {
				type: "message",
				id: messageId,
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text }],
			},
		});
		this.sendJson({
			type: terminalType,
			response: {
				id: responseId,
				status: "completed",
				usage: DEFAULT_USAGE,
			},
		});
	}
}

describe("openai-codex streaming", () => {
	it("normalizes Codex response endpoint base URLs", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const context = createCodexTestContext();
		const requestedUrls: string[] = [];
		const sse = createCompletedCodexSse("Hello");
		global.fetch = vi.fn(async (input: string | URL) => {
			requestedUrls.push(typeof input === "string" ? input : input.toString());
			return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
		}) as unknown as typeof fetch;

		for (const baseUrl of [
			undefined,
			"https://chatgpt.com/backend-api",
			"https://chatgpt.com/backend-api/codex",
			"https://chatgpt.com/backend-api/codex/responses",
		]) {
			const model = { ...createCodexTestModel(baseUrl), preferWebsockets: false };
			const result = await streamOpenAICodexResponses(model, context, { apiKey: token }).result();
			expect(result.stopReason).toBe("stop");
		}

		expect(requestedUrls).toEqual([
			"https://chatgpt.com/backend-api/codex/responses",
			"https://chatgpt.com/backend-api/codex/responses",
			"https://chatgpt.com/backend-api/codex/responses",
			"https://chatgpt.com/backend-api/codex/responses",
		]);
	});

	it("maps reserved tool wire names back to canonical tool names", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const sse = `${[
			`data: ${JSON.stringify({
				type: "response.output_item.added",
				item: {
					type: "function_call",
					id: "fc_1",
					call_id: "call_1",
					name: "computer_tool",
					arguments: "",
				},
			})}`,
			`data: ${JSON.stringify({
				type: "response.function_call_arguments.done",
				item_id: "fc_1",
				arguments: '{"action":"screenshot"}',
			})}`,
			`data: ${JSON.stringify({
				type: "response.output_item.done",
				item: {
					type: "function_call",
					id: "fc_1",
					call_id: "call_1",
					name: "computer_tool",
					arguments: '{"action":"screenshot"}',
				},
			})}`,
			`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed" } })}`,
		].join("\n\n")}\n\n`;
		global.fetch = vi.fn(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		) as unknown as typeof fetch;

		const model = { ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false };
		const result = await streamOpenAICodexResponses(model, createCodexTestContext(), { apiKey: token }).result();

		const toolCalls = result.content.filter(block => block.type === "toolCall");
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0]).toMatchObject({ name: "computer", arguments: { action: "screenshot" } });
	});

	it("salvages finalized function calls after a transient stream close", async () => {
		const warn = vi.spyOn(logger, "warn");
		const sse = createCodexErrorSse([
			{
				type: "response.output_item.added",
				item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "todo_write", arguments: "" },
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"ops":[]}' },
			{
				type: "response.output_item.done",
				item: {
					type: "function_call",
					id: "fc_1",
					call_id: "call_1",
					name: "todo_write",
					arguments: '{"ops":[]}',
				},
			},
			{
				type: "error",
				code: "request_timeout",
				message:
					"stream disconnected before completion: stream closed before response.completed (code=request_timeout)",
			},
		]);
		global.fetch = vi.fn(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		) as unknown as typeof fetch;

		const result = await streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken() },
		).result();

		expect(result.stopReason).toBe("toolUse");
		expect(result.errorCode).toBe("codex_stream_closed_after_finalized_tool_calls");
		expect(result.content).toEqual([
			{ type: "toolCall", id: "call_1|fc_1", name: "todo_write", arguments: { ops: [] } },
		]);
		expect(warn).not.toHaveBeenCalledWith("[codex] codex stream close salvage refused", expect.anything());
	});

	it("warns with bounded diagnostics when transient-close salvage is refused", async () => {
		const warn = vi.spyOn(logger, "warn");
		const sse = createCodexErrorSse([
			...Array.from({ length: 20 }, (_, index) => ({
				type: "diagnostic.replay",
				output_index: index,
				content: RAW_SENTINEL,
				arguments: RAW_SENTINEL,
				encrypted_content: RAW_SENTINEL,
				headers: { authorization: RAW_SENTINEL },
			})),
			{
				type: "response.output_item.added",
				output_index: 2,
				item: {
					type: "function_call",
					id: "fc_partial",
					call_id: "call_partial",
					name: "todo_write",
					arguments: "",
				},
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_partial", delta: '{"ops":' },
			{
				type: "error",
				code: "request_timeout",
				message:
					"stream disconnected before completion: stream closed before response.completed (code=request_timeout)",
			},
		]);
		global.fetch = vi.fn(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		) as unknown as typeof fetch;

		const result = await streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken(), disableProviderRetries: true },
		).result();

		const refusal = warn.mock.calls.find(([message]) => message === "[codex] codex stream close salvage refused");
		expect(result.stopReason).toBe("error");
		expect(refusal).toBeDefined();
		expect(refusal?.[1]).toMatchObject({
			canSalvageFinalizedCall: false,
			canSalvageCompleteArguments: false,
			finalizedToolCallIds: 0,
			contentBlockTypes: ["toolCall"],
			errorCode: "request_timeout",
			recentEvents: [
				...Array.from({ length: 13 }, (_, index) => ({
					type: "diagnostic.replay",
					itemType: null,
					itemId: null,
					outputIndex: index + 7,
					deltaLength: 0,
				})),
				{
					type: "response.output_item.added",
					itemType: "function_call",
					itemId: "fc_partial",
					outputIndex: 2,
					deltaLength: 0,
				},
				{
					type: "response.function_call_arguments.delta",
					itemType: null,
					itemId: "fc_partial",
					outputIndex: null,
					deltaLength: 7,
				},
				{ type: "error", itemType: null, itemId: null, outputIndex: null, deltaLength: 0 },
			],
		});
		expect(JSON.stringify(refusal)).not.toContain(RAW_SENTINEL);
		expect(JSON.stringify(refusal)).not.toContain('{"ops":');
		expect(
			warn.mock.calls.filter(([message]) => message === "[codex] codex stream close salvage refused"),
		).toHaveLength(1);
	});

	it("replays an incomplete tool call after a transient stream close", async () => {
		const partial = createCodexErrorSse([
			{ type: "response.output_item.added", item: { type: "reasoning", id: "rs_1", content: [], summary: [] } },
			{
				type: "response.output_item.added",
				item: {
					type: "function_call",
					id: "fc_partial",
					call_id: "call_partial",
					name: "todo_write",
					arguments: "",
				},
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_partial", delta: '{"ops":' },
			{
				type: "error",
				code: "request_timeout",
				message: "stream error: stream disconnected before completion: stream closed before response.completed",
			},
		]);
		const complete = createCodexErrorSse([
			{
				type: "response.output_item.added",
				item: { type: "function_call", id: "fc_2", call_id: "call_2", name: "todo_write", arguments: "" },
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_2", delta: '{"ops":[]}' },
			{
				type: "response.output_item.done",
				item: { type: "function_call", id: "fc_2", call_id: "call_2", name: "todo_write", arguments: '{"ops":[]}' },
			},
			{ type: "response.completed", response: { status: "completed", usage: DEFAULT_USAGE } },
		]);
		let requestCount = 0;
		global.fetch = vi.fn(async () => {
			requestCount += 1;
			return new Response(requestCount === 1 ? partial : complete, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}) as unknown as typeof fetch;

		const result = await streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken() },
		).result();

		expect(requestCount).toBe(2);
		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toEqual([
			{ type: "toolCall", id: "call_2|fc_2", name: "todo_write", arguments: { ops: [] } },
		]);
	});

	it("replays an incomplete tool call after an ECONNRESET socket close", async () => {
		const partial = [
			{ type: "response.output_item.added", item: { type: "reasoning", id: "rs_socket", content: [], summary: [] } },
			{
				type: "response.output_item.added",
				item: { type: "function_call", id: "fc_socket", call_id: "call_socket", name: "todo_write", arguments: "" },
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_socket", delta: '{"ops":' },
		];
		const complete = createCodexErrorSse([
			{
				type: "response.output_item.added",
				item: {
					type: "function_call",
					id: "fc_socket_2",
					call_id: "call_socket_2",
					name: "todo_write",
					arguments: "",
				},
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_socket_2", delta: '{"ops":[]}' },
			{
				type: "response.output_item.done",
				item: {
					type: "function_call",
					id: "fc_socket_2",
					call_id: "call_socket_2",
					name: "todo_write",
					arguments: '{"ops":[]}',
				},
			},
			{ type: "response.completed", response: { status: "completed", usage: DEFAULT_USAGE } },
		]);
		let requestCount = 0;
		global.fetch = vi.fn(async (_input, init) => {
			requestCount += 1;
			if (requestCount === 1) return createSocketCloseCodexSse(getRequestSignal(_input, init), partial);
			return new Response(complete, { status: 200, headers: { "content-type": "text/event-stream" } });
		}) as unknown as typeof fetch;

		const result = await streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken() },
		).result();

		expect(requestCount).toBe(2);
		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toEqual([
			{ type: "toolCall", id: "call_socket_2|fc_socket_2", name: "todo_write", arguments: { ops: [] } },
		]);
	});

	it("does not replay a released partial call after a timeout retry", async () => {
		const firstPartial = [
			{
				type: "response.output_item.added",
				item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "old_tool", arguments: "" },
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"old":' },
		];
		const secondTimeout = createCodexErrorSse([
			{
				type: "response.output_item.added",
				item: { type: "function_call", id: "fc_2", call_id: "call_2", name: "old_tool", arguments: "" },
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_2", delta: '{"old":' },
			{ type: "error", code: "request_timeout", message: "stream closed before response.completed" },
		]);
		let requestCount = 0;
		global.fetch = vi.fn(async (_input, _init) => {
			requestCount += 1;
			if (requestCount === 1) return createSocketCloseCodexSse(undefined, firstPartial);
			return new Response(secondTimeout, { status: 200, headers: { "content-type": "text/event-stream" } });
		}) as unknown as typeof fetch;
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		const stream = streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken() },
		);
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();

		expect(requestCount).toBe(2);
		expect(result.stopReason).toBe("error");
		expect(events.filter(event => event.type === "toolcall_start")).toHaveLength(1);
	});

	it("does not replay a partial call after timeout retry consumes the replay", async () => {
		const firstTimeout = createCodexErrorSse([
			{
				type: "response.output_item.added",
				item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "old_tool", arguments: "" },
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"old":' },
			{ type: "error", code: "request_timeout", message: "stream closed before response.completed" },
		]);
		const secondPartial = [
			{
				type: "response.output_item.added",
				item: { type: "function_call", id: "fc_2", call_id: "call_2", name: "old_tool", arguments: "" },
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_2", delta: '{"old":' },
		];
		let requestCount = 0;
		global.fetch = vi.fn(async (_input, _init) => {
			requestCount += 1;
			if (requestCount === 1) {
				return new Response(firstTimeout, { status: 200, headers: { "content-type": "text/event-stream" } });
			}
			return createSocketCloseCodexSse(undefined, secondPartial);
		}) as unknown as typeof fetch;
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		const stream = streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken() },
		);
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();

		expect(requestCount).toBe(2);
		expect(result.stopReason).toBe("error");
		expect(events.filter(event => event.type === "toolcall_start")).toHaveLength(1);
	});

	it("does not replay an ECONNRESET socket close after visible text", async () => {
		const partial = [
			{
				type: "response.output_item.added",
				item: { type: "message", id: "msg_socket", role: "assistant", content: [] },
			},
			{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
			{ type: "response.output_text.delta", delta: "Already emitted" },
			{
				type: "response.output_item.added",
				item: { type: "function_call", id: "fc_socket", call_id: "call_socket", name: "todo_write", arguments: "" },
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_socket", delta: '{"ops":' },
		];
		const fetchMock = vi.fn(async (_input, init) =>
			createSocketCloseCodexSse(getRequestSignal(_input, init), partial),
		);
		global.fetch = fetchMock as unknown as typeof fetch;

		const result = await streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken() },
		).result();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.stopReason).toBe("error");
	});

	it.each([
		{ label: "provider retries disabled", options: { disableProviderRetries: true } },
		{ label: "a second socket close", options: {} },
	])("does not replay an ECONNRESET socket close when $label", async ({ options }) => {
		const partial = [
			{ type: "response.output_item.added", item: { type: "reasoning", id: "rs_socket", content: [], summary: [] } },
			{
				type: "response.output_item.added",
				item: { type: "function_call", id: "fc_socket", call_id: "call_socket", name: "todo_write", arguments: "" },
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_socket", delta: '{"ops":' },
		];
		let requestCount = 0;
		const fetchMock = vi.fn(async (_input, init) => {
			requestCount += 1;
			return createSocketCloseCodexSse(getRequestSignal(_input, init), partial);
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		const result = await streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken(), ...options },
		).result();

		expect(requestCount).toBe(options.disableProviderRetries ? 1 : 2);
		expect(result.stopReason).toBe("error");
	});

	it.each([
		{ label: "retries disabled", options: { disableProviderRetries: true } },
		{ label: "non-empty text emitted", options: {} },
	])("does not replay an incomplete tool call when $label", async ({ options }) => {
		const events: Record<string, unknown>[] = [
			...(options.disableProviderRetries
				? []
				: [
						{
							type: "response.output_item.added",
							item: { type: "message", id: "msg_1", role: "assistant", content: [] },
						},
						{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
						{ type: "response.output_text.delta", delta: "Already emitted" },
					]),
			{
				type: "response.output_item.added",
				item: {
					type: "function_call",
					id: "fc_partial",
					call_id: "call_partial",
					name: "todo_write",
					arguments: "",
				},
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_partial", delta: '{"ops":' },
			{
				type: "error",
				code: "request_timeout",
				message: "stream error: stream disconnected before completion: stream closed before response.completed",
			},
		];
		const fetchMock = vi.fn(
			async () =>
				new Response(createCodexErrorSse(events), {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
		);
		global.fetch = fetchMock as unknown as typeof fetch;

		const result = await streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken(), ...options },
		).result();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.stopReason).toBe("error");
	});

	it("keeps salvage refusal debug-only for non-transient stream errors", async () => {
		const warn = vi.spyOn(logger, "warn");
		const sse = createCodexErrorSse([
			{
				type: "response.output_item.added",
				item: {
					type: "function_call",
					id: "fc_invalid",
					call_id: "call_invalid",
					name: "todo_write",
					arguments: "",
				},
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_invalid", delta: '{"ops":' },
			{ type: "error", code: "invalid_request_error", message: "invalid request" },
		]);
		global.fetch = vi.fn(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		) as unknown as typeof fetch;

		await streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken(), disableProviderRetries: true },
		).result();

		expect(
			warn.mock.calls.filter(([message]) => message === "[codex] codex stream close salvage refused"),
		).toHaveLength(0);
	});

	it.each([
		false,
		true,
	])("salvages the production request_timeout replay over SSE (nested error: %s)", async nestedError => {
		global.fetch = vi.fn(
			async () =>
				new Response(createCodexErrorSse(createProductionCodexToolCallEvents(nestedError)), {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
		) as unknown as typeof fetch;

		const result = await streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken() },
		).result();

		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toContainEqual({
			type: "toolCall",
			id: "call_production|fc_production",
			name: "todo_write",
			arguments: { ops: [{ op: "init", phases: [] }] },
		});
	});

	it.each(
		(["none", "message", "reasoning"] as const).flatMap(newItem =>
			[false, true].flatMap(argumentsDone =>
				[false, true].flatMap(outputItemDone =>
					[false, true].map(correlateDelta => ({
						argumentsDone,
						outputItemDone,
						newItem,
						correlateDelta,
					})),
				),
			),
		),
	)("salvages complete todo_write arguments across replay variants (%j)", async (variant: CompleteToolTimeoutReplayVariant) => {
		const sse = createCodexErrorSse(createCompleteToolTimeoutReplayEvents(variant));
		global.fetch = vi.fn(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		) as unknown as typeof fetch;

		const result = await streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken() },
		).result();

		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toContainEqual({
			type: "toolCall",
			id: "call_variant|fc_variant",
			name: "todo_write",
			arguments: { ops: [] },
		});
	});

	it.each([
		false,
		true,
	])("salvages the production request_timeout replay over websocket (nested error: %s)", async nestedError => {
		class ProductionReplayWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			send(): void {
				for (const event of createProductionCodexToolCallEvents(nestedError)) this.sendJson(event);
			}
		}
		global.WebSocket = ProductionReplayWebSocket as unknown as typeof WebSocket;
		global.fetch = vi.fn() as unknown as typeof fetch;

		const result = await streamOpenAICodexResponses(
			createCodexTestModel("https://chatgpt.com/backend-api"),
			createCodexTestContext(),
			{
				apiKey: createCodexTestToken(),
				sessionId: `production-replay-${nestedError}`,
				streamIdleTimeoutMs: 100,
				providerSessionState: new Map<string, ProviderSessionState>(),
			},
		).result();

		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toContainEqual({
			type: "toolCall",
			id: "call_production|fc_production",
			name: "todo_write",
			arguments: { ops: [{ op: "init", phases: [] }] },
		});
	});

	it("salvages a complete todo_write snapshot after a later reasoning item opens", async () => {
		const sse = createCodexErrorSse([
			{
				type: "response.output_item.added",
				item: { type: "reasoning", id: "rs_production", summary: [] },
			},
			{
				type: "response.output_item.done",
				item: { type: "reasoning", id: "rs_production", summary: [] },
			},
			{
				type: "response.output_item.added",
				item: {
					type: "function_call",
					id: "fc_production",
					call_id: "call_production",
					name: "todo_write",
					arguments: '{"ops":[]}',
				},
			},
			{
				type: "response.output_item.added",
				item: { type: "reasoning", id: "rs_after_call", summary: [] },
			},
			{
				type: "error",
				code: "request_timeout",
				message:
					"stream error: stream disconnected before completion: stream closed before response.completed (code=request_timeout)",
			},
		]);
		global.fetch = vi.fn(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		) as unknown as typeof fetch;

		const result = await streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken() },
		).result();

		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toContainEqual({
			type: "toolCall",
			id: "call_production|fc_production",
			name: "todo_write",
			arguments: { ops: [] },
		});
	});

	it.each([
		["empty message item", []],
		["non-empty message item", [{ type: "output_text", text: "visible text" }]],
	])("handles a later %s after a finalized todo_write call", async (_label, content) => {
		const sse = createCodexErrorSse([
			{
				type: "response.output_item.added",
				output_index: 0,
				item: {
					type: "reasoning",
					id: "rs_0d4a2e17e5cd3232016ac0dd08c6a487d0bb045aa97bfa8b58",
					summary: [],
					encrypted_content: "encrypted",
				},
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "reasoning",
					id: "rs_0d4a2e17e5cd3232016ac0dd08c6a487d0bb045aa97bfa8b58",
					summary: [],
					encrypted_content: "encrypted",
				},
			},
			{
				type: "response.output_item.added",
				output_index: 1,
				item: {
					type: "function_call",
					id: "fc_0d4a2e17e5cd3232016ac0dd08c6a487d0bb045aa97bfa8b58",
					call_id: "call_1Oy7wVQBglbUc9rgt73OWP8l",
					name: "todo_write",
					arguments: '{"ops":[]}',
				},
			},
			{
				type: "response.output_item.done",
				output_index: 1,
				item: {
					type: "function_call",
					id: "fc_0d4a2e17e5cd3232016ac0dd08c6a487d0bb045aa97bfa8b58",
					call_id: "call_1Oy7wVQBglbUc9rgt73OWP8l",
					name: "todo_write",
					arguments: '{"ops":[]}',
				},
			},
			{
				type: "response.output_item.added",
				output_index: 2,
				item: {
					type: "message",
					id: "msg_after_call",
					role: "assistant",
					content,
				},
			},
			{
				type: "error",
				error: {
					type: "request_timeout",
					code: "request_timeout",
					message:
						"stream error: stream disconnected before completion: stream closed before response.completed (code=request_timeout)",
				},
			},
		]);
		global.fetch = vi.fn(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		) as unknown as typeof fetch;

		const result = await streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken() },
		).result();

		if (content.length === 0) {
			expect(result.stopReason).toBe("toolUse");
			expect(result.content).toContainEqual({
				type: "toolCall",
				id: "call_1Oy7wVQBglbUc9rgt73OWP8l|fc_0d4a2e17e5cd3232016ac0dd08c6a487d0bb045aa97bfa8b58",
				name: "todo_write",
				arguments: { ops: [] },
			});
		} else {
			expect(result.stopReason).toBe("error");
		}
	});

	it.each([
		"finalized",
		"unfinished",
		"visible text",
	])("handles EOF without response.completed after a %s tool call", async state => {
		const item = {
			type: "function_call",
			id: "fc_eof",
			call_id: "call_eof",
			name: "todo_write",
			arguments: '{"ops":[]}',
		};
		const events: Record<string, unknown>[] = [{ type: "response.output_item.added", output_index: 0, item }];
		if (state !== "unfinished") {
			events.push({ type: "response.output_item.done", output_index: 0, item });
		}
		events.push({
			type: "response.output_item.added",
			output_index: 1,
			item: {
				type: "message",
				id: "msg_eof",
				role: "assistant",
				content: state === "visible text" ? [{ type: "output_text", text: "visible" }] : [],
			},
		});
		const fetchMock = vi.fn(
			async () =>
				new Response(createCodexErrorSse(events), {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
		);
		global.fetch = fetchMock as unknown as typeof fetch;
		const result = await streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken() },
		).result();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.stopReason).toBe(state === "finalized" ? "toolUse" : "error");
		if (state === "finalized") {
			expect(result.errorCode).toBe("codex_stream_closed_after_finalized_tool_calls");
			expect(result.providerPayload).toMatchObject({
				items: [{ ...item }],
			});
			expect(result.content).toContainEqual({
				type: "toolCall",
				id: "call_eof|fc_eof",
				name: "todo_write",
				arguments: { ops: [] },
			});
		}
	});

	it("fails closed when a complete tool call has no source item id", async () => {
		const sse = createCodexErrorSse([
			{
				type: "response.output_item.added",
				item: { type: "function_call", call_id: "call_missing_item_id", name: "todo_write", arguments: "" },
			},
			{ type: "response.function_call_arguments.delta", delta: '{"ops":[]}' },
			{
				type: "error",
				code: "request_timeout",
				message:
					"stream disconnected before completion: stream closed before response.completed (code=request_timeout)",
			},
		]);
		global.fetch = vi.fn(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		) as unknown as typeof fetch;

		const stream = streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken() },
		);
		const events = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(events.filter(event => event.type === "toolcall_end")).toHaveLength(0);
	});

	it("preserves reserved Codex wire names in salvaged history", async () => {
		const sse = createCodexErrorSse([
			{
				type: "response.output_item.added",
				item: {
					type: "function_call",
					id: "fc_browser",
					call_id: "call_browser",
					name: "browser_tool",
					arguments: "",
				},
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_browser", delta: '{"query":"status"}' },
			{
				type: "response.output_item.added",
				item: { type: "reasoning", id: "rs_after_browser", summary: [] },
			},
			{
				type: "error",
				code: "request_timeout",
				message:
					"stream disconnected before completion: stream closed before response.completed (code=request_timeout)",
			},
		]);
		global.fetch = vi.fn(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		) as unknown as typeof fetch;

		const result = await streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken() },
		).result();

		const historyItems = (result.providerPayload as { items?: Array<Record<string, unknown>> }).items ?? [];
		expect(historyItems).toContainEqual(
			expect.objectContaining({ type: "function_call", name: "browser_tool", call_id: "call_browser" }),
		);
	});

	it("preserves stream order when reasoning completes before salvage", async () => {
		const sse = createCodexErrorSse([
			{
				type: "response.output_item.added",
				output_index: 0,
				item: {
					type: "function_call",
					id: "fc_ordered",
					call_id: "call_ordered",
					name: "todo_write",
					arguments: "",
				},
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_ordered", delta: '{"ops":[]}' },
			{
				type: "response.output_item.added",
				output_index: 1,
				item: { type: "reasoning", id: "rs_ordered", summary: [] },
			},
			{
				type: "response.output_item.done",
				output_index: 1,
				item: { type: "reasoning", id: "rs_ordered", summary: [] },
			},
			{
				type: "error",
				code: "request_timeout",
				message:
					"stream disconnected before completion: stream closed before response.completed (code=request_timeout)",
			},
		]);
		global.fetch = vi.fn(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		) as unknown as typeof fetch;

		const result = await streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken() },
		).result();

		const historyItems = (result.providerPayload as { items?: Array<Record<string, unknown>> }).items ?? [];
		expect(historyItems.map(item => item.type)).toEqual(["function_call", "reasoning"]);
	});

	it("rejects all salvage when one complete call is unreconstructable", async () => {
		const sse = createCodexErrorSse([
			{
				type: "response.output_item.added",
				item: { type: "function_call", id: "fc_valid", call_id: "call_valid", name: "todo_write", arguments: "" },
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_valid", delta: '{"ops":[]}' },
			{
				type: "response.output_item.added",
				item: { type: "function_call", call_id: "call_missing_id", name: "todo_write", arguments: "" },
			},
			{ type: "response.function_call_arguments.delta", delta: '{"ops":[]}' },
			{
				type: "error",
				code: "request_timeout",
				message:
					"stream disconnected before completion: stream closed before response.completed (code=request_timeout)",
			},
		]);
		global.fetch = vi.fn(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		) as unknown as typeof fetch;

		const result = await streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken() },
		).result();

		expect(result.stopReason).toBe("error");
		expect(result.content.filter(block => block.type === "toolCall")).toHaveLength(2);
	});

	it("keeps a complete tool call when transient close omits output_item.done", async () => {
		const sse = createCodexErrorSse([
			{
				type: "response.output_item.added",
				item: {
					type: "function_call",
					id: "fc_unfinalized",
					call_id: "call_unfinalized",
					name: "todo_write",
					arguments: "",
				},
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_unfinalized", delta: '{"ops":[]}' },
			{
				type: "error",
				code: "request_timeout",
				message:
					"stream disconnected before completion: stream closed before response.completed (code=request_timeout)",
			},
		]);
		global.fetch = vi.fn(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		) as unknown as typeof fetch;

		const result = await streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken() },
		).result();

		expect(result.stopReason).toBe("toolUse");
		expect(result.errorCode).toBe("codex_stream_closed_after_complete_tool_arguments");
		expect(result.content).toEqual([
			{ type: "toolCall", id: "call_unfinalized|fc_unfinalized", name: "todo_write", arguments: { ops: [] } },
		]);
	});

	it("salvages arguments provided only by the initial output item snapshot", async () => {
		const sse = createCodexErrorSse([
			{
				type: "response.output_item.added",
				item: {
					type: "function_call",
					id: "fc_snapshot",
					call_id: "call_snapshot",
					name: "job",
					arguments: '{"cancel":["job-1"]}',
				},
			},
			{
				type: "error",
				code: "request_timeout",
				message:
					"stream disconnected before completion: stream closed before response.completed (code=request_timeout)",
			},
		]);
		global.fetch = vi.fn(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		) as unknown as typeof fetch;

		const result = await streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken() },
		).result();

		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toEqual([
			{ type: "toolCall", id: "call_snapshot|fc_snapshot", name: "job", arguments: { cancel: ["job-1"] } },
		]);
	});

	it("refuses to salvage a placeholder initial argument snapshot", async () => {
		const sse = createCodexErrorSse([
			{
				type: "response.output_item.added",
				item: {
					type: "function_call",
					id: "fc_placeholder",
					call_id: "call_placeholder",
					name: "job",
					arguments: "{}",
				},
			},
			{
				type: "error",
				code: "request_timeout",
				message:
					"stream disconnected before completion: stream closed before response.completed (code=request_timeout)",
			},
		]);
		global.fetch = vi.fn(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		) as unknown as typeof fetch;

		const stream = streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken() },
		);
		const events = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(events.filter(event => event.type === "toolcall_end")).toHaveLength(0);
	});

	it("refuses to salvage when another returned tool call is unfinished", async () => {
		const sse = createCodexErrorSse([
			{
				type: "response.output_item.added",
				item: {
					type: "function_call",
					id: "fc_incomplete",
					call_id: "call_incomplete",
					name: "todo_write",
					arguments: "",
				},
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_incomplete", delta: '{"ops":[]' },
			{
				type: "response.output_item.added",
				item: {
					type: "function_call",
					id: "fc_complete",
					call_id: "call_complete",
					name: "todo_write",
					arguments: "",
				},
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_complete", delta: '{"ops":[]}' },
			{
				type: "error",
				code: "request_timeout",
				message:
					"stream disconnected before completion: stream closed before response.completed (code=request_timeout)",
			},
		]);
		global.fetch = vi.fn(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		) as unknown as typeof fetch;

		const result = await streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken() },
		).result();

		expect(result.stopReason).toBe("error");
		expect(result.content.filter(block => block.type === "toolCall")).toHaveLength(2);
	});

	it("salvages a complete tool call after an idle stall", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		global.fetch = ((input: string | URL | Request, init?: RequestInit) =>
			Promise.resolve(
				createTimedCodexSse(
					getRequestSignal(input, init),
					[
						{
							type: "response.output_item.added",
							item: {
								type: "function_call",
								id: "fc_idle_complete",
								call_id: "call_idle_complete",
								name: "todo_write",
								arguments: "",
							},
						},
						{
							type: "response.function_call_arguments.delta",
							item_id: "fc_idle_complete",
							delta: '{"ops":[]}',
						},
					],
					10,
					false,
				),
			)) as typeof fetch;

		const result = await streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken(), streamIdleTimeoutMs: 20 },
		).result();

		expect(result.stopReason).toBe("toolUse");
		expect(result.errorCode).toBe("codex_stream_closed_after_complete_tool_arguments");
		expect(result.content).toEqual([
			{ type: "toolCall", id: "call_idle_complete|fc_idle_complete", name: "todo_write", arguments: { ops: [] } },
		]);
	});

	it.each([
		["delta", { type: "response.function_call_arguments.delta", item_id: "fc_unknown", delta: '{"ops":[]}' }],
		["done", { type: "response.function_call_arguments.done", item_id: "fc_unknown", arguments: '{"ops":[]}' }],
	])("fails closed when a %s targets an unknown tool item", async (_label, argumentEvent) => {
		const sse = createCodexErrorSse([
			{
				type: "response.output_item.added",
				item: { type: "function_call", id: "fc_active", call_id: "call_active", name: "todo_write", arguments: "" },
			},
			argumentEvent,
			{
				type: "error",
				code: "request_timeout",
				message:
					"stream disconnected before completion: stream closed before response.completed (code=request_timeout)",
			},
		]);
		global.fetch = vi.fn(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		) as unknown as typeof fetch;
		const result = await streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken() },
		).result();
		expect(result.stopReason).toBe("error");
		expect(result.content.filter(block => block.type === "toolCall")).toHaveLength(1);
	});

	it("fails closed for an unknown-item argument delta during an idle stall", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-mismatch-idle-");
		setAgentDir(tempDir.path());
		global.fetch = ((input: string | URL | Request, init?: RequestInit) =>
			Promise.resolve(
				createTimedCodexSse(
					getRequestSignal(input, init),
					[
						{
							type: "response.output_item.added",
							item: {
								type: "function_call",
								id: "fc_active_idle",
								call_id: "call_active_idle",
								name: "todo_write",
								arguments: "",
							},
						},
						{ type: "response.function_call_arguments.delta", item_id: "fc_unknown_idle", delta: '{"ops":[]}' },
					],
					10,
					false,
				),
			)) as typeof fetch;
		const result = await streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken(), streamIdleTimeoutMs: 20 },
		).result();
		expect(result.stopReason).toBe("error");
	});

	it("still salvages an argument event whose item_id matches the active call", async () => {
		const sse = createCodexErrorSse([
			{
				type: "response.output_item.added",
				item: {
					type: "function_call",
					id: "fc_matching",
					call_id: "call_matching",
					name: "todo_write",
					arguments: "",
				},
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_matching", delta: '{"ops":[]}' },
			{
				type: "error",
				code: "request_timeout",
				message:
					"stream disconnected before completion: stream closed before response.completed (code=request_timeout)",
			},
		]);
		global.fetch = vi.fn(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		) as unknown as typeof fetch;
		const result = await streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken() },
		).result();
		expect(result.stopReason).toBe("toolUse");
	});

	it("does not salvage after a generic thrown stream error", async () => {
		const sse = createCodexErrorSse([
			{
				type: "response.output_item.added",
				item: { type: "function_call", id: "fc_throw", call_id: "call_throw", name: "todo_write", arguments: "" },
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_throw", delta: '{"ops":[]}' },
			{ type: "response.function_call_arguments.delta", item_id: "fc_throw", delta: 7 },
		]);
		global.fetch = vi.fn(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		) as unknown as typeof fetch;
		const streamResult = streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken() },
		);
		const events: Array<{ type: string }> = [];
		for await (const event of streamResult) events.push(event as { type: string });
		const result = await streamResult.result();
		expect(result.stopReason).toBe("error");
		expect(events.filter(event => event.type === "toolcall_end")).toHaveLength(0);
	});

	it("does not salvage after a mismatched item receives a late terminal acknowledgement", async () => {
		const sse = createCodexErrorSse([
			{
				type: "response.output_item.added",
				item: {
					type: "function_call",
					id: "fc_late_ack",
					call_id: "call_late_ack",
					name: "todo_write",
					arguments: "",
				},
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_unknown_late_ack", delta: '{"ops":[]}' },
			{
				type: "response.output_item.done",
				item: {
					type: "function_call",
					id: "fc_unknown_late_ack",
					call_id: "call_unknown_late_ack",
					name: "todo_write",
					arguments: '{"ops":[]}',
				},
			},
		]);
		global.fetch = vi.fn(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		) as unknown as typeof fetch;
		const result = await streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken() },
		).result();
		expect(result.stopReason).toBe("error");
	});

	it.each([
		"stream disconnected before completion: timed out (request_timeout)",
		"stream closed before response.completed (request_timeout)",
	])("does not salvage on an explicitly non-transient error code (%s)", async message => {
		const sse = createCodexErrorSse([
			{
				type: "response.output_item.added",
				item: {
					type: "function_call",
					id: "fc_typed_error",
					call_id: "call_typed_error",
					name: "todo_write",
					arguments: "",
				},
			},
			{ type: "response.function_call_arguments.done", item_id: "fc_typed_error", arguments: '{"ops":[]}' },
			{ type: "error", code: "invalid_request_error", message },
		]);
		global.fetch = vi.fn(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		) as unknown as typeof fetch;
		const result = await streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken() },
		).result();
		expect(result.stopReason).toBe("error");
		expect(result.content.filter(block => block.type === "toolCall")).toHaveLength(1);
	});

	it("still salvages timeout wording when no authoritative error code is present", async () => {
		const sse = createCodexErrorSse([
			{
				type: "response.output_item.added",
				item: {
					type: "function_call",
					id: "fc_untyped_error",
					call_id: "call_untyped_error",
					name: "todo_write",
					arguments: "",
				},
			},
			{ type: "response.function_call_arguments.done", item_id: "fc_untyped_error", arguments: '{"ops":[]}' },
			{ type: "error", message: "stream disconnected before completion: timed out (code=request_timeout)" },
		]);
		global.fetch = vi.fn(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		) as unknown as typeof fetch;
		const result = await streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken() },
		).result();
		expect(result.stopReason).toBe("toolUse");
	});

	it.each([" ", "\n"])("does not authenticate whitespace after an empty snapshot (%j)", async delta => {
		const sse = createCodexErrorSse([
			{
				type: "response.output_item.added",
				item: {
					type: "function_call",
					id: "fc_empty_snapshot",
					call_id: "call_empty_snapshot",
					name: "noop",
					arguments: "{}",
				},
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_empty_snapshot", delta },
			{
				type: "error",
				code: "request_timeout",
				message:
					"stream disconnected before completion: stream closed before response.completed (code=request_timeout)",
			},
		]);
		global.fetch = vi.fn(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		) as unknown as typeof fetch;
		const result = await streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken() },
		).result();
		expect(result.stopReason).toBe("error");
	});

	it("does not authenticate whitespace after an empty snapshot during an idle stall", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-empty-snapshot-idle-");
		setAgentDir(tempDir.path());
		global.fetch = ((input: string | URL | Request, init?: RequestInit) =>
			Promise.resolve(
				createTimedCodexSse(
					getRequestSignal(input, init),
					[
						{
							type: "response.output_item.added",
							item: {
								type: "function_call",
								id: "fc_empty_snapshot_idle",
								call_id: "call_empty_snapshot_idle",
								name: "noop",
								arguments: "{}",
							},
						},
						{ type: "response.function_call_arguments.delta", item_id: "fc_empty_snapshot_idle", delta: " " },
					],
					10,
					false,
				),
			)) as typeof fetch;
		const result = await streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken(), streamIdleTimeoutMs: 20 },
		).result();
		expect(result.stopReason).toBe("error");
	});

	it("closes an open thinking lifecycle before salvaging a finalized call", async () => {
		const sse = createCodexErrorSse([
			{
				type: "response.output_item.added",
				item: {
					type: "function_call",
					id: "fc_finalized_then_thinking",
					call_id: "call_finalized_then_thinking",
					name: "noop",
					arguments: "",
				},
			},
			{ type: "response.function_call_arguments.done", item_id: "fc_finalized_then_thinking", arguments: "{}" },
			{
				type: "response.output_item.done",
				item: {
					type: "function_call",
					id: "fc_finalized_then_thinking",
					call_id: "call_finalized_then_thinking",
					name: "noop",
					arguments: "{}",
				},
			},
			{ type: "response.output_item.added", item: { type: "reasoning", id: "reasoning_open", summary: [] } },
			{
				type: "error",
				code: "request_timeout",
				message:
					"stream disconnected before completion: stream closed before response.completed (code=request_timeout)",
			},
		]);
		global.fetch = vi.fn(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		) as unknown as typeof fetch;
		const events: Array<{ type: string }> = [];
		const streamResult = streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken() },
		);
		for await (const event of streamResult) events.push(event as { type: string });
		const result = await streamResult.result();
		expect(result.stopReason).toBe("toolUse");
		expect(events.findIndex(event => event.type === "thinking_end")).toBeGreaterThan(-1);
		expect(events.findIndex(event => event.type === "thinking_end")).toBeLessThan(
			events.findIndex(event => event.type === "done"),
		);
	});

	it("salvages an empty object from arguments.done after a transient close", async () => {
		const sse = createCodexErrorSse([
			{
				type: "response.output_item.added",
				item: {
					type: "function_call",
					id: "fc_empty_done",
					call_id: "call_empty_done",
					name: "noop",
					arguments: "",
				},
			},
			{ type: "response.function_call_arguments.done", item_id: "fc_empty_done", arguments: "{}" },
			{
				type: "error",
				code: "request_timeout",
				message:
					"stream disconnected before completion: stream closed before response.completed (code=request_timeout)",
			},
		]);
		global.fetch = vi.fn(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		) as unknown as typeof fetch;

		const result = await streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken() },
		).result();

		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toEqual([
			{ type: "toolCall", id: "call_empty_done|fc_empty_done", name: "noop", arguments: {} },
		]);
	});

	it("salvages an empty object from arguments.done after an idle stall", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-empty-done-idle-");
		setAgentDir(tempDir.path());
		global.fetch = ((input: string | URL | Request, init?: RequestInit) =>
			Promise.resolve(
				createTimedCodexSse(
					getRequestSignal(input, init),
					[
						{
							type: "response.output_item.added",
							item: {
								type: "function_call",
								id: "fc_empty_done_idle",
								call_id: "call_empty_done_idle",
								name: "noop",
								arguments: "",
							},
						},
						{
							type: "response.function_call_arguments.done",
							item_id: "fc_empty_done_idle",
							arguments: "{}",
						},
					],
					10,
					false,
				),
			)) as typeof fetch;

		const result = await streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken(), streamIdleTimeoutMs: 20 },
		).result();

		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toEqual([
			{
				type: "toolCall",
				id: "call_empty_done_idle|fc_empty_done_idle",
				name: "noop",
				arguments: {},
			},
		]);
	});

	it("salvages an empty object assembled from argument deltas", async () => {
		const sse = createCodexErrorSse([
			{
				type: "response.output_item.added",
				item: {
					type: "function_call",
					id: "fc_empty_delta",
					call_id: "call_empty_delta",
					name: "noop",
					arguments: "",
				},
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_empty_delta", delta: "{" },
			{ type: "response.function_call_arguments.delta", item_id: "fc_empty_delta", delta: "}" },
			{
				type: "error",
				code: "request_timeout",
				message:
					"stream disconnected before completion: stream closed before response.completed (code=request_timeout)",
			},
		]);
		global.fetch = vi.fn(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		) as unknown as typeof fetch;

		const result = await streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken() },
		).result();

		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toEqual([
			{ type: "toolCall", id: "call_empty_delta|fc_empty_delta", name: "noop", arguments: {} },
		]);
	});

	it("rejects an empty object when only the initial snapshot proves it", async () => {
		const sse = createCodexErrorSse([
			{
				type: "response.output_item.added",
				item: {
					type: "function_call",
					id: "fc_empty_snapshot",
					call_id: "call_empty_snapshot",
					name: "noop",
					arguments: "{}",
				},
			},
			{
				type: "error",
				code: "request_timeout",
				message:
					"stream disconnected before completion: stream closed before response.completed (code=request_timeout)",
			},
		]);
		global.fetch = vi.fn(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		) as unknown as typeof fetch;

		const result = await streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken() },
		).result();

		expect(result.stopReason).toBe("error");
	});

	it("rejects an empty object when the initial snapshot has no argument events", async () => {
		const sse = createCodexErrorSse([
			{
				type: "response.output_item.added",
				item: {
					type: "function_call",
					id: "fc_empty_missing",
					call_id: "call_empty_missing",
					name: "noop",
					arguments: "",
				},
			},
			{
				type: "error",
				code: "request_timeout",
				message:
					"stream disconnected before completion: stream closed before response.completed (code=request_timeout)",
			},
		]);
		global.fetch = vi.fn(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		) as unknown as typeof fetch;

		const result = await streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken() },
		).result();

		expect(result.stopReason).toBe("error");
	});

	it("rejects an authoritative empty object invalidated by a later delta", async () => {
		const sse = createCodexErrorSse([
			{
				type: "response.output_item.added",
				item: {
					type: "function_call",
					id: "fc_empty_invalidated",
					call_id: "call_empty_invalidated",
					name: "noop",
					arguments: "",
				},
			},
			{ type: "response.function_call_arguments.done", item_id: "fc_empty_invalidated", arguments: "{}" },
			{ type: "response.function_call_arguments.delta", item_id: "fc_empty_invalidated", delta: '{"later"' },
			{
				type: "error",
				code: "request_timeout",
				message:
					"stream disconnected before completion: stream closed before response.completed (code=request_timeout)",
			},
		]);
		global.fetch = vi.fn(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		) as unknown as typeof fetch;

		const result = await streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken() },
		).result();

		expect(result.stopReason).toBe("error");
	});

	it("salvages a finalized call and an active empty-object call together", async () => {
		const sse = createCodexErrorSse([
			{
				type: "response.output_item.added",
				item: {
					type: "function_call",
					id: "fc_finalized",
					call_id: "call_finalized",
					name: "first",
					arguments: "",
				},
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_finalized", delta: '{"ok":true}' },
			{
				type: "response.output_item.done",
				item: {
					type: "function_call",
					id: "fc_finalized",
					call_id: "call_finalized",
					name: "first",
					arguments: '{"ok":true}',
				},
			},
			{
				type: "response.output_item.added",
				item: {
					type: "function_call",
					id: "fc_empty_sibling",
					call_id: "call_empty_sibling",
					name: "second",
					arguments: "",
				},
			},
			{ type: "response.function_call_arguments.done", item_id: "fc_empty_sibling", arguments: "{}" },
			{
				type: "error",
				code: "request_timeout",
				message:
					"stream disconnected before completion: stream closed before response.completed (code=request_timeout)",
			},
		]);
		global.fetch = vi.fn(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		) as unknown as typeof fetch;

		const result = await streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken() },
		).result();

		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toEqual([
			{ type: "toolCall", id: "call_finalized|fc_finalized", name: "first", arguments: { ok: true } },
			{ type: "toolCall", id: "call_empty_sibling|fc_empty_sibling", name: "second", arguments: {} },
		]);
	});

	it("rejects an active empty-object call when an earlier call is unfinished", async () => {
		const sse = createCodexErrorSse([
			{
				type: "response.output_item.added",
				item: {
					type: "function_call",
					id: "fc_partial_sibling",
					call_id: "call_partial_sibling",
					name: "first",
					arguments: "",
				},
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_partial_sibling", delta: '{"partial":' },
			{
				type: "response.output_item.added",
				item: {
					type: "function_call",
					id: "fc_empty_active",
					call_id: "call_empty_active",
					name: "second",
					arguments: "",
				},
			},
			{ type: "response.function_call_arguments.done", item_id: "fc_empty_active", arguments: "{}" },
			{
				type: "error",
				code: "request_timeout",
				message:
					"stream disconnected before completion: stream closed before response.completed (code=request_timeout)",
			},
		]);
		global.fetch = vi.fn(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		) as unknown as typeof fetch;

		const result = await streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken() },
		).result();

		expect(result.stopReason).toBe("error");
	});

	it("does not salvage an empty object after a non-transient failure", async () => {
		const sse = createCodexErrorSse([
			{
				type: "response.output_item.added",
				item: {
					type: "function_call",
					id: "fc_empty_error",
					call_id: "call_empty_error",
					name: "noop",
					arguments: "",
				},
			},
			{ type: "response.function_call_arguments.done", item_id: "fc_empty_error", arguments: "{}" },
			{ type: "error", code: "invalid_request_error", message: "invalid request" },
		]);
		global.fetch = vi.fn(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		) as unknown as typeof fetch;

		const result = await streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken() },
		).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Codex error event: invalid request (code=invalid_request_error)");
	});

	it("preserves malformed Unicode evidence when salvaging after a transient close", async () => {
		const sse = createCodexErrorSse([
			{
				type: "response.output_item.added",
				item: {
					type: "function_call",
					id: "fc_unicode",
					call_id: "call_unicode",
					name: "todo_write",
					arguments: "",
				},
			},
			{
				type: "response.function_call_arguments.delta",
				item_id: "fc_unicode",
				delta: String.raw`{"value":"\uD800"}`,
			},
			{
				type: "error",
				code: "request_timeout",
				message:
					"stream disconnected before completion: stream closed before response.completed (code=request_timeout)",
			},
		]);
		global.fetch = vi.fn(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		) as unknown as typeof fetch;

		const result = await streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken() },
		).result();
		const [toolCall] = result.content.filter(block => block.type === "toolCall");

		expect(result.stopReason).toBe("toolUse");
		expect(toolCall?.arguments).toEqual({ value: String.fromCharCode(0xd800) });
		expect(toolCall?.escapedNonAsciiArguments).toBe(true);
		expect(toolCall?.escapedUnicodeArgumentEvidence).toMatchObject({ malformed: true });
		expect(JSON.stringify(toolCall)).not.toContain("escapedUnicodeArgumentEvidence");
	});

	it.each([
		[
			"unfinalized function call",
			[
				{
					type: "response.output_item.added",
					item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "todo_write", arguments: "" },
				},
				{ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"ops":' },
			],
		],
		[
			"non-transient failure",
			[
				{
					type: "response.output_item.added",
					item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "todo_write", arguments: "" },
				},
				{
					type: "response.output_item.done",
					item: {
						type: "function_call",
						id: "fc_1",
						call_id: "call_1",
						name: "todo_write",
						arguments: '{"ops":[]}',
					},
				},
			],
		],
		[
			"text-only partial",
			[
				{
					type: "response.output_item.added",
					item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
				},
				{ type: "response.output_text.delta", delta: "partial" },
			],
		],
	] as const)("keeps %s stream failures terminal", async (label, prefix) => {
		const error =
			label === "non-transient failure"
				? { type: "error", code: "invalid_request_error", message: "invalid request" }
				: {
						type: "error",
						code: "request_timeout",
						message:
							"stream disconnected before completion: stream closed before response.completed (code=request_timeout)",
					};
		const sse = createCodexErrorSse([...prefix, error]);
		global.fetch = vi.fn(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		) as unknown as typeof fetch;

		const result = await streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken() },
		).result();

		expect(result.stopReason).toBe("error");
	});

	it.each([
		[false, 2],
		[true, 1],
	])("uses one websocket request per managed connection-limit failure", async (fallbackManaged, expectedRequests) => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		let requests = 0;
		class ConnectionLimitWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}
			send(): void {
				requests += 1;
				if (requests === 1) {
					this.sendJson({
						type: "error",
						error: { code: "websocket_connection_limit_reached", message: "connection limit" },
					});
					return;
				}
				this.emitCodexResponse({
					messageId: "msg_reconnected",
					responseId: "resp_reconnected",
					text: "reconnected",
				});
			}
		}
		global.WebSocket = ConnectionLimitWebSocket as unknown as typeof WebSocket;
		const result = await streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: true },
			createCodexTestContext(),
			{
				apiKey: createCodexTestToken(),
				sessionId: `connection-limit-${fallbackManaged}`,
				preferWebsockets: true,
				fallbackManaged,
				providerSessionState: new Map<string, ProviderSessionState>(),
			},
		).result();
		expect(requests).toBe(expectedRequests);
		expect(result.stopReason).toBe(fallbackManaged ? "error" : "stop");
	});

	it("does not replay a managed websocket failure over SSE", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		let websocketRequests = 0;
		const fetchMock = vi.fn(async () => new Response(createCompletedCodexSse("unexpected replay"), { status: 200 }));
		global.fetch = fetchMock as unknown as typeof fetch;
		class BufferedCloseWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}
			send(): void {
				websocketRequests += 1;
				this.sendJson({
					type: "response.output_item.added",
					item: { type: "message", id: "partial", role: "assistant", status: "in_progress", content: [] },
				});
				this.sendJson({ type: "response.content_part.added", part: { type: "output_text", text: "" } });
				this.sendJson({ type: "response.output_text.delta", delta: "partial" });
				this.readyState = MockWebSocket.CLOSED;
				this.emit("close", { code: 1006 } as unknown as Event);
			}
		}
		global.WebSocket = BufferedCloseWebSocket as unknown as typeof WebSocket;
		const result = await streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: true },
			createCodexTestContext(),
			{
				apiKey: createCodexTestToken(),
				sessionId: "managed-sse-replay",
				preferWebsockets: true,
				fallbackManaged: true,
				providerSessionState: new Map<string, ProviderSessionState>(),
			},
		).result();
		expect(websocketRequests).toBe(1);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(result.stopReason).toBe("error");
	});

	it("times out SSE streams whose repeated malformed deltas are not semantic progress", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const context = createCodexTestContext();
		global.fetch = ((input: string | URL | Request, init?: RequestInit) =>
			Promise.resolve(createMalformedDeltaCodexSse(getRequestSignal(input, init)))) as typeof fetch;

		const model = { ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false };
		const result = await streamOpenAICodexResponses(model, context, {
			apiKey: token,
			streamIdleTimeoutMs: 20,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("OpenAI Codex SSE stream stalled while waiting for the next event");
		expect(result.content as unknown[]).toEqual([{ type: "text", text: "", textSignature: undefined }]);
	});

	it("treats trailing whitespace after complete tool arguments as non-progress", () => {
		const isProgress = createCodexStreamProgressClassifier();
		expect(
			isProgress({
				type: "response.output_item.added",
				output_index: 3,
				item: { type: "function_call", id: "fc_complete", arguments: "" },
			}),
		).toBe(true);
		expect(
			isProgress({ type: "response.function_call_arguments.delta", item_id: "fc_complete", delta: '{"ops":[]}' }),
		).toBe(true);
		expect(isProgress({ type: "response.function_call_arguments.delta", item_id: "fc_complete", delta: " \t" })).toBe(
			false,
		);
	});

	it("treats whitespace inside incomplete tool arguments as progress", () => {
		const isProgress = createCodexStreamProgressClassifier();
		expect(
			isProgress({
				type: "response.output_item.added",
				output_index: 4,
				item: { type: "function_call", id: "fc_incomplete", arguments: "" },
			}),
		).toBe(true);
		expect(
			isProgress({
				type: "response.function_call_arguments.delta",
				item_id: "fc_incomplete",
				delta: '{"ops":',
			}),
		).toBe(true);
		expect(
			isProgress({ type: "response.function_call_arguments.delta", item_id: "fc_incomplete", delta: " \t" }),
		).toBe(true);
	});

	it("treats whitespace after a malformed tool argument prefix as progress", () => {
		const isProgress = createCodexStreamProgressClassifier();
		expect(
			isProgress({
				type: "response.output_item.added",
				output_index: 5,
				item: { type: "function_call", id: "fc_malformed", arguments: "" },
			}),
		).toBe(true);
		expect(
			isProgress({
				type: "response.function_call_arguments.delta",
				item_id: "fc_malformed",
				delta: '{"ops":]',
			}),
		).toBe(true);
		expect(
			isProgress({ type: "response.function_call_arguments.delta", item_id: "fc_malformed", delta: " \t" }),
		).toBe(true);
	});

	it("times out SSE after trailing whitespace follows complete tool arguments", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		global.fetch = ((input: string | URL | Request, init?: RequestInit) =>
			Promise.resolve(
				createTimedCodexSse(
					getRequestSignal(input, init),
					[
						{ type: "response.created", response: { id: "resp_whitespace", status: "in_progress" } },
						{
							type: "response.output_item.added",
							output_index: 0,
							item: {
								type: "function_call",
								id: "fc_whitespace",
								call_id: "call_whitespace",
								name: "todo_write",
								status: "in_progress",
								arguments: "",
							},
						},
						{ type: "response.function_call_arguments.delta", item_id: "fc_whitespace", delta: '{"ops":[]}' },
						...Array.from({ length: 1000 }, () => ({
							type: "response.function_call_arguments.delta",
							item_id: "fc_whitespace",
							delta: " \t",
						})),
					],
					10,
					false,
				),
			)) as typeof fetch;
		const result = await streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken(), streamIdleTimeoutMs: 20 },
		).result();
		expect(result.stopReason).toBe("toolUse");
		expect(result.errorCode).toBe("codex_stream_closed_after_complete_tool_arguments");
	});

	it("does not time out SSE while whitespace arrives inside incomplete tool arguments", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		global.fetch = ((input: string | URL | Request, init?: RequestInit) =>
			Promise.resolve(
				createTimedCodexSse(
					getRequestSignal(input, init),
					[
						{
							type: "response.output_item.added",
							output_index: 0,
							item: {
								type: "function_call",
								id: "fc_open",
								call_id: "call_open",
								name: "todo_write",
								arguments: "",
							},
						},
						{ type: "response.function_call_arguments.delta", item_id: "fc_open", delta: '{"ops":' },
						...Array.from({ length: 3 }, () => ({
							type: "response.function_call_arguments.delta",
							item_id: "fc_open",
							delta: " \t",
						})),
						{ type: "response.function_call_arguments.delta", item_id: "fc_open", delta: "[]}" },
						{
							type: "response.function_call_arguments.done",
							item_id: "fc_open",
							arguments: '{"ops": \t[]}',
						},
						{
							type: "response.output_item.done",
							item: {
								type: "function_call",
								id: "fc_open",
								call_id: "call_open",
								name: "todo_write",
								arguments: '{"ops": \t[]}',
							},
						},
						{ type: "response.completed", response: { status: "completed", usage: DEFAULT_USAGE } },
					],
					10,
				),
			)) as typeof fetch;
		const result = await streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken(), streamIdleTimeoutMs: 20 },
		).result();
		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toEqual([
			expect.objectContaining({ type: "toolCall", name: "todo_write", arguments: { ops: [] } }),
		]);
	});

	it("keeps SSE progress for whitespace in reasoning and custom tool deltas", () => {
		const isProgress = createCodexStreamProgressClassifier();
		expect(isProgress({ type: "response.reasoning_summary_text.delta", delta: " \t" })).toBe(true);
		expect(isProgress({ type: "response.custom_tool_call_input.delta", delta: " \t" })).toBe(true);
	});

	it("honors caller cancellation during trailing whitespace after complete arguments", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const controller = new AbortController();
		global.fetch = ((input: string | URL | Request, init?: RequestInit) =>
			Promise.resolve(
				createTimedCodexSse(
					getRequestSignal(input, init),
					[
						{
							type: "response.output_item.added",
							output_index: 0,
							item: { type: "function_call", id: "fc_abort", name: "todo_write", arguments: "" },
						},
						{ type: "response.function_call_arguments.delta", item_id: "fc_abort", delta: "{}" },
						...Array.from({ length: 10 }, () => ({
							type: "response.function_call_arguments.delta",
							item_id: "fc_abort",
							delta: " ",
						})),
					],
					10,
					false,
				),
			)) as typeof fetch;
		setTimeout(() => controller.abort(), 45);
		const result = await streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{
				apiKey: createCodexTestToken(),
				signal: controller.signal,
				streamIdleTimeoutMs: 100,
			},
		).result();
		expect(result.stopReason).toBe("aborted");
	});

	it("allows websocket whitespace argument deltas to make progress without SSE replay", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected SSE replay"));
		class WhitespaceToolCallWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			send(): void {
				this.sendJson({ type: "response.created", response: { id: "resp_ws", status: "in_progress" } });
				this.sendJson({
					type: "response.output_item.added",
					output_index: 0,
					item: { type: "function_call", id: "fc_ws", call_id: "call_ws", name: "todo_write", arguments: "" },
				});
				this.sendJson({ type: "response.function_call_arguments.delta", item_id: "fc_ws", delta: "{}" });
				for (let index = 0; index < 4; index++) {
					setTimeout(
						() => {
							this.sendJson({ type: "response.function_call_arguments.delta", item_id: "fc_ws", delta: " " });
						},
						(index + 1) * 10,
					);
				}
				setTimeout(() => {
					this.sendJson({
						type: "response.output_item.done",
						item: {
							type: "function_call",
							id: "fc_ws",
							call_id: "call_ws",
							name: "todo_write",
							arguments: "{}    ",
						},
					});
					this.sendJson({ type: "response.completed", response: { status: "completed", usage: DEFAULT_USAGE } });
				}, 55);
			}
		}
		global.WebSocket = WhitespaceToolCallWebSocket as unknown as typeof WebSocket;
		const result = await streamOpenAICodexResponses(
			createCodexTestModel("https://chatgpt.com/backend-api"),
			createCodexTestContext(),
			{
				apiKey: createCodexTestToken(),
				sessionId: "ws-whitespace-progress",
				preferWebsockets: true,
				streamIdleTimeoutMs: 20,
				providerSessionState: new Map<string, ProviderSessionState>(),
			},
		).result();
		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toEqual([
			expect.objectContaining({ type: "toolCall", name: "todo_write", arguments: {} }),
		]);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("does not time out a websocket stream right away when the idle timeout exceeds the timer limit", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected SSE replay"));
		class SlowWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			send(): void {
				// The reply arrives 30 ms after the request, well past a 1 ms timer.
				setTimeout(() => {
					this.emitCodexResponse({ messageId: "msg_slow", responseId: "resp_slow", text: "late reply" });
				}, 30);
			}
		}
		global.WebSocket = SlowWebSocket as unknown as typeof WebSocket;
		const result = await streamOpenAICodexResponses(
			createCodexTestModel("https://chatgpt.com/backend-api"),
			createCodexTestContext(),
			{
				apiKey: createCodexTestToken(),
				sessionId: "ws-timer-ceiling",
				preferWebsockets: true,
				// One past the 32-bit setTimeout limit (about 24.9 days); setTimeout would treat it as 1 ms.
				streamIdleTimeoutMs: 2 ** 31,
				providerSessionState: new Map<string, ProviderSessionState>(),
			},
		).result();
		expect(result.stopReason).toBe("stop");
		expect(result.content.find(block => block.type === "text")?.text).toBe("late reply");
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("ends an SSE stream that hangs after a text delta", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const encoder = new TextEncoder();
		global.fetch = (async () =>
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						for (const event of [
							{
								type: "response.output_item.added",
								item: {
									type: "message",
									id: "msg_stalled",
									role: "assistant",
									status: "in_progress",
									content: [],
								},
							},
							{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
							{ type: "response.output_text.delta", delta: "partial" },
						]) {
							controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
						}
					},
				}),
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			)) as unknown as typeof fetch;
		const controller = new AbortController();
		const deadline = setTimeout(() => controller.abort(), 150);
		try {
			const result = await streamOpenAICodexResponses(
				{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
				createCodexTestContext(),
				{ apiKey: createCodexTestToken(), signal: controller.signal, streamIdleTimeoutMs: 20 },
			).result();
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toBe("OpenAI Codex SSE stream stalled while waiting for the next event");
		} finally {
			clearTimeout(deadline);
		}
	});

	it("parses websocket JSON from non-string payloads", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		class BinaryPayloadWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			send(): void {
				const added = encodeWebSocketMessage({
					type: "response.output_item.added",
					item: { type: "message", id: "msg_ws", role: "assistant", status: "in_progress", content: [] },
				});
				const contentPart = encodeWebSocketMessage({
					type: "response.content_part.added",
					part: { type: "output_text", text: "" },
				});
				const delta = encodeWebSocketMessage({ type: "response.output_text.delta", delta: "Hello binary" });
				const done = encodeWebSocketMessage({
					type: "response.output_item.done",
					item: {
						type: "message",
						id: "msg_ws",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "Hello binary" }],
					},
				});
				const completed = encodeWebSocketMessage({
					type: "response.done",
					response: { id: "resp_ws", status: "completed", usage: DEFAULT_USAGE },
				});
				// Exercise every payload shape the production decoder must accept.
				this.sendMessage(added.buffer.slice(added.byteOffset, added.byteOffset + added.byteLength));
				this.sendMessage(contentPart);
				this.sendMessage(Buffer.from(delta));
				this.sendMessage(Buffer.from(done));
				this.sendMessage(completed.buffer.slice(completed.byteOffset, completed.byteOffset + completed.byteLength));
			}
		}

		global.WebSocket = BinaryPayloadWebSocket as unknown as typeof WebSocket;
		const result = await streamOpenAICodexResponses(
			createCodexTestModel("https://chatgpt.com/backend-api"),
			createCodexTestContext(),
			{
				apiKey: token,
				sessionId: "ws-binary-payload-session",
				providerSessionState: new Map<string, ProviderSessionState>(),
			},
		).result();
		expect(result.content.find(block => block.type === "text")?.text).toBe("Hello binary");
		expect(result.stopReason).toBe("stop");
	});

	it("omits request-body headers and replaces stale beta headers for websocket handshakes", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		let capturedHeaders: Record<string, string> | undefined;
		class HeaderCaptureWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				capturedHeaders = options?.headers;
				this.scheduleOpen();
			}

			send(): void {
				this.sendJson({
					type: "response.done",
					response: {
						id: "resp_ws",
						status: "completed",
						usage: {
							input_tokens: 1,
							output_tokens: 1,
							total_tokens: 2,
							input_tokens_details: { cached_tokens: 0 },
						},
					},
				});
			}
		}

		global.WebSocket = HeaderCaptureWebSocket as unknown as typeof WebSocket;
		await streamOpenAICodexResponses(
			createCodexTestModel("https://chatgpt.com/backend-api"),
			createCodexTestContext(),
			{
				apiKey: token,
				headers: {
					accept: "application/json",
					"content-type": "application/json",
					"OpenAI-Beta": "responses=experimental",
					"openai-beta": "responses=stale",
				},
				sessionId: "ws-header-session",
				providerSessionState: new Map<string, ProviderSessionState>(),
			},
		).result();

		expect(capturedHeaders?.accept).toBeUndefined();
		expect(capturedHeaders?.["content-type"]).toBeUndefined();
		expect(capturedHeaders?.["openai-beta"]).toBe("responses_websockets=2026-02-06");
		expect(Object.keys(capturedHeaders ?? {}).filter(key => key.toLowerCase() === "openai-beta")).toHaveLength(1);
	});

	it("passes opaque apiKey tokens through to custom Codex-compatible backends", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = "sk-custom-proxy-test";
		const sse = createCompletedCodexSse("Hello proxy");
		let capturedUrl: string | undefined;
		let capturedHeaders: Headers | undefined;
		global.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
			capturedUrl = typeof input === "string" ? input : input.toString();
			capturedHeaders = init?.headers instanceof Headers ? init.headers : new Headers(init?.headers);
			return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
		}) as unknown as typeof fetch;

		const result = await streamOpenAICodexResponses(
			{ ...createCodexTestModel("http://127.0.0.1:2455/backend-api/codex"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: token },
		).result();

		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(capturedUrl).toBe("http://127.0.0.1:2455/backend-api/codex/responses");
		expect(capturedHeaders?.get("Authorization")).toBe(`Bearer ${token}`);
		expect(capturedHeaders?.has("chatgpt-account-id")).toBe(false);
		expect(capturedHeaders?.get("OpenAI-Beta")).toBe("responses=experimental");
	});

	it("streams SSE responses into AssistantMessageEventStream", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;

		const sse = `${[
			`data: ${JSON.stringify({
				type: "response.output_item.added",
				item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
			})}`,
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}`,
			`data: ${JSON.stringify({
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Hello" }],
				},
			})}`,
			`data: ${JSON.stringify({
				type: "response.completed",
				response: {
					status: "completed",
					usage: {
						input_tokens: 5,
						output_tokens: 3,
						total_tokens: 8,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			})}`,
		].join("\n\n")}\n\n`;

		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sse));
				controller.close();
			},
		});

		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
				return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
			}
			if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
				return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
			}
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				const headers = init?.headers instanceof Headers ? init.headers : undefined;
				expect(headers?.get("Authorization")).toBe(`Bearer ${token}`);
				expect(headers?.get("chatgpt-account-id")).toBe("acc_test");
				expect(headers?.get("OpenAI-Beta")).toBe("responses=experimental");
				expect(headers?.get("originator")).toBe("codex_cli_rs");
				expect(headers?.get("accept")).toBe("text/event-stream");
				expect(headers?.has("x-api-key")).toBe(false);
				return new Response(stream, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		});

		global.fetch = fetchMock as unknown as typeof fetch;

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};

		const context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const streamResult = streamOpenAICodexResponses(model, context, { apiKey: token });
		let sawTextDelta = false;
		let sawDone = false;

		for await (const event of streamResult) {
			if (event.type === "text_delta") {
				sawTextDelta = true;
			}
			if (event.type === "done") {
				sawDone = true;
				expect(event.message.content.find(c => c.type === "text")?.text).toBe("Hello");
			}
		}

		expect(sawTextDelta).toBe(true);
		expect(sawDone).toBe(true);
	});

	describe("Codex reasoning summary fallback", () => {
		const token = createCodexTestToken();
		const run = async (streamedDelta: string | undefined) => {
			const events = [
				{
					type: "response.output_item.added",
					output_index: 0,
					item: { type: "reasoning", id: "reasoning_1", summary: [] },
				},
				{
					type: "response.reasoning_summary_part.added",
					item_id: "reasoning_1",
					output_index: 0,
					part: { type: "summary_text", text: "" },
				},
				...(streamedDelta
					? [
							{
								type: "response.reasoning_summary_text.delta",
								item_id: "reasoning_1",
								output_index: 0,
								delta: streamedDelta,
							},
						]
					: []),
				{ type: "response.reasoning_summary_part.done", item_id: "reasoning_1", output_index: 0 },
				{
					type: "response.output_item.done",
					output_index: 0,
					item: {
						type: "reasoning",
						id: "reasoning_1",
						summary: [{ type: "summary_text", text: "FINAL CODEX SUMMARY" }],
						content: [],
					},
				},
				{
					type: "response.completed",
					response: {
						status: "completed",
						usage: {
							input_tokens: 0,
							output_tokens: 0,
							total_tokens: 0,
							input_tokens_details: { cached_tokens: 0 },
						},
					},
				},
			];
			const sse = `${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
			global.fetch = vi.fn(async (input: string | URL) => {
				if (String(input) === "https://chatgpt.com/backend-api/codex/responses") {
					return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
				}
				return new Response("not found", { status: 404 });
			}) as unknown as typeof fetch;

			const streamResult = streamOpenAICodexResponses(
				{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
				createCodexTestContext(),
				{ apiKey: token },
			);
			const emitted: Array<Record<string, unknown>> = [];
			for await (const event of streamResult) emitted.push(event as Record<string, unknown>);
			return emitted;
		};

		it("emits a summary start before the canonical summary end when no summary text delta streams", async () => {
			const fallbackEvents = await run(undefined);
			const summaryEvents = fallbackEvents.filter(
				event => event.type === "reasoning_summary_start" || event.type === "reasoning_summary_end",
			);
			expect(summaryEvents).toEqual([
				expect.objectContaining({ type: "reasoning_summary_start", contentIndex: 0 }),
				expect.objectContaining({ type: "reasoning_summary_end", contentIndex: 0, content: "FINAL CODEX SUMMARY" }),
			]);
			const fallbackDone = fallbackEvents.find(event => event.type === "done");
			expect(
				(fallbackDone?.message as { content: Array<{ type: string; summaryText?: string; provenance?: string }> })
					.content,
			).toContainEqual(
				expect.objectContaining({ type: "thinking", summaryText: "FINAL CODEX SUMMARY", provenance: "summary" }),
			);
		});

		it("emits one summary start and keeps streamed summary text when a summary text delta streams", async () => {
			const streamedEvents = await run("STREAMED CODEX SUMMARY");
			expect(streamedEvents.filter(event => event.type === "reasoning_summary_start")).toHaveLength(1);
			const summaryEnd = streamedEvents.find(event => event.type === "reasoning_summary_end");
			expect(summaryEnd).toEqual(
				expect.objectContaining({ contentIndex: 0, content: expect.stringContaining("STREAMED CODEX SUMMARY") }),
			);
			expect(summaryEnd?.content).not.toContain("FINAL CODEX SUMMARY");
		});
		it("keeps finalized thinking monotonic across reasoning finalization permutations", async () => {
			const run = async (events: Array<Record<string, unknown>>) => {
				const sse = `${[
					...events,
					{
						type: "response.completed",
						response: {
							status: "completed",
							usage: {
								input_tokens: 0,
								output_tokens: 0,
								total_tokens: 0,
								input_tokens_details: { cached_tokens: 0 },
							},
						},
					},
				]
					.map(event => `data: ${JSON.stringify(event)}`)
					.join("\n\n")}\n\n`;
				global.fetch = vi.fn(
					async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
				) as unknown as typeof fetch;
				return streamOpenAICodexResponses(
					{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
					createCodexTestContext(),
					{ apiKey: token },
				).result();
			};
			const added = {
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "reasoning", id: "reasoning_monotonic", summary: [] },
			};
			const summaryPart = {
				type: "response.reasoning_summary_part.added",
				item_id: "reasoning_monotonic",
				output_index: 0,
				part: { type: "summary_text", text: "" },
			};
			const summaryDelta = {
				type: "response.reasoning_summary_text.delta",
				item_id: "reasoning_monotonic",
				output_index: 0,
				delta: SUMMARY_SENTINEL,
			};
			const rawDelta = {
				type: "response.reasoning_text.delta",
				item_id: "reasoning_monotonic",
				output_index: 0,
				delta: RAW_SENTINEL,
			};
			const done = (summary: string[] = [], raw = "") => ({
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "reasoning",
					id: "reasoning_monotonic",
					summary: summary.map(text => ({ type: "summary_text", text })),
					content: raw ? [{ type: "reasoning_text", text: raw }] : [],
				},
			});
			const cases = [
				{
					name: "summary-first then raw duplicate output_item.done",
					events: [added, summaryPart, summaryDelta, done([SUMMARY_SENTINEL]), done([], RAW_SENTINEL)],
					provenance: "summary",
					summaryText: SUMMARY_SENTINEL,
					rawText: undefined,
				},
				{
					name: "raw-first then summary",
					events: [added, rawDelta, summaryPart, summaryDelta, done([SUMMARY_SENTINEL], RAW_SENTINEL)],
					provenance: "mixed",
					summaryText: SUMMARY_SENTINEL,
					rawText: RAW_SENTINEL,
				},
				{
					name: "duplicate summary finalizations",
					events: [added, summaryPart, summaryDelta, done([SUMMARY_SENTINEL]), done([SUMMARY_SENTINEL])],
					provenance: "summary",
					summaryText: SUMMARY_SENTINEL,
					rawText: undefined,
				},
				{
					name: "final-only summary",
					events: [added, done([SUMMARY_SENTINEL])],
					provenance: "summary",
					summaryText: SUMMARY_SENTINEL,
					rawText: undefined,
				},
				{
					name: "raw-only control",
					events: [added, rawDelta, done([], RAW_SENTINEL)],
					provenance: "raw",
					summaryText: undefined,
					rawText: RAW_SENTINEL,
				},
			] as const;

			for (const scenario of cases) {
				const result = await run([...scenario.events]);
				const block = result.content[0] as {
					thinking: string;
					provenance?: string;
					summaryText?: string;
					rawText?: string;
				};
				expect(block, scenario.name).toMatchObject({ provenance: scenario.provenance });
				expect(block.summaryText, scenario.name).toBe(scenario.summaryText);
				expect(block.rawText, scenario.name).toBe(scenario.rawText);
				if (scenario.provenance === "raw") {
					expect(block.thinking, scenario.name).toBe(RAW_SENTINEL);
				} else {
					expect(block.thinking, scenario.name).toBe(SUMMARY_SENTINEL);
					expect(block.thinking, scenario.name).not.toContain(RAW_SENTINEL);
				}
			}
		});
	});

	it("uses the explicit response service tier before the requested-tier fallback", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;
		const capturedBodies: Record<string, unknown>[] = [];
		let responseServiceTier: "default" | undefined = "default";

		const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
			capturedBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			const sse = `${[
				`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] } })}`,
				`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
				`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}`,
				`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello" }] } })}`,
				`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", ...(responseServiceTier ? { service_tier: responseServiceTier } : {}), usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
			].join("\n\n")}\n\n`;
			return new Response(sse, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};

		const context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const explicitDefaultResult = await streamOpenAICodexResponses(model, context, {
			apiKey: token,
			serviceTier: "priority",
		}).result();
		responseServiceTier = undefined;
		const missingTierResult = await streamOpenAICodexResponses(model, context, {
			apiKey: token,
			serviceTier: "priority",
		}).result();

		expect(explicitDefaultResult.stopReason).toBe("stop");
		expect(missingTierResult.stopReason).toBe("stop");
		expect(capturedBodies).toHaveLength(2);
		expect(capturedBodies[0]?.service_tier).toBe("priority");
		expect(capturedBodies[1]?.service_tier).toBe("priority");
		expect(explicitDefaultResult.usage.cost.input).toBeCloseTo(0.000005, 10);
		expect(explicitDefaultResult.usage.cost.output).toBeCloseTo(0.000006, 10);
		expect(explicitDefaultResult.usage.cost.total).toBeCloseTo(0.000011, 10);
		expect(missingTierResult.usage.cost.input).toBeCloseTo(0.00001, 10);
		expect(missingTierResult.usage.cost.output).toBeCloseTo(0.000012, 10);
		expect(missingTierResult.usage.cost.total).toBeCloseTo(0.000022, 10);
	});

	it("fails truncated SSE streams that never emit a terminal response event", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;

		const sse = `${[
			`data: ${JSON.stringify({
				type: "response.output_item.added",
				item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
			})}`,
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}`,
			`data: ${JSON.stringify({
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Hello" }],
				},
			})}`,
		].join("\n\n")}\n\n`;

		const fetchMock = vi.fn(async (input: string | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				return new Response(sse, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};

		const context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const result = await streamOpenAICodexResponses(model, context, { apiKey: token }).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("terminal completion event");
	});

	it("surfaces provider model-access failures without client-authored account claims", async () => {
		const tempDir = TempDir.createSync("@pi-codex-provider-error-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const model = {
			...createCodexTestModel("https://chatgpt.com/backend-api"),
			id: "gpt-5.6-sol",
			name: "GPT-5.6 Sol",
			preferWebsockets: false,
		};
		const context = createCodexTestContext();
		const providerMessage = "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.";

		global.fetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ error: { code: "invalid_request_error", message: providerMessage } }), {
					status: 400,
					headers: { "content-type": "application/json" },
				}),
		) as unknown as typeof fetch;
		const httpResult = await streamOpenAICodexResponses(model, context, { apiKey: token }).result();
		expect(httpResult.stopReason).toBe("error");
		expect(httpResult.errorMessage).toContain(providerMessage);
		expect(httpResult.transportFailure).toMatchObject({
			status: 400,
			providerCode: "invalid_request_error",
			credentialModelUnavailable: true,
		});
		expect(httpResult.errorMessage).not.toContain("Select a model available to this ChatGPT account");
		expect(httpResult.errorMessage).not.toContain("API-key credential");

		const sse = `data: ${JSON.stringify({
			type: "error",
			error: { code: "invalid_request_error", message: providerMessage },
		})}\n\n`;
		global.fetch = vi.fn(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		) as unknown as typeof fetch;
		const streamResult = await streamOpenAICodexResponses(model, context, { apiKey: token }).result();
		expect(streamResult.stopReason).toBe("error");
		expect(streamResult.errorMessage).toContain(providerMessage);
		expect(streamResult.errorMessage).toContain("code=invalid_request_error");
		expect(streamResult.transportFailure).toMatchObject({
			credentialModelUnavailable: true,
		});
		expect(streamResult.errorMessage).not.toContain("Select a model available to this ChatGPT account");
		expect(streamResult.errorMessage).not.toContain("API-key credential");
	});

	it.each(["server_error", "internal_error"])("preserves bare Codex %s error codes as transport facts", async code => {
		const tempDir = TempDir.createSync("@pi-codex-provider-error-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const model = { ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false };
		const sse = `data: ${JSON.stringify({ type: "error", error: { code, message: "fake upstream failure" } })}\n\n`;
		global.fetch = vi.fn(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		) as unknown as typeof fetch;

		const result = await streamOpenAICodexResponses(model, createCodexTestContext(), {
			apiKey: token,
			streamMaxRetries: 0,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain(`code=${code}`);
		expect(result.transportFailure).toMatchObject({ kind: "transport", providerCode: code });
		expect(result.transportFailure?.retryMaxAttempts).toBeUndefined();
	});

	it("preserves a code-only Codex overload as retryable transport facts", async () => {
		const tempDir = TempDir.createSync("@pi-codex-provider-overload-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const model = { ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false };
		const sse = `data: ${JSON.stringify({ type: "error", code: "server_is_overloaded" })}\n\n`;
		global.fetch = vi.fn(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		) as unknown as typeof fetch;

		const result = await streamOpenAICodexResponses(model, createCodexTestContext(), {
			apiKey: token,
			streamMaxRetries: 0,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.transportFailure).toMatchObject({
			kind: "transport",
			providerCode: "server_is_overloaded",
		});
		expect(result.transportFailure?.retryMaxAttempts).toBeUndefined();
	});

	it("stops reading SSE responses after a terminal response event", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;
		const sse = `${[
			`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] } })}`,
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}`,
			`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello" }] } })}`,
			`data: ${JSON.stringify({ type: "response.done", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
			`data: ${JSON.stringify({ type: "response.failed", code: "server_error", message: "late failure after terminal event" })}`,
		].join("\n\n")}\n\n`;

		global.fetch = vi.fn(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		) as unknown as typeof fetch;

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};
		const context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const result = await streamOpenAICodexResponses(model, context, { apiKey: token }).result();
		expect(result.stopReason).toBe("stop");
		expect(result.content.find(block => block.type === "text")?.text).toBe("Hello");
	});

	it("surfaces 429 errors after retry budget checks without body reuse failures", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;

		const fetchMock = vi.fn(async (input: string | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				return new Response(
					JSON.stringify({
						error: {
							code: "rate_limit_exceeded",
							message: "too many requests",
						},
					}),
					{
						status: 429,
						headers: {
							"content-type": "application/json",
							"retry-after": "600",
						},
					},
				);
			}
			return new Response("not found", { status: 404 });
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};

		const context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const result = await streamOpenAICodexResponses(model, context, { apiKey: token }).result();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.stopReason).toBe("error");
		expect((result.errorMessage ?? "").toLowerCase()).toContain("rate limit");
		expect(result.errorMessage).not.toContain("Body already used");
		expect(result.transportFailure).toMatchObject({
			kind: "transport",
			status: 429,
			providerCode: "rate_limit_exceeded",
		});
		expect(result.transportFailure?.headers).toEqual({ "retry-after": "600" });
		expect(classifyFallbackTrigger(result.transportFailure)).toEqual({ class: "rate_limit", retryAfterMs: 600_000 });
	});

	it("honors requestMaxRetries before a Codex SSE stream is established", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const token = createCodexTestToken();
		const fetchMock = vi.fn(async (input: string | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				return new Response(JSON.stringify({ error: { code: "server_error", message: "transient failure" } }), {
					status: 500,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response("not found", { status: 404 });
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		const model = {
			...createCodexTestModel("https://chatgpt.com/backend-api"),
			preferWebsockets: false,
		};
		const result = await streamOpenAICodexResponses(model, createCodexTestContext(), {
			apiKey: token,
			requestMaxRetries: 0,
		}).result();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("transient failure");
	});

	it("retries a connection-refused Codex SSE open before completing the turn", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-connect-retry-");
		setAgentDir(tempDir.path());
		const sse = createCompletedCodexSse("Recovered");
		let attempts = 0;
		const fetchMock = vi.fn(async () => {
			attempts += 1;
			if (attempts === 1) {
				throw Object.assign(new Error("connection refused"), { code: "ConnectionRefused" });
			}
			return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		const result = await streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken() },
		).result();

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(result.stopReason).not.toBe("error");
	});

	it("backs off connection-refused SSE opens for at least ten seconds", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-connect-backoff-");
		setAgentDir(tempDir.path());
		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const fetchMock = vi.fn(async () => {
			throw Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		const result = await streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken() },
		).result();

		expect(result.stopReason).toBe("error");
		expect(fetchMock).toHaveBeenCalledTimes(6);
		expect(waitSpy.mock.calls.reduce((total, [delay]) => total + Number(delay), 0)).toBeGreaterThanOrEqual(10_000);
	});

	it("retries transient model_error SSE events before surfacing an error", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;
		let requestCount = 0;

		const successSse = `${[
			`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "message", id: "msg_retry", role: "assistant", status: "in_progress", content: [] } })}`,
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello after retry" })}`,
			`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", id: "msg_retry", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello after retry" }] } })}`,
			`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
		].join("\n\n")}\n\n`;
		const errorSse = `${[
			`data: ${JSON.stringify({
				type: "error",
				code: "model_error",
				message: "An error occurred while processing your request. You can retry your request.",
			})}`,
		].join("\n\n")}\n\n`;

		const fetchMock = vi.fn(async (input: string | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				requestCount += 1;
				return new Response(requestCount === 1 ? errorSse : successSse, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};

		const context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const result = await streamOpenAICodexResponses(model, context, { apiKey: token }).result();
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(result.stopReason).toBe("stop");
		expect(result.content.find(block => block.type === "text")?.text).toBe("Hello after retry");
	});
	it.each([
		{ label: "generic prose", message: "Please try again later." },
		{ label: "absent prose", message: undefined },
	])("retries typed server_is_overloaded SSE events with $label", async ({ message }) => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		let requestCount = 0;
		const errorSse = createCodexErrorSse([
			{ type: "error", code: "server_is_overloaded", ...(message === undefined ? {} : { message }) },
		]);
		const fetchMock = vi.fn(async () => {
			requestCount += 1;
			const successSse = `${[
				`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "message", id: "msg_retry", role: "assistant", status: "in_progress", content: [] } })}`,
				`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
				`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Recovered after overload" })}`,
				`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", id: "msg_retry", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Recovered after overload" }] } })}`,
				`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
			].join("\n\n")}\n\n`;
			return new Response(requestCount === 1 ? errorSse : successSse, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		const result = await streamOpenAICodexResponses(
			createCodexTestModel("https://chatgpt.com/backend-api"),
			createCodexTestContext(),
			{ apiKey: token },
		).result();

		expect(requestCount).toBe(2);
		expect(result.stopReason).toBe("stop");
		expect(result.content.find(block => block.type === "text")?.text).toBe("Recovered after overload");
	});
	it("does not retry non-recoverable Codex schema validation SSE events", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const token = createCodexTestToken();
		const errorSse = `${[
			`data: ${JSON.stringify({
				type: "error",
				code: "server_error",
				message:
					"Invalid schema for function 'computer': schema must have type 'object' and not have 'oneOf' at the top level. (code=invalid_function_parameters)",
			})}`,
		].join("\n\n")}\n\n`;

		const fetchMock = vi.fn(async (input: string | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				return new Response(errorSse, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		const model = {
			...createCodexTestModel("https://chatgpt.com/backend-api"),
			preferWebsockets: false,
		};
		const result = await streamOpenAICodexResponses(model, createCodexTestContext(), { apiKey: token }).result();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("invalid_function_parameters");
		expect(result.transportFailure).toBeUndefined();
	});

	it("honors streamMaxRetries for replay-safe Codex stream failures", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const token = createCodexTestToken();
		const errorSse = `${[
			`data: ${JSON.stringify({
				type: "error",
				code: "model_error",
				message: "An error occurred while processing your request. You can retry your request.",
			})}`,
		].join("\n\n")}\n\n`;

		const fetchMock = vi.fn(async (input: string | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				return new Response(errorSse, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		const model = {
			...createCodexTestModel("https://chatgpt.com/backend-api"),
			preferWebsockets: false,
		};
		const result = await streamOpenAICodexResponses(model, createCodexTestContext(), {
			apiKey: token,
			streamMaxRetries: 0,
		}).result();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("model_error");
	});

	it("sets conversation_id/session_id headers and prompt_cache_key when sessionId is provided", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;

		const sse = `${[
			`data: ${JSON.stringify({
				type: "response.output_item.added",
				item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
			})}`,
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}`,
			`data: ${JSON.stringify({
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Hello" }],
				},
			})}`,
			`data: ${JSON.stringify({
				type: "response.completed",
				response: {
					status: "completed",
					usage: {
						input_tokens: 5,
						output_tokens: 3,
						total_tokens: 8,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			})}`,
		].join("\n\n")}\n\n`;

		const encoder = new TextEncoder();
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode(sse));
				controller.close();
			},
		});

		const sessionId = "test-session-123";
		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
				return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
			}
			if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
				return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
			}
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				const headers = init?.headers instanceof Headers ? init.headers : undefined;
				// Verify sessionId is set in headers
				expect(headers?.get("conversation_id")).toBe(sessionId);
				expect(headers?.get("session_id")).toBe(sessionId);
				expect(headers?.get("x-client-request-id")).toBe(sessionId);

				// Verify sessionId is set in request body as prompt_cache_key
				const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
				expect(body?.prompt_cache_key).toBe(sessionId);

				return new Response(stream, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		});

		global.fetch = fetchMock as unknown as typeof fetch;

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};

		const context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const streamResult = streamOpenAICodexResponses(model, context, { apiKey: token, sessionId });
		await streamResult.result();
	});

	it("rejects gpt-5.3-codex minimal reasoning effort instead of clamping", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;

		const sse = `${[
			`data: ${JSON.stringify({
				type: "response.output_item.added",
				item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
			})}`,
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}`,
			`data: ${JSON.stringify({
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Hello" }],
				},
			})}`,
			`data: ${JSON.stringify({
				type: "response.completed",
				response: {
					status: "completed",
					usage: {
						input_tokens: 5,
						output_tokens: 3,
						total_tokens: 8,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			})}`,
		].join("\n\n")}\n\n`;

		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sse));
				controller.close();
			},
		});

		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
				return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
			}
			if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
				return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
			}
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
				expect(body?.reasoning).toEqual({ effort: "low", summary: "auto" });

				return new Response(stream, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		});

		global.fetch = fetchMock as unknown as typeof fetch;

		const model = enrichModelThinking({
			id: "gpt-5.3-codex",
			name: "GPT-5.3 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		});

		const context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const streamResult = streamOpenAICodexResponses(model, context, {
			apiKey: token,
			reasoning: "minimal",
		});
		const response = await streamResult.result();
		expect(response.stopReason).toBe("error");
		expect(response.errorMessage).toContain("Supported efforts: low, medium, high, xhigh");
	});

	it("does not set conversation_id/session_id headers when sessionId is not provided", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;

		const sse = `${[
			`data: ${JSON.stringify({
				type: "response.output_item.added",
				item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
			})}`,
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}`,
			`data: ${JSON.stringify({
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Hello" }],
				},
			})}`,
			`data: ${JSON.stringify({
				type: "response.completed",
				response: {
					status: "completed",
					usage: {
						input_tokens: 5,
						output_tokens: 3,
						total_tokens: 8,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			})}`,
		].join("\n\n")}\n\n`;

		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
				return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
			}
			if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
				return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
			}
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				const headers = init?.headers instanceof Headers ? init.headers : undefined;
				// Verify headers are not set when sessionId is not provided
				expect(headers?.has("conversation_id")).toBe(false);
				expect(headers?.has("session_id")).toBe(false);

				return new Response(sse, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		});

		global.fetch = fetchMock as unknown as typeof fetch;

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};

		const context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		// No sessionId provided
		const streamResult = streamOpenAICodexResponses(model, context, { apiKey: token });
		await streamResult.result();
	});

	it("falls back to SSE when websocket connect fails", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;
		Bun.env.PI_CODEX_WEBSOCKET_RETRY_BUDGET = "0";
		Bun.env.PI_CODEX_WEBSOCKET_RETRY_DELAY_MS = "1";
		const sse = `${[
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}`,
			`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello" }] } })}`,
			`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
		].join("\n\n")}\n\n`;

		const fetchMock = vi.fn(async (input: string | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				return new Response(sse, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		});
		global.fetch = fetchMock as unknown as typeof fetch;
		class FailingWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				setTimeout(() => {
					expect(this.options?.headers?.["OpenAI-Beta"] ?? this.options?.headers?.["openai-beta"]).toStartWith(
						"responses_websockets=",
					);
					this.emit("error", new Event("error"));
					this.emit("close", new Event("close"));
					this.readyState = MockWebSocket.CLOSED;
				}, 0);
			}
		}

		global.WebSocket = FailingWebSocket as unknown as typeof WebSocket;
		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			preferWebsockets: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 128000,
		};
		const context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};
		const providerSessionState = new Map<string, ProviderSessionState>();
		const streamResult = streamOpenAICodexResponses(model, context, {
			apiKey: token,
			sessionId: "ws-session",
			providerSessionState,
		});
		const result = await streamResult.result();
		expect(result.role).toBe("assistant");
		expect(fetchMock).toHaveBeenCalled();
		const fallbackDetails = getOpenAICodexTransportDetails(model, { sessionId: "ws-session", providerSessionState });
		expect(fallbackDetails.lastTransport).toBe("sse");
		expect(fallbackDetails.websocketDisabled).toBe(true);
		expect(fallbackDetails.fallbackCount).toBe(1);
	});

	it("immediately falls back to SSE on fatal websocket connection errors", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;

		const sse = `${[
			`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "message", id: "msg_sse", role: "assistant", status: "in_progress", content: [] } })}`,
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello SSE" })}`,
			`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", id: "msg_sse", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello SSE" }] } })}`,
			`data: ${JSON.stringify({ type: "response.done", response: { id: "resp_sse", status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
		].join("\n\n")}\n\n`;
		const fetchMock = vi.fn(async () => {
			return new Response(sse, { headers: { "content-type": "text/event-stream" } });
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		let constructorCount = 0;
		class FailingConnectWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				constructorCount += 1;
				setTimeout(() => {
					this.emit("error", new Event("error"));
					this.emit("close", new Event("close"));
					this.readyState = MockWebSocket.CLOSED;
				}, 0);
			}
		}

		global.WebSocket = FailingConnectWebSocket as unknown as typeof WebSocket;

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			preferWebsockets: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 128000,
		};
		const context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};
		const providerSessionState = new Map<string, ProviderSessionState>();
		const result = await streamOpenAICodexResponses(model, context, {
			apiKey: token,
			sessionId: "ws-fatal-fallback-session",
			providerSessionState,
		}).result();
		expect(result.role).toBe("assistant");
		expect(constructorCount).toBe(1);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const transportDetails = getOpenAICodexTransportDetails(model, {
			sessionId: "ws-fatal-fallback-session",
			providerSessionState,
		});
		expect(transportDetails.lastTransport).toBe("sse");
		expect(transportDetails.websocketDisabled).toBe(true);
		expect(transportDetails.fallbackCount).toBe(1);
	});

	it("captures websocket handshake metadata and replays it on later SSE requests", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;

		const sse = `${[
			`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "message", id: "msg_sse", role: "assistant", status: "in_progress", content: [] } })}`,
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello SSE" })}`,
			`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", id: "msg_sse", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello SSE" }] } })}`,
			`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
		].join("\n\n")}\n\n`;
		const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
			const headers = init?.headers instanceof Headers ? init.headers : new Headers(init?.headers);
			expect(headers.get("x-codex-turn-state")).toBe("ws-turn-state-1");
			expect(headers.get("x-models-etag")).toBe("models-etag-1");
			return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		class HandshakeWebSocket extends MockWebSocket {
			handshakeHeaders = {
				"x-codex-turn-state": "ws-turn-state-1",
				"x-models-etag": "models-etag-1",
				"x-reasoning-included": "true",
			};

			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			send(): void {
				this.emitCodexResponse({ messageId: "msg_ws", responseId: "resp_ws", text: "Hello WS" });
			}
		}

		global.WebSocket = HandshakeWebSocket as unknown as typeof WebSocket;

		const websocketModel: Model<"openai-codex-responses"> = {
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			preferWebsockets: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 128000,
		};
		const sseModel: Model<"openai-codex-responses"> = {
			...websocketModel,
			preferWebsockets: false,
		};
		const context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};
		const providerSessionState = new Map<string, ProviderSessionState>();
		await streamOpenAICodexResponses(websocketModel, context, {
			apiKey: token,
			sessionId: "ws-handshake-session",
			providerSessionState,
		}).result();
		await streamOpenAICodexResponses(sseModel, context, {
			apiKey: token,
			sessionId: "ws-handshake-session",
			providerSessionState,
		}).result();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("includes service_tier in websocket payloads when requested", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;
		const sentRequests: Array<Record<string, unknown>> = [];

		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not be called");
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		class ServiceTierWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			send(data: string): void {
				sentRequests.push(JSON.parse(data) as Record<string, unknown>);
				this.sendJson({
					type: "response.output_item.added",
					item: { type: "message", id: "msg_ws", role: "assistant", status: "in_progress", content: [] },
				});
				this.sendJson({ type: "response.content_part.added", part: { type: "output_text", text: "" } });
				this.sendJson({ type: "response.output_text.delta", delta: "Hello WS" });
				this.sendJson({
					type: "response.output_item.done",
					item: {
						type: "message",
						id: "msg_ws",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "Hello WS" }],
					},
				});
				this.sendJson({ type: "response.created", response: { id: "resp_ws" } });
				this.sendJson({
					type: "response.done",
					response: { id: "resp_ws", status: "completed", usage: DEFAULT_USAGE },
				});
			}
		}

		global.WebSocket = ServiceTierWebSocket as unknown as typeof WebSocket;

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			preferWebsockets: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 128000,
		};
		const context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const result = await streamOpenAICodexResponses(model, context, {
			apiKey: token,
			serviceTier: "priority",
			sessionId: "ws-service-tier-session",
			providerSessionState: new Map<string, ProviderSessionState>(),
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(fetchMock).not.toHaveBeenCalled();
		expect(sentRequests[0]?.type).toBe("response.create");
		expect(sentRequests[0]?.service_tier).toBe("priority");
		expect(result.usage.premiumRequests).toBeUndefined();
	});

	it("sends websocket continuation deltas after prior assistant response items and records stats", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;
		const sentRequests: Array<Record<string, unknown>> = [];
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not be called");
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		class DeltaWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			send(data: string): void {
				sentRequests.push(JSON.parse(data) as Record<string, unknown>);
				const responseIndex = sentRequests.length;
				this.emitCodexResponse({
					messageId: `msg_${responseIndex}`,
					responseId: `resp_${responseIndex}`,
					text: responseIndex === 1 ? "First answer" : "Second answer",
					terminalType: "response.completed",
					includeCreated: true,
				});
			}
		}

		global.WebSocket = DeltaWebSocket as unknown as typeof WebSocket;
		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			preferWebsockets: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 128000,
		};
		const providerSessionState = new Map<string, ProviderSessionState>();
		const firstContext: Context = {
			systemPrompt: ["You are a helpful assistant.", "Use concise answers."],
			messages: [{ role: "user", content: "First question", timestamp: Date.now() }],
		};
		const firstResponse = await streamOpenAICodexResponses(model, firstContext, {
			apiKey: token,
			sessionId: "ws-delta-session",
			providerSessionState,
		}).result();
		const secondContext: Context = {
			systemPrompt: ["You are a helpful assistant.", "Use concise answers."],
			messages: [
				...firstContext.messages,
				firstResponse,
				{ role: "user", content: "Second question", timestamp: Date.now() },
			],
		};
		await streamOpenAICodexResponses(model, secondContext, {
			apiKey: token,
			sessionId: "ws-delta-session",
			providerSessionState,
		}).result();

		expect(fetchMock).not.toHaveBeenCalled();
		expect(sentRequests).toHaveLength(2);
		expect(sentRequests[0]?.previous_response_id).toBeUndefined();
		expect(sentRequests[0]?.prompt_cache_key).toBe("ws-delta-session");
		expect(sentRequests[0]?.instructions).toBe("You are a helpful assistant.");
		const initialInput = sentRequests[0]?.input;
		expect(Array.isArray(initialInput)).toBe(true);
		const initialItems = initialInput as Array<{ role?: string; content?: unknown }>;
		expect(initialItems).toHaveLength(2);
		expect(initialItems[0]?.role).toBe("developer");
		expect(JSON.stringify(initialItems[0]?.content)).toContain("Use concise answers.");
		expect(initialItems[1]?.role).toBe("user");
		expect(sentRequests[1]?.type).toBe("response.create");
		expect(sentRequests[1]?.previous_response_id).toBe("resp_1");
		expect(sentRequests[1]?.prompt_cache_key).toBe("ws-delta-session");
		expect(sentRequests[1]?.instructions).toBe("You are a helpful assistant.");
		const deltaInput = sentRequests[1]?.input;
		expect(Array.isArray(deltaInput)).toBe(true);
		const deltaItems = deltaInput as Array<{ role?: string }>;
		expect(deltaItems).toHaveLength(1);
		expect(deltaItems[0]?.role).toBe("user");
		expect(JSON.stringify(deltaItems)).toContain("Second question");
		expect(JSON.stringify(deltaItems)).not.toContain("First answer");

		const stats = getOpenAICodexWebSocketDebugStats(model, {
			sessionId: "ws-delta-session",
			providerSessionState,
		});
		expect(stats).toEqual({
			fullContextRequests: 1,
			deltaRequests: 1,
			lastInputItems: 1,
			lastDeltaInputItems: 1,
			lastPreviousResponseId: "resp_1",
		});
	});

	it("resets websocket append state after salvaging a finalized tool call", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-salvage-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const sentRequests: Array<Record<string, unknown>> = [];
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not be called");
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		class SalvageWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			send(data: string): void {
				const request = JSON.parse(data) as Record<string, unknown>;
				sentRequests.push(request);
				const requestIndex = sentRequests.length;

				if (requestIndex === 1) {
					this.emitCodexResponse({
						messageId: "msg_a",
						responseId: "resp_a",
						text: "Answer A",
						terminalType: "response.completed",
						includeCreated: true,
					});
					return;
				}

				if (requestIndex === 2) {
					this.sendJson({ type: "response.created", response: { id: "resp_b" } });
					this.sendJson({
						type: "response.output_item.added",
						item: { type: "function_call", id: "fc_b", call_id: "call_b", name: "todo_write", arguments: "" },
					});
					this.sendJson({
						type: "response.function_call_arguments.delta",
						item_id: "fc_b",
						delta: '{"ops":[]}',
					});
					this.sendJson({
						type: "response.output_item.done",
						item: {
							type: "function_call",
							id: "fc_b",
							call_id: "call_b",
							name: "todo_write",
							arguments: '{"ops":[]}',
						},
					});
					this.sendJson({
						type: "error",
						code: "request_timeout",
						message:
							"stream disconnected before completion: stream closed before response.completed (code=request_timeout)",
					});
					return;
				}

				if (requestIndex === 3) {
					expect(request.previous_response_id).toBeUndefined();
					this.emitCodexResponse({
						messageId: "msg_c",
						responseId: "resp_c",
						text: "Answer C",
						terminalType: "response.completed",
						includeCreated: true,
					});
					return;
				}

				throw new Error(`Unexpected websocket request index: ${requestIndex}`);
			}
		}

		global.WebSocket = SalvageWebSocket as unknown as typeof WebSocket;
		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const sessionId = "ws-salvage-session";
		const firstContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Question A", timestamp: Date.now() }],
		};
		const firstResponse = await streamOpenAICodexResponses(model, firstContext, {
			apiKey: token,
			sessionId,
			providerSessionState,
		}).result();
		const secondContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [
				...firstContext.messages,
				firstResponse,
				{ role: "user", content: "Question B", timestamp: Date.now() + 1 },
			],
		};
		const secondResponse = await streamOpenAICodexResponses(model, secondContext, {
			apiKey: token,
			sessionId,
			providerSessionState,
		}).result();

		expect(secondResponse.stopReason).toBe("toolUse");
		expect(secondResponse.errorCode).toBe("codex_stream_closed_after_finalized_tool_calls");
		const thirdContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [
				...secondContext.messages,
				secondResponse,
				{
					role: "toolResult",
					toolCallId: "call_b|fc_b",
					toolName: "todo_write",
					content: [{ type: "text", text: "Tool completed" }],
					isError: false,
					timestamp: Date.now() + 2,
				},
			],
		};
		await streamOpenAICodexResponses(model, thirdContext, {
			apiKey: token,
			sessionId,
			providerSessionState,
		}).result();

		expect(fetchMock).not.toHaveBeenCalled();
		expect(sentRequests).toHaveLength(3);
		expect(sentRequests[2]?.previous_response_id).toBeUndefined();
		const fullInput = sentRequests[2]?.input;
		expect(Array.isArray(fullInput)).toBe(true);
		const serializedInput = JSON.stringify(fullInput);
		expect(serializedInput).toContain("Question A");
		expect(serializedInput).toContain("Question B");
		expect(serializedInput).toContain("function_call");
		expect(serializedInput).toContain("function_call_output");
		expect(serializedInput).toContain("Tool completed");
	});

	it("retries websocket continuations with full context when previous_response_id expires", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const sentRequests: Array<Record<string, unknown>> = [];
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not be called");
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		class PreviousResponseMissingWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			send(data: string): void {
				const request = JSON.parse(data) as Record<string, unknown>;
				sentRequests.push(request);
				const requestIndex = sentRequests.length;

				if (requestIndex === 1) {
					this.emitCodexResponse({
						messageId: "msg_1",
						responseId: "resp_1",
						text: "First answer",
						terminalType: "response.completed",
						includeCreated: true,
					});
					return;
				}

				if (requestIndex === 2) {
					expect(request.previous_response_id).toBe("resp_1");
					this.sendJson({
						type: "error",
						code: "previous_response_not_found",
						message: "Previous response with id 'resp_1' not found.",
					});
					return;
				}

				if (requestIndex === 3) {
					expect(request.previous_response_id).toBeUndefined();
					this.emitCodexResponse({
						messageId: "msg_3",
						responseId: "resp_3",
						text: "Second answer",
						terminalType: "response.completed",
						includeCreated: true,
					});
					return;
				}

				throw new Error(`Unexpected websocket request index: ${requestIndex}`);
			}
		}

		global.WebSocket = PreviousResponseMissingWebSocket as unknown as typeof WebSocket;
		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const firstContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "First question", timestamp: Date.now() }],
		};
		const firstResponse = await streamOpenAICodexResponses(model, firstContext, {
			apiKey: token,
			sessionId: "ws-expired-previous-response-session",
			providerSessionState,
		}).result();
		const secondContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [
				...firstContext.messages,
				firstResponse,
				{ role: "user", content: "Second question", timestamp: Date.now() + 1 },
			],
		};

		const secondResponse = await streamOpenAICodexResponses(model, secondContext, {
			apiKey: token,
			sessionId: "ws-expired-previous-response-session",
			providerSessionState,
		}).result();

		expect(secondResponse.stopReason).toBe("stop");
		expect(JSON.stringify(secondResponse.content)).toContain("Second answer");
		expect(fetchMock).not.toHaveBeenCalled();
		expect(sentRequests).toHaveLength(3);
		expect(sentRequests[2]?.prompt_cache_key).toBe("ws-expired-previous-response-session");
		const retryInput = sentRequests[2]?.input;
		expect(Array.isArray(retryInput)).toBe(true);
		expect(JSON.stringify(retryInput)).toContain("First question");
		expect(JSON.stringify(retryInput)).toContain("Second question");

		const stats = getOpenAICodexWebSocketDebugStats(model, {
			sessionId: "ws-expired-previous-response-session",
			providerSessionState,
		});
		expect(stats).toEqual({
			fullContextRequests: 2,
			deltaRequests: 1,
			lastInputItems: (retryInput as unknown[]).length,
			lastDeltaInputItems: undefined,
			lastPreviousResponseId: undefined,
		});
	});

	it.each([
		undefined,
		0,
	])("retries websocket continuations when previous_response_id expires with fallbackManaged and streamMaxRetries=%s", async streamMaxRetries => {
		const tempDir = TempDir.createSync("@pi-codex-stream-fallback-managed-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const sentRequests: Array<Record<string, unknown>> = [];
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not be called");
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		class PreviousResponseMissingWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			send(data: string): void {
				const request = JSON.parse(data) as Record<string, unknown>;
				sentRequests.push(request);
				const requestIndex = sentRequests.length;

				if (requestIndex === 1) {
					this.emitCodexResponse({
						messageId: "msg_1",
						responseId: "resp_1",
						text: "First answer",
						terminalType: "response.completed",
						includeCreated: true,
					});
					return;
				}

				if (requestIndex === 2) {
					expect(request.previous_response_id).toBe("resp_1");
					this.sendJson({
						type: "error",
						code: "previous_response_not_found",
						message: "Previous response with id 'resp_1' not found.",
					});
					return;
				}

				if (requestIndex === 3) {
					expect(request.previous_response_id).toBeUndefined();
					this.emitCodexResponse({
						messageId: "msg_3",
						responseId: "resp_3",
						text: "Second answer",
						terminalType: "response.completed",
						includeCreated: true,
					});
					return;
				}

				throw new Error(`Unexpected websocket request index: ${requestIndex}`);
			}
		}

		global.WebSocket = PreviousResponseMissingWebSocket as unknown as typeof WebSocket;
		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const sessionId = `ws-expired-previous-response-fallback-managed-${streamMaxRetries}-session`;
		const firstContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "First question", timestamp: Date.now() }],
		};
		const firstResponse = await streamOpenAICodexResponses(model, firstContext, {
			apiKey: token,
			sessionId,
			fallbackManaged: true,
			providerSessionState,
		}).result();
		const secondContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [
				...firstContext.messages,
				firstResponse,
				{ role: "user", content: "Second question", timestamp: Date.now() + 1 },
			],
		};

		const secondResponse = await streamOpenAICodexResponses(model, secondContext, {
			apiKey: token,
			sessionId,
			fallbackManaged: true,
			streamMaxRetries,
			providerSessionState,
		}).result();

		expect(secondResponse.stopReason).toBe("stop");
		expect(JSON.stringify(secondResponse.content)).toContain("Second answer");
		expect(fetchMock).not.toHaveBeenCalled();
		expect(sentRequests).toHaveLength(3);
		expect(sentRequests[2]?.previous_response_id).toBeUndefined();
		const retryInput = sentRequests[2]?.input;
		expect(Array.isArray(retryInput)).toBe(true);
		expect(JSON.stringify(retryInput)).toContain("First question");
		expect(JSON.stringify(retryInput)).toContain("First answer");
		expect(JSON.stringify(retryInput)).toContain("Second question");
	});

	it("does not replay expired previous_response_id with fallbackManaged when provider retries are disabled", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-fallback-managed-disabled-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const sentRequests: Array<Record<string, unknown>> = [];
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not be called");
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		class PreviousResponseMissingWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			send(data: string): void {
				const request = JSON.parse(data) as Record<string, unknown>;
				sentRequests.push(request);
				if (sentRequests.length === 1) {
					this.emitCodexResponse({
						messageId: "msg_1",
						responseId: "resp_1",
						text: "First answer",
						terminalType: "response.completed",
						includeCreated: true,
					});
					return;
				}
				expect(request.previous_response_id).toBe("resp_1");
				this.sendJson({
					type: "error",
					code: "previous_response_not_found",
					message: "Previous response with id 'resp_1' not found.",
				});
			}
		}

		global.WebSocket = PreviousResponseMissingWebSocket as unknown as typeof WebSocket;
		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const sessionId = "ws-expired-previous-response-fallback-managed-disabled-session";
		const firstContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "First question", timestamp: Date.now() }],
		};
		const firstResponse = await streamOpenAICodexResponses(model, firstContext, {
			apiKey: token,
			sessionId,
			fallbackManaged: true,
			providerSessionState,
		}).result();
		const secondResponse = await streamOpenAICodexResponses(
			model,
			{
				systemPrompt: firstContext.systemPrompt,
				messages: [
					...firstContext.messages,
					firstResponse,
					{ role: "user", content: "Second question", timestamp: Date.now() + 1 },
				],
			},
			{
				apiKey: token,
				sessionId,
				fallbackManaged: true,
				streamMaxRetries: 0,
				disableProviderRetries: true,
				providerSessionState,
			},
		).result();

		expect(secondResponse.stopReason).toBe("error");
		expect(sentRequests).toHaveLength(2);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("retries websocket continuations when codex-lb masks stale previous_response_id", async () => {
		const tempDir = TempDir.createSync("@pi-codex-lb-stale-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const sentRequests: Array<Record<string, unknown>> = [];
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not be called");
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		class MaskedPreviousResponseMissingWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			send(data: string): void {
				const request = JSON.parse(data) as Record<string, unknown>;
				sentRequests.push(request);
				const requestIndex = sentRequests.length;

				if (requestIndex === 1) {
					this.emitCodexResponse({
						messageId: "msg_1",
						responseId: "resp_1",
						text: "First answer",
						terminalType: "response.completed",
						includeCreated: true,
					});
					return;
				}

				if (requestIndex === 2) {
					expect(request.previous_response_id).toBe("resp_1");
					this.sendJson({
						type: "response.failed",
						response: {
							id: "resp_masked_failure",
							status: "failed",
							error: {
								type: "server_error",
								code: "codex_previous_response_stale",
								message: "Upstream previous response anchor expired; retry without previous_response_id.",
							},
						},
					});
					return;
				}

				if (requestIndex === 3) {
					expect(request.previous_response_id).toBeUndefined();
					this.emitCodexResponse({
						messageId: "msg_3",
						responseId: "resp_3",
						text: "Second answer",
						terminalType: "response.completed",
						includeCreated: true,
					});
					return;
				}

				throw new Error(`Unexpected websocket request index: ${requestIndex}`);
			}
		}

		global.WebSocket = MaskedPreviousResponseMissingWebSocket as unknown as typeof WebSocket;
		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const firstContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "First question", timestamp: Date.now() }],
		};
		const firstResponse = await streamOpenAICodexResponses(model, firstContext, {
			apiKey: token,
			sessionId: "ws-masked-expired-previous-response-session",
			providerSessionState,
		}).result();
		const secondContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [
				...firstContext.messages,
				firstResponse,
				{ role: "user", content: "Second question", timestamp: Date.now() + 1 },
			],
		};

		const secondResponse = await streamOpenAICodexResponses(model, secondContext, {
			apiKey: token,
			sessionId: "ws-masked-expired-previous-response-session",
			providerSessionState,
		}).result();

		expect(secondResponse.stopReason).toBe("stop");
		expect(JSON.stringify(secondResponse.content)).toContain("Second answer");
		expect(fetchMock).not.toHaveBeenCalled();
		expect(sentRequests).toHaveLength(3);
		const retryInput = sentRequests[2]?.input;
		expect(Array.isArray(retryInput)).toBe(true);
		expect(JSON.stringify(retryInput)).toContain("First question");
		expect(JSON.stringify(retryInput)).toContain("Second question");
	});

	it("retries websocket continuations when Codex rejects the anchor as a generic invalid_request_error", async () => {
		const tempDir = TempDir.createSync("@pi-codex-invalid-anchor-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const sentRequests: Array<Record<string, unknown>> = [];
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not be called");
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		class InvalidPreviousResponseIdWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			send(data: string): void {
				const request = JSON.parse(data) as Record<string, unknown>;
				sentRequests.push(request);
				const requestIndex = sentRequests.length;

				if (requestIndex === 1) {
					this.emitCodexResponse({
						messageId: "msg_1",
						responseId: "resp_1",
						text: "First answer",
						terminalType: "response.completed",
						includeCreated: true,
					});
					return;
				}

				if (requestIndex === 2) {
					expect(request.previous_response_id).toBe("resp_1");
					this.sendJson({
						type: "error",
						error: {
							type: "invalid_request_error",
							code: "invalid_request_error",
							message: "Invalid `previous_response_id`.",
						},
					});
					return;
				}

				if (requestIndex === 3) {
					expect(request.previous_response_id).toBeUndefined();
					this.emitCodexResponse({
						messageId: "msg_3",
						responseId: "resp_3",
						text: "Second answer",
						terminalType: "response.completed",
						includeCreated: true,
					});
					return;
				}

				throw new Error(`Unexpected websocket request index: ${requestIndex}`);
			}
		}

		global.WebSocket = InvalidPreviousResponseIdWebSocket as unknown as typeof WebSocket;
		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const firstContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "First question", timestamp: Date.now() }],
		};
		const firstResponse = await streamOpenAICodexResponses(model, firstContext, {
			apiKey: token,
			sessionId: "ws-invalid-previous-response-session",
			providerSessionState,
		}).result();
		const secondContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [
				...firstContext.messages,
				firstResponse,
				{ role: "user", content: "Second question", timestamp: Date.now() + 1 },
			],
		};

		const secondResponse = await streamOpenAICodexResponses(model, secondContext, {
			apiKey: token,
			sessionId: "ws-invalid-previous-response-session",
			providerSessionState,
		}).result();

		expect(secondResponse.stopReason).toBe("stop");
		expect(JSON.stringify(secondResponse.content)).toContain("Second answer");
		expect(fetchMock).not.toHaveBeenCalled();
		expect(sentRequests).toHaveLength(3);
		const retryInput = sentRequests[2]?.input;
		expect(Array.isArray(retryInput)).toBe(true);
		expect(JSON.stringify(retryInput)).toContain("First question");
		expect(JSON.stringify(retryInput)).toContain("First answer");
		expect(JSON.stringify(retryInput)).toContain("Second question");

		const stats = getOpenAICodexWebSocketDebugStats(model, {
			sessionId: "ws-invalid-previous-response-session",
			providerSessionState,
		});
		expect(stats?.lastPreviousResponseId).toBeUndefined();
	});

	it.each([
		["tool call id fault", "Previous response's tool call ID is malformed."],
		["missing call id", "Invalid tool call in previous response; call ID is missing."],
		["unknown message id", "Previous response's message ID is unknown."],
		// No stale qualifier in the RAW message. Only display formatting appends
		// `(code=invalid_request_error)`; classifying the formatted string would
		// manufacture the "invalid" the provider never sent next to the token.
		["schema fault naming the anchor field", "The previous_response_id field is required."],
	])("keeps a deterministic %s fatal instead of replaying full context", async (_label, providerMessage) => {
		const tempDir = TempDir.createSync("@pi-codex-anchor-nearmiss-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const sentRequests: Array<Record<string, unknown>> = [];
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not be called");
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		class NearMissWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			send(data: string): void {
				const request = JSON.parse(data) as Record<string, unknown>;
				sentRequests.push(request);
				if (sentRequests.length === 1) {
					this.emitCodexResponse({
						messageId: "msg_1",
						responseId: "resp_1",
						text: "First answer",
						terminalType: "response.completed",
						includeCreated: true,
					});
					return;
				}
				expect(request.previous_response_id).toBe("resp_1");
				this.sendJson({
					type: "error",
					error: { type: "invalid_request_error", code: "invalid_request_error", message: providerMessage },
				});
			}
		}

		global.WebSocket = NearMissWebSocket as unknown as typeof WebSocket;
		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const sessionId = "ws-anchor-near-miss-session";
		const firstContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "First question", timestamp: Date.now() }],
		};
		const firstResponse = await streamOpenAICodexResponses(model, firstContext, {
			apiKey: token,
			sessionId,
			providerSessionState,
		}).result();
		const secondResponse = await streamOpenAICodexResponses(
			model,
			{
				systemPrompt: ["You are a helpful assistant."],
				messages: [
					...firstContext.messages,
					firstResponse,
					{ role: "user", content: "Second question", timestamp: Date.now() + 1 },
				],
			},
			{ apiKey: token, sessionId, providerSessionState },
		).result();

		expect(secondResponse.stopReason).toBe("error");
		// Exactly one continuation attempt: no anchor-clearing full-context replay.
		expect(sentRequests).toHaveLength(2);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("keeps an anchor-naming rejection fatal when the request sent no anchor", async () => {
		const tempDir = TempDir.createSync("@pi-codex-no-anchor-sent-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const sentRequests: Array<Record<string, unknown>> = [];
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not be called");
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		class RequiresAnchorWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			send(data: string): void {
				sentRequests.push(JSON.parse(data) as Record<string, unknown>);
				// The very first turn never carries an anchor. A rejection naming the
				// field is a real validation fault, not a stale continuation.
				this.sendJson({
					type: "error",
					error: {
						type: "invalid_request_error",
						code: "invalid_request_error",
						message: "Invalid request: previous_response_id is required",
					},
				});
			}
		}

		global.WebSocket = RequiresAnchorWebSocket as unknown as typeof WebSocket;
		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const response = await streamOpenAICodexResponses(
			model,
			{
				systemPrompt: ["You are a helpful assistant."],
				messages: [{ role: "user", content: "First question", timestamp: Date.now() }],
			},
			{
				apiKey: token,
				sessionId: "ws-no-anchor-sent-session",
				providerSessionState: new Map<string, ProviderSessionState>(),
			},
		).result();

		expect(response.stopReason).toBe("error");
		// No anchor was sent, so no state-clearing replay may be attempted.
		expect(sentRequests).toHaveLength(1);
		expect(sentRequests[0]?.previous_response_id).toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("bounds Codex anchor recovery to a single full-context replay", async () => {
		const tempDir = TempDir.createSync("@pi-codex-anchor-oneshot-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const sentRequests: Array<Record<string, unknown>> = [];
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not be called");
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		class AlwaysRejectsAnchorWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			send(data: string): void {
				sentRequests.push(JSON.parse(data) as Record<string, unknown>);
				if (sentRequests.length === 1) {
					this.emitCodexResponse({
						messageId: "msg_1",
						responseId: "resp_1",
						text: "First answer",
						terminalType: "response.completed",
						includeCreated: true,
					});
					return;
				}
				this.sendJson({
					type: "error",
					error: {
						type: "invalid_request_error",
						code: "invalid_request_error",
						message: "Invalid `previous_response_id`.",
					},
				});
			}
		}

		global.WebSocket = AlwaysRejectsAnchorWebSocket as unknown as typeof WebSocket;
		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const sessionId = "ws-anchor-one-shot-session";
		const firstContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "First question", timestamp: Date.now() }],
		};
		const firstResponse = await streamOpenAICodexResponses(model, firstContext, {
			apiKey: token,
			sessionId,
			providerSessionState,
		}).result();
		const secondResponse = await streamOpenAICodexResponses(
			model,
			{
				systemPrompt: ["You are a helpful assistant."],
				messages: [
					...firstContext.messages,
					firstResponse,
					{ role: "user", content: "Second question", timestamp: Date.now() + 1 },
				],
			},
			{ apiKey: token, sessionId, providerSessionState },
		).result();

		expect(secondResponse.stopReason).toBe("error");
		// Anchored attempt + exactly one anchor-free replay, then the error surfaces.
		expect(sentRequests).toHaveLength(3);
		expect(sentRequests[1]?.previous_response_id).toBe("resp_1");
		expect(sentRequests[2]?.previous_response_id).toBeUndefined();
	});

	it.each([
		["backticked identifier", "Invalid `previous_response_id`."],
		["prose wording", "Invalid previous response ID provided."],
		["hyphenated identifier", "previous-response-id expired"],
		["trailing predicate", "previous_response_id is no longer valid"],
	])("recovers a Codex anchor rejection worded as %s", async (_label, providerMessage) => {
		const tempDir = TempDir.createSync("@pi-codex-anchor-wording-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const sentRequests: Array<Record<string, unknown>> = [];
		global.fetch = vi.fn(async () => {
			throw new Error("SSE fallback should not be called");
		}) as unknown as typeof fetch;

		class AnchorWordingWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			send(data: string): void {
				const request = JSON.parse(data) as Record<string, unknown>;
				sentRequests.push(request);
				const requestIndex = sentRequests.length;
				if (requestIndex === 2) {
					expect(request.previous_response_id).toBe("resp_1");
					this.sendJson({
						type: "error",
						error: { type: "invalid_request_error", code: "invalid_request_error", message: providerMessage },
					});
					return;
				}
				if (requestIndex === 3) expect(request.previous_response_id).toBeUndefined();
				this.emitCodexResponse({
					messageId: `msg_${requestIndex}`,
					responseId: `resp_${requestIndex}`,
					text: requestIndex === 1 ? "First answer" : "Second answer",
					terminalType: "response.completed",
					includeCreated: true,
				});
			}
		}

		global.WebSocket = AnchorWordingWebSocket as unknown as typeof WebSocket;
		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const sessionId = "ws-anchor-wording-session";
		const firstContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "First question", timestamp: Date.now() }],
		};
		const firstResponse = await streamOpenAICodexResponses(model, firstContext, {
			apiKey: token,
			sessionId,
			providerSessionState,
		}).result();
		const secondResponse = await streamOpenAICodexResponses(
			model,
			{
				systemPrompt: ["You are a helpful assistant."],
				messages: [
					...firstContext.messages,
					firstResponse,
					{ role: "user", content: "Second question", timestamp: Date.now() + 1 },
				],
			},
			{ apiKey: token, sessionId, providerSessionState },
		).result();

		expect(secondResponse.stopReason).toBe("stop");
		expect(sentRequests).toHaveLength(3);
		expect(JSON.stringify(sentRequests[2]?.input)).toContain("First question");
	});
	it.each([
		// codex-lb masks the anchor fault's specific code to invalid_request_error
		// and keeps only the canonical not-found/expired prose; the same masking it
		// already applies to codex_previous_response_stale. The third element
		// controls whether the event carries the masked code at all.
		["canonical not-found prose with masked code", "Previous response with id 'resp_1' not found.", true],
		["canonical not-found prose without a code", "Previous response with id 'resp_1' not found.", false],
		["expired prose with masked code", "The previous response 'resp_1' has expired.", true],
		["unknown-anchor prose", "Unknown previous response 'resp_1'.", true],
		// Cross-sentence coincidence inside the 48-char window is a deliberate
		// trade-off: the anchor-sent + one-shot + zero-content gates bound the
		// worst case to one extra full-context request, so ambiguity resolves
		// toward recovery instead of killing the turn.
		[
			"cross-sentence stale qualifier",
			"The requested resource was not found in the archive. Please inspect the previous response.",
			true,
		],
	])("recovers a Codex stale anchor worded as %s", async (_label, providerMessage, includeCode) => {
		const tempDir = TempDir.createSync("@pi-codex-anchor-prose-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const sentRequests: Array<Record<string, unknown>> = [];
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not be called");
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		class AnchorProseWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			send(data: string): void {
				const request = JSON.parse(data) as Record<string, unknown>;
				sentRequests.push(request);
				const requestIndex = sentRequests.length;
				if (requestIndex === 2) {
					expect(request.previous_response_id).toBe("resp_1");
					this.sendJson({
						type: "error",
						error: includeCode
							? { type: "invalid_request_error", code: "invalid_request_error", message: providerMessage }
							: { message: providerMessage },
					});
					return;
				}
				if (requestIndex === 3) expect(request.previous_response_id).toBeUndefined();
				this.emitCodexResponse({
					messageId: `msg_${requestIndex}`,
					responseId: `resp_${requestIndex}`,
					text: requestIndex === 1 ? "First answer" : "Second answer",
					terminalType: "response.completed",
					includeCreated: true,
				});
			}
		}

		global.WebSocket = AnchorProseWebSocket as unknown as typeof WebSocket;
		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const sessionId = "ws-anchor-prose-session";
		const firstContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "First question", timestamp: Date.now() }],
		};
		const firstResponse = await streamOpenAICodexResponses(model, firstContext, {
			apiKey: token,
			sessionId,
			providerSessionState,
		}).result();
		const secondResponse = await streamOpenAICodexResponses(
			model,
			{
				systemPrompt: ["You are a helpful assistant."],
				messages: [
					...firstContext.messages,
					firstResponse,
					{ role: "user", content: "Second question", timestamp: Date.now() + 1 },
				],
			},
			{ apiKey: token, sessionId, providerSessionState },
		).result();

		expect(secondResponse.stopReason).toBe("stop");
		expect(JSON.stringify(secondResponse.content)).toContain("Second answer");
		expect(fetchMock).not.toHaveBeenCalled();
		// Anchored attempt, one anchor-free full-context replay, nothing more.
		expect(sentRequests).toHaveLength(3);
		expect(sentRequests[1]?.previous_response_id).toBe("resp_1");
		expect(sentRequests[2]?.previous_response_id).toBeUndefined();
		const retryInput = sentRequests[2]?.input;
		expect(Array.isArray(retryInput)).toBe(true);
		expect(JSON.stringify(retryInput)).toContain("First question");
		expect(JSON.stringify(retryInput)).toContain("First answer");
		expect(JSON.stringify(retryInput)).toContain("Second question");
	});

	it.each([
		// Sub-field faults INSIDE the previous response are deterministic history
		// faults; replaying full context would re-send the same offending item.
		["tool call fault in prose", "Unknown tool call in previous response."],
		["message id fault in prose", "Unknown message ID in previous response."],
		["item fault in prose", "Unknown item in previous response."],
		["function call fault in prose", "Previous response's function call is invalid."],
		// The fault noun may FOLLOW the anchor phrase as well: the sub-field guard
		// applies on both sides of the reference.
		["tool call fault after the anchor phrase", "Unknown previous response tool call."],
		["output item fault after the anchor phrase", "Unknown previous response output item."],
		["call id fault after the anchor phrase", "Unknown previous response call id fc_1."],
		// ... and after the QUALIFIER in the token-first ordering.
		["sub-field fault after the qualifier", "Previous response includes an unknown tool call."],
		["output item fault after the qualifier", "Previous response contains an invalid output item."],
		// Span bound and line bound: a stale qualifier more than 48 chars from the
		// reference, or across a line break, is not an anchor-stale message.
		[
			"stale qualifier beyond the span bound",
			"Previous response 'resp_1' referenced by this very long request identifier string is no longer available.",
		],
		["stale qualifier across a line break", "The previous response\nwith id 'resp_1' was not found."],
	])("keeps a %s fatal instead of replaying full context", async (_label, providerMessage) => {
		const tempDir = TempDir.createSync("@pi-codex-anchor-prose-nearmiss-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const sentRequests: Array<Record<string, unknown>> = [];
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not be called");
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		class AnchorProseNearMissWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			send(data: string): void {
				const request = JSON.parse(data) as Record<string, unknown>;
				sentRequests.push(request);
				if (sentRequests.length === 1) {
					this.emitCodexResponse({
						messageId: "msg_1",
						responseId: "resp_1",
						text: "First answer",
						terminalType: "response.completed",
						includeCreated: true,
					});
					return;
				}
				expect(request.previous_response_id).toBe("resp_1");
				this.sendJson({
					type: "error",
					error: { type: "invalid_request_error", code: "invalid_request_error", message: providerMessage },
				});
			}
		}

		global.WebSocket = AnchorProseNearMissWebSocket as unknown as typeof WebSocket;
		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const sessionId = "ws-anchor-prose-near-miss-session";
		const firstContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "First question", timestamp: Date.now() }],
		};
		const firstResponse = await streamOpenAICodexResponses(model, firstContext, {
			apiKey: token,
			sessionId,
			providerSessionState,
		}).result();
		const secondResponse = await streamOpenAICodexResponses(
			model,
			{
				systemPrompt: ["You are a helpful assistant."],
				messages: [
					...firstContext.messages,
					firstResponse,
					{ role: "user", content: "Second question", timestamp: Date.now() + 1 },
				],
			},
			{ apiKey: token, sessionId, providerSessionState },
		).result();

		expect(secondResponse.stopReason).toBe("error");
		// Exactly one continuation attempt: no anchor-clearing full-context replay.
		expect(sentRequests).toHaveLength(2);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("keeps a genuine invalid_request_error fatal when no continuation anchor is implicated", async () => {
		const tempDir = TempDir.createSync("@pi-codex-invalid-request-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const sentRequests: Array<Record<string, unknown>> = [];
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not be called");
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		class InvalidRequestWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			send(data: string): void {
				sentRequests.push(JSON.parse(data) as Record<string, unknown>);
				this.sendJson({
					type: "error",
					error: {
						type: "invalid_request_error",
						code: "invalid_request_error",
						message: "Invalid value for 'model'.",
					},
				});
			}
		}

		global.WebSocket = InvalidRequestWebSocket as unknown as typeof WebSocket;
		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const response = await streamOpenAICodexResponses(
			model,
			{
				systemPrompt: ["You are a helpful assistant."],
				messages: [{ role: "user", content: "First question", timestamp: Date.now() }],
			},
			{
				apiKey: token,
				sessionId: "ws-invalid-request-session",
				providerSessionState: new Map<string, ProviderSessionState>(),
			},
		).result();

		expect(response.stopReason).toBe("error");
		expect(sentRequests).toHaveLength(1);
	});

	it("uses low Codex text verbosity by default while preserving explicit overrides", async () => {
		const tempDir = TempDir.createSync("@pi-codex-verbosity-");
		setAgentDir(tempDir.path());
		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;
		const capturedBodies: Array<Record<string, unknown>> = [];
		const sse = `${[
			`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "message", id: "msg_verbosity", role: "assistant", status: "in_progress", content: [] } })}`,
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}`,
			`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", id: "msg_verbosity", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello" }] } })}`,
			`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
		].join("\n\n")}\n\n`;
		const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
			capturedBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
		});
		global.fetch = fetchMock as unknown as typeof fetch;
		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};
		const context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		await streamOpenAICodexResponses(model, context, { apiKey: token }).result();
		await streamOpenAICodexResponses(model, context, { apiKey: token, textVerbosity: "high" }).result();

		expect((capturedBodies[0]?.text as { verbosity?: string } | undefined)?.verbosity).toBe("low");
		expect((capturedBodies[1]?.text as { verbosity?: string } | undefined)?.verbosity).toBe("high");
	});

	it("sends the websocket v2 beta header on every websocket transport", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;

		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not be called");
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		class WebSocketV2HeaderProbe extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				expect(options?.headers?.["OpenAI-Beta"] ?? options?.headers?.["openai-beta"]).toBe(
					"responses_websockets=2026-02-06",
				);
				this.scheduleOpen();
			}

			send(): void {
				this.emitCodexResponse({ messageId: "msg_v2", responseId: "resp_v2", text: "Hello v2" });
			}
		}

		global.WebSocket = WebSocketV2HeaderProbe as unknown as typeof WebSocket;

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			preferWebsockets: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 128000,
		};
		const context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};
		const providerSessionState = new Map<string, ProviderSessionState>();
		await streamOpenAICodexResponses(model, context, {
			apiKey: token,
			sessionId: "ws-v2-session",
			providerSessionState,
		}).result();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("discards a timed-out prewarmed websocket before the outer retry", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		Bun.env.PI_CODEX_WEBSOCKET_RETRY_BUDGET = "0";

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;

		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback must not run for a typed first-event timeout");
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		let sendCount = 0;
		const sockets: IdleWebSocket[] = [];
		class IdleWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				sockets.push(this);
				this.scheduleOpen();
			}

			send(): void {
				sendCount += 1;
				if (sendCount === 1) {
					setTimeout(() => {
						this.emitCodexResponse({
							messageId: "msg_stale",
							responseId: "resp_stale",
							text: "Stale response",
						});
					}, 25);
					return;
				}
				if (sendCount === 2) {
					setTimeout(() => {
						this.emitCodexResponse({
							messageId: "msg_fresh",
							responseId: "resp_fresh",
							text: "Fresh response",
						});
					}, 30);
					return;
				}
				throw new Error(`Unexpected websocket send ${sendCount}`);
			}
		}

		global.WebSocket = IdleWebSocket as unknown as typeof WebSocket;

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			preferWebsockets: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 128000,
		};
		const context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};
		const providerSessionState = new Map<string, ProviderSessionState>();
		await prewarmOpenAICodexResponses(model, {
			apiKey: token,
			sessionId: "ws-idle-timeout-session",
			providerSessionState,
		});

		const first = await streamOpenAICodexResponses(model, context, {
			apiKey: token,
			sessionId: "ws-idle-timeout-session",
			providerSessionState,
			streamFirstEventTimeoutMs: 10,
		}).result();
		expect(first.stopReason).toBe("error");
		expect(first.errorMessage).toBe("Codex websocket transport error: timeout waiting for first websocket event");
		expect(first.transportFailure).toMatchObject({
			kind: "transport",
			providerCode: "stream_first_event_timeout",
		});
		expect(sockets).toHaveLength(1);
		expect(sockets[0]?.readyState).toBe(MockWebSocket.CLOSED);
		const afterTimeout = getOpenAICodexTransportDetails(model, {
			sessionId: "ws-idle-timeout-session",
			providerSessionState,
		});
		expect(afterTimeout.websocketConnected).toBe(false);
		expect(afterTimeout.websocketDisabled).toBe(false);
		expect(afterTimeout.fallbackCount).toBe(0);

		const second = await streamOpenAICodexResponses(model, context, {
			apiKey: token,
			sessionId: "ws-idle-timeout-session",
			providerSessionState,
			streamFirstEventTimeoutMs: 100,
		}).result();
		expect(sendCount).toBe(2);
		expect(sockets).toHaveLength(2);
		expect(second.stopReason).toBe("stop");
		expect(second.content.find(block => block.type === "text")?.text).toBe("Fresh response");
		expect(second.content.find(block => block.type === "text")?.text).not.toContain("Stale response");
		expect(fetchMock).not.toHaveBeenCalled();
		const afterRetry = getOpenAICodexTransportDetails(model, {
			sessionId: "ws-idle-timeout-session",
			providerSessionState,
		});
		expect(afterRetry.lastTransport).toBe("websocket");
		expect(afterRetry.websocketConnected).toBe(true);
		expect(afterRetry.websocketDisabled).toBe(false);
		expect(afterRetry.fallbackCount).toBe(0);
	});

	it("falls back to SSE when websocket status events do not make semantic progress", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const sse = createCompletedCodexSse("Hello fallback");
		const fetchMock = vi.fn(async () => {
			return new Response(sse, { headers: { "content-type": "text/event-stream" } });
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		let sendCount = 0;
		let interval: NodeJS.Timeout | undefined;
		const sockets: NoProgressWebSocket[] = [];
		class NoProgressWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				sockets.push(this);
				this.scheduleOpen();
			}

			send(): void {
				sendCount += 1;
				this.sendJson({
					type: "response.output_item.added",
					item: {
						type: "function_call",
						id: "fc_ws_stalled",
						call_id: "call_ws_stalled",
						name: "todo_write",
						arguments: "",
					},
				});
				interval = setInterval(() => {
					this.sendJson({
						type: "response.in_progress",
						response: { id: "resp_ws_stalled", status: "in_progress" },
					});
				}, 2);
			}

			close(): void {
				if (interval) clearInterval(interval);
				super.close();
			}
		}
		global.WebSocket = NoProgressWebSocket as unknown as typeof WebSocket;

		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const result = await streamOpenAICodexResponses(model, createCodexTestContext(), {
			apiKey: token,
			sessionId: "ws-no-progress-session",
			providerSessionState,
			streamIdleTimeoutMs: 20,
		}).result();

		expect(sendCount).toBe(1);
		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(sockets[0]?.readyState).toBe(MockWebSocket.CLOSED);
		const transportDetails = getOpenAICodexTransportDetails(model, {
			sessionId: "ws-no-progress-session",
			providerSessionState,
		});
		expect(transportDetails.lastTransport).toBe("sse");
		expect(transportDetails.websocketDisabled).toBe(true);
	});

	it("bounds the websocket first-progress window across repeated no-op deltas", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		let interval: NodeJS.Timeout | undefined;
		class NoFirstProgressWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}
			send(): void {
				interval = setInterval(() => {
					this.sendJson({ type: "response.output_text.delta", delta: 42 });
				}, 2);
			}
			close(): void {
				if (interval) clearInterval(interval);
				super.close();
			}
		}
		global.WebSocket = NoFirstProgressWebSocket as unknown as typeof WebSocket;
		const result = await streamOpenAICodexResponses(
			createCodexTestModel("https://chatgpt.com/backend-api"),
			createCodexTestContext(),
			{
				apiKey: createCodexTestToken(),
				sessionId: "ws-first-progress-noop",
				providerSessionState: new Map<string, ProviderSessionState>(),
				streamFirstEventTimeoutMs: 20,
				streamIdleTimeoutMs: 500,
			},
		).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("timeout waiting for first websocket event");
	});

	it("retries websocket stream closes before surfacing transport errors", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		Bun.env.PI_CODEX_WEBSOCKET_RETRY_BUDGET = "1";
		Bun.env.PI_CODEX_WEBSOCKET_RETRY_DELAY_MS = "1";

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not be called when websocket retry succeeds");
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		let constructorCount = 0;
		const requestTypes: string[] = [];

		class FlakyCloseWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				constructorCount += 1;
				this.scheduleOpen();
			}

			send(data: string): void {
				const request = JSON.parse(data) as { type?: string };
				requestTypes.push(typeof request.type === "string" ? request.type : "");
				if (requestTypes.length === 1) {
					this.readyState = MockWebSocket.CLOSED;
					this.emit("close", { code: 1012 } as unknown as Event);
					return;
				}
				this.emitCodexResponse({
					messageId: "msg_retry_close",
					responseId: "resp_retry_close",
					text: "Hello retry close",
				});
			}
		}

		global.WebSocket = FlakyCloseWebSocket as unknown as typeof WebSocket;

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			preferWebsockets: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 128000,
		};
		const context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};
		const providerSessionState = new Map<string, ProviderSessionState>();
		const result = await streamOpenAICodexResponses(model, context, {
			apiKey: token,
			sessionId: "ws-retry-close-session",
			providerSessionState,
		}).result();

		expect(result.role).toBe("assistant");
		expect(constructorCount).toBe(2);
		expect(requestTypes).toEqual(["response.create", "response.create"]);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("falls back to SSE when websocket becomes unavailable before stream start", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		Bun.env.PI_CODEX_WEBSOCKET_RETRY_BUDGET = "0";
		Bun.env.PI_CODEX_WEBSOCKET_RETRY_DELAY_MS = "1";

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;
		const sse = `${[
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello fallback" })}`,
			`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", id: "msg_ws_unavailable", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello fallback" }] } })}`,
			`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
		].join("\n\n")}\n\n`;

		const fetchMock = vi.fn(async (input: string | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				return new Response(sse, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		class UnavailableBeforeStreamWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				setTimeout(() => {
					this.readyState = MockWebSocket.OPEN;
					this.emit("open", new Event("open"));
					this.readyState = MockWebSocket.CLOSED;
					this.emit("close", { code: 1006 } as unknown as Event);
				}, 0);
			}
		}

		global.WebSocket = UnavailableBeforeStreamWebSocket as unknown as typeof WebSocket;

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			preferWebsockets: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 128000,
		};
		const context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};
		const providerSessionState = new Map<string, ProviderSessionState>();
		const result = await streamOpenAICodexResponses(model, context, {
			apiKey: token,
			sessionId: "ws-unavailable-session",
			providerSessionState,
		}).result();

		expect(result.role).toBe("assistant");
		expect(result.stopReason).not.toBe("error");
		expect(result.errorMessage).toBeUndefined();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const transportDetails = getOpenAICodexTransportDetails(model, {
			sessionId: "ws-unavailable-session",
			providerSessionState,
		});
		expect(transportDetails.lastTransport).toBe("sse");
		expect(transportDetails.websocketDisabled).toBe(true);
		expect(transportDetails.fallbackCount).toBe(1);
	});

	it("releases an in-flight websocket request when the stream consumer returns early", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const providerSessionState = new Map<string, ProviderSessionState>();
		const sentTypesByConnection: string[][] = [];
		let constructorCount = 0;

		class ConsumerReturnWebSocket extends MockWebSocket {
			#connectionIndex: number;

			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.#connectionIndex = constructorCount++;
				sentTypesByConnection[this.#connectionIndex] = [];
				this.scheduleOpen();
			}

			send(data: string): void {
				const request = JSON.parse(data) as { type?: string };
				const requestType = typeof request.type === "string" ? request.type : "";
				sentTypesByConnection[this.#connectionIndex]?.push(requestType);
				if (this.#connectionIndex === 0) {
					this.sendJson({
						type: "response.output_item.added",
						item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
					});
					this.sendJson({ type: "response.content_part.added", part: { type: "output_text", text: "" } });
					this.sendJson({ type: "response.output_text.delta", delta: "oversized provisional payload" });
					return;
				}
				this.emitCodexResponse({ messageId: "msg_2", responseId: "resp_2", text: "clean successor" });
			}
		}

		global.WebSocket = ConsumerReturnWebSocket as unknown as typeof WebSocket;
		global.fetch = vi.fn(async () => {
			throw new Error("SSE fallback should not be called");
		}) as unknown as typeof fetch;
		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const first = streamOpenAICodexResponses(model, createCodexTestContext(), {
			apiKey: token,
			sessionId: "ws-consumer-return-session",
			providerSessionState,
		});
		const iterator = first[Symbol.asyncIterator]();
		for (let i = 0; i < 3; i++) {
			const event = await iterator.next();
			expect(event.done).toBe(false);
		}
		await iterator.return?.();

		const successor = await streamOpenAICodexResponses(model, createCodexTestContext(), {
			apiKey: token,
			sessionId: "ws-consumer-return-session",
			providerSessionState,
		}).result();

		expect(successor.stopReason).toBe("stop");
		expect(successor.content).toEqual([expect.objectContaining({ type: "text", text: "clean successor" })]);
		expect(constructorCount).toBe(2);
		expect(sentTypesByConnection).toEqual([["response.create"], ["response.create"]]);
	});

	it("resets websocket append state after an aborted request closes the connection", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not be called");
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		const sentTypesByConnection: string[][] = [];
		let constructorCount = 0;
		let abortSecondRequest: (() => void) | undefined;

		class AbortResetWebSocket extends MockWebSocket {
			#connectionIndex: number;

			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.#connectionIndex = constructorCount;
				constructorCount += 1;
				sentTypesByConnection[this.#connectionIndex] = [];
				this.scheduleOpen();
			}

			send(data: string): void {
				const request = JSON.parse(data) as { type?: string };
				const requestType = typeof request.type === "string" ? request.type : "";
				sentTypesByConnection[this.#connectionIndex]?.push(requestType);
				const requestIndex = sentTypesByConnection[this.#connectionIndex]?.length ?? 0;

				if (this.#connectionIndex === 0 && requestIndex === 1) {
					this.emitCodexResponse({ messageId: "msg_1", responseId: "resp_1", text: "Hello one" });
					return;
				}
				if (this.#connectionIndex === 0 && requestIndex === 2) {
					this.sendJson({
						type: "response.output_item.added",
						item: { type: "message", id: "msg_2", role: "assistant", status: "in_progress", content: [] },
					});
					this.sendJson({ type: "response.content_part.added", part: { type: "output_text", text: "" } });
					this.sendJson({ type: "response.output_text.delta", delta: "Still streaming" });
					setTimeout(() => {
						abortSecondRequest?.();
					}, 0);
					return;
				}
				if (this.#connectionIndex === 1 && requestIndex === 1) {
					expect(requestType).toBe("response.create");
					this.emitCodexResponse({ messageId: "msg_3", responseId: "resp_3", text: "Hello three" });
					return;
				}
				throw new Error(`Unexpected websocket send sequence: ${this.#connectionIndex}:${requestIndex}`);
			}
		}

		global.WebSocket = AbortResetWebSocket as unknown as typeof WebSocket;
		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			preferWebsockets: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 128000,
		};
		const firstContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};
		const secondContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [
				{ role: "user", content: "Say hello", timestamp: Date.now() },
				{ role: "user", content: "Keep going", timestamp: Date.now() + 1 },
			],
		};
		const thirdContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [
				{ role: "user", content: "Say hello", timestamp: Date.now() },
				{ role: "user", content: "Keep going", timestamp: Date.now() + 1 },
				{ role: "user", content: "Finish", timestamp: Date.now() + 2 },
			],
		};
		const providerSessionState = new Map<string, ProviderSessionState>();

		const firstResult = await streamOpenAICodexResponses(model, firstContext, {
			apiKey: token,
			sessionId: "ws-abort-reset-session",
			providerSessionState,
		}).result();
		expect(firstResult.role).toBe("assistant");

		const secondAbortController = new AbortController();
		abortSecondRequest = () => {
			secondAbortController.abort();
		};
		const secondResult = await streamOpenAICodexResponses(model, secondContext, {
			apiKey: token,
			sessionId: "ws-abort-reset-session",
			signal: secondAbortController.signal,
			providerSessionState,
		}).result();
		expect(secondResult.stopReason).toBe("aborted");

		const thirdResult = await streamOpenAICodexResponses(model, thirdContext, {
			apiKey: token,
			sessionId: "ws-abort-reset-session",
			providerSessionState,
		}).result();
		expect(thirdResult.role).toBe("assistant");
		expect(constructorCount).toBe(2);
		expect(sentTypesByConnection[0]).toEqual(["response.create", "response.create"]);
		expect(sentTypesByConnection[1]).toEqual(["response.create"]);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("resets websocket append state after websocket error events", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not be called");
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		const sentTypes: string[] = [];
		let constructorCount = 0;

		class ErrorResetWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				constructorCount += 1;
				this.scheduleOpen();
			}

			send(data: string): void {
				const request = JSON.parse(data) as { type?: string };
				const requestType = typeof request.type === "string" ? request.type : "";
				sentTypes.push(requestType);
				const requestIndex = sentTypes.length;

				if (requestIndex === 1) {
					this.emitCodexResponse({ messageId: "msg_1", responseId: "resp_1", text: "Hello one" });
					return;
				}
				if (requestIndex === 2) {
					this.sendJson({
						type: "error",
						code: "invalid_request_error",
						message: "simulated request error",
					});
					return;
				}
				if (requestIndex === 3) {
					expect(requestType).toBe("response.create");
					this.emitCodexResponse({ messageId: "msg_3", responseId: "resp_3", text: "Hello three" });
					return;
				}
				throw new Error(`Unexpected websocket request index: ${requestIndex}`);
			}
		}

		global.WebSocket = ErrorResetWebSocket as unknown as typeof WebSocket;
		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			preferWebsockets: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 128000,
		};
		const firstContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};
		const secondContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [
				{ role: "user", content: "Say hello", timestamp: Date.now() },
				{ role: "user", content: "Keep going", timestamp: Date.now() + 1 },
			],
		};
		const thirdContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [
				{ role: "user", content: "Say hello", timestamp: Date.now() },
				{ role: "user", content: "Keep going", timestamp: Date.now() + 1 },
				{ role: "user", content: "Finish", timestamp: Date.now() + 2 },
			],
		};
		const providerSessionState = new Map<string, ProviderSessionState>();

		const firstResult = await streamOpenAICodexResponses(model, firstContext, {
			apiKey: token,
			sessionId: "ws-error-reset-session",
			providerSessionState,
		}).result();
		expect(firstResult.role).toBe("assistant");

		const secondResult = await streamOpenAICodexResponses(model, secondContext, {
			apiKey: token,
			sessionId: "ws-error-reset-session",
			providerSessionState,
		}).result();
		expect(secondResult.stopReason).toBe("error");
		expect(secondResult.errorMessage).toContain("simulated request error");

		const thirdResult = await streamOpenAICodexResponses(model, thirdContext, {
			apiKey: token,
			sessionId: "ws-error-reset-session",
			providerSessionState,
		}).result();
		expect(thirdResult.role).toBe("assistant");
		expect(constructorCount).toBe(1);
		expect(sentTypes).toEqual(["response.create", "response.create", "response.create"]);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("falls back to SSE when websocket receives malformed JSON before completion", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;
		Bun.env.PI_CODEX_WEBSOCKET_RETRY_BUDGET = "0";
		Bun.env.PI_CODEX_WEBSOCKET_RETRY_DELAY_MS = "1";

		const sse = `${[
			`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "message", id: "msg_sse", role: "assistant", status: "in_progress", content: [] } })}`,
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Recovered over SSE" })}`,
			`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", id: "msg_sse", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Recovered over SSE" }] } })}`,
			`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
		].join("\n\n")}\n\n`;
		const fetchMock = vi.fn(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		);
		global.fetch = fetchMock as unknown as typeof fetch;

		class MalformedMessageWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			send(): void {
				this.sendMessage("{");
			}
		}

		global.WebSocket = MalformedMessageWebSocket as unknown as typeof WebSocket;
		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			preferWebsockets: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 128000,
		};
		const result = await streamOpenAICodexResponses(
			model,
			{
				systemPrompt: ["You are a helpful assistant."],
				messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
			},
			{
				apiKey: token,
				sessionId: "ws-malformed-json-session",
				providerSessionState: new Map<string, ProviderSessionState>(),
			},
		).result();

		expect(result.stopReason).toBe("stop");
		expect(result.content.find(c => c.type === "text")?.text).toBe("Recovered over SSE");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it.each([
		"null",
		"42",
		'["task"]',
		'"task"',
	])("preserves recovery and diagnostics for non-record provisional arguments: %s", async argumentsJson => {
		for (const mode of ["replay", "close", "idle"] as const) {
			class ProvisionalArgumentsWebSocket extends MockWebSocket {
				constructor(url: string, options?: { headers?: WsHeaders }) {
					super(url, options);
					this.scheduleOpen();
				}
				send(): void {
					this.sendJson({
						type: "response.output_item.added",
						item: {
							type: "function_call",
							id: "fc_provisional",
							call_id: "call_provisional",
							name: "todo_write",
							arguments: "",
						},
					});
					this.sendJson({ type: "response.function_call_arguments.done", arguments: argumentsJson });
					// No output_item.done: successful JSON parsing does not validate the terminal object.
					if (mode !== "idle") {
						this.readyState = MockWebSocket.CLOSED;
						this.emit("close", { code: 1006 } as unknown as Event);
					}
				}
			}
			global.WebSocket = ProvisionalArgumentsWebSocket as unknown as typeof WebSocket;
			const fetchSpy = vi
				.spyOn(globalThis, "fetch")
				.mockResolvedValue(
					new Response(
						`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] } })}\n\n` +
							createCompletedCodexSse("Recovered from SSE"),
						{ headers: { "content-type": "text/event-stream" } },
					),
				);
			try {
				const result = await streamOpenAICodexResponses(
					createCodexTestModel("https://chatgpt.com/backend-api"),
					createCodexTestContext(),
					{
						apiKey: createCodexTestToken(),
						sessionId: `provisional-${argumentsJson}-${mode}`,
						providerSessionState: new Map<string, ProviderSessionState>(),
						streamIdleTimeoutMs: 25,
						disableProviderRetries: mode !== "replay",
					},
				).result();
				if (mode === "replay") {
					expect(result.stopReason).toBe("stop");
					expect(result.errorMessage).toBeUndefined();
					expect(result.content.find(block => block.type === "text")?.text).toBe("Recovered from SSE");
					expect(fetchSpy).toHaveBeenCalledTimes(1);
				} else {
					expect(result.stopReason).toBe("error");
					expect(result.errorMessage).toContain(
						mode === "idle" ? "idle timeout waiting for websocket" : "websocket closed (1006)",
					);
					expect(fetchSpy).not.toHaveBeenCalled();
				}
			} finally {
				fetchSpy.mockRestore();
			}
		}
	});

	it("replays over SSE when websocket closes after buffered output without a terminal event", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;
		Bun.env.PI_CODEX_WEBSOCKET_RETRY_BUDGET = "0";
		Bun.env.PI_CODEX_WEBSOCKET_RETRY_DELAY_MS = "1";

		const sse = `${[
			`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "message", id: "msg_sse_replay", role: "assistant", status: "in_progress", content: [] } })}`,
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Replay succeeded" })}`,
			`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", id: "msg_sse_replay", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Replay succeeded" }] } })}`,
			`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
		].join("\n\n")}\n\n`;
		const fetchMock = vi.fn(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		);
		global.fetch = fetchMock as unknown as typeof fetch;

		class BufferedCloseWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			send(): void {
				this.sendJson({
					type: "response.output_item.added",
					item: {
						type: "message",
						id: "msg_ws_partial",
						role: "assistant",
						status: "in_progress",
						content: [],
					},
				});
				this.sendJson({ type: "response.content_part.added", part: { type: "output_text", text: "" } });
				this.sendJson({ type: "response.output_text.delta", delta: "Partial output" });
				this.readyState = MockWebSocket.CLOSED;
				this.emit("close", { code: 1006 } as unknown as Event);
			}
		}

		global.WebSocket = BufferedCloseWebSocket as unknown as typeof WebSocket;
		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			preferWebsockets: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 128000,
		};
		const result = await streamOpenAICodexResponses(
			model,
			{
				systemPrompt: ["You are a helpful assistant."],
				messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
			},
			{
				apiKey: token,
				sessionId: "ws-buffered-close-session",
				providerSessionState: new Map<string, ProviderSessionState>(),
			},
		).result();

		expect(result.stopReason).toBe("stop");
		expect(result.content.find(c => c.type === "text")?.text).toBe("Replay succeeded");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("resets append state and stale turn headers when websocket requests diverge", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;

		const sseTurnStates: Array<string | null> = [];
		const sseModelsEtags: Array<string | null> = [];
		const sse = `${[
			`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "message", id: "msg_sse", role: "assistant", status: "in_progress", content: [] } })}`,
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello SSE" })}`,
			`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", id: "msg_sse", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello SSE" }] } })}`,
			`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
		].join("\n\n")}\n\n`;
		const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
			const headers = init?.headers instanceof Headers ? init.headers : new Headers(init?.headers);
			sseTurnStates.push(headers.get("x-codex-turn-state"));
			sseModelsEtags.push(headers.get("x-models-etag"));
			return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		const requestTypes: string[] = [];
		class DivergedAppendWebSocket extends MockWebSocket {
			handshakeHeaders = {
				"x-codex-turn-state": "ws-turn-state-1",
				"x-models-etag": "ws-models-etag-1",
			};
			#sendCount = 0;

			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			send(data: string): void {
				this.#sendCount += 1;
				const request = JSON.parse(data) as { type?: string };
				requestTypes.push(typeof request.type === "string" ? request.type : "");
				const idSuffix = String(this.#sendCount);
				this.emitCodexResponse({
					messageId: `msg_${idSuffix}`,
					responseId: `resp_${idSuffix}`,
					text: `Hello WS ${idSuffix}`,
				});
			}
		}

		global.WebSocket = DivergedAppendWebSocket as unknown as typeof WebSocket;

		const websocketModel: Model<"openai-codex-responses"> = {
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			preferWebsockets: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 128000,
		};
		const sseModel: Model<"openai-codex-responses"> = {
			...websocketModel,
			preferWebsockets: false,
		};
		const firstContext: Context = {
			systemPrompt: ["Prompt A"],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};
		const secondContext: Context = {
			systemPrompt: ["Prompt B"],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};
		const providerSessionState = new Map<string, ProviderSessionState>();

		await streamOpenAICodexResponses(websocketModel, firstContext, {
			apiKey: token,
			sessionId: "ws-diverged-session",
			providerSessionState,
		}).result();
		await streamOpenAICodexResponses(websocketModel, secondContext, {
			apiKey: token,
			sessionId: "ws-diverged-session",
			providerSessionState,
		}).result();
		await streamOpenAICodexResponses(sseModel, secondContext, {
			apiKey: token,
			sessionId: "ws-diverged-session",
			providerSessionState,
		}).result();

		expect(requestTypes).toEqual(["response.create", "response.create"]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(sseTurnStates[0]).toBeNull();
		expect(sseModelsEtags[0]).toBeNull();
	});

	it("reuses a prewarmed websocket connection across turns", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;

		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not be called");
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		let constructorCount = 0;
		let sendCount = 0;
		class ReusableWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				constructorCount += 1;
				this.scheduleOpen();
			}

			send(data: string): void {
				sendCount += 1;
				const request = JSON.parse(data) as Record<string, unknown>;
				expect(typeof request.type).toBe("string");
				this.emitCodexResponse({
					messageId: `msg_${sendCount}`,
					responseId: `resp_${sendCount}`,
					text: `Hello ${sendCount}`,
				});
			}
		}

		global.WebSocket = ReusableWebSocket as unknown as typeof WebSocket;

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			preferWebsockets: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 128000,
		};

		const providerSessionState = new Map<string, ProviderSessionState>();
		await prewarmOpenAICodexResponses(model, { apiKey: token, sessionId: "ws-reuse-session", providerSessionState });

		const firstContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "First", timestamp: Date.now() }],
		};
		const secondContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [
				{ role: "user", content: "First", timestamp: Date.now() },
				{ role: "user", content: "Second", timestamp: Date.now() },
			],
		};

		await streamOpenAICodexResponses(model, firstContext, {
			apiKey: token,
			sessionId: "ws-reuse-session",
			providerSessionState,
		}).result();
		await streamOpenAICodexResponses(model, secondContext, {
			apiKey: token,
			sessionId: "ws-reuse-session",
			providerSessionState,
		}).result();

		expect(constructorCount).toBe(1);
		expect(sendCount).toBe(2);
		expect(fetchMock).not.toHaveBeenCalled();
		const transportDetails = getOpenAICodexTransportDetails(model, {
			sessionId: "ws-reuse-session",
			providerSessionState,
		});
		expect(transportDetails.lastTransport).toBe("websocket");
		expect(transportDetails.websocketConnected).toBe(true);
		expect(transportDetails.prewarmed).toBe(true);
		expect(transportDetails.canAppend).toBe(true);
	});

	it("disables websocket after a fatal prewarm handshake failure", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const sse = createCompletedCodexSse("Hello SSE");
		const fetchMock = vi.fn(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		);
		global.fetch = fetchMock as unknown as typeof fetch;

		let constructorCount = 0;
		class RejectingWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				constructorCount += 1;
				queueMicrotask(() => {
					this.readyState = MockWebSocket.CLOSED;
					this.emit("close", { code: 1008 } as unknown as Event);
				});
			}
		}
		global.WebSocket = RejectingWebSocket as unknown as typeof WebSocket;

		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const options = {
			apiKey: token,
			sessionId: "ws-fatal-prewarm",
			providerSessionState,
		};

		await expect(prewarmOpenAICodexResponses(model, options)).rejects.toThrow(
			"Codex websocket transport error: websocket closed before open (1008)",
		);
		const afterPrewarm = getOpenAICodexTransportDetails(model, options);
		expect(afterPrewarm.websocketDisabled).toBe(true);
		expect(afterPrewarm.fallbackCount).toBe(1);

		const result = await streamOpenAICodexResponses(model, createCodexTestContext(), options).result();
		expect(result.stopReason).toBe("stop");
		expect(constructorCount).toBe(1);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("reuses the fatal prewarm verdict when the account-scoped key changes", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const sse = createCompletedCodexSse("Hello SSE");
		const fetchMock = vi.fn(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		);
		global.fetch = fetchMock as unknown as typeof fetch;

		let constructorCount = 0;
		class RejectingWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				constructorCount += 1;
				queueMicrotask(() => {
					this.readyState = MockWebSocket.CLOSED;
					this.emit("close", { code: 1008 } as unknown as Event);
				});
			}
		}
		global.WebSocket = RejectingWebSocket as unknown as typeof WebSocket;

		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		await expect(
			prewarmOpenAICodexResponses(model, {
				apiKey: createCodexTestToken("acc_prewarm"),
				sessionId: "ws-account-key-change",
				providerSessionState,
			}),
		).rejects.toThrow("Codex websocket transport error: websocket closed before open (1008)");

		const result = await streamOpenAICodexResponses(model, createCodexTestContext(), {
			apiKey: createCodexTestToken("acc_request"),
			sessionId: "ws-account-key-change",
			providerSessionState,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(constructorCount).toBe(1);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("keeps websocket enabled after a non-fatal prewarm failure", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const sse = createCompletedCodexSse("Hello SSE");
		const fetchMock = vi.fn(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		);
		global.fetch = fetchMock as unknown as typeof fetch;

		const abortController = new AbortController();
		let constructorCount = 0;
		class TransientFailureWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				constructorCount += 1;
			}
		}
		global.WebSocket = TransientFailureWebSocket as unknown as typeof WebSocket;
		queueMicrotask(() => abortController.abort());

		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const options = {
			apiKey: token,
			sessionId: "ws-transient-prewarm",
			signal: abortController.signal,
			providerSessionState,
		};

		await expect(prewarmOpenAICodexResponses(model, options)).rejects.toThrow(
			"Codex websocket transport error: request was aborted",
		);
		const afterPrewarm = getOpenAICodexTransportDetails(model, options);
		expect(afterPrewarm.websocketDisabled).toBe(false);
		expect(afterPrewarm.fallbackCount).toBe(0);
		expect(constructorCount).toBe(1);
	});

	it("ignores a fatal failure from a superseded prewarm connection", async () => {
		const firstSocketCreated = Promise.withResolvers<void>();
		const sockets: MockWebSocket[] = [];
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not be called");
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		class SupersededPrewarmWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				sockets.push(this);
				if (sockets.length === 1) {
					firstSocketCreated.resolve();
				} else {
					this.scheduleOpen();
				}
			}

			close(): void {
				this.readyState = MockWebSocket.CLOSED;
				this.emit("close", { code: 1008 } as unknown as Event);
			}

			send(): void {
				this.emitCodexResponse({ messageId: "msg_successor", responseId: "resp_successor", text: "successor" });
			}
		}

		global.WebSocket = SupersededPrewarmWebSocket as unknown as typeof WebSocket;
		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const options = {
			apiKey: createCodexTestToken(),
			sessionId: "ws-superseded-prewarm",
			providerSessionState,
		};
		const prewarmPromise = prewarmOpenAICodexResponses(model, options);
		const prewarmFailure = prewarmPromise.catch(error => error);
		await firstSocketCreated.promise;

		const result = await streamOpenAICodexResponses(model, createCodexTestContext(), options).result();
		const prewarmError = await prewarmFailure;
		expect(prewarmError instanceof Error ? prewarmError.message : String(prewarmError)).toContain(
			"websocket closed before open (1008)",
		);

		expect(result.stopReason).toBe("stop");
		expect(sockets).toHaveLength(2);
		expect(sockets[1]?.readyState).toBe(MockWebSocket.OPEN);
		expect(getOpenAICodexTransportDetails(model, options).websocketDisabled).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("keeps continuation state isolated across account switches", async () => {
		const requests: Array<Record<string, unknown>> = [];
		class AccountScopedWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			send(data: string): void {
				requests.push(JSON.parse(data) as Record<string, unknown>);
				const index = requests.length;
				this.emitCodexResponse({
					messageId: `msg_account_${index}`,
					responseId: `resp_account_${index}`,
					text: `Account ${index}`,
				});
			}
		}

		global.WebSocket = AccountScopedWebSocket as unknown as typeof WebSocket;
		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const sessionId = "ws-account-switch-healthy";
		const firstContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "First question", timestamp: Date.now() }],
		};
		const first = await streamOpenAICodexResponses(model, firstContext, {
			apiKey: createCodexTestToken("acc_a"),
			sessionId,
			providerSessionState,
		}).result();
		const secondContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [
				...firstContext.messages,
				first,
				{ role: "user", content: "Second question", timestamp: Date.now() + 1 },
			],
		};

		const second = await streamOpenAICodexResponses(model, secondContext, {
			apiKey: createCodexTestToken("acc_b"),
			sessionId,
			providerSessionState,
		}).result();

		expect(first.stopReason).toBe("stop");
		expect(second.stopReason).toBe("stop");
		expect(requests).toHaveLength(2);
		expect(requests[1]?.previous_response_id).toBeUndefined();
		expect(JSON.stringify(requests[1]?.input)).toContain("First question");
		expect(JSON.stringify(requests[1]?.input)).toContain("Second question");
	});

	it("does not disable websocket after a non-fatal prewarm close", async () => {
		class GracefulPrewarmCloseWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				queueMicrotask(() => {
					this.readyState = MockWebSocket.CLOSED;
					this.emit("close", { code: 1000 } as unknown as Event);
				});
			}
		}

		global.WebSocket = GracefulPrewarmCloseWebSocket as unknown as typeof WebSocket;
		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const options = {
			apiKey: createCodexTestToken(),
			sessionId: "ws-graceful-prewarm-close",
			providerSessionState: new Map<string, ProviderSessionState>(),
		};

		await expect(prewarmOpenAICodexResponses(model, options)).rejects.toThrow(
			"Codex websocket transport error: websocket closed before open (1000)",
		);
		expect(getOpenAICodexTransportDetails(model, options)).toMatchObject({
			websocketDisabled: false,
			fallbackCount: 0,
		});
	});

	it("ignores a late prewarm failure after successor response completion", async () => {
		const sockets: MockWebSocket[] = [];
		const firstSocketCreated = Promise.withResolvers<void>();
		class LatePrewarmFailureWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				sockets.push(this);
				if (sockets.length === 1) firstSocketCreated.resolve();
				else this.scheduleOpen();
			}

			close(): void {
				this.readyState = MockWebSocket.CLOSED;
			}

			send(): void {
				this.emitCodexResponse({ messageId: "msg_late", responseId: "resp_late", text: "successor" });
			}
		}

		global.WebSocket = LatePrewarmFailureWebSocket as unknown as typeof WebSocket;
		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const options = {
			apiKey: createCodexTestToken(),
			sessionId: "ws-late-prewarm",
			providerSessionState,
		};
		const prewarmPromise = prewarmOpenAICodexResponses(model, options);
		await firstSocketCreated.promise;
		const result = await streamOpenAICodexResponses(model, createCodexTestContext(), options).result();
		sockets[0]?.emit("close", { code: 1008 } as unknown as Event);
		await expect(prewarmPromise).rejects.toThrow("websocket closed before open (1008)");

		expect(result.stopReason).toBe("stop");
		expect(getOpenAICodexTransportDetails(model, options)).toMatchObject({
			websocketDisabled: false,
			websocketConnected: true,
		});
	});

	it("does not record a prewarm failure after provider session teardown", async () => {
		let firstSocket: MockWebSocket | undefined;
		let socketCount = 0;
		const firstSocketCreated = Promise.withResolvers<void>();
		class TeardownPrewarmWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				socketCount += 1;
				if (socketCount === 1) {
					firstSocket = this;
					firstSocketCreated.resolve();
				} else this.scheduleOpen();
			}

			send(): void {
				this.emitCodexResponse({ messageId: "msg_fresh", responseId: "resp_fresh", text: "fresh" });
			}
		}

		global.WebSocket = TeardownPrewarmWebSocket as unknown as typeof WebSocket;
		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const options = {
			apiKey: createCodexTestToken(),
			sessionId: "ws-teardown-prewarm",
			providerSessionState,
		};
		const prewarmPromise = prewarmOpenAICodexResponses(model, options);
		await firstSocketCreated.promise;
		const codexState = providerSessionState.get("openai-codex-responses");
		codexState?.close();
		firstSocket?.emit("close", { code: 1008 } as unknown as Event);
		await expect(prewarmPromise).rejects.toThrow("websocket closed before open (1008)");

		const result = await streamOpenAICodexResponses(model, createCodexTestContext(), options).result();
		expect(result.stopReason).toBe("stop");
		expect(socketCount).toBe(2);
		expect(getOpenAICodexTransportDetails(model, options).websocketDisabled).toBe(false);
	});

	it("applies each reused websocket request's idle timeout", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected SSE fallback"));
		let sendCount = 0;
		class RequestScopedIdleWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}
			send(): void {
				sendCount += 1;
				if (sendCount === 1) {
					this.emitCodexResponse({ messageId: "msg_first", responseId: "resp_first", text: "first" });
					return;
				}
				this.sendJson({ type: "response.created", response: { id: "resp_stalled", status: "in_progress" } });
			}
		}
		global.WebSocket = RequestScopedIdleWebSocket as unknown as typeof WebSocket;
		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const options = { apiKey: createCodexTestToken(), sessionId: "ws-request-idle", providerSessionState };
		await streamOpenAICodexResponses(model, createCodexTestContext(), {
			...options,
			streamIdleTimeoutMs: 1_000,
		}).result();
		const startedAt = Date.now();
		const stalled = await streamOpenAICodexResponses(model, createCodexTestContext(), {
			...options,
			streamIdleTimeoutMs: 20,
			streamMaxRetries: 0,
			// Measure this request's websocket deadline, not an HTTP fallback round trip.
			disableProviderRetries: true,
		}).result();
		expect(stalled.stopReason).toBe("error");
		expect(Date.now() - startedAt).toBeLessThan(600);
		expect(stalled.errorMessage).toContain("idle timeout waiting for websocket");
		expect(sendCount).toBe(2);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("ends a preferred websocket stream at the shared idle bound after output progress", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		Bun.env.GJC_OPENAI_STREAM_IDLE_TIMEOUT_MS = "20";
		class StalledWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}
			send(): void {
				this.sendJson({
					type: "response.output_item.added",
					item: { type: "message", id: "msg_stalled", role: "assistant", status: "in_progress", content: [] },
				});
				this.sendJson({ type: "response.content_part.added", part: { type: "output_text", text: "" } });
				this.sendJson({ type: "response.output_text.delta", delta: "partial" });
			}
		}
		global.WebSocket = StalledWebSocket as unknown as typeof WebSocket;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected SSE replay"));
		const controller = new AbortController();
		const deadline = setTimeout(() => controller.abort(), 150);
		try {
			const result = await streamOpenAICodexResponses(
				createCodexTestModel("https://chatgpt.com/backend-api"),
				createCodexTestContext(),
				{
					apiKey: createCodexTestToken(),
					sessionId: "stalled-websocket-output",
					providerSessionState: new Map<string, ProviderSessionState>(),
					signal: controller.signal,
				},
			).result();
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("idle timeout waiting for websocket");
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			clearTimeout(deadline);
		}
	});

	it("ends a stalled empty reasoning tool-call start at the shared idle bound", async () => {
		const originalIdle = Bun.env.PI_STREAM_IDLE_TIMEOUT_MS;
		Bun.env.PI_STREAM_IDLE_TIMEOUT_MS = "25";
		const sockets: MockWebSocket[] = [];
		class StalledToolCallWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				sockets.push(this);
				this.scheduleOpen();
			}

			send(): void {
				this.sendJson({ type: "response.output_item.added", item: { type: "reasoning", id: "r1", summary: [] } });
				this.sendJson({
					type: "response.output_item.added",
					item: { type: "function_call", id: "fc1", call_id: "call1", name: "todo_write", arguments: "" },
				});
			}
		}
		global.WebSocket = StalledToolCallWebSocket as unknown as typeof WebSocket;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(new ReadableStream({ start() {} }), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);
		try {
			const result = await streamOpenAICodexResponses(
				createCodexTestModel("https://chatgpt.com/backend-api"),
				createCodexTestContext(),
				{
					apiKey: createCodexTestToken(),
					sessionId: "stalled-empty-tool-call",
					preferWebsockets: true,
					streamIdleTimeoutMs: 25,
					providerSessionState: new Map<string, ProviderSessionState>(),
				},
			).result();
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("idle timeout");
			expect(sockets).toHaveLength(1);
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			if (originalIdle === undefined) delete Bun.env.PI_STREAM_IDLE_TIMEOUT_MS;
			else Bun.env.PI_STREAM_IDLE_TIMEOUT_MS = originalIdle;
			fetchSpy.mockRestore();
		}
	});

	it.each([
		false,
		true,
	])("ends a silent todo_write start with complete arguments and zero usage (item finalized: %s)", async finalized => {
		const args = {
			ops: [{ op: "init", phases: [{ name: "Investigate", tasks: [{ content: "Inspect the stall" }] }] }],
		};
		class SilentTodoWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}
			send(): void {
				const item = {
					type: "function_call",
					id: "fc_todo",
					call_id: "call_todo",
					name: "todo_write",
					arguments: JSON.stringify(args),
				};
				this.sendJson({ type: "response.output_item.added", item });
				this.sendJson({ type: "response.function_call_arguments.delta", delta: item.arguments });
				this.sendJson({ type: "response.function_call_arguments.done", arguments: item.arguments });
				if (finalized) this.sendJson({ type: "response.output_item.done", item });
				// No response.completed, usage, or subsequent transport activity.
			}
		}
		global.WebSocket = SilentTodoWebSocket as unknown as typeof WebSocket;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(new ReadableStream({ start() {} }), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);
		try {
			const result = await streamOpenAICodexResponses(
				createCodexTestModel("https://chatgpt.com/backend-api"),
				createCodexTestContext(),
				{
					apiKey: createCodexTestToken(),
					sessionId: `silent-complete-todo-${finalized}`,
					preferWebsockets: true,
					streamIdleTimeoutMs: 25,
					streamFirstEventTimeoutMs: 50,
					providerSessionState: new Map<string, ProviderSessionState>(),
				},
			).result();
			expect(result.stopReason).toBe("toolUse");
			expect(result.errorCode).toBe(
				finalized
					? "codex_stream_closed_after_finalized_tool_calls"
					: "codex_stream_closed_after_complete_tool_arguments",
			);
			expect(result.usage.totalTokens).toBe(0);
			expect(result.content).toContainEqual(
				expect.objectContaining({ type: "toolCall", name: "todo_write", arguments: args }),
			);
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("salvages a complete websocket tool call when the idle watchdog fires", async () => {
		vi.useFakeTimers();
		class SilentCompleteWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			send(): void {
				const item = {
					type: "function_call",
					id: "fc_fake_timer",
					call_id: "call_fake_timer",
					name: "todo_write",
					arguments: JSON.stringify({ ops: [] }),
				};
				this.sendJson({ type: "response.output_item.added", item });
				this.sendJson({ type: "response.function_call_arguments.delta", item_id: item.id, delta: item.arguments });
				this.sendJson({
					type: "response.function_call_arguments.done",
					item_id: item.id,
					arguments: item.arguments,
				});
				this.sendJson({ type: "response.output_item.done", item });
			}
		}
		global.WebSocket = SilentCompleteWebSocket as unknown as typeof WebSocket;
		try {
			const resultPromise = streamOpenAICodexResponses(
				createCodexTestModel("https://chatgpt.com/backend-api"),
				createCodexTestContext(),
				{
					apiKey: createCodexTestToken(),
					sessionId: "fake-timer-idle-salvage",
					streamIdleTimeoutMs: 25,
					streamFirstEventTimeoutMs: 50,
					providerSessionState: new Map<string, ProviderSessionState>(),
				},
			).result();
			for (let index = 0; index < 100; index += 1) await Promise.resolve();
			vi.advanceTimersByTime(0);
			for (let index = 0; index < 100; index += 1) await Promise.resolve();
			vi.advanceTimersByTime(25);
			for (let index = 0; index < 100; index += 1) await Promise.resolve();
			const result = await resultPromise;

			expect(result.stopReason).toBe("toolUse");
			expect(result.errorCode).toBe("codex_stream_closed_after_finalized_tool_calls");
			expect(result.content).toContainEqual(
				expect.objectContaining({ type: "toolCall", id: "call_fake_timer|fc_fake_timer", name: "todo_write" }),
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("replays x-codex-turn-state on subsequent SSE requests", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;

		const requestTurnStates: Array<string | null> = [];
		let callCount = 0;
		const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
			const headers = init?.headers instanceof Headers ? init.headers : new Headers(init?.headers);
			requestTurnStates.push(headers.get("x-codex-turn-state"));
			const sse = `${[
				`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "message", id: `msg_${callCount}`, role: "assistant", status: "in_progress", content: [] } })}`,
				`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
				`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}`,
				`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", id: `msg_${callCount}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello" }] } })}`,
				`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
			].join("\n\n")}\n\n`;
			const responseHeaders = new Headers({ "content-type": "text/event-stream" });
			if (callCount === 0) {
				responseHeaders.set("x-codex-turn-state", "turn-state-1");
			}
			callCount += 1;
			return new Response(sse, { status: 200, headers: responseHeaders });
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};

		const context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const providerSessionState = new Map<string, ProviderSessionState>();
		await streamOpenAICodexResponses(model, context, {
			apiKey: token,
			sessionId: "turn-state-session",
			providerSessionState,
		}).result();
		await streamOpenAICodexResponses(model, context, {
			apiKey: token,
			sessionId: "turn-state-session",
			providerSessionState,
		}).result();

		expect(requestTurnStates[0]).toBeNull();
		expect(requestTurnStates[1]).toBe("turn-state-1");
	});

	it("discards abandoned tool-call args on timeout partial replay", async () => {
		const partial = createCodexErrorSse([
			{
				type: "response.output_item.added",
				item: {
					type: "function_call",
					id: "fc_abandoned",
					call_id: "call_abandoned",
					name: "old_tool",
					arguments: "",
				},
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_abandoned", delta: '{"abandoned":' },
			{
				type: "error",
				code: "request_timeout",
				message: "stream disconnected before completion: stream closed before response.completed",
			},
		]);
		const accepted = createCodexErrorSse([
			{
				type: "response.output_item.added",
				item: {
					type: "function_call",
					id: "fc_accepted",
					call_id: "call_accepted",
					name: "new_tool",
					arguments: "",
				},
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_accepted", delta: '{"accepted":true}' },
			{
				type: "response.output_item.done",
				item: {
					type: "function_call",
					id: "fc_accepted",
					call_id: "call_accepted",
					name: "new_tool",
					arguments: '{"accepted":true}',
				},
			},
			{ type: "response.completed", response: { status: "completed", usage: DEFAULT_USAGE } },
		]);
		let requestCount = 0;
		global.fetch = vi.fn(async () => {
			requestCount += 1;
			return new Response(requestCount === 1 ? partial : accepted, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}) as unknown as typeof fetch;
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		const stream = streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken() },
		);
		const events = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();

		expect(requestCount).toBe(2);
		expect(result.content).toEqual([
			{ type: "toolCall", id: "call_accepted|fc_accepted", name: "new_tool", arguments: { accepted: true } },
		]);
		expect(events.filter(event => event.type === "toolcall_start")).toHaveLength(1);
		expect(events.filter(event => event.type === "toolcall_delta").map(event => event.delta)).toEqual([
			'{"accepted":true}',
		]);
		expect(JSON.stringify(events)).not.toContain("abandoned");
	});

	it("discards abandoned thinking before a replayed tool call", async () => {
		const partial = createCodexErrorSse([
			{ type: "response.output_item.added", item: { type: "reasoning", id: "rs_abandoned", summary: [] } },
			{ type: "response.reasoning_text.delta", item_id: "rs_abandoned", delta: "abandoned thinking" },
			{
				type: "response.output_item.added",
				item: {
					type: "function_call",
					id: "fc_abandoned_thinking",
					call_id: "call_abandoned_thinking",
					name: "old_tool",
					arguments: "",
				},
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_abandoned_thinking", delta: '{"abandoned":' },
			{
				type: "error",
				code: "request_timeout",
				message: "stream disconnected before completion: stream closed before response.completed",
			},
		]);
		const accepted = createCodexErrorSse([
			{ type: "response.output_item.added", item: { type: "reasoning", id: "rs_accepted", summary: [] } },
			{ type: "response.reasoning_text.delta", item_id: "rs_accepted", delta: "accepted thinking" },
			{
				type: "response.output_item.added",
				item: {
					type: "function_call",
					id: "fc_accepted_thinking",
					call_id: "call_accepted_thinking",
					name: "new_tool",
					arguments: "",
				},
			},
			{
				type: "response.function_call_arguments.delta",
				item_id: "fc_accepted_thinking",
				delta: '{"accepted":true}',
			},
			{
				type: "response.output_item.done",
				item: {
					type: "function_call",
					id: "fc_accepted_thinking",
					call_id: "call_accepted_thinking",
					name: "new_tool",
					arguments: '{"accepted":true}',
				},
			},
			{ type: "response.completed", response: { status: "completed", usage: DEFAULT_USAGE } },
		]);
		let requestCount = 0;
		global.fetch = vi.fn(async () => {
			requestCount += 1;
			return new Response(requestCount === 1 ? partial : accepted, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}) as unknown as typeof fetch;
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		const stream = streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken() },
		);
		const events = [];
		for await (const event of stream) events.push(event);
		await stream.result();

		expect(requestCount).toBe(2);
		expect(events.filter(event => event.type === "thinking_start")).toHaveLength(1);
		expect(events.filter(event => event.type === "thinking_delta").map(event => event.delta)).toEqual([
			"accepted thinking",
		]);
		expect(events.filter(event => event.type === "toolcall_start")).toHaveLength(1);
		expect(JSON.stringify(events)).not.toContain("abandoned");
	});

	it.each([
		["exhausted retry budget", { streamMaxRetries: 0 }],
		["provider retries disabled", { disableProviderRetries: true }],
		["managed fallback", { fallbackManaged: true }],
	])("flushes partial events before error with %s", async (_label, options) => {
		const sse = createCodexErrorSse([
			{
				type: "response.output_item.added",
				item: {
					type: "function_call",
					id: "fc_partial_error",
					call_id: "call_partial_error",
					name: "partial_tool",
					arguments: "",
				},
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_partial_error", delta: '{"partial":' },
			{
				type: "error",
				code: "request_timeout",
				message: "stream disconnected before completion: stream closed before response.completed",
			},
		]);
		const fetchMock = vi.fn(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		) as unknown as typeof fetch;
		global.fetch = fetchMock;
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		const stream = streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken(), ...options },
		);
		const events = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(events.map(event => event.type)).toContain("toolcall_start");
		expect(events.map(event => event.type)).toContain("toolcall_delta");
	});

	it("flushes the buffered window on abort and finishes as aborted", async () => {
		const ready = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
		const partialRead = Promise.withResolvers<void>();
		const encoder = new TextEncoder();
		global.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			const body = new ReadableStream<Uint8Array>({
				pull(controller) {
					if (controller.desiredSize === null) return;
					controller.enqueue(
						encoder.encode(
							`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", id: "fc_abort", call_id: "call_abort", name: "abort_tool", arguments: "" } })}\n\n`,
						),
					);
					controller.enqueue(
						encoder.encode(
							`data: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_abort", delta: '{"partial":' })}\n\n`,
						),
					);
					partialRead.resolve();
				},
				start(controller) {
					ready.resolve(controller);
					init?.signal?.addEventListener("abort", () => {
						controller.error(init.signal?.reason ?? new DOMException("aborted", "AbortError"));
					});
				},
			});
			return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
		}) as unknown as typeof fetch;
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const abort = new AbortController();
		const stream = streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken(), signal: abort.signal },
		);
		const events: Array<{ type: string }> = [];
		const consuming = (async () => {
			for await (const event of stream) events.push(event as { type: string });
		})();
		await ready.promise;
		await partialRead.promise;
		abort.abort();
		await consuming;
		const result = await stream.result();

		expect(result.stopReason).toBe("aborted");
		expect(global.fetch).toHaveBeenCalledTimes(1);
		expect(events.map(event => event.type)).not.toContain("toolcall_start");
		expect(events.map(event => event.type)).not.toContain("toolcall_delta");
	});

	it("flushes buffered partial events before a nonretryable error", async () => {
		const sse = createCodexErrorSse([
			{
				type: "response.output_item.added",
				item: {
					type: "function_call",
					id: "fc_nonretryable",
					call_id: "call_nonretryable",
					name: "invalid_tool",
					arguments: "",
				},
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_nonretryable", delta: '{"partial":' },
			{ type: "error", code: "invalid_request_error", message: "invalid request" },
		]);
		const fetchMock = vi.fn(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		) as unknown as typeof fetch;
		global.fetch = fetchMock;

		const stream = streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken() },
		);
		const events = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(events.map(event => event.type)).toContain("toolcall_start");
		expect(events.map(event => event.type)).toContain("toolcall_delta");
	});

	it("flushes finalized toolcall_end before close and salvages without duplication", async () => {
		const sse = createCodexErrorSse([
			{
				type: "response.output_item.added",
				item: {
					type: "function_call",
					id: "fc_finalized_flush",
					call_id: "call_finalized_flush",
					name: "final_tool",
					arguments: "",
				},
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_finalized_flush", delta: '{"ok":true}' },
			{
				type: "response.output_item.done",
				item: {
					type: "function_call",
					id: "fc_finalized_flush",
					call_id: "call_finalized_flush",
					name: "final_tool",
					arguments: '{"ok":true}',
				},
			},
			{
				type: "error",
				code: "request_timeout",
				message: "stream disconnected before completion: stream closed before response.completed",
			},
		]);
		global.fetch = vi.fn(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		) as unknown as typeof fetch;

		const stream = streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken() },
		);
		const events = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();

		expect(result.stopReason).toBe("toolUse");
		expect(result.content.filter(block => block.type === "toolCall")).toHaveLength(1);
		expect(events.filter(event => event.type === "toolcall_end")).toHaveLength(1);
		expect(events.findIndex(event => event.type === "toolcall_end")).toBeLessThan(
			events.findIndex(event => event.type === "done"),
		);
	});

	it("preserves partial replay allowance across empty transient close, partial timeout, and success", async () => {
		const emptyTransient = createCodexErrorSse([
			{ type: "error", code: "model_error", message: "temporarily unavailable; retry your request" },
		]);
		const partial = createCodexErrorSse([
			{
				type: "response.output_item.added",
				item: {
					type: "function_call",
					id: "fc_partial_allowance",
					call_id: "call_partial_allowance",
					name: "old_tool",
					arguments: "",
				},
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_partial_allowance", delta: '{"old":' },
			{
				type: "error",
				code: "request_timeout",
				message: "stream disconnected before completion: stream closed before response.completed",
			},
		]);
		const success = createCodexErrorSse([
			{
				type: "response.output_item.added",
				item: {
					type: "function_call",
					id: "fc_success_allowance",
					call_id: "call_success_allowance",
					name: "new_tool",
					arguments: "",
				},
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_success_allowance", delta: '{"new":true}' },
			{
				type: "response.output_item.done",
				item: {
					type: "function_call",
					id: "fc_success_allowance",
					call_id: "call_success_allowance",
					name: "new_tool",
					arguments: '{"new":true}',
				},
			},
			{ type: "response.completed", response: { status: "completed", usage: DEFAULT_USAGE } },
		]);
		let requestCount = 0;
		global.fetch = vi.fn(async () => {
			requestCount += 1;
			const body = requestCount === 1 ? emptyTransient : requestCount === 2 ? partial : success;
			return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
		}) as unknown as typeof fetch;
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		const stream = streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken() },
		);
		const events = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();

		expect(requestCount).toBe(3);
		expect(result.content).toEqual([
			{
				type: "toolCall",
				id: "call_success_allowance|fc_success_allowance",
				name: "new_tool",
				arguments: { new: true },
			},
		]);
		expect(events.filter(event => event.type === "toolcall_start")).toHaveLength(1);
		expect(JSON.stringify(events)).not.toContain("old");
	});

	it("flushes visible text immediately and vetoes partial replay", async () => {
		const sse = createCodexErrorSse([
			{
				type: "response.output_item.added",
				item: { type: "message", id: "msg_veto", role: "assistant", content: [] },
			},
			{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
			{ type: "response.output_text.delta", delta: "visible text" },
			{
				type: "response.output_item.added",
				item: { type: "function_call", id: "fc_veto", call_id: "call_veto", name: "veto_tool", arguments: "" },
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_veto", delta: '{"partial":' },
			{ type: "error", code: "request_timeout", message: "stream disconnected before completion" },
		]);
		const fetchMock = vi.fn(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		);
		global.fetch = fetchMock as unknown as typeof fetch;

		const stream = streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken() },
		);
		const events = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.stopReason).toBe("error");
		expect(events.map(event => event.type)).toContain("text_delta");
		expect(events.map(event => event.type)).toContain("toolcall_delta");
	});

	it("replays a socket reset partial call with clean accepted events", async () => {
		const partial = [
			{
				type: "response.output_item.added",
				item: {
					type: "function_call",
					id: "fc_reset_old",
					call_id: "call_reset_old",
					name: "old_tool",
					arguments: "",
				},
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_reset_old", delta: '{"old":' },
		];
		const accepted = createCodexErrorSse([
			{
				type: "response.output_item.added",
				item: {
					type: "function_call",
					id: "fc_reset_new",
					call_id: "call_reset_new",
					name: "new_tool",
					arguments: "",
				},
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_reset_new", delta: '{"new":true}' },
			{
				type: "response.output_item.done",
				item: {
					type: "function_call",
					id: "fc_reset_new",
					call_id: "call_reset_new",
					name: "new_tool",
					arguments: '{"new":true}',
				},
			},
			{ type: "response.completed", response: { status: "completed", usage: DEFAULT_USAGE } },
		]);
		let requestCount = 0;
		const socketReady = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
		global.fetch = vi.fn(async (_input, _init) => {
			requestCount += 1;
			if (requestCount === 1) {
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							socketReady.resolve(controller);
						},
						pull(controller) {
							const event = partial.shift();
							if (event) {
								controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
								return;
							}
							controller.error(
								Object.assign(
									new Error(
										"The socket connection was closed unexpectedly (transport=ECONNRESET url=https://chatgpt.com/backend-api/codex/responses)",
									),
									{ code: "ECONNRESET" },
								),
							);
						},
					}),
					{ status: 200, headers: { "content-type": "text/event-stream" } },
				);
			}
			return new Response(accepted, { status: 200, headers: { "content-type": "text/event-stream" } });
		}) as unknown as typeof fetch;
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		const stream = streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken() },
		);
		const events: AssistantMessageEvent[] = [];
		const consuming = (async () => {
			for await (const event of stream) events.push(event);
		})();
		await socketReady.promise;
		await consuming;
		const result = await stream.result();

		expect(requestCount).toBe(2);
		expect(result.content).toEqual([
			{ type: "toolCall", id: "call_reset_new|fc_reset_new", name: "new_tool", arguments: { new: true } },
		]);
		expect(events.filter(event => event.type === "toolcall_start")).toHaveLength(1);
		expect(JSON.stringify(events)).not.toContain("old");
	});

	it.each([
		"invalid_request_error",
		"invalid_prompt",
	])("does not replay a partial call for non-retryable %s socket-close errors", async code => {
		const sse = createCodexErrorSse([
			{
				type: "response.output_item.added",
				item: { type: "function_call", id: "fc_veto", call_id: "call_veto", name: "veto_tool", arguments: "" },
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_veto", delta: '{"partial":' },
			{ type: "error", code, message: "The socket connection was closed unexpectedly" },
		]);
		const fetchMock = vi.fn(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		);
		global.fetch = fetchMock as unknown as typeof fetch;

		const result = await streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken() },
		).result();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain(`code=${code}`);
	});

	it("replays a partial call when socket-close wording has no non-retryable provider veto", async () => {
		const partial = createCodexErrorSse([
			{
				type: "response.output_item.added",
				item: {
					type: "function_call",
					id: "fc_socket_retry",
					call_id: "call_socket_retry",
					name: "old_tool",
					arguments: "",
				},
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_socket_retry", delta: '{"old":' },
			{ type: "error", code: "request_timeout", message: "The socket connection was closed unexpectedly" },
		]);
		const accepted = createCodexErrorSse([
			{
				type: "response.output_item.added",
				item: {
					type: "function_call",
					id: "fc_socket_retry_new",
					call_id: "call_socket_retry_new",
					name: "new_tool",
					arguments: "",
				},
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_socket_retry_new", delta: '{"new":true}' },
			{
				type: "response.output_item.done",
				item: {
					type: "function_call",
					id: "fc_socket_retry_new",
					call_id: "call_socket_retry_new",
					name: "new_tool",
					arguments: '{"new":true}',
				},
			},
			{ type: "response.completed", response: { status: "completed", usage: DEFAULT_USAGE } },
		]);
		let requestCount = 0;
		global.fetch = vi.fn(async () => {
			requestCount += 1;
			return new Response(requestCount === 1 ? partial : accepted, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}) as unknown as typeof fetch;

		const result = await streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			createCodexTestContext(),
			{ apiKey: createCodexTestToken() },
		).result();

		expect(requestCount).toBe(2);
		expect(result.stopReason).toBe("toolUse");
	});

	it("delivers tool-choice incapability when streaming fallback retries", async () => {
		const tool: Tool = { name: "forced_tool", description: "forced tool", parameters: { type: "object" } };
		const context = { ...createCodexTestContext(), tools: [tool] };
		const success = createCodexErrorSse([
			{
				type: "response.output_item.added",
				item: { type: "message", id: "retry_msg", role: "assistant", content: [] },
			},
			{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
			{ type: "response.output_text.delta", delta: "retry succeeded" },
			{
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "retry_msg",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "retry succeeded" }],
				},
			},
			{ type: "response.completed", response: { status: "completed", usage: DEFAULT_USAGE } },
		]);
		let requestCount = 0;
		global.fetch = vi.fn(async () => {
			requestCount += 1;
			const body =
				requestCount === 1
					? createCodexErrorSse([
							{
								type: "error",
								code: "invalid_request_error",
								message: "Tool choice 'forced_tool' not found in 'tools' parameter.",
							},
						])
					: success;
			return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
		}) as unknown as typeof fetch;
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		const stream = streamOpenAICodexResponses(
			{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
			context,
			{ apiKey: createCodexTestToken(), toolChoice: { type: "function", name: "forced_tool" } },
		);
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();

		expect(requestCount).toBe(2);
		expect(events.filter(event => event.type === "toolChoiceIncapability")).toHaveLength(1);
		expect(result.content).toEqual([{ type: "text", text: "retry succeeded", textSignature: expect.any(String) }]);
	});

	it("does not replay partial SSE output after websocket fallback released events", async () => {
		let websocketRequests = 0;
		class VisibleCloseWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}
			send(): void {
				websocketRequests += 1;
				this.sendJson({
					type: "response.output_item.added",
					item: { type: "message", id: "ws_msg", role: "assistant", status: "in_progress", content: [] },
				});
				this.sendJson({ type: "response.content_part.added", part: { type: "output_text", text: "" } });
				this.sendJson({ type: "response.output_text.delta", delta: "visible" });
				this.readyState = MockWebSocket.CLOSED;
				this.emit("close", { code: 1006 } as unknown as Event);
			}
		}
		global.WebSocket = VisibleCloseWebSocket as unknown as typeof WebSocket;

		const partial = createSocketCloseCodexSse(undefined, [
			{
				type: "response.output_item.added",
				item: {
					type: "function_call",
					id: "fc_abandoned",
					call_id: "call_abandoned",
					name: "old_tool",
					arguments: "",
				},
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_abandoned", delta: '{"old":' },
		]);
		const accepted = createCodexErrorSse([
			{
				type: "response.output_item.added",
				item: {
					type: "function_call",
					id: "fc_accepted",
					call_id: "call_accepted",
					name: "new_tool",
					arguments: "",
				},
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_accepted", delta: '{"accepted":true}' },
			{
				type: "response.output_item.done",
				item: {
					type: "function_call",
					id: "fc_accepted",
					call_id: "call_accepted",
					name: "new_tool",
					arguments: '{"accepted":true}',
				},
			},
			{ type: "response.completed", response: { status: "completed", usage: DEFAULT_USAGE } },
		]);
		let requestCount = 0;
		global.fetch = vi.fn(async () => {
			requestCount += 1;
			return requestCount === 1
				? partial
				: new Response(accepted, { status: 200, headers: { "content-type": "text/event-stream" } });
		}) as unknown as typeof fetch;
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		const stream = streamOpenAICodexResponses(
			createCodexTestModel("https://chatgpt.com/backend-api"),
			createCodexTestContext(),
			{
				apiKey: createCodexTestToken(),
				sessionId: "released-events-session",
				providerSessionState: new Map<string, ProviderSessionState>(),
			},
		);
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();

		expect(websocketRequests).toBe(1);
		expect(requestCount).toBe(2);
		expect(result.content).toEqual([
			{ type: "toolCall", id: "call_accepted|fc_accepted", name: "new_tool", arguments: { accepted: true } },
		]);
		expect(events.filter(event => event.type === "toolcall_start")).toHaveLength(1);
		expect(events.filter(event => event.type === "toolcall_end")).toHaveLength(1);
		expect(JSON.stringify(events)).not.toContain("abandoned");
	});
});
