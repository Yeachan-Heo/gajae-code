import { describe, expect, it } from "bun:test";
import { transformMessages } from "@gajae-code/ai/providers/transform-messages";
import type { AssistantMessage, Message, Model, UserMessage } from "@gajae-code/ai/types";

// Anthropic thinking signatures and redacted thinking are bound to the stored
// credential (account) that minted them. An earlier turn replayed to a signing
// Anthropic target under another credential must not carry them (omp 7106a00f61,
// refined by 4308d0156d). The latest turn is handled by the provider pre-check.

const claudeModel: Model<"anthropic-messages"> = {
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

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const user: UserMessage = { role: "user", content: "go", timestamp: 0 };

function assistantTurn(
	overrides: Partial<AssistantMessage> & Pick<AssistantMessage, "provider" | "model" | "api">,
): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "earlier reasoning", thinkingSignature: "sig_earlier" },
			{ type: "redactedThinking", data: "redacted_earlier" },
			{ type: "text", text: "earlier answer" },
		],
		usage,
		stopReason: "stop",
		timestamp: 0,
		...overrides,
	};
}

const claudeTurn = (credentialId: number | undefined): AssistantMessage =>
	assistantTurn({
		api: "anthropic-messages",
		provider: "anthropic",
		model: claudeModel.id,
		...(credentialId === undefined ? {} : { credentialId }),
	});

/** Replay `earlier` as a non-latest turn, followed by a later same-credential turn. */
function replay(
	earlier: AssistantMessage,
	options: { signingAnthropicTarget?: boolean; targetCredentialId?: number },
): AssistantMessage {
	const latest: AssistantMessage = {
		...claudeTurn(options.targetCredentialId),
		content: [{ type: "text", text: "latest answer" }],
	};
	const messages: Message[] = [user, earlier, { ...user, content: "again" }, latest];
	const out = transformMessages(messages, claudeModel, undefined, options);
	return out[1] as AssistantMessage;
}

const blockTypes = (message: AssistantMessage) => message.content.map(block => block.type);

describe("transformMessages credential-bound thinking", () => {
	it("drops an earlier Claude turn's thinking and redacted thinking minted under another credential", () => {
		const out = replay(claudeTurn(5), { signingAnthropicTarget: true, targetCredentialId: 7 });

		expect(blockTypes(out)).toEqual(["text"]);
		expect(JSON.stringify(out)).not.toContain("sig_earlier");
		expect(JSON.stringify(out)).not.toContain("redacted_earlier");
	});

	it("keeps the blocks when the turn was minted under the same credential (guard)", () => {
		const out = replay(claudeTurn(5), { signingAnthropicTarget: true, targetCredentialId: 5 });

		expect(blockTypes(out)).toEqual(["thinking", "redactedThinking", "text"]);
	});

	it("keeps legacy replay when either side's provenance is unknown (guard)", () => {
		expect(
			blockTypes(replay(claudeTurn(undefined), { signingAnthropicTarget: true, targetCredentialId: 7 })),
		).toEqual(["thinking", "redactedThinking", "text"]);
		expect(blockTypes(replay(claudeTurn(5), { signingAnthropicTarget: true }))).toEqual([
			"thinking",
			"redactedThinking",
			"text",
		]);
	});

	it("leaves a non-signing target unchanged (guard)", () => {
		const out = replay(claudeTurn(5), { signingAnthropicTarget: false, targetCredentialId: 7 });

		expect(blockTypes(out)).toEqual(["thinking", "redactedThinking", "text"]);
	});

	it("keeps a non-Claude turn's visible thinking as demoted text (guard)", () => {
		const kimiTurn = assistantTurn({
			api: "openai-completions",
			provider: "kimi",
			model: "kimi-k2",
			credentialId: 5,
		});
		const out = replay(kimiTurn, { signingAnthropicTarget: true, targetCredentialId: 7 });

		// Another provider's reasoning replays as plain text like any model switch;
		// its opaque redacted payload never replays across models.
		expect(out.content).toEqual([
			{ type: "text", text: "earlier reasoning" },
			{ type: "text", text: "earlier answer" },
		]);
	});

	it("leaves the latest turn intact for the provider's whole-replay degrade (guard)", () => {
		const latestForeign = claudeTurn(5);
		const out = transformMessages([user, latestForeign], claudeModel, undefined, {
			signingAnthropicTarget: true,
			targetCredentialId: 7,
		});

		expect(blockTypes(out[1] as AssistantMessage)).toEqual(["thinking", "redactedThinking", "text"]);
	});
});
