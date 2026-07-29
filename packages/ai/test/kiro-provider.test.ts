import { afterEach, describe, expect, test, vi } from "bun:test";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "../src/provider-models/descriptors";
import { kiroModelManagerOptions } from "../src/provider-models/openai-compat";
import { getEnvApiKey } from "../src/stream";
import { getOAuthProviders } from "../src/utils/oauth";

const originalKiroApiKey = Bun.env.KIRO_API_KEY;
const originalFetch = global.fetch;

/** Entry shape kiro-go's `/v1/models` actually returns. */
function kiroEntry(
	id: string,
	options: { ownedBy?: string; supportsImage?: boolean; inputModalities?: string[] } = {},
): Record<string, unknown> {
	const supportsImage = options.supportsImage ?? true;
	return {
		id,
		object: "model",
		owned_by: options.ownedBy ?? "anthropic",
		supports_image: supportsImage,
		input_modalities: options.inputModalities ?? (supportsImage ? ["text", "image"] : ["text"]),
	};
}

function kiroModelsResponse(entries: Record<string, unknown>[]): Response {
	return new Response(JSON.stringify({ object: "list", data: entries }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

function mockKiroModels(entries: Record<string, unknown>[]): void {
	global.fetch = vi.fn(async () => kiroModelsResponse(entries)) as unknown as typeof fetch;
}

/** Discovery is credential-gated, so every mapping case supplies a relay key. */
function kiroOptions(config?: { baseUrl?: string }) {
	return kiroModelManagerOptions({ apiKey: "kiro-relay-test", ...config });
}

afterEach(() => {
	if (originalKiroApiKey === undefined) {
		delete Bun.env.KIRO_API_KEY;
	} else {
		Bun.env.KIRO_API_KEY = originalKiroApiKey;
	}
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("kiro provider support", () => {
	test("resolves KIRO_API_KEY from environment", () => {
		const ambient = Bun.env.KIRO_API_KEY;
		if (ambient) {
			// A key inherited from the launching shell resolves through the credential env.
			expect(getEnvApiKey("kiro")).toBe(ambient);
		} else {
			Bun.env.KIRO_API_KEY = "kiro-relay-test";
			expect(getEnvApiKey("kiro")).toBe("kiro-relay-test");
		}
	});

	test("registers built-in descriptor without catalog discovery", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "kiro");
		expect(descriptor).toBeDefined();
		expect(descriptor?.defaultModel).toBe("claude-sonnet-5");
		// Entitlements are per-subscription and the relay is local, so nothing is bundled
		// and nothing can be generated into the catalog.
		expect(descriptor?.catalogDiscovery).toBeUndefined();
		// A local relay must not be probed without an explicit credential.
		expect(descriptor?.allowUnauthenticated).toBeUndefined();

		expect(DEFAULT_MODEL_PER_PROVIDER.kiro).toBe("claude-sonnet-5");
	});

	test("registers Kiro in the OAuth provider selector", () => {
		const provider = getOAuthProviders().find(item => item.id === "kiro");
		expect(provider?.name).toBe("Kiro (kiro-go / kiro2api relay)");
	});

	test("discovers relay models over the Anthropic Messages API", async () => {
		mockKiroModels([kiroEntry("claude-opus-4.6")]);

		const options = kiroOptions();
		expect(options.providerId).toBe("kiro");

		const models = await options.fetchDynamicModels?.();
		expect(global.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:8080/v1/models",
			expect.objectContaining({ method: "GET" }),
		);

		const opus = models?.find(model => model.id === "claude-opus-4.6");
		expect(opus?.api).toBe("anthropic-messages");
		expect(opus?.provider).toBe("kiro");
		expect(opus?.baseUrl).toBe("http://127.0.0.1:8080/v1");
		// Bedrock/CodeWhisperer behind the relay rejects strict tool schemas.
		expect(opus?.compat?.disableStrictTools).toBe(true);
		// Kiro meters subscription credits per request, not per token.
		expect(opus?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});

	test("fills token limits for dotted Kiro ids from the bundled catalog", async () => {
		mockKiroModels([kiroEntry("claude-opus-4.6"), kiroEntry("claude-sonnet-5")]);

		const models = await kiroOptions().fetchDynamicModels?.();

		// Kiro ids are dotted; the bundled catalog is dashed (`claude-opus-4-6`).
		const opus = models?.find(model => model.id === "claude-opus-4.6");
		expect(opus?.contextWindow).toBe(1000000);
		expect(opus?.maxTokens).toBe(128000);

		const sonnet = models?.find(model => model.id === "claude-sonnet-5");
		expect(sonnet?.contextWindow).toBe(1000000);
		expect(sonnet?.maxTokens).toBe(128000);
	});

	test("marks thinking twins as reasoning models", async () => {
		mockKiroModels([
			kiroEntry("claude-opus-4.6"),
			kiroEntry("claude-opus-4.6-thinking"),
			kiroEntry("qwen3-coder-next"),
			kiroEntry("qwen3-coder-next-thinking"),
		]);

		const models = await kiroOptions().fetchDynamicModels?.();

		expect(models?.find(model => model.id === "claude-opus-4.6-thinking")?.reasoning).toBe(true);
		expect(models?.find(model => model.id === "qwen3-coder-next-thinking")?.reasoning).toBe(true);
		// The twin inherits the base model's limits.
		expect(models?.find(model => model.id === "claude-opus-4.6-thinking")?.contextWindow).toBe(1000000);
		// Base ids without a bundled counterpart and outside the reasoning families stay plain.
		expect(models?.find(model => model.id === "qwen3-coder-next")?.reasoning).toBe(false);
	});

	test("falls back to family prefixes for ids with no bundled counterpart", async () => {
		mockKiroModels([kiroEntry("deepseek-3.2"), kiroEntry("minimax-m2.1", { supportsImage: false })]);

		const models = await kiroOptions().fetchDynamicModels?.();

		expect(models?.find(model => model.id === "deepseek-3.2")?.reasoning).toBe(true);
		expect(models?.find(model => model.id === "minimax-m2.1")?.reasoning).toBe(true);
	});

	test("honors relay-reported modalities per model", async () => {
		mockKiroModels([
			kiroEntry("claude-sonnet-4.5"),
			kiroEntry("glm-5", { supportsImage: false }),
			{ id: "legacy-entry", object: "model", owned_by: "anthropic", supports_image: true },
		]);

		const models = await kiroOptions().fetchDynamicModels?.();

		expect(models?.find(model => model.id === "claude-sonnet-4.5")?.input).toEqual(["text", "image"]);
		expect(models?.find(model => model.id === "glm-5")?.input).toEqual(["text"]);
		// Relays that only send the boolean still advertise vision.
		expect(models?.find(model => model.id === "legacy-entry")?.input).toEqual(["text", "image"]);
	});

	test("drops the relay's hardcoded OpenAI aliases", async () => {
		mockKiroModels([
			kiroEntry("claude-sonnet-4.6"),
			kiroEntry("auto"),
			kiroEntry("auto", { ownedBy: "kiro-proxy" }),
			kiroEntry("gpt-4o", { ownedBy: "kiro-proxy" }),
			kiroEntry("gpt-4", { ownedBy: "kiro-proxy" }),
		]);

		const models = await kiroOptions().fetchDynamicModels?.();

		// `gpt-4o`/`gpt-4` resolve to a Claude model upstream, so they must not surface.
		expect(models?.map(model => model.id).sort()).toEqual(["auto", "claude-sonnet-4.6"]);
	});

	test("leaves the router lane on discovery defaults", async () => {
		mockKiroModels([kiroEntry("auto")]);

		const models = await kiroOptions().fetchDynamicModels?.();

		// OpenRouter bundles an unrelated `auto` (2M context / 30K output); importing
		// its limits for Kiro's router lane would advertise ceilings nobody verified.
		const router = models?.find(model => model.id === "auto");
		expect(router?.contextWindow).not.toBe(2000000);
		expect(router?.maxTokens).not.toBe(30000);
		expect(router?.reasoning).toBe(false);
	});

	test("discovers against an overridden relay base URL", async () => {
		mockKiroModels([kiroEntry("claude-sonnet-5")]);

		const models = await kiroOptions({ baseUrl: "http://127.0.0.1:8317" }).fetchDynamicModels?.();

		expect(global.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:8317/v1/models",
			expect.objectContaining({ method: "GET" }),
		);
		expect(models?.[0]?.baseUrl).toBe("http://127.0.0.1:8317/v1");
	});

	test("skips discovery without a relay credential", () => {
		// `127.0.0.1:8080` is also llama.cpp's default, so an unconditional probe
		// would discover an unrelated server's models as Kiro entitlements.
		const options = kiroModelManagerOptions();
		expect(options.providerId).toBe("kiro");
		expect(options.fetchDynamicModels).toBeUndefined();
	});

	test("sends the relay key as a bearer token when configured", async () => {
		mockKiroModels([kiroEntry("claude-sonnet-5")]);

		await kiroOptions().fetchDynamicModels?.();

		const headers = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.headers as Record<
			string,
			string
		>;
		expect(headers.Authorization).toBe("Bearer kiro-relay-test");
	});

	test("returns null when the relay is not running", async () => {
		global.fetch = vi.fn(async () => {
			throw new Error("connect ECONNREFUSED 127.0.0.1:8080");
		}) as unknown as typeof fetch;

		const models = await kiroOptions().fetchDynamicModels?.();
		expect(models).toBeNull();
	});
});
