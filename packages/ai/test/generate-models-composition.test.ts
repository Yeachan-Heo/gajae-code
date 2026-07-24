import { describe, expect, it } from "bun:test";
import { composeCatalog, FIRST_PARTY_CATALOG_SEEDS, firstPartyCatalogSeedKeys } from "../scripts/generate-models";
import bundledModelsJson from "../src/models.json" with { type: "json" };
import type { Model } from "../src/types";

/**
 * Deterministic generation coverage for the catalog surface this package seeds.
 *
 * `composeCatalog` is the whole merge/normalization pipeline `generateModels()`
 * runs after fetching. These tests drive it with in-memory fixtures only — no
 * network, no provider credentials, no discovery — so precedence and output
 * exactness are asserted on the real code path rather than on the seed table.
 */

const bundledCatalog = bundledModelsJson as unknown as Record<string, Record<string, Model>>;

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function bundledRow(key: string): Model {
	const separator = key.indexOf("/");
	const provider = key.slice(0, separator);
	const id = key.slice(separator + 1);
	const row = bundledCatalog[provider]?.[id];
	if (!row) throw new Error(`Expected bundled catalog row for ${key}`);
	return row;
}

function composedRow(catalog: Record<string, Record<string, Model>>, key: string): Model | undefined {
	const separator = key.indexOf("/");
	return catalog[key.slice(0, separator)]?.[key.slice(separator + 1)];
}

describe("composeCatalog seeded surface", () => {
	it("reproduces every committed seeded row from the typed seed alone", () => {
		// Empty live sources and an empty previous catalog: the committed row must
		// be exactly what the pipeline emits from the seed, so no field in
		// `src/models.json` can be a hand-fix that regeneration would drop.
		const catalog = composeCatalog({ liveModels: [], modelsDevModels: [], previousCatalog: {} });

		for (const key of firstPartyCatalogSeedKeys()) {
			expect(clone(composedRow(catalog, key))).toEqual(clone(bundledRow(key)));
		}
	});

	it("overrides a stale previously generated row instead of inheriting it", () => {
		// Regression for the bootstrap trap: once the generated catalog carries the
		// key, a corrected seed must still win, or the seed stops being canonical.
		const previousCatalog: Record<string, Record<string, Model>> = {};
		for (const key of firstPartyCatalogSeedKeys()) {
			const stale = clone(bundledRow(key));
			stale.name = "Stale Generated Row";
			stale.cost = { input: 999, output: 999, cacheRead: 999, cacheWrite: 999 };
			stale.contextWindow = 4_096;
			stale.maxTokens = 512;
			delete stale.catalogProvenance;
			previousCatalog[stale.provider] = { ...(previousCatalog[stale.provider] ?? {}), [stale.id]: stale };
		}

		const catalog = composeCatalog({ liveModels: [], modelsDevModels: [], previousCatalog });

		for (const key of firstPartyCatalogSeedKeys()) {
			expect(clone(composedRow(catalog, key))).toEqual(clone(bundledRow(key)));
		}
	});

	it("yields to a genuinely fresher live upstream row for the same key", () => {
		const seed = FIRST_PARTY_CATALOG_SEEDS[0];
		if (!seed) throw new Error("Expected at least one catalog seed");
		const live = clone(seed.model) as Model;
		live.name = "Claude Opus 5 (upstream)";
		live.contextWindow = 2_000_000;
		live.maxTokens = 300_000;

		const catalog = composeCatalog({
			liveModels: [live],
			modelsDevModels: [live],
			previousCatalog: {},
		});

		const row = composedRow(catalog, `${seed.model.provider}/${seed.model.id}`);
		expect(row?.contextWindow).toBe(2_000_000);
		expect(row?.maxTokens).toBe(300_000);
		// Upstream rows are not documented transcriptions, so they carry no provenance.
		expect(row?.catalogProvenance).toBeUndefined();
		// The name still goes through generated-name scrubbing.
		expect(row?.name).toBe("Anthropic Opus 5 (upstream)");
	});

	it("binds seed provenance into the emitted row", () => {
		const catalog = composeCatalog({ liveModels: [], modelsDevModels: [], previousCatalog: {} });

		for (const seed of FIRST_PARTY_CATALOG_SEEDS) {
			const row = composedRow(catalog, `${seed.model.provider}/${seed.model.id}`);
			expect(row?.catalogProvenance).toEqual({
				sources: [...seed.provenance.sources],
				retrievedAt: seed.provenance.retrievedAt,
			});
		}
	});

	it("is idempotent when its own output is fed back as the previous catalog", () => {
		const first = composeCatalog({ liveModels: [], modelsDevModels: [], previousCatalog: {} });
		const second = composeCatalog({ liveModels: [], modelsDevModels: [], previousCatalog: clone(first) });

		for (const key of firstPartyCatalogSeedKeys()) {
			expect(clone(composedRow(second, key))).toEqual(clone(composedRow(first, key)));
		}
	});

	it("does not mutate the exported seed table", () => {
		const before = clone(FIRST_PARTY_CATALOG_SEEDS);
		composeCatalog({ liveModels: [], modelsDevModels: [], previousCatalog: clone(bundledCatalog) });
		expect(clone(FIRST_PARTY_CATALOG_SEEDS)).toEqual(before);
	});

	it("keeps the committed catalog's seeded rows stable through a full recompose", () => {
		// Feeding the committed catalog back in (still no network/credentials) must
		// leave the seeded rows byte-identical: the seed and the artifact agree.
		const catalog = composeCatalog({
			liveModels: [],
			modelsDevModels: [],
			previousCatalog: clone(bundledCatalog),
		});

		for (const key of firstPartyCatalogSeedKeys()) {
			expect(clone(composedRow(catalog, key))).toEqual(clone(bundledRow(key)));
		}
	});
});
