import { describe, expect, it } from "bun:test";
import { encodeResponse, encodeStream, parseRequest } from "../src/providers/anthropic-messages-server";
import type { AssistantMessage, AssistantMessageEvent, ToolResultMessage } from "../src/types";
import { AssistantMessageEventStream } from "../src/utils/event-stream";

function emptyUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

const RAW_SENTINEL = "RAW_SERIALIZED_RESPONSES_REASONING";
const SUMMARY_SENTINEL = "SUMMARY_SAFE_DISPLAY_TEXT";
const RESPONSES_REASONING_SIGNATURE = JSON.stringify({
	type: "reasoning",
	id: "rs_raw",
	content: [{ type: "reasoning_text", text: RAW_SENTINEL }],
});
const OPAQUE_SIGNATURE = "opaque-provider-signature";

function makeStream(events: AssistantMessageEvent[]): AssistantMessageEventStream {
	const s = new AssistantMessageEventStream();
	queueMicrotask(() => {
		for (const ev of events) s.push(ev);
		s.end();
	});
	return s;
}

interface SseEvent {
	event: string;
	data: Record<string, unknown>;
}

async function collectSse(stream: ReadableStream<Uint8Array>): Promise<SseEvent[]> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	const out: SseEvent[] = [];
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		buf += decoder.decode(value, { stream: true });
	}
	buf += decoder.decode();
	for (const chunk of buf.split("\n\n")) {
		if (!chunk.trim()) continue;
		let event = "";
		let dataLine = "";
		for (const line of chunk.split("\n")) {
			if (line.startsWith("event: ")) event = line.slice(7);
			else if (line.startsWith("data: ")) dataLine = line.slice(6);
		}
		out.push({ event, data: JSON.parse(dataLine) as Record<string, unknown> });
	}
	return out;
}

