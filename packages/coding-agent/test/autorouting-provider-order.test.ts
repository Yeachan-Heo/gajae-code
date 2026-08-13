import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import {
	buildProviderSelectionCatalog,
	createProviderSelectionPolicy,
	type EffectiveProviderAuth,
	projectCatalogProviderOrder,
	projectProviderOrder,
} from "@gajae-code/coding-agent/config/provider-selection-policy";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";

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

describe("projectCatalogProviderOrder (the accessor's own implementation)", () => {
	// autoroutingProviderOrder() is a one-line call to this function, so these
	// exercise the real code path rather than a reimplementation of it.
	const catalog = (entries: Array<{ provider: string; id: string }>) => entries as never;

	test("restores the catalog's spelling instead of the normalized key", () => {
		// The generator matches provider prefixes case-sensitively, so a lowercased
		// id here would silently empty CustomRouter's tiers.
		expect(projectCatalogProviderOrder(["customrouter"], catalog([{ provider: "CustomRouter", id: "m1" }]))).toEqual([
			"CustomRouter",
		]);
	});

	test("keeps the first-seen spelling when the catalog disagrees with itself", () => {
		expect(
			projectCatalogProviderOrder(
				[],
				catalog([
					{ provider: "CustomRouter", id: "a" },
					{ provider: "customrouter", id: "b" },
				]),
			),
		).toEqual(["CustomRouter"]);
	});

	test("drops a declared provider the catalog does not offer", () => {
		expect(
			projectCatalogProviderOrder(["ghost", "anthropic"], catalog([{ provider: "anthropic", id: "m1" }])),
		).toEqual(["anthropic"]);
	});

	test("puts the declared order ahead of the catalog remainder", () => {
		const models = catalog([
			{ provider: "anthropic", id: "a" },
			{ provider: "google", id: "g" },
		]);
		expect(projectCatalogProviderOrder(["google"], models)).toEqual(["google", "anthropic"]);
	});

	test("returns nothing for an empty catalog", () => {
		expect(projectCatalogProviderOrder(["anthropic"], catalog([]))).toEqual([]);
	});
});

describe("ModelRegistry.autoroutingProviderOrder (real instance)", () => {
	// These call the real accessor, not a reimplementation. The configured-order and
	// catalog-drop branches are covered by projectProviderOrder above and by the
	// policy-derived golden fixture; here the global settings read legitimately
	// yields no explicit order, so the catalog projection is what is exercised.
	const cleanups: Array<() => void | Promise<void>> = [];

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		vi.restoreAllMocks();
	});

	async function registry(): Promise<ModelRegistry> {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-autorouting-order-"));
		const authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"), {
			configValueResolver: async () => undefined,
		});
		cleanups.push(() => authStorage.close());
		cleanups.push(async () => await fs.rm(tempDir, { recursive: true, force: true }));
		return new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
	}

	test("declares no parameters, so no caller can bind it to a session", async () => {
		const instance = await registry();
		expect(instance.autoroutingProviderOrder.length).toBe(0);
	});

	test("returns only providers the catalog actually offers", async () => {
		const instance = await registry();
		const order = instance.autoroutingProviderOrder();
		const catalogProviders = new Set(instance.getAll().map(model => model.provider));
		expect(order.length).toBeGreaterThan(0);
		for (const provider of order) expect(catalogProviders.has(provider)).toBe(true);
	});

	test("returns each provider once, in catalog first-wins order", async () => {
		const instance = await registry();
		const order = instance.autoroutingProviderOrder();
		expect(new Set(order).size).toBe(order.length);
		const catalogOrder = [...new Set(instance.getAll().map(model => model.provider))];
		expect(order).toEqual(catalogOrder);
	});

	test("is unchanged by stored credentials", async () => {
		const instance = await registry();
		const before = [...instance.autoroutingProviderOrder()];
		const target = before.at(-1);
		expect(target).toBeDefined();
		// The accessor never reads auth, so a new credential cannot reorder anything.
		await instance.authStorage.set(target as string, [{ type: "api_key", key: "test-key" }]);
		expect([...instance.autoroutingProviderOrder()]).toEqual(before);
	});

	test("is deterministic across repeated calls", async () => {
		const instance = await registry();
		expect([...instance.autoroutingProviderOrder()]).toEqual([...instance.autoroutingProviderOrder()]);
	});
});
