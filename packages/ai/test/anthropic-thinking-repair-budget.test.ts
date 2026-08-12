import { describe, expect, it, vi } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { streamAnthropic } from "@gajae-code/ai/providers/anthropic";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Model,
	ProviderSessionState,
	UserMessage,
} from "@gajae-code/ai/types";

/**
 * Issue #4011: a single ACP session burned 121 rejected Anthropic requests over
 * 29m17s because the thinking-replay repair reset the provider retry budget and
 * nothing bounded how often the repair pair was re-entered. The captured
 * rejection stream is exactly the shape stubbed here: a thinking-block mutation
 * `invalid_request_error` first, then the proxy-masked generic `api_error`.
 */
const model: Model<"anthropic-messages"> = {
	api: "anthropic-messages",
	provider: "anthropic",
	id: "claude-sonnet-4-6",
	name: "Claude Sonnet 4.6",
	baseUrl: "https://api.anthropic.com",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	maxTokens: 8_192,
	contextWindow: 200_000,
	reasoning: true,
};

type MockAnthropicRequest = {
	withResponse(): Promise<{
		data: AsyncIterable<Record<string, unknown>>;
		response: Response;
		request_id: string | null;
	}>;
};

const MUTATION_REJECTION =
	'{"type":"error","error":{"type":"invalid_request_error","message":"messages.1.content.24: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response."}}';
const MASKED_REJECTION =
	'{"type":"error","error":{"type":"api_error","message":"An error occurred while processing the request."}}';

function rejectingRequest(message: string, status?: number): MockAnthropicRequest {
	return {
		async withResponse(): Promise<never> {
			const error = new Error(message);
			if (status !== undefined) {
				(error as { status?: number }).status = status;
			}
			throw error;
		},
	};
}

function successfulRequest(): MockAnthropicRequest {
	const response = new Response(null, { status: 200, headers: { "request-id": "req_ok" } });
	const events: Record<string, unknown>[] = [
		{
			type: "message_start",
			message: {
				id: "msg_ok",
				usage: { input_tokens: 1, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "recovered" } },
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
		},
		{ type: "message_stop" },
	];
	return {
		async withResponse() {
			return {
				data: {
					async *[Symbol.asyncIterator]() {
						for (const event of events) yield event;
					},
				},
				response,
				request_id: response.headers.get("request-id"),
			};
		},
	};
}

function signedAssistant(suffix: string, text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: `thinking ${suffix}`, thinkingSignature: `sig_${suffix}` },
			{ type: "text", text },
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function replayContext(): Context {
	const user: UserMessage = { role: "user", content: "first", timestamp: Date.now() };
	return {
		messages: [
			user,
			signedAssistant("early", "early answer"),
			{ ...user, content: "second", timestamp: Date.now() + 1 },
			signedAssistant("late", "late answer"),
			{ ...user, content: "next prompt", timestamp: Date.now() + 2 },
		],
	};
}

type RecordedBody = { messages?: Array<{ content?: unknown }> };

function replayedThinkingBlockTypes(body: unknown): string[] {
	const messages = (body as RecordedBody).messages ?? [];
	return messages.flatMap(message =>
		Array.isArray(message.content)
			? (message.content as Array<{ type?: string }>)
					.map(block => block.type ?? "")
					.filter(type => type === "thinking" || type === "redacted_thinking")
			: [],
	);
}

