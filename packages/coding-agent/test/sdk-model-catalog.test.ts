import { expect, test } from "bun:test";
import type { Api, Effort, Model } from "@gajae-code/ai";
import { toSdkModelCatalogEntry } from "../src/sdk/bus/model-catalog";

const MINIMAL = "minimal" as Effort;
const LOW = "low" as Effort;
const HIGH = "high" as Effort;
function modelFixture(overrides: Partial<Model<Api>>): Model<Api> {
	return {
		id: "plain-model",
		name: "Plain Model",
		api: "openai-completions",
		provider: "runtime-provider",
		baseUrl: "http://127.0.0.1:9/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
		...overrides,
	};
}

test("SDK model catalog exposes reasoning and thinking capabilities", () => {
	const entry = toSdkModelCatalogEntry(
		modelFixture({
			id: "reasoning-model",
			name: "Reasoning Model",
			reasoning: true,
			thinking: {
				minLevel: MINIMAL,
				maxLevel: HIGH,
				levels: [MINIMAL, LOW, HIGH],
				defaultLevel: LOW,
				mode: "effort",
			},
		}),
	);

	expect(entry).toEqual({
		provider: "runtime-provider",
		id: "reasoning-model",
		name: "Reasoning Model",
		contextWindow: 128_000,
		maxTokens: 8_192,
		reasoning: true,
		thinking: {
			minLevel: MINIMAL,
			maxLevel: HIGH,
			levels: [MINIMAL, LOW, HIGH],
			defaultLevel: LOW,
			mode: "effort",
		},
	});
});

test("SDK model catalog keeps non-reasoning models explicit without fake thinking metadata", () => {
	const entry = toSdkModelCatalogEntry(modelFixture({}));

	expect(entry).toEqual({
		provider: "runtime-provider",
		id: "plain-model",
		name: "Plain Model",
		contextWindow: 128_000,
		maxTokens: 8_192,
		reasoning: false,
	});
});
