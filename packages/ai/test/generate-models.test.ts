import { describe, expect, it } from "bun:test";
import {
	FIRST_PARTY_CATALOG_SEEDS,
	injectFirstPartyCatalogSeeds,
	injectImageGenerationModels,
} from "../scripts/generate-models";
import { applyGeneratedModelPolicies } from "../src/model-thinking";
import { getBundledModel } from "../src/models";
import type { Api, ApiModel, Model } from "../src/types";

describe("injectImageGenerationModels", () => {
	it("adds typed image-output models once for OpenAI and Codex", () => {
		const models: Model[] = [];

		injectImageGenerationModels(models);
		injectImageGenerationModels(models);

		expect(models).toEqual([
			expect.objectContaining({
				id: "gpt-image-2",
				api: "openai-responses",
				provider: "openai",
				input: ["text"],
				output: ["text", "image"],
			}),
			expect.objectContaining({
				id: "gpt-image-2",
				api: "openai-codex-responses",
				provider: "openai-codex",
				input: ["text"],
				output: ["text", "image"],
			}),
		]);
	});
});

describe("injectFirstPartyCatalogSeeds", () => {
	it("carries published provenance for every seed", () => {
		expect(FIRST_PARTY_CATALOG_SEEDS.length).toBeGreaterThan(0);
		for (const seed of FIRST_PARTY_CATALOG_SEEDS) {
			expect(seed.provenance.sources.length).toBeGreaterThan(0);
			for (const source of seed.provenance.sources) {
				expect(source).toMatch(/^https:\/\//);
			}
			expect(seed.provenance.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		}
	});

	it("reproduces the bundled catalog entry from the typed seed alone", () => {
		// Deterministic: no network fetch, no provider credentials, no discovery.
		// Seeding an empty catalog and running the generator's normalization must
		// yield exactly the committed `models.json` entry, so the generated
		// artifact stays reproducible from this source.
		const models: Model[] = [];
		injectFirstPartyCatalogSeeds(models);
		applyGeneratedModelPolicies(models as ApiModel<Api>[]);

		for (const seed of FIRST_PARTY_CATALOG_SEEDS) {
			const generated = models.find(model => model.provider === seed.model.provider && model.id === seed.model.id);
			const bundled = getBundledModel(seed.model.provider as Parameters<typeof getBundledModel>[0], seed.model.id);
			expect(bundled).toBeDefined();
			expect(JSON.parse(JSON.stringify(generated))).toEqual(JSON.parse(JSON.stringify(bundled)));
		}
	});

	it("is idempotent and never overrides an upstream entry for the same key", () => {
		const seed = FIRST_PARTY_CATALOG_SEEDS[0];
		if (!seed) throw new Error("Expected at least one catalog seed");

		const models: Model[] = [];
		injectFirstPartyCatalogSeeds(models);
		injectFirstPartyCatalogSeeds(models);
		expect(models.filter(model => model.provider === seed.model.provider && model.id === seed.model.id)).toHaveLength(
			1,
		);

		const upstream = { ...seed.model, name: "Upstream Name", contextWindow: 123_456 } as Model;
		const withUpstream: Model[] = [upstream];
		injectFirstPartyCatalogSeeds(withUpstream);
		expect(withUpstream).toEqual([upstream]);
	});

	it("does not mutate the exported seed table", () => {
		const before = JSON.parse(JSON.stringify(FIRST_PARTY_CATALOG_SEEDS));
		const models: Model[] = [];
		injectFirstPartyCatalogSeeds(models);
		applyGeneratedModelPolicies(models as ApiModel<Api>[]);
		expect(JSON.parse(JSON.stringify(FIRST_PARTY_CATALOG_SEEDS))).toEqual(before);
	});
});