describe("Anthropic thinking-replay repair budget (issue #4011)", () => {
	it("stops after two requests when a mutation 400 degrades into the masked api_error", async () => {
		const requestBodies: unknown[] = [];
		let attempt = 0;
		const create = ((body: unknown) => {
			requestBodies.push(body);
			attempt += 1;
			return (attempt === 1 ? rejectingRequest(MUTATION_REJECTION) : rejectingRequest(MASKED_REJECTION)) as never;
		}) as unknown as Anthropic["messages"]["create"];
		const client = { messages: { create } } as Anthropic;

		const stream = streamAnthropic(model, replayContext(), { client });
		const observed: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			observed.push(event);
		}
		const result = await stream.result();

		// One repair, one confirming request. The captured session made 121.
		expect(requestBodies).toHaveLength(2);
		// The turn dies loudly: a terminal frame carrying the provider's own message.
		expect(observed.filter(event => event.type === "error")).toHaveLength(1);
		expect(observed.at(-1)?.type).toBe("error");
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("An error occurred while processing the request.");
	});

	it("replays no thinking blocks at all after a mutation rejection", async () => {
		const requestBodies: unknown[] = [];
		let attempt = 0;
		const create = ((body: unknown) => {
			requestBodies.push(body);
			attempt += 1;
			return (attempt === 1 ? rejectingRequest(MUTATION_REJECTION) : successfulRequest()) as never;
		}) as unknown as Anthropic["messages"]["create"];
		const client = { messages: { create } } as Anthropic;

		const result = await streamAnthropic(model, replayContext(), { client }).result();

		expect(result.stopReason).toBe("stop");
		expect(requestBodies).toHaveLength(2);
		expect(replayedThinkingBlockTypes(requestBodies[0])).toEqual(["thinking", "thinking"]);
		// The latest-assistant transform changes this body, so it is the one bounded
		// application-level repair attempt that may be sent.
		expect(replayedThinkingBlockTypes(requestBodies[1])).toEqual(["thinking"]);
		expect(JSON.stringify(requestBodies[1])).toContain("sig_early");
		expect(JSON.stringify(requestBodies[1])).not.toContain("sig_late");
		expect(JSON.stringify(requestBodies[1])).toContain("early answer");
	});

	it("does not renew the provider retry budget when a repair fires", async () => {
		const requestBodies: unknown[] = [];
		let attempt = 0;
		const create = ((body: unknown) => {
			requestBodies.push(body);
			attempt += 1;
			// Burn the whole provider retry budget, then trip the repair, then fail
			// again: the repair must not hand the budget back.
			if (attempt === 4) return rejectingRequest(MUTATION_REJECTION) as never;
			return rejectingRequest("529 Overloaded", 529) as never;
		}) as unknown as Anthropic["messages"]["create"];
		const client = { messages: { create } } as Anthropic;
		const providerRetryWait = vi.fn(async () => {});

		const result = await streamAnthropic(model, replayContext(), { client, providerRetryWait }).result();

		// 3 provider retries + the repaired request + the request that exhausts the
		// budget. Resetting the budget on repair would allow 3 more.
		expect(requestBodies).toHaveLength(5);
		expect(providerRetryWait).toHaveBeenCalledTimes(3);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Overloaded");
	});

	it("carries the repair budget across stream re-invocation for the same session", async () => {
		const requestBodies: unknown[] = [];
		const create = ((body: unknown) => {
			requestBodies.push(body);
			return rejectingRequest(MASKED_REJECTION) as never;
		}) as unknown as Anthropic["messages"]["create"];
		const client = { messages: { create } } as Anthropic;
		const providerSessionState = new Map<string, ProviderSessionState>();

		const first = await streamAnthropic(model, replayContext(), { client, providerSessionState }).result();
		// One application-level repair attempt, then the budget is spent.
		expect(first.stopReason).toBe("error");
		expect(requestBodies).toHaveLength(2);

		const second = await streamAnthropic(model, replayContext(), { client, providerSessionState }).result();

		// Re-invoking the stream must not hand out a fresh pair of repairs.
		expect(second.stopReason).toBe("error");
		expect(second.errorMessage).toContain("An error occurred while processing the request.");
		expect(requestBodies).toHaveLength(3);
		// The spent budget remains session-scoped, but the unclassifiable masked
		// rejection does not carry its speculative degradation into the next turn.
		expect(replayedThinkingBlockTypes(requestBodies[2])).toEqual(["thinking", "thinking"]);
	});

	it("stays bounded across three turns that never complete a stream", async () => {
		const requestBodies: unknown[] = [];
		const create = ((body: unknown) => {
			requestBodies.push(body);
			return rejectingRequest(MASKED_REJECTION) as never;
		}) as unknown as Anthropic["messages"]["create"];
		const client = { messages: { create } } as Anthropic;
		const providerSessionState = new Map<string, ProviderSessionState>();

		for (let turn = 0; turn < 3; turn++) {
			const result = await streamAnthropic(model, replayContext(), { client, providerSessionState }).result();
			expect(result.stopReason).toBe("error");
		}

		// One repair on the first turn, then one bare request per later turn.
		expect(requestBodies).toHaveLength(4);
	});
});

