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
