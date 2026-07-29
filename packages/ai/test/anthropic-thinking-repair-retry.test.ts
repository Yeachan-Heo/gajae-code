import { beforeEach, describe, expect, it } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { streamAnthropic } from "@gajae-code/ai/providers/anthropic";
import type { AssistantMessage, Context, Model, Tool, UserMessage } from "@gajae-code/ai/types";
import { clearToolChoiceIncapabilityRegistryForTests } from "@gajae-code/ai/utils/tool-choice-capability";

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

type MockAnthropicEvent = Record<string, unknown>;
type MockAnthropicStream = AsyncIterable<MockAnthropicEvent>;
type MockAnthropicRequest = {
	withResponse(): Promise<{
		data: MockAnthropicStream;
		response: Response;
		request_id: string | null;
	}>;
};

function createSuccessfulRequest(): MockAnthropicRequest {
	const response = new Response(null, {
		status: 200,
		headers: { "request-id": "req_repair" },
	});
	const events: MockAnthropicEvent[] = [
		{
			type: "message_start",
			message: {
				id: "msg_repair_success",
				usage: {
					input_tokens: 1,
					output_tokens: 0,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "recovered" } },
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: {
				input_tokens: 1,
				output_tokens: 1,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
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

function createAnthropicThinking400(): MockAnthropicRequest {
	return {
		async withResponse() {
			const error = new Error(
				"400 invalid_request_error: thinking blocks in the latest assistant message cannot be modified",
			);
			(error as { status?: number }).status = 400;
			throw error;
		},
	};
}

// Real captured session failure (2026-07-23): the cited block index points into
// HISTORY, not the latest assistant message.
function createAnthropicSignatureInvalid400(): MockAnthropicRequest {
	return {
		async withResponse() {
			const error = new Error(
				'400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.5.content.24: Invalid `signature` in `thinking` block"}}',
			);
			(error as { status?: number }).status = 400;
			throw error;
		},
	};
}

function makeSignedAssistant(suffix: string, text: string): AssistantMessage {
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

describe("Anthropic thinking replay repair retry", () => {
	it("retries once without latest assistant thinking blocks after the Anthropic 400 invariant error", async () => {
		const user: UserMessage = {
			role: "user",
			content: "continue",
			timestamp: Date.now(),
		};
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "synthetic thinking", thinkingSignature: "synthetic_sig" },
				{ type: "redactedThinking", data: "synthetic-redacted-block" },
				{ type: "text", text: "visible answer" },
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
		const context: Context = {
			messages: [user, assistant, { ...user, content: "next prompt", timestamp: Date.now() + 1 }],
		};
		const requestBodies: unknown[] = [];
		let attempt = 0;
		const create = ((body: unknown) => {
			requestBodies.push(body);
			attempt += 1;
			return (attempt === 1 ? createAnthropicThinking400() : createSuccessfulRequest()) as never;
		}) as unknown as Anthropic["messages"]["create"];
		const client = { messages: { create } } as Anthropic;

		const result = await streamAnthropic(model, context, { client }).result();

		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "recovered" }]);
		expect(requestBodies).toHaveLength(2);
		expect(JSON.stringify(requestBodies[0])).toContain("synthetic_sig");
		expect(JSON.stringify(requestBodies[1])).not.toContain("synthetic_sig");
		expect(JSON.stringify(requestBodies[1])).not.toContain("redacted_thinking");
		expect(JSON.stringify(requestBodies[1])).toContain("visible answer");
	});

	// Real captured session failure (2026-07-29): the mutation 400 says "latest
	// assistant message" but cites `messages.1.content.1` — a HISTORICAL turn — so the
	// latest-only repair is rejected identically and the turn used to die.
	it("escalates to a full-history repair when the mutation 400 survives the latest-only repair", async () => {
		const user: UserMessage = {
			role: "user",
			content: "first",
			timestamp: Date.now(),
		};
		const context: Context = {
			messages: [
				user,
				makeSignedAssistant("early", "early answer"),
				{ ...user, content: "second", timestamp: Date.now() + 1 },
				makeSignedAssistant("late", "late answer"),
				{ ...user, content: "next prompt", timestamp: Date.now() + 2 },
			],
		};
		const requestBodies: unknown[] = [];
		let attempt = 0;
		const create = ((body: unknown) => {
			requestBodies.push(body);
			attempt += 1;
			return (attempt <= 2 ? createAnthropicThinking400() : createSuccessfulRequest()) as never;
		}) as unknown as Anthropic["messages"]["create"];
		const client = { messages: { create } } as Anthropic;

		const result = await streamAnthropic(model, context, { client }).result();

		expect(result.stopReason).toBe("stop");
		expect(requestBodies).toHaveLength(3);
		// Attempt 2: latest-only repair keeps the historical signature.
		const secondBody = JSON.stringify(requestBodies[1]);
		expect(secondBody).toContain("sig_early");
		expect(secondBody).not.toContain("sig_late");
		// Attempt 3: escalated full-history repair drops every replayed signature.
		const thirdBody = JSON.stringify(requestBodies[2]);
		expect(thirdBody).not.toContain("sig_early");
		expect(thirdBody).not.toContain("sig_late");
		expect(thirdBody).toContain("early answer");
	});

	it("stops after exactly three requests when the mutation 400 persists through both repair scopes", async () => {
		const user: UserMessage = {
			role: "user",
			content: "first",
			timestamp: Date.now(),
		};
		const context: Context = {
			messages: [user, makeSignedAssistant("history", "history answer"), { ...user, content: "next prompt" }],
		};
		const requestBodies: unknown[] = [];
		const create = ((body: unknown) => {
			requestBodies.push(body);
			return createAnthropicThinking400() as never;
		}) as unknown as Anthropic["messages"]["create"];
		const client = { messages: { create } } as Anthropic;

		const result = await streamAnthropic(model, context, { client }).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(400);
		expect(requestBodies).toHaveLength(3);
	});

	it("retries once with thinking dropped from EVERY assistant turn after the invalid-signature 400", async () => {
		const user: UserMessage = {
			role: "user",
			content: "first",
			timestamp: Date.now(),
		};
		const context: Context = {
			messages: [
				user,
				makeSignedAssistant("early", "early answer"),
				{ ...user, content: "second", timestamp: Date.now() + 1 },
				makeSignedAssistant("late", "late answer"),
				{ ...user, content: "next prompt", timestamp: Date.now() + 2 },
			],
		};
		const requestBodies: unknown[] = [];
		let attempt = 0;
		const create = ((body: unknown) => {
			requestBodies.push(body);
			attempt += 1;
			return (attempt === 1 ? createAnthropicSignatureInvalid400() : createSuccessfulRequest()) as never;
		}) as unknown as Anthropic["messages"]["create"];
		const client = { messages: { create } } as Anthropic;

		const result = await streamAnthropic(model, context, { client }).result();

		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "recovered" }]);
		expect(requestBodies).toHaveLength(2);
		const firstBody = JSON.stringify(requestBodies[0]);
		expect(firstBody).toContain("sig_early");
		expect(firstBody).toContain("sig_late");
		// The repaired replay must drop the HISTORICAL signed block, not only the
		// latest one — a latest-only repair would resend sig_early and 400 again.
		const secondBody = JSON.stringify(requestBodies[1]);
		expect(secondBody).not.toContain("sig_early");
		expect(secondBody).not.toContain("sig_late");
		expect(secondBody).toContain("early answer");
		expect(secondBody).toContain("late answer");
	});

	it("stops after exactly two requests when the invalid-signature 400 persists", async () => {
		const user: UserMessage = {
			role: "user",
			content: "first",
			timestamp: Date.now(),
		};
		const context: Context = {
			messages: [
				user,
				makeSignedAssistant("early", "early answer"),
				{ ...user, content: "next prompt", timestamp: Date.now() + 1 },
			],
		};
		const requestBodies: unknown[] = [];
		const create = ((body: unknown) => {
			requestBodies.push(body);
			return createAnthropicSignatureInvalid400() as never;
		}) as unknown as Anthropic["messages"]["create"];
		const client = { messages: { create } } as Anthropic;

		const result = await streamAnthropic(model, context, { client }).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(400);
		expect(result.errorMessage).toContain("Invalid `signature`");
		expect(requestBodies).toHaveLength(2);
	});

	// A forced tool choice makes the request drop `thinking`; replaying signed thinking
	// blocks against a request that never enabled thinking is the shape Anthropic rejects
	// with "blocks in the latest assistant message cannot be modified".
	it("drops replayed native thinking when a forced tool choice disables thinking", async () => {
		const user: UserMessage = {
			role: "user",
			content: "first",
			timestamp: Date.now(),
		};
		const context: Context = {
			messages: [
				user,
				makeSignedAssistant("history", "history answer"),
				{ ...user, content: "next prompt", timestamp: Date.now() + 1 },
			],
			tools: [
				{
					name: "todo_write",
					description: "Write todos",
					parameters: { type: "object", properties: {}, additionalProperties: false },
				},
			],
		};
		const requestBodies: unknown[] = [];
		const create = ((body: unknown) => {
			requestBodies.push(body);
			return createSuccessfulRequest() as never;
		}) as unknown as Anthropic["messages"]["create"];
		const client = { messages: { create } } as Anthropic;

		const result = await streamAnthropic(model, context, {
			client,
			thinkingEnabled: true,
			toolChoice: { type: "tool", name: "todo_write" },
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(requestBodies).toHaveLength(1);
		const body = requestBodies[0] as { thinking?: unknown; tool_choice?: unknown };
		expect(body.tool_choice).toEqual({ type: "tool", name: "todo_write" });
		expect(body.thinking).toBeUndefined();
		const serialized = JSON.stringify(body);
		expect(serialized).not.toContain("sig_history");
		expect(serialized).not.toContain('"thinking"');
		// Reasoning text survives as context; only the signed native block is dropped.
		expect(serialized).toContain("history answer");
	});

	it("keeps replayed native thinking when the tool choice is not forced", async () => {
		const user: UserMessage = {
			role: "user",
			content: "first",
			timestamp: Date.now(),
		};
		const context: Context = {
			messages: [
				user,
				makeSignedAssistant("history", "history answer"),
				{ ...user, content: "next prompt", timestamp: Date.now() + 1 },
			],
		};
		const requestBodies: unknown[] = [];
		const create = ((body: unknown) => {
			requestBodies.push(body);
			return createSuccessfulRequest() as never;
		}) as unknown as Anthropic["messages"]["create"];
		const client = { messages: { create } } as Anthropic;

		await streamAnthropic(model, context, { client, thinkingEnabled: true, toolChoice: "auto" }).result();

		expect(JSON.stringify(requestBodies[0])).toContain("sig_history");
	});

	it("does not retry or scrub history for non-matching Anthropic 400 errors", async () => {
		const user: UserMessage = {
			role: "user",
			content: "continue",
			timestamp: Date.now(),
		};
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "synthetic thinking", thinkingSignature: "synthetic_sig" },
				{ type: "text", text: "visible answer" },
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
		const context: Context = {
			messages: [user, assistant, { ...user, content: "next prompt", timestamp: Date.now() + 1 }],
		};
		const requestBodies: unknown[] = [];
		const create = ((body: unknown) => {
			requestBodies.push(body);
			const error = new Error("400 invalid_request_error: max_tokens is too low");
			(error as { status?: number }).status = 400;
			throw error;
		}) as unknown as Anthropic["messages"]["create"];
		const client = { messages: { create } } as Anthropic;

		const result = await streamAnthropic(model, context, { client }).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(400);
		expect(result.errorMessage).toContain("max_tokens is too low");
		expect(requestBodies).toHaveLength(1);
		expect(JSON.stringify(requestBodies[0])).toContain("synthetic_sig");
	});

	describe("cumulative degradation across fallbacks", () => {
		beforeEach(() => clearToolChoiceIncapabilityRegistryForTests());

		const tool: Tool = {
			name: "read",
			description: "Read",
			parameters: { type: "object", properties: {}, additionalProperties: false },
		};

		const createForcedToolChoice400 = (): MockAnthropicRequest => ({
			async withResponse() {
				const error = new Error("400 invalid_request_error: tool_choice is not supported by this model");
				(error as { status?: number }).status = 400;
				throw error;
			},
		});

		const makeContext = (): Context => ({
			messages: [
				{ role: "user", content: "first", timestamp: Date.now() },
				makeSignedAssistant("history", "history answer"),
				{ role: "user", content: "next prompt", timestamp: Date.now() + 1 },
			],
			tools: [tool],
		});

		it("keeps thinking repair active when a later forced-tool_choice fallback rebuilds params", async () => {
			const requestBodies: unknown[] = [];
			let attempt = 0;
			const create = ((body: unknown) => {
				requestBodies.push(body);
				attempt += 1;
				if (attempt === 1) return createAnthropicSignatureInvalid400() as never;
				if (attempt === 2) return createForcedToolChoice400() as never;
				return createSuccessfulRequest() as never;
			}) as unknown as Anthropic["messages"]["create"];
			const client = { messages: { create } } as Anthropic;

			const result = await streamAnthropic(model, makeContext(), { client, toolChoice: "any" }).result();

			expect(result.stopReason).toBe("stop");
			expect(requestBodies).toHaveLength(3);
			// Signature repair activates on attempt 2; the forced-tool_choice fallback
			// rebuild (attempt 3) must not reintroduce the dropped signature, and must
			// drop the forced tool_choice.
			expect(JSON.stringify(requestBodies[1])).not.toContain("sig_history");
			const thirdBody = JSON.stringify(requestBodies[2]);
			expect(thirdBody).not.toContain("sig_history");
			expect(thirdBody).not.toContain("tool_choice");
			expect((requestBodies[2] as { tool_choice?: unknown }).tool_choice).toBeUndefined();
			expect(thirdBody).toContain("history answer");
		});

		it("keeps forced-tool_choice drop active when a later signature repair rebuilds params", async () => {
			const requestBodies: unknown[] = [];
			let attempt = 0;
			const create = ((body: unknown) => {
				requestBodies.push(body);
				attempt += 1;
				if (attempt === 1) return createForcedToolChoice400() as never;
				if (attempt === 2) return createAnthropicSignatureInvalid400() as never;
				return createSuccessfulRequest() as never;
			}) as unknown as Anthropic["messages"]["create"];
			const client = { messages: { create } } as Anthropic;

			const result = await streamAnthropic(model, makeContext(), { client, toolChoice: "any" }).result();

			expect(result.stopReason).toBe("stop");
			expect(requestBodies).toHaveLength(3);
			// Forced tool_choice is dropped from attempt 2 onward; the signature-repair
			// rebuild (attempt 3) must not reintroduce it, and must drop the signature.
			expect((requestBodies[1] as { tool_choice?: unknown }).tool_choice).toBeUndefined();
			const thirdBody = JSON.stringify(requestBodies[2]);
			expect(thirdBody).not.toContain("sig_history");
			expect((requestBodies[2] as { tool_choice?: unknown }).tool_choice).toBeUndefined();
			expect(thirdBody).toContain("history answer");
		});
	});
});
