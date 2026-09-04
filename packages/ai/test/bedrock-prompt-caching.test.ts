import { describe, expect, it } from "bun:test";
import { supportsPromptCaching } from "../src/providers/amazon-bedrock";
import type { Model } from "../src/types";

function bedrockModel(id: string, cachePriced = false): Model<"bedrock-converse-stream"> {
	return {
		id,
		name: id,
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "",
		reasoning: false,
		input: ["text"],
		cost: cachePriced
			? { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }
			: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	};
}

describe("Bedrock prompt caching support", () => {
	it("enables cache points for the documented 3.x pair", () => {
		expect(supportsPromptCaching(bedrockModel("anthropic.claude-3-5-haiku-20241022-v1:0"))).toBe(true);
		expect(supportsPromptCaching(bedrockModel("anthropic.claude-3-7-sonnet-20250219-v1:0"))).toBe(true);
	});

	it("keeps older and unversioned 3.x Claude models uncached", () => {
		expect(supportsPromptCaching(bedrockModel("anthropic.claude-3-opus-20240229-v1:0"))).toBe(false);
		// 3.5 Sonnet predates Bedrock cache points; only Haiku of that minor is documented.
		expect(supportsPromptCaching(bedrockModel("anthropic.claude-3-5-sonnet-20240620-v1:0"))).toBe(false);
		expect(supportsPromptCaching(bedrockModel("anthropic.claude-v2:0"))).toBe(false);
	});

	it("enables cache points for 4.x kind-first naming, including cross-region profiles", () => {
		expect(supportsPromptCaching(bedrockModel("anthropic.claude-opus-4-20250514-v1:0"))).toBe(true);
		expect(supportsPromptCaching(bedrockModel("anthropic.claude-sonnet-4-5-20250929-v1:0"))).toBe(true);
		expect(supportsPromptCaching(bedrockModel("us.anthropic.claude-haiku-4-5-20251001-v1:0"))).toBe(true);
		expect(supportsPromptCaching(bedrockModel("eu.anthropic.claude-3-7-sonnet-20250219-v1:0"))).toBe(true);
	});

	it("keeps covering future generations without a source patch", () => {
		expect(supportsPromptCaching(bedrockModel("us.anthropic.claude-opus-5-20300101-v1:0"))).toBe(true);
		expect(supportsPromptCaching(bedrockModel("eu.anthropic.claude-fable-5-20300101-v1:0"))).toBe(true);
		expect(supportsPromptCaching(bedrockModel("anthropic.claude-6-1-20400101-v1:0"))).toBe(true);
	});

	it("trusts catalog cache pricing for non-Claude models and excludes the rest", () => {
		expect(supportsPromptCaching(bedrockModel("amazon.nova-pro-v1", true))).toBe(true);
		expect(supportsPromptCaching(bedrockModel("amazon.nova-pro-v1"))).toBe(false);
		expect(supportsPromptCaching(bedrockModel("mistral.mistral-large-2407-v1:0"))).toBe(false);
	});
});
