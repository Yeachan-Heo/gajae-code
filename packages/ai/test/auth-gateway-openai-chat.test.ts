import { describe, expect, it } from "bun:test";
import { encodeResponse, encodeStream, parseRequest } from "../src/providers/openai-chat-server";
import type { AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream } from "../src/types";

function makeEventStream(events: AssistantMessageEvent[], final: AssistantMessage): AssistantMessageEventStream {
	async function* iter() {
		for (const e of events) yield e;
	}
	const stream = iter() as unknown as AssistantMessageEventStream;
	(stream as { result(): Promise<AssistantMessage> }).result = async () => final;
	return stream;
}

async function collectStream(stream: ReadableStream<Uint8Array>): Promise<string[]> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		buf += decoder.decode(value, { stream: true });
	}
	buf += decoder.decode();
	return buf.split("\n\n").filter(s => s.length > 0);
}

function parseSseLine(line: string): unknown {
	const stripped = line.replace(/^data: /, "");
	if (stripped === "[DONE]") return "[DONE]";
	return JSON.parse(stripped);
}

const baseUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const RAW_SENTINEL = "RAW_SERIALIZED_RESPONSES_REASONING";
const SUMMARY_SENTINEL = "SUMMARY_SAFE_DISPLAY_TEXT";

function emptyAssistant(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "openai",
		model: "gpt-test",
		usage: baseUsage,
		stopReason: "stop",
		timestamp: 0,
	};
}

describe("auth-gateway openai-chat: parseRequest", () => {
	it("converts a full request into a Context", () => {
		const parsed = parseRequest({
			model: "gpt-5.2",
			messages: [
				{ role: "system", content: "you are X" },
				{ role: "system", content: "also Y" },
				{ role: "user", content: "hi" },
				{
					role: "assistant",
					content: "hello",
					tool_calls: [
						{
							id: "call_1",
							type: "function",
							function: { name: "lookup", arguments: '{"q":"a"}' },
						},
						{
							id: "call_2",
							type: "function",
							function: { name: "broken", arguments: "not-json" },
						},
					],
				},
				{ role: "tool", tool_call_id: "call_1", content: "result-text" },
			],
			tools: [
				{
					type: "function",
					function: {
						name: "lookup",
						description: "look something up",
						parameters: { type: "object", properties: { q: { type: "string" } } },
					},
				},
			],
			stream: true,
			max_tokens: 512,
			max_completion_tokens: 1024,
			temperature: 0.2,
			top_p: 0.9,
			stop: ["\n\n"],
			tool_choice: { type: "function", function: { name: "lookup" } },
			response_format: { type: "json_object" },
			stream_options: { include_usage: true },
		});

		expect(parsed.modelId).toBe("gpt-5.2");
		expect(parsed.stream).toBe(true);
		expect(parsed.context.systemPrompt).toEqual(["you are X\n\nalso Y"]);
		expect(parsed.context.messages).toHaveLength(3);

		const [user, assistant, tool] = parsed.context.messages;
		expect(user.role).toBe("user");
		expect(assistant.role).toBe("assistant");
		if (assistant.role !== "assistant") throw new Error("unreachable");
		expect(assistant.api).toBe("openai-completions");
		expect(assistant.provider).toBe("openai");
		expect(assistant.model).toBe("gpt-5.2");
		expect(assistant.content[0]).toEqual({ type: "text", text: "hello" });
		const call1 = assistant.content[1];
		const call2 = assistant.content[2];
		if (call1.type !== "toolCall" || call2.type !== "toolCall") throw new Error("unreachable");
		expect(call1.id).toBe("call_1");
		expect(call1.name).toBe("lookup");
		expect(call1.arguments).toEqual({ q: "a" });
		// Un-parseable args fall back to __raw passthrough.
		expect(call2.arguments).toEqual({ __raw: "not-json" });

		expect(tool.role).toBe("toolResult");
		if (tool.role !== "toolResult") throw new Error("unreachable");
		expect(tool.toolCallId).toBe("call_1");
		expect(tool.toolName).toBe("");
		expect(tool.content).toEqual([{ type: "text", text: "result-text" }]);

		expect(parsed.context.tools).toHaveLength(1);
		expect(parsed.context.tools?.[0].name).toBe("lookup");

		// max_completion_tokens wins over max_tokens.
		expect(parsed.options.maxOutputTokens).toBe(1024);
		expect(parsed.options.temperature).toBe(0.2);
		expect(parsed.options.topP).toBe(0.9);
		expect(parsed.options.stopSequences).toEqual(["\n\n"]);
		expect(parsed.options.toolChoice).toEqual({ name: "lookup" });
		expect(parsed.options.responseFormat).toEqual({ type: "json_object" });
		expect(parsed.options.extra).toEqual({ includeStreamingUsage: true });
	});

	it("rejects missing required fields", () => {
		expect(() => parseRequest({ messages: [] })).toThrow(/model/);
		expect(() => parseRequest({ model: "x" })).toThrow(/messages/);
	});

	it("falls back to max_tokens when max_completion_tokens is absent", () => {
		const parsed = parseRequest({ model: "m", messages: [], max_tokens: 256 });
		expect(parsed.options.maxOutputTokens).toBe(256);
		expect(parsed.stream).toBe(false);
	});
});

