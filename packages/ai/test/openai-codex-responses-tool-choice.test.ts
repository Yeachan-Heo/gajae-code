import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { streamOpenAICodexResponses } from "../src/providers/openai-codex-responses";
import type { Context, Model, ToolChoice } from "../src/types";
import {
	clearToolChoiceIncapabilityRegistryForTests,
	getToolChoiceCapabilityOverride,
} from "../src/utils/tool-choice-capability";
import {
	collectEvents,
	createBaseModel,
	createErrorResponse,
	createSseResponse,
	expectSingleCleanFallbackEvents,
	testContext,
} from "./openai-tool-choice-test-helpers";

const originalFetch = global.fetch;
const codexToken =
	"eyJhbGciOiJub25lIn0.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjLXRlc3QifX0.";

beforeEach(() => clearToolChoiceIncapabilityRegistryForTests());
afterEach(() => {
	global.fetch = originalFetch;
});

function model(overrides: Partial<Model<"openai-codex-responses">> = {}): Model<"openai-codex-responses"> {
	return {
		...createBaseModel("openai-codex-responses"),
		provider: "openai",
		baseUrl: "https://chatgpt.com/backend-api",
		...overrides,
	};
}

function okResponse(modelId: string): Response {
	return createSseResponse([
		{ type: "response.created", response: { id: "resp_codex", model: modelId, status: "in_progress" } },
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { id: "msg_1", type: "message", role: "assistant", content: [] },
		},
		{
			type: "response.content_part.added",
			item_id: "msg_1",
			output_index: 0,
			content_index: 0,
			part: { type: "output_text", text: "" },
		},
		{ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "ok" },
		{ type: "response.output_text.done", item_id: "msg_1", output_index: 0, content_index: 0, text: "ok" },
		{
			type: "response.output_item.done",
			output_index: 0,
			item: { id: "msg_1", type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
		},
		{
			type: "response.completed",
			response: {
				id: "resp_codex",
				model: modelId,
				status: "completed",
				output: [],
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
			},
		},
	]);
}
function statuslessToolChoiceError(
	name: string,
	message = `Tool choice '${name}' not found in 'tools' parameter.`,
): Response {
	return createSseResponse([{ type: "error", code: "invalid_request_error", message }]);
}

