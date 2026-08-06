import { describe, expect, test } from "bun:test";
import { ModelsConfigSchema } from "@gajae-code/coding-agent/config/models-config-schema";
import modelsSchema from "../../../schemas/models.schema.json" with { type: "json" };

describe("models config Anthropic prompt-cache compatibility", () => {
	test("accepts prompt-cache compatibility at provider, model, and override levels", () => {
		const result = ModelsConfigSchema.safeParse({
			providers: {
				proxy: {
					baseUrl: "https://proxy.example.com/anthropic",
					api: "anthropic-messages",
					compat: { promptCacheMode: "explicit", supportsLongCacheRetention: false },
					models: [
						{
							id: "claude-sonnet-4-5",
							compat: { promptCacheMode: "automatic", supportsLongCacheRetention: true },
						},
					],
					modelOverrides: {
						"claude-sonnet-4-5": { compat: { promptCacheMode: "none" } },
					},
				},
			},
		});

		expect(result.success).toBe(true);
	});

	test("rejects invalid prompt-cache compatibility values", () => {
		const invalidMode = ModelsConfigSchema.safeParse({
			providers: {
				proxy: {
					baseUrl: "https://proxy.example.com/anthropic",
					api: "anthropic-messages",
					compat: { promptCacheMode: "block-level" },
				},
			},
		});
		const invalidLongRetention = ModelsConfigSchema.safeParse({
			providers: {
				proxy: {
					baseUrl: "https://proxy.example.com/anthropic",
					api: "anthropic-messages",
					compat: { supportsLongCacheRetention: "yes" },
				},
			},
		});

		expect(invalidMode.success).toBe(false);
		expect(invalidLongRetention.success).toBe(false);
	});

	test("generated JSON schema exposes Anthropic prompt-cache compatibility", () => {
		const text = JSON.stringify(modelsSchema);

		expect(text).toContain('"promptCacheMode"');
		expect(text).toContain('"explicit"');
		expect(text).toContain('"supportsLongCacheRetention"');
	});
});
