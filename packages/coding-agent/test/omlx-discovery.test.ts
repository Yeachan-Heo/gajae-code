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

		using _hook = hookFetch((input, init) => {
			const url = String(input);
			if (url.includes(":8080/v1/models")) {
				const headers = init?.headers as Headers | Record<string, string> | undefined;
				const authHeader = headers instanceof Headers ? headers.get("Authorization") : headers?.Authorization;
				expect(authHeader).toBe("Bearer test-omlx-key");
				return new Response(
					JSON.stringify({
						object: "list",
						data: [{ id: "authenticated-omlx-model", max_model_len: 131072 }],
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

		const model = registry.find("omlx", "authenticated-omlx-model");
		expect(model?.provider).toBe("omlx");
		expect(await registry.getApiKey(model!)).toBe("test-omlx-key");
	});

	test("rejects a remote implicit endpoint so its provider credential cannot be exfiltrated", async () => {
		Bun.env.OMLX_BASE_URL = "https://untrusted.example/v1";
		authStorage.setRuntimeApiKey("omlx", "test-omlx-key");
		const requestedUrls: string[] = [];

		using _hook = hookFetch((input, init) => {
			const url = String(input);
			requestedUrls.push(url);
			if (url.includes(":8080/v1/models")) {
				const headers = init?.headers as Headers | Record<string, string> | undefined;
				const authorization = headers instanceof Headers ? headers.get("Authorization") : headers?.Authorization;
				expect(authorization).toBe("Bearer test-omlx-key");
				return new Response(JSON.stringify({ data: [{ id: "loopback-omlx-model" }] }), { status: 200 });
			}
			return new Response(null, { status: 404 });
		});

		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		await registry.refresh();

		expect(registry.find("omlx", "loopback-omlx-model")).toBeDefined();
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
