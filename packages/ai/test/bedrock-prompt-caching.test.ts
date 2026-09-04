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
	it("parses both Claude naming schemes across base ids, regional profiles, and ARNs", () => {
		for (const id of [
			"anthropic.claude-3-5-haiku-20241022-v1:0",
			"eu.anthropic.claude-3-7-sonnet-20250219-v1:0",
			"anthropic.claude-opus-4-20250514-v1:0",
			"global.anthropic.claude-sonnet-4-5-20250929-v1:0",
			"au.anthropic.claude-haiku-4-5-20251001-v1:0",
			"jp.anthropic.claude-sonnet-4-6",
			"apac.anthropic.claude-opus-5",
			"arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-4-6-v1:0",
			"arn:aws-us-gov:bedrock:us-gov-west-1::foundation-model/anthropic.claude-opus-4-20250514-v1:0",
		]) {
			expect(supportsPromptCaching(bedrockModel(id)), id).toBe(true);
		}
	});

	it("keeps unsupported Claude 3.x generations and families uncached", () => {
		for (const id of [
			"anthropic.claude-3-opus-20240229-v1:0",
			"anthropic.claude-3-haiku-20240307-v1:0",
			"anthropic.claude-3-5-sonnet-20240620-v1:0",
			"anthropic.claude-3-7-haiku-20250219-v1:0",
			"anthropic.claude-v2:0",
		]) {
			expect(supportsPromptCaching(bedrockModel(id)), id).toBe(false);
		}
	});

	it("keeps covering future generations without a source patch", () => {
		for (const id of [
			"us.anthropic.claude-opus-5-20300101-v1:0",
			"eu.anthropic.claude-fable-5-20300101-v1:0",
			"anthropic.claude-6-1-fable-20400101-v1:0",
		]) {
			expect(supportsPromptCaching(bedrockModel(id)), id).toBe(true);
		}
	});

	it("rejects non-Claude lookalikes and malformed model ids", () => {
		for (const id of [
			"amazon.claude-opus-5-20300101-v1:0",
			"notanthropic.claude-opus-5-20300101-v1:0",
			"anthropic.not-claude-opus-5-20300101-v1:0",
			"custom-anthropic.claude-opus-5-20300101-v1:0",
			"custom/us.anthropic.claude-opus-5-20300101-v1:0",
			"arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/us.anthropic.claude-opus-5",
			"arn:aws:bedrock:us-east-1:123456789012:prompt/us.anthropic.claude-opus-5",
			"anthropic.claude-opus-04-5-20300101-v1:0",
			"anthropic.claude-opus-4-05-20300101-v1:0",
			"anthropic.claude-opus-4-5--preview",
			"anthropic.claude-opus-4-5-preview_1",
			"anthropic.claude-6-1-20400101-v1:0",
			"ANTHROPIC.CLAUDE-OPUS-5",
		]) {
			expect(supportsPromptCaching(bedrockModel(id)), id).toBe(false);
		}
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
