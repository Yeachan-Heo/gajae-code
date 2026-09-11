import { afterEach, describe, expect, test, vi } from "bun:test";
import { Effort } from "../src/model-thinking";
import { getBundledModel } from "../src/models";
import { streamSimple } from "../src/stream";
import type { Context } from "../src/types";
import { createSseResponse, testContext } from "./openai-tool-choice-test-helpers";

const modelId = "muse-spark-1.3-contributor";
const efforts = [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh];

function textEvents(text: string, id: string): unknown[] {
	return [
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "message", id, role: "assistant", content: [] },
		},
		{
			type: "response.content_part.added",
			output_index: 0,
			content_index: 0,
			item_id: id,
			part: { type: "output_text", text: "" },
		},
		{ type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: id, delta: text },
		{
			type: "response.output_item.done",
			output_index: 0,
			item: {
				type: "message",
				id,
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text }],
			},
		},
	];
}

function response(events: unknown[]): Response {
	return createSseResponse([
		{ type: "response.created", response: { id: "resp_muse", status: "in_progress" } },
		...events,
		{
			type: "response.completed",
			response: {
				id: "resp_muse",
				status: "completed",
				usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
			},
		},
	]);
}

function capture(responses: Response[]) {
	const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
	async function capturingFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
		requests.push({
			url: input instanceof Request ? input.url : String(input),
			headers: new Headers(init?.headers),
			body: JSON.parse(String(init?.body)) as Record<string, unknown>,
		});
		const next = responses.shift();
		if (!next) throw new Error("Unexpected request");
		return next;
	}
	vi.spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(capturingFetch, { preconnect: globalThis.fetch.preconnect }),
	);
	return requests;
}

afterEach(() => vi.restoreAllMocks());

describe("OpenCode Go Muse Spark 1.3 Responses dispatch", () => {
	test.each(efforts)("forwards nested %s effort through normal dispatch", async reasoning => {
		const requests = capture([response(textEvents("ok", "msg_ok"))]);
		const result = await streamSimple(getBundledModel("opencode-go", modelId), testContext, {
			apiKey: "test-key",
			reasoning,
			providerSessionId: "opaque-muse-session",
			sessionId: "generic-session",
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe("https://opencode.ai/zen/go/v1/responses");
		expect(requests[0]?.headers.get("x-opencode-session")).toBe("opaque-muse-session");
		expect(requests[0]?.body.model).toBe(modelId);
		expect(requests[0]?.body.reasoning).toMatchObject({ effort: reasoning });
		expect(requests[0]?.body.reasoning_effort).toBeUndefined();
	});

	test("rejects unsupported max before sending a request", () => {
		const requests = capture([]);
		expect(() =>
			streamSimple(getBundledModel("opencode-go", modelId), testContext, {
				apiKey: "test-key",
				reasoning: Effort.Max,
			}),
		).toThrow(`Thinking effort max is not supported by opencode-go/${modelId}`);
		expect(requests).toHaveLength(0);
	});

	test("preserves text, tool IDs and result across turns with forced tool choice and reasoning", async () => {
		const item = {
			type: "function_call",
			id: "fc_lookup",
			call_id: "call_lookup",
			name: "search",
			arguments: '{"query":"muse"}',
		};
		const requests = capture([
			response([
				...textEvents("Looking up Muse.", "msg_lookup"),
				{ type: "response.output_item.added", output_index: 1, item: { ...item, arguments: "" } },
				{
					type: "response.function_call_arguments.delta",
					output_index: 1,
					item_id: item.id,
					delta: item.arguments,
				},
				{
					type: "response.function_call_arguments.done",
					output_index: 1,
					item_id: item.id,
					arguments: item.arguments,
				},
				{ type: "response.output_item.done", output_index: 1, item },
			]),
			response(textEvents("Found Muse.", "msg_final")),
		]);
		const model = getBundledModel("opencode-go", modelId);
		const options = { apiKey: "test-key", reasoning: Effort.High, providerSessionId: "opaque-muse-session" };
		const first = await streamSimple(model, testContext, {
			...options,
			toolChoice: { type: "function", name: "search" },
		}).result();
		expect(first.stopReason).toBe("toolUse");
		expect(first.content).toContainEqual(expect.objectContaining({ type: "text", text: "Looking up Muse." }));
		const call = first.content.find(block => block.type === "toolCall");
		expect(call).toMatchObject({ id: "call_lookup|fc_lookup", name: "search", arguments: { query: "muse" } });
		if (!call) throw new Error("Missing streamed tool call");
		const context: Context = {
			...testContext,
			messages: [
				...testContext.messages,
				first,
				{
					role: "toolResult",
					toolCallId: call.id,
					toolName: call.name,
					content: [{ type: "text", text: "Muse result 42" }],
					isError: false,
					timestamp: 1,
				},
			],
		};
		const final = await streamSimple(model, context, options).result();
		expect(final.stopReason).toBe("stop");
		expect(final.content).toContainEqual(expect.objectContaining({ type: "text", text: "Found Muse." }));
		expect(requests).toHaveLength(2);
		expect(requests[0]?.body.tool_choice).toEqual({ type: "function", name: "search" });
		// Existing history replay strips output-only item IDs, retaining call_id
		// for pairing; the compound item identity remains in the assistant above.
		expect(requests[1]?.body.input).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "hello" }] },
			{
				type: "message",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "Looking up Muse." }],
			},
			{ type: item.type, call_id: item.call_id, name: item.name, arguments: item.arguments },
			{ type: "function_call_output", call_id: "call_lookup", output: "Muse result 42" },
		]);
		for (const request of requests) {
			expect(request.url).toBe("https://opencode.ai/zen/go/v1/responses");
			expect(request.headers.get("x-opencode-session")).toBe("opaque-muse-session");
			expect(request.body.reasoning).toMatchObject({ effort: "high" });
		}
	});

	test("preserves Muse 1.2 Responses reasoning", async () => {
		const requests = capture([response(textEvents("ok", "msg_old"))]);
		const result = await streamSimple(getBundledModel("opencode-go", "muse-spark-1.2-contributor"), testContext, {
			apiKey: "test-key",
			reasoning: Effort.XHigh,
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(requests[0]?.url).toBe("https://opencode.ai/zen/go/v1/responses");
		expect(requests[0]?.body.reasoning).toMatchObject({ effort: "xhigh" });
	});
});
