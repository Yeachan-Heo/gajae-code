import { describe, expect, it } from "bun:test";
import { streamAnthropic } from "@gajae-code/ai/providers/anthropic";
import type { AssistantMessage, Context, Message, Model, ToolResultMessage, UserMessage } from "@gajae-code/ai/types";

const model: Model<"anthropic-messages"> = {
	api: "anthropic-messages",
	provider: "anthropic",
	id: "claude-opus-5",
	name: "Claude Opus 5",
	baseUrl: "https://api.anthropic.com",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	maxTokens: 8_192,
	contextWindow: 200_000,
	reasoning: true,
};
const deepseekModel: Model<"anthropic-messages"> = {
	...model,
	provider: "deepseek",
	id: "deepseek-chat",
	name: "DeepSeek Chat",
	baseUrl: "https://api.deepseek.com",
};

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

/** Build the request the provider would send, without letting it leave the process. */
function capturePayload(
	messages: Message[],
	activeModel: Model<"anthropic-messages"> = model,
): Promise<{ messages: unknown[] }> {
	const context: Context = { systemPrompt: ["Stay concise."], messages };
	const { promise, resolve } = Promise.withResolvers<{ messages: unknown[] }>();
	streamAnthropic(activeModel, context, {
		apiKey: "sk-ant-oat-test",
		isOAuth: true,
		thinkingEnabled: true,
		signal: abortedSignal(),
		onPayload: payload => resolve(payload as { messages: unknown[] }),
	});
	return promise;
}

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantTurn(
	content: AssistantMessage["content"],
	toolId: string,
	activeModel: Model<"anthropic-messages"> = model,
): AssistantMessage {
	return {
		role: "assistant",
		content: [...content, { type: "toolCall", id: toolId, name: "bash", arguments: { command: "echo hi" } }],
		api: "anthropic-messages",
		provider: activeModel.provider,
		model: activeModel.id,
		usage,
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function toolResult(toolId: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: toolId,
		toolName: "bash",
		content: [{ type: "text", text: "hi" }],
		isError: false,
		timestamp: Date.now(),
	} as ToolResultMessage;
}

const user: UserMessage = { role: "user", content: "go", timestamp: Date.now() };

/** A block Anthropic opened and closed without ever sending content or a signature. */
const HOLLOW_THINKING = { type: "thinking" as const, thinking: "", thinkingSignature: "" };
const SIGNED_EARLY = { type: "thinking" as const, thinking: "early reasoning", thinkingSignature: "sig_early" };
const SIGNED_LATE = { type: "thinking" as const, thinking: "late reasoning", thinkingSignature: "sig_late" };
/** A block with empty text but a valid signature — natively replayable via the signed-thinking path. */
const SIGNED_EMPTY = { type: "thinking" as const, thinking: "", thinkingSignature: "sig_empty" };

function nativeThinkingCount(payload: { messages: unknown[] }): number {
	let count = 0;
	for (const message of payload.messages) {
		const content = (message as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			const type = (block as { type?: string }).type;
			if (type === "thinking" || type === "redacted_thinking") count++;
		}
	}
	return count;
}

describe("Anthropic unreplayable latest-assistant thinking", () => {
	it("degrades the whole replay when the latest assistant turn lost its thinking block", async () => {
		const payload = await capturePayload([
			user,
			assistantTurn([SIGNED_EARLY], "toolu_a"),
			toolResult("toolu_a"),
			{ ...user, content: "again", timestamp: Date.now() + 1 },
			assistantTurn([HOLLOW_THINKING], "toolu_b"),
			toolResult("toolu_b"),
		]);

		// The hollow block cannot go back on the wire, and Anthropic rejects the turn
		// for arriving without it — so no native thinking is replayed at all.
		expect(nativeThinkingCount(payload)).toBe(0);
		expect(JSON.stringify(payload.messages)).not.toContain("sig_early");
	});

	it("keeps native thinking when the latest assistant turn replays faithfully", async () => {
		const payload = await capturePayload([
			user,
			assistantTurn([SIGNED_EARLY], "toolu_a"),
			toolResult("toolu_a"),
			{ ...user, content: "again", timestamp: Date.now() + 1 },
			assistantTurn([SIGNED_LATE], "toolu_b"),
			toolResult("toolu_b"),
		]);

		expect(nativeThinkingCount(payload)).toBe(2);
		expect(JSON.stringify(payload.messages)).toContain("sig_late");
	});

	it("does not degrade when only an earlier turn is unreplayable", async () => {
		const payload = await capturePayload([
			user,
			assistantTurn([HOLLOW_THINKING], "toolu_a"),
			toolResult("toolu_a"),
			{ ...user, content: "again", timestamp: Date.now() + 1 },
			assistantTurn([SIGNED_LATE], "toolu_b"),
			toolResult("toolu_b"),
		]);

		// Anthropic only validates the latest assistant message against its own
		// output, so an older hollow block must not cost the rest of the replay.
		expect(JSON.stringify(payload.messages)).toContain("sig_late");
		expect(nativeThinkingCount(payload)).toBe(1);
	});

	it("does not degrade a non-signing endpoint whose latest turn has hollow thinking", async () => {
		const payload = await capturePayload(
			[
				user,
				assistantTurn([SIGNED_EARLY], "toolu_a", deepseekModel),
				toolResult("toolu_a"),
				{ ...user, content: "again", timestamp: Date.now() + 1 },
				assistantTurn([HOLLOW_THINKING], "toolu_b", deepseekModel),
				toolResult("toolu_b"),
			],
			deepseekModel,
		);

		// DeepSeek never signs thinking and does not validate thinking presence, so
		// a hollow latest block is harmless and earlier reasoning must survive.
		expect(JSON.stringify(payload.messages)).toContain("sig_early");
	});

	it("does not degrade when the latest turn has signed-but-empty thinking", async () => {
		const payload = await capturePayload([
			user,
			assistantTurn([SIGNED_EARLY], "toolu_a"),
			toolResult("toolu_a"),
			{ ...user, content: "again", timestamp: Date.now() + 1 },
			assistantTurn([SIGNED_EMPTY], "toolu_b"),
			toolResult("toolu_b"),
		]);

		// A block with empty text but a valid signature is natively replayable —
		// convertAnthropicMessages forwards it via the signed-thinking path — so
		// both signed blocks are preserved.
		expect(nativeThinkingCount(payload)).toBe(2);
		expect(JSON.stringify(payload.messages)).toContain("sig_empty");
	});
});
