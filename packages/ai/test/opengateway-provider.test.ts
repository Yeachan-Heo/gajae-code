import { afterEach, describe, expect, test, vi } from "bun:test";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "../src/provider-models/descriptors";
import { opengatewayModelManagerOptions } from "../src/provider-models/openai-compat";
import { getEnvApiKey } from "../src/stream";
import { getOAuthProviders } from "../src/utils/oauth";

const originalOpenGatewayApiKey = Bun.env.OPENGATEWAY_API_KEY;
const originalFetch = global.fetch;

afterEach(() => {
	if (originalOpenGatewayApiKey === undefined) {
		delete Bun.env.OPENGATEWAY_API_KEY;
	} else {
		Bun.env.OPENGATEWAY_API_KEY = originalOpenGatewayApiKey;
	}
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("opengateway provider support", () => {
	test("resolves OPENGATEWAY_API_KEY from environment", () => {
		const ambient = Bun.env.OPENGATEWAY_API_KEY;
		if (ambient) {
			// A key inherited from the launching shell resolves through the credential env.
			expect(getEnvApiKey("opengateway")).toBe(ambient);
		} else {
			Bun.env.OPENGATEWAY_API_KEY = "opengateway-test-key";
			expect(getEnvApiKey("opengateway")).toBe("opengateway-test-key");
		}
	});

	test("registers built-in descriptor and default model", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "opengateway");
		expect(descriptor).toBeDefined();
		expect(descriptor?.defaultModel).toBe("openai/gpt-4o");
		expect(descriptor?.catalogDiscovery?.envVars).toContain("OPENGATEWAY_API_KEY");
		expect(DEFAULT_MODEL_PER_PROVIDER.opengateway).toBe("openai/gpt-4o");
	});

	test("registers OpenGateway in OAuth provider selector", () => {
		const provider = getOAuthProviders().find(item => item.id === "opengateway");
		expect(provider?.name).toBe("OpenGateway by Sionic AI");
	});

	test("discovers models from the OpenAI-compatible endpoint", async () => {
		global.fetch = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						object: "list",
						data: [
							{ id: "openai/gpt-4o", object: "model" },
							{ id: "anthropic/claude-sonnet-4-5", object: "model" },
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		) as unknown as typeof fetch;

		const options = opengatewayModelManagerOptions({ apiKey: "opengateway-test-key" });
		expect(options.providerId).toBe("opengateway");
		expect(options.fetchDynamicModels).toBeDefined();

		const models = await options.fetchDynamicModels?.();
		expect(models).not.toBeNull();
		expect(global.fetch).toHaveBeenCalledWith(
			"https://apis.opengateway.ai/v1/models",
			expect.objectContaining({ method: "GET" }),
		);

		const gpt = models?.find(model => model.id === "openai/gpt-4o");
		expect(gpt?.api).toBe("openai-completions");
		expect(gpt?.baseUrl).toBe("https://apis.opengateway.ai/v1");
		expect(gpt?.provider).toBe("opengateway");
	});

	test("takes capabilities from the upstream model, including -ultrafast deployments", async () => {
		global.fetch = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						object: "list",
						data: [
							{ id: "deepseek/deepseek-v4.1-flash-ultrafast", object: "model", context_window: 1_000_000 },
							{ id: "deepseek/deepseek-v4.1-flash", object: "model" },
							{ id: "z-ai/glm-5.3-ultrafast", object: "model", max_output_tokens: 131_072 },
							{ id: "acme/unknown-model-ultrafast", object: "model" },
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		) as unknown as typeof fetch;

		const models = await opengatewayModelManagerOptions({ apiKey: "opengateway-test-key" }).fetchDynamicModels?.();
		const byId = new Map(models?.map(model => [model.id, model]));

		const ultrafast = byId.get("deepseek/deepseek-v4.1-flash-ultrafast");
		expect(ultrafast?.reasoning).toBe(true);
		expect(ultrafast?.thinking).toBeDefined();
		expect(ultrafast?.contextWindow).toBe(1_000_000);
		expect(ultrafast?.provider).toBe("opengateway");
		expect(ultrafast?.baseUrl).toBe("https://apis.opengateway.ai/v1");
		expect(byId.get("deepseek/deepseek-v4.1-flash")?.reasoning).toBe(true);

		const glm = byId.get("z-ai/glm-5.3-ultrafast");
		expect(glm?.reasoning).toBe(true);
		expect(glm?.maxTokens).toBe(131_072);
		expect(glm?.provider).toBe("opengateway");

		// No bundled upstream: stays conservative instead of guessing a capability.
		expect(byId.get("acme/unknown-model-ultrafast")?.reasoning).toBe(false);
	});

	test("skips dynamic discovery without an API key", () => {
		const options = opengatewayModelManagerOptions();
		expect(options.providerId).toBe("opengateway");
		expect(options.fetchDynamicModels).toBeUndefined();
	});
});
