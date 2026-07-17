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

		expect(models?.map(model => model.id)).toEqual(["gemini-3.1-pro-low"]);
	});

	it("keeps gemini-3.1-pro-high when discovery targets google-gemini-cli", async () => {
		const models = await fetchAntigravityDiscoveryModels({
			token: "test-token",
			endpoint: "https://antigravity.example.test",
			fetcher: createDiscoveryFetcher(),
			targetProvider: "google-gemini-cli",
		});

		expect(models?.map(model => model.id)).toEqual(["gemini-3.1-pro-high", "gemini-3.1-pro-low"]);
	});

	it("does not expose retired selectors from the bundled registry", () => {
		expect(getBundledModel("google-antigravity", "gemini-3.1-pro-high")).toBeUndefined();
		expect(getBundledModels("google-antigravity").map(model => model.id)).not.toContain("gemini-3.1-pro-high");
		expect(getBundledModel("google-antigravity", "gemini-3.1-pro-low")?.id).toBe("gemini-3.1-pro-low");
	});

	it("filters retired selectors from fresh authoritative model caches", async () => {
		const cacheDir = mkdtempSync(join(tmpdir(), "pi-ai-antigravity-model-cache-"));
		cacheDirs.push(cacheDir);
		const cacheDbPath = join(cacheDir, "models.db");
		const low = createAntigravityModel("gemini-3.1-pro-low", "Gemini 3.1 Pro (Low)");
		const high = createAntigravityModel("gemini-3.1-pro-high", "Gemini 3.1 Pro (High)");
		const staticModels: Model<Api>[] = [low];
		const cachedModels: Model<Api>[] = [low, high];
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
		expect(models.map(model => model.id)).toEqual(["gemini-3.1-pro-low"]);
	});
});
