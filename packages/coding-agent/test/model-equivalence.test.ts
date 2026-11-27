import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@gajae-code/ai";
import {
	buildCanonicalModelIndex,
	compareEquivalentModelVariants,
	getFinalSlashSegmentAliasKey,
} from "@gajae-code/coding-agent/config/model-equivalence";

function makeModel(provider: string, id: string, overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider,
		baseUrl: `https://${provider}.example.com/v1`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
		...overrides,
	} as Model<Api>;
}

describe("final-slash-segment alias keys", () => {
	test("bare ids yield the id itself", () => {
		expect(getFinalSlashSegmentAliasKey("claude-sonnet-4.5")).toBe("claude-sonnet-4.5");
		expect(getFinalSlashSegmentAliasKey("GLM-4.7")).toBe("glm-4.7");
	});

	test("single slash yields the last segment", () => {
		expect(getFinalSlashSegmentAliasKey("anthropic/claude-sonnet-4.5")).toBe("claude-sonnet-4.5");
		expect(getFinalSlashSegmentAliasKey("hf:nvidia/Kimi-K2.5-NVFP4")).toBe("kimi-k2.5-nvfp4");
	});

	test("arbitrary slash depth yields the last segment", () => {
		expect(getFinalSlashSegmentAliasKey("a/b/c/deep-model")).toBe("deep-model");
		expect(getFinalSlashSegmentAliasKey("one/two/three/four/five")).toBe("five");
	});

	test("empty and trailing-slash ids yield undefined", () => {
		expect(getFinalSlashSegmentAliasKey("")).toBeUndefined();
		expect(getFinalSlashSegmentAliasKey("   ")).toBeUndefined();
		expect(getFinalSlashSegmentAliasKey("alpha/")).toBeUndefined();
	});
});

