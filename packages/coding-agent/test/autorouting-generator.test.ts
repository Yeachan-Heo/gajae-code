import { describe, expect, it } from "bun:test";
import type { Model } from "@gajae-code/ai";
import { resolveTaskRouting } from "../src/config/autorouting";
import { validateAutoroutingEffective } from "../src/config/autorouting-contract";
import { canonicalJsonBytes, generateTierChains } from "../src/config/autorouting-generator";
import type { CuratedTierLabels } from "../src/config/autorouting-tier-map";

function model(provider: string, id: string, reasoning = true): Model {
	return {
		provider,
		id,
		name: id,
		api: "openai-completions",
		baseUrl: "https://example.invalid",
		reasoning,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4096,
	};
}

function bytes(value: unknown): string {
	return new TextDecoder().decode(canonicalJsonBytes(value));
}

const syntheticLabels = {
	"alpha/fast": [{ tier: "fast", rank: 1 }],
	"alpha/slow": [{ tier: "fast", rank: 2 }],
	"beta/fast": [{ tier: "fast", rank: 1 }],
	"gamma/fast": [{ tier: "fast", rank: 1 }],
	"alpha/strong": [{ tier: "strong", effort: "high", rank: 1 }],
} satisfies CuratedTierLabels;

const syntheticMap = { labels: syntheticLabels, skips: {}, version: 1 };

describe("autorouting generator", () => {
	it("is byte-identical across repeated runs", () => {
		const catalog = [model("alpha", "fast"), model("alpha", "slow"), model("alpha", "strong")];
		const setup = { schema: 1 as const, providers: ["alpha"] };
		const first = generateTierChains(setup, syntheticMap, catalog);
		const second = generateTierChains(setup, syntheticMap, catalog);
		expect(bytes(first.tiers)).toBe(bytes(second.tiers));
		expect(first).toEqual(second);
	});

	it("orders by provider declaration, then curation rank, and is stable under catalog permutation", () => {
		const catalog = [model("alpha", "slow"), model("gamma", "fast"), model("beta", "fast"), model("alpha", "fast")];
		const setup = { schema: 1 as const, providers: ["beta", "alpha", "gamma"] };
		const first = generateTierChains(setup, syntheticMap, catalog);
		const second = generateTierChains(setup, syntheticMap, [...catalog].reverse());
		expect(first.tiers.fast).toEqual(["beta/fast", "alpha/fast", "alpha/slow", "gamma/fast"]);
		expect(bytes(first.tiers)).toBe(bytes(second.tiers));
	});

	it("omits unlabeled and empty tiers so downstream routing falls through honestly", () => {
		const result = generateTierChains(
			{ schema: 1, providers: ["qianfan"] },
			{ labels: { "qianfan/only": [{ tier: "fast", rank: 1 }] }, skips: {}, version: 1 },
			[model("qianfan", "only", false)],
		);
		expect(result.tiers).toEqual({ fast: ["qianfan/only"] });
		const routing = resolveTaskRouting({
			effectiveAutorouting: validateAutoroutingEffective({ enabled: true, tiers: result.tiers }),
			requestedTier: "balanced",
			availableModels: [model("qianfan", "only", false)],
		});
		expect(routing).toMatchObject({ kind: "manual-fallback", reason: "tier_missing_in_map" });
	});

	it("uses allowlists only as eligibility filters and never as a priority channel", () => {
		const catalog = [model("alpha", "fast"), model("alpha", "slow"), model("beta", "fast")];
		const setup = {
			schema: 1 as const,
			providers: ["alpha", "beta"],
			models: ["alpha/slow", "beta/fast", "alpha/fast"],
		};
		const result = generateTierChains(setup, syntheticMap, catalog);
		expect(result.tiers.fast).toEqual(["alpha/fast", "alpha/slow", "beta/fast"]);
	});

	it("deduplicates duplicate catalog overlays without inventing tier membership", () => {
		const catalog = [model("alpha", "fast"), model("alpha", "fast"), model("alpha", "strong")];
		const result = generateTierChains({ schema: 1, providers: ["alpha", "alpha"] }, syntheticMap, catalog);
		expect(result.tiers.fast).toEqual(["alpha/fast"]);
		expect(result.tiers.strong).toEqual(["alpha/strong:high"]);
	});

	it("does not consult credentials or auth state", () => {
		const setup = { schema: 1 as const, providers: ["alpha"] };
		const catalog = [model("alpha", "fast")];
		const authenticated = generateTierChains(setup, syntheticMap, catalog);
		const unauthenticated = generateTierChains(
			setup,
			syntheticMap,
			catalog.map(entry => ({ ...entry, baseUrl: "https://other.invalid" })),
		);
		expect(bytes(authenticated.tiers)).toBe(bytes(unauthenticated.tiers));
		expect(authenticated.declarationFingerprint).toBe(unauthenticated.declarationFingerprint);
	});

	it("matches the frozen canonical-byte golden fixtures", async () => {
		const fixtureNames = ["anthropic", "anthropic-google", "openai", "thin-single-provider"] as const;
		for (const name of fixtureNames) {
			const fixture = (await Bun.file(new URL(`./autorouting-golden/${name}.json`, import.meta.url)).json()) as {
				catalog: Array<{ provider: string; id: string; reasoning: boolean }>;
				setup: { schema: 1; providers: string[] };
				expectedTiers: Record<string, string[]>;
				expectedCanonicalBytes: string;
			};
			const catalog = fixture.catalog.map(entry => model(entry.provider, entry.id, entry.reasoning));
			const result = generateTierChains(fixture.setup, undefined, catalog);
			expect(bytes(result.tiers)).toBe(fixture.expectedCanonicalBytes);
			expect(result.tiers).toEqual(fixture.expectedTiers);
		}
	});
});
