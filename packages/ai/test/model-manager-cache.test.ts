import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readModelCache, writeModelCache } from "../src/model-cache";
import { resolveProviderModels } from "../src/model-manager";
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
});
