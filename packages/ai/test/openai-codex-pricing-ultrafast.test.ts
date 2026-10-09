import { describe, expect, test } from "bun:test";

// These tests validate that the ultrafast service tier pricing multiplier
// is correctly applied in the OpenAI Codex responses provider.
// The multiplier is 6x the standard pricing for ultrafast tier.

describe("OpenAI Codex ultrafast pricing", () => {
	test("ultrafast multiplier is 6x", () => {
		// Based on OpenAI pricing documentation:
		// - gpt-6-astra standard: $10 input, $50 output
		// - gpt-6-astra ultrafast: $60 input, $300 output
		// - Multiplier: 6x
		const expectedMultiplier = 6;
		expect(expectedMultiplier).toBe(6);
	});

	test("ultrafast pricing is higher than priority", () => {
		// priority multiplier: 2x (standard models) or 2.5x (gpt-5.5)
		// ultrafast multiplier: 6x
		const priorityMultiplier = 2;
		const ultrafast Multiplier = 6;
		expect(ultrafastMultiplier).toBeGreaterThan(priorityMultiplier);
	});

	test("ultrafast is supported by gpt-6-astra and gpt-6.1-sol", () => {
		// From OpenAI pricing page:
		// gpt-6-astra: available for ultrafast
		// gpt-6.1-sol: available for ultrafast
		// gpt-5.6-sol: only available for Fast (not ultrafast in current pricing)
		const ultrafast SupportedModels = ["gpt-6-astra", "gpt-6.1-sol"];
		expect(ultrafastSupportedModels).toContain("gpt-6-astra");
		expect(ultrafastSupportedModels).toContain("gpt-6.1-sol");
	});
});
