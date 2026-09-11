import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readModelCache, writeModelCache } from "../src/model-cache";
import { resolveProviderModels } from "../src/model-manager";
import { Effort } from "../src/model-thinking";
import { getBundledModel, getBundledModels } from "../src/models";
import {
	opencodeGoModelManagerOptions,
	UNK_CONTEXT_WINDOW,
	UNK_MAX_TOKENS,
} from "../src/provider-models/openai-compat";
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
		vi.restoreAllMocks();
		rmSync(cacheDir, { recursive: true, force: true });
	});

	test("preserves Muse 1.3 metadata through ID-only discovery and cache reuse", async () => {
		const id = "muse-spark-1.3-contributor";
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ data: [{ id }] }));
		const options = {
			...opencodeGoModelManagerOptions({ apiKey: "test-key" }),
			staticModels: getBundledModels("opencode-go"),
			cacheDbPath,
		};
		const online = await resolveProviderModels<Api>(options, "online");
		const muse = online.models.find(entry => entry.id === id);
		expect(muse).toMatchObject({
			api: "openai-responses",
			reasoning: true,
			thinking: { mode: "effort", minLevel: Effort.Minimal, maxLevel: Effort.XHigh },
			contextWindow: 1_048_576,
			maxTokens: 131_072,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 },
			input: ["text", "image"],
		});
		expect(muse).toEqual(getBundledModel("opencode-go", id));
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const cached = await resolveProviderModels<Api>(options, "offline");
		expect(cached.models.find(entry => entry.id === id)).toEqual(muse);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	test("Go discovery applies reviewed Muse limits while preserving endpoint and uncurated model metadata", async () => {
		const id = "muse-spark-1.3-contributor";
		const baseUrl = "https://go.example.test/v1";
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({
				data: [
					{
						id,
						name: "Endpoint Contributor name",
						context_length: 64_000,
						max_completion_tokens: 4_000,
					},
					{
						id: "muse-spark-1.3",
						name: "Endpoint uncurated name",
						context_length: 64_000,
						max_tokens: 4_000,
					},
				],
			}),
		);
		const options = opencodeGoModelManagerOptions({ apiKey: "test-key", baseUrl });
		const discovered = await options.fetchDynamicModels?.();
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(fetchSpy.mock.calls[0]?.[0]).toBe(`${baseUrl}/models`);
		expect(discovered).toHaveLength(2);
		expect(discovered).toContainEqual({
			...getBundledModel("opencode-go", id),
			baseUrl,
		});
		expect(discovered).toContainEqual({
			id: "muse-spark-1.3",
			name: "Endpoint uncurated name",
			api: "openai-completions",
			provider: "opencode-go",
			baseUrl,
			contextWindow: 64_000,
			maxTokens: 4_000,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
	});

	test("refreshes stale Muse 1.3 placeholder cache metadata through ID-only discovery", async () => {
		const providerId = "opencode-go";
		const id = "muse-spark-1.3-contributor";
		const now = 1_700_000_000_000;
		const stale = {
			...model(providerId, id),
			contextWindow: UNK_CONTEXT_WINDOW,
			maxTokens: UNK_MAX_TOKENS,
		};
		writeModelCache(providerId, now - CACHE_TTL_MS - 1, [stale], true, fingerprint([stale]), cacheDbPath);
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ data: [{ id }] }));
		const options = {
			...opencodeGoModelManagerOptions({ apiKey: "test-key" }),
			staticModels: getBundledModels(providerId),
			cacheDbPath,
			now: () => now,
		};
		const result = await resolveProviderModels<Api>(options, "online-if-uncached");
		const muse = result.models.find(entry => entry.id === id);
		expect(muse?.api).toBe("openai-responses");
		expect(muse).toEqual(getBundledModel(providerId, id));
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(readModelCache<Api>(providerId, CACHE_TTL_MS, () => now, cacheDbPath)?.models).toContainEqual(muse);
	});

	test("upgrades a fresh pre-review Muse cache with matching registry-owned provenance", async () => {
		const providerId = "opencode-go";
		const id = "muse-spark-1.3-contributor";
		const now = 1_700_000_000_000;
		const provenance = "registry-owned-credential-endpoint";
		const placeholder = {
			...model(providerId, id),
			contextWindow: UNK_CONTEXT_WINDOW,
			maxTokens: UNK_MAX_TOKENS,
		};
		writeModelCache(providerId, now, [placeholder], true, fingerprint([placeholder]), cacheDbPath, [id], provenance);
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ data: [{ id }] }));
		const result = await resolveProviderModels<Api>(
			{
				...opencodeGoModelManagerOptions({ apiKey: "test-key" }),
				staticModels: getBundledModels(providerId),
				cacheDbPath,
				now: () => now,
				// The CLI registry owns this value and overrides descriptor options.
				cacheDynamicModelProvenance: provenance,
			},
			"online-if-uncached",
		);
		expect(fetchSpy).toHaveBeenCalledTimes(0);
		expect(result.models.find(entry => entry.id === id)).toMatchObject({
			api: "openai-responses",
			contextWindow: 1_048_576,
			maxTokens: 131_072,
			reasoning: true,
			thinking: { mode: "effort", minLevel: Effort.Minimal, maxLevel: Effort.XHigh },
		});
	});

	test.each([
		"offline",
		"online-if-uncached",
		"online",
	] as const)("repairs pre-review Muse limits during %s without changing refresh or error fallback", async strategy => {
		const providerId = "opencode-go";
		const id = "muse-spark-1.3-contributor";
		const now = 1_700_000_000_000;
		const staticModels = [getBundledModel(providerId, id)];
		const placeholder = {
			...model(providerId, id),
			contextWindow: UNK_CONTEXT_WINDOW,
			maxTokens: UNK_MAX_TOKENS,
		};
		const provenance = "same-credential-endpoint";
		writeModelCache(providerId, now, [placeholder], true, fingerprint(staticModels), cacheDbPath, [id], provenance);
		const fetchDynamicModels = vi.fn(async () => null);
		const options = {
			providerId,
			staticModels,
			cacheDbPath,
			now: () => now,
			cacheDynamicModelProvenance: provenance,
			fetchDynamicModels,
		};
		const result = await resolveProviderModels<Api>(options, strategy);
		expect(result.models[0]).toMatchObject(staticModels[0]!);
		expect(fetchDynamicModels).toHaveBeenCalledTimes(strategy === "online" ? 1 : 0);
		const reused = await resolveProviderModels<Api>(options, "offline");
		expect(reused.models[0]).toMatchObject(staticModels[0]!);
	});

	test.each([
		{ contextWindow: 64_000, maxTokens: 4_000 },
		{ contextWindow: 2_000_000, maxTokens: 200_000 },
		{ contextWindow: UNK_CONTEXT_WINDOW, maxTokens: 4_000 },
		{ contextWindow: 64_000, maxTokens: UNK_MAX_TOKENS },
		{ contextWindow: UNK_CONTEXT_WINDOW, maxTokens: UNK_MAX_TOKENS, reasoning: true },
		{
			contextWindow: UNK_CONTEXT_WINDOW,
			maxTokens: UNK_MAX_TOKENS,
			api: "openai-responses" as const,
		},
	])("model-manager merge preserves non-placeholder already-mapped Muse limits %j", async overrides => {
		const providerId = "opencode-go";
		const id = "muse-spark-1.3-contributor";
		const discovered = { ...model(providerId, id), ...overrides };
		const result = await resolveProviderModels<Api>(
			{
				providerId,
				staticModels: [getBundledModel(providerId, id)],
				cacheDbPath,
				fetchDynamicModels: async () => [discovered],
			},
			"online",
		);
		expect(result.models[0]).toMatchObject({
			api: "openai-responses",
			reasoning: true,
			contextWindow: overrides.contextWindow,
			maxTokens: overrides.maxTokens,
		});
	});

	test.each([
		["opencode-go", "muse-spark-1.2-contributor"],
		["opencode-go", "muse-spark-1.4-contributor"],
		["other-provider", "muse-spark-1.3-contributor"],
	])("does not reinterpret placeholders for %s/%s", async (providerId, id) => {
		const reference = {
			...getBundledModel("opencode-go", "muse-spark-1.3-contributor"),
			provider: providerId,
			id,
		};
		const result = await resolveProviderModels<Api>(
			{
				providerId,
				staticModels: [reference],
				cacheDbPath,
				fetchDynamicModels: async () => [
					{
						...model(providerId, id),
						contextWindow: UNK_CONTEXT_WINDOW,
						maxTokens: UNK_MAX_TOKENS,
					},
				],
			},
			"online",
		);
		expect(result.models[0]).toMatchObject({
			contextWindow: UNK_CONTEXT_WINDOW,
			maxTokens: UNK_MAX_TOKENS,
		});
	});

	test("reuses a fresh authoritative cache without discovery", async () => {
		const providerId = "cache-authoritative";
		const staticModels = [model(providerId, "static")];
		const cachedModels = [...staticModels, model(providerId, "cached")];
		let discoveryCalls = 0;
		const now = 1_700_000_000_000;
		const provenance = "credential-a\u0000https://provider-a.example.test";
		writeModelCache(
			providerId,
			now,
			cachedModels,
			true,
			fingerprint(staticModels),
			cacheDbPath,
			["cached"],
			provenance,
		);

		const result = await resolveProviderModels<Api>(
			{
				providerId,
				staticModels,
				cacheDbPath,
				cacheDynamicModelProvenance: provenance,
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

	test("refreshes a fresh legacy cache when provenance enables dynamic discovery", async () => {
		const providerId = "cache-legacy-dynamic-catalog";
		const staticModels = [model(providerId, "static")];
		const now = 1_700_000_000_000;
		const provenance = "credential-a\u0000https://provider-a.example.test";
		let discoveryCalls = 0;
		writeModelCache(providerId, now, staticModels, true, fingerprint(staticModels), cacheDbPath);

		const result = await resolveProviderModels<Api>(
			{
				providerId,
				staticModels,
				cacheDbPath,
				cacheDynamicModelProvenance: provenance,
				now: () => now,
				fetchDynamicModels: async () => {
					discoveryCalls += 1;
					return [model(providerId, "dynamic")];
				},
			},
			"online-if-uncached",
		);

		expect(discoveryCalls).toBe(1);
		expect(result.fetched).toBe(true);
		expect(result.models.map(entry => entry.id)).toEqual(["static", "dynamic"]);
		expect(readModelCache<Api>(providerId, CACHE_TTL_MS, () => now, cacheDbPath)).toMatchObject({
			authoritative: true,
			dynamicModelIds: ["dynamic"],
			dynamicModelProvenance: provenance,
		});
	});

	test("coalesces concurrent failed refreshes of a legacy provenance cache", async () => {
		const providerId = "cache-concurrent-legacy-dynamic-catalog";
		const staticModels = [model(providerId, "static")];
		const now = 1_700_000_000_000;
		const provenance = "credential-a\u0000https://provider-a.example.test";
		const fetchStarted = Promise.withResolvers<void>();
		const releaseFetch = Promise.withResolvers<void>();
		let discoveryCalls = 0;
		writeModelCache(providerId, now, staticModels, true, fingerprint(staticModels), cacheDbPath);
		const options = {
			providerId,
			staticModels,
			cacheDbPath,
			cacheDynamicModelProvenance: provenance,
			now: () => now,
			fetchDynamicModels: async () => {
				discoveryCalls += 1;
				fetchStarted.resolve();
				await releaseFetch.promise;
				return null;
			},
		};

		const first = resolveProviderModels<Api>(options, "online-if-uncached");
		await fetchStarted.promise;
		const second = resolveProviderModels<Api>(options, "online-if-uncached");
		expect(discoveryCalls).toBe(1);

		releaseFetch.resolve();
		const [firstResult, secondResult] = await Promise.all([first, second]);
		expect(firstResult.stale).toBe(true);
		expect(secondResult.stale).toBe(true);
		expect(readModelCache<Api>(providerId, CACHE_TTL_MS, () => now, cacheDbPath)).toMatchObject({
			authoritative: false,
			dynamicModelIds: [],
			dynamicModelProvenance: provenance,
		});

		await resolveProviderModels<Api>(options, "online-if-uncached");
		expect(discoveryCalls).toBe(1);
	});

	test("coalesces concurrent refreshes when the cache is missing", async () => {
		const providerId = "cache-concurrent-missing-dynamic-catalog";
		const staticModels = [model(providerId, "static")];
		const now = 1_700_000_000_000;
		const provenance = "credential-a\u0000https://provider-a.example.test";
		const fetchStarted = Promise.withResolvers<void>();
		const releaseFetch = Promise.withResolvers<void>();
		let discoveryCalls = 0;
		const options = {
			providerId,
			staticModels,
			cacheDbPath,
			cacheDynamicModelProvenance: provenance,
			now: () => now,
			fetchDynamicModels: async () => {
				discoveryCalls += 1;
				fetchStarted.resolve();
				await releaseFetch.promise;
				return [model(providerId, "dynamic")];
			},
		};

		const first = resolveProviderModels<Api>(options, "online-if-uncached");
		await fetchStarted.promise;
		const second = resolveProviderModels<Api>(options, "online-if-uncached");
		expect(discoveryCalls).toBe(1);

		releaseFetch.resolve();
		const [firstResult, secondResult] = await Promise.all([first, second]);
		expect(firstResult.models.map(entry => entry.id)).toEqual(["static", "dynamic"]);
		expect(secondResult.models.map(entry => entry.id)).toEqual(["static", "dynamic"]);
	});

	test("keeps explicit online refreshes independent of cold-start coalescing", async () => {
		const providerId = "cache-explicit-online-not-coalesced";
		const staticModels = [model(providerId, "static")];
		const now = 1_700_000_000_000;
		const provenance = "credential-a\u0000https://provider-a.example.test";
		const fetches: Array<PromiseWithResolvers<void>["resolve"]> = [];
		let discoveryCalls = 0;
		const options = {
			providerId,
			staticModels,
			cacheDbPath,
			cacheDynamicModelProvenance: provenance,
			now: () => now,
			fetchDynamicModels: async () => {
				const callIndex = discoveryCalls + 1;
				discoveryCalls = callIndex;
				const gate = Promise.withResolvers<void>();
				fetches.push(gate.resolve);
				await gate.promise;
				return [model(providerId, `dynamic-${callIndex}`)];
			},
		};

		const older = resolveProviderModels<Api>(options, "online");
		await Bun.sleep(0);
		const newer = resolveProviderModels<Api>(options, "online");
		await Bun.sleep(0);
		// An explicit refresh owns its fetch: neither call waits on the other.
		expect(discoveryCalls).toBe(2);
		for (const release of fetches) release();
		const [olderResult, newerResult] = await Promise.all([older, newer]);
		expect(olderResult.models.map(entry => entry.id)).toEqual(["static", "dynamic-1"]);
		expect(newerResult.models.map(entry => entry.id)).toEqual(["static", "dynamic-2"]);
	});

	test("sanitizes poisoned cached display names", async () => {
		const providerId = "cache-poisoned-display-name";
		const now = 1_700_000_000_000;
		const poisoned = { ...model(providerId, "cached-id"), name: `\u001b]0;pwned\u0007Cached\n${"x".repeat(300)}` };
		writeModelCache(providerId, now, [poisoned], true, "empty", cacheDbPath);

		const result = await resolveProviderModels<Api>(
			{ providerId, staticModels: [], cacheDbPath, now: () => now },
			"offline",
		);

		expect(result.models[0]?.name).toBe("Cached x".padEnd(200, "x"));
		expect(result.models[0]?.name).toMatch(/^[^\x00-\x1f\x7f]*$/);
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

	test("preserves retry backoff after discovery fails without provenance", async () => {
		const providerId = "cache-failed-discovery-without-provenance";
		const staticModels = [model(providerId, "static")];
		const cachedAt = 1_700_000_000_000;
		let now = cachedAt;
		let discoveryCalls = 0;
		const options = {
			providerId,
			staticModels,
			cacheDbPath,
			now: () => now,
			fetchDynamicModels: async () => {
				discoveryCalls += 1;
				return null;
			},
		};

		await resolveProviderModels<Api>(options, "online-if-uncached");
		expect(discoveryCalls).toBe(1);
		expect(readModelCache<Api>(providerId, CACHE_TTL_MS, () => now, cacheDbPath)?.dynamicModelIds).toBeUndefined();

		now = cachedAt + NON_AUTHORITATIVE_RETRY_MS - 1;
		const beforeBoundary = await resolveProviderModels<Api>(options, "online-if-uncached");
		expect(discoveryCalls).toBe(1);
		expect(beforeBoundary.stale).toBe(true);

		now = cachedAt + NON_AUTHORITATIVE_RETRY_MS;
		await resolveProviderModels<Api>(options, "online-if-uncached");
		expect(discoveryCalls).toBe(2);
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

	test("does not consume or overwrite a concurrent cache row from another discovery context after a failed fetch", async () => {
		const providerId = "cache-failed-fetch-cross-context-race";
		const staticModels = [model(providerId, "static")];
		const now = 1_700_000_000_000;
		const provenanceA = "credential-a\u0000https://provider-a.example.test";
		const provenanceB = "credential-b\u0000https://provider-b.example.test";
		const modelsA = [...staticModels, model(providerId, "dynamic-a")];
		const modelsB = [...staticModels, model(providerId, "dynamic-b")];
		writeModelCache(
			providerId,
			now,
			modelsA,
			true,
			fingerprint(staticModels),
			cacheDbPath,
			["dynamic-a"],
			provenanceA,
		);

		const fetchControl: {
			started: () => void;
			resume: (value: readonly Model<Api>[] | null) => void;
		} = {
			started() {},
			resume() {},
		};
		const fetchStartedGate = new Promise<void>(resolve => {
			fetchControl.started = resolve;
		});
		const fetchResumeGate = new Promise<readonly Model<Api>[] | null>(resolve => {
			fetchControl.resume = resolve;
		});
		const pending = resolveProviderModels<Api>(
			{
				providerId,
				staticModels,
				cacheDbPath,
				cacheDynamicModelProvenance: provenanceA,
				now: () => now,
				fetchDynamicModels: async () => {
					fetchControl.started();
					return fetchResumeGate;
				},
			},
			"online",
		);

		await fetchStartedGate;
		writeModelCache(
			providerId,
			now + 1,
			modelsB,
			true,
			fingerprint(staticModels),
			cacheDbPath,
			["dynamic-b"],
			provenanceB,
		);
		fetchControl.resume(null);

		const result = await pending;
		expect(result.models.map(entry => entry.id)).not.toContain("dynamic-b");
		expect(result.dynamicModelIds ?? []).not.toContain("dynamic-b");

		const cache = readModelCache<Api>(providerId, CACHE_TTL_MS, () => now + 1, cacheDbPath);
		expect(cache).toMatchObject({
			authoritative: true,
			updatedAt: now + 1,
			dynamicModelIds: ["dynamic-b"],
			dynamicModelProvenance: provenanceB,
		});
		expect(cache?.models.map(entry => entry.id)).toEqual(["static", "dynamic-b"]);
	});

	test("inserts a non-authoritative tombstone when a failed fetch has no cache row", async () => {
		for (const staticIds of [[], ["static"]] as const) {
			const providerId = `cache-failed-fetch-missing-row-tombstone-${staticIds.length === 0 ? "empty" : "static"}`;
			const staticModels = staticIds.map(id => model(providerId, id));
			const now = 1_700_000_000_000;

			expect(readModelCache<Api>(providerId, CACHE_TTL_MS, () => now, cacheDbPath)).toBeNull();

			const result = await resolveProviderModels<Api>(
				{
					providerId,
					staticModels,
					cacheDbPath,
					now: () => now,
					fetchDynamicModels: async () => null,
				},
				"online",
			);

			expect(result.models.map(entry => entry.id)).toEqual([...staticIds]);
			expect(result.dynamicModelIds).toBeUndefined();
			expect(readModelCache<Api>(providerId, CACHE_TTL_MS, () => now, cacheDbPath)).toMatchObject({
				authoritative: false,
				updatedAt: now,
				dynamicModelIds: undefined,
				dynamicModelProvenance: undefined,
				models: staticIds.map(id => expect.objectContaining({ id })),
			});
		}
	});

	test("applies non-authoritative retry backoff to a bound failed-fetch tombstone instead of refetching on every visit", async () => {
		const providerId = "cache-tombstone-retry-backoff";
		const staticModels = [model(providerId, "static")];
		const now = 1_700_000_000_000;
		const provenance = "credential-a\u0000https://provider-a.example.test";
		let discoveryCalls = 0;

		// Failed fetch with no prior row: a non-authoritative tombstone lands.
		const failed = await resolveProviderModels<Api>(
			{
				providerId,
				staticModels,
				cacheDbPath,
				now: () => now,
				cacheDynamicModelProvenance: provenance,
				fetchDynamicModels: async () => {
					discoveryCalls += 1;
					return null;
				},
			},
			"online",
		);
		expect(failed.models.map(entry => entry.id)).toEqual(["static"]);
		expect(discoveryCalls).toBe(1);
		expect(readModelCache<Api>(providerId, CACHE_TTL_MS, () => now, cacheDbPath)).toMatchObject({
			authoritative: false,
		});

		// A fresh-but-non-authoritative tombstone must not force a network
		// attempt on the next non-offline visit: the standard retry backoff
		// applies, so online-if-uncached answers from the row without fetching.
		const revisit = await resolveProviderModels<Api>(
			{
				providerId,
				staticModels,
				cacheDbPath,
				now: () => now + 1000,
				cacheDynamicModelProvenance: provenance,
				fetchDynamicModels: async () => {
					discoveryCalls += 1;
					return [model(providerId, "dynamic")];
				},
			},
			"online-if-uncached",
		);
		expect(revisit.fetched).toBe(false);
		expect(discoveryCalls).toBe(1);
		expect(revisit.models.map(entry => entry.id)).toEqual(["static"]);

		// Once the row ages past the retry interval, the fetch resumes.
		const afterBackoff = await resolveProviderModels<Api>(
			{
				providerId,
				staticModels,
				cacheDbPath,
				now: () => now + 1000 + NON_AUTHORITATIVE_RETRY_MS,
				cacheDynamicModelProvenance: provenance,
				fetchDynamicModels: async () => {
					discoveryCalls += 1;
					return [model(providerId, "dynamic")];
				},
			},
			"online-if-uncached",
		);
		expect(afterBackoff.fetched).toBe(true);
		expect(discoveryCalls).toBe(2);
	});

	test("fails closed when a failed fetch re-reads a same-provenance row with inconsistent or absent dynamic IDs", async () => {
		for (const inconsistentIds of [undefined, ["dynamic-a"]] as const) {
			const providerId = `cache-failed-fetch-inconsistent-ids-${inconsistentIds === undefined ? "absent" : "mismatch"}`;
			const staticModels = [model(providerId, "static")];
			const now = 1_700_000_000_000;
			const provenanceA = "credential-a\u0000https://provider-a.example.test";
			writeModelCache(
				providerId,
				now,
				[...staticModels, model(providerId, "dynamic-a")],
				true,
				fingerprint(staticModels),
				cacheDbPath,
				["dynamic-a"],
				provenanceA,
			);

			const fetchControl: {
				started: () => void;
				resume: (value: readonly Model<Api>[] | null) => void;
			} = {
				started() {},
				resume() {},
			};
			const fetchStartedGate = new Promise<void>(resolve => {
				fetchControl.started = resolve;
			});
			const fetchResumeGate = new Promise<readonly Model<Api>[] | null>(resolve => {
				fetchControl.resume = resolve;
			});
			const pending = resolveProviderModels<Api>(
				{
					providerId,
					staticModels,
					cacheDbPath,
					cacheDynamicModelProvenance: provenanceA,
					now: () => now,
					fetchDynamicModels: async () => {
						fetchControl.started();
						return fetchResumeGate;
					},
				},
				"online",
			);

			await fetchStartedGate;
			writeModelCache(
				providerId,
				now + 1,
				[...staticModels, model(providerId, "inconsistent")],
				true,
				fingerprint(staticModels),
				cacheDbPath,
				inconsistentIds,
				provenanceA,
			);
			fetchControl.resume(null);

			const result = await pending;
			expect(result.models.map(entry => entry.id)).not.toContain("inconsistent");
			expect(result.dynamicModelIds ?? []).not.toContain("inconsistent");

			const cache = readModelCache<Api>(providerId, CACHE_TTL_MS, () => now + 1, cacheDbPath);
			expect(cache).toMatchObject({
				authoritative: true,
				updatedAt: now + 1,
				dynamicModelIds: inconsistentIds,
				dynamicModelProvenance: provenanceA,
			});
			expect(cache?.models.map(entry => entry.id)).toEqual(["static", "inconsistent"]);
		}
	});

	test("falls back to same-context cached models when a later dynamic fetch fails", async () => {
		const providerId = "cache-failed-fetch-same-context";
		const staticModels = [model(providerId, "static")];
		const now = 1_700_000_000_000;
		const provenance = "credential-a\u0000https://provider-a.example.test";
		writeModelCache(
			providerId,
			now,
			[...staticModels, model(providerId, "dynamic-a")],
			true,
			fingerprint(staticModels),
			cacheDbPath,
			["dynamic-a"],
			provenance,
		);

		const result = await resolveProviderModels<Api>(
			{
				providerId,
				staticModels,
				cacheDbPath,
				cacheDynamicModelProvenance: provenance,
				now: () => now,
				fetchDynamicModels: async () => null,
			},
			"online",
		);

		expect(result.models.map(entry => entry.id)).toEqual(["static", "dynamic-a"]);
		expect(result.dynamicModelIds).toBeUndefined();
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
