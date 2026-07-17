import { describe, expect, test } from "bun:test";
import type { Model } from "@gajae-code/ai";
import {
	resolveAgentCreationModel,
	updateAgentModelOverride,
} from "@gajae-code/coding-agent/modes/components/agent-dashboard";

const availableModel = {
	provider: "available-provider",
	id: "available-model",
	name: "Available model",
	api: "openai-responses",
	contextWindow: 1_000,
	maxTokens: 1_000,
} as Model;

function createRegistry(models: Model[]) {
	return {
		getAvailable: () => models,
		resolveCanonicalModel: () => undefined,
	};
}

describe("agent dashboard model resolution", () => {
	test("surfaces configured selectors that do not resolve instead of using an arbitrary model", () => {
		expect(() =>
			resolveAgentCreationModel(
				["missing-provider/missing-model"],
				createRegistry([availableModel]) as never,
				undefined,
			),
		).toThrow("Configured model selector(s) did not resolve: missing-provider/missing-model.");
	});

	test("uses the first available model only when no preference was configured", () => {
		expect(resolveAgentCreationModel([], createRegistry([availableModel]) as never, undefined)).toBe(availableModel);
	});
	test("preserves unrelated fallback chains when saving an agent override", () => {
		const fallbackChain = ["anthropic/claude-sonnet", "openai/gpt-5"];
		const saved = updateAgentModelOverride(
			{ architect: fallbackChain, executor: "old-provider/old-model" },
			"executor",
			"new-provider/new-model",
		);

		expect(saved).toEqual({ architect: fallbackChain, executor: "new-provider/new-model" });
		expect(saved.architect).toBe(fallbackChain);
	});
});
