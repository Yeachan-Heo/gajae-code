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

	it("bundles GPT-6-Astra with the discovered Codex metadata", () => {
		const model = getBundledModel("openai-codex", "gpt-6-astra");

		expect(model.name).toBe("GPT-6-Astra");
		expect(model.api).toBe("openai-codex-responses");
		expect(model.reasoning).toBe(true);
		expect(model.input).toEqual(["text", "image"]);
		expect(model.preferWebsockets).toBe(true);
		// `/codex/models` reports a 272K prompt budget for Astra; it is not in the
		// forced 372K GPT-5.6 tier and no first-party pricing has been published.
		expect(model.contextWindow).toBe(272_000);
		expect(model.maxTokens).toBe(128_000);
		expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		expect(model.thinking).toEqual({ mode: "effort", minLevel: Effort.Low, maxLevel: Effort.Max });
	});
});
