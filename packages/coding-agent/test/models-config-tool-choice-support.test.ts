import { describe, expect, test } from "bun:test";
import { ModelsConfigSchema } from "@gajae-code/coding-agent/config/models-config-schema";

describe("models config compatibility fields", () => {
	test("accepts toolChoiceSupport alongside legacy booleans in provider and model compat", () => {
		const result = ModelsConfigSchema.safeParse({
			providers: {
				proxy: {
					baseUrl: "https://proxy.example.com/v1",
					api: "openai-completions",
					compat: { toolChoiceSupport: "auto", supportsToolChoice: true },
					models: [
						{
							id: "proxied-model",
							name: "Proxied",
							contextWindow: 128000,
							maxTokens: 8192,
							compat: { toolChoiceSupport: "named", supportsForcedToolChoice: false },
						},
					],
				},
			},
		});
		expect(result.success).toBe(true);
	});

	test("rejects invalid toolChoiceSupport values", () => {
		const result = ModelsConfigSchema.safeParse({
			providers: {
				proxy: {
					baseUrl: "https://proxy.example.com/v1",
					api: "openai-completions",
					compat: { toolChoiceSupport: "forced" },
				},
			},
		});
		expect(result.success).toBe(false);
	});

	test("accepts supportsUltrafastTier in custom provider and model config", () => {
		const result = ModelsConfigSchema.safeParse({
			providers: {
				proxy: {
					baseUrl: "https://proxy.example.com/v1",
					api: "openai-completions",
					compat: { supportsUltrafastTier: true },
					models: [
						{
							id: "proxied-model",
							name: "Proxied",
							contextWindow: 128000,
							maxTokens: 8192,
							compat: { supportsUltrafastTier: true },
						},
					],
				},
			},
		});

		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.providers?.proxy?.compat?.supportsUltrafastTier).toBe(true);
			expect(result.data.providers?.proxy?.models?.[0]?.compat?.supportsUltrafastTier).toBe(true);
		}
	});

	test("generated JSON schema exposes the toolChoiceSupport enum", async () => {
		const schema = (await import("../../../schemas/models.schema.json")) as Record<string, unknown>;
		const text = JSON.stringify(schema);
		expect(text).toContain('"toolChoiceSupport"');
		expect(text).toContain('"named"');
		expect(text).toContain('"supportsUltrafastTier"');
	});
});
