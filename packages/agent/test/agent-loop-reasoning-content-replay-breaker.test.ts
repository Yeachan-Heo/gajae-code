import { describe, expect, it } from "bun:test";
import { agentLoop } from "@gajae-code/agent-core/agent-loop";
import type { AgentContext, AgentLoopConfig, AgentMessage } from "@gajae-code/agent-core/types";
import type { AssistantMessage, Message } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { createUserMessage } from "./helpers";

// DeepSeek-family reasoning-content replay rejection. The proxy strips the
// encrypted reasoning blob to `""`; replaying it 400s deterministically, so the
// bounded circuit breaker must strip the unusable reasoning items and resend
// exactly once. Mirrors the invalid_prompt breaker's contract.

const REASONING_REPLAY_ERROR =
	"400 Error from provider (Console): Upstream request failed: [invalid_request_error] The `reasoning_content` in the thinking mode must be passed back to the API.";

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

async function drain(stream: AsyncIterable<unknown> & { result(): Promise<AgentMessage[]> }): Promise<AgentMessage[]> {
	for await (const _ of stream) {
		/* consume */
	}
	return stream.result();
}

/** An assistant message carrying a Responses history payload with unusable reasoning items. */
function assistantWithStrippedReasoning(provider = "mock"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "prior assistant turn" }],
		api: "openai-responses",
		provider,
		model: "deepseek-v4-flash",
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
		providerPayload: {
			type: "openaiResponsesHistory",
			provider,
			dt: true,
			items: [
				{
					type: "reasoning",
					encrypted_content: "",
					summary: [{ type: "summary_text", text: "stripped reasoning summary" }],
				},
				{ type: "output_text", text: "prior assistant turn" },
			],
		},
	};
}

