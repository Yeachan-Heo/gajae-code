import { afterEach, describe, expect, test, vi } from "bun:test";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "../src/provider-models/descriptors";
import { zenmuxModelManagerOptions } from "../src/provider-models/openai-compat";
import { getEnvApiKey } from "../src/stream";
import { getOAuthProviders } from "../src/utils/oauth";

const originalZenMuxApiKey = Bun.env.ZENMUX_API_KEY;
const originalFetch = global.fetch;

afterEach(() => {
	if (originalZenMuxApiKey === undefined) {
		delete Bun.env.ZENMUX_API_KEY;
	} else {
		Bun.env.ZENMUX_API_KEY = originalZenMuxApiKey;
	}
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("zenmux provider support", () => {
	test("resolves ZENMUX_API_KEY from environment", () => {
		Bun.env.ZENMUX_API_KEY = "zenmux-test-key";
		expect(getEnvApiKey("zenmux")).toBe("zenmux-test-key");
	});

	test("registers built-in descriptor and default model", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "zenmux");
		expect(descriptor).toBeDefined();
		expect(descriptor?.defaultModel).toBe("anthropic/claude-opus-4.8");
		expect(descriptor?.catalogDiscovery?.envVars).toContain("ZENMUX_API_KEY");
		expect(DEFAULT_MODEL_PER_PROVIDER.zenmux).toBe("anthropic/claude-opus-4.8");
	});

	test("registers ZenMux in OAuth provider selector", () => {
		const provider = getOAuthProviders().find(item => item.id === "zenmux");
		expect(provider?.name).toBe("ZenMux");
	});
	test("routes Anthropic-owned models to anthropic-messages", async () => {
		global.fetch = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						data: [
							{
								id: "anthropic/claude-opus-4.6",
								display_name: "Anthropic: Claude Opus 4.6",
								owned_by: "anthropic",
								input_modalities: ["text", "image"],
								capabilities: { reasoning: true },
								context_length: 200000,
								pricings: {
									prompt: [{ value: 15, unit: "perMTokens", currency: "USD" }],
									completion: [{ value: 75, unit: "perMTokens", currency: "USD" }],
									input_cache_read: [{ value: 1.5, unit: "perMTokens", currency: "USD" }],
									input_cache_write_1_h: [{ value: 18.75, unit: "perMTokens", currency: "USD" }],
								},
							},
							{
								id: "openai/gpt-5.2",
								display_name: "OpenAI: GPT-5.2",
								owned_by: "openai",
								input_modalities: ["text"],
								capabilities: { reasoning: true },
								context_length: 400000,
								pricings: {
									prompt: [{ value: 1.25, unit: "perMTokens", currency: "USD" }],
									completion: [{ value: 10, unit: "perMTokens", currency: "USD" }],
								},
							},
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		) as unknown as typeof fetch;

		const options = zenmuxModelManagerOptions({ apiKey: "zenmux-test-key" });
		expect(options.providerId).toBe("zenmux");
		expect(options.fetchDynamicModels).toBeDefined();

		const models = await options.fetchDynamicModels?.();
		expect(models).not.toBeNull();
		expect(global.fetch).toHaveBeenCalledWith(
			"https://zenmux.ai/api/v1/models",
			expect.objectContaining({ method: "GET" }),
		);

		const anthropic = models?.find(model => model.id === "anthropic/claude-opus-4.6");
		expect(anthropic?.api).toBe("anthropic-messages");
		expect(anthropic?.baseUrl).toBe("https://zenmux.ai/api/anthropic");
		expect(anthropic?.input).toEqual(["text", "image"]);
		expect(anthropic?.cost.input).toBe(15);
		expect(anthropic?.cost.cacheWrite).toBe(18.75);

		const openai = models?.find(model => model.id === "openai/gpt-5.2");
		expect(openai?.api).toBe("openai-completions");
		expect(openai?.baseUrl).toBe("https://zenmux.ai/api/v1");
		expect(openai?.cost.output).toBe(10);
	});
});
