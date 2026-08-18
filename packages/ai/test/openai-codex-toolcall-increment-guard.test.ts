import { afterEach, describe, expect, it, vi } from "bun:test";
import * as utils from "@gajae-code/utils";
import { getAgentDir, setAgentDir, TempDir } from "@gajae-code/utils";
import { streamOpenAICodexResponses } from "../src/providers/openai-codex-responses";
import type { Context, Model, ToolCall } from "../src/types";

// Review follow-up for the primitive-increment degradation (PR #4612):
// object-shaped tool-argument increments on the Codex Responses stream must
// fail the turn closed instead of being silently erased to "". Primitive
// anomalies still degrade to an empty string with a bounded diagnostic.

const originalFetch = global.fetch;
const originalAgentDir = getAgentDir();
afterEach(() => {
	global.fetch = originalFetch;
	setAgentDir(originalAgentDir);
	vi.restoreAllMocks();
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

describe("openai-codex: tool-argument increment guard", () => {
	it("fails the turn closed when a function_call arguments delta is object-shaped", async () => {
		setAgentDir(TempDir.createSync("@pi-codex-increment-").path());
		vi.spyOn(utils.logger, "warn").mockImplementation(() => {});
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
					delta: { path: "a.ts", content: "injected object increment" },
				},
				{ type: "response.completed", response: { status: "completed", usage: USAGE } },
			]),
		);

		const result = await streamOpenAICodexResponses(model(), context(), {
			apiKey: token(),
			streamMaxRetries: 0,
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage ?? "").toMatch(/tool-argument|arguments.delta/i);
		expect(result.errorMessage ?? "").not.toContain("injected object increment");
	});

	it("fails the turn closed when a function_call arguments delta is function-shaped", async () => {
		setAgentDir(TempDir.createSync("@pi-codex-increment-").path());
		vi.spyOn(utils.logger, "warn").mockImplementation(() => {});
		const parse = JSON.parse;
		const fnIncrement = () => '{"path":"a.ts"}';
		JSON.parse = ((source: string, reviver?: (key: string, value: unknown) => unknown) => {
			const value = parse(source, reviver) as Record<string, unknown>;
			if (value.type === "response.function_call_arguments.delta" && value.delta === "__fn__") {
				value.delta = fnIncrement;
			}
			return value;
		}) as typeof JSON.parse;
		try {
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
						delta: "__fn__",
					},
					{ type: "response.completed", response: { status: "completed", usage: USAGE } },
				]),
			);

			const result = await streamOpenAICodexResponses(model(), context(), {
				apiKey: token(),
				streamMaxRetries: 0,
			}).result();
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage ?? "").toMatch(/tool-argument|arguments.delta/i);
			expect(result.errorMessage ?? "").not.toContain("a.ts");
		} finally {
			JSON.parse = parse;
		}
	});

	it("fails the turn closed when a custom_tool_call input delta is object-shaped", async () => {
		setAgentDir(TempDir.createSync("@pi-codex-increment-").path());
		vi.spyOn(utils.logger, "warn").mockImplementation(() => {});
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
					delta: { patch: "injected object increment" },
				},
				{ type: "response.completed", response: { status: "completed", usage: USAGE } },
			]),
		);

		const result = await streamOpenAICodexResponses(model(), context(), {
			apiKey: token(),
			streamMaxRetries: 0,
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage ?? "").toMatch(/tool-argument|custom_tool_call_input.delta/i);
	});

	it("degrades primitive function_call argument anomalies with one bounded warning", async () => {
		setAgentDir(TempDir.createSync("@pi-codex-increment-").path());
		const warnSpy = vi.spyOn(utils.logger, "warn").mockImplementation(() => {});
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
					delta: '{"path":',
				},
				// Two primitive anomalies on one stream: number, then missing delta.
				{ type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: 42 },
				{ type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0 },
				{
					type: "response.function_call_arguments.delta",
					item_id: "fc_1",
					output_index: 0,
					delta: '"a.ts"}',
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
		expect(result.stopReason).toBe("toolUse");
		const tools = result.content.filter((b): b is ToolCall => b.type === "toolCall");
		expect(tools).toHaveLength(1);
		expect(tools[0].arguments).toEqual({ path: "a.ts" });

		const degradeWarns = warnSpy.mock.calls.filter(
			([message]) => typeof message === "string" && message.includes("degraded non-string stream increment"),
		);
		expect(degradeWarns).toHaveLength(1);
		const metadata = degradeWarns[0]?.[1] as Record<string, unknown>;
		expect(metadata).toHaveProperty("model");
		expect(metadata).toHaveProperty("provider");
		expect(metadata).toHaveProperty("eventType", "response.function_call_arguments.delta");
		expect(JSON.stringify(metadata)).not.toContain("a.ts");
	});
});
