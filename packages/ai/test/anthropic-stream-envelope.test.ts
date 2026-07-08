import { afterEach, describe, expect, it, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import { Messages } from "@anthropic-ai/sdk/resources/messages/messages";
import { streamAnthropic } from "../src/providers/anthropic";
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
		expect(result.errorMessage).not.toContain("An unknown error occurred");
		expect(countEvents(events, "error")).toBe(1);
		expect(countEvents(events, "done")).toBe(0);
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

		const cacheControls = payloads.map(payload => {
			const messages = (payload as { messages: Array<{ content: unknown }> }).messages;
			const content = messages.at(-1)?.content;
			if (!Array.isArray(content)) return undefined;
			return (content.at(-1) as { cache_control?: { ttl?: string; type: string } } | undefined)?.cache_control;
		});
		expect(cacheControls[0]).toEqual({ type: "ephemeral", ttl: "1h" });
		expect(cacheControls[1]).toEqual({ type: "ephemeral" });
		expect(cacheControls[2]).toEqual({ type: "ephemeral" });
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

		const cacheControls = payloads.map(payload => {
			const messages = (payload as { messages: Array<{ content: unknown }> }).messages;
			const content = messages.at(-1)?.content;
			if (!Array.isArray(content)) return undefined;
			return (content.at(-1) as { cache_control?: { ttl?: string; type: string } } | undefined)?.cache_control;
		});
		// Canonical Anthropic API + long-cache-capable model gets 1h by default.
		expect(cacheControls[0]).toEqual({ type: "ephemeral", ttl: "1h" });
		// Models without long-cache support fall back to the default ~5m breakpoint.
		expect(cacheControls[1]).toEqual({ type: "ephemeral" });
		// Non-canonical base URLs fall back to the default ~5m breakpoint.
		expect(cacheControls[2]).toEqual({ type: "ephemeral" });
	});
});