describe("anthropic-messages parseRequest", () => {
	it("parses system + user + assistant(thinking,text,tool_use) + tool_result", () => {
		const parsed = parseRequest({
			model: "claude-opus-4-7",
			max_tokens: 1024,
			temperature: 0.2,
			top_p: 0.9,
			stop_sequences: ["\n\n"],
			tool_choice: { type: "any" },
			thinking: { type: "enabled", budget_tokens: 2048 },
			system: [
				{ type: "text", text: "You are X" },
				{ type: "text", text: "Be brief." },
			],
			tools: [
				{
					name: "lookup",
					description: "find a thing",
					input_schema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
				},
			],
			messages: [
				{ role: "user", content: "hi" },
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "hmm", signature: "sig-1" },
						{ type: "redacted_thinking", data: "REDACTED" },
						{ type: "text", text: "calling tool" },
						{ type: "tool_use", id: "toolu_abc", name: "lookup", input: { q: "x" } },
					],
				},
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "toolu_abc",
							content: [{ type: "text", text: "result text" }],
							is_error: false,
						},
					],
				},
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "toolu_def",
							content: "string body",
							is_error: true,
						},
						{ type: "text", text: "and another result coming" },
					],
				},
			],
		});

		expect(parsed.modelId).toBe("claude-opus-4-7");
		expect(parsed.stream).toBe(false);
		expect(parsed.context.systemPrompt).toEqual(["You are X\n\nBe brief."]);
		expect(parsed.options.maxOutputTokens).toBe(1024);
		expect(parsed.options.temperature).toBe(0.2);
		expect(parsed.options.topP).toBe(0.9);
		expect(parsed.options.stopSequences).toEqual(["\n\n"]);
		expect(parsed.options.toolChoice).toBe("required");
		expect(parsed.options.explicitThinkingBudgetTokens).toBe(2048);
		expect(parsed.options.extra).toBeUndefined();

		expect(parsed.context.tools).toHaveLength(1);
		const tool = parsed.context.tools![0]!;
		expect(tool.name).toBe("lookup");
		expect(tool.description).toBe("find a thing");
		expect(tool.parameters).toEqual({
			type: "object",
			properties: { q: { type: "string" } },
			required: ["q"],
		});

		// messages: user("hi"), assistant(4 blocks), toolResult(toolu_abc),
		// toolResult(toolu_def), user("and another result coming")
		const msgs = parsed.context.messages;
		expect(msgs).toHaveLength(5);

		expect(msgs[0]).toMatchObject({ role: "user", content: "hi" });

		const asst = msgs[1];
		expect(asst.role).toBe("assistant");
		if (asst.role !== "assistant") throw new Error();
		expect(asst.content).toEqual([
			{ type: "thinking", thinking: "hmm", thinkingSignature: "sig-1" },
			{ type: "redactedThinking", data: "REDACTED" },
			{ type: "text", text: "calling tool" },
			{ type: "toolCall", id: "toolu_abc", name: "lookup", arguments: { q: "x" } },
		]);
		expect(asst.api).toBe("anthropic-messages");
		expect(asst.provider).toBe("anthropic");
		expect(asst.model).toBe("claude-opus-4-7");

		const tr1 = msgs[2] as ToolResultMessage;
		expect(tr1.role).toBe("toolResult");
		expect(tr1.toolCallId).toBe("toolu_abc");
		expect(tr1.isError).toBe(false);
		expect(tr1.content).toEqual([{ type: "text", text: "result text" }]);

		const tr2 = msgs[3] as ToolResultMessage;
		expect(tr2.role).toBe("toolResult");
		expect(tr2.toolCallId).toBe("toolu_def");
		expect(tr2.isError).toBe(true);
		expect(tr2.content).toEqual([{ type: "text", text: "string body" }]);

		expect(msgs[4]).toMatchObject({ role: "user", content: "and another result coming" });
	});

	it("maps tool_choice variants and suppresses user wrappers that hold only tool_result", () => {
		const auto = parseRequest({
			model: "m",
			max_tokens: 8,
			tool_choice: { type: "auto" },
			messages: [{ role: "user", content: "hi" }],
		});
		expect(auto.options.toolChoice).toBe("auto");

		const named = parseRequest({
			model: "m",
			max_tokens: 8,
			tool_choice: { type: "tool", name: "lookup" },
			messages: [{ role: "user", content: "hi" }],
		});
		expect(named.options.toolChoice).toEqual({ name: "lookup" });

		const onlyResult = parseRequest({
			model: "m",
			max_tokens: 8,
			messages: [
				{
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "ok" }] }],
				},
			],
		});
		// no user wrapper, just the toolResult
		expect(onlyResult.context.messages).toHaveLength(1);
		expect(onlyResult.context.messages[0]!.role).toBe("toolResult");
	});

	it("splits user text/image blocks into a separate UserMessage before a tool_result", () => {
		const parsed = parseRequest({
			model: "m",
			max_tokens: 8,
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "preface text" },
						{ type: "tool_result", tool_use_id: "t1", content: "ok" },
					],
				},
			],
		});
		// Expect a flush before the tool result: user("preface text") then toolResult(t1).
		expect(parsed.context.messages).toHaveLength(2);
		expect(parsed.context.messages[0]).toMatchObject({ role: "user", content: "preface text" });
		expect(parsed.context.messages[1]!.role).toBe("toolResult");
	});

	it("rejects missing required fields and unsupported request controls", () => {
		expect(() => parseRequest({})).toThrow(/model/);
		expect(() => parseRequest({ model: "m", messages: [] })).toThrow(/max_tokens/);
		expect(() => parseRequest({ model: "m", max_tokens: 1 })).toThrow(/messages/);
		const topK = parseRequest({ model: "m", max_tokens: 1, messages: [{ role: "user", content: "hi" }], top_k: 50 });
		expect(topK.options.topK).toBe(50);
		// `metadata` is tolerated permissively and surfaced on options for
		// downstream forwarding (Anthropic clients ship `metadata.user_id`).
		const withMetadata = parseRequest({
			model: "m",
			max_tokens: 1,
			messages: [{ role: "user", content: "hi" }],
			metadata: { user_id: "u_1" },
		});
		expect(withMetadata.options.extra).toBeUndefined();
		expect(withMetadata.options.metadata).toEqual({ user_id: "u_1" });
	});
});

