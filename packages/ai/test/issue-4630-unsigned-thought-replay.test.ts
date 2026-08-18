import { describe, expect, it } from "bun:test";
import { convertMessages } from "../src/providers/google-shared";
import type { AssistantMessage, Context, Model, Usage } from "../src/types";

const emptyUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function createGeminiCliModel(
	provider: "google-gemini-cli" | "google-antigravity",
	id: string,
): Model<"google-gemini-cli"> {
	return {
		id,
		name: id,
		api: "google-gemini-cli",
		provider,
		baseUrl: "https://cloudcode-pa.googleapis.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 65_536,
	};
}

function makeAssistant(model: Model<"google-gemini-cli">, content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "google-gemini-cli",
		provider: model.provider,
		model: model.id,
		usage: emptyUsage,
		stopReason: "stop",
		timestamp: 2,
	};
}

function signedThinking(): AssistantMessage["content"] {
	return [
		{ type: "thinking", thinking: "I should inspect the file first.", thinkingSignature: "c2lnbmF0dXJl" },
		{ type: "text", text: "Reading the file now." },
	];
}

/**
 * Issue #4630: resumed google-antigravity sessions replay assistant thinking
 * parts as `{"thought": true}` with no `thoughtSignature` (persisted signatures
 * are cleared when oversized, and older sessions never captured one). Cloud
 * Code Assist maps `thought: true` to an Anthropic `thinking` block and
 * rejects the whole request with
 * `messages.N.content.0.thinking.signature: Field required`, permanently
 * bricking the session.
 */
describe("issue #4630 unsigned thought replay repair (google-gemini-cli)", () => {
	it("degrades same-provider unsigned thinking to plain text for Claude models", () => {
		const model = createGeminiCliModel("google-antigravity", "claude-opus-4-6-thinking");
		const assistant = makeAssistant(model, [
			{ type: "thinking", thinking: "I should inspect the file first." },
			{ type: "text", text: "Reading the file now." },
		]);
		const context: Context = {
			messages: [assistant, { role: "user", content: "continue", timestamp: 3 }],
		};

		const contents = convertMessages(model, context);
		const parts = contents.flatMap(content => content.parts ?? []);
		expect(parts.some(part => part.thought === true)).toBe(false);
		expect(parts.some(part => part.thoughtSignature !== undefined)).toBe(false);
		expect(parts).toContainEqual({ text: "I should inspect the file first." });
		expect(parts).toContainEqual({ text: "Reading the file now." });
	});

	it("degrades same-provider empty-string-signature thinking to plain text for Claude models", () => {
		// Persistence clears oversized thinkingSignature to "" (#4630 persisted-session shape).
		const model = createGeminiCliModel("google-antigravity", "claude-opus-4-6-thinking");
		const assistant = makeAssistant(model, [
			{ type: "thinking", thinking: "I should inspect the file first.", thinkingSignature: "" },
		]);
		const context: Context = { messages: [assistant] };

		const contents = convertMessages(model, context);
		const parts = contents.flatMap(content => content.parts ?? []);
		expect(parts.some(part => part.thought === true)).toBe(false);
		expect(parts.some(part => part.thoughtSignature !== undefined)).toBe(false);
		expect(parts).toContainEqual({ text: "I should inspect the file first." });
	});

	it("degrades invalid (non-base64) signature thinking to plain text for Claude models", () => {
		const model = createGeminiCliModel("google-antigravity", "claude-opus-4-6-thinking");
		const assistant = makeAssistant(model, [
			{ type: "thinking", thinking: "Hmm", thinkingSignature: "not base64!!" },
		]);
		const context: Context = { messages: [assistant] };

		const contents = convertMessages(model, context);
		const parts = contents.flatMap(content => content.parts ?? []);
		expect(parts.some(part => part.thought === true)).toBe(false);
		expect(parts).toContainEqual({ text: "Hmm" });
	});

	it("preserves validly signed same-provider thinking as thought parts for Claude models", () => {
		const model = createGeminiCliModel("google-antigravity", "claude-opus-4-6-thinking");
		const assistant = makeAssistant(model, signedThinking());
		const context: Context = { messages: [assistant] };

		const contents = convertMessages(model, context);
		const parts = contents.flatMap(content => content.parts ?? []);
		expect(parts).toContainEqual({
			thought: true,
			text: "I should inspect the file first.",
			thoughtSignature: "c2lnbmF0dXJl",
		});
		expect(parts).toContainEqual({ text: "Reading the file now." });
	});

	it("degrades unsigned same-provider thinking to plain text for Gemini models too", () => {
		// Gemini native replay also cannot round-trip thought:true without a
		// signature; the unsigned marker would violate the thought-signature
		// replay contract on every provider using this converter.
		const model = createGeminiCliModel("google-antigravity", "gemini-3-pro-preview");
		const assistant = makeAssistant(model, [{ type: "thinking", thinking: "Plan the answer." }]);
		const context: Context = { messages: [assistant] };

		const contents = convertMessages(model, context);
		const parts = contents.flatMap(content => content.parts ?? []);
		expect(parts.some(part => part.thought === true)).toBe(false);
		expect(parts).toContainEqual({ text: "Plan the answer." });
	});

	it("preserves validly signed same-provider thinking for Gemini models", () => {
		const model = createGeminiCliModel("google-antigravity", "gemini-3-pro-preview");
		const assistant = makeAssistant(model, [
			{ type: "thinking", thinking: "Plan the answer.", thinkingSignature: "c2lnbmF0dXJl" },
		]);
		const context: Context = { messages: [assistant] };

		const contents = convertMessages(model, context);
		const parts = contents.flatMap(content => content.parts ?? []);
		expect(parts).toContainEqual({
			thought: true,
			text: "Plan the answer.",
			thoughtSignature: "c2lnbmF0dXJl",
		});
	});
});
