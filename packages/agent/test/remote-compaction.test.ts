import { describe, expect, test } from "bun:test";
import { type CompactionPreparation, compact } from "@gajae-code/agent-core/compaction";
import {
	buildOpenAiNativeHistory,
	getPreservedOpenAiRemoteCompactionData,
	requestOpenAiRemoteCompaction,
	requestRemoteCompaction,
} from "@gajae-code/agent-core/compaction/openai";
import type { AssistantMessage, Model, ToolResultMessage } from "@gajae-code/ai/types";
import { captureEndpointConfiguration, type EndpointConfiguration, hookFetch } from "@gajae-code/utils";

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

function makeCompactionPreparation(messages: CompactionPreparation["recentMessages"]): CompactionPreparation {
	return {
		firstKeptEntryId: "kept-entry",
		messagesToSummarize: [],
		turnPrefixMessages: [],
		recentMessages: messages,
		isSplitTurn: false,
		tokensBefore: 1,
		previousSummary: "existing summary",
		fileOps: { read: new Set(), written: new Set(), edited: new Set() },
		settings: { enabled: true, reserveTokens: 1024, keepRecentTokens: 1024, remoteEnabled: true },
		tokenCorrection: { ratio: 1, keepRecentTokensCorrected: 0 },
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

	test("neutralizes leaked Harmony control tokens in the remote compaction request input", async () => {
		let requestInput: Array<Record<string, unknown>> | undefined;
		using _hook = hookFetch(async (_input, init) => {
			const body = JSON.parse(String(init?.body)) as { input: Array<Record<string, unknown>> };
			requestInput = body.input;
			return Response.json({
				output: [{ type: "compaction_summary", summary: "compact" }],
			});
		});

		// Remote compaction (/responses/compact) bypasses the streaming transport, so
		// leaked `<|channel|>analysis` markers in reasoning/text/tool content would
		// otherwise reach gpt-5.6 verbatim and return `Request blocked`.
		await requestOpenAiRemoteCompaction(
			makeOpenAiModel(),
			"test-key",
			[
				{
					type: "reasoning",
					summary: [{ type: "summary_text", text: "Plan.<|channel|>analysis<|message|>go" }],
				},
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "hi<|recipient|>functions.bash" }],
				},
				{ type: "function_call_output", call_id: "c1", output: "done<|call|>" },
			],
			"compact",
		);

		const serialized = JSON.stringify(requestInput);
		expect(serialized).not.toContain("<|channel|>");
		expect(serialized).not.toContain("<|message|>");
		expect(serialized).not.toContain("<|recipient|>");
		expect(serialized).not.toContain("<|call|>");
		expect(serialized).toContain("<\u200b|channel|>");
		expect(serialized).toContain("Plan.");
	});
});

