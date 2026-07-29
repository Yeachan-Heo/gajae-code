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
	messages: [{ role: "user", content: "Write the file", timestamp: Date.now() }],
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

async function run(
	argumentsValue: Record<string, unknown> | string,
	doneReason?: "length" | "tool_calls",
): Promise<AssistantMessage> {
	return runChunks([
		{
			message: {
				role: "assistant",
				content: "",
				tool_calls: [{ function: { name: "write_file", arguments: argumentsValue } }],
			},
			done: false,
		},
		{ done: true, done_reason: doneReason, prompt_eval_count: 5, eval_count: 9 },
	]);
}

function firstTool(message: AssistantMessage): ToolCall | undefined {
	return message.content.find((block): block is ToolCall => block.type === "toolCall");
}

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("Ollama truncated tool calls", () => {
	it("flags an incomplete string argument buffer on a length stop", async () => {
		const result = await run('{"path":"a.ts","content":"line1', "length");
		const tool = firstTool(result);

		expect(result.stopReason).toBe("length");
		expect(tool?.incompleteArguments).toBe(true);
		expect(tool && "partialJson" in tool).toBe(false);
	});

	it("does not flag a complete argument buffer on a length stop", async () => {
		const result = await run('{"path":"a.ts"}', "length");

		expect(firstTool(result)?.incompleteArguments).toBeFalsy();
	});

	it("fails closed for object-shaped arguments on a length stop", async () => {
		const result = await run({ path: "a.ts" }, "length");

		expect(result.stopReason).toBe("length");
		expect(firstTool(result)?.incompleteArguments).toBe(true);
	});

	it("fails closed for absent arguments on a length stop", async () => {
		const result = await runChunks([
			{
				message: { role: "assistant", content: "", tool_calls: [{ function: { name: "no_args" } }] },
				done: false,
			},
			{ done: true, done_reason: "length" },
		]);

		expect(firstTool(result)?.incompleteArguments).toBe(true);
	});

	it("fails closed for null arguments on a length stop", async () => {
		const result = await runChunks([
			{
				message: {
					role: "assistant",
					content: "",
					tool_calls: [{ function: { name: "no_args", arguments: null } }],
				},
				done: false,
			},
			{ done: true, done_reason: "length" },
		]);

		expect(firstTool(result)?.incompleteArguments).toBe(true);
	});

	it("does not flag object-shaped arguments on an explicit tool-use stop", async () => {
		const result = await run({ path: "a.ts" }, "tool_calls");

		expect(firstTool(result)?.incompleteArguments).toBeFalsy();
	});

	it("removes the private buffer for an empty no-argument string call", async () => {
		const result = await run("", "tool_calls");
		const tool = firstTool(result);

		expect(tool?.incompleteArguments).toBeFalsy();
		expect(tool && "partialJson" in tool).toBe(false);
	});

	it("does not flag an incomplete buffer when the stop reason is tool use", async () => {
		const result = await run('{"path":"a.ts","content":"line1', "tool_calls");

		expect(result.stopReason).toBe("toolUse");
		expect(firstTool(result)?.incompleteArguments).toBeFalsy();
	});

	it("flags an incomplete string buffer when the terminal reason is omitted", async () => {
		const result = await run('{"path":"a.ts","content":"line1');

		expect(result.stopReason).toBe("toolUse");
		expect(firstTool(result)?.incompleteArguments).toBe(true);
	});

	it("accepts a complete string buffer when the terminal reason is omitted", async () => {
		const result = await run('{"path":"a.ts"}');

		expect(result.stopReason).toBe("toolUse");
		expect(firstTool(result)?.incompleteArguments).toBeFalsy();
	});

	it("fails closed when the stream ends before a terminal done chunk", async () => {
		const result = await runChunks([
			{
				message: {
					role: "assistant",
					content: "",
					tool_calls: [{ function: { name: "write_file", arguments: '{"path":"a.ts","content":"line1' } }],
				},
				done: false,
			},
		]);
		const tool = firstTool(result);

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("ended before terminal done chunk");
		expect(tool && "partialJson" in tool).toBe(false);
	});

	it("ignores tool-call chunks after the terminal done chunk", async () => {
		const result = await runChunks([
			{ message: { role: "assistant", content: "done" }, done: true, done_reason: "stop" },
			{
				message: {
					role: "assistant",
					content: "",
					tool_calls: [{ function: { name: "late_tool", arguments: '{"path":"late.ts"}' } }],
				},
				done: false,
			},
		]);

		expect(result.stopReason).toBe("stop");
		expect(firstTool(result)).toBeUndefined();
	});
});
