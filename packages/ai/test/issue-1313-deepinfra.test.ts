import { describe, expect, test } from "bun:test";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "../src/provider-models/descriptors";
import { MODELS_DEV_PROVIDER_DESCRIPTORS } from "../src/provider-models/openai-compat";
import { getEnvApiKey } from "../src/stream";
import { getOAuthProviders } from "../src/utils/oauth";

describe("DeepInfra provider support (issue #1313)", () => {
	test("registers DeepInfra provider metadata and credential discovery", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "deepinfra");
		expect(descriptor).toBeDefined();
		expect(descriptor?.defaultModel).toBe("deepseek-ai/DeepSeek-V3.2");
		expect(descriptor?.catalogDiscovery?.envVars).toContain("DEEPINFRA_API_KEY");
		expect(DEFAULT_MODEL_PER_PROVIDER.deepinfra).toBe("deepseek-ai/DeepSeek-V3.2");

		const provider = getOAuthProviders().find(item => item.id === "deepinfra");
		expect(provider?.name).toBe("DeepInfra");
		expect(provider?.available).toBe(true);
	});

	test("resolves DEEPINFRA_API_KEY via env", () => {
		const previous = Bun.env.DEEPINFRA_API_KEY;
		Bun.env.DEEPINFRA_API_KEY = "deepinfra-test-key";
		try {
			expect(getEnvApiKey("deepinfra")).toBe("deepinfra-test-key");
		} finally {
			if (previous === undefined) {
				delete Bun.env.DEEPINFRA_API_KEY;
			} else {
				Bun.env.DEEPINFRA_API_KEY = previous;
			}
		}
	});

	test("maps models.dev DeepInfra models to OpenAI-compatible chat completions", () => {
		const descriptor = MODELS_DEV_PROVIDER_DESCRIPTORS.find(item => item.providerId === "deepinfra");
		expect(descriptor).toBeDefined();
		expect(descriptor?.modelsDevKey).toBe("deepinfra");
		expect(descriptor?.api).toBe("openai-completions");
		expect(descriptor?.baseUrl).toBe("https://api.deepinfra.com/v1/openai");
	});
});