describe("remote compaction endpoint", () => {
	test("uses captured routing through the maintenance caller and returns preserve data", async () => {
		const previousBaseUrl = Bun.env.OPENAI_BASE_URL;
		const requestCapture: { url?: string; authorization?: string | null } = {};
		try {
			Bun.env.OPENAI_BASE_URL = "https://endpoint-a.example.com/v1";
			const endpointConfiguration = captureEndpointConfiguration();
			Bun.env.OPENAI_BASE_URL = "https://endpoint-b.example.com/v1";
			using _hook = hookFetch(async (input, init) => {
				const request = input instanceof Request ? input : new Request(String(input), init);
				requestCapture.url = request.url;
				requestCapture.authorization = request.headers.get("authorization");
				return Response.json({
					output: [{ type: "compaction_summary", summary: "remote preserve summary" }],
				});
			});

			const result = await compact(
				makeCompactionPreparation([{ role: "user", content: "preserve this", timestamp: 1 }]),
				makeOpenAiModel(),
				"shared-current-key",
				undefined,
				undefined,
				{ endpointConfiguration },
			);

			expect(requestCapture.url).toBe("https://endpoint-a.example.com/v1/responses/compact");
			expect(requestCapture.authorization).toBe("Bearer shared-current-key");
			expect(result.summary).toBe("existing summary");
			const preserved = getPreservedOpenAiRemoteCompactionData(result.preserveData);
			expect(preserved?.compactionItem).toEqual({ type: "compaction_summary", summary: "remote preserve summary" });
			expect(preserved?.replacementHistory.length).toBeGreaterThan(0);
		} finally {
			if (previousBaseUrl === undefined) delete Bun.env.OPENAI_BASE_URL;
			else Bun.env.OPENAI_BASE_URL = previousBaseUrl;
		}
	});

	test("captured absence does not adopt a later OPENAI_BASE_URL", async () => {
		const previousBaseUrl = Bun.env.OPENAI_BASE_URL;
		const requestCapture: { url?: string; authorization?: string | null } = {};
		try {
			delete Bun.env.OPENAI_BASE_URL;
			const endpointConfiguration = captureEndpointConfiguration();
			Bun.env.OPENAI_BASE_URL = "https://endpoint-b.example.com/v1";
			using _hook = hookFetch(async (input, init) => {
				const request = input instanceof Request ? input : new Request(String(input), init);
				requestCapture.url = request.url;
				requestCapture.authorization = request.headers.get("authorization");
				return Response.json({
					output: [{ type: "compaction_summary", summary: "compact" }],
				});
			});

			await requestOpenAiRemoteCompaction(
				makeOpenAiModel({ baseUrl: "https://api.openai.com/v1" }),
				"shared-live-key",
				[{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
				"compact",
				undefined,
				{ endpointConfiguration },
			);

			expect(requestCapture.url).toBe("https://api.openai.com/v1/responses/compact");
			expect(requestCapture.authorization).toBe("Bearer shared-live-key");
		} finally {
			if (previousBaseUrl === undefined) delete Bun.env.OPENAI_BASE_URL;
			else Bun.env.OPENAI_BASE_URL = previousBaseUrl;
		}
	});

	test("uses the current shared authorization token without recapturing endpoint routing", async () => {
		const previousBaseUrl = Bun.env.OPENAI_BASE_URL;
		const requestUrls: string[] = [];
		const authorizations: Array<string | null> = [];
		try {
			Bun.env.OPENAI_BASE_URL = "https://endpoint-a.example.com/v1";
			const endpointConfiguration = captureEndpointConfiguration();
			Bun.env.OPENAI_BASE_URL = "https://endpoint-b.example.com/v1";
			using _hook = hookFetch(async (input, init) => {
				const request = input instanceof Request ? input : new Request(String(input), init);
				requestUrls.push(request.url);
				authorizations.push(request.headers.get("authorization"));
				return Response.json({
					output: [{ type: "compaction_summary", summary: "compact" }],
				});
			});
			const input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }];

			await requestOpenAiRemoteCompaction(makeOpenAiModel(), "rotated-key-one", input, "compact", undefined, {
				endpointConfiguration,
			});
			await requestOpenAiRemoteCompaction(makeOpenAiModel(), "rotated-key-two", input, "compact", undefined, {
				endpointConfiguration,
			});

			expect(requestUrls).toEqual([
				"https://endpoint-a.example.com/v1/responses/compact",
				"https://endpoint-a.example.com/v1/responses/compact",
			]);
			expect(authorizations).toEqual(["Bearer rotated-key-one", "Bearer rotated-key-two"]);
		} finally {
			if (previousBaseUrl === undefined) delete Bun.env.OPENAI_BASE_URL;
			else Bun.env.OPENAI_BASE_URL = previousBaseUrl;
		}
	});

	test("rejects forged endpoint handles before early compaction routes or fetch", async () => {
		const previousBaseUrl = Bun.env.OPENAI_BASE_URL;
		let fetchCalls = 0;
		try {
			using _hook = hookFetch(async () => {
				fetchCalls += 1;
				return Response.json({ output: [{ type: "compaction_summary", summary: "compact" }] });
			});
			const forged = Object.freeze({}) as EndpointConfiguration;
			const emptyPreparation = makeCompactionPreparation([]);
			await expect(
				compact(emptyPreparation, makeOpenAiModel(), "key", undefined, undefined, {
					endpointConfiguration: forged,
				}),
			).rejects.toThrow("Invalid endpoint configuration handle");
			await expect(
				requestOpenAiRemoteCompaction(
					makeOpenAiModel(),
					"key",
					[{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
					"compact",
					undefined,
					{ endpointConfiguration: forged },
				),
			).rejects.toThrow("Invalid endpoint configuration handle");
			expect(fetchCalls).toBe(0);
		} finally {
			if (previousBaseUrl === undefined) delete Bun.env.OPENAI_BASE_URL;
			else Bun.env.OPENAI_BASE_URL = previousBaseUrl;
		}
	});

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

	test.each([
		"https://proxy.example/api.openai.com/v1",
		"https://api.openai.com.proxy.example/v1",
	])("preserves explicit native model URL containing the canonical hostname: %s", async baseUrl => {
		const previousBaseUrl = Bun.env.OPENAI_BASE_URL;
		const requestUrls: string[] = [];
		try {
			Bun.env.OPENAI_BASE_URL = "https://captured-proxy.example/v1";
			const endpointConfiguration = captureEndpointConfiguration();
			Bun.env.OPENAI_BASE_URL = "https://live-proxy.example/v1";
			using _hook = hookFetch(async (input, init) => {
				const request = input instanceof Request ? input : new Request(String(input), init);
				requestUrls.push(request.url);
				return Response.json({ output: [{ type: "compaction_summary", summary: "explicit model" }] });
			});
			const result = await requestOpenAiRemoteCompaction(
				makeOpenAiModel({ baseUrl }),
				"shared-key",
				[{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
				"compact",
				undefined,
				{ endpointConfiguration },
			);
			expect(requestUrls).toEqual([`${baseUrl}/responses/compact`]);
			expect(result.compactionItem).toEqual({ type: "compaction_summary", summary: "explicit model" });
		} finally {
			if (previousBaseUrl === undefined) delete Bun.env.OPENAI_BASE_URL;
			else Bun.env.OPENAI_BASE_URL = previousBaseUrl;
		}
	});

	test("keeps OAuth OpenAI compaction on the canonical origin despite captured and live proxies", async () => {
		const previousBaseUrl = Bun.env.OPENAI_BASE_URL;
		const requestCapture: { url?: string; authorization?: string | null } = {};
		try {
			Bun.env.OPENAI_BASE_URL = "https://captured-proxy.example.com/v1";
			const endpointConfiguration = captureEndpointConfiguration();
			Bun.env.OPENAI_BASE_URL = "https://later-proxy.example.com/v1";
			using _hook = hookFetch(async (input, init) => {
				const request = input instanceof Request ? input : new Request(String(input), init);
				requestCapture.url = request.url;
				requestCapture.authorization = request.headers.get("authorization");
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
				{ authCredentialType: "oauth", endpointConfiguration },
			);

			expect(requestCapture.url).toBe("https://api.openai.com/v1/responses/compact");
			expect(requestCapture.authorization).toBe("Bearer oauth-token");
		} finally {
			if (previousBaseUrl === undefined) delete Bun.env.OPENAI_BASE_URL;
			else Bun.env.OPENAI_BASE_URL = previousBaseUrl;
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

describe("remote compaction invalid_prompt termination (issue #2282)", () => {
	test("neutralizes the prompt and fails fast without retry when the endpoint returns invalid_prompt", async () => {
		let fetchCalls = 0;
		let sentBody: string | undefined;
		using _hook = hookFetch(async (_input, init) => {
			fetchCalls += 1;
			sentBody = String(init?.body);
			return new Response(JSON.stringify({ error: { code: "invalid_prompt", message: "Request blocked" } }), {
				status: 400,
				statusText: "Bad Request",
			});
		});

		await expect(
			requestRemoteCompaction("https://compact.example.com/responses/compact", {
				systemPrompt: "system<|channel|>analysis",
				prompt: "transcript<|message|>leak",
			}),
		).rejects.toThrow(/Remote compaction failed \(400/);

		// Single-shot by construction: the poisoned rejection terminates immediately,
		// it is never retried into an account-level block.
		expect(fetchCalls).toBe(1);
		// The outgoing request was neutralized (the repair) before it was sent.
		expect(sentBody).toBeDefined();
		expect(sentBody).not.toContain("<|channel|>");
		expect(sentBody).not.toContain("<|message|>");
		expect(sentBody).toContain("<\u200b|channel|>");
	});
});
