import { describe, expect, test } from "bun:test";
import { getBundledModels, getBundledProviders } from "../src/models";
import { modelSupportsUltrafastTier } from "../src/types";

// gpt-5.6-sol is Fast-only and excluded from ultrafast support.

describe("Codex gpt-5.6-sol ultrafast exclusion", () => {
	test("Codex gpt-5.6-sol is present and does not support ultrafast", () => {
		const codexModels = getBundledModels("openai-codex");
		if (codexModels.length === 0) {
			throw new Error("openai-codex provider not found in models.json");
		}
		const codexGpt56 = codexModels.find(m => m.id === "gpt-5.6-sol");
		if (!codexGpt56) {
			throw new Error("openai-codex/gpt-5.6-sol model not found in models.json");
		}
		const supportsUltrafast = modelSupportsUltrafastTier(codexGpt56);
		expect(supportsUltrafast).toBe(false);
	});

	test("gpt-5.6-sol across all providers does not support ultrafast", async () => {
		const providers = getBundledProviders();
		for (const provider of providers) {
			const providerModels = getBundledModels(provider as never);
			const gpt56 = providerModels.find(m => m.id === "gpt-5.6-sol");
			if (!gpt56) continue;
			const supportsUltrafast = modelSupportsUltrafastTier(gpt56);
			expect(supportsUltrafast).toBe(false);
		}
	});

	test("GPT-6 Astra and GPT-6.1/6.2 Astra and Sol support ultrafast on each bundled provider", async () => {
		const ultrafastIds = ["gpt-6-astra", "gpt-6.1-sol", "gpt-6.2-astra", "gpt-6.2-sol"];
		const providers = getBundledProviders();
		for (const provider of providers) {
			const providerModels = getBundledModels(provider as never);
			for (const id of ultrafastIds) {
				const model = providerModels.find(m => m.id === id);
				if (model) expect(modelSupportsUltrafastTier(model)).toBe(true);
			}
		}
		for (const provider of ["openai", "openai-codex", "opencode-zen"] as const) {
			const ids = getBundledModels(provider).map(model => model.id);
			expect(ids).toEqual(expect.arrayContaining(["gpt-6.2-astra", "gpt-6.2-sol"]));
		}
	});
});
