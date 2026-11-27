import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { UNK_CONTEXT_WINDOW, UNK_MAX_TOKENS } from "@gajae-code/ai";
import { hookFetch, Snowflake } from "@gajae-code/utils";
import { kNoAuth } from "../src/config/model-auth";
import { ModelRegistry } from "../src/config/model-registry";
import { AuthStorage } from "../src/session/auth-storage";

describe("ModelRegistry oMLX Discovery", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let authStorage: AuthStorage;
	let origApiKey: string | undefined;
	let origBaseUrl: string | undefined;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-test-omlx-discovery-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = path.join(tempDir, "models.json");
		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		origApiKey = process.env.OMLX_API_KEY ?? Bun.env.OMLX_API_KEY;
		origBaseUrl = process.env.OMLX_BASE_URL ?? Bun.env.OMLX_BASE_URL;
		delete process.env.OMLX_API_KEY;
		delete Bun.env.OMLX_API_KEY;
		delete process.env.OMLX_BASE_URL;
		delete Bun.env.OMLX_BASE_URL;
	});

	afterEach(() => {
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true });
		}
		if (origApiKey !== undefined) {
			process.env.OMLX_API_KEY = origApiKey;
			Bun.env.OMLX_API_KEY = origApiKey;
		} else {
			delete process.env.OMLX_API_KEY;
			delete Bun.env.OMLX_API_KEY;
		}
		if (origBaseUrl !== undefined) {
			process.env.OMLX_BASE_URL = origBaseUrl;
			Bun.env.OMLX_BASE_URL = origBaseUrl;
		} else {
			delete process.env.OMLX_BASE_URL;
			delete Bun.env.OMLX_BASE_URL;
		}
	});
	test("auto-discovers oMLX models and maps context length from max_model_len", async () => {
		using _hook = hookFetch(input => {
			const url = String(input);
			if (url.includes(":8080/v1/models")) {
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
			if (provider === "omlx") return undefined;
			return undefined;
		});

		try {
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refresh();

			const allModels = registry.getAll();
			const omlxModel = allModels.find(m => m.provider === "omlx" && m.id === "Qwen3.5-122B-A10B-Q4");
			expect(omlxModel).toBeDefined();
			expect(omlxModel?.contextWindow).toBe(262144);

			const available = registry.getAvailable();
			expect(available.some(m => m.provider === "omlx")).toBe(true);

			const apiKey = await registry.getApiKey(omlxModel!);
			expect(apiKey).toBe(kNoAuth);
		} finally {
			apiKeySpy.mockRestore();
			hasAuthSpy.mockRestore();
			hasSpy.mockRestore();
		}
	});

	test("forwards configured oMLX auth during discovery when configured", async () => {
		authStorage.setRuntimeApiKey("omlx", "test-omlx-key");
		const endpoint = "http://127.0.0.1:18117/v1";
		Bun.env.OMLX_BASE_URL = endpoint;
		const requestedUrls: string[] = [];
		const authorizations: (string | null)[] = [];
		// Observe the discovery request through the fetch hook: a credentialed oMLX
		// probe is not a transport exemption, so it takes the ordinary `fetch` path
		// that an ambient proxy can redirect. The hook keeps this assertion about the
		// bearer independent of that configuration; the fresh-child inverse test in
		// model-registry.test.ts remains the wire-level proof that the request target
		// is the configured proxy. `bun test` strips proxy variables in its preload, but
		// preload-free and E2E invocations do not, so those must control
		// HTTP_PROXY/HTTPS_PROXY/ALL_PROXY explicitly.
		using _hook = hookFetch((input, init) => {
			const url = String(input);
			requestedUrls.push(url);
			if (url !== `${endpoint}/models`) return new Response(null, { status: 404 });
			authorizations.push(new Headers(init?.headers).get("authorization"));
			return Response.json({
				object: "list",
				data: [{ id: "authenticated-omlx-model", max_model_len: 131072 }],
			});
		});

		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		// Provider-scoped so this case cannot probe Ollama, llama.cpp, LM Studio, or
		// the implicit Rapid-MLX hook (whose direct socket bypasses the fetch hook).
		await registry.refreshProvider("omlx", "online");

		expect(requestedUrls).toEqual([`${endpoint}/models`]);
		expect(authorizations).toEqual(["Bearer test-omlx-key"]);
		const model = registry.find("omlx", "authenticated-omlx-model");
		expect(model?.provider).toBe("omlx");
		expect(await registry.getApiKey(model!)).toBe("test-omlx-key");
	});

	test("rejects a remote implicit endpoint so its provider credential cannot be exfiltrated", async () => {
		Bun.env.OMLX_BASE_URL = "https://untrusted.example/v1";
		authStorage.setRuntimeApiKey("omlx", "test-omlx-key");
		const authorizations: (string | null)[] = [];
		const requestedUrls: string[] = [];
		// The remote endpoint is rewritten to the loopback default before the probe.
		// A credential does not change the transport, so the ordinary discovery
		// `fetch` is observable here: serve the loopback catalog through the hook and
		// record where the bearer would have gone.
		using _hook = hookFetch((input, init) => {
			const url = String(input);
			requestedUrls.push(url);
			if (!url.includes(":8080/v1/models")) return new Response(null, { status: 404 });
			authorizations.push(new Headers(init?.headers).get("authorization"));
			return Response.json({ data: [{ id: "loopback-omlx-model" }] });
		});

		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		// Provider-scoped refresh: the oMLX probe is the only one this case observes.
		await registry.refreshProvider("omlx", "online");

		expect(registry.find("omlx", "loopback-omlx-model")).toBeDefined();
		expect(requestedUrls).toContain("http://127.0.0.1:8080/v1/models");
		expect(authorizations).toEqual(["Bearer test-omlx-key"]);
		expect(requestedUrls.some(url => url.includes("untrusted.example"))).toBe(false);
	});

	test("skips malformed records and bounds oMLX limits to finite positive values", async () => {
		using _hook = hookFetch(input => {
			if (!String(input).includes(":8080/v1/models")) return new Response(null, { status: 404 });
			return new Response(
				'{"data":[{"id":"invalid-limits","max_model_len":1e400,"context_length":-1,"max_tokens":0},{"id":42},{"id":"valid-model","max_model_len":"131072","max_tokens":"8192"}]}',
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		await registry.refresh();

		expect(registry.find("omlx", "invalid-limits")?.contextWindow).toBe(UNK_CONTEXT_WINDOW);
		expect(registry.find("omlx", "invalid-limits")?.maxTokens).toBe(UNK_MAX_TOKENS);
		expect(registry.find("omlx", "42")).toBeUndefined();
		expect(registry.find("omlx", "valid-model")?.contextWindow).toBe(131072);
		expect(registry.find("omlx", "valid-model")?.maxTokens).toBe(8192);
	});
	test("marks discovered oMLX models as reasoning with low/medium/high effort", async () => {
		using _hook = hookFetch(input => {
			if (!String(input).includes(":8080/v1/models")) return new Response(null, { status: 404 });
			return new Response(
				JSON.stringify({
					data: [{ id: "Qwen3.6-35B-A3B-8bit", max_model_len: 262144 }],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		await registry.refresh();

		const model = registry.find("omlx", "Qwen3.6-35B-A3B-8bit");
		expect(model?.reasoning).toBe(true);
		expect(model?.thinking).toMatchObject({
			mode: "effort",
			minLevel: "low",
			maxLevel: "high",
			defaultLevel: "medium",
		});
		expect(model?.compat).toMatchObject({
			supportsReasoningEffort: true,
			thinkingFormat: "qwen-chat-template",
		});
	});
});
