import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { UNK_CONTEXT_WINDOW, UNK_MAX_TOKENS } from "@gajae-code/ai";
import { hookFetch, Snowflake } from "@gajae-code/utils";
import { kNoAuth } from "../src/config/model-auth";
import { ModelRegistry } from "../src/config/model-registry";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { AuthStorage } from "../src/session/auth-storage";

describe("ModelRegistry vLLM Discovery", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let authStorage: AuthStorage;
	let origApiKey: string | undefined;
	let origBaseUrl: string | undefined;

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = path.join(os.tmpdir(), `pi-test-vllm-discovery-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = path.join(tempDir, "models.json");
		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		origApiKey = process.env.VLLM_API_KEY ?? Bun.env.VLLM_API_KEY;
		origBaseUrl = process.env.VLLM_BASE_URL ?? Bun.env.VLLM_BASE_URL;
		delete process.env.VLLM_API_KEY;
		delete Bun.env.VLLM_API_KEY;
		delete process.env.VLLM_BASE_URL;
		delete Bun.env.VLLM_BASE_URL;
	});

	afterEach(() => {
		resetSettingsForTest();
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true });
		}
		if (origApiKey !== undefined) {
			process.env.VLLM_API_KEY = origApiKey;
			Bun.env.VLLM_API_KEY = origApiKey;
		} else {
			delete process.env.VLLM_API_KEY;
			delete Bun.env.VLLM_API_KEY;
		}
		if (origBaseUrl !== undefined) {
			process.env.VLLM_BASE_URL = origBaseUrl;
			Bun.env.VLLM_BASE_URL = origBaseUrl;
		} else {
			delete process.env.VLLM_BASE_URL;
			delete Bun.env.VLLM_BASE_URL;
		}
	});

	test("auto-discovers vLLM models and maps context length from max_model_len", async () => {
		using _hook = hookFetch(input => {
			const url = String(input);
			if (url.includes(":8000/v1/models")) {
				return new Response(
					JSON.stringify({
						object: "list",
						data: [
							{
								id: "Qwen3.5-122B-A10B-Q4",
								object: "model",
								max_model_len: 262144,
							},
						],
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
			return new Response(null, { status: 404 });
		});

		const hasAuthSpy = spyOn(authStorage, "hasAuth").mockReturnValue(false);
		const hasSpy = spyOn(authStorage, "has").mockReturnValue(false);
		const apiKeySpy = spyOn(authStorage, "getApiKey").mockImplementation(async provider => {
			if (provider === "vllm") return undefined;
			return undefined;
		});

		try {
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refresh();

			const allModels = registry.getAll();
			const vllmModel = allModels.find(m => m.provider === "vllm" && m.id === "Qwen3.5-122B-A10B-Q4");
			expect(vllmModel).toBeDefined();
			expect(vllmModel?.contextWindow).toBe(262144);

			const available = registry.getAvailable();
			expect(available.some(m => m.provider === "vllm")).toBe(true);

			const apiKey = await registry.getApiKey(vllmModel!);
			expect(apiKey).toBe(kNoAuth);
		} finally {
			apiKeySpy.mockRestore();
			hasAuthSpy.mockRestore();
			hasSpy.mockRestore();
		}
	});

	test("forwards configured vLLM auth during discovery when configured", async () => {
		authStorage.setRuntimeApiKey("vllm", "test-vllm-key");

		using _hook = hookFetch((input, init) => {
			const url = String(input);
			if (url.includes(":8000/v1/models")) {
				expect(init?.redirect).toBe("error");
				const headers = init?.headers as Headers | Record<string, string> | undefined;
				const authHeader = headers instanceof Headers ? headers.get("Authorization") : headers?.Authorization;
				expect(authHeader).toBe("Bearer test-vllm-key");
				return new Response(
					JSON.stringify({
						object: "list",
						data: [{ id: "authenticated-vllm-model", max_model_len: 131072 }],
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
			return new Response(null, { status: 404 });
		});

		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		await registry.refresh();

		const model = registry.find("vllm", "authenticated-vllm-model");
		expect(model?.provider).toBe("vllm");
		expect(await registry.getApiKey(model!)).toBe("test-vllm-key");
	});

	test("honors a trusted remote VLLM_BASE_URL when a credential is present", async () => {
		Bun.env.VLLM_BASE_URL = "https://trusted-vllm.example/v1";
		authStorage.setRuntimeApiKey("vllm", "test-vllm-key");

		using _hook = hookFetch((input, init) => {
			expect(String(input)).toBe("https://trusted-vllm.example/v1/models");
			expect(init?.redirect).toBe("error");
			const headers = init?.headers as Headers | Record<string, string> | undefined;
			const authHeader = headers instanceof Headers ? headers.get("Authorization") : headers?.Authorization;
			expect(authHeader).toBe("Bearer test-vllm-key");
			return new Response(JSON.stringify({ data: [{ id: "remote-vllm-model" }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		await registry.refreshProvider("vllm", "online");

		expect(registry.find("vllm", "remote-vllm-model")?.baseUrl).toBe("https://trusted-vllm.example/v1");
	});

	test("treats the empty-login vLLM sentinel as keyless", async () => {
		authStorage.setRuntimeApiKey("vllm", "vllm-local");

		using _hook = hookFetch((input, init) => {
			if (!String(input).includes(":8000/v1/models")) return new Response(null, { status: 404 });
			const headers = init?.headers as Headers | Record<string, string> | undefined;
			const authHeader = headers instanceof Headers ? headers.get("Authorization") : headers?.Authorization;
			expect(authHeader).toBeUndefined();
			return new Response(JSON.stringify({ data: [{ id: "sentinel-keyless-vllm-model" }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		await registry.refresh();

		expect(registry.find("vllm", "sentinel-keyless-vllm-model")).toBeDefined();
	});

	test("neutralizes a stored legacy sentinel and preserves the environment key", async () => {
		await authStorage.set("vllm", { type: "api_key", key: "vllm-local" });
		Bun.env.VLLM_API_KEY = "env-vllm-key";

		using _hook = hookFetch((input, init) => {
			const url = String(input);
			if (!url.includes(":8000/v1/models")) return new Response(null, { status: 404 });
			const headers = init?.headers as Headers | Record<string, string> | undefined;
			const authHeader = headers instanceof Headers ? headers.get("Authorization") : headers?.Authorization;
			expect(authHeader).toBe("Bearer env-vllm-key");
			return new Response(JSON.stringify({ data: [{ id: "legacy-sentinel-vllm-model" }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		// AuthStorage intentionally retains stored-credential precedence; the model
		// registry must recognize this historical marker before it reaches inference.
		expect(await authStorage.getApiKey("vllm")).toBe("vllm-local");

		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		await registry.refreshProvider("vllm", "online");
		const model = registry.find("vllm", "legacy-sentinel-vllm-model");
		expect(model).toBeDefined();
		expect(await registry.getApiKey(model!)).toBe("env-vllm-key");
	});

	test("maps a stored legacy sentinel to keyless auth when no environment key exists", async () => {
		await authStorage.set("vllm", { type: "api_key", key: "vllm-local" });

		using _hook = hookFetch(input => {
			if (!String(input).includes(":8000/v1/models")) return new Response(null, { status: 404 });
			return new Response(JSON.stringify({ data: [{ id: "legacy-keyless-vllm-model" }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		await registry.refreshProvider("vllm", "online");
		const model = registry.find("vllm", "legacy-keyless-vllm-model");
		expect(model).toBeDefined();
		expect(await registry.getApiKey(model!)).toBe(kNoAuth);
	});

	test("does not let the empty-login vLLM sentinel authorize remote discovery", async () => {
		Bun.env.VLLM_BASE_URL = "https://vllm.example.test/v1";
		authStorage.setRuntimeApiKey("vllm", "vllm-local");
		let requestedRemote = false;

		using _hook = hookFetch(input => {
			if (String(input) === "https://vllm.example.test/v1/models") requestedRemote = true;
			return new Response(null, { status: 404 });
		});

		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		await registry.refresh();

		expect(requestedRemote).toBe(false);
	});

	test("accepts a loopback VLLM_BASE_URL override for the implicit endpoint", async () => {
		Bun.env.VLLM_BASE_URL = "http://127.0.0.1:19000/v1";
		const requestedUrls: string[] = [];

		using _hook = hookFetch(input => {
			const url = String(input);
			requestedUrls.push(url);
			if (url.includes(":19000/v1/models")) {
				return new Response(JSON.stringify({ data: [{ id: "custom-port-vllm-model" }] }), { status: 200 });
			}
			return new Response(null, { status: 404 });
		});

		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		await registry.refresh();

		expect(registry.find("vllm", "custom-port-vllm-model")).toBeDefined();
		expect(requestedUrls.some(url => url.includes(":8000/v1/models"))).toBe(false);
	});

	test("skips malformed records and bounds vLLM limits to finite positive values", async () => {
		using _hook = hookFetch(input => {
			if (!String(input).includes(":8000/v1/models")) return new Response(null, { status: 404 });
			return new Response(
				'{"data":[{"id":"invalid-limits","max_model_len":1e400,"context_length":-1,"max_tokens":0},{"id":"fractional-limits","max_model_len":1.5,"max_tokens":2.5},{"id":"unsafe-limits","max_model_len":9007199254740992,"max_tokens":9007199254740992},{"id":42},{"id":"valid-model","max_model_len":"131072","max_tokens":"8192"}]}',
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		await registry.refresh();

		expect(registry.find("vllm", "invalid-limits")?.contextWindow).toBe(UNK_CONTEXT_WINDOW);
		expect(registry.find("vllm", "invalid-limits")?.maxTokens).toBe(UNK_MAX_TOKENS);
		expect(registry.find("vllm", "fractional-limits")?.contextWindow).toBe(UNK_CONTEXT_WINDOW);
		expect(registry.find("vllm", "fractional-limits")?.maxTokens).toBe(UNK_MAX_TOKENS);
		expect(registry.find("vllm", "unsafe-limits")?.contextWindow).toBe(UNK_CONTEXT_WINDOW);
		expect(registry.find("vllm", "unsafe-limits")?.maxTokens).toBe(UNK_MAX_TOKENS);
		expect(registry.find("vllm", "42")).toBeUndefined();
		expect(registry.find("vllm", "valid-model")?.contextWindow).toBe(131072);
		expect(registry.find("vllm", "valid-model")?.maxTokens).toBe(8192);
	});

	test("treats an unreachable implicit vLLM server as optional", async () => {
		using _hook = hookFetch((input, init) => {
			if (String(input).includes(":8000/v1/models")) {
				const response = Promise.withResolvers<Response>();
				init?.signal?.addEventListener(
					"abort",
					() => response.reject(new DOMException("The operation was aborted", "AbortError")),
					{ once: true },
				);
				return response.promise;
			}
			return new Response(null, { status: 404 });
		});

		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		const startedAt = performance.now();
		await registry.refresh();

		expect(performance.now() - startedAt).toBeLessThan(2_000);
		expect(registry.getAll().some(model => model.provider === "vllm" && model.id === "unreachable")).toBe(false);
	});

	test("suppresses implicit vLLM descriptor discovery when the provider is disabled", async () => {
		await Settings.init({
			inMemory: true,
			overrides: {
				disabledProviders: ["llama.cpp", "lm-studio", "ollama", "omlx", "vllm"],
			},
		});
		const requestedUrls: string[] = [];
		using _hook = hookFetch(input => {
			const url = String(input);
			requestedUrls.push(url);
			throw new Error(`Unexpected URL: ${url}`);
		});

		const registry = new ModelRegistry(authStorage, modelsJsonPath);

		await registry.refresh("online");

		expect(requestedUrls.some(url => url.includes("127.0.0.1:8000"))).toBe(false);
	});

	test("suppresses implicit vLLM discovery when vllm is explicitly configured in models.yml", async () => {
		fs.writeFileSync(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					vllm: {
						baseUrl: "http://127.0.0.1:8000/v1",
						api: "openai-completions",
						auth: "none",
						models: [{ id: "configured-vllm-model" }],
					},
				},
			}),
		);
		const requestedUrls: string[] = [];
		using _hook = hookFetch(input => {
			const url = String(input);
			requestedUrls.push(url);
			if (url === "http://127.0.0.1:8000/v1/models") throw new Error(`Unexpected vLLM discovery request: ${url}`);
			return new Response(null, { status: 404 });
		});

		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		expect(registry.getDiscoverableProviders()).not.toContain("vllm");

		await registry.refresh();

		expect(registry.find("vllm", "configured-vllm-model")).toBeDefined();
		expect(requestedUrls).not.toContain("http://127.0.0.1:8000/v1/models");
	});

	test("does not apply oMLX-only reasoning metadata to discovered vLLM models", async () => {
		// The qwen-chat-template / reasoning-effort inference in #discoverOpenAIModelsList is
		// gated on `providerConfig.provider === "omlx"` and intentionally NOT extended to vLLM
		// (see design doc section 5 / model-registry.ts ~L3286) — vLLM models should discover
		// with plain, non-reasoning compat metadata instead.
		using _hook = hookFetch(input => {
			if (!String(input).includes(":8000/v1/models")) return new Response(null, { status: 404 });
			return new Response(
				JSON.stringify({
					data: [{ id: "Qwen3.6-35B-A3B-8bit", max_model_len: 262144 }],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		await registry.refresh();

		const model = registry.find("vllm", "Qwen3.6-35B-A3B-8bit");
		expect(model?.reasoning).toBeFalsy();
		expect(model?.thinking).toBeUndefined();
		expect(model?.compat).toBeUndefined();
	});
});
