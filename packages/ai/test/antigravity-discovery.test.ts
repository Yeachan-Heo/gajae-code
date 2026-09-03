import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeModelCache } from "../src/model-cache";
import { resolveProviderModels } from "../src/model-manager";
import { getBundledModel, getBundledModels } from "../src/models";
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
});
