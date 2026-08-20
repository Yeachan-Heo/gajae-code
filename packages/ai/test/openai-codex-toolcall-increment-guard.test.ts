import { afterEach, describe, expect, it, vi } from "bun:test";
import * as utils from "@gajae-code/utils";
import { getAgentDir, setAgentDir, TempDir } from "@gajae-code/utils";
import { streamOpenAICodexResponses } from "../src/providers/openai-codex-responses";
import type { Context, Model, ToolCall } from "../src/types";

// Review follow-up for the primitive-increment degradation (PR #4612):
// every non-string tool-argument increment on the Codex Responses stream must
// fail the turn closed instead of being silently erased to "". Primitive
// prose/reasoning anomalies still degrade with a bounded diagnostic.

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

	it("uses one captured function_call arguments delta value", async () => {
		setAgentDir(TempDir.createSync("@pi-codex-increment-").path());
		const parse = JSON.parse;
		let reads = 0;
		JSON.parse = ((source: string, reviver?: (key: string, value: unknown) => unknown) => {
			const value = parse(source, reviver) as Record<string, unknown>;
			if (value.type === "response.function_call_arguments.delta" && value.delta === "__getter__") {
				Object.defineProperty(value, "delta", {
					enumerable: true,
					get() {
						reads += 1;
						return reads <= 2 ? '{"safe":true}' : { injected: true };
					},
				});
			}
			return value;
		}) as typeof JSON.parse;
		try {
			mockFetchOnce(
				sse([
					{
						type: "response.output_item.added",
						item: { type: "function_call", id: "fc_getter", call_id: "call_getter", name: "run", arguments: "" },
					},
					{ type: "response.function_call_arguments.delta", delta: "__getter__" },
					{
						type: "response.output_item.done",
						item: {
							type: "function_call",
							id: "fc_getter",
							call_id: "call_getter",
							name: "run",
							arguments: '{"safe":true}',
						},
					},
					{ type: "response.completed", response: { status: "completed", usage: USAGE } },
				]),
			);
			const result = await streamOpenAICodexResponses(model(), context(), { apiKey: token() }).result();
			expect(result.stopReason).toBe("toolUse");
			expect(reads).toBe(2);
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

	it("fails closed on non-string initial custom-tool input", async () => {
		setAgentDir(TempDir.createSync("@pi-codex-increment-").path());
		mockFetchOnce(
			sse([
				{
					type: "response.output_item.added",
					item: {
						type: "custom_tool_call",
						id: "ct_initial",
						call_id: "call_initial",
						name: "deploy",
						input: ["unsafe"],
					},
				},
				{ type: "response.custom_tool_call_input.delta", delta: "" },
				{ type: "response.completed", response: { status: "completed", usage: USAGE } },
			]),
		);
		const result = await streamOpenAICodexResponses(model(), context(), { apiKey: token() }).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage ?? "").toMatch(/non-string input/i);
	});

	it("uses one captured initial custom-tool input value", async () => {
		setAgentDir(TempDir.createSync("@pi-codex-increment-").path());
		const parse = JSON.parse;
		let reads = 0;
		JSON.parse = ((source: string, reviver?: (key: string, value: unknown) => unknown) => {
			const value = parse(source, reviver) as Record<string, unknown>;
			const item = value.item as Record<string, unknown> | undefined;
			if (value.type === "response.output_item.added" && item?.input === "__getter__") {
				Object.defineProperty(item, "input", {
					enumerable: true,
					get() {
						reads += 1;
						return reads <= 2 ? "exact" : ["unsafe"];
					},
				});
			}
			return value;
		}) as typeof JSON.parse;
		try {
			mockFetchOnce(
				sse([
					{
						type: "response.output_item.added",
						item: {
							type: "custom_tool_call",
							id: "ct_getter",
							call_id: "call_getter",
							name: "deploy",
							input: "__getter__",
						},
					},
					{
						type: "response.output_item.done",
						item: {
							type: "custom_tool_call",
							id: "ct_getter",
							call_id: "call_getter",
							name: "deploy",
							input: "exact",
						},
					},
					{ type: "response.completed", response: { status: "completed", usage: USAGE } },
				]),
			);
			const result = await streamOpenAICodexResponses(model(), context(), { apiKey: token() }).result();
			expect(result.stopReason).toBe("toolUse");
			expect(reads).toBe(1);
		} finally {
			JSON.parse = parse;
		}
	});

	it("fails closed when a completed custom tool lacks output_item.done", async () => {
		setAgentDir(TempDir.createSync("@pi-codex-increment-").path());
		mockFetchOnce(
			sse([
				{
					type: "response.output_item.added",
					item: {
						type: "custom_tool_call",
						id: "ct_unfinalized",
						call_id: "call_unfinalized",
						name: "deploy",
						input: "",
					},
				},
				{ type: "response.custom_tool_call_input.done", input: "unsafe" },
				{ type: "response.completed", response: { status: "completed", usage: USAGE } },
			]),
		);
		const result = await streamOpenAICodexResponses(model(), context(), { apiKey: token() }).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage ?? "").toMatch(/unfinalized tool call/i);
	});

	it("removes internal custom-tool fields from truncated successful output", async () => {
		setAgentDir(TempDir.createSync("@pi-codex-increment-").path());
		mockFetchOnce(
			sse([
				{
					type: "response.output_item.added",
					item: {
						type: "custom_tool_call",
						id: "ct_truncated",
						call_id: "call_truncated",
						name: "deploy",
						input: "",
					},
				},
				{ type: "response.custom_tool_call_input.delta", delta: "partial" },
				{ type: "response.incomplete", response: { status: "incomplete", usage: USAGE } },
			]),
		);
		const result = await streamOpenAICodexResponses(model(), context(), { apiKey: token() }).result();
		expect(result.stopReason).toBe("length");
		const tools = result.content.filter((block): block is ToolCall => block.type === "toolCall");
		expect(tools[0]).not.toHaveProperty("partialJson");
		expect(tools[0]).not.toHaveProperty("doneInput");
	});

	it("fails the turn closed when a function_call arguments delta is a primitive (valid-but-wrong assembly)", async () => {
		setAgentDir(TempDir.createSync("@pi-codex-increment-").path());
		vi.spyOn(utils.logger, "warn").mockImplementation(() => {});
		// `{"n":1` + numeric primitive + `3}` would assemble as {"n":13} if the
		// primitive were erased — a silently different tool call. Terminal
		// `item.arguments` must not launder a corrupted delta stream either.
		mockFetchOnce(
			sse([
				{
					type: "response.output_item.added",
					output_index: 0,
					item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "run_job", arguments: "" },
				},
				{ type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: '{"n":1' },
				{ type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: 2 },
				{ type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: "3}" },
				{
					type: "response.output_item.done",
					output_index: 0,
					item: {
						type: "function_call",
						id: "fc_1",
						call_id: "call_1",
						name: "run_job",
						arguments: '{"n":13}',
					},
				},
				{ type: "response.completed", response: { status: "completed", usage: USAGE } },
			]),
		);

		const result = await streamOpenAICodexResponses(model(), context(), { apiKey: token() }).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage ?? "").toMatch(/non-string response\.function_call_arguments\.delta/i);
	});

	it("finalizes a custom_tool_call from terminal input and fails closed on a buffer mismatch", async () => {
		setAgentDir(TempDir.createSync("@pi-codex-increment-").path());
		vi.spyOn(utils.logger, "warn").mockImplementation(() => {});
		// Streamed buffer assembles "corrupt" while terminal item.input says
		// "authoritative": the mismatch must fail the turn instead of executing
		// either variant.
		mockFetchOnce(
			sse([
				{
					type: "response.output_item.added",
					output_index: 0,
					item: { type: "custom_tool_call", id: "ct_1", call_id: "call_ct", name: "deploy", input: "" },
				},
				{ type: "response.custom_tool_call_input.delta", item_id: "ct_1", output_index: 0, delta: "corru" },
				{ type: "response.custom_tool_call_input.delta", item_id: "ct_1", output_index: 0, delta: "pt" },
				{
					type: "response.output_item.done",
					output_index: 0,
					item: {
						type: "custom_tool_call",
						id: "ct_1",
						call_id: "call_ct",
						name: "deploy",
						input: "authoritative",
					},
				},
				{ type: "response.completed", response: { status: "completed", usage: USAGE } },
			]),
		);

		const result = await streamOpenAICodexResponses(model(), context(), { apiKey: token() }).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage ?? "").toMatch(/terminal input disagrees with the streamed input buffer/i);
	});

	it("does not let custom_tool_call_input.done erase a streamed buffer mismatch", async () => {
		setAgentDir(TempDir.createSync("@pi-codex-increment-").path());
		mockFetchOnce(
			sse([
				{
					type: "response.output_item.added",
					item: { type: "custom_tool_call", id: "ct_done", call_id: "call_done", name: "deploy", input: "" },
				},
				{ type: "response.custom_tool_call_input.delta", delta: "corrupt" },
				{ type: "response.custom_tool_call_input.done", input: "authoritative" },
				{
					type: "response.output_item.done",
					item: {
						type: "custom_tool_call",
						id: "ct_done",
						call_id: "call_done",
						name: "deploy",
						input: "authoritative",
					},
				},
				{ type: "response.completed", response: { status: "completed", usage: USAGE } },
			]),
		);
		const result = await streamOpenAICodexResponses(model(), context(), { apiKey: token() }).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage ?? "").toMatch(/disagrees with the streamed input buffer/i);
	});

	it("retains done-only custom input and rejects terminal disagreement", async () => {
		setAgentDir(TempDir.createSync("@pi-codex-increment-").path());
		mockFetchOnce(
			sse([
				{
					type: "response.output_item.added",
					item: {
						type: "custom_tool_call",
						id: "ct_done_only",
						call_id: "call_done_only",
						name: "deploy",
						input: "",
					},
				},
				{ type: "response.custom_tool_call_input.done", input: "exact" },
				{
					type: "response.output_item.done",
					item: {
						type: "custom_tool_call",
						id: "ct_done_only",
						call_id: "call_done_only",
						name: "deploy",
						input: "exact",
					},
				},
				{ type: "response.completed", response: { status: "completed", usage: USAGE } },
			]),
		);
		const valid = await streamOpenAICodexResponses(model(), context(), { apiKey: token() }).result();
		expect(valid.stopReason).toBe("toolUse");
		const tools = valid.content.filter((block): block is ToolCall => block.type === "toolCall");
		expect(tools[0]?.arguments).toEqual({ input: "exact" });
		expect(tools[0]).not.toHaveProperty("partialJson");
		expect(tools[0]).not.toHaveProperty("doneInput");

		mockFetchOnce(
			sse([
				{
					type: "response.output_item.added",
					item: {
						type: "custom_tool_call",
						id: "ct_conflict",
						call_id: "call_conflict",
						name: "deploy",
						input: "",
					},
				},
				{ type: "response.custom_tool_call_input.done", input: "safe" },
				{
					type: "response.output_item.done",
					item: {
						type: "custom_tool_call",
						id: "ct_conflict",
						call_id: "call_conflict",
						name: "deploy",
						input: "dangerous",
					},
				},
				{ type: "response.completed", response: { status: "completed", usage: USAGE } },
			]),
		);
		const conflict = await streamOpenAICodexResponses(model(), context(), { apiKey: token() }).result();
		expect(conflict.stopReason).toBe("error");
		expect(conflict.errorMessage ?? "").toMatch(/input\.done|terminal input/i);
		const conflictTools = conflict.content.filter((block): block is ToolCall => block.type === "toolCall");
		expect(conflictTools[0]).not.toHaveProperty("partialJson");
		expect(conflictTools[0]).not.toHaveProperty("doneInput");
	});

	it("fails closed on non-string custom_tool_call_input.done", async () => {
		setAgentDir(TempDir.createSync("@pi-codex-increment-").path());
		mockFetchOnce(
			sse([
				{
					type: "response.output_item.added",
					item: {
						type: "custom_tool_call",
						id: "ct_bad_done",
						call_id: "call_bad_done",
						name: "deploy",
						input: "",
					},
				},
				{ type: "response.custom_tool_call_input.done", input: 42 },
				{ type: "response.completed", response: { status: "completed", usage: USAGE } },
			]),
		);
		const result = await streamOpenAICodexResponses(model(), context(), { apiKey: token() }).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage ?? "").toMatch(/non-string.*input\.done/i);
	});

	it("finalizes a custom_tool_call from matching terminal input without error", async () => {
		setAgentDir(TempDir.createSync("@pi-codex-increment-").path());
		vi.spyOn(utils.logger, "warn").mockImplementation(() => {});
		mockFetchOnce(
			sse([
				{
					type: "response.output_item.added",
					output_index: 0,
					item: { type: "custom_tool_call", id: "ct_2", call_id: "call_ct2", name: "deploy", input: "" },
				},
				{ type: "response.custom_tool_call_input.delta", item_id: "ct_2", output_index: 0, delta: "exact" },
				{
					type: "response.output_item.done",
					output_index: 0,
					item: { type: "custom_tool_call", id: "ct_2", call_id: "call_ct2", name: "deploy", input: "exact" },
				},
				{ type: "response.completed", response: { status: "completed", usage: USAGE } },
			]),
		);

		const result = await streamOpenAICodexResponses(model(), context(), { apiKey: token() }).result();
		expect(result.stopReason).toBe("toolUse");
		const tools = result.content.filter((b): b is ToolCall => b.type === "toolCall");
		expect(tools).toHaveLength(1);
		expect(tools[0].arguments).toEqual({ input: "exact" });
	});

	it("commits terminal function identity and arguments to stored output", async () => {
		setAgentDir(TempDir.createSync("@pi-codex-increment-").path());
		mockFetchOnce(
			sse([
				{
					type: "response.output_item.added",
					item: {
						type: "function_call",
						id: "fc_authority",
						call_id: "call_authority",
						name: "run_job",
						arguments: "",
					},
				},
				{ type: "response.function_call_arguments.delta", delta: '{"n":1}' },
				{
					type: "response.output_item.done",
					item: {
						type: "function_call",
						id: "fc_authority",
						call_id: "call_authority",
						name: "run_job",
						arguments: '{"n":1}',
					},
				},
				{ type: "response.completed", response: { status: "completed", usage: USAGE } },
			]),
		);
		const result = await streamOpenAICodexResponses(model(), context(), { apiKey: token() }).result();
		const tools = result.content.filter((block): block is ToolCall => block.type === "toolCall");
		expect(tools).toEqual([
			{ type: "toolCall", id: "call_authority|fc_authority", name: "run_job", arguments: { n: 1 } },
		]);
	});

	it("fails closed on non-string terminal function arguments", async () => {
		for (const terminalArguments of [undefined, 0, false, null, ["unsafe"], { unsafe: true }]) {
			setAgentDir(TempDir.createSync("@pi-codex-increment-").path());
			mockFetchOnce(
				sse([
					{
						type: "response.output_item.done",
						output_index: 0,
						item: {
							type: "function_call",
							id: "fc_terminal",
							call_id: "call_terminal",
							name: "run_job",
							arguments: terminalArguments,
						},
					},
					{ type: "response.completed", response: { status: "completed", usage: USAGE } },
				]),
			);

			const result = await streamOpenAICodexResponses(model(), context(), { apiKey: token() }).result();
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage ?? "").toMatch(/non-string terminal arguments/i);
		}
	});

	it("fails closed on malformed string terminal function arguments", async () => {
		setAgentDir(TempDir.createSync("@pi-codex-increment-").path());
		mockFetchOnce(
			sse([
				{
					type: "response.output_item.added",
					item: {
						type: "function_call",
						id: "fc_malformed",
						call_id: "call_malformed",
						name: "run",
						arguments: "",
					},
				},
				{
					type: "response.output_item.done",
					item: {
						type: "function_call",
						id: "fc_malformed",
						call_id: "call_malformed",
						name: "run",
						arguments: '{"command":"dangerous"',
					},
				},
				{ type: "response.completed", response: { status: "completed", usage: USAGE } },
			]),
		);
		const result = await streamOpenAICodexResponses(model(), context(), { apiKey: token() }).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage ?? "").toMatch(/malformed terminal arguments/i);
		expect(result.errorMessage ?? "").not.toContain("dangerous");
	});

	it("fails closed on empty terminal function arguments", async () => {
		setAgentDir(TempDir.createSync("@pi-codex-increment-").path());
		mockFetchOnce(
			sse([
				{
					type: "response.output_item.added",
					item: { type: "function_call", id: "fc_empty", call_id: "call_empty", name: "run", arguments: "" },
				},
				{
					type: "response.output_item.done",
					item: { type: "function_call", id: "fc_empty", call_id: "call_empty", name: "run", arguments: "" },
				},
				{ type: "response.completed", response: { status: "completed", usage: USAGE } },
			]),
		);
		const result = await streamOpenAICodexResponses(model(), context(), { apiKey: token() }).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage ?? "").toMatch(/malformed terminal arguments/i);
	});

	it("fails closed on non-string terminal custom-tool input", async () => {
		for (const terminalInput of [undefined, 0, false, null, ["unsafe"], { unsafe: true }]) {
			setAgentDir(TempDir.createSync("@pi-codex-increment-").path());
			mockFetchOnce(
				sse([
					{
						type: "response.output_item.done",
						output_index: 0,
						item: {
							type: "custom_tool_call",
							id: "ct_terminal",
							call_id: "call_terminal",
							name: "deploy",
							input: terminalInput,
						},
					},
					{ type: "response.completed", response: { status: "completed", usage: USAGE } },
				]),
			);

			const result = await streamOpenAICodexResponses(model(), context(), { apiKey: token() }).result();
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage ?? "").toMatch(/non-string terminal input/i);
		}
	});
});