/**
 * Issue #4038: the repair branch also fires on the proxy-masked generic
 * `api_error`, which nothing can classify and which may simply be transient.
 * Persisting an escalation triggered by it stripped native thinking replay from
 * every remaining turn of the session. A stream that completes releases the
 * escalation and the budget it consumed; a session that never completes one
 * keeps the #4011 ceiling.
 */
describe("Anthropic thinking-replay repair scope release (issue #4038)", () => {
	it("replays native thinking again on the next turn after a transient masked api_error", async () => {
		const requestBodies: unknown[] = [];
		let attempt = 0;
		const create = ((body: unknown) => {
			requestBodies.push(body);
			attempt += 1;
			return (attempt === 1 ? rejectingRequest(MASKED_REJECTION) : successfulRequest()) as never;
		}) as unknown as Anthropic["messages"]["create"];
		const client = { messages: { create } } as Anthropic;
		const providerSessionState = new Map<string, ProviderSessionState>();

		const first = await streamAnthropic(model, replayContext(), { client, providerSessionState }).result();

		expect(first.stopReason).toBe("stop");
		expect(requestBodies).toHaveLength(2);
		expect(replayedThinkingBlockTypes(requestBodies[0])).toEqual(["thinking", "thinking"]);
		expect(replayedThinkingBlockTypes(requestBodies[1])).toEqual(["thinking"]);

		const second = await streamAnthropic(model, replayContext(), { client, providerSessionState }).result();

		expect(second.stopReason).toBe("stop");
		expect(requestBodies).toHaveLength(3);
		// The blip is over and nothing ever proved the replay was at fault, so the
		// next turn ships the signed blocks instead of staying degraded forever.
		expect(replayedThinkingBlockTypes(requestBodies[2])).toEqual(["thinking", "thinking"]);
		expect(JSON.stringify(requestBodies[2])).toContain("sig_early");
		expect(JSON.stringify(requestBodies[2])).toContain("sig_late");
	});

	it("re-arms the repair budget for the next turn once a stream completes", async () => {
		const requestBodies: unknown[] = [];
		let attempt = 0;
		const create = ((body: unknown) => {
			requestBodies.push(body);
			attempt += 1;
			// Turn 1 spends one repair, then completes. Turn 2 is rejected once more.
			const rejects = attempt === 1 || attempt === 3;
			return (rejects ? rejectingRequest(MASKED_REJECTION) : successfulRequest()) as never;
		}) as unknown as Anthropic["messages"]["create"];
		const client = { messages: { create } } as Anthropic;
		const providerSessionState = new Map<string, ProviderSessionState>();

		const first = await streamAnthropic(model, replayContext(), { client, providerSessionState }).result();
		expect(first.stopReason).toBe("stop");
		expect(requestBodies).toHaveLength(2);

		const second = await streamAnthropic(model, replayContext(), { client, providerSessionState }).result();

		// A spent budget would have surfaced the rejection instead of repairing it.
		expect(second.stopReason).toBe("stop");
		expect(requestBodies).toHaveLength(4);
		expect(replayedThinkingBlockTypes(requestBodies[2])).toEqual(["thinking", "thinking"]);
		expect(replayedThinkingBlockTypes(requestBodies[3])).toEqual(["thinking"]);
	});
});
