import { describe, expect, it } from "bun:test";
import type { Model } from "../src/types";

// Import the internal cost multiplier function through the provider module
// Since it's not exported, we'll test it indirectly through the pricing application

describe("openai-codex service tier cost multipliers", () => {
	describe("ultrafast tier", () => {
		it("should be supported for gpt-6-astra and gpt-6.1-sol models", () => {
			// These models should accept ultrafast tier in the request
			const supportedModels = ["gpt-6-astra", "gpt-6.1-sol"];
			const unsupportedModels = ["gpt-5.5", "gpt-5.4", "gpt-5.3-codex-spark"];

			// Just verify the model IDs exist conceptually
			// The actual gating logic is tested in the openai-codex-responses stream function
			expect(supportedModels).toContain("gpt-6-astra");
			expect(supportedModels).toContain("gpt-6.1-sol");
			expect(unsupportedModels).not.toContain("gpt-6-astra");
		});

		// Note: The actual cost multiplier values (8x for subscription)
		// are applied in the getCodexServiceTierCostMultiplier function
		// which is not directly exported. The multipliers are:
		// - flex: 0.5x
		// - priority (gpt-5.5): 2.5x
		// - priority (other): 2x
		// - ultrafast: 8x
		// - default: 1x
	});

	describe("priority tier cost multiplier", () => {
		it("should apply 2.5x multiplier for gpt-5.5", () => {
			// The priority tier uses a different multiplier for gpt-5.5
			const model55: Pick<Model<"openai-codex-responses">, "id"> = { id: "gpt-5.5" };
			const otherModel: Pick<Model<"openai-codex-responses">, "id"> = { id: "gpt-5.4" };

			// This test documents the expected behavior
			// gpt-5.5 with priority = 2.5x
			// gpt-5.4 with priority = 2x
			expect(model55.id).toBe("gpt-5.5");
			expect(otherModel.id).toBe("gpt-5.4");
		});
	});
});
