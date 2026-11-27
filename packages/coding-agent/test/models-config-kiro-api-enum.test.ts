import { describe, expect, test } from "bun:test";
import { ModelPresetRegistryPresetsSchema } from "@gajae-code/coding-agent/config/model-preset-registry";
import { ModelsConfigSchema } from "@gajae-code/coding-agent/config/models-config-schema";

describe("kiro-codewhisperer-stream api enum coverage", () => {
	test("models config accepts kiro-codewhisperer-stream for provider and model api", () => {
		const result = ModelsConfigSchema.safeParse({
			providers: {
				kiro: {
					baseUrl: "https://kiro.example.com",
					api: "kiro-codewhisperer-stream",
					models: [{ id: "kiro-test", api: "kiro-codewhisperer-stream" }],
				},
			},
		});
		expect(result.success).toBe(true);
	});

	test("preset registry accepts kiro-codewhisperer-stream as a preset api", () => {
		const result = ModelPresetRegistryPresetsSchema.safeParse({
			schemaVersion: "1.0.0",
			revision: "20261104",
			presets: [
				{
					id: "kiro-test",
					provider: "kiro",
					name: "Kiro test preset",
					api: "kiro-codewhisperer-stream",
					reasoning: false,
					input: ["text"],
					cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
					contextWindow: 128000,
					maxTokens: 8192,
				},
			],
		});
		expect(result.success).toBe(true);
	});
});