describe("auth-gateway openai-chat: encodeResponse", () => {
	it("serializes text + tool calls with finish_reason=tool_calls", () => {
		const message: AssistantMessage = {
			...emptyAssistant(),
			content: [
				{ type: "text", text: "the answer is " },
				{ type: "thinking", thinking: "private reasoning" }, // dropped
				{ type: "toolCall", id: "call_42", name: "compute", arguments: { x: 1 } },
			],
			usage: { ...baseUsage, input: 10, output: 20, cacheRead: 4, cacheWrite: 6, totalTokens: 40 },
			stopReason: "toolUse",
		};

		const out = encodeResponse(message, "gpt-5.2");
		expect(out.object).toBe("chat.completion");
		expect(out.model).toBe("gpt-5.2");
		expect(typeof out.id).toBe("string");
		expect(String(out.id).startsWith("chatcmpl-")).toBe(true);

		const choices = out.choices as Array<{
			index: number;
			message: { role: string; content: string | null; tool_calls?: unknown };
			finish_reason: string;
		}>;
		expect(choices).toHaveLength(1);
		expect(choices[0].finish_reason).toBe("tool_calls");
		expect(choices[0].message.role).toBe("assistant");
		expect(choices[0].message.content).toBe("the answer is ");
		expect(choices[0].message.tool_calls).toEqual([
			{ id: "call_42", type: "function", function: { name: "compute", arguments: '{"x":1}' } },
		]);

		expect(out.usage).toEqual({
			prompt_tokens: 20,
			prompt_tokens_details: { cached_tokens: 4 },
			completion_tokens: 20,
			total_tokens: 40,
		});
	});

	it("surfaces only the finalized summary for mixed reasoning", () => {
		const message: AssistantMessage = {
			...emptyAssistant(),
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
		};

		const encoded = encodeResponse(message, "gpt-test");
		const choices = encoded.choices as Array<{
			message: { content: string | null; reasoning_content?: string };
		}>;
		expect(choices[0].message.reasoning_content).toBe("SUMMARY_ONLY");
		expect(JSON.stringify(encoded)).not.toContain("RAW_DO_NOT_SURFACE");
	});

	it("omits raw-only Codex Responses reasoning from non-streaming egress", () => {
		const message: AssistantMessage = {
			...emptyAssistant(),
			content: [{ type: "thinking", thinking: RAW_SENTINEL, provenance: "raw", rawText: RAW_SENTINEL }],
			api: "openai-codex-responses",
			provider: "openai-codex",
		};

		const encoded = encodeResponse(message, "gpt-test");
		expect(JSON.stringify(encoded)).not.toContain(RAW_SENTINEL);
		const choices = encoded.choices as Array<{ message: { reasoning_content?: string } }>;
		expect(choices[0].message.reasoning_content).toBeUndefined();
	});

	it("maps length stop reason and emits null content when text is empty", () => {
		const message: AssistantMessage = { ...emptyAssistant(), stopReason: "length" };
		const out = encodeResponse(message, "gpt-test");
		const choices = out.choices as Array<{ finish_reason: string; message: { content: string | null } }>;
		expect(choices[0].finish_reason).toBe("length");
		expect(choices[0].message.content).toBeNull();
	});
});

