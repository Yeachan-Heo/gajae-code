import { describe, expect, it } from "bun:test";
import {
	applyFinalCodexGpt56ContextCap,
	CODEX_GPT_5_6_CONTEXT_CAP,
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
	it("uses the conservative fallback and preserves smaller live limits", () => {
		const identity = model();
		expect(resolveCodexGpt56DiscoveryContext(identity, undefined)).toBe(272_000);
		expect(resolveCodexGpt56DiscoveryContext(identity, 373_000)).toBe(272_000);
		expect(resolveCodexGpt56DiscoveryContext(identity, 200_000)).toBe(200_000);
	});

	it("scopes the ceiling to exact tiers and Codex product transports", () => {
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
			272_000, 272_000, 272_000, 272_000, 373_000, 373_000, 373_000,
		]);
	});

	it("supports a future authority increase without promoting stale smaller observations", () => {
		const futurePolicy = { ...CODEX_GPT_5_6_CONTEXT_CAP, fallback: 372_000, ceiling: 372_000 };
		const identity = model();
		expect(resolveCodexGpt56DiscoveryContext(identity, undefined, futurePolicy)).toBe(372_000);
		expect(resolveCodexGpt56DiscoveryContext(identity, 372_000, futurePolicy)).toBe(372_000);
		expect(applyFinalCodexGpt56ContextCap([model({ contextWindow: 272_000 })], futurePolicy)[0]?.contextWindow).toBe(
			272_000,
		);
		expect(applyFinalCodexGpt56ContextCap([model({ contextWindow: 373_000 })], futurePolicy)[0]?.contextWindow).toBe(
			372_000,
		);
	});
});
