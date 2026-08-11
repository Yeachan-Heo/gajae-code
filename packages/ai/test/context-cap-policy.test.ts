import { describe, expect, it } from "bun:test";
import {
	applyFinalCodexGpt56ContextCap,
	CODEX_GPT_5_6_CONTEXT_CAP,
	codexContextOverrideKey,
	resolveCodexGpt56DiscoveryContext,
} from "../src/context-cap-policy";
import type { Api, Model } from "../src/types";

function model(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id: "gpt-5.6-sol",
		name: "GPT-5.6 Sol",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 373_000,
		maxTokens: 128_000,
		...overrides,
	};
}

describe("Codex GPT-5.6 context cap policy", () => {
	it("forces the 372K window for the tier regardless of observations", () => {
		const identity = model();
		expect(resolveCodexGpt56DiscoveryContext(identity, undefined)).toBe(372_000);
		expect(resolveCodexGpt56DiscoveryContext(identity, 373_000)).toBe(372_000);
		expect(resolveCodexGpt56DiscoveryContext(identity, 1_050_000)).toBe(372_000);
		// Smaller observations are overridden too — the tier is forced to 372K
		// because the live backend metadata under-reports the GPT-5.6 budget.
		expect(resolveCodexGpt56DiscoveryContext(identity, 200_000)).toBe(372_000);
		// Non-5.6 Codex rows keep the generic 272K fallback — the forced 372K
		// window never leaks into unrelated discovery rows with absent metadata.
		expect(resolveCodexGpt56DiscoveryContext(model({ id: "gpt-5.5" }), undefined)).toBe(272_000);
		expect(resolveCodexGpt56DiscoveryContext(model({ id: "gpt-5.6-codex" }), undefined)).toBe(272_000);
		expect(resolveCodexGpt56DiscoveryContext(model({ id: "gpt-5.5" }), 373_000)).toBe(373_000);
	});

	it("forces 372K for invalid observations on the tier", () => {
		// The tier branch ignores the observation entirely, so every invalid shape
		// must resolve to the enforced window without crashing or falling through.
		for (const raw of [null, "373000", 0, -100, Number.NaN, Number.POSITIVE_INFINITY] as const) {
			expect(resolveCodexGpt56DiscoveryContext(model(), raw)).toBe(372_000);
		}
		for (const bad of [Number.NaN, 0, -1, undefined as unknown as number]) {
			expect(applyFinalCodexGpt56ContextCap([model({ contextWindow: bad })])[0]?.contextWindow).toBe(372_000);
		}
		// The generic fallback still applies to non-tier rows with invalid metadata.
		expect(resolveCodexGpt56DiscoveryContext(model({ id: "gpt-5.5" }), null)).toBe(272_000);
	});

	it("scopes the forced window to exact tiers and Codex product transports", () => {
		const capped = applyFinalCodexGpt56ContextCap([
			model({ id: "gpt-5.6" }),
			model({ id: "gpt-5.6-sol" }),
			model({ id: "gpt-5.6-terra", provider: "custom" }),
			model({ id: "gpt-5.6-luna", api: "openai-responses" }),
			model({ id: "gpt-5.6-sol", api: "openai-responses", provider: "openai" }),
			model({ id: "gpt-5.5" }),
			model({ id: "gpt-5.6-codex" }),
		]);
		expect(capped.map(entry => entry.contextWindow)).toEqual([
			372_000, 372_000, 372_000, 372_000, 373_000, 373_000, 373_000,
		]);
	});

	it("applies a custom enforced window only to the exact tier", () => {
		const customPolicy = { ...CODEX_GPT_5_6_CONTEXT_CAP, enforced: 400_000 };
		const identity = model();
		expect(resolveCodexGpt56DiscoveryContext(identity, undefined, customPolicy)).toBe(400_000);
		expect(resolveCodexGpt56DiscoveryContext(identity, 400_000, customPolicy)).toBe(400_000);
		expect(resolveCodexGpt56DiscoveryContext(identity, 272_000, customPolicy)).toBe(400_000);
		expect(applyFinalCodexGpt56ContextCap([model({ contextWindow: 272_000 })], customPolicy)[0]?.contextWindow).toBe(
			400_000,
		);
		expect(applyFinalCodexGpt56ContextCap([model({ contextWindow: 500_000 })], customPolicy)[0]?.contextWindow).toBe(
			400_000,
		);
		// Non-tier rows are untouched by the policy entirely.
		expect(resolveCodexGpt56DiscoveryContext(model({ id: "gpt-5.5" }), undefined, customPolicy)).toBe(272_000);
	});

	it("honors an explicit user override above the ceiling and caps sibling tiers", () => {
		const overrides = new Map([[codexContextOverrideKey("openai-codex", "gpt-5.6-sol"), 373_000]]);
		const capped = applyFinalCodexGpt56ContextCap([model(), model({ id: "gpt-5.6-terra" })], undefined, overrides);
		expect(capped.map(entry => entry.contextWindow)).toEqual([373_000, 372_000]);
	});

	it("leaves non-tier and first-party OpenAI transports untouched by the override path", () => {
		const overrides = new Map([[codexContextOverrideKey("openai-codex", "gpt-5.6-sol"), 373_000]]);
		const capped = applyFinalCodexGpt56ContextCap(
			[model({ id: "gpt-5.5" }), model({ id: "gpt-5.6-sol", api: "openai-responses", provider: "openai" })],
			undefined,
			overrides,
		);
		expect(capped.map(entry => entry.contextWindow)).toEqual([373_000, 373_000]);
	});

	it("ignores non-positive overrides so the stale-cap guard still applies", () => {
		const capped = applyFinalCodexGpt56ContextCap(
			[model(), model({ id: "gpt-5.6-terra" })],
			undefined,
			new Map([
				[codexContextOverrideKey("openai-codex", "gpt-5.6-sol"), -5],
				[codexContextOverrideKey("openai-codex", "gpt-5.6-terra"), Number.NaN],
			]),
		);
		expect(capped.map(entry => entry.contextWindow)).toEqual([372_000, 372_000]);
	});

	it("does not exempt a same-ID model when the override belongs to another provider", () => {
		// The override is configured for openai-codex/gpt-5.6-sol, but this model
		// is an unrelated extension-provider model with the same id. Its 1M window
		// must be capped to the enforced window, not honored.
		const capped = applyFinalCodexGpt56ContextCap(
			[model({ id: "gpt-5.6-sol", provider: "extension", api: "openai-codex-responses", contextWindow: 1_000_000 })],
			undefined,
			new Map([[codexContextOverrideKey("openai-codex", "gpt-5.6-sol"), 373_000]]),
		);
		expect(capped.map(entry => entry.contextWindow)).toEqual([372_000]);
	});

	it("honors a same-ID override configured for the extension provider", () => {
		// The override is configured for extension/gpt-5.6-sol, matching this
		// model's own provider, so it is honored even above the enforced window.
		const capped = applyFinalCodexGpt56ContextCap(
			[model({ id: "gpt-5.6-sol", provider: "extension", api: "openai-codex-responses", contextWindow: 1_000_000 })],
			undefined,
			new Map([[codexContextOverrideKey("extension", "gpt-5.6-sol"), 1_000_000]]),
		);
		expect(capped.map(entry => entry.contextWindow)).toEqual([1_000_000]);
	});

	it("honors a right-provider override above the enforced window", () => {
		// openai-codex/gpt-5.6-sol with an override for the same provider+model
		// keeps its explicit value even above the enforced window.
		const capped = applyFinalCodexGpt56ContextCap(
			[
				model({
					id: "gpt-5.6-sol",
					provider: "openai-codex",
					api: "openai-codex-responses",
					contextWindow: 373_000,
				}),
			],
			undefined,
			new Map([[codexContextOverrideKey("openai-codex", "gpt-5.6-sol"), 373_000]]),
		);
		expect(capped.map(entry => entry.contextWindow)).toEqual([373_000]);
	});
});
