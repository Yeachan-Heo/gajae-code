import { describe, expect, test } from "bun:test";
import { buildOpenAiNativeHistory, requestOpenAiRemoteCompaction } from "@gajae-code/agent-core/compaction/openai";
import type { AssistantMessage, Model, ToolResultMessage } from "@gajae-code/ai/types";
import { hookFetch } from "@gajae-code/utils";

function setEnvForTest(key: string, value: string): () => void {
	const previous = Bun.env[key];
	Bun.env[key] = value;
	return () => {
		if (previous === undefined) {
			delete Bun.env[key];
		} else {
			Bun.env[key] = previous;
		}
	};
}

function makeOpenAiModel(overrides: Partial<Model<"openai-responses">> = {}): Model<"openai-responses"> {
	return {
		id: "gpt-5",
		name: "GPT-5",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
		...overrides,
	};
}

describe("buildOpenAiNativeHistory custom tool calls", () => {
	test("serializes customWireName tool calls as custom_tool_call + custom_tool_call_output", () => {
		const patch = "*** Begin Patch\n*** End Patch\n";
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_apply_1|ctc_apply_1",
					name: "edit",
					arguments: { input: patch },
					customWireName: "apply_patch",
				},
			],
			timestamp: Date.now(),
			provider: "openai",
			model: "gpt-5",
			api: "openai-responses",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
		};
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_apply_1|ctc_apply_1",
			toolName: "edit",
			content: [{ type: "text", text: "patch applied" }],
			isError: false,
			timestamp: Date.now(),
		};

		const items = buildOpenAiNativeHistory([assistant, toolResult], makeOpenAiModel());

		const call = items.find(item => item.type === "custom_tool_call");
		expect(call).toBeDefined();
		expect(call?.name).toBe("apply_patch");
		expect(call?.input).toBe(patch);
		expect(call?.call_id).toBe("call_apply_1");

		const output = items.find(item => item.type === "custom_tool_call_output");
		expect(output).toBeDefined();
		expect(output?.call_id).toBe("call_apply_1");
		expect(output?.output).toBe("patch applied");

		// Did NOT emit the legacy function_call / function_call_output pair.
		expect(items.find(item => item.type === "function_call")).toBeUndefined();
		expect(items.find(item => item.type === "function_call_output")).toBeUndefined();
	});

	test("continues to emit function_call for regular JSON tools", () => {
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_read_1|fc_read_1",
					name: "read_file",
					arguments: { path: "/tmp/x" },
				},
			],
			timestamp: Date.now(),
			provider: "openai",
			model: "gpt-5",
			api: "openai-responses",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
		};
		const items = buildOpenAiNativeHistory([assistant], makeOpenAiModel());
		expect(items.find(item => item.type === "function_call")).toBeDefined();
		expect(items.find(item => item.type === "custom_tool_call")).toBeUndefined();
	});
});

describe("remote compaction input trimming", () => {
	test("trims removable items against reserved input budget when input fits full context window", async () => {
		let requestInput: Array<Record<string, unknown>> | undefined;
		using _hook = hookFetch(async (_input, init) => {
			const body = JSON.parse(String(init?.body)) as { input: Array<Record<string, unknown>> };
			requestInput = body.input;
			return Response.json({
				output: [{ type: "compaction_summary", summary: "compact" }],
			});
		});

		await requestOpenAiRemoteCompaction(
			makeOpenAiModel({ contextWindow: 100, maxTokens: 20 }),
			"test-key",
			[
				{ type: "message", role: "user", content: [{ type: "input_text", text: "keep user message" }] },
				{
					type: "message",
					role: "developer",
					content: [{ type: "input_text", text: "remove developer message ".repeat(8) }],
				},
			],
			"compact",
		);

		expect(requestInput?.some(item => item.type === "message" && item.role === "developer")).toBe(false);
		expect(requestInput?.some(item => item.type === "message" && item.role === "user")).toBe(true);
	});

	test("trims custom tool outputs with their matching custom calls", async () => {
		let requestInput: Array<Record<string, unknown>> | undefined;
		using _hook = hookFetch(async (_input, init) => {
			const body = JSON.parse(String(init?.body)) as { input: Array<Record<string, unknown>> };
			requestInput = body.input;
			return Response.json({
				output: [{ type: "compaction_summary", summary: "compact" }],
			});
		});

		await requestOpenAiRemoteCompaction(
			makeOpenAiModel({ contextWindow: 1 }),
			"test-key",
			[
				{ type: "custom_tool_call", call_id: "call_apply_1", name: "apply_patch", input: "x".repeat(10_000) },
				{ type: "custom_tool_call_output", call_id: "call_apply_1", output: "patch applied".repeat(1_000) },
			],
			"compact",
		);

		expect(requestInput?.some(item => item.type === "custom_tool_call")).toBe(false);
		expect(requestInput?.some(item => item.type === "custom_tool_call_output")).toBe(false);
	});
});

describe("remote compaction endpoint", () => {
	test("uses OPENAI_BASE_URL for OpenAI compaction when bundled metadata has the default OpenAI URL", async () => {
		const restore = setEnvForTest("OPENAI_BASE_URL", "https://openai-proxy.example.com/v1");
		let requestUrl: string | undefined;
		try {
			using _hook = hookFetch(async input => {
				requestUrl = String(input instanceof Request ? input.url : input);
				return Response.json({
					output: [{ type: "compaction_summary", summary: "compact" }],
				});
			});

			await requestOpenAiRemoteCompaction(
				makeOpenAiModel({ baseUrl: "https://api.openai.com/v1" }),
				"test-key",
				[{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
				"compact",
			);

			expect(requestUrl).toBe("https://openai-proxy.example.com/v1/responses/compact");
		} finally {
			restore();
		}
	});

	test("keeps OAuth OpenAI compaction on the default API base URL when OPENAI_BASE_URL is set", async () => {
		const restore = setEnvForTest("OPENAI_BASE_URL", "https://openai-proxy.example.com/v1");
		let requestUrl: string | undefined;
		try {
			using _hook = hookFetch(async input => {
				requestUrl = String(input instanceof Request ? input.url : input);
				return Response.json({
					output: [{ type: "compaction_summary", summary: "compact" }],
				});
			});

			await requestOpenAiRemoteCompaction(
				makeOpenAiModel({ baseUrl: "" }),
				"oauth-token",
				[{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
				"compact",
				undefined,
				{ authCredentialType: "oauth" },
			);

			expect(requestUrl).toBe("https://api.openai.com/v1/responses/compact");
		} finally {
			restore();
		}
	});
});

describe("requestOpenAiRemoteCompaction abort", () => {
	test("rejects when the abort signal is aborted mid-fetch", async () => {
		const controller = new AbortController();
		using _hook = hookFetch((_input, init) => {
			// Honor the provided abort signal: hang until aborted, then reject.
			const signal = init?.signal as AbortSignal | undefined;
			const { promise, reject } = Promise.withResolvers<Response>();
			if (signal?.aborted) {
				reject(signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
				return promise;
			}
			signal?.addEventListener("abort", () => {
				reject(signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
			});
			return promise;
		});

		const promise = requestOpenAiRemoteCompaction(
			makeOpenAiModel(),
			"test-key",
			[{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
			"compact",
			controller.signal,
		);

		queueMicrotask(() => controller.abort());

		await expect(promise).rejects.toThrow();
	});
});
