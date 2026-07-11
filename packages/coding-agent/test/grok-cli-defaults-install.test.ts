import { describe, expect, it } from "bun:test";
import {
	resolveModels,
	supportsReasoningEffort,
} from "../src/defaults/gjc/extensions/grok-cli-vendor/src/models/catalog";
import {
	assertBundledGrokCliDefaults,
	getBundledGrokBuildExtensionFactory,
	getBundledGrokCliModelDefaults,
} from "../src/defaults/gjc-grok-cli";

describe("bundled Grok CLI defaults", () => {
	it("loads the shipped vendor defaults without filesystem path discovery", async () => {
		await expect(assertBundledGrokCliDefaults()).resolves.toBeUndefined();
		expect(typeof getBundledGrokBuildExtensionFactory()).toBe("function");
		expect(getBundledGrokCliModelDefaults()).toContain("grok-composer-2.5-fast");
	});

	it("registers Grok 4.5 with its public model metadata", () => {
		const previousGrokCliModels = process.env.GJC_GROK_CLI_MODELS;
		delete process.env.GJC_GROK_CLI_MODELS;
		try {
			const model = resolveModels().find(candidate => candidate.id === "grok-4.5");

			expect(model).toEqual({
				id: "grok-4.5",
				name: "Grok 4.5",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
				contextWindow: 500_000,
				maxTokens: 30_000,
			});
			expect(supportsReasoningEffort("grok-build/grok-4.5")).toBe(true);
		} finally {
			if (previousGrokCliModels === undefined) {
				delete process.env.GJC_GROK_CLI_MODELS;
			} else {
				process.env.GJC_GROK_CLI_MODELS = previousGrokCliModels;
			}
		}
	});
});
