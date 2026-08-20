import { afterEach, describe, expect, it, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import { Messages } from "@anthropic-ai/sdk/resources/messages/messages";
import { Effort } from "../src/model-thinking";
import { applyClaudeToolPrefix, streamAnthropic, stripClaudeToolPrefix } from "../src/providers/anthropic";
import type { AssistantMessageEvent, Context, Model, ProviderSessionState } from "../src/types";

const model: Model<"anthropic-messages"> = {
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

const context: Context = {
	messages: [{ role: "user", content: "Say hi", timestamp: Date.now() }],
};
const queryObjectSchema = {
	type: "object",
	properties: { query: { type: "string" } },
	required: ["query"],
};

const cityObjectSchema = {
	type: "object",
	properties: { city: { type: "string" } },
	required: ["city"],
};

type MockAnthropicEvent = Record<string, unknown>;
type MockAnthropicStream = AsyncIterable<MockAnthropicEvent>;
type MockAnthropicRequest = {
	withResponse(): Promise<{
		data: MockAnthropicStream;
		response: Response;
		request_id: string | null;
	}>;
};

function createMockRequest(events: MockAnthropicEvent[]): MockAnthropicRequest {
	const response = new Response(null, {
		status: 200,
		headers: { "request-id": "req_mock" },
	});

	const stream: MockAnthropicStream = {
		async *[Symbol.asyncIterator]() {
			for (const event of events) {
				yield event;
			}
		},
	};

	return {
		async withResponse() {
			return {
				data: stream,
				response,
				request_id: response.headers.get("request-id"),
			};
		},
	};
}
function createRawSseRequest(frames: string[]): { asResponse(): Promise<Response> } {
	const body = new TextEncoder().encode(frames.join(""));
	return {
		async asResponse() {
			return new Response(body, {
				status: 200,
				headers: {
					"content-type": "text/event-stream",
					"request-id": "req_raw_mock",
				},
			});
		},
	};
}

function sseFrame(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sseRawFrame(event: string, data: string): string {
	return `event: ${event}\ndata: ${data}\n\n`;
}

function createTextSuccessSseFrames(text: string, preamble: string[] = []): string[] {
	return [...preamble, ...createTextSuccessEvents(text).map(event => sseFrame(String(event.type), event))];
}

function createRejectedMockRequest(error: Error): MockAnthropicRequest {
	return {
		async withResponse() {
			throw error;
		},
	};
}

function createStrictGrammarTooLargeError(): Error {
	const error = new Error(
		'400 {"type":"error","error":{"type":"invalid_request_error","message":"The compiled grammar is too large, which would cause performance issues. Simplify your tool schemas or reduce the number of strict tools."},"request_id":"req_test"}',
	);
	(error as Error & { status: number }).status = 400;
	return error;
}

function createOtherInvalidRequestError(): Error {
	const error = new Error(
		'400 {"type":"error","error":{"type":"invalid_request_error","message":"Some other validation error."},"request_id":"req_test"}',
	);
	(error as Error & { status: number }).status = 400;
	return error;
}

function createCacheBreakpointOverflowError(): Error {
	const error = new Error(
		'400 {"type":"error","error":{"type":"invalid_request_error","message":"A maximum of 4 blocks with cache_control may be provided. Found 5."},"request_id":"req_test"}',
	);
	(error as Error & { status: number }).status = 400;
	return error;
}

/** The same rejection as a proxy forwards it: in-stream SSE body, HTTP 200, no status on the error. */
function createStatuslessCacheBreakpointOverflowError(): Error {
	return new Error(
		'{"type":"error","error":{"type":"invalid_request_error","message":"A maximum of 4 blocks with cache_control may be provided. Found 5."}}',
	);
}

function cacheControlCount(params: unknown): number {
	const payload = params as {
		cache_control?: unknown;
		tools?: Array<{ cache_control?: unknown }>;
		system?: Array<{ cache_control?: unknown }>;
		messages?: Array<{ content?: unknown }>;
	};
	let total = payload.cache_control ? 1 : 0;
	for (const tool of payload.tools ?? []) if (tool.cache_control) total++;
	for (const block of payload.system ?? []) if (block.cache_control) total++;
	for (const message of payload.messages ?? []) {
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content as Array<{ cache_control?: unknown }>) {
			if (block.cache_control) total++;
		}
	}
	return total;
}

function getStrictFlags(params: unknown): boolean[] {
	const tools = (params as { tools?: Array<{ strict?: unknown }> }).tools ?? [];
	return tools.map(tool => tool.strict === true);
}

function createTextSuccessEvents(
	text: string,
	options: { duplicateMessageStart?: boolean } = {},
): MockAnthropicEvent[] {
	const events: MockAnthropicEvent[] = [
		{
			type: "message_start",
			message: {
				id: "msg_text_success",
				usage: {
					input_tokens: 12,
					output_tokens: 0,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: {
				input_tokens: 12,
				output_tokens: 4,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
		},
		{ type: "message_stop" },
	];
	if (options.duplicateMessageStart) {
		events.splice(2, 0, {
			type: "message_start",
			message: { id: "msg_duplicate", usage: { input_tokens: 99, output_tokens: 99 } },
		});
	}
	return events;
}

function createTextSuccessEventsWithPreamble(text: string, preambleEvents: MockAnthropicEvent[]): MockAnthropicEvent[] {
	return [...preambleEvents, ...createTextSuccessEvents(text)];
}

function createMalformedPreMessageStartEvents(): MockAnthropicEvent[] {
	return [{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }];
}

function createMalformedToolUseEvents(): MockAnthropicEvent[] {
	return [
		{
			type: "message_start",
			message: {
				id: "msg_tool_broken",
				usage: {
					input_tokens: 12,
					output_tokens: 0,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
			},
		},
		{
			type: "content_block_start",
			index: 0,
			content_block: { type: "tool_use", id: "tool_broken", name: "lookup_weather", input: {} },
		},
		{
			type: "content_block_delta",
			index: 0,
			delta: { type: "input_json_delta", partial_json: '{"city":"Par' },
		},
		{ type: "content_block_stop", index: 0 },
	];
}

function countEvents(events: AssistantMessageEvent[], type: AssistantMessageEvent["type"]): number {
	return events.filter(event => event.type === type).length;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("anthropic stream envelope handling", () => {
	it("ignores duplicate message_start envelopes without resetting streamed text", async () => {
		vi.spyOn(Messages.prototype, "create").mockImplementation(
			() => createMockRequest(createTextSuccessEvents("hello", { duplicateMessageStart: true })) as never,
		);

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		expect(countEvents(events, "text_start")).toBe(1);
		expect(countEvents(events, "text_delta")).toBe(1);
		expect(countEvents(events, "text_end")).toBe(1);
		expect(countEvents(events, "done")).toBe(1);
		expect(result.stopReason).toBe("stop");
		expect(result.responseId).toBe("msg_text_success");
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
	});

	it("opens thinking before summarized reasoning for a summarized adaptive stream", async () => {
		const summarizedModel: Model<"anthropic-messages"> = {
			...model,
			id: "claude-opus-4-7",
			thinking: { mode: "anthropic-adaptive", minLevel: Effort.Minimal, maxLevel: Effort.Max },
		};
		let requestedThinking: unknown;
		vi.spyOn(Messages.prototype, "create").mockImplementation(params => {
			requestedThinking = (params as { thinking?: unknown }).thinking;
			return createMockRequest([
				{
					type: "message_start",
					message: { id: "msg_summary", usage: { input_tokens: 0, output_tokens: 0 } },
				},
				{ type: "content_block_start", index: 3, content_block: { type: "thinking", thinking: "" } },
				{ type: "content_block_delta", index: 3, delta: { type: "thinking_delta", thinking: "summary" } },
				{ type: "content_block_stop", index: 3 },
				{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
				{ type: "message_stop" },
			]) as never;
		});

		const stream = streamAnthropic(summarizedModel, context, { apiKey: "sk-ant-test", thinkingEnabled: true });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);

		expect(requestedThinking).toEqual({ type: "adaptive", display: "summarized" });
		const starts = events.filter(
			event => event.type === "thinking_start" || event.type === "reasoning_summary_start",
		);
		expect(starts.map(event => [event.type, event.contentIndex])).toEqual([
			["thinking_start", 0],
			["reasoning_summary_start", 0],
		]);
	});

	it("keeps unsupported adaptive thinking raw when summarized display is omitted", async () => {
		const unsupportedAdaptiveModel: Model<"anthropic-messages"> = {
			...model,
			id: "claude-sonnet-4-6",
			thinking: { mode: "anthropic-adaptive", minLevel: Effort.Minimal, maxLevel: Effort.Max },
		};
		let requestedThinking: unknown;
		vi.spyOn(Messages.prototype, "create").mockImplementation(params => {
			requestedThinking = (params as { thinking?: unknown }).thinking;
			return createMockRequest([
				{
					type: "message_start",
					message: { id: "msg_raw", usage: { input_tokens: 0, output_tokens: 0 } },
				},
				{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
				{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "raw" } },
				{ type: "content_block_stop", index: 0 },
				{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
				{ type: "message_stop" },
			]) as never;
		});

		const stream = streamAnthropic(unsupportedAdaptiveModel, context, {
			apiKey: "sk-ant-test",
			thinkingEnabled: true,
		});
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();

		expect(requestedThinking).toEqual({ type: "adaptive" });
		expect(events.filter(event => event.type === "thinking_delta")).toHaveLength(1);
		expect(events.filter(event => event.type.startsWith("reasoning_summary_"))).toHaveLength(0);
		expect(result.content[0]).not.toMatchObject({ provenance: "summary" });
	});

	it("preserves streamed tool-call arguments through Anthropic partial JSON deltas", async () => {
		const args = {
			command: "printf hi",
			cwd: "/tmp/worktree",
			timeout: 5,
		};
		vi.spyOn(Messages.prototype, "create").mockImplementation(
			() =>
				createMockRequest([
					{
						type: "message_start",
						message: {
							id: "msg_tool_args",
							usage: {
								input_tokens: 12,
								output_tokens: 0,
								cache_read_input_tokens: 0,
								cache_creation_input_tokens: 0,
							},
						},
					},
					{
						type: "content_block_start",
						index: 0,
						content_block: { type: "tool_use", id: "tool_args", name: "bash", input: {} },
					},
					{
						type: "content_block_delta",
						index: 0,
						delta: { type: "input_json_delta", partial_json: '{"command":"printf' },
					},
					{
						type: "content_block_delta",
						index: 0,
						delta: { type: "input_json_delta", partial_json: ' hi","cwd":"/tmp/worktree","timeout":5}' },
					},
					{ type: "content_block_stop", index: 0 },
					{
						type: "message_delta",
						delta: { stop_reason: "tool_use" },
						usage: { output_tokens: 7 },
					},
					{ type: "message_stop" },
				]) as never,
		);

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();
		const deltaEvents = events.filter(event => event.type === "toolcall_delta");
		const endEvent = events.find(event => event.type === "toolcall_end");

		expect(deltaEvents).toHaveLength(2);
		expect(endEvent?.type).toBe("toolcall_end");
		if (endEvent?.type !== "toolcall_end") throw new Error("Expected toolcall_end");
		expect(endEvent.toolCall.arguments).toEqual(args);
		expect(result.content).toEqual([{ type: "toolCall", id: "tool_args", name: "bash", arguments: args }]);
	});
	it("preserves non-delta tool-call input from Anthropic content_block_start", async () => {
		const args = {
			command: "printf hi",
			cwd: "/tmp/worktree",
			timeout: 5,
		};
		vi.spyOn(Messages.prototype, "create").mockImplementation(
			() =>
				createMockRequest([
					{
						type: "message_start",
						message: {
							id: "msg_tool_start_input",
							usage: {
								input_tokens: 12,
								output_tokens: 0,
								cache_read_input_tokens: 0,
								cache_creation_input_tokens: 0,
							},
						},
					},
					{
						type: "content_block_start",
						index: 0,
						content_block: { type: "tool_use", id: "tool_start_input", name: "bash", input: args },
					},
					{ type: "content_block_stop", index: 0 },
					{
						type: "message_delta",
						delta: { stop_reason: "tool_use" },
						usage: { output_tokens: 7 },
					},
					{ type: "message_stop" },
				]) as never,
		);

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();
		const deltaEvents = events.filter(event => event.type === "toolcall_delta");
		const endEvent = events.find(event => event.type === "toolcall_end");

		expect(deltaEvents).toHaveLength(0);
		expect(endEvent?.type).toBe("toolcall_end");
		if (endEvent?.type !== "toolcall_end") throw new Error("Expected toolcall_end");
		expect(endEvent.toolCall.arguments).toEqual(args);
		expect(result.content).toEqual([{ type: "toolCall", id: "tool_start_input", name: "bash", arguments: args }]);
	});
	it("keeps interleaved streamed tool-call arguments keyed to their Anthropic content indexes", async () => {
		vi.spyOn(Messages.prototype, "create").mockImplementation(
			() =>
				createMockRequest([
					{
						type: "message_start",
						message: {
							id: "msg_interleaved_tools",
							usage: {
								input_tokens: 12,
								output_tokens: 0,
								cache_read_input_tokens: 0,
								cache_creation_input_tokens: 0,
							},
						},
					},
					{
						type: "content_block_start",
						index: 2,
						content_block: { type: "tool_use", id: "tool_a", name: "bash", input: {} },
					},
					{
						type: "content_block_start",
						index: 5,
						content_block: { type: "tool_use", id: "tool_b", name: "edit", input: {} },
					},
					{
						type: "content_block_delta",
						index: 5,
						delta: { type: "input_json_delta", partial_json: '{"path":"a' },
					},
					{
						type: "content_block_delta",
						index: 2,
						delta: { type: "input_json_delta", partial_json: '{"command":"printf' },
					},
					{
						type: "content_block_delta",
						index: 5,
						delta: { type: "input_json_delta", partial_json: '.ts","old":"x","new":"y"}' },
					},
					{ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: ' hi"}' } },
					{ type: "content_block_stop", index: 5 },
					{ type: "content_block_stop", index: 2 },
					{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } },
					{ type: "message_stop" },
				]) as never,
		);

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		for await (const _ of stream) {
			// drain stream
		}
		const result = await stream.result();

		expect(result.content).toEqual([
			{ type: "toolCall", id: "tool_a", name: "bash", arguments: { command: "printf hi" } },
			{ type: "toolCall", id: "tool_b", name: "edit", arguments: { path: "a.ts", old: "x", new: "y" } },
		]);
	});

	it("keeps later block deltas after an earlier content_block_stop removed its stream index field", async () => {
		vi.spyOn(Messages.prototype, "create").mockImplementation(
			() =>
				createMockRequest([
					{
						type: "message_start",
						message: {
							id: "msg_stop_then_delta",
							usage: {
								input_tokens: 12,
								output_tokens: 0,
								cache_read_input_tokens: 0,
								cache_creation_input_tokens: 0,
							},
						},
					},
					{
						type: "content_block_start",
						index: 0,
						content_block: { type: "tool_use", id: "tool_done", name: "bash", input: { command: "pwd" } },
					},
					{
						type: "content_block_start",
						index: 1,
						content_block: { type: "tool_use", id: "tool_streamed", name: "bash", input: {} },
					},
					{ type: "content_block_stop", index: 0 },
					{
						type: "content_block_delta",
						index: 1,
						delta: { type: "input_json_delta", partial_json: '{"command":"echo' },
					},
					{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: ' later"}' } },
					{ type: "content_block_stop", index: 1 },
					{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } },
					{ type: "message_stop" },
				]) as never,
		);

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		for await (const _ of stream) {
			// drain stream
		}
		const result = await stream.result();

		expect(result.content).toEqual([
			{ type: "toolCall", id: "tool_done", name: "bash", arguments: { command: "pwd" } },
			{ type: "toolCall", id: "tool_streamed", name: "bash", arguments: { command: "echo later" } },
		]);
	});
	it("finalizes an orphaned block when a duplicate content_block_start reuses an active index", async () => {
		vi.spyOn(Messages.prototype, "create").mockImplementation(
			() =>
				createMockRequest([
					{
						type: "message_start",
						message: {
							id: "msg_duplicate_start",
							usage: {
								input_tokens: 12,
								output_tokens: 0,
								cache_read_input_tokens: 0,
								cache_creation_input_tokens: 0,
							},
						},
					},
					{
						type: "content_block_start",
						index: 4,
						content_block: { type: "tool_use", id: "tool_orphaned", name: "bash", input: {} },
					},
					{
						type: "content_block_delta",
						index: 4,
						delta: { type: "input_json_delta", partial_json: '{"command":"pwd"}' },
					},
					{
						type: "content_block_start",
						index: 4,
						content_block: { type: "tool_use", id: "tool_replacement", name: "bash", input: {} },
					},
					{
						type: "content_block_delta",
						index: 4,
						delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' },
					},
					{ type: "content_block_stop", index: 4 },
					{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } },
					{ type: "message_stop" },
				]) as never,
		);

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		for await (const _ of stream) {
			// drain stream
		}
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage ?? "").toMatch(/reused an active content block index/i);
	});

	it("round-trips OAuth tool prefixes without stripping original tool names that contain the prefix", () => {
		for (const name of ["bash", "proxy_bash", "Proxy_bash", "web_search"] as const) {
			expect(stripClaudeToolPrefix(applyClaudeToolPrefix(name))).toBe(name);
		}
		expect(stripClaudeToolPrefix("proxy_bash")).toBe("bash");
		expect(stripClaudeToolPrefix("proxy_proxy_bash")).toBe("proxy_bash");
		expect(stripClaudeToolPrefix("00y_bash")).toBe("00y_bash");
	});

	it("ignores ping before message_start and streams the response once", async () => {
		let attempt = 0;
		vi.spyOn(Messages.prototype, "create").mockImplementation(() => {
			attempt += 1;
			return createMockRequest(createTextSuccessEventsWithPreamble("hello", [{ type: "ping" }])) as never;
		});

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		expect(attempt).toBe(1);
		expect(countEvents(events, "error")).toBe(0);
		expect(countEvents(events, "text_start")).toBe(1);
		expect(countEvents(events, "text_delta")).toBe(1);
		expect(countEvents(events, "text_end")).toBe(1);
		expect(countEvents(events, "done")).toBe(1);
		expect(result.stopReason).toBe("stop");
		expect(result.responseId).toBe("msg_text_success");
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
	});

	it("ignores unknown preamble events before message_start and streams the response once", async () => {
		let attempt = 0;
		vi.spyOn(Messages.prototype, "create").mockImplementation(() => {
			attempt += 1;
			return createMockRequest(
				createTextSuccessEventsWithPreamble("hello", [{ type: "custom_preamble_event", trace_id: "trace_123" }]),
			) as never;
		});

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		expect(attempt).toBe(1);
		expect(countEvents(events, "error")).toBe(0);
		expect(countEvents(events, "text_start")).toBe(1);
		expect(countEvents(events, "text_delta")).toBe(1);
		expect(countEvents(events, "text_end")).toBe(1);
		expect(countEvents(events, "done")).toBe(1);
		expect(result.stopReason).toBe("stop");
		expect(result.responseId).toBe("msg_text_success");
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
	});

	it("retries malformed envelopes before content starts without duplicating streamed text events", async () => {
		let attempt = 0;
		vi.spyOn(Messages.prototype, "create").mockImplementation(() => {
			attempt += 1;
			return createMockRequest(
				attempt === 1 ? createMalformedPreMessageStartEvents() : createTextSuccessEvents("recovered"),
			) as never;
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		expect(attempt).toBe(2);
		expect(countEvents(events, "text_start")).toBe(1);
		expect(countEvents(events, "text_delta")).toBe(1);
		expect(countEvents(events, "text_end")).toBe(1);
		expect(countEvents(events, "done")).toBe(1);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "recovered" }]);
	});

	it("retries without strict tools after Anthropic compiled grammar errors and keeps strict disabled", async () => {
		const toolContext: Context = {
			...context,
			tools: [
				{
					name: "edit",
					description: "Edit a value",
					strict: true,
					parameters: queryObjectSchema,
				},
			],
		};
		const providerSessionState = new Map<string, ProviderSessionState>();
		const strictFlags: boolean[][] = [];
		let attempt = 0;
		vi.spyOn(Messages.prototype, "create").mockImplementation((params: unknown) => {
			attempt += 1;
			strictFlags.push(getStrictFlags(params));
			if (attempt === 1) {
				return createRejectedMockRequest(createStrictGrammarTooLargeError()) as never;
			}
			return createMockRequest(createTextSuccessEvents(attempt === 2 ? "recovered" : "later")) as never;
		});

		const stream = streamAnthropic(model, toolContext, { apiKey: "sk-ant-test", providerSessionState });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toContain("compiled grammar is too large");
		expect(result.content).toEqual([{ type: "text", text: "recovered" }]);
		expect(countEvents(events, "done")).toBe(1);
		expect(countEvents(events, "error")).toBe(0);
		expect(strictFlags).toEqual([[true], [false]]);
		expect(
			(providerSessionState.get("anthropic-messages") as { strictToolsDisabled?: boolean } | undefined)
				?.strictToolsDisabled,
		).toBe(true);

		const nextStream = streamAnthropic(model, toolContext, { apiKey: "sk-ant-test", providerSessionState });
		const nextEvents: AssistantMessageEvent[] = [];
		for await (const event of nextStream) {
			nextEvents.push(event);
		}
		const nextResult = await nextStream.result();

		expect(nextResult.stopReason).toBe("stop");
		expect(nextResult.content).toEqual([{ type: "text", text: "later" }]);
		expect(countEvents(nextEvents, "done")).toBe(1);
		expect(countEvents(nextEvents, "error")).toBe(0);
		expect(strictFlags).toEqual([[true], [false], [false]]);
	});

	it("does not disable strict tools for unrelated Anthropic invalid request errors", async () => {
		const toolContext: Context = {
			...context,
			tools: [
				{
					name: "edit",
					description: "Edit a value",
					strict: true,
					parameters: queryObjectSchema,
				},
			],
		};
		const providerSessionState = new Map<string, ProviderSessionState>();
		const strictFlags: boolean[][] = [];
		let attempt = 0;
		vi.spyOn(Messages.prototype, "create").mockImplementation((params: unknown) => {
			attempt += 1;
			strictFlags.push(getStrictFlags(params));
			return createRejectedMockRequest(createOtherInvalidRequestError()) as never;
		});

		const stream = streamAnthropic(model, toolContext, { apiKey: "sk-ant-test", providerSessionState });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		expect(attempt).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Some other validation error");
		expect(countEvents(events, "error")).toBe(1);
		expect(countEvents(events, "done")).toBe(0);
		expect(strictFlags).toEqual([[true]]);
		expect(
			(providerSessionState.get("anthropic-messages") as { strictToolsDisabled?: boolean } | undefined)
				?.strictToolsDisabled,
		).toBe(false);
	});

	it("steps generated breakpoints down one at a time after a cache breakpoint overflow", async () => {
		// A gateway that injects its own block-level markers leaves few slots for ours.
		const gatewayModel: Model<"anthropic-messages"> = {
			...model,
			baseUrl: "https://proxy.example.com/anthropic",
		};
		// A prior assistant turn exists, so explicit mode has both a prefix anchor
		// and a current-turn refresh point to place.
		const toolLoopContext: Context = {
			messages: [
				{ role: "user", content: "First question", timestamp: 1 },
				{
					role: "assistant",
					content: [{ type: "text", text: "First answer" }],
					api: "anthropic-messages",
					provider: "anthropic",
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
					timestamp: 2,
				},
				{ role: "user", content: "Second question", timestamp: 3 },
			],
		};
		const providerSessionState = new Map<string, ProviderSessionState>();
		const breakpointCounts: number[] = [];
		let attempt = 0;
		vi.spyOn(Messages.prototype, "create").mockImplementation((params: unknown) => {
			attempt += 1;
			breakpointCounts.push(cacheControlCount(params));
			// Reject while we still generate more than one breakpoint; a gateway with
			// exactly one free slot accepts the reduced request.
			if (cacheControlCount(params) > 1) {
				return createRejectedMockRequest(createCacheBreakpointOverflowError()) as never;
			}
			return createMockRequest(createTextSuccessEvents("recovered")) as never;
		});

		const stream = streamAnthropic(gatewayModel, toolLoopContext, {
			apiKey: "sk-ant-test",
			providerSessionState,
		});
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		expect(attempt).toBe(2);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "recovered" }]);
		expect(countEvents(events, "error")).toBe(0);
		// The rejected attempt carried two markers; the retry keeps one rather than
		// giving up caching entirely.
		expect(breakpointCounts[0]).toBe(2);
		expect(breakpointCounts[1]).toBe(1);
		expect(
			(providerSessionState.get("anthropic-messages") as { generatedCacheBudget?: number } | undefined)
				?.generatedCacheBudget,
		).toBe(1);

		// A later turn in the same session starts from the reduced budget instead of
		// re-triggering the rejection.
		const nextStream = streamAnthropic(gatewayModel, toolLoopContext, {
			apiKey: "sk-ant-test",
			providerSessionState,
		});
		for await (const _ of nextStream) {
			// drain stream
		}
		await nextStream.result();
		expect(attempt).toBe(3);
		expect(breakpointCounts[2]).toBe(1);
	});

	it("gives up generated caching only after the reduced budget is also rejected", async () => {
		const gatewayModel: Model<"anthropic-messages"> = {
			...model,
			baseUrl: "https://proxy.example.com/anthropic",
		};
		const providerSessionState = new Map<string, ProviderSessionState>();
		const breakpointCounts: number[] = [];
		let attempt = 0;
		vi.spyOn(Messages.prototype, "create").mockImplementation((params: unknown) => {
			attempt += 1;
			breakpointCounts.push(cacheControlCount(params));
			// A gateway with no free slot at all rejects until we add nothing.
			if (cacheControlCount(params) > 0) {
				return createRejectedMockRequest(createCacheBreakpointOverflowError()) as never;
			}
			return createMockRequest(createTextSuccessEvents("recovered")) as never;
		});

		const stream = streamAnthropic(gatewayModel, context, { apiKey: "sk-ant-test", providerSessionState });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		// Two rejections are needed: 2 -> 1 -> 0. A single retry is not enough,
		// which is exactly what the graded step buys over an immediate kill switch.
		expect(attempt).toBe(3);
		expect(result.stopReason).toBe("stop");
		expect(countEvents(events, "error")).toBe(0);
		expect(breakpointCounts.at(-1)).toBe(0);
		expect(breakpointCounts[0]).toBeGreaterThan(0);
		expect(
			(providerSessionState.get("anthropic-messages") as { generatedCacheBudget?: number } | undefined)
				?.generatedCacheBudget,
		).toBe(0);
	});

	it("recovers from a cache breakpoint overflow forwarded as a statusless proxy SSE error", async () => {
		const gatewayModel: Model<"anthropic-messages"> = {
			...model,
			baseUrl: "https://proxy.example.com/anthropic",
		};
		const breakpointCounts: number[] = [];
		let attempt = 0;
		vi.spyOn(Messages.prototype, "create").mockImplementation((params: unknown) => {
			attempt += 1;
			breakpointCounts.push(cacheControlCount(params));
			if (attempt === 1) {
				return createRejectedMockRequest(createStatuslessCacheBreakpointOverflowError()) as never;
			}
			return createMockRequest(createTextSuccessEvents("recovered")) as never;
		});

		const stream = streamAnthropic(gatewayModel, context, { apiKey: "sk-ant-test" });
		for await (const _ of stream) {
			// drain stream
		}
		const result = await stream.result();

		expect(attempt).toBe(2);
		expect(result.stopReason).toBe("stop");
		// A single-turn context has no assistant anchor, so explicit mode emits one
		// marker and the reduced budget still spends it on the current turn. The
		// gateway here frees a slot once we drop from two, so one marker is accepted.
		expect(breakpointCounts[0]).toBe(1);
		expect(breakpointCounts[1]).toBe(1);
	});

	it("does not reduce the cache budget for unrelated invalid request errors", async () => {
		const gatewayModel: Model<"anthropic-messages"> = {
			...model,
			baseUrl: "https://proxy.example.com/anthropic",
		};
		const providerSessionState = new Map<string, ProviderSessionState>();
		let attempt = 0;
		vi.spyOn(Messages.prototype, "create").mockImplementation(() => {
			attempt += 1;
			return createRejectedMockRequest(createOtherInvalidRequestError()) as never;
		});

		const stream = streamAnthropic(gatewayModel, context, { apiKey: "sk-ant-test", providerSessionState });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		expect(attempt).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Some other validation error");
		expect(countEvents(events, "error")).toBe(1);
		expect(
			(providerSessionState.get("anthropic-messages") as { generatedCacheBudget?: number } | undefined)
				?.generatedCacheBudget,
		).toBe(2);
	});

	it("does not retry malformed envelopes after partial tool-call content starts streaming", async () => {
		let attempt = 0;
		vi.spyOn(Messages.prototype, "create").mockImplementation(() => {
			attempt += 1;
			return createMockRequest(createMalformedToolUseEvents()) as never;
		});

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		expect(attempt).toBe(1);
		expect(countEvents(events, "toolcall_start")).toBe(1);
		expect(countEvents(events, "toolcall_delta")).toBe(1);
		expect(countEvents(events, "toolcall_end")).toBe(1);
		expect(countEvents(events, "error")).toBe(1);
		expect(countEvents(events, "done")).toBe(0);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("stream ended before terminal stop signal");

		const toolCall = result.content[0];
		expect(toolCall?.type).toBe("toolCall");
		if (toolCall?.type !== "toolCall") {
			throw new Error("Expected toolCall content in terminal error payload");
		}
		expect("partialJson" in toolCall).toBe(false);
	});
	it("parses raw SSE directly so unknown events do not fail Anthropic streams", async () => {
		vi.spyOn(Messages.prototype, "create").mockImplementation(
			() =>
				createRawSseRequest(
					createTextSuccessSseFrames("hello", [
						sseFrame("anthropic_internal_trace", { type: "anthropic_internal_trace", trace_id: "trace_123" }),
					]),
				) as never,
		);

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		expect(countEvents(events, "error")).toBe(0);
		expect(countEvents(events, "done")).toBe(1);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
	});

	it("surfaces an error when a raw SSE stream closes before message_stop", async () => {
		const incompleteFrames = createTextSuccessSseFrames("partial").filter(
			frame => !frame.includes("event: message_stop"),
		);
		vi.spyOn(Messages.prototype, "create").mockImplementation(() => createRawSseRequest(incompleteFrames) as never);

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		expect(countEvents(events, "error")).toBe(1);
		expect(countEvents(events, "done")).toBe(0);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("stream ended before message_stop");
		expect(result.content).toEqual([{ type: "text", text: "partial" }]);
	});

	it("repairs malformed JSON in raw SSE event data before parsing", async () => {
		const malformedTextDelta =
			'{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"line\\qbreak"}}';
		const successEvents = createTextSuccessEvents("unused");
		const frames = [
			sseFrame("message_start", successEvents[0]),
			sseFrame("content_block_start", successEvents[1]),
			sseRawFrame("content_block_delta", malformedTextDelta),
			sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
			sseFrame("message_delta", successEvents[4]),
			sseFrame("message_stop", { type: "message_stop" }),
		];
		vi.spyOn(Messages.prototype, "create").mockImplementation(() => createRawSseRequest(frames) as never);

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		for await (const _ of stream) {
			// drain stream
		}
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "line\\qbreak" }]);
	});
	it("surfaces a refusal fallback message when stop_details is null", async () => {
		const refusalEvents: MockAnthropicEvent[] = [
			{
				type: "message_start",
				message: {
					id: "msg_refusal_no_details",
					usage: {
						input_tokens: 5,
						output_tokens: 0,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				},
			},
			{
				type: "message_delta",
				delta: { stop_reason: "refusal", stop_sequence: null, stop_details: null },
				usage: { input_tokens: 5, output_tokens: 0 },
			},
			{ type: "message_stop" },
		];
		vi.spyOn(Messages.prototype, "create").mockImplementation(() => createMockRequest(refusalEvents) as never);

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Refusal (no details provided)");
		expect(result.errorKind).toBe("provider_safety_stop");
		expect(result.errorMessage).not.toContain("An unknown error occurred");
		expect(countEvents(events, "error")).toBe(1);
		expect(countEvents(events, "done")).toBe(0);
	});

	it("surfaces a typed safety stop for a refusal with details", async () => {
		const refusalEvents: MockAnthropicEvent[] = [
			{
				type: "message_start",
				message: {
					id: "msg_refusal_details",
					usage: {
						input_tokens: 5,
						output_tokens: 0,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				},
			},
			{
				type: "message_delta",
				delta: {
					stop_reason: "end_turn",
					stop_details: {
						type: "refusal",
						category: "safety",
						explanation: "Policy violation",
					},
				},
				usage: { input_tokens: 5, output_tokens: 0 },
			},
			{ type: "message_stop" },
		];
		vi.spyOn(Messages.prototype, "create").mockImplementation(() => createMockRequest(refusalEvents) as never);

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Refusal (safety): Policy violation");
		expect(result.errorKind).toBe("provider_safety_stop");
		expect(countEvents(events, "error")).toBe(1);
		expect(countEvents(events, "done")).toBe(0);
	});

	it("surfaces a typed safety stop for a sensitive termination", async () => {
		const sensitiveEvents: MockAnthropicEvent[] = [
			{
				type: "message_start",
				message: {
					id: "msg_sensitive",
					usage: {
						input_tokens: 5,
						output_tokens: 0,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				},
			},
			{
				type: "message_delta",
				delta: { stop_reason: "sensitive", stop_details: null },
				usage: { input_tokens: 5, output_tokens: 0 },
			},
			{ type: "message_stop" },
		];
		vi.spyOn(Messages.prototype, "create").mockImplementation(() => createMockRequest(sensitiveEvents) as never);

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		for await (const _ of stream) {
			// drain stream
		}
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Content flagged by safety filters");
		expect(result.errorKind).toBe("provider_safety_stop");
	});
	it("keeps a safety stop terminal when later stop reasons and tool events arrive", async () => {
		const eventsAfterSafety: MockAnthropicEvent[] = [
			{
				type: "message_start",
				message: {
					id: "msg_safety_then_tool",
					usage: {
						input_tokens: 5,
						output_tokens: 0,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				},
			},
			{
				type: "message_delta",
				delta: { stop_reason: "refusal", stop_details: null },
				usage: { input_tokens: 5, output_tokens: 0 },
			},
			{
				type: "content_block_start",
				index: 0,
				content_block: { type: "tool_use", id: "tool_after_safety", name: "bash", input: {} },
			},
			{
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: '{"command":"pwd"}' },
			},
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
			{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
			{ type: "message_stop" },
		];
		vi.spyOn(Messages.prototype, "create").mockImplementation(() => createMockRequest(eventsAfterSafety) as never);

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		const observedEvents: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			observedEvents.push(event);
		}
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(result.errorKind).toBe("provider_safety_stop");
		expect(result.content).toEqual([]);
		expect(countEvents(observedEvents, "error")).toBe(1);
		expect(countEvents(observedEvents, "done")).toBe(0);
		expect(countEvents(observedEvents, "toolcall_start")).toBe(0);
		expect(countEvents(observedEvents, "toolcall_delta")).toBe(0);
		expect(countEvents(observedEvents, "toolcall_end")).toBe(0);
	});

	it("does not retry a stream that closes after a stop_details refusal", async () => {
		let attempt = 0;
		vi.spyOn(Messages.prototype, "create").mockImplementation(() => {
			attempt += 1;
			if (attempt === 1) {
				return createRawSseRequest([
					sseFrame("message_start", {
						type: "message_start",
						message: {
							id: "msg_safety_stream_close",
							usage: {
								input_tokens: 5,
								output_tokens: 0,
								cache_read_input_tokens: 0,
								cache_creation_input_tokens: 0,
							},
						},
					}),
					sseFrame("message_delta", {
						type: "message_delta",
						delta: {
							stop_details: {
								type: "refusal",
								category: "safety",
								explanation: "Policy violation",
							},
						},
						usage: { input_tokens: 5, output_tokens: 0 },
					}),
				]) as never;
			}
			return createMockRequest(createTextSuccessEvents("must not be used")) as never;
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		const observedEvents: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			observedEvents.push(event);
		}
		const result = await stream.result();

		expect(attempt).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorKind).toBe("provider_safety_stop");
		expect(result.errorMessage).toBe("Refusal (safety): Policy violation");
		expect(countEvents(observedEvents, "error")).toBe(1);
		expect(countEvents(observedEvents, "done")).toBe(0);
	});
	it("emits per-tool eager_input_streaming only when Anthropic compat allows it", async () => {
		const toolContext: Context = {
			...context,
			tools: [
				{
					name: "lookup_weather",
					description: "Lookup weather",
					parameters: cityObjectSchema,
				},
			],
		};
		const payloads: unknown[] = [];
		vi.spyOn(Messages.prototype, "create").mockImplementation((params: unknown) => {
			payloads.push(params);
			return createMockRequest(createTextSuccessEvents("ok")) as never;
		});

		const eagerStream = streamAnthropic(model, toolContext, { apiKey: "sk-ant-test" });
		for await (const _ of eagerStream) {
			// drain stream
		}
		await eagerStream.result();

		const disabledStream = streamAnthropic(
			{ ...model, compat: { supportsEagerToolInputStreaming: false } },
			toolContext,
			{ apiKey: "sk-ant-test" },
		);
		for await (const _ of disabledStream) {
			// drain stream
		}
		await disabledStream.result();

		const eagerTool = (payloads[0] as { tools?: Array<Record<string, unknown>> }).tools?.[0];
		const disabledTool = (payloads[1] as { tools?: Array<Record<string, unknown>> }).tools?.[0];
		expect(eagerTool?.eager_input_streaming).toBe(true);
		expect(disabledTool).not.toHaveProperty("eager_input_streaming");
	});

	it("emits 1h cache TTL only for canonical Anthropic API with compatible long-cache support", async () => {
		const payloads: unknown[] = [];
		vi.spyOn(Messages.prototype, "create").mockImplementation((params: unknown) => {
			payloads.push(params);
			return createMockRequest(createTextSuccessEvents("ok")) as never;
		});

		for (const testModel of [
			model,
			{ ...model, compat: { supportsLongCacheRetention: false } },
			{ ...model, baseUrl: "https://proxy.example.com/anthropic" },
			{
				...model,
				id: "custom-compatible-model",
				name: "Custom compatible model",
				baseUrl: "https://proxy.example.com/anthropic",
			},
		]) {
			const stream = streamAnthropic(testModel, context, {
				apiKey: "sk-ant-test",
				cacheRetention: "long",
			});
			for await (const _ of stream) {
				// drain stream
			}
			await stream.result();
		}

		const cacheControls = payloads.map(
			payload => (payload as { cache_control?: { ttl?: string; type: string } }).cache_control,
		);
		expect(cacheControls[0]).toEqual({ type: "ephemeral", ttl: "1h" });
		expect(cacheControls[1]).toEqual({ type: "ephemeral" });
		// Claude-family models through compatible gateways default to explicit
		// block caching; without long-retention opt-in the marker uses ~5m.
		expect(cacheControls[2]).toBeUndefined();
		const proxiedControl = (
			payloads[2] as { messages?: Array<{ content?: Array<{ cache_control?: { ttl?: string; type: string } }> }> }
		).messages
			?.at(-1)
			?.content?.at(-1)?.cache_control;
		expect(proxiedControl).toEqual({ type: "ephemeral" });
		// Non-Claude models on unknown compatible endpoints receive no generated caching.
		expect(cacheControls[3]).toBeUndefined();
	});

	it("defaults to 1h cache TTL when the request omits cacheRetention, with safe fallback", async () => {
		const prevGjc = Bun.env.GJC_CACHE_RETENTION;
		const prevPi = Bun.env.PI_CACHE_RETENTION;
		delete Bun.env.GJC_CACHE_RETENTION;
		delete Bun.env.PI_CACHE_RETENTION;

		const payloads: unknown[] = [];
		vi.spyOn(Messages.prototype, "create").mockImplementation((params: unknown) => {
			payloads.push(params);
			return createMockRequest(createTextSuccessEvents("ok")) as never;
		});

		try {
			for (const testModel of [
				model,
				{ ...model, compat: { supportsLongCacheRetention: false } },
				{ ...model, baseUrl: "https://proxy.example.com/anthropic" },
				{
					...model,
					id: "custom-compatible-model",
					name: "Custom compatible model",
					baseUrl: "https://proxy.example.com/anthropic",
				},
			]) {
				// No cacheRetention passed: the provider default should drive the TTL.
				const stream = streamAnthropic(testModel, context, { apiKey: "sk-ant-test" });
				for await (const _ of stream) {
					// drain stream
				}
				await stream.result();
			}
		} finally {
			if (prevGjc === undefined) delete Bun.env.GJC_CACHE_RETENTION;
			else Bun.env.GJC_CACHE_RETENTION = prevGjc;
			if (prevPi === undefined) delete Bun.env.PI_CACHE_RETENTION;
			else Bun.env.PI_CACHE_RETENTION = prevPi;
		}

		const cacheControls = payloads.map(
			payload => (payload as { cache_control?: { ttl?: string; type: string } }).cache_control,
		);
		// Canonical Anthropic API + long-cache-capable model gets 1h by default.
		expect(cacheControls[0]).toEqual({ type: "ephemeral", ttl: "1h" });
		// Models without long-cache support fall back to the default ~5m breakpoint.
		expect(cacheControls[1]).toEqual({ type: "ephemeral" });
		// Claude-family models through compatible gateways default to explicit
		// block caching; without long-retention opt-in the marker uses ~5m.
		expect(cacheControls[2]).toBeUndefined();
		const proxiedControl = (
			payloads[2] as { messages?: Array<{ content?: Array<{ cache_control?: { ttl?: string; type: string } }> }> }
		).messages
			?.at(-1)
			?.content?.at(-1)?.cache_control;
		expect(proxiedControl).toEqual({ type: "ephemeral" });
		// Non-Claude models on unknown compatible endpoints receive no generated caching.
		expect(cacheControls[3]).toBeUndefined();
	});
	it("coerces a non-string thinking increment to an empty string instead of forwarding the live value", async () => {
		const thinkingModel: Model<"anthropic-messages"> = {
			...model,
			id: "claude-sonnet-4-6",
			thinking: { mode: "anthropic-adaptive", minLevel: Effort.Minimal, maxLevel: Effort.Max },
		};
		vi.spyOn(Messages.prototype, "create").mockImplementation(
			() =>
				createMockRequest([
					{
						type: "message_start",
						message: { id: "msg_zai_thinking", usage: { input_tokens: 0, output_tokens: 0 } },
					},
					{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
					{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: 1 } },
					{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta" } },
					{
						type: "content_block_delta",
						index: 0,
						delta: { type: "thinking_delta", thinking: "later" },
					},
					{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: 7 } },
					{
						type: "content_block_delta",
						index: 0,
						delta: { type: "signature_delta", signature: "sig_ok" },
					},
					{ type: "content_block_stop", index: 0 },
					{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
					{ type: "message_stop" },
				]) as never,
		);

		const stream = streamAnthropic(thinkingModel, context, { apiKey: "sk-ant-test", thinkingEnabled: true });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();

		const deltas = events.filter(event => event.type === "thinking_delta");
		expect(deltas.map(event => event.delta)).toEqual(["", "", "later"]);
		expect(result.content).toEqual([{ type: "thinking", thinking: "later", thinkingSignature: "sig_ok" }]);
	});
});
