import { describe, expect, it } from "bun:test";
import { Effort } from "@gajae-code/ai/model-thinking";
import { streamAnthropic } from "@gajae-code/ai/providers/anthropic";
import { streamSimple } from "@gajae-code/ai/stream";
import type { AssistantMessage, Context, Message, Model, ToolResultMessage, UserMessage } from "@gajae-code/ai/types";
import { createAbortedSignal } from "./helpers";

// Thinking signatures and redacted thinking are bound to the stored credential
// that minted them (omp 7106a00f61, 4308d0156d). Earlier foreign-credential turns
// lose their private blocks; a foreign-credential latest turn cannot lose a block
// (Anthropic rejects it), so the whole replay degrades like the existing
// unreplayable-thinking pre-check (anthropic-unreplayable-thinking.test.ts).

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

type Payload = { messages: unknown[] };

/** Build the request the provider would send, without letting it leave the process. */
function capturePayload(messages: Message[], credentialId: number | undefined): Promise<Payload> {
	const context: Context = { systemPrompt: ["Stay concise."], messages };
	const { promise, resolve } = Promise.withResolvers<Payload>();
	streamAnthropic(model, context, {
		apiKey: "sk-ant-oat-test",
		isOAuth: true,
		thinkingEnabled: true,
		credentialId,
		signal: createAbortedSignal(),
		onPayload: payload => resolve(payload as Payload),
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
	credentialId: number | undefined,
): AssistantMessage {
	return {
		role: "assistant",
		content: [...content, { type: "toolCall", id: toolId, name: "bash", arguments: { command: "echo hi" } }],
		api: "anthropic-messages",
		provider: model.provider,
		model: model.id,
		usage,
		stopReason: "toolUse",
		timestamp: Date.now(),
		...(credentialId === undefined ? {} : { credentialId }),
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
const SIGNED_A = { type: "thinking" as const, thinking: "row A reasoning", thinkingSignature: "sig_row_a" };
const REDACTED_A = { type: "redactedThinking" as const, data: "redacted_row_a" };
const SIGNED_B = { type: "thinking" as const, thinking: "row B reasoning", thinkingSignature: "sig_row_b" };

function history(earlierRow: number, latestRow: number): Message[] {
	return [
		user,
		// Text keeps the two private blocks apart so the adjacency collapse leaves both.
		assistantTurn([SIGNED_A, { type: "text", text: "between" }, REDACTED_A], "toolu_a", earlierRow),
		toolResult("toolu_a"),
		{ ...user, content: "again", timestamp: Date.now() + 1 },
		assistantTurn([SIGNED_B], "toolu_b", latestRow),
		toolResult("toolu_b"),
	];
}

function nativeThinkingCount(payload: Payload): number {
	let count = 0;
	for (const message of payload.messages as Array<{ content?: unknown }>) {
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content as Array<{ type?: string }>) {
			if (block.type === "thinking" || block.type === "redacted_thinking") count++;
		}
	}
	return count;
}

describe("Anthropic request build with credential-bound thinking", () => {
	it("drops an earlier turn's signature and redacted thinking minted under another credential", async () => {
		const payload = await capturePayload(history(5, 7), 7);
		const wire = JSON.stringify(payload.messages);

		expect(wire).not.toContain("sig_row_a");
		expect(wire).not.toContain("redacted_row_a");
		// The latest turn belongs to this credential and keeps its signed thinking.
		expect(wire).toContain("sig_row_b");
		expect(nativeThinkingCount(payload)).toBe(1);
	});

	it("keeps every signature when the whole history belongs to this credential (guard)", async () => {
		const payload = await capturePayload(history(5, 5), 5);
		const wire = JSON.stringify(payload.messages);

		expect(wire).toContain("sig_row_a");
		expect(wire).toContain("redacted_row_a");
		expect(wire).toContain("sig_row_b");
		expect(nativeThinkingCount(payload)).toBe(3);
	});

	it("degrades the whole replay when the latest turn was minted under another credential", async () => {
		// Same shape as the unreplayable latest-turn degrade: no native thinking at all.
		const payload = await capturePayload(history(7, 5), 7);
		const wire = JSON.stringify(payload.messages);

		expect(nativeThinkingCount(payload)).toBe(0);
		expect(wire).not.toContain("sig_row_b");
		expect(wire).not.toContain("sig_row_a");
		// Tool-use continuity is preserved.
		expect(wire).toContain("toolu_b");
	});

	it("keeps legacy replay when the request credential is unknown (guard)", async () => {
		const payload = await capturePayload(history(5, 7), undefined);

		expect(nativeThinkingCount(payload)).toBe(3);
	});

	it("degrades for a foreign-credential Claude latest turn served by another provider", async () => {
		const messages = history(7, 5);
		messages[4] = { ...(messages[4] as AssistantMessage), provider: "claude-proxy", model: "claude-opus-5" };
		const payload = await capturePayload(messages, 7);

		expect(nativeThinkingCount(payload)).toBe(0);
	});

	it("keeps the model-switch replay for another provider's non-Claude latest turn (guard)", async () => {
		const messages = history(7, 5);
		messages[4] = { ...(messages[4] as AssistantMessage), provider: "kimi-code", model: "kimi-k2" };
		const payload = await capturePayload(messages, 7);

		// omp 4308d0156d: no account binding governs another provider's non-Claude reasoning.
		expect(JSON.stringify(payload.messages)).toContain("sig_row_b");
	});

	it("receives the request credential through streamSimple", async () => {
		const { promise, resolve } = Promise.withResolvers<Payload>();
		streamSimple(
			model,
			{ systemPrompt: ["Stay concise."], messages: history(5, 7) },
			{
				apiKey: "sk-ant-oat-test",
				credentialId: 7,
				reasoning: Effort.High,
				signal: createAbortedSignal(),
				onPayload: payload => resolve(payload as Payload),
			},
		);
		const wire = JSON.stringify((await promise).messages);

		expect(wire).not.toContain("sig_row_a");
		expect(wire).toContain("sig_row_b");
	});
});