describe("auth-gateway openai-chat: encodeStream", () => {
	it("emits role chunk, text deltas, tool_call deltas with sequential indexes, then [DONE]", async () => {
		const partial = emptyAssistant();
		// Pre-populate partial.content so toolcall_start can look up id/name by contentIndex.
		partial.content = [
			{ type: "text", text: "" },
			{ type: "toolCall", id: "call_A", name: "tool_a", arguments: {} },
			{ type: "toolCall", id: "call_B", name: "tool_b", arguments: {} },
		];
		const events: AssistantMessageEvent[] = [
			{ type: "text_start", contentIndex: 0, partial },
			{ type: "text_delta", contentIndex: 0, delta: "Hi ", partial },
			{ type: "text_delta", contentIndex: 0, delta: "there", partial },
			{ type: "text_end", contentIndex: 0, content: "Hi there", partial },
			{ type: "toolcall_start", contentIndex: 1, partial },
			{ type: "toolcall_delta", contentIndex: 1, delta: '{"a":', partial },
			{ type: "toolcall_delta", contentIndex: 1, delta: "1}", partial },
			{ type: "toolcall_start", contentIndex: 2, partial },
			{ type: "toolcall_delta", contentIndex: 2, delta: "{}", partial },
			{
				type: "done",
				reason: "toolUse",
				message: { ...partial, stopReason: "toolUse" },
			},
		];

		const stream = encodeStream(makeEventStream(events, partial), "gpt-5.2");
		const lines = await collectStream(stream);
		const payloads = lines.map(parseSseLine);

		expect(payloads[payloads.length - 1]).toBe("[DONE]");

		const chunks = payloads.slice(0, -1) as Array<{
			id: string;
			object: string;
			model: string;
			choices: Array<{ delta: Record<string, unknown>; finish_reason: string | null }>;
		}>;

		// First chunk is the role announcement.
		expect(chunks[0].object).toBe("chat.completion.chunk");
		expect(chunks[0].model).toBe("gpt-5.2");
		expect(chunks[0].choices[0].delta).toEqual({ role: "assistant" });
		expect(chunks[0].choices[0].finish_reason).toBeNull();

		// All chunks share the same id.
		const id = chunks[0].id;
		for (const c of chunks) expect(c.id).toBe(id);

		// Collect text deltas.
		const textDeltas = chunks.map(c => c.choices[0].delta.content).filter((v): v is string => typeof v === "string");
		expect(textDeltas.join("")).toBe("Hi there");

		// Collect tool_call deltas; verify index sequence.
		const toolDeltas: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> = [];
		for (const c of chunks) {
			const tc = c.choices[0].delta.tool_calls;
			if (Array.isArray(tc)) toolDeltas.push(...(tc as typeof toolDeltas));
		}
		// Two starts (index 0 and 1, NOT contentIndex 1 and 2) plus three arg deltas.
		const starts = toolDeltas.filter(t => typeof t.id === "string" && t.id.length > 0);
		expect(starts.map(s => s.index)).toEqual([0, 1]);
		expect(starts[0].id).toBe("call_A");
		expect(starts[0].function?.name).toBe("tool_a");
		expect(starts[1].id).toBe("call_B");
		expect(starts[1].function?.name).toBe("tool_b");

		// Argument deltas use the wire index, not the contentIndex.
		const argDeltas = toolDeltas.filter(t => typeof t.function?.arguments === "string" && !t.id);
		expect(argDeltas.map(d => [d.index, d.function?.arguments])).toEqual([
			[0, '{"a":'],
			[0, "1}"],
			[1, "{}"],
		]);

		// Penultimate chunk carries finish_reason.
		const finishChunk = chunks[chunks.length - 1];
		expect(finishChunk.choices[0].delta).toEqual({});
		expect(finishChunk.choices[0].finish_reason).toBe("tool_calls");
	});

	it("buffers unclassified Responses thinking until final provenance while summaries remain live", async () => {
		const unclassified = {
			...emptyAssistant(),
			api: "openai-responses" as const,
			content: [{ type: "thinking" as const, thinking: RAW_SENTINEL }],
		};
		const finalized = {
			...unclassified,
			content: [
				{
					type: "thinking" as const,
					thinking: RAW_SENTINEL,
					provenance: "raw" as const,
					rawText: RAW_SENTINEL,
				},
			],
		};
		const events: AssistantMessageEvent[] = [
			{ type: "thinking_start", contentIndex: 0, partial: unclassified },
			{ type: "thinking_delta", contentIndex: 0, delta: RAW_SENTINEL, partial: unclassified },
			{ type: "reasoning_summary_delta", contentIndex: 0, delta: SUMMARY_SENTINEL, partial: unclassified },
			{ type: "thinking_end", contentIndex: 0, content: RAW_SENTINEL, partial: finalized },
			{ type: "done", reason: "stop", message: finalized },
		];

		const payloads = (await collectStream(encodeStream(makeEventStream(events, finalized), "gpt-test"))).map(
			parseSseLine,
		);
		const bytes = JSON.stringify(payloads);
		const reasoningDeltas = (
			payloads.slice(0, -1) as Array<{ choices: Array<{ delta: { reasoning_content?: string } }> }>
		)
			.map(chunk => chunk.choices[0]?.delta.reasoning_content)
			.filter((delta): delta is string => typeof delta === "string");

		expect(bytes).not.toContain(RAW_SENTINEL);
		expect(reasoningDeltas).toEqual([SUMMARY_SENTINEL]);
	});

	it("emits only provider-displayable summary reasoning through reasoning_content", async () => {
		const partial = emptyAssistant();
		partial.content = [
			{
				type: "thinking",
				thinking: SUMMARY_SENTINEL,
				provenance: "mixed",
				summaryText: SUMMARY_SENTINEL,
				rawText: RAW_SENTINEL,
			},
		];
		const events: AssistantMessageEvent[] = [
			{ type: "reasoning_summary_start", contentIndex: 0, partial },
			{ type: "reasoning_summary_delta", contentIndex: 0, delta: SUMMARY_SENTINEL, partial },
			{ type: "reasoning_summary_end", contentIndex: 0, content: SUMMARY_SENTINEL, partial },
			{ type: "thinking_delta", contentIndex: 0, delta: RAW_SENTINEL, partial },
			{ type: "thinking_end", contentIndex: 0, content: RAW_SENTINEL, partial },
			{ type: "done", reason: "stop", message: partial },
		];

		const payloads = (await collectStream(encodeStream(makeEventStream(events, partial), "gpt-test"))).map(
			parseSseLine,
		);
		const bytes = JSON.stringify(payloads);
		const chunks = payloads.slice(0, -1) as Array<{
			choices: Array<{ delta: { reasoning_content?: string } }>;
		}>;
		const reasoningDeltas = chunks
			.map(chunk => chunk.choices[0]?.delta.reasoning_content)
			.filter((delta): delta is string => typeof delta === "string");

		expect(bytes).not.toContain(RAW_SENTINEL);
		expect(reasoningDeltas).toEqual([SUMMARY_SENTINEL]);
	});

	it("emits a final-only summary through reasoning_content once", async () => {
		const partial = emptyAssistant();
		const events: AssistantMessageEvent[] = [
			{ type: "reasoning_summary_start", contentIndex: 0, partial },
			{ type: "reasoning_summary_end", contentIndex: 0, content: "FINAL SUMMARY", partial },
			{ type: "done", reason: "stop", message: partial },
		];

		const payloads = (await collectStream(encodeStream(makeEventStream(events, partial), "gpt-test"))).map(
			parseSseLine,
		);
		const chunks = payloads.slice(0, -1) as Array<{
			choices: Array<{ delta: { reasoning_content?: string } }>;
		}>;
		const reasoningDeltas = chunks
			.map(chunk => chunk.choices[0]?.delta.reasoning_content)
			.filter((delta): delta is string => typeof delta === "string");

		expect(reasoningDeltas).toEqual(["FINAL SUMMARY"]);
	});

	it("emits final summary content after a separator-only summary delta", async () => {
		const partial = emptyAssistant();
		const events: AssistantMessageEvent[] = [
			{ type: "reasoning_summary_start", contentIndex: 0, partial },
			{ type: "reasoning_summary_delta", contentIndex: 0, delta: "\n\n", partial },
			{ type: "reasoning_summary_end", contentIndex: 0, content: "REAL SUMMARY", partial },
			{ type: "done", reason: "stop", message: partial },
		];

		const payloads = (await collectStream(encodeStream(makeEventStream(events, partial), "gpt-test"))).map(
			parseSseLine,
		);
		const chunks = payloads.slice(0, -1) as Array<{
			choices: Array<{ delta: { reasoning_content?: string } }>;
		}>;
		const reasoningDeltas = chunks
			.map(chunk => chunk.choices[0]?.delta.reasoning_content)
			.filter((delta): delta is string => typeof delta === "string");

		expect(reasoningDeltas).toContain("REAL SUMMARY");
	});

	it("does not repeat a streamed summary at summary end", async () => {
		const partial = emptyAssistant();
		const events: AssistantMessageEvent[] = [
			{ type: "reasoning_summary_start", contentIndex: 0, partial },
			{ type: "reasoning_summary_delta", contentIndex: 0, delta: "X", partial },
			{ type: "reasoning_summary_end", contentIndex: 0, content: "X", partial },
			{ type: "done", reason: "stop", message: partial },
		];

		const payloads = (await collectStream(encodeStream(makeEventStream(events, partial), "gpt-test"))).map(
			parseSseLine,
		);
		const chunks = payloads.slice(0, -1) as Array<{
			choices: Array<{ delta: { reasoning_content?: string } }>;
		}>;
		const reasoningDeltas = chunks
			.map(chunk => chunk.choices[0]?.delta.reasoning_content)
			.filter((delta): delta is string => typeof delta === "string");

		expect(reasoningDeltas).toEqual(["X"]);
	});

	it("drops unprovenanced Codex thinking when the stream is interrupted", async () => {
		const partial: AssistantMessage = {
			...emptyAssistant(),
			api: "openai-codex-responses",
			provider: "openai-codex",
			content: [{ type: "thinking", thinking: RAW_SENTINEL }],
		};
		const error: AssistantMessage = { ...partial, errorMessage: "upstream went away" };
		const events: AssistantMessageEvent[] = [
			{ type: "thinking_start", contentIndex: 0, partial },
			{ type: "thinking_delta", contentIndex: 0, delta: RAW_SENTINEL, partial },
			{ type: "error", reason: "error", error },
		];

		const payloads = (await collectStream(encodeStream(makeEventStream(events, partial), "gpt-test"))).map(
			parseSseLine,
		);
		const bytes = JSON.stringify(payloads);

		expect(bytes).not.toContain(RAW_SENTINEL);
		expect(payloads).toContainEqual({ error: { message: "upstream went away", type: "upstream_error" } });
	});
	it("emits an error envelope when the stream errors", async () => {
		const partial = emptyAssistant();
		const errorMessage: AssistantMessage = { ...partial, errorMessage: "upstream went away" };
		const events: AssistantMessageEvent[] = [{ type: "error", reason: "error", error: errorMessage }];
		const stream = encodeStream(makeEventStream(events, partial), "gpt-test");
		const lines = await collectStream(stream);
		expect(lines).toHaveLength(2); // role chunk + error envelope
		const payloads = lines.map(parseSseLine) as Array<Record<string, unknown>>;
		expect(payloads[1]).toEqual({ error: { message: "upstream went away", type: "upstream_error" } });
	});
});
