import { describe, expect, test } from "bun:test";
import { getBundledModels, type Model } from "@gajae-code/ai";
import {
	type CanonicalModelCatalog,
	createCanonicalModelCatalog,
	ModelCatalogError,
	projectModelRegistry,
} from "@gajae-code/coding-agent/config/model-catalog";

function model(id: string, name: string, reasoning: boolean): Model<"openai-responses"> {
	const input: ("text" | "image")[] = ["text"];
	if (id === "vision") input.push("image");

	return {
		id,
		name,
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://provider.invalid/v1",
		reasoning,
		input,
		output: ["text"],
		cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
		contextWindow: 128000,
		maxTokens: 16000,
	};
}

function json(value: CanonicalModelCatalog): string {
	return JSON.stringify(value);
}

describe("model catalog contract", () => {
	test("projects secret-bearing registry models into immutable, safe records", () => {
		const source = model("vision", "Vision", true);
		const catalog = projectModelRegistry([source], {
			source: "discovered",
			sourceVersion: "provider-feed-7",
			revision: 3,
			freshness: { status: "fresh", reason: "refresh_succeeded", timestamp: 42 },
		});

		expect(catalog.revision).toBe(1);
		expect(catalog.records).toHaveLength(1);
		expect(catalog.records[0]).toEqual({
			canonicalId: "openai/vision",
			provider: "openai",
			modelId: "vision",
			displayName: "Vision",
			inputModalities: ["text", "image"],
			capabilities: ["reasoning", "vision"],
			reasoning: true,
			contextWindow: 128000,
			maxTokens: 16000,
			source: "discovered",
			sourceVersion: "provider-feed-7",
			revision: 3,
			freshness: { status: "fresh", reason: "refresh_succeeded", timestamp: 42 },
		});
		expect(Object.keys(catalog.records[0] ?? {})).not.toContain("apiKey");
		expect(Object.keys(catalog.records[0] ?? {})).not.toContain("baseUrl");
		expect(Object.keys(catalog.records[0] ?? {})).not.toContain("cost");
		expect(Object.keys(catalog.records[0] ?? {})).not.toContain("latency");
		expect(Object.isFrozen(catalog)).toBe(true);
		expect(Object.isFrozen(catalog.records)).toBe(true);
		expect(Object.isFrozen(catalog.records[0])).toBe(true);
		expect(Object.isFrozen(catalog.records[0]?.inputModalities)).toBe(true);
		expect(Object.isFrozen(catalog.records[0]?.freshness)).toBe(true);
		expect(source.baseUrl).toBe("https://provider.invalid/v1");
		expect(source.cost.input).toBe(1);
	});

	test("defaults dynamic registry models to discovered with unknown freshness", () => {
		const catalog = projectModelRegistry([model("dynamic", "Dynamic", false)]);
		const record = catalog.records[0];
		if (!record) throw new Error("Expected one projected model record");

		expect(record.source).toBe("discovered");
		expect(record.freshness).toEqual({ status: "unavailable", reason: "freshness_unknown" });
		expect(record.freshness.timestamp).toBeUndefined();
	});

	test("uses authoritative bundled references and preserves explicit projection provenance", () => {
		const authoritative = getBundledModels("openai").find(current => current.id === "gpt-4o-mini");
		if (!authoritative) throw new Error("Expected an authoritative bundled model reference");
		const bundled = projectModelRegistry([authoritative]);
		const bundledRecord = bundled.records[0];
		if (!bundledRecord) throw new Error("Expected one bundled model record");
		expect(bundledRecord.source).toBe("builtin");
		expect(bundledRecord.freshness).toEqual({ status: "fresh" });

		const clone = { ...authoritative };
		const cloned = projectModelRegistry([clone]);
		const clonedRecord = cloned.records[0];
		if (!clonedRecord) throw new Error("Expected one cloned model record");
		expect(clonedRecord.source).toBe("discovered");
		expect(clonedRecord.freshness).toEqual({ status: "unavailable", reason: "freshness_unknown" });

		const explicit = projectModelRegistry([model("dynamic-explicit", "Dynamic", false)], {
			source: "custom",
			sourceVersion: "registry-feed-2",
			freshness: { status: "stale", reason: "cached" },
		});
		const explicitRecord = explicit.records[0];
		if (!explicitRecord) throw new Error("Expected one explicitly-provenanced model record");
		expect(explicitRecord.source).toBe("custom");
		expect(explicitRecord.sourceVersion).toBe("registry-feed-2");
		expect(explicitRecord.freshness).toEqual({ status: "stale", reason: "cached" });
	});

	test("deduplicates deterministically and preserves the selected freshness", () => {
		const stale = model("same", "Same stale", false);
		const fresh = model("same", "Same fresh", true);
		const first = projectModelRegistry([stale, fresh], {
			source: "discovered",
			sourceVersion: "feed",
			freshness: current =>
				current.name.endsWith("fresh") ? { status: "fresh" } : { status: "stale", reason: "cached" },
		});
		const second = projectModelRegistry([fresh, stale], {
			source: "discovered",
			sourceVersion: "feed",
			freshness: current =>
				current.name.endsWith("fresh") ? { status: "fresh" } : { status: "stale", reason: "cached" },
		});

		expect(first.records).toHaveLength(1);
		expect(first.records[0]?.freshness.status).toBe("fresh");
		expect(first.records[0]?.displayName).toBe("Same fresh");
		expect(json(first)).toBe(json(second));
	});

	test("rejects private fields in hand-authored base records with a stable code", () => {
		const hostile = {
			provider: "openai",
			modelId: "private",
			displayName: "Private",
			contextWindow: 1,
			maxTokens: 1,
			apiKey: "not accepted",
		};

		expect(() => createCanonicalModelCatalog([hostile])).toThrow(ModelCatalogError);
		try {
			createCanonicalModelCatalog([hostile]);
		} catch (error: unknown) {
			expect(error).toBeInstanceOf(ModelCatalogError);
			if (error instanceof ModelCatalogError) expect(error.code).toBe("forbidden_field");
		}
	});
	test("rejects nested cost and pricing fields before freezing", () => {
		const hostileRecords = [
			{
				provider: "openai",
				modelId: "cost",
				displayName: "Cost",
				contextWindow: 1,
				maxTokens: 1,
				cost: { input: 1 },
			},
			{
				provider: "openai",
				modelId: "pricing",
				displayName: "Pricing",
				contextWindow: 1,
				maxTokens: 1,
				metadata: { nested: { pricing: { output: 1 } } },
			},
			{
				provider: "openai",
				modelId: "input-cost",
				displayName: "Input Cost",
				contextWindow: 1,
				maxTokens: 1,
				metadata: { details: { inputCost: 1 } },
			},
		];

		for (const hostile of hostileRecords) {
			let error: unknown;
			try {
				createCanonicalModelCatalog([hostile]);
			} catch (caught: unknown) {
				error = caught;
			}
			expect(error).toBeInstanceOf(ModelCatalogError);
			if (error instanceof ModelCatalogError) expect(error.code).toBe("forbidden_field");
		}
	});
});
