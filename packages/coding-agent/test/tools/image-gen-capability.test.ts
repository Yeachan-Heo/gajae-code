import { describe, expect, it } from "bun:test";
import type { Api, Model } from "@gajae-code/ai";
import { isOpenAIHostedImageModel } from "@gajae-code/coding-agent/tools/image-gen";

function model<TApi extends Api>(
	overrides: Partial<Model<TApi>> & Pick<Model<TApi>, "id" | "api" | "provider">,
): Model<TApi> {
	return {
		name: overrides.id,
		baseUrl: "https://proxy.example/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
		...overrides,
	} as Model<TApi>;
}

describe("isOpenAIHostedImageModel", () => {
	it("accepts first-party OpenAI GPT/o3 Responses models (unchanged)", () => {
		expect(isOpenAIHostedImageModel(model({ id: "gpt-5.5", api: "openai-responses", provider: "openai" }))).toBe(
			true,
		);
		expect(
			isOpenAIHostedImageModel(model({ id: "o3", api: "openai-codex-responses", provider: "openai-codex" })),
		).toBe(true);
	});

	it("accepts any provider whose Responses model declares image output", () => {
		expect(
			isOpenAIHostedImageModel(
				model({ id: "gpt-5.5", api: "openai-responses", provider: "layofflabs", output: ["text", "image"] }),
			),
		).toBe(true);
	});

	it("rejects a custom Responses model that does not declare image output", () => {
		expect(isOpenAIHostedImageModel(model({ id: "gpt-5.5", api: "openai-responses", provider: "layofflabs" }))).toBe(
			false,
		);
	});

	it("rejects image output declared over a non-Responses API", () => {
		expect(
			isOpenAIHostedImageModel(
				model({ id: "gpt-image-2", api: "openai-completions", provider: "layofflabs", output: ["text", "image"] }),
			),
		).toBe(false);
	});

	it("rejects a non-GPT first-party model without declared image output", () => {
		expect(
			isOpenAIHostedImageModel(model({ id: "text-embedding-3", api: "openai-responses", provider: "openai" })),
		).toBe(false);
	});

	it("rejects undefined", () => {
		expect(isOpenAIHostedImageModel(undefined)).toBe(false);
	});
});