describe("anthropic-messages encodeResponse", () => {
	it("encodes text + thinking + tool_use with correct ordering and stop_reason mapping", () => {
		const message: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "let me think", thinkingSignature: "sig-xyz" },
				{ type: "text", text: "calling tool now" },
				{ type: "toolCall", id: "toolu_999", name: "lookup", arguments: { q: "hello" } },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus-4-7",
			usage: { ...emptyUsage(), input: 12, output: 34, cacheRead: 5, cacheWrite: 7, totalTokens: 58 },
			stopReason: "toolUse",
			timestamp: 1000,
		};
		const encoded = encodeResponse(message, "claude-opus-4-7");
		expect(encoded.type).toBe("message");
		expect(encoded.role).toBe("assistant");
		expect(encoded.model).toBe("claude-opus-4-7");
		expect(encoded.stop_reason).toBe("tool_use");
		expect(encoded.stop_sequence).toBeNull();
		expect(encoded.usage).toEqual({
			input_tokens: 12,
			output_tokens: 34,
			cache_read_input_tokens: 5,
			cache_creation_input_tokens: 7,
		});
		expect(encoded.content).toEqual([
			{ type: "thinking", thinking: "let me think", signature: "sig-xyz" },
			{ type: "text", text: "calling tool now" },
			{ type: "tool_use", id: "toolu_999", name: "lookup", input: { q: "hello" } },
		]);
		expect(typeof encoded.id).toBe("string");
		expect((encoded.id as string).startsWith("msg_")).toBe(true);
	});

	it("surfaces only the finalized summary for mixed reasoning", () => {
		const message: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: "SUMMARY_ONLY",
					provenance: "mixed",
					summaryText: "SUMMARY_ONLY",
					rawText: "RAW_DO_NOT_SURFACE",
					thinkingSignature: "opaque-signature",
				},
				{ type: "text", text: "visible answer" },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus-4-7",
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: 0,
		};

		const encoded = encodeResponse(message, "claude-opus-4-7");
		const content = encoded.content as Array<{ type: string; thinking?: string }>;
		expect(content[0]).toMatchObject({ type: "thinking", thinking: "SUMMARY_ONLY" });
		expect(JSON.stringify(encoded)).not.toContain("RAW_DO_NOT_SURFACE");
	});

	it("omits raw-only Codex Responses reasoning from non-streaming egress", () => {
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "thinking", thinking: RAW_SENTINEL, provenance: "raw", rawText: RAW_SENTINEL }],
			api: "openai-codex-responses",
			provider: "openai-codex",
			model: "gpt-5",
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: 0,
		};

		const encoded = encodeResponse(message, "claude-opus-4-7");
		expect(JSON.stringify(encoded)).not.toContain(RAW_SENTINEL);
		expect(encoded.content).toEqual([]);
	});

	it("maps stop reasons and rejects upstream terminal errors", () => {
		const base: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "m",
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: 0,
		};
		expect(encodeResponse({ ...base, stopReason: "stop" }, "m").stop_reason).toBe("end_turn");
		expect(encodeResponse({ ...base, stopReason: "length" }, "m").stop_reason).toBe("max_tokens");
		expect(encodeResponse({ ...base, stopReason: "toolUse" }, "m").stop_reason).toBe("tool_use");
		expect(() => encodeResponse({ ...base, stopReason: "error", errorMessage: "upstream failed" }, "m")).toThrow(
			/upstream failed/,
		);
		expect(() => encodeResponse({ ...base, stopReason: "aborted", errorMessage: "request aborted" }, "m")).toThrow(
			/request aborted/,
		);
	});
});

