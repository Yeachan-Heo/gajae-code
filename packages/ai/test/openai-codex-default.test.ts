import { describe, expect, it } from "bun:test";
import { Effort, getBundledModel } from "@gajae-code/ai";
import { DEFAULT_MODEL_PER_PROVIDER } from "@gajae-code/ai/provider-models";

describe("OpenAI Codex defaults", () => {
	it("pins provider default to GPT-5.5", () => {
		expect(DEFAULT_MODEL_PER_PROVIDER["openai-codex"]).toBe("gpt-5.5");
	});

	it("represents GPT-5.5 as the xhigh default effort", () => {
		const model = getBundledModel("openai-codex", "gpt-5.5");

		expect(model.thinking).toMatchObject({
			mode: "effort",
			minLevel: Effort.Low,
			maxLevel: Effort.XHigh,
			defaultLevel: Effort.XHigh,
		});
		// Codex GPT-5.5 may advertise a 1M total window, but the code backend's
		// effective prompt/request cap is lower. Status and compaction must use the
		// safe request cap instead of promising a window that overflows upstream.
		expect(model.contextWindow).toBe(272_000);
	});

	it("advertises the 372K prompt budget for bundled GPT-5.6 tiers", () => {
		for (const id of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
			const model = getBundledModel("openai-codex", id);
			expect(model.contextWindow).toBe(372_000);
			expect(model.maxTokens).toBe(128_000);
			expect(model.longContextPricing?.threshold).toBe(272_000);
		}
	});

	it("bundles GPT-6 Astra with discovered Codex limits and first-party pricing", () => {
		const model = getBundledModel("openai-codex", "gpt-6-astra");

		expect(model.name).toBe("GPT-6 Astra");
		expect(model.api).toBe("openai-codex-responses");
		expect(model.reasoning).toBe(true);
		expect(model.input).toEqual(["text", "image"]);
		expect(model.preferWebsockets).toBe(true);
		expect(model.applyPatchToolType).toBe("freeform");
		// `/codex/models` reports the Codex product's usable prompt budget; the
		// direct API's larger published window must not override discovery here.
		expect(model.contextWindow).toBe(272_000);
		expect(model.maxTokens).toBe(128_000);
		expect(model.cost).toEqual({ input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 });
		expect(model.longContextPricing).toEqual({
			threshold: 272_000,
			cost: { input: 20, output: 75, cacheRead: 2, cacheWrite: 25 },
		});
		expect(model.thinking).toEqual({ mode: "effort", minLevel: Effort.Low, maxLevel: Effort.Max });
	});
});
