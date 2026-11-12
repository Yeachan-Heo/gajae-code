import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { UNK_CONTEXT_WINDOW, UNK_MAX_TOKENS } from "@gajae-code/ai";
import { hookFetch, Snowflake } from "@gajae-code/utils";
import { kNoAuth } from "../src/config/model-auth";
import { ModelRegistry } from "../src/config/model-registry";
import { AuthStorage } from "../src/session/auth-storage";

describe("ModelRegistry Rapid-MLX Discovery", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let authStorage: AuthStorage;
	let origApiKey: string | undefined;
	let origBaseUrl: string | undefined;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-test-rapid-mlx-discovery-${Snowflake.next()}`);
		await fs.mkdir(tempDir, { recursive: true });
		modelsJsonPath = path.join(tempDir, "models.json");
		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		origApiKey = process.env.RAPID_MLX_API_KEY ?? Bun.env.RAPID_MLX_API_KEY;
		origBaseUrl = process.env.RAPID_MLX_BASE_URL ?? Bun.env.RAPID_MLX_BASE_URL;
		delete process.env.RAPID_MLX_API_KEY;
		delete Bun.env.RAPID_MLX_API_KEY;
		delete process.env.RAPID_MLX_BASE_URL;
		delete Bun.env.RAPID_MLX_BASE_URL;
	});

	afterEach(async () => {
		authStorage.close();
		if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
		if (origApiKey !== undefined) {
			process.env.RAPID_MLX_API_KEY = origApiKey;
			Bun.env.RAPID_MLX_API_KEY = origApiKey;
		} else {
			delete process.env.RAPID_MLX_API_KEY;
			delete Bun.env.RAPID_MLX_API_KEY;
		}
		if (origBaseUrl !== undefined) {
			process.env.RAPID_MLX_BASE_URL = origBaseUrl;
			Bun.env.RAPID_MLX_BASE_URL = origBaseUrl;
		} else {
			delete process.env.RAPID_MLX_BASE_URL;
			delete Bun.env.RAPID_MLX_BASE_URL;
		}
	});
	test("auto-discovers Rapid-MLX models and maps context length from context_window", async () => {
		using _hook = hookFetch(input => {
			const url = String(input);
			if (url === "http://localhost:8000/v1/models") {
				return new Response(
					JSON.stringify({
						object: "list",
						data: [
							{
								id: "mlx-community/Qwen3.5-4B-MLX-4bit",
								object: "model",
								context_window: 262144,
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
			if (provider === "rapid-mlx") return undefined;
			return undefined;
		});

		try {
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refresh();

			const allModels = registry.getAll();
			const rapidMlxModel = allModels.find(
				m => m.provider === "rapid-mlx" && m.id === "mlx-community/Qwen3.5-4B-MLX-4bit",
			);
			expect(rapidMlxModel).toBeDefined();
			expect(rapidMlxModel?.contextWindow).toBe(262144);

			const available = registry.getAvailable();
			expect(available.some(m => m.provider === "rapid-mlx")).toBe(true);

			const apiKey = await registry.getApiKey(rapidMlxModel!);
			expect(apiKey).toBe(kNoAuth);
		} finally {
			apiKeySpy.mockRestore();
			hasAuthSpy.mockRestore();
			hasSpy.mockRestore();
		}
	});

	test("forwards configured Rapid-MLX auth during discovery when configured", async () => {
		authStorage.setRuntimeApiKey("rapid-mlx", "test-rapid-mlx-key");

		using _hook = hookFetch((input, init) => {
			const url = String(input);
			if (url === "http://localhost:8000/v1/models") {
				const headers = init?.headers as Headers | Record<string, string> | undefined;
				const authHeader = headers instanceof Headers ? headers.get("Authorization") : headers?.Authorization;
				expect(authHeader).toBe("Bearer test-rapid-mlx-key");
				return new Response(
					JSON.stringify({
						object: "list",
						data: [{ id: "authenticated-rapid-mlx-model", context_window: 131072 }],
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

		const model = registry.find("rapid-mlx", "authenticated-rapid-mlx-model");
		expect(model?.provider).toBe("rapid-mlx");
		expect(await registry.getApiKey(model!)).toBe("test-rapid-mlx-key");
	});

	test("rejects a remote implicit endpoint so its provider credential cannot be exfiltrated", async () => {
		Bun.env.RAPID_MLX_BASE_URL = "https://untrusted.example/v1";
		authStorage.setRuntimeApiKey("rapid-mlx", "test-rapid-mlx-key");
		const requestedUrls: string[] = [];

		using _hook = hookFetch((input, init) => {
			const url = String(input);
			requestedUrls.push(url);
			if (url === "http://localhost:8000/v1/models") {
				const headers = init?.headers as Headers | Record<string, string> | undefined;
				const authorization = headers instanceof Headers ? headers.get("Authorization") : headers?.Authorization;
				expect(authorization).toBe("Bearer test-rapid-mlx-key");
				return new Response(JSON.stringify({ data: [{ id: "loopback-rapid-mlx-model" }] }), { status: 200 });
			}
			return new Response(null, { status: 404 });
		});

		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		await registry.refresh();

		expect(registry.find("rapid-mlx", "loopback-rapid-mlx-model")).toBeDefined();
		expect(requestedUrls.some(url => url.includes("untrusted.example"))).toBe(false);
	});

	test("skips malformed records and bounds Rapid-MLX limits to finite positive values", async () => {
		using _hook = hookFetch(input => {
			if (String(input) !== "http://localhost:8000/v1/models") return new Response(null, { status: 404 });
			return new Response(
				'{"data":[{"id":"invalid-limits","context_window":1e400,"context_length":-1,"max_tokens":0},{"id":42},{"id":"valid-model","context_window":"131072","max_tokens":"8192"}]}',
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		await registry.refresh();

		expect(registry.find("rapid-mlx", "invalid-limits")?.contextWindow).toBe(UNK_CONTEXT_WINDOW);
		expect(registry.find("rapid-mlx", "invalid-limits")?.maxTokens).toBe(UNK_MAX_TOKENS);
		expect(registry.find("rapid-mlx", "42")).toBeUndefined();
		expect(registry.find("rapid-mlx", "valid-model")?.contextWindow).toBe(131072);
		expect(registry.find("rapid-mlx", "valid-model")?.maxTokens).toBe(8192);
	});

	test("uses a loopback endpoint override without probing the default port", async () => {
		Bun.env.RAPID_MLX_BASE_URL = "http://127.0.0.1:8477/v1";
		const requestedUrls: string[] = [];
		using _hook = hookFetch(input => {
			const url = String(input);
			requestedUrls.push(url);
			if (url === "http://127.0.0.1:8477/v1/models") {
				return Response.json({ data: [{ id: "custom-port-model", context_window: 131072 }] });
			}
			return new Response(null, { status: 404 });
		});
		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		await registry.refresh();
		expect(registry.find("rapid-mlx", "custom-port-model")?.baseUrl).toBe("http://127.0.0.1:8477/v1");
		expect(requestedUrls.includes("http://localhost:8000/v1/models")).toBe(false);
	});

	test("honors explicit rapid-mlx discovery configuration", async () => {
		await Bun.write(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					"rapid-mlx": {
						api: "openai-completions",
						auth: "none",
						baseUrl: "http://localhost:8123/v1",
						discovery: { type: "rapid-mlx" },
					},
				},
			}),
		);
		const requestedUrls: string[] = [];
		using _hook = hookFetch(input => {
			const url = String(input);
			requestedUrls.push(url);
			if (url === "http://localhost:8123/v1/models") {
				return Response.json({ data: [{ id: "explicit-model", context_window: 131072 }] });
			}
			return new Response(null, { status: 404 });
		});
		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		await registry.refresh();
		expect(registry.find("rapid-mlx", "explicit-model")?.contextWindow).toBe(131072);
		expect(requestedUrls.includes("http://localhost:8000/v1/models")).toBe(false);
	});
});