describe("anthropic-messages serialized Responses signature privacy", () => {
	it("omits raw-bearing signatures from non-streaming and streaming egress", async () => {
		const message: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: SUMMARY_SENTINEL,
					provenance: "mixed",
					summaryText: SUMMARY_SENTINEL,
					rawText: RAW_SENTINEL,
					thinkingSignature: RESPONSES_REASONING_SIGNATURE,
				},
				{ type: "thinking", thinking: "provider thought", thinkingSignature: OPAQUE_SIGNATURE },
			],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5",
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: 0,
		};
		const encoded = encodeResponse(message, "claude-opus-4-7");
		const encodedBytes = JSON.stringify(encoded);
		expect(encodedBytes).not.toContain(RAW_SENTINEL);
		expect(encodedBytes).not.toContain(RESPONSES_REASONING_SIGNATURE);
		expect(encodedBytes).toContain(SUMMARY_SENTINEL);
		expect(encodedBytes).not.toContain(OPAQUE_SIGNATURE);
		expect(encoded.content).toEqual([{ type: "thinking", thinking: SUMMARY_SENTINEL }]);
		const providerMessage: AssistantMessage = {
			...message,
			content: [{ type: "thinking", thinking: "provider thought", thinkingSignature: OPAQUE_SIGNATURE }],
			api: "anthropic-messages",
			provider: "anthropic",
		};

		const events: AssistantMessageEvent[] = [
			{ type: "thinking_start", contentIndex: 0, partial: message },
			{ type: "reasoning_summary_start", contentIndex: 0, partial: message },
			{ type: "reasoning_summary_delta", contentIndex: 0, delta: SUMMARY_SENTINEL, partial: message },
			{ type: "reasoning_summary_end", contentIndex: 0, content: SUMMARY_SENTINEL, partial: message },
			{ type: "thinking_delta", contentIndex: 0, delta: RAW_SENTINEL, partial: message },
			{ type: "thinking_end", contentIndex: 0, content: RAW_SENTINEL, partial: message },
			{ type: "thinking_start", contentIndex: 0, partial: providerMessage },
			{ type: "thinking_delta", contentIndex: 0, delta: "provider thought", partial: providerMessage },
			{ type: "thinking_end", contentIndex: 0, content: "provider thought", partial: providerMessage },
			{ type: "done", reason: "stop", message },
		];
		const stream = await collectSse(encodeStream(makeStream(events), "claude-opus-4-7"));
		const streamBytes = JSON.stringify(stream);
		expect(streamBytes).not.toContain(RAW_SENTINEL);
		expect(streamBytes).not.toContain(RESPONSES_REASONING_SIGNATURE);
		expect(streamBytes).toContain(SUMMARY_SENTINEL);
		expect(streamBytes).toContain(OPAQUE_SIGNATURE);
		const signatureDeltas = stream.filter(
			event => (event.data.delta as { type?: string; signature?: string } | undefined)?.type === "signature_delta",
		);
		expect(signatureDeltas).toEqual([
			{
				event: "content_block_delta",
				data: {
					type: "content_block_delta",
					index: 0,
					delta: { type: "signature_delta", signature: OPAQUE_SIGNATURE },
				},
			},
		]);
		expect(message.content[0]).toMatchObject({ thinkingSignature: RESPONSES_REASONING_SIGNATURE });
	});
});

