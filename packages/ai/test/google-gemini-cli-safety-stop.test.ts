import { describe, expect, it } from "bun:test";
import { streamGoogleGeminiCli } from "../src/providers/google-gemini-cli";
import type { Context, Model } from "../src/types";
import { collectEvents, createSseResponse } from "./openai-tool-choice-test-helpers";

type GeminiCliProvider = "google-gemini-cli" | "google-antigravity";

const providers: GeminiCliProvider[] = ["google-gemini-cli", "google-antigravity"];
const context: Context = {
	messages: [{ role: "user", content: "hi", timestamp: 0 }],
	tools: [],
};

function createModel(provider: GeminiCliProvider): Model<"google-gemini-cli"> {
	return {
		id: "gemini-test",
		name: "Gemini Test",
		api: "google-gemini-cli",
		provider,
		baseUrl: "https://gemini-cli.example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
	};
}
function createSseResponseWithUrl(chunks: unknown[]): Response {
	const response = createSseResponse(chunks);
	Object.defineProperty(response, "url", {
		value: "https://gemini-cli.example.test/stream",
	});
	return response;
}

async function streamResponse(provider: GeminiCliProvider, chunks: unknown[]) {
	let requestCount = 0;
	const stream = streamGoogleGeminiCli(createModel(provider), context, {
		apiKey: JSON.stringify({ token: "token", projectId: "project" }),
		fetch: async () => {
			requestCount += 1;
			return createSseResponseWithUrl(chunks);
		},
	});

	const events = await collectEvents(stream);
	return { events, requestCount, result: await stream.result() };
}

describe("Google Gemini CLI safety stops", () => {
	it("keeps safety-finished tool calls as typed errors for both OAuth providers", async () => {
		for (const provider of providers) {
			const { result } = await streamResponse(provider, [
				{
					response: {
						candidates: [
							{
								content: {
									role: "model",
									parts: [{ functionCall: { name: "read", args: { path: "README.md" } } }],
								},
								finishReason: "SAFETY",
							},
						],
					},
				},
			]);

			expect(result.content.some(block => block.type === "toolCall")).toBe(true);
			expect(result.errorKind).toBe("provider_safety_stop");
			expect(result.stopReason).toBe("error");
		}
	});

	it("does not empty-retry a prompt safety block for both OAuth providers", async () => {
		for (const provider of providers) {
			const { requestCount, result } = await streamResponse(provider, [
				{ response: { promptFeedback: { blockReason: "SAFETY" } } },
			]);

			expect(requestCount).toBe(1);
			expect(result.errorKind).toBe("provider_safety_stop");
			expect(result.stopReason).toBe("error");
		}
	});
	it("does not empty-retry a candidate safety finish without content for both OAuth providers", async () => {
		for (const provider of providers) {
			const { requestCount, result } = await streamResponse(provider, [
				{ response: { candidates: [{ finishReason: "SAFETY" }] } },
			]);

			expect(requestCount).toBe(1);
			expect(result.errorKind).toBe("provider_safety_stop");
			expect(result.stopReason).toBe("error");
		}
	});

	it("keeps non-safety prompt blocks generic and untyped for both OAuth providers", async () => {
		for (const provider of providers) {
			const { requestCount, result } = await streamResponse(provider, [
				{ response: { promptFeedback: { blockReason: "OTHER" } } },
			]);

			expect(requestCount).toBe(1);
			expect(result.errorKind).toBeUndefined();
			expect(result.stopReason).toBe("error");
		}
	});

	it("keeps a typed safety stop after a later benign finish for both OAuth providers", async () => {
		for (const provider of providers) {
			const { requestCount, result } = await streamResponse(provider, [
				{ response: { candidates: [{ finishReason: "SAFETY" }] } },
				{ response: { candidates: [{ finishReason: "STOP" }] } },
			]);

			expect(requestCount).toBe(1);
			expect(result.errorKind).toBe("provider_safety_stop");
			expect(result.stopReason).toBe("error");
		}
	});
});
