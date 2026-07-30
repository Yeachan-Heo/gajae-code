import { afterEach, describe, expect, test, vi } from "bun:test";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "../src/provider-models/descriptors";
import { maraModelManagerOptions } from "../src/provider-models/openai-compat";
import { getEnvApiKey } from "../src/stream";
import { getOAuthProviders } from "../src/utils/oauth";

const originalMaraApiKey = Bun.env.MARA_API_KEY;
const originalFetch = global.fetch;

afterEach(() => {
	if (originalMaraApiKey === undefined) {
		delete Bun.env.MARA_API_KEY;
	} else {
		Bun.env.MARA_API_KEY = originalMaraApiKey;
	}
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("mara provider support", () => {
	test("resolves MARA_API_KEY from environment", () => {
		const ambient = Bun.env.MARA_API_KEY;
		if (ambient) {
			// A key inherited from the launching shell resolves through the credential env.
			expect(getEnvApiKey("mara")).toBe(ambient);
		} else {
			Bun.env.MARA_API_KEY = "mara-test-key";
			expect(getEnvApiKey("mara")).toBe("mara-test-key");
		}
	});

	test("registers built-in descriptor and default model", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "mara");
		expect(descriptor).toBeDefined();
		expect(descriptor?.defaultModel).toBe("DeepSeek-V3.1");
		expect(descriptor?.catalogDiscovery?.envVars).toContain("MARA_API_KEY");
		expect(DEFAULT_MODEL_PER_PROVIDER.mara).toBe("DeepSeek-V3.1");
	});

	test("registers Mara Cloud in OAuth provider selector", () => {
		const provider = getOAuthProviders().find(item => item.id === "mara");
		expect(provider?.name).toBe("Mara Cloud");
	});

	test("discovers and maps models from the OpenAI-compatible /v1/models envelope", async () => {
		global.fetch = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						data: [
							{
								id: "DeepSeek-V3.1",
								object: "model",
								owned_by: "mara",
							},
							{
								id: "gpt-oss-120b",
								object: "model",
								owned_by: "mara",
							},
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		) as unknown as typeof fetch;

		const options = maraModelManagerOptions({ apiKey: "mara-test-key" });
		expect(options.providerId).toBe("mara");
		expect(options.fetchDynamicModels).toBeDefined();

		const models = await options.fetchDynamicModels?.();
		expect(models).not.toBeNull();
		expect(global.fetch).toHaveBeenCalledWith(
			"https://api.cloud.mara.com/v1/models",
			expect.objectContaining({ method: "GET" }),
		);

		const deepseek = models?.find(model => model.id === "DeepSeek-V3.1");
		expect(deepseek?.api).toBe("openai-completions");
		expect(deepseek?.baseUrl).toBe("https://api.cloud.mara.com/v1");
		expect(deepseek?.provider).toBe("mara");

		const oss = models?.find(model => model.id === "gpt-oss-120b");
		expect(oss?.api).toBe("openai-completions");
		expect(oss?.baseUrl).toBe("https://api.cloud.mara.com/v1");
		expect(oss?.provider).toBe("mara");
	});

	test("skips dynamic discovery without an API key", () => {
		const options = maraModelManagerOptions();
		expect(options.providerId).toBe("mara");
		expect(options.fetchDynamicModels).toBeUndefined();
	});
});
