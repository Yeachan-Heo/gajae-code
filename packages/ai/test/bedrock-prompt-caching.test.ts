import { describe, expect, it } from "bun:test";
import { getBundledModels } from "../src/models";
import { parseBedrockClaudeGeneration, supportsPromptCaching } from "../src/providers/amazon-bedrock";
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

// Pre-3.5 ids intentionally parse as undefined (no Bedrock cache points).
// Frozen history — a new id shape failing to parse is not in this table and
// must trip the sweep below.
const LEGACY_UNPARSABLE_BEDROCK_CLAUDE_IDS: Record<string, true> = {
	"anthropic.claude-3-haiku-20240307-v1:0": true,
	"anthropic.claude-3-opus-20240229-v1:0": true,
	"anthropic.claude-3-sonnet-20240229-v1:0": true,
	"eu.anthropic.claude-3-haiku-20240307-v1:0": true,
	"eu.anthropic.claude-3-opus-20240229-v1:0": true,
	"eu.anthropic.claude-3-sonnet-20240229-v1:0": true,
};

describe("bundled Bedrock catalog id-shape tripwire", () => {
	it("parses a generation out of every bundled Bedrock Claude id", () => {
		const unparsable = getBundledModels("amazon-bedrock")
			.filter(model => model.id.toLowerCase().includes("claude"))
			.filter(model => parseBedrockClaudeGeneration(model.id.toLowerCase()) === undefined)
			.filter(model => !(model.id in LEGACY_UNPARSABLE_BEDROCK_CLAUDE_IDS));
		expect(unparsable.map(model => model.id)).toEqual([]);
	});

	it("guards against the sweep going vacuous", () => {
		const claudeIds = getBundledModels("amazon-bedrock").filter(model => model.id.toLowerCase().includes("claude"));
		expect(claudeIds.length).toBeGreaterThan(0);
		expect(
			claudeIds.filter(model => parseBedrockClaudeGeneration(model.id.toLowerCase()) !== undefined).length,
		).toBeGreaterThan(0);
	});
});
