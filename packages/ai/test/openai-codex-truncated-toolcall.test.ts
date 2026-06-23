import { afterEach, describe, expect, it } from "bun:test";
import { streamOpenAICodexResponses } from "@gajae-code/ai/providers/openai-codex-responses";
import type { Context, Model, ToolCall } from "@gajae-code/ai/types";
import { getAgentDir, setAgentDir, TempDir } from "@gajae-code/utils";

// The Codex Responses provider has its own stream handlers; the truncated
// tool-call guard must cover it too. A `function_call` that never receives its
// `output_item.done` before a length-truncated completion must be flagged.

const originalFetch = global.fetch;
const originalAgentDir = getAgentDir();
afterEach(() => {
	global.fetch = originalFetch;
	setAgentDir(originalAgentDir);
});

function token(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toBase64();
	return `aaa.${payload}.bbb`;
}

function model(): Model<"openai-codex-responses"> {
	return {
		id: "gpt-5.3-codex-spark",
		name: "Codex",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		preferWebsockets: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 128000,
	};
}

function context(): Context {
	return { systemPrompt: ["You are helpful."], messages: [{ role: "user", content: "go", timestamp: Date.now() }] };
}

function sse(events: unknown[]): string {
	return `${events.map(e => `data: ${JSON.stringify(e)}`).join("\n\n")}\n\n`;
}

function mockFetchOnce(body: string): void {
	const fn = async (): Promise<Response> =>
		new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	global.fetch = Object.assign(fn, { preconnect: originalFetch.preconnect });
}

const USAGE = { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } };

describe("openai-codex: truncated tool-call detection", () => {
	it("flags a function call cut off before output_item.done (status incomplete)", async () => {
		setAgentDir(TempDir.createSync("@pi-codex-trunc-").path());
		mockFetchOnce(
			sse([
				{
					type: "response.output_item.added",
					output_index: 0,
					item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "write_file", arguments: "" },
				},
				{
					type: "response.function_call_arguments.delta",
					item_id: "fc_1",
					output_index: 0,
					delta: '{"path":"a.ts","content":"partial',
				},
				{ type: "response.incomplete", response: { status: "incomplete", usage: USAGE } },
			]),
		);

		const result = await streamOpenAICodexResponses(model(), context(), { apiKey: token() }).result();
		expect(result.stopReason).toBe("length");
		const tools = result.content.filter((b): b is ToolCall => b.type === "toolCall");
		expect(tools).toHaveLength(1);
		expect(tools[0].name).toBe("write_file");
		expect(tools[0].incompleteArguments).toBe(true);
	});

	it("does NOT flag a completed function call", async () => {
		setAgentDir(TempDir.createSync("@pi-codex-trunc-").path());
		mockFetchOnce(
			sse([
				{
					type: "response.output_item.added",
					output_index: 0,
					item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: "" },
				},
				{
					type: "response.function_call_arguments.delta",
					item_id: "fc_1",
					output_index: 0,
					delta: '{"path":"a.ts"}',
				},
				{
					type: "response.function_call_arguments.done",
					item_id: "fc_1",
					output_index: 0,
					arguments: '{"path":"a.ts"}',
				},
				{
					type: "response.output_item.done",
					output_index: 0,
					item: {
						type: "function_call",
						id: "fc_1",
						call_id: "call_1",
						name: "read_file",
						arguments: '{"path":"a.ts"}',
					},
				},
				{ type: "response.completed", response: { status: "completed", usage: USAGE } },
			]),
		);

		const result = await streamOpenAICodexResponses(model(), context(), { apiKey: token() }).result();
		const tools = result.content.filter((b): b is ToolCall => b.type === "toolCall");
		expect(tools).toHaveLength(1);
		expect(tools[0].incompleteArguments).toBeFalsy();
	});

	it("flags a custom tool whose raw input was cut off; not a completed one", async () => {
		setAgentDir(TempDir.createSync("@pi-codex-trunc-").path());
		// Truncated custom tool.
		mockFetchOnce(
			sse([
				{
					type: "response.output_item.added",
					output_index: 0,
					item: { type: "custom_tool_call", id: "ct_1", call_id: "call_1", name: "apply_patch", input: "" },
				},
				{
					type: "response.custom_tool_call_input.delta",
					item_id: "ct_1",
					output_index: 0,
					delta: "*** Begin Patch\n+const x =",
				},
				{ type: "response.incomplete", response: { status: "incomplete", usage: USAGE } },
			]),
		);
		let result = await streamOpenAICodexResponses(model(), context(), { apiKey: token() }).result();
		let tools = result.content.filter((b): b is ToolCall => b.type === "toolCall");
		expect(tools[0].customWireName).toBe("apply_patch");
		expect(tools[0].incompleteArguments).toBe(true);

		// Completed custom tool on a truncated turn — must NOT be flagged.
		const fullPatch = "*** Begin Patch\n+const x = 1\n*** End Patch";
		mockFetchOnce(
			sse([
				{
					type: "response.output_item.added",
					output_index: 0,
					item: { type: "custom_tool_call", id: "ct_2", call_id: "call_2", name: "apply_patch", input: "" },
				},
				{ type: "response.custom_tool_call_input.delta", item_id: "ct_2", output_index: 0, delta: fullPatch },
				{ type: "response.custom_tool_call_input.done", item_id: "ct_2", output_index: 0, input: fullPatch },
				{
					type: "response.output_item.done",
					output_index: 0,
					item: { type: "custom_tool_call", id: "ct_2", call_id: "call_2", name: "apply_patch", input: fullPatch },
				},
				{ type: "response.incomplete", response: { status: "incomplete", usage: USAGE } },
			]),
		);
		result = await streamOpenAICodexResponses(model(), context(), { apiKey: token() }).result();
		tools = result.content.filter((b): b is ToolCall => b.type === "toolCall");
		expect(tools[0].incompleteArguments).toBeFalsy();
	});
});