it("drops unprovenanced Codex thinking when the stream is interrupted", async () => {
	const partial: AssistantMessage = {
		role: "assistant",
		content: [{ type: "thinking", thinking: RAW_SENTINEL }],
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "gpt-5",
		usage: emptyUsage(),
		stopReason: "error",
		timestamp: 0,
	};
	const error: AssistantMessage = { ...partial, errorMessage: "upstream went away" };
	const events: AssistantMessageEvent[] = [
		{ type: "thinking_start", contentIndex: 0, partial },
		{ type: "thinking_delta", contentIndex: 0, delta: RAW_SENTINEL, partial },
		{ type: "error", reason: "error", error },
	];

	const sse = await collectSse(encodeStream(makeStream(events), "claude-opus-4-7"));
	const bytes = JSON.stringify(sse);

	expect(bytes).not.toContain(RAW_SENTINEL);
	expect(sse.at(-1)).toEqual({
		event: "error",
		data: { type: "error", error: { type: "api_error", message: "upstream went away" } },
	});
});

it("buffers unclassified Responses thinking and flushes finalized provider-native thinking with its opaque signature", async () => {
	const unclassified: AssistantMessage = {
		role: "assistant",
		content: [{ type: "thinking", thinking: RAW_SENTINEL }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5",
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: 0,
	};
	const mixed: AssistantMessage = {
		...unclassified,
		content: [
			{
				type: "thinking",
				thinking: SUMMARY_SENTINEL,
				provenance: "mixed",
				summaryText: SUMMARY_SENTINEL,
				rawText: RAW_SENTINEL,
			},
		],
	};
	const native: AssistantMessage = {
		...unclassified,
		api: "anthropic-messages",
		provider: "anthropic",
		content: [
			{ type: "text", text: "" },
			{ type: "thinking", thinking: "provider thought", thinkingSignature: OPAQUE_SIGNATURE },
		],
	};
	const events: AssistantMessageEvent[] = [
		{ type: "thinking_start", contentIndex: 0, partial: unclassified },
		{ type: "thinking_delta", contentIndex: 0, delta: RAW_SENTINEL, partial: unclassified },
		{ type: "reasoning_summary_start", contentIndex: 0, partial: unclassified },
		{ type: "reasoning_summary_delta", contentIndex: 0, delta: SUMMARY_SENTINEL, partial: unclassified },
		{ type: "thinking_end", contentIndex: 0, content: RAW_SENTINEL, partial: mixed },
		{ type: "thinking_start", contentIndex: 1, partial: native },
		{ type: "thinking_delta", contentIndex: 1, delta: "provider thought", partial: native },
		{ type: "thinking_end", contentIndex: 1, content: "provider thought", partial: native },
		{ type: "done", reason: "stop", message: native },
	];

	const sse = await collectSse(encodeStream(makeStream(events), "claude-opus-4-7"));
	const bytes = JSON.stringify(sse);
	expect(bytes).not.toContain(RAW_SENTINEL);
	expect(bytes).toContain(SUMMARY_SENTINEL);
	expect(bytes).toContain(OPAQUE_SIGNATURE);
	expect(sse.filter(event => event.event === "content_block_start").map(event => event.data.index)).toEqual([0, 1]);
	expect(sse.filter(event => event.event === "content_block_stop").map(event => event.data.index)).toEqual([0, 1]);
});

describe("anthropic-messages encodeStream", () => {
	it("emits thinking_delta + signature_delta + text_delta + tool_use input_json_delta + message_stop", async () => {
		const finalMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "thoughts", thinkingSignature: "SIG" },
				{ type: "text", text: "hi there" },
				{ type: "toolCall", id: "toolu_1", name: "go", arguments: { x: 1 } },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus-4-7",
			usage: { ...emptyUsage(), input: 11, output: 42, cacheRead: 3, cacheWrite: 5 },
			stopReason: "toolUse",
			timestamp: 0,
		};

		const partialAfterThinkingEnd: AssistantMessage = {
			...finalMessage,
			content: [{ type: "thinking", thinking: "thoughts", thinkingSignature: "SIG" }],
		};
		const partialAtToolStart: AssistantMessage = {
			...finalMessage,
			content: [
				{ type: "thinking", thinking: "thoughts", thinkingSignature: "SIG" },
				{ type: "text", text: "hi there" },
				{ type: "toolCall", id: "toolu_1", name: "go", arguments: {} },
			],
		};

		const events: AssistantMessageEvent[] = [
			{ type: "start", partial: finalMessage },
			{ type: "thinking_start", contentIndex: 0, partial: finalMessage },
			{ type: "thinking_delta", contentIndex: 0, delta: "thoughts", partial: finalMessage },
			{ type: "thinking_end", contentIndex: 0, content: "thoughts", partial: partialAfterThinkingEnd },
			{ type: "text_start", contentIndex: 1, partial: finalMessage },
			{ type: "text_delta", contentIndex: 1, delta: "hi ", partial: finalMessage },
			{ type: "text_delta", contentIndex: 1, delta: "there", partial: finalMessage },
			{ type: "text_end", contentIndex: 1, content: "hi there", partial: finalMessage },
			{ type: "toolcall_start", contentIndex: 2, partial: partialAtToolStart },
			{ type: "toolcall_delta", contentIndex: 2, delta: '{"x":', partial: partialAtToolStart },
			{ type: "toolcall_delta", contentIndex: 2, delta: "1}", partial: partialAtToolStart },
			{
				type: "toolcall_end",
				contentIndex: 2,
				toolCall: { type: "toolCall", id: "toolu_1", name: "go", arguments: { x: 1 } },
				partial: finalMessage,
			},
			{ type: "done", reason: "toolUse", message: finalMessage },
		];

		const sse = await collectSse(encodeStream(makeStream(events), "claude-opus-4-7"));

		// Sequence check
		const types = sse.map(e => e.event);
		expect(types).toEqual([
			"message_start",
			"content_block_start",
			"content_block_delta",
			"content_block_delta", // signature_delta
			"content_block_stop",
			"content_block_start",
			"content_block_delta",
			"content_block_delta",
			"content_block_stop",
			"content_block_start",
			"content_block_delta",
			"content_block_delta",
			"content_block_stop",
			"message_delta",
			"message_stop",
		]);

		// message_start payload
		const start = sse[0]!.data as {
			type: string;
			message: { id: string; model: string; role: string; usage: Record<string, unknown> };
		};
		expect(start.type).toBe("message_start");
		expect(start.message.model).toBe("claude-opus-4-7");
		expect(start.message.role).toBe("assistant");
		expect(start.message.id.startsWith("msg_")).toBe(true);
		expect(start.message.usage).toEqual({
			input_tokens: 11,
			output_tokens: 42,
			cache_read_input_tokens: 3,
			cache_creation_input_tokens: 5,
		});

		// thinking block_start
		expect(sse[1]!.data).toEqual({
			type: "content_block_start",
			index: 0,
			content_block: { type: "thinking", thinking: "" },
		});
		expect(sse[2]!.data).toEqual({
			type: "content_block_delta",
			index: 0,
			delta: { type: "thinking_delta", thinking: "thoughts" },
		});
		expect(sse[3]!.data).toEqual({
			type: "content_block_delta",
			index: 0,
			delta: { type: "signature_delta", signature: "SIG" },
		});
		expect(sse[4]!.data).toEqual({ type: "content_block_stop", index: 0 });

		// text block
		expect(sse[5]!.data).toEqual({
			type: "content_block_start",
			index: 1,
			content_block: { type: "text", text: "" },
		});
		expect(sse[6]!.data).toEqual({
			type: "content_block_delta",
			index: 1,
			delta: { type: "text_delta", text: "hi " },
		});

		// tool_use block
		expect(sse[9]!.data).toEqual({
			type: "content_block_start",
			index: 2,
			content_block: { type: "tool_use", id: "toolu_1", name: "go", input: {} },
		});
		expect(sse[10]!.data).toEqual({
			type: "content_block_delta",
			index: 2,
			delta: { type: "input_json_delta", partial_json: '{"x":' },
		});

		// message_delta with mapped stop_reason
		expect(sse[13]!.data).toEqual({
			type: "message_delta",
			delta: { stop_reason: "tool_use", stop_sequence: null },
			usage: {
				input_tokens: 11,
				output_tokens: 42,
				cache_read_input_tokens: 3,
				cache_creation_input_tokens: 5,
			},
		});

		expect(sse[14]!.data).toEqual({ type: "message_stop" });
	});

	it("surfaces summary-only reasoning as a thinking block before its delta", async () => {
		const finalMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "SUMMARY REASONING" },
				{ type: "text", text: "final text" },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus-4-7",
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: 0,
		};
		const partialAfterThinking: AssistantMessage = {
			...finalMessage,
			content: [{ type: "thinking", thinking: "SUMMARY REASONING" }],
		};
		const events: AssistantMessageEvent[] = [
			{ type: "reasoning_summary_start", contentIndex: 0, partial: finalMessage },
			{ type: "reasoning_summary_delta", contentIndex: 0, delta: "SUMMARY REASONING", partial: finalMessage },
			{ type: "reasoning_summary_end", contentIndex: 0, content: "SUMMARY REASONING", partial: finalMessage },
			{ type: "thinking_end", contentIndex: 0, content: "SUMMARY REASONING", partial: partialAfterThinking },
			{ type: "text_start", contentIndex: 1, partial: finalMessage },
			{ type: "text_delta", contentIndex: 1, delta: "final text", partial: finalMessage },
			{ type: "text_end", contentIndex: 1, content: "final text", partial: finalMessage },
			{ type: "done", reason: "stop", message: finalMessage },
		];

		const sse = await collectSse(encodeStream(makeStream(events), "claude-opus-4-7"));
		expect(sse).toContainEqual({
			event: "content_block_start",
			data: {
				type: "content_block_start",
				index: 0,
				content_block: { type: "thinking", thinking: "" },
			},
		});
		expect(sse).toContainEqual({
			event: "content_block_delta",
			data: {
				type: "content_block_delta",
				index: 0,
				delta: { type: "thinking_delta", thinking: "SUMMARY REASONING" },
			},
		});
		const thinkingStart = sse.findIndex(event => event.event === "content_block_start" && event.data.index === 0);
		const summaryDelta = sse.findIndex(event => event.event === "content_block_delta" && event.data.index === 0);
		expect(summaryDelta).toBeGreaterThan(thinkingStart);
		expect(sse).toContainEqual({
			event: "content_block_delta",
			data: {
				type: "content_block_delta",
				index: 1,
				delta: { type: "text_delta", text: "final text" },
			},
		});
	});

	it("surfaces final-only summary reasoning once and closes it before text", async () => {
		const finalMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "FINAL SUMMARY" },
				{ type: "text", text: "final text" },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus-4-7",
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: 0,
		};
		const partialAfterThinking: AssistantMessage = {
			...finalMessage,
			content: [{ type: "thinking", thinking: "FINAL SUMMARY" }],
		};
		const events: AssistantMessageEvent[] = [
			{ type: "reasoning_summary_start", contentIndex: 0, partial: finalMessage },
			{ type: "reasoning_summary_end", contentIndex: 0, content: "FINAL SUMMARY", partial: finalMessage },
			{ type: "thinking_end", contentIndex: 0, content: "FINAL SUMMARY", partial: partialAfterThinking },
			{ type: "text_start", contentIndex: 1, partial: finalMessage },
			{ type: "text_delta", contentIndex: 1, delta: "final text", partial: finalMessage },
			{ type: "text_end", contentIndex: 1, content: "final text", partial: finalMessage },
			{ type: "done", reason: "stop", message: finalMessage },
		];

		const sse = await collectSse(encodeStream(makeStream(events), "claude-opus-4-7"));
		const summaryDeltas = sse.filter(
			event =>
				event.event === "content_block_delta" &&
				event.data.index === 0 &&
				(event.data.delta as { type?: string; thinking?: string }).type === "thinking_delta",
		);
		expect(sse.filter(event => event.event === "content_block_start" && event.data.index === 0)).toHaveLength(1);
		expect(summaryDeltas).toEqual([
			{
				event: "content_block_delta",
				data: {
					type: "content_block_delta",
					index: 0,
					delta: { type: "thinking_delta", thinking: "FINAL SUMMARY" },
				},
			},
		]);
		const summaryDeltaIndex = sse.indexOf(summaryDeltas[0]!);
		const thinkingStopIndex = sse.findIndex(event => event.event === "content_block_stop" && event.data.index === 0);
		expect(thinkingStopIndex).toBeGreaterThan(summaryDeltaIndex);
		expect(sse).toContainEqual({
			event: "content_block_delta",
			data: {
				type: "content_block_delta",
				index: 1,
				delta: { type: "text_delta", text: "final text" },
			},
		});
	});

	it("emits final summary content after a separator-only summary delta", async () => {
		const finalMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "thinking", thinking: "REAL SUMMARY" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus-4-7",
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: 0,
		};
		const events: AssistantMessageEvent[] = [
			{ type: "reasoning_summary_start", contentIndex: 0, partial: finalMessage },
			{ type: "reasoning_summary_delta", contentIndex: 0, delta: "\n\n", partial: finalMessage },
			{ type: "reasoning_summary_end", contentIndex: 0, content: "REAL SUMMARY", partial: finalMessage },
			{ type: "thinking_end", contentIndex: 0, content: "REAL SUMMARY", partial: finalMessage },
			{ type: "done", reason: "stop", message: finalMessage },
		];

		const sse = await collectSse(encodeStream(makeStream(events), "claude-opus-4-7"));
		const thinkingDeltas = sse.filter(
			event =>
				event.event === "content_block_delta" &&
				(event.data.delta as { type?: string; thinking?: string }).type === "thinking_delta",
		);

		expect(thinkingDeltas).toContainEqual({
			event: "content_block_delta",
			data: {
				type: "content_block_delta",
				index: 0,
				delta: { type: "thinking_delta", thinking: "REAL SUMMARY" },
			},
		});
	});

	it("does not repeat streamed summary reasoning at summary end", async () => {
		const finalMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "thinking", thinking: "X" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus-4-7",
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: 0,
		};
		const events: AssistantMessageEvent[] = [
			{ type: "reasoning_summary_start", contentIndex: 0, partial: finalMessage },
			{ type: "reasoning_summary_delta", contentIndex: 0, delta: "X", partial: finalMessage },
			{ type: "reasoning_summary_end", contentIndex: 0, content: "X", partial: finalMessage },
			{ type: "thinking_end", contentIndex: 0, content: "X", partial: finalMessage },
			{ type: "done", reason: "stop", message: finalMessage },
		];

		const sse = await collectSse(encodeStream(makeStream(events), "claude-opus-4-7"));
		const thinkingDeltas = sse.filter(
			event =>
				event.event === "content_block_delta" &&
				event.data.index === 0 &&
				(event.data.delta as { type?: string }).type === "thinking_delta",
		);
		expect(thinkingDeltas).toHaveLength(1);
		expect(thinkingDeltas[0]!.data).toEqual({
			type: "content_block_delta",
			index: 0,
			delta: { type: "thinking_delta", thinking: "X" },
		});
	});

	it("emits an error event when the upstream stream errors", async () => {
		const errMessage: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "m",
			usage: emptyUsage(),
			stopReason: "error",
			errorMessage: "boom",
			timestamp: 0,
		};
		const events: AssistantMessageEvent[] = [
			{ type: "start", partial: errMessage },
			{ type: "error", reason: "error", error: errMessage },
		];
		const sse = await collectSse(encodeStream(makeStream(events), "m"));
		const last = sse.at(-1)!;
		expect(last.event).toBe("error");
		expect(last.data).toEqual({ type: "error", error: { type: "api_error", message: "boom" } });
	});
});
