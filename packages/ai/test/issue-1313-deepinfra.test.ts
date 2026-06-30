import { afterEach, describe, expect, test, vi } from "bun:test";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "../src/provider-models/descriptors";
import { MODELS_DEV_PROVIDER_DESCRIPTORS } from "../src/provider-models/openai-compat";
import { streamOpenAICompletions } from "../src/providers/openai-completions";
import { getEnvApiKey } from "../src/stream";
import type { Context, Model, ServiceTier } from "../src/types";
import { getOAuthProviders } from "../src/utils/oauth";

const originalFetch = global.fetch;

const context: Context = {
	systemPrompt: [],
	messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
};

function completionsSseResponse(): Response {
	const payload = [
		{ choices: [{ delta: { content: "ok" }, index: 0 }] },
		{ choices: [{ delta: {}, finish_reason: "stop", index: 0 }] },
		"[DONE]",
	]
		.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`)
		.join("\n\n");
	return new Response(`${payload}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
}

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

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

	async function captureDeepInfraBody(serviceTier: ServiceTier): Promise<Record<string, unknown>> {
		const model: Model<"openai-completions"> = {
			id: "deepseek-ai/DeepSeek-V3.2",
			name: "DeepSeek-V3.2",
			api: "openai-completions",
			provider: "deepinfra",
			baseUrl: "https://api.deepinfra.com/v1/openai",
			reasoning: true,
			input: ["text"],
			cost: { input: 0.26, output: 0.38, cacheRead: 0.13, cacheWrite: 0 },
			contextWindow: 163840,
			maxTokens: 64000,
		};
		let capturedBody: Record<string, unknown> = {};
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			capturedBody = JSON.parse(
				String(init?.body ?? (input instanceof Request ? await input.clone().text() : "{}")),
			) as Record<string, unknown>;
			return completionsSseResponse();
		});
		global.fetch = Object.assign(fetchMock, { preconnect: originalFetch.preconnect }) as typeof fetch;

		const stream = streamOpenAICompletions(model, context, { apiKey: "test-key", serviceTier });
		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}
		return capturedBody;
	}

	test("forwards priority service_tier to DeepInfra chat completions", async () => {
		const capturedBody = await captureDeepInfraBody("priority");

		expect(capturedBody.model).toBe("deepseek-ai/DeepSeek-V3.2");
		expect(capturedBody.service_tier).toBe("priority");
	});

	test.each(["flex", "scale"] as const)("does not forward %s service_tier to DeepInfra", async serviceTier => {
		const capturedBody = await captureDeepInfraBody(serviceTier);

		expect(capturedBody.model).toBe("deepseek-ai/DeepSeek-V3.2");
		expect(capturedBody).not.toHaveProperty("service_tier");
	});
});