describe("agentLoop reasoning-content replay circuit breaker", () => {
	it("strips unusable reasoning items and resends EXACTLY once", async () => {
		const seeded = assistantWithStrippedReasoning();
		const prompt = createUserMessage("next turn");
		const context: AgentContext = {
			systemPrompt: ["sys"],
			messages: [seeded],
			tools: [],
		};
		const mock = createMockModel({
			responses: [{ throw: REASONING_REPLAY_ERROR }, { content: ["recovered"] }],
		});
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const messages = await drain(agentLoop([prompt], context, config, undefined, mock.stream));

		// Exactly 2 provider requests: initial rejected send + one repaired resend.
		expect(mock.calls.length).toBe(2);
		const last = messages[messages.length - 1];
		expect(last.role).toBe("assistant");
		if (last.role !== "assistant") throw new Error("expected assistant");
		expect(last.stopReason).toBe("stop");
		expect(last.content).toEqual([{ type: "text", text: "recovered" }]);

		// The seeded reasoning item with empty encrypted_content must be stripped
		// in place so a durable resume no longer carries the poison.
		const payload = seeded.providerPayload;
		expect(payload?.type).toBe("openaiResponsesHistory");
		const reasoningItems = payload?.items.filter(i => i.type === "reasoning") ?? [];
		expect(reasoningItems).toEqual([]);
	});

	it("does NOT replay the rejected assistant turn on the repaired resend", async () => {
		const seeded = assistantWithStrippedReasoning();
		const prompt = createUserMessage("next turn");
		const context: AgentContext = {
			systemPrompt: ["sys"],
			messages: [seeded],
			tools: [],
		};
		const mock = createMockModel({
			responses: [{ throw: REASONING_REPLAY_ERROR }, { content: ["recovered"] }],
		});
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		await drain(agentLoop([prompt], context, config, undefined, mock.stream));

		expect(mock.calls.length).toBe(2);
		// The repaired resend carries the seeded assistant + new user prompt, but NOT
		// the rejected assistant turn from the first (failed) provider call.
		expect(mock.calls[1].context.messages.map(m => m.role)).toEqual(["assistant", "user"]);
	});

	it("fails fast with EXACTLY one request when there are no reasoning items to strip", async () => {
		// History with only non-reasoning items — stripping cannot change anything,
		// so the breaker must not spend a resend budget.
		const seededWithoutReasoning: AssistantMessage = {
			...assistantWithStrippedReasoning(),
			providerPayload: {
				type: "openaiResponsesHistory",
				provider: "mock",
				dt: true,
				items: [{ type: "output_text", text: "prior assistant turn" }],
			},
		};
		const prompt = createUserMessage("next turn");
		const context: AgentContext = {
			systemPrompt: ["sys"],
			messages: [seededWithoutReasoning],
			tools: [],
		};
		const mock = createMockModel({ responses: [{ throw: REASONING_REPLAY_ERROR }] });
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const messages = await drain(agentLoop([prompt], context, config, undefined, mock.stream));

		expect(mock.calls.length).toBe(1);
		const last = messages[messages.length - 1];
		if (last.role !== "assistant") throw new Error("expected assistant");
		expect(last.stopReason).toBe("error");
		expect(last.errorMessage).toBe(REASONING_REPLAY_ERROR);
		// Non-reasoning items are untouched.
		expect(seededWithoutReasoning.providerPayload?.items.length).toBe(1);
	});

	it("spends the repair budget only once even if the error recurs (budget=1)", async () => {
		const seeded = assistantWithStrippedReasoning();
		const prompt = createUserMessage("next turn");
		const context: AgentContext = {
			systemPrompt: ["sys"],
			messages: [seeded],
			tools: [],
		};
		const mock = createMockModel({
			responses: [
				{ throw: REASONING_REPLAY_ERROR },
				{ throw: REASONING_REPLAY_ERROR },
				{ content: ["never reached"] },
			],
		});
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const messages = await drain(agentLoop([prompt], context, config, undefined, mock.stream));

		// Initial send + exactly one repaired resend, then durable fail-fast.
		expect(mock.calls.length).toBe(2);
		const last = messages[messages.length - 1];
		if (last.role !== "assistant") throw new Error("expected assistant");
		expect(last.stopReason).toBe("error");
		expect(last.errorMessage).toBe(REASONING_REPLAY_ERROR);
	});

	it("does NOT trigger on non-reasoning-content errors (negative)", async () => {
		const seeded = assistantWithStrippedReasoning();
		const prompt = createUserMessage("next turn");
		const context: AgentContext = {
			systemPrompt: ["sys"],
			messages: [seeded],
			tools: [],
		};
		const mock = createMockModel({ responses: [{ throw: "The server had an error (code=server_error)" }] });
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const messages = await drain(agentLoop([prompt], context, config, undefined, mock.stream));

		expect(mock.calls.length).toBe(1);
		const last = messages[messages.length - 1];
		if (last.role !== "assistant") throw new Error("expected assistant");
		expect(last.stopReason).toBe("error");
		// The reasoning item is untouched for non-reasoning-content faults.
		const reasoningItems = seeded.providerPayload?.items.filter(i => i.type === "reasoning") ?? [];
		expect(reasoningItems.length).toBe(1);
	});

	it("preserves reasoning items that DO have non-empty encrypted_content", async () => {
		// A reasoning item with a real (non-empty) encrypted_content is NOT poison:
		// the breaker must not strip it, and since stripping changed nothing, no
		// resend is spent.
		const seeded: AssistantMessage = {
			...assistantWithStrippedReasoning(),
			providerPayload: {
				type: "openaiResponsesHistory",
				provider: "mock",
				dt: true,
				items: [
					{
						type: "reasoning",
						encrypted_content: "OpaqueBlobSignatureData==",
						summary: [{ type: "summary_text", text: "valid reasoning summary" }],
					},
					{ type: "output_text", text: "prior assistant turn" },
				],
			},
		};
		const prompt = createUserMessage("next turn");
		const context: AgentContext = {
			systemPrompt: ["sys"],
			messages: [seeded],
			tools: [],
		};
		const mock = createMockModel({ responses: [{ throw: REASONING_REPLAY_ERROR }] });
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		await drain(agentLoop([prompt], context, config, undefined, mock.stream));

		expect(mock.calls.length).toBe(1);
		// The valid reasoning item is preserved.
		const reasoningItems = seeded.providerPayload?.items.filter(i => i.type === "reasoning") ?? [];
		expect(reasoningItems.length).toBe(1);
	});
});
