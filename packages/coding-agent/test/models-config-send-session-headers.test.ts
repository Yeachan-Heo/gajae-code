import { describe, expect, test } from "bun:test";
import { ModelsConfigSchema } from "@gajae-code/coding-agent/config/models-config-schema";

describe("models config sendSessionHeaders", () => {
	test("accepts sendSessionHeaders in provider and model compat", () => {
		const result = ModelsConfigSchema.safeParse({
			providers: {
				relay: {
					baseUrl: "https://relay.example.com/v1",
					api: "openai-completions",
					compat: { sendSessionHeaders: true },
					models: [
						{
							id: "relay-model",
							name: "Relay",
							contextWindow: 128000,
							maxTokens: 8192,
							compat: { sendSessionHeaders: false },
						},
					],
				},
			},
		});
		expect(result.success).toBe(true);
	});

	test("rejects a non-boolean sendSessionHeaders value", () => {
		const result = ModelsConfigSchema.safeParse({
			providers: {
				relay: {
					baseUrl: "https://relay.example.com/v1",
					api: "openai-completions",
					compat: { sendSessionHeaders: "yes" },
				},
			},
		});
		expect(result.success).toBe(false);
	});

	test("generated JSON schema exposes the sendSessionHeaders field", async () => {
		const schema = (await import("../../../schemas/models.schema.json")) as Record<string, unknown>;
		const text = JSON.stringify(schema);
		expect(text).toContain('"sendSessionHeaders"');
	});
});
