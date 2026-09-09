import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setImmediate } from "node:timers/promises";
import { AuthStorage, SqliteAuthCredentialStore } from "@gajae-code/ai";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { CustomProviderWizardComponent } from "@gajae-code/coding-agent/modes/components/custom-provider-wizard";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import {
	addApiCompatibleProvider,
	formatProviderSetupResult,
	probeOpenAIModelsList,
} from "@gajae-code/coding-agent/setup/provider-onboarding";
import { getAgentDir, hookFetch, setAgentDir } from "@gajae-code/utils";
import { YAML } from "bun";

const originalAgentDir = getAgentDir();
let tempRoot: string | undefined;

beforeAll(async () => {
	await initTheme(false);
});

afterEach(async () => {
	setAgentDir(originalAgentDir);
	if (tempRoot) {
		await fs.rm(tempRoot, { recursive: true, force: true });
		tempRoot = undefined;
	}
});

async function tempModelsPath(): Promise<string> {
	tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-5387-discovery-"));
	setAgentDir(path.join(tempRoot, "agent"));
	return path.join(tempRoot, "models.yml");
}

function modelsListResponse(ids: string[]): Response {
	return new Response(JSON.stringify({ object: "list", data: ids.map(id => ({ id })) }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

function typeText(component: { handleInput(input: string): void }, text: string): void {
	for (const char of text) component.handleInput(char);
}

describe("issue #5387 custom provider auto-discovery", () => {
	it("persists discovery config and refreshes the live catalog without duplicates", async () => {
		const modelsPath = await tempModelsPath();
		const result = await addApiCompatibleProvider({
			compatibility: "openai",
			providerId: "gateway",
			baseUrl: "https://gateway.example.com/v1",
			apiKeyEnv: "GATEWAY_KEY",
			models: ["static-one"],
			discover: true,
			discoverySignal: expect.any(AbortSignal),
			modelsPath,
		});

		expect(result.discoveryEnabled).toBe(true);
		expect(result.discoveryType).toBe("openai-models-list");
		expect(formatProviderSetupResult(result)).toContain("Discovery: live OpenAI /v1/models catalog");

		const parsed = YAML.parse(await Bun.file(modelsPath).text()) as {
			providers: Record<string, { discovery?: { type: string }; models: Array<{ id: string }> }>;
		};
		expect(parsed.providers.gateway?.discovery).toEqual({ type: "openai-models-list" });

		process.env.GATEWAY_KEY = "sk-gateway";
		try {
			using _hook = hookFetch(input => {
				if (!String(input).endsWith("/models")) throw new Error(`Unexpected URL: ${String(input)}`);
				return modelsListResponse(["static-one", "discovered-two", "discovered-two"]);
			});
			const store = await SqliteAuthCredentialStore.open(path.join(tempRoot!, "agent.db"));
			try {
				const authStorage = new AuthStorage(store);
				const registry = new ModelRegistry(authStorage, modelsPath);
				await registry.refreshProvider("gateway");
				const ids = registry
					.getAll()
					.filter(model => model.provider === "gateway")
					.map(model => model.id)
					.sort();
				expect(ids).toEqual(["discovered-two", "static-one"]);
				expect(registry.getProviderDiscoveryState("gateway")?.status).toBe("ok");
			} finally {
				store.close();
			}
		} finally {
			delete process.env.GATEWAY_KEY;
		}
	});

	it("allows discovery-only setup with no manual models", async () => {
		const modelsPath = await tempModelsPath();
		const result = await addApiCompatibleProvider({
			compatibility: "openai",
			providerId: "discover-only",
			baseUrl: "https://gateway.example.com/v1",
			apiKeyEnv: "GATEWAY_KEY",
			discover: true,
			discoverySignal: expect.any(AbortSignal),
			modelsPath,
			probeDiscovery: async () => ({ models: ["live-one"], endpoint: "https://gateway.example.com/v1/models" }),
		});
		expect(result.modelIds).toEqual([]);
		expect(result.discoveryEnabled).toBe(true);
	});

	it("refuses to write config when cancelled after the probe resolves", async () => {
		const modelsPath = await tempModelsPath();
		const controller = new AbortController();
		await expect(
			addApiCompatibleProvider({
				compatibility: "openai",
				providerId: "cancelled-gateway",
				baseUrl: "https://gateway.example.com/v1",
				apiKeyEnv: "GATEWAY_KEY",
				discover: true,
				modelsPath,
				discoverySignal: controller.signal,
				probeDiscovery: async () => {
					// Resolve the probe, then simulate a revision/cancel
					// landing in the persistence window.
					controller.abort(new Error("revision superseded"));
					return { models: ["live-model"], endpoint: "https://gateway.example.com/v1/models" };
				},
			}),
		).rejects.toThrow("was cancelled; setup did not write any config");
		expect(await Bun.file(modelsPath).exists()).toBe(false);
	});

	it("merges with concurrent config changes made during the probe", async () => {
		const modelsPath = await tempModelsPath();
		const { promise: probeGate, resolve: releaseProbe } = Promise.withResolvers<void>();
		const { promise: writerGate, resolve: releaseWriter } = Promise.withResolvers<void>();
		const probe = addApiCompatibleProvider({
			compatibility: "openai",
			providerId: "concurrent-gateway",
			baseUrl: "https://gateway.example.com/v1",
			apiKeyEnv: "GATEWAY_KEY",
			discover: true,
			modelsPath,
			probeDiscovery: async () => {
				// A concurrent writer lands while the probe is in flight.
				releaseWriter();
				await probeGate;
				return { models: ["live-model"], endpoint: "https://gateway.example.com/v1/models" };
			},
		});
		await writerGate;
		await addApiCompatibleProvider({
			compatibility: "openai",
			providerId: "other-provider",
			baseUrl: "https://other.example.com/v1",
			apiKeyEnv: "GATEWAY_KEY",
			models: ["other-model"],
			modelsPath,
		});
		releaseProbe();
		const result = await probe;
		expect(result.providerId).toBe("concurrent-gateway");
		const parsed = YAML.parse(await Bun.file(modelsPath).text()) as {
			providers: Record<string, { models?: Array<{ id: string }> }>;
		};
		// Both providers survive: the post-probe merge must not clobber
		// the concurrent writer's entry.
		expect(Object.keys(parsed.providers).sort()).toEqual(["concurrent-gateway", "other-provider"]);
		expect(parsed.providers["other-provider"]?.models?.map(model => model.id)).toEqual(["other-model"]);
	});

	it("rolls back the literal credential when cancelled during persistence", async () => {
		const modelsPath = await tempModelsPath();
		const controller = new AbortController();
		const { promise: setGate, resolve: resolveSet } = Promise.withResolvers<void>();
		const store = await SqliteAuthCredentialStore.open(path.join(tempRoot!, "agent.db"));
		try {
			const authStorage = new AuthStorage(store);
			const probeController = controller;
			await expect(
				addApiCompatibleProvider({
					compatibility: "openai",
					providerId: "rollback-gateway",
					baseUrl: "https://gateway.example.com/v1",
					apiKey: "sk-literal-live",
					discover: true,
					modelsPath,
					authStorage: {
						exportSnapshot: () => authStorage.exportSnapshot(),
						set: async (...args: Parameters<AuthStorage["set"]>) => {
							const result = await authStorage.set(...args);
							// Simulate a delayed credential store: abort while
							// the write is resolving, before models.yml lands.
							probeController.abort(new Error("revision superseded"));
							resolveSet();
							return result;
						},
						remove: (...args: Parameters<AuthStorage["remove"]>) => authStorage.remove(...args),
					},
					discoverySignal: controller.signal,
					probeDiscovery: async () => ({
						models: ["live-model"],
						endpoint: "https://gateway.example.com/v1/models",
					}),
				}),
			).rejects.toThrow("was cancelled; setup did not write any config");
			await setGate;
			expect(await Bun.file(modelsPath).exists()).toBe(false);
			expect(authStorage.has("rollback-gateway")).toBe(false);
		} finally {
			store.close();
		}
	});

	it("restores the prior credential when a force replacement is cancelled mid-write", async () => {
		const modelsPath = await tempModelsPath();
		const controller = new AbortController();
		const store = await SqliteAuthCredentialStore.open(path.join(tempRoot!, "agent.db"));
		try {
			const authStorage = new AuthStorage(store);
			await authStorage.set("force-gateway", { type: "api_key", key: "sk-old-key" });
			const { promise: setGate, resolve: resolveSet } = Promise.withResolvers<void>();
			await expect(
				addApiCompatibleProvider({
					compatibility: "openai",
					providerId: "force-gateway",
					baseUrl: "https://gateway.example.com/v1",
					apiKey: "sk-new-key",
					discover: true,
					force: true,
					modelsPath,
					authStorage: {
						exportSnapshot: () => authStorage.exportSnapshot(),
						set: async (...args: Parameters<AuthStorage["set"]>) => {
							const result = await authStorage.set(...args);
							controller.abort(new Error("revision superseded"));
							resolveSet();
							return result;
						},
						remove: (...args: Parameters<AuthStorage["remove"]>) => authStorage.remove(...args),
					},
					discoverySignal: controller.signal,
					probeDiscovery: async () => ({
						models: ["live-model"],
						endpoint: "https://gateway.example.com/v1/models",
					}),
				}),
			).rejects.toThrow("was cancelled; setup did not write any config");
			await setGate;
			expect(await Bun.file(modelsPath).exists()).toBe(false);
			expect(await authStorage.peekApiKey("force-gateway")).toBe("sk-old-key");
		} finally {
			store.close();
		}
	});

	it("refuses setup when cancelled while acquiring the config lock", async () => {
		const modelsPath = await tempModelsPath();
		const controller = new AbortController();
		controller.abort(new Error("cancelled before lock"));
		await expect(
			addApiCompatibleProvider({
				compatibility: "openai",
				providerId: "locked-gateway",
				baseUrl: "https://gateway.example.com/v1",
				apiKeyEnv: "GATEWAY_KEY",
				discover: true,
				modelsPath,
				discoverySignal: controller.signal,
				probeDiscovery: async () => ({
					models: ["live-model"],
					endpoint: "https://gateway.example.com/v1/models",
				}),
			}),
		).rejects.toThrow("was cancelled; setup did not write any config");
		expect(await Bun.file(modelsPath).exists()).toBe(false);
	});

	it("refuses force replacement over non-API-key credentials when cancellable", async () => {
		const modelsPath = await tempModelsPath();
		const controller = new AbortController();
		const store = await SqliteAuthCredentialStore.open(path.join(tempRoot!, "agent.db"));
		try {
			await expect(
				addApiCompatibleProvider({
					compatibility: "openai",
					providerId: "oauth-gateway",
					baseUrl: "https://gateway.example.com/v1",
					apiKey: "sk-new-key",
					discover: true,
					force: true,
					modelsPath,
					authStorage: {
						exportSnapshot: () => ({
							generation: 1,
							generatedAt: Date.now(),
							credentials: [
								{
									id: 7,
									provider: "oauth-gateway",
									credential: {
										type: "oauth",
										access: "tok",
										refresh: "__remote__",
										expires: Date.now() + 3600000,
									},
									identityKey: null,
								},
							],
						}),
						set: async () => undefined,
						remove: async () => undefined,
					},
					discoverySignal: controller.signal,
					probeDiscovery: async () => ({
						models: ["live-model"],
						endpoint: "https://gateway.example.com/v1/models",
					}),
				}),
			).rejects.toThrow("non-API-key credentials");
			expect(await Bun.file(modelsPath).exists()).toBe(false);
		} finally {
			store.close();
		}
	});

	it("fails discovery-only setup loudly when the endpoint is unreachable", async () => {
		const modelsPath = await tempModelsPath();
		await expect(
			addApiCompatibleProvider({
				compatibility: "openai",
				providerId: "dead-gateway",
				baseUrl: "https://gateway.example.com/v1",
				apiKeyEnv: "GATEWAY_KEY",
				discover: true,
				discoverySignal: expect.any(AbortSignal),
				modelsPath,
				probeDiscovery: async () => {
					throw new Error("Model discovery failed for https://gateway.example.com/v1/models: fetch failed");
				},
			}),
		).rejects.toThrow("Model discovery failed for https://gateway.example.com/v1/models");
		expect(await Bun.file(modelsPath).exists()).toBe(false);
	});

	it("fails discovery-only setup when the catalog is empty", async () => {
		const modelsPath = await tempModelsPath();
		await expect(
			addApiCompatibleProvider({
				compatibility: "openai",
				providerId: "empty-gateway",
				baseUrl: "https://gateway.example.com/v1",
				apiKeyEnv: "GATEWAY_KEY",
				discover: true,
				discoverySignal: expect.any(AbortSignal),
				modelsPath,
				probeDiscovery: async () => ({ models: [], endpoint: "https://gateway.example.com/v1/models" }),
			}),
		).rejects.toThrow("returned no models");
	});

	it("rejects unsafe model IDs from the probe before rendering or persisting", async () => {
		const evil = "good-model\n\u001b[2J\u001b]0;spoofed\u0007";
		using _hook = hookFetch(() => modelsListResponse(["good-model", evil, "x".repeat(300), "  ", "good-model"]));
		const result = await probeOpenAIModelsList({
			baseUrl: "https://gateway.example.com/v1",
			apiKey: "sk-test",
		});
		expect(result.models).toEqual(["good-model"]);
	});

	it("rejects oversized discovery responses without buffering them", async () => {
		using _hook = hookFetch(
			() =>
				new Response("x".repeat(64), {
					status: 200,
					headers: { "Content-Type": "application/json", "Content-Length": "2000000" },
				}),
		);
		await expect(
			probeOpenAIModelsList({ baseUrl: "https://gateway.example.com/v1", apiKey: "sk-test" }),
		).rejects.toThrow("exceeds the size limit");
	});

	it("rejects streamed discovery responses that overflow the size limit", async () => {
		const big = "y".repeat(2_000_000);
		using _hook = hookFetch(
			() =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode(big));
							controller.close();
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		);
		await expect(
			probeOpenAIModelsList({ baseUrl: "https://gateway.example.com/v1", apiKey: "sk-test" }),
		).rejects.toThrow("exceeds the size limit");
	});

	for (const source of ["env", "literal"] as const) {
		it(`automatically probes once per fresh ${source} credential entry without another Enter`, async () => {
			const pending = Promise.withResolvers<{ models: string[] }>();
			const requests: Array<{ apiKeyEnv?: string; apiKey?: string }> = [];
			const wizard = new CustomProviderWizardComponent(
				() => undefined,
				() => undefined,
				() => undefined,
				{
					discoverModels: request => {
						requests.push(request);
						return requests.length === 1 ? pending.promise : Promise.resolve({ models: ["fresh-model"] });
					},
				},
			);
			wizard.handleInput("\n");
			typeText(wizard, "automatic-provider");
			wizard.handleInput("\n");
			typeText(wizard, "https://api.example.com/v1");
			wizard.handleInput("\n");
			if (source === "literal") wizard.handleInput("\x1b[B");
			wizard.handleInput("\n");
			typeText(wizard, source === "env" ? "AUTO_KEY" : "sk-auto-key");
			wizard.handleInput("\n");
			await setImmediate();
			expect(requests).toHaveLength(1);
			expect(requests[0]).toMatchObject(source === "env" ? { apiKeyEnv: "AUTO_KEY" } : { apiKey: "sk-auto-key" });
			// Renders and repeated Enter while probing must not issue another request.
			wizard.render(100);
			wizard.handleInput("\n");
			wizard.handleInput("\n");
			await setImmediate();
			expect(requests).toHaveLength(1);
			pending.resolve({ models: ["first-model"] });
			await setImmediate();
			expect(wizard.render(100).join("\n")).toContain("first-model");
			wizard.handleInput("\x1b");
			typeText(wizard, source === "env" ? "_2" : "sk-revised-key");
			wizard.handleInput("\n");
			await setImmediate();
			expect(requests).toHaveLength(2);
			expect(requests[1]).toMatchObject(
				source === "env" ? { apiKeyEnv: "AUTO_KEY_2" } : { apiKey: "sk-revised-key" },
			);
			expect(wizard.render(100).join("\n")).toContain("fresh-model");
			// Returning from manual entry keeps the fresh preview, without probing on render.
			wizard.handleInput("\x1b[B");
			wizard.handleInput("\n");
			wizard.handleInput("\x1b");
			await setImmediate();
			expect(requests).toHaveLength(2);
			expect(wizard.render(100).join("\n")).toContain("fresh-model");
		});
	}

	for (const outcome of ["success", "failure"] as const) {
		it(`ignores late discovery ${outcome} after backing out to credential-source selection`, async () => {
			const pending = Promise.withResolvers<{ models: string[] }>();
			let signal: AbortSignal | undefined;
			const wizard = new CustomProviderWizardComponent(
				() => undefined,
				() => undefined,
				() => undefined,
				{
					discoverModels: request => {
						signal = request.signal;
						return pending.promise;
					},
				},
			);
			wizard.handleInput("\n");
			typeText(wizard, "late-provider");
			wizard.handleInput("\n");
			typeText(wizard, "https://api.example.com/v1");
			wizard.handleInput("\n");
			wizard.handleInput("\n");
			typeText(wizard, "LATE_KEY");
			wizard.handleInput("\n");
			await setImmediate();
			wizard.handleInput("\x1b");
			expect(signal?.aborted).toBe(true);
			wizard.handleInput("\x1b");
			if (outcome === "success") wizard.handleInput("\x1b[B");
			const before = wizard.render(100);
			if (outcome === "success") pending.resolve({ models: ["late-model"] });
			else pending.reject(new Error("late failure"));
			await setImmediate();
			expect(wizard.render(100)).toEqual(before);
			wizard.handleInput("\n");
			expect(wizard.render(100).join("\n")).toContain(
				outcome === "success" ? "Paste the API key:" : "Enter the API key environment variable name:",
			);
		});
	}

	it("automatically probes empty catalogs once and retains explicit retry and manual fallback", async () => {
		let calls = 0;
		const wizard = new CustomProviderWizardComponent(
			() => undefined,
			() => undefined,
			() => undefined,
			{
				discoverModels: async () => {
					calls += 1;
					return { models: [] };
				},
			},
		);
		wizard.handleInput("\n");
		typeText(wizard, "empty-provider");
		wizard.handleInput("\n");
		typeText(wizard, "https://api.example.com/v1");
		wizard.handleInput("\n");
		wizard.handleInput("\n");
		typeText(wizard, "EMPTY_KEY");
		wizard.handleInput("\n");
		await setImmediate();
		expect(calls).toBe(1);
		expect(wizard.render(100).join("\n")).toContain("The endpoint returned no models.");
		wizard.handleInput("\n");
		await setImmediate();
		expect(calls).toBe(2);
		wizard.handleInput("\x1b[B");
		wizard.handleInput("\n");
		expect(wizard.render(100).join("\n")).toContain("Enter model ids, comma-separated:");
	});

	it("keeps Anthropic credentials on manual entry without probing", async () => {
		let calls = 0;
		const wizard = new CustomProviderWizardComponent(
			() => undefined,
			() => undefined,
			() => undefined,
			{
				discoverModels: async () => {
					calls += 1;
					throw new Error("Anthropic must not request an OpenAI catalog");
				},
			},
		);
		wizard.handleInput("\x1b[B");
		wizard.handleInput("\n");
		typeText(wizard, "anthropic-provider");
		wizard.handleInput("\n");
		typeText(wizard, "https://api.example.com/v1");
		wizard.handleInput("\n");
		wizard.handleInput("\n");
		typeText(wizard, "ANTHROPIC_KEY");
		wizard.handleInput("\n");
		await setImmediate();
		expect(calls).toBe(0);
		expect(wizard.render(100).join("\n")).toContain("Continue with manual model ids.");
		wizard.handleInput("\n");
		expect(wizard.render(100).join("\n")).toContain("Enter model ids, comma-separated:");
	});

	it("wizard ignores discovery completions superseded by input edits", async () => {
		const { promise: gate, resolve: release } = Promise.withResolvers<string[]>();
		const seen: string[] = [];
		let calls = 0;
		const submissions: unknown[] = [];
		const wizard = new CustomProviderWizardComponent(
			input => submissions.push(input),
			() => undefined,
			() => undefined,
			{
				discoverModels: async request => {
					seen.push(`${request.baseUrl}|${request.apiKeyEnv ?? request.apiKey}`);
					calls += 1;
					// Only the first probe hangs; re-probes resolve immediately.
					return { models: calls === 1 ? await gate : ["fresh-model"] };
				},
			},
		);
		wizard.handleInput("\n");
		typeText(wizard, "race-provider");
		wizard.handleInput("\n");
		typeText(wizard, "https://api.example.com/v1");
		wizard.handleInput("\n");
		wizard.handleInput("\n");
		typeText(wizard, "FIRST_KEY");
		wizard.handleInput("\n");
		// Credential submission starts the probe; edit while it is in flight.
		await Promise.resolve();
		wizard.handleInput("\u001b");
		typeText(wizard, "_2");
		wizard.handleInput("\n");
		// Submitting edited inputs automatically re-probes. Resolve the stale
		// first probe: its models must be dropped, not published.
		release(["stale-model"]);
		await setImmediate();
		expect(seen).toEqual(["https://api.example.com/v1|FIRST_KEY", "https://api.example.com/v1|FIRST_KEY_2"]);
		// Accept the fresh catalog and submit: the stale completion must not
		// be rendered or accepted — only fresh-model flows into the submit.
		wizard.handleInput("\n");
		wizard.handleInput("\n");
		expect(submissions).toEqual([
			{
				compatibility: "openai",
				providerId: "race-provider",
				baseUrl: "https://api.example.com/v1",
				apiKeyEnv: "FIRST_KEY_2",
				apiKey: undefined,
				models: [],
				discover: true,
				discoverySignal: expect.any(AbortSignal),
				force: false,
			},
		]);
	});

	it("times out on a never-closing body instead of hanging setup", async () => {
		using _hook = hookFetch((_input, init) => {
			const signal = init?.signal;
			return new Response(
				new ReadableStream({
					start(controller) {
						// Never enqueues or closes; like a real fetch body,
						// error the stream when the deadline signal aborts.
						signal?.addEventListener("abort", () => {
							try {
								controller.error(new Error("Body Timeout Error"));
							} catch {
								// Stream already closed.
							}
						});
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});
		await expect(
			probeOpenAIModelsList({ baseUrl: "https://gateway.example.com/v1", apiKey: "sk-test", timeoutMs: 50 }),
		).rejects.toThrow("Model discovery failed for https://gateway.example.com/v1/models");
	});

	it("honors caller cancellation via AbortSignal", async () => {
		let observedSignal: AbortSignal | null = null;
		using _hook = hookFetch((_input, init) => {
			observedSignal = init?.signal ?? null;
			return modelsListResponse(["m"]);
		});
		const controller = new AbortController();
		controller.abort(new Error("superseded"));
		await expect(
			probeOpenAIModelsList({
				baseUrl: "https://gateway.example.com/v1",
				apiKey: "sk-test",
				signal: controller.signal,
			}),
		).rejects.toThrow("was cancelled before probing");
		expect(observedSignal).toBeNull();
	});

	it("sends the bearer on same-origin redirects without leaking it into errors", async () => {
		const seen: Array<{ url: string; auth: string | null }> = [];
		const handler = (input: unknown, init?: RequestInit): Response => {
			const headers = init?.headers;
			seen.push({
				url: String(input),
				auth:
					headers instanceof Headers
						? headers.get("Authorization")
						: ((headers as Record<string, string> | undefined)?.Authorization ?? null),
			});
			if (String(input).includes("/old-path")) {
				// Emulate fetch follow semantics: resolve the redirect target
				// with the same init (same-origin keeps Authorization).
				return handler("https://gateway.example.com/v1/models", init);
			}
			return modelsListResponse(["redirected-model"]);
		};
		using _hook = hookFetch(handler);
		const result = await probeOpenAIModelsList({
			baseUrl: "https://gateway.example.com/old-path",
			apiKey: "sk-redirect-secret",
		});
		expect(result.models).toEqual(["redirected-model"]);
		expect(seen.length).toBeGreaterThan(0);
		expect(seen.every(entry => entry.auth === "Bearer sk-redirect-secret")).toBe(true);
	});

	it("manual model entry supersedes accepted discovery", async () => {
		const submissions: unknown[] = [];
		const wizard = new CustomProviderWizardComponent(
			input => submissions.push(input),
			() => undefined,
			() => undefined,
			{ discoverModels: async () => ({ models: ["probed-model"] }) },
		);
		wizard.handleInput("\n");
		typeText(wizard, "supersede-provider");
		wizard.handleInput("\n");
		typeText(wizard, "https://api.example.com/v1");
		wizard.handleInput("\n");
		wizard.handleInput("\n");
		typeText(wizard, "SUPERSEDE_KEY");
		wizard.handleInput("\n");
		// Accept discovered models...
		await setImmediate();
		wizard.handleInput("\n");
		// ...then go back and enter a manual model instead.
		wizard.handleInput("\u001b");
		typeText(wizard, "manual-model");
		wizard.handleInput("\n");
		wizard.handleInput("\n");
		expect(submissions).toEqual([
			{
				compatibility: "openai",
				providerId: "supersede-provider",
				baseUrl: "https://api.example.com/v1",
				apiKeyEnv: "SUPERSEDE_KEY",
				apiKey: undefined,
				models: ["manual-model"],
				discover: false,
				discoverySignal: expect.any(AbortSignal),
				force: false,
			},
		]);
	});

	it("aborts the submit-time probe when inputs are revised mid-submit", async () => {
		const deferred = Promise.withResolvers<void>();
		let submitProbeSignal: AbortSignal | null | undefined;
		const wizard = new CustomProviderWizardComponent(
			input => {
				submitProbeSignal = (input as { discoverySignal?: AbortSignal }).discoverySignal;
				return deferred.promise;
			},
			() => undefined,
			() => undefined,
			{ discoverModels: async () => ({ models: ["probed-model"] }) },
		);
		wizard.handleInput("\n");
		typeText(wizard, "revise-submit-provider");
		wizard.handleInput("\n");
		typeText(wizard, "https://api.example.com/v1");
		wizard.handleInput("\n");
		wizard.handleInput("\n");
		typeText(wizard, "FIRST_KEY");
		wizard.handleInput("\n");
		await setImmediate();
		wizard.handleInput("\n");
		wizard.handleInput("\n");
		// Submit pending: Esc back (confirm -> models -> discover ->
		// credential) and save a revision. The revision must abort the
		// in-flight submit probe so the old inputs cannot be persisted.
		expect(submitProbeSignal instanceof AbortSignal).toBe(true);
		wizard.handleInput("\u001b");
		wizard.handleInput("\u001b");
		wizard.handleInput("\u001b");
		typeText(wizard, "_2");
		wizard.handleInput("\n");
		expect(submitProbeSignal?.aborted).toBe(true);
		deferred.resolve();
		await setImmediate();
	});

	it("does not erase input typed on another step when a probe settles", async () => {
		const { promise: gate, resolve: release } = Promise.withResolvers<string[]>();
		let calls = 0;
		let signal: AbortSignal | undefined;
		const submissions: unknown[] = [];
		const wizard = new CustomProviderWizardComponent(
			input => submissions.push(input),
			() => undefined,
			() => undefined,
			{
				discoverModels: async request => {
					signal = request.signal;
					calls += 1;
					return { models: calls === 1 ? await gate : ["fresh-model"] };
				},
			},
		);
		wizard.handleInput("\n");
		typeText(wizard, "noclobber-provider");
		wizard.handleInput("\n");
		typeText(wizard, "https://api.example.com/v1");
		wizard.handleInput("\n");
		wizard.handleInput("\n");
		typeText(wizard, "FIRST_KEY");
		wizard.handleInput("\n");
		await setImmediate();
		// Choose manual entry while the automatic probe is still in flight
		// and type a model id there.
		wizard.handleInput("\u001b[B");
		wizard.handleInput("\n");
		expect(signal?.aborted).toBe(true);
		typeText(wizard, "typed-model");
		release(["late-model"]);
		await setImmediate();
		// The typed input must survive the late probe completion: submit
		// the manual entry and assert it (not the late probe) is submitted.
		wizard.handleInput("\n");
		wizard.handleInput("\n");
		expect(submissions).toEqual([
			{
				compatibility: "openai",
				providerId: "noclobber-provider",
				baseUrl: "https://api.example.com/v1",
				apiKeyEnv: "FIRST_KEY",
				apiKey: undefined,
				models: ["typed-model"],
				discover: false,
				discoverySignal: expect.any(AbortSignal),
				force: false,
			},
		]);
	});

	it("invalidates a pending submit when inputs are revised", async () => {
		const deferred = Promise.withResolvers<void>();
		let capturedGeneration = -1;
		const wizard = new CustomProviderWizardComponent(
			() => deferred.promise,
			() => undefined,
			() => undefined,
			{ discoverModels: async () => ({ models: ["probed-model"] }) },
		);
		wizard.handleInput("\n");
		typeText(wizard, "generation-provider");
		wizard.handleInput("\n");
		typeText(wizard, "https://api.example.com/v1");
		wizard.handleInput("\n");
		wizard.handleInput("\n");
		typeText(wizard, "FIRST_KEY");
		wizard.handleInput("\n");
		await setImmediate();
		wizard.handleInput("\n");
		wizard.handleInput("\n");
		capturedGeneration = wizard.currentSubmitGeneration();
		expect(wizard.isSubmitCurrent(capturedGeneration)).toBe(true);
		// Esc back to credential and save a revision: the pending submit
		// generation must be invalidated.
		wizard.handleInput("\u001b");
		wizard.handleInput("\u001b");
		wizard.handleInput("\u001b");
		typeText(wizard, "_2");
		wizard.handleInput("\n");
		expect(wizard.isSubmitCurrent(capturedGeneration)).toBe(false);
		deferred.resolve();
		await setImmediate();
	});

	it("aborts the submit-time probe when the wizard is cancelled mid-submit", async () => {
		const deferred = Promise.withResolvers<void>();
		let submitSignal: AbortSignal | null | undefined;
		const wizard = new CustomProviderWizardComponent(
			input => {
				submitSignal = (input as { discoverySignal?: AbortSignal }).discoverySignal;
				return deferred.promise;
			},
			() => undefined,
			() => undefined,
			{ discoverModels: async () => ({ models: ["probed-model"] }) },
		);
		wizard.handleInput("\n");
		typeText(wizard, "submit-abort-provider");
		wizard.handleInput("\n");
		typeText(wizard, "https://api.example.com/v1");
		wizard.handleInput("\n");
		wizard.handleInput("\n");
		typeText(wizard, "SUBMIT_ABORT_KEY");
		wizard.handleInput("\n");
		await setImmediate();
		// Accept the discovered catalog (discover -> confirm)...
		wizard.handleInput("\n");
		// ...then submit from the confirm screen (stays pending).
		wizard.handleInput("\n");
		// Esc back through confirm -> models -> discover -> credential ->
		// source -> base-url -> provider-id -> compatibility (7), then cancel
		// the wizard outright with one more Esc.
		for (let i = 0; i < 7; i++) wizard.handleInput("\u001b");
		wizard.handleInput("\u001b");
		expect(submitSignal instanceof AbortSignal).toBe(true);
		expect(submitSignal?.aborted).toBe(true);
		deferred.resolve();
	});

	it("aborts the in-flight probe when the wizard is cancelled", async () => {
		let observedSignal: AbortSignal | null | undefined;
		let released = false;
		// Never resolved: the probe must be aborted by cancellation instead.
		const { promise: gate } = Promise.withResolvers<string[]>();
		const submissions: unknown[] = [];
		let cancelled = false;
		const wizard = new CustomProviderWizardComponent(
			input => submissions.push(input),
			() => {
				cancelled = true;
			},
			() => undefined,
			{
				discoverModels: async request => {
					observedSignal = request.signal ?? null;
					request.signal?.addEventListener("abort", () => {
						released = true;
					});
					return { models: await gate };
				},
			},
		);
		wizard.handleInput("\n");
		typeText(wizard, "cancel-provider");
		wizard.handleInput("\n");
		typeText(wizard, "https://api.example.com/v1");
		wizard.handleInput("\n");
		wizard.handleInput("\n");
		typeText(wizard, "CANCEL_KEY");
		wizard.handleInput("\n");
		await setImmediate();
		// Esc back through discover -> credential -> source -> base -> id ->
		// compatibility, then Esc again to cancel the wizard outright.
		for (let i = 0; i < 5; i++) wizard.handleInput("\u001b");
		wizard.handleInput("\u001b");
		expect(cancelled).toBe(true);
		expect(observedSignal?.aborted).toBe(true);
		expect(released).toBe(true);
		expect(submissions).toEqual([]);
	});

	it("resolves env credentials through the rotating reader", async () => {
		// The trusted agent env snapshot may hold a stale value while the
		// rotating reader sees the live one; the probe must use the live key.
		process.env.ROTATING_5387_KEY = "sk-live-rotated";
		try {
			let seenAuth: string | null = null;
			using _hook = hookFetch((_input, init) => {
				const headers = init?.headers;
				seenAuth =
					headers instanceof Headers
						? headers.get("Authorization")
						: ((headers as Record<string, string> | undefined)?.Authorization ?? null);
				return modelsListResponse(["rotated-model"]);
			});
			const result = await probeOpenAIModelsList({
				baseUrl: "https://gateway.example.com/v1",
				apiKeyEnv: "ROTATING_5387_KEY",
			});
			expect(result.models).toEqual(["rotated-model"]);
			expect(seenAuth as unknown as string).toBe("Bearer sk-live-rotated");
		} finally {
			delete process.env.ROTATING_5387_KEY;
		}
	});

	it("scrubs credential material from transport failure text", async () => {
		using _hook = hookFetch(() => {
			throw new Error("connection reset by peer (Authorization: Bearer sk-live-secret)");
		});
		const error = await probeOpenAIModelsList({
			baseUrl: "https://gateway.example.com/v1",
			apiKey: "sk-live-secret",
		}).catch(error => error);
		expect(String(error)).toContain("Model discovery failed for https://gateway.example.com/v1/models");
		expect(String(error)).not.toContain("sk-live-secret");
		expect(String(error)).toContain("[redacted]");
	});

	it("rejects transmitting the bearer to remote http:// endpoints", async () => {
		let fetched = false;
		using _hook = hookFetch(() => {
			fetched = true;
			return modelsListResponse(["m"]);
		});
		await expect(
			probeOpenAIModelsList({ baseUrl: "http://api.example.com/v1", apiKey: "sk-secret" }),
		).rejects.toThrow("needs https");
		expect(fetched).toBe(false);
	});

	it("re-add with --force refreshes discovery instead of duplicating entries", async () => {
		const modelsPath = await tempModelsPath();
		await addApiCompatibleProvider({
			compatibility: "openai",
			providerId: "gateway",
			baseUrl: "https://gateway.example.com/v1",
			apiKeyEnv: "GATEWAY_KEY",
			models: ["static-one"],
			discover: true,
			discoverySignal: expect.any(AbortSignal),
			modelsPath,
		});
		const replaced = await addApiCompatibleProvider({
			compatibility: "openai",
			providerId: "gateway",
			baseUrl: "https://gateway.example.com/v1",
			apiKeyEnv: "GATEWAY_KEY",
			models: ["static-two"],
			discover: true,
			discoverySignal: expect.any(AbortSignal),
			force: true,
			modelsPath,
		});
		expect(replaced.modelIds).toEqual(["static-two"]);

		process.env.GATEWAY_KEY = "sk-gateway";
		try {
			using _hook = hookFetch(() => modelsListResponse(["static-two", "live-three"]));
			const store = await SqliteAuthCredentialStore.open(path.join(tempRoot!, "agent.db"));
			try {
				const authStorage = new AuthStorage(store);
				const registry = new ModelRegistry(authStorage, modelsPath);
				await registry.refreshProvider("gateway");
				const ids = registry
					.getAll()
					.filter(model => model.provider === "gateway")
					.map(model => model.id)
					.sort();
				expect(ids).toEqual(["live-three", "static-two"]);
			} finally {
				store.close();
			}
		} finally {
			delete process.env.GATEWAY_KEY;
		}
	});

	it("literal-key discovery-only add is immediately selectable after the targeted refresh", async () => {
		const modelsPath = await tempModelsPath();
		const store = await SqliteAuthCredentialStore.open(path.join(tempRoot!, "agent.db"));
		try {
			const authStorage = new AuthStorage(store);
			const registry = new ModelRegistry(authStorage, modelsPath);
			// Production sequence from the wizard submit path: persist the
			// pasted key through the LIVE registry authority, reload static
			// config offline, then refresh only the new provider online.
			const result = await addApiCompatibleProvider({
				compatibility: "openai",
				providerId: "literal-gateway",
				baseUrl: "https://gateway.example.com/v1",
				apiKey: "sk-literal-live",
				discover: true,
				discoverySignal: expect.any(AbortSignal),
				modelsPath,
				authStorage,
				probeDiscovery: async () => ({
					models: ["live-model"],
					endpoint: "https://gateway.example.com/v1/models",
				}),
			});
			expect(result.discoveryEnabled).toBe(true);
			let authorization: string | null = null;
			using _hook = hookFetch((input, init) => {
				if (!String(input).endsWith("/models")) throw new Error(`Unexpected URL: ${String(input)}`);
				const headers = init?.headers;
				authorization =
					headers instanceof Headers
						? headers.get("Authorization")
						: ((headers as Record<string, string> | undefined)?.Authorization ?? null);
				return modelsListResponse(["live-model"]);
			});
			await registry.refresh("offline");
			await registry.refreshProvider("literal-gateway", "online");
			// The live registry authenticated from the same authority that
			// stored the pasted key (no stale-cache failure).
			expect(authorization as unknown as string).toBe("Bearer sk-literal-live");
			expect(registry.find("literal-gateway", "live-model")).toBeDefined();
		} finally {
			store.close();
		}
	});

	it("rejects duplicates locally before transmitting any credential", async () => {
		const modelsPath = await tempModelsPath();
		await addApiCompatibleProvider({
			compatibility: "openai",
			providerId: "dupe-gateway",
			baseUrl: "https://gateway.example.com/v1",
			apiKeyEnv: "GATEWAY_KEY",
			models: ["existing-model"],
			modelsPath,
		});
		let probed = false;
		await expect(
			addApiCompatibleProvider({
				compatibility: "openai",
				providerId: "dupe-gateway",
				baseUrl: "https://gateway.example.com/v1",
				apiKeyEnv: "GATEWAY_KEY",
				discover: true,
				discoverySignal: expect.any(AbortSignal),
				modelsPath,
				probeDiscovery: async () => {
					probed = true;
					return { models: ["live-model"], endpoint: "https://gateway.example.com/v1/models" };
				},
			}),
		).rejects.toThrow("already exists");
		expect(probed).toBe(false);
	});

	it("rejects discovery for Anthropic-compatible providers and preset-managed catalogs", async () => {
		const modelsPath = await tempModelsPath();
		await expect(
			addApiCompatibleProvider({
				compatibility: "anthropic",
				providerId: "claude-proxy",
				baseUrl: "https://proxy.example.com/v1",
				apiKeyEnv: "PROXY_KEY",
				discover: true,
				discoverySignal: expect.any(AbortSignal),
				modelsPath,
			}),
		).rejects.toThrow("requires an OpenAI-compatible provider");
		await expect(addApiCompatibleProvider({ preset: "minimax", discover: true, modelsPath })).rejects.toThrow(
			"manages its own model catalog",
		);
	});

	it("probe surfaces unreachable endpoints and auth failures without leaking the key", async () => {
		using _hook = hookFetch(input => {
			if (String(input).includes("unreachable")) throw new Error("fetch failed: ECONNREFUSED");
			if (String(input).includes("denied")) return new Response("nope", { status: 401 });
			return modelsListResponse(["b-model", "a-model", "b-model"]);
		});

		await expect(
			probeOpenAIModelsList({ baseUrl: "https://unreachable.example.com/v1", apiKey: "sk-secret" }),
		).rejects.toThrow("Model discovery failed for https://unreachable.example.com/v1/models");

		const denied = await probeOpenAIModelsList({ baseUrl: "https://denied.example.com/v1", apiKey: "x" }).catch(
			error => error,
		);
		expect(String(denied)).toContain("credential was rejected");
		expect(String(denied)).not.toContain("sk-secret");

		const ok = await probeOpenAIModelsList({ baseUrl: "https://ok.example.com/openai", apiKey: "sk-ok" });
		expect(ok.models).toEqual(["a-model", "b-model"]);
		expect(ok.endpoint).toBe("https://ok.example.com/openai/v1/models");
	});

	it("probe requires the env credential to be set instead of silently returning empty", async () => {
		await expect(
			probeOpenAIModelsList({ baseUrl: "https://gateway.example.com/v1", apiKeyEnv: "MISSING_5387_KEY" }),
		).rejects.toThrow("MISSING_5387_KEY");
	});

	it("wizard discovery path submits discover:true and manual fallback submits discover:false", async () => {
		const submissions: unknown[] = [];
		const wizard = new CustomProviderWizardComponent(
			input => submissions.push(input),
			() => undefined,
			() => undefined,
			{ discoverModels: async () => ({ models: ["z-model", "a-model"] }) },
		);
		wizard.handleInput("\n");
		typeText(wizard, "discover-provider");
		wizard.handleInput("\n");
		typeText(wizard, "https://api.example.com/v1");
		wizard.handleInput("\n");
		wizard.handleInput("\n");
		typeText(wizard, "DISCOVER_KEY");
		wizard.handleInput("\n");
		// Credential submission starts discovery without another Enter.
		await setImmediate();
		wizard.handleInput("\n");
		wizard.handleInput("\n");
		expect(submissions).toEqual([
			{
				compatibility: "openai",
				providerId: "discover-provider",
				baseUrl: "https://api.example.com/v1",
				apiKeyEnv: "DISCOVER_KEY",
				apiKey: undefined,
				models: [],
				discover: true,
				discoverySignal: expect.any(AbortSignal),
				force: false,
			},
		]);

		const manual: unknown[] = [];
		const manualWizard = new CustomProviderWizardComponent(
			input => manual.push(input),
			() => undefined,
		);
		manualWizard.handleInput("\n");
		typeText(manualWizard, "manual-provider");
		manualWizard.handleInput("\n");
		typeText(manualWizard, "https://api.example.com/v1");
		manualWizard.handleInput("\n");
		manualWizard.handleInput("\n");
		typeText(manualWizard, "MANUAL_KEY");
		manualWizard.handleInput("\n");
		manualWizard.handleInput("\x1b[B");
		manualWizard.handleInput("\n");
		typeText(manualWizard, "manual-model");
		manualWizard.handleInput("\n");
		manualWizard.handleInput("\n");
		expect(manual).toEqual([
			{
				compatibility: "openai",
				providerId: "manual-provider",
				baseUrl: "https://api.example.com/v1",
				apiKeyEnv: "MANUAL_KEY",
				apiKey: undefined,
				models: ["manual-model"],
				discover: false,
				discoverySignal: expect.any(AbortSignal),
				force: false,
			},
		]);
	});

	it("wizard discards discovered models after the endpoint inputs change", async () => {
		const seen: string[] = [];
		const submissions: unknown[] = [];
		const wizard = new CustomProviderWizardComponent(
			input => submissions.push(input),
			() => undefined,
			() => undefined,
			{
				discoverModels: async request => {
					seen.push(`${request.baseUrl}|${request.apiKeyEnv ?? request.apiKey}`);
					return { models: ["probed-model"] };
				},
			},
		);
		wizard.handleInput("\n");
		typeText(wizard, "stale-provider");
		wizard.handleInput("\n");
		typeText(wizard, "https://api.example.com/v1");
		wizard.handleInput("\n");
		wizard.handleInput("\n");
		typeText(wizard, "FIRST_KEY");
		wizard.handleInput("\n");
		await setImmediate();
		// Go back to the credential step (discover -> credential), which
		// pre-fills the previous value, and append a suffix so the credential
		// differs: the prior probe results must be discarded, so confirming
		// the step re-probes instead of offering stale models.
		wizard.handleInput("\u001b");
		typeText(wizard, "_2");
		wizard.handleInput("\n");
		await setImmediate();
		expect(seen).toEqual(["https://api.example.com/v1|FIRST_KEY", "https://api.example.com/v1|FIRST_KEY_2"]);
		wizard.handleInput("\n");
		wizard.handleInput("\n");
		expect(submissions).toEqual([
			{
				compatibility: "openai",
				providerId: "stale-provider",
				baseUrl: "https://api.example.com/v1",
				apiKeyEnv: "FIRST_KEY_2",
				apiKey: undefined,
				models: [],
				discover: true,
				discoverySignal: expect.any(AbortSignal),
				force: false,
			},
		]);
	});

	it("wizard discovery failure keeps manual entry available", async () => {
		const submissions: unknown[] = [];
		const wizard = new CustomProviderWizardComponent(
			input => submissions.push(input),
			() => undefined,
			() => undefined,
			{
				discoverModels: async () => {
					throw new Error("Model discovery failed for https://api.example.com/v1/models: boom");
				},
			},
		);
		wizard.handleInput("\n");
		typeText(wizard, "failing-provider");
		wizard.handleInput("\n");
		typeText(wizard, "https://api.example.com/v1");
		wizard.handleInput("\n");
		wizard.handleInput("\n");
		typeText(wizard, "FAILING_KEY");
		wizard.handleInput("\n");
		await setImmediate();
		// Failure selects manual entry; confirm the step, then type the fallback model id.
		wizard.handleInput("\n");
		typeText(wizard, "fallback-model");
		wizard.handleInput("\n");
		wizard.handleInput("\n");
		expect(submissions).toEqual([
			{
				compatibility: "openai",
				providerId: "failing-provider",
				baseUrl: "https://api.example.com/v1",
				apiKeyEnv: "FAILING_KEY",
				apiKey: undefined,
				models: ["fallback-model"],
				discover: false,
				discoverySignal: expect.any(AbortSignal),
				force: false,
			},
		]);
	});
});
