import { describe, expect, it } from "bun:test";
import { getBundledModel, getBundledModels } from "../src/models";
import {
	hasBedrockEuInferenceProfile,
	MODELS_DEV_PROVIDER_DESCRIPTORS,
	mapModelsDevToModels,
} from "../src/provider-models/openai-compat";

function bedrockIdsFor(modelId: string): string[] {
	return mapModelsDevToModels(
		{ "amazon-bedrock": { models: { [modelId]: { name: modelId, tool_call: true } } } },
		MODELS_DEV_PROVIDER_DESCRIPTORS,
	)
		.filter(model => model.provider === "amazon-bedrock")
		.map(model => model.id)
		.sort();
}

describe("Bedrock EU Geo inference profiles", () => {
	it.each([
		["anthropic.claude-fable-5", true],
		["anthropic.claude-fable-5-1", false],
		["anthropic.claude-fable-5-2", false],
		["anthropic.claude-opus-5-5", true],
		["amazon.nova-lite-v1:0", false],
	] as const)("classifies %s EU profile support as %s", (id, expected) => {
		expect(hasBedrockEuInferenceProfile(id)).toBe(expected);
	});

	it("does not synthesize an EU id for Fable 5.2", () => {
		expect(bedrockIdsFor("anthropic.claude-fable-5-2")).toEqual(["anthropic.claude-fable-5-2"]);
	});

	it("keeps synthesizing EU ids for Anthropic models that have the profile", () => {
		expect(bedrockIdsFor("anthropic.claude-fable-5")).toEqual([
			"anthropic.claude-fable-5",
			"eu.anthropic.claude-fable-5",
		]);
	});

	it("bundles only the documented Fable 5.1/5.2 Bedrock profiles", () => {
		const ids = getBundledModels("amazon-bedrock")
			.map(model => model.id)
			.filter(id => /claude-fable-5-[12]$/.test(id))
			.sort();
		expect(ids).toEqual([
			"anthropic.claude-fable-5-1",
			"anthropic.claude-fable-5-2",
			"global.anthropic.claude-fable-5-1",
			"global.anthropic.claude-fable-5-2",
			"us.anthropic.claude-fable-5-1",
			"us.anthropic.claude-fable-5-2",
		]);
		expect(getBundledModel("amazon-bedrock", "eu.anthropic.claude-fable-5" as never)).toBeDefined();
	});
});