describe("compareEquivalentModelVariants axis order", () => {
	test("keeps the legacy vision-first order by default", () => {
		const textOnly = makeModel("first", "text-model", { input: ["text"] });
		const vision = makeModel("second", "vision-model", { input: ["text", "image"] });
		const providerRank = new Map([
			["first", 0],
			["second", 1],
		]);
		// Default: vision wins despite the worse provider rank.
		expect(compareEquivalentModelVariants(textOnly, vision, { providerRank })).toBeGreaterThan(0);
		expect(compareEquivalentModelVariants(vision, textOnly, { providerRank })).toBeLessThan(0);
	});

	test("provider-rank-first order prefers the configured provider over vision", () => {
		const textOnly = makeModel("first", "text-model", { input: ["text"] });
		const vision = makeModel("second", "vision-model", { input: ["text", "image"] });
		const providerRank = new Map([
			["first", 0],
			["second", 1],
		]);
		expect(compareEquivalentModelVariants(textOnly, vision, { providerRank, providerRankFirst: true })).toBeLessThan(
			0,
		);
		expect(
			compareEquivalentModelVariants(vision, textOnly, { providerRank, providerRankFirst: true }),
		).toBeGreaterThan(0);
	});

	test("provider-rank-first falls back to vision when provider ranks tie", () => {
		const textOnly = makeModel("same", "text-model", { input: ["text"] });
		const vision = makeModel("same", "vision-model", { input: ["text", "image"] });
		const providerRank = new Map([["same", 1]]);
		expect(
			compareEquivalentModelVariants(textOnly, vision, { providerRank, providerRankFirst: true }),
		).toBeGreaterThan(0);
	});

	test("walks the full provider-rank-first axis chain", () => {
		const providerRank = new Map([["same", 1]]);

		// Same rank and vision: canonical exactness decides.
		const exact = makeModel("same", "canonical-model", { input: ["text", "image"] });
		const inexact = makeModel("same", "prefix/canonical-model", { input: ["text", "image"] });
		expect(
			compareEquivalentModelVariants(exact, inexact, {
				providerRank,
				providerRankFirst: true,
				canonicalId: "canonical-model",
			}),
		).toBeLessThan(0);

		// Same rank, vision, and exactness: canonical source rank decides.
		const overrideSource = makeModel("same", "other-model", { input: ["text", "image"] });
		const fallbackSource = makeModel("same", "fallback-model", { input: ["text", "image"] });
		expect(
			compareEquivalentModelVariants(overrideSource, fallbackSource, {
				providerRank,
				providerRankFirst: true,
				canonicalId: "unrelated",
				leftSourceRank: 1,
				rightSourceRank: 3,
			}),
		).toBeLessThan(0);

		// Same rank, vision, exactness, and source: input plus cache-read cost decides.
		const cheap = makeModel("same", "cheap-model", {
			input: ["text", "image"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
		});
		const expensive = makeModel("same", "expensive-model", {
			input: ["text", "image"],
			cost: { input: 5, output: 10, cacheRead: 0.5, cacheWrite: 0 },
		});
		expect(
			compareEquivalentModelVariants(cheap, expensive, {
				providerRank,
				providerRankFirst: true,
				canonicalId: "unrelated",
				leftSourceRank: 1,
				rightSourceRank: 1,
				includeCost: true,
			}),
		).toBeLessThan(0);

		// Stable model order breaks the remaining tie.
		const firstOrder = makeModel("same", "order-a", { input: ["text", "image"] });
		const secondOrder = makeModel("same", "order-b", { input: ["text", "image"] });
		const modelOrder = new Map([
			["same/order-a", 0],
			["same/order-b", 1],
		]);
		expect(
			compareEquivalentModelVariants(firstOrder, secondOrder, {
				providerRank,
				providerRankFirst: true,
				canonicalId: "unrelated",
				leftSourceRank: 1,
				rightSourceRank: 1,
				includeCost: true,
				modelOrder,
			}),
		).toBeLessThan(0);

		// Without model order the selector lexicographic tie-break applies.
		expect(
			compareEquivalentModelVariants(firstOrder, secondOrder, {
				providerRank,
				providerRankFirst: true,
				canonicalId: "unrelated",
				leftSourceRank: 1,
				rightSourceRank: 1,
				includeCost: true,
			}),
		).toBeLessThan(0);
	});
});

describe("buildCanonicalModelIndex alias indexing", () => {
	test("indexes final-segment aliases without rewriting canonical identity", () => {
		const models = [
			makeModel("demo", "anthropic/claude-sonnet-4.5"),
			makeModel("demo", "org/team/project/deep-model"),
		];
		const index = buildCanonicalModelIndex(models);

		expect(index.aliases.get("claude-sonnet-4.5")).toEqual(["demo/anthropic/claude-sonnet-4.5"]);
		expect(index.aliases.get("deep-model")).toEqual(["demo/org/team/project/deep-model"]);

		// Canonical records keep the original model objects untouched.
		const record = index.byId.get("claude-sonnet-4-5");
		expect(record).toBeDefined();
		const variant = record!.variants.find(entry => entry.selector === "demo/anthropic/claude-sonnet-4.5");
		expect(variant).toBeDefined();
		expect(variant!.model).toBe(models[0]);
		expect(variant!.model.id).toBe("anthropic/claude-sonnet-4.5");
		expect(index.bySelector.get("demo/anthropic/claude-sonnet-4.5")).toBe("claude-sonnet-4-5");
	});

	test("gathers every colliding variant selector under the shared alias key", () => {
		const models = [makeModel("alpha", "x/conflict-model"), makeModel("beta", "y/conflict-model")];
		const index = buildCanonicalModelIndex(models);

		// Multi-target: both variants collide on the same final segment.
		expect([...(index.aliases.get("conflict-model") ?? [])].sort()).toEqual([
			"alpha/x/conflict-model",
			"beta/y/conflict-model",
		]);
		// Both records still exist under their own canonical ids.
		expect(index.byId.get("x/conflict-model")).toBeDefined();
		expect(index.byId.get("y/conflict-model")).toBeDefined();
	});

	test("keeps distinct colliding variants inside a shared canonical record", () => {
		const models = [makeModel("demo", "org/conflict-model"), makeModel("demo", "team/conflict-model")];
		const index = buildCanonicalModelIndex(models);

		expect([...(index.aliases.get("conflict-model") ?? [])].sort()).toEqual([
			"demo/org/conflict-model",
			"demo/team/conflict-model",
		]);
		// Two distinct canonical records keep their own variants.
		expect(index.byId.get("org/conflict-model")!.variants.map(entry => entry.selector)).toEqual([
			"demo/org/conflict-model",
		]);
		expect(index.byId.get("team/conflict-model")!.variants.map(entry => entry.selector)).toEqual([
			"demo/team/conflict-model",
		]);
	});

	test("alias index is variant-level within a shared canonical record", () => {
		// Both model ids canonicalize to the same record, but end in different
		// final segments: `claude-sonnet-4.5` and `claude-sonnet-45`. Each alias
		// key must list only its own matching variant selector.
		const models = [makeModel("demo", "anthropic/claude-sonnet-4.5"), makeModel("demo", "claude-sonnet-45")];
		const index = buildCanonicalModelIndex(models);

		expect(index.byId.get("claude-sonnet-4-5")).toBeDefined();
		expect(index.aliases.get("claude-sonnet-4.5")).toEqual(["demo/anthropic/claude-sonnet-4.5"]);
		expect(index.aliases.get("claude-sonnet-45")).toEqual(["demo/claude-sonnet-45"]);
	});

	test("preserves full model and wire ids in indexed variants", () => {
		const wireModel = makeModel("demo", "anthropic/claude-sonnet-4.5", {
			name: "Sonnet via demo",
			wireModelId: "wire-sonnet-4.5",
		});
		const index = buildCanonicalModelIndex([wireModel]);

		const variant = index.byId.get("claude-sonnet-4-5")!.variants[0];
		expect(variant.model).toBe(wireModel);
		expect(variant.model.id).toBe("anthropic/claude-sonnet-4.5");
		expect(variant.model.wireModelId).toBe("wire-sonnet-4.5");
		expect(variant.model.name).toBe("Sonnet via demo");
		// The alias maps to the canonical record, never to a rewritten id.
		expect(index.aliases.get("claude-sonnet-4.5")).toEqual(["demo/anthropic/claude-sonnet-4.5"]);
	});

	test("canonical ids and selectors stay authoritative over aliases", () => {
		const models = [makeModel("demo", "anthropic/claude-sonnet-4.5")];
		const index = buildCanonicalModelIndex(models);

		// A lookup that is both a canonical id and a final segment prefers byId.
		expect(index.byId.has("claude-sonnet-4-5")).toBe(true);
		expect(index.aliases.get("claude-sonnet-4-5")).toBeUndefined();
		expect(index.aliases.get("claude-sonnet-4.5")).toEqual(["demo/anthropic/claude-sonnet-4.5"]);
	});

	test("fails alias indexing closed for case-normalized concrete selector collisions", () => {
		const lower = makeModel("Demo", "org/shared-model");
		const upper = makeModel("demo", "ORG/SHARED-MODEL");
		const index = buildCanonicalModelIndex([lower, upper]);

		expect(index.bySelector.has("demo/org/shared-model")).toBe(false);
		expect(index.aliases.get("shared-model")).toBeUndefined();
	});
});

describe("buildCanonicalModelIndex resolution reuse", () => {
	test("keeps provider and id apart when their joined selectors coincide", () => {
		const slashedProvider = makeModel("vendor/region", "custom-model");
		const slashedId = makeModel("vendor", "region/custom-model");
		const index = buildCanonicalModelIndex([slashedProvider, slashedId]);

		expect(index.byId.get("custom-model")!.variants.map(entry => entry.model)).toEqual([slashedProvider]);
		expect(index.byId.get("region/custom-model")!.variants.map(entry => entry.model)).toEqual([slashedId]);
	});

	test("reuses resolution when a reloaded equivalence config has the same content", () => {
		// Count `id` reads on fresh model objects: a memoized resolution reads the id
		// a fixed few times, a full heuristic resolution reads it more. The catalog is
		// larger than the bounded per-id heuristic cache so that cache cannot hide a miss.
		const ids = Array.from({ length: 400 }, (_, index) => `reuse-family-${index}.5-preview`);
		const idReadsForRebuild = (equivalence: { exclude: string[] }): number => {
			let reads = 0;
			const models = ids.map(id => {
				const model = makeModel("reuse-provider", id);
				return new Proxy(model, {
					get(target, property, receiver) {
						if (property === "id") reads += 1;
						return Reflect.get(target, property, receiver);
					},
				});
			});
			buildCanonicalModelIndex(models, equivalence);
			return reads;
		};
		const config = { exclude: ["reuse-provider/excluded-model"] };
		const firstReads = idReadsForRebuild(config);
		const reloadedReads = idReadsForRebuild(structuredClone(config));

		expect(reloadedReads).toBeLessThan(firstReads);
	});

	test("does not reuse resolution across equivalence configs with different content", () => {
		// Each step changes exactly one field so a key that ignored either field would
		// hand back the previous step's resolutions.
		const pinned = makeModel("reuse-provider", "pinned-source");
		const normalized = makeModel("reuse-provider", "claude-sonnet-4-5-20250929");
		const canonicalOf = (
			equivalence: { overrides: Record<string, string>; exclude: string[] },
			model: Model<Api>,
		): string | undefined =>
			buildCanonicalModelIndex([pinned, normalized], equivalence).bySelector.get(
				`${model.provider}/${model.id}`.toLowerCase(),
			);
		const exclude = ["reuse-provider/unrelated"];

		expect(canonicalOf({ overrides: { "reuse-provider/pinned-source": "pinned-a" }, exclude }, pinned)).toBe(
			"pinned-a",
		);
		expect(canonicalOf({ overrides: { "reuse-provider/pinned-source": "pinned-b" }, exclude }, pinned)).toBe(
			"pinned-b",
		);

		const overrides = { "reuse-provider/pinned-source": "pinned-b" };
		const heuristic = canonicalOf({ overrides, exclude }, normalized);
		expect(heuristic).not.toBe(normalized.id);
		expect(canonicalOf({ overrides, exclude: ["reuse-provider/claude-sonnet-4-5-20250929"] }, normalized)).toBe(
			normalized.id,
		);
	});
});