describe("OpenAI Codex responses tool choice capability", () => {
	it("passes through named tool_choice when named choices are supported", async () => {
		let payload: Record<string, unknown> | undefined;
		const testModel = model({ compat: { toolChoiceSupport: "named" } });
		global.fetch = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit) => {
				payload = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
				return okResponse(testModel.id);
			},
			{ preconnect: originalFetch.preconnect },
		);
		await streamOpenAICodexResponses(testModel, testContext, {
			apiKey: codexToken,
			preferWebsockets: false,
			toolChoice: { type: "function", function: { name: "search" } },
		}).result();
		expect(payload?.tool_choice).toEqual({ type: "function", name: "search" });
	});

	it("omits forced tool_choice but keeps tools when forced choices are unsupported", async () => {
		let payload: Record<string, unknown> | undefined;
		const testModel = model({ compat: { supportsForcedToolChoice: false } });
		global.fetch = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit) => {
				payload = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
				return okResponse(testModel.id);
			},
			{ preconnect: originalFetch.preconnect },
		);
		await streamOpenAICodexResponses(testModel, testContext, {
			apiKey: codexToken,
			preferWebsockets: false,
			toolChoice: { type: "function", function: { name: "search" } },
		}).result();
		expect(payload?.tool_choice).toBeUndefined();
		expect(payload?.tools).toEqual(expect.any(Array));
	});

	it("retries once when Codex rejects a named tool choice missing from its tool list", async () => {
		const bodies: Record<string, unknown>[] = [];
		const testModel = model({ id: "runtime-codex" });
		const todoContext = {
			...testContext,
			tools: [{ ...testContext.tools![0]!, name: "todo_write" }],
		};
		global.fetch = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit) => {
				bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
				return bodies.length === 1
					? createErrorResponse("Tool choice 'todo_write' not found in 'tools' parameter.")
					: okResponse(testModel.id);
			},
			{ preconnect: originalFetch.preconnect },
		);
		const stream = streamOpenAICodexResponses(testModel, todoContext, {
			apiKey: codexToken,
			preferWebsockets: false,
			toolChoice: { type: "function", function: { name: "todo_write" } },
			sessionId: "session-a",
		});
		const events = await collectEvents(stream);
		const result = await stream.result();
		expect(result.stopReason).toBe("stop");
		expect(bodies).toHaveLength(2);
		expect(bodies[0]?.tool_choice).toEqual({ type: "function", name: "todo_write" });
		expect(bodies[0]?.tools).toEqual([expect.objectContaining({ type: "function", name: "todo_write" })]);
		expect(bodies[1]?.tool_choice).toBeUndefined();
		expect(bodies[1]?.tools).toEqual(expect.any(Array));
		expect(bodies[1]?.prompt_cache_key).toBe(bodies[0]?.prompt_cache_key);
		expect(getToolChoiceCapabilityOverride(testModel)).toBe("auto");
		expectSingleCleanFallbackEvents(events);
	});

	it("keeps an initial HTTP downgrade across a later provider retry", async () => {
		const bodies: Record<string, unknown>[] = [];
		const testModel = model({ id: "runtime-codex-http-sticky-downgrade" });
		global.fetch = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit) => {
				bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
				if (bodies.length === 1) {
					return createErrorResponse("Tool choice 'search' not found in 'tools' parameter.");
				}
				if (bodies.length === 2) {
					return createSseResponse([{ type: "error", code: "server_error", message: "retry me" }]);
				}
				return okResponse(testModel.id);
			},
			{ preconnect: originalFetch.preconnect },
		);

		const result = await streamOpenAICodexResponses(testModel, testContext, {
			apiKey: codexToken,
			preferWebsockets: false,
			toolChoice: { type: "function", function: { name: "search" } },
			streamMaxRetries: 1,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(bodies).toHaveLength(3);
		expect(bodies[0]?.tool_choice).toEqual({ type: "function", name: "search" });
		expect(bodies[1]?.tool_choice).toBeUndefined();
		expect(bodies[2]?.tool_choice).toBeUndefined();
		expect(getToolChoiceCapabilityOverride(testModel)).toBe("auto");
	});
	it("retries once when a Codex SSE error rejects a named tool choice", async () => {
		const bodies: Record<string, unknown>[] = [];
		const testModel = model({ id: "runtime-codex-sse" });
		const todoContext = {
			...testContext,
			tools: [{ ...testContext.tools![0]!, name: "todo_write" }],
		};
		global.fetch = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit) => {
				bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
				return bodies.length === 1
					? createSseResponse([
							{
								type: "error",
								code: "invalid_request_error",
								message: "Tool choice 'todo_write' not found in 'tools' parameter.",
							},
						])
					: okResponse(testModel.id);
			},
			{ preconnect: originalFetch.preconnect },
		);
		const stream = streamOpenAICodexResponses(testModel, todoContext, {
			apiKey: codexToken,
			preferWebsockets: false,
			toolChoice: { type: "function", function: { name: "todo_write" } },
			sessionId: "session-sse",
		});
		const events = await collectEvents(stream);
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect(bodies).toHaveLength(2);
		expect(bodies[0]?.tool_choice).toEqual({ type: "function", name: "todo_write" });
		expect(bodies[0]?.tools).toEqual([expect.objectContaining({ type: "function", name: "todo_write" })]);
		expect(bodies[1]?.tool_choice).toBeUndefined();
		expect(bodies[1]?.prompt_cache_key).toBe(bodies[0]?.prompt_cache_key);
		expect(getToolChoiceCapabilityOverride(testModel)).toBe("auto");
		expectSingleCleanFallbackEvents(events);
	});
	it("keeps the downgraded SSE body across a later provider retry", async () => {
		const bodies: Record<string, unknown>[] = [];
		const testModel = model({ id: "runtime-codex-sticky-downgrade" });
		global.fetch = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit) => {
				bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
				if (bodies.length === 1) return statuslessToolChoiceError("search");
				if (bodies.length === 2) {
					return createSseResponse([{ type: "error", code: "server_error", message: "retry me" }]);
				}
				return okResponse(testModel.id);
			},
			{ preconnect: originalFetch.preconnect },
		);

		const result = await streamOpenAICodexResponses(testModel, testContext, {
			apiKey: codexToken,
			preferWebsockets: false,
			toolChoice: { type: "function", function: { name: "search" } },
			streamMaxRetries: 1,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(bodies).toHaveLength(3);
		expect(bodies[0]?.tool_choice).toEqual({ type: "function", name: "search" });
		expect(bodies[1]?.tool_choice).toBeUndefined();
		expect(bodies[2]?.tool_choice).toBeUndefined();
		expect(getToolChoiceCapabilityOverride(testModel)).toBe("auto");
	});

	it("allows the tool-choice fallback after an unrelated provider retry", async () => {
		const bodies: Record<string, unknown>[] = [];
		const testModel = model({ id: "runtime-codex-retry-then-downgrade" });
		global.fetch = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit) => {
				bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
				if (bodies.length === 1) {
					return createSseResponse([{ type: "error", code: "server_error", message: "retry me" }]);
				}
				if (bodies.length === 2) return statuslessToolChoiceError("search");
				return okResponse(testModel.id);
			},
			{ preconnect: originalFetch.preconnect },
		);

		const result = await streamOpenAICodexResponses(testModel, testContext, {
			apiKey: codexToken,
			preferWebsockets: false,
			toolChoice: { type: "function", function: { name: "search" } },
			streamMaxRetries: 1,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(bodies).toHaveLength(3);
		expect(bodies[0]?.tool_choice).toEqual({ type: "function", name: "search" });
		expect(bodies[1]?.tool_choice).toEqual({ type: "function", name: "search" });
		expect(bodies[2]?.tool_choice).toBeUndefined();
		expect(getToolChoiceCapabilityOverride(testModel)).toBe("auto");
	});

	it("does not retry a statusless SSE error in managed mode", async () => {
		let calls = 0;
		const testModel = model({ id: "managed-runtime-codex" });
		global.fetch = Object.assign(
			async () => {
				calls += 1;
				return statuslessToolChoiceError("search");
			},
			{ preconnect: originalFetch.preconnect },
		);
		const result = await streamOpenAICodexResponses(testModel, testContext, {
			apiKey: codexToken,
			preferWebsockets: false,
			toolChoice: { type: "function", function: { name: "search" } },
			fallbackManaged: true,
		}).result();
		expect(calls).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(getToolChoiceCapabilityOverride(testModel)).toBeUndefined();
	});

	it("does not retry statusless SSE errors outside the exact named-tool rejection", async () => {
		const todoContext: Context = {
			...testContext,
			tools: [{ ...testContext.tools![0]!, name: "todo_write" }],
		};
		const cases: Array<{ context: Context; toolChoice: ToolChoice; rejectedName: string; message?: string }> = [
			{
				context: testContext,
				toolChoice: "required",
				rejectedName: "search",
				message: "tool_choice forces tool use is not compatible with this model",
			},
			{
				context: todoContext,
				toolChoice: { type: "function", function: { name: "todo_write" } },
				rejectedName: "search",
			},
			{
				context: testContext,
				toolChoice: { type: "function", function: { name: "todo_write" } },
				rejectedName: "todo_write",
			},
		];
		for (const [index, testCase] of cases.entries()) {
			let calls = 0;
			let body: Record<string, unknown> | undefined;
			const testModel = model({ id: `statusless-negative-${index}` });
			global.fetch = Object.assign(
				async (_input: string | URL | Request, init?: RequestInit) => {
					calls += 1;
					body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
					return statuslessToolChoiceError(testCase.rejectedName, testCase.message);
				},
				{ preconnect: originalFetch.preconnect },
			);
			const result = await streamOpenAICodexResponses(testModel, testCase.context, {
				apiKey: codexToken,
				preferWebsockets: false,
				toolChoice: testCase.toolChoice,
			}).result();
			expect(calls).toBe(1);
			expect(result.stopReason).toBe("error");
			expect(getToolChoiceCapabilityOverride(testModel)).toBeUndefined();
			if (index === 2) {
				expect(body?.tools).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "todo_write" })]));
			}
		}
	});

	it("does not retry a statusless SSE error after abort or output", async () => {
		const controller = new AbortController();
		let abortCalls = 0;
		const abortModel = model({ id: "aborted-statusless-codex" });
		global.fetch = Object.assign(
			async () => {
				abortCalls += 1;
				controller.abort();
				return statuslessToolChoiceError("search");
			},
			{ preconnect: originalFetch.preconnect },
		);
		await streamOpenAICodexResponses(abortModel, testContext, {
			apiKey: codexToken,
			preferWebsockets: false,
			toolChoice: { type: "function", function: { name: "search" } },
			signal: controller.signal,
		}).result();
		expect(abortCalls).toBe(1);
		expect(getToolChoiceCapabilityOverride(abortModel)).toBeUndefined();

		let outputCalls = 0;
		const outputModel = model({ id: "output-statusless-codex" });
		global.fetch = Object.assign(
			async () => {
				outputCalls += 1;
				return createSseResponse([
					{
						type: "response.output_item.added",
						output_index: 0,
						item: { id: "msg_1", type: "message", role: "assistant", content: [] },
					},
					{
						type: "response.content_part.added",
						item_id: "msg_1",
						output_index: 0,
						content_index: 0,
						part: { type: "output_text", text: "" },
					},
					{
						type: "response.output_text.delta",
						item_id: "msg_1",
						output_index: 0,
						content_index: 0,
						delta: "partial",
					},
					{
						type: "error",
						code: "invalid_request_error",
						message: "Tool choice 'search' not found in 'tools' parameter.",
					},
				]);
			},
			{ preconnect: originalFetch.preconnect },
		);
		await streamOpenAICodexResponses(outputModel, testContext, {
			apiKey: codexToken,
			preferWebsockets: false,
			toolChoice: { type: "function", function: { name: "search" } },
		}).result();
		expect(outputCalls).toBe(1);
		expect(getToolChoiceCapabilityOverride(outputModel)).toBeUndefined();
	});

	it("does not issue a third request after a second statusless SSE rejection", async () => {
		let calls = 0;
		const testModel = model({ id: "second-statusless-codex" });
		global.fetch = Object.assign(
			async () => {
				calls += 1;
				return statuslessToolChoiceError("search");
			},
			{ preconnect: originalFetch.preconnect },
		);
		const result = await streamOpenAICodexResponses(testModel, testContext, {
			apiKey: codexToken,
			preferWebsockets: false,
			toolChoice: { type: "function", function: { name: "search" } },
		}).result();
		expect(calls).toBe(2);
		expect(result.stopReason).toBe("error");
		expect(getToolChoiceCapabilityOverride(testModel)).toBe("auto");
	});
	it("propagates unrelated 400 without retry or registry mark", async () => {
		let calls = 0;
		const testModel = model({ id: "unrelated-codex" });
		global.fetch = Object.assign(
			async () => {
				calls += 1;
				return createErrorResponse("some other bad request");
			},
			{ preconnect: originalFetch.preconnect },
		);
		const result = await streamOpenAICodexResponses(testModel, testContext, {
			apiKey: codexToken,
			preferWebsockets: false,
			toolChoice: { type: "function", function: { name: "search" } },
		}).result();
		expect(calls).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(getToolChoiceCapabilityOverride(testModel)).toBeUndefined();
	});
});
