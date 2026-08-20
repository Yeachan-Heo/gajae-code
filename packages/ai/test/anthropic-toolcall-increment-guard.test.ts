import { afterEach, describe, expect, it, vi } from "bun:test";
import { Messages } from "@anthropic-ai/sdk/resources/messages/messages";
import * as utils from "@gajae-code/utils";
import { Effort } from "../src/model-thinking";
import { streamAnthropic } from "../src/providers/anthropic";
import type { AssistantMessageEvent, Context, Model } from "../src/types";
import type { AssistantMessageEventStream } from "../src/utils/event-stream";

// Review follow-up for the primitive-increment degradation (PR #4612):
// tool-argument increments carry executable intent, so a malformed
// every non-string `input_json_delta.partial_json` must fail the turn closed
// instead of being silently erased to "". Primitive prose/thinking anomalies
// still degrade with a bounded diagnostic; executable fragments never do.

const model: Model<"anthropic-messages"> = {
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

const context: Context = {
	messages: [{ role: "user", content: "run the tool", timestamp: Date.now() }],
};

type MockEvent = Record<string, unknown>;
type MockStream = AsyncIterable<MockEvent>;
type MockRequest = {
	withResponse(): Promise<{
		data: MockStream;
		response: Response;
		request_id: string | null;
	}>;
};

function mockRequest(events: MockEvent[]): MockRequest {
	const response = new Response(null, { status: 200, headers: { "request-id": "req_mock" } });
	const stream: MockStream = {
		async *[Symbol.asyncIterator]() {
			for (const event of events) yield event;
		},
	};
	return {
		async withResponse() {
			return { data: stream, response, request_id: response.headers.get("request-id") };
		},
	};
}

function toolUseStreamEvents(jsonDeltas: unknown[]): MockEvent[] {
	return [
		{
			type: "message_start",
			message: { id: "msg_tool", usage: { input_tokens: 10, output_tokens: 0 } },
		},
		{
			type: "content_block_start",
			index: 0,
			content_block: { type: "tool_use", id: "toolu_1", name: "write_file", input: {} },
		},
		...jsonDeltas.map(partialJson => ({
			type: "content_block_delta",
			index: 0,
			delta: { type: "input_json_delta", partial_json: partialJson },
		})),
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
		{ type: "message_stop" },
	];
}

async function drain(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("anthropic tool-argument increment guard", () => {
	it("fails the turn closed when an input_json_delta increment is object-shaped", async () => {
		vi.spyOn(utils.logger, "warn").mockImplementation(() => {});
		vi.spyOn(Messages.prototype, "create").mockImplementation(
			() =>
				mockRequest(
					toolUseStreamEvents(['{"path":"a.ts",', { content: "injected object increment" }, "}"]),
				) as never,
		);

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		const events = await drain(stream);
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage ?? "").toMatch(/tool-argument|input_json_delta/i);
		// The malformed payload must never leak into the surfaced error.
		expect(result.errorMessage ?? "").not.toContain("injected object increment");
		expect(events.find(event => event.type === "done")).toBeUndefined();
	});

	it("fails the turn closed when an input_json_delta increment is function-shaped", async () => {
		vi.spyOn(utils.logger, "warn").mockImplementation(() => {});
		const fnIncrement = () => '{"path":"a.ts"}';
		vi.spyOn(Messages.prototype, "create").mockImplementation(
			() => mockRequest(toolUseStreamEvents(['{"path":', fnIncrement])) as never,
		);

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		await drain(stream);
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage ?? "").toMatch(/tool-argument|input_json_delta/i);
	});

	it("fails the turn closed when an input_json_delta increment is a primitive (valid-but-wrong assembly)", async () => {
		vi.spyOn(utils.logger, "warn").mockImplementation(() => {});
		// `{"n":1` + numeric primitive + `3}` would assemble as {"n":13} if the
		// primitive were erased to "" — a silently different tool call. The turn
		// must fail closed instead of executing assembled-wrong arguments.
		vi.spyOn(Messages.prototype, "create").mockImplementation(
			() => mockRequest(toolUseStreamEvents(['{"n":1', 2, "3}"])) as never,
		);

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		const events = await drain(stream);
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage ?? "").toMatch(/non-string input_json_delta tool-argument/i);
		expect(result.errorMessage ?? "").not.toContain('{"n":1');
		expect(events.find(event => event.type === "done")).toBeUndefined();
	});

	it("fails the turn closed when an input_json_delta increment is missing", async () => {
		vi.spyOn(utils.logger, "warn").mockImplementation(() => {});
		vi.spyOn(Messages.prototype, "create").mockImplementation(
			() => mockRequest(toolUseStreamEvents(['{"path":"a.ts",', undefined])) as never,
		);

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		await drain(stream);
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage ?? "").toMatch(/non-string input_json_delta tool-argument/i);
	});

	it("marks a tool call incomplete when message_stop arrives without content_block_stop", async () => {
		vi.spyOn(Messages.prototype, "create").mockImplementation(
			() =>
				mockRequest([
					{
						type: "message_start",
						message: { id: "msg_unfinalized", usage: { input_tokens: 1, output_tokens: 0 } },
					},
					{
						type: "content_block_start",
						index: 0,
						content_block: { type: "tool_use", id: "tool_unfinalized", name: "write_file", input: {} },
					},
					{
						type: "content_block_delta",
						index: 0,
						delta: { type: "input_json_delta", partial_json: '{"path":"a"}' },
					},
					{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
					{ type: "message_stop" },
				]) as never,
		);
		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		await drain(stream);
		const result = await stream.result();
		const tool = result.content.find(block => block.type === "toolCall");
		expect(tool).toMatchObject({ incompleteArguments: true, incompleteArgumentsReason: "truncated" });
	});

	it("fails closed on non-object completed tool arguments", async () => {
		vi.spyOn(Messages.prototype, "create").mockImplementation(
			() => mockRequest(toolUseStreamEvents(["[]"])) as never,
		);
		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		await drain(stream);
		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage ?? "").toMatch(/non-object arguments/i);
	});

	it("keeps primitive thinking-delta degradation and emits one bounded warning for it", async () => {
		const warnSpy = vi.spyOn(utils.logger, "warn").mockImplementation(() => {});
		const thinkingModel: Model<"anthropic-messages"> = {
			...model,
			id: "claude-sonnet-4-6",
			thinking: { mode: "anthropic-adaptive", minLevel: Effort.Minimal, maxLevel: Effort.Max },
		};
		vi.spyOn(Messages.prototype, "create").mockImplementation(
			() =>
				mockRequest([
					{
						type: "message_start",
						message: { id: "msg_think", usage: { input_tokens: 10, output_tokens: 0 } },
					},
					{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
					{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: 1 } },
					{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta" } },
					{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "later" } },
					{ type: "content_block_stop", index: 0 },
					{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
					{ type: "message_stop" },
				]) as never,
		);

		const stream = streamAnthropic(thinkingModel, context, { apiKey: "sk-ant-test", thinkingEnabled: true });
		await drain(stream);
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "thinking", thinking: "later", thinkingSignature: "" }]);
		const degradeWarns = warnSpy.mock.calls.filter(
			([message]) => typeof message === "string" && message.includes("degraded non-string stream increment"),
		);
		expect(degradeWarns).toHaveLength(1);
		expect(degradeWarns[0]?.[1]).toHaveProperty("deltaType", "thinking_delta");
	});

	it("uses one captured text_delta value", async () => {
		let reads = 0;
		const delta = { type: "text_delta" } as Record<string, unknown>;
		Object.defineProperty(delta, "text", {
			enumerable: true,
			get() {
				reads += 1;
				return reads <= 3 ? "captured" : { injected: true };
			},
		});
		vi.spyOn(Messages.prototype, "create").mockImplementation(
			() =>
				mockRequest([
					{ type: "message_start", message: { id: "msg_text", usage: { input_tokens: 1, output_tokens: 0 } } },
					{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
					{ type: "content_block_delta", index: 0, delta },
					{ type: "content_block_stop", index: 0 },
					{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
					{ type: "message_stop" },
				]) as never,
		);
		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		await drain(stream);
		const result = await stream.result();
		expect(reads).toBe(3);
		expect(result.content).toEqual([{ type: "text", text: "captured" }]);
	});
});
