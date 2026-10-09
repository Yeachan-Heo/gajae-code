import { describe, expect, test } from "bun:test";
import type { Model } from "../src/types";
import { resolveServiceTier, shouldSendServiceTier, modelSupportsUltrafastTier } from "../src/types";

describe("ultrafast service tier", () => {
	test("resolveServiceTier resolves ultrafast to ultrafast", () => {
		expect(resolveServiceTier("ultrafast", "openai")).toBe("ultrafast");
		expect(resolveServiceTier("ultrafast", "openai-codex")).toBe("ultrafast");
		expect(resolveServiceTier("ultrafast", undefined)).toBe("ultrafast");
	});

	test("shouldSendServiceTier sends ultrafast to OpenAI", () => {
		expect(shouldSendServiceTier("ultrafast", "openai")).toBe(true);
		expect(shouldSendServiceTier("ultrafast", "openai-codex")).toBe(true);
	});

	test("shouldSendServiceTier sends ultrafast when provider supports it", () => {
		expect(shouldSendServiceTier("ultrafast", "custom-provider", true)).toBe(true);
	});

	test("shouldSendServiceTier does not send ultrafast to providers that do not support it", () => {
		expect(shouldSendServiceTier("ultrafast", "anthropic")).toBe(false);
		expect(shouldSendServiceTier("ultrafast", "custom-provider", false)).toBe(false);
	});

	test("ultrafast works alongside existing tiers", () => {
		expect(resolveServiceTier("flex", "openai")).toBe("flex");
		expect(resolveServiceTier("priority", "openai")).toBe("priority");
		expect(shouldSendServiceTier("flex", "openai")).toBe(true);
		expect(shouldSendServiceTier("priority", "openai")).toBe(true);
	});
});

describe("ultrafast model gating", () => {
	test("modelSupportsUltrafastTier detects support", () => {
		const supported: Model = {
			id: "gpt-6-astra",
			name: "GPT-6 Astra",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 128000,
			maxTokens: 65536,
			cost: { input: 60, output: 300, cacheRead: 6, cacheWrite: 75 },
			compat: { supportsUltrafastTier: true },
		};
		expect(modelSupportsUltrafastTier(supported)).toBe(true);

		const unsupported: Model = {
			id: "gpt-4",
			name: "GPT-4",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: false,
			input: ["text", "image"],
			contextWindow: 8192,
			maxTokens: 2048,
			cost: { input: 0.03, output: 0.06, cacheRead: 0, cacheWrite: 0 },
			compat: { supportsUltrafastTier: false },
		};
		expect(modelSupportsUltrafastTier(unsupported)).toBe(false);

		const noCompat: Model = {
			id: "gpt-3.5-turbo",
			name: "GPT-3.5 Turbo",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: false,
			input: ["text"],
			contextWindow: 4096,
			maxTokens: 2048,
			cost: { input: 0.0005, output: 0.0015, cacheRead: 0, cacheWrite: 0 },
		};
		expect(modelSupportsUltrafastTier(noCompat)).toBe(false);
	});
});
