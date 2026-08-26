import { afterEach, describe, expect, it, vi } from "bun:test";
import { streamOllama } from "../src/providers/ollama";
import type { AssistantMessage, Context, Model, ToolCall } from "../src/types";

const originalFetch = global.fetch;

const model = {
	id: "qwen3:latest",
	name: "Qwen 3",
	api: "ollama-chat",
	provider: "ollama",
	baseUrl: "http://127.0.0.1:11434",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32_768,
	maxTokens: 8_192,
} satisfies Model<"ollama-chat">;

const context: Context = {
	messages: [{ role: "user", content: "Ask me something", timestamp: Date.now() }],
};

async function runChunks(chunks: unknown[]): Promise<AssistantMessage> {
	global.fetch = vi.fn(
		async () =>
			new Response(`${chunks.map(chunk => JSON.stringify(chunk)).join("\n")}\n`, {
				status: 200,
				headers: { "Content-Type": "application/x-ndjson" },
			}),
	) as unknown as typeof fetch;

	const stream = streamOllama(model, context, { apiKey: "test-key" });
	for await (const _event of stream) {
		// Drain the provider stream.
	}
	return stream.result();
}

async function run(argumentsValue: Record<string, unknown> | string): Promise<AssistantMessage> {
	return runChunks([
		{
			message: {
				role: "assistant",
				content: "",
				tool_calls: [{ function: { name: "ask", arguments: argumentsValue } }],
			},
			done: false,
		},
		{ done: true, done_reason: "tool_calls", prompt_eval_count: 5, eval_count: 9 },
	]);
}

function firstTool(message: AssistantMessage): ToolCall | undefined {
	return message.content.find((block): block is ToolCall => block.type === "toolCall");
}

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("Ollama ASCII-escaped non-ASCII tool arguments", () => {
	it("accepts a call whose arguments spell Hangul as \\uXXXX escapes", async () => {
		const result = await run(String.raw`{"question":"\ub9c8\uc9c0\ub9c9 \ubcd1\ubaa9"}`);
		const tool = firstTool(result);

		expect(tool?.arguments).toEqual({ question: "마지막 병목" });
		expect(tool?.escapedNonAsciiArguments).toBeUndefined();
		expect(tool?.escapedUnicodeArgumentEvidence).toBeUndefined();
		expect(tool && "partialJson" in tool).toBe(false);
	});

	it("accepts printable ASCII escapes", async () => {
		const result = await run(String.raw`{"question":"\u0077 \u0026"}`);
		const tool = firstTool(result);

		expect(tool?.arguments).toEqual({ question: "w &" });
		expect(tool?.escapedNonAsciiArguments).toBeUndefined();
		expect(tool?.escapedUnicodeArgumentEvidence).toBeUndefined();
	});

	it("does not flag literal UTF-8 arguments", async () => {
		const result = await run('{"question":"마지막 병목"}');

		expect(firstTool(result)?.escapedNonAsciiArguments).toBeUndefined();
	});

	it("does not flag an escaped backslash that is the written source text", async () => {
		const result = await run(String.raw`{"question":"if c == \\uac00:"}`);

		expect(firstTool(result)?.arguments).toEqual({ question: String.raw`if c == \uac00:` });
		expect(firstTool(result)?.escapedNonAsciiArguments).toBeUndefined();
	});

	it("does not flag ASCII-only arguments", async () => {
		const result = await run('{"question":"hello world"}');

		expect(firstTool(result)?.escapedNonAsciiArguments).toBeUndefined();
	});
});
