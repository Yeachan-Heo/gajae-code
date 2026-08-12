import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readModelCache, writeModelCache } from "../src/model-cache";
import { resolveProviderModels } from "../src/model-manager";
import { Effort } from "../src/model-thinking";
import type { Api, Model } from "../src/types";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const NON_AUTHORITATIVE_RETRY_MS = 5 * 60 * 1000;

function model(provider: string, id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	};
}

function fingerprint(models: readonly Model<Api>[]): string {
	return Bun.hash(JSON.stringify(models)).toString(36);
}

describe("online-if-uncached model refresh", () => {
	let cacheDir: string;
	let cacheDbPath: string;

	beforeEach(() => {
		cacheDir = mkdtempSync(join(tmpdir(), "model-manager-cache-"));
		cacheDbPath = join(cacheDir, "models.db");
	});

	afterEach(() => {
		rmSync(cacheDir, { recursive: true, force: true });
	});

	test("reuses a fresh authoritative cache without discovery", async () => {
		const providerId = "cache-authoritative";
		const staticModels = [model(providerId, "static")];
		const cachedModels = [...staticModels, model(providerId, "cached")];
		let discoveryCalls = 0;
		const now = 1_700_000_000_000;
		writeModelCache(providerId, now, cachedModels, true, fingerprint(staticModels), cacheDbPath);

		const result = await resolveProviderModels<Api>(
			{
				providerId,
				staticModels,
				cacheDbPath,
				cacheDynamicModelProvenance: "credential-a\u0000https://provider-a.example.test",
				now: () => now,
				fetchDynamicModels: async () => {
					discoveryCalls += 1;
					return [model(providerId, "network")];
				},
			},
			"online-if-uncached",
		);

		expect(discoveryCalls).toBe(0);
		expect(result.stale).toBe(false);
		expect(result.models.map(entry => entry.id)).toEqual(["static", "cached"]);
	});

	test("retains authoritative dynamic IDs separately from merged static models", async () => {
		const providerId = "cache-authoritative-ids";
		const staticModels = [model(providerId, "static")];
		const now = 1_700_000_000_000;

		const fetched = await resolveProviderModels<Api>(
			{
				providerId,
				staticModels,
				cacheDbPath,
				cacheDynamicModelProvenance: "credential-a\u0000https://provider-a.example.test",
				now: () => now,
				fetchDynamicModels: async () => [model(providerId, "dynamic")],
			},
			"online",
		);
		expect(fetched.models.map(entry => entry.id)).toEqual(["static", "dynamic"]);
		expect(fetched.dynamicModelIds).toEqual(["dynamic"]);

		const cached = await resolveProviderModels<Api>(
			{
				providerId,
				staticModels,
				cacheDbPath,
				cacheDynamicModelProvenance: "credential-a\u0000https://provider-a.example.test",
				now: () => now,
				fetchDynamicModels: async () => {
					throw new Error("fresh cache must be reused");
				},
			},
			"online-if-uncached",
		);
		expect(cached.models.map(entry => entry.id)).toEqual(["static", "dynamic"]);
		expect(cached.dynamicModelIds).toEqual(["dynamic"]);
	});

	test("retains fresh cached dynamic IDs when static transport drift forces a cache re-merge", async () => {
		const providerId = "cache-authoritative-remerge";
		const now = 1_700_000_000_000;
		const initialStatic = [model(providerId, "static")];
		await resolveProviderModels<Api>(
			{
				providerId,
				staticModels: initialStatic,
				cacheDbPath,
				cacheDynamicModelProvenance: "credential-a\u0000https://provider-a.example.test",
				now: () => now,
				fetchDynamicModels: async () => [model(providerId, "dynamic")],
			},
			"online",
		);

		const changedStatic = [{ ...model(providerId, "static"), baseUrl: "https://changed.example.test/v1" }];
		const cached = await resolveProviderModels<Api>(
			{
				providerId,
				staticModels: changedStatic,
				cacheDbPath,
				cacheDynamicModelProvenance: "credential-a\u0000https://provider-a.example.test",
				now: () => now,
				fetchDynamicModels: async () => {
					throw new Error("fresh cache must be reused");
				},
			},
			"online-if-uncached",
		);

		expect(cached.fetched).toBe(false);
		expect(cached.stale).toBe(false);
		expect(cached.dynamicModelIds).toEqual(["dynamic"]);
	});

	test("does not reuse cached dynamic IDs after an offline credential or endpoint change", async () => {
		const providerId = "cache-provenance-change";
		const staticModels = [model(providerId, "static")];
		const now = 1_700_000_000_000;
		await resolveProviderModels<Api>(
			{
				providerId,
				staticModels,
				cacheDbPath,
				cacheDynamicModelProvenance: "credential-a\u0000https://provider-a.example.test",
				now: () => now,
				fetchDynamicModels: async () => [model(providerId, "dynamic")],
			},
			"online",
		);

		const offline = await resolveProviderModels<Api>(
			{
				providerId,
				staticModels,
				cacheDbPath,
				cacheDynamicModelProvenance: "credential-b\u0000https://provider-b.example.test",
				now: () => now,
				fetchDynamicModels: async () => {
					throw new Error("offline refresh must not fetch");
				},
			},
			"offline",
		);

		expect(offline.models.map(entry => entry.id)).toEqual(["static", "dynamic"]);
		expect(offline.dynamicModelIds).toBeUndefined();
	});

	test("withholds matching cached dynamic IDs during offline refresh", async () => {
		const providerId = "cache-offline-provenance";
		const staticModels = [model(providerId, "static")];
		const now = 1_700_000_000_000;
		const provenance = "credential-a\u0000https://provider-a.example.test";
		await resolveProviderModels<Api>(
			{
				providerId,
				staticModels,
				cacheDbPath,
				cacheDynamicModelProvenance: provenance,
				now: () => now,
				fetchDynamicModels: async () => [model(providerId, "dynamic")],
			},
			"online",
		);

		const offline = await resolveProviderModels<Api>(
			{
				providerId,
				staticModels,
				cacheDbPath,
				cacheDynamicModelProvenance: provenance,
				now: () => now,
				fetchDynamicModels: async () => {
					throw new Error("offline refresh must not fetch");
				},
			},
			"offline",
		);

		expect(offline.models.map(entry => entry.id)).toEqual(["static", "dynamic"]);
		expect(offline.dynamicModelIds).toBeUndefined();
	});

	test("refreshes missing and stale caches", async () => {
		const now = 1_700_000_000_000;
		for (const [providerId, cachedAt] of [
			["cache-missing", undefined],
			["cache-stale", now - CACHE_TTL_MS - 1],
		] as const) {
			const staticModels = [model(providerId, "static")];
			if (cachedAt !== undefined) {
				writeModelCache(providerId, cachedAt, staticModels, true, fingerprint(staticModels), cacheDbPath);
			}
			let discoveryCalls = 0;

			const result = await resolveProviderModels<Api>(
				{
					providerId,
					staticModels,
					cacheDbPath,
					now: () => now,
					fetchDynamicModels: async () => {
						discoveryCalls += 1;
						return [model(providerId, "network")];
					},
				},
				"online-if-uncached",
			);

			expect(discoveryCalls, providerId).toBe(1);
			expect(result.stale, providerId).toBe(false);
			expect(
				result.models.some(entry => entry.id === "network"),
				providerId,
			).toBe(true);
		}
	});

	test("retries a fresh non-authoritative cache at the five-minute boundary", async () => {
		const providerId = "cache-non-authoritative";
		const staticModels = [model(providerId, "static")];
		const cachedModels = [...staticModels, model(providerId, "cached")];
		const cachedAt = 1_700_000_000_000;
		let now = cachedAt + NON_AUTHORITATIVE_RETRY_MS - 1;
		let discoveryCalls = 0;
		writeModelCache(providerId, cachedAt, cachedModels, false, fingerprint(staticModels), cacheDbPath);
		const options = {
			providerId,
			staticModels,
			cacheDbPath,
			now: () => now,
			fetchDynamicModels: async () => {
				discoveryCalls += 1;
				return [model(providerId, "network")];
			},
		};

		const beforeBoundary = await resolveProviderModels<Api>(options, "online-if-uncached");
		expect(discoveryCalls).toBe(0);
		expect(beforeBoundary.stale).toBe(true);
		expect(beforeBoundary.models.some(entry => entry.id === "cached")).toBe(true);

		now = cachedAt + NON_AUTHORITATIVE_RETRY_MS;
		const atBoundary = await resolveProviderModels<Api>(options, "online-if-uncached");
		expect(discoveryCalls).toBe(1);
		expect(atBoundary.stale).toBe(false);
		expect(atBoundary.models.some(entry => entry.id === "network")).toBe(true);
	});

	test("falls back safely when discovery throws or returns null", async () => {
		for (const failure of ["throw", "null"] as const) {
			const providerId = `cache-fallback-${failure}`;
			const staticModels = [model(providerId, "static")];
			const result = await resolveProviderModels<Api>(
				{
					providerId,
					staticModels,
					cacheDbPath,
					fetchDynamicModels: async () => {
						if (failure === "throw") throw new Error("discovery failed");
						return null;
					},
				},
				"online-if-uncached",
			);

			expect(result.stale, failure).toBe(true);
			expect(
				result.models.map(entry => entry.id),
				failure,
			).toEqual(["static"]);
		}
	});

	test("does not present stale or failed catalog IDs as live evidence", async () => {
		const providerId = "cache-unproven-ids";
		const staticModels = [model(providerId, "static")];
		const result = await resolveProviderModels<Api>(
			{
				providerId,
				staticModels,
				cacheDbPath,
				fetchDynamicModels: async () => null,
			},
			"online",
		);

		expect(result.models.map(entry => entry.id)).toEqual(["static"]);
		expect(result.stale).toBe(true);
		expect(result.dynamicModelIds).toBeUndefined();
	});

	test("does not publish successful dynamic models when the cache guard denies publication", async () => {
		const providerId = "cache-guard-success-denied";
		const now = 1_700_000_000_000;

		await resolveProviderModels<Api>(
			{
				providerId,
				staticModels: [model(providerId, "static")],
				cacheDbPath,
				now: () => now,
				canPublishCache: () => false,
				fetchDynamicModels: async () => [model(providerId, "dynamic")],
			},
			"online",
		);

		expect(readModelCache<Api>(providerId, CACHE_TTL_MS, () => now, cacheDbPath)).toBeNull();
	});

	test("does not downgrade an authoritative cache when the failed-fetch guard denies publication", async () => {
		const providerId = "cache-guard-failure-denied";
		const now = 1_700_000_000_000;
		const cachedAt = now - CACHE_TTL_MS - 1;
		const cachedModels = [model(providerId, "cached")];
		writeModelCache(providerId, cachedAt, cachedModels, true, fingerprint([]), cacheDbPath);

		await resolveProviderModels<Api>(
			{
				providerId,
				staticModels: [],
				cacheDbPath,
				now: () => now,
				canPublishCache: () => false,
				fetchDynamicModels: async () => null,
			},
			"online",
		);

		const cache = readModelCache<Api>(providerId, CACHE_TTL_MS * 2, () => now, cacheDbPath);
		expect(cache).toMatchObject({ authoritative: true, updatedAt: cachedAt, models: cachedModels });
	});

	test("publishes dynamic models by default and when the cache guard permits it", async () => {
		const now = 1_700_000_000_000;
		for (const [providerId, canPublishCache] of [
			["cache-guard-default", undefined],
			["cache-guard-allowed", () => true],
		] as const) {
			await resolveProviderModels<Api>(
				{
					providerId,
					staticModels: [],
					cacheDbPath,
					now: () => now,
					canPublishCache,
					fetchDynamicModels: async () => [model(providerId, "dynamic")],
				},
				"online",
			);

			expect(readModelCache<Api>(providerId, CACHE_TTL_MS, () => now, cacheDbPath)).toMatchObject({
				authoritative: true,
				models: [expect.objectContaining({ id: "dynamic" })],
			});
		}
	});

	test("preserves Muse Spark xhigh after dynamic OpenRouter discovery merges", async () => {
		const providerId = "openrouter";
		const muse = {
			...model(providerId, "meta/muse-spark-1.2"),
			name: "Meta: Muse Spark 1.2",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoning: true,
			contextWindow: 1_048_576,
			maxTokens: 131_072,
		};

		const result = await resolveProviderModels<Api>(
			{
				providerId,
				staticModels: [muse],
				cacheDbPath,
				fetchDynamicModels: async () => [{ ...muse, reasoning: false, thinking: undefined }],
			},
			"online",
		);

		expect(result.models).toContainEqual(
			expect.objectContaining({
				id: "meta/muse-spark-1.2",
				thinking: {
					mode: "effort",
					minLevel: Effort.Minimal,
					maxLevel: Effort.XHigh,
				},
			}),
		);
	});
});
