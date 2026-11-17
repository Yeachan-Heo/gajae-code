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
	test("project .env cannot redirect a trusted key", async () => {
		const projectDir = path.join(tempDir, "project");
		const agentDir = path.join(tempDir, "agent");
		await fs.mkdir(projectDir);
		await fs.mkdir(agentDir);
		const trustedAuthorizations: (string | null)[] = [];
		const trustedServer = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch(request) {
				if (new URL(request.url).pathname !== "/v1/models") return new Response(null, { status: 404 });
				trustedAuthorizations.push(request.headers.get("authorization"));
				return Response.json({ data: [{ id: "trusted-model", context_window: 131072 }] });
			},
		});
		let untrustedRequests = 0;
		const untrustedServer = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch() {
				untrustedRequests++;
				return new Response(null, { status: 404 });
			},
		});
		try {
			const trustedBaseUrl = `http://127.0.0.1:${trustedServer.port}/v1`;
			const untrustedBaseUrl = `http://127.0.0.1:${untrustedServer.port}/v1`;
			await Bun.write(path.join(projectDir, ".env"), `RAPID_MLX_BASE_URL=${untrustedBaseUrl}\n`);
			await Bun.write(
				path.join(agentDir, ".env"),
				`RAPID_MLX_API_KEY=trusted-rapid-key\nRAPID_MLX_BASE_URL=${trustedBaseUrl}\n`,
			);
			const env: Record<string, string | undefined> = { ...process.env, GJC_CODING_AGENT_DIR: agentDir };
			delete env.RAPID_MLX_BASE_URL;
			delete env.RAPID_MLX_API_KEY;
			const child = Bun.spawn(
				[process.execPath, path.join(import.meta.dir, "fixtures", "rapid-mlx-trust-probe.ts"), tempDir],
				{ cwd: projectDir, env, stdout: "pipe", stderr: "pipe" },
			);
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
			const result = JSON.parse(stdout);
			// The project declared a different endpoint and it stayed loaded in the
			// process, but neither the registry nor the descriptor sent the trusted key
			// there: both used the agent-owned endpoint.
			expect(result.projectUrl).toBe(untrustedBaseUrl);
			expect(result.trustedUrl).toBe(trustedBaseUrl);
			expect(result.modelBaseUrl).toBe(trustedBaseUrl);
			expect(trustedAuthorizations).toEqual(["Bearer trusted-rapid-key", "Bearer trusted-rapid-key"]);
			expect(untrustedRequests).toBe(0);
		} finally {
			trustedServer.stop(true);
			untrustedServer.stop(true);
		}
	}, 15_000);

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
		const authorizations: (string | null)[] = [];
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch(request) {
				if (new URL(request.url).pathname !== "/v1/models") return new Response(null, { status: 404 });
				authorizations.push(request.headers.get("authorization"));
				return Response.json({
					object: "list",
					data: [{ id: "authenticated-rapid-mlx-model", context_window: 131072 }],
				});
			},
		});
		try {
			// A credentialed loopback discovery request is issued over a direct socket,
			// so the assertions run against a real server instead of a fetch hook.
			Bun.env.RAPID_MLX_BASE_URL = `http://127.0.0.1:${server.port}/v1`;
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refresh();

			expect(authorizations).toEqual(["Bearer test-rapid-mlx-key"]);
			const model = registry.find("rapid-mlx", "authenticated-rapid-mlx-model");
			expect(model?.provider).toBe("rapid-mlx");
			expect(await registry.getApiKey(model!)).toBe("test-rapid-mlx-key");
		} finally {
			server.stop(true);
		}
	});

	test("rejects a remote implicit endpoint so discovery stays on loopback", async () => {
		Bun.env.RAPID_MLX_BASE_URL = "https://untrusted.example/v1";
		const requestedUrls: string[] = [];

		using _hook = hookFetch(input => {
			const url = String(input);
			requestedUrls.push(url);
			if (url === "http://localhost:8000/v1/models") {
				return new Response(
					JSON.stringify({ data: [{ id: "loopback-rapid-mlx-model", context_window: 131072 }] }),
					{
						status: 200,
					},
				);
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

	test("treats an unreachable Rapid-MLX server as optional", async () => {
		using _hook = hookFetch((input, init) => {
			if (String(input) === "http://localhost:8000/v1/models") {
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

		// Local discovery must abort quickly instead of waiting out the remote
		// models-list timeout, which would stall every registry refresh.
		expect(performance.now() - startedAt).toBeLessThan(2_000);
		expect(registry.getProviderDiscoveryState("rapid-mlx")?.models).toEqual([]);
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

	test("does not publish a vLLM-only endpoint on the shared default port", async () => {
		// vLLM also serves `http://127.0.0.1:8000/v1` and answers the same
		// OpenAI `/v1/models` shape, so the response alone cannot name the
		// implementation. vLLM keeps its own catalog; the implicit Rapid-MLX probe
		// must not republish the same rows under a provider that resolves
		// RAPID_MLX_API_KEY.
		const vllmCatalog = {
			object: "list",
			data: [{ id: "meta-llama/Llama-3.1-8B-Instruct", object: "model", max_model_len: 131072 }],
		};
		using _hook = hookFetch(input => {
			const url = String(input);
			if (url === "http://localhost:8000/v1/models" || url === "http://127.0.0.1:8000/v1/models") {
				return Response.json(vllmCatalog);
			}
			return new Response(null, { status: 404 });
		});

		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		await registry.refresh();

		expect(registry.find("vllm", "meta-llama/Llama-3.1-8B-Instruct")?.contextWindow).toBe(131072);
		expect(registry.find("rapid-mlx", "meta-llama/Llama-3.1-8B-Instruct")).toBeUndefined();
		expect(registry.getAvailable().some(model => model.provider === "rapid-mlx")).toBe(false);
		expect(registry.getProviderDiscoveryState("rapid-mlx")?.models).toEqual([]);
	});

	test("takes an explicit rapid-mlx selection at its word when the catalog is unidentified", async () => {
		// The identity check exists to keep an unrequested vLLM endpoint from being
		// attributed to Rapid-MLX. An operator who names rapid-mlx in models.json
		// has made that attribution themselves.
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
		using _hook = hookFetch(input => {
			if (String(input) === "http://localhost:8123/v1/models") {
				return Response.json({ data: [{ id: "operator-selected-model" }] });
			}
			return new Response(null, { status: 404 });
		});
		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		await registry.refresh();
		expect(registry.find("rapid-mlx", "operator-selected-model")).toBeDefined();
	});

	test("does not reuse a cache row admitted under explicit selection for the implicit probe", async () => {
		// An operator who names rapid-mlx at the shared port admits bare vLLM rows as
		// written, and those rows are cached. Removing the config switches to the
		// implicit probe, whose admission policy requires a Rapid-MLX-native field.
		// Cache reuse skips admission, so the policy is part of the cache provenance:
		// the cached rows must not surface under the implicit provider.
		const bareVllmCatalog = {
			object: "list",
			data: [{ id: "bare-vllm-row", object: "model", max_model_len: 8192 }],
		};
		await Bun.write(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					"rapid-mlx": {
						api: "openai-completions",
						auth: "none",
						baseUrl: "http://localhost:8000/v1",
						discovery: { type: "rapid-mlx" },
					},
				},
			}),
		);
		using _explicitSelectionFetch = hookFetch(() => Response.json(bareVllmCatalog));
		const explicitRegistry = new ModelRegistry(authStorage, modelsJsonPath);
		await explicitRegistry.refresh();
		expect(explicitRegistry.find("rapid-mlx", "bare-vllm-row")).toBeDefined();

		await Bun.write(modelsJsonPath, JSON.stringify({ providers: {} }));
		using _implicitProbeFetch = hookFetch(() => Response.json(bareVllmCatalog));
		// Both cache-consuming strategies read the row the operator selection wrote,
		// not a row rewritten by an earlier iteration, so each strategy is tested
		// against the foreign-policy cache independently.
		const cacheDirectory = path.dirname(modelsJsonPath);
		const cacheSnapshot = new Map<string, Uint8Array>();
		for (const name of await fs.readdir(cacheDirectory)) {
			if (!name.startsWith("models.db")) continue;
			cacheSnapshot.set(name, new Uint8Array(await Bun.file(path.join(cacheDirectory, name)).arrayBuffer()));
		}
		expect(cacheSnapshot.size).toBeGreaterThan(0);
		const restoreCacheSnapshot = async () => {
			for (const name of await fs.readdir(cacheDirectory)) {
				if (name.startsWith("models.db") && !cacheSnapshot.has(name)) {
					await fs.rm(path.join(cacheDirectory, name), { force: true });
				}
			}
			for (const [name, bytes] of cacheSnapshot) await Bun.write(path.join(cacheDirectory, name), bytes);
		};
		for (const strategy of ["online-if-uncached", "offline"] as const) {
			await restoreCacheSnapshot();
			const implicitRegistry = new ModelRegistry(authStorage, modelsJsonPath);
			await implicitRegistry.refresh(strategy);
			expect({
				strategy,
				ids: implicitRegistry
					.getAll()
					.filter(m => m.provider === "rapid-mlx")
					.map(m => m.id),
			}).toEqual({
				strategy,
				ids: [],
			});
		}

		using _nativeRowFetch = hookFetch(() =>
			Response.json({ object: "list", data: [{ id: "native-row", context_window: 131072 }] }),
		);
		// Control 1: a row that WAS admitted under the implicit policy keeps serving an
		// offline refresh, so opening the model selector (which refreshes offline) does
		// not blank an admitted Rapid-MLX catalog.
		for (const name of await fs.readdir(cacheDirectory)) {
			if (name.startsWith("models.db")) await fs.rm(path.join(cacheDirectory, name), { force: true });
		}
		const admittedOnlineRegistry = new ModelRegistry(authStorage, modelsJsonPath);
		await admittedOnlineRegistry.refresh("online");
		expect(admittedOnlineRegistry.find("rapid-mlx", "native-row")).toBeDefined();
		const admittedOfflineRegistry = new ModelRegistry(authStorage, modelsJsonPath);
		await admittedOfflineRegistry.refresh("offline");
		expect(admittedOfflineRegistry.find("rapid-mlx", "native-row")).toBeDefined();

		// Control 2: the offline cache path itself serves a rapid-mlx row when the
		// admission policy does not require wire-only evidence. An explicit selection
		// is trusted as written, so its cached row survives an offline refresh; the
		// empty results above are the policy boundary, not an inert path.
		await Bun.write(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					"rapid-mlx": {
						api: "openai-completions",
						auth: "none",
						baseUrl: "http://localhost:8000/v1",
						discovery: { type: "rapid-mlx" },
					},
				},
			}),
		);
		for (const name of await fs.readdir(cacheDirectory)) {
			if (name.startsWith("models.db")) await fs.rm(path.join(cacheDirectory, name), { force: true });
		}
		const explicitOnlineRegistry = new ModelRegistry(authStorage, modelsJsonPath);
		await explicitOnlineRegistry.refresh("online");
		expect(explicitOnlineRegistry.find("rapid-mlx", "native-row")).toBeDefined();
		const explicitOfflineRegistry = new ModelRegistry(authStorage, modelsJsonPath);
		await explicitOfflineRegistry.refresh("offline");
		expect(explicitOfflineRegistry.find("rapid-mlx", "native-row")).toBeDefined();
	});

	test("keeps a credentialed loopback probe off the proxy environment", async () => {
		// A project `.env` can set HTTP_PROXY, and Bun applies it to loopback
		// requests too. The discovery request carries RAPID_MLX_API_KEY, so it must
		// reach the server directly instead of handing the bearer to the proxy.
		const serverHeaders: { authorization: string | null; aliasKey: string | null }[] = [];
		const rapidMlxServer = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch(request) {
				if (new URL(request.url).pathname !== "/v1/models") return new Response(null, { status: 404 });
				serverHeaders.push({
					authorization: request.headers.get("authorization"),
					aliasKey: request.headers.get("x-api-key"),
				});
				return Response.json({
					object: "list",
					data: [
						{ id: "proxy-probe-model", context_window: 131072 },
						{ id: "alias-model", context_window: 131072 },
					],
				});
			},
		});
		const proxyRequests: string[] = [];
		const proxyServer = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch(request) {
				proxyRequests.push(
					`${request.method} ${request.url} authorization=${request.headers.get("authorization") ?? "none"}`,
				);
				return new Response("loopback discovery must not use the proxy", { status: 502 });
			},
		});
		try {
			const projectDir = path.join(tempDir, "proxy-project");
			const agentDir = path.join(tempDir, "proxy-agent");
			const scratchDir = path.join(tempDir, "proxy-scratch");
			await fs.mkdir(projectDir);
			await fs.mkdir(agentDir);
			await fs.mkdir(scratchDir);
			// A custom alias that declares Rapid-MLX discovery and carries a secret in a
			// non-Authorization header. `auth: none` keeps the provider keyless, so the
			// header is its only credential.
			await Bun.write(
				path.join(scratchDir, "models.json"),
				JSON.stringify({
					providers: {
						"alias-mlx": {
							api: "openai-completions",
							auth: "none",
							baseUrl: `http://127.0.0.1:${rapidMlxServer.port}/v1`,
							headers: { "X-API-Key": "header-secret" },
							discovery: { type: "rapid-mlx" },
						},
					},
				}),
			);
			const inheritedEnv: Record<string, string> = {};
			for (const [name, value] of Object.entries(process.env)) {
				if (value === undefined) continue;
				const normalized = name.toLowerCase();
				if (
					normalized === "http_proxy" ||
					normalized === "https_proxy" ||
					normalized === "all_proxy" ||
					normalized === "no_proxy"
				) {
					continue;
				}
				inheritedEnv[name] = value;
			}
			const proxyUrl = `http://127.0.0.1:${proxyServer.port}`;
			const child = Bun.spawn(
				[process.execPath, path.join(import.meta.dir, "fixtures", "rapid-mlx-proxy-probe.ts"), scratchDir],
				{
					cwd: projectDir,
					env: {
						...inheritedEnv,
						GJC_CODING_AGENT_DIR: agentDir,
						HTTP_PROXY: proxyUrl,
						http_proxy: proxyUrl,
						HTTPS_PROXY: proxyUrl,
						https_proxy: proxyUrl,
						ALL_PROXY: proxyUrl,
						all_proxy: proxyUrl,
						RAPID_MLX_API_KEY: "proxy-probe-key",
						RAPID_MLX_BASE_URL: `http://127.0.0.1:${rapidMlxServer.port}/v1`,
					},
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
			const result = JSON.parse(stdout);
			expect(result.modelIds).toContain("proxy-probe-model");
			expect(result.aliasModelIds).toContain("alias-model");
			expect(result.baseUrl).toBe(`http://127.0.0.1:${rapidMlxServer.port}/v1`);
			// Bun keeps using a proxy it has already used, so the fixture clears the proxy
			// variables before discovery; the credentials still take the direct socket
			// because the transport does not depend on reading them.
			expect(result.proxyVariablesCleared).toBe(true);
			// Registry discovery and the library descriptor both send the bearer.
			expect(serverHeaders.filter(headers => headers.authorization === "Bearer proxy-probe-key")).toHaveLength(2);
			// The alias carries its secret in a non-Authorization header and also arrived
			// directly, so the credential rule is not limited to `Authorization`.
			expect(serverHeaders.filter(headers => headers.aliasKey === "header-secret")).toHaveLength(1);
			// The fixture's control `fetch` to the same loopback origin went through the
			// proxy, proving the proxy configuration was live for the child; the
			// credentialed discovery requests did not.
			expect(proxyRequests.some(request => request.includes("/v1/control"))).toBe(true);
			expect(proxyRequests.filter(request => request.includes("proxy-probe-key"))).toEqual([]);
			expect(proxyRequests.filter(request => request.includes("header-secret"))).toEqual([]);
			expect(proxyRequests.filter(request => request.includes(`:${rapidMlxServer.port}/v1/models`))).toEqual([]);
		} finally {
			rapidMlxServer.stop(true);
			proxyServer.stop(true);
		}
	}, 20_000);
});
