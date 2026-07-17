import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "../src/auth-storage";
import { getBundledModel } from "../src/models";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "../src/provider-models/descriptors";
import { fuguModelManagerOptions } from "../src/provider-models/openai-compat";
import { getEnvApiKey } from "../src/stream";
import { getOAuthProviders, refreshOAuthToken } from "../src/utils/oauth";

const originalFuguApiKey = Bun.env.FUGU_API_KEY;
const originalFetch = global.fetch;

afterEach(() => {
	if (originalFuguApiKey === undefined) {
		delete Bun.env.FUGU_API_KEY;
	} else {
		Bun.env.FUGU_API_KEY = originalFuguApiKey;
	}
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("Sakana Fugu provider support", () => {
	test("resolves FUGU_API_KEY from environment", () => {
		Bun.env.FUGU_API_KEY = "fugu-test-key";
		expect(getEnvApiKey("fugu")).toBe("fugu-test-key");
	});

	test("registers built-in descriptor and default model", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "fugu");
		expect(descriptor).toBeDefined();
		expect(descriptor?.defaultModel).toBe("fugu");
		expect(descriptor?.catalogDiscovery?.envVars).toContain("FUGU_API_KEY");
		expect(DEFAULT_MODEL_PER_PROVIDER.fugu).toBe("fugu");
	});

	test("registers API-key auth selector without inventing OAuth endpoints", () => {
		const provider = getOAuthProviders().find(item => item.id === "fugu");
		expect(provider?.name).toBe("Sakana Fugu (API key)");
	});

	test("bundles Fugu and Fugu Ultra as OpenAI-compatible chat models", () => {
		const fugu = getBundledModel("fugu", "fugu");
		const ultra = getBundledModel("fugu", "fugu-ultra");
		expect(fugu.provider).toBe("fugu");
		expect(fugu.api).toBe("openai-completions");
		expect(fugu.baseUrl).toBe("https://api.sakana.ai/v1");
		expect(fugu.api).toBe("openai-completions");
		expect((fugu.compat as { maxTokensField?: string } | undefined)?.maxTokensField).toBe("max_tokens");
		expect(ultra.name).toBe("Sakana Fugu Ultra");
		expect(ultra.reasoning).toBe(true);
	});

	test("stores Fugu login as a built-in API key credential", async () => {
		global.fetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ data: [{ id: "fugu" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		) as unknown as typeof fetch;

		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-fugu-auth-"));
		const store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		try {
			const authStorage = new AuthStorage(store);
			await authStorage.login("fugu", {
				onAuth: info => {
					expect(info.url).toBe("https://console.sakana.ai/api-keys");
				},
				onPrompt: async prompt => {
					expect(prompt.message).toContain("Sakana Fugu");
					return " fish-test-key ";
				},
			});

			expect(global.fetch).toHaveBeenCalledWith(
				"https://api.sakana.ai/v1/models",
				expect.objectContaining({
					method: "GET",
					headers: { Authorization: "Bearer fish-test-key" },
				}),
			);
			expect(await authStorage.getApiKey("fugu")).toBe("fish-test-key");
		} finally {
			store.close();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("treats Fugu API-key OAuth credentials as non-expiring refresh credentials", async () => {
		const credential = { access: "fugu-test-key", refresh: "fugu-test-key", expires: Date.now() - 1 };
		await expect(refreshOAuthToken("fugu", credential)).resolves.toBe(credential);
	});

	test("discovers OpenAI-compatible models with configurable base URL", async () => {
		global.fetch = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						data: [
							{ id: "fugu", name: "Fugu", context_length: 200000, max_completion_tokens: 65536 },
							{ id: "fugu-ultra", name: "Fugu Ultra", context_length: 200000, max_completion_tokens: 65536 },
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		) as unknown as typeof fetch;

		const options = fuguModelManagerOptions({ apiKey: "fugu-test-key", baseUrl: "https://fugu.example/v1" });
		expect(options.providerId).toBe("fugu");
		expect(options.fetchDynamicModels).toBeDefined();

		const models = await options.fetchDynamicModels?.();
		expect(global.fetch).toHaveBeenCalledWith(
			"https://fugu.example/v1/models",
			expect.objectContaining({ method: "GET" }),
		);
		expect(models?.map(model => model.id)).toEqual(["fugu", "fugu-ultra"]);
		expect(models?.[0]?.baseUrl).toBe("https://fugu.example/v1");
	});
});
