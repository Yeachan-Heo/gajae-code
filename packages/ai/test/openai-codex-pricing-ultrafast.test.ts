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

	test("gpt-6-astra and gpt-6.1-sol support ultrafast on each bundled provider", async () => {
		const providers = getBundledProviders();
		for (const provider of providers) {
			const providerModels = getBundledModels(provider as never);
			const gpt6Astra = providerModels.find(m => m.id === "gpt-6-astra");
			if (gpt6Astra) {
				const supportsUltrafast = modelSupportsUltrafastTier(gpt6Astra);
				expect(supportsUltrafast).toBe(true);
			}
			const gpt61Sol = providerModels.find(m => m.id === "gpt-6.1-sol");
			if (gpt61Sol) {
				const supportsUltrafast = modelSupportsUltrafastTier(gpt61Sol);
				expect(supportsUltrafast).toBe(true);
			}
		}
	});
});
