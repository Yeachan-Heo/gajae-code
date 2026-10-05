import { describe, expect, it } from "bun:test";
import { Effort } from "../src/model-thinking";
import { streamSimple } from "../src/stream";
import type { Context, Model } from "../src/types";

// This test uses the public streamSimple API to verify the fix for adaptive thinking max_tokens.
// The bug: anthropic-adaptive models with high/xhigh/max reasoning request max_tokens capped at
// DEFAULT_REQUEST_MAX_TOKENS (32000). With adaptive thinking, this consumes all 32K for thinking,
// leaving no tokens for output. The fix: when reasoning is enabled with adaptive thinking and no
// explicit maxTokens is provided, increase to model.maxTokens to allow room for both thinking and output.

describe("anthropic-adaptive thinking max_tokens for reasoning", () => {
	const createAdaptiveModel = (maxTokens: number): Model<"anthropic-messages"> => ({
		id: "claude-opus-5-5",
		name: "Claude Opus 5.5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200000,
		maxTokens,
		maxTokensSource: "discovered",
		thinking: {
			minLevel: Effort.Low,
			maxLevel: Effort.Max,
			mode: "anthropic-adaptive",
		},
	});

	function createContext(): Context {
		return {
			messages: [{ role: "user", content: "test", timestamp: Date.now() }],
		};
	}

	it("should raise adaptive model maxTokens above 32000 when reasoning is enabled and no explicit maxTokens given", async () => {
		// When caller does not explicitly specify maxTokens (undefined),
		// and the model's maxTokens exceeds DEFAULT_REQUEST_MAX_TOKENS (32000),
		// the adaptive thinking guard should increase wire max_tokens to model.maxTokens.
		const model = createAdaptiveModel(128000);
		const payloadPromise = Promise.withResolvers<Record<string, unknown>>();
		const controller = new AbortController();
		controller.abort(); // Abort immediately to skip actual API call

		streamSimple(model, createContext(), {
			reasoning: Effort.XHigh,
			apiKey: "test-key",
			signal: controller.signal,
			onPayload: payload => payloadPromise.resolve(payload as Record<string, unknown>),
		});

		const payload = await payloadPromise.promise;
		expect(payload.max_tokens).toBe(128000);
	});

	it("should treat maxTokens=0 as unspecified and raise to model.maxTokens", async () => {
		// Per docs/models.md, a request value of 0 is treated as unspecified.
		// The adaptive guard should handle this case same as undefined.
		const model = createAdaptiveModel(128000);
		const payloadPromise = Promise.withResolvers<Record<string, unknown>>();
		const controller = new AbortController();
		controller.abort(); // Abort immediately to skip actual API call

		streamSimple(model, createContext(), {
			reasoning: Effort.XHigh,
			maxTokens: 0,
			apiKey: "test-key",
			signal: controller.signal,
			onPayload: payload => payloadPromise.resolve(payload as Record<string, unknown>),
		});

		const payload = await payloadPromise.promise;
		expect(payload.max_tokens).toBe(128000);
	});

	it("should respect explicit positive maxTokens without override", async () => {
		// When caller explicitly sets a positive maxTokens, preserve it.
		const model = createAdaptiveModel(128000);
		const payloadPromise = Promise.withResolvers<Record<string, unknown>>();
		const controller = new AbortController();
		controller.abort(); // Abort immediately to skip actual API call

		streamSimple(model, createContext(), {
			reasoning: Effort.XHigh,
			maxTokens: 16000,
			apiKey: "test-key",
			signal: controller.signal,
			onPayload: payload => payloadPromise.resolve(payload as Record<string, unknown>),
		});

		const payload = await payloadPromise.promise;
		expect(payload.max_tokens).toBe(16000);
	});

	it("should maintain model catalog data for anthropic-adaptive models", () => {
		const model = createAdaptiveModel(128000);
		expect(model.id).toBe("claude-opus-5-5");
		expect(model.api).toBe("anthropic-messages");
		expect(model.thinking?.maxLevel).toBe(Effort.Max);
		expect(model.reasoning).toBe(true);
	});
});
