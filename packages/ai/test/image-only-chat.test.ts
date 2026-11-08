import { describe, expect, test } from "bun:test";
import { IMAGE_ONLY_CHAT_MESSAGE, isImageOnlyModel } from "../src/models";
import { streamOpenAICodexResponses } from "../src/providers/openai-codex-responses";
import { streamOpenAIResponses } from "../src/providers/openai-responses";
import type { Context, Model } from "../src/types";

const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };

function model(provider: "openai" | "openai-codex", output?: Array<"text" | "image">): Model {
	return {
		id: "gpt-image-2.6-sunburst",
		name: "GPT Image 2.6 Sunburst",
		api: provider === "openai" ? "openai-responses" : "openai-codex-responses",
		provider,
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text"],
		output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	} as Model;
}

describe("image-only chat dispatch", () => {
	test("recognizes an image-only output list", () => {
		expect(isImageOnlyModel(model("openai", ["image"]))).toBe(true);
		expect(isImageOnlyModel(model("openai", ["text", "image"]))).toBe(false);
		expect(isImageOnlyModel(model("openai"))).toBe(false);
	});

	test("does not send a Responses request for an image-only model", async () => {
		let fetched = false;
		const result = await streamOpenAIResponses(model("openai", ["image"]) as Model<"openai-responses">, context, {
			apiKey: "test-key",
			fetch: async () => {
				fetched = true;
				throw new Error("fetch should not run");
			},
		}).result();

		expect(fetched).toBe(false);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe(IMAGE_ONLY_CHAT_MESSAGE);
	});

	test("does not send a Codex Responses request for an image-only model", async () => {
		let fetched = false;
		const result = await streamOpenAICodexResponses(
			model("openai-codex", ["image"]) as Model<"openai-codex-responses">,
			context,
			{
				apiKey: "test-key",
				fetch: async () => {
					fetched = true;
					throw new Error("fetch should not run");
				},
			},
		).result();

		expect(fetched).toBe(false);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe(IMAGE_ONLY_CHAT_MESSAGE);
	});
});
