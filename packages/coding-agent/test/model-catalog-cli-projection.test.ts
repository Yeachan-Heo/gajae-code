import { describe, expect, test } from "bun:test";
import { projectListModelCatalog } from "@gajae-code/coding-agent/cli/list-models";
import type { CanonicalModelCatalog } from "@gajae-code/coding-agent/config/model-catalog";
import { ModelRegistry, type ProviderConfigInput } from "@gajae-code/coding-agent/config/model-registry";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";

function safeRecords(catalog: CanonicalModelCatalog): CanonicalModelCatalog["records"] {
	return catalog.records.filter(record => record.provider.startsWith("safe-"));
}

function registerModels(registry: ModelRegistry, reverseOrder: boolean): void {
	const alphaModels: NonNullable<ProviderConfigInput["models"]> = [
		{
			id: "vision",
			name: "Alpha Vision",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
			contextWindow: 128_000,
			maxTokens: 16_000,
		},
	];
	const betaModels: NonNullable<ProviderConfigInput["models"]> = [
		{
			id: "plain",
			name: "Beta Plain",
			reasoning: false,
			input: ["text"],
			cost: { input: 5, output: 6, cacheRead: 7, cacheWrite: 8 },
			contextWindow: 64_000,
			maxTokens: 8_000,
		},
	];
	if (reverseOrder) {
		registry.registerProvider("safe-beta", {
			baseUrl: "https://safe-beta.invalid/v1",
			apiKey: "safe-beta-secret",
			api: "openai-responses",
			models: betaModels,
		});
		registry.registerProvider("safe-alpha", {
			baseUrl: "https://safe-alpha.invalid/v1",
			apiKey: "safe-alpha-secret",
			api: "openai-responses",
			models: alphaModels,
		});
		return;
	}
	registry.registerProvider("safe-alpha", {
		baseUrl: "https://safe-alpha.invalid/v1",
		apiKey: "safe-alpha-secret",
		api: "openai-responses",
		models: alphaModels,
	});
	registry.registerProvider("safe-beta", {
		baseUrl: "https://safe-beta.invalid/v1",
		apiKey: "safe-beta-secret",
		api: "openai-responses",
		models: betaModels,
	});
}

async function createRegistry(reverseOrder: boolean): Promise<{ registry: ModelRegistry; authStorage: AuthStorage }> {
	const authStorage = await AuthStorage.create(":memory:");
	const registry = new ModelRegistry(authStorage);
	registerModels(registry, reverseOrder);
	return { registry, authStorage };
}

describe("CLI model catalog projection", () => {
	test("projects available models into deeply immutable, base-only records", async () => {
		const { registry, authStorage } = await createRegistry(false);
		try {
			const catalog = projectListModelCatalog(registry);
			const records = catalog.records;
			const fixtureRecords = safeRecords(catalog);

			expect(fixtureRecords.map(record => record.canonicalId)).toEqual(["safe-alpha/vision", "safe-beta/plain"]);
			expect(fixtureRecords[0]).toMatchObject({
				canonicalId: "safe-alpha/vision",
				provider: "safe-alpha",
				modelId: "vision",
				displayName: "Alpha Vision",
				inputModalities: ["text", "image"],
				capabilities: ["reasoning", "vision"],
				reasoning: true,
				contextWindow: 128_000,
				maxTokens: 16_000,
			});

			const forbiddenFields = [
				"active",
				"session",
				"role",
				"fallback",
				"workMode",
				"credential",
				"baseUrl",
				"endpoint",
				"cost",
				"price",
				"latency",
			];
			const projectedFields = records.flatMap(record => Object.keys(record));
			expect(projectedFields).not.toEqual(expect.arrayContaining(forbiddenFields));
			expect(JSON.stringify(records)).not.toMatch(
				/active|session|role|fallback|workMode|credential|baseUrl|endpoint|cost|price|latency/iu,
			);
			expect(Object.isFrozen(catalog.records)).toBe(true);
			expect(Object.isFrozen(fixtureRecords[0])).toBe(true);
			expect(Object.isFrozen(fixtureRecords[0]?.inputModalities)).toBe(true);
			expect(Object.isFrozen(fixtureRecords[0]?.capabilities)).toBe(true);
		} finally {
			authStorage.close();
		}
	});

	test("searches canonical identity, display name, and capabilities without changing deterministic order", async () => {
		const first = await createRegistry(false);
		const second = await createRegistry(true);
		try {
			const firstCatalog = projectListModelCatalog(first.registry);
			const secondCatalog = projectListModelCatalog(second.registry);
			expect(JSON.stringify(safeRecords(firstCatalog))).toBe(JSON.stringify(safeRecords(secondCatalog)));

			expect(
				safeRecords(projectListModelCatalog(first.registry, "safe-beta/plain")).map(record => record.canonicalId),
			).toEqual(["safe-beta/plain"]);
			expect(
				safeRecords(projectListModelCatalog(first.registry, "Alpha Vision")).map(record => record.canonicalId),
			).toEqual(["safe-alpha/vision"]);
			expect(
				safeRecords(projectListModelCatalog(first.registry, "vision")).map(record => record.canonicalId),
			).toEqual(["safe-alpha/vision"]);
			expect(
				safeRecords(projectListModelCatalog(first.registry, "reasoning")).map(record => record.canonicalId),
			).toEqual(["safe-alpha/vision"]);
			expect(safeRecords(projectListModelCatalog(first.registry, "safe")).map(record => record.canonicalId)).toEqual(
				["safe-alpha/vision", "safe-beta/plain"],
			);
			expect(safeRecords(projectListModelCatalog(first.registry, "safe-alpha-secret"))).toHaveLength(0);
			expect(safeRecords(projectListModelCatalog(first.registry, "https://safe-alpha.invalid/v1"))).toHaveLength(0);
		} finally {
			first.authStorage.close();
			second.authStorage.close();
		}
	});
});
