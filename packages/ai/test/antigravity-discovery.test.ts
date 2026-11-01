import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeModelCache } from "../src/model-cache";
import { resolveProviderModels } from "../src/model-manager";
import { getBundledModel, getBundledModels } from "../src/models";
import { getAntigravityUserAgent, getGeminiCliUserAgent } from "../src/providers/google-gemini-headers";
import type { Api, Model } from "../src/types";
import { fetchAntigravityDiscoveryModels } from "../src/utils/discovery/antigravity";

const cacheDirs: string[] = [];

afterEach(() => {
	for (const cacheDir of cacheDirs.splice(0)) {
		rmSync(cacheDir, { recursive: true, force: true });
	}
});

function createAntigravityModel(id: string, name: string): Model<Api> {
	return {
		id,
		name,
		api: "google-gemini-cli",
		provider: "google-antigravity",
		baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65_535,
	};
}

describe("Antigravity model discovery", () => {
	async function resolveDiscoveryPayload(payload: unknown): Promise<Model<Api>[]> {
		const cacheDir = mkdtempSync(join(tmpdir(), "pi-ai-antigravity-model-cache-"));
		cacheDirs.push(cacheDir);
		const cacheDbPath = join(cacheDir, "models.db");
		const fetcher = (async () =>
			new Response(JSON.stringify(payload), {
				headers: { "content-type": "application/json" },
			})) as unknown as typeof fetch;

		const { models } = await resolveProviderModels<Api>(
			{
				providerId: "google-antigravity",
				staticModels: [],
				cacheDbPath,
				fetchDynamicModels: () =>
					fetchAntigravityDiscoveryModels({
						token: "test-token",
						endpoint: "https://antigravity.example.test",
						fetcher,
					}),
			},
			"online",
		);

		return models;
	}

	function createDiscoveryFetcher(): typeof fetch {
		return (async () =>
			new Response(
				JSON.stringify({
					models: {
						"gemini-3.1-pro-high": {
							displayName: "Gemini 3.1 Pro (High)",
							supportsImages: true,
							supportsThinking: true,
							maxTokens: 1_048_576,
							maxOutputTokens: 65_535,
						},
						"gemini-3.1-pro-low": {
							displayName: "Gemini 3.1 Pro (Low)",
							supportsImages: true,
							supportsThinking: true,
							maxTokens: 1_048_576,
							maxOutputTokens: 65_535,
						},
						"gemini-3.7-flash-high": {
							displayName: "Gemini 3.7 Flash (High)",
							supportsImages: true,
							supportsThinking: true,
						},
						"gemini-3.7-flash-low": {
							displayName: "Gemini 3.7 Flash (Low)",
							supportsImages: true,
							supportsThinking: true,
						},
						"gemini-3.7-flash-medium": {
							displayName: "Gemini 3.7 Flash (Medium)",
							supportsImages: true,
							supportsThinking: true,
						},
						"gemini-3.7-flash-tiered": {
							displayName: "Gemini 3.7 Flash (Tiered)",
							supportsImages: true,
							supportsThinking: true,
						},
					},
				}),
				{ headers: { "content-type": "application/json" } },
			)) as unknown as typeof fetch;
	}

	it("filters the advertised but non-callable gemini-3.1-pro-high selector", async () => {
		const models = await fetchAntigravityDiscoveryModels({
			token: "test-token",
			endpoint: "https://antigravity.example.test",
			fetcher: createDiscoveryFetcher(),
		});

		expect(models?.map(model => model.id)).toEqual(["gemini-3.1-pro-low", "gemini-3.7-flash-tiered"]);
	});

	it("resolves an internal mid-rollout model surfaced by agentModelSorts", async () => {
		const models = await resolveDiscoveryPayload({
			models: {
				"gemini-future-flash-medium": {
					displayName: "Gemini Future Flash (Medium)",
					isInternal: true,
					supportsImages: true,
					supportsThinking: true,
				},
			},
			agentModelSorts: [{ groups: [{ modelIds: ["gemini-future-flash-medium"] }] }],
		});

		expect(models.map(model => model.id)).toEqual(["gemini-future-flash-medium"]);
	});

	it("keeps genuinely internal models absent from agentModelSorts hidden", async () => {
		const models = await resolveDiscoveryPayload({
			models: {
				"internal-evaluation-model": {
					displayName: "Internal Evaluation Model",
					isInternal: true,
				},
			},
			agentModelSorts: [{ groups: [{ modelIds: ["public-model"] }] }],
		});

		expect(models).toEqual([]);
	});

	it("keeps denylisted and retired models hidden when agentModelSorts surfaces them", async () => {
		const models = await resolveDiscoveryPayload({
			models: {
				chat_20706: { displayName: "Denylisted", isInternal: true },
				"gemini-3.1-pro-high": { displayName: "Retired", isInternal: true },
			},
			agentModelSorts: [{ groups: [{ modelIds: ["chat_20706", "gemini-3.1-pro-high"] }] }],
		});

		expect(models).toEqual([]);
	});

	it("keeps gemini-3.1-pro-high when discovery targets google-gemini-cli", async () => {
		const models = await fetchAntigravityDiscoveryModels({
			token: "test-token",
			endpoint: "https://antigravity.example.test",
			fetcher: createDiscoveryFetcher(),
			targetProvider: "google-gemini-cli",
		});

		expect(models?.map(model => model.id)).toEqual([
			"gemini-3.1-pro-high",
			"gemini-3.1-pro-low",
			"gemini-3.7-flash-high",
			"gemini-3.7-flash-low",
			"gemini-3.7-flash-medium",
			"gemini-3.7-flash-tiered",
		]);
	});

	it("does not expose retired selectors from the bundled registry", () => {
		expect(getBundledModel("google-antigravity", "gemini-3.1-pro-high")).toBeUndefined();
		expect(getBundledModels("google-antigravity").map(model => model.id)).not.toContain("gemini-3.1-pro-high");
		expect(getBundledModel("google-antigravity", "gemini-3.7-flash-high")).toBeUndefined();
		expect(getBundledModel("google-antigravity", "gemini-3.7-flash-low")).toBeUndefined();
		expect(getBundledModel("google-antigravity", "gemini-3.7-flash-medium")).toBeUndefined();
		expect(getBundledModel("google-antigravity", "gemini-3.7-flash-tiered")?.id).toBe("gemini-3.7-flash-tiered");
		expect(getBundledModel("google-antigravity", "gemini-3.1-pro-low")?.id).toBe("gemini-3.1-pro-low");
	});

	it("sends project in request body when project is provided", async () => {
		let capturedRequestBody: unknown;
		const fetcher = (async (_url: string, init?: RequestInit) => {
			if (init?.body) {
				capturedRequestBody = JSON.parse(init.body as string);
			}
			return new Response(
				JSON.stringify({
					models: {
						"gemini-4-argon": {
							displayName: "Gemini 4 Argon",
							supportsImages: true,
						},
					},
				}),
				{ headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		const models = await fetchAntigravityDiscoveryModels({
			token: "test-token",
			endpoint: "https://antigravity.example.test",
			project: "test-project-123",
			fetcher,
		});

		expect(models?.map(model => model.id)).toEqual(["gemini-4-argon"]);
		expect(capturedRequestBody).toEqual({ project: "test-project-123" });
	});

	it("uses the Gemini CLI user agent to discover Argon without a project", async () => {
		let capturedRequestBody: unknown;
		const capturedUserAgents: string[] = [];
		const fetcher = (async (_url: string, init?: RequestInit) => {
			if (init?.body) {
				capturedRequestBody = JSON.parse(init.body as string);
			}
			const userAgent = new Headers(init?.headers).get("user-agent");
			if (userAgent) capturedUserAgents.push(userAgent);
			return new Response(
				JSON.stringify({
					models: {
						"gemini-4-argon": {
							displayName: "Gemini 4 Argon",
							supportsImages: true,
						},
					},
				}),
				{ headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		const models = await fetchAntigravityDiscoveryModels({
			token: "test-token",
			endpoint: "https://antigravity.example.test",
			fetcher,
		});

		expect(models?.map(model => model.id)).toEqual(["gemini-4-argon"]);
		expect(capturedRequestBody).toEqual({});
		const expectedUserAgent = process.env.PI_AI_ANTIGRAVITY_USER_AGENT
			? getAntigravityUserAgent()
			: getGeminiCliUserAgent();
		expect(capturedUserAgents).toEqual([expectedUserAgent]);
	});

	it("preserves the custom logger receiver while logging drop reasons", async () => {
		const testLogger = {
			entries: [] as Array<[string, Record<string, unknown> | undefined]>,
			debug(message: string, meta?: Record<string, unknown>) {
				this.entries.push([message, meta]);
			},
		};

		const fetcher = (async () =>
			new Response(
				JSON.stringify({
					models: {
						"gemini-3.1-pro-low": {
							displayName: "Gemini 3.1 Pro (Low)",
							supportsImages: true,
						},
						chat_20706: {
							displayName: "Denylisted",
							isInternal: true,
						},
						"gemini-3.1-pro-high": {
							displayName: "Retired",
							isInternal: true,
						},
						"internal-hidden": {
							displayName: "Internal Hidden",
							isInternal: true,
						},
					},
				}),
				{ headers: { "content-type": "application/json" } },
			)) as unknown as typeof fetch;

		const models = await fetchAntigravityDiscoveryModels({
			token: "test-token",
			endpoint: "https://user:secret@antigravity.example.test/private/path?access_token=query-secret",
			fetcher,
			logger: testLogger,
		});

		expect(models?.map(model => model.id)).toEqual(["gemini-3.1-pro-low"]);

		const dropReasonLog = testLogger.entries.find(log => log[0] === "Antigravity discovery dropped models");
		expect(dropReasonLog?.[1]?.dropReasons).toEqual({
			chat_20706: "denylist",
			"gemini-3.1-pro-high": "retired",
			"internal-hidden": "isInternal-not-surfaced",
		});
		const keptModelsLog = testLogger.entries.find(log => log[0] === "Antigravity discovery kept models");
		expect(keptModelsLog?.[1]?.keptModelIds).toEqual(["gemini-3.1-pro-low"]);
		expect(testLogger.entries.map(([, meta]) => meta?.endpoint)).toEqual([
			"https://antigravity.example.test",
			"https://antigravity.example.test",
			"https://antigravity.example.test",
		]);
	});

	it("filters retired selectors from fresh authoritative model caches", async () => {
		const cacheDir = mkdtempSync(join(tmpdir(), "pi-ai-antigravity-model-cache-"));
		cacheDirs.push(cacheDir);
		const cacheDbPath = join(cacheDir, "models.db");
		const low = createAntigravityModel("gemini-3.1-pro-low", "Gemini 3.1 Pro (Low)");
		const high = createAntigravityModel("gemini-3.1-pro-high", "Gemini 3.1 Pro (High)");
		const flashHigh = createAntigravityModel("gemini-3.7-flash-high", "Gemini 3.7 Flash (High)");
		const flashLow = createAntigravityModel("gemini-3.7-flash-low", "Gemini 3.7 Flash (Low)");
		const flashMedium = createAntigravityModel("gemini-3.7-flash-medium", "Gemini 3.7 Flash (Medium)");
		const flashTiered = createAntigravityModel("gemini-3.7-flash-tiered", "Gemini 3.7 Flash (Tiered)");
		const staticModels: Model<Api>[] = [low, flashTiered];
		const cachedModels: Model<Api>[] = [low, high, flashHigh, flashLow, flashMedium, flashTiered];
		const now = () => 1_800_000_000_000;
		const staticFingerprint = Bun.hash(JSON.stringify(staticModels)).toString(36);
		writeModelCache("google-antigravity", now(), cachedModels, true, staticFingerprint, cacheDbPath);

		const { models, stale } = await resolveProviderModels<Api>(
			{
				providerId: "google-antigravity",
				staticModels,
				cacheDbPath,
				now,
				fetchDynamicModels: async () => {
					throw new Error("fresh authoritative cache should skip network fetch");
				},
			},
			"online-if-uncached",
		);

		expect(stale).toBe(false);
		expect(models.map(model => model.id)).toEqual(["gemini-3.1-pro-low", "gemini-3.7-flash-tiered"]);
	});

	it("logs model discovery filtering decisions when GJC_DEBUG_ANTIGRAVITY_DISCOVERY=1", async () => {
		const originalEnv = process.env.GJC_DEBUG_ANTIGRAVITY_DISCOVERY;
		process.env.GJC_DEBUG_ANTIGRAVITY_DISCOVERY = "1";

		const consoleErrorSpyData: string[] = [];
		const originalConsoleError = console.error;
		const spyConsoleError = (message?: unknown) => {
			consoleErrorSpyData.push(String(message));
		};

		Object.assign(console, { error: spyConsoleError });

		const models: Record<string, unknown> = {};
		const requestUserAgents: Array<string | null> = [];
		models["gemini-3.1-pro-low"] = {
			displayName: "Gemini 3.1 Pro (Low)",
			maxTokens: 1_048_576,
		};
		models.chat_20706 = { displayName: "Denylisted Model" };
		models["gemini-3.1-pro-high"] = { displayName: "Retired Model" };
		models["internal-hidden-model"] = {
			displayName: "Internal Hidden",
			isInternal: true,
		};
		const payload = {
			models,
			agentModelSorts: [{ groups: [{ modelIds: ["gemini-3.1-pro-low"] }] }],
		};

		const fetcher = (async (_input: string | URL | Request, init?: RequestInit) => {
			requestUserAgents.push(new Headers(init?.headers).get("User-Agent"));
			return new Response(JSON.stringify(payload), {
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;

		try {
			await fetchAntigravityDiscoveryModels({
				token: "test-token",
				endpoint: "https://antigravity.example.test",
				fetcher,
			});

			expect(consoleErrorSpyData).toContain("[GJC_DEBUG_ANTIGRAVITY_DISCOVERY]");
			const output = consoleErrorSpyData.join("\n");
			expect(output).toContain("HTTP Status:");
			expect(requestUserAgents).toEqual([expect.any(String)]);
			expect(output).toContain(`User-Agent: ${requestUserAgents[0]}`);
			expect(output).not.toContain("(using default getAntigravityUserAgent())");
			expect(output).toContain("Endpoint:");
			expect(output).toContain("Total raw models from response:");
			expect(output).toContain("=== KEPT MODELS ===");
			expect(output).toContain("gemini-3.1-pro-low");
			expect(output).toContain("=== FILTERED BY DENYLIST ===");
			expect(output).toContain("chat_20706");
			expect(output).toContain("=== FILTERED BY RETIREMENT (google-antigravity) ===");
			expect(output).toContain("gemini-3.1-pro-high");
			expect(output).toContain("=== FILTERED (internal, not surfaced) ===");
			expect(output).toContain("internal-hidden-model");
			expect(output).toContain("isInternal=true");
		} finally {
			Object.assign(console, { error: originalConsoleError });
			if (originalEnv !== undefined) {
				process.env.GJC_DEBUG_ANTIGRAVITY_DISCOVERY = originalEnv;
			} else {
				delete process.env.GJC_DEBUG_ANTIGRAVITY_DISCOVERY;
			}
		}
	});

	it("excludes disabled models from discovery", async () => {
		const cacheDir = mkdtempSync(join(tmpdir(), "pi-ai-antigravity-model-cache-"));
		cacheDirs.push(cacheDir);
		const cacheDbPath = join(cacheDir, "models.db");
		const fetcher = (async () =>
			new Response(
				JSON.stringify({
					models: {
						"gemini-4-argon-high": {
							displayName: "Gemini 4 Argon (High)",
							supportsImages: true,
						},
						"gemini-4-argon-disabled": {
							displayName: "Gemini 4 Argon (Disabled)",
							supportsImages: true,
							disabled: true,
						},
						"gemini-3.8-flash-medium": {
							displayName: "Gemini 3.8 Flash (Medium)",
							supportsImages: true,
						},
					},
				}),
				{ headers: { "content-type": "application/json" } },
			)) as unknown as typeof fetch;

		const { models } = await resolveProviderModels<Api>(
			{
				providerId: "google-antigravity",
				staticModels: [],
				cacheDbPath,
				fetchDynamicModels: () =>
					fetchAntigravityDiscoveryModels({
						token: "test-token",
						endpoint: "https://antigravity.example.test",
						fetcher,
					}),
			},
			"online",
		);

		const modelIds = models.map(m => m.id);
		expect(modelIds).toContain("gemini-4-argon-high");
		expect(modelIds).toContain("gemini-3.8-flash-medium");
		expect(modelIds).not.toContain("gemini-4-argon-disabled");
	});

	it("accepts explicit User-Agent override via options", async () => {
		const ua = "antigravity/cli/1.3.4 (os_type=darwin; arch=arm64; aidev_client; auth_method=oauth)";
		let capturedUA: string | undefined;
		const fetcher = (async (_url: string, options?: RequestInit) => {
			capturedUA = (options?.headers as Record<string, string>)?.["User-Agent"];
			return new Response(
				JSON.stringify({
					models: {
						"gemini-4-argon-high": {
							displayName: "Gemini 4 Argon (High)",
							supportsImages: true,
						},
					},
				}),
				{ headers: { "content-type": "application/json" } },
			) as unknown as Response;
		}) as unknown as typeof fetch;

		const models = await fetchAntigravityDiscoveryModels({
			token: "test-token",
			endpoint: "https://antigravity.example.test",
			userAgent: ua,
			fetcher,
		});

		// Verify UA was passed to the fetcher
		expect(capturedUA).toBe(ua);
		// Verify we got models back
		expect(models).not.toBeNull();
	});

	it("passes User-Agent to discovery endpoint and stores in cache", async () => {
		const cacheDir = mkdtempSync(join(tmpdir(), "pi-ai-antigravity-model-cache-"));
		cacheDirs.push(cacheDir);
		const cacheDbPath = join(cacheDir, "models.db");

		let capturedUserAgent: string | undefined;
		const fetcher = (async (_url: string, options?: RequestInit) => {
			capturedUserAgent = (options?.headers as Record<string, string>)?.["User-Agent"];
			return new Response(
				JSON.stringify({
					models: {
						"test-model": {
							displayName: "Test Model",
							supportsImages: true,
						},
					},
				}),
				{ headers: { "content-type": "application/json" } },
			) as unknown as Response;
		}) as unknown as typeof fetch;

		const ua = "antigravity/cli/1.3.4 (os_type=darwin; arch=arm64; aidev_client; auth_method=oauth)";
		await resolveProviderModels<Api>(
			{
				providerId: "google-antigravity",
				staticModels: [],
				cacheDbPath,
				discoveryUserAgent: ua,
				fetchDynamicModels: () =>
					fetchAntigravityDiscoveryModels({
						token: "test-token",
						endpoint: "https://antigravity.example.test",
						userAgent: ua,
						fetcher,
					}),
			},
			"online",
		);

		expect(capturedUserAgent).toBe(ua);
	});

	it("refreshes cache when User-Agent changes (stale cache scenario)", async () => {
		const cacheDir = mkdtempSync(join(tmpdir(), "pi-ai-antigravity-model-cache-"));
		cacheDirs.push(cacheDir);
		const cacheDbPath = join(cacheDir, "models.db");

		// Simulate field scenario: old cache with outdated UA (no Argon)
		const oldUA = "antigravity-ide";
		const oldFetcher = (async () =>
			new Response(
				JSON.stringify({
					models: {
						"gemini-3.8-flash-medium": {
							displayName: "Gemini 3.8 Flash (Medium)",
							supportsImages: true,
						},
					},
				}),
				{ headers: { "content-type": "application/json" } },
			)) as unknown as typeof fetch;

		// Step 1: Populate cache with old UA (simulates old gjc version or env var not set)
		const { models: oldCacheModels } = await resolveProviderModels<Api>(
			{
				providerId: "google-antigravity",
				staticModels: [],
				cacheDbPath,
				discoveryUserAgent: oldUA,
				fetchDynamicModels: () =>
					fetchAntigravityDiscoveryModels({
						token: "test-token",
						endpoint: "https://antigravity.example.test",
						userAgent: oldUA,
						fetcher: oldFetcher,
					}),
			},
			"online",
		);

		expect(oldCacheModels.map(m => m.id)).toContain("gemini-3.8-flash-medium");
		expect(oldCacheModels.map(m => m.id)).not.toContain("gemini-4-argon-medium");

		// Step 2: New resolution with new UA (upgraded gjc or env var is now set)
		// Should NOT reuse old cache and should fetch new models including Argon
		const newUA = "antigravity/cli/1.3.4 (os_type=darwin; arch=arm64; aidev_client; auth_method=oauth)";
		let fetchCount = 0;
		const newFetcher = (async () => {
			fetchCount++;
			return new Response(
				JSON.stringify({
					models: {
						"gemini-4-argon-medium": {
							displayName: "Gemini 4 Argon (Medium)",
							supportsImages: true,
							maxTokens: 1_048_576,
							maxOutputTokens: 65_535,
						},
						"gemini-3.8-flash-medium": {
							displayName: "Gemini 3.8 Flash (Medium)",
							supportsImages: true,
						},
					},
				}),
				{ headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		const { models: newModels } = await resolveProviderModels<Api>(
			{
				providerId: "google-antigravity",
				staticModels: [],
				cacheDbPath,
				discoveryUserAgent: newUA,
				fetchDynamicModels: () =>
					fetchAntigravityDiscoveryModels({
						token: "test-token",
						endpoint: "https://antigravity.example.test",
						userAgent: newUA,
						fetcher: newFetcher,
					}),
			},
			"online",
		);

		// Verify the new fetcher was called (cache was invalidated)
		expect(fetchCount).toBe(1);
		// Verify we got the new models including Argon
		expect(newModels.map(m => m.id)).toContain("gemini-4-argon-medium");
		expect(newModels.map(m => m.id)).toContain("gemini-3.8-flash-medium");
	});
});
