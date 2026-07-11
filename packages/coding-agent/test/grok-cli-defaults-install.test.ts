import { describe, expect, it } from "bun:test";
import { Effort } from "@gajae-code/ai/model-thinking";
import {
	type GrokCliModelConfig,
	resolveModels,
	supportsReasoningEffort,
} from "../src/defaults/gjc/extensions/grok-cli-vendor/src/models/catalog";
import {
	assertBundledGrokCliDefaults,
	getBundledGrokBuildExtensionFactory,
	getBundledGrokCliModelDefaults,
} from "../src/defaults/gjc-grok-cli";
import type { ExtensionAPI, ProviderConfig } from "../src/extensibility/extensions";

async function captureGrokBuildProviderConfig(): Promise<ProviderConfig> {
	let providerConfig: ProviderConfig | undefined;
	await getBundledGrokBuildExtensionFactory()({
		registerProvider(name: string, config: ProviderConfig) {
			if (name === "grok-build") providerConfig = config;
		},
		on() {},
		registerCommand() {},
	} as unknown as ExtensionAPI);
	if (!providerConfig) throw new Error("Grok Build provider was not registered");
	return providerConfig;
}

describe("bundled Grok CLI defaults", () => {
	it("loads the shipped vendor defaults without filesystem path discovery", async () => {
		await expect(assertBundledGrokCliDefaults()).resolves.toBeUndefined();
		expect(typeof getBundledGrokBuildExtensionFactory()).toBe("function");
		expect(getBundledGrokCliModelDefaults()).toContain("grok-composer-2.5-fast");
	});

	it("registers Grok 4.5 with verified model metadata and documented effort cap", async () => {
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
				maxReasoningEffort: Effort.High,
			});
			expect(supportsReasoningEffort("grok-build/grok-4.5")).toBe(true);

			const providerConfig = await captureGrokBuildProviderConfig();
			const registeredModel = providerConfig?.models?.find(candidate => candidate.id === "grok-4.5");
			expect(registeredModel?.thinking).toEqual({
				minLevel: Effort.Low,
				maxLevel: Effort.High,
				mode: "effort",
			});
		} finally {
			if (previousGrokCliModels === undefined) {
				delete process.env.GJC_GROK_CLI_MODELS;
			} else {
				process.env.GJC_GROK_CLI_MODELS = previousGrokCliModels;
			}
		}
	});

	it("maps official Grok 4.5 aliases to canonical metadata and effort limits", async () => {
		const previousGrokCliModels = process.env.GJC_GROK_CLI_MODELS;
		const aliases = ["grok-4.5-latest", "grok-build-latest"];
		process.env.GJC_GROK_CLI_MODELS = aliases.join(",");
		try {
			const expectedMetadata = {
				name: "Grok 4.5",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
				contextWindow: 500_000,
				maxTokens: 30_000,
				maxReasoningEffort: Effort.High,
			} satisfies Omit<GrokCliModelConfig, "id">;
			expect(resolveModels()).toEqual(aliases.map(id => ({ id, ...expectedMetadata })));
			for (const alias of aliases) {
				expect(supportsReasoningEffort(`grok-build/${alias}`)).toBe(true);
			}

			const providerConfig = await captureGrokBuildProviderConfig();
			expect(
				providerConfig.models?.map(model => ({
					id: model.id,
					thinking: model.thinking,
				})),
			).toEqual(
				aliases.map(id => ({
					id,
					thinking: {
						minLevel: Effort.Low,
						maxLevel: Effort.High,
						mode: "effort",
					},
				})),
			);
		} finally {
			if (previousGrokCliModels === undefined) {
				delete process.env.GJC_GROK_CLI_MODELS;
			} else {
				process.env.GJC_GROK_CLI_MODELS = previousGrokCliModels;
			}
		}
	});
});
