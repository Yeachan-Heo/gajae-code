import { describe, expect, test } from "bun:test";
import {
	buildProviderSelectionCatalog,
	createProviderSelectionPolicy,
	type EffectiveProviderAuth,
	projectProviderOrder,
} from "@gajae-code/coding-agent/config/provider-selection-policy";

describe("projectProviderOrder", () => {
	test("puts the explicit order first and appends catalog order after it", () => {
		expect(
			projectProviderOrder(["openai-codex", "anthropic"], ["anthropic", "google", "openai-codex", "xai"]),
		).toEqual(["openai-codex", "anthropic", "google", "xai"]);
	});

	test("normalizes and dedupes explicit entries the same way provider selection does", () => {
		expect(projectProviderOrder(["  Anthropic ", "ANTHROPIC", "", "google"], ["anthropic", "google"])).toEqual([
			"anthropic",
			"google",
		]);
	});

	test("keeps explicit providers that are absent from the catalog", () => {
		// The projection is order-only; catalog membership is the caller's filter.
		expect(projectProviderOrder(["ghost"], ["anthropic"])).toEqual(["ghost", "anthropic"]);
	});

	test("preserves first-wins catalog order and drops blanks", () => {
		expect(projectProviderOrder([], ["anthropic", "", "anthropic", "google"])).toEqual(["anthropic", "google"]);
	});

	test("is deterministic across repeated calls", () => {
		const first = projectProviderOrder(["b"], ["a", "b", "c"]);
		const second = projectProviderOrder(["b"], ["a", "b", "c"]);
		expect(first).toEqual(second);
	});
});

describe("provider order is auth-independent while ranking is not", () => {
	const catalogProviders = ["anthropic", "google", "openai-codex"];
	const catalogModels = ["anthropic/claude", "google/gemini", "openai-codex/gpt"];

	function policyWith(effectiveAuth: ReadonlyMap<string, EffectiveProviderAuth>) {
		return createProviderSelectionPolicy({
			explicitProviderOrder: ["google"],
			effectiveAuth,
			catalogProviders,
			catalogModels,
		});
	}

	test("orderedProviders ignores effective auth entirely", () => {
		const noAuth = policyWith(new Map());
		const oauthElsewhere = policyWith(
			new Map<string, EffectiveProviderAuth>([
				["anthropic", "key"],
				["openai-codex", "oauth"],
			]),
		);
		// Flipping openai-codex into the OAuth band must not reorder the projection.
		expect(oauthElsewhere.orderedProviders()).toEqual(noAuth.orderedProviders());
		expect(noAuth.orderedProviders()).toEqual(["google", "anthropic", "openai-codex"]);
	});

	test("rank still bands omitted OAuth providers ahead of the rest", () => {
		const policy = policyWith(
			new Map<string, EffectiveProviderAuth>([
				["anthropic", "key"],
				["openai-codex", "oauth"],
			]),
		);
		expect(policy.rank("google")).toBe(0);
		expect(policy.rank("openai-codex")).toBeLessThan(policy.rank("anthropic"));
	});
});

describe("buildProviderSelectionCatalog feeds the projection", () => {
	test("catalog spelling is lowercased for comparison keys", () => {
		const { catalogProviders } = buildProviderSelectionCatalog([
			{ provider: "CustomRouter", id: "m1" },
			{ provider: "customrouter", id: "m2" },
			{ provider: "anthropic", id: "m3" },
		] as never);
		expect(catalogProviders).toEqual(["customrouter", "anthropic"]);
		expect(projectProviderOrder([], catalogProviders)).toEqual(["customrouter", "anthropic"]);
	});
});

describe("ModelRegistry.autoroutingProviderOrder", () => {
	/** Minimal registry stand-in exercising the real accessor body. */
	function registryWith(models: Array<{ provider: string; id: string }>, configured: readonly string[]) {
		const { catalogProviders } = buildProviderSelectionCatalog(models as never);
		const spelling = new Map<string, string>();
		for (const model of models) {
			const normalized = model.provider.trim().toLowerCase();
			if (normalized && !spelling.has(normalized)) spelling.set(normalized, model.provider);
		}
		// Mirrors the accessor: project order, then restore catalog spelling and drop
		// providers the catalog does not offer.
		return projectProviderOrder(configured, catalogProviders)
			.map(provider => spelling.get(provider))
			.filter((provider): provider is string => provider !== undefined);
	}

	test("returns catalog spelling, not the normalized comparison key", () => {
		// The generator matches provider prefixes case-sensitively, so persisting a
		// lowercased id would silently empty that provider's tiers.
		expect(registryWith([{ provider: "CustomRouter", id: "m1" }], ["customrouter"])).toEqual(["CustomRouter"]);
	});

	test("drops configured providers the catalog does not offer", () => {
		// A dead declaration must not reach setup.providers and pollute the fingerprint.
		expect(registryWith([{ provider: "anthropic", id: "m1" }], ["ghost", "anthropic"])).toEqual(["anthropic"]);
	});

	test("honours configured priority ahead of catalog order", () => {
		const models = [
			{ provider: "anthropic", id: "a" },
			{ provider: "google", id: "g" },
		];
		expect(registryWith(models, ["google"])).toEqual(["google", "anthropic"]);
	});

	test("collapses duplicate catalog spellings to the first occurrence", () => {
		const models = [
			{ provider: "CustomRouter", id: "a" },
			{ provider: "customrouter", id: "b" },
		];
		expect(registryWith(models, [])).toEqual(["CustomRouter"]);
	});
});
